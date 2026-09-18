// Print Airway Bill: fulfilled PostEx/Couriers Next orders for a fulfillment-date
// range, each with a Print action plus a header button to print the whole selection
// at once. Ported from print-airway-bill.js.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton, HeaderRefButton } from '../../components/HeaderButton';
import { createDateRangePicker, type DateRangePickerHandle } from '../../dateRangePicker';
import { formatDateDDMMYYYY, getCourierDisplayName, rowMatchesQuery } from '../../logic/shared';
import { formatMoney } from '../../logic/ledgers';
import { printAirwayBillsForOrders } from '../../logic/airwayBills';
import type { Order } from '../../logic/orders';
import { Dropdown } from '../../components/Dropdown';

function todayIso(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function PrintAirwayBillPage() {
  const { showToast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>({ from: todayIso(), to: todayIso() });
  const [courier, setCourier] = useState('PostEx');
  const [search, setSearch] = useState('');
  const [printing, setPrinting] = useState<string | null>(null);
  const [dateBtnNode, setDateBtnNode] = useState<HTMLButtonElement | null>(null);
  const pickerRef = useRef<DateRangePickerHandle | null>(null);
  const [dateLabel, setDateLabel] = useState('Date range');

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (dateRange.from) params.append('date_from', dateRange.from);
    if (dateRange.to) params.append('date_to', dateRange.to);
    if (courier) params.append('courier', courier);
    try {
      const rows = await apiJson<Order[]>(`/orders/airway-bill-list?${params}`, { fallback: 'Failed to load fulfilled orders' });
      setOrders(rows);
      const ids = new Set(rows.map((o) => o.id));
      setSelectedIds((prev) => new Set([...prev].filter((id) => ids.has(id))));
    } catch (error: any) {
      console.error('Error loading airway bill list:', error);
      showToast(error?.message || 'Failed to load fulfilled orders', 'error');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [dateRange, courier]);

  useEffect(() => {
    if (!dateBtnNode) return;
    const handle = createDateRangePicker(dateBtnNode, {
      onSelect: (from, to) => {
        setDateRange({ from, to });
        setDateLabel(`${formatDateDDMMYYYY(from)} – ${formatDateDDMMYYYY(to)}`);
        handle?.setClearable(true);
      },
      onClear: () => {
        setDateRange({ from: '', to: '' });
        setDateLabel('Date range');
        handle?.picker.clear();
        handle?.setClearable(false);
      },
    });
    pickerRef.current = handle;
    return () => handle?.destroy();
  }, [dateBtnNode]);

  const visible = useMemo(() => orders.filter((o) => rowMatchesQuery(o, search)), [orders, search]);

  function clearFilters() {
    setCourier('PostEx');
    setSearch('');
    setDateRange({ from: todayIso(), to: todayIso() });
    setDateLabel('Date range');
    pickerRef.current?.picker.clear();
    pickerRef.current?.setClearable(false);
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(visible.map((o) => o.id)) : new Set());
  }

  async function printOne(order: Order) {
    setPrinting(order.id);
    try {
      await printAirwayBillsForOrders([order]);
    } catch (error: any) {
      showToast(error?.message || 'Failed to print airway bill', 'error');
    } finally {
      setPrinting(null);
    }
  }

  async function printSelected() {
    const selected = orders.filter((o) => selectedIds.has(o.id));
    const targets = selected.length ? selected : visible;
    if (targets.length === 0) { showToast('No orders to print', 'error', { silent: true }); return; }
    try {
      const skipped = await printAirwayBillsForOrders(targets);
      showToast(`Airway bills ready${skipped > 0 ? ` (${skipped} order(s) skipped)` : ''}`, 'success');
    } catch (error: any) {
      showToast(error?.message || 'Failed to print airway bills', 'error');
    }
  }

  usePageHeader({
    title: 'Print Airway Bill',
    search: { value: search, onChange: setSearch, placeholder: 'Search order #, name, phone or tracking...' },
    actions: (
      <>
        <HeaderRefButton ref={setDateBtnNode} label={dateLabel} title="Filter by fulfillment date range" />
        <Dropdown options={['PostEx', 'Couriers Next']} value={courier} onChange={setCourier} />
        <HeaderButton onClick={clearFilters}>Clear Filters</HeaderButton>
        <HeaderButton variant="primary" icon={<i className="fa-solid fa-print" />} onClick={printSelected}>Print Airway Bill</HeaderButton>
      </>
    ),
  });

  const allSelected = visible.length > 0 && visible.every((o) => selectedIds.has(o.id));
  const someSelected = !allSelected && visible.some((o) => selectedIds.has(o.id));

  return (
    <div className="fulfillment-body">
      <div className="fulfillment-table-panel">
        <div className="fulfillment-table-toolbar">
          <label className="fulfillment-select-all">
            <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected; }} onChange={(e) => toggleSelectAll(e.target.checked)} />
            <span>Select all</span>
          </label>
          <button type="button" className="fulfillment-link-btn" onClick={() => setSelectedIds(new Set())}>Clear Selection</button>
          <div className="fulfillment-table-toolbar-spacer" />
          <span className="fulfillment-toolbar-stat">Total Orders: {orders.length}</span>
          {selectedIds.size > 0 && <span className="fulfillment-toolbar-badge">{selectedIds.size} selected</span>}
        </div>
        <div className="fulfillment-table-wrap">
          <table className="fulfillment-table">
            <thead>
              <tr>
                <th className="fulfillment-col-check"><input type="checkbox" checked={allSelected} onChange={(e) => toggleSelectAll(e.target.checked)} /></th>
                <th>Order ID</th><th>Customer Name</th><th className="print-awb-col-address">Complete Address</th>
                <th>Mobile Number</th><th>City</th><th className="fulfillment-th-cod">COD (PKR)</th>
                <th>Tracking ID</th><th>Courier</th><th>Status</th><th className="fulfillment-col-actions">Airway Bill</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="empty-state">Loading fulfilled orders…</td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={11} className="empty-state">No fulfilled orders for this date range.</td></tr>
              ) : visible.map((o: any) => (
                <tr key={o.id} className={selectedIds.has(o.id) ? 'fulfillment-row--selected' : ''}>
                  <td className="fulfillment-col-check">
                    <input type="checkbox" checked={selectedIds.has(o.id)} onChange={(e) => setSelectedIds((prev) => { const next = new Set(prev); if (e.target.checked) next.add(o.id); else next.delete(o.id); return next; })} />
                  </td>
                  <td className="fulfillment-col-orderid"><span className="fulfillment-order-id">#{o.order_number}</span></td>
                  <td className="fulfillment-col-name" title={o.customer_name}>{o.customer_name}</td>
                  <td className="print-awb-col-address" title={o.customer_address}>{o.customer_address}</td>
                  <td>{o.customer_phone}</td>
                  <td>{o.customer_city}</td>
                  <td className="fulfillment-col-cod">{formatMoney(o.cod)}</td>
                  <td>{o.tracking_number}</td>
                  <td>{getCourierDisplayName(o)}</td>
                  <td><span className="grid-status-badge grid-status-fulfilled">Fulfilled</span></td>
                  <td className="fulfillment-actions-cell">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={printing === o.id} onClick={() => printOne(o)}><i className="fa-solid fa-print" /> Print</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
