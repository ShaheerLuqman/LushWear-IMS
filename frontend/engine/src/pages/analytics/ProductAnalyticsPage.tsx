// Product Analytics: per-product volume & revenue, size breakdown, Hero/Zero
// classification, trend/mix/size/insight widgets. Ported from product-analytics.js.
// Data: GET /products/analytics (aggregates the picked range + the equal-length
// window before it in one call) - this file only shapes filters, classifies, renders.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { create as createEasepick, DateTime } from '@easepick/bundle';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import {
  analyticsComparisonWord, analyticsIsoDate, analyticsN, analyticsPct, analyticsRangeDates, analyticsRangeLabel,
  analyticsShortDate, analyticsToday, ANALYTICS_TIME_PRESETS, type CustomRange,
} from '../../logic/analyticsShared';
import { AnalyticsDeltaBadge, AnalyticsDonut, AnalyticsLineChart, legendList } from '../../logic/analyticsCharts';

const PA_BASE_SIZES = ['S', 'M', 'L', 'XL'];
const PA_COLS_KEY = 'lushwear_pa_cols';

interface RawRow {
  key: string; name: string; collection: string; imageUrl: string; variantCount: number; stock: number;
  units: number; revenue: number; sizes: Record<string, number>; prevUnits: number; prevRevenue: number;
}
interface TrendPoint { phase: string; collection: string; bucket: string; units: number; revenue: number }
interface RawData {
  rows: RawRow[];
  ordersByColl: { current: Record<string, number>; previous: Record<string, number> };
  trend: TrendPoint[];
  hasPrev: boolean;
}
interface ViewRow extends RawRow { rank: number; perf: 'hero' | 'average' | 'zero' }

const PERF_META: Record<string, { label: string; icon: string }> = {
  hero: { label: 'Hero', icon: 'fa-trophy' },
  average: { label: 'Average', icon: 'fa-equals' },
  zero: { label: 'Zero', icon: 'fa-arrow-trend-down' },
};

function loadCols(): { revenue: boolean; delta: boolean; sizes: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(PA_COLS_KEY) || '{}');
    return { revenue: true, delta: true, sizes: true, ...saved };
  } catch { return { revenue: true, delta: true, sizes: true }; }
}

function classify(sortedRows: RawRow[]): Map<string, 'hero' | 'average' | 'zero'> {
  const sold = sortedRows.filter((r) => r.units > 0);
  const n = sold.length;
  const cls = new Map<string, 'hero' | 'average' | 'zero'>();
  if (!n) return cls;
  const u = sold.map((r) => r.units);
  const heroCut = u[Math.floor((n - 1) * 0.2)];
  const zeroCut = u[Math.ceil((n - 1) * 0.8)];
  const allEqual = u[0] === u[n - 1];
  for (const r of sortedRows) {
    if (r.units === 0) { cls.set(r.key, 'zero'); continue; }
    if (allEqual) { cls.set(r.key, 'average'); continue; }
    const isHero = r.units >= heroCut;
    const isZero = r.units <= zeroCut;
    cls.set(r.key, isHero && !isZero ? 'hero' : isZero && !isHero ? 'zero' : 'average');
  }
  return cls;
}

