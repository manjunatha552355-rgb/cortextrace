import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { Severity } from '../core/schema.ts';
import { TYPE_LABEL, fmtDateTime, fmtDuration, riskLevel, agentName, seriesColor, type EventRow } from './lib.ts';

export function Card({ title, sub, right, children, className = '', flush }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="card-h">
          {title && <h3>{title}</h3>}
          {sub && <span className="sub">{sub}</span>}
          {right && <div className="right">{right}</div>}
        </div>
      )}
      <div className={`card-b ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, onClick, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; onClick?: () => void; tone?: Severity }) {
  const body = (
    <>
      <div className="label">{tone && <span className={`swatch`} style={{ background: `var(--sev-${tone.toLowerCase()})` }} />}{label}</div>
      <div className="value num">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </>
  );
  return onClick ? <button className="stat" onClick={onClick}>{body}</button> : <div className="stat">{body}</div>;
}

export const SevBadge = ({ s }: { s: Severity }) => <span className={`badge sev sev-${s}`}>{s}</span>;

export function RiskMeter({ score, width }: { score: number; width?: number }) {
  const level = riskLevel(score);
  const color = level === 'INFO' ? 'var(--axis)' : `var(--sev-${level.toLowerCase()})`;
  return (
    <span className="risk-meter" style={{ width }} title={`Risk ${Math.round(score)} / 100 (${level})`}>
      <span className="track"><span className="bar" style={{ width: `${Math.max(2, score)}%`, background: color }} /></span>
      <span className="num dim" style={{ minWidth: 22, textAlign: 'right' }}>{Math.round(score)}</span>
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => <button key={o.id} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="search">
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      <input className="input" value={value} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h4>{title}</h4>{children}</div>;
}

export function AgentChip({ type }: { type: string }) {
  return <span className="chip"><span className="swatch" style={{ background: seriesColor(type) }} />{agentName(type)}</span>;
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'}>
        <div className="drawer-h"><h2>{title}</h2><div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{actions}<button className="btn ghost sm" onClick={onClose} aria-label="Close">Close</button></div></div>
        <div className="drawer-b">{children}</div>
      </aside>
    </>
  );
}

/** Virtualised fixed-height list; renders only visible rows so 100k-row streams stay smooth. */
export function VirtualList<T>({ items, rowHeight = 34, height, columns, header, row, onSelect, selectedKey, getKey }: {
  items: T[]; rowHeight?: number; height: number | string; columns: string; header: ReactNode; row: (item: T) => ReactNode;
  onSelect?: (item: T) => void; selectedKey?: string | null; getKey: (item: T) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 8);
  const end = Math.min(items.length, Math.ceil((scroll + viewH) / rowHeight) + 8);
  const style: CSSProperties = { gridTemplateColumns: columns };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height, minHeight: 0 }}>
      <div className="vhead" style={style}>{header}</div>
      <div className="vlist" ref={ref} style={{ flex: 1 }} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} role="listbox" aria-label="rows">
        <div style={{ height: items.length * rowHeight }} />
        {items.slice(start, end).map((it, i) => {
          const key = getKey(it);
          return (
            <div key={key} className="vrow" role="option" aria-selected={selectedKey === key} tabIndex={-1}
              style={{ ...style, top: (start + i) * rowHeight, height: rowHeight }} onClick={() => onSelect?.(it)}>
              {row(it)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EventInspector({ event, onClose, onOpenSession, onFilterCorrelation }: { event: EventRow; onClose: () => void; onOpenSession?: (id: string) => void; onFilterCorrelation?: (id: string) => void }) {
  return (
    <Drawer title={TYPE_LABEL[event.event_type] ?? event.event_type} onClose={onClose}
      actions={<button className="btn sm" onClick={() => void navigator.clipboard.writeText(JSON.stringify(event, null, 2))}>Copy JSON</button>}>
      <dl className="kv">
        <dt>Summary</dt><dd className="mono">{event.summary ?? '—'}</dd>
        <dt>Time</dt><dd>{fmtDateTime(event.timestamp)} <span className="muted num">({event.timestamp})</span></dd>
        <dt>Severity</dt><dd><SevBadge s={event.severity} /> <span className="muted">risk {Math.round(event.risk_score)}</span></dd>
        <dt>Agent</dt><dd><AgentChip type={event.agent_type} /> {event.agent_version && <span className="muted">v{event.agent_version}</span>}</dd>
        <dt>Session</dt><dd>{event.session_id ? <button className="btn sm" onClick={() => onOpenSession?.(event.session_id!)}>{event.session_id}</button> : '—'}</dd>
        <dt>Source / fidelity</dt><dd>{event.source} · {event.fidelity === 'inferred' ? <span title="Attributed by correlation, not reported by the runtime">inferred</span> : 'observed'}</dd>
        <dt>Process</dt><dd className="num">{event.process_id ?? '—'}{event.parent_process_id ? ` ← ${event.parent_process_id}` : ''}</dd>
        <dt>Workspace</dt><dd className="mono">{event.workspace ?? '—'}</dd>
        <dt>Duration</dt><dd>{fmtDuration(event.duration_ms)}</dd>
        <dt>Correlation</dt><dd>{event.correlation_id ? <button className="btn sm" onClick={() => onFilterCorrelation?.(event.correlation_id!)}>{event.correlation_id}</button> : '—'}</dd>
        <dt>Trace / span</dt><dd className="mono">{event.trace_id ?? '—'} {event.span_id ? `/ ${event.span_id}` : ''}{event.parent_span_id ? ` ← ${event.parent_span_id}` : ''}</dd>
        <dt>Labels</dt><dd style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{event.security_labels.length ? event.security_labels.map((l) => <span key={l} className="badge">{l}</span>) : '—'}</dd>
        <dt>Event id</dt><dd className="mono">{event.event_id} <span className="muted">schema v{event.event_version}</span></dd>
      </dl>
      <div className="section-title">Payload (redacted)</div>
      <pre className="json">{JSON.stringify(event.payload, null, 2)}</pre>
    </Drawer>
  );
}

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  const p: Record<string, ReactNode> = {
    overview: <><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></>,
    live: <><circle cx="8" cy="8" r="2" /><path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7" /></>,
    agents: <><circle cx="8" cy="6" r="2.6" /><path d="M3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></>,
    sessions: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 6.5h12" /></>,
    threats: <><path d="M8 1.8 13.5 4v4c0 3.2-2.3 5.4-5.5 6.2C4.8 13.4 2.5 11.2 2.5 8V4z" /><path d="M8 5.5v3M8 10.6v.1" /></>,
    timeline: <><path d="M3 2v12M3 4h7M3 8h10M3 12h5" /></>,
    graph: <><circle cx="4" cy="4" r="1.8" /><circle cx="12" cy="5" r="1.8" /><circle cx="7" cy="12" r="1.8" /><path d="M5.6 4.3 10.2 4.8M4.8 5.6 6.3 10.3M11 6.6 8 10.6" /></>,
    processes: <><path d="M3 3h4v4H3zM9 9h4v4H9zM5 7v4h4" /></>,
    tools: <><path d="M10.5 2.5a3 3 0 0 0-3.8 3.8L2.5 10.5l3 3 4.2-4.2a3 3 0 0 0 3.8-3.8l-1.8 1.8-2-.2-.2-2z" /></>,
    commands: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="m4.8 6.3 2 1.7-2 1.7M8.5 10h3" /></>,
    files: <><path d="M4 1.8h5l3 3v9.4H4z" /><path d="M9 1.8v3h3" /></>,
    network: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></>,
    mcp: <><path d="M5 2v4M11 2v4M3.5 6h9v2a4.5 4.5 0 0 1-9 0zM8 12.5V15" /></>,
    policies: <><path d="M3 2.5h10v11H3z" /><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" /></>,
    analytics: <><path d="M2.5 13.5h11M4.5 11V7M8 11V3.5M11.5 11V8" /></>,
    health: <><path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4" /></>,
    settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p[name]}</svg>;
}

export const Logo = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
    <rect x="64" y="64" width="896" height="896" rx="200" fill="#18181c" />
    <path d="M 724 330 A 270 270 0 1 0 724 694" fill="none" stroke="#3987e5" strokeWidth="72" strokeLinecap="round" />
    <circle cx="724" cy="694" r="62" fill="#f4f4f2" />
    <circle cx="525" cy="512" r="74" fill="#3987e5" />
  </svg>
);
