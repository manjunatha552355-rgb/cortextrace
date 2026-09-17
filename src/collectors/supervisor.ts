import type { EventInput } from '../core/schema.ts';
import type { Logger, Metrics } from '../core/observe.ts';

export type Emit = (e: EventInput & { agent_hint?: AgentHint }) => void;

export interface AgentHint {
  adapter_id: string;
  executable: string | null;
  confidence: number;
}

export interface Collector {
  name: string;
  intervalMs(): number;
  enabled(): boolean;
  tick(emit: Emit): Promise<void>;
  close?(): void;
}

export interface CollectorStatus {
  name: string;
  state: 'running' | 'disabled' | 'paused' | 'degraded' | 'stopped';
  runs: number;
  failures: number;
  consecutive_failures: number;
  last_run_at: number | null;
  last_duration_ms: number | null;
  last_error: string | null;
  next_run_at: number | null;
}

// Runs each collector on its own timer. A throwing collector is backed off exponentially and never affects its siblings.
export class Supervisor {
  readonly status = new Map<string, CollectorStatus>();
  private timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  private collectors: Collector[];
  private emit: Emit;
  private log: Logger;
  private metrics: Metrics;
  private paused: () => boolean;

  constructor(collectors: Collector[], emit: Emit, log: Logger, metrics: Metrics, paused: () => boolean) {
    this.collectors = collectors;
    this.emit = emit;
    this.log = log;
    this.metrics = metrics;
    this.paused = paused;
    for (const c of collectors) {
      this.status.set(c.name, { name: c.name, state: 'stopped', runs: 0, failures: 0, consecutive_failures: 0, last_run_at: null, last_duration_ms: null, last_error: null, next_run_at: null });
    }
  }

  start() {
    this.stopped = false;
    for (const c of this.collectors) this.schedule(c, 250);
  }

  private schedule(c: Collector, delay: number) {
    if (this.stopped) return;
    const st = this.status.get(c.name)!;
    st.next_run_at = Date.now() + delay;
    this.timers.set(c.name, setTimeout(() => void this.run(c), delay).unref());
  }

  async run(c: Collector) {
    const st = this.status.get(c.name)!;
    if (!c.enabled()) {
      st.state = 'disabled';
      return this.schedule(c, 5000);
    }
    if (this.paused()) {
      st.state = 'paused';
      return this.schedule(c, 2000);
    }
    const t0 = performance.now();
    try {
      await c.tick(this.emit);
      st.runs++;
      st.consecutive_failures = 0;
      st.state = 'running';
      st.last_error = null;
      this.schedule(c, c.intervalMs());
    } catch (e) {
      st.failures++;
      st.consecutive_failures++;
      st.state = 'degraded';
      st.last_error = (e as Error).message.slice(0, 500);
      this.metrics.inc(`collector.${c.name}.failures`);
      this.log.warn('collector', `${c.name} failed`, { error: st.last_error, consecutive: st.consecutive_failures });
      this.schedule(c, Math.min(c.intervalMs() * 2 ** st.consecutive_failures, 300_000));
    } finally {
      const ms = performance.now() - t0;
      st.last_run_at = Date.now();
      st.last_duration_ms = Math.round(ms);
      this.metrics.time(`collector.${c.name}`, ms);
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const c of this.collectors) {
      try { c.close?.(); } catch { /* closing is best effort */ }
      this.status.get(c.name)!.state = 'stopped';
    }
  }
}
