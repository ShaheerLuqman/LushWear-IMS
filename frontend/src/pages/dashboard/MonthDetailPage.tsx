// Month Detail: full P&L, product-sales-by-collection breakdown, order snapshot,
// expenses, and carrier health for one fiscal period. Ported from sync-summary.js's
// openMonthDetail/displayMonthDetail.
import { useEffect, useState, type ReactNode } from 'react';
import { Banner, BlockStack, Box, Button, Card, Collapsible, InlineGrid, InlineStack, Spinner, Text } from '@shopify/polaris';
import { ChevronDownIcon, ChevronRightIcon } from '@shopify/polaris-icons';
import { KeyValueList } from '../../components/KeyValueList';
import { MetricsStrip } from '../../components/MetricsStrip';
import { StatCardGrid } from '../../components/StatCardGrid';
import { useParams } from 'react-router-dom';
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

function CollectionBreakdownRow({ row }: { row: CollectionRow }) {
  const [expanded, setExpanded] = useState(false);
  const products = row.products || [];
  return (
    <>
      <Box paddingBlock="150" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
          <InlineStack gap="100" blockAlign="center">
            {products.length > 0 && <Button icon={expanded ? ChevronDownIcon : ChevronRightIcon} variant="tertiary" size="micro" accessibilityLabel="Toggle products" onClick={() => setExpanded((v) => !v)} />}
            <Text as="span">{row.collection || 'Others'}</Text>
          </InlineStack>
          <Text as="span" numeric>{fmt(row.count)} units · Rs {fmt(row.sum)}</Text>
        </InlineStack>
      </Box>
      <Collapsible open={expanded} id={`collection-${row.collection || 'others'}`}>
        <Box paddingInlineStart="600">
          <KeyValueList rows={products.map((p) => ({ label: p.name, value: `${fmt(p.count)} units · Rs ${fmt(p.sum)}` }))} />
        </Box>
      </Collapsible>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">{title}</Text>
        {children}
      </BlockStack>
    </Card>
  );
}

export function MonthDetailPage() {
  const { month: monthParam } = useParams<{ month: string }>();
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

  const monthName = month ? MONTH_NAMES[month - 1] : '';
  const periodLabel = month && year ? formatOrdersPeriodLabel(month, year, fiscalMonthStartDay) : '';
  const netSales = data?.net_sales ?? 0;
  const grossProfit = data?.gross_profit ?? 0;
  const netProfit = data?.net_profit ?? 0;
  const grossMargin = netSales !== 0 ? (grossProfit / netSales) * 100 : 0;
  const soldCollections = (data?.products_sold_by_collection || []).filter((row) => (row.count || 0) > 0);
  const collectionsTotal = soldCollections.reduce<{ count: number; sum: number }>((acc, row) => ({ count: acc.count + (row.count || 0), sum: acc.sum + (row.sum || 0) }), { count: 0, sum: 0 });

  usePageHeader({
    title: `${monthName} ${year || ''}`,
    subtitle: periodLabel,
  });

  if (error) return <Banner tone="critical">Failed to load period data. Please try again.</Banner>;
  if (!data) return <div className="page-loading"><Spinner size="small" /><Text as="span" tone="subdued">Loading period data...</Text></div>;

  return (
    <BlockStack gap="400">
      <MetricsStrip
        label="Period summary"
        tiles={[
          { label: 'Company Net Profit', value: rs(netProfit), negative: netProfit < 0 },
          { label: 'Net Sales', value: rs(netSales) },
          { label: 'Cost of Goods Sold', value: rs(data.cost_of_goods_sold ?? 0) },
          { label: 'Gross Profit', value: rs(grossProfit) },
          { label: 'Gross Profit Margin', value: `${grossMargin.toFixed(2)}%` },
        ]}
      />
      <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
        <BlockStack gap="400">
          <Section title="Profit & Loss Summary">
            <KeyValueList rows={[
              { label: 'Metric', value: 'Amount (Rs)', kind: 'head' },
              { label: 'Total Gross Sale', value: rs(data.total_gross_sale) },
              { label: 'Total Return Amount', value: rs(data.total_return_amount), kind: 'deduction' },
              { label: 'Net Sales', value: rs(netSales), kind: 'subtotal' },
              { label: 'Less: DC Charges / Delivery Expense', value: rs(data.dc_charges_total ?? 0), kind: 'deduction' },
              { label: 'Less: Tax', value: rs(data.tax_total ?? 0), kind: 'deduction' },
              { label: 'Gross Profit', value: rs(grossProfit), kind: 'subtotal' },
              { label: 'Less: Cost of Goods Sold', value: rs(data.cost_of_goods_sold ?? 0), kind: 'deduction' },
              ...(data.expense_lines || []).map((l) => ({ key: `exp-${l.name}`, label: `Less: ${l.name}`, value: rs(l.amount ?? 0), kind: 'deduction' as const })),
              { label: 'Net Profit', value: rs(netProfit), kind: netProfit < 0 ? 'negative' : 'final' },
            ]} />
          </Section>
          <Section title="Product Sales by Collection">
            <KeyValueList rows={[{ label: 'Collection', value: 'Units · Sales (Rs)', kind: 'head' }]} />
            {soldCollections.map((row) => <CollectionBreakdownRow row={row} key={row.collection || 'Others'} />)}
            <KeyValueList rows={[{ label: 'Total', value: `${fmt(collectionsTotal.count)} units · Rs ${fmt(collectionsTotal.sum)}`, kind: 'subtotal' }]} />
          </Section>
        </BlockStack>
        <BlockStack gap="400">
          <Section title="Order & Collection Snapshot">
            <StatCardGrid columns={{ xs: 2, md: 3 }} tiles={[
              { label: 'Total Orders', value: fmt(data.total_orders) },
              { label: 'Delivered Orders', value: fmt(data.delivered_orders_count), tone: 'success' },
              { label: 'Return Orders', value: fmt(data.return_orders_count), tone: 'critical' },
              { label: 'Cancelled Orders', value: fmt(data.cancelled_orders_count ?? 0), tone: 'critical' },
              { label: 'Enroute Orders', value: fmt(data.enroute_orders_count ?? 0) },
              { label: 'Unfulfilled Orders', value: fmt(data.unfulfilled_orders_count ?? 0) },
            ]} />
            <KeyValueList rows={[
              { label: 'DC Charges (Delivered)', value: rs(data.dc_charges_delivered ?? 0) },
              { label: 'DC Charges (Returned)', value: rs(data.dc_charges_returned ?? 0) },
              { label: 'Total DC Charges', value: rs(data.dc_charges_total ?? 0), kind: 'subtotal' },
            ]} />
          </Section>
          <Section title="Expense Summary">
            <KeyValueList rows={[
              { label: 'Expense', value: 'Amount (Rs)', kind: 'head' },
              ...(data.expense_lines || []).map((l) => ({ label: l.name, value: rs(l.amount ?? 0) })),
              { label: 'Total Expenses', value: rs(data.total_expenses ?? 0), kind: 'subtotal' },
            ]} />
          </Section>
          <Section title="Carrier Health">
            <KeyValueList rows={(data.carrier_health || []).map((row) => {
              const pct = row.total_count > 0 ? Math.round((row.delivered_count / row.total_count) * 100) : 0;
              return { label: row.courier, value: `${row.delivered_count}/${row.total_count} (${pct}%)` };
            })} />
          </Section>
        </BlockStack>
      </InlineGrid>
    </BlockStack>
  );
}
