import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, createWriteStream } from 'node:fs';
import { homedir, userInfo, platform, release, arch, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ConfigStore, type Config } from './config.ts';
import { Logger, Metrics } from './observe.ts';
import { compileUserPatterns, redactValue, truncate } from './redact.ts';
import {
  eventSchema, makeEvent, severityRank, HOST_ID, SEVERITIES,
  type AgentEvent, type Detection, type EventInput, type Severity,
} from './schema.ts';
import { Store, type EventQuery } from '../storage/db.ts';
import { AdapterRegistry, scanMcpConfigs, genericEvent } from '../adapters/registry.ts';
import type { HookContext, HookDecision } from '../adapters/types.ts';
import { normalizeOtlpLogs, normalizeOtlpMetrics, normalizeOtlpTraces } from '../adapters/otlp.ts';
import { Detector, summaryOf, effectivePolicies } from '../detection/detector.ts';
import { computeRisk } from '../detection/risk.ts';
import { AlertManager } from '../detection/alerts.ts';
import { DEFAULT_POLICIES, evaluatePolicies } from '../detection/policy.ts';
import type { AlertRow } from '../storage/db.ts';
import { Supervisor, type AgentHint, type Collector } from '../collectors/supervisor.ts';
import { createOsProbe, type OsProbe } from '../collectors/os.ts';
import { ProcessTracker, NetworkCollector } from '../collectors/process.ts';
import { FilesystemCollector, type WatchTarget } from '../collectors/filesystem.ts';

export const VERSION = '0.1.0';
const QUEUE_LIMIT = 50_000;
const BATCH = 1000;

type Pending = EventInput & { agent_hint?: AgentHint; adapter_id?: string };

export interface EngineOptions {
  dataDir: string;
  /** disable OS collectors (tests, headless ingest-only) */
  collectors?: boolean;
  probe?: OsProbe;
  notify?: (a: AlertRow, d: Detection) => void;
  home?: string;
}

export interface StreamBatch {
  events: (AgentEvent & { summary: string })[];
  detections: Detection[];
  alerts: AlertRow[];
}

const FALLBACK_NAMES: Record<string, string> = { 'llm-client': 'Unidentified LLM client', unknown: 'Unknown agent' };

export class Engine extends EventEmitter {
  readonly config: ConfigStore;
  readonly store: Store;
  readonly log: Logger;
  readonly metrics = new Metrics();
  readonly registry: AdapterRegistry;
  readonly detector: Detector;
  readonly alerts: AlertManager;
  readonly tokens: { api: string; ingest: string };
  readonly home: string;
  readonly health = { db_ok: true, db_detail: 'ok', db_recovered_from: null as string | null, started_at: Date.now() };
  tracker: ProcessTracker | null = null;
  fs: FilesystemCollector | null = null;
  supervisor: Supervisor | null = null;

