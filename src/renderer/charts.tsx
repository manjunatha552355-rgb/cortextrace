import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtNum } from './lib.ts';

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 0) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

export interface SeriesPoint { bucket: number; series: string | number; n: number }

/**
 * Stacked column time series. One y-axis, recessive grid, 2px surface gap between stacked segments,
 * per-bucket hover tooltip, legend toggles series (colors follow the entity, never rank).
 */
export function StackedColumns({ data, from, to, bucketMs, height = 190, color, label = (s) => String(s), onBucketClick, order }: {
  data: SeriesPoint[]; from: number; to: number; bucketMs: number; height?: number; color: (s: string) => string;
  label?: (s: string) => string; onBucketClick?: (bucket: number) => void; order?: string[];
}) {
  const [ref, width] = useWidth();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of data) totals.set(String(d.series), (totals.get(String(d.series)) ?? 0) + d.n);
    const keys = [...totals.keys()];
    return order ? [...order.filter((o) => totals.has(o)), ...keys.filter((k) => !order.includes(k))] : keys.sort((a, b) => totals.get(b)! - totals.get(a)!);
  }, [data, order]);
  const start = Math.floor(from / bucketMs) * bucketMs;
  const buckets = Math.max(1, Math.ceil((to - start) / bucketMs));
  const byBucket = useMemo(() => {
    const m = new Map<number, Map<string, number>>();
    for (const d of data) {
      if (hidden.has(String(d.series))) continue;
      let b = m.get(d.bucket);
      if (!b) m.set(d.bucket, (b = new Map()));
      b.set(String(d.series), (b.get(String(d.series)) ?? 0) + d.n);
    }
    return m;
  }, [data, hidden]);
  const maxY = niceMax(Math.max(0, ...[...byBucket.values()].map((b) => [...b.values()].reduce((a, c) => a + c, 0))));
  const padL = 34, padB = 20, padT = 6;
  const plotW = Math.max(10, width - padL);
  const plotH = height - padB - padT;
  const colW = plotW / buckets;
  const barW = Math.max(1, Math.min(28, colW - 2));
  const y = (v: number) => padT + plotH - (v / maxY) * plotH;
  const tickEvery = Math.max(1, Math.ceil(buckets / Math.max(2, Math.floor(plotW / 90))));
  const fmtTick = (t: number) => bucketMs >= 86400_000 ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const hoverData = hover != null ? byBucket.get(start + hover * bucketMs) : undefined;

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="Activity over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left - padL;
          const i = Math.floor(x / colW);
          setHover(i >= 0 && i < buckets ? i : null);
        }}
        onClick={() => { if (hover != null && onBucketClick) onBucketClick(start + hover * bucketMs); }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="gridline" x1={padL} x2={width} y1={y(maxY * f)} y2={y(maxY * f)} />
            <text className="axis-label" x={padL - 6} y={y(maxY * f) + 3} textAnchor="end">{fmtNum(maxY * f)}</text>
          </g>
        ))}
        {hover != null && <rect x={padL + hover * colW} y={padT} width={colW} height={plotH} style={{ fill: 'var(--surface-hover)' }} />}
        {Array.from({ length: buckets }, (_, i) => {
          const b = byBucket.get(start + i * bucketMs);
          if (!b) return null;
          let acc = 0;
          const x = padL + i * colW + (colW - barW) / 2;
          const visible = series.filter((s) => b.get(s));
          return (
            <g key={i}>
              {visible.map((s, j) => {
                const v = b.get(s)!;
                const y1 = y(acc + v);
                const h = Math.max(1, y(acc) - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between segments
                acc += v;
                const top = j === visible.length - 1;
                return <path key={s} style={{ fill: color(s) }} d={roundedTop(x, y1, barW, h, top ? Math.min(3, barW / 2) : 0)} />;
              })}
            </g>
          );
        })}
        <line x1={padL} x2={width} y1={padT + plotH} y2={padT + plotH} style={{ stroke: 'var(--axis)' }} />
        {Array.from({ length: buckets }, (_, i) => i % tickEvery === 0 && (
          <text key={i} className="axis-label" x={padL + i * colW + colW / 2} y={height - 5} textAnchor="middle">{fmtTick(start + i * bucketMs)}</text>
        ))}
      </svg>
      {hover != null && hoverData && (
        <div className="tooltip" style={{ left: Math.min(width - 170, padL + hover * colW + colW + 8), top: 4 }}>
          <div className="t-title">{new Date(start + hover * bucketMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          {series.filter((s) => hoverData.get(s)).map((s) => (
            <div key={s} className="t-row"><span className="swatch" style={{ background: color(s) }} />{label(s)}<span className="v">{hoverData.get(s)!.toLocaleString()}</span></div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <button key={s} aria-pressed={!hidden.has(s)} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; })}>
              <span className="swatch" style={{ background: color(s) }} />{label(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  if (r <= 0 || h < r) return `M${x},${y}h${w}v${h}h${-w}z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}z`;
}

export function BarList({ items, onClick, render, color }: { items: { key: string; n: number; extra?: ReactNode }[]; onClick?: (key: string) => void; render?: (key: string) => ReactNode; color?: (key: string) => string }) {
  if (!items.length) return <div className="muted" style={{ padding: '8px 8px' }}>No data in range</div>;
  const max = Math.max(...items.map((i) => i.n));
  return (
    <div className="barlist">
      {items.map((it) => {
        const inner = (
          <>
            <span className="fill" style={{ width: `${(it.n / max) * 100}%`, background: color ? `color-mix(in srgb, ${color(it.key)} 18%, transparent)` : undefined }} />
            <span className="ellipsis mono" style={{ minWidth: 0, fontSize: 12 }} title={it.key}>{render ? render(it.key) : it.key}</span>
            {it.extra && <span>{it.extra}</span>}
            <span className="v">{it.n.toLocaleString()}</span>
          </>
        );
        return onClick ? <button key={it.key} className="barlist-row" onClick={() => onClick(it.key)}>{inner}</button> : <div key={it.key} className="barlist-row">{inner}</div>;
      })}
    </div>
  );
}

/** Sequential single-hue heatmap (light → dark = more activity). */
export function Heatmap({ cells, rows, cols, rowLabel, colLabel, valueLabel = 'events' }: {
  cells: Map<string, number>; rows: number; cols: number; rowLabel: (r: number) => string; colLabel: (c: number) => string; valueLabel?: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const max = Math.max(1, ...cells.values());
  const padL = 34, padT = 16;
  const cw = Math.max(6, (width - padL) / cols);
  const ch = 18;
  const steps = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={padT + rows * ch + 4} role="img" aria-label="Activity heatmap" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: cols }, (_, c) => c % 3 === 0 && <text key={c} className="axis-label" x={padL + c * cw + cw / 2} y={11} textAnchor="middle">{colLabel(c)}</text>)}
        {Array.from({ length: rows }, (_, r) => (
          <g key={r}>
            <text className="axis-label" x={padL - 6} y={padT + r * ch + 12} textAnchor="end">{rowLabel(r)}</text>
            {Array.from({ length: cols }, (_, c) => {
              const v = cells.get(`${r}:${c}`) ?? 0;
              const fill = v === 0 ? 'var(--surface-2)' : steps[Math.min(steps.length - 1, Math.floor((v / max) * (steps.length - 1)))];
              return <rect key={c} x={padL + c * cw + 1} y={padT + r * ch + 1} width={cw - 2} height={ch - 2} rx={3} style={{ fill }}
                onMouseEnter={() => setHover({ r, c, x: padL + c * cw, y: padT + r * ch })} />;
            })}
          </g>
        ))}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: Math.min(width - 160, hover.x + cw + 6), top: hover.y - 6 }}>
          <div className="t-title">{rowLabel(hover.r)} {colLabel(hover.c)}:00</div>
          <div className="t-row">{valueLabel}<span className="v">{(cells.get(`${hover.r}:${hover.c}`) ?? 0).toLocaleString()}</span></div>
        </div>
      )}
    </div>
  );
}

