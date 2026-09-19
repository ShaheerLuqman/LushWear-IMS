// Product Analytics: per-product volume & revenue, size breakdown, Hero/Zero
// classification, trend/mix/size/insight widgets. Ported from product-analytics.js.
// Data: GET /products/analytics (aggregates the picked range + the equal-length
// window before it in one call) - this file only shapes filters, classifies, renders.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { DateRangePopover, type DateRange } from '../../components/DateRangePopover';
import {
  analyticsComparisonWord, analyticsIsoDate, analyticsN, analyticsPct, analyticsRangeDates, analyticsRangeLabel,
  analyticsShortDate, analyticsToday, ANALYTICS_TIME_PRESETS, type CustomRange,
} from '../../logic/analyticsShared';
import { AnalyticsDeltaBadge, AnalyticsDonut, AnalyticsLineChart, legendList } from '../../logic/analyticsCharts';
import { Badge, BlockStack, Box, Card, Checkbox, InlineGrid, InlineStack, Popover, Text } from '@shopify/polaris';
import { ExportIcon, InfoIcon, SettingsIcon } from '@shopify/polaris-icons';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { RowActions } from '../../components/RowActions';
import { MetricsStrip } from '../../components/MetricsStrip';
import { Dropdown } from '../../components/Dropdown';
import { InfoModal } from '../../components/FormModal';
import { ProductIdentity } from '../../components/ProductIdentity';
import { StatGrid } from '../../components/StatGrid';

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
  const dates = buckets.map((b) => analyticsShortDate(new Date(`${b}T00:00:00`)));
  return {
    values: buckets.map((b) => m.get(b) as number),
    dates,
    first: dates[0] || '',
    last: dates[dates.length - 1] || '',
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

  const [timeRange, setTimeRange] = useState('last30');
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

  const reqId = useRef(0);

  function onRangeChange({ from, to }: DateRange) {
    const matched = ANALYTICS_TIME_PRESETS.find((p) => {
      const [s, e] = analyticsRangeDates(p.key, { start: '', end: '' });
      return analyticsIsoDate(s) === from && analyticsIsoDate(e) === to;
    });
    if (matched) setTimeRange(matched.key);
    else { setTimeRange('custom'); setCustomRange({ start: from, end: to }); }
    setCustomizeOpen(false);
    setHeroDefOpen(false);
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

  const view = useMemo(() => deriveView(data, collection, search.trim()), [data, collection, search]);

  const collectionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows || []) set.add(r.collection || 'Uncategorized');
    return [...set].sort((a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)));
  }, [data]);

  useEffect(() => {
    if (collection && !collectionOptions.includes(collection)) setCollection('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

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
  const prevTrend = view.hasPrev ? trendSeries(data, 'previous', trendMetric, collection) : { values: [] as number[], dates: [] as string[], first: '', last: '' };

  const ranked = [...view.rows].filter((r) => r.units > 0).sort((a, b) => b.units - a.units);
  const top5 = ranked.slice(0, 5);
  const othersUnits = ranked.slice(5).reduce((s, r) => s + r.units, 0);
  const donutSlices = top5.map((r) => ({ name: r.name, value: r.units }));
  if (othersUnits) donutSlices.push({ name: 'Others', value: othersUnits });


  const detailsRow = detailsKey ? view.rows.find((r) => r.key === detailsKey) || null : null;

  usePageHeader({
    title: 'Product Analytics',
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
        <Popover
          active={customizeOpen} onClose={() => setCustomizeOpen(false)} preferredAlignment="right"
          activator={<HeaderButton icon={SettingsIcon} disclosure onClick={() => setCustomizeOpen((v) => !v)}>Customize</HeaderButton>}
        >
          <Box padding="300">
            <BlockStack gap="200">
              <Text as="span" variant="headingSm">Columns</Text>
              <Checkbox label="Revenue" checked={cols.revenue} onChange={(v) => toggleCol('revenue', v)} />
              <Checkbox label="vs Previous" checked={cols.delta} onChange={(v) => toggleCol('delta', v)} />
              <Checkbox label="Variant sizes" checked={cols.sizes} onChange={(v) => toggleCol('sizes', v)} />
            </BlockStack>
          </Box>
        </Popover>
        <Popover
          active={heroDefOpen} onClose={() => setHeroDefOpen(false)} preferredAlignment="right"
          activator={<HeaderButton icon={InfoIcon} accessibilityLabel="Performance definition" onClick={() => setHeroDefOpen((v) => !v)} />}
        >
          <Box padding="300" maxWidth="320px">
            <Text as="p">Products are ranked by units sold within the current collection and range. <Text as="span" fontWeight="semibold">Hero</Text> = the top ~20% (ties included); <Text as="span" fontWeight="semibold">Zero</Text> = the bottom ~20%, including products with no sales; everything between is <Text as="span" fontWeight="semibold">Average</Text>.</Text>
          </Box>
        </Popover>
      </>
    ),
  });

  const showSizes = cols.sizes && view.sizes.length > 0;
  const kpi = (label: string, value: string, cur: number, prev: number, isMoney: boolean) => ({
    label, value,
    detail: (
      <InlineStack gap="200" blockAlign="center">
        <Text as="span" tone="subdued" variant="bodySm">{comparisonWord}: {view.hasPrev ? (isMoney ? `PKR ${analyticsN(prev)}` : analyticsN(prev)) : '—'}</Text>
        <AnalyticsDeltaBadge cur={cur} prev={prev} hasPrev={view.hasPrev} />
      </InlineStack>
    ),
  });
  const PERF_TONE = { hero: 'success', average: undefined, zero: 'critical' } as const;
  const columns: DataColumn<ViewRow>[] = [
    { key: 'rank', heading: '#', render: (r) => (r.rank <= 3 ? <Badge tone={r.rank === 1 ? 'success' : r.rank === 2 ? 'info' : 'attention'}>{String(r.rank)}</Badge> : <Text as="span" tone="subdued">{r.rank}</Text>), sortValue: (r) => r.rank },
    {
      key: 'product', heading: 'Product', sortValue: (r) => r.name,
      render: (r) => (
        <div className="pa-product" onClick={() => setDetailsKey(r.key)} style={{ cursor: 'pointer' }}>
          <ProductThumb imageUrl={r.imageUrl} name={r.name} />
          <div className="pa-product-text">
            <Text as="span" fontWeight="semibold">{r.name}</Text>
            <Text as="span" tone="subdued" variant="bodySm">{r.collection} · {analyticsN(r.variantCount)} variants · {analyticsN(r.stock)} in stock</Text>
          </div>
        </div>
      ),
    },
    { key: 'units', heading: 'Total Sold (Units)', alignment: 'end', sortValue: (r) => r.units, render: (r) => <BlockStack gap="0" inlineAlign="end"><Text as="span" fontWeight="semibold" numeric>{analyticsN(r.units)}</Text><Text as="span" tone="subdued" variant="bodySm">{Math.round(analyticsPct(r.units, view.totals.units))}% of shown</Text></BlockStack> },
    ...(cols.revenue ? [{ key: 'revenue', heading: 'Revenue (PKR)', alignment: 'end' as const, sortValue: (r: ViewRow) => r.revenue, render: (r: ViewRow) => analyticsN(r.revenue) }] : []),
    ...(cols.delta ? [{ key: 'delta', heading: 'vs Previous (Units)', alignment: 'end' as const, sortValue: (r: ViewRow) => r.units - r.prevUnits, render: (r: ViewRow) => <InlineStack gap="100" align="end" blockAlign="center"><Text as="span" tone="subdued">{analyticsN(r.prevUnits)}</Text><AnalyticsDeltaBadge cur={r.units} prev={r.prevUnits} hasPrev={view.hasPrev} /></InlineStack> }] : []),
    ...(showSizes ? view.sizes.map((size) => ({
      key: `size-${size}`, heading: size, alignment: 'end' as const, sortValue: (r: ViewRow) => r.sizes[size] || 0,
      render: (r: ViewRow) => { const q = r.sizes[size] || 0; return q ? <BlockStack gap="0" inlineAlign="end"><Text as="span" numeric>{analyticsN(q)}</Text><Text as="span" tone="subdued" variant="bodySm">{((q / r.units) * 100).toFixed(1)}%</Text></BlockStack> : <Text as="span" tone="subdued">–</Text>; },
    })) : []),
    { key: 'perf', heading: 'Performance', sortValue: (r) => r.perf, render: (r) => <Badge tone={PERF_TONE[r.perf as keyof typeof PERF_TONE]}>{PERF_META[r.perf].label}</Badge> },
    { key: 'actions', heading: '', alignment: 'end', render: (r) => <RowActions items={[{ content: 'View details', onAction: () => setDetailsKey(r.key) }, { content: 'Open in Products', onAction: () => navigate('/products') }]} /> },
  ];

  return (
    <div className="pa-scroll">
      <BlockStack gap="400">
        <MetricsStrip label="Product analytics summary" tiles={[
          kpi('Total Units Sold', analyticsN(view.totals.units), view.totals.units, view.prevTotals.units, false),
          kpi('Total Revenue', `PKR ${analyticsN(view.totals.revenue)}`, view.totals.revenue, view.prevTotals.revenue, true),
          kpi('Orders', analyticsN(view.totals.orders), view.totals.orders, view.prevTotals.orders, false),
          kpi('Avg. Order Value', `PKR ${analyticsN(view.totals.aov)}`, view.totals.aov, view.prevTotals.aov, true),
        ]} />

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">Sales Trend</Text>
                <Dropdown size="slim" options={[{ value: 'units', label: 'Units' }, { value: 'revenue', label: 'Revenue' }]} value={trendMetric} onChange={(v) => setTrendMetric(v as 'units' | 'revenue')} />
              </InlineStack>
              <div className="pa-trend-legend">
                <span><i className="pa-swatch pa-swatch--cur" />This period</span>
                {prevTrend.values.length > 0 && <span><i className="pa-swatch pa-swatch--prev" />Previous period</span>}
              </div>
              <AnalyticsLineChart cur={curTrend.values} prev={prevTrend.values} metric={trendMetric} curDates={curTrend.dates} prevDates={prevTrend.dates} />
              <div className="pa-trend-axis"><span>{curTrend.first}</span><span>{curTrend.last}</span></div>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Top Products by Units</Text>
              <div className="pa-donut-wrap pa-donut-wrap--lg">
                <AnalyticsDonut slices={donutSlices} total={view.totals.units} metric="units" />
                <ul className="pa-legend-list">{donutSlices.length ? legendList(donutSlices, view.totals.units) : <li className="pa-muted">No sales</li>}</ul>
              </div>
            </BlockStack>
          </Card>
        </InlineGrid>

        <div className="pa-table-card">
          <DataTable
            columns={columns} rows={view.segmentRows} rowId={(r) => r.key} loading={loading}
            resourceName={{ singular: 'product', plural: 'products' }} emptyMessage="No products match these filters."
          />
        </div>
      </BlockStack>

      {detailsRow && (
        <InfoModal title="Product Details" onClose={() => setDetailsKey(null)} actions={[{ content: 'Open in Products', onAction: () => { setDetailsKey(null); navigate('/products'); } }]}>
          <BlockStack gap="400">
            <ProductIdentity
              name={detailsRow.name} imageUrl={detailsRow.imageUrl}
              subtitle={`${detailsRow.collection} · ${analyticsN(detailsRow.variantCount)} variant${detailsRow.variantCount === 1 ? '' : 's'} · ${analyticsN(detailsRow.stock)} in stock`}
            />
            <StatGrid rows={[
              ['Rank', `#${detailsRow.rank}`],
              ['Performance', PERF_META[detailsRow.perf].label],
              ['Units Sold', analyticsN(detailsRow.units)],
              ['Revenue', `PKR ${analyticsN(detailsRow.revenue)}`],
              [comparisonWord, view.hasPrev ? `${analyticsN(detailsRow.prevUnits)} units` : '—'],
            ]} />
            {view.sizes.filter((s) => detailsRow.sizes[s]).length > 0 && (
              <StatGrid rows={view.sizes.filter((s) => detailsRow.sizes[s]).map((s) => [s, `${analyticsN(detailsRow.sizes[s])} (${((detailsRow.sizes[s] / detailsRow.units) * 100).toFixed(1)}%)`])} />
            )}
          </BlockStack>
        </InfoModal>
      )}
    </div>
  );
}
