// Month Detail: full P&L, product-sales-by-collection breakdown, order snapshot,
// expenses, and carrier health for one fiscal period. Ported from sync-summary.js's
// openMonthDetail/displayMonthDetail.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { formatOrdersPeriodLabel } from '../orders/useOrdersData';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface ExpenseLine { name: string; amount?: number }
interface CollectionProduct { name: string; count?: number; sum?: number }
interface CollectionRow { collection?: string; count?: number; sum?: number; products?: CollectionProduct[] }
interface CarrierHealthRow { courier: string; delivered_count: number; total_count: number }
interface MonthDetail {
  month: number; year: number;
  total_gross_sale?: number; total_return_amount?: number; net_sales?: number;
  dc_charges_total?: number; tax_total?: number; gross_profit?: number; cost_of_goods_sold?: number;
  expense_lines?: ExpenseLine[]; net_profit?: number; total_expenses?: number;
  products_sold_by_collection?: CollectionRow[];
  total_orders?: number; delivered_orders_count?: number; return_orders_count?: number; cancelled_orders_count?: number;
  enroute_orders_count?: number; unfulfilled_orders_count?: number;
  dc_charges_delivered?: number; dc_charges_returned?: number;
  carrier_health?: CarrierHealthRow[];
}

const fmt = (n: number | null | undefined) => (typeof n === 'number' && !Number.isInteger(n))
  ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : (n ?? 0).toLocaleString('en-US');
const rs = (n: number | null | undefined) => `Rs ${fmt(n)}`;

function Line({ label, value, modifier }: { label: string; value: string; modifier?: string }) {
  return (
    <div className={'month-detail-line' + (modifier ? ` month-detail-line--${modifier}` : '')}>
      <span className="month-detail-line-label">{label}</span>
      <span className="month-detail-line-value">{value}</span>
    </div>
  );
}

function StatCard({ icon, color, value, label }: { icon: string; color: string; value: string; label: string }) {
  return (
    <div className="month-detail-stat-card">
      <div className={`month-detail-stat-icon month-detail-stat-icon--${color}`}><i className={`fa-solid ${icon}`} /></div>
      <div className="month-detail-stat-info"><span className="month-detail-stat-value">{value}</span><span className="month-detail-stat-label">{label}</span></div>
    </div>
  );
}

function SectionHeading({ icon, color, title }: { icon: string; color: string; title: string }) {
  return <h3 className="month-detail-section-heading"><span className={`month-detail-section-icon month-detail-section-icon--${color}`}><i className={`fa-solid ${icon}`} /></span>{title}</h3>;
}

