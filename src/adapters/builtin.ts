import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { platform } from 'node:os';
import type { EventInput, EventType } from '../core/schema.ts';
import type { AgentAdapter, Capability, HookContext, HookDecision, HookInstallResult, IntegrationStatus, ProcInfo } from './types.ts';

const IS_WIN = platform() === 'win32';
const MARKER = 'cortextrace';

// ---------- process signature helpers ----------
const exeBase = (p: ProcInfo) => basename((p.exe ?? p.name).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
const isHelper = (p: ProcInfo) => /\s--type=/.test(p.cmd); // Chromium/Electron helper processes are never agent roots

interface Signature {
  names?: string[]; // executable basenames without .exe, lower-case
  cmd?: RegExp; // command-line match (for interpreters like node/python)
  path?: RegExp; // executable path must match
  notPath?: RegExp;
  interpreters?: string[]; // when cmd is set, restrict to these interpreter basenames
}

function matchSignature(p: ProcInfo, sigs: Signature[]): { confidence: number } | null {
  if (isHelper(p)) return null;
  const base = exeBase(p);
  const full = (p.exe ?? '').replace(/\\/g, '/');
  for (const s of sigs) {
    if (s.path && !s.path.test(full)) continue;
    if (s.notPath && s.notPath.test(full)) continue;
    if (s.names && s.names.includes(base)) return { confidence: s.path ? 0.95 : 0.8 };
    if (s.cmd && (!s.interpreters || s.interpreters.includes(base)) && s.cmd.test(p.cmd)) return { confidence: 0.85 };
  }
  return null;
}

const CLAUDE_DESKTOP_PATH = /AnthropicClaude|Claude\.app|Programs\/Claude\/|WindowsApps\/Claude_|\/opt\/Claude/i;
const NODE = ['node', 'bun', 'deno', 'npx'];
const PY = ['python', 'python3', 'pythonw', 'py', 'uv', 'uvx', 'pipx'];

// ---------- config file helpers (backup before every write) ----------
function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  return text ? JSON.parse(text) : {};
}

function backupAndWrite(file: string, content: string): string | null {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.${MARKER}-backup-${Date.now()}`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, content, { mode: 0o600 });
  return backup;
}

const curl = IS_WIN ? 'curl.exe' : 'curl';
export function hookCommand(ctx: HookContext, adapter: string, event: string) {
  return `${curl} -sS -m 3 -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${ctx.ingestToken}" --data-binary "@-" "${ctx.apiBase}/v1/hooks/${adapter}/${event}?src=${MARKER}"`;
}
const isOurs = (cmd: unknown) => typeof cmd === 'string' && cmd.includes(`src=${MARKER}`);

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? undefined : JSON.stringify(v));
const hostOf = (url: unknown) => {
  try { return new URL(String(url)).hostname; } catch { return undefined; }
};

