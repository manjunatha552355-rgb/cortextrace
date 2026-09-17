import { randomUUID } from 'node:crypto';
import type { AgentEvent, Detection, RiskDimension, Severity, Classification } from '../core/schema.ts';
import type { Config, Policy } from '../core/config.ts';
import type { Store } from '../storage/db.ts';
import { RULES, extractField, type Rule } from './rules.ts';
import { evaluatePolicies, globMatch } from './policy.ts';

const SECRET_LABELS = new Set(['private_key', 'aws_access_key', 'github_token', 'anthropic_key', 'openai_key', 'google_api_key', 'slack_token', 'stripe_key', 'jwt', 'bearer_token', 'url_credentials', 'assigned_secret']);
const FILE_CHANGE = new Set(['file_modified', 'file_created', 'file_deleted']);

interface SessionState {
  fileTimes: number[];
  deleteTimes: number[];
  distinctFiles: Set<string>;
  massFired: number;
  largeFired: boolean;
  lastSecretAccess: { ts: number; event_id: string; what: string } | null;
  deniedCommands: Map<string, number>;
  touched: number;
}

export interface DetectOutput {
  detections: Detection[];
  /** policies in require_approval mode that matched; used by hook handlers to return "ask" */
  approvals: Policy[];
}

/**
 * Layered detection:
 *  1. deterministic rules (rules.ts)
 *  2. user policies (confirmed policy violations)
 *  3. stateful heuristics (mass changes, secret-then-egress sequences, denied-then-executed)
 *  4. statistical anomaly (per agent type event-rate baseline, first-seen destinations/servers)
 * Each layer tags its classification so observations, indicators and violations stay distinct.
 */
export class Detector {
  private sessions = new Map<string, SessionState>();
  private minuteCounts = new Map<string, number>();
  private minuteStart = Math.floor(Date.now() / 60_000);
  private seenDest = new Set<string>();
  private seenMcp = new Set<string>();
  private knownMcpNames = new Set<string>();

  private store: Store;
  private config: () => Config;

  constructor(store: Store, config: () => Config) {
    this.store = store;
    this.config = config;
    for (const row of store.listInventory('net_dest')) this.seenDest.add(row.id);
    for (const row of store.listInventory('mcp_seen')) this.seenMcp.add(row.id);
  }

  setKnownMcpServers(names: string[]) {
    this.knownMcpNames = new Set(names.map((n) => n.toLowerCase()));
  }

