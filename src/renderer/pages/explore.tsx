import { useMemo, useState } from 'react';
import type { PageProps } from '../App.tsx';
import { invoke, useQuery, useStream, fmtTimeMs, fmtAgo, fmtDateTime, fmtNum, TYPE_LABEL, SEVERITIES, agentName, seriesColor, type EventRow } from '../lib.ts';
import { Card, Stat, SevBadge, AgentChip, VirtualList, EventInspector, SearchInput, Empty, Segmented } from '../ui.tsx';
import { BarList, StackedColumns } from '../charts.tsx';
import type { Severity } from '../../core/schema.ts';

export const EXPLORERS: Record<string, { types: string[]; title: string; column: string; topBy: (e: EventRow) => string | null }> = {
  commands: { types: ['command_execution', 'process_started'], title: 'Command', column: 'Command', topBy: (e) => binary(String(e.payload.command ?? '')) },
  files: { types: ['file_read', 'file_modified', 'file_created', 'file_deleted', 'directory_access'], title: 'File', column: 'Path', topBy: (e) => dirOf(String(e.payload.path ?? '')) },
  tools: { types: ['tool_call', 'tool_result', 'mcp_call', 'command_execution', 'file_read', 'file_modified', 'directory_access'], title: 'Tool', column: 'Tool / target', topBy: (e) => (e.payload.tool_name as string) ?? null },
  network: { types: ['network_connection_metadata'], title: 'Destination', column: 'Destination', topBy: (e) => String(e.payload.host ?? e.payload.remote_ip ?? '') || null },
  mcp: { types: ['mcp_call', 'mcp_server_activity'], title: 'MCP', column: 'Server / tool', topBy: (e) => (e.payload.mcp_server as string) ?? null },
};

const binary = (cmd: string) => cmd.trim().replace(/^(sudo|env)\s+/, '').split(/\s+/)[0]?.split(/[\\/]/).pop() || null;
const dirOf = (p: string) => { const parts = p.split(/[\\/]/); parts.pop(); return parts.slice(-3).join('/') || null; };

function useEvents(q: Record<string, unknown>, live: boolean) {
  const res = useQuery<EventRow[]>('events', q);
  const [extra, setExtra] = useState<EventRow[]>([]);
  const types = q.types as string[] | undefined;
  useStream((b) => {
    if (!live) return;
    const add = b.events.filter((e) => (!types || types.includes(e.event_type)) && (!q.agent_type || e.agent_type === q.agent_type) && (!q.session_id || e.session_id === q.session_id));
    if (add.length) setExtra((x) => [...add.reverse(), ...x].slice(0, 2000));
  });
  const merged = useMemo(() => {
    const seen = new Set<string>();
    return [...extra, ...(res.data ?? [])].filter((e) => (seen.has(e.event_id) ? false : (seen.add(e.event_id), true)));
  }, [extra, res.data]);
  return { events: merged, loading: res.loading, refetch: () => { setExtra([]); return res.refetch(); } };
}