// ---------- Claude-style hook normalization (Claude Code, Codex hooks share this payload shape) ----------
export function normalizeClaudeStyle(eventName: string, p: Record<string, any>): EventInput[] {
  const base: Partial<EventInput> = {
    session_id: str(p.session_id) ?? null,
    workspace: str(p.cwd) ?? null,
    correlation_id: str(p.tool_use_id) ?? null,
    source: 'hook',
  };
  const tool = str(p.tool_name) ?? '';
  const input = (p.tool_input ?? {}) as Record<string, any>;
  const ev = (event_type: EventType, payload: Record<string, unknown>, extra: Partial<EventInput> = {}): EventInput =>
    ({ ...base, event_type, payload: { hook_event: eventName, ...payload }, ...extra }) as EventInput;

  switch (eventName) {
    case 'SessionStart':
      return [ev('session_started', { trigger: p.source, model: p.model, permission_mode: p.permission_mode })];
    case 'SessionEnd':
      return [ev('session_completed', { reason: p.reason })];
    case 'UserPromptSubmit':
      return [ev('prompt_observed', { prompt: p.prompt, prompt_length: typeof p.prompt === 'string' ? p.prompt.length : null })];
    case 'Stop':
    case 'SubagentStop':
      return [ev('response_metadata', { stop: true, subagent: eventName === 'SubagentStop', agent_type: p.agent_type })];
    case 'SubagentStart':
      return [ev('response_metadata', { subagent_start: true, agent_type: p.agent_type })];
    case 'Notification':
      return [ev(/permission|approv/i.test(String(p.message)) ? 'approval_requested' : 'warning', { message: p.message })];
    case 'PermissionRequest':
      return [ev('approval_requested', { tool_name: tool, tool_input: input })];
    case 'PreCompact':
      return [ev('response_metadata', { compact: p.trigger })];
    case 'PreToolUse':
      return [classifyTool(tool, input, ev)];
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const resp = p.tool_response;
      const failed = eventName === 'PostToolUseFailure' || (resp && typeof resp === 'object' && (resp.success === false || resp.is_error === true));
      return [ev('tool_result', {
        tool_name: tool,
        success: !failed,
        error: failed ? str(p.error ?? resp?.error) : undefined,
        output: resp,
        output_length: resp == null ? 0 : JSON.stringify(resp).length,
        exit_code: resp?.exit_code ?? resp?.exitCode,
      }, { severity: failed ? 'LOW' : 'INFO' })];
    }
    default:
      return [ev('response_metadata', { unmapped_hook: eventName, raw: p })];
  }
}

type Ev = (t: EventType, payload: Record<string, unknown>, extra?: Partial<EventInput>) => EventInput;

export function classifyTool(tool: string, input: Record<string, any>, ev: Ev): EventInput {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return ev('mcp_call', { tool_name: tool, mcp_server: mcp[1], mcp_tool: mcp[2], arguments: input });
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
    case 'Shell':
    case 'shell':
    case 'exec_command':
    case 'run_shell_command':
      return ev('command_execution', { tool_name: tool, command: str(input.command ?? input.cmd), description: input.description, cwd: input.cwd });
    case 'Read':
    case 'read_file':
    case 'NotebookRead':
      return ev('file_read', { tool_name: tool, path: str(input.file_path ?? input.path ?? input.notebook_path) });
    case 'Write':
    case 'write_file':
      return ev('file_modified', { tool_name: tool, path: str(input.file_path ?? input.path), content_length: str(input.content)?.length, operation: 'write' });
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'apply_patch':
    case 'replace':
      return ev('file_modified', { tool_name: tool, path: str(input.file_path ?? input.path ?? input.notebook_path), operation: 'edit' });
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'list_directory':
      return ev('directory_access', { tool_name: tool, path: str(input.path) ?? null, pattern: str(input.pattern) });
    case 'WebFetch':
    case 'web_fetch':
      return ev('network_connection_metadata', { tool_name: tool, url: str(input.url), host: hostOf(input.url), direction: 'outbound', via: 'tool' });
    default:
      return ev('tool_call', { tool_name: tool, arguments: input });
  }
}

function claudeHookResponse(eventName: string, d: HookDecision | null) {
  if (!d || d.decision === 'allow') return null;
  if (eventName === 'PreToolUse') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: `Cortextrace policy: ${d.reason}` } };
  }
  return null;
}

// ---------- Claude Code ----------
const CLAUDE_HOOK_EVENTS: [string, string | undefined][] = [
  ['SessionStart', undefined], ['SessionEnd', undefined], ['UserPromptSubmit', undefined], ['PreToolUse', '*'],
  ['PostToolUse', '*'], ['PostToolUseFailure', '*'], ['Notification', undefined], ['Stop', undefined],
  ['SubagentStart', undefined], ['SubagentStop', undefined], ['PermissionRequest', '*'],
];

function claudeLikeHooks(file: string, adapterId: string, events: [string, string | undefined][], ctx: HookContext): HookInstallResult {
  const doc = readJson(file);
  doc.hooks ??= {};
  for (const [name, matcher] of events) {
    const groups: any[] = (doc.hooks[name] ??= []);
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    cleaned.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCommand(ctx, adapterId, name), timeout: 5 }] });
    doc.hooks[name] = cleaned;
  }
  const backup = backupAndWrite(file, JSON.stringify(doc, null, 2));
  return { ok: true, file, backup, message: `Installed ${events.length} hooks` };
}

