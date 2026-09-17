import { useMemo } from 'react';
import type { PageProps } from '../App.tsx';
import { invoke, useQuery, seriesColor, agentName, fmtDuration, fmtNum, fmtAgo, DIM_LABEL, TYPE_LABEL, SEVERITIES } from '../lib.ts';
import { Card, Stat, SevBadge, AgentChip, RiskMeter } from '../ui.tsx';
import { StackedColumns, BarList, Heatmap, Histogram } from '../charts.tsx';
import type { Severity } from '../../core/schema.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function categorize(cmd: string) {
  const bin = cmd.trim().replace(/^(sudo|env)\s+/, '').split(/\s+/)[0]?.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (/^(git|gh|hg|svn)$/.test(bin)) return 'Version control';
  if (/^(npm|pnpm|yarn|bun|pip3?|uv|cargo|go|gem|brew|apt|apt-get|dnf|choco|winget|poetry)$/.test(bin)) return 'Package & build';
  if (/^(pytest|jest|vitest|mocha|tsc|eslint|ruff|mypy|make|gradle|mvn|dotnet)$/.test(bin)) return 'Test & lint';
  if (/^(ls|dir|cat|type|head|tail|find|rg|grep|sed|awk|wc|tree|pwd|echo|cd|mkdir|cp|mv|rm|touch|less|more)$/.test(bin)) return 'Filesystem & text';
  if (/^(curl|wget|ssh|scp|rsync|nc|ping|dig|nslookup|iwr|invoke-webrequest)$/.test(bin)) return 'Network';
  if (/^(docker|kubectl|helm|terraform|aws|gcloud|az)$/.test(bin)) return 'Cloud & containers';
  if (/^(python\d?|node|deno|ruby|perl|bash|sh|zsh|pwsh|powershell|cmd)$/.test(bin)) return 'Interpreters & shells';
  return 'Other';
}

