// City Analytics: per-city volume & revenue, city-wise sales ranking, and a
// product-by-city breakdown table. Ported from city-analytics.js. Same basis and
// product resolution as Product Analytics so the two screens never disagree on a
// line's product - data comes from GET /products/analytics-by-city.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { create as createEasepick, DateTime } from '@easepick/bundle';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import {
  analyticsIsoDate, analyticsN, analyticsPct, analyticsRangeDates, analyticsRangeLabel, analyticsToday,
  ANALYTICS_TIME_PRESETS, type CustomRange,
} from '../../logic/analyticsShared';
import { AnalyticsDonut, legendList } from '../../logic/analyticsCharts';

const CA_MAX_CITIES = 8;

interface CityRow { city: string; units: number; revenue: number; orders: number; products: number; prevUnits: number; prevRevenue: number }
interface CityProductRow { city: string; productId: string | null; name: string; collection: string; units: number; revenue: number }
interface RawData { cities: CityRow[]; cityProducts: CityProductRow[]; hasPrev: boolean }

function deriveView(data: RawData | null, collection: string, search: string) {
  const d: RawData = data || { cities: [], cityProducts: [], hasPrev: false };
  let cityProducts = d.cityProducts;
  if (collection) cityProducts = cityProducts.filter((r) => r.collection === collection);
  if (search) {
    const q = search.toLowerCase();
    cityProducts = cityProducts.filter((r) => r.name.toLowerCase().includes(q));
  }

  const cityAgg = new Map<string, { city: string; units: number; revenue: number }>();
  for (const r of cityProducts) {
    const b = cityAgg.get(r.city) || { city: r.city, units: 0, revenue: 0 };
    b.units += r.units;
    b.revenue += r.revenue;
    cityAgg.set(r.city, b);
  }
  const cityMeta = new Map(d.cities.map((c) => [c.city, c]));
  const cities = [...cityAgg.values()]
    .map((c) => ({ ...c, orders: cityMeta.get(c.city)?.orders || 0 }))
    .sort((a, b) => b.revenue - a.revenue || b.units - a.units);

  const totals = {
    revenue: cities.reduce((s, c) => s + c.revenue, 0),
    units: cities.reduce((s, c) => s + c.units, 0),
    orders: (collection || search) ? cities.reduce((s, c) => s + c.orders, 0) : d.cities.reduce((s, c) => s + (c.orders || 0), 0),
    cityCount: cities.length,
    productCount: new Set(cityProducts.map((r) => r.productId || r.name)).size,
  };

  const topCities = cities.slice(0, CA_MAX_CITIES);
  const moreCities = cities.length - topCities.length;

  const productAgg = new Map<string, { key: string; name: string; collection: string; byCity: Record<string, { units: number; revenue: number }> }>();
  for (const r of cityProducts) {
    const key = r.productId || `name:${r.name.toLowerCase()}`;
    const b = productAgg.get(key) || { key, name: r.name, collection: r.collection, byCity: {} };
    const existing = b.byCity[r.city] || { units: 0, revenue: 0 };
    b.byCity[r.city] = { units: existing.units + r.units, revenue: existing.revenue + r.revenue };
    productAgg.set(key, b);
  }
  const products = [...productAgg.values()]
    .map((p) => ({ ...p, total: Object.values(p.byCity).reduce((s, v) => s + v.revenue, 0) }))
    .sort((a, b) => b.total - a.total);

  return { cities, topCities, moreCities, totals, products, hasPrev: d.hasPrev };
}