function removeClaudeLikeHooks(file: string): HookInstallResult {
  if (!existsSync(file)) return { ok: true, file, backup: null, message: 'Nothing to remove' };
  const doc = readJson(file);
  let removed = 0;
  for (const name of Object.keys(doc.hooks ?? {})) {
    doc.hooks[name] = (doc.hooks[name] as any[])
      .map((g) => {
        const before = (g.hooks ?? []).length;
        const hooks = (g.hooks ?? []).filter((h: any) => !isOurs(h.command));
        removed += before - hooks.length;
        return { ...g, hooks };
      })
      .filter((g) => g.hooks.length > 0);
    if (!doc.hooks[name].length) delete doc.hooks[name];
  }
  if (doc.hooks && !Object.keys(doc.hooks).length) delete doc.hooks;
  const backup = backupAndWrite(file, JSON.stringify(doc, null, 2));
  return { ok: true, file, backup, message: `Removed ${removed} hooks` };
}

const countOurHooks = (file: string) => {
  try {
    const doc = readJson(file);
    return Object.values(doc.hooks ?? {}).flatMap((gs: any) => gs.flatMap((g: any) => g.hooks ?? [g])).filter((h: any) => isOurs(h.command)).length;
  } catch {
    return -1;
  }
};

const CLAUDE_OTEL_ENV = (ctx: HookContext) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: ctx.otlpBase,
});

export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  runtime: 'node/native cli',
  capabilities: ['process_discovery', 'hooks', 'otlp', 'approvals', 'prompts', 'tool_calls', 'file_events', 'mcp', 'require_approval'],
  otlpServiceNames: ['claude-code'],
  matchProcess: (p) => matchSignature(p, [
    { names: ['claude'], notPath: CLAUDE_DESKTOP_PATH },
    { cmd: /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.js/i, interpreters: NODE },
  ]),
  installPaths: (home) => [join(home, '.claude'), join(home, '.claude.json')],
  normalizeHook: normalizeClaudeStyle,
  hookResponse: claudeHookResponse,
  integrations(home) {
    const file = join(home, '.claude', 'settings.json');
    let otel = false;
    try { otel = readJson(file).env?.OTEL_EXPORTER_OTLP_PROTOCOL === 'http/json' && !!readJson(file).env?.CLAUDE_CODE_ENABLE_TELEMETRY; } catch { /* unreadable */ }
    const n = countOurHooks(file);
    return [
      { id: 'hooks', kind: 'hooks', label: 'Claude Code hooks', file, installed: n > 0, detail: n < 0 ? 'settings.json unreadable' : `${n} Cortextrace hooks` },
      { id: 'otlp', kind: 'otlp', label: 'Claude Code OpenTelemetry', file, installed: otel, detail: otel ? 'exporting to local OTLP receiver' : 'not configured' },
    ];
  },
  install(id, home, ctx) {
    const file = join(home, '.claude', 'settings.json');
    if (id === 'hooks') return claudeLikeHooks(file, 'claude-code', CLAUDE_HOOK_EVENTS, ctx);
    const doc = readJson(file);
    doc.env = { ...(doc.env ?? {}), ...CLAUDE_OTEL_ENV(ctx) };
    return { ok: true, file, backup: backupAndWrite(file, JSON.stringify(doc, null, 2)), message: 'OpenTelemetry export enabled (prompts are not exported)' };
  },
  uninstall(id, home) {
    const file = join(home, '.claude', 'settings.json');
    if (id === 'hooks') return removeClaudeLikeHooks(file);
    if (!existsSync(file)) return { ok: true, file, backup: null, message: 'Nothing to remove' };
    const doc = readJson(file);
    for (const k of Object.keys(CLAUDE_OTEL_ENV({ apiBase: '', ingestToken: '', otlpBase: '' }))) if (doc.env) delete doc.env[k];
    return { ok: true, file, backup: backupAndWrite(file, JSON.stringify(doc, null, 2)), message: 'OpenTelemetry settings removed' };
  },
};

