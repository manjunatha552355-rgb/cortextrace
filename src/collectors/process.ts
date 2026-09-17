import { promises as dns } from 'node:dns';
import { basename } from 'node:path';
import type { AdapterRegistry } from '../adapters/registry.ts';
import type { ProcInfo } from '../adapters/types.ts';
import type { Collector, Emit } from './supervisor.ts';
import type { OsProbe } from './os.ts';

export interface TrackedRoot {
  key: string;
  adapter_id: string;
  confidence: number;
  pid: number;
  started_at: number | null;
  exe: string | null;
  name: string;
  session_id: string;
  cwd: string | null;
  descendants: Map<number, ProcInfo>;
  first_seen: number;
  dynamic: boolean;
}

const procKey = (p: { pid: number; started_at: number | null }) => `${p.pid}:${p.started_at ?? 0}`;
const isHelper = (p: ProcInfo) => /\s--type=/.test(p.cmd);
const NOISE = new Set(['conhost.exe', 'crashpad_handler', 'crashpad_handler.exe', 'wermgr.exe', 'werfault.exe']);

export class ProcessTracker implements Collector {
  name = 'process';
  readonly roots = new Map<string, TrackedRoot>();
  /** pid -> owning root key, for every tracked root and descendant */
  readonly owner = new Map<number, string>();
  latest: ProcInfo[] = [];
  private identified = new Map<string, { adapter_id: string; confidence: number } | null>();
  private promoted = new Map<string, { adapter_id: string; confidence: number }>();
  private ticks = 0;

  private probe: OsProbe;
  private registry: AdapterRegistry;
  private cfg: () => { enabled: boolean; interval_ms: number };

  constructor(probe: OsProbe, registry: AdapterRegistry, cfg: () => { enabled: boolean; interval_ms: number }) {
    this.probe = probe;
    this.registry = registry;
    this.cfg = cfg;
  }

  enabled = () => this.cfg().enabled;
  intervalMs = () => this.cfg().interval_ms;

  /** Marks a live process as an agent discovered through other signals (e.g. connections to LLM APIs). */
  promote(p: ProcInfo, adapter_id: string, confidence: number) {
    this.promoted.set(procKey(p), { adapter_id, confidence });
  }

  private identify(p: ProcInfo) {
    const k = procKey(p);
    const promoted = this.promoted.get(k);
    if (promoted) return promoted;
    if (!this.identified.has(k)) {
      const m = this.registry.identify(p);
      this.identified.set(k, m ? { adapter_id: m.adapter.id, confidence: m.confidence } : null);
    }
    return this.identified.get(k)!;
  }

