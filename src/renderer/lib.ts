import { useEffect, useRef, useState, useCallback } from 'react';
import type { AgentEvent, Detection, Severity } from '../core/schema.ts';
import type { AlertRow } from '../storage/db.ts';

export type EventRow = AgentEvent & { summary: string | null };
export interface StreamBatch { events: EventRow[]; detections: Detection[]; alerts: AlertRow[] }

declare global {
  interface Window {
    cortex: {
      invoke<T = any>(channel: string, args?: unknown): Promise<T>;
      onStream(fn: (b: StreamBatch) => void): () => void;
      onNavigate(fn: (t: { page: string; [k: string]: unknown }) => void): () => void;
    };
  }
}

export const invoke = <T = any>(channel: string, args?: unknown) => window.cortex.invoke<T>(channel, args);

/** Polls an IPC query; pauses while the window is hidden. Keeps stale data during refetch (no flicker). */
export function useQuery<T>(channel: string, args: unknown, opts: { interval?: number; enabled?: boolean } = {}) {
  const key = JSON.stringify(args ?? null);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const refetch = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await invoke<T>(channel, args);
      if (my === seq.current) { setData(r); setError(null); }
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key]);

  useEffect(() => {
    if (opts.enabled === false) return;
    setLoading(true);
    void refetch();
    if (!opts.interval) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refetch(); }, opts.interval);
    return () => clearInterval(t);
  }, [refetch, opts.interval, opts.enabled]);

  return { data, error, loading, refetch };
}

export function useStream(fn: (b: StreamBatch) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => window.cortex.onStream((b) => ref.current(b)), []);
}

export const SEVERITIES: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const sevRank = (s: Severity) => SEVERITIES.indexOf(s);

export const RANGES = [
  { id: '15m', label: '15m', ms: 15 * 60_000 },
  { id: '1h', label: '1h', ms: 3600_000 },
  { id: '24h', label: '24h', ms: 86400_000 },
  { id: '7d', label: '7d', ms: 7 * 86400_000 },
  { id: '30d', label: '30d', ms: 30 * 86400_000 },
] as const;
export type RangeId = (typeof RANGES)[number]['id'];
export const rangeMs = (id: RangeId) => RANGES.find((r) => r.id === id)!.ms;

export const fmtNum = (n: number | null | undefined) => (n == null ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString());
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtTimeMs = (ts: number) => `${fmtTime(ts)}.${String(ts % 1000).padStart(3, '0')}`;
export const fmtDateTime = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function fmtAgo(ts: number | null | undefined) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
}

export const TYPE_LABEL: Record<string, string> = {
  agent_started: 'Agent started', agent_stopped: 'Agent stopped', session_started: 'Session started', session_completed: 'Session ended',
  prompt_observed: 'Prompt', response_metadata: 'Model response', tool_call: 'Tool call', tool_result: 'Tool result',
  command_execution: 'Command', process_started: 'Process', process_exited: 'Process exited', file_created: 'File created',
  file_modified: 'File modified', file_deleted: 'File deleted', file_read: 'File read', directory_access: 'Directory access',
  network_connection_metadata: 'Network', mcp_call: 'MCP call', mcp_server_activity: 'MCP server', approval_requested: 'Approval requested',
  approval_granted: 'Approved', approval_denied: 'Denied', authentication_event: 'Authentication', error: 'Error', warning: 'Warning',
  security_detection: 'Detection', policy_violation: 'Policy violation',
};

// Categorical order is fixed; an entity keeps its color regardless of rank or filters.
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
const assigned = new Map<string, Map<string, string>>();
/** Each namespace (agents, event types, risk dimensions…) has its own fixed-order palette; a 9th entity folds to neutral. */
export function seriesColor(key: string, namespace = 'agent') {
  let ns = assigned.get(namespace);
  if (!ns) assigned.set(namespace, (ns = new Map()));
  let c = ns.get(key);
  if (!c) {
    c = ns.size < SERIES.length ? SERIES[ns.size]! : 'var(--text-3)';
    ns.set(key, c);
  }
  return c;
}

export const DIM_LABEL: Record<string, string> = {
  command: 'Command', filesystem: 'Filesystem', network: 'Network', credential: 'Credential', privilege: 'Privilege',
  persistence: 'Persistence', data_access: 'Data access', mcp_tool: 'MCP / tool', anomaly: 'Anomaly', policy: 'Policy',
};

export function riskLevel(score: number) {
  return score >= 85 ? 'CRITICAL' : score >= 65 ? 'HIGH' : score >= 40 ? 'MEDIUM' : score >= 15 ? 'LOW' : 'INFO';
}

export function agentName(type: string) {
  const names: Record<string, string> = {
    'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', cursor: 'Cursor', codex: 'Codex', 'gemini-cli': 'Gemini CLI',
    'github-copilot': 'GitHub Copilot', 'github-copilot-cli': 'Copilot CLI', antigravity: 'Antigravity', windsurf: 'Windsurf', cline: 'Cline',
    'roo-code': 'Roo Code', opencode: 'OpenCode', aider: 'Aider', goose: 'goose', ollama: 'Ollama', 'lm-studio': 'LM Studio',
    'mcp-server': 'MCP server', 'python-agent': 'Python agent', 'node-agent': 'Node agent', 'llm-client': 'LLM client', 'chatgpt-desktop': 'ChatGPT',
  };
  return names[type] ?? type.replace(/^custom\.|^otel\./, '');
}
