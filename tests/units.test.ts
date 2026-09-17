import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactText, redactValue } from '../src/core/redact.ts';
import { configSchema, deepMerge } from '../src/core/config.ts';
import { makeEvent, upgradeEvent } from '../src/core/schema.ts';
import { evalCondition } from '../src/detection/policy.ts';
import { computeRisk } from '../src/detection/risk.ts';
import { hostAllowed, binaryOf } from '../src/detection/detector.ts';
import { AdapterRegistry, scanMcpConfigs } from '../src/adapters/registry.ts';
import { claudeCode, cursor, codex } from '../src/adapters/builtin.ts';
import { ProcessTracker, NetworkCollector } from '../src/collectors/process.ts';
import { Supervisor } from '../src/collectors/supervisor.ts';
import { hexToIpv4, hexToIpv6, type OsProbe } from '../src/collectors/os.ts';
import { Logger, Metrics } from '../src/core/observe.ts';
import type { ProcInfo } from '../src/adapters/types.ts';

test('redaction masks known token formats and keeps context', () => {
  const r = redactText('export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 && aws AKIAABCDEFGHIJKLMNOP postgres://u:pa55word@db/x');
  assert.ok(!r.text.includes('abcdefghijklmnop'));
  assert.ok(!r.text.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(!r.text.includes('pa55word'));
  assert.ok(r.text.includes('postgres://u:[REDACTED:url_credentials]@db/x'));
  assert.ok(r.labels.includes('aws_access_key'));
  // regression: replacements for patterns without capture groups used to append the entire input
  assert.equal(r.text, 'export OPENAI_API_KEY=[REDACTED:openai_key] && aws [REDACTED:aws_access_key] postgres://u:[REDACTED:url_credentials]@db/x');
  const labels = new Set<string>();
  const v = redactValue({ headers: { Authorization: 'Bearer abc', 'x-trace': 'ok' }, nested: [{ password: 'hunter2' }] }, labels) as any;
  assert.equal(v.headers.Authorization, '[REDACTED:sensitive_field]');
  assert.equal(v.headers['x-trace'], 'ok');
  assert.equal(v.nested[0].password, '[REDACTED:sensitive_field]');
});

test('redaction does not mangle ordinary commands', () => {
  for (const s of ['git commit -m "fix token refresh"', 'npm run build', 'ls -la ~/.ssh']) assert.equal(redactText(s).text, s);
});

test('config defaults, validation and prototype-safe merge', () => {
  const c = configSchema.parse({});
  assert.equal(c.privacy.prompts, 'metadata');
  assert.equal(c.api.port, 47631);
  assert.throws(() => configSchema.parse({ api: { port: 80 } }));
  const merged = deepMerge({ a: { b: 1 } }, JSON.parse('{"__proto__":{"polluted":true},"a":{"c":2}}')) as any;
  assert.deepEqual(merged, { a: { b: 1, c: 2 } });
  assert.equal(({} as any).polluted, undefined);
});

test('schema rejects events from a newer schema version', () => {
  const e = makeEvent({ event_type: 'tool_call', source: 'api' });
  assert.equal(upgradeEvent({ ...e }).event_id, e.event_id);
  assert.throws(() => upgradeEvent({ ...e, event_version: 99 }), /newer/);
});

test('policy conditions', () => {
  const e = makeEvent({ event_type: 'file_read', source: 'hook', agent_type: 'claude-code', payload: { path: 'C:\\Users\\me\\.ssh\\id_rsa', size: 10 } });
  assert.ok(evalCondition(e, { field: 'payload.path', op: 'glob', value: ['**/.ssh/**'] }));
  assert.ok(evalCondition(e, { field: 'payload.size', op: 'gt', value: 5 }));
  assert.ok(evalCondition(e, { field: 'agent_type', op: 'in', value: ['claude-code'] }));
  assert.ok(!evalCondition(e, { field: 'payload.missing', op: 'exists' }));
  assert.ok(!evalCondition(e, { field: '__proto__.x', op: 'exists' }));
  assert.ok(!evalCondition(e, { field: 'payload.path', op: 'matches', value: ['(unclosed'] }), 'invalid regex never matches');
});

test('risk score is explainable and bounded', () => {
  const d = (rule_id: string, severity: any, confidence = 1, classification: any = 'suspicious_indicator', dimension: any = 'command') => ({
    detection_id: rule_id + Math.random(), timestamp: Date.now(), rule_id, rule_name: rule_id, agent_id: 'a', agent_type: 'a', session_id: 's', event_id: 'e',
    classification, dimension, severity, confidence, reason: '', evidence: ['x'], recommended_action: '', related_event_ids: [],
  });
  const th = configSchema.parse({}).risk.thresholds;
  assert.equal(computeRisk([], th).score, 0);
  const one = computeRisk([d('a', 'HIGH')], th);
  assert.equal(one.score, 40);
  assert.equal(one.factors[0]!.points, 40);
  const many = computeRisk(Array.from({ length: 50 }, (_, i) => d(`r${i}`, 'CRITICAL', 1, 'suspicious_indicator', i % 2 ? 'credential' : 'command')), th);
  assert.equal(many.score, 100);
  assert.equal(many.level, 'critical');
  const repeats = computeRisk(Array.from({ length: 10 }, () => d('same', 'MEDIUM')), th);
  assert.ok(repeats.factors.length <= 4, 'repeats are capped');
  assert.equal(computeRisk([d('o', 'LOW', 1, 'observation')], th).score, 3);
});

test('network allowlist supports wildcards', () => {
  const allow = ['*.anthropic.com', 'github.com'];
  assert.ok(hostAllowed('api.anthropic.com', allow));
  assert.ok(hostAllowed('github.com', allow));
  assert.ok(!hostAllowed('anthropic.com.evil.io', allow));
  assert.equal(binaryOf('sudo "C:\\Program Files\\Git\\bin\\git.exe" status'), 'git');
});

test('adapters identify processes and skip electron helpers', () => {
  const reg = new AdapterRegistry();
  const p = (name: string, exe: string | null, cmd: string): ProcInfo => ({ pid: 1, ppid: 0, name, exe, cmd, started_at: 1 });
  assert.equal(reg.identify(p('claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe', 'claude'))?.adapter.id, 'claude-code');
  assert.equal(reg.identify(p('claude.exe', 'C:\\Program Files\\WindowsApps\\Claude_2.1_x64__abc\\app\\claude.exe', '"claude.exe"'))?.adapter.id, 'claude-desktop');
  assert.equal(reg.identify(p('claude.exe', 'C:\\Program Files\\WindowsApps\\Claude_2.1_x64__abc\\app\\claude.exe', '"claude.exe" --type=renderer')), null);
  assert.equal(reg.identify(p('node', '/usr/bin/node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'))?.adapter.id, 'claude-code');
  assert.equal(reg.identify(p('Cursor.exe', 'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe', 'Cursor.exe'))?.adapter.id, 'cursor');
  assert.equal(reg.identify(p('python3', '/usr/bin/python3', 'python3 -m crewai run'))?.adapter.id, 'python-agent');
  assert.equal(reg.identify(p('npx', '/usr/bin/npx', 'npx -y @modelcontextprotocol/server-filesystem /tmp'))?.adapter.id, 'mcp-server');
  assert.equal(reg.identify(p('bash', '/bin/bash', 'bash')), null);
  reg.setCustom([configSchema.parse({ custom_agents: [{ id: 'mybot', name: 'My Bot', process_names: ['mybot'] }] }).custom_agents[0]!]);
  assert.equal(reg.identify(p('mybot.exe', null, 'mybot.exe --serve'))?.adapter.id, 'custom.mybot');
});

test('hook install is idempotent, preserves user hooks and backs up', () => {
  const home = mkdtempSync(join(tmpdir(), 'ct-home-'));
  try {
    const ctx = { apiBase: 'http://127.0.0.1:47631', ingestToken: 'tok', otlpBase: 'http://127.0.0.1:4318' };
    const file = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'));
    writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }));
    const r1 = claudeCode.install!('hooks', home, ctx);
    assert.ok(r1.backup);
    claudeCode.install!('hooks', home, ctx);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(doc.model, 'opus');
    const pre = doc.hooks.PreToolUse.flatMap((g: any) => g.hooks);
    assert.equal(pre.filter((h: any) => h.command.includes('src=cortextrace')).length, 1, 'no duplicate hooks after reinstall');
    assert.ok(pre.some((h: any) => h.command === 'my-own-hook'));
    assert.ok(claudeCode.integrations!(home).find((i) => i.id === 'hooks')!.installed);
    claudeCode.uninstall!('hooks', home);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(after.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }] });

    claudeCode.install!('otlp', home, ctx);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).env.OTEL_LOG_USER_PROMPTS, undefined, 'prompt export stays off');
    claudeCode.uninstall!('otlp', home);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).env, {});

    cursor.install!('hooks', home, ctx);
    const ch = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(ch.version, 1);
    assert.ok(ch.hooks.beforeShellExecution[0].command.includes('/v1/hooks/cursor/beforeShellExecution'));
    cursor.uninstall!('hooks', home);
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8')).hooks, {});

    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    codex.install!('otlp', home, ctx);
    assert.ok(codex.integrations!(home).find((i) => i.id === 'otlp')!.installed);
    codex.uninstall!('otlp', home);
    assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').trim(), 'model = "gpt-5"');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mcp config scan records env names but never values', () => {
  const home = mkdtempSync(join(tmpdir(), 'ct-home-'));
  try {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['-y', 'github-mcp'], env: { GITHUB_TOKEN: 'ghp_' + 'z'.repeat(36) } }, remote: { url: 'https://mcp.example.com/sse' } } }));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { '/repo': { mcpServers: { db: { command: 'uvx', args: ['pg-mcp', '--dsn', 'postgres://u:secretpw@h/db'] } } } } }));
    const s = scanMcpConfigs(home);
    const gh = s.find((x) => x.id === 'cursor:gh')!;
    assert.deepEqual(gh.env_keys, ['GITHUB_TOKEN']);
    assert.ok(!JSON.stringify(s).includes('zzzz'));
    assert.ok(!JSON.stringify(s).includes('secretpw'));
    assert.equal(s.find((x) => x.id === 'cursor:remote')!.transport, 'http');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeProbe(snapshots: ProcInfo[][], conns: any[] = []): OsProbe & { i: number } {
  return {
    i: 0,
    async processes() { return snapshots[Math.min(this.i++, snapshots.length - 1)]!; },
    async connections(pids) { return conns.filter((c) => pids.has(c.pid)); },
    async cwd(pids) { return new Map(pids.map((p) => [p, `/work/${p}`])); },
    close() {},
  };
}

