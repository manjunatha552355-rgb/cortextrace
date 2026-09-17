import type { AgentEvent } from '../core/schema.ts';
import type { Condition, Policy } from '../core/config.ts';

export function getField(e: AgentEvent, path: string): unknown {
  let cur: unknown = e;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const regexCache = new Map<string, RegExp | null>();
function re(src: string) {
  if (!regexCache.has(src)) {
    try { regexCache.set(src, new RegExp(src, 'i')); } catch { regexCache.set(src, null); }
    if (regexCache.size > 2000) regexCache.clear();
  }
  return regexCache.get(src) ?? null;
}

const globCache = new Map<string, RegExp>();

/** Compiles a path glob (**, *, ?, {a,b}) to a cached case-insensitive regex. Backslashes are treated as separators. */
export function globToRegex(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (re) return re;
  const p = pattern.replace(/\\/g, '/');
  let src = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      const slash = p[i + 2] === '/';
      src += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end < 0) { src += '\\{'; continue; }
      src += `(?:${p.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else src += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  re = new RegExp(`^${src}$`, 'i');
  if (globCache.size > 5000) globCache.clear();
  globCache.set(pattern, re);
  return re;
}

export const globMatch = (value: string, pattern: string) => globToRegex(pattern).test(value.replace(/\\/g, '/'));

export function evalCondition(e: AgentEvent, c: Condition): boolean {
  const v = getField(e, c.field);
  const list = Array.isArray(c.value) ? c.value.map(String) : [String(c.value ?? '')];
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null && v !== '';
    case 'equals': return v != null && String(v) === String(c.value);
    case 'contains': return typeof v === 'string' && list.some((x) => v.toLowerCase().includes(x.toLowerCase()));
    case 'matches': return typeof v === 'string' && list.some((x) => re(x)?.test(v) ?? false);
    case 'glob': return typeof v === 'string' && list.some((x) => globMatch(v, x));
    case 'in': return v != null && list.includes(String(v));
    case 'not_in': return v != null && v !== '' && !list.some((x) => String(v) === x || (x.includes('*') && globMatch(String(v), x)));
    case 'gt': return typeof v === 'number' && v > Number(c.value);
    case 'lt': return typeof v === 'number' && v < Number(c.value);
  }
}

export function policyApplies(p: Policy, e: AgentEvent) {
  return p.enabled
    && p.event_types.includes(e.event_type)
    && (p.agent_types.length === 0 || p.agent_types.includes(e.agent_type))
    && p.conditions.every((c) => evalCondition(e, c));
}

export function evaluatePolicies(policies: Policy[], e: AgentEvent): Policy[] {
  return policies.filter((p) => policyApplies(p, e));
}

export const DEFAULT_POLICIES: Policy[] = [
  {
    id: 'sensitive-directories', name: 'Access to sensitive directories', enabled: true, mode: 'alert', severity: 'HIGH', dimension: 'credential',
    description: 'Flags any agent access to SSH, cloud, GPG and Kubernetes credential directories.',
    event_types: ['file_read', 'file_modified', 'file_created', 'file_deleted', 'directory_access'], agent_types: [],
    conditions: [{ field: 'payload.path', op: 'glob', value: ['**/.ssh/**', '**/.aws/**', '**/.gnupg/**', '**/.kube/**', '**/.config/gcloud/**', '**/.azure/**'] }],
    recommended_action: 'Confirm the agent needed access to this credential directory.',
  },
  {
    id: 'destructive-commands', name: 'Destructive shell commands', enabled: true, mode: 'alert', severity: 'MEDIUM', dimension: 'command',
    description: 'Recursive force deletes and force pushes require a human to confirm.',
    event_types: ['command_execution'], agent_types: [],
    conditions: [{ field: 'payload.command', op: 'matches', value: ['\\brm\\s+-[a-z]*r[a-z]*f|\\brm\\s+-[a-z]*f[a-z]*r', 'git\\s+push\\s+.*(--force|-f\\b)', 'Remove-Item\\s+.*-Recurse'] }],
    recommended_action: 'Review what was deleted or overwritten.',
  },
  {
    id: 'package-installation', name: 'Package installation', enabled: true, mode: 'observe', severity: 'LOW', dimension: 'command',
    description: 'Records dependency installs so supply-chain changes are reviewable.',
    event_types: ['command_execution'], agent_types: [],
    conditions: [{ field: 'payload.command', op: 'matches', value: ['\\b(npm|pnpm|yarn|bun)\\s+(add|install|i)\\s+[@\\w]', '\\bpip3?\\s+install\\s+[\\w-]', '\\bcargo\\s+(add|install)\\b'] }],
    recommended_action: 'Check new dependencies before merging.',
  },
  {
    id: 'agent-self-configuration', name: 'Agent edits its own configuration', enabled: true, mode: 'alert', severity: 'MEDIUM', dimension: 'policy',
    description: 'Agents should not rewrite hooks, permissions or MCP server lists without a human.',
    event_types: ['file_modified', 'file_created'], agent_types: [],
    conditions: [{ field: 'payload.path', op: 'glob', value: ['**/.claude/settings*.json', '**/.cursor/hooks.json', '**/.cursor/mcp.json', '**/.codex/config.toml', '**/.mcp.json'] }],
    recommended_action: 'Diff the configuration change.',
  },
];
