// Order Fulfillment: bulk "select orders, pick a courier, fulfill" screen, plus its
// live booking-progress screen. Ported from order-fulfillment.js. The order list and
// Fulfill are both live; editing a row's address/mobile/tags/city here is local-only
// and is NOT sent to the courier, which books from what's stored on the order.
// Same Polaris IndexTable/IndexFilters card as OrdersPage (shares its .orders-table-card CSS).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionList, Badge, Button, IndexFilters, IndexTable, IndexTableSelectionType, Popover, Text, TextField, Tooltip,
  useIndexResourceState, useSetIndexFiltersMode,
} from '@shopify/polaris';
import { MenuVerticalIcon } from '@shopify/polaris-icons';
import { FilterX } from 'lucide-react';
import { apiJson, apiJsonStream } from '../../api';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton, HeaderRefButton } from '../../components/HeaderButton';
import { Dropdown } from '../../components/Dropdown';
import { useStickyIndexTableHeader } from '../../components/useStickyIndexTableHeader';
import { createDateRangePicker, type DateRangePickerHandle } from '../../dateRangePicker';
import { formatDateDDMMYYYY, rowMatchesQuery } from '../../logic/shared';
import { printAirwayBillsForOrders } from '../../logic/airwayBills';
import { orderHasAirwayBill } from '../../logic/orders';
import {
  FULFILLMENT_COURIERS, FULFILLMENT_DEFAULT_ORDER_TYPE, FULFILLMENT_DEFAULT_REMARK, FULFILLMENT_ORDER_TYPES,
  FULFILLMENT_PROGRESS_STATE_META, fulfillmentFilteredOrders, fulfillmentLineItemCount,
  fulfillmentPickupAddressLabel, type CustomerStatus, type FulfillmentCourier, type FulfillmentFilters,
  type FulfillmentOrder, type FulfillmentProgressOrder, type PickupAddress,
} from '../../logic/fulfillment';
import { EditableAmount } from '../orders/ordersPolarisColumns';
import { FulfillmentDetailsModal } from './FulfillmentDetailsModal';

const COLUMNS: Array<{ key: string; title: string; alignment?: 'end'; tooltipContent?: string }> = [
  { key: 'order_number', title: 'Order ID' },
  { key: 'name', title: 'Name' },
  { key: 'address', title: 'Complete Address' },
  { key: 'mobile', title: 'Mobile Number' },
  { key: 'tags', title: 'Tags' },
  { key: 'city', title: 'City' },
  { key: 'courier_city', title: 'Courier City', tooltipContent: 'Select a courier above to populate this with its supported cities' },
  { key: 'order_type', title: 'Type', tooltipContent: "The courier's own order type." },
  { key: 'cod', title: 'CoD', alignment: 'end', tooltipContent: 'Amount the rider collects on delivery.' },
  { key: 'risk', title: 'Risk / Customer Status', tooltipContent: "Based on this customer's past delivered vs. total orders" },
  { key: 'actions', title: 'Actions' },
];

// Tabs in the filter strip, same as OrdersPage's status tabs: null = no tier filter.
const RISK_TABS: Array<{ id: string; label: string; tier: CustomerStatus['tier'] | null }> = [
  { id: 'all', label: 'Unfulfilled', tier: null },
  { id: 'new', label: 'New Customer', tier: 'new' },
  { id: 'trusted', label: 'Trusted', tier: 'trusted' },
  { id: 'low', label: 'Low Risk', tier: 'low' },
  { id: 'medium', label: 'Medium Risk', tier: 'medium' },
  { id: 'high', label: 'High Risk', tier: 'high' },
];

const TAG_TONES: Record<string, 'info' | 'success' | 'new' | 'warning'> = { VIP: 'info', Repeat: 'success', New: 'new', Wholesale: 'warning' };
const RISK_TONES: Record<CustomerStatus['tier'], 'success' | 'info' | 'warning' | 'critical'> = {
  trusted: 'success', low: 'success', new: 'info', medium: 'warning', high: 'critical',
};

