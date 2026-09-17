import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import type { ProcInfo } from '../adapters/types.ts';

const run = promisify(execFile);

export interface Conn {
  pid: number;
  local: string;
  remote_ip: string;
  remote_port: number;
}

export interface OsProbe {
  processes(): Promise<ProcInfo[]>;
  connections(pids: Set<number>): Promise<Conn[]>;
  cwd(pids: number[]): Promise<Map<number, string>>;
  close(): void;
}

// ---------- Windows: one long-lived PowerShell host answers "procs"/"conns" requests over stdio ----------
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$epoch = [datetime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line -eq 'procs') {
    @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ForEach-Object {
      $t = $null; if ($_.CreationDate) { $t = [int64]($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds }
      [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; e = $_.ExecutablePath; c = $_.CommandLine; t = $t }
    }) | ConvertTo-Json -Compress -Depth 2
  } elseif ($line -eq 'conns') {
    @(Get-NetTCPConnection -State Established | ForEach-Object {
      [pscustomobject]@{ p = $_.OwningProcess; l = "$($_.LocalAddress):$($_.LocalPort)"; ra = $_.RemoteAddress; rp = $_.RemotePort }
    }) | ConvertTo-Json -Compress -Depth 2
  }
  '<<CT-END>>'
}`;

class PowerShellHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private queue: { cmd: string; resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  private ensure() {
    if (this.child && this.child.exitCode === null) return this.child;
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.on('exit', () => {
      this.child = null;
      for (const q of this.queue.splice(0)) { clearTimeout(q.timer); q.reject(new Error('powershell host exited')); }
    });
    child.on('error', () => { /* surfaced through exit / timeout */ });
    this.child = child;
    return child;
  }

  private onData(d: string) {
    this.buf += d;
    let idx: number;
    while ((idx = this.buf.indexOf('<<CT-END>>')) >= 0) {
      const out = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 10).replace(/^\r?\n/, '');
      const q = this.queue.shift();
      if (q) { clearTimeout(q.timer); q.resolve(out.trim()); }
    }
  }

  request(cmd: string, timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.ensure();
      const timer = setTimeout(() => {
        reject(new Error(`powershell ${cmd} timed out`));
        child.kill();
      }, timeoutMs);
      this.queue.push({ cmd, resolve, reject, timer });
      child.stdin.write(`${cmd}\n`);
    });
  }

  close() {
    this.child?.kill();
    this.child = null;
  }
}

const parseJsonArray = (s: string): any[] => {
  if (!s) return [];
  const v = JSON.parse(s);
  return Array.isArray(v) ? v : [v];
};

function windowsProbe(): OsProbe {
  const ps = new PowerShellHost();
  return {
    async processes() {
      return parseJsonArray(await ps.request('procs')).map((r) => ({
        pid: r.p, ppid: r.pp, name: r.n ?? '', exe: r.e ?? null, cmd: r.c ?? r.n ?? '', started_at: r.t ?? null, cwd: null,
      }));
    },
    async connections(pids) {
      return parseJsonArray(await ps.request('conns'))
        .filter((r) => pids.has(r.p))
        .map((r) => ({ pid: r.p, local: r.l, remote_ip: r.ra, remote_port: r.rp }));
    },
    // Windows exposes no supported API for another process's working directory without debugging privileges.
    async cwd() { return new Map(); },
    close: () => ps.close(),
  };
}

// ---------- Linux: /proc ----------
function linuxProbe(): OsProbe {
  let bootMs = 0;
  try {
    const btime = /^btime (\d+)/m.exec(readFileSync('/proc/stat', 'utf8'));
    bootMs = btime ? Number(btime[1]) * 1000 : 0;
  } catch { /* no /proc/stat */ }
  const HZ = 100;
  const readSafe = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
  const linkSafe = (f: string) => { try { return readlinkSync(f); } catch { return null; } };

  return {
    async processes() {
      const out: ProcInfo[] = [];
      for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        const stat = readSafe(`/proc/${d}/stat`);
        if (!stat) continue;
        const close = stat.lastIndexOf(')');
        const name = stat.slice(stat.indexOf('(') + 1, close);
        const f = stat.slice(close + 2).split(' ');
        const cmd = (readSafe(`/proc/${d}/cmdline`) ?? '').replace(/\0+$/, '').replace(/\0/g, ' ');
        out.push({
          pid: Number(d), ppid: Number(f[1]), name, exe: linkSafe(`/proc/${d}/exe`), cmd: cmd || name,
          started_at: bootMs ? bootMs + Math.round((Number(f[19]) / HZ) * 1000) : null,
        });
      }
      return out;
    },
    async connections(pids) {
      const inodeToPid = new Map<string, number>();
      for (const pid of pids) {
        let fds: string[] = [];
        try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
        for (const fd of fds) {
          const l = linkSafe(`/proc/${pid}/fd/${fd}`);
          const m = l && /^socket:\[(\d+)\]$/.exec(l);
          if (m) inodeToPid.set(m[1]!, pid);
        }
      }
      if (!inodeToPid.size) return [];
      const conns: Conn[] = [];
      for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
        const text = readSafe(file);
        if (!text) continue;
        for (const line of text.split('\n').slice(1)) {
          const c = line.trim().split(/\s+/);
          if (c.length < 10 || c[3] !== '01') continue; // 01 = ESTABLISHED
          const pid = inodeToPid.get(c[9]!);
          if (pid == null) continue;
          const [rip, rport] = c[2]!.split(':');
          conns.push({ pid, local: c[1]!, remote_ip: v6 ? hexToIpv6(rip!) : hexToIpv4(rip!), remote_port: parseInt(rport!, 16) });
        }
      }
      return conns;
    },
    async cwd(pids) {
      const m = new Map<number, string>();
      for (const p of pids) { const c = linkSafe(`/proc/${p}/cwd`); if (c) m.set(p, c); }
      return m;
    },
    close() {},
  };
}

export function hexToIpv4(h: string) {
  return [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join('.');
}

export function hexToIpv6(h: string) {
  if (h.startsWith('0000000000000000FFFF0000')) return hexToIpv4(h.slice(24));
  const bytes: string[] = [];
  for (let w = 0; w < 4; w++) {
    const word = h.slice(w * 8, w * 8 + 8);
    for (let i = 6; i >= 0; i -= 2) bytes.push(word.slice(i, i + 2));
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(`${bytes[i]}${bytes[i + 1]}`.replace(/^0{1,3}/, ''));
  return groups.join(':').toLowerCase().replace(/(^|:)0(:0)+(:|$)/, '::');
}

// ---------- macOS: ps + lsof ----------
function macProbe(): OsProbe {
  return {
    async processes() {
      const [{ stdout: args }, { stdout: comms }] = await Promise.all([
        run('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,args='], { maxBuffer: 32 * 1024 * 1024 }),
        run('ps', ['-ax', '-o', 'pid=,comm='], { maxBuffer: 16 * 1024 * 1024 }),
      ]);
      const exe = new Map<number, string>();
      for (const l of comms.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(l);
        if (m) exe.set(Number(m[1]), m[2]!);
      }
      const out: ProcInfo[] = [];
      for (const l of args.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(l);
        if (!m) continue;
        const pid = Number(m[1]);
        const path = exe.get(pid) ?? null;
        out.push({ pid, ppid: Number(m[2]), started_at: Date.parse(m[3]!) || null, cmd: m[4]!, exe: path, name: path ? path.split('/').pop()! : m[4]!.split(' ')[0]! });
      }
      return out;
    },
    async connections(pids) {
      if (!pids.size) return [];
      const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn'], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
      const conns: Conn[] = [];
      let pid = -1;
      for (const l of stdout.split('\n')) {
        if (l.startsWith('p')) pid = Number(l.slice(1));
        else if (l.startsWith('n') && pids.has(pid)) {
          const m = /^n(.+)->(.+):(\d+)$/.exec(l);
          if (m) conns.push({ pid, local: m[1]!, remote_ip: m[2]!.replace(/^\[|\]$/g, ''), remote_port: Number(m[3]) });
        }
      }
      return conns;
    },
    async cwd(pids) {
      const m = new Map<number, string>();
      if (!pids.length) return m;
      const { stdout } = await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]).catch(() => ({ stdout: '' }));
      let pid = -1;
      for (const l of stdout.split('\n')) {
        if (l.startsWith('p')) pid = Number(l.slice(1));
        else if (l.startsWith('n') && pid > 0) m.set(pid, l.slice(1));
      }
      return m;
    },
    close() {},
  };
}

export function createOsProbe(): OsProbe {
  switch (platform()) {
    case 'win32': return windowsProbe();
    case 'darwin': return macProbe();
    default: return linuxProbe();
  }
}