export function CityAnalyticsPage() {
  const { showToast } = useToast();

  const [timeRange, setTimeRange] = useState('thisMonth');
  const [customRange, setCustomRange] = useState<CustomRange>({ start: '', end: '' });
  const [collection, setCollection] = useState('');
  const [search, setSearch] = useState('');
  // 'revenue' | 'orders' - the select's own naming: 'orders' here means "show unit
  // counts" in the matrix table below, not order counts (ported unchanged from
  // city-analytics.js's caMetric, which the city bar list on the left ignores entirely -
  // that always ranks by revenue).
  const [metric, setMetric] = useState<'revenue' | 'orders'>('revenue');
  const [data, setData] = useState<RawData | null>(null);
  const [loading, setLoading] = useState(true);

  // State, not a plain ref: this page's own mount effects run before the setHeader
  // effect from usePageHeader() below, which is what actually mounts this button
  // into AppShell's header - a ref would still read null then. See ProductAnalyticsPage.
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
    });
    return () => picker.destroy();
  }, [timeBtnNode]);

  const rangeLabel = analyticsRangeLabel(timeRange, customRange);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    (async () => {
      try {
        const [start, end] = analyticsRangeDates(timeRange, customRange);
        const res = await apiJson<any>(`/products/analytics-by-city?start=${analyticsIsoDate(start)}&end=${analyticsIsoDate(end)}`, { fallback: 'Failed to load city analytics' });
        if (id !== reqId.current) return;
        setData({
          cities: (res.cities || []).map((c: any): CityRow => ({
            city: c.city || 'Unknown', units: c.units || 0, revenue: Number(c.revenue) || 0, orders: c.orders || 0,
            products: c.products || 0, prevUnits: c.prev_units || 0, prevRevenue: Number(c.prev_revenue) || 0,
          })),
          cityProducts: (res.city_products || []).map((r: any): CityProductRow => ({
            city: r.city || 'Unknown', productId: r.product_id || null, name: r.name || '(unknown product)',
            collection: r.collection || 'Uncategorized', units: r.units || 0, revenue: Number(r.revenue) || 0,
          })),
          hasPrev: !!res.has_prev,
        });
      } catch (error) {
        if (id !== reqId.current) return;
        console.error('Error loading city analytics:', error);
        showToast('Failed to load city analytics', 'error');
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange, customRange.start, customRange.end]);

  const view = useMemo(() => deriveView(data, collection, search), [data, collection, search]);

  const collectionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.cityProducts || []) set.add(r.collection || 'Uncategorized');
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

  function exportExcel() {
    if (!view.products.length) { showToast('Nothing to export', 'warning', { silent: true }); return; }
    const rows = view.products.map((p) => {
      const out: Record<string, unknown> = { Product: p.name, Collection: p.collection, 'Total Sales (PKR)': Math.round(p.total) };
      for (const c of view.cities) out[c.city] = Math.round((p.byCity[c.city] || {}).revenue || 0);
      return out;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'City Analytics');
    XLSX.writeFile(wb, `city-analytics-${analyticsIsoDate(analyticsToday())}.xlsx`);
  }

  usePageHeader({
    title: 'Analytics by City',
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
      </>
    ),
  });

  const maxCityRevenue = Math.max(1, ...view.topCities.map((c) => c.revenue));
  const rankedProducts = [...view.products].sort((a, b) => b.total - a.total);
  const top5 = rankedProducts.slice(0, 5);
  const othersTotal = rankedProducts.slice(5).reduce((s, p) => s + p.total, 0);
  const donutSlices = top5.map((p) => ({ name: p.name, value: p.total }));
  if (othersTotal) donutSlices.push({ name: 'Others', value: othersTotal });

  return (
    <div className="pa-scroll">
      <div className="stats-grid">
        <StatCard label="Total Sales" value={`Rs ${analyticsN(view.totals.revenue)}`} />
        <StatCard label="Total Orders" value={analyticsN(view.totals.orders)} />
        <StatCard label="Total Products Sold" value={analyticsN(view.totals.units)} />
        <StatCard label="Cities Covered" value={analyticsN(view.totals.cityCount)} />
        <StatCard label="Total Products" value={analyticsN(view.totals.productCount)} />
      </div>

      <div className="ca-main-grid">
        <div className="pa-card ca-city-card">
          <div className="pa-widget-head">
            <h3>City Wise Sales</h3>
            <select className="pa-mini-select" value={metric} onChange={(e) => setMetric(e.target.value as 'revenue' | 'orders')}>
              <option value="revenue">Amount</option>
              <option value="orders">Units</option>
            </select>
          </div>
          <ul className="ca-city-list">
            {loading ? (
              <li className="pa-muted">Crunching sales by city…</li>
            ) : view.topCities.length === 0 ? (
              <li className="pa-muted">No sales in this range.</li>
            ) : view.topCities.map((c, i) => (
              <li className="ca-city-row" key={c.city}>
                <span className="ca-city-rank">{i + 1}.</span>
                <span className="ca-city-name">{c.city}</span>
                <span className="ca-city-bar-track"><span className="ca-city-bar-fill" style={{ width: `${((c.revenue / maxCityRevenue) * 100).toFixed(1)}%` }} /></span>
                <span className="ca-city-pct">{analyticsPct(c.revenue, view.totals.revenue).toFixed(1)}%</span>
                <span className="ca-city-val">Rs {analyticsN(c.revenue)}</span>
              </li>
            ))}
          </ul>
          {view.moreCities > 0 && <p className="ca-city-more">+{view.moreCities} more cit{view.moreCities === 1 ? 'y' : 'ies'}</p>}
        </div>
        <div className="pa-card ca-donut-card">
          <div className="pa-widget-head"><h3>Top Products Overall</h3></div>
          <div className="pa-donut-wrap">
            <AnalyticsDonut slices={donutSlices} total={view.totals.revenue} metric="revenue" />
            <ul className="pa-legend-list">{donutSlices.length ? legendList(donutSlices, view.totals.revenue) : <li className="pa-muted">No sales</li>}</ul>
          </div>
        </div>
      </div>

      <div className="pa-widget-head ca-matrix-head"><h3>Product Performance by City</h3></div>
      <div className="pa-card">
        <div className="pa-table-wrap">
          <table className="pa-table ca-matrix-table">
            <thead>
              <tr>
                <th>Product</th>
                {view.topCities.map((c) => <th key={c.city}>{c.city}</th>)}
                <th>Total Sales</th>
              </tr>
            </thead>
            <tbody>
              {rankedProducts.length === 0 ? (
                <tr><td colSpan={view.topCities.length + 2} className="pa-empty">No products match these filters.</td></tr>
              ) : rankedProducts.slice(0, 20).map((p) => (
                <tr key={p.key}>
                  <td className="ca-matrix-product">
                    <span className="ca-matrix-name">{p.name}</span>
                    <span className="ca-matrix-sub">{p.collection}</span>
                  </td>
                  {view.topCities.map((c) => {
                    const v = p.byCity[c.city];
                    const empty = !v || (metric === 'revenue' ? !v.revenue : !v.units);
                    return (
                      <td key={c.city} className={empty ? 'ca-matrix-empty' : undefined}>
                        {empty ? '–' : (metric === 'revenue' ? `Rs ${analyticsN(v!.revenue)}` : analyticsN(v!.units))}
                      </td>
                    );
                  })}
                  <td className="ca-matrix-total">Rs {analyticsN(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="stat-info">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
      </div>
    </div>
  );
}
