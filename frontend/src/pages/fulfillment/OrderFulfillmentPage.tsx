// Order Fulfillment: bulk "select orders, pick a courier, fulfill" screen, plus its
// live booking-progress screen. Ported from order-fulfillment.js. The order list and
// Fulfill are both live. Edits to a row's address/mobile are sent with the booking and
// override what's stored on the order for that parcel only (the order itself is not
// updated); tags/city edits are display-only.
// Same Polaris IndexTable/IndexFilters card as OrdersPage (shares its .table-card CSS).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, BlockStack, Box, Button, Card, IndexFilters, IndexTable, IndexTableSelectionType, InlineStack, Popover, ProgressBar, Spinner, Text, TextField, Tooltip,
  useIndexResourceState, useSetIndexFiltersMode,
} from '@shopify/polaris';
import { MenuHorizontalIcon, PrintIcon, RefreshIcon } from '@shopify/polaris-icons';
import { MetricsStrip } from '../../components/MetricsStrip';
import { Filter, FilterX } from 'lucide-react';
import { apiJson, apiJsonStream } from '../../api';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { Dropdown } from '../../components/Dropdown';
import { useStickyIndexTableHeader } from '../../components/useStickyIndexTableHeader';
import { DateRangePopover, dateToIso, isoToDate } from '../../components/DateRangePopover';
import { printAirwayBillsForOrders } from '../../logic/airwayBills';
import { orderHasAirwayBill } from '../../logic/orders';
import {
  FULFILLMENT_COURIERS, FULFILLMENT_DEFAULT_ORDER_TYPE, FULFILLMENT_DEFAULT_REMARK, FULFILLMENT_ORDER_TYPES,
  FULFILLMENT_COLUMN_VALUE, FULFILLMENT_PROGRESS_STATE_META, fulfillmentFilteredOrders, fulfillmentLineItemCount, fulfillmentRowMatchesQuery,
  fulfillmentPickupAddressLabel, type CustomerStatus, type FulfillmentCourier, type FulfillmentFilters,
  type FulfillmentOrder, type FulfillmentProgressOrder, type PickupAddress,
} from '../../logic/fulfillment';
import { EditableAmount } from '../../components/EditableCell';
import { FulfillmentDetailsModal } from './FulfillmentDetailsModal';
import { AdvanceModal } from '../orders/AdvanceModal';
import { useLedgersData } from '../finance/useLedgersData';

