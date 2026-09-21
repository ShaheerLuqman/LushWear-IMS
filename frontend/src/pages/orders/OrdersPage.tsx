// Orders view: metrics strip, a Polaris IndexTable (Shopify's own orders-list component)
// with its IndexFilters (search + status tabs + filter chips), period/date-range filtering,
// and the header toolbar.
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import * as XLSX from 'xlsx';
import {
  IndexTable, IndexFilters, useSetIndexFiltersMode, useIndexResourceState,
  IndexTableSelectionType, InlineStack, TextField, Text, Tooltip, Pagination,
} from '@shopify/polaris';
import { BarcodeIcon, MaximizeIcon } from '@shopify/polaris-icons';
import { useNavigate } from 'react-router-dom';
import { Filter, FilterX } from 'lucide-react';
import { apiJson, apiRequest } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { useConfirm } from '../../components/ConfirmContext';
import { Dropdown } from '../../components/Dropdown';
import { MetricsStrip } from '../../components/MetricsStrip';
import { HeaderButton } from '../../components/HeaderButton';
import { useStickyIndexTableHeader } from '../../components/useStickyIndexTableHeader';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { DateRangePopover, type DateRange } from '../../components/DateRangePopover';
import {
  computeNetProfit, FINAL_STATUS_VALUES, ORDER_STATUS_VALUES, orderStatusDisplayLabel, type Order,
} from '../../logic/orders';
import { getCourierDisplayName, rowMatchesQuery } from '../../logic/shared';
import { AnalyticsDeltaBadge } from '../../logic/analyticsCharts';
import {
  ALL_ORDERS_VALUE, buildStaticPeriodOptions, CUSTOM_ORDERS_VALUE, formatOrdersDateRangeLabel,
  getCurrentOrdersPeriod, ORDERS_PERIOD_OLDEST_MONTH, ORDERS_PERIOD_OLDEST_YEAR, previousOrdersPeriod, useOrdersData,
} from './useOrdersData';
import {
  ORDERS_COLUMNS, PIECE_RECEIVED_VALUES, calculateSelectedSums, type OrdersColumnCtx, type OrdersColumnDef, type SelectionSums,
} from './ordersPolarisColumns';
import { BulkUpdateOrderModal } from './BulkUpdateOrderModal';
import { DeliveryStatusModal } from './DeliveryStatusModal';
import { DeliveryStatusReportModal } from './DeliveryStatusReportModal';
import { buildDeliveryStatusReport, deriveOrderStatusFromLatest, mergeDeliveryStatusData, type DeliveryReport } from '../../logic/deliveryStatus';
import { ORDERS_CHANGED_EVENT } from '../../eventsStream';
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

const PAGE_SIZE = 100;

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

function computeOrderMetrics(rows: Order[]) {
  let items = 0, total = 0, delivered = 0, returned = 0, cancelled = 0, netProfit = 0;
  for (const order of rows) {
    const status = (order.order_status || '').toLowerCase();
    if (status === 'cancelled') { cancelled += 1; continue; }
    items += orderLineItemQty(order);
    total += parseFloat(String(order.total_amount)) || 0;
    if (status === 'delivered') delivered += 1;
    else if (status === 'returned') returned += 1;
    const rowProfit = computeNetProfit(order);
    if (rowProfit != null) netProfit += rowProfit;
  }
  return { orders: rows.length - cancelled, items, total, delivered, returned, cancelled, netProfit };
}

const AGGREGATE_SUM_KEYS: Partial<Record<string, keyof SelectionSums>> = {
  total_amount: 'total_amount', advance_amount: 'advance_amount', cod: 'cod',
  delivery_charge: 'delivery_charge', tax_amount: 'tax_amount', receivable: 'receivable',
  cost_price: 'cost_price', net_profit: 'net_profit',
};

/* Aggregate row cells: a sum under every numeric column, blank under the rest
   (order #, courier, status, folio, ...) rather than the old horizontal summary bar. */
