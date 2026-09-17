import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  SEVERITIES, severityRank, upgradeEvent,
  type AgentEvent, type Severity, type Detection, type AgentRecord, type SessionRecord,
} from '../core/schema.ts';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_version INTEGER NOT NULL, ts INTEGER NOT NULL, host_id TEXT,
     agent_id TEXT NOT NULL, agent_type TEXT NOT NULL, agent_version TEXT, session_id TEXT,
     pid INTEGER, ppid INTEGER, workspace TEXT, event_type TEXT NOT NULL, source TEXT NOT NULL,
     fidelity TEXT NOT NULL, severity INTEGER NOT NULL, duration_ms REAL, risk_score REAL NOT NULL,
     correlation_id TEXT, trace_id TEXT, span_id TEXT, parent_span_id TEXT,
     labels TEXT NOT NULL, summary TEXT, tool TEXT, payload TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
   CREATE INDEX IF NOT EXISTS ix_events_session ON events(session_id, ts);
   CREATE INDEX IF NOT EXISTS ix_events_agent ON events(agent_id, ts);
   CREATE INDEX IF NOT EXISTS ix_events_type ON events(event_type, ts);
   CREATE INDEX IF NOT EXISTS ix_events_agent_type ON events(agent_type, ts);
   CREATE INDEX IF NOT EXISTS ix_events_workspace ON events(workspace, ts) WHERE workspace IS NOT NULL;
   CREATE INDEX IF NOT EXISTS ix_events_tool ON events(tool, ts) WHERE tool IS NOT NULL;
   CREATE INDEX IF NOT EXISTS ix_events_type_summary ON events(event_type, summary, ts);
   CREATE INDEX IF NOT EXISTS ix_events_corr ON events(correlation_id) WHERE correlation_id IS NOT NULL;
   CREATE TABLE IF NOT EXISTS agents (
     agent_id TEXT PRIMARY KEY, agent_type TEXT NOT NULL, display_name TEXT NOT NULL, version TEXT,
     runtime TEXT NOT NULL, executable TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
     trust TEXT NOT NULL DEFAULT 'unknown', installed INTEGER NOT NULL DEFAULT 0, running INTEGER NOT NULL DEFAULT 0,
     risk_score REAL NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}'
   );
   CREATE TABLE IF NOT EXISTS sessions (
     session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_type TEXT NOT NULL, pid INTEGER, workspace TEXT,
     user TEXT, started_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, ended_at INTEGER,
     event_count INTEGER NOT NULL DEFAULT 0, risk_score REAL NOT NULL DEFAULT 0, risk TEXT NOT NULL DEFAULT '{}'
   );
   CREATE INDEX IF NOT EXISTS ix_sessions_agent ON sessions(agent_id, last_activity);
   CREATE INDEX IF NOT EXISTS ix_sessions_activity ON sessions(last_activity);
   CREATE TABLE IF NOT EXISTS detections (
     detection_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, rule_id TEXT NOT NULL, rule_name TEXT NOT NULL,
     agent_id TEXT NOT NULL, agent_type TEXT NOT NULL, session_id TEXT, event_id TEXT NOT NULL,
     classification TEXT NOT NULL, dimension TEXT NOT NULL, severity INTEGER NOT NULL, confidence REAL NOT NULL,
     reason TEXT NOT NULL, evidence TEXT NOT NULL, recommended_action TEXT NOT NULL, related TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS ix_det_ts ON detections(ts);
   CREATE INDEX IF NOT EXISTS ix_det_session ON detections(session_id, ts);
   CREATE INDEX IF NOT EXISTS ix_det_agent ON detections(agent_id, ts);
   CREATE TABLE IF NOT EXISTS alerts (
     alert_id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL, incident_id TEXT NOT NULL, first_ts INTEGER NOT NULL,
     last_ts INTEGER NOT NULL, count INTEGER NOT NULL, rule_id TEXT NOT NULL, title TEXT NOT NULL,
     severity INTEGER NOT NULL, agent_id TEXT NOT NULL, agent_type TEXT NOT NULL, session_id TEXT,
     detection_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', acked_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS ix_alerts_dedup ON alerts(dedup_key, last_ts);
   CREATE INDEX IF NOT EXISTS ix_alerts_ts ON alerts(last_ts);
   CREATE TABLE IF NOT EXISTS inventory (
     kind TEXT NOT NULL, id TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id)
   );
   CREATE TABLE IF NOT EXISTS baselines (
     agent_type TEXT NOT NULL, metric TEXT NOT NULL, mean REAL NOT NULL, var REAL NOT NULL, n INTEGER NOT NULL,
     PRIMARY KEY (agent_type, metric)
   );`,
];

export interface EventQuery {
  from?: number;
  to?: number;
  agent_id?: string;
  agent_type?: string;
  session_id?: string;
  types?: string[];
  sources?: string[];
  min_severity?: Severity;
  search?: string;
  correlation_id?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export type StoredDetection = Detection;
export type AgentRow = AgentRecord & { risk_score: number; session_count?: number; meta: Record<string, any> };
export type SessionRow = SessionRecord & { risk: any };

export interface AlertRow {
  alert_id: string; dedup_key: string; incident_id: string; first_ts: number; last_ts: number; count: number;
  rule_id: string; title: string; severity: Severity; agent_id: string; agent_type: string; session_id: string | null;
  detection_id: string; status: 'open' | 'acknowledged' | 'suppressed'; acked_at: number | null;
}

type Row = Record<string, any>;

export class Store {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const fresh = path === ':memory:' || !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh && path !== ':memory:') {
      try { chmodSync(path, 0o600); } catch { /* best effort */ }
    }
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456;`);
      this.migrate();
    } catch (e) {
      this.db.close(); // release the file handle so a corrupt file can be moved aside
      throw e;
    }
  }

  private migrate() {
    const v = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version=${i + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private st(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  private inTx = false;

  /** Runs fn in a transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  close() {
    this.db.close();
  }

  // ---------- events ----------
  insertEvents(events: (AgentEvent & { summary?: string })[]) {
    const s = this.st(`INSERT OR IGNORE INTO events (event_id,event_version,ts,host_id,agent_id,agent_type,agent_version,session_id,pid,ppid,workspace,event_type,source,fidelity,severity,duration_ms,risk_score,correlation_id,trace_id,span_id,parent_span_id,labels,summary,tool,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.tx(() => {
      for (const e of events) {
        s.run(
          e.event_id, e.event_version, e.timestamp, e.host_id, e.agent_id, e.agent_type, e.agent_version, e.session_id,
          e.process_id, e.parent_process_id, e.workspace, e.event_type, e.source, e.fidelity, severityRank(e.severity),
          e.duration_ms, e.risk_score, e.correlation_id, e.trace_id, e.span_id, e.parent_span_id,
          JSON.stringify(e.security_labels), e.summary ?? null, typeof e.payload.tool_name === 'string' ? e.payload.tool_name.slice(0, 200) : null, JSON.stringify(e.payload),
        );
      }
    });
  }

  private eventWhere(q: EventQuery) {
    const w: string[] = [];
    const p: (string | number)[] = [];
    if (q.from != null) { w.push('ts >= ?'); p.push(q.from); }
    if (q.to != null) { w.push('ts <= ?'); p.push(q.to); }
    if (q.agent_id) { w.push('agent_id = ?'); p.push(q.agent_id); }
    if (q.agent_type) { w.push('agent_type = ?'); p.push(q.agent_type); }
    if (q.session_id) { w.push('session_id = ?'); p.push(q.session_id); }
    if (q.correlation_id) { w.push('correlation_id = ?'); p.push(q.correlation_id); }
    if (q.types?.length) { w.push(`event_type IN (${q.types.map(() => '?').join(',')})`); p.push(...q.types); }
    if (q.sources?.length) { w.push(`source IN (${q.sources.map(() => '?').join(',')})`); p.push(...q.sources); }
    if (q.min_severity) { w.push('severity >= ?'); p.push(severityRank(q.min_severity)); }
    if (q.search) {
      // ponytail: LIKE scan over summary within the indexed time/type window; add FTS5 table if search gets slow on >10M rows
      w.push(`(summary LIKE ? ESCAPE '\\' OR event_type LIKE ? ESCAPE '\\')`);
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      p.push(like, like);
    }
    return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
  }

  queryEvents(q: EventQuery) {
    const { where, params } = this.eventWhere(q);
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
    const order = q.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`SELECT * FROM events ${where} ORDER BY ts ${order}, id ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, Math.max(0, q.offset ?? 0)) as Row[];
    return rows.map(rowToEvent);
  }

  countEvents(q: EventQuery): number {
    const { where, params } = this.eventWhere(q);
    return Number((this.db.prepare(`SELECT COUNT(*) c FROM events ${where}`).get(...params) as Row).c);
  }

  getEvent(id: string) {
    const r = this.st('SELECT * FROM events WHERE event_id=?').get(id) as Row | undefined;
    return r ? rowToEvent(r) : null;
  }

  // ---------- agents & sessions ----------
  upsertAgent(a: AgentRecord & { meta?: Record<string, unknown> }) {
    this.st(`INSERT INTO agents (agent_id,agent_type,display_name,version,runtime,executable,first_seen,last_seen,trust,installed,running,meta)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(agent_id) DO UPDATE SET display_name=excluded.display_name, version=COALESCE(excluded.version,version),
               runtime=excluded.runtime, executable=COALESCE(excluded.executable,executable), last_seen=MAX(last_seen,excluded.last_seen),
               installed=MAX(installed,excluded.installed), running=excluded.running,
               meta=CASE WHEN excluded.meta='{}' THEN meta ELSE excluded.meta END`)
      .run(a.agent_id, a.agent_type, a.display_name, a.version, a.runtime, a.executable, a.first_seen, a.last_seen,
        a.trust, a.installed ? 1 : 0, a.running ? 1 : 0, JSON.stringify(a.meta ?? {}));
  }

  setAgentRunning(agentId: string, running: boolean) {
    this.st('UPDATE agents SET running=? WHERE agent_id=?').run(running ? 1 : 0, agentId);
  }

  setAgentTrust(agentId: string, trust: AgentRecord['trust']) {
    this.st('UPDATE agents SET trust=? WHERE agent_id=?').run(trust, agentId);
  }

  setAgentRisk(agentId: string, risk: number) {
    this.st('UPDATE agents SET risk_score=? WHERE agent_id=?').run(risk, agentId);
  }

  listAgents(): AgentRow[] {
    return (this.st(`SELECT a.*, (SELECT COUNT(*) FROM sessions s WHERE s.agent_id=a.agent_id) session_count
                     FROM agents a ORDER BY running DESC, last_seen DESC`).all() as Row[])
      .map((r) => ({ ...r, installed: !!r.installed, running: !!r.running, meta: JSON.parse(r.meta) }) as AgentRow);
  }

  getAgent(id: string): AgentRow | null {
    const r = this.st('SELECT * FROM agents WHERE agent_id=?').get(id) as Row | undefined;
    return r ? ({ ...r, installed: !!r.installed, running: !!r.running, meta: JSON.parse(r.meta) } as AgentRow) : null;
  }

  touchSession(s: Omit<SessionRecord, 'event_count' | 'risk_score' | 'ended_at'>, events = 1) {
    this.st(`INSERT INTO sessions (session_id,agent_id,agent_type,pid,workspace,user,started_at,last_activity,event_count)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(session_id) DO UPDATE SET last_activity=MAX(last_activity,excluded.last_activity),
               event_count=event_count+excluded.event_count, pid=COALESCE(pid,excluded.pid),
               workspace=COALESCE(workspace,excluded.workspace), user=COALESCE(user,excluded.user),
               started_at=MIN(started_at,excluded.started_at)`)
      .run(s.session_id, s.agent_id, s.agent_type, s.process_id, s.workspace, s.user, s.started_at, s.last_activity, events);
  }

  endSession(id: string, ts: number) {
    this.st('UPDATE sessions SET ended_at=? WHERE session_id=? AND ended_at IS NULL').run(ts, id);
  }

  setSessionRisk(id: string, score: number, explanation: unknown) {
    this.st('UPDATE sessions SET risk_score=?, risk=? WHERE session_id=?').run(score, JSON.stringify(explanation), id);
  }

  listSessions(q: { agent_id?: string; active_since?: number; limit?: number } = {}): SessionRow[] {
    const w: string[] = [];
    const p: (string | number)[] = [];
    if (q.agent_id) { w.push('agent_id=?'); p.push(q.agent_id); }
    if (q.active_since) { w.push('last_activity>=?'); p.push(q.active_since); }
    return (this.db.prepare(`SELECT * FROM sessions ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY last_activity DESC LIMIT ?`)
      .all(...p, Math.min(q.limit ?? 500, 5000)) as Row[]).map((r) => ({ ...r, risk: JSON.parse(r.risk) }) as SessionRow);
  }

  getSession(id: string): SessionRow | null {
    const r = this.st('SELECT * FROM sessions WHERE session_id=?').get(id) as Row | undefined;
    return r ? ({ ...r, risk: JSON.parse(r.risk) } as SessionRow) : null;
  }

  // ---------- detections & alerts ----------
  insertDetection(d: Detection) {
    this.st(`INSERT OR IGNORE INTO detections VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      d.detection_id, d.timestamp, d.rule_id, d.rule_name, d.agent_id, d.agent_type, d.session_id, d.event_id,
      d.classification, d.dimension, severityRank(d.severity), d.confidence, d.reason, JSON.stringify(d.evidence),
      d.recommended_action, JSON.stringify(d.related_event_ids),
    );
  }

  queryDetections(q: { from?: number; session_id?: string; agent_id?: string; min_severity?: Severity; limit?: number } = {}): Detection[] {
    const w: string[] = [];
    const p: (string | number)[] = [];
    if (q.from) { w.push('ts>=?'); p.push(q.from); }
    if (q.session_id) { w.push('session_id=?'); p.push(q.session_id); }
    if (q.agent_id) { w.push('agent_id=?'); p.push(q.agent_id); }
    if (q.min_severity) { w.push('severity>=?'); p.push(severityRank(q.min_severity)); }
    return (this.db.prepare(`SELECT * FROM detections ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`)
      .all(...p, Math.min(q.limit ?? 500, 10000)) as Row[]).map(rowToDetection);
  }

  findOpenAlert(dedupKey: string, since: number) {
    const r = this.st(`SELECT * FROM alerts WHERE dedup_key=? AND last_ts>=? ORDER BY last_ts DESC LIMIT 1`).get(dedupKey, since) as Row | undefined;
    return r ? rowToAlert(r) : null;
  }

  recentIncident(sessionOrAgent: string, since: number) {
    const r = this.st(`SELECT incident_id FROM alerts WHERE COALESCE(session_id, agent_id)=? AND last_ts>=? ORDER BY last_ts DESC LIMIT 1`)
      .get(sessionOrAgent, since) as Row | undefined;
    return r?.incident_id as string | undefined;
  }

  insertAlert(a: AlertRow) {
    this.st(`INSERT INTO alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      a.alert_id, a.dedup_key, a.incident_id, a.first_ts, a.last_ts, a.count, a.rule_id, a.title, severityRank(a.severity),
      a.agent_id, a.agent_type, a.session_id, a.detection_id, a.status, a.acked_at,
    );
  }

  bumpAlert(alertId: string, ts: number, detectionId: string) {
    this.st(`UPDATE alerts SET count=count+1, last_ts=?, detection_id=? WHERE alert_id=?`).run(ts, detectionId, alertId);
  }

  setAlertStatus(alertId: string, status: AlertRow['status']) {
    this.st(`UPDATE alerts SET status=?, acked_at=CASE WHEN ?='acknowledged' THEN ? ELSE acked_at END WHERE alert_id=?`)
      .run(status, status, Date.now(), alertId);
  }

  listAlerts(q: { status?: string; limit?: number; from?: number } = {}) {
    const w: string[] = [];
    const p: (string | number)[] = [];
    if (q.status) { w.push('status=?'); p.push(q.status); }
    if (q.from) { w.push('last_ts>=?'); p.push(q.from); }
    return (this.db.prepare(`SELECT * FROM alerts ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY last_ts DESC LIMIT ?`)
      .all(...p, Math.min(q.limit ?? 500, 5000)) as Row[]).map(rowToAlert);
  }

  countAlerts(status: string, from: number) {
    return Number((this.st('SELECT COUNT(*) c FROM alerts WHERE status=? AND last_ts>=?').get(status, from) as Row).c);
  }

  // ---------- inventory & baselines ----------
  putInventory(kind: string, id: string, data: unknown) {
    this.st(`INSERT INTO inventory VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET updated=excluded.updated, data=excluded.data`)
      .run(kind, id, Date.now(), JSON.stringify(data));
  }

  listInventory(kind: string) {
    return (this.st('SELECT * FROM inventory WHERE kind=? ORDER BY id').all(kind) as Row[]).map((r) => ({ id: r.id, updated: r.updated, ...JSON.parse(r.data) }));
  }

  getBaseline(agentType: string, metric: string) {
    return this.st('SELECT mean, var, n FROM baselines WHERE agent_type=? AND metric=?').get(agentType, metric) as { mean: number; var: number; n: number } | undefined;
  }

  putBaseline(agentType: string, metric: string, b: { mean: number; var: number; n: number }) {
    this.st(`INSERT INTO baselines VALUES (?,?,?,?,?) ON CONFLICT(agent_type,metric) DO UPDATE SET mean=excluded.mean, var=excluded.var, n=excluded.n`)
      .run(agentType, metric, b.mean, b.var, b.n);
  }

  // ---------- analytics ----------
  timeseries(from: number, to: number, bucketMs: number, groupBy: 'event_type' | 'agent_type' | 'severity' | null = null, types?: string[]) {
    const g = groupBy ?? `'all'`;
    const typeFilter = types?.length ? `AND event_type IN (${types.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, ${g} AS series, COUNT(*) AS n FROM events
                            WHERE ts BETWEEN ? AND ? ${typeFilter} GROUP BY bucket, series ORDER BY bucket`)
      .all(bucketMs, bucketMs, from, to, ...(types ?? [])) as { bucket: number; series: string | number; n: number }[];
  }

  countBy(field: 'event_type' | 'agent_type' | 'agent_id' | 'source' | 'workspace' | 'severity' | 'session_id' | 'tool', from: number, to: number, types?: string[], limit = 20) {
    const typeFilter = types?.length ? `AND event_type IN (${types.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT ${field} AS key, COUNT(*) AS n FROM events WHERE ts BETWEEN ? AND ? AND ${field} IS NOT NULL ${typeFilter}
                            GROUP BY key ORDER BY n DESC LIMIT ?`).all(from, to, ...(types ?? []), limit) as { key: string; n: number }[];
  }

  topSummaries(types: string[], from: number, to: number, limit = 15) {
    return this.db.prepare(`SELECT summary AS key, COUNT(*) AS n, MAX(risk_score) AS risk FROM events
                            WHERE ts BETWEEN ? AND ? AND event_type IN (${types.map(() => '?').join(',')}) AND summary IS NOT NULL
                            GROUP BY summary ORDER BY n DESC LIMIT ?`).all(from, to, ...types, limit) as { key: string; n: number; risk: number }[];
  }

  detectionCounts(from: number) {
    return this.db.prepare(`SELECT severity, dimension, rule_id, rule_name, COUNT(*) n FROM detections WHERE ts>=? GROUP BY severity, dimension, rule_id ORDER BY n DESC`)
      .all(from) as { severity: number; dimension: string; rule_id: string; rule_name: string; n: number }[];
  }

  hourOfWeek(from: number) {
    // SQLite strftime works in UTC; renderer shifts by local offset.
    return this.db.prepare(`SELECT CAST(strftime('%w', ts/1000, 'unixepoch') AS INTEGER) dow, CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) hour, COUNT(*) n
                            FROM events WHERE ts>=? GROUP BY dow, hour`).all(from) as { dow: number; hour: number; n: number }[];
  }

  // ---------- maintenance ----------
  applyRetention(days: number, maxEvents: number) {
    const cutoff = Date.now() - days * 86400_000;
    const del = this.tx(() => {
      const a = Number(this.st('DELETE FROM events WHERE ts < ?').run(cutoff).changes);
      this.st('DELETE FROM detections WHERE ts < ?').run(cutoff);
      this.st(`DELETE FROM alerts WHERE last_ts < ? AND status != 'open'`).run(cutoff);
      this.st('DELETE FROM sessions WHERE last_activity < ?').run(cutoff);
      const total = Number((this.st('SELECT COUNT(*) c FROM events').get() as Row).c);
      let b = 0;
      if (total > maxEvents) {
        const edge = this.st('SELECT ts FROM events ORDER BY ts DESC LIMIT 1 OFFSET ?').get(maxEvents) as Row | undefined;
        if (edge) b = Number(this.st('DELETE FROM events WHERE ts <= ?').run(edge.ts).changes);
      }
      return a + b;
    });
    if (del > 0) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return del;
  }

  integrityCheck(): { ok: boolean; detail: string } {
    const rows = this.db.prepare('PRAGMA quick_check').all() as Row[];
    const detail = rows.map((r) => Object.values(r)[0]).join('; ');
    return { ok: detail === 'ok', detail };
  }

  stats() {
    const one = (sql: string) => Number(Object.values(this.db.prepare(sql).get() as Row)[0]);
    const pageCount = one('PRAGMA page_count');
    const pageSize = one('PRAGMA page_size');
    return {
      events: one('SELECT COUNT(*) FROM events'),
      sessions: one('SELECT COUNT(*) FROM sessions'),
      agents: one('SELECT COUNT(*) FROM agents'),
      detections: one('SELECT COUNT(*) FROM detections'),
      alerts: one('SELECT COUNT(*) FROM alerts'),
      size_mb: Math.round(((pageCount * pageSize) / 1048576) * 10) / 10,
    };
  }

  *iterateEvents(q: EventQuery): Generator<AgentEvent> {
    const { where, params } = this.eventWhere(q);
    for (const r of this.db.prepare(`SELECT * FROM events ${where} ORDER BY ts ASC, id ASC`).iterate(...params)) yield rowToEvent(r as Row);
  }
}

export function rowToEvent(r: Row): AgentEvent & { summary: string | null } {
  const e = upgradeEvent({
    event_id: r.event_id, event_version: r.event_version, timestamp: r.ts, host_id: r.host_id ?? '',
    agent_id: r.agent_id, agent_type: r.agent_type, agent_version: r.agent_version, session_id: r.session_id,
    process_id: r.pid, parent_process_id: r.ppid, workspace: r.workspace, event_type: r.event_type, source: r.source,
    fidelity: r.fidelity, severity: SEVERITIES[r.severity] ?? 'INFO', duration_ms: r.duration_ms, payload: JSON.parse(r.payload),
    correlation_id: r.correlation_id, trace_id: r.trace_id, span_id: r.span_id, parent_span_id: r.parent_span_id,
    risk_score: r.risk_score, security_labels: JSON.parse(r.labels),
  });
  return { ...e, summary: r.summary ?? null };
}

function rowToDetection(r: Row): Detection {
  return {
    detection_id: r.detection_id, timestamp: r.ts, rule_id: r.rule_id, rule_name: r.rule_name, agent_id: r.agent_id,
    agent_type: r.agent_type, session_id: r.session_id, event_id: r.event_id, classification: r.classification,
    dimension: r.dimension, severity: SEVERITIES[r.severity] ?? 'INFO', confidence: r.confidence, reason: r.reason,
    evidence: JSON.parse(r.evidence), recommended_action: r.recommended_action, related_event_ids: JSON.parse(r.related),
  };
}

function rowToAlert(r: Row): AlertRow {
  return { ...(r as AlertRow), severity: SEVERITIES[r.severity] ?? 'INFO' };
}
