import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_TYPES, type EventInput, type EventType } from '../core/schema.ts';
import type { CustomAgentDef } from '../core/config.ts';
import { redactText } from '../core/redact.ts';
import { BUILTIN_ADAPTERS, classifyTool } from './builtin.ts';
import type { AgentAdapter, ProcInfo } from './types.ts';

export interface AdapterHealth {
  id: string;
  display_name: string;
  capabilities: string[];
  errors: number;
  last_error: string | null;
  last_event_at: number | null;
  events: number;
  custom: boolean;
}

export function customAdapter(def: CustomAgentDef): AgentAdapter {
  let cmdRe: RegExp | null = null;
  try { cmdRe = def.command_line_regex ? new RegExp(def.command_line_regex, 'i') : null; } catch { cmdRe = null; }
  const names = def.process_names.map((n) => n.toLowerCase().replace(/\.exe$/, ''));
  return {
    id: `custom.${def.id}`,
    displayName: def.name,
    runtime: 'custom',
    capabilities: ['process_discovery', ...(def.telemetry.includes('hook') || def.telemetry.includes('api') ? (['hooks'] as const) : [])],
    matchProcess(p: ProcInfo) {
      const base = p.name.toLowerCase().replace(/\.exe$/, '');
      if (names.includes(base)) return { confidence: 0.9 };
      if (cmdRe && cmdRe.test(p.cmd)) return { confidence: 0.8 };
      return null;
    },
    installPaths: () => def.config_paths,
    normalizeHook(eventName, payload) {
      const mapped = def.event_mappings[eventName] ?? ((EVENT_TYPES as readonly string[]).includes(eventName) ? (eventName as EventType) : null);
      return [genericEvent(mapped, eventName, payload)];
    },
  };
}

// Normalises loosely-shaped payloads from custom agents and SDK clients.
export function genericEvent(type: EventType | null, eventName: string, p: Record<string, any>): EventInput {
  const base: Partial<EventInput> = {
    source: 'hook',
    session_id: typeof p.session_id === 'string' ? p.session_id : null,
    workspace: typeof p.cwd === 'string' ? p.cwd : typeof p.workspace === 'string' ? p.workspace : null,
    correlation_id: typeof p.correlation_id === 'string' ? p.correlation_id : null,
    process_id: Number.isInteger(p.pid) ? p.pid : null,
  };
  if (!type && typeof p.tool_name === 'string') {
    return classifyTool(p.tool_name, p.tool_input ?? {}, (t, payload) => ({ ...base, event_type: t, payload: { hook_event: eventName, ...payload } }) as EventInput);
  }
  return { ...base, event_type: type ?? 'response_metadata', payload: { hook_event: eventName, ...p } } as EventInput;
}

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();
  readonly health = new Map<string, AdapterHealth>();

  constructor(custom: CustomAgentDef[] = []) {
    for (const a of BUILTIN_ADAPTERS) this.add(a, false);
    this.setCustom(custom);
  }

  private add(a: AgentAdapter, custom: boolean) {
    this.adapters.set(a.id, a);
    const prev = this.health.get(a.id);
    this.health.set(a.id, prev ?? { id: a.id, display_name: a.displayName, capabilities: a.capabilities, errors: 0, last_error: null, last_event_at: null, events: 0, custom });
  }

  setCustom(defs: CustomAgentDef[]) {
    for (const id of [...this.adapters.keys()]) if (id.startsWith('custom.')) { this.adapters.delete(id); this.health.delete(id); }
    for (const d of defs) this.add(customAdapter(d), true);
  }

  get(id: string) {
    return this.adapters.get(id);
  }

  all() {
    return [...this.adapters.values()];
  }

  byOtlpService(serviceName: string) {
    const s = serviceName.toLowerCase();
    return this.all().find((a) => a.otlpServiceNames?.some((n) => s === n || s.startsWith(`${n}.`) || s.startsWith(`${n}-`)));
  }

  // One adapter throwing must never affect the others; failures are counted and surfaced in System Health.
  guard<T>(id: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      const h = this.health.get(id);
      if (h) { h.errors++; h.last_error = (e as Error).message.slice(0, 300); }
      return fallback;
    }
  }

  noteEvent(id: string) {
    const h = this.health.get(id);
    if (h) { h.events++; h.last_event_at = Date.now(); }
  }

  identify(p: ProcInfo): { adapter: AgentAdapter; confidence: number } | null {
    let best: { adapter: AgentAdapter; confidence: number } | null = null;
    for (const a of this.adapters.values()) {
      const m = this.guard(a.id, () => a.matchProcess(p), null);
      // Custom adapters win ties so users can override built-in identification.
      if (m && (!best || m.confidence > best.confidence || (m.confidence === best.confidence && a.id.startsWith('custom.')))) best = { adapter: a, confidence: m.confidence };
    }
    return best;
  }

  installed(home: string) {
    return this.all()
      .map((a) => ({ adapter: a, paths: this.guard(a.id, () => a.installPaths(home).filter((p) => existsSync(p)), [] as string[]) }))
      .filter((x) => x.paths.length > 0);
  }
}

