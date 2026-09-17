import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { SEVERITIES, EVENT_TYPES, RISK_DIMENSIONS } from './schema.ts';

const conditionSchema = z.object({
  field: z.string().min(1).max(200),
  op: z.enum(['equals', 'contains', 'matches', 'glob', 'in', 'not_in', 'gt', 'lt', 'exists']),
  value: z.unknown().optional(),
});

export const policySchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
  mode: z.enum(['observe', 'alert', 'require_approval']).default('alert'),
  event_types: z.array(z.enum(EVENT_TYPES)).min(1),
  agent_types: z.array(z.string()).default([]),
  conditions: z.array(conditionSchema).min(1),
  severity: z.enum(SEVERITIES).default('MEDIUM'),
  dimension: z.enum(RISK_DIMENSIONS).default('policy'),
  recommended_action: z.string().max(500).default('Review the event and confirm the agent was expected to do this.'),
});
export type Policy = z.infer<typeof policySchema>;
export type Condition = z.infer<typeof conditionSchema>;

export const customAgentSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1).max(120),
  process_names: z.array(z.string().max(200)).default([]),
  command_line_regex: z.string().max(500).optional(),
  config_paths: z.array(z.string().max(1024)).default([]),
  telemetry: z.array(z.enum(['process', 'hook', 'otlp', 'api'])).default(['process']),
  event_mappings: z.record(z.string(), z.enum(EVENT_TYPES)).default({}),
  capabilities: z.array(z.string().max(64)).default([]),
  policies: z.array(policySchema).default([]),
});
export type CustomAgentDef = z.infer<typeof customAgentSchema>;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  monitoring: z.object({
    paused: z.boolean().default(false),
    process: z.object({ enabled: z.boolean().default(true), interval_ms: z.number().int().min(1000).max(600000).default(5000) }).prefault({}),
    network: z.object({ enabled: z.boolean().default(true), interval_ms: z.number().int().min(2000).max(600000).default(10000) }).prefault({}),
    filesystem: z.object({
      enabled: z.boolean().default(true),
      max_workspaces: z.number().int().min(0).max(128).default(16),
      ignore: z.array(z.string()).default(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv']),
    }).prefault({}),
    otlp: z.object({ enabled: z.boolean().default(true), port: z.number().int().min(1024).max(65535).default(4318) }).prefault({}),
    discovery_interval_ms: z.number().int().min(10000).default(60000),
  }).prefault({}),
  api: z.object({
    port: z.number().int().min(1024).max(65535).default(47631),
    rate_limit_per_sec: z.number().int().min(1).max(10000).default(500),
  }).prefault({}),
  privacy: z.object({
    prompts: z.enum(['metadata', 'redacted', 'full']).default('metadata'),
    tool_output: z.enum(['metadata', 'redacted']).default('metadata'),
    command_lines: z.enum(['redacted', 'metadata']).default('redacted'),
    custom_patterns: z.array(z.object({ label: z.string(), regex: z.string() })).default([]),
  }).prefault({}),
  retention: z.object({
    days: z.number().int().min(1).max(3650).default(30),
    max_events: z.number().int().min(10000).default(5_000_000),
  }).prefault({}),
  risk: z.object({
    thresholds: z.object({
      low: z.number().min(0).max(100).default(15),
      medium: z.number().min(0).max(100).default(40),
      high: z.number().min(0).max(100).default(65),
      critical: z.number().min(0).max(100).default(85),
    }).prefault({}),
  }).prefault({}),
  alerts: z.object({
    min_severity: z.enum(SEVERITIES).default('MEDIUM'),
    desktop_notifications: z.boolean().default(true),
    notify_min_severity: z.enum(SEVERITIES).default('HIGH'),
    dedup_window_sec: z.number().int().min(0).default(600),
    webhook_url: z.string().url().nullable().default(null),
    suppressions: z.array(z.object({ rule_id: z.string(), agent_type: z.string().optional(), until: z.number().optional() })).default([]),
  }).prefault({}),
  detection: z.object({
    mass_file_threshold: z.number().int().min(5).default(60),
    mass_file_window_sec: z.number().int().min(5).default(60),
    anomaly_z: z.number().min(1).default(4),
    network_allowlist: z.array(z.string()).default([
      '*.anthropic.com', '*.openai.com', '*.githubcopilot.com', '*.github.com', 'github.com', '*.githubusercontent.com',
      '*.cursor.sh', '*.cursor.com', '*.googleapis.com', '*.npmjs.org', 'registry.npmjs.org', 'pypi.org', '*.pythonhosted.org',
      '127.0.0.1', '::1', 'localhost',
    ]),
    known_mcp_servers: z.array(z.string()).default([]),
    disabled_rules: z.array(z.string()).default([]),
  }).prefault({}),
  export: z.object({
    otlp_endpoint: z.string().url().nullable().default(null),
    otlp_headers: z.record(z.string(), z.string()).default({}),
  }).prefault({}),
  policies: z.array(policySchema).default([]),
  custom_agents: z.array(customAgentSchema).default([]),
  ui: z.object({
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    start_on_login: z.boolean().default(false),
    onboarded: z.boolean().default(false),
    minimize_to_tray: z.boolean().default(true),
  }).prefault({}),
});
export type Config = z.infer<typeof configSchema>;

export const defaultConfig = (): Config => configSchema.parse({});

export class ConfigStore {
  readonly path: string;
  current: Config;
  lastError: string | null = null;
  private listeners = new Set<(c: Config) => void>();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'config.json');
    this.current = this.load();
  }

  private load(): Config {
    if (!existsSync(this.path)) return defaultConfig();
    try {
      return configSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (e) {
      // Keep running with defaults; never silently overwrite the user's broken file.
      this.lastError = `config.json invalid, using defaults: ${(e as Error).message}`;
      return defaultConfig();
    }
  }

  update(patch: unknown): Config {
    const merged = deepMerge(this.current, patch);
    const next = configSchema.parse(merged);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* not supported on all filesystems */ }
    this.current = next;
    this.lastError = null;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(fn: (c: Config) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = deepMerge(out[k], v);
  }
  return out;
}
