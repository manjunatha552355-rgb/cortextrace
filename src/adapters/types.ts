import type { EventInput } from '../core/schema.ts';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  exe: string | null;
  cmd: string;
  started_at: number | null;
  cwd?: string | null;
  user?: string | null;
}

export type Capability =
  | 'process_discovery' | 'hooks' | 'otlp' | 'approvals' | 'prompts' | 'tool_calls'
  | 'file_events' | 'mcp' | 'network' | 'require_approval';

export interface HookInstallResult {
  ok: boolean;
  file: string;
  backup: string | null;
  message: string;
}

export interface IntegrationStatus {
  id: string;
  kind: 'hooks' | 'otlp';
  label: string;
  file: string;
  installed: boolean;
  detail: string;
}

export interface HookContext {
  apiBase: string;
  ingestToken: string;
  otlpBase: string;
}

export interface HookDecision {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  runtime: string;
  capabilities: Capability[];
  /** Identity detection from a live process. Return null when the process is not this agent. */
  matchProcess(p: ProcInfo): { confidence: number } | null;
  /** Files whose existence indicates the agent is installed. */
  installPaths(home: string): string[];
  /** OTLP resource service.name values emitted by this agent. */
  otlpServiceNames?: string[];
  /** Maps a raw hook payload into normalized event inputs. */
  normalizeHook?(eventName: string, payload: Record<string, unknown>): EventInput[];
  /** Serialises a policy decision into the response body the runtime expects from its hook. */
  hookResponse?(eventName: string, decision: HookDecision | null): unknown;
  integrations?(home: string): IntegrationStatus[];
  install?(integrationId: string, home: string, ctx: HookContext): HookInstallResult;
  uninstall?(integrationId: string, home: string): HookInstallResult;
  versionFrom?(p: ProcInfo): string | null;
}
