// City Analytics: per-city volume & revenue, city-wise sales ranking, and a
// product-by-city breakdown table. Ported from city-analytics.js. Same basis and
// product resolution as Product Analytics so the two screens never disagree on a
// line's product - data comes from GET /products/analytics-by-city.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { DateRangePopover, type DateRange } from '../../components/DateRangePopover';
import {
  analyticsComparisonWord, analyticsIsoDate, analyticsN, analyticsPct, analyticsRangeDates, analyticsRangeLabel, analyticsToday,
  ANALYTICS_TIME_PRESETS, type CustomRange,
} from '../../logic/analyticsShared';
import { AnalyticsDeltaBadge, AnalyticsDonut, legendList } from '../../logic/analyticsCharts';
import { BlockStack, Card, InlineGrid, InlineStack, ProgressBar, Text } from '@shopify/polaris';
import { ExportIcon } from '@shopify/polaris-icons';
import { Dropdown } from '../../components/Dropdown';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { MetricsStrip } from '../../components/MetricsStrip';

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
  // No product-level previous-period breakdown from the API - approximate the filtered
  // view's previous totals the same way `orders` already does, from each city's overall figure.
  const prevTotals = {
    revenue: cities.reduce((s, c) => s + (cityMeta.get(c.city)?.prevRevenue || 0), 0),
    units: cities.reduce((s, c) => s + (cityMeta.get(c.city)?.prevUnits || 0), 0),
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

  return { cities, topCities, moreCities, totals, prevTotals, products, hasPrev: d.hasPrev };
}