// ---------- Codex CLI ----------
export const codex: AgentAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  runtime: 'native cli',
  capabilities: ['process_discovery', 'hooks', 'otlp', 'tool_calls', 'approvals'],
  otlpServiceNames: ['codex', 'codex_cli_rs', 'codex-cli', 'codex_exec'],
  matchProcess: (p) => matchSignature(p, [
    { names: ['codex'] },
    { cmd: /@openai[\\/]codex/i, interpreters: NODE },
  ]),
  installPaths: (home) => [join(home, '.codex')],
  normalizeHook: normalizeClaudeStyle,
  hookResponse: claudeHookResponse,
  integrations(home) {
    const hooks = join(home, '.codex', 'hooks.json');
    const toml = join(home, '.codex', 'config.toml');
    const n = countOurHooks(hooks);
    const otel = existsSync(toml) && readFileSync(toml, 'utf8').includes(`# ${MARKER}:begin`);
    return [
      { id: 'hooks', kind: 'hooks', label: 'Codex hooks', file: hooks, installed: n > 0, detail: `${Math.max(n, 0)} Cortextrace hooks` },
      { id: 'otlp', kind: 'otlp', label: 'Codex OpenTelemetry', file: toml, installed: otel, detail: otel ? 'exporting to local OTLP receiver' : 'not configured' },
    ];
  },
  install(id, home, ctx) {
    if (id === 'hooks') {
      return claudeLikeHooks(join(home, '.codex', 'hooks.json'), 'codex',
        [['SessionStart', undefined], ['UserPromptSubmit', undefined], ['PreToolUse', '*'], ['PostToolUse', '*'], ['Stop', undefined]], ctx);
    }
    const file = join(home, '.codex', 'config.toml');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (text.includes(`# ${MARKER}:begin`)) return { ok: true, file, backup: null, message: 'Already configured' };
    if (/^\s*\[otel\]/m.test(text)) {
      return { ok: false, file, backup: null, message: 'config.toml already has an [otel] table; add an otlp-http exporter pointing at the local receiver manually' };
    }
    const block = `\n# ${MARKER}:begin\n[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "${ctx.otlpBase}/v1/logs", protocol = "json" } }\n# ${MARKER}:end\n`;
    return { ok: true, file, backup: backupAndWrite(file, text + block), message: 'OpenTelemetry export enabled' };
  },
  uninstall(id, home) {
    if (id === 'hooks') return removeClaudeLikeHooks(join(home, '.codex', 'hooks.json'));
    const file = join(home, '.codex', 'config.toml');
    if (!existsSync(file)) return { ok: true, file, backup: null, message: 'Nothing to remove' };
    const text = readFileSync(file, 'utf8').replace(new RegExp(`\\n?# ${MARKER}:begin[\\s\\S]*?# ${MARKER}:end\\n?`), '\n');
    return { ok: true, file, backup: backupAndWrite(file, text), message: 'OpenTelemetry block removed' };
  },
};