export function TimelinePage({ route, nav, from, to }: PageProps) {
  const p = route.params;
  const [search, setSearch] = useState(p.search ?? '');
  const [minSev, setMinSev] = useState<Severity>('INFO');
  const [selected, setSelected] = useState<EventRow | null>(null);
  const q = {
    from: p.from ? Number(p.from) : from, to: p.to ? Number(p.to) : to, agent_type: p.agent_type, session_id: p.session_id,
    correlation_id: p.correlation_id, types: p.types ? p.types.split(',') : undefined, search: search || undefined, min_severity: minSev, limit: 5000,
  };
  const { events, loading } = useEvents(q, !p.from && !p.correlation_id);
  const filtered = p.workspace ? events.filter((e) => e.workspace === p.workspace) : events;
  const active = Object.entries(p).filter(([k]) => ['agent_type', 'session_id', 'correlation_id', 'types', 'workspace', 'from'].includes(k));

  return (
    <>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search summaries" />
        <select className="input" value={minSev} onChange={(e) => setMinSev(e.target.value as Severity)} aria-label="Minimum severity">
          {SEVERITIES.map((s) => <option key={s} value={s}>{s === 'INFO' ? 'All severities' : `${s}+`}</option>)}
        </select>
        {active.map(([k, v]) => (
          <span key={k} className="badge" style={{ gap: 6 }}>{k === 'from' ? `${fmtDateTime(Number(v))} window` : `${k.replace('_', ' ')}: ${k === 'agent_type' ? agentName(v) : k === 'types' ? v.split(',').map((t) => TYPE_LABEL[t] ?? t).join(', ') : v}`}
            <button className="btn ghost sm" style={{ height: 16, padding: '0 3px' }} aria-label={`Remove ${k} filter`} onClick={() => { const n = { ...p }; delete n[k]; if (k === 'from') delete n.to; nav('timeline', n); }}>×</button>
          </span>
        ))}
        <div className="grow" />
        <span className="muted num">{loading ? 'Loading…' : `${filtered.length.toLocaleString()} events${filtered.length >= 5000 ? ' (limit)' : ''}`}</span>
        <button className="btn" onClick={() => void invoke('export.events', { query: { ...q, limit: undefined }, format: 'jsonl' })}>Export JSONL</button>
        <button className="btn" onClick={() => void invoke('export.events', { query: { ...q, limit: undefined }, format: 'csv' })}>CSV</button>
      </div>
      <div className="card" style={{ height: 'calc(100vh - 150px)', overflow: 'hidden' }}>
        {filtered.length === 0 && !loading ? <Empty title="No events match" /> : (
          <VirtualList items={filtered} height="100%" columns="118px 140px 140px 80px minmax(0,1fr) 170px 76px" getKey={(e) => e.event_id}
            selectedKey={selected?.event_id} onSelect={setSelected}
            header={<><span>Time</span><span>Agent</span><span>Type</span><span>Severity</span><span>Summary</span><span>Session</span><span>Source</span></>}
            row={(e) => (
              <>
                <span className="num muted" title={fmtDateTime(e.timestamp)}>{fmtTimeMs(e.timestamp)}</span>
                <span className="ellipsis"><AgentChip type={e.agent_type} /></span>
                <span className="ellipsis">{TYPE_LABEL[e.event_type] ?? e.event_type}</span>
                <span>{e.severity !== 'INFO' ? <SevBadge s={e.severity} /> : <span className="muted">—</span>}</span>
                <span className="ellipsis mono" title={e.summary ?? ''}>{e.summary}</span>
                <span className="ellipsis mono muted" title={e.session_id ?? ''}>{e.session_id}</span>
                <span className="muted">{e.source}</span>
              </>
            )} />
        )}
      </div>
      {selected && <EventInspector event={selected} onClose={() => setSelected(null)} onOpenSession={(id) => nav('sessions', { id })} onFilterCorrelation={(c) => nav('timeline', { correlation_id: c })} />}
    </>
  );
}