  async tick(emit: Emit) {
    const procs = await this.probe.processes();
    const now = Date.now();
    const firstTick = this.ticks++ === 0;
    this.latest = procs;
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const children = new Map<number, ProcInfo[]>();
    for (const p of procs) {
      if (p.pid === p.ppid) continue;
      const arr = children.get(p.ppid);
      if (arr) arr.push(p); else children.set(p.ppid, [p]);
    }

    // Identify agent roots: matched processes with no matched ancestor of the same adapter.
    const current = new Map<string, { p: ProcInfo; adapter_id: string; confidence: number }>();
    for (const p of procs) {
      const m = this.identify(p);
      if (!m) continue;
      let anc = byPid.get(p.ppid);
      let guard = 0;
      let nested = false;
      while (anc && guard++ < 64) {
        if ((anc.started_at ?? 0) > (p.started_at ?? Infinity)) break; // pid reuse
        if (this.identify(anc)?.adapter_id === m.adapter_id) { nested = true; break; }
        if (anc.ppid === anc.pid) break;
        anc = byPid.get(anc.ppid);
      }
      if (!nested) current.set(procKey(p), { p, adapter_id: m.adapter_id, confidence: m.confidence });
    }

    // Exits
    for (const [key, root] of this.roots) {
      if (current.has(key)) continue;
      this.roots.delete(key);
      emit({
        event_type: 'session_completed', source: 'process', session_id: root.session_id, process_id: root.pid, workspace: root.cwd,
        timestamp: now, payload: { reason: 'process_exited', executable: root.exe, duration_ms: now - root.first_seen },
        agent_hint: { adapter_id: root.adapter_id, executable: root.exe, confidence: root.confidence },
      });
      if (![...this.roots.values()].some((r) => r.adapter_id === root.adapter_id)) {
        emit({
          event_type: 'agent_stopped', source: 'process', process_id: root.pid, timestamp: now, payload: { executable: root.exe },
          agent_hint: { adapter_id: root.adapter_id, executable: root.exe, confidence: root.confidence },
        });
      }
    }

    // New roots
    const fresh: TrackedRoot[] = [];
    for (const [key, { p, adapter_id, confidence }] of current) {
      if (this.roots.has(key)) continue;
      const agentAlreadyRunning = [...this.roots.values()].some((r) => r.adapter_id === adapter_id);
      const root: TrackedRoot = {
        key, adapter_id, confidence, pid: p.pid, started_at: p.started_at, exe: p.exe, name: p.name,
        session_id: `proc:${adapter_id}:${p.pid}:${p.started_at ?? now}`, cwd: null, descendants: new Map(),
        first_seen: now, dynamic: this.promoted.has(key),
      };
      this.roots.set(key, root);
      fresh.push(root);
      const hint = { adapter_id, executable: p.exe, confidence };
      if (!agentAlreadyRunning) {
        emit({ event_type: 'agent_started', source: 'process', process_id: p.pid, parent_process_id: p.ppid, timestamp: p.started_at ?? now,
          fidelity: root.dynamic ? 'inferred' : 'observed', payload: { executable: p.exe, name: p.name, command: p.cmd, confidence, preexisting: firstTick }, agent_hint: hint });
      }
      emit({ event_type: 'session_started', source: 'process', session_id: root.session_id, process_id: p.pid, parent_process_id: p.ppid,
        timestamp: p.started_at ?? now, fidelity: root.dynamic ? 'inferred' : 'observed',
        payload: { executable: p.exe, name: p.name, command: p.cmd, parent_name: byPid.get(p.ppid)?.name ?? null, preexisting: firstTick }, agent_hint: hint });
    }

    if (fresh.length) {
      const cwds = await this.probe.cwd(fresh.map((r) => r.pid)).catch(() => new Map<number, string>());
      for (const r of fresh) r.cwd = cwds.get(r.pid) ?? null;
    }

    // Descendants
    this.owner.clear();
    for (const root of this.roots.values()) {
      this.owner.set(root.pid, root.key);
      const isFresh = fresh.includes(root);
      const seen = new Set<number>();
      const stack = [...(children.get(root.pid) ?? [])];
      const hint = { adapter_id: root.adapter_id, executable: root.exe, confidence: root.confidence };
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c.pid) || seen.size > 5000) continue;
        seen.add(c.pid);
        // A nested agent (e.g. an MCP server) owns its own subtree; don't descend into it.
        if (current.has(procKey(c)) && this.identify(c)?.adapter_id !== root.adapter_id) continue;
        stack.push(...(children.get(c.pid) ?? []));
        this.owner.set(c.pid, root.key);
        const prev = root.descendants.get(c.pid);
        if (prev && prev.started_at === c.started_at) continue;
        root.descendants.set(c.pid, c);
        if (isHelper(c) || NOISE.has(c.name.toLowerCase()) || (c.exe && c.exe === root.exe)) continue;
        const parent = byPid.get(c.ppid);
        emit({
          event_type: isFresh || firstTick ? 'process_started' : 'command_execution',
          source: 'process', session_id: root.session_id, process_id: c.pid, parent_process_id: c.ppid, workspace: root.cwd,
          timestamp: c.started_at ?? now,
          payload: { command: c.cmd, executable: c.exe, name: c.name, parent_name: parent?.name ?? null, preexisting: isFresh || firstTick, observed_via: 'process_snapshot' },
          agent_hint: hint,
        });
      }
      for (const pid of root.descendants.keys()) if (!seen.has(pid)) root.descendants.delete(pid);
    }

    // Bound caches to live processes.
    if (this.identified.size > procs.length * 4) {
      const live = new Set(procs.map(procKey));
      for (const k of this.identified.keys()) if (!live.has(k)) this.identified.delete(k);
      for (const k of this.promoted.keys()) if (!live.has(k)) this.promoted.delete(k);
    }
  }

  close() {
    this.probe.close();
  }
}