function aggregateCell(col: OrdersColumnDef, sums: SelectionSums): React.ReactNode {
  if (col.key === 'profit_percent') {
    return sums.profit_percent == null ? null : (
      <Text as="span" alignment="end" numeric fontWeight="semibold">{sums.profit_percent.toFixed(1)}%</Text>
    );
  }
  const sumKey = AGGREGATE_SUM_KEYS[col.key];
  if (!sumKey) return null;
  return (
    <Text as="span" alignment="end" numeric fontWeight="semibold">
      {(sums[sumKey] as number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </Text>
  );
}

/* Selecting a row re-renders OrdersPage, which would otherwise re-run every column's render()
   (several are live TextField/Select inputs) for all PAGE_SIZE rows just to flip one checkbox.
   Memoized so only the row whose `selected` actually changed re-renders - columnCtx is itself
   memoized above, so unrelated rows' props are reference-equal and this fully bails out. */
const OrderRow = memo(function OrderRow({
  order, index, selected, tone, columnCtx,
}: { order: Order; index: number; selected: boolean; tone: 'subdued' | undefined; columnCtx: OrdersColumnCtx }) {
  return (
    <IndexTable.Row id={order.id} position={index} selected={selected} tone={tone} onClick={() => {}}>
      {ORDERS_COLUMNS.map((col) => (
        <IndexTable.Cell key={col.key}>{col.render(order, columnCtx)}</IndexTable.Cell>
      ))}
    </IndexTable.Row>
  );
});

export function OrdersPage() {
  const { account, isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const fiscalMonthStartDay = account?.fiscal_month_start_day || 22;
  const {
    orders, setOrders, hasCachedOrders, loadAllOrders, loadOrdersForPeriod, loadOrdersForDateRange,
  } = useOrdersData();

  const [period, setPeriod] = useState<string>('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [prevOrders, setPrevOrders] = useState<Order[]>([]);
  const [hasPrevPeriod, setHasPrevPeriod] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [columnFilters, setColumnFilters] = useState<Record<string, string | string[]>>({});
  const [showFilterRow, setShowFilterRow] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ index: number; direction: 'ascending' | 'descending' } | null>(null);
  const [page, setPage] = useState(0);
  const [tableLoading, setTableLoading] = useState(false);
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
  const { mode, setMode } = useSetIndexFiltersMode();

  const ordersRef = useRef(orders);
  ordersRef.current = orders;

  // "Fetch order by number" - a full order-number search with 0 results fetches that order
  // straight from the DB and injects it into `orders` (outside loadOrders*, so it doesn't
  // skew the metrics strip) - same behaviour as the old orders-grid.js/AG Grid version.
  const fetchedByNumberIdsRef = useRef<Set<string>>(new Set());
  const fetchByNumberInFlightRef = useRef<string | null>(null);


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
    const already = ordersRealRows(ordersRef.current)
      .filter((o) => wanted.has(String(o.order_number)) && statuses.includes((o.order_status || '').toLowerCase()))
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

  const runOrderAction = useCallback(async (order: Order, action: 'unbook' | 'cancel', prompt: { title: string; message: string; confirmText: string }) => {
    if (!await confirm({ ...prompt, danger: true })) return;
    try {
      const result = await apiJson<{ order_status: string }>(`/orders/${order.id}/${action}`, { method: 'POST', fallback: `Failed to ${action} order` });
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, order_status: result.order_status } : o)));
      showToast(`Order #${order.order_number} ${action === 'unbook' ? 'unbooked' : 'cancelled'}`, 'success');
    } catch (error: any) {
      showToast(error?.message || `Failed to ${action} order`, 'error');
    }
  }, [confirm, setOrders, showToast]);

  // Single-row versions of the Bulk update modal's actions - same endpoints, one order number.
  const bulkForOne = useCallback(async (order: Order, path: string, body: Record<string, unknown>, patch: Partial<Order>, done: string) => {
    try {
      await apiJson(path, { method: 'POST', body: { order_numbers: [order.order_number], ...body }, fallback: `Failed to ${done.toLowerCase()} order` });
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, ...patch } : o)));
      showToast(`Order #${order.order_number} ${done.toLowerCase()}`, 'success');
    } catch (error: any) {
      showToast(error?.message || `Failed to ${done.toLowerCase()} order`, 'error');
    }
  }, [setOrders, showToast]);

  const columnCtx: OrdersColumnCtx = useMemo(() => ({
    isEditingAllowed,
    saveOrderField,
    confirmActionOnTerminalOrders,
    onRefreshDelivery: (orderId) => setDeliveryStatusForId(orderId),
    onSetStatus: async (order, status, pieceReceived) => {
      const label = pieceReceived ? 'mark it Returned + Piece Received' : `mark it ${status === 'delivered' ? 'Delivered' : 'Returned'}`;
      const conflicting = pieceReceived ? ['delivered'] : ['delivered', 'returned'].filter((s) => s !== status);
      if (!await confirmActionOnTerminalOrders([order.order_number!], label, conflicting)) return;
      await bulkForOne(order, '/orders/bulk-update-status',
        { order_status: status, ...(pieceReceived ? { piece_received: 'Received' } : {}) },
        { order_status: status, ...(pieceReceived ? { piece_received: 'Received' } : {}) },
        pieceReceived ? 'Marked returned + piece received' : `Marked ${status}`);
    },
    onSetSettled: (order, settled) => bulkForOne(order, '/orders/bulk-update-order-settled',
      { is_order_settled: settled }, { is_order_settled: settled }, settled ? 'Marked settled' : 'Marked unsettled'),
    onUnbook: (order) => runOrderAction(order, 'unbook', {
      title: `Unbook order #${order.order_number}?`,
      message: `This cancels the Shopify fulfillment and clears the ${getCourierDisplayName(order)} booking (${order.tracking_number || 'no tracking number'}) so the order can be booked again.\n\nThe parcel itself is not cancelled with the courier.`,
      confirmText: 'Unbook',
    }),
    onCancel: (order) => runOrderAction(order, 'cancel', {
      title: `Cancel order #${order.order_number}?`,
      message: 'This cancels the order on Shopify (and its fulfillment, if any) and marks it cancelled here. Any courier booking stays on record.',
      confirmText: 'Cancel order',
    }),
  }), [isEditingAllowed, saveOrderField, confirmActionOnTerminalOrders, runOrderAction, bulkForOne]);

  function removeFetchedByNumberRows() {
    if (fetchedByNumberIdsRef.current.size === 0) return;
    const ids = fetchedByNumberIdsRef.current;
    setOrders((prev) => prev.filter((o) => !ids.has(o.id)));
    fetchedByNumberIdsRef.current.clear();
  }

  async function fetchOrderByNumber(orderNumber: string) {
    if (fetchByNumberInFlightRef.current === orderNumber) return;
    fetchByNumberInFlightRef.current = orderNumber;
    try {
      const order = await apiJson<Order | null>(`/orders/by-number/${encodeURIComponent(orderNumber)}`, { fallback: 'Failed to fetch order from database' });
      if (order && order.id) {
        fetchedByNumberIdsRef.current.add(order.id);
        setOrders((prev) => [order, ...prev]);
        showToast(`Order #${orderNumber} loaded from database`, 'success');
      }
    } catch (e: any) {
      if (e?.status === 404) showToast(`Order #${orderNumber} not found in database`, 'info');
      else showToast('Failed to fetch order from database', 'error');
    } finally {
      fetchByNumberInFlightRef.current = null;
    }
  }

  // Order-number auto-fetch: when the order # column filter holds a full order number
  // (4+ digits) that matches nothing currently loaded, pull it straight from the DB.
  const orderNumberFilter = String(columnFilters.order_number || '').trim();
  useEffect(() => {
    const isFullOrderNumber = /^\d{4,}$/.test(orderNumberFilter);
    if (!isFullOrderNumber) { removeFetchedByNumberRows(); return; }
    const hasMatch = ordersRealRows(ordersRef.current).some((o) => String(o.order_number) === orderNumberFilter);
    if (hasMatch) return;
    const t = setTimeout(() => { removeFetchedByNumberRows(); fetchOrderByNumber(orderNumberFilter); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderNumberFilter]);

  // Metrics strip + tab counts, derived from the currently loaded `orders` (not the current
  // filter/search - the strip always summarizes the whole loaded period).
  const metrics = useMemo(() => computeOrderMetrics(ordersRealRows(orders)), [orders]);
  const prevMetrics = useMemo(() => computeOrderMetrics(ordersRealRows(prevOrders)), [prevOrders]);

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

  const courierOptions = useMemo(() => {
    const names = new Set<string>();
    ordersRealRows(orders).forEach((o) => names.add(getCourierDisplayName(o)));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [orders]);

  const activeTabDef = ORDERS_VIEW_TABS.find((t) => t.id === activeTab) || ORDERS_VIEW_TABS[0];

  const filteredOrders = useMemo(() => {
    let rows = ordersRealRows(orders).filter((o) => rowMatchesQuery(o, search));
    if (activeTabDef.statuses) rows = rows.filter((o) => activeTabDef.statuses!.includes(o.order_status || ''));
    // The order # column filter doubles as the old global search box did: it matches
    // order number, tracking number, or folio, not just the order_number field.
    const orderNumberQuery = orderNumberFilter.toLowerCase();
    if (orderNumberQuery) {
      rows = rows.filter((o) => String(o.order_number || '').includes(orderNumberQuery)
        || (o.tracking_number || '').toLowerCase().includes(orderNumberQuery)
        || (o.folio || '').toLowerCase().includes(orderNumberQuery));
    }
    const SELECT_FILTER_KEYS = new Set(['courier', 'order_status', 'piece_received', 'final_status']);
    const CONTAINS_FILTER_KEYS = new Set(['folio']);
    for (const [key, raw] of Object.entries(columnFilters)) {
      if (key === 'order_number') continue;
      if (!Array.isArray(raw) && !raw) continue;
      const col = ORDERS_COLUMNS.find((c) => c.key === key);
      if (!col?.sortValue) continue;
      if (SELECT_FILTER_KEYS.has(key)) {
        const values = Array.isArray(raw) ? raw : [raw];
        rows = rows.filter((o) => values.includes(String(col.sortValue!(o))));
      } else if (CONTAINS_FILTER_KEYS.has(key)) {
        rows = rows.filter((o) => String(col.sortValue!(o)).toLowerCase().includes(String(raw).toLowerCase()));
      } else {
        const target = parseFloat(String(raw));
        if (!isNaN(target)) rows = rows.filter((o) => Math.abs((col.sortValue!(o) as number) - target) < 0.01);
      }
    }
    if (sort) {
      const col = ORDERS_COLUMNS[sort.index];
      if (col?.sortValue) {
        const dir = sort.direction === 'ascending' ? 1 : -1;
        rows = [...rows].sort((a, b) => {
          const av = col.sortValue!(a);
          const bv = col.sortValue!(b);
          const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
          return cmp * dir;
        });
      }
    }
    return rows;
  }, [orders, search, activeTabDef, columnFilters, sort]);

  const pageCount = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE));
  const pageRows = filteredOrders.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const hasAnyOrders = ordersRealRows(orders).length > 0;

  useEffect(() => { setPage(0); }, [activeTab, columnFilters]);
  useEffect(() => { if (page > pageCount - 1) setPage(pageCount - 1); }, [page, pageCount]);

  const {
    selectedResources, allResourcesSelected, handleSelectionChange, clearSelection,
  } = useIndexResourceState(pageRows as unknown as Array<Order & { [key: string]: unknown }>, {
    resourceIDResolver: (o) => o.id,
  });

  const selectedRows = useMemo(() => orders.filter((o) => selectedResources.includes(o.id)), [orders, selectedResources]);

  function selectOrderNumbers(orderNumbers: number[]): { matched: number; notFound: string[] } {
    const wanted = new Set(orderNumbers.map(String));
    const matchedIds: string[] = [];
    const matchedNums = new Set<string>();
    ordersRealRows(ordersRef.current).forEach((o) => {
      const num = String(o.order_number);
      if (wanted.has(num)) { matchedIds.push(o.id); matchedNums.add(num); }
    });
    clearSelection();
    matchedIds.forEach((id) => handleSelectionChange(IndexTableSelectionType.Single, true, id));
    const notFound = [...wanted].filter((n) => !matchedNums.has(n));
    return { matched: matchedIds.length, notFound };
  }

  const reload = useCallback(async () => {
    const cacheKey = period === CUSTOM_ORDERS_VALUE && dateRange ? `${CUSTOM_ORDERS_VALUE}-${dateRange.from}-${dateRange.to}` : period;
    if (cacheKey && !hasCachedOrders(cacheKey)) setTableLoading(true);
    try {
      if (period === ALL_ORDERS_VALUE) await loadAllOrders();
      else if (period === CUSTOM_ORDERS_VALUE && dateRange) await loadOrdersForDateRange(dateRange.from, dateRange.to);
      else if (period) {
        const [month, year] = period.split('-').map(Number);
        await loadOrdersForPeriod(month, year);
      }
    } finally {
      setTableLoading(false);
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
    if (value !== CUSTOM_ORDERS_VALUE) setDateRange(null);
    if (!hasCachedOrders(value)) setTableLoading(true);
    try {
      if (value === ALL_ORDERS_VALUE) await loadAllOrders();
      else if (value !== CUSTOM_ORDERS_VALUE) {
        const [month, year] = value.split('-').map(Number);
        await loadOrdersForPeriod(month, year);
      }
    } finally {
      setTableLoading(false);
    }
  }

  // "vs previous period" for the metrics strip - fetched separately (like fetchOrderByNumber
  // above) so it never touches `orders`/the cache the table itself renders from.
  const prevPeriodReqId = useRef(0);
  useEffect(() => {
    const id = ++prevPeriodReqId.current;
    (async () => {
      try {
        let url: string | null = null;
        if (period === CUSTOM_ORDERS_VALUE) {
          if (dateRange) {
            const from = new Date(`${dateRange.from}T00:00:00`);
            const to = new Date(`${dateRange.to}T00:00:00`);
            const spanDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
            const prevTo = new Date(from); prevTo.setDate(prevTo.getDate() - 1);
            const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (spanDays - 1));
            const oldest = new Date(ORDERS_PERIOD_OLDEST_YEAR, ORDERS_PERIOD_OLDEST_MONTH - 1, 1);
            if (prevTo >= oldest) {
              const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              url = `/orders/?date_from=${iso(prevFrom)}&date_to=${iso(prevTo)}`;
            }
          }
        } else if (period && period !== ALL_ORDERS_VALUE) {
          const [month, year] = period.split('-').map(Number);
          const prev = previousOrdersPeriod(month, year);
          if (prev) url = `/orders/?month=${prev.month}&year=${prev.year}`;
        }
        if (!url) { setPrevOrders([]); setHasPrevPeriod(false); return; }
        const rows = await apiJson<Order[]>(url, { fallback: 'Failed to fetch previous period orders' });
        if (id !== prevPeriodReqId.current) return;
        setPrevOrders(rows);
        setHasPrevPeriod(true);
      } catch {
        if (id !== prevPeriodReqId.current) return;
        setPrevOrders([]);
        setHasPrevPeriod(false);
      }
    })();
  }, [period, dateRange]);

  const moreActionsBtnRef = useRef<HTMLSpanElement | null>(null);

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

  async function onDateRangeChange(range: DateRange | null) {
    setDateRange(range);
    setTableLoading(true);
    try {
      if (range) {
        setPeriod(CUSTOM_ORDERS_VALUE);
        await loadOrdersForDateRange(range.from, range.to);
      } else {
        const { month, year } = getCurrentOrdersPeriod(fiscalMonthStartDay);
        setPeriod(`${month}-${year}`);
        await loadOrdersForPeriod(month, year);
      }
    } finally {
      setTableLoading(false);
    }
  }

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
    const rows = filteredOrders.map((o) => {
      const out: Record<string, unknown> = {};
      ORDERS_COLUMNS.forEach((c) => { if (c.exportValue) out[c.heading] = c.exportValue(o); });
      return out;
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Orders');
    XLSX.writeFile(workbook, `inventory-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast('Excel exported (1 sheet)', 'success');
    setMoreActionsOpen(false);
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

  const autoFetchedDeliveryStatusRef = useRef(false);
  // Silently refresh delivery status for non-terminal PostEx/Couriers Next orders from the
  // last 2 months, once per visit right after orders finish their first load.
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

  /** Live-fetch delivery status for selected orders (skipping cancelled and anything not on
   * PostEx/Couriers Next with a tracking number), then always show the report. */
  async function fetchDeliveryStatusSelected() {
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

  const selectionSums = useMemo(() => (selectedRows.length > 0 ? calculateSelectedSums(selectedRows) : null), [selectedRows]);

  // Column widths for the aggregate row below (see .orders-aggregate-row in JSX) - it's a plain
  // div sibling *after* the scrolling IndexTable, not a row inside it, because Chrome doesn't
  // support `position: sticky; bottom` on a <tr>/<td> (confirmed: it just scrolls with the rest
  // of the table, unlike the same trick on thead th above, which works fine) - so it can't get
  // Polaris's auto table-layout widths for free and needs them mirrored in from the real <th>s.
  const [aggregateColumnWidths, setAggregateColumnWidths] = useState<number[]>([]);
  useLayoutEffect(() => {
    const headerCells = document.querySelectorAll('#ordersView .Polaris-IndexTable thead th');
    if (headerCells.length === 0) return;
    const recalcColumnWidths = () => {
      setAggregateColumnWidths(Array.from(headerCells).map((el) => el.getBoundingClientRect().width));
    };
    recalcColumnWidths();
    const observer = new ResizeObserver(recalcColumnWidths);
    headerCells.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pageRows.length > 0]);

  // The table itself scrolls horizontally when columns overflow the card's width (its own
  // scrollbar, not just the page's) - since the aggregate row lives outside that scroll
  // container (see above), it needs its horizontal position mirrored in by hand, or its cells
  // stop lining up with the real columns the moment you scroll sideways. Set directly on the
  // DOM (not React state) so a fast scroll doesn't re-render the whole orders page per frame.
  const aggregateRowInnerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectionSums) return;
    const scrollContainer = document.querySelector('#ordersView .Polaris-IndexTable-ScrollContainer') as HTMLElement | null;
    const inner = aggregateRowInnerRef.current;
    if (!scrollContainer || !inner) return;
    const syncScroll = () => { inner.style.transform = `translateX(${-scrollContainer.scrollLeft}px)`; };
    syncScroll();
    scrollContainer.addEventListener('scroll', syncScroll, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', syncScroll);
  }, [selectionSums != null]);

  useStickyIndexTableHeader('#ordersView', pageRows.length > 0);

  // Per-column filters live in the header row rendered just below IndexTable's real
  // headings (see the `rowType="subheader"` row below) - this only turns each active one
  // into a removable chip in the filter bar, same as before.
  const appliedFilters = Object.entries(columnFilters)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v))
    .map(([key, v]) => {
      const display = (s: string) => (key === 'order_status' ? orderStatusDisplayLabel(s) : s);
      return {
        key,
        label: `${ORDERS_COLUMNS.find((c) => c.key === key)?.heading || key}: ${Array.isArray(v) ? v.map(display).join(', ') : display(v)}`,
        onRemove: () => setColumnFilters((f) => { const next = { ...f }; delete next[key]; return next; }),
      };
    });

  function setColumnFilter(key: string, value: string) {
    setColumnFilters((f) => ({ ...f, [key]: value }));
  }

  function setColumnFilterValues(key: string, values: string[] | null) {
    setColumnFilters((f) => {
      if (values === null) { const next = { ...f }; delete next[key]; return next; }
      return { ...f, [key]: values };
    });
  }

  function renderColumnFilterCell(key: string) {
    switch (key) {
      case 'order_number':
      case 'folio':
        return (
          <TextField
            label="" labelHidden autoComplete="off" variant="borderless" size="slim" clearButton
            placeholder="Search..." value={(columnFilters[key] as string) || ''}
            onChange={(v) => setColumnFilter(key, v)}
            onClearButtonClick={() => setColumnFilter(key, '')}
          />
        );
      case 'courier':
        return (
          <Dropdown
            multiple fullWidth allLabel="All" options={courierOptions}
            value={(columnFilters.courier as string[] | undefined) ?? null}
            onChange={(v) => setColumnFilterValues('courier', v)}
          />
        );
      case 'order_status':
        return (
          <Dropdown
            multiple fullWidth allLabel="All" options={ORDER_STATUS_VALUES.map((v) => ({ value: v, label: orderStatusDisplayLabel(v) }))}
            value={(columnFilters.order_status as string[] | undefined) ?? null}
            onChange={(v) => setColumnFilterValues('order_status', v)}
          />
        );
      case 'piece_received':
        return (
          <Dropdown
            multiple fullWidth allLabel="All" options={PIECE_RECEIVED_VALUES}
            value={(columnFilters.piece_received as string[] | undefined) ?? null}
            onChange={(v) => setColumnFilterValues('piece_received', v)}
          />
        );
      case 'final_status':
        return (
          <Dropdown
            multiple fullWidth allLabel="All" options={FINAL_STATUS_VALUES}
            value={(columnFilters.final_status as string[] | undefined) ?? null}
            onChange={(v) => setColumnFilterValues('final_status', v)}
          />
        );
      case 'delivery':
        return null;
      default:
        return (
          <TextField
            label="" labelHidden autoComplete="off" variant="borderless" align="right" size="slim" clearButton
            placeholder="=" value={(columnFilters[key] as string) || ''}
            onChange={(v) => setColumnFilter(key, v)}
            onClearButtonClick={() => setColumnFilter(key, '')}
          />
        );
    }
  }

  usePageHeader({
    title: 'Orders',
    search: { value: search, onChange: setSearch },
    actions: (
      <>
        <div className="orders-period-filter-wrap">
          <Dropdown
            value={period}
            onChange={onPeriodChange}
            options={[
              { label: 'Recent Orders', value: ALL_ORDERS_VALUE },
              ...buildStaticPeriodOptions(fiscalMonthStartDay),
              ...(period === CUSTOM_ORDERS_VALUE && dateRange
                ? [{ label: formatOrdersDateRangeLabel(dateRange.from, dateRange.to), value: CUSTOM_ORDERS_VALUE }]
                : []),
            ]}
          />
        </div>
        <DateRangePopover
          value={period === CUSTOM_ORDERS_VALUE ? dateRange : null} onChange={onDateRangeChange}
          label={period === CUSTOM_ORDERS_VALUE && dateRange ? 'Range set' : undefined}
          title={period === CUSTOM_ORDERS_VALUE && dateRange ? formatOrdersDateRangeLabel(dateRange.from, dateRange.to) : 'Filter by date range'}
        />
        <div className={'orders-more-actions' + (moreActionsOpen ? ' open' : '')}>
          <span ref={moreActionsBtnRef} style={{ display: 'inline-block' }}>
            <HeaderButton
              disclosure={moreActionsOpen ? 'up' : 'down'}
              ariaExpanded={moreActionsOpen}
              onClick={() => {
                if (!moreActionsOpen && moreActionsBtnRef.current) {
                  const rect = moreActionsBtnRef.current.getBoundingClientRect();
                  setMoreActionsPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 220) });
                }
                setMoreActionsOpen((v) => !v);
              }}
            >
              More actions
            </HeaderButton>
          </span>
          {moreActionsOpen && (
            <div className="orders-more-actions__menu" role="menu" style={moreActionsPos}>
              <button type="button" className="orders-more-actions__item" role="menuitem" disabled={fetchingDeliveryStatus} onClick={() => { setMoreActionsOpen(false); fetchDeliveryStatusSelected(); }}>Track delivery status</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={generateInvoice}>Generate invoice</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={() => { setMoreActionsOpen(false); setBulkUpdateOpen(true); }}>Bulk update order</button>
              <button
                type="button" className="orders-more-actions__item" role="menuitem"
                onClick={() => { setMoreActionsOpen(false); loadLedgersList(); setUploadPostExModalOpen(true); }}
              >
                Upload PostEx CSV
              </button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={() => { setMoreActionsOpen(false); setLoadSheetModalOpen(true); }}>Generate Load Sheet</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={() => { setMoreActionsOpen(false); setPackagingListModalOpen(true); }}>Generate Packaging List</button>
              <button type="button" className="orders-more-actions__item" role="menuitem" onClick={exportToExcel}>Export Data to Excel</button>
            </div>
          )}
        </div>
        <Tooltip content="Scan barcode">
          <HeaderButton icon={BarcodeIcon} accessibilityLabel="Scan barcode" onClick={() => navigate('/scan-barcode')} />
        </Tooltip>
        <div className="header-orders-app-actions" role="group" aria-label="App security and view">
          <Tooltip content="Full screen (Esc to exit)">
            <HeaderButton icon={MaximizeIcon} accessibilityLabel="Full screen (Esc to exit)" onClick={toggleFullscreen} />
          </Tooltip>
        </div>
      </>
    ),
  });

  const formatExactMetric = (n: number, isMoney: boolean) => isMoney
    ? `Rs ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : n.toLocaleString('en-US');

  const kpi = (label: string, value: string, cur: number, prev: number, isMoney: boolean, negative?: boolean) => ({
    label, value, negative,
    title: [
      `Current: ${formatExactMetric(cur, isMoney)}`,
      hasPrevPeriod ? `Previous: ${formatExactMetric(prev, isMoney)}` : null,
    ].filter(Boolean).join(' • '),
    detail: (
      <InlineStack gap="200" blockAlign="center">
        <Text as="span" tone="subdued" variant="bodySm">vs previous: {hasPrevPeriod ? (isMoney ? compactRs(prev) : prev.toLocaleString('en-US')) : '—'}</Text>
        <AnalyticsDeltaBadge cur={cur} prev={prev} hasPrev={hasPrevPeriod} />
      </InlineStack>
    ),
  });

  return (
    <div id="ordersView" className="view active">
      <MetricsStrip
        label="Order summary"
        tiles={[
          kpi('Orders', metrics.orders.toLocaleString('en-US'), metrics.orders, prevMetrics.orders, false),
          kpi('Items ordered', metrics.items.toLocaleString('en-US'), metrics.items, prevMetrics.items, false),
          kpi('Total Sales', compactRs(metrics.total), metrics.total, prevMetrics.total, true),
          kpi('Delivered', metrics.delivered.toLocaleString('en-US'), metrics.delivered, prevMetrics.delivered, false),
          kpi('Returned', metrics.returned.toLocaleString('en-US'), metrics.returned, prevMetrics.returned, false),
          kpi('Net profit', compactRs(metrics.netProfit), metrics.netProfit, prevMetrics.netProfit, true, metrics.netProfit < 0),
        ]}
      />
      <div className="table-card">
        <div className="table-index-filters">
          <IndexFilters
            mode={mode}
            setMode={setMode}
            tabs={ORDERS_VIEW_TABS.map((t) => ({ id: t.id, content: t.label, badge: String(tabCounts[t.id] ?? '') }))}
            selected={Math.max(0, ORDERS_VIEW_TABS.findIndex((t) => t.id === activeTab))}
            onSelect={(index) => setActiveTab(ORDERS_VIEW_TABS[index]?.id || 'all')}
            onQueryChange={() => {}}
            onQueryClear={() => {}}
            filters={[]}
            appliedFilters={appliedFilters}
            onClearAll={() => setColumnFilters({})}
            cancelAction={{ onAction: () => {}, disabled: true }}
            hideQueryField
            hideFilters
            canCreateNewView={false}
          />
          {Object.keys(columnFilters).length > 0 && (
            <Tooltip content="Clear filters">
              <HeaderButton
                icon={<FilterX size={16} />}
                accessibilityLabel="Clear filters"
                onClick={() => setColumnFilters({})}
                variant="tertiary"
              />
            </Tooltip>
          )}
          <Tooltip content={showFilterRow ? 'Hide filters' : 'Show filters'}>
            <HeaderButton icon={<Filter size={16} />} accessibilityLabel="Toggle filters" onClick={() => setShowFilterRow((v) => !v)} variant="tertiary" pressed={showFilterRow} />
          </Tooltip>
        </div>
          <IndexTable
            resourceName={{ singular: 'order', plural: 'orders' }}
            // Polaris swaps the whole <table> (thead included) for `emptyState` once
            // itemCount hits 0, taking our filter subheader row down with it - keep
            // itemCount at 1 and render the empty message as a row instead, see below.
            itemCount={pageRows.length || 1}
            selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            headings={ORDERS_COLUMNS.map((c) => ({ title: c.heading, alignment: c.alignment })) as any}
            sortable={ORDERS_COLUMNS.map((c) => !!c.sortable)}
            sortColumnIndex={sort?.index}
            sortDirection={sort?.direction}
            onSort={(index, direction) => setSort({ index, direction })}
            loading={tableLoading}
            condensed={false}
          >
            {showFilterRow && (
              <IndexTable.Row id="__filters__" position={-1} rowType="subheader" hideSelectable>
                {ORDERS_COLUMNS.map((col) => (
                  <IndexTable.Cell key={col.key}>{renderColumnFilterCell(col.key)}</IndexTable.Cell>
                ))}
              </IndexTable.Row>
            )}
            {pageRows.length === 0 && !tableLoading && (
              <IndexTable.Row id="__empty__" position={-2} hideSelectable>
                <IndexTable.Cell colSpan={ORDERS_COLUMNS.length}>
                  <div className="table-empty">{hasAnyOrders ? 'No orders match this filter' : 'No orders yet'}</div>
                </IndexTable.Cell>
              </IndexTable.Row>
            )}
            {pageRows.map((order, index) => (
              <OrderRow
                key={order.id} order={order} index={index}
                selected={selectedResources.includes(order.id)}
                tone={(order.order_status || '').toLowerCase() === 'cancelled' ? 'subdued' : undefined}
                columnCtx={columnCtx}
              />
            ))}
          </IndexTable>
          {selectionSums && (
            <div className="orders-aggregate-row">
              <div className="orders-aggregate-row__inner" ref={aggregateRowInnerRef}>
                {aggregateColumnWidths[0] != null && <div style={{ width: aggregateColumnWidths[0], flex: '0 0 auto' }} />}
                {ORDERS_COLUMNS.map((col, i) => (
                  <div
                    key={col.key} className="Polaris-IndexTable__TableCell"
                    style={{ width: aggregateColumnWidths[i + 1], flex: '0 0 auto', boxSizing: 'border-box' }}
                  >
                    {i === 0
                      ? <Text as="span" fontWeight="semibold">{selectedRows.length} selected</Text>
                      : aggregateCell(col, selectionSums)}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="table-pagination">
            <Pagination
              type="table"
              hasNext={page < pageCount - 1}
              hasPrevious={page > 0}
              onNext={() => setPage((p) => p + 1)}
              onPrevious={() => setPage((p) => p - 1)}
              label={`${filteredOrders.length === 0 ? 0 : page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, filteredOrders.length)} of ${filteredOrders.length}`}
            />
          </div>
      </div>
      <BulkUpdateOrderModal
        open={bulkUpdateOpen}
        onClose={() => setBulkUpdateOpen(false)}
        onChanged={reload}
        onSelectOrderNumbers={selectOrderNumbers}
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
    </div>
  );
}
