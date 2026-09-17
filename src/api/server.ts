import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError, VERSION, type Engine } from '../core/engine.ts';
import { SEVERITIES, EVENT_TYPES } from '../core/schema.ts';
import { OPENAPI } from './openapi.ts';

type Scope = 'none' | 'ingest' | 'read';

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  scope: Scope;
  maxBody?: number;
  handler: (ctx: { engine: Engine; params: string[]; query: URLSearchParams; body: unknown }) => unknown;
}

const intParam = (q: URLSearchParams, k: string) => {
  const v = q.get(k);
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${k} must be a number`);
  return n;
};

const eventQuery = (q: URLSearchParams) => {
  const sev = q.get('min_severity');
  if (sev && !(SEVERITIES as readonly string[]).includes(sev)) throw new HttpError(400, 'invalid min_severity');
  const types = q.get('types')?.split(',').filter(Boolean);
  if (types?.some((t) => !(EVENT_TYPES as readonly string[]).includes(t))) throw new HttpError(400, 'invalid types');
  return {
    from: intParam(q, 'from'), to: intParam(q, 'to'), agent_id: q.get('agent_id') ?? undefined, session_id: q.get('session_id') ?? undefined,
    types, min_severity: (sev ?? undefined) as any, search: q.get('search')?.slice(0, 200) ?? undefined,
    limit: intParam(q, 'limit'), offset: intParam(q, 'offset'), order: q.get('order') === 'asc' ? 'asc' as const : 'desc' as const,
  };
};

const apiEventSchema = z.object({
  event_type: z.enum(EVENT_TYPES),
  agent_type: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  agent_version: z.string().max(64).optional(),
  session_id: z.string().max(200).optional(),
  workspace: z.string().max(1024).optional(),
  timestamp: z.number().int().positive().optional(),
  duration_ms: z.number().nonnegative().optional(),
  severity: z.enum(SEVERITIES).optional(),
  process_id: z.number().int().optional(),
  correlation_id: z.string().max(200).optional(),
  trace_id: z.string().max(64).optional(),
  span_id: z.string().max(32).optional(),
  parent_span_id: z.string().max(32).optional(),
  source: z.enum(['api', 'synthetic']).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/v1\/health$/, scope: 'none', handler: ({ engine }) => ({ ok: true, version: VERSION, paused: engine.cfg().monitoring.paused }) },
  { method: 'GET', pattern: /^\/v1\/openapi\.json$/, scope: 'none', handler: () => OPENAPI },
  {
    method: 'POST', pattern: /^\/v1\/hooks\/([a-z0-9._-]{1,80})\/([A-Za-z0-9_.-]{1,80})$/, scope: 'ingest', maxBody: 1024 * 1024,
    handler: ({ engine, params, body }) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'hook payload must be a JSON object');
      return engine.handleHook(params[0]!, params[1]!, body as Record<string, unknown>).response ?? undefined;
    },
  },
  {
    method: 'POST', pattern: /^\/v1\/events$/, scope: 'ingest', maxBody: 5 * 1024 * 1024,
    handler: ({ engine, body }) => {
      const parsed = z.array(apiEventSchema).max(5000).safeParse(Array.isArray(body) ? body : [body]);
      if (!parsed.success) throw new HttpError(422, parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return { accepted: engine.ingestApiEvents(parsed.data) };
    },
  },
  ...(['logs', 'traces', 'metrics'] as const).map((kind): Route => ({
    method: 'POST', pattern: new RegExp(`^/otlp/v1/${kind}$`), scope: 'ingest', maxBody: 8 * 1024 * 1024,
    handler: ({ engine, body }) => { engine.handleOtlp(kind, body); return { partialSuccess: {} }; },
  })),
  { method: 'GET', pattern: /^\/v1\/agents$/, scope: 'read', handler: ({ engine }) => engine.store.listAgents() },
  { method: 'GET', pattern: /^\/v1\/sessions$/, scope: 'read', handler: ({ engine, query }) => engine.store.listSessions({ agent_id: query.get('agent_id') ?? undefined, active_since: intParam(query, 'active_since'), limit: intParam(query, 'limit') }) },
  {
    method: 'GET', pattern: /^\/v1\/sessions\/([^/]{1,200})$/, scope: 'read',
    handler: ({ engine, params }) => {
      const id = decodeURIComponent(params[0]!);
      const s = engine.store.getSession(id);
      if (!s) throw new HttpError(404, 'session not found');
      return { session: s, detections: engine.store.queryDetections({ session_id: id }) };
    },
  },
  { method: 'GET', pattern: /^\/v1\/events$/, scope: 'read', handler: ({ engine, query }) => engine.store.queryEvents(eventQuery(query)) },
  { method: 'GET', pattern: /^\/v1\/detections$/, scope: 'read', handler: ({ engine, query }) => engine.store.queryDetections({ from: intParam(query, 'from'), session_id: query.get('session_id') ?? undefined, agent_id: query.get('agent_id') ?? undefined, limit: intParam(query, 'limit') }) },
  { method: 'GET', pattern: /^\/v1\/alerts$/, scope: 'read', handler: ({ engine, query }) => engine.store.listAlerts({ status: query.get('status') ?? undefined, from: intParam(query, 'from'), limit: intParam(query, 'limit') }) },
  {
    method: 'POST', pattern: /^\/v1\/alerts\/([0-9a-f-]{36})\/(acknowledge|reopen)$/, scope: 'read',
    handler: ({ engine, params }) => { engine.store.setAlertStatus(params[0]!, params[1] === 'acknowledge' ? 'acknowledged' : 'open'); return { ok: true }; },
  },
  { method: 'GET', pattern: /^\/v1\/overview$/, scope: 'read', handler: ({ engine, query }) => { const to = intParam(query, 'to') ?? Date.now(); return engine.overview(intParam(query, 'from') ?? to - 3600_000, to); } },
  { method: 'GET', pattern: /^\/v1\/system$/, scope: 'read', handler: ({ engine }) => engine.systemHealth() },
];

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private perSec: () => number;
  constructor(perSec: () => number) { this.perSec = perSec; }
  take(key: string) {
    const now = Date.now();
    const rate = this.perSec();
    const b = this.buckets.get(key) ?? { tokens: rate * 2, at: now };
    b.tokens = Math.min(rate * 2, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status === 200 ? 204 : status, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export interface ListenOptions {
  port: number;
  /** When true, OTLP paths at the root (/v1/logs etc.) are accepted without a token: used for the dedicated OTLP port. */
  otlpOpen?: boolean;
}

/**
 * Security model:
 *  - binds to 127.0.0.1 only
 *  - rejects any request carrying an Origin header or a foreign Host header (blocks browser CSRF and DNS rebinding)
 *  - requires application/json for all bodies (forces CORS preflight, which is never granted)
 *  - bearer tokens: ingest (write-only) and api (read + manage); compared in constant time
 *  - per-client token-bucket rate limiting and body size caps
 */
export function createApiServer(engine: Engine, opts: ListenOptions): Server {
  const limiter = new RateLimiter(() => engine.cfg().api.rate_limit_per_sec);
  return createServer(async (req, res) => {
    const started = performance.now();
    try {
      const host = req.headers.host ?? '';
      if (!new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${opts.port}$`).test(host)) throw new HttpError(421, 'invalid host');
      if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'browser origins are not allowed');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);

      if (opts.otlpOpen) {
        const m = /^\/v1\/(logs|traces|metrics)$/.exec(url.pathname);
        if (req.method !== 'POST' || !m) throw new HttpError(404, 'OTLP receiver accepts POST /v1/logs, /v1/traces, /v1/metrics');
        if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, 'only OTLP/HTTP JSON is supported; set protocol to http/json');
        if (!limiter.take('otlp')) throw new HttpError(429, 'rate limited');
        const body = await readBody(req, 8 * 1024 * 1024);
        engine.handleOtlp(m[1] as 'logs' | 'traces' | 'metrics', body);
        engine.metrics.inc('api.otlp_requests');
        return send(res, 200, { partialSuccess: {} });
      }

      const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new HttpError(404, 'not found');
      const params = route.pattern.exec(url.pathname)!.slice(1);

      let clientKey = 'anonymous';
      if (route.scope !== 'none') {
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        const isApi = token && safeEq(token, engine.tokens.api);
        const isIngest = token && safeEq(token, engine.tokens.ingest);
        if (!isApi && !(route.scope === 'ingest' && isIngest)) throw new HttpError(401, 'missing or invalid bearer token');
        clientKey = isApi ? 'api' : 'ingest';
      }
      if (!limiter.take(clientKey)) throw new HttpError(429, 'rate limited');

      let body: unknown;
      if (req.method === 'POST') {
        const ct = String(req.headers['content-type'] ?? '');
        if (!ct.startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json');
        body = await readBody(req, route.maxBody ?? 64 * 1024);
      }
      const result = route.handler({ engine, params, query: url.searchParams, body });
      engine.metrics.inc('api.requests');
      send(res, 200, result);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) engine.log.error('api', 'handler error', { error: (e as Error).message });
      engine.metrics.inc(`api.status_${status}`);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    } finally {
      engine.metrics.time('api.request', performance.now() - started);
    }
  });
}

export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}
