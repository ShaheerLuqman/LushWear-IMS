// Row of summary tiles above a page's main table (see Orders for the reference look).
import type { ReactNode } from 'react';

export interface MetricTile { label: string; value: string; negative?: boolean; detail?: ReactNode }

export function MetricsStrip({ tiles, label, wrap }: { tiles: MetricTile[]; label: string; wrap?: boolean }) {
  return (
    <div className={'metrics-strip' + (wrap ? ' metrics-strip--wrap' : '')} role="group" aria-label={label}>
      {tiles.map((t) => (
        <div className="metric" key={t.label}>
          <span className="metric__label">{t.label}</span>
          <span className={'metric__value' + (t.negative ? ' metric__value--neg' : '')}>{t.value}</span>
          {t.detail && <span className="metric__detail">{t.detail}</span>}
        </div>
      ))}
    </div>
  );
}