function deriveView(data: RawData | null, collection: string, search: string) {
  const d: RawData = data || { rows: [], ordersByColl: { current: {}, previous: {} }, trend: [], hasPrev: false };
  let rows = d.rows;
  if (collection) rows = rows.filter((r) => r.collection === collection);
  rows = [...rows].sort((a, b) => b.units - a.units || b.revenue - a.revenue || a.name.localeCompare(b.name));
  const cls = classify(rows);
  const rankedRows: ViewRow[] = rows.map((r, i) => ({ ...r, rank: i + 1, perf: cls.get(r.key) || 'average' }));

  const present = new Set<string>();
  for (const r of rankedRows) for (const s of Object.keys(r.sizes)) if (r.sizes[s] > 0) present.add(s);
  const sizes = [...PA_BASE_SIZES, ...[...present].filter((s) => !PA_BASE_SIZES.includes(s)).sort()];

  const collKey = collection || '__all__';
  const units = rankedRows.reduce((s, r) => s + r.units, 0);
  const revenue = rankedRows.reduce((s, r) => s + r.revenue, 0);
  const orders = d.ordersByColl.current?.[collKey] || 0;
  const totals = { units, revenue, orders, aov: orders ? revenue / orders : 0 };
  const prevUnits = rankedRows.reduce((s, r) => s + r.prevUnits, 0);
  const prevRevenue = rankedRows.reduce((s, r) => s + r.prevRevenue, 0);
  const prevOrders = d.ordersByColl.previous?.[collKey] || 0;
  const prevTotals = { units: prevUnits, revenue: prevRevenue, orders: prevOrders, aov: prevOrders ? prevRevenue / prevOrders : 0 };

  let segmentRows = rankedRows;
  if (search) {
    const q = search.toLowerCase();
    segmentRows = segmentRows.filter((r) => r.name.toLowerCase().includes(q) || r.collection.toLowerCase().includes(q));
  }
  return { rows: rankedRows, segmentRows, sizes, totals, prevTotals, hasPrev: d.hasPrev };
}

function trendSeries(data: RawData | null, phase: 'current' | 'previous', metric: 'units' | 'revenue', collection: string) {
  const m = new Map<string, number>();
  for (const t of data?.trend || []) {
    if (t.phase !== phase) continue;
    if (collection && t.collection !== collection) continue;
    m.set(t.bucket, (m.get(t.bucket) || 0) + (metric === 'revenue' ? Number(t.revenue) || 0 : Number(t.units) || 0));
  }
  const buckets = [...m.keys()].sort();
  return {
    values: buckets.map((b) => m.get(b) as number),
    first: buckets.length ? analyticsShortDate(new Date(`${buckets[0]}T00:00:00`)) : '',
    last: buckets.length ? analyticsShortDate(new Date(`${buckets[buckets.length - 1]}T00:00:00`)) : '',
  };
}

function productThumbInitial(name: string) {
  return (name || '?').replace(/[^a-z0-9]/i, '').slice(0, 1).toUpperCase() || '?';
}

function ProductThumb({ imageUrl, name }: { imageUrl: string | null | undefined; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!imageUrl || broken) return <span className="pa-thumb pa-thumb--fallback">{productThumbInitial(name)}</span>;
  return <img className="pa-thumb" src={imageUrl} alt="" loading="lazy" onError={() => setBroken(true)} />;
}