  private state(sessionKey: string): SessionState {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      s = { fileTimes: [], deleteTimes: [], distinctFiles: new Set(), massFired: 0, largeFired: false, lastSecretAccess: null, deniedCommands: new Map(), touched: Date.now() };
      this.sessions.set(sessionKey, s);
      if (this.sessions.size > 5000) this.evictSessions();
    }
    s.touched = Date.now();
    return s;
  }

  private evictSessions() {
    const cutoff = Date.now() - 3600_000;
    for (const [k, v] of this.sessions) if (v.touched < cutoff) this.sessions.delete(k);
  }

  analyze(e: AgentEvent): DetectOutput {
    const cfg = this.config();
    const out: Detection[] = [];
    const disabled = new Set(cfg.detection.disabled_rules);
    const make = (
      rule_id: string, rule_name: string, severity: Severity, confidence: number, dimension: RiskDimension,
      classification: Classification, reason: string, evidence: string[], recommended_action: string, related: string[] = [],
    ) => {
      if (disabled.has(rule_id)) return;
      out.push({
        detection_id: randomUUID(), timestamp: e.timestamp, rule_id, rule_name, agent_id: e.agent_id, agent_type: e.agent_type,
        session_id: e.session_id, event_id: e.event_id, classification, dimension, severity, confidence, reason,
        evidence: evidence.map((x) => x.slice(0, 300)), recommended_action, related_event_ids: related,
      });
    };

    // 1. deterministic rules
    for (const r of RULES) {
      if (!r.event_types.includes(e.event_type)) continue;
      const text = extractField(e, r.field);
      if (!text) continue;
      const m = r.pattern.exec(text.slice(0, 20_000));
      if (!m || r.exclude?.test(text)) continue;
      make(r.id, r.name, r.severity, r.confidence, r.dimension, r.classification, r.description, [evidenceSnippet(r, text, m)], r.recommended_action);
    }

    // Secret material surfaced by redaction is itself a signal (values are never stored).
    const secretLabels = e.security_labels.filter((l) => SECRET_LABELS.has(l));
    if (secretLabels.length && e.event_type !== 'prompt_observed') {
      make('secret.exposed_in_activity', 'Secret value observed in agent activity', e.event_type === 'tool_result' ? 'MEDIUM' : 'LOW', 0.7, 'credential',
        'suspicious_indicator', 'A value matching a secret format appeared in agent input or output. It was redacted before storage.',
        [`secret types: ${secretLabels.join(', ')}`], 'Rotate the secret if it may have been sent to a model provider or external service.');
    }

    // 2. policies
    const matched = evaluatePolicies([...effectivePolicies(cfg)], e);
    for (const p of matched) {
      if (p.mode === 'observe') {
        make(`policy.${p.id}`, p.name, 'INFO', 1, p.dimension, 'observation', p.description || `Matched policy ${p.name}`, [summaryOf(e)], p.recommended_action);
      } else {
        make(`policy.${p.id}`, p.name, p.severity, 1, p.dimension, 'policy_violation', p.description || `Violated policy ${p.name}`, [summaryOf(e)], p.recommended_action);
      }
    }

    // 3. stateful heuristics
    const sessionKey = e.session_id ?? `agent:${e.agent_id}`;
    if (FILE_CHANGE.has(e.event_type)) this.fileHeuristics(e, sessionKey, cfg, make);
    this.sequenceHeuristics(e, sessionKey, out, cfg, make);

    // 4. anomaly / first-seen
    this.rateAnomaly(e, cfg, make);
    this.firstSeen(e, cfg, make);

    return { detections: out, approvals: matched.filter((p) => p.mode === 'require_approval') };
  }

  private fileHeuristics(e: AgentEvent, key: string, cfg: Config, make: MakeFn) {
    const s = this.state(key);
    const now = e.timestamp;
    const win = cfg.detection.mass_file_window_sec * 1000;
    s.fileTimes.push(now);
    if (e.event_type === 'file_deleted') s.deleteTimes.push(now);
    while (s.fileTimes.length && s.fileTimes[0]! < now - win) s.fileTimes.shift();
    while (s.deleteTimes.length && s.deleteTimes[0]! < now - win) s.deleteTimes.shift();
    const path = String((e.payload as any).path ?? '');
    if (path && s.distinctFiles.size < 100_000) s.distinctFiles.add(path);

    if (s.fileTimes.length >= cfg.detection.mass_file_threshold && now - s.massFired > win) {
      s.massFired = now;
      make('behavior.mass_file_modification', 'Mass file modification', 'HIGH', 0.7, 'filesystem', 'suspicious_indicator',
        `${s.fileTimes.length} file changes within ${cfg.detection.mass_file_window_sec}s (threshold ${cfg.detection.mass_file_threshold}).`,
        [`${s.fileTimes.length} changes in window`, `latest: ${path}`], 'Review the session diff; confirm a bulk refactor or generator was expected.');
    }
    const delThreshold = Math.max(5, Math.floor(cfg.detection.mass_file_threshold / 3));
    if (e.event_type === 'file_deleted' && s.deleteTimes.length === delThreshold) {
      make('behavior.mass_file_deletion', 'Mass file deletion', 'HIGH', 0.7, 'filesystem', 'suspicious_indicator',
        `${s.deleteTimes.length} files deleted within ${cfg.detection.mass_file_window_sec}s.`, [`latest: ${path}`], 'Check whether the deletions were intended and recoverable.');
    }
    if (!s.largeFired && s.distinctFiles.size >= 200) {
      s.largeFired = true;
      make('behavior.large_repository_change', 'Large-scale repository change', 'MEDIUM', 0.6, 'filesystem', 'observation',
        `Session has changed ${s.distinctFiles.size} distinct files.`, [`workspace: ${e.workspace ?? 'unknown'}`], 'Review the change set before committing.');
    }
  }

  private sequenceHeuristics(e: AgentEvent, key: string, current: Detection[], cfg: Config, make: MakeFn) {
    const s = this.state(key);
    const credentialHit = current.find((d) => d.dimension === 'credential' && d.classification !== 'observation');
    if (credentialHit) s.lastSecretAccess = { ts: e.timestamp, event_id: e.event_id, what: credentialHit.evidence[0] ?? credentialHit.rule_name };

    const p = e.payload as Record<string, any>;
    const isEgress =
      (e.event_type === 'network_connection_metadata' && !p.loopback && !hostAllowed(String(p.host ?? p.remote_ip ?? ''), cfg.detection.network_allowlist)) ||
      current.some((d) => d.rule_id === 'cmd.exfiltration.upload');
    if (isEgress && s.lastSecretAccess && e.timestamp - s.lastSecretAccess.ts <= 120_000 && s.lastSecretAccess.event_id !== e.event_id) {
      make('sequence.secret_access_then_egress', 'Credential access followed by outbound transfer', 'HIGH', 0.6, 'data_access', 'suspicious_indicator',
        'Within two minutes of accessing credential material, the same session contacted a non-allowlisted destination or uploaded data.',
        [`credential access: ${s.lastSecretAccess.what}`, `egress: ${summaryOf(e)}`],
        'Treat as possible exfiltration: identify the destination, rotate the accessed credentials.', [s.lastSecretAccess.event_id]);
      s.lastSecretAccess = null;
    }

    if (e.event_type === 'approval_denied') {
      const cmd = String(p.command ?? p.tool_input?.command ?? '');
      if (cmd) s.deniedCommands.set(cmd.trim(), e.timestamp);
    }
    if (e.event_type === 'command_execution' && typeof p.command === 'string' && s.deniedCommands.size) {
      const t = s.deniedCommands.get(p.command.trim());
      if (t && e.timestamp - t < 30 * 60_000) {
        make('approval.denied_then_executed', 'Denied action executed anyway', 'HIGH', 0.8, 'policy', 'policy_violation',
          'A command the user denied was subsequently executed in the same session.', [p.command], 'Investigate how the approval was bypassed.');
      }
    }
  }

  private rateAnomaly(e: AgentEvent, cfg: Config, make: MakeFn) {
    const minute = Math.floor(e.timestamp / 60_000);
    if (minute > this.minuteStart) this.rollMinute(minute);
    const key = e.agent_type;
    const n = (this.minuteCounts.get(key) ?? 0) + 1;
    this.minuteCounts.set(key, n);
    const b = this.store.getBaseline(key, 'events_per_minute');
    if (!b || b.n < 30 || n < 50) return;
    const threshold = b.mean + cfg.detection.anomaly_z * Math.sqrt(Math.max(b.var, 1));
    // fire once when crossing the threshold
    if (n === Math.ceil(threshold)) {
      make('anomaly.event_rate', 'Activity rate far above baseline', 'MEDIUM', 0.5, 'anomaly', 'suspicious_indicator',
        `${key} produced ${n} events this minute; baseline mean ${b.mean.toFixed(1)} (σ ${Math.sqrt(b.var).toFixed(1)}, n=${b.n}).`,
        [`z-threshold ${cfg.detection.anomaly_z}`], 'Check whether a runaway loop or unattended automation is active.');
    }
  }

  private rollMinute(minute: number) {
    // Update exponentially-weighted baselines for every agent type active in the finished minute.
    for (const [agentType, count] of this.minuteCounts) {
      const b = this.store.getBaseline(agentType, 'events_per_minute') ?? { mean: count, var: 0, n: 0 };
      const alpha = b.n < 30 ? 1 / (b.n + 1) : 0.05;
      const diff = count - b.mean;
      const mean = b.mean + alpha * diff;
      const variance = (1 - alpha) * (b.var + alpha * diff * diff);
      this.store.putBaseline(agentType, 'events_per_minute', { mean, var: variance, n: b.n + 1 });
    }
    this.minuteCounts.clear();
    this.minuteStart = minute;
  }

  private firstSeen(e: AgentEvent, cfg: Config, make: MakeFn) {
    const p = e.payload as Record<string, any>;
    if (e.event_type === 'network_connection_metadata' && !p.loopback) {
      const dest = String(p.host ?? p.remote_ip ?? '');
      if (!dest || hostAllowed(dest, cfg.detection.network_allowlist)) return;
      const id = `${e.agent_type}|${dest}`;
      if (this.seenDest.has(id)) return;
      this.seenDest.add(id);
      this.store.putInventory('net_dest', id, { agent_type: e.agent_type, destination: dest, first_seen: e.timestamp });
      const port = Number(p.remote_port ?? 443);
      const unusualPort = ![80, 443, 22, 53].includes(port);
      if (p.host || unusualPort) {
        make('network.unexpected_destination', 'First connection to non-allowlisted destination', unusualPort ? 'MEDIUM' : 'LOW', 0.5, 'network', 'observation',
          `${e.agent_type} connected to ${dest}${p.remote_port ? `:${p.remote_port}` : ''} for the first time; it is not on the network allowlist.`,
          [summaryOf(e)], 'Add the destination to the allowlist if expected, otherwise investigate.');
      }
    }
    if (e.event_type === 'mcp_call') {
      const server = String(p.mcp_server ?? '').toLowerCase();
      if (!server) return;
      const id = `${e.agent_type}|${server}`;
      const known = this.knownMcpNames.has(server) || cfg.detection.known_mcp_servers.map((s) => s.toLowerCase()).includes(server);
      if (this.seenMcp.has(id)) return;
      this.seenMcp.add(id);
      this.store.putInventory('mcp_seen', id, { agent_type: e.agent_type, server, first_seen: e.timestamp, configured: known });
      if (!known) {
        make('mcp.unknown_server', 'Call to an MCP server not found in any configuration', 'LOW', 0.5, 'mcp_tool', 'observation',
          `${e.agent_type} invoked tools on MCP server "${server}", which is not in scanned MCP configurations or the known-server list.`,
          [summaryOf(e)], 'Verify the MCP server origin and add it to known servers if trusted.');
      }
    }
  }
}

