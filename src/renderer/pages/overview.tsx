import { useMemo, useState } from 'react';
import type { PageProps } from '../App.tsx';
import { useQuery, useStream, seriesColor, agentName, fmtNum, fmtTimeMs, TYPE_LABEL, SEVERITIES, sevRank, type EventRow } from '../lib.ts';
import { Card, Stat, SevBadge, AgentChip, EventInspector, VirtualList, SearchInput, Segmented, Empty } from '../ui.tsx';
import { StackedColumns, BarList } from '../charts.tsx';
import type { Severity } from '../../core/schema.ts';

export function OverviewPage({ nav, from, to }: PageProps) {
  const { data: o, error } = useQuery<any>('overview', { from, to });
  if (error) return <Empty title="Could not load overview">{error}</Empty>;
  if (!o) return <div className="muted">Loading…</div>;
  const k = o.kpis;
  const riskOrder = ['critical', 'high', 'medium', 'low', 'none'];
  const riskItems = riskOrder.map((r) => ({ key: r, n: o.risk_distribution[r] ?? 0 })).filter((x) => x.n > 0);
  const sevData = o.severity_series.map((d: any) => ({ ...d, series: SEVERITIES[d.series as number] }));
  const noData = k.events === 0;

  return (
    <div className="grid" style={{ gap: 14 }}>
      {noData && (
        <div className="card"><div className="card-b" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <strong>No agent activity in this time range yet.</strong>
            <div className="dim">Process discovery runs automatically. For full tool, command and file detail, connect Claude Code, Cursor, Codex or Gemini CLI in Settings → Integrations.</div>
          </div>
          <button className="btn primary" onClick={() => nav('settings', { tab: 'integrations' })}>Connect agents</button>
        </div></div>
      )}
      <div className="stats">
        <Stat label="Active agents" value={k.active_agents} hint={`${k.known_agents} known`} onClick={() => nav('agents')} />
        <Stat label="Active sessions" value={k.active_sessions} hint={`${fmtNum(k.sessions)} in range`} onClick={() => nav('sessions')} />
        <Stat label="Events / min" value={k.events_per_minute} hint={`${fmtNum(k.events)} total`} onClick={() => nav('live')} />
        <Stat label="Commands" value={fmtNum(k.commands)} onClick={() => nav('commands')} />
        <Stat label="File changes" value={fmtNum(k.files_modified)} onClick={() => nav('files')} />
        <Stat label="Tool calls" value={fmtNum(k.tools)} onClick={() => nav('tools')} />
        <Stat label="MCP calls" value={fmtNum(k.mcp_calls)} onClick={() => nav('mcp')} />
        <Stat label="Network connections" value={fmtNum(k.network)} onClick={() => nav('network')} />
        <Stat label="Detections" value={fmtNum(k.detections)} hint={`${k.open_alerts} open alerts`} onClick={() => nav('threats')} />
        <Stat label="Critical / high" value={`${k.critical} / ${k.high}`} tone={k.critical ? 'CRITICAL' : k.high ? 'HIGH' : undefined} onClick={() => nav('threats')} />
      </div>

      <div className="grid cols-3">
        <Card title="Activity by agent" sub="events per interval" className="span-2">
          <StackedColumns data={o.activity} from={from} to={to} bucketMs={o.range.bucket_ms} color={seriesColor} label={agentName}
            onBucketClick={(b) => nav('timeline', { from: String(b), to: String(b + o.range.bucket_ms) })} />
        </Card>
        <Card title="Session risk" sub="sessions in range">
          {riskItems.length ? (
            <BarList items={riskItems} onClick={() => nav('sessions')}
              color={(key) => key === 'none' ? 'var(--axis)' : `var(--sev-${key})`}
              render={(key) => <span className="chip" style={{ fontFamily: 'system-ui' }}><span className="swatch" style={{ background: key === 'none' ? 'var(--axis)' : `var(--sev-${key})` }} />{key === 'none' ? 'No risk' : key[0]!.toUpperCase() + key.slice(1)}</span>} />
          ) : <div className="muted">No sessions</div>}
          <div className="section-title">Agents</div>
          <BarList items={o.agent_distribution} onClick={(t) => nav('timeline', { agent_type: t })} color={seriesColor} render={(t) => <span style={{ fontFamily: 'system-ui' }}>{agentName(t)}</span>} />
        </Card>
      </div>

      <div className="grid cols-3">
        <Card title="Security detections" sub="by severity" className="span-2">
          {sevData.length ? <StackedColumns data={sevData} from={from} to={to} bucketMs={o.range.bucket_ms} height={150} order={['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']}
            color={(s) => `var(--sev-${s.toLowerCase()})`} label={(s) => s} onBucketClick={() => nav('threats')} /> : <div className="muted" style={{ padding: 20 }}>No detections in range.</div>}
        </Card>
        <Card title="Top detection rules">
          <BarList items={o.detection_counts.filter((d: any) => d.severity > 0).slice(0, 8).map((d: any) => ({ key: d.rule_id, n: d.n, extra: <SevBadge s={SEVERITIES[d.severity] as Severity} /> }))}
            onClick={(r) => nav('threats', { rule: r })} render={(r) => <span style={{ fontFamily: 'system-ui' }}>{o.detection_counts.find((d: any) => d.rule_id === r)?.rule_name}</span>} />
        </Card>
      </div>

      <div className="grid cols-3">
        <Card title="Top commands"><BarList items={o.top_commands.slice(0, 10)} onClick={(c) => nav('commands', { search: c })} /></Card>
        <Card title="Top tools"><BarList items={o.top_tools.slice(0, 10)} onClick={(t) => nav('tools', { search: t })} /></Card>
        <Card title="Top workspaces"><BarList items={o.top_workspaces.slice(0, 10)} onClick={(w) => nav('timeline', { search: '', workspace: w })} /></Card>
      </div>
      <Card title="Event types" sub="in range">
        <BarList items={o.type_distribution.slice(0, 14)} onClick={(t) => nav('timeline', { types: t })} render={(t) => <span style={{ fontFamily: 'system-ui' }}>{TYPE_LABEL[t] ?? t}</span>} />
      </Card>
    </div>
  );
}