  private queue: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private flushing: Promise<void> | null = null;
  private recentHookCommands = new Map<string, number>();
  private recentFilePaths = new Map<string, number>();
  private recentKeys = new Map<string, number>();
  private toolStarts = new Map<string, number>();
  private hookSessionWorkspaces = new Map<string, { workspace: string; hint: AgentHint; last: number }>();
  private dirtySessions = new Set<string>();
  private dirtyAgents = new Set<string>();
  private samples: { ts: number; events: number; dropped: number; queue: number; cpu: number; rss: number; ingest_p95: number }[] = [];
  private lastSampleEvents = 0;
  private lastSampleDropped = 0;
  private otlpExportBuffer: AgentEvent[] = [];

  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    super();
    this.opts = opts;
    this.setMaxListeners(50);
    mkdirSync(opts.dataDir, { recursive: true });
    this.home = opts.home ?? homedir();
    this.log = new Logger(join(opts.dataDir, 'logs'));
    const freshConfig = !existsSync(join(opts.dataDir, 'config.json'));
    this.config = new ConfigStore(opts.dataDir);
    if (freshConfig) this.config.update({ policies: DEFAULT_POLICIES });
    if (this.config.lastError) this.log.error('config', this.config.lastError);
    this.store = this.openStore(join(opts.dataDir, 'cortextrace.db'));
    this.tokens = this.loadTokens();
    this.registry = new AdapterRegistry(this.cfg().custom_agents);
    this.config.onChange((c) => this.registry.setCustom(c.custom_agents));
    this.detector = new Detector(this.store, () => this.cfg());
    this.alerts = new AlertManager(this.store, () => this.cfg(), this.log, join(opts.dataDir, 'alerts.jsonl'), (a, d) => {
      this.opts.notify?.(a, d);
      this.emit('notify', a, d);
    });
  }

  cfg(): Config {
    return this.config.current;
  }

  private openStore(path: string): Store {
    try {
      const s = new Store(path);
      const check = s.integrityCheck();
      if (check.ok) return s;
      s.close();
      throw new Error(`integrity check failed: ${check.detail}`);
    } catch (e) {
      // Corruption is detected, the damaged file is preserved for forensics, and monitoring continues on a fresh database.
      const moved = `${path}.corrupt-${Date.now()}`;
      try { if (existsSync(path)) renameSync(path, moved); } catch { /* keep going */ }
      for (const ext of ['-wal', '-shm']) { try { if (existsSync(path + ext)) renameSync(path + ext, moved + ext); } catch { /* ignore */ } }
      this.health.db_ok = false;
      this.health.db_detail = (e as Error).message;
      this.health.db_recovered_from = moved;
      this.log.error('storage', 'database unusable; moved aside and recreated', { moved, error: (e as Error).message });
      return new Store(path);
    }
  }

  private loadTokens() {
    const file = join(this.opts.dataDir, 'tokens.json');
    try {
      const t = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof t.api === 'string' && typeof t.ingest === 'string' && t.api.length >= 32) return t as { api: string; ingest: string };
    } catch { /* regenerate */ }
    const t = { api: randomBytes(32).toString('hex'), ingest: randomBytes(24).toString('hex') };
    writeFileSync(file, JSON.stringify(t), { mode: 0o600 });
    return t;
  }

  hookContext(): HookContext {
    const c = this.cfg();
    return { apiBase: `http://127.0.0.1:${c.api.port}`, ingestToken: this.tokens.ingest, otlpBase: `http://127.0.0.1:${c.monitoring.otlp.port}` };
  }

  // ---------- lifecycle ----------
  start() {
    if (this.opts.collectors !== false) {
      const probe = this.opts.probe ?? createOsProbe();
      const cfg = () => this.cfg().monitoring;
      this.tracker = new ProcessTracker(probe, this.registry, () => cfg().process);
      const net = new NetworkCollector(probe, this.tracker, () => cfg().network, () => [this.cfg().api.port, this.cfg().monitoring.otlp.port]);
      this.fs = new FilesystemCollector(() => this.watchTargets(), () => cfg().filesystem, (p) => this.wasRecentlyReported(p));
      const collectors: Collector[] = [this.tracker, net, this.fs];
      this.supervisor = new Supervisor(collectors, (e) => this.enqueue(e), this.log, this.metrics, () => this.cfg().monitoring.paused);
      this.supervisor.start();
    }
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(() => { try { fn(); } catch (e) { this.log.error('engine', 'periodic task failed', { error: (e as Error).message }); } }, ms);
      t.unref();
      this.timers.push(t);
    };
    this.discoverInstalled();
    every(this.cfg().monitoring.discovery_interval_ms, () => this.discoverInstalled());
    every(3600_000, () => this.retention());
    every(24 * 3600_000, () => this.integrity());
    every(10_000, () => this.sample());
    every(30_000, () => this.recomputeAgentRisk());
    this.log.info('engine', 'started', { version: VERSION, data_dir: this.opts.dataDir });
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.supervisor?.stop();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flush();
    this.store.close();
  }

  // ---------- ingest ----------
  enqueue(e: Pending) {
    this.metrics.inc('events.received');
    if (this.cfg().monitoring.paused) {
      this.metrics.inc('events.paused_discarded');
      return;
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      // Backpressure: shed load instead of growing memory without bound; drops are visible in System Health.
      this.metrics.inc('events.dropped');
      return;
    }
    this.queue.push(e);
    if (this.queue.length >= BATCH) void this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 200);
  }

  handleHook(adapterId: string, eventName: string, payload: Record<string, unknown>): { accepted: number; response: unknown } {
    const adapter = this.registry.get(adapterId);
    if (!adapter?.normalizeHook) throw new HttpError(404, `unknown adapter ${adapterId}`);
    const inputs = this.registry.guard(adapterId, () => adapter.normalizeHook!(eventName, payload), null);
    if (!inputs) throw new HttpError(422, 'adapter could not normalize payload');
    let decision: HookDecision | null = null;
    for (const i of inputs) {
      const pending: Pending = { ...i, adapter_id: adapterId };
      // Synchronous policy check so require_approval policies can answer the runtime before the action runs.
      const preview = this.buildEvent(pending);
      if (preview) {
        const hits = evaluatePolicies(effectivePolicies(this.cfg()), preview.event).filter((p) => p.mode === 'require_approval');
        if (hits.length) decision = { decision: 'ask', reason: hits.map((h) => h.name).join('; ') };
      }
      this.enqueue(pending);
    }
    this.registry.noteEvent(adapterId);
    const response = decision && adapter.hookResponse ? this.registry.guard(adapterId, () => adapter.hookResponse!(eventName, decision), null) : null;
    return { accepted: inputs.length, response };
  }

  ingestApiEvents(items: Record<string, any>[]) {
    let n = 0;
    for (const it of items.slice(0, 5000)) {
      const agentType = typeof it.agent_type === 'string' ? it.agent_type.slice(0, 64) : 'custom';
      const adapterId = this.registry.get(agentType) ? agentType : this.registry.get(`custom.${agentType}`) ? `custom.${agentType}` : agentType;
      const input = typeof it.event_type === 'string'
        ? genericEvent(it.event_type as any, it.event_type, { ...(it.payload ?? {}), session_id: it.session_id, cwd: it.workspace, correlation_id: it.correlation_id, pid: it.process_id })
        : null;
      if (!input) continue;
      input.source = it.source === 'synthetic' ? 'synthetic' : 'api';
      if (typeof it.timestamp === 'number') input.timestamp = it.timestamp;
      if (typeof it.duration_ms === 'number') input.duration_ms = it.duration_ms;
      if (typeof it.trace_id === 'string') input.trace_id = it.trace_id;
      if (typeof it.span_id === 'string') input.span_id = it.span_id;
      if (typeof it.parent_span_id === 'string') input.parent_span_id = it.parent_span_id;
      if (typeof it.agent_version === 'string') input.agent_version = it.agent_version;
      if (typeof it.severity === 'string' && (SEVERITIES as readonly string[]).includes(it.severity)) input.severity = it.severity as Severity;
      this.enqueue({ ...input, adapter_id: adapterId });
      n++;
    }
    return n;
  }

  handleOtlp(kind: 'logs' | 'traces' | 'metrics', body: unknown) {
    if (kind === 'metrics') {
      const pts = normalizeOtlpMetrics(body);
      const agg = new Map<string, number>();
      for (const p of pts) {
        const key = `${p.service}|${p.name}|${String(p.attributes['type'] ?? p.attributes['token.type'] ?? p.attributes['model'] ?? '')}`;
        agg.set(key, (agg.get(key) ?? 0) + p.value);
      }
      for (const [key, v] of agg) {
        const prev = this.store.listInventory('otel_metric').find((r) => r.id === key);
        this.store.putInventory('otel_metric', key, { total: (prev?.total ?? 0) + v, service: key.split('|')[0], name: key.split('|')[1], kind: key.split('|')[2] });
      }
      return pts.length;
    }
    const groups = kind === 'logs' ? normalizeOtlpLogs(body) : normalizeOtlpTraces(body);
    let n = 0;
    for (const g of groups) {
      const adapter = this.registry.byOtlpService(g.service);
      const adapterId = adapter?.id ?? `otel.${g.service.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40)}`;
      for (const e of g.events) { this.enqueue({ ...e, adapter_id: adapterId }); n++; }
      if (adapter) this.registry.noteEvent(adapter.id);
    }
    return n;
  }

  // ---------- pipeline ----------
  private resolveAgent(p: Pending) {
    const adapterId = p.agent_hint?.adapter_id ?? p.adapter_id ?? p.agent_type ?? 'unknown';
    const adapter = this.registry.get(adapterId);
    return {
      adapterId,
      agent_id: `${adapterId}@${HOST_ID}`,
      display: adapter?.displayName ?? FALLBACK_NAMES[adapterId] ?? adapterId,
      runtime: adapter?.runtime ?? (adapterId.startsWith('otel.') ? 'opentelemetry' : 'unknown'),
      executable: p.agent_hint?.executable ?? null,
    };
  }

  private buildEvent(p: Pending): { event: AgentEvent; agent: ReturnType<Engine['resolveAgent']> } | null {
    const agent = this.resolveAgent(p);
    const labels = new Set<string>(p.security_labels ?? []);
    const extra = compileUserPatterns(this.cfg().privacy.custom_patterns);
    const payload = redactValue(p.payload ?? {}, labels, extra) as Record<string, unknown>;
    const { agent_hint: _h, adapter_id: _a, ...rest } = p;
    const candidate = makeEvent({
      ...rest,
      agent_id: agent.agent_id,
      agent_type: agent.adapterId,
      session_id: p.session_id ?? `agent:${agent.agent_id}`,
      workspace: p.workspace ? truncate(p.workspace, 1024) : null,
      payload,
      security_labels: [...labels],
    });
    const parsed = eventSchema.safeParse(candidate);
    if (!parsed.success) {
      this.metrics.inc('events.invalid');
      this.log.warn('pipeline', 'invalid event dropped', { issue: parsed.error.issues[0]?.message, type: p.event_type });
      return null;
    }
    return { event: parsed.data, agent };
  }

  private isDuplicate(e: AgentEvent): boolean {
    const now = e.timestamp;
    const p = e.payload as Record<string, any>;
    if (e.event_type === 'command_execution' && typeof p.command === 'string') {
      const key = `${e.agent_type}|${p.command.trim().slice(0, 200)}`;
      if (e.source === 'hook' || e.source === 'otlp') {
        const seen = this.recentHookCommands.get(key);
        this.recentHookCommands.set(key, now);
        if (seen && e.source === 'otlp' && now - seen < 10_000) return true;
      } else if (e.source === 'process') {
        // A shell spawned for a hook-reported command shows up in the process snapshot; match on the command text.
        for (const [k, t] of this.recentHookCommands) {
          if (now - t > 30_000) continue;
          const cmd = k.slice(e.agent_type.length + 1);
          if (k.startsWith(`${e.agent_type}|`) && cmd.length > 3 && p.command.includes(cmd.slice(0, 60))) return true;
        }
      }
    }
    if ((e.event_type === 'file_modified' || e.event_type === 'file_created') && typeof p.path === 'string' && e.source !== 'filesystem') {
      this.recentFilePaths.set(normPath(p.path), now);
    }
    if (e.source === 'otlp' && ['tool_result', 'mcp_call', 'prompt_observed'].includes(e.event_type)) {
      const key = `${e.session_id}|${e.event_type}|${p.tool_name ?? ''}|${Math.floor(now / 3000)}`;
      if (this.recentKeys.has(key)) return true;
    }
    if (e.source === 'hook' && ['tool_result', 'mcp_call', 'prompt_observed'].includes(e.event_type)) {
      this.recentKeys.set(`${e.session_id}|${e.event_type}|${p.tool_name ?? ''}|${Math.floor(now / 3000)}`, now);
    }
    return false;
  }

  wasRecentlyReported(path: string) {
    const t = this.recentFilePaths.get(normPath(path));
    return t != null && Date.now() - t < 5000;
  }

  private minimize(e: AgentEvent) {
    const priv = this.cfg().privacy;
    const p = e.payload as Record<string, any>;
    if (typeof p.prompt === 'string') {
      p.prompt_length ??= p.prompt.length;
      p.prompt_sha256 = createHash('sha256').update(p.prompt).digest('hex').slice(0, 16);
      if (priv.prompts === 'metadata') delete p.prompt;
    }
    if (p.output !== undefined) {
      const text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      p.output_length ??= text?.length ?? 0;
      if (priv.tool_output === 'metadata') delete p.output;
      else p.output = truncate(text ?? '', 2048);
    }
    if (priv.command_lines === 'metadata' && typeof p.command === 'string') {
      const parts = p.command.trim().split(/\s+/);
      p.command = `${parts[0]} …(${parts.length - 1} args)`;
    }
    if (p.raw !== undefined) delete p.raw;
  }

  /** Drains the queue. Concurrent callers wait for the in-flight drain instead of returning early. */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    while (this.flushing) await this.flushing;
    if (!this.queue.length) return;
    this.flushing = this.drain();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
    if (this.queue.length) return this.flush();
  }

  private async drain() {
    {
      while (this.queue.length) {
        const batch = this.queue.splice(0, BATCH);
        const t0 = performance.now();
        try {
          this.processBatch(batch);
        } catch (e) {
          // A failed batch is logged and counted; the pipeline keeps running for later batches.
          this.metrics.inc('events.batch_failures');
          this.metrics.inc('events.dropped', batch.length);
          this.log.error('pipeline', 'batch failed', { error: (e as Error).message, size: batch.length });
        }
        this.metrics.time('pipeline.batch', performance.now() - t0);
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  private processBatch(batch: Pending[]) {
    const events: (AgentEvent & { summary: string })[] = [];
    const detections: Detection[] = [];
    const alerts: AlertRow[] = [];
    const agents = new Map<string, { agent: ReturnType<Engine['resolveAgent']>; e: AgentEvent }>();
    const detectT0 = performance.now();

    for (const p of batch) {
      const built = this.buildEvent(p);
      if (!built) continue;
      const { event: e, agent } = built;
      if (this.isDuplicate(e)) { this.metrics.inc('events.deduplicated'); continue; }
      this.trackToolDuration(e);
      this.trackHookWorkspace(e);

      const out = this.detector.analyze(e);
      if (out.detections.length) {
        const top = out.detections.reduce((a, b) => (severityRank(b.severity) > severityRank(a.severity) ? b : a));
        e.severity = severityRank(top.severity) > severityRank(e.severity) ? top.severity : e.severity;
        e.security_labels = [...new Set([...e.security_labels, ...out.detections.map((d) => d.rule_id)])].slice(0, 64);
        e.risk_score = Math.min(100, Math.max(...out.detections.map((d) => ({ INFO: 0, LOW: 10, MEDIUM: 30, HIGH: 60, CRITICAL: 90 })[d.severity] * d.confidence)));
      }
      this.minimize(e);
      const withSummary = { ...e, summary: summaryOf(e) };
      events.push(withSummary);
      agents.set(e.agent_id, { agent, e });

      for (const d of out.detections) {
        detections.push(d);
        if (d.severity === 'INFO') continue;
        const detEvent = makeEvent({
          event_type: d.classification === 'policy_violation' ? 'policy_violation' : 'security_detection', source: 'engine',
          timestamp: e.timestamp, agent_id: e.agent_id, agent_type: e.agent_type, session_id: e.session_id, workspace: e.workspace,
          process_id: e.process_id, severity: d.severity, correlation_id: e.event_id, risk_score: e.risk_score,
          payload: { detection_id: d.detection_id, rule_id: d.rule_id, rule_name: d.rule_name, reason: d.reason, evidence: d.evidence, classification: d.classification, confidence: d.confidence },
          security_labels: [d.rule_id],
        });
        events.push({ ...detEvent, summary: d.rule_name });
      }
    }
    this.metrics.time('detection.batch', performance.now() - detectT0);

    const dbT0 = performance.now();
    this.store.tx(() => {
      for (const { agent, e } of agents.values()) {
        this.store.upsertAgent({
          agent_id: agent.agent_id, agent_type: agent.adapterId, display_name: agent.display, version: e.agent_version, runtime: agent.runtime,
          executable: agent.executable, first_seen: e.timestamp, last_seen: e.timestamp, trust: 'unknown', installed: false,
          running: e.event_type !== 'agent_stopped' && (e.source !== 'process' || this.isAgentRunning(agent.adapterId)),
        });
      }
      this.store.insertEvents(events);
      const sessionCounts = new Map<string, { e: AgentEvent; n: number; first: number; last: number }>();
      for (const e of events) {
        if (!e.session_id) continue;
        const s = sessionCounts.get(e.session_id);
        if (s) { s.n++; s.first = Math.min(s.first, e.timestamp); s.last = Math.max(s.last, e.timestamp); if (!s.e.workspace && e.workspace) s.e = e; }
        else sessionCounts.set(e.session_id, { e, n: 1, first: e.timestamp, last: e.timestamp });
      }
      for (const [sid, s] of sessionCounts) {
        this.store.touchSession({ session_id: sid, agent_id: s.e.agent_id, agent_type: s.e.agent_type, process_id: s.e.process_id, workspace: s.e.workspace, user: userName(), started_at: s.first, last_activity: s.last }, s.n);
      }
      for (const e of events) if (e.event_type === 'session_completed' && e.session_id) this.store.endSession(e.session_id, e.timestamp);
      for (const d of detections) {
        this.store.insertDetection(d);
        if (d.session_id) this.dirtySessions.add(d.session_id);
        this.dirtyAgents.add(d.agent_id);
        const outcome = this.alerts.process(d);
        if (outcome?.created) alerts.push(outcome.alert);
      }
      for (const sid of this.dirtySessions) {
        // ponytail: recomputed from the 500 most recent detections; repeats are capped so older ones rarely change the score
        const risk = computeRisk(this.store.queryDetections({ session_id: sid, limit: 500 }), this.cfg().risk.thresholds);
        this.store.setSessionRisk(sid, risk.score, risk);
      }
      this.dirtySessions.clear();
    });
    this.metrics.time('storage.batch', performance.now() - dbT0);
    this.metrics.inc('events.stored', events.length);
    this.metrics.inc('detections.total', detections.length);
    this.exportOtlp(events);
    if (events.length || detections.length) this.emit('batch', { events, detections, alerts } satisfies StreamBatch);
  }

  private isAgentRunning(adapterId: string) {
    return !this.tracker || [...this.tracker.roots.values()].some((r) => r.adapter_id === adapterId);
  }

  private trackToolDuration(e: AgentEvent) {
    if (!e.correlation_id) return;
    if (e.event_type !== 'tool_result') {
      this.toolStarts.set(e.correlation_id, e.timestamp);
      if (this.toolStarts.size > 20_000) this.toolStarts.clear();
    } else if (e.duration_ms == null) {
      const t = this.toolStarts.get(e.correlation_id);
      if (t != null) { e.duration_ms = Math.max(0, e.timestamp - t); this.toolStarts.delete(e.correlation_id); }
    }
  }

  private trackHookWorkspace(e: AgentEvent) {
    if ((e.source === 'hook' || e.source === 'api') && e.workspace && e.session_id) {
      this.hookSessionWorkspaces.set(e.session_id, { workspace: e.workspace, hint: { adapter_id: e.agent_type, executable: null, confidence: 1 }, last: e.timestamp });
      if (this.hookSessionWorkspaces.size > 500) {
        const oldest = [...this.hookSessionWorkspaces].sort((a, b) => a[1].last - b[1].last).slice(0, 100);
        for (const [k] of oldest) this.hookSessionWorkspaces.delete(k);
      }
    }
  }

  watchTargets(): WatchTarget[] {
    const targets: WatchTarget[] = [];
    const cutoff = Date.now() - 30 * 60_000;
    for (const [sid, s] of [...this.hookSessionWorkspaces].sort((a, b) => b[1].last - a[1].last)) {
      if (s.last >= cutoff) targets.push({ workspace: s.workspace, session_id: sid, agent_hint: s.hint });
    }
    for (const r of this.tracker?.roots.values() ?? []) {
      if (r.cwd) targets.push({ workspace: r.cwd, session_id: r.session_id, agent_hint: { adapter_id: r.adapter_id, executable: r.exe, confidence: r.confidence } });
    }
    return targets;
  }

  // ---------- periodic ----------
  discoverInstalled() {
    const now = Date.now();
    for (const { adapter, paths } of this.registry.installed(this.home)) {
      this.store.upsertAgent({
        agent_id: `${adapter.id}@${HOST_ID}`, agent_type: adapter.id, display_name: adapter.displayName, version: null, runtime: adapter.runtime,
        executable: null, first_seen: now, last_seen: 0, trust: 'unknown', installed: true, running: this.tracker ? this.isAgentRunning(adapter.id) : false,
        meta: { install_paths: paths, capabilities: adapter.capabilities },
      });
    }
    if (this.tracker) {
      for (const a of this.store.listAgents()) {
        const running = this.isAgentRunning(a.agent_type);
        if (a.running !== running) this.store.setAgentRunning(a.agent_id, running);
      }
    }
    const servers = this.registry.guard('mcp-inventory', () => scanMcpConfigs(this.home), []);
    for (const s of servers) this.store.putInventory('mcp_server', s.id, s);
    this.detector.setKnownMcpServers(servers.map((s) => s.name));
  }

  retention() {
    const r = this.cfg().retention;
    const deleted = this.store.applyRetention(r.days, r.max_events);
    if (deleted) this.log.info('storage', 'retention applied', { deleted });
  }

  integrity() {
    const c = this.store.integrityCheck();
    this.health.db_ok = c.ok;
    this.health.db_detail = c.detail;
    if (!c.ok) this.log.error('storage', 'integrity check failed', { detail: c.detail });
    return c;
  }

  private recomputeAgentRisk() {
    const since = Date.now() - 24 * 3600_000;
    for (const id of this.dirtyAgents) {
      this.store.setAgentRisk(id, computeRisk(this.store.queryDetections({ agent_id: id, from: since, limit: 5000 }), this.cfg().risk.thresholds).score);
    }
    this.dirtyAgents.clear();
  }

  private sample() {
    const m = this.metrics.snapshot();
    const stored = m.counters['events.stored'] ?? 0;
    const dropped = m.counters['events.dropped'] ?? 0;
    this.samples.push({
      ts: Date.now(), events: stored - this.lastSampleEvents, dropped: dropped - this.lastSampleDropped, queue: this.queue.length,
      cpu: m.cpu_percent, rss: m.rss_mb, ingest_p95: Math.round((m.latency['pipeline.batch']?.p95 ?? 0) * 10) / 10,
    });
    this.lastSampleEvents = stored;
    this.lastSampleDropped = dropped;
    if (this.samples.length > 360) this.samples.shift();
  }

  private exportOtlp(events: AgentEvent[]) {
    const c = this.cfg().export;
    if (!c.otlp_endpoint) return;
    this.otlpExportBuffer.push(...events);
    if (this.otlpExportBuffer.length < 200 && events.length) return;
    const batch = this.otlpExportBuffer.splice(0, 5000);
    const body = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cortextrace' } }, { key: 'host.id', value: { stringValue: HOST_ID } }] },
        scopeLogs: [{
          scope: { name: 'cortextrace', version: VERSION },
          logRecords: batch.map((e) => ({
            timeUnixNano: `${e.timestamp}000000`, severityText: e.severity, severityNumber: 9 + severityRank(e.severity) * 4,
            body: { stringValue: e.event_type }, traceId: e.trace_id ?? undefined, spanId: e.span_id ?? undefined,
            attributes: Object.entries({ 'event.name': `cortextrace.${e.event_type}`, 'agent.id': e.agent_id, 'agent.type': e.agent_type, 'session.id': e.session_id ?? '', 'event.id': e.event_id, 'event.source': e.source, 'risk.score': e.risk_score, labels: e.security_labels.join(','), payload: JSON.stringify(e.payload) })
              .map(([key, v]) => ({ key, value: typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) } })),
          })),
        }],
      }],
    };
    fetch(new URL('/v1/logs', c.otlp_endpoint), { method: 'POST', headers: { 'content-type': 'application/json', ...c.otlp_headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
      .then((r) => { if (!r.ok) this.metrics.inc('export.otlp_failures'); else this.metrics.inc('export.otlp_events', batch.length); })
      .catch(() => this.metrics.inc('export.otlp_failures'));
  }

  // ---------- queries used by API + UI ----------
  private overviewCache: { key: string; at: number; value: ReturnType<Engine['computeOverview']> } | null = null;

  // ponytail: 10 s result cache keyed on 15 s-rounded range; aggregates can take ~2 s at >200k events in range. Materialised rollups if that grows.
  overview(from: number, to: number) {
    const key = `${Math.floor(from / 15_000)}|${Math.floor(to / 15_000)}`;
    const now = Date.now();
    if (this.overviewCache?.key === key && now - this.overviewCache.at < 10_000) return this.overviewCache.value;
    const value = this.computeOverview(from, to);
    this.overviewCache = { key, at: now, value };
    return value;
  }

  private computeOverview(from: number, to: number) {
    const s = this.store;
    const bucket = pickBucket(to - from);
    const count = (types: string[]) => s.countEvents({ from, to, types });
    const activeSince = Date.now() - 15 * 60_000;
    const sessions = s.listSessions({ active_since: from, limit: 5000 });
    const agents = s.listAgents();
    const detectionCounts = s.detectionCounts(from);
    const bySeverity = (rank: number) => detectionCounts.filter((d) => d.severity === rank).reduce((a, d) => a + d.n, 0);
    const riskBuckets = { none: 0, low: 0, medium: 0, high: 0, critical: 0 } as Record<string, number>;
    const t = this.cfg().risk.thresholds;
    for (const x of sessions) {
      const r = x.risk_score as number;
      riskBuckets[r >= t.critical ? 'critical' : r >= t.high ? 'high' : r >= t.medium ? 'medium' : r >= t.low ? 'low' : 'none']!++;
    }
    const minutes = Math.max(1, (Math.min(to, Date.now()) - from) / 60_000);
    const total = s.countEvents({ from, to });
    return {
      range: { from, to, bucket_ms: bucket },
      kpis: {
        active_agents: agents.filter((a) => a.running || (a.last_seen as number) >= activeSince).length,
        known_agents: agents.length,
        active_sessions: sessions.filter((x) => (x.last_activity as number) >= activeSince && !x.ended_at).length,
        sessions: sessions.length,
        events: total,
        events_per_minute: Math.round((total / minutes) * 10) / 10,
        commands: count(['command_execution']),
        files_modified: count(['file_modified', 'file_created', 'file_deleted']),
        tools: count(['tool_call', 'tool_result', 'mcp_call']),
        mcp_calls: count(['mcp_call']),
        network: count(['network_connection_metadata']),
        detections: detectionCounts.filter((d) => d.severity > 0).reduce((a, d) => a + d.n, 0),
        critical: bySeverity(4),
        high: bySeverity(3),
        open_alerts: s.countAlerts('open', from),
      },
      activity: s.timeseries(from, to, bucket, 'agent_type'),
      severity_series: s.timeseries(from, to, bucket, 'severity', ['security_detection', 'policy_violation']),
      risk_distribution: riskBuckets,
      agent_distribution: s.countBy('agent_type', from, to),
      type_distribution: s.countBy('event_type', from, to, undefined, 30),
      top_tools: s.countBy('tool', from, to, ['tool_call', 'mcp_call', 'command_execution', 'file_read', 'file_modified', 'directory_access', 'network_connection_metadata'], 15),
      top_commands: s.topSummaries(['command_execution'], from, to),
      top_workspaces: s.countBy('workspace', from, to),
      detection_counts: detectionCounts,
    };
  }

  systemHealth() {
    const m = this.metrics.snapshot();
    return {
      version: VERSION,
      platform: `${platform()} ${release()} ${arch()}`,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      host: { cpus: cpus().length, memory_gb: Math.round(totalmem() / 1073741824) },
      data_dir: this.opts.dataDir,
      paused: this.cfg().monitoring.paused,
      config_error: this.config.lastError,
      database: { ...this.store.stats(), ok: this.health.db_ok, detail: this.health.db_detail, recovered_from: this.health.db_recovered_from },
      queue: { depth: this.queue.length, limit: QUEUE_LIMIT },
      metrics: m,
      samples: this.samples,
      collectors: [...(this.supervisor?.status.values() ?? [])],
      watched_workspaces: this.fs?.watched() ?? [],
      tracked_roots: [...(this.tracker?.roots.values() ?? [])].map((r) => ({ adapter_id: r.adapter_id, pid: r.pid, name: r.name, session_id: r.session_id, descendants: r.descendants.size, cwd: r.cwd })),
      adapters: [...this.registry.health.values()],
      logs: this.log.recent.slice(-100),
    };
  }

  processTree() {
    const roots = [...(this.tracker?.roots.values() ?? [])];
    return roots.map((r) => ({
      adapter_id: r.adapter_id, pid: r.pid, name: r.name, exe: r.exe, session_id: r.session_id, started_at: r.started_at, cwd: r.cwd,
      children: [...r.descendants.values()].map((c) => ({ pid: c.pid, ppid: c.ppid, name: c.name, cmd: redactValue(c.cmd, new Set()) as string, started_at: c.started_at })),
    }));
  }

  graph(q: { from: number; session_id?: string; agent_id?: string; limit?: number }) {
    const events = this.store.queryEvents({ from: q.from, session_id: q.session_id, agent_id: q.agent_id, limit: Math.min(q.limit ?? 3000, 5000) });
    const nodes = new Map<string, { id: string; kind: string; label: string; weight: number; risk: number }>();
    const edges = new Map<string, { source: string; target: string; kind: string; count: number }>();
    const node = (id: string, kind: string, label: string, risk = 0) => {
      const n = nodes.get(id);
      if (n) { n.weight++; n.risk = Math.max(n.risk, risk); } else nodes.set(id, { id, kind, label: label.slice(0, 80), weight: 1, risk });
      return id;
    };
    const edge = (source: string, target: string, kind: string) => {
      const k = `${source}>${target}>${kind}`;
      const e = edges.get(k);
      if (e) e.count++; else edges.set(k, { source, target, kind, count: 1 });
    };
    for (const e of events) {
      const p = e.payload as Record<string, any>;
      const a = node(`agent:${e.agent_id}`, 'agent', e.agent_type, e.risk_score);
      const s = node(`session:${e.session_id}`, 'session', (e.session_id ?? '').slice(0, 24), e.risk_score);
      edge(s, a, 'belongs_to');
      if (e.process_id && e.source === 'process') edge(s, node(`process:${e.process_id}`, 'process', String(p.name ?? e.process_id)), 'spawned');
      switch (e.event_type) {
        case 'command_execution': edge(s, node(`command:${e.summary}`, 'command', String(e.summary), e.risk_score), 'executed'); break;
        case 'file_read': if (p.path) edge(s, node(`file:${p.path}`, 'file', basenameOf(p.path), e.risk_score), 'read'); break;
        case 'file_modified': case 'file_created': case 'file_deleted': if (p.path) edge(s, node(`file:${p.path}`, 'file', basenameOf(p.path), e.risk_score), 'modified'); break;
        case 'directory_access': if (p.path) edge(s, node(`dir:${p.path}`, 'directory', basenameOf(p.path), e.risk_score), 'read'); break;
        case 'tool_call': case 'tool_result': if (p.tool_name) edge(s, node(`tool:${p.tool_name}`, 'tool', String(p.tool_name)), 'called'); break;
        case 'mcp_call': {
          const srv = node(`mcp:${p.mcp_server}`, 'mcp_server', String(p.mcp_server), e.risk_score);
          edge(s, srv, 'called');
          if (p.mcp_tool) edge(srv, node(`tool:${p.tool_name ?? p.mcp_tool}`, 'tool', String(p.mcp_tool)), 'called');
          break;
        }
        case 'network_connection_metadata': edge(s, node(`net:${p.host ?? p.remote_ip}`, 'network_endpoint', String(p.host ?? p.remote_ip ?? p.url ?? '?'), e.risk_score), 'connected_to'); break;
        case 'security_detection': case 'policy_violation': {
          const d = node(`detection:${p.rule_id}:${e.session_id}`, 'security_event', String(p.rule_name ?? p.rule_id), e.risk_score);
          edge(d, s, 'detected_by');
          break;
        }
      }
    }
    // Keep the graph legible: most connected nodes first.
    const top = [...nodes.values()].sort((a, b) => (b.kind === 'agent' ? 1e9 : b.weight + b.risk * 10) - (a.kind === 'agent' ? 1e9 : a.weight + a.risk * 10)).slice(0, 400);
    const keep = new Set(top.map((n) => n.id));
    return { nodes: top, edges: [...edges.values()].filter((e) => keep.has(e.source) && keep.has(e.target)) };
  }

  exportEvents(q: EventQuery, format: 'jsonl' | 'csv', file: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const out = createWriteStream(file, { mode: 0o600 });
      let n = 0;
      out.on('error', reject);
      const cols = ['event_id', 'timestamp', 'agent_type', 'agent_id', 'session_id', 'event_type', 'source', 'fidelity', 'severity', 'risk_score', 'process_id', 'workspace', 'correlation_id', 'security_labels', 'payload'] as const;
      if (format === 'csv') out.write(`${cols.join(',')}\n`);
      for (const e of this.store.iterateEvents(q)) {
        if (format === 'jsonl') out.write(`${JSON.stringify(e)}\n`);
        else out.write(`${cols.map((c) => csvCell(c === 'timestamp' ? new Date(e.timestamp).toISOString() : (e as any)[c])).join(',')}\n`);
        n++;
      }
      out.end(() => resolve(n));
    });
  }

  diagnostics() {
    const cfg = structuredClone(this.cfg()) as any;
    if (cfg.alerts.webhook_url) cfg.alerts.webhook_url = '[set]';
    for (const k of Object.keys(cfg.export.otlp_headers ?? {})) cfg.export.otlp_headers[k] = '[redacted]';
    return { generated_at: new Date().toISOString(), health: this.systemHealth(), config: cfg, integrations: this.integrations(), note: 'Contains no events, prompts, file contents or tokens.' };
  }

  integrations() {
    return this.registry.all().filter((a) => a.integrations).flatMap((a) =>
      this.registry.guard(a.id, () => a.integrations!(this.home), []).map((i) => ({ ...i, adapter_id: a.id, adapter: a.displayName })));
  }

  installIntegration(adapterId: string, integrationId: string, install: boolean) {
    const a = this.registry.get(adapterId);
    if (!a?.install || !a.uninstall) throw new HttpError(404, 'adapter has no installable integration');
    const r = install ? a.install(integrationId, this.home, this.hookContext()) : a.uninstall(integrationId, this.home);
    this.log.info('integrations', `${install ? 'install' : 'uninstall'} ${adapterId}/${integrationId}`, { file: r.file, backup: r.backup, ok: r.ok });
    return r;
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
const basenameOf = (p: string) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);
let cachedUser: string | null = null;
const userName = () => (cachedUser ??= (() => { try { return userInfo().username; } catch { return null; } })());

export function pickBucket(spanMs: number) {
  const target = spanMs / 60;
  const steps = [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 3600_000, 3 * 3600_000, 6 * 3600_000, 86400_000];
  return steps.find((s) => s >= target) ?? 86400_000;
}

function csvCell(v: unknown) {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Neutralise spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
