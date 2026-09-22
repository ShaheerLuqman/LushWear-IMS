// Courier Payment Report: what the courier still owes for delivered/returned orders,
// grouped by pickup date + courier, plus its bill-detail screen. Ported from
// courier-payment-report.js.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, BlockStack, Button, Card, InlineGrid, InlineStack, ProgressBar, Text } from '@shopify/polaris';
import { InfoModal } from '../../components/FormModal';
import { ReportTable } from '../../components/ReportTable';
import { ArrowLeftIcon, ExportIcon, ViewIcon } from '@shopify/polaris-icons';
import { KeyValueList } from '../../components/KeyValueList';
import { StatCardGrid } from '../../components/StatCardGrid';
import { apiJson, apiRequest } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { DateRangePopover, type DateRange } from '../../components/DateRangePopover';
import { Dropdown } from '../../components/Dropdown';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { MetricsStrip } from '../../components/MetricsStrip';
import { StatusBadge } from '../../components/StatusBadge';
import { formatMoney } from '../../logic/ledgers';
import { computeReceivable } from '../../logic/orders';
import {
  BILL_STATUS_META, COURIER_PAYMENT_STATUSES, COURIER_PAYMENT_STATUS_LABELS, COURIER_RESOLVED_STATUSES,
  billCourierLabel, billDateSortValue, billPickupDateLabel, computeCod, courierPaymentReportSummary, mapCourierBillRow,
  paymentProgressPieStops, paymentProgressStats, PAYMENT_PROGRESS_COLORS, type CourierBill,
} from '../../logic/courierPaymentReport';

function defaultRange() { const now = new Date(); const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29); const p = (n: number) => String(n).padStart(2, '0'); const ymd = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; return { from: ymd(from), to: ymd(now) }; }

interface PostExSettlementRow {
  order_number: number | string; corrected?: boolean; folio?: string; order_status: string;
  settlement_date?: string; invoice_payment: number; delivery_charge: number; tax_amount: number; receivable: number;
}
interface PostExSettlementsResult { message?: string; checked?: number; settlements?: PostExSettlementRow[] }

function formatPostExDate(value?: string): string {
  if (!value) return '-';
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '-';
}

function PostExSettlementsModal({ data, onClose }: { data: PostExSettlementsResult; onClose: () => void }) {
  const rows = data.settlements || [];
  const num = (v: unknown) => Number(v || 0).toFixed(2);
  const totalReceivable = rows.reduce((sum, r) => sum + Number(r.receivable || 0), 0);
  return (
    <InfoModal title="PostEx settlements" onClose={onClose} size="large">
      <BlockStack gap="400">
        <Text as="p" tone="subdued">{data.message || ''} Checked {data.checked || 0} order(s); total receivable across the {rows.length} listed: {totalReceivable.toFixed(2)}.</Text>
        <ReportTable
          headings={['Order #', 'Folio', 'Status', 'Settlement date', 'Invoice', 'Delivery charge', 'Tax', 'Receivable']} numeric={[4, 5, 6, 7]}
          emptyMessage="No orders were ready to settle."
          rows={rows.map((r) => [
            r.corrected ? `${r.order_number} (corrected)` : String(r.order_number), r.folio || '-', r.order_status, formatPostExDate(r.settlement_date),
            num(r.invoice_payment), num(r.delivery_charge), num(r.tax_amount), num(r.receivable),
          ])}
        />
        {rows.length > 0 && <Text as="p" tone="subdued">Tax is derived from the order value (2% income + 2% sales withholding); PostEx does not report it. Uploading the CPR CSV later replaces it with the exact figures.</Text>}
      </BlockStack>
    </InfoModal>
  );
}

function SettledOrdersCell({ bill }: { bill: CourierBill }) {
  const pct = bill.totalOrders > 0 ? Math.round((bill.settledCount / bill.totalOrders) * 100) : 0;
  return (
    <div className="payment-progress">
      <div className="payment-progress__row">
        <Text as="span" tone="subdued">{bill.settledCount} / {bill.totalOrders} Orders</Text>
        <Text as="span" fontWeight="semibold">{pct}%</Text>
      </div>
      <ProgressBar progress={pct} size="small" tone="success" />
    </div>
  );
}