// ---------- Cursor ----------
const CURSOR_EVENTS = ['beforeSubmitPrompt', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile', 'afterFileEdit', 'stop'];

export function normalizeCursor(eventName: string, p: Record<string, any>): EventInput[] {
  const base = {
    source: 'hook' as const,
    session_id: str(p.conversation_id) ?? null,
    workspace: Array.isArray(p.workspace_roots) ? str(p.workspace_roots[0]) ?? null : null,
    correlation_id: str(p.generation_id) ?? null,
  };
  const e = (event_type: EventType, payload: Record<string, unknown>, extra: Partial<EventInput> = {}): EventInput[] =>
    [{ ...base, event_type, payload: { hook_event: eventName, ...payload }, ...extra }];
  switch (eventName) {
    case 'sessionStart': return e('session_started', {});
    case 'sessionEnd': return e('session_completed', { reason: p.reason });
    case 'beforeSubmitPrompt': return e('prompt_observed', { prompt: p.prompt, prompt_length: str(p.prompt)?.length ?? null });
    case 'beforeShellExecution': return e('command_execution', { command: p.command, cwd: p.cwd, tool_name: 'shell' });
    case 'afterShellExecution': return e('tool_result', { tool_name: 'shell', command: p.command, output: p.output, output_length: str(p.output)?.length ?? 0, success: true }, { duration_ms: typeof p.duration === 'number' ? p.duration : null });
    case 'beforeMCPExecution': return e('mcp_call', { tool_name: p.tool_name, mcp_server: p.url ?? p.command ?? 'unknown', mcp_tool: p.tool_name, arguments: safeParse(p.tool_input) });
    case 'afterMCPExecution': return e('tool_result', { tool_name: p.tool_name, output: p.result_json, output_length: str(p.result_json)?.length ?? 0, success: true }, { duration_ms: typeof p.duration === 'number' ? p.duration : null });
    // File contents from beforeReadFile are intentionally discarded; only the path and size are kept.
    case 'beforeReadFile': return e('file_read', { path: p.file_path, content_length: str(p.content)?.length ?? null });
    case 'afterFileEdit': return e('file_modified', { path: p.file_path, operation: 'edit', edit_count: Array.isArray(p.edits) ? p.edits.length : null });
    case 'stop': return e('response_metadata', { stop: true, status: p.status });
    default: return e('response_metadata', { unmapped_hook: eventName });
  }
}

const safeParse = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

export const cursor: AgentAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  runtime: 'electron ide',
  capabilities: ['process_discovery', 'hooks', 'prompts', 'tool_calls', 'file_events', 'mcp', 'require_approval'],
  matchProcess: (p) => matchSignature(p, [{ names: ['cursor'], notPath: /cursor-agent|resources\/app/i }]),
  installPaths: (home) => [join(home, '.cursor')],
  normalizeHook: normalizeCursor,
  hookResponse(eventName, d) {
    if (!eventName.startsWith('before')) return null;
    const permission = !d || d.decision === 'allow' ? 'allow' : d.decision;
    return { continue: true, permission, ...(d && d.decision !== 'allow' ? { userMessage: `Cortextrace policy: ${d.reason}`, agentMessage: `Blocked pending approval: ${d.reason}` } : {}) };
  },
  integrations(home) {
    const file = join(home, '.cursor', 'hooks.json');
    let n = 0;
    try { n = Object.values(readJson(file).hooks ?? {}).flat().filter((h: any) => isOurs(h.command)).length; } catch { n = -1; }
    return [{ id: 'hooks', kind: 'hooks', label: 'Cursor hooks', file, installed: n > 0, detail: n < 0 ? 'hooks.json unreadable' : `${n} Cortextrace hooks` }];
  },
  install(_id, home, ctx) {
    const file = join(home, '.cursor', 'hooks.json');
    const doc = readJson(file);
    doc.version ??= 1;
    doc.hooks ??= {};
    for (const name of CURSOR_EVENTS) {
      doc.hooks[name] = [...(doc.hooks[name] ?? []).filter((h: any) => !isOurs(h.command)), { command: hookCommand(ctx, 'cursor', name) }];
    }
    return { ok: true, file, backup: backupAndWrite(file, JSON.stringify(doc, null, 2)), message: `Installed ${CURSOR_EVENTS.length} hooks` };
  },
  uninstall(_id, home) {
    const file = join(home, '.cursor', 'hooks.json');
    if (!existsSync(file)) return { ok: true, file, backup: null, message: 'Nothing to remove' };
    const doc = readJson(file);
    for (const k of Object.keys(doc.hooks ?? {})) {
      doc.hooks[k] = doc.hooks[k].filter((h: any) => !isOurs(h.command));
      if (!doc.hooks[k].length) delete doc.hooks[k];
    }
    return { ok: true, file, backup: backupAndWrite(file, JSON.stringify(doc, null, 2)), message: 'Hooks removed' };
  },
};

