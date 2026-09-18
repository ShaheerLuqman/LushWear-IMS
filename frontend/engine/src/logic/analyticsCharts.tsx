// Small inline SVG charts shared by Product Analytics and City Analytics -
// ported 1:1 (same pixel math) from product-analytics.js's paLineChart/paDonut.
import { analyticsN, analyticsPct } from './analyticsShared';

export function AnalyticsLineChart({ cur, prev, metric }: { cur: number[]; prev: number[]; metric: 'units' | 'revenue' }) {
  const w = 560, h = 190, padX = 8, padTop = 12, padBot = 22;
  const max = Math.max(1, ...cur, ...prev);
  const n = Math.max(cur.length, 1);
  const x = (i: number) => padX + (n === 1 ? 0 : (i / (n - 1)) * (w - padX * 2));
  const y = (v: number) => h - padBot - (v / max) * (h - padTop - padBot);
  const line = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = cur.length ? `${line(cur)} L${x(cur.length - 1).toFixed(1)},${(h - padBot).toFixed(1)} L${x(0).toFixed(1)},${(h - padBot).toFixed(1)} Z` : '';
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => (h - padBot - f * (h - padTop - padBot)));
  const fmtMax = metric === 'revenue' ? `PKR ${analyticsN(max)}` : analyticsN(max);

  return (
    <svg className="pa-linechart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Sales trend">
      {gridLines.map((gy, i) => <line key={i} x1={padX} x2={w - padX} y1={gy} y2={gy} className="pa-chart-grid" />)}
      {prev.length > 0 && <path d={line(prev)} className="pa-chart-prev" />}
      {area && <path d={area} className="pa-chart-area" />}
      {cur.length > 0 && <path d={line(cur)} className="pa-chart-cur" />}
      {cur.length > 0 && <circle cx={x(cur.length - 1)} cy={y(cur[cur.length - 1])} r={3.5} className="pa-chart-dot" />}
      <text x={padX} y={10} className="pa-chart-axis">{fmtMax}</text>
    </svg>
  );
}

const DONUT_PALETTE = ['var(--accent-primary)', 'var(--accent-secondary)', '#a78bfa', '#c4b5fd', 'var(--text-muted)'];

export function AnalyticsDonut({ slices, total, metric }: { slices: Array<{ name: string; value: number }>; total: number; metric: string }) {
  const r = 52, c = 2 * Math.PI * r, cx = 64, cy = 64;
  let offset = 0;
  const segs = slices.map((s, i) => {
    const frac = total ? s.value / total : 0;
    const seg = (
      <circle
        key={i} cx={cx} cy={cy} r={r} fill="none" stroke={DONUT_PALETTE[i] || 'var(--text-muted)'}
        strokeWidth={16} strokeDasharray={`${(frac * c).toFixed(2)} ${c.toFixed(2)}`}
        strokeDashoffset={(-offset * c).toFixed(2)} transform={`rotate(-90 ${cx} ${cy})`}
      />
    );
    offset += frac;
    return seg;
  });
  return (
    <svg className="pa-donut" viewBox="0 0 128 128" role="img" aria-label={`Top products by ${metric}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-color)" strokeWidth={16} />
      {segs}
      <text x={64} y={60} className="pa-donut-total">{analyticsN(total)}</text>
      <text x={64} y={76} className="pa-donut-label">Total {metric === 'revenue' ? 'PKR' : 'units'}</text>
    </svg>
  );
}

export function AnalyticsDeltaBadge({ cur, prev, hasPrev }: { cur: number; prev: number; hasPrev: boolean }) {
  if (!hasPrev || (prev === 0 && cur === 0)) return <span className="pa-delta pa-delta--flat">—</span>;
  if (prev === 0) return <span className="pa-delta pa-delta--up"><i className="fa-solid fa-arrow-up" />new</span>;
  const pct = ((cur - prev) / prev) * 100;
  const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  const icon = dir === 'up' ? 'fa-arrow-up' : dir === 'down' ? 'fa-arrow-down' : 'fa-minus';
  return <span className={`pa-delta pa-delta--${dir}`}><i className={`fa-solid ${icon}`} />{Math.abs(pct).toFixed(1)}%</span>;
}

export function legendList(slices: Array<{ name: string; value: number }>, total: number) {
  return slices.map((s, i) => (
    <li key={i}>
      <span className={`pa-legend-dot pa-legend-dot--${i}`} />
      <span className="pa-legend-name">{s.name}</span>
      <span className="pa-legend-val">{Math.round(analyticsPct(s.value, total))}% ({analyticsN(s.value)})</span>
    </li>
  ));
}