export function Histogram({ values, bins = 12, height = 150, fmt = String, color = 'var(--s1)' }: { values: number[]; bins?: number; height?: number; fmt?: (v: number) => string; color?: string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  if (!values.length) return <div className="muted">No data in range</div>;
  // log-spaced bins: durations span ms to hours
  const lo = Math.max(1, Math.min(...values));
  const hi = Math.max(lo * 2, Math.max(...values));
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo * (hi / lo) ** (i / bins));
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.max(0, edges.findIndex((e) => v < e) - 1))]++;
  const maxY = niceMax(Math.max(...counts));
  const padL = 30, padB = 20;
  const colW = (width - padL) / bins;
  const plotH = height - padB - 4;
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="Distribution" onMouseLeave={() => setHover(null)}>
        <line className="gridline" x1={padL} x2={width} y1={4} y2={4} />
        <text className="axis-label" x={padL - 5} y={8} textAnchor="end">{maxY}</text>
        {counts.map((c, i) => {
          const h = (c / maxY) * plotH;
          return <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={padL + i * colW} y={4} width={colW} height={plotH} fill="transparent" />
            {c > 0 && <path d={roundedTop(padL + i * colW + 1, 4 + plotH - h, colW - 2, h, 3)} style={{ fill: color }} opacity={hover == null || hover === i ? 1 : 0.55} />}
          </g>;
        })}
        <line x1={padL} x2={width} y1={4 + plotH} y2={4 + plotH} style={{ stroke: 'var(--axis)' }} />
        {[0, Math.floor(bins / 2), bins].map((i) => <text key={i} className="axis-label" x={padL + i * colW} y={height - 5} textAnchor={i === 0 ? 'start' : i === bins ? 'end' : 'middle'}>{fmt(edges[i]!)}</text>)}
      </svg>
      {hover != null && (
        <div className="tooltip" style={{ left: Math.min(width - 160, padL + hover * colW + colW), top: 0 }}>
          <div className="t-title">{fmt(edges[hover]!)} – {fmt(edges[hover + 1]!)}</div>
          <div className="t-row">sessions<span className="v">{counts[hover]}</span></div>
        </div>
      )}
    </div>
  );
}