export function ExplorerPage({ kind, route, nav, from, to }: PageProps & { kind: string }) {
  const def = EXPLORERS[kind]!;
  const [search, setSearch] = useState(route.params.search ?? '');
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const q = { from, to, types: def.types, search: search || undefined, limit: 5000 };
  const { events } = useEvents(q, true);
  const ov = useQuery<any>('overview', { from, to });
  const rows = focus ? events.filter((e) => def.topBy(e) === focus) : events;
  const top = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) { const k = def.topBy(e); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n).slice(0, 12);
  }, [events, def]);
  const series = useMemo(() => {
    const bucket = ov.data?.range.bucket_ms ?? 60_000;
    const m = new Map<string, number>();
    for (const e of events) { const k = `${Math.floor(e.timestamp / bucket) * bucket}|${e.agent_type}`; m.set(k, (m.get(k) ?? 0) + 1); }
    return { bucket, data: [...m.entries()].map(([k, n]) => ({ bucket: Number(k.split('|')[0]), series: k.split('|')[1]!, n })) };
  }, [events, ov.data]);
  const risky = events.filter((e) => e.risk_score > 0).length;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid cols-3">
        <Card title={`${def.title} activity`} sub={`${fmtNum(events.length)} events${events.length >= 5000 ? ' (latest 5,000)' : ''} · ${risky} with risk`} className="span-2">
          <StackedColumns data={series.data} from={from} to={to} bucketMs={series.bucket} height={150} color={seriesColor} label={agentName} />
        </Card>
        <Card title={`Top ${kind === 'files' ? 'directories' : kind === 'commands' ? 'binaries' : kind === 'network' ? 'destinations' : kind === 'mcp' ? 'servers' : 'tools'}`} right={focus && <button className="btn sm" onClick={() => setFocus(null)}>Clear</button>}>
          <BarList items={top} onClick={(k) => setFocus(focus === k ? null : k)} />
        </Card>
      </div>
      {kind === 'mcp' && <McpInventory />}
      {kind === 'network' && <NetworkInventory />}
      <div>
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder={`Search ${kind}`} />
          {focus && <span className="badge">{focus}</span>}
          <div className="grow" />
          <button className="btn" onClick={() => void invoke('export.events', { query: { ...q, limit: undefined }, format: 'csv' })}>Export CSV</button>
        </div>
        <div className="card" style={{ height: 520, overflow: 'hidden' }}>
          {rows.length === 0 ? <Empty title={`No ${kind} activity in range`}>{kind === 'network' ? 'Network metadata comes from connection tables of monitored agent processes and from web-fetch tool calls.' : 'Connect agent hooks in Settings for detailed activity.'}</Empty> : (
            <VirtualList items={rows} height="100%" columns="118px 140px 120px 80px minmax(0,1fr) 90px" getKey={(e) => e.event_id} selectedKey={selected?.event_id} onSelect={setSelected}
              header={<><span>Time</span><span>Agent</span><span>Type</span><span>Severity</span><span>{def.column}</span><span>Fidelity</span></>}
              row={(e) => (
                <>
                  <span className="num muted">{fmtTimeMs(e.timestamp)}</span>
                  <span className="ellipsis"><AgentChip type={e.agent_type} /></span>
                  <span className="ellipsis dim">{TYPE_LABEL[e.event_type]}</span>
                  <span>{e.severity !== 'INFO' ? <SevBadge s={e.severity} /> : <span className="muted">—</span>}</span>
                  <span className="ellipsis mono" title={e.summary ?? ''}>{e.summary}</span>
                  <span className="muted">{e.fidelity}</span>
                </>
              )} />
          )}
        </div>
      </div>
      {selected && <EventInspector event={selected} onClose={() => setSelected(null)} onOpenSession={(id) => nav('sessions', { id })} onFilterCorrelation={(c) => nav('timeline', { correlation_id: c })} />}
    </div>
  );
}