export function AnalyticsPage({ from, to, nav }: PageProps) {
  const { data: a } = useQuery<any>('analytics', { from, to });
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  const heat = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of a?.hour_of_week ?? []) {
      let hour = c.hour + offsetHours;
      let dow = c.dow;
      if (hour < 0) { hour += 24; dow = (dow + 6) % 7; }
      if (hour >= 24) { hour -= 24; dow = (dow + 1) % 7; }
      const k = `${dow}:${Math.floor(hour)}`;
      m.set(k, (m.get(k) ?? 0) + c.n);
    }
    return m;
  }, [a, offsetHours]);
  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of a?.command_binaries ?? []) m.set(categorize(c.key ?? ''), (m.get(categorize(c.key ?? '')) ?? 0) + c.n);
    return [...m.entries()].map(([key, n]) => ({ key, n })).sort((x, y) => y.n - x.n);
  }, [a]);
  if (!a) return <div className="muted">Loading…</div>;
  const durations = a.session_durations.map((s: any) => s.d).filter((d: number) => d > 0);
  const totalEvents = a.agent_compare.reduce((s: number, r: any) => s + r.events, 0);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="stats">
        <Stat label="Events" value={fmtNum(totalEvents)} />
        <Stat label="Agent types active" value={a.agent_compare.length} />
        <Stat label="Sessions started" value={a.session_durations.length} />
        <Stat label="Median session" value={durations.length ? fmtDuration([...durations].sort((x: number, y: number) => x - y)[Math.floor(durations.length / 2)]) : '—'} />
      </div>
      <div className="grid cols-2">
        <Card title="Agent usage trend"><StackedColumns data={a.by_agent} from={from} to={to} bucketMs={a.bucket_ms} color={seriesColor} label={agentName} /></Card>
        <Card title="Activity by type"><StackedColumns data={a.by_type} from={from} to={to} bucketMs={a.bucket_ms} color={(t) => seriesColor(t, 'type')} label={(t) => TYPE_LABEL[t] ?? t} /></Card>
      </div>
      <Card title="Agent comparison">
        <table className="table">
          <thead><tr><th>Agent</th><th>Events</th><th>Sessions</th><th>Commands</th><th>File changes</th><th>MCP calls</th><th>Detections</th><th style={{ width: 150 }}>Peak event risk</th></tr></thead>
          <tbody>
            {a.agent_compare.map((r: any) => (
              <tr key={r.agent_type} className="clickable" onClick={() => nav('timeline', { agent_type: r.agent_type })}>
                <td><AgentChip type={r.agent_type} /></td><td className="num">{fmtNum(r.events)}</td><td className="num">{r.sessions}</td><td className="num">{fmtNum(r.commands)}</td>
                <td className="num">{fmtNum(r.file_changes)}</td><td className="num">{fmtNum(r.mcp)}</td><td className="num">{fmtNum(r.detections)}</td><td><RiskMeter score={r.max_risk} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="grid cols-3">
        <Card title="Risk trend" sub="detections by dimension" className="span-2">
          <StackedColumns data={a.risk_trend} from={from} to={to} bucketMs={a.bucket_ms} height={170} color={(d) => seriesColor(d, 'dimension')} label={(d) => DIM_LABEL[d] ?? d} />
        </Card>
        <Card title="Threat frequency" sub="top rules">
          <BarList items={a.top_rules.map((r: any) => ({ key: r.rule_id, n: r.n, extra: <SevBadge s={SEVERITIES[r.severity] as Severity} /> }))}
            render={(id) => <span style={{ fontFamily: 'system-ui' }}>{a.top_rules.find((r: any) => r.rule_id === id)?.rule_name}</span>} onClick={(r) => nav('threats', { rule: r })} />
        </Card>
      </div>
      <div className="grid cols-3">
        <Card title="Activity by time" sub="local time, hour of week" className="span-2">
          <Heatmap cells={heat} rows={7} cols={24} rowLabel={(r) => DAYS[r]!} colLabel={(c) => String(c).padStart(2, '0')} />
        </Card>
        <Card title="Command categories"><BarList items={categories} /></Card>
      </div>
      <div className="grid cols-3">
        <Card title="Session duration" sub="log scale"><Histogram values={durations} fmt={(v) => fmtDuration(v)} /></Card>
        <Card title="Workspace activity">
          <BarList items={a.workspaces.map((w: any) => ({ key: w.key, n: w.n, extra: <span className="muted" style={{ fontSize: 11.5 }}>{w.sessions} sessions</span> }))} />
        </Card>
        <Card title="Behavioral baselines" sub="events per active minute">
          {a.baselines.length === 0 ? <div className="muted">Baselines build after 30 active minutes per agent type.</div> : (
            <table className="table">
              <thead><tr><th>Agent</th><th>Mean</th><th>σ</th><th>Samples</th></tr></thead>
              <tbody>{a.baselines.map((b: any) => <tr key={b.agent_type + b.metric}><td><AgentChip type={b.agent_type} /></td><td className="num">{b.mean.toFixed(1)}</td><td className="num">{Math.sqrt(b.var).toFixed(1)}</td><td className="num">{b.n}{b.n < 30 && <span className="muted"> (learning)</span>}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

export function HealthPage(_: PageProps) {
  const { data: s, refetch } = useQuery<any>('system', null, { interval: 3000 });
  if (!s) return <div className="muted">Loading…</div>;
  const c = s.metrics.counters;
  const lat = s.metrics.latency;
  const samples = s.samples as any[];
  const align = (ts: number) => Math.floor(ts / 10_000) * 10_000;
  const eventSeries = samples.map((x) => ({ bucket: align(x.ts), series: 'events stored', n: x.events }));
  const dropSeries = samples.filter((x) => x.dropped).map((x) => ({ bucket: align(x.ts), series: 'dropped', n: x.dropped }));
  const first = Math.min(samples[0]?.ts ?? Date.now(), Date.now() - 600_000);
  const p = (name: string) => (lat[name] ? `${lat[name].p50.toFixed(1)} / ${lat[name].p95.toFixed(1)} ms` : '—');

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="stats">
        <Stat label="Events stored" value={fmtNum(c['events.stored'] ?? 0)} hint={`${fmtNum(c['events.received'] ?? 0)} received`} />
        <Stat label="Dropped" value={fmtNum(c['events.dropped'] ?? 0)} hint="backpressure / failed batches" tone={c['events.dropped'] ? 'HIGH' : undefined} />
        <Stat label="Deduplicated" value={fmtNum(c['events.deduplicated'] ?? 0)} hint="hook/OTLP/process overlap" />
        <Stat label="Queue depth" value={`${s.queue.depth}`} hint={`limit ${fmtNum(s.queue.limit)}`} />
        <Stat label="CPU" value={`${s.metrics.cpu_percent}%`} hint="engine process" />
        <Stat label="Memory" value={`${s.metrics.rss_mb} MB`} hint={`heap ${s.metrics.heap_mb} MB`} />
        <Stat label="Database" value={`${s.database.size_mb} MB`} hint={`${fmtNum(s.database.events)} events`} tone={s.database.ok ? undefined : 'CRITICAL'} />
        <Stat label="Uptime" value={fmtDuration(s.metrics.uptime_ms)} />
      </div>
      <div className="grid cols-2">
        <Card title="Ingestion" sub="events stored per 10 s">
          <StackedColumns data={[...eventSeries, ...dropSeries]} from={first} to={Date.now()} bucketMs={10_000} height={150} order={['events stored', 'dropped']}
            color={(k) => (k === 'dropped' ? 'var(--sev-critical)' : 'var(--s1)')} />
        </Card>
        <Card title="Latency" sub="p50 / p95">
          <dl className="kv" style={{ gridTemplateColumns: '200px 1fr' }}>
            <dt>Pipeline batch</dt><dd className="num">{p('pipeline.batch')}</dd>
            <dt>Detection (per batch)</dt><dd className="num">{p('detection.batch')}</dd>
            <dt>Database write (per batch)</dt><dd className="num">{p('storage.batch')}</dd>
            <dt>API request</dt><dd className="num">{p('api.request')}</dd>
            <dt>Process snapshot</dt><dd className="num">{p('collector.process')}</dd>
            <dt>Network snapshot</dt><dd className="num">{p('collector.network')}</dd>
          </dl>
        </Card>
      </div>
      <Card title="Collectors" right={<span className="muted">{s.paused ? 'monitoring paused' : ''}</span>}>
        <table className="table">
          <thead><tr><th>Collector</th><th>State</th><th>Runs</th><th>Failures</th><th>Last run</th><th>Duration</th><th>Last error</th></tr></thead>
          <tbody>
            {s.collectors.map((col: any) => (
              <tr key={col.name}>
                <td>{col.name}</td>
                <td><span className="chip"><span className={`dot ${col.state === 'degraded' ? 'degraded' : col.state === 'running' ? '' : 'paused'}`} />{col.state}</span></td>
                <td className="num">{col.runs}</td><td className="num">{col.failures}</td><td className="dim">{fmtAgo(col.last_run_at)}</td>
                <td className="num">{col.last_duration_ms != null ? `${col.last_duration_ms} ms` : '—'}</td><td className="mono dim ellipsis" style={{ maxWidth: 360 }}>{col.last_error ?? '—'}</td>
              </tr>
            ))}
            {s.collectors.length === 0 && <tr><td colSpan={7} className="muted">OS collectors disabled (ingest-only mode)</td></tr>}
          </tbody>
        </table>
        {s.watched_workspaces.length > 0 && <><div className="section-title">Watched workspaces</div><div className="mono dim">{s.watched_workspaces.join('\n')}</div></>}
      </Card>
      <div className="grid cols-2">
        <Card title="Agent adapters">
          <table className="table">
            <thead><tr><th>Adapter</th><th>Capabilities</th><th>Events</th><th>Errors</th><th>Last event</th></tr></thead>
            <tbody>
              {s.adapters.map((ad: any) => (
                <tr key={ad.id}>
                  <td>{ad.display_name}{ad.custom && <span className="badge" style={{ marginLeft: 6 }}>custom</span>}</td>
                  <td className="dim" style={{ fontSize: 11.5 }}>{ad.capabilities.join(', ')}</td>
                  <td className="num">{ad.events}</td>
                  <td className="num" title={ad.last_error ?? ''}>{ad.errors ? <span className="badge sev sev-HIGH">{ad.errors}</span> : 0}</td>
                  <td className="dim">{fmtAgo(ad.last_event_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Database & maintenance" right={<>
          <button className="btn sm" onClick={async () => { await invoke('maintenance.integrity'); await refetch(); }}>Check integrity</button>
          <button className="btn sm" onClick={async () => { await invoke('maintenance.retention'); await refetch(); }}>Apply retention</button>
          <button className="btn sm" onClick={() => void invoke('export.diagnostics')}>Export diagnostics</button>
        </>}>
          <dl className="kv">
            <dt>Integrity</dt><dd>{s.database.ok ? 'OK' : <span className="badge sev sev-CRITICAL">{s.database.detail}</span>}</dd>
            <dt>Rows</dt><dd className="num">{fmtNum(s.database.events)} events · {fmtNum(s.database.sessions)} sessions · {fmtNum(s.database.detections)} detections · {fmtNum(s.database.alerts)} alerts</dd>
            <dt>Data directory</dt><dd className="mono">{s.data_dir} <button className="btn sm" onClick={() => void invoke('open.dataDir')}>Open</button></dd>
            <dt>Platform</dt><dd>{s.platform} · Node {s.node}{s.electron ? ` · Electron ${s.electron}` : ''} · {s.host.cpus} CPUs · {s.host.memory_gb} GB</dd>
            <dt>API requests</dt><dd className="num">{fmtNum(c['api.requests'] ?? 0)} ({c['api.status_401'] ?? 0} unauthorized, {c['api.status_429'] ?? 0} rate limited)</dd>
          </dl>
        </Card>
      </div>
      <Card title="Diagnostic log" sub="most recent 100 entries">
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          {[...s.logs].reverse().map((l: any, i: number) => (
            <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '90px 50px 110px 1fr', gap: 8, padding: '2px 0', color: l.level === 'error' ? 'var(--sev-critical)' : l.level === 'warn' ? 'var(--text)' : 'var(--text-2)' }}>
              <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span><span>{l.level}</span><span>{l.component}</span><span>{l.msg}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