function BillDetail({ bill, onBack }: { bill: CourierBill; onBack: () => void }) {
  const { showToast } = useToast();
  const [orders, setOrders] = useState(bill.orders);
  const [customerNames, setCustomerNames] = useState<Map<number, string>>(new Map());
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (orders) return;
      try {
        const detail = await apiJson<{ orders: any[] }>(`/courier-bills/${bill.id}`, { fallback: 'Failed to load bill orders' });
        if (!cancelled) setOrders(detail.orders);
      } catch (error) {
        console.error('Error loading bill orders:', error);
        showToast('Failed to load bill orders', 'error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill.id]);

  useEffect(() => {
    if (!orders || orders.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const results = await apiJson<Array<{ order_number: number; customer_name?: string }>>('/orders/shipping-info', { method: 'POST', body: orders!.map((o) => o.id).filter(Boolean), fallback: 'Failed to load customer details' });
        if (cancelled) return;
        setCustomerNames(new Map(results.map((r) => [r.order_number, r.customer_name || '-'])));
      } catch (error) {
        console.error('Error loading shipping info:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [orders]);

  async function downloadPdf() {
    setDownloading(true);
    try {
      const query = new URLSearchParams({ pickup_date: bill.pickupDateKey, courier: bill.courier });
      const response = await apiRequest(`/orders/courier-bill-summary-pdf?${query}`, { fallback: 'Failed to generate PDF' });
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `courier_summary_${bill.courier.replace(/\s+/g, '_')}_${bill.pickupDateKey}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast('Summary downloaded', 'success');
    } catch (error: any) {
      showToast(error?.message || 'Failed to download summary', 'error');
    } finally {
      setDownloading(false);
    }
  }

  const meta = BILL_STATUS_META[bill.status] || BILL_STATUS_META.unpaid;
  const stats = paymentProgressStats(bill);
  const stops = paymentProgressPieStops(stats);
  const pieBackground = `conic-gradient(${PAYMENT_PROGRESS_COLORS.received} 0% ${stops.receivedEnd}%, ${PAYMENT_PROGRESS_COLORS.returned} ${stops.receivedEnd}% ${stops.returnedEnd}%, ${PAYMENT_PROGRESS_COLORS.charges} ${stops.returnedEnd}% ${stops.chargesEnd}%, ${PAYMENT_PROGRESS_COLORS.taxes} ${stops.chargesEnd}% ${stops.taxesEnd}%, ${PAYMENT_PROGRESS_COLORS.remaining} ${stops.taxesEnd}% 100%)`;
  const rs = (v: number) => `Rs ${formatMoney(v)}`;
  const legend = (color: string, label: string, value: number, pct: number) => ({
    key: label,
    label: <InlineStack gap="200" blockAlign="center"><span className="progress-ring-legend__dot" style={{ background: color }} />{label}</InlineStack>,
    value: <>{rs(value)} <Text as="span" tone="subdued">({pct}%)</Text></>,
  });

  return (
    <div className="bill-detail-scroll">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Button icon={ArrowLeftIcon} onClick={onBack}>Back</Button>
            <BlockStack gap="050">
              <InlineStack gap="200" blockAlign="center"><Text as="h2" variant="headingMd">Bill Details</Text><Badge tone={meta.tone}>{meta.label}</Badge></InlineStack>
              <Text as="span" tone="subdued">{billPickupDateLabel(bill)} · {billCourierLabel(bill)} · {bill.totalOrders} order{bill.totalOrders === 1 ? '' : 's'}</Text>
            </BlockStack>
          </InlineStack>
          <Button icon={ExportIcon} loading={downloading} onClick={downloadPdf}>Download Summary (PDF)</Button>
        </InlineStack>

        <StatCardGrid columns={{ xs: 2, md: 3, lg: 5 }} tiles={[
          { label: 'Total Orders', value: String(bill.totalOrders), detail: `${bill.resolvedCount} resolved${bill.inTransitCount > 0 ? ` · ${bill.inTransitCount} in transit` : ''}` },
          { label: 'Bill Value', value: rs(bill.billValue) },
          { label: 'Advance Received', value: rs(bill.advanceTotal) },
          { label: 'Returned Orders', value: `- ${rs(bill.returnedTotal)}` },
          { label: 'Gross COD', value: rs(bill.grossCod) },
          { label: 'Total Delivery Charges', value: `- ${rs(bill.charges)}` },
          { label: 'Total Taxes (SST)', value: `- ${rs(bill.taxes)}` },
          { label: 'Net Receivable', value: rs(bill.netReceivable), tone: bill.netReceivable < 0 ? 'critical' : 'success' },
          { label: 'Total Cost Price', value: rs(bill.costTotal) },
        ]} />

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Financial Summary</Text>
              <KeyValueList rows={[
                { label: 'Bill Value', value: rs(bill.billValue) },
                { label: 'Less: Returned Orders', value: `- ${rs(bill.returnedTotal)}`, kind: 'deduction' },
                { label: 'Gross COD', value: rs(bill.grossCod), kind: 'subtotal' },
                { label: 'Less: Delivery Charges', value: `- ${rs(bill.charges)}`, kind: 'deduction' },
                { label: 'Less: Taxes (SST)', value: `- ${rs(bill.taxes)}`, kind: 'deduction' },
                { label: 'Net Receivable', value: rs(bill.netReceivable), kind: 'subtotal' },
                { label: 'Total Received', value: rs(bill.receivedAmount) },
                { label: 'Remaining', value: rs(bill.remainingAmount), kind: 'final' },
              ]} />
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Courier Summary</Text>
              <KeyValueList rows={[
                { label: 'Courier', value: billCourierLabel(bill) },
                { label: 'Pickup Date', value: billPickupDateLabel(bill) },
                { label: 'Total Parcels', value: String(bill.totalOrders) },
                { label: 'Resolved', value: String(bill.resolvedCount) },
                { label: 'In Transit', value: String(bill.inTransitCount) },
                { label: 'Settled', value: `${bill.settledCount} / ${bill.resolvedCount}` },
              ]} />
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Payment Progress</Text>
              <InlineStack gap="400" blockAlign="center" wrap={false}>
                <div className="progress-ring" style={{ background: pieBackground }}>
                  <div className="progress-ring__inner"><span className="progress-ring__pct">{stats.pct}%</span><span className="progress-ring__label">Settled</span></div>
                </div>
                <div style={{ flex: 1 }}>
                  <KeyValueList rows={[
                    legend('var(--text-muted)', 'Bill Value (Total Amount)', stats.billValue, 100),
                    legend(PAYMENT_PROGRESS_COLORS.received, 'Received', stats.received, stats.receivedPct),
                    legend(PAYMENT_PROGRESS_COLORS.returned, 'Returned Orders', stats.returned, stats.returnedPct),
                    legend(PAYMENT_PROGRESS_COLORS.charges, 'Delivery Charges', stats.charges, stats.chargesPct),
                    legend(PAYMENT_PROGRESS_COLORS.taxes, 'Taxes (SST)', stats.taxes, stats.taxesPct),
                    legend(PAYMENT_PROGRESS_COLORS.remaining, 'Remaining', stats.remaining, stats.remainingPct),
                  ]} />
                </div>
              </InlineStack>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Text as="h3" variant="headingSm">Orders in this Bill ({orders?.length ?? 0})</Text>
        <ReportTable
          headings={['Order #', 'Folio', 'Customer Name', 'Tracking ID', 'Status', 'Total', 'Advance', 'COD (Rs.)', 'Delivery Charge', 'Tax', 'Net Receivable', 'Cost Price', 'Settled']}
          numeric={[5, 6, 7, 8, 9, 10, 11]} emptyMessage={orders ? 'No orders' : 'Loading orders…'}
          rows={(orders || []).map((order) => {
            const status = order.order_status || '';
            const isResolved = COURIER_RESOLVED_STATUSES.has(status.toLowerCase());
            const receivable = isResolved ? computeReceivable(order as any) : null;
            return [
              String(order.order_number ?? ''), order.folio || '-', customerNames.get(order.order_number || -1) ?? '…', order.tracking_number || '-',
              <StatusBadge status={status} />, formatMoney(order.total_amount), formatMoney(order.advance_amount), formatMoney(computeCod(order)),
              formatMoney(order.delivery_charge), formatMoney(order.tax_amount), receivable != null ? formatMoney(receivable) : '-', formatMoney(order.cost_price),
              <Badge tone={order.is_order_settled ? 'success' : 'info'}>{order.is_order_settled ? 'Settled' : 'Unsettled'}</Badge>,
            ];
          })}
        />
      </BlockStack>
    </div>
  );
}

export function CourierPaymentReportPage() {
  const { showToast } = useToast();
  const [bills, setBills] = useState<CourierBill[]>([]);
  const [couriers, setCouriers] = useState<string[]>([]);
  const [courierFilter, setCourierFilter] = useState<string[] | null | undefined>(undefined); // undefined = not yet defaulted
  const [statusFilter, setStatusFilter] = useState<string[] | null>(null);
  const [dateRange, setDateRange] = useState<DateRange | null>(defaultRange());
  const [search, setSearch] = useState('');
  const [detailBill, setDetailBill] = useState<CourierBill | null>(null);
  const [fetchingSettlements, setFetchingSettlements] = useState(false);
  const [settlementsResult, setSettlementsResult] = useState<PostExSettlementsResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (dateRange) { params.append('date_from', dateRange.from); params.append('date_to', dateRange.to); }
    (courierFilter || []).forEach((c) => params.append('courier', c));
    (statusFilter || []).forEach((s) => params.append('payment_status', s));
    try {
      const rows = await apiJson<any[]>(`/courier-bills/?${params}`, { fallback: 'Failed to load courier payment report data' });
      const mapped = rows.map(mapCourierBillRow);
      setBills(mapped);
      setCouriers((prev) => [...new Set([...prev, ...mapped.map((b) => b.courier).filter(Boolean)])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
      // Default to PostEx alone once the courier list is known, for now the only courier
      // this report gets used for day to day - refetch once with it applied.
      if (courierFilter === undefined) {
        const list = [...new Set(mapped.map((b) => b.courier).filter(Boolean))];
        const postex = list.find((c) => c.toLowerCase() === 'postex');
        setCourierFilter(postex ? [postex] : null);
      }
    } catch (error) {
      console.error('Error loading courier payment report:', error);
      showToast('Failed to load courier payment report data', 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange, courierFilter, statusFilter, showToast]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bills;
    // Bill value is matched both formatted ("197,730.00") and bare ("197730") so a
    // typed amount hits whether or not the separators are included.
    return bills.filter((b) => [b.courier, billCourierLabel(b), billPickupDateLabel(b), b.pickupDateKey, formatMoney(b.billValue), String(b.billValue),
      b.status, BILL_STATUS_META[b.status]?.label ?? '']
      .some((field) => field.toLowerCase().includes(q))
      || (b.orders || []).some((o) => String(o.order_number ?? '').toLowerCase().includes(q)));
  }, [bills, search]);

  const summary = useMemo(() => courierPaymentReportSummary(visible), [visible]);

  async function fetchPostExSettlements() {
    setFetchingSettlements(true);
    try {
      // recheck_derived also revisits orders this endpoint settled earlier, so a corrected
      // derivation reaches rows written under the old one. CSV-settled rows are never touched.
      const data = await apiJson<PostExSettlementsResult & { updated?: number }>('/orders/fetch-postex-settlements?recheck_derived=true', {
        method: 'POST', fallback: 'Failed to fetch settlements',
      });
      showToast((data as any).message || `Settled ${(data as any).updated || 0} order(s).`, 'success');
      if ((data as any).updated > 0) await load();
      setSettlementsResult(data);
    } catch (error: any) {
      console.error('Error fetching PostEx settlements', error);
      showToast(error?.message || 'Failed to fetch PostEx settlements', 'error');
    } finally {
      setFetchingSettlements(false);
    }
  }

  function clearFilters() {
    setCourierFilter(null);
    setStatusFilter(null);
    setSearch('');
    setDateRange(defaultRange());
  }

  const columns: DataColumn<CourierBill>[] = [
    {
      key: 'pickupDate',
      heading: 'Date',
      // A bill's notes are its title where it has one - the pre-onboarding bill
      // ("Pre-onboarding remaining orders") is otherwise indistinguishable from
      // an ordinary dispatch on the same date.
      render: (b) => (b.notes ? (
        <BlockStack gap="050">
          <Text as="span">{billPickupDateLabel(b)}</Text>
          <Text as="span" tone="subdued" variant="bodySm">{b.notes}</Text>
        </BlockStack>
      ) : billPickupDateLabel(b)),
      sortValue: (b) => billDateSortValue(b),
    },
    { key: 'courier', heading: 'Courier', render: (b) => billCourierLabel(b), sortValue: (b) => b.courier },
    { key: 'billValue', heading: 'Bill Value', alignment: 'end', render: (b) => formatMoney(b.billValue), sortValue: (b) => b.billValue },
    { key: 'remainingAmount', heading: 'Remaining', alignment: 'end', render: (b) => formatMoney(b.remainingAmount), sortValue: (b) => b.remainingAmount },
    { key: 'settled', heading: 'Settled Orders', render: (b) => <SettledOrdersCell bill={b} />, sortValue: (b) => (b.totalOrders ? b.settledCount / b.totalOrders : 0) },
    { key: 'status', heading: 'Status', render: (b) => { const meta = BILL_STATUS_META[b.status] || BILL_STATUS_META.unpaid; return <Badge tone={meta.tone}>{meta.label}</Badge>; }, sortValue: (b) => b.status },
    { key: 'actions', heading: '', alignment: 'end', render: (b) => <Button icon={ViewIcon} size="slim" onClick={() => setDetailBill(b)}>View Details</Button> },
  ];

  usePageHeader({
    title: 'Courier Payment Report',
    actions: detailBill ? undefined : (
      <>
        <DateRangePopover value={dateRange} onChange={setDateRange} title="Filter by pickup date range" />
        <Dropdown multiple allLabel="All couriers" options={couriers} value={courierFilter === undefined ? null : courierFilter} onChange={setCourierFilter} />
        <Dropdown multiple allLabel="All Status" options={COURIER_PAYMENT_STATUSES.map((v) => ({ value: v, label: COURIER_PAYMENT_STATUS_LABELS[v] }))} value={statusFilter} onChange={setStatusFilter} />
        <HeaderButton onClick={clearFilters}>Clear Filters</HeaderButton>
        <HeaderButton loading={fetchingSettlements} onClick={fetchPostExSettlements}>Fetch Settlements</HeaderButton>
      </>
    ),
    search: detailBill ? undefined : { value: search, onChange: setSearch, placeholder: 'Search courier, date, bill value, status or order #...' },
  });

  if (detailBill) return <BillDetail bill={detailBill} onBack={() => setDetailBill(null)} />;

  return (
    <>
      <MetricsStrip
        label="Courier payment summary"
        tiles={[
          { label: 'Orders In Transit', value: summary.inTransit.toLocaleString(), detail: Object.entries(summary.inTransitByStatus).sort((a, b) => b[1] - a[1]).map(([s, c]) => `${c} ${s}`).join(' · ') || 'None in transit' },
          { label: 'Orders Resolved (Delivered/Returned)', value: summary.resolved.toLocaleString() },
          { label: 'Net Owed by Courier', value: summary.netOwed < 0 ? `-Rs ${formatMoney(-summary.netOwed)}` : `Rs ${formatMoney(summary.netOwed)}`, negative: summary.netOwed < 0, detail: summary.netOwed > 0 ? 'Courier owes you' : summary.netOwed < 0 ? 'You owe the courier' : 'Settled' },
        ]}
      />
      <DataTable
        columns={columns} rows={visible} rowId={(b) => b.id} loading={loading} initialSort={{ key: 'pickupDate', direction: 'descending' }}
        resourceName={{ singular: 'bill', plural: 'bills' }} emptyMessage="No courier bills in this range"
      />
      {settlementsResult && <PostExSettlementsModal data={settlementsResult} onClose={() => setSettlementsResult(null)} />}
    </>
  );
}