function McpInventory() {
  const { data: servers } = useQuery<any[]>('inventory', { kind: 'mcp_server' });
  const { data: seen } = useQuery<any[]>('inventory', { kind: 'mcp_seen' });
  return (
    <Card title="Configured MCP servers" sub="discovered from agent configuration files; environment variable values are never read into storage">
      {!servers?.length ? <div className="muted">No MCP configuration found.</div> : (
        <table className="table">
          <thead><tr><th>Server</th><th>Client</th><th>Transport</th><th>Command / URL</th><th>Env vars</th><th>Observed calls</th></tr></thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td><td><AgentChip type={s.client} /></td><td className="dim">{s.transport}</td>
                <td className="mono ellipsis dim" style={{ maxWidth: 380 }} title={s.command ?? s.url}>{s.command ?? s.url}</td>
                <td className="mono dim">{s.env_keys.join(', ') || '—'}</td>
                <td className="dim">{seen?.some((x) => x.server === s.name.toLowerCase()) ? 'yes' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!!seen?.filter((x) => !x.configured).length && (
        <><div className="section-title">Called but not configured</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{seen.filter((x) => !x.configured).map((x) => <span key={x.id} className="badge">{x.server} · {agentName(x.agent_type)}</span>)}</div></>
      )}
    </Card>
  );
}

function NetworkInventory() {
  const { data } = useQuery<any[]>('inventory', { kind: 'net_dest' });
  if (!data?.length) return null;
  return (
    <Card title="Non-allowlisted destinations" sub="first seen per agent">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {data.sort((a, b) => b.first_seen - a.first_seen).slice(0, 60).map((d) => <span key={d.id} className="badge" title={fmtDateTime(d.first_seen)}>{d.destination} · {agentName(d.agent_type)}</span>)}
      </div>
    </Card>
  );
}

export function ProcessesPage({ nav }: PageProps) {
  const { data: tree } = useQuery<any[]>('processes', null, { interval: 5000 });
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'tree' | 'flat'>('tree');
  if (!tree) return <div className="muted">Loading…</div>;
  const f = filter.toLowerCase();
  const total = tree.reduce((a, r) => a + r.children.length + 1, 0);
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="stats">
        <Stat label="Agent root processes" value={tree.length} />
        <Stat label="Tracked processes" value={total} />
        <Stat label="Agent types" value={new Set(tree.map((r) => r.adapter_id)).size} />
      </div>
      <div className="toolbar">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by name or command" />
        <Segmented label="View" value={view} onChange={setView} options={[{ id: 'tree', label: 'Tree' }, { id: 'flat', label: 'Flat' }]} />
        <div className="grow" />
        <span className="muted">Snapshot refreshes every 5 s. Very short-lived processes can be missed between snapshots; hook integrations capture those.</span>
      </div>
      {tree.length === 0 && <div className="card"><Empty title="No agent processes running">When a known agent starts, its process tree appears here.</Empty></div>}
      {tree.map((r) => {
        const kids = r.children.filter((c: any) => !f || c.name.toLowerCase().includes(f) || c.cmd.toLowerCase().includes(f));
        if (f && !kids.length && !r.name.toLowerCase().includes(f)) return null;
        const byParent = new Map<number, any[]>();
        for (const c of r.children) { const arr = byParent.get(c.ppid); if (arr) arr.push(c); else byParent.set(c.ppid, [c]); }
        const renderNode = (pid: number, depth: number): React.ReactNode => (byParent.get(pid) ?? []).map((c) => (
          <div key={c.pid}>
            <div style={{ display: 'grid', gridTemplateColumns: '80px 160px 1fr 90px', gap: 10, padding: '4px 0', paddingLeft: depth * 18, borderTop: '1px solid var(--border)' }}>
              <span className="mono muted">{c.pid}</span><span className="ellipsis">{c.name}</span><span className="mono dim ellipsis" title={c.cmd}>{c.cmd}</span><span className="muted">{c.started_at ? fmtAgo(c.started_at) : ''}</span>
            </div>
            {renderNode(c.pid, depth + 1)}
          </div>
        ));
        return (
          <Card key={r.pid} title={<AgentChip type={r.adapter_id} />} sub={<span className="mono">pid {r.pid} · {r.name}{r.cwd ? ` · ${r.cwd}` : ''}</span>}
            right={<button className="btn sm" onClick={() => nav('sessions', { id: r.session_id })}>Session</button>}>
            {view === 'tree' && !f ? (r.children.length ? renderNode(r.pid, 0) : <div className="muted">No child processes</div>) : (
              kids.map((c: any) => (
                <div key={c.pid} style={{ display: 'grid', gridTemplateColumns: '80px 80px 160px 1fr', gap: 10, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                  <span className="mono muted">{c.pid}</span><span className="mono muted">↑{c.ppid}</span><span>{c.name}</span><span className="mono dim ellipsis" title={c.cmd}>{c.cmd}</span>
                </div>
              ))
            )}
          </Card>
        );
      })}
    </div>
  );
}