const COLUMNS: Array<{ key: string; title: string; alignment?: 'end'; tooltipContent?: string }> = [
  { key: 'order_number', title: 'Order ID' },
  { key: 'name', title: 'Name' },
  { key: 'address', title: 'Complete Address' },
  { key: 'mobile', title: 'Mobile Number' },
  { key: 'tags', title: 'Tags' },
  { key: 'city', title: 'City' },
  { key: 'ref', title: 'Ref', tooltipContent: "The rider's booking ID or phone, if you have one." },
  { key: 'courier_city', title: 'Courier City', tooltipContent: 'Select a courier above to populate this with its supported cities' },
  { key: 'order_type', title: 'Type', tooltipContent: "The courier's own order type." },
  { key: 'cod', title: 'CoD', alignment: 'end', tooltipContent: 'Amount the rider collects on delivery.' },
  { key: 'risk', title: 'Risk / Customer Status', tooltipContent: "Based on this customer's past delivered vs. total orders" },
  { key: 'actions', title: 'Actions' },
];
// A Local Delivery rider has no courier city, order type or COD (see logic/fulfillment.ts).
const LOCAL_DELIVERY_HIDDEN = new Set(['courier_city', 'order_type', 'cod']);

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
  const [filters, setFilters] = useState<FulfillmentFilters>({ columns: {}, dateFrom: null, dateTo: null });
  const [search, setSearch] = useState('');
  const [showFilterRow, setShowFilterRow] = useState(false);
  const [riskTab, setRiskTab] = useState(0);
  const [couriers, setCouriers] = useState<FulfillmentCourier[]>([]);
  const [selectedCourier, setSelectedCourier] = useState<FulfillmentCourier | null>(null);
  const [fulfillPanelOpen, setFulfillPanelOpen] = useState(false);
  const { mode, setMode } = useSetIndexFiltersMode();
  const [pickupAddresses, setPickupAddresses] = useState<PickupAddress[]>([]);
  const [pickupCode, setPickupCode] = useState('');
  const [courierCities, setCourierCities] = useState<string[]>([]);
  const [courierCitiesLoading, setCourierCitiesLoading] = useState(false);
  const [detailsForId, setDetailsForId] = useState<string | null>(null);
  const [fulfilling, setFulfilling] = useState(false);
  const [progress, setProgress] = useState<{ orders: FulfillmentProgressOrder[]; phase: 'booking' | 'shopify_sync' | 'done' } | null>(null);
  const isLocal = selectedCourier?.kind === 'local_delivery';
  // Local Delivery refuses an order short of a full advance; the progress screen lets it
  // be recorded on the spot and the booking retried.
  const [advanceForId, setAdvanceForId] = useState<string | null>(null);
  const { ledgers, loadLedgersList } = useLedgersData();
  const columns = useMemo(() => COLUMNS.filter((c) => (isLocal ? !LOCAL_DELIVERY_HIDDEN.has(c.key) : c.key !== 'ref')), [isLocal]);

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

  useEffect(() => {
    apiJson<string[]>('/orders/enabled-couriers', { fallback: 'Failed to load couriers' })
      .then((ids) => setCouriers(FULFILLMENT_COURIERS.filter((c) => ids.includes(c.id))))
      .catch((error: any) => showToast(error?.message || 'Failed to load couriers', 'error'));
  }, [showToast]);

  function autoSelectCourierCities(list: FulfillmentOrder[], cities: string[]): FulfillmentOrder[] {
    if (cities.length === 0) return list;
    const byNormalized = new Map(cities.map((c) => [c.trim().toLowerCase(), c]));
    return list.map((o) => (o.courierCity ? o : { ...o, courierCity: byNormalized.get((o.city || '').trim().toLowerCase()) || null }));
  }

  const filterOptions = useMemo(() => Object.fromEntries(
    ['tags', 'city', 'courier_city', 'order_type'].map((key) => [key, [...new Set(orders.flatMap(FULFILLMENT_COLUMN_VALUE[key]).filter(Boolean))].sort()]),
  ), [orders]);
  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length };
    for (const o of orders) { const t = o.customer_status?.tier || 'new'; counts[t] = (counts[t] || 0) + 1; }
    return counts;
  }, [orders]);
  const filtered = useMemo(() => {
    const tier = RISK_TABS[riskTab]?.tier;
    const rows = tier ? orders.filter((o) => (o.customer_status?.tier || 'new') === tier) : orders;
    return fulfillmentFilteredOrders(rows, filters).filter((o) => fulfillmentRowMatchesQuery(o, search));
  }, [orders, filters, riskTab, search]);
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(
    filtered as unknown as Array<FulfillmentOrder & { [key: string]: unknown }>, { resourceIDResolver: (o) => o.id },
  );
  const selectedOrders = useMemo(() => orders.filter((o) => selectedResources.includes(o.id)), [orders, selectedResources]);
  useStickyIndexTableHeader('#orderFulfillmentView', filtered.length > 0 && showFilterRow);

  function updateOrder(id: string, patch: Partial<FulfillmentOrder>) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  function needsAdvance(id: string): boolean {
    const order = orders.find((x) => x.id === id);
    return isLocal && !!order && order.advance_amount < order.total_amount;
  }

  async function pickCourier(courier: FulfillmentCourier) {
    setSelectedCourier(courier);
    setCourierCities([]);
    setOrders((prev) => prev.map((o) => ({ ...o, courierCity: null, orderType: FULFILLMENT_DEFAULT_ORDER_TYPE })));
    setPickupAddresses([]);
    setPickupCode('');
    if (courier.kind === 'local_delivery') return;
    setCourierCitiesLoading(true);
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
    if (!isLocal && !pickupCode) return 'Select a pickup location first';
    if (selectedOrders.length === 0) return 'Select at least one order';
    const missingCity = isLocal ? [] : selectedOrders.filter((o) => !o.courierCity);
    if (missingCity.length > 0) return `Pick a courier city for ${missingCity.length === 1 ? `order #${missingCity[0].order_number}` : `${missingCity.length} orders`} first`;
    return '';
  }, [fulfilling, selectedCourier, isLocal, pickupCode, selectedOrders]);

  async function fulfillSelected() {
    if (disabledReason) { showToast(disabledReason, 'error', { silent: true }); return; }
    const pickup = pickupAddresses.find((a) => a.code === pickupCode);
    const ok = await confirm({
      title: 'Fulfill Orders',
      message: isLocal
        ? `Send ${selectedOrders.length} order(s) by ${selectedCourier!.name}?\n\nThis marks them fulfilled in Shopify. Enter each order's delivery charge on the Local Deliveries page.`
        : `Book ${selectedOrders.length} order(s) with ${selectedCourier!.name}?\n\nPickup from: ${pickup ? fulfillmentPickupAddressLabel(pickup) : pickupCode}\n\nThis creates real shipments the courier will collect, and marks the orders fulfilled in Shopify.`,
      confirmText: 'Fulfill',
    });
    if (!ok) return;
    setFulfillPanelOpen(false);

    const progressOrders: FulfillmentProgressOrder[] = selectedOrders.map((o) => ({
      id: o.id, order_number: o.order_number, name: o.name, city: o.city, courier: selectedCourier!.name,
      state: 'pending', tracking_number: null, error: null,
    }));
    if (progressOrders[0]) progressOrders[0].state = 'booking';
    setProgress({ orders: progressOrders, phase: 'booking' });
    await runBooking(selectedOrders);
  }

  function retryFailed() {
    if (!progress) return;
    const failedIds = new Set(progress.orders.filter((o) => o.state === 'fail').map((o) => o.id));
    const targets = orders.filter((o) => failedIds.has(o.id));
    if (targets.length === 0) return;
    let first = true;
    setProgress({
      phase: 'booking',
      orders: progress.orders.map((o) => {
        if (!failedIds.has(o.id)) return o;
        const state = first ? 'booking' as const : 'pending' as const;
        first = false;
        return { ...o, state, error: null };
      }),
    });
    void runBooking(targets);
  }

  /** Streams bookings for `targets`, updating their rows in the already-shown progress screen. */
  async function runBooking(targets: FulfillmentOrder[]) {
    setFulfilling(true);
    const courierName = selectedCourier!.name;
    try {
      for await (const event of apiJsonStream<any>('/orders/fulfill', {
        body: isLocal ? {
          courier: selectedCourier!.id,
          orders: targets.map((o) => ({ order_id: o.id, tracking_number: o.trackingRef?.trim() || null })),
        } : {
          courier: selectedCourier!.id, pickup_address_code: pickupCode,
          orders: targets.map((o) => ({
            order_id: o.id, courier_city: o.courierCity, order_type: o.orderType, cod_amount: o.codAmount,
            customer_phone: o.mobile, customer_address: o.address,
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

  function setColumnFilter(key: string, value: string | string[] | null) {
    setFilters((f) => {
      const columns = { ...f.columns };
      if (value === null || value === '') delete columns[key]; else columns[key] = value;
      return { ...f, columns };
    });
  }

  function clearFilters() {
    setFilters({ columns: {}, dateFrom: null, dateTo: null });
  }

  const hasFilters = Object.keys(filters.columns).length > 0 || !!filters.dateFrom;
  const appliedFilters = Object.entries(filters.columns).map(([key, v]) => {
    const display = (s: string) => (key === 'risk' ? RISK_TABS.find((t) => t.tier === s)?.label || s : s);
    return {
      key,
      label: `${COLUMNS.find((c) => c.key === key)?.title}: ${Array.isArray(v) ? v.map(display).join(', ') : v}`,
      onRemove: () => setColumnFilter(key, null),
    };
  });

  const orderTypes = (selectedCourier && FULFILLMENT_ORDER_TYPES[selectedCourier.id]) || [];
  const isCouriersNext = selectedCourier?.id === 'couriers_next';
  const pickupSelected = pickupAddresses.find((a) => a.code === pickupCode);

  const courierChip = (c: FulfillmentCourier) => (c.logo
    ? <span className="fulfillment-courier-logo-chip"><img src={c.logo} alt={c.name} /></span>
    : <span className="fulfillment-courier-monogram" style={{ background: c.color }}>{c.monogram}</span>);

  usePageHeader({
    title: 'Order Fulfillment',
    search: { value: search, onChange: setSearch },
    actions: (
      <>
        <DateRangePopover
          title="Filter by order date"
          value={filters.dateFrom && filters.dateTo ? { from: dateToIso(filters.dateFrom), to: dateToIso(filters.dateTo) } : null}
          onChange={(r) => setFilters((f) => ({ ...f, dateFrom: r ? isoToDate(r.from) : null, dateTo: r ? isoToDate(r.to) : null }))}
        />
        <HeaderButton onClick={async () => { if (await fetchOrders()) showToast('Refreshed', 'success'); }}>Refresh</HeaderButton>
        <Popover
          active={fulfillPanelOpen} onClose={() => setFulfillPanelOpen(false)} preferredAlignment="right" fluidContent preventCloseOnChildOverlayClick
          activator={(
            <HeaderButton variant="primary" disclosure onClick={() => setFulfillPanelOpen((v) => !v)}>
              {selectedOrders.length > 0 ? `Fulfill ${selectedOrders.length} Order${selectedOrders.length === 1 ? '' : 's'}` : 'Fulfill Orders'}
            </HeaderButton>
          )}
        >
          <div className="fulfillment-panel">
            <BlockStack gap="300">
              <Dropdown
                label="Courier" placeholder="Select courier" fullWidth
                icon={selectedCourier ? courierChip(selectedCourier) : undefined}
                options={couriers.map((c) => ({ label: c.name, value: c.id }))}
                value={selectedCourier?.id || ''} onChange={(id) => pickCourier(couriers.find((c) => c.id === id)!)}
              />
              {!isLocal && (
                <Dropdown
                  label="Pickup location" placeholder={selectedCourier ? 'Select pickup location' : 'Select courier first'} fullWidth
                  disabled={pickupAddresses.length === 0} value={pickupCode} onChange={setPickupCode}
                  options={pickupAddresses.map((a) => ({ label: fulfillmentPickupAddressLabel(a), value: a.code }))}
                />
              )}
              <Text as="p" tone={disabledReason ? 'subdued' : 'success'} variant="bodySm">
                {disabledReason || `Ready to book ${selectedOrders.length} order(s) with ${selectedCourier!.name}`}
              </Text>
              <Button variant="primary" fullWidth disabled={!!disabledReason} onClick={fulfillSelected}>Book Orders</Button>
            </BlockStack>
          </div>
        </Popover>
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
    const pillTone = !done ? 'info' : failed === 0 ? 'success' : 'warning';
    const STATE_TONE = { pending: undefined, booking: 'info', ok: 'success', fail: 'critical' } as const;
    const printAll = async () => { try { await printAirwayBillsForOrders(progress.orders as any); } catch (e: any) { showToast(e?.message || 'Failed to print airway bills', 'error'); } };
    const advanceOrder = advanceForId ? orders.find((x) => x.id === advanceForId) : undefined;
    return (
      <div className="fulfillment-progress-wrap">
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Fulfillment Progress</Text>
                <Badge tone={pillTone}>{pillLabel}</Badge>
              </InlineStack>
              <Text as="span" tone="subdued">{progress.orders[0] ? `via ${progress.orders[0].courier}` : ''}</Text>
            </InlineStack>
            <MetricsStrip label="Fulfillment progress" tiles={[
              { label: 'Total', value: String(total) }, { label: 'Completed', value: String(ok) },
              { label: 'Failed', value: String(failed), negative: failed > 0 }, { label: 'Remaining', value: String(total - ok - failed) },
            ]} />
            <ProgressBar progress={total ? Math.round(((ok + failed) / total) * 100) : 0} size="small" tone={failed ? 'critical' : 'success'} />
            <BlockStack gap="200">
              {progress.orders.map((o) => {
                const meta = FULFILLMENT_PROGRESS_STATE_META[o.state];
                return (
                  <Box key={o.id} paddingBlock="200" borderBlockEndWidth="025" borderColor="border-secondary">
                    <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        {o.state === 'booking' ? <Spinner size="small" /> : <Badge tone={STATE_TONE[o.state]}>{meta.badge}</Badge>}
                        <BlockStack gap="0">
                          <Text as="span" fontWeight="semibold">#{o.order_number}</Text>
                          <Text as="span" tone="subdued" variant="bodySm">{[o.name, o.city].filter(Boolean).join(' · ')}</Text>
                        </BlockStack>
                      </InlineStack>
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        {o.state === 'fail'
                          ? <Text as="span" tone="critical">{o.error || 'Failed'}</Text>
                          : o.tracking_number ? <Text as="span" tone="subdued">{o.tracking_number}</Text> : null}
                        {done && o.state === 'fail' && needsAdvance(o.id) && (
                          <Button size="slim" onClick={() => { loadLedgersList(); setAdvanceForId(o.id); }}>Record Advance</Button>
                        )}
                        {orderHasAirwayBill(o as any) && (
                          <Button size="slim" icon={PrintIcon} onClick={async () => { try { await printAirwayBillsForOrders([o as any]); } catch (e: any) { showToast(e?.message || 'Failed to print airway bill', 'error'); } }}>Airway Bill</Button>
                        )}
                      </InlineStack>
                    </InlineStack>
                  </Box>
                );
              })}
            </BlockStack>
            <InlineStack align="end" gap="200">
              <Button icon={PrintIcon} disabled={!progress.orders.some((o) => orderHasAirwayBill(o as any))} onClick={printAll}>Print All Airway Bills</Button>
              {done && failed > 0 && <Button icon={RefreshIcon} onClick={retryFailed}>{`Retry Failed (${failed})`}</Button>}
              <Button variant="primary" disabled={!done} onClick={() => setProgress(null)}>Done</Button>
            </InlineStack>
          </BlockStack>
        </Card>
        {advanceOrder && (
          <AdvanceModal
            order={advanceOrder}
            ledgers={ledgers}
            onClose={() => setAdvanceForId(null)}
            onSaved={({ advance_amount }) => updateOrder(advanceOrder.id, { advance_amount: Number(advance_amount) || 0 })}
          />
        )}
      </div>
    );
  }

  function renderColumnFilterCell(key: string) {
    if (key === 'actions' || key === 'ref') return null;
    const options = key === 'risk' ? RISK_TABS.filter((t) => t.tier).map((t) => ({ value: t.tier!, label: t.label })) : filterOptions[key];
    if (options) {
      return (
        <Dropdown
          multiple fullWidth allLabel="All" searchable={key === 'city' || key === 'courier_city'} options={options}
          value={(filters.columns[key] as string[] | undefined) ?? null} onChange={(v) => setColumnFilter(key, v)}
        />
      );
    }
    return (
      <TextField
        label="" labelHidden autoComplete="off" variant="borderless" size="slim" clearButton
        align={key === 'cod' ? 'right' : undefined}
        placeholder="Search..." value={(filters.columns[key] as string | undefined) || ''}
        onChange={(v) => setColumnFilter(key, v)}
        onClearButtonClick={() => setColumnFilter(key, null)}
      />
    );
  }

  return (
    <div id="orderFulfillmentView" className="view active">
      <div className="table-card">
        <div className="table-index-filters">
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
          <Tooltip content={showFilterRow ? 'Hide filters' : 'Show filters'}>
            <HeaderButton icon={<Filter size={16} />} accessibilityLabel="Toggle filters" onClick={() => setShowFilterRow((v) => !v)} variant="tertiary" pressed={showFilterRow} />
          </Tooltip>
        </div>
        <IndexTable
          resourceName={{ singular: 'order', plural: 'orders' }}
          // Same trick as OrdersPage: keep itemCount >= 1 so Polaris doesn't swap the whole
          // <table> (and our filter subheader row) for its emptyState when nothing matches.
          itemCount={filtered.length || 1}
          selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
          onSelectionChange={handleSelectionChange}
          headings={columns.map(({ title, alignment, tooltipContent }) => ({ title, alignment, tooltipContent })) as any}
          loading={loading}
          condensed={false}
        >
          {showFilterRow && (
            <IndexTable.Row id="__filters__" position={-1} rowType="subheader" hideSelectable>
              {columns.map((col) => <IndexTable.Cell key={col.key}>{renderColumnFilterCell(col.key)}</IndexTable.Cell>)}
            </IndexTable.Row>
          )}
          {filtered.length === 0 && !loading && (
            <IndexTable.Row id="__empty__" position={-2} hideSelectable>
              <IndexTable.Cell colSpan={columns.length}>
                <div className="table-empty">No unfulfilled orders match these filters.</div>
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
              {isLocal ? (
                <IndexTable.Cell>
                  <TextField
                    label="" labelHidden autoComplete="off" variant="borderless" size="slim" placeholder="Optional"
                    value={o.trackingRef || ''} onChange={(v) => updateOrder(o.id, { trackingRef: v })}
                  />
                </IndexTable.Cell>
              ) : (
                <>
                  <IndexTable.Cell>
                    <Dropdown
                      searchable size="slim" disabled={courierCities.length === 0}
                      placeholder={courierCitiesLoading ? 'Loading…' : '—'}
                      options={courierCities} value={o.courierCity || ''} onChange={(city) => updateOrder(o.id, { courierCity: city })}
                    />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {orderTypes.length === 0
                      ? <Text as="span" tone="subdued">—</Text>
                      : <Dropdown size="slim" options={orderTypes} value={o.orderType} onChange={(v) => updateOrder(o.id, { orderType: v })} />}
                  </IndexTable.Cell>
                  <IndexTable.Cell><EditableAmount value={o.codAmount} editable onSave={(n) => updateOrder(o.id, { codAmount: n })} /></IndexTable.Cell>
                </>
              )}
              <IndexTable.Cell><RiskCell order={o} /></IndexTable.Cell>
              <IndexTable.Cell>
                <Tooltip content="Shipping details">
                  <Button icon={MenuHorizontalIcon} variant="tertiary" size="micro" accessibilityLabel="Shipping details" onClick={() => setDetailsForId(o.id)} />
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