test('process tracker: agent roots, sessions, child commands, exits', async () => {
  const proc = (pid: number, ppid: number, name: string, cmd = name, exe: string | null = `/usr/bin/${name}`, started_at = pid): ProcInfo => ({ pid, ppid, name, exe, cmd, started_at });
  const base = [proc(1, 0, 'init'), proc(10, 1, 'zsh'), proc(100, 10, 'claude', 'claude', '/home/u/.local/bin/claude'), proc(101, 100, 'node', 'node mcp-server-git', '/usr/bin/node')];
  const withChild = [...base, proc(200, 100, 'bash', 'bash -c "git status"', '/bin/bash'), proc(201, 200, 'git', 'git status', '/usr/bin/git')];
  const probe = fakeProbe([base, withChild, [proc(1, 0, 'init')]]);
  const tracker = new ProcessTracker(probe, new AdapterRegistry(), () => ({ enabled: true, interval_ms: 1000 }));
  const events: any[] = [];
  await tracker.tick((e) => events.push(e));
  // pid 101 is an MCP server: it becomes its own agent root instead of a claude child process
  assert.deepEqual(events.map((e) => `${e.event_type}:${e.agent_hint.adapter_id}`), ['agent_started:claude-code', 'session_started:claude-code', 'agent_started:mcp-server', 'session_started:mcp-server']);
  assert.equal(events[3].payload.parent_name, 'claude');
  const root = [...tracker.roots.values()].find((r) => r.adapter_id === 'claude-code')!;
  assert.equal(root.cwd, '/work/100');
  events.length = 0;
  await tracker.tick((e) => events.push(e));
  const cmds = events.filter((e) => e.event_type === 'command_execution').map((e) => e.payload.command).sort();
  assert.deepEqual(cmds, ['bash -c "git status"', 'git status']);
  assert.ok(events.every((e) => e.agent_hint.adapter_id === 'claude-code'));
  assert.equal(tracker.owner.get(201), root.key);
  events.length = 0;
  await tracker.tick((e) => events.push(e));
  assert.deepEqual(events.map((e) => e.event_type).sort(), ['agent_stopped', 'agent_stopped', 'session_completed', 'session_completed']);
});

