import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageProps } from '../App.tsx';
import { invoke, useQuery, fmtAgo, fmtDateTime, fmtDuration, fmtTimeMs, fmtNum, TYPE_LABEL, DIM_LABEL, agentName, seriesColor, type EventRow } from '../lib.ts';
import { Card, Stat, SevBadge, RiskMeter, AgentChip, Drawer, Empty, SearchInput, Segmented, Switch, EventInspector } from '../ui.tsx';
import type { Detection } from '../../core/schema.ts';

export function AgentsPage({ nav }: PageProps) {
  const { data: agents, refetch } = useQuery<any[]>('agents', null, { interval: 5000 });
  const { data: sys } = useQuery<any>('system', null, { interval: 5000 });
  const [filter, setFilter] = useState<'all' | 'running' | 'installed' | 'history'>('all');
  const [selected, setSelected] = useState<any | null>(null);
  if (!agents) return <div className="muted">Loading…</div>;
  const rows = agents.filter((a) => filter === 'all' || (filter === 'running' ? a.running : filter === 'installed' ? a.installed : a.last_seen > 0));
  const roots = (type: string) => (sys?.tracked_roots ?? []).filter((r: any) => r.adapter_id === type);

  return (
    <>
      <div className="stats" style={{ marginBottom: 14 }}>
        <Stat label="Running now" value={agents.filter((a) => a.running).length} />
        <Stat label="Installed" value={agents.filter((a) => a.installed).length} />
        <Stat label="Observed historically" value={agents.filter((a) => a.last_seen > 0).length} />
        <Stat label="Untrusted" value={agents.filter((a) => a.trust === 'untrusted').length} />
      </div>
      <div className="toolbar">
        <Segmented label="Agent filter" value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All' }, { id: 'running', label: 'Running' }, { id: 'installed', label: 'Installed' }, { id: 'history', label: 'Observed' }]} />
        <div className="grow" />
        <button className="btn" onClick={async () => { await invoke('maintenance.rediscover'); await refetch(); }}>Rescan installed agents</button>
      </div>
      <div className="card">
        {rows.length === 0 ? <Empty title="No agents match">Installed agents are discovered from known config locations; running agents from the process list.</Empty> : (
          <table className="table">
            <thead><tr><th>Agent</th><th>Status</th><th>Runtime</th><th>Version</th><th>Processes</th><th>Sessions</th><th>Last activity</th><th style={{ width: 140 }}>Risk (24h)</th><th>Trust</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.agent_id} className="clickable" onClick={() => setSelected(a)} aria-selected={selected?.agent_id === a.agent_id}>
                  <td><AgentChip type={a.agent_type} /></td>
                  <td>{a.running ? <span className="chip"><span className="dot" />Running</span> : a.installed ? <span className="dim">Installed</span> : <span className="muted">Not running</span>}</td>
                  <td className="dim">{a.runtime}</td>
                  <td className="mono dim">{a.version ?? '—'}</td>
                  <td className="num">{roots(a.agent_type).map((r: any) => r.pid).join(', ') || '—'}</td>
                  <td className="num">{a.session_count}</td>
                  <td className="dim">{a.last_seen ? fmtAgo(a.last_seen) : '—'}</td>
                  <td><RiskMeter score={a.risk_score} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select className="input" value={a.trust} aria-label={`Trust for ${a.display_name}`} onChange={async (e) => { await invoke('agent.trust', { agent_id: a.agent_id, trust: e.target.value }); await refetch(); }}>
                      <option value="unknown">Unreviewed</option><option value="trusted">Trusted</option><option value="untrusted">Untrusted</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {selected && <AgentDrawer agent={selected} roots={roots(selected.agent_type)} onClose={() => setSelected(null)} nav={nav} />}
    </>
  );
}

function AgentDrawer({ agent, roots, onClose, nav }: { agent: any; roots: any[]; onClose: () => void; nav: PageProps['nav'] }) {
  const { data: sessions } = useQuery<any[]>('sessions', { agent_id: agent.agent_id, limit: 50 });
  const { data: dets } = useQuery<Detection[]>('detections', { agent_id: agent.agent_id, limit: 20, min_severity: 'LOW' });
  return (
    <Drawer title={agent.display_name} onClose={onClose} actions={<button className="btn sm" onClick={() => nav('graph', { agent_id: agent.agent_id })}>View graph</button>}>
      <dl className="kv">
        <dt>Agent id</dt><dd className="mono">{agent.agent_id}</dd>
        <dt>Runtime</dt><dd>{agent.runtime}</dd>
        <dt>Executable</dt><dd className="mono">{agent.executable ?? '—'}</dd>
        <dt>First seen</dt><dd>{agent.last_seen ? fmtDateTime(agent.first_seen) : '—'}</dd>
        <dt>Install paths</dt><dd className="mono">{(agent.meta.install_paths ?? []).join('\n') || '—'}</dd>
        <dt>Capabilities</dt><dd style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{(agent.meta.capabilities ?? []).map((c: string) => <span key={c} className="badge">{c}</span>)}</dd>
      </dl>
      <div className="section-title">Live processes</div>
      {roots.length ? roots.map((r) => (
        <div key={r.pid} className="dim" style={{ marginBottom: 4 }}><span className="mono">pid {r.pid}</span> · {r.name} · {r.descendants} child processes {r.cwd && <>· <span className="mono">{r.cwd}</span></>}</div>
      )) : <div className="muted">Not running</div>}
      <div className="section-title">Recent sessions</div>
      <table className="table">
        <tbody>
          {(sessions ?? []).slice(0, 15).map((s) => (
            <tr key={s.session_id} className="clickable" onClick={() => nav('sessions', { id: s.session_id })}>
              <td className="mono ellipsis" style={{ maxWidth: 200 }}>{s.session_id}</td><td className="dim">{fmtAgo(s.last_activity)}</td><td className="num">{s.event_count}</td><td style={{ width: 110 }}><RiskMeter score={s.risk_score} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">Recent detections</div>
      {(dets ?? []).map((d) => (
        <div key={d.detection_id} className="explain-factor"><span><SevBadge s={d.severity} /> {d.rule_name}</span><span className="muted">{fmtAgo(d.timestamp)}</span><span className="mono muted ellipsis" style={{ gridColumn: '1 / -1' }}>{d.evidence[0]}</span></div>
      ))}
      {dets?.length === 0 && <div className="muted">None</div>}
    </Drawer>
  );
}

export function SessionsPage({ nav, from, route }: PageProps) {
  const [activeOnly, setActiveOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'activity' | 'risk' | 'events'>('activity');
  const { data } = useQuery<any[]>('sessions', { active_since: from, limit: 2000 }, { interval: 5000 });
  const rows = useMemo(() => {
    const q = search.toLowerCase();
    const r = (data ?? []).filter((s) => (!activeOnly || (!s.ended_at && Date.now() - s.last_activity < 15 * 60_000))
      && (!route.params.agent_type || s.agent_type === route.params.agent_type)
      && (!q || s.session_id.toLowerCase().includes(q) || (s.workspace ?? '').toLowerCase().includes(q) || agentName(s.agent_type).toLowerCase().includes(q)));
    return r.sort((a, b) => sort === 'risk' ? b.risk_score - a.risk_score : sort === 'events' ? b.event_count - a.event_count : b.last_activity - a.last_activity);
  }, [data, activeOnly, search, sort, route.params.agent_type]);

  return (
    <>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Session, workspace or agent" />
        <label className="chip"><Switch checked={activeOnly} onChange={setActiveOnly} label="Active only" />Active only</label>
        <div className="grow" />
        <span className="muted">Sort</span>
        <Segmented label="Sort" value={sort} onChange={setSort} options={[{ id: 'activity', label: 'Recent' }, { id: 'risk', label: 'Risk' }, { id: 'events', label: 'Events' }]} />
      </div>
      <div className="card" style={{ overflow: 'auto', maxHeight: 'calc(100vh - 150px)' }}>
        {rows.length === 0 ? <Empty title="No sessions in range" /> : (
          <table className="table">
            <thead><tr><th>Agent</th><th>Session</th><th>Workspace</th><th>Started</th><th>Duration</th><th>Events</th><th>Status</th><th style={{ width: 150 }}>Risk</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.session_id} className="clickable" onClick={() => nav('sessions', { id: s.session_id })}>
                  <td><AgentChip type={s.agent_type} /></td>
                  <td className="mono ellipsis" style={{ maxWidth: 220 }} title={s.session_id}>{s.session_id}</td>
                  <td className="mono ellipsis dim" style={{ maxWidth: 260 }} title={s.workspace ?? ''}>{s.workspace ?? '—'}</td>
                  <td className="dim">{fmtDateTime(s.started_at)}</td>
                  <td className="num dim">{fmtDuration((s.ended_at ?? s.last_activity) - s.started_at)}</td>
                  <td className="num">{fmtNum(s.event_count)}</td>
                  <td>{s.ended_at ? <span className="muted">Ended</span> : Date.now() - s.last_activity < 15 * 60_000 ? <span className="chip"><span className="dot" />Active</span> : <span className="dim">Idle</span>}</td>
                  <td><RiskMeter score={s.risk_score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const TYPE_GROUPS: Record<string, string[]> = {
  commands: ['command_execution', 'process_started'],
  files: ['file_read', 'file_modified', 'file_created', 'file_deleted', 'directory_access'],
  tools: ['tool_call', 'tool_result', 'mcp_call', 'mcp_server_activity'],
  network: ['network_connection_metadata'],
  security: ['security_detection', 'policy_violation', 'approval_requested', 'approval_denied', 'approval_granted'],
};

export function SessionDetailPage({ route, nav }: PageProps) {
  const id = route.params.id!;
  const { data } = useQuery<{ session: any; detections: Detection[] }>('session', { id }, { interval: 5000 });
  const { data: events } = useQuery<EventRow[]>('events', { session_id: id, order: 'asc', limit: 5000 }, { interval: 5000 });
  if (!data) return <div className="muted">Loading…</div>;
  if (!data.session) return <Empty title="Session not found">It may have been removed by the retention policy.</Empty>;
  const s = data.session;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="stats">
        <Stat label="Agent" value={<span style={{ fontSize: 16 }}><AgentChip type={s.agent_type} /></span>} hint={s.pid ? `pid ${s.pid}` : undefined} />
        <Stat label="Started" value={<span style={{ fontSize: 16 }}>{fmtDateTime(s.started_at)}</span>} hint={s.ended_at ? `ended ${fmtAgo(s.ended_at)}` : `active ${fmtAgo(s.last_activity)}`} />
        <Stat label="Duration" value={fmtDuration((s.ended_at ?? s.last_activity) - s.started_at)} />
        <Stat label="Events" value={fmtNum(s.event_count)} />
        <Stat label="Detections" value={data.detections.filter((d) => d.severity !== 'INFO').length} />
        <Stat label="Risk score" value={Math.round(s.risk_score)} hint={s.risk?.level} tone={s.risk?.level && s.risk.level !== 'none' ? s.risk.level.toUpperCase() : undefined} />
      </div>
      <div className="grid cols-3" style={{ alignItems: 'start' }}>
        <Card title="Timeline" sub={<span className="mono">{id}</span>} className="span-2"
          right={<><button className="btn sm" onClick={() => nav('graph', { session_id: id })}>Graph</button><button className="btn sm" onClick={() => void invoke('export.events', { query: { session_id: id }, format: 'jsonl' })}>Export</button></>}>
          {s.workspace && <div className="dim mono" style={{ marginBottom: 10 }}>{s.workspace}</div>}
          <Timeline events={events ?? []} nav={nav} />
        </Card>
        <RiskExplanation risk={s.risk} detections={data.detections} />
      </div>
    </div>
  );
}

export function RiskExplanation({ risk, detections }: { risk: any; detections: Detection[] }) {
  const [open, setOpen] = useState<Detection | null>(null);
  if (!risk?.factors) return <Card title="Risk explanation"><div className="muted">No risk factors observed. Nothing in this session matched a detection rule or policy.</div></Card>;
  const dims = Object.entries(risk.dimensions as Record<string, number>).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Risk explanation" sub={`score ${risk.score} · ${risk.level}`}>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>{risk.formula}</div>
      <div className="section-title" style={{ marginTop: 0 }}>Dimensions</div>
      {dims.map(([d, v]) => <div key={d} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center', marginBottom: 4 }}><span className="dim">{DIM_LABEL[d] ?? d}</span><RiskMeter score={v} /></div>)}
      <div className="section-title">Contributing factors</div>
      {risk.factors.map((f: any) => {
        const det = detections.find((d) => d.detection_id === f.detection_id);
        return (
          <div key={f.detection_id} className="explain-factor" role="button" tabIndex={0} onClick={() => det && setOpen(det)} onKeyDown={(e) => e.key === 'Enter' && det && setOpen(det)} style={{ cursor: 'default' }}>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}><SevBadge s={f.severity} /><span className="ellipsis">{f.rule_name}</span></span>
            <span className="num" title="points contributed before rank decay">+{f.points}</span>
            <span className="muted" style={{ gridColumn: '1 / -1', fontSize: 11.5 }}>{f.classification.replace('_', ' ')} · confidence {Math.round(f.confidence * 100)}% · {DIM_LABEL[f.dimension]}</span>
            {f.evidence?.[0] && <span className="mono muted ellipsis" style={{ gridColumn: '1 / -1' }} title={f.evidence[0]}>{f.evidence[0]}</span>}
          </div>
        );
      })}
      {open && <DetectionDrawer d={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

export function DetectionDrawer({ d, onClose, extra }: { d: Detection; onClose: () => void; extra?: React.ReactNode }) {
  const { data: ev } = useQuery<EventRow | null>('event', { id: d.event_id });
  return (
    <Drawer title={d.rule_name} onClose={onClose}>
      <dl className="kv">
        <dt>Severity</dt><dd><SevBadge s={d.severity} /> <span className="muted">confidence {Math.round(d.confidence * 100)}%</span></dd>
        <dt>Classification</dt><dd>{d.classification === 'observation' ? 'Observation (fact, not a finding)' : d.classification === 'policy_violation' ? 'Confirmed policy violation' : 'Suspicious indicator (requires review)'}</dd>
        <dt>Reason</dt><dd>{d.reason}</dd>
        <dt>Recommended action</dt><dd>{d.recommended_action}</dd>
        <dt>Rule</dt><dd className="mono">{d.rule_id}</dd>
        <dt>Risk dimension</dt><dd>{DIM_LABEL[d.dimension]}</dd>
        <dt>Agent</dt><dd><AgentChip type={d.agent_type} /></dd>
        <dt>Time</dt><dd>{fmtDateTime(d.timestamp)}</dd>
        <dt>Detection id</dt><dd className="mono">{d.detection_id}</dd>
      </dl>
      <div className="section-title">Evidence</div>
      {d.evidence.map((e, i) => <pre key={i} className="json" style={{ marginBottom: 6 }}>{e}</pre>)}
      {d.related_event_ids.length > 0 && <><div className="section-title">Related events</div><div className="mono dim">{d.related_event_ids.join('\n')}</div></>}
      <div className="section-title">Triggering event</div>
      {ev ? <pre className="json">{JSON.stringify(ev, null, 2)}</pre> : <div className="muted">Event no longer retained</div>}
      {extra}
    </Drawer>
  );
}

export function Timeline({ events, nav }: { events: EventRow[]; nav: PageProps['nav'] }) {
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inspect, setInspect] = useState<EventRow | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return events.filter((e) => (group === 'all' || TYPE_GROUPS[group]!.includes(e.event_type)) && (!q || (e.summary ?? '').toLowerCase().includes(q) || e.event_type.includes(q)));
  }, [events, group, search]);
  const byId = useMemo(() => new Map(events.map((e) => [e.event_id, e])), [events]);
  const callIds = useMemo(() => new Set(events.filter((e) => e.event_type !== 'tool_result' && e.correlation_id).map((e) => e.correlation_id)), [events]);
  // Children (tool results, detections) indent under the call or event they correlate to.
  const depth = (e: EventRow) => (e.correlation_id && (byId.has(e.correlation_id) || (e.event_type === 'tool_result' && callIds.has(e.correlation_id))) ? 1 : 0);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setCursor((c) => {
      const next = (c ?? -1) + 1;
      if (next >= filtered.length - 1) { setPlaying(false); return filtered.length - 1; }
      return next;
    }), 350);
    return () => clearInterval(t);
  }, [playing, filtered.length]);
  useEffect(() => {
    if (cursor == null || !listRef.current) return;
    listRef.current.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [cursor]);

  const shown = filtered.slice(0, 2000);
  return (
    <>
      <div className="toolbar">
        <Segmented label="Event group" value={group} onChange={setGroup} options={[{ id: 'all', label: 'All' }, { id: 'commands', label: 'Commands' }, { id: 'files', label: 'Files' }, { id: 'tools', label: 'Tools' }, { id: 'network', label: 'Network' }, { id: 'security', label: 'Security' }]} />
        <SearchInput value={search} onChange={setSearch} placeholder="Search timeline" />
      </div>
      <div className="replay" style={{ marginBottom: 10 }}>
        <button className="btn sm" onClick={() => { if (cursor == null || cursor >= filtered.length - 1) setCursor(-1); setPlaying(!playing); }}>{playing ? 'Pause replay' : 'Replay'}</button>
        <input type="range" min={0} max={Math.max(0, filtered.length - 1)} value={cursor ?? filtered.length - 1} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} aria-label="Replay position" />
        <span className="muted num" style={{ minWidth: 140, textAlign: 'right' }}>{cursor != null && filtered[cursor] ? fmtTimeMs(filtered[cursor]!.timestamp) : `${filtered.length} events`}</span>
        {cursor != null && <button className="btn ghost sm" onClick={() => { setCursor(null); setPlaying(false); }}>Show all</button>}
      </div>
      <div className="tl" ref={listRef} style={{ maxHeight: 'calc(100vh - 360px)', overflow: 'auto', paddingRight: 4 }}>
        {shown.length === 0 && <Empty title="No events" />}
        {shown.map((e, i) => {
          const isOpen = expanded.has(e.event_id);
          const alert = e.event_type === 'security_detection' || e.event_type === 'policy_violation';
          const d = depth(e);
          const color = alert ? `var(--sev-${e.severity.toLowerCase()})` : seriesColor(Object.keys(TYPE_GROUPS).find((g) => TYPE_GROUPS[g]!.includes(e.event_type)) ?? 'other', 'group');
          return (
            <div key={e.event_id} className="tl-row" data-idx={i}>
              <span className="time">{fmtTimeMs(e.timestamp)}</span>
              <span className="tl-rail"><span className="tl-node" style={{ background: color }} /></span>
              <div style={{ paddingLeft: d * 22 }}>
                <button className={`tl-card ${alert ? 'alert' : ''} ${cursor != null && i > cursor ? 'future' : ''}`} aria-expanded={isOpen}
                  onClick={() => setExpanded((x) => { const n = new Set(x); if (n.has(e.event_id)) n.delete(e.event_id); else n.add(e.event_id); return n; })}>
                  <div className="tl-head">
                    <span className="type">{TYPE_LABEL[e.event_type] ?? e.event_type}</span>
                    {e.severity !== 'INFO' && <SevBadge s={e.severity} />}
                    <span className="sum mono ellipsis">{e.summary}</span>
                    <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', fontSize: 11.5 }}>{e.duration_ms != null ? `${fmtDuration(e.duration_ms)} · ` : ''}{e.source}{e.fidelity === 'inferred' ? ' (inferred)' : ''}</span>
                  </div>
                  {isOpen && (
                    <div style={{ marginTop: 8 }} onClick={(ev) => ev.stopPropagation()}>
                      <pre className="json">{JSON.stringify(e.payload, null, 2)}</pre>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button className="btn sm" onClick={() => setInspect(e)}>Inspect raw event</button>
                        {e.correlation_id && byId.get(e.correlation_id) && <button className="btn sm" onClick={() => setInspect(byId.get(e.correlation_id!)!)}>Open parent event</button>}
                      </div>
                    </div>
                  )}
                </button>
              </div>
            </div>
          );
        })}
        {filtered.length > shown.length && <div className="muted" style={{ padding: 10 }}>Showing first {shown.length} of {filtered.length}; use search or export for the rest.</div>}
      </div>
      {inspect && <EventInspector event={inspect} onClose={() => setInspect(null)} onOpenSession={(sid) => nav('sessions', { id: sid })} onFilterCorrelation={(c) => nav('timeline', { correlation_id: c })} />}
    </>
  );
}
