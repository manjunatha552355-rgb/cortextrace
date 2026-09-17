import { useEffect, useMemo, useRef, useState } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force';
import type { PageProps } from '../App.tsx';
import { useQuery, agentName } from '../lib.ts';
import { Empty, Segmented } from '../ui.tsx';

interface GNode extends SimulationNodeDatum { id: string; kind: string; label: string; weight: number; risk: number }
interface GLink extends SimulationLinkDatum<GNode> { kind: string; count: number }

const KIND_COLOR: Record<string, string> = {
  agent: 'var(--s1)', session: 'var(--s7)', process: 'var(--text-3)', command: 'var(--s2)', file: 'var(--s3)', directory: 'var(--s3)',
  tool: 'var(--s4)', mcp_server: 'var(--s5)', network_endpoint: 'var(--s6)', security_event: 'var(--sev-critical)',
};
const KIND_LABEL: Record<string, string> = {
  agent: 'Agent', session: 'Session', process: 'Process', command: 'Command', file: 'File', directory: 'Directory', tool: 'Tool',
  mcp_server: 'MCP server', network_endpoint: 'Network endpoint', security_event: 'Security event',
};

export function GraphPage({ route, from, nav }: PageProps) {
  const [kinds, setKinds] = useState<Set<string>>(new Set(Object.keys(KIND_COLOR).filter((k) => k !== 'process')));
  const [scope, setScope] = useState<'range' | 'hour'>('range');
  const q = { from: scope === 'hour' ? Date.now() - 3600_000 : from, session_id: route.params.session_id, agent_id: route.params.agent_id };
  const { data } = useQuery<{ nodes: GNode[]; edges: { source: string; target: string; kind: string; count: number }[] }>('graph', q);
  const [selected, setSelected] = useState<GNode | null>(null);

  const graph = useMemo(() => {
    if (!data) return null;
    const nodes = data.nodes.filter((n) => kinds.has(n.kind)).map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: GLink[] = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
    return { nodes, links };
  }, [data, kinds]);

  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        {Object.keys(KIND_COLOR).map((k) => (
          <button key={k} className="btn sm" aria-pressed={kinds.has(k)} style={{ opacity: kinds.has(k) ? 1 : 0.45 }}
            onClick={() => setKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
            <span className="swatch" style={{ background: KIND_COLOR[k], borderRadius: k === 'agent' ? 5 : 3 }} />{KIND_LABEL[k]}
          </button>
        ))}
        <div className="grow" />
        {(route.params.session_id || route.params.agent_id) && <button className="btn sm" onClick={() => nav('graph')}>Clear scope</button>}
        <Segmented label="Scope" value={scope} onChange={setScope} options={[{ id: 'range', label: 'Time range' }, { id: 'hour', label: 'Last hour' }]} />
      </div>
      <div className="card graph-wrap">
        {!graph ? <div className="muted" style={{ padding: 20 }}>Loading…</div> : graph.nodes.length === 0 ? <Empty title="Nothing to graph">No relationships in this scope.</Empty> : <ForceGraph nodes={graph.nodes} links={graph.links} onSelect={setSelected} selected={selected} />}
        {selected && (
          <div className="card graph-detail">
            <div className="card-h"><span className="swatch" style={{ background: KIND_COLOR[selected.kind] }} /><h3 className="ellipsis">{KIND_LABEL[selected.kind]}</h3><div className="right"><button className="btn ghost sm" onClick={() => setSelected(null)}>Close</button></div></div>
            <div className="card-b">
              <div className="mono" style={{ overflowWrap: 'anywhere', marginBottom: 8 }}>{selected.kind === 'agent' ? agentName(selected.label) : selected.id.replace(/^[a-z_]+:/, '')}</div>
              <dl className="kv" style={{ gridTemplateColumns: '90px 1fr' }}>
                <dt>Occurrences</dt><dd className="num">{selected.weight}</dd>
                <dt>Max risk</dt><dd className="num">{Math.round(selected.risk)}</dd>
                <dt>Connections</dt><dd className="num">{graph?.links.filter((l) => (l.source as GNode).id === selected.id || (l.target as GNode).id === selected.id).length}</dd>
              </dl>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {selected.kind === 'session' && <button className="btn sm" onClick={() => nav('sessions', { id: selected.id.slice(8) })}>Open session</button>}
                {selected.kind === 'session' && <button className="btn sm" onClick={() => nav('graph', { session_id: selected.id.slice(8) })}>Focus</button>}
                {selected.kind === 'agent' && <button className="btn sm" onClick={() => nav('graph', { agent_id: selected.id.slice(6) })}>Focus agent</button>}
                {selected.kind === 'command' && <button className="btn sm" onClick={() => nav('commands', { search: selected.id.slice(8) })}>Find commands</button>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ForceGraph({ nodes, links, onSelect, selected }: { nodes: GNode[]; links: GLink[]; onSelect: (n: GNode | null) => void; selected: GNode | null }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [, setTick] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const sim = useRef<ReturnType<typeof forceSimulation<GNode>> | null>(null);

  useEffect(() => {
    const { width, height } = svgRef.current!.getBoundingClientRect();
    const s = forceSimulation<GNode>(nodes)
      .force('link', forceLink<GNode, GLink>(links).id((d) => d.id).distance((l) => (l.kind === 'belongs_to' ? 60 : 38)).strength(0.6))
      .force('charge', forceManyBody().strength(-90))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<GNode>().radius((d) => radius(d) + 3))
      .alphaDecay(0.035)
      .on('tick', () => setTick((t) => t + 1));
    sim.current = s;
    return () => { s.stop(); };
  }, [nodes, links]);

  const neighbors = useMemo(() => {
    const focus = hover ?? selected?.id;
    if (!focus) return null;
    const set = new Set([focus]);
    for (const l of links) {
      const a = (l.source as GNode).id ?? l.source;
      const b = (l.target as GNode).id ?? l.target;
      if (a === focus) set.add(b as string);
      if (b === focus) set.add(a as string);
    }
    return set;
  }, [hover, selected, links, nodes.length]);

  // Pan (drag background), zoom (wheel), drag node (1:1 with pointer, reheats the simulation).
  const drag = useRef<{ node?: GNode; startX: number; startY: number; vx: number; vy: number; moved: boolean } | null>(null);
  const toGraph = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };

  return (
    <svg ref={svgRef} role="img" aria-label="Agent relationship graph"
      onWheel={(e) => {
        const r = svgRef.current!.getBoundingClientRect();
        const k = Math.min(4, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)));
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        setView({ k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k });
      }}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        const id = (e.target as Element).getAttribute('data-id');
        const node = id ? nodes.find((n) => n.id === id) : undefined;
        drag.current = { node, startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y, moved: false };
        if (node) { node.fx = node.x; node.fy = node.y; sim.current?.alphaTarget(0.25).restart(); }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 3) d.moved = true;
        if (d.node) { const p = toGraph(e.clientX, e.clientY); d.node.fx = p.x; d.node.fy = p.y; }
        else setView((v) => ({ ...v, x: d.vx + e.clientX - d.startX, y: d.vy + e.clientY - d.startY }));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.node) { d.node.fx = null; d.node.fy = null; sim.current?.alphaTarget(0); }
        if (d && !d.moved) onSelect(d.node ?? null);
      }}>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {links.map((l, i) => {
          const s = l.source as GNode, t = l.target as GNode;
          const dim = neighbors && !(neighbors.has(s.id) && neighbors.has(t.id));
          return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} style={{ stroke: l.kind === 'detected_by' ? 'var(--sev-critical)' : 'var(--axis)' }} strokeWidth={Math.min(3, 0.8 + Math.log2(l.count + 1) * 0.4) / view.k} opacity={dim ? 0.12 : 0.75} />;
        })}
        {nodes.map((n) => {
          const dim = neighbors && !neighbors.has(n.id);
          const r = radius(n);
          return (
            <g key={n.id} transform={`translate(${n.x ?? 0},${n.y ?? 0})`} opacity={dim ? 0.2 : 1} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)}>
              {n.risk >= 40 && <circle r={r + 4} style={{ fill: 'none', stroke: `var(--sev-${n.risk >= 85 ? 'critical' : n.risk >= 65 ? 'high' : 'medium'})` }} strokeWidth={2 / view.k} />}
              {n.kind === 'agent'
                ? <rect data-id={n.id} x={-r} y={-r} width={r * 2} height={r * 2} rx={5} style={{ fill: KIND_COLOR[n.kind], stroke: 'var(--surface)' }} strokeWidth={2 / view.k} />
                : <circle data-id={n.id} r={r} style={{ fill: KIND_COLOR[n.kind], stroke: selected?.id === n.id ? 'var(--text)' : 'var(--surface)' }} strokeWidth={(selected?.id === n.id ? 2.5 : 1.5) / view.k} />}
              {(n.kind === 'agent' || n.kind === 'mcp_server' || n.kind === 'security_event' || hover === n.id || selected?.id === n.id || view.k > 1.6) && (
                <text y={r + 12 / view.k} textAnchor="middle" fontSize={11 / view.k} style={{ fill: 'var(--text-2)', pointerEvents: 'none', paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 3 / view.k }}>
                  {n.kind === 'agent' ? agentName(n.label) : n.label.length > 32 ? `${n.label.slice(0, 30)}…` : n.label}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

const radius = (n: GNode) => (n.kind === 'agent' ? 13 : n.kind === 'session' ? 8 : Math.min(10, 4 + Math.log2(n.weight + 1)));
