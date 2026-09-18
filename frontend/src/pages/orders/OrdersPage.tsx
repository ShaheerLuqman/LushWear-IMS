// Orders view: metrics strip, status tabs, the AG Grid itself, period/date-range
// filtering, and the header toolbar. Ported from orders-grid.js, navigation.js's
// period/date-range init, and orders-shopify-ui.js.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import * as XLSX from 'xlsx';
import { apiJson, apiRequest } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { useConfirm } from '../../components/ConfirmContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { createDateRangePicker, type DateRangePickerHandle } from '../../dateRangePicker';
import { computeNetProfit, type Order } from '../../logic/orders';
import {
  ALL_ORDERS_VALUE, buildStaticPeriodOptions, CUSTOM_ORDERS_VALUE, formatOrdersDateRangeLabel,
  getCurrentOrdersPeriod, useOrdersData,
} from './useOrdersData';
import { buildOrdersGridColumns, calculateSelectedSums } from './ordersColumns';
import { BulkUpdateOrderModal } from './BulkUpdateOrderModal';
import { DeliveryStatusModal } from './DeliveryStatusModal';
import { DeliveryStatusReportModal } from './DeliveryStatusReportModal';
import { buildDeliveryStatusReport, deriveOrderStatusFromLatest, mergeDeliveryStatusData, type DeliveryReport } from '../../logic/deliveryStatus';
import { ORDERS_CHANGED_EVENT } from '../../eventsStream';
import { getLastOrdersSyncAt, ORDERS_SYNC_STATUS_CHANGED_EVENT } from '../../shopifySync';
import { formatRelativeTime } from '../../logic/shared';
import { useLedgersData } from '../finance/useLedgersData';
import { useLoadSheetLogs } from './useLoadSheetLogs';
import { GenerateLoadSheetModal } from './GenerateLoadSheetModal';
import { PackagingListModal } from './PackagingListModal';
import { UploadPostExModal } from './UploadPostExModal';
import { PostExUploadReportModal, type PostExUploadReportData } from './PostExUploadReportModal';

