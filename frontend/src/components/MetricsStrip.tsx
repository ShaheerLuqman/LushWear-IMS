// Row of summary tiles above a page's main table (see Orders for the reference look).
export interface MetricTile { label: string; value: string; negative?: boolean }

export function MetricsStrip({ tiles, label }: { tiles: MetricTile[]; label: string }) {
  return (
    <div className="metrics-strip" role="group" aria-label={label}>
      {tiles.map((t) => (
        <div className="metric" key={t.label}>
          <span className="metric__label">{t.label}</span>
          <span className={'metric__value' + (t.negative ? ' metric__value--neg' : '')}>{t.value}</span>
        </div>
      ))}
    </div>
  );
}
