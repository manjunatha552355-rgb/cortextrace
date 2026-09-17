import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cpuUsage, memoryUsage } from 'node:process';

type Level = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private file: string | null;
  private writes = 0;
  readonly recent: { ts: number; level: Level; component: string; msg: string }[] = [];

  private maxBytes = 5 * 1024 * 1024;
  private keep = 3;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, 'cortextrace.log') : null;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  log(level: Level, component: string, msg: string, extra?: Record<string, unknown>) {
    const entry = { ts: Date.now(), level, component, msg };
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${JSON.stringify({ ...entry, ...extra })}\n`);
      if (++this.writes % 200 === 0) this.rotate();
    } catch {
      // logging must never take the engine down
    }
  }

  private rotate() {
    if (!this.file || !existsSync(this.file) || statSync(this.file).size < this.maxBytes) return;
    rmSync(`${this.file}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    renameSync(this.file, `${this.file}.1`);
  }

  debug = (c: string, m: string, e?: Record<string, unknown>) => this.log('debug', c, m, e);
  info = (c: string, m: string, e?: Record<string, unknown>) => this.log('info', c, m, e);
  warn = (c: string, m: string, e?: Record<string, unknown>) => this.log('warn', c, m, e);
  error = (c: string, m: string, e?: Record<string, unknown>) => this.log('error', c, m, e);
}

class Latency {
  private samples: number[] = [];
  observe(ms: number) {
    this.samples.push(ms);
    if (this.samples.length > 1024) this.samples.splice(0, 512);
  }
  snapshot() {
    if (!this.samples.length) return { p50: 0, p95: 0, max: 0, n: 0 };
    const s = [...this.samples].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, n: s.length };
  }
}

export class Metrics {
  readonly counters: Record<string, number> = {};
  private latencies = new Map<string, Latency>();
  private lastCpu = cpuUsage();
  private lastCpuAt = Date.now();
  readonly startedAt = Date.now();

  inc(name: string, by = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + by;
  }

  time(name: string, ms: number) {
    let l = this.latencies.get(name);
    if (!l) this.latencies.set(name, (l = new Latency()));
    l.observe(ms);
  }

  snapshot() {
    const now = Date.now();
    const cpu = cpuUsage(this.lastCpu);
    const cpuPct = ((cpu.user + cpu.system) / 1000 / Math.max(1, now - this.lastCpuAt)) * 100;
    this.lastCpu = cpuUsage();
    this.lastCpuAt = now;
    const mem = memoryUsage();
    return {
      uptime_ms: now - this.startedAt,
      counters: { ...this.counters },
      latency: Object.fromEntries([...this.latencies].map(([k, v]) => [k, v.snapshot()])),
      cpu_percent: Math.round(cpuPct * 10) / 10,
      rss_mb: Math.round(mem.rss / 1048576),
      heap_mb: Math.round(mem.heapUsed / 1048576),
    };
  }
}
