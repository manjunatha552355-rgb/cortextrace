import { watch, statSync, type FSWatcher } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Collector, Emit, AgentHint } from './supervisor.ts';

export interface WatchTarget {
  workspace: string;
  session_id: string;
  agent_hint: AgentHint;
}

interface Watch {
  watcher: FSWatcher;
  target: WatchTarget;
  started: number;
  pending: Map<string, NodeJS.Timeout>;
  known: Set<string>;
  errors: number;
}

/**
 * Watches active session workspaces. Attribution is inferred: the OS does not tell us which process wrote a file,
 * so changes are credited to the agent session that owns the workspace and marked fidelity="inferred".
 */
export class FilesystemCollector implements Collector {
  name = 'filesystem';
  private watches = new Map<string, Watch>();
  private queue: Parameters<Emit>[0][] = [];

  private targets: () => WatchTarget[];
  private cfg: () => { enabled: boolean; max_workspaces: number; ignore: string[] };
  private recentlyReported: (path: string) => boolean;

  constructor(
    targets: () => WatchTarget[],
    cfg: () => { enabled: boolean; max_workspaces: number; ignore: string[] },
    recentlyReported: (path: string) => boolean,
  ) {
    this.targets = targets;
    this.cfg = cfg;
    this.recentlyReported = recentlyReported;
  }

  enabled = () => this.cfg().enabled;
  intervalMs = () => 2000;

  async tick(emit: Emit) {
    const { max_workspaces, ignore } = this.cfg();
    const want = new Map<string, WatchTarget>();
    for (const t of this.targets()) {
      const ws = resolve(t.workspace);
      if (!isWatchable(ws) || want.has(ws)) continue;
      if (want.size >= max_workspaces) break;
      want.set(ws, t);
    }
    for (const [ws, w] of this.watches) {
      if (!want.has(ws) || w.errors > 5) this.unwatch(ws);
    }
    for (const [ws, t] of want) {
      const existing = this.watches.get(ws);
      if (existing) { existing.target = t; continue; }
      this.addWatch(ws, t, new Set(ignore));
    }
    for (const e of this.queue.splice(0)) emit(e);
  }

  private addWatch(ws: string, target: WatchTarget, ignore: Set<string>) {
    let watcher: FSWatcher;
    try {
      watcher = watch(ws, { recursive: true, persistent: false });
    } catch {
      return;
    }
    const w: Watch = { watcher, target, started: Date.now(), pending: new Map(), known: new Set(), errors: 0 };
    watcher.on('error', () => { w.errors++; });
    watcher.on('change', (_type, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (rel.split(/[\\/]/).some((seg) => ignore.has(seg))) return;
      const full = join(ws, rel);
      clearTimeout(w.pending.get(full));
      w.pending.set(full, setTimeout(() => {
        w.pending.delete(full);
        this.onSettled(w, full, rel);
      }, 300));
      if (w.pending.size > 10_000) { for (const t of w.pending.values()) clearTimeout(t); w.pending.clear(); }
    });
    this.watches.set(ws, w);
  }

  private onSettled(w: Watch, full: string, rel: string) {
    if (this.recentlyReported(full)) return; // the runtime already reported this change with higher fidelity
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(full); } catch { st = null; }
    if (st?.isDirectory()) return;
    let type: 'file_created' | 'file_modified' | 'file_deleted';
    if (!st) type = 'file_deleted';
    else if (!w.known.has(full) && st.birthtimeMs >= w.started) type = 'file_created';
    else type = 'file_modified';
    if (st) w.known.add(full); else w.known.delete(full);
    if (w.known.size > 50_000) w.known.clear();
    if (this.queue.length > 20_000) return; // backpressure: drop rather than grow unbounded
    this.queue.push({
      event_type: type, source: 'filesystem', fidelity: 'inferred', session_id: w.target.session_id, workspace: w.target.workspace,
      payload: { path: full, relative_path: rel, size: st?.size ?? null, operation: type.replace('file_', '') },
      agent_hint: w.target.agent_hint,
    });
  }

  private unwatch(ws: string) {
    const w = this.watches.get(ws);
    if (!w) return;
    for (const t of w.pending.values()) clearTimeout(t);
    w.watcher.close();
    this.watches.delete(ws);
  }

  watched() {
    return [...this.watches.keys()];
  }

  close() {
    for (const ws of [...this.watches.keys()]) this.unwatch(ws);
  }
}

// Never recursively watch a filesystem root or a home directory: too expensive and far too broad to attribute.
export function isWatchable(ws: string) {
  const home = resolve(process.env.HOME ?? process.env.USERPROFILE ?? '/');
  const parts = ws.split(sep).filter(Boolean);
  if (ws === home || parts.length < 2) return false;
  try { return statSync(ws).isDirectory(); } catch { return false; }
}