export function ProductAnalyticsPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [timeRange, setTimeRange] = useState('thisMonth');
  const [customRange, setCustomRange] = useState<CustomRange>({ start: '', end: '' });
  const [collection, setCollection] = useState('');
  const [search, setSearch] = useState('');
  const [trendMetric, setTrendMetric] = useState<'units' | 'revenue'>('units');
  const [cols, setCols] = useState(loadCols);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [heroDefOpen, setHeroDefOpen] = useState(false);
  const [data, setData] = useState<RawData | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const [kebabRow, setKebabRow] = useState<{ key: string; top: number; left: number } | null>(null);

  // A plain useRef+useEffect(() => {...}, []) would fire before the button exists:
  // this page's own effects run in the same commit as (and before) the setHeader
  // effect from usePageHeader() below, which is what actually mounts this button
  // into AppShell's header - so the ref would still be null. Tracking the node via
  // state instead lets the effect wait for it to really exist, whichever commit that is.
  const [timeBtnNode, setTimeBtnNode] = useState<HTMLButtonElement | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!timeBtnNode) return;
    const picker = new (createEasepick as any)({
      element: timeBtnNode as any,
      css: ['https://cdn.jsdelivr.net/npm/@easepick/bundle@1.2.1/dist/index.css'],
      zIndex: 9999,
      format: 'DD/MM/YYYY',
      grid: 1,
      calendars: 1,
      autoApply: true,
      plugins: ['RangePlugin', 'PresetPlugin'],
      PresetPlugin: {
        position: 'left',
        customPreset: Object.fromEntries(ANALYTICS_TIME_PRESETS.map((p) => {
          const [s, e] = analyticsRangeDates(p.key, { start: '', end: '' });
          return [p.label, [new DateTime(s), new DateTime(e)]];
        })),
      },
    });
    picker.on('select', (e: any) => {
      const { start, end } = e.detail;
      if (!start || !end) return;
      const from = start.format('YYYY-MM-DD');
      const to = end.format('YYYY-MM-DD');
      const matched = ANALYTICS_TIME_PRESETS.find((p) => {
        const [s, en] = analyticsRangeDates(p.key, { start: '', end: '' });
        return analyticsIsoDate(s) === from && analyticsIsoDate(en) === to;
      });
      if (matched) setTimeRange(matched.key);
      else { setTimeRange('custom'); setCustomRange({ start: from, end: to }); }
      setCustomizeOpen(false);
      setHeroDefOpen(false);
    });
    return () => picker.destroy();
  }, [timeBtnNode]);

  // Closes the Customize/Hero-Zero popovers on ANY outside click, including other header
  // controls (search, collection select, time-range button) - not just clicks inside the
  // results area below, since those popovers are rendered from the page header.
  useEffect(() => {
    if (!customizeOpen && !heroDefOpen) return;
    const onDocClick = () => { setCustomizeOpen(false); setHeroDefOpen(false); };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [customizeOpen, heroDefOpen]);

  const rangeLabel = analyticsRangeLabel(timeRange, customRange);
  const comparisonWord = analyticsComparisonWord(timeRange);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    (async () => {
      try {
        const [start, end] = analyticsRangeDates(timeRange, customRange);
        const res = await apiJson<any>(`/products/analytics?start=${analyticsIsoDate(start)}&end=${analyticsIsoDate(end)}`, { fallback: 'Failed to load analytics' });
        if (id !== reqId.current) return;
        setData({
          rows: (res.rows || []).map((r: any): RawRow => ({
            key: r.product_id || `name:${(r.name || '').toLowerCase()}`,
            name: r.name || '(unknown product)',
            collection: r.collection || 'Uncategorized',
            imageUrl: r.image_url || '',
            variantCount: r.variant_count || 0,
            stock: r.stock || 0,
            units: r.units || 0,
            revenue: Number(r.revenue) || 0,
            sizes: r.sizes || {},
            prevUnits: r.prev_units || 0,
            prevRevenue: Number(r.prev_revenue) || 0,
          })),
          ordersByColl: res.orders || { current: {}, previous: {} },
          trend: res.trend || [],
          hasPrev: !!res.has_prev,
        });
      } catch (error) {
        if (id !== reqId.current) return;
        console.error('Error loading product analytics:', error);
        showToast('Failed to load product analytics', 'error');
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange, customRange.start, customRange.end]);

  const view = useMemo(() => deriveView(data, collection, search), [data, collection, search]);

  const collectionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows || []) set.add(r.collection || 'Uncategorized');
    return [...set].sort((a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)));
  }, [data]);

  useEffect(() => {
    if (collection && !collectionOptions.includes(collection)) setCollection('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function onSearchChange(value: string) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(value.trim()), 200);
  }

  function toggleCol(key: 'revenue' | 'delta' | 'sizes', checked: boolean) {
    const next = { ...cols, [key]: checked };
    setCols(next);
    try { localStorage.setItem(PA_COLS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  function exportExcel() {
    if (!view.segmentRows.length) { showToast('Nothing to export', 'warning', { silent: true }); return; }
    const rows = view.segmentRows.map((r) => {
      const out: Record<string, unknown> = {
        Rank: r.rank, Product: r.name, Collection: r.collection,
        Performance: PERF_META[r.perf]?.label || r.perf,
        'Units Sold': r.units, 'Revenue (PKR)': Math.round(r.revenue),
        'Units (prev)': r.prevUnits, 'In Stock': r.stock,
      };
      for (const s of view.sizes) out[s] = r.sizes[s] || 0;
      return out;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Product Analytics');
    XLSX.writeFile(wb, `product-analytics-${analyticsIsoDate(analyticsToday())}.xlsx`);
  }

  const curTrend = trendSeries(data, 'current', trendMetric, collection);
  const prevTrend = view.hasPrev ? trendSeries(data, 'previous', trendMetric, collection) : { values: [] as number[], first: '', last: '' };

  const ranked = [...view.rows].filter((r) => r.units > 0).sort((a, b) => b.units - a.units);
  const top5 = ranked.slice(0, 5);
  const othersUnits = ranked.slice(5).reduce((s, r) => s + r.units, 0);
  const donutSlices = top5.map((r) => ({ name: r.name, value: r.units }));
  if (othersUnits) donutSlices.push({ name: 'Others', value: othersUnits });

  const bySize: Record<string, number> = {};
  for (const r of view.rows) for (const [s, q] of Object.entries(r.sizes)) bySize[s] = (bySize[s] || 0) + q;
  const sizeRows = view.sizes.filter((s) => bySize[s]);
  const topSizeEntry = Object.entries(bySize).sort((a, b) => b[1] - a[1])[0];

  const dropRow = [...view.rows].filter((r) => r.prevUnits > 0 && r.units < r.prevUnits)
    .sort((a, b) => a.units / a.prevUnits - b.units / b.prevUnits)[0];
  const insights: Array<{ icon: string; tint: string; title: string; desc: string }> = [];
  if (ranked[0]) insights.push({ icon: 'fa-arrow-trend-up', tint: 'hero', title: ranked[0].name, desc: `Your top seller — ${analyticsN(ranked[0].units)} units this period.` });
  if (dropRow && view.hasPrev) {
    const pct = ((dropRow.prevUnits - dropRow.units) / dropRow.prevUnits) * 100;
    insights.push({ icon: 'fa-arrow-trend-down', tint: 'zero', title: dropRow.name, desc: `Sales dropped ${pct.toFixed(1)}% ${comparisonWord}.` });
  }
  if (topSizeEntry) insights.push({ icon: 'fa-shirt', tint: 'info', title: `Size ${topSizeEntry[0]}`, desc: `Most preferred size (${analyticsPct(topSizeEntry[1], view.totals.units).toFixed(1)}%).` });

  const detailsRow = detailsKey ? view.rows.find((r) => r.key === detailsKey) || null : null;

  usePageHeader({
    title: 'Product Analytics',
    actions: (
      <>
        <div className="transaction-search-wrap">
          <i className="fa-solid fa-magnifying-glass transaction-search-icon" />
          <input className="transaction-search-filter" placeholder="Search products…" autoComplete="off" onChange={(e) => onSearchChange(e.target.value)} />
        </div>
        <div className="pa-time">
          <button type="button" ref={setTimeBtnNode} className="pa-time-btn">
            <i className="fa-regular fa-calendar" /><span>{rangeLabel}</span><i className="fa-solid fa-chevron-down" />
          </button>
        </div>
        <select className="orders-period-filter" title="Filter by collection" value={collection} onChange={(e) => setCollection(e.target.value)}>
          <option value="">All collections</option>
          {collectionOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="button" className="btn btn-secondary header-toolbar-btn" onClick={exportExcel}><i className="fa-solid fa-arrow-up-from-bracket" /> Export</button>
        <div className="pa-customize">
          <button type="button" className="btn btn-secondary header-toolbar-btn" onClick={(e) => { e.stopPropagation(); setCustomizeOpen((v) => !v); setHeroDefOpen(false); }}><i className="fa-solid fa-sliders" /> Customize</button>
          {customizeOpen && (
            <div className="pa-pop" onClick={(e) => e.stopPropagation()}>
              <span className="pa-pop-title">Columns</span>
              <label><input type="checkbox" checked={cols.revenue} onChange={(e) => toggleCol('revenue', e.target.checked)} /> Revenue</label>
              <label><input type="checkbox" checked={cols.delta} onChange={(e) => toggleCol('delta', e.target.checked)} /> vs Previous</label>
              <label><input type="checkbox" checked={cols.sizes} onChange={(e) => toggleCol('sizes', e.target.checked)} /> Variant sizes</label>
            </div>
          )}
        </div>
        <div className="pa-info">
          <button type="button" className="btn btn-secondary header-toolbar-btn header-toolbar-btn-icon-only" title="Performance definition" aria-label="Performance definition" onClick={(e) => { e.stopPropagation(); setHeroDefOpen((v) => !v); setCustomizeOpen(false); }}>
            <i className="fa-solid fa-circle-info" />
          </button>
          {heroDefOpen && (
            <div className="pa-pop pa-hero-def-pop" onClick={(e) => e.stopPropagation()}>
              Products are ranked by units sold within the current collection and range.
              <strong> Hero</strong> = the top ~20% (ties included); <strong>Zero</strong> = the bottom ~20%, including products with no sales; everything between is <strong>Average</strong>.
            </div>
          )}
        </div>
      </>
    ),
  });

  const showSizes = cols.sizes && view.sizes.length > 0;
  const colCount = 5 + (cols.revenue ? 1 : 0) + (cols.delta ? 1 : 0) + (showSizes ? view.sizes.length : 0);

  return (
    <div className="pa-scroll">
      <div className="pa-kpis">
        <KpiCard mod="units" icon="fa-box" label="Total Units Sold" value={analyticsN(view.totals.units)} cur={view.totals.units} prev={view.prevTotals.units} hasPrev={view.hasPrev} comparisonWord={comparisonWord} isMoney={false} />
        <KpiCard mod="revenue" icon="fa-sack-dollar" label="Total Revenue" value={`PKR ${analyticsN(view.totals.revenue)}`} cur={view.totals.revenue} prev={view.prevTotals.revenue} hasPrev={view.hasPrev} comparisonWord={comparisonWord} isMoney />
        <KpiCard mod="orders" icon="fa-receipt" label="Orders" value={analyticsN(view.totals.orders)} cur={view.totals.orders} prev={view.prevTotals.orders} hasPrev={view.hasPrev} comparisonWord={comparisonWord} isMoney={false} />
        <KpiCard mod="aov" icon="fa-tags" label="Avg. Order Value" value={`PKR ${analyticsN(view.totals.aov)}`} cur={view.totals.aov} prev={view.prevTotals.aov} hasPrev={view.hasPrev} comparisonWord={comparisonWord} isMoney />
      </div>

      <div className="pa-card">
        <div className="pa-table-wrap">
          <table className="pa-table">
            <thead>
              {showSizes && (
                <tr className="pa-thead-group">
                  <th /><th /><th />
                  {cols.revenue && <th />}{cols.delta && <th />}
                  <th className="pa-group-variants" colSpan={view.sizes.length}>Variants Sold (Units)</th>
                  <th /><th />
                </tr>
              )}
              <tr className="pa-thead-cols">
                <th className="pa-col-rank">#</th>
                <th className="pa-col-product">Product</th>
                <th className="pa-col-total">Total Sold<span>Units</span></th>
                {cols.revenue && <th className="pa-col-rev">Revenue<span>PKR</span></th>}
                {cols.delta && <th className="pa-col-delta">vs Previous<span>Units</span></th>}
                {showSizes && view.sizes.map((s) => <th className="pa-col-size" key={s}>{s}</th>)}
                <th className="pa-col-perf">Performance</th>
                <th className="pa-col-kebab" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={colCount} className="pa-empty">Crunching sales…</td></tr>
              ) : view.segmentRows.length === 0 ? (
                <tr><td colSpan={colCount} className="pa-empty">No products match these filters.</td></tr>
              ) : view.segmentRows.map((r) => (
                <tr key={r.key}>
                  <td className="pa-col-rank">{r.rank <= 3 ? <span className={`pa-medal pa-medal--${r.rank}`}>{r.rank}</span> : <span className="pa-rank">{r.rank}</span>}</td>
                  <td className="pa-col-product" onClick={() => setDetailsKey(r.key)} style={{ cursor: 'pointer' }}>
                    <div className="pa-product">
                      <ProductThumb imageUrl={r.imageUrl} name={r.name} />
                      <div className="pa-product-text">
                        <span className="pa-product-name">{r.name}</span>
                        <span className="pa-product-sub">{r.collection} · {analyticsN(r.variantCount)} variants · {analyticsN(r.stock)} in stock</span>
                      </div>
                    </div>
                  </td>
                  <td className="pa-col-total"><span className="pa-total-q">{analyticsN(r.units)}</span><span className="pa-total-sub">{Math.round(analyticsPct(r.units, view.totals.units))}% of shown</span></td>
                  {cols.revenue && <td className="pa-col-rev">PKR {analyticsN(r.revenue)}</td>}
                  {cols.delta && (
                    <td className="pa-col-delta">
                      <span className="pa-delta-prev">{analyticsN(r.prevUnits)}</span>
                      <AnalyticsDeltaBadge cur={r.units} prev={r.prevUnits} hasPrev={view.hasPrev} />
                    </td>
                  )}
                  {showSizes && view.sizes.map((s) => {
                    const q = r.sizes[s] || 0;
                    return (
                      <td className={q ? 'pa-col-size' : 'pa-col-size pa-size-empty'} key={s}>
                        {q ? <><span className="pa-size-q">{analyticsN(q)}</span><span className="pa-size-pct">{((q / r.units) * 100).toFixed(1)}%</span></> : '–'}
                      </td>
                    );
                  })}
                  <td className="pa-col-perf"><span className={`pa-badge pa-badge--${r.perf}`}><i className={`fa-solid ${PERF_META[r.perf].icon}`} />{PERF_META[r.perf].label}</span></td>
                  <td className="pa-col-kebab">
                    <button
                      type="button" className="pa-kebab" aria-label="Product actions"
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setKebabRow({ key: r.key, top: rect.bottom + 4, left: Math.max(8, rect.right - 170) });
                      }}
                    >
                      <i className="fa-solid fa-ellipsis-vertical" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pa-widgets">
        <section className="pa-widget pa-widget--trend">
          <div className="pa-widget-head">
            <h3>Sales Trend</h3>
            <select className="pa-mini-select" value={trendMetric} onChange={(e) => setTrendMetric(e.target.value as 'units' | 'revenue')} onClick={(e) => e.stopPropagation()}>
              <option value="units">Units</option>
              <option value="revenue">Revenue</option>
            </select>
          </div>
          <div className="pa-trend-legend">
            <span><i className="pa-swatch pa-swatch--cur" />This period</span>
            {prevTrend.values.length > 0 && <span><i className="pa-swatch pa-swatch--prev" />Previous period</span>}
          </div>
          <AnalyticsLineChart cur={curTrend.values} prev={prevTrend.values} metric={trendMetric} />
          <div className="pa-trend-axis"><span>{curTrend.first}</span><span>{curTrend.last}</span></div>
        </section>

        <section className="pa-widget">
          <div className="pa-widget-head"><h3>Top Products by Units</h3></div>
          <div className="pa-donut-wrap">
            <AnalyticsDonut slices={donutSlices} total={view.totals.units} metric="units" />
            <ul className="pa-legend-list">{donutSlices.length ? legendList(donutSlices, view.totals.units) : <li className="pa-muted">No sales</li>}</ul>
          </div>
        </section>

        <section className="pa-widget">
          <div className="pa-widget-head"><h3>Size Breakdown</h3></div>
          <table className="pa-size-table">
            <thead><tr><th>Size</th><th>Units</th><th>% of total</th></tr></thead>
            <tbody>
              {sizeRows.length === 0
                ? <tr><td colSpan={3} className="pa-muted">No sales</td></tr>
                : sizeRows.map((s) => <tr key={s}><td>{s}</td><td>{analyticsN(bySize[s])}</td><td>{analyticsPct(bySize[s], view.totals.units).toFixed(1)}%</td></tr>)}
            </tbody>
          </table>
        </section>

        <section className="pa-widget">
          <div className="pa-widget-head"><h3>Key Insights</h3></div>
          <ul className="pa-insight-list">
            {insights.length === 0
              ? <li className="pa-muted">Not enough data yet.</li>
              : insights.map((i, idx) => (
                <li key={idx}>
                  <span className={`pa-insight-ic pa-insight-ic--${i.tint}`}><i className={`fa-solid ${i.icon}`} /></span>
                  <div><strong>{i.title}</strong><span>{i.desc}</span></div>
                </li>
              ))}
          </ul>
        </section>
      </div>

      {kebabRow && createPortal(
        <KebabPop
          pos={kebabRow}
          onClose={() => setKebabRow(null)}
          onDetails={() => { setDetailsKey(kebabRow.key); setKebabRow(null); }}
          onOpenProducts={() => { setKebabRow(null); navigate('/products'); }}
        />,
        document.body,
      )}

      {detailsRow && (
        <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) setDetailsKey(null); }}>
          <div className="modal-content">
            <div className="modal-header">
              <h2>Product Details</h2>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => setDetailsKey(null)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="product-details-identity">
                <div className="product-details-thumb">
                  {detailsRow.imageUrl ? <img src={detailsRow.imageUrl} alt="" /> : <div className="grid-image-placeholder">No Img</div>}
                </div>
                <div className="product-details-identity-text">
                  <div className="product-details-name-row"><h3>{detailsRow.name}</h3></div>
                  <p className="product-details-sub">
                    {detailsRow.collection} · {analyticsN(detailsRow.variantCount)} variant{detailsRow.variantCount === 1 ? '' : 's'} · {analyticsN(detailsRow.stock)} in stock
                  </p>
                </div>
              </div>
              <div className="product-details-stock">
                <div className="product-details-stock-grid">
                  {([
                    ['Rank', `#${detailsRow.rank}`],
                    ['Performance', PERF_META[detailsRow.perf].label],
                    ['Units Sold', analyticsN(detailsRow.units)],
                    ['Revenue', `PKR ${analyticsN(detailsRow.revenue)}`],
                    [comparisonWord, view.hasPrev ? `${analyticsN(detailsRow.prevUnits)} units` : '—'],
                  ] as Array<[string, string]>).map(([label, value]) => (
                    <div className="product-details-stock-cell" key={label}>
                      <span className="product-details-stock-label">{label}</span>
                      <span className="product-details-stock-value">{value}</span>
                    </div>
                  ))}
                </div>
                {view.sizes.filter((s) => detailsRow.sizes[s]).length > 0 && (
                  <div className="product-details-stock-grid">
                    {view.sizes.filter((s) => detailsRow.sizes[s]).map((s) => (
                      <div className="product-details-stock-cell" key={s}>
                        <span className="product-details-stock-label">{s}</span>
                        <span className="product-details-stock-value">{analyticsN(detailsRow.sizes[s])}  ({((detailsRow.sizes[s] / detailsRow.units) * 100).toFixed(1)}%)</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="modal-pinned-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setDetailsKey(null)}>Close</button>
              <button type="button" className="btn btn-primary" onClick={() => { setDetailsKey(null); navigate('/products'); }}>Open in Products</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({
  mod, icon, label, value, cur, prev, hasPrev, comparisonWord, isMoney,
}: {
  mod: string; icon: string; label: string; value: string; cur: number; prev: number; hasPrev: boolean; comparisonWord: string; isMoney: boolean;
}) {
  return (
    <div className={`pa-kpi pa-kpi--${mod}`}>
      <div className="pa-kpi-top">
        <span className="pa-kpi-label">{label}</span>
        <span className="pa-kpi-icon"><i className={`fa-solid ${icon}`} /></span>
      </div>
      <span className="pa-kpi-value">{value}</span>
      <div className="pa-kpi-foot">
        <span className="pa-kpi-prev">{comparisonWord}: {hasPrev ? (isMoney ? `PKR ${analyticsN(prev)}` : analyticsN(prev)) : '—'}</span>
        <AnalyticsDeltaBadge cur={cur} prev={prev} hasPrev={hasPrev} />
      </div>
    </div>
  );
}

function KebabPop({ pos, onClose, onDetails, onOpenProducts }: { pos: { top: number; left: number }; onClose: () => void; onDetails: () => void; onOpenProducts: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="pa-pop pa-kebab-pop" style={{ position: 'fixed', top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={onDetails}>View details</button>
      <button type="button" onClick={onOpenProducts}>Open in Products</button>
    </div>
  );
}