const ORDERS_VIEW_TABS = [
  { id: 'all', label: 'All', statuses: null as string[] | null },
  { id: 'unfulfilled', label: 'Unfulfilled', statuses: ['unfulfilled'] },
  { id: 'fulfilled', label: 'Fulfilled', statuses: ['fulfilled', 'RFD', 'CNA', 'ICA'] },
  { id: 'delivered', label: 'Delivered', statuses: ['delivered'] },
  { id: 'returned', label: 'Returned', statuses: ['returned'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];

function ordersRealRows(orders: Order[]): Order[] {
  return orders.filter((o) => o && o.id !== '__footer__');
}

function orderLineItemQty(order: Order): number {
  const lineItems = order.line_items;
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
  return lineItems.reduce((sum, li) => sum + (Number(li.qty) || 1), 0);
}

function compactRs(value: number): string {
  const v = Math.round(value || 0);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `Rs ${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `Rs ${Math.round(v / 1_000).toLocaleString('en-US')}K`;
  return `Rs ${v.toLocaleString('en-US')}`;
}

export function OrdersPage() {
  const { account, isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const fiscalMonthStartDay = account?.fiscal_month_start_day || 22;
  const {
    orders, setOrders, hasCachedOrders, loadAllOrders, loadOrdersForPeriod, loadOrdersForDateRange,
  } = useOrdersData();

  const [period, setPeriod] = useState<string>('');
  const [dateRange, setDateRange] = useState<{ from: string; to: string } | null>(null);
  const [activeTab, setActiveTab] = useState('all');
  const [selectedRows, setSelectedRows] = useState<Order[]>([]);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [moreActionsPos, setMoreActionsPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [bulkUpdateOpen, setBulkUpdateOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [deliveryStatusForId, setDeliveryStatusForId] = useState<string | null>(null);
  const [deliveryReport, setDeliveryReport] = useState<{ report: DeliveryReport; total: number } | null>(null);
  const [fetchingDeliveryStatus, setFetchingDeliveryStatus] = useState(false);
  const [loadSheetModalOpen, setLoadSheetModalOpen] = useState(false);
  const [packagingListModalOpen, setPackagingListModalOpen] = useState(false);
  const [uploadPostExModalOpen, setUploadPostExModalOpen] = useState(false);
  const [postExUploadReport, setPostExUploadReport] = useState<PostExUploadReportData | null>(null);

  const { ledgers, loadLedgersList } = useLedgersData();
  const { riderNames, nextAssignmentNumber, load: loadLoadSheetLogs } = useLoadSheetLogs();

  const gridApiRef = useRef<GridApi | null>(null);
  // "Fetch order by number" - a full order-number search with 0 grid results fetches that
  // order straight from the DB and injects it via applyTransaction, outside the `orders`
  // state (so it doesn't skew the metrics strip) - same as orders-grid.js's onFilterChanged.
  const fetchedByNumberIdsRef = useRef<Set<string>>(new Set());
  const fetchByNumberInFlightRef = useRef<string | null>(null);
  // Row highlight that follows the focused cell (click/arrow keys), toggled directly on the
  // row DOM rather than via rowClassRules+redrawRows, which would recreate the just-focused
  // cell and steal browser focus back to <body> - see orders-grid.js's onCellFocused.
  const focusedRowIdRef = useRef<string | null>(null);
  const autoFetchedDeliveryStatusRef = useRef(false);
  // State, not a plain ref: this page's own mount effects run before the setHeader
  // effect from usePageHeader() below, which is what actually mounts this button into
  // AppShell's header - a ref would still read null when the picker effect runs, so the
  // button would silently never get wired up (createDateRangePicker no-ops on a null element).
  const [dateRangeBtnNode, setDateRangeBtnNode] = useState<HTMLButtonElement | null>(null);
  const dateRangePickerRef = useRef<DateRangePickerHandle | null>(null);
  const moreActionsBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!moreActionsOpen) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest('.orders-more-actions')) setMoreActionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreActionsOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  }, [moreActionsOpen]);

  const ordersRef = useRef(orders);
  ordersRef.current = orders;

  // "Synced with Shopify X ago" - re-renders on a sync (ORDERS_SYNC_STATUS_CHANGED_EVENT)
  // and every 30s so the relative-time text keeps ticking forward.
  const [, forceSyncLabelTick] = useState(0);
  useEffect(() => {
    const tick = () => forceSyncLabelTick((n) => n + 1);
    window.addEventListener(ORDERS_SYNC_STATUS_CHANGED_EVENT, tick);
    const intervalId = setInterval(tick, 30000);
    return () => { window.removeEventListener(ORDERS_SYNC_STATUS_CHANGED_EVENT, tick); clearInterval(intervalId); };
  }, []);
  const lastOrdersSyncAt = getLastOrdersSyncAt();

  // Initial load: current period.
  useEffect(() => {
    const { month, year } = getCurrentOrdersPeriod(fiscalMonthStartDay);
    const key = `${month}-${year}`;
    setPeriod(key);
    loadOrdersForPeriod(month, year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rider-name suggestions + next assignment number for the Generate Load Sheet modal.
  useEffect(() => { loadLoadSheetLogs(); }, [loadLoadSheetLogs]);

  const saveOrderField = useCallback((orderId: string, field: string, value: unknown) => {
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, [field]: value } : o)));
    (async () => {
      try {
        const updated = await apiJson<Order>(`/orders/${orderId}`, { method: 'PUT', body: { [field]: value }, fallback: `Failed to update ${field}` });
        if (field === 'advance_amount' && updated && updated.advance_status !== undefined) {
          setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, advance_status: updated.advance_status } : o)));
        }
        showToast(`Order ${field.replace('_', ' ')} updated`, 'success');
      } catch (error: any) {
        console.error(`Error saving ${field}:`, error);
        showToast(`Failed to save ${field}`, 'error');
      }
    })();
  }, [setOrders, showToast]);

  const confirmActionOnTerminalOrders = useCallback(async (orderNumbers: Array<string | number>, actionLabel: string, statuses: string[] = ['delivered', 'returned']) => {
    const wanted = new Set(orderNumbers.map(String));
    const already = ordersRef.current
      .filter((o) => o && o.id !== '__footer__' && wanted.has(String(o.order_number)) && statuses.includes((o.order_status || '').toLowerCase()))
      .map((o) => o.order_number!);
    if (already.length === 0) return true;
    const list = [...already].sort((a, b) => a - b).join(', ');
    const statusLabel = statuses.join(' or ');
    return confirm({
      title: `Order already ${statusLabel}`,
      message: `${already.length} order(s) are already ${statusLabel}: ${list}.\n\nAre you sure you want to ${actionLabel}?`,
      confirmText: 'Continue',
      danger: true,
    });
  }, [confirm]);

  const columnDefs = useMemo(() => buildOrdersGridColumns({
    isEditingAllowed,
    saveOrderField,
    confirmActionOnTerminalOrders,
    getOrders: () => ordersRef.current,
  }), [isEditingAllowed, saveOrderField, confirmActionOnTerminalOrders]);

  const defaultColDef = useMemo(() => ({
    sortable: true, resizable: true, filter: true, floatingFilter: true, minWidth: 70,
    suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressFloatingFilterButton: true,
    floatingFilterComponentParams: { suppressFilterButton: true },
  }), []);

  const footerRow = useMemo(() => {
    if (selectedRows.length === 0) return [];
    const sums = calculateSelectedSums(selectedRows);
    return [{
      id: '__footer__', order_number: null, courier: null, tracking_number: null, order_status: null,
      delivery_status: null, piece_received: null, order_receiving_date: null, final_status: null,
      ...sums,
    }];
  }, [selectedRows]);

  function onGridReady(e: GridReadyEvent) {
    gridApiRef.current = e.api;
  }

  function onSelectionChanged() {
    const api = gridApiRef.current;
    if (!api) return;
    // Deselect any row that no longer passes the active filter - e.g. after filtering to a
    // status while other rows were already selected.
    const filteredIds = new Set<string>();
    api.forEachNodeAfterFilter((node) => { if (node.data && node.data.id !== '__footer__') filteredIds.add(node.id!); });
    api.getSelectedNodes().forEach((node) => {
      if (node.data && node.data.id !== '__footer__' && !filteredIds.has(node.id!)) node.setSelected(false);
    });
    setSelectedRows(api.getSelectedRows().filter((r) => r.id !== '__footer__'));
  }

  async function fetchOrderByNumber(orderNumber: string) {
    const api = gridApiRef.current;
    if (!api || fetchByNumberInFlightRef.current === orderNumber) return;
    fetchByNumberInFlightRef.current = orderNumber;
    try {
      const order = await apiJson<Order | null>(`/orders/by-number/${encodeURIComponent(orderNumber)}`, { fallback: 'Failed to fetch order from database' });
      if (order && order.id) {
        fetchedByNumberIdsRef.current.add(order.id);
        api.applyTransaction({ add: [order], addIndex: 0 });
        showToast(`Order #${orderNumber} loaded from database`, 'success');
      }
    } catch (e: any) {
      if (e?.status === 404) showToast(`Order #${orderNumber} not found in database`, 'info');
      else showToast('Failed to fetch order from database', 'error');
    } finally {
      fetchByNumberInFlightRef.current = null;
    }
  }

  function onFilterChanged() {
    const api = gridApiRef.current;
    if (!api) return;
    const model = (api.getFilterModel() || {}).order_status;
    const values = model && Array.isArray(model.values) ? [...model.values].sort() : null;
    if (!values) setActiveTab('all');
    else {
      const match = ORDERS_VIEW_TABS.find((t) => t.statuses && [...t.statuses].sort().join(',') === values.join(','));
      setActiveTab(match ? match.id : '');
    }

    // Temporarily-added "fetch by number" rows: drop them once the Order # filter is
    // cleared/changed. Order numbers start at 1000, so a full number is 4+ digits.
    const orderNumFilter = (api.getFilterModel() || {}).order_number;
    const filterValue = orderNumFilter && orderNumFilter.filter != null ? String(orderNumFilter.filter).trim() : '';
    const isFullOrderNumber = /^\d{4,}$/.test(filterValue);

    function removeFetchedByNumberRows() {
      if (fetchedByNumberIdsRef.current.size === 0) return;
      const toRemove: any[] = [];
      api!.forEachNode((node) => {
        if (node.data && node.data.id !== '__footer__' && fetchedByNumberIdsRef.current.has(node.data.id)) toRemove.push(node.data);
      });
      if (toRemove.length) api!.applyTransaction({ remove: toRemove });
      fetchedByNumberIdsRef.current.clear();
    }

    if (!isFullOrderNumber) { removeFetchedByNumberRows(); return; }
    if (api.getDisplayedRowCount() > 0) return; // already showing a match (real or fetched) - no-op
    removeFetchedByNumberRows();
    fetchOrderByNumber(filterValue);
  }

  function applyViewTab(tabId: string) {
    const api = gridApiRef.current;
    if (!api) return;
    const tab = ORDERS_VIEW_TABS.find((t) => t.id === tabId) || ORDERS_VIEW_TABS[0];
    const model = { ...(api.getFilterModel() || {}) };
    if (tab.statuses) model.order_status = { values: tab.statuses.slice() };
    else delete model.order_status;
    api.setFilterModel(model);
    setActiveTab(tab.id);
  }

  // Metrics strip + tab counts, derived from the currently loaded `orders` (not the grid's
  // own filtered view - the strip always summarizes the whole loaded period).
  const metrics = useMemo(() => {
    const rows = ordersRealRows(orders);
    let items = 0, cod = 0, delivered = 0, returned = 0, cancelled = 0, netProfit = 0;
    for (const order of rows) {
      const status = (order.order_status || '').toLowerCase();
      if (status === 'cancelled') { cancelled += 1; continue; }
      items += orderLineItemQty(order);
      if (status === 'delivered') delivered += 1;
      else if (status === 'returned') returned += 1;
      else cod += (parseFloat(String(order.total_amount)) || 0) - (parseFloat(String(order.advance_amount)) || 0);
      const rowProfit = computeNetProfit(order);
      if (rowProfit != null) netProfit += rowProfit;
    }
    return { orders: rows.length - cancelled, items, cod, delivered, returned, cancelled, netProfit };
  }, [orders]);

  const tabCounts = useMemo(() => {
    const rows = ordersRealRows(orders);
    const counts: Record<string, number> = { all: rows.length };
    ORDERS_VIEW_TABS.forEach((t) => { if (t.statuses) counts[t.id] = 0; });
    for (const order of rows) {
      const status = order.order_status || '';
      for (const tab of ORDERS_VIEW_TABS) {
        if (tab.statuses && tab.statuses.includes(status)) counts[tab.id] += 1;
      }
    }
    return counts;
  }, [orders]);

  const reload = useCallback(async () => {
    const api = gridApiRef.current;
    if (api) api.showLoadingOverlay();
    if (period === ALL_ORDERS_VALUE) await loadAllOrders();
    else if (period === CUSTOM_ORDERS_VALUE && dateRange) await loadOrdersForDateRange(dateRange.from, dateRange.to);
    else if (period) {
      const [month, year] = period.split('-').map(Number);
      await loadOrdersForPeriod(month, year);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, dateRange]);

  // Live push from the backend (app/routes/events.py) whenever an order changes anywhere
  // in the app, any user - refreshes this grid instead of waiting on a manual reload.
  useEffect(() => {
    const onOrdersChanged = () => { reload(); };
    window.addEventListener(ORDERS_CHANGED_EVENT, onOrdersChanged);
    return () => window.removeEventListener(ORDERS_CHANGED_EVENT, onOrdersChanged);
  }, [reload]);

  // Period <select> + Date range button wiring.
  async function onPeriodChange(value: string) {
    setPeriod(value);
    if (value !== CUSTOM_ORDERS_VALUE) {
      setDateRange(null);
      dateRangePickerRef.current?.setClearable(false);
    }
    const api = gridApiRef.current;
    if (api && !hasCachedOrders(value)) api.showLoadingOverlay();
    if (value === ALL_ORDERS_VALUE) await loadAllOrders();
    else if (value !== CUSTOM_ORDERS_VALUE) {
      const [month, year] = value.split('-').map(Number);
      await loadOrdersForPeriod(month, year);
    }
  }

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    if (orders.length === 0) api.showNoRowsOverlay(); else api.hideOverlay();
  }, [orders]);

  useEffect(() => {
    if (!dateRangeBtnNode) return;
    const handle = createDateRangePicker(dateRangeBtnNode, {
      presets: undefined,
      onSelect: async (from, to) => {
        setDateRange({ from, to });
        setPeriod(CUSTOM_ORDERS_VALUE);
        handle?.setLabel('Range set', formatOrdersDateRangeLabel(from, to));
        handle?.setClearable(true);
        const api = gridApiRef.current;
        if (api) api.showLoadingOverlay();
        await loadOrdersForDateRange(from, to);
      },
      onClear: async () => {
        setDateRange(null);
        handle?.picker.clear();
        handle?.setLabel('Date range', 'Filter by date range');
        handle?.setClearable(false);
        const { month, year } = getCurrentOrdersPeriod(fiscalMonthStartDay);
        setPeriod(`${month}-${year}`);
        const api = gridApiRef.current;
        if (api) api.showLoadingOverlay();
        await loadOrdersForPeriod(month, year);
      },
    });
    dateRangePickerRef.current = handle;
    return () => handle?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRangeBtnNode]);

  function toggleFullscreen() {
    const next = !fullscreen;
    setFullscreen(next);
    document.body.classList.toggle('orders-table-fullscreen', next);
    if (next && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (!next && document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && document.body.classList.contains('orders-table-fullscreen')) {
        setFullscreen(false);
        document.body.classList.remove('orders-table-fullscreen');
      }
    }
    // Also sync when the browser itself leaves fullscreen (F11, or its own Esc banner) -
    // not just our own Escape keydown handler above.
    function onFullscreenChange() {
      if (!document.fullscreenElement && document.body.classList.contains('orders-table-fullscreen')) {
        setFullscreen(false);
        document.body.classList.remove('orders-table-fullscreen');
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  function exportToExcel() {
    const api = gridApiRef.current;
    if (!api) return;
    const columns = (api.getAllGridColumns() || []).map((col) => {
      const colDef: any = col.getColDef ? col.getColDef() : null;
      if (colDef?.checkboxSelection) return null;
      const field = colDef?.field || col.getColId?.();
      const header = colDef?.headerName || field;
      if (!header) return null;
      return { field, header, col };
    }).filter(Boolean) as Array<{ field: string; header: string; col: any }>;
    const rows: Record<string, unknown>[] = [];
    api.forEachNodeAfterFilterAndSort((node) => {
      if (!node?.data) return;
      const out: Record<string, unknown> = {};
      for (const c of columns) {
        let value = api.getValue(c.col, node);
        if (value == null) { out[c.header] = ''; continue; }
        const colDef = c.col.getColDef?.();
        if (colDef?.valueFormatter && typeof colDef.valueFormatter === 'function') {
          value = colDef.valueFormatter({ value, data: node.data });
        }
        out[c.header] = Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : value;
      }
      rows.push(out);
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Orders');
    XLSX.writeFile(workbook, `inventory-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast('Excel exported (1 sheet)', 'success');
    setMoreActionsOpen(false);
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 60000);
  }

  async function generateInvoice() {
    setMoreActionsOpen(false);
    const rows = selectedRows.filter((r) => r.order_number);
    if (rows.length === 0) { showToast('Please select at least one order', 'error', { silent: true }); return; }
    try {
      const res = await apiRequest('/orders/generate-invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows.map((r) => r.id)),
        fallback: 'Failed to generate invoice',
      });
      const blob = await res.blob();
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const filename = `invoice_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
      const url = window.URL.createObjectURL(blob);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => window.URL.revokeObjectURL(url), 60000);
      showToast(`Invoice generated (${rows.length} order(s))`, 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to generate invoice', 'error');
    }
  }

  async function printAirwayBills() {
    setMoreActionsOpen(false);
    const rows = selectedRows.filter((r) => r.order_number);
    const eligible = rows.filter((o) => {
      const c = (o.courier || '').trim().toUpperCase();
      return (c === 'POSTEX' || c === 'COURIERS NEXT') && !!o.tracking_number;
    });
    if (eligible.length === 0) { showToast('No selected orders have an airway bill available', 'error'); return; }
    const skipped = rows.length - eligible.length;
    try {
      const postexOrders = eligible.filter((o) => (o.courier || '').trim().toUpperCase() === 'POSTEX');
      const cnOrders = eligible.filter((o) => (o.courier || '').trim().toUpperCase() === 'COURIERS NEXT');
      const cnTab = cnOrders.length > 0 ? window.open('', '_blank') : null;
      if (postexOrders.length > 0) {
        const res = await apiRequest('/orders/postex-airway-bills', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(postexOrders.map((o) => o.id)),
          fallback: 'Failed to fetch airway bills',
        });
        const blob = await res.blob();
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        downloadBlob(blob, `airway_bills_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`);
      }
      if (cnOrders.length > 0) {
        const { url } = await apiJson<{ url: string }>('/orders/couriers-next-airway-bills', { method: 'POST', body: cnOrders.map((o) => o.id), fallback: 'Failed to fetch airway bills' });
        if (cnTab && !cnTab.closed) cnTab.location.href = url;
      }
      showToast(`Airway bills ready${skipped > 0 ? ` (${skipped} order(s) skipped - not fulfilled or unsupported courier)` : ''}`, 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to print airway bills', 'error');
    }
  }

  function applyDeliveryStatusUpdate(orderId: string, merged: any) {
    setOrders((prev) => prev.map((o) => {
      if (o.id !== orderId) return o;
      const derivedStatus = deriveOrderStatusFromLatest(merged);
      const next: Order = { ...o, delivery_status: merged };
      if (derivedStatus) {
        next.order_status = derivedStatus;
        if (derivedStatus === 'delivered' && (o.piece_received || '').trim().toLowerCase() === 'pending') next.piece_received = 'Done';
      }
      return next;
    }));
  }

  // Silently refresh delivery status for non-terminal PostEx/Couriers Next orders from the
  // last 2 months, once per visit right after orders finish their first load - a background
  // top-up, same as delivery-status.js's autoFetchRecentDeliveryStatus (there fired once at
  // app boot; here once per Orders page visit, since data now loads per-route not at boot).
  useEffect(() => {
    if (autoFetchedDeliveryStatusRef.current || orders.length === 0) return;
    autoFetchedDeliveryStatusRef.current = true;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 2);
    const toFetch = ordersRealRows(orders).filter((order) => {
      const status = (order.order_status || '').toLowerCase();
      if (status === 'delivered' || status === 'returned' || status === 'cancelled') return false;
      const courierNormalized = (order.courier || '').trim().toUpperCase();
      if (courierNormalized !== 'POSTEX' && courierNormalized !== 'COURIERS NEXT') return false;
      const track = (order.tracking_number || '').trim();
      if (!track || track === '-') return false;
      const raw = order.order_receiving_date || order.created_at;
      const date = raw ? new Date(raw) : null;
      return !!date && !isNaN(date.getTime()) && date >= cutoff;
    });
    if (toFetch.length === 0) return;
    (async () => {
      try {
        const results = await apiJson<Array<{ order_id: string; delivery_status?: any; error?: string }>>('/orders/delivery-status/bulk?save=true', {
          method: 'POST', body: toFetch.map((o) => o.id), fallback: 'Failed to fetch delivery status',
        });
        const resultsById = new Map(results.map((r) => [r.order_id, r]));
        for (const order of toFetch) {
          const result = resultsById.get(order.id);
          if (!result || result.error) continue;
          applyDeliveryStatusUpdate(order.id, mergeDeliveryStatusData(order.delivery_status as any, result.delivery_status));
        }
      } catch (error) {
        console.error('Auto delivery status fetch failed:', error);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  function onGridContainerClick(e: ReactMouseEvent) {
    const btn = (e.target as HTMLElement).closest('.grid-delivery-refresh-btn') as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    const id = btn.dataset.refreshOrderId;
    if (id) setDeliveryStatusForId(id);
  }

  /** Live-fetch delivery status for selected orders (skipping cancelled and anything not on
   * PostEx/Couriers Next with a tracking number), then always show the report. */
  async function fetchDeliveryStatusSelected() {
    setMoreActionsOpen(false);
    const selected = selectedRows.filter((row) => (row.order_status || '').toLowerCase() !== 'cancelled');
    if (selected.length === 0) {
      showToast('Select orders to fetch delivery status for', 'warning', { silent: true });
      return;
    }
    const fetchable = selected.filter((row) => {
      const courierNormalized = (row.courier || '').trim().toUpperCase();
      const track = (row.tracking_number || '').trim();
      return (courierNormalized === 'POSTEX' || courierNormalized === 'COURIERS NEXT') && track && track !== '-';
    });
    if (fetchable.length === 0) {
      setDeliveryReport({ report: buildDeliveryStatusReport(selected), total: selected.length });
      return;
    }
    setFetchingDeliveryStatus(true);
    try {
      const results = await apiJson<Array<{ order_id: string; delivery_status?: any; error?: string }>>('/orders/delivery-status/bulk?save=true', {
        method: 'POST', body: fetchable.map((o) => o.id), fallback: 'Failed to fetch delivery status',
      });
      const resultsById = new Map(results.map((r) => [r.order_id, r]));
      let updated = 0, failed = 0;
      const updatedSelected = selected.map((row) => {
        const result = resultsById.get(row.id);
        if (!result) return row;
        if (result.error) { failed++; return row; }
        const merged = mergeDeliveryStatusData(row.delivery_status as any, result.delivery_status);
        applyDeliveryStatusUpdate(row.id, merged);
        updated++;
        const derivedStatus = deriveOrderStatusFromLatest(merged);
        const next: Order = { ...row, delivery_status: merged };
        if (derivedStatus) {
          next.order_status = derivedStatus;
          if (derivedStatus === 'delivered' && (row.piece_received || '').trim().toLowerCase() === 'pending') next.piece_received = 'Done';
        }
        return next;
      });
      showToast(`Delivery status fetched for ${updated} order${updated === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, failed && !updated ? 'error' : 'success');
      setDeliveryReport({ report: buildDeliveryStatusReport(updatedSelected), total: updatedSelected.length });
    } catch (error: any) {
      showToast(error?.message || 'Failed to fetch delivery status', 'error');
    } finally {
      setFetchingDeliveryStatus(false);
    }
  }

  usePageHeader({
    title: 'Orders',
    actions: (
      <>
        {lastOrdersSyncAt != null && (
          <span className="orders-sync-status" title="Orders sync automatically from Shopify every 30 minutes">
            Synced with Shopify {formatRelativeTime(lastOrdersSyncAt)}
          </span>
        )}
        <div className="orders-period-filter-wrap header-inline">
          <label htmlFor="ordersPeriodFilter" className="orders-period-filter-label">Period:</label>
          <select id="ordersPeriodFilter" className="orders-period-filter" value={period} onChange={(e) => onPeriodChange(e.target.value)}>
            <option value={ALL_ORDERS_VALUE}>Recent Orders</option>
            {buildStaticPeriodOptions(fiscalMonthStartDay).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            {period === CUSTOM_ORDERS_VALUE && dateRange && (
              <option value={CUSTOM_ORDERS_VALUE}>{formatOrdersDateRangeLabel(dateRange.from, dateRange.to)}</option>
            )}
          </select>
        </div>
        <div className="orders-date-range-wrap header-inline">
          <button ref={setDateRangeBtnNode} className="btn btn-secondary header-toolbar-btn" title="Filter by date range">Date range</button>
        </div>
        <div className={'orders-more-actions' + (moreActionsOpen ? ' open' : '')}>
          <button
            ref={moreActionsBtnRef}
            type="button" className="btn btn-secondary header-toolbar-btn" aria-haspopup="true" aria-expanded={moreActionsOpen}
            onClick={() => {
              if (!moreActionsOpen && moreActionsBtnRef.current) {
                const rect = moreActionsBtnRef.current.getBoundingClientRect();
                setMoreActionsPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 220) });
              }
              setMoreActionsOpen((v) => !v);
            }}
          >
            <span>More actions</span><span className="orders-more-actions__caret" aria-hidden="true" />
          </button>
          {moreActionsOpen && (
            <div className="orders-more-actions__menu" role="menu" style={moreActionsPos}>
              <button type="button" className="orders-more-actions__item" role="menuitem" disabled={fetchingDeliveryStatus} onClick={fetchDeliveryStatusSelected}>Track Delivery Status</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={() => { setMoreActionsOpen(false); setBulkUpdateOpen(true); }}>Bulk update order</button>
              <button
                type="button" className="orders-more-actions__item" role="menuitem"
                onClick={() => { setMoreActionsOpen(false); loadLedgersList(); setUploadPostExModalOpen(true); }}
              >
                Upload PostEx CSV
              </button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={() => { setMoreActionsOpen(false); setLoadSheetModalOpen(true); }}>Generate Load Sheet</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={() => { setMoreActionsOpen(false); setPackagingListModalOpen(true); }}>Generate Packaging List</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={generateInvoice}>Generate Invoice</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={printAirwayBills}>Print Airway Bills</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={exportToExcel}>Export Data to Excel</button>
            </div>
          )}
        </div>
        <div className="header-orders-app-actions" role="group" aria-label="App security and view">
          <button
            type="button" className="btn btn-secondary header-toolbar-btn header-toolbar-btn-icon-only header-orders-app-actions-btn"
            title="Full screen (Esc to exit)" onClick={toggleFullscreen}
          >
            <span className="header-fullscreen-icon" aria-hidden="true">&#x26F6;</span>
          </button>
        </div>
      </>
    ),
  });

  return (
    <>
      <div className="orders-metrics-strip" role="group" aria-label="Order summary">
        {[
          { label: 'Orders', value: metrics.orders.toLocaleString('en-US') },
          { label: 'Items ordered', value: metrics.items.toLocaleString('en-US') },
          { label: 'COD to collect', value: compactRs(metrics.cod) },
          { label: 'Delivered', value: metrics.delivered.toLocaleString('en-US') },
          { label: 'Returned', value: metrics.returned.toLocaleString('en-US') },
          { label: 'Net profit', value: compactRs(metrics.netProfit), negative: metrics.netProfit < 0 },
        ].map((t) => (
          <div className="orders-metric" key={t.label}>
            <span className="orders-metric__label">{t.label}</span>
            <span className={'orders-metric__value' + (t.negative ? ' orders-metric__value--neg' : '')}>{t.value}</span>
          </div>
        ))}
      </div>
      <div className="orders-table-card">
        <div className="orders-view-tabs" role="tablist" aria-label="Filter orders by status">
          {ORDERS_VIEW_TABS.map((t) => (
            <button
              type="button" key={t.id} className={'orders-view-tab' + (activeTab === t.id ? ' active' : '')}
              role="tab" aria-selected={activeTab === t.id} onClick={() => applyViewTab(t.id)}
            >
              <span className="orders-view-tab__label">{t.label}</span>
              <span className="orders-view-tab__count">{(tabCounts[t.id] ?? '').toLocaleString?.('en-US') ?? tabCounts[t.id]}</span>
            </button>
          ))}
        </div>
        <div className="ag-theme-alpine grid-container" onClick={onGridContainerClick}>
          <AgGridReact
            columnDefs={columnDefs}
            rowData={orders}
            rowSelection="multiple"
            suppressRowClickSelection
            pinnedBottomRowData={footerRow}
            defaultColDef={defaultColDef}
            animateRows={false}
            pagination={false}
            domLayout="normal"
            suppressCellFocus={false}
            stopEditingWhenCellsLoseFocus
            singleClickEdit
            getRowId={(p) => p.data.id}
            getRowStyle={(p) => {
              if (p.data.id === '__footer__') return { backgroundColor: 'var(--bg-secondary, #f5f5f5)', borderTop: '2px solid var(--primary, #007bff)', fontWeight: 'bold' } as any;
              const status = (p.data.order_status || '').toLowerCase();
              if (status === 'cancelled') return { opacity: '0.5', textDecoration: 'line-through' } as any;
              return undefined;
            }}
            rowClassRules={{ 'orders-row-focused': (p) => !!p.data && p.data.id === focusedRowIdRef.current }}
            onCellFocused={(p) => {
              const api = p.api;
              if (!api) return;
              const node = (!p.rowPinned && p.rowIndex != null) ? api.getDisplayedRowAtIndex(p.rowIndex) : null;
              const nextId = (node && node.data && node.data.id !== '__footer__') ? node.id! : null;
              const prevId = focusedRowIdRef.current;
              if (nextId === prevId) return;
              focusedRowIdRef.current = nextId;
              if (prevId != null) document.querySelector(`.ag-row[row-id="${CSS.escape(String(prevId))}"]`)?.classList.remove('orders-row-focused');
              if (nextId != null) document.querySelector(`.ag-row[row-id="${CSS.escape(String(nextId))}"]`)?.classList.add('orders-row-focused');
            }}
            onGridReady={onGridReady}
            onFilterChanged={onFilterChanged}
            onSelectionChanged={onSelectionChanged}
            onCellValueChanged={onSelectionChanged}
          />
        </div>
      </div>
      {selectedRows.length > 0 && (
        <div className="orders-selected-count">{selectedRows.length} row(s) selected</div>
      )}
      <BulkUpdateOrderModal
        open={bulkUpdateOpen}
        onClose={() => setBulkUpdateOpen(false)}
        onChanged={reload}
        gridApi={gridApiRef.current}
        prefill={selectedRows.filter((r) => r.order_number).map((r) => r.order_number).join('\n')}
        orders={orders}
      />
      {deliveryStatusForId && (() => {
        const order = orders.find((o) => o.id === deliveryStatusForId);
        if (!order) return null;
        return (
          <DeliveryStatusModal
            orderId={order.id}
            courier={order.courier}
            trackingNumber={order.tracking_number}
            existing={order.delivery_status as any}
            onClose={() => setDeliveryStatusForId(null)}
            onUpdated={(merged) => applyDeliveryStatusUpdate(order.id, merged)}
          />
        );
      })()}
      {deliveryReport && (
        <DeliveryStatusReportModal
          report={deliveryReport.report}
          total={deliveryReport.total}
          onClose={() => setDeliveryReport(null)}
          onViewOrder={(order) => { setDeliveryReport(null); setDeliveryStatusForId(order.id); }}
        />
      )}
      {loadSheetModalOpen && (
        <GenerateLoadSheetModal
          initialOrderNumbers={selectedRows.filter((r) => r.order_number).map((r) => r.order_number!)}
          riderNames={riderNames}
          nextAssignmentNumber={nextAssignmentNumber}
          onClose={() => setLoadSheetModalOpen(false)}
          onDone={loadLoadSheetLogs}
        />
      )}
      {packagingListModalOpen && (
        <PackagingListModal
          initialOrderNumbers={selectedRows.filter((r) => r.order_number).map((r) => r.order_number!)}
          onClose={() => setPackagingListModalOpen(false)}
        />
      )}
      {uploadPostExModalOpen && (
        <UploadPostExModal
          ledgers={ledgers}
          onClose={() => setUploadPostExModalOpen(false)}
          onUploaded={setPostExUploadReport}
        />
      )}
      {postExUploadReport && (
        <PostExUploadReportModal data={postExUploadReport} onClose={() => setPostExUploadReport(null)} />
      )}
    </>
  );
}