/** Borderless inline text cell; commits on blur, blank reverts to the current value. */
function EditableText({ value, minWidth, onCommit }: { value: string; minWidth?: number; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return (
    <div style={{ minWidth }}>
      <TextField
        label="" labelHidden autoComplete="off" variant="borderless" size="slim"
        value={text} onChange={setText}
        onBlur={() => { const next = text.trim(); if (next && next !== value) onCommit(next); else setText(value); }}
      />
    </div>
  );
}

function RiskCell({ order }: { order: FulfillmentOrder }) {
  const status = order.customer_status || { tier: 'new' as const, label: 'New Customer', received: 0, total: 0 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <Badge tone={RISK_TONES[status.tier]}>{status.label}</Badge>
      {status.total > 0 && <Text as="span" tone="subdued" variant="bodyXs">{status.received}/{status.total} delivered</Text>}
    </div>
  );
}

export function OrderFulfillmentPage() {
  const confirm = useConfirm();
  const { showToast } = useToast();

  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FulfillmentFilters>({ cities: null, tags: null, dateFrom: null, dateTo: null });
  const [search, setSearch] = useState('');
  const [riskTab, setRiskTab] = useState(0);
  const [selectedCourier, setSelectedCourier] = useState<FulfillmentCourier | null>(null);
  const [courierMenuOpen, setCourierMenuOpen] = useState(false);
  const { mode, setMode } = useSetIndexFiltersMode();
  const [pickupAddresses, setPickupAddresses] = useState<PickupAddress[]>([]);
  const [pickupCode, setPickupCode] = useState('');
  const [courierCities, setCourierCities] = useState<string[]>([]);
  const [courierCitiesLoading, setCourierCitiesLoading] = useState(false);
  const [detailsForId, setDetailsForId] = useState<string | null>(null);
  const [fulfilling, setFulfilling] = useState(false);
  const [progress, setProgress] = useState<{ orders: FulfillmentProgressOrder[]; phase: 'booking' | 'shopify_sync' | 'done' } | null>(null);
  const [dateRangeNode, setDateRangeNode] = useState<HTMLButtonElement | null>(null);
  const dateRangePickerRef = useRef<DateRangePickerHandle | null>(null);
  const [dateRangeLabel, setDateRangeLabel] = useState('Date range');

  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const courierCitiesRef = useRef(courierCities);
  courierCitiesRef.current = courierCities;

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiJson<any[]>('/orders/unfulfilled', { fallback: 'Failed to fetch unfulfilled orders' });
      const prev = ordersRef.current;
      const byId = new Map(prev.map((o) => [o.id, o]));
      const next: FulfillmentOrder[] = rows.map((o) => {
        const carried = byId.get(o.id);
        return {
          ...o,
          order_date: new Date(o.order_date),
          courierCity: (carried?.courierCity) || null,
          orderType: carried?.orderType || FULFILLMENT_DEFAULT_ORDER_TYPE,
          codAmount: carried?.codAmount != null ? carried.codAmount : Math.max(0, (o.total_amount || 0) - (o.advance_amount || 0)),
          email: carried?.email || '',
          instructions: carried?.instructions != null ? carried.instructions : FULFILLMENT_DEFAULT_REMARK,
          pieces: carried?.pieces != null ? carried.pieces : (fulfillmentLineItemCount(o.line_items) || 1),
          invoiceDivision: carried?.invoiceDivision != null ? carried.invoiceDivision : 1,
          handling: carried?.handling || 'Standard',
        };
      });
      setOrders(autoSelectCourierCities(next, courierCitiesRef.current));
      return true;
    } catch (error: any) {
      console.error('Error loading unfulfilled orders:', error);
      showToast(error?.message || 'Failed to load unfulfilled orders', 'error');
      setOrders([]);
      return false;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  function autoSelectCourierCities(list: FulfillmentOrder[], cities: string[]): FulfillmentOrder[] {
    if (cities.length === 0) return list;
    const byNormalized = new Map(cities.map((c) => [c.trim().toLowerCase(), c]));
    return list.map((o) => (o.courierCity ? o : { ...o, courierCity: byNormalized.get((o.city || '').trim().toLowerCase()) || null }));
  }

  const allCities = useMemo(() => [...new Set(orders.map((o) => o.city).filter(Boolean))].sort(), [orders]);
  const allTags = useMemo(() => [...new Set(orders.flatMap((o) => o.tags))].sort(), [orders]);
  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length };
    for (const o of orders) { const t = o.customer_status?.tier || 'new'; counts[t] = (counts[t] || 0) + 1; }
    return counts;
  }, [orders]);
  const filtered = useMemo(() => {
    const tier = RISK_TABS[riskTab]?.tier;
    const rows = tier ? orders.filter((o) => (o.customer_status?.tier || 'new') === tier) : orders;
    return fulfillmentFilteredOrders(rows, filters).filter((o) => rowMatchesQuery(o, search));
  }, [orders, filters, riskTab, search]);
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(
    filtered as unknown as Array<FulfillmentOrder & { [key: string]: unknown }>, { resourceIDResolver: (o) => o.id },
  );
  const selectedOrders = useMemo(() => orders.filter((o) => selectedResources.includes(o.id)), [orders, selectedResources]);
  useStickyIndexTableHeader('#orderFulfillmentView', filtered.length > 0);

  function updateOrder(id: string, patch: Partial<FulfillmentOrder>) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  async function pickCourier(courier: FulfillmentCourier) {
    setSelectedCourier(courier);
    setCourierMenuOpen(false);
    setCourierCitiesLoading(true);
    setCourierCities([]);
    setOrders((prev) => prev.map((o) => ({ ...o, courierCity: null, orderType: FULFILLMENT_DEFAULT_ORDER_TYPE })));
    setPickupAddresses([]);
    setPickupCode('');
    // Independent try/catches, not Promise.all - a failure fetching one (e.g. pickup
    // addresses down) shouldn't also blank out the other one that actually succeeded.
    const citiesPromise = (async () => {
      try {
        const citiesRes = await apiJson<{ cities?: string[] }>(`/orders/courier-cities?courier=${encodeURIComponent(courier.id)}`, { fallback: 'Failed to fetch supported cities' });
        const cities = citiesRes.cities || [];
        setCourierCities(cities);
        setOrders((prev) => autoSelectCourierCities(prev, cities));
      } catch (error: any) {
        console.error('Error loading courier cities:', error);
        showToast(error?.message || 'Failed to fetch supported cities', 'error');
      }
    })();
    const pickupPromise = (async () => {
      try {
        const pickupRes = await apiJson<{ addresses?: PickupAddress[] }>(`/orders/courier-pickup-addresses?courier=${encodeURIComponent(courier.id)}`, { fallback: 'Failed to fetch pickup addresses' });
        const addresses = pickupRes.addresses || [];
        setPickupAddresses(addresses);
        const def = addresses.find((a) => a.is_default);
        setPickupCode(def ? def.code : '');
      } catch (error: any) {
        console.error('Error loading pickup addresses:', error);
        showToast(error?.message || 'Failed to fetch pickup addresses', 'error');
      }
    })();
    await Promise.all([citiesPromise, pickupPromise]);
    setCourierCitiesLoading(false);
  }

  const disabledReason = useMemo(() => {
    if (fulfilling) return 'Booking in progress…';
    if (!selectedCourier) return 'Select a courier first';
    if (!pickupCode) return 'Select a pickup location first';
    if (selectedOrders.length === 0) return 'Select at least one order';
    const missingCity = selectedOrders.filter((o) => !o.courierCity);
    if (missingCity.length > 0) return `Pick a courier city for ${missingCity.length === 1 ? `order #${missingCity[0].order_number}` : `${missingCity.length} orders`} first`;
    return '';
  }, [fulfilling, selectedCourier, pickupCode, selectedOrders]);

  async function fulfillSelected() {
    if (disabledReason) { showToast(disabledReason, 'error', { silent: true }); return; }
    const pickup = pickupAddresses.find((a) => a.code === pickupCode);
    const ok = await confirm({
      title: 'Fulfill Orders',
      message: `Book ${selectedOrders.length} order(s) with ${selectedCourier!.name}?\n\nPickup from: ${pickup ? fulfillmentPickupAddressLabel(pickup) : pickupCode}\n\nThis creates real shipments the courier will collect, and marks the orders fulfilled in Shopify.`,
      confirmText: 'Fulfill',
    });
    if (!ok) return;

    const progressOrders: FulfillmentProgressOrder[] = selectedOrders.map((o) => ({
      id: o.id, order_number: o.order_number, name: o.name, city: o.city, courier: selectedCourier!.name,
      state: 'pending', tracking_number: null, error: null,
    }));
    if (progressOrders[0]) progressOrders[0].state = 'booking';
    setFulfilling(true);
    setProgress({ orders: progressOrders, phase: 'booking' });

    const courierName = selectedCourier!.name;
    try {
      for await (const event of apiJsonStream<any>('/orders/fulfill', {
        body: {
          courier: selectedCourier!.id, pickup_address_code: pickupCode,
          orders: selectedOrders.map((o) => ({
            order_id: o.id, courier_city: o.courierCity, order_type: o.orderType, cod_amount: o.codAmount,
            customer_email: o.email || null, instructions: o.instructions || null, pieces: o.pieces,
            invoice_division: o.invoiceDivision, handling: o.handling,
          })),
        },
        fallback: 'Failed to fulfill orders',
      })) {
        if (event.type === 'order') {
          const result = event.result;
          setProgress((prevProgress) => {
            if (!prevProgress) return prevProgress;
            const next = prevProgress.orders.map((o) => (o.id === result.order_id ? { ...o, state: result.ok ? 'ok' as const : 'fail' as const, tracking_number: result.tracking_number || null, error: result.error || null } : o));
            const pendingIdx = next.findIndex((o) => o.state === 'pending');
            if (pendingIdx >= 0) next[pendingIdx] = { ...next[pendingIdx], state: 'booking' };
            return { ...prevProgress, orders: next };
          });
          if (result.ok) {
            setOrders((prev) => prev.filter((o) => o.id !== result.order_id));
            handleSelectionChange(IndexTableSelectionType.Single, false, result.order_id);
          }
        } else if (event.type === 'shopify_sync') {
          setProgress((prevProgress) => (prevProgress ? { ...prevProgress, phase: 'shopify_sync' } : prevProgress));
        }
      }
    } catch (error: any) {
      console.error('Error fulfilling orders:', error);
      showToast(error?.message || 'Failed to fulfill orders', 'error');
      setProgress((prevProgress) => (prevProgress ? {
        ...prevProgress,
        orders: prevProgress.orders.map((o) => (o.state === 'pending' || o.state === 'booking' ? { ...o, state: 'fail' as const, error: o.error || 'Fulfillment interrupted - not booked' } : o)),
      } : prevProgress));
    } finally {
      setFulfilling(false);
      setProgress((prevProgress) => (prevProgress ? { ...prevProgress, phase: 'done' } : prevProgress));
    }

    setProgress((finalProgress) => {
      if (finalProgress) {
        const booked = finalProgress.orders.filter((o) => o.state === 'ok').length;
        const failed = finalProgress.orders.filter((o) => o.state === 'fail').length;
        showToast(failed === 0 ? `Booked ${booked} order(s) with ${courierName}` : `Booked ${booked}, failed ${failed}`, failed === 0 ? 'success' : (booked > 0 ? 'info' : 'error'));
      }
      return finalProgress;
    });
  }

  useEffect(() => {
    if (!dateRangeNode) return;
    const handle = createDateRangePicker(dateRangeNode, {
      onSelect: (from, to) => {
        const toLocal = (s: string) => { const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d); };
        setFilters((f) => ({ ...f, dateFrom: toLocal(from), dateTo: toLocal(to) }));
        setDateRangeLabel(`${formatDateDDMMYYYY(from)} – ${formatDateDDMMYYYY(to)}`);
        handle?.setClearable(true);
      },
      onClear: () => {
        setFilters((f) => ({ ...f, dateFrom: null, dateTo: null }));
        setDateRangeLabel('Date range');
        handle?.picker.clear();
        handle?.setClearable(false);
      },
    });
    dateRangePickerRef.current = handle;
    return () => handle?.destroy();
  }, [dateRangeNode]);

  function clearFilters() {
    setFilters({ cities: null, tags: null, dateFrom: null, dateTo: null });
    dateRangePickerRef.current?.picker.clear();
    dateRangePickerRef.current?.setClearable(false);
    setDateRangeLabel('Date range');
  }

  const hasFilters = !!(filters.cities || filters.tags || filters.dateFrom);
  const appliedFilters = (['cities', 'tags'] as const)
    .filter((key) => filters[key])
    .map((key) => ({
      key,
      label: `${key === 'cities' ? 'City' : 'Tags'}: ${filters[key]!.join(', ')}`,
      onRemove: () => setFilters((f) => ({ ...f, [key]: null })),
    }));

  usePageHeader({
    title: 'Order Fulfillment',
    search: { value: search, onChange: setSearch, placeholder: 'Search orders...' },
    actions: (
      <>
        <div className="orders-date-range-wrap header-inline">
          <HeaderRefButton ref={setDateRangeNode} label={dateRangeLabel} title="Filter by order date" />
        </div>
        <HeaderButton onClick={() => showToast('Export not implemented yet', 'info', { silent: true })}>Export</HeaderButton>
        <HeaderButton onClick={async () => { if (await fetchOrders()) showToast('Refreshed', 'success'); }}>Refresh</HeaderButton>
      </>
    ),
  });

  const detailsOrder = detailsForId ? orders.find((o) => o.id === detailsForId) || null : null;

  if (progress) {
    const total = progress.orders.length;
    const ok = progress.orders.filter((o) => o.state === 'ok').length;
    const failed = progress.orders.filter((o) => o.state === 'fail').length;
    const done = progress.phase === 'done';
    const pillLabel = progress.phase === 'shopify_sync' ? 'Updating Shopify…' : done ? (failed ? 'Completed with errors' : 'Fulfillment complete') : 'Live fulfillment in progress';
    const pillClass = !done ? 'fulfillment-progress-pill--live' : failed === 0 ? 'fulfillment-progress-pill--done' : 'fulfillment-progress-pill--warn';
    return (
      <div className="fulfillment-progress-head-wrap">
        <div className="fulfillment-progress-head">
          <div className="fulfillment-progress-head-titles">
            <h2 className="fulfillment-progress-title">Fulfillment Progress</h2>
            <span className={`fulfillment-progress-pill ${pillClass}`}>{pillLabel}</span>
          </div>
          <span className="fulfillment-progress-courier">{progress.orders[0] ? `via ${progress.orders[0].courier}` : ''}</span>
        </div>
        <div className="fulfillment-progress-summary">
          <div className="fulfillment-progress-stat"><span className="fulfillment-progress-stat-label">Total</span><span className="fulfillment-progress-stat-value">{total}</span></div>
          <div className="fulfillment-progress-stat"><span className="fulfillment-progress-stat-label">Completed</span><span className="fulfillment-progress-stat-value fulfillment-progress-stat-value--ok">{ok}</span></div>
          <div className="fulfillment-progress-stat"><span className="fulfillment-progress-stat-label">Failed</span><span className="fulfillment-progress-stat-value fulfillment-progress-stat-value--fail">{failed}</span></div>
          <div className="fulfillment-progress-stat"><span className="fulfillment-progress-stat-label">Remaining</span><span className="fulfillment-progress-stat-value">{total - ok - failed}</span></div>
        </div>
        <div className="fulfillment-progress-bar"><div className="fulfillment-progress-bar-fill" style={{ width: total ? `${Math.round(((ok + failed) / total) * 100)}%` : '0%' }} /></div>
        <div className="fulfillment-progress-list">
          {progress.orders.map((o) => {
            const meta = FULFILLMENT_PROGRESS_STATE_META[o.state];
            return (
              <div className="fulfillment-progress-row" key={o.id} data-state={o.state}>
                <span className="fulfillment-progress-row-icon"><i className={`fa-solid ${o.state === 'ok' ? 'fa-circle-check' : o.state === 'fail' ? 'fa-circle-xmark' : o.state === 'booking' ? 'fa-spinner fa-spin' : 'fa-circle'}`} /></span>
                <div className="fulfillment-progress-row-main">
                  <span className="fulfillment-progress-row-order">#{o.order_number}</span>
                  <span className="fulfillment-progress-row-sub">{[o.name, o.city].filter(Boolean).join(' · ')}</span>
                </div>
                <div className="fulfillment-progress-row-status">
                  <span className={`fulfillment-progress-badge fulfillment-progress-badge--${o.state}`}>{meta.badge}</span>
                  {o.state === 'fail' ? <span className="fulfillment-progress-row-error" title={o.error || 'Failed'}>{o.error || 'Failed'}</span>
                    : o.tracking_number ? <span className="fulfillment-progress-row-tracking">{o.tracking_number}</span> : null}
                </div>
                {orderHasAirwayBill(o as any) && (
                  <button type="button" className="fulfillment-progress-awb-btn" onClick={async () => { try { await printAirwayBillsForOrders([o as any]); } catch (e: any) { showToast(e?.message || 'Failed to print airway bill', 'error'); } }}>
                    <i className="fa-solid fa-file-arrow-down" /> Airway Bill
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="fulfillment-progress-footer">
          <button type="button" className="btn btn-secondary" disabled={!progress.orders.some((o) => orderHasAirwayBill(o as any))} onClick={async () => { try { await printAirwayBillsForOrders(progress.orders as any); } catch (e: any) { showToast(e?.message || 'Failed to print airway bills', 'error'); } }}>
            <i className="fa-solid fa-print" /> Print All Airway Bills
          </button>
          <button type="button" className="btn btn-primary" disabled={!done} onClick={() => setProgress(null)}>Done</button>
        </div>
      </div>
    );
  }

  const orderTypes = (selectedCourier && FULFILLMENT_ORDER_TYPES[selectedCourier.id]) || [];
  const isCouriersNext = selectedCourier?.id === 'couriers_next';
  const pickupSelected = pickupAddresses.find((a) => a.code === pickupCode);

  const courierChip = (c: FulfillmentCourier) => (c.logo
    ? <span className="fulfillment-courier-logo-chip"><img src={c.logo} alt={c.name} /></span>
    : <span className="fulfillment-courier-monogram" style={{ background: c.color }}>{c.monogram}</span>);

  function renderColumnFilterCell(key: string) {
    if (key === 'city') {
      return <Dropdown multiple searchable fullWidth allLabel="All" options={allCities} value={filters.cities} onChange={(v) => setFilters((f) => ({ ...f, cities: v }))} />;
    }
    if (key === 'tags') {
      return <Dropdown multiple fullWidth allLabel="All" options={allTags} value={filters.tags} onChange={(v) => setFilters((f) => ({ ...f, tags: v }))} />;
    }
    return null;
  }

  return (
    <div id="orderFulfillmentView" className="view active">
      <div className="orders-table-card">
        <div className="orders-index-filters-wrap">
          <IndexFilters
            mode={mode} setMode={setMode}
            tabs={RISK_TABS.map((t) => ({ id: t.id, content: t.label, badge: String(tierCounts[t.id] ?? 0) }))}
            selected={riskTab} onSelect={setRiskTab}
            onQueryChange={() => {}} onQueryClear={() => {}}
            filters={[]} appliedFilters={appliedFilters} onClearAll={clearFilters}
            cancelAction={{ onAction: () => {}, disabled: true }}
            hideQueryField hideFilters canCreateNewView={false}
          />
          {hasFilters && (
            <Tooltip content="Clear filters">
              <HeaderButton icon={<FilterX size={16} />} accessibilityLabel="Clear filters" onClick={clearFilters} variant="tertiary" />
            </Tooltip>
          )}
        </div>
        {selectedOrders.length > 0 && (
          <div className="fulfillment-selection-bar">
            <Text as="span" fontWeight="semibold">{selectedOrders.length} selected</Text>
            <Popover
              active={courierMenuOpen} onClose={() => setCourierMenuOpen(false)}
              activator={(
                <Button disclosure icon={selectedCourier ? courierChip(selectedCourier) : undefined} onClick={() => setCourierMenuOpen((v) => !v)}>
                  {selectedCourier ? selectedCourier.name : 'Select Courier'}
                </Button>
              )}
            >
              <ActionList items={FULFILLMENT_COURIERS.map((c) => ({ content: c.name, prefix: courierChip(c), onAction: () => pickCourier(c) }))} />
            </Popover>
            <div className="fulfillment-pickup-group" title={pickupSelected ? fulfillmentPickupAddressLabel(pickupSelected) : ''}>
              <Dropdown
                disabled={pickupAddresses.length === 0} placeholder="Select courier first" value={pickupCode} onChange={setPickupCode}
                options={pickupAddresses.map((a) => ({ label: fulfillmentPickupAddressLabel(a), value: a.code }))}
              />
            </div>
            <Tooltip content={disabledReason || 'Book the selected orders'}>
              <Button variant="primary" disabled={!!disabledReason} onClick={fulfillSelected}>Fulfill Order</Button>
            </Tooltip>
            <Button onClick={clearSelection}>Cancel</Button>
          </div>
        )}
        <IndexTable
          resourceName={{ singular: 'order', plural: 'orders' }}
          // Same trick as OrdersPage: keep itemCount >= 1 so Polaris doesn't swap the whole
          // <table> (and our filter subheader row) for its emptyState when nothing matches.
          itemCount={filtered.length || 1}
          selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
          onSelectionChange={handleSelectionChange}
          headings={COLUMNS.map(({ title, alignment, tooltipContent }) => ({ title, alignment, tooltipContent })) as any}
          loading={loading}
          condensed={false}
        >
          <IndexTable.Row id="__filters__" position={-1} rowType="subheader" hideSelectable>
            {COLUMNS.map((col) => <IndexTable.Cell key={col.key}>{renderColumnFilterCell(col.key)}</IndexTable.Cell>)}
          </IndexTable.Row>
          {filtered.length === 0 && !loading && (
            <IndexTable.Row id="__empty__" position={-2} hideSelectable>
              <IndexTable.Cell colSpan={COLUMNS.length}>
                <div className="orders-table-empty">No unfulfilled orders match these filters.</div>
              </IndexTable.Cell>
            </IndexTable.Row>
          )}
          {filtered.map((o, index) => (
            <IndexTable.Row id={o.id} key={o.id} position={index} selected={selectedResources.includes(o.id)} onClick={() => {}}>
              <IndexTable.Cell><Text as="span" fontWeight="semibold">#{o.order_number}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text as="span">{o.name}</Text></IndexTable.Cell>
              <IndexTable.Cell><EditableText value={o.address} minWidth={240} onCommit={(v) => updateOrder(o.id, { address: v })} /></IndexTable.Cell>
              <IndexTable.Cell><EditableText value={o.mobile} minWidth={120} onCommit={(v) => updateOrder(o.id, { mobile: v })} /></IndexTable.Cell>
              <IndexTable.Cell>
                <div style={{ display: 'flex', gap: 4, whiteSpace: 'nowrap' }}>
                  {o.tags.map((t) => <Badge key={t} tone={TAG_TONES[t] || 'new'}>{t}</Badge>)}
                </div>
              </IndexTable.Cell>
              <IndexTable.Cell><Text as="span">{o.city}</Text></IndexTable.Cell>
              <IndexTable.Cell>
                <Dropdown
                  searchable size="slim" disabled={courierCities.length === 0}
                  placeholder={courierCitiesLoading ? 'Loading…' : courierCities.length ? 'Select city' : '—'}
                  options={courierCities} value={o.courierCity || ''} onChange={(city) => updateOrder(o.id, { courierCity: city })}
                />
              </IndexTable.Cell>
              <IndexTable.Cell>
                {orderTypes.length === 0
                  ? <Text as="span" tone="subdued">—</Text>
                  : <Dropdown size="slim" options={orderTypes} value={o.orderType} onChange={(v) => updateOrder(o.id, { orderType: v })} />}
              </IndexTable.Cell>
              <IndexTable.Cell><EditableAmount value={o.codAmount} editable onSave={(n) => updateOrder(o.id, { codAmount: n })} /></IndexTable.Cell>
              <IndexTable.Cell><RiskCell order={o} /></IndexTable.Cell>
              <IndexTable.Cell>
                <Tooltip content="Shipping details">
                  <Button icon={MenuVerticalIcon} variant="tertiary" size="micro" accessibilityLabel="Shipping details" onClick={() => setDetailsForId(o.id)} />
                </Tooltip>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </div>
      {detailsOrder && (
        <FulfillmentDetailsModal
          order={detailsOrder}
          isCouriersNext={isCouriersNext}
          pickupLabel={pickupSelected ? fulfillmentPickupAddressLabel(pickupSelected) : '—'}
          onClose={() => setDetailsForId(null)}
          onSave={(patch) => { updateOrder(detailsOrder.id, patch); setDetailsForId(null); }}
        />
      )}
    </div>
  );
}
