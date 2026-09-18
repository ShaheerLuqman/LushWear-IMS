// Courier Payment Report: what the courier still owes for delivered/returned orders,
// grouped by pickup date + courier, plus its bill-detail screen. Ported from
// courier-payment-report.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridApi, GridReadyEvent } from 'ag-grid-community';
import { apiJson, apiRequest } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { SearchField } from '../../components/SearchField';
import { HeaderButton, HeaderRefButton } from '../../components/HeaderButton';
import { createDateRangePicker, type DateRangePickerHandle } from '../../dateRangePicker';
import { Dropdown } from '../../components/Dropdown';
import { formatDateDDMMYYYY } from '../../logic/shared';
import { formatMoney } from '../../logic/ledgers';
import { computeReceivable, orderStatusBadgeClass } from '../../logic/orders';
import {
  BILL_STATUS_META, COURIER_PAYMENT_STATUSES, COURIER_PAYMENT_STATUS_LABELS, COURIER_RESOLVED_STATUSES,
  billCourierLabel, billPickupDateLabel, computeCod, courierPaymentReportSummary, mapCourierBillRow,
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
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>PostEx settlements</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-description">{data.message || ''} Checked {data.checked || 0} order(s); total receivable across the {rows.length} listed: {totalReceivable.toFixed(2)}.</p>
          <div className="postex-mismatches-table-wrap">
            <table className="postex-mismatches-table">
              <thead>
                <tr><th>Order #</th><th>Folio</th><th>Status</th><th>Settlement date</th><th>Invoice</th><th>Delivery charge</th><th>Tax</th><th>Receivable</th></tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.order_number}{r.corrected ? <em> (corrected)</em> : null}</td>
                    <td>{r.folio || '-'}</td>
                    <td>{r.order_status}</td>
                    <td>{formatPostExDate(r.settlement_date)}</td>
                    <td>{num(r.invoice_payment)}</td>
                    <td>{num(r.delivery_charge)}</td>
                    <td>{num(r.tax_amount)}</td>
                    <td>{num(r.receivable)}</td>
                  </tr>
                )) : <tr><td colSpan={8}>No orders were ready to settle.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="modal-description">
            {rows.length ? 'Tax is derived from the order value (2% income + 2% sales withholding); PostEx does not report it. Uploading the CPR CSV later replaces it with the exact figures.' : ''}
          </p>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function SettledOrdersCell({ bill }: { bill: CourierBill }) {
  const pct = bill.totalOrders > 0 ? Math.round((bill.settledCount / bill.totalOrders) * 100) : 0;
  return (
    <div className="payment-progress-cell-wrap">
      <div className="payment-progress">
        <div className="payment-progress__row">
          <span className="payment-progress__amounts">{bill.settledCount} / {bill.totalOrders} Orders</span>
          <span className="payment-progress__pct">{pct}%</span>
        </div>
        <div className="payment-progress__bar"><div className="payment-progress__segment payment-progress__segment--received" style={{ width: `${pct}%` }} /></div>
      </div>
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
  const netColor = bill.netReceivable < 0 ? 'var(--danger)' : 'var(--success)';
  const stats = paymentProgressStats(bill);
  const stops = paymentProgressPieStops(stats);
  const pieBackground = `conic-gradient(${PAYMENT_PROGRESS_COLORS.received} 0% ${stops.receivedEnd}%, ${PAYMENT_PROGRESS_COLORS.returned} ${stops.receivedEnd}% ${stops.returnedEnd}%, ${PAYMENT_PROGRESS_COLORS.charges} ${stops.returnedEnd}% ${stops.chargesEnd}%, ${PAYMENT_PROGRESS_COLORS.taxes} ${stops.chargesEnd}% ${stops.taxesEnd}%, ${PAYMENT_PROGRESS_COLORS.remaining} ${stops.taxesEnd}% 100%)`;

  const legend = (color: string, label: string, value: number, pct: number) => (
    <div className="progress-ring-legend__item" key={label}>
      <span className="progress-ring-legend__label"><span className="progress-ring-legend__dot" style={{ background: color }} />{label}</span>
      <span className="progress-ring-legend__value">Rs {formatMoney(value)} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({pct}%)</span></span>
    </div>
  );
  const summaryRow = (label: string, value: string, opts: { total?: boolean; color?: string; bold?: boolean } = {}) => (
    <div className={'bill-detail-summary-row' + (opts.total ? ' bill-detail-summary-row--total' : '')} key={label}>
      <span>{label}</span><span style={{ color: opts.color, fontWeight: opts.bold ? 700 : undefined }}>{value}</span>
    </div>
  );
  const courierRow = (label: string, value: string | number) => (
    <div className="bill-detail-summary-row" key={label}><span>{label}</span><span>{value}</span></div>
  );

  return (
    <div className="bill-detail-scroll">
      <div className="bill-detail-header">
        <div className="bill-detail-header-top">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}><i className="fa-solid fa-arrow-left" /> Back</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={downloading} onClick={downloadPdf}><i className="fa-solid fa-download" /> Download Summary (PDF)</button>
        </div>
        <div className="bill-detail-title-row">
          <h2 className="bill-detail-title">Bill Details</h2>
          <span className={`grid-status-badge ${meta.cls}`}>{meta.label}</span>
        </div>
        <p className="bill-detail-subtitle">{billPickupDateLabel(bill)} · {billCourierLabel(bill)} · {bill.totalOrders} order{bill.totalOrders === 1 ? '' : 's'}</p>
      </div>

      <div className="stats-grid bill-detail-stats-grid">
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total Orders</span><span className="stat-detail">{bill.resolvedCount} resolved{bill.inTransitCount > 0 ? ` · ${bill.inTransitCount} in transit` : ''}</span><span className="stat-value">{bill.totalOrders}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Bill Value</span><span className="stat-value">Rs {formatMoney(bill.billValue)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Advance Received</span><span className="stat-value">Rs {formatMoney(bill.advanceTotal)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Returned Orders</span><span className="stat-value">- Rs {formatMoney(bill.returnedTotal)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Gross COD</span><span className="stat-value">Rs {formatMoney(bill.grossCod)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total Delivery Charges</span><span className="stat-value">- Rs {formatMoney(bill.charges)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total Taxes (SST)</span><span className="stat-value">- Rs {formatMoney(bill.taxes)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Net Receivable</span><span className="stat-value" style={{ color: netColor }}>Rs {formatMoney(bill.netReceivable)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total Cost Price</span><span className="stat-value">Rs {formatMoney(bill.costTotal)}</span></div></div>
      </div>

      <div className="bill-detail-summary-grid">
        <div className="bill-detail-card">
          <h3>Financial Summary</h3>
          <div>
            {summaryRow('Bill Value', `Rs ${formatMoney(bill.billValue)}`)}
            {summaryRow('Less: Returned Orders', `- Rs ${formatMoney(bill.returnedTotal)}`)}
            {summaryRow('Gross COD', `Rs ${formatMoney(bill.grossCod)}`, { total: true })}
            {summaryRow('Less: Delivery Charges', `- Rs ${formatMoney(bill.charges)}`)}
            {summaryRow('Less: Taxes (SST)', `- Rs ${formatMoney(bill.taxes)}`)}
            {summaryRow('Net Receivable', `Rs ${formatMoney(bill.netReceivable)}`, { total: true, color: 'var(--text-primary)' })}
            {summaryRow('Total Received', `Rs ${formatMoney(bill.receivedAmount)}`)}
            {summaryRow('Remaining', `Rs ${formatMoney(bill.remainingAmount)}`, { color: '#7c3aed', bold: true })}
          </div>
        </div>
        <div className="bill-detail-card">
          <h3>Courier Summary</h3>
          <div>
            {courierRow('Courier', billCourierLabel(bill))}
            {courierRow('Pickup Date', billPickupDateLabel(bill))}
            {courierRow('Total Parcels', bill.totalOrders)}
            {courierRow('Resolved', bill.resolvedCount)}
            {courierRow('In Transit', bill.inTransitCount)}
            {courierRow('Settled', `${bill.settledCount} / ${bill.resolvedCount}`)}
          </div>
        </div>
        <div className="bill-detail-card">
          <h3>Payment Progress</h3>
          <div className="bill-detail-progress-ring-wrap">
            <div className="progress-ring" style={{ background: pieBackground }}>
              <div className="progress-ring__inner"><span className="progress-ring__pct">{stats.pct}%</span><span className="progress-ring__label">Settled</span></div>
            </div>
            <div className="progress-ring-legend">
              {legend('var(--text-muted)', 'Bill Value (Total Amount)', stats.billValue, 100)}
              {legend(PAYMENT_PROGRESS_COLORS.received, 'Received', stats.received, stats.receivedPct)}
              {legend(PAYMENT_PROGRESS_COLORS.returned, 'Returned Orders', stats.returned, stats.returnedPct)}
              {legend(PAYMENT_PROGRESS_COLORS.charges, 'Delivery Charges', stats.charges, stats.chargesPct)}
              {legend(PAYMENT_PROGRESS_COLORS.taxes, 'Taxes (SST)', stats.taxes, stats.taxesPct)}
              {legend(PAYMENT_PROGRESS_COLORS.remaining, 'Remaining', stats.remaining, stats.remainingPct)}
            </div>
          </div>
        </div>
      </div>

      <div className="bill-detail-orders-section">
        <h3>Orders in this Bill ({orders?.length ?? 0})</h3>
        <div className="postex-mismatches-table-wrap">
          <table className="postex-mismatches-table">
            <thead>
              <tr>
                <th>Order #</th><th>Folio</th><th>Customer Name</th><th>Tracking ID</th><th>Status</th><th>Total</th>
                <th>Advance</th><th>COD (Rs.)</th><th>Delivery Charge</th><th>Tax</th><th>Net Receivable</th><th>Cost Price</th><th>Settled</th>
              </tr>
            </thead>
            <tbody>
              {!orders ? (
                <tr><td colSpan={13}>Loading orders…</td></tr>
              ) : orders.map((order) => {
                const status = order.order_status || '';
                const isResolved = COURIER_RESOLVED_STATUSES.has(status.toLowerCase());
                const receivable = isResolved ? computeReceivable(order as any) : null;
                const cod = computeCod(order);
                return (
                  <tr key={order.id}>
                    <td>{order.order_number ?? ''}</td>
                    <td>{order.folio || '-'}</td>
                    <td>{customerNames.get(order.order_number || -1) ?? <span className="btn-loading-spinner" />}</td>
                    <td>{order.tracking_number || '-'}</td>
                    <td><span className={`grid-status-badge ${orderStatusBadgeClass(status)}`}>{status}</span></td>
                    <td>{formatMoney(order.total_amount)}</td>
                    <td>{formatMoney(order.advance_amount)}</td>
                    <td>{formatMoney(cod)}</td>
                    <td>{formatMoney(order.delivery_charge)}</td>
                    <td>{formatMoney(order.tax_amount)}</td>
                    <td>{receivable != null ? formatMoney(receivable) : '-'}</td>
                    <td>{formatMoney(order.cost_price)}</td>
                    <td>{order.is_order_settled
                      ? <span className="grid-status-badge grid-status-delivered">Settled</span>
                      : <span className="grid-status-badge grid-status-fulfilled">Unsettled</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function CourierPaymentReportPage() {
  const { showToast } = useToast();
  const [bills, setBills] = useState<CourierBill[]>([]);
  const [couriers, setCouriers] = useState<string[]>([]);
  const [courierFilter, setCourierFilter] = useState<string[] | null | undefined>(undefined); // undefined = not yet defaulted
  const [statusFilter, setStatusFilter] = useState<string[] | null>(null);
  const [dateRange, setDateRange] = useState(defaultRange());
  const [dateLabel, setDateLabel] = useState('Date range');
  const [search, setSearch] = useState('');
  const [detailBill, setDetailBill] = useState<CourierBill | null>(null);
  const [fetchingSettlements, setFetchingSettlements] = useState(false);
  const [settlementsResult, setSettlementsResult] = useState<PostExSettlementsResult | null>(null);
  const [dateBtnNode, setDateBtnNode] = useState<HTMLButtonElement | null>(null);
  const pickerRef = useRef<DateRangePickerHandle | null>(null);
  const gridApiRef = useRef<GridApi | null>(null);

  const load = useCallback(async () => {
    gridApiRef.current?.showLoadingOverlay();
    const params = new URLSearchParams();
    if (dateRange.from) params.append('date_from', dateRange.from);
    if (dateRange.to) params.append('date_to', dateRange.to);
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
      gridApiRef.current?.hideOverlay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange, courierFilter, statusFilter, showToast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!dateBtnNode) return;
    const handle = createDateRangePicker(dateBtnNode, {
      onSelect: (from, to) => { setDateRange({ from, to }); setDateLabel(`${formatDateDDMMYYYY(from)} – ${formatDateDDMMYYYY(to)}`); handle?.setClearable(true); },
      onClear: () => { setDateRange({ from: '', to: '' }); setDateLabel('Date range'); handle?.picker.clear(); handle?.setClearable(false); },
    });
    pickerRef.current = handle;
    return () => handle?.destroy();
  }, [dateBtnNode]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bills;
    return bills.filter((b) => b.courier.toLowerCase().includes(q) || (b.orders || []).some((o) => String(o.order_number ?? '').toLowerCase().includes(q)));
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
    setDateLabel('Date range');
    pickerRef.current?.picker.clear();
    pickerRef.current?.setClearable(false);
  }

  const columnDefs: ColDef[] = useMemo(() => [
    { headerName: 'Date', field: 'pickupDate', width: 110, minWidth: 110, valueFormatter: (p: any) => billPickupDateLabel(p.data) },
    {
      headerName: 'Courier', field: 'courier', width: 130, minWidth: 110, valueFormatter: (p: any) => billCourierLabel(p.data),
      cellRenderer: (p: any) => <span>{billCourierLabel(p.data)}</span>,
    },
    { headerName: 'Bill Value', field: 'billValue', width: 140, minWidth: 130, cellClass: 'ag-right-aligned-cell', valueFormatter: (p: any) => formatMoney(p.value) },
    { headerName: 'Remaining', field: 'remainingAmount', width: 140, minWidth: 130, cellClass: 'ag-right-aligned-cell', valueFormatter: (p: any) => formatMoney(p.value) },
    { headerName: 'Settled Orders', colId: 'settledOrders', field: 'settledCount', width: 300, minWidth: 240, cellRenderer: (p: any) => <SettledOrdersCell bill={p.data} /> },
    {
      headerName: 'Status', field: 'status', width: 130, minWidth: 120,
      cellRenderer: (p: any) => { const meta = BILL_STATUS_META[p.value] || BILL_STATUS_META.unpaid; return <span className={`grid-status-badge ${meta.cls}`}>{meta.label}</span>; },
    },
    {
      headerName: 'Actions', colId: 'viewOrders', width: 130, minWidth: 130, sortable: false, filter: false,
      cellRenderer: (p: any) => (
        <div className="bill-cell-center"><button type="button" className="bill-view-btn" title="View orders in this bill" onClick={() => setDetailBill(p.data)}><i className="fa-solid fa-eye" /><span>View Details</span></button></div>
      ),
    },
  ], []);

  usePageHeader({
    title: 'Courier Payment Report',
    actions: detailBill ? undefined : (
      <>
        <HeaderRefButton ref={setDateBtnNode} label={dateLabel} title="Filter by pickup date range" />
        <Dropdown multiple allLabel="All couriers" options={couriers} value={courierFilter === undefined ? null : courierFilter} onChange={setCourierFilter} />
        <Dropdown multiple allLabel="All Status" options={COURIER_PAYMENT_STATUSES.map((v) => ({ value: v, label: COURIER_PAYMENT_STATUS_LABELS[v] }))} value={statusFilter} onChange={setStatusFilter} />
        <div className="toolbar-search"><SearchField placeholder="Search courier or order #..." value={search} onChange={setSearch} /></div>
        <HeaderButton onClick={clearFilters}>Clear Filters</HeaderButton>
        <HeaderButton loading={fetchingSettlements} onClick={fetchPostExSettlements}>Fetch Settlements</HeaderButton>
      </>
    ),
  });

  if (detailBill) return <BillDetail bill={detailBill} onBack={() => setDetailBill(null)} />;

  function onGridReady(e: GridReadyEvent) { gridApiRef.current = e.api; }

  return (
    <>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Orders In Transit</span><span className="stat-detail">{Object.entries(summary.inTransitByStatus).sort((a, b) => b[1] - a[1]).map(([s, c]) => `${c} ${s}`).join(' · ') || 'None in transit'}</span><span className="stat-value">{summary.inTransit.toLocaleString()}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Orders Resolved (Delivered/Returned)</span><span className="stat-value">{summary.resolved.toLocaleString()}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Net Owed by Courier</span><span className="stat-detail">{summary.netOwed > 0 ? 'Courier owes you' : summary.netOwed < 0 ? 'You owe the courier' : 'Settled'}</span><span className="stat-value" style={{ color: summary.netOwed < 0 ? 'var(--danger)' : undefined }}>{summary.netOwed < 0 ? `-Rs ${formatMoney(-summary.netOwed)}` : `Rs ${formatMoney(summary.netOwed)}`}</span></div></div>
      </div>
      <div className="ag-theme-alpine grid-container">
        <AgGridReact
          columnDefs={columnDefs} rowData={visible} rowHeight={74}
          defaultColDef={{ sortable: true, resizable: true, filter: true, minWidth: 90 }}
          pagination={false} domLayout="normal" getRowId={(p) => p.data.id} onGridReady={onGridReady}
        />
      </div>
      {settlementsResult && <PostExSettlementsModal data={settlementsResult} onClose={() => setSettlementsResult(null)} />}
    </>
  );
}