// ---------- Gemini CLI (OTLP) ----------
export const geminiCli: AgentAdapter = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  runtime: 'node cli',
  capabilities: ['process_discovery', 'otlp', 'tool_calls'],
  otlpServiceNames: ['gemini-cli', 'gemini_cli'],
  matchProcess: (p) => matchSignature(p, [{ names: ['gemini'] }, { cmd: /@google[\\/]gemini-cli|gemini-cli[\\/].*index\.js/i, interpreters: NODE }]),
  installPaths: (home) => [join(home, '.gemini')],
  integrations(home) {
    const file = join(home, '.gemini', 'settings.json');
    let ok = false;
    try { ok = String(readJson(file).telemetry?.otlpEndpoint ?? '').includes('127.0.0.1'); } catch { /* unreadable */ }
    return [{ id: 'otlp', kind: 'otlp', label: 'Gemini CLI telemetry', file, installed: ok, detail: ok ? 'exporting to local OTLP receiver' : 'not configured' }];
  },
  install(_id, home, ctx) {
    const file = join(home, '.gemini', 'settings.json');
    const doc = readJson(file);
    doc.telemetry = { ...(doc.telemetry ?? {}), enabled: true, target: 'local', otlpEndpoint: ctx.otlpBase, otlpProtocol: 'http', logPrompts: false };
    return { ok: true, file, backup: backupAndWrite(file, JSON.stringify(doc, null, 2)), message: 'Telemetry enabled (prompt logging off)' };
  },
  uninstall(_id, home) {
    const file = join(home, '.gemini', 'settings.json');
    if (!existsSync(file)) return { ok: true, file, backup: null, message: 'Nothing to remove' };
    const doc = readJson(file);
    delete doc.telemetry;
    return { ok: true, file, backup: backupAndWrite(file, JSON.stringify(doc, null, 2)), message: 'Telemetry settings removed' };
  },
};

// ---------- process/config-only adapters ----------
function simple(id: string, displayName: string, runtime: string, sigs: Signature[], installPaths: (h: string) => string[], extra: Capability[] = [], otlp?: string[]): AgentAdapter {
  return { id, displayName, runtime, capabilities: ['process_discovery', ...extra], matchProcess: (p) => matchSignature(p, sigs), installPaths, otlpServiceNames: otlp };
}

const appData = (home: string) => process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
const localAppData = (home: string) => process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
const macApp = (name: string) => `/Applications/${name}.app`;

function vscodeExtension(home: string, prefix: string) {
  const dirs = [join(home, '.vscode', 'extensions'), join(home, '.vscode-insiders', 'extensions'), join(home, '.cursor', 'extensions'), join(home, '.windsurf', 'extensions')];
  const hits: string[] = [];
  for (const d of dirs) {
    try { for (const e of readdirSync(d)) if (e.toLowerCase().startsWith(prefix)) hits.push(join(d, e)); } catch { /* dir missing */ }
  }
  return hits;
}

let copilotCache = { at: 0, value: false };
function copilotInstalled() {
  if (Date.now() - copilotCache.at > 60_000) {
    copilotCache = { at: Date.now(), value: vscodeExtension(process.env.HOME ?? process.env.USERPROFILE ?? '', 'github.copilot').length > 0 };
  }
  return copilotCache.value;
}