function CollectionBreakdownRow({ row }: { row: CollectionRow }) {
  const [expanded, setExpanded] = useState(false);
  const hasProducts = (row.products || []).length > 0;
  return (
    <div className={'collection-breakdown-group' + (expanded ? ' expanded' : '')}>
      <button type="button" className="month-detail-line collection-breakdown-toggle" disabled={!hasProducts} onClick={() => setExpanded((v) => !v)}>
        <span className="month-detail-line-label">
          {hasProducts && <span className="collection-breakdown-chevron">▸</span>}
          {row.collection || 'Others'}
        </span>
        <span className="month-detail-line-value">{fmt(row.count)} units · Rs {fmt(row.sum)}</span>
      </button>
      <div className="collection-breakdown-products">
        {(row.products || []).map((p) => (
          <div className="month-detail-line collection-breakdown-product" key={p.name}>
            <span className="month-detail-line-label">{p.name}</span>
            <span className="month-detail-line-value">{fmt(p.count)} units · Rs {fmt(p.sum)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonthDetailPage() {
  const { month: monthParam } = useParams<{ month: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { account } = useAuth();
  const fiscalMonthStartDay = account?.fiscal_month_start_day || 22;
  const [data, setData] = useState<MonthDetail | null>(null);
  const [error, setError] = useState(false);

  const [month, year] = (monthParam || '').split('-').map(Number);

  useEffect(() => {
    if (!month || !year) return;
    let cancelled = false;
    setData(null);
    setError(false);
    (async () => {
      try {
        const result = await apiJson<MonthDetail>(`/orders/month-summary/${month}/${year}`, { fallback: 'Failed to fetch month detail' });
        if (!cancelled) setData(result);
      } catch (err) {
        console.error('Error loading month detail:', err);
        if (!cancelled) { setError(true); showToast('Failed to load month details', 'error'); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year]);

  usePageHeader({ title: 'Finance' });

  const monthName = month ? MONTH_NAMES[month - 1] : '';
  const periodLabel = month && year ? formatOrdersPeriodLabel(month, year, fiscalMonthStartDay) : '';
  const title = data ? `${MONTH_NAMES[data.month - 1]} ${data.year} - ${formatOrdersPeriodLabel(data.month, data.year, fiscalMonthStartDay)}` : `${monthName} ${year} - ${periodLabel}`;

  const netSales = data?.net_sales ?? 0;
  const grossProfit = data?.gross_profit ?? 0;
  const netProfit = data?.net_profit ?? 0;
  const grossMargin = netSales !== 0 ? (grossProfit / netSales) * 100 : 0;
  const soldCollections = (data?.products_sold_by_collection || []).filter((row) => (row.count || 0) > 0);
  const collectionsTotal = soldCollections.reduce<{ count: number; sum: number }>((acc, row) => ({ count: acc.count + (row.count || 0), sum: acc.sum + (row.sum || 0) }), { count: 0, sum: 0 });

  return (
    <>
      <div className="month-detail-header">
        <div className="month-detail-header-left">
          <button className="btn btn-secondary" onClick={() => navigate('/month-summary')}><i className="fa-solid fa-arrow-left" /> Back to Month Summary</button>
          <h2>{title}</h2>
        </div>
        {data && (
          <div className={'month-detail-hero' + (netProfit < 0 ? ' month-detail-hero--negative' : '')}>
            <div className="month-detail-hero-icon"><i className="fa-solid fa-arrow-trend-up" /></div>
            <div className="month-detail-hero-info"><span className="month-detail-hero-label">Company Net Profit</span><span className="month-detail-hero-value">{rs(netProfit)}</span></div>
          </div>
        )}
      </div>
      <div className="month-detail-content">
        {error ? (
          <div className="no-data-message">Failed to load period data. Please try again.</div>
        ) : !data ? (
          <div className="content-loading"><div className="content-loading-spinner" /><p className="content-loading-text">Loading period data...</p></div>
        ) : (
          <>
            <div className="month-detail-sections">
              <div className="month-detail-column">
                <section className="month-detail-section">
                  <SectionHeading icon="fa-chart-line" color="success" title="Profit & Loss Summary" />
                  <div className="month-detail-lines">
                    <Line label="Metric" value="Amount (Rs)" modifier="head" />
                    <Line label="Total Gross Sale" value={rs(data.total_gross_sale)} />
                    <Line label="Total Return Amount" value={rs(data.total_return_amount)} modifier="deduction" />
                    <Line label="Net Sales" value={rs(netSales)} modifier="subtotal" />
                    <Line label="Less: DC Charges / Delivery Expense" value={rs(data.dc_charges_total ?? 0)} modifier="deduction" />
                    <Line label="Less: Tax" value={rs(data.tax_total ?? 0)} modifier="deduction" />
                    <Line label="Gross Profit" value={rs(grossProfit)} modifier="subtotal" />
                    <Line label="Less: Cost of Goods Sold" value={rs(data.cost_of_goods_sold ?? 0)} modifier="deduction" />
                    {(data.expense_lines || []).map((l) => <Line key={l.name} label={`Less: ${l.name}`} value={rs(l.amount ?? 0)} modifier="deduction" />)}
                    <Line label="Net Profit" value={rs(netProfit)} modifier={netProfit < 0 ? 'final negative' : 'final'} />
                  </div>
                </section>
                <section className="month-detail-section">
                  <SectionHeading icon="fa-layer-group" color="info" title="Product Sales by Collection" />
                  <div className="month-detail-lines collection-breakdown">
                    <Line label="Collection" value="Units · Sales (Rs)" modifier="head" />
                    {soldCollections.map((row) => <CollectionBreakdownRow row={row} key={row.collection || 'Others'} />)}
                    <Line label="Total" value={`${fmt(collectionsTotal.count)} units · Rs ${fmt(collectionsTotal.sum)}`} modifier="subtotal" />
                  </div>
                </section>
              </div>
              <div className="month-detail-column">
                <section className="month-detail-section">
                  <SectionHeading icon="fa-clipboard-list" color="accent" title="Order & Collection Snapshot" />
                  <div className="month-detail-stats month-detail-stats--compact">
                    <StatCard icon="fa-bag-shopping" color="accent" value={fmt(data.total_orders)} label="Total Orders" />
                    <StatCard icon="fa-truck" color="success" value={fmt(data.delivered_orders_count)} label="Delivered Orders" />
                    <StatCard icon="fa-rotate-left" color="danger" value={fmt(data.return_orders_count)} label="Return Orders" />
                    <StatCard icon="fa-circle-xmark" color="danger" value={fmt(data.cancelled_orders_count ?? 0)} label="Cancelled Orders" />
                    <StatCard icon="fa-location-dot" color="warning" value={fmt(data.enroute_orders_count ?? 0)} label="Enroute Orders" />
                    <StatCard icon="fa-box" color="accent" value={fmt(data.unfulfilled_orders_count ?? 0)} label="Unfulfilled Orders" />
                  </div>
                  <div className="month-detail-dc-grid">
                    <div className="month-detail-dc-box"><span className="month-detail-dc-label">DC Charges (Delivered)</span><span className="month-detail-dc-value">{rs(data.dc_charges_delivered ?? 0)}</span></div>
                    <div className="month-detail-dc-box"><span className="month-detail-dc-label">DC Charges (Returned)</span><span className="month-detail-dc-value">{rs(data.dc_charges_returned ?? 0)}</span></div>
                  </div>
                  <div className="month-detail-stats month-detail-stats--compact month-detail-stats--single">
                    <StatCard icon="fa-coins" color="accent" value={rs(data.dc_charges_total ?? 0)} label="Total DC Charges" />
                  </div>
                </section>
                <section className="month-detail-section">
                  <SectionHeading icon="fa-file-invoice-dollar" color="warning" title="Expense Summary" />
                  <div className="month-detail-lines">
                    <Line label="Expense" value="Amount (Rs)" modifier="head" />
                    {(data.expense_lines || []).map((l) => <Line key={l.name} label={l.name} value={rs(l.amount ?? 0)} />)}
                    <Line label="Total Expenses" value={rs(data.total_expenses ?? 0)} modifier="subtotal" />
                  </div>
                </section>
                <section className="month-detail-section">
                  <SectionHeading icon="fa-truck-fast" color="accent" title="Carrier Health" />
                  <div className="month-detail-lines">
                    {(data.carrier_health || []).map((row) => {
                      const pct = row.total_count > 0 ? Math.round((row.delivered_count / row.total_count) * 100) : 0;
                      return <Line key={row.courier} label={row.courier} value={`${row.delivered_count}/${row.total_count} (${pct}%)`} />;
                    })}
                  </div>
                </section>
              </div>
            </div>
            <div className="month-detail-stats">
              <StatCard icon="fa-sack-dollar" color="accent" value={rs(netSales)} label="Net Sales" />
              <StatCard icon="fa-boxes-stacked" color="danger" value={rs(data.cost_of_goods_sold ?? 0)} label="Cost of Goods Sold" />
              <StatCard icon="fa-arrow-trend-up" color="success" value={rs(grossProfit)} label="Gross Profit" />
              <StatCard icon="fa-money-bill-trend-up" color={netProfit < 0 ? 'danger' : 'success'} value={rs(netProfit)} label="Net Profit" />
              <StatCard icon="fa-percent" color="warning" value={`${grossMargin.toFixed(2)}%`} label="Gross Profit Margin" />
            </div>
          </>
        )}
      </div>
    </>
  );
}
