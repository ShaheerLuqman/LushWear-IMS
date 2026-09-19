import { Badge } from '@shopify/polaris';
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from '@shopify/polaris-icons';
// Small inline SVG charts shared by Product Analytics and City Analytics -
// ported 1:1 (same pixel math) from product-analytics.js's paLineChart/paDonut.
import { analyticsCompactN, analyticsN, analyticsPct } from './analyticsShared';

function fmtVal(v: number, metric: 'units' | 'revenue') {
  return metric === 'revenue' ? `PKR ${analyticsN(v)}` : analyticsN(v);
}

export function AnalyticsLineChart({ cur, prev, metric, curDates, prevDates }: {
  cur: number[]; prev: number[]; metric: 'units' | 'revenue'; curDates?: string[]; prevDates?: string[];
}) {
  const w = 560, h = 190, padX = 8, padTop = 12, padBot = 22;
  const max = Math.max(1, ...cur, ...prev);
  const n = Math.max(cur.length, 1);
  const x = (i: number) => padX + (n === 1 ? 0 : (i / (n - 1)) * (w - padX * 2));
  const y = (v: number) => h - padBot - (v / max) * (h - padTop - padBot);
  const line = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = cur.length ? `${line(cur)} L${x(cur.length - 1).toFixed(1)},${(h - padBot).toFixed(1)} L${x(0).toFixed(1)},${(h - padBot).toFixed(1)} Z` : '';
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => (h - padBot - f * (h - padTop - padBot)));

  return (
    <svg className="pa-linechart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Sales trend">
      {gridLines.map((gy, i) => <line key={i} x1={padX} x2={w - padX} y1={gy} y2={gy} className="pa-chart-grid" />)}
      {prev.length > 0 && <path d={line(prev)} className="pa-chart-prev" />}
      {area && <path d={area} className="pa-chart-area" />}
      {cur.length > 0 && <path d={line(cur)} className="pa-chart-cur" />}
      {prev.map((v, i) => (
        <circle key={`p${i}`} cx={x(i)} cy={y(v)} r={7} className="pa-chart-hit">
          <title>{`${prevDates?.[i] || ''}: ${fmtVal(v, metric)}`}</title>
        </circle>
      ))}
      {cur.map((v, i) => (
        <circle key={`c${i}`} cx={x(i)} cy={y(v)} r={i === cur.length - 1 ? 4 : 7} className={i === cur.length - 1 ? 'pa-chart-dot' : 'pa-chart-hit'}>
          <title>{`${curDates?.[i] || ''}: ${fmtVal(v, metric)}`}</title>
        </circle>
      ))}
      <text x={padX} y={10} className="pa-chart-axis">{fmtVal(max, metric)}</text>
      <text x={padX} y={h - padBot - 2} className="pa-chart-axis">0</text>
    </svg>
  );
}

const DONUT_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', 'var(--text-muted)'];

export function AnalyticsDonut({ slices, total, metric }: { slices: Array<{ name: string; value: number }>; total: number; metric: string }) {
  const r = 52, c = 2 * Math.PI * r, cx = 64, cy = 64;
  const gap = 2.5;
  let offset = 0;
  const segs = slices.map((s, i) => {
    const frac = total ? s.value / total : 0;
    const len = Math.max(0, frac * c - gap);
    const seg = (
      <circle
        key={i} cx={cx} cy={cy} r={r} fill="none" stroke={DONUT_PALETTE[i] || 'var(--text-muted)'}
        strokeWidth={16} strokeLinecap="round" strokeDasharray={`${len.toFixed(2)} ${c.toFixed(2)}`}
        strokeDashoffset={(-offset * c).toFixed(2)} transform={`rotate(-90 ${cx} ${cy})`}
      >
        <title>{`${s.name}: ${Math.round(analyticsPct(s.value, total))}% (${analyticsN(s.value)})`}</title>
      </circle>
    );
    offset += frac;
    return seg;
  });
  return (
    <svg className="pa-donut" viewBox="0 0 128 128" role="img" aria-label={`Top products by ${metric}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-color)" strokeWidth={16} />
      {segs}
      <text x={64} y={60} className="pa-donut-total">{analyticsCompactN(total)}<title>{analyticsN(total)}</title></text>
      <text x={64} y={76} className="pa-donut-label">Total {metric === 'revenue' ? 'PKR' : 'units'}</text>
    </svg>
  );
}

export function AnalyticsDeltaBadge({ cur, prev, hasPrev }: { cur: number; prev: number; hasPrev: boolean }) {
  if (!hasPrev || (prev === 0 && cur === 0)) return <Badge>—</Badge>;
  if (prev === 0) return <Badge tone="success" icon={ArrowUpIcon}>new</Badge>;
  const pct = ((cur - prev) / prev) * 100;
  const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  return (
    <Badge tone={dir === 'up' ? 'success' : dir === 'down' ? 'critical' : undefined} icon={dir === 'up' ? ArrowUpIcon : dir === 'down' ? ArrowDownIcon : MinusIcon}>
      {`${Math.abs(pct).toFixed(1)}%`}
    </Badge>
  );
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