export function CityAnalyticsPage() {
  const { showToast } = useToast();

  const [timeRange, setTimeRange] = useState('last30');
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

  const reqId = useRef(0);

  function onRangeChange({ from, to }: DateRange) {
    const matched = ANALYTICS_TIME_PRESETS.find((p) => {
      const [s, e] = analyticsRangeDates(p.key, { start: '', end: '' });
      return analyticsIsoDate(s) === from && analyticsIsoDate(e) === to;
    });
    if (matched) setTimeRange(matched.key);
    else { setTimeRange('custom'); setCustomRange({ start: from, end: to }); }
  }

  const rangeLabel = analyticsRangeLabel(timeRange, customRange);
  const [rangeStart, rangeEnd] = analyticsRangeDates(timeRange, customRange);
  const comparisonWord = analyticsComparisonWord(timeRange);

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

  const view = useMemo(() => deriveView(data, collection, search.trim()), [data, collection, search]);

  const collectionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.cityProducts || []) set.add(r.collection || 'Uncategorized');
    return [...set].sort((a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)));
  }, [data]);

  useEffect(() => {
    if (collection && !collectionOptions.includes(collection)) setCollection('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

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
    search: { value: search, onChange: setSearch },
    actions: (
      <>
        <DateRangePopover
          value={{ from: analyticsIsoDate(rangeStart), to: analyticsIsoDate(rangeEnd) }} onChange={(r) => r && onRangeChange(r)}
          label={rangeLabel} clearable={false}
          presets={Object.fromEntries(ANALYTICS_TIME_PRESETS.map((p) => [p.label, analyticsRangeDates(p.key, { start: '', end: '' })]))}
        />
        <Dropdown searchable options={[{ value: '', label: 'All collections' }, ...collectionOptions]} value={collection} onChange={setCollection} />
        <HeaderButton icon={ExportIcon} onClick={exportExcel}>Export</HeaderButton>
      </>
    ),
  });

  const kpi = (label: string, value: string, cur: number, prev: number, isMoney: boolean) => ({
    label, value,
    detail: (
      <InlineStack gap="200" blockAlign="center">
        <Text as="span" tone="subdued" variant="bodySm">{comparisonWord}: {view.hasPrev ? (isMoney ? `Rs ${analyticsN(prev)}` : analyticsN(prev)) : '—'}</Text>
        <AnalyticsDeltaBadge cur={cur} prev={prev} hasPrev={view.hasPrev} />
      </InlineStack>
    ),
  });
  const maxCityRevenue = Math.max(1, ...view.topCities.map((c) => c.revenue));
  const rankedProducts = [...view.products].sort((a, b) => b.total - a.total);
  const top5 = rankedProducts.slice(0, 5);
  const othersTotal = rankedProducts.slice(5).reduce((s, p) => s + p.total, 0);
  const donutSlices = top5.map((p) => ({ name: p.name, value: p.total }));
  if (othersTotal) donutSlices.push({ name: 'Others', value: othersTotal });

  type ProductRow = typeof rankedProducts[number];
  const matrixColumns: DataColumn<ProductRow>[] = [
    { key: 'product', heading: 'Product', sortValue: (r) => r.name, render: (r) => <BlockStack gap="0"><Text as="span" fontWeight="semibold">{r.name}</Text><Text as="span" tone="subdued" variant="bodySm">{r.collection}</Text></BlockStack> },
    ...view.topCities.map((c) => ({
      key: `city-${c.city}`, heading: c.city, alignment: 'end' as const,
      sortValue: (r: ProductRow) => (metric === 'revenue' ? r.byCity[c.city]?.revenue : r.byCity[c.city]?.units) || 0,
      render: (r: ProductRow) => {
        const v = r.byCity[c.city];
        const empty = !v || (metric === 'revenue' ? !v.revenue : !v.units);
        return empty ? <Text as="span" tone="subdued">–</Text> : (metric === 'revenue' ? `Rs ${analyticsN(v!.revenue)}` : analyticsN(v!.units));
      },
    })),
    { key: 'total', heading: 'Total Sales', alignment: 'end', sortValue: (r) => r.total, render: (r) => <Text as="span" fontWeight="semibold" numeric>Rs {analyticsN(r.total)}</Text> },
  ];

  return (
    <div className="pa-scroll">
      <BlockStack gap="400">
        <MetricsStrip
          label="City analytics summary"
          tiles={[
            kpi('Total Sales', `Rs ${analyticsN(view.totals.revenue)}`, view.totals.revenue, view.prevTotals.revenue, true),
            { label: 'Total Orders', value: analyticsN(view.totals.orders) },
            kpi('Total Products Sold', analyticsN(view.totals.units), view.totals.units, view.prevTotals.units, false),
            { label: 'Cities Covered', value: analyticsN(view.totals.cityCount) },
            { label: 'Total Products', value: analyticsN(view.totals.productCount) },
          ]}
        />

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">City Wise Sales</Text>
                <Dropdown size="slim" options={[{ value: 'revenue', label: 'Amount' }, { value: 'orders', label: 'Units' }]} value={metric} onChange={(v) => setMetric(v as 'revenue' | 'orders')} />
              </InlineStack>
              {loading ? (
                <Text as="p" tone="subdued">Crunching sales by city…</Text>
              ) : view.topCities.length === 0 ? (
                <Text as="p" tone="subdued">No sales in this range.</Text>
              ) : view.topCities.map((c, i) => (
                <BlockStack gap="100" key={c.city}>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span"><Text as="span" tone="subdued">{i + 1}.</Text> {c.city}</Text>
                    <Text as="span" numeric>Rs {analyticsN(c.revenue)} <Text as="span" tone="subdued">({analyticsPct(c.revenue, view.totals.revenue).toFixed(1)}%)</Text></Text>
                  </InlineStack>
                  <ProgressBar progress={(c.revenue / maxCityRevenue) * 100} size="small" tone="primary" />
                </BlockStack>
              ))}
              {view.moreCities > 0 && <Text as="p" tone="subdued" variant="bodySm">+{view.moreCities} more cit{view.moreCities === 1 ? 'y' : 'ies'}</Text>}
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Top Products Overall</Text>
              <div className="pa-donut-wrap">
                <AnalyticsDonut slices={donutSlices} total={view.totals.revenue} metric="revenue" />
                <ul className="pa-legend-list">{donutSlices.length ? legendList(donutSlices, view.totals.revenue) : <li className="pa-muted">No sales</li>}</ul>
              </div>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Text as="h3" variant="headingSm">Product Performance by City</Text>
        <div className="pa-table-card">
          <DataTable
            columns={matrixColumns} rows={rankedProducts.slice(0, 20)} rowId={(r) => r.key} loading={loading}
            resourceName={{ singular: 'product', plural: 'products' }} emptyMessage="No products match these filters."
          />
        </div>
      </BlockStack>
    </div>
  );
}