// Hostnames whose connections identify an otherwise unknown process as an LLM client.
export const LLM_API_HOSTS = [
  'api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'aiplatform.googleapis.com', 'api.mistral.ai',
  'api.groq.com', 'api.deepseek.com', 'api.x.ai', 'openrouter.ai', 'api.together.xyz', 'api.fireworks.ai', 'api.cohere.com',
  'api.githubcopilot.com', 'api2.cursor.sh', 'api.perplexity.ai', 'bedrock-runtime.us-east-1.amazonaws.com',
];

const INTERPRETERS = /^(node|bun|deno|python\d?(\.\d+)?|pythonw|java|ruby|dotnet|go|docker|com\.docker\.backend)(\.exe)?$/i;

export class NetworkCollector implements Collector {
  name = 'network';
  private seen = new Map<string, number>();
  private ipToHost = new Map<string, string>();
  private resolvedAt = 0;
  private ticks = 0;

  private probe: OsProbe;
  private tracker: ProcessTracker;
  private cfg: () => { enabled: boolean; interval_ms: number };
  private ownPorts: () => number[];

  constructor(probe: OsProbe, tracker: ProcessTracker, cfg: () => { enabled: boolean; interval_ms: number }, ownPorts: () => number[]) {
    this.probe = probe;
    this.tracker = tracker;
    this.cfg = cfg;
    this.ownPorts = ownPorts;
  }

  enabled = () => this.cfg().enabled;
  intervalMs = () => this.cfg().interval_ms;

  private async refreshDns() {
    if (Date.now() - this.resolvedAt < 10 * 60_000) return;
    this.resolvedAt = Date.now();
    await Promise.all(LLM_API_HOSTS.map(async (h) => {
      const ips = [...await dns.resolve4(h).catch(() => [] as string[]), ...await dns.resolve6(h).catch(() => [] as string[])];
      for (const ip of ips) this.ipToHost.set(ip, h);
    }));
  }

  async tick(emit: Emit) {
    const now = Date.now();
    const discovery = this.ticks++ % 6 === 0;
    if (discovery) await this.refreshDns();
    const tracked = new Set(this.tracker.owner.keys());
    const pids = discovery ? new Set(this.tracker.latest.map((p) => p.pid)) : tracked;
    if (!pids.size) return;
    const conns = await this.probe.connections(pids);
    const own = new Set(this.ownPorts());
    const byPid = new Map(this.tracker.latest.map((p) => [p.pid, p]));

    for (const c of conns) {
      const loopback = c.remote_ip === '127.0.0.1' || c.remote_ip === '::1' || c.remote_ip.startsWith('127.');
      if (loopback && own.has(c.remote_port)) continue;
      const rootKey = this.tracker.owner.get(c.pid);
      if (!rootKey) {
        const host = this.ipToHost.get(c.remote_ip);
        const p = byPid.get(c.pid);
        // Only interpreters/containers are promoted; browsers and IDEs talk to these APIs for unrelated reasons.
        if (host && p && INTERPRETERS.test(basename((p.exe ?? p.name).replace(/\\/g, '/')))) this.tracker.promote(p, 'llm-client', 0.5);
        continue;
      }
      const key = `${c.pid}|${c.remote_ip}|${c.remote_port}`;
      const had = this.seen.has(key);
      this.seen.set(key, now);
      if (had) continue;
      const root = this.tracker.roots.get(rootKey);
      if (!root) continue;
      const p = byPid.get(c.pid);
      emit({
        event_type: 'network_connection_metadata', source: 'network', session_id: root.session_id, process_id: c.pid,
        parent_process_id: p?.ppid ?? null, workspace: root.cwd, timestamp: now,
        payload: { remote_ip: c.remote_ip, remote_port: c.remote_port, host: this.ipToHost.get(c.remote_ip) ?? null, loopback, direction: 'outbound', process_name: p?.name ?? null, protocol: 'tcp' },
        agent_hint: { adapter_id: root.adapter_id, executable: root.exe, confidence: root.confidence },
      });
    }
    // Forget connections unseen for 10 minutes so reconnects are reported again.
    for (const [k, t] of this.seen) if (now - t > 600_000) this.seen.delete(k);
  }
}