const LIVE_CAP = 5000;

export function LivePage({ nav }: PageProps) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [minSev, setMinSev] = useState<Severity>('INFO');
  const [agent, setAgent] = useState('all');
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [rate, setRate] = useState<number[]>([]);
  const initial = useQuery<EventRow[]>('events', { limit: 300 });
  const base = events.length ? events : initial.data ?? [];

  useStream((b) => {
    setRate((r) => [...r.slice(-59), b.events.length]);
    if (paused) return;
    setEvents((prev) => [...[...b.events].reverse(), ...(prev.length ? prev : initial.data ?? [])].slice(0, LIVE_CAP));
  });

  const agents = useMemo(() => [...new Set(base.map((e) => e.agent_type))], [base]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return base.filter((e) => sevRank(e.severity) >= sevRank(minSev) && (agent === 'all' || e.agent_type === agent)
      && (!q || (e.summary ?? '').toLowerCase().includes(q) || e.event_type.includes(q) || (e.session_id ?? '').includes(q)));
  }, [base, search, minSev, agent]);

  return (
    <>
      <div className="toolbar">
        <button className={`btn ${paused ? 'primary' : ''}`} onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? 'Resume stream' : 'Pause stream'}</button>
        <SearchInput value={search} onChange={setSearch} placeholder="Filter summary, type, session" />
        <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent filter">
          <option value="all">All agents</option>
          {agents.map((a) => <option key={a} value={a}>{agentName(a)}</option>)}
        </select>
        <Segmented label="Minimum severity" value={minSev} onChange={setMinSev} options={SEVERITIES.map((s) => ({ id: s, label: s === 'INFO' ? 'All' : `${s[0]}${s.slice(1).toLowerCase()}+` }))} />
        <div className="grow" />
        <span className="muted num">{rate.length ? `${Math.round((rate.reduce((a, c) => a + c, 0) / rate.length) * 2)} events/s` : ''} · {filtered.length.toLocaleString()} shown</span>
      </div>
      <div className="card" style={{ height: 'calc(100vh - 150px)', overflow: 'hidden' }}>
        {filtered.length === 0 ? <Empty title="Waiting for events">New agent activity appears here as it is collected.</Empty> : (
          <VirtualList items={filtered} height="100%" columns="118px 140px 150px 82px minmax(0,1fr) 90px" getKey={(e) => e.event_id}
            selectedKey={selected?.event_id} onSelect={setSelected}
            header={<><span>Time</span><span>Agent</span><span>Type</span><span>Severity</span><span>Summary</span><span>Source</span></>}
            row={(e) => (
              <>
                <span className="num muted">{fmtTimeMs(e.timestamp)}</span>
                <span className="ellipsis"><AgentChip type={e.agent_type} /></span>
                <span className="ellipsis">{TYPE_LABEL[e.event_type] ?? e.event_type}</span>
                <span>{e.severity !== 'INFO' ? <SevBadge s={e.severity} /> : <span className="muted">—</span>}</span>
                <span className="ellipsis mono" title={e.summary ?? ''}>{e.summary}</span>
                <span className="muted">{e.source}{e.fidelity === 'inferred' ? '*' : ''}</span>
              </>
            )} />
        )}
      </div>
      {selected && <EventInspector event={selected} onClose={() => setSelected(null)} onOpenSession={(id) => nav('sessions', { id })} onFilterCorrelation={(c) => nav('timeline', { correlation_id: c })} />}
    </>
  );
}