type MakeFn = (rule_id: string, rule_name: string, severity: Severity, confidence: number, dimension: RiskDimension, classification: Classification, reason: string, evidence: string[], recommended_action: string, related?: string[]) => void;

export function effectivePolicies(cfg: Config): Policy[] {
  return [...cfg.policies, ...cfg.custom_agents.flatMap((a) => a.policies.map((p) => ({ ...p, agent_types: p.agent_types.length ? p.agent_types : [`custom.${a.id}`] })))];
}

export function hostAllowed(host: string, allowlist: string[]) {
  const h = host.toLowerCase();
  return allowlist.some((pat) => {
    const p = pat.toLowerCase();
    if (p === h) return true;
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) || h === p.slice(2);
    return p.includes('*') || p.includes('?') ? globMatch(h, p) : false;
  });
}

export function binaryOf(command: string) {
  const rest = command.trim().replace(/^(?:(?:sudo|env|time|nohup)\s+)+/, '');
  const first = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(rest);
  const token = first?.[1] ?? first?.[2] ?? first?.[3] ?? '';
  return token.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
}

export function summaryOf(e: AgentEvent): string {
  const p = e.payload as Record<string, any>;
  const s = p.command ?? p.path ?? (p.mcp_server ? `${p.mcp_server}/${p.mcp_tool}` : undefined) ?? p.url ?? (p.host ? `${p.host}:${p.remote_port ?? ''}` : undefined)
    ?? (p.remote_ip ? `${p.remote_ip}:${p.remote_port}` : undefined) ?? p.tool_name ?? p.message ?? e.event_type;
  return String(s).slice(0, 300);
}

function evidenceSnippet(r: Rule, text: string, m: RegExpExecArray) {
  const start = Math.max(0, m.index - 40);
  const snippet = text.slice(start, m.index + m[0].length + 40);
  return `${r.field}: ${start > 0 ? '…' : ''}${snippet}${m.index + m[0].length + 40 < text.length ? '…' : ''}`;
}
