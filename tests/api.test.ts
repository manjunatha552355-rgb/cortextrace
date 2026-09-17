import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime, type Runtime } from '../src/runtime.ts';
import { tempDir } from './helpers.ts';

let rt: Runtime;
let port: number;
let otlpPort: number;
const t = tempDir();
const home = mkdtempSync(join(tmpdir(), 'ct-home-'));

function call(path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; port?: number; rawBody?: string } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const req = request({
      host: '127.0.0.1', port: opts.port ?? port, path, method: opts.method ?? 'GET',
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  otlpPort = port + 1;
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(join(t.dir, 'config.json'), JSON.stringify({ api: { port, rate_limit_per_sec: 50 }, monitoring: { otlp: { port: otlpPort } } }));
  rt = await startRuntime({ dataDir: t.dir, collectors: false, home });
});

after(async () => {
  await rt.stop();
  t.cleanup();
  rmSync(home, { recursive: true, force: true });
});

test('health and openapi are public', async () => {
  assert.equal((await call('/v1/health')).status, 200);
  const spec = await call('/v1/openapi.json');
  assert.equal(spec.body.openapi, '3.1.0');
  assert.ok(spec.body.paths['/v1/events'].get && spec.body.paths['/v1/events'].post);
});

test('read endpoints require the api token; ingest token is write-only', async () => {
  assert.equal((await call('/v1/agents')).status, 401);
  assert.equal((await call('/v1/agents', { token: 'wrong' })).status, 401);
  assert.equal((await call('/v1/agents', { token: rt.engine.tokens.ingest })).status, 401);
  assert.equal((await call('/v1/agents', { token: rt.engine.tokens.api })).status, 200);
});

test('hook endpoint accepts ingest token and returns 204 without decision', async () => {
  const r = await call('/v1/hooks/claude-code/SessionStart', { method: 'POST', token: rt.engine.tokens.ingest, body: { session_id: 'api1', cwd: '/x' } });
  assert.equal(r.status, 204);
  await rt.engine.flush();
  assert.equal(rt.engine.store.countEvents({ session_id: 'api1' }), 1);
  assert.equal((await call('/v1/hooks/nope/SessionStart', { method: 'POST', token: rt.engine.tokens.ingest, body: {} })).status, 404);
});

test('browser-originated and rebinding requests are refused', async () => {
  assert.equal((await call('/v1/agents', { token: rt.engine.tokens.api, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/v1/agents', { token: rt.engine.tokens.api, headers: { host: `evil.example:${port}` } })).status, 421);
  assert.equal((await call('/v1/logs', { port: otlpPort, method: 'POST', rawBody: '{}', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/v1/logs', { port: otlpPort, method: 'POST', rawBody: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('event ingest validates schema', async () => {
  const bad = await call('/v1/events', { method: 'POST', token: rt.engine.tokens.ingest, body: [{ event_type: 'not_a_type', agent_type: 'x' }] });
  assert.equal(bad.status, 422);
  const bad2 = await call('/v1/events', { method: 'POST', token: rt.engine.tokens.ingest, body: [{ event_type: 'tool_call', agent_type: 'has spaces' }] });
  assert.equal(bad2.status, 422);
  const ok = await call('/v1/events', { method: 'POST', token: rt.engine.tokens.ingest, body: [{ event_type: 'tool_call', agent_type: 'sdk-agent', session_id: 'api2', payload: { tool_name: 'x' } }] });
  assert.deepEqual(ok.body, { accepted: 1 });
  assert.equal((await call('/v1/events', { method: 'POST', token: rt.engine.tokens.ingest, rawBody: '{nope' })).status, 400);
  assert.equal((await call('/v1/events?types=bogus', { token: rt.engine.tokens.api })).status, 400);
});

test('oversized bodies are rejected', async () => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const r = await call('/v1/hooks/claude-code/Stop', { method: 'POST', token: rt.engine.tokens.ingest, rawBody: JSON.stringify({ a: big }) }).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
});

test('otlp receiver ingests JSON logs without a token', async () => {
  const r = await call('/v1/logs', { port: otlpPort, method: 'POST', body: { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex_cli_rs' } }] }, scopeLogs: [{ logRecords: [{ attributes: [{ key: 'event.name', value: { stringValue: 'codex.user_prompt' } }, { key: 'conversation.id', value: { stringValue: 'cx1' } }, { key: 'prompt_length', value: { intValue: '12' } }] }] }] }] } });
  assert.equal(r.status, 200);
  await rt.engine.flush();
  const [e] = rt.engine.store.queryEvents({ session_id: 'cx1' });
  assert.equal(e!.agent_type, 'codex');
});

test('rate limiting returns 429 under burst', async () => {
  const results: { status: number }[] = [];
  for (let i = 0; i < 8; i++) results.push(...await Promise.all(Array.from({ length: 25 }, () => call('/v1/health'))));
  // health is unauthenticated and shares the anonymous bucket
  assert.ok(results.some((r) => r.status === 429));
});