export const processAdapters: AgentAdapter[] = [
  simple('claude-desktop', 'Claude Desktop / Cowork', 'electron app',
    [{ names: ['claude'], path: CLAUDE_DESKTOP_PATH }],
    (h) => [join(appData(h), 'Claude'), join(h, 'Library', 'Application Support', 'Claude'), macApp('Claude')], ['mcp'], ['claude-cowork']),
  simple('chatgpt-desktop', 'ChatGPT Desktop', 'native app', [{ names: ['chatgpt'] }],
    (h) => (IS_WIN ? [join(localAppData(h), 'Programs', 'ChatGPT')] : [macApp('ChatGPT')])),
  simple('antigravity', 'Google Antigravity', 'electron ide', [{ names: ['antigravity'] }],
    (h) => [join(h, '.antigravity'), join(localAppData(h), 'Programs', 'Antigravity'), macApp('Antigravity')], ['mcp']),
  simple('windsurf', 'Windsurf', 'electron ide', [{ names: ['windsurf'] }], (h) => [join(h, '.codeium', 'windsurf'), macApp('Windsurf')], ['mcp']),
  simple('github-copilot-cli', 'GitHub Copilot CLI', 'node cli', [{ names: ['copilot'] }, { cmd: /@github[\\/]copilot/i, interpreters: NODE }],
    (h) => [join(h, '.copilot')], ['otlp'], ['github-copilot', 'copilot-cli']),
  {
    ...simple('github-copilot', 'GitHub Copilot (VS Code)', 'vscode extension', [{ names: ['code', 'code-insiders'] }], (h) => vscodeExtension(h, 'github.copilot'), ['mcp']),
    matchProcess: (p) => (copilotInstalled() ? matchSignature(p, [{ names: ['code', 'code-insiders'] }]) : null),
  },
  simple('cline', 'Cline', 'vscode extension', [{ names: ['cline'] }, { cmd: /saoudrizwan\.claude-dev|[\\/]cline[\\/]/i, interpreters: NODE }], (h) => [...vscodeExtension(h, 'saoudrizwan.claude-dev'), join(h, '.cline')]),
  simple('roo-code', 'Roo Code', 'vscode extension', [{ cmd: /rooveterinaryinc\.roo-cline/i, interpreters: NODE }], (h) => vscodeExtension(h, 'rooveterinaryinc.roo-cline')),
  simple('opencode', 'OpenCode', 'native cli', [{ names: ['opencode'] }, { cmd: /opencode-ai|[\\/]opencode[\\/]/i, interpreters: NODE }], (h) => [join(h, '.config', 'opencode'), join(h, '.opencode')], ['otlp']),
  simple('aider', 'Aider', 'python cli', [{ names: ['aider'] }, { cmd: /\baider(?:-chat)?\b/i, interpreters: PY }], (h) => [join(h, '.aider.conf.yml')]),
  simple('goose', 'goose', 'native cli', [{ names: ['goose', 'goosed'] }], (h) => [join(h, '.config', 'goose')], ['otlp'], ['goose']),
  simple('amp', 'Amp', 'node cli', [{ names: ['amp'] }, { cmd: /@sourcegraph[\\/]amp/i, interpreters: NODE }], (h) => [join(h, '.config', 'amp')]),
  simple('kiro', 'Kiro', 'electron ide', [{ names: ['kiro'] }], (h) => [join(h, '.kiro')]),
  simple('ollama', 'Ollama (local LLM)', 'local llm server', [{ names: ['ollama', 'ollama app'] }], (h) => [join(h, '.ollama')]),
  simple('lm-studio', 'LM Studio (local LLM)', 'local llm server', [{ names: ['lm studio', 'lms'] }], (h) => [join(h, '.lmstudio'), join(h, '.cache', 'lm-studio')]),
  simple('llama-cpp', 'llama.cpp server', 'local llm server', [{ names: ['llama-server', 'llama-cli'] }], () => []),
  simple('mcp-server', 'MCP server process', 'mcp', [
    { cmd: /@modelcontextprotocol[\\/]|\bmcp-server[-\w]*\b|\bmcp_server\b|fastmcp|\bmcp\s+(?:run|serve)\b/i, interpreters: [...NODE, ...PY, 'docker'] },
    { names: ['github-mcp-server'] },
  ], () => [], ['mcp']),
  simple('python-agent', 'Python agent framework', 'python', [
    { cmd: /\b(langgraph|langchain|autogen|crewai|smolagents|openai[-_]agents|pydantic[-_]ai|llama[-_]index|agno|letta)\b/i, interpreters: PY },
  ], () => []),
  simple('node-agent', 'Node.js agent framework', 'node', [
    { cmd: /@openai[\\/]agents|@anthropic-ai[\\/]claude-agent-sdk|@mastra[\\/]|langchain|@voltagent[\\/]/i, interpreters: NODE },
  ], () => []),
];

export const BUILTIN_ADAPTERS: AgentAdapter[] = [claudeCode, codex, cursor, geminiCli, ...processAdapters];