test('regression: descendants of a nested agent are not attributed to the outer agent', async () => {
  const proc = (pid: number, ppid: number, name: string, cmd: string, exe: string): ProcInfo => ({ pid, ppid, name, exe, cmd, started_at: pid });
  const snap = [
    proc(100, 1, 'claude', 'claude', '/home/u/.local/bin/claude'),
    proc(101, 100, 'node', 'node /x/@modelcontextprotocol/server-github', '/usr/bin/node'),
    proc(102, 101, 'git', 'git fetch', '/usr/bin/git'),
  ];
  const tracker = new ProcessTracker(fakeProbe([snap]), new AdapterRegistry(), () => ({ enabled: true, interval_ms: 1000 }));
  const events: any[] = [];
  await tracker.tick((e) => events.push(e));
  const git = events.filter((e) => e.process_id === 102);
  assert.equal(git.length, 1);
  assert.equal(git[0].agent_hint.adapter_id, 'mcp-server');
});

test('network collector reports new connections of tracked processes once', async () => {
  const procs: ProcInfo[] = [{ pid: 100, ppid: 1, name: 'claude', exe: '/home/u/.local/bin/claude', cmd: 'claude', started_at: 5 }];
  const conns = [{ pid: 100, local: '1:2', remote_ip: '203.0.113.9', remote_port: 8443 }, { pid: 100, local: '1:3', remote_ip: '127.0.0.1', remote_port: 47631 }];
  const probe = fakeProbe([procs], conns);
  const tracker = new ProcessTracker(probe, new AdapterRegistry(), () => ({ enabled: true, interval_ms: 1000 }));
  await tracker.tick(() => {});
  const net = new NetworkCollector(probe, tracker, () => ({ enabled: true, interval_ms: 1000 }), () => [47631]);
  const out: any[] = [];
  (net as any).resolvedAt = Date.now(); // skip DNS in tests
  await net.tick((e) => out.push(e));
  await net.tick((e) => out.push(e));
  assert.equal(out.length, 1, 'own API port skipped, repeat suppressed');
  assert.equal(out[0].payload.remote_port, 8443);
});

test('supervisor isolates a failing collector and backs off', async () => {
  const log = new Logger(null);
  const metrics = new Metrics();
  let goodRuns = 0;
  const bad = { name: 'bad', enabled: () => true, intervalMs: () => 10, tick: async () => { throw new Error('probe exploded'); } };
  const good = { name: 'good', enabled: () => true, intervalMs: () => 10, tick: async () => { goodRuns++; } };
  const sup = new Supervisor([bad, good], () => {}, log, metrics, () => false);
  await sup.run(bad);
  await sup.run(bad);
  await sup.run(good);
  sup.stop();
  const st = sup.status.get('bad')!;
  assert.equal(st.state, 'stopped');
  assert.equal(st.failures, 2);
  assert.equal(st.consecutive_failures, 2);
  assert.equal(goodRuns, 1);
  assert.equal(metrics.counters['collector.bad.failures'], 2);
});

test('linux /proc/net address decoding', () => {
  assert.equal(hexToIpv4('0100007F'), '127.0.0.1');
  assert.equal(hexToIpv6('0000000000000000FFFF00000100007F'), '127.0.0.1');
});