// ---------- MCP configuration inventory ----------
export interface McpServerEntry {
  id: string;
  name: string;
  client: string;
  config_file: string;
  transport: 'stdio' | 'http' | 'unknown';
  command: string | null;
  url: string | null;
  env_keys: string[];
}

function readJsonSafe(file: string): any {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

function entriesFrom(client: string, file: string, servers: Record<string, any> | undefined): McpServerEntry[] {
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).map(([name, s]) => {
    const command = s?.command ? redactText([s.command, ...(Array.isArray(s.args) ? s.args : [])].join(' ')).text : null;
    const url = typeof s?.url === 'string' ? redactText(s.url).text : typeof s?.serverUrl === 'string' ? redactText(s.serverUrl).text : null;
    return {
      id: `${client}:${name}`,
      name,
      client,
      config_file: file,
      transport: command ? 'stdio' : url ? 'http' : 'unknown',
      command,
      url,
      // Only the names of environment variables are recorded, never their values.
      env_keys: s?.env && typeof s.env === 'object' ? Object.keys(s.env) : [],
    };
  });
}

export function scanMcpConfigs(home: string): McpServerEntry[] {
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const out: McpServerEntry[] = [];
  const claudeDesktop = [join(appData, 'Claude', 'claude_desktop_config.json'), join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), join(home, '.config', 'Claude', 'claude_desktop_config.json')];
  for (const f of claudeDesktop) out.push(...entriesFrom('claude-desktop', f, readJsonSafe(f)?.mcpServers));

  const claudeJson = join(home, '.claude.json');
  const cj = readJsonSafe(claudeJson);
  out.push(...entriesFrom('claude-code', claudeJson, cj?.mcpServers));
  for (const [proj, v] of Object.entries<any>(cj?.projects ?? {})) {
    out.push(...entriesFrom('claude-code', `${claudeJson}#${proj}`, v?.mcpServers));
  }
  for (const [client, f] of [
    ['cursor', join(home, '.cursor', 'mcp.json')],
    ['windsurf', join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    ['gemini-cli', join(home, '.gemini', 'settings.json')],
    ['antigravity', join(home, '.gemini', 'antigravity', 'mcp_config.json')],
    ['vscode', join(appData, 'Code', 'User', 'mcp.json')],
    ['vscode', join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')],
    ['vscode', join(home, '.config', 'Code', 'User', 'mcp.json')],
  ] as const) {
    const doc = readJsonSafe(f);
    out.push(...entriesFrom(client, f, doc?.mcpServers ?? doc?.servers));
  }
  const codexToml = join(home, '.codex', 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const text = readFileSync(codexToml, 'utf8');
      for (const m of text.matchAll(/^\[mcp_servers\.("?)([^\]"]+)\1\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
        const body = m[3] ?? '';
        const cmd = /^\s*command\s*=\s*"([^"]*)"/m.exec(body)?.[1];
        const url = /^\s*url\s*=\s*"([^"]*)"/m.exec(body)?.[1];
        out.push({ id: `codex:${m[2]}`, name: m[2]!, client: 'codex', config_file: codexToml, transport: cmd ? 'stdio' : url ? 'http' : 'unknown', command: cmd ? redactText(cmd).text : null, url: url ?? null, env_keys: [] });
      }
    } catch { /* unreadable */ }
  }
  return out;
}
