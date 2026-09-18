// Order Fulfillment: bulk "select orders, pick a courier, fulfill" screen, plus its
// live booking-progress screen. Ported from order-fulfillment.js. The order list and
// Fulfill are both live; editing a row's address/mobile/tags/city here is local-only
// and is NOT sent to the courier, which books from what's stored on the order.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiJson, apiJsonStream } from '../../api';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { createDateRangePicker, type DateRangePickerHandle } from '../../dateRangePicker';
import { formatDateDDMMYYYY } from '../../logic/shared';
import { printAirwayBillsForOrders } from '../../logic/airwayBills';
import { orderHasAirwayBill } from '../../logic/orders';
import {
  FULFILLMENT_COURIERS, FULFILLMENT_DEFAULT_ORDER_TYPE, FULFILLMENT_DEFAULT_REMARK, FULFILLMENT_ORDER_TYPES,
  FULFILLMENT_PROGRESS_STATE_META, FULFILLMENT_RISK_ICONS, fulfillmentFilteredOrders, fulfillmentLineItemCount,
  fulfillmentPickupAddressLabel, fulfillmentTagBadgeClass, type FulfillmentCourier, type FulfillmentFilters,
  type FulfillmentOrder, type FulfillmentProgressOrder, type PickupAddress,
} from '../../logic/fulfillment';
import { CourierCityPicker } from './CourierCityPicker';
import { FulfillmentDetailsModal } from './FulfillmentDetailsModal';

function MultiSelectFilter({ allLabel, options, selected, onChange }: { allLabel: string; options: string[]; selected: string[] | null; onChange: (v: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const ticked = selected ?? options;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const label = options.length === 0 ? allLabel : ticked.length === options.length ? allLabel : ticked.length === 0 ? 'None' : ticked.length === 1 ? ticked[0] : `${ticked.length} selected`;

  function toggle(v: string) {
    const next = ticked.includes(v) ? ticked.filter((s) => s !== v) : [...ticked, v];
    onChange(next.length === options.length ? null : next);
  }

  return (
    <div className="pa-customize" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="form-input checkbox-filter-control__btn" onClick={() => setOpen((v) => !v)}>{label}</button>
      {open && (
        <div className="pa-pop">
          <label><input type="checkbox" checked={ticked.length === options.length} onChange={() => onChange(ticked.length === options.length ? [] : null)} /> {allLabel}</label>
          {options.map((o) => <label key={o}><input type="checkbox" checked={ticked.includes(o)} onChange={() => toggle(o)} /> {o}</label>)}
        </div>
      )}
    </div>
  );
}

function EditableCell({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing) {
    return (
      <input
        type="text" className="fulfillment-edit-input" autoFocus value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); onCommit(draft); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { setEditing(false); onCommit(draft); }
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="fulfillment-editable-cell">
      <span className="fulfillment-editable-text" title={value}>{value}</span>
      <button type="button" className="fulfillment-edit-btn" title="Edit" onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true); }}><i className="fa-solid fa-pen" /></button>
    </div>
  );
}

function TagsCell({ tags, allTags, onChange }: { tags: string[]; allTags: string[]; onChange: (tags: string[]) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <div className="fulfillment-tags-cell" onClick={(e) => e.stopPropagation()}>
      {tags.map((t) => <span className={`fulfillment-tag-badge ${fulfillmentTagBadgeClass(t)}`} key={t}>{t}</span>)}
      <button type="button" className="fulfillment-tags-toggle" title="Edit tags" onClick={() => setOpen((v) => !v)}><i className="fa-solid fa-chevron-down" /></button>
      {open && (
        <div className="fulfillment-tags-menu open">
          {allTags.map((t) => (
            <label key={t}>
              <input
                type="checkbox" checked={tags.includes(t)}
                onChange={(e) => onChange(e.target.checked ? [...tags, t] : tags.filter((x) => x !== t))}
              /> {t}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function RiskCell({ order }: { order: FulfillmentOrder }) {
  const status = order.customer_status || { tier: 'new' as const, label: 'New Customer', received: 0, total: 0 };
  const icon = FULFILLMENT_RISK_ICONS[status.tier];
  const subtitle = status.total === 0 ? 'No previous orders' : `${status.received}/${status.total} orders delivered`;
  return (
    <>
      <div className={`fulfillment-risk-badge fulfillment-risk-badge--${status.tier}`}>
        {icon ? <i className={`fa-solid ${icon === 'shield-check' ? 'fa-shield-halved' : 'fa-user-plus'}`} /> : <span className="fulfillment-risk-dot" />}
        <span>{status.label}</span>
      </div>
      <div className="fulfillment-risk-sub"><span>{subtitle}</span><i className="fa-solid fa-circle-info" title="Based on this customer's past delivered vs. total orders" /></div>
    </>
  );
}

export function OrderFulfillmentPage() {
  const confirm = useConfirm();
  const { showToast } = useToast();

  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FulfillmentFilters>({ cities: null, tags: null, dateFrom: null, dateTo: null });
  const [selectedCourier, setSelectedCourier] = useState<FulfillmentCourier | null>(null);
  const [courierMenuOpen, setCourierMenuOpen] = useState(false);
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
  const filtered = useMemo(() => fulfillmentFilteredOrders(orders, filters), [orders, filters]);
  const selectedOrders = useMemo(() => orders.filter((o) => selectedIds.has(o.id)), [orders, selectedIds]);

  function updateOrder(id: string, patch: Partial<FulfillmentOrder>) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  function toggleSelectAllVisible(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((o) => { if (checked) next.add(o.id); else next.delete(o.id); });
      return next;
    });
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
            setSelectedIds((prev) => { const next = new Set(prev); next.delete(result.order_id); return next; });
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

  usePageHeader({
    title: 'Order Fulfillment',
    actions: (
      <>
        <div className="fulfillment-filters-bar">
          <div className="fulfillment-filter-group">
            <label>City</label>
            <MultiSelectFilter allLabel="All Cities" options={allCities} selected={filters.cities} onChange={(v) => setFilters((f) => ({ ...f, cities: v }))} />
          </div>
          <div className="fulfillment-filter-group">
            <label>Tags</label>
            <MultiSelectFilter allLabel="All Tags" options={allTags} selected={filters.tags} onChange={(v) => setFilters((f) => ({ ...f, tags: v }))} />
          </div>
          <div className="fulfillment-filter-group">
            <label>Date Range</label>
            <div className="fulfillment-date-range-input-wrap">
              <i className="fa-regular fa-calendar" />
              <button ref={setDateRangeNode} type="button" className="fulfillment-date-range-input" style={{ textAlign: 'left' }}>{dateRangeLabel}</button>
            </div>
          </div>
          <button type="button" className="btn btn-secondary fulfillment-clear-filters-btn" onClick={clearFilters}>Clear Filters</button>
        </div>
        <button type="button" className="btn btn-secondary header-toolbar-btn" onClick={() => showToast('Export not implemented yet', 'info', { silent: true })}><i className="fa-solid fa-arrow-up-from-bracket" /> Export</button>
        <button type="button" className="btn btn-secondary header-toolbar-btn" onClick={async () => { if (await fetchOrders()) showToast('Refreshed', 'success'); }}><i className="fa-solid fa-arrows-rotate" /> Refresh</button>
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

  const allSelected = filtered.length > 0 && filtered.every((o) => selectedIds.has(o.id));
  const someSelected = !allSelected && filtered.some((o) => selectedIds.has(o.id));
  const orderTypes = (selectedCourier && FULFILLMENT_ORDER_TYPES[selectedCourier.id]) || [];
  const isCouriersNext = selectedCourier?.id === 'couriers_next';
  const pickupSelected = pickupAddresses.find((a) => a.code === pickupCode);

  return (
    <div className="fulfillment-body">
      <div className="fulfillment-table-panel">
        <div className="fulfillment-table-toolbar">
          <label className="fulfillment-select-all">
            <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected; }} onChange={(e) => toggleSelectAllVisible(e.target.checked)} />
            <span>Select all</span>
          </label>
          <button type="button" className="fulfillment-link-btn" onClick={() => setSelectedIds(new Set())}>Clear Selection</button>
          <div className="fulfillment-table-toolbar-spacer" />
          <span className="fulfillment-toolbar-stat">Total Orders: {orders.length}</span>
          {selectedIds.size > 0 && <span className="fulfillment-toolbar-badge">{selectedIds.size} selected</span>}

          {selectedIds.size > 0 && (
            <div className="fulfillment-side-panel-content" style={{ display: 'flex' }}>
              <div className="fulfillment-courier-select-wrap">
                <button type="button" className="fulfillment-courier-select-btn" onClick={(e) => { e.stopPropagation(); setCourierMenuOpen((v) => !v); }}>
                  <span className="fulfillment-courier-select-label">
                    {selectedCourier ? (selectedCourier.logo
                      ? <span className="fulfillment-courier-logo-chip"><img src={selectedCourier.logo} alt={selectedCourier.name} /></span>
                      : <span className="fulfillment-courier-monogram" style={{ background: selectedCourier.color }}>{selectedCourier.monogram}</span>) : null}
                    {selectedCourier ? selectedCourier.name : 'Select Courier'}
                  </span>
                  <i className="fa-solid fa-chevron-down fulfillment-courier-select-caret" />
                </button>
                <div className={'fulfillment-courier-menu' + (courierMenuOpen ? ' open' : '')} onClick={(e) => e.stopPropagation()}>
                  {FULFILLMENT_COURIERS.map((c) => (
                    <div className="fulfillment-courier-menu-item" key={c.id} onClick={() => pickCourier(c)}>
                      {c.logo ? <span className="fulfillment-courier-logo-chip"><img src={c.logo} alt={c.name} /></span> : <span className="fulfillment-courier-monogram" style={{ background: c.color }}>{c.monogram}</span>}
                      <span>{c.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="form-group fulfillment-pickup-group">
                <select className="form-input" disabled={pickupAddresses.length === 0} value={pickupCode} title={pickupSelected ? fulfillmentPickupAddressLabel(pickupSelected) : ''} onChange={(e) => setPickupCode(e.target.value)}>
                  {pickupAddresses.length === 0
                    ? <option value="">Select courier first</option>
                    : pickupAddresses.map((a) => <option key={a.code} value={a.code} title={fulfillmentPickupAddressLabel(a)}>{fulfillmentPickupAddressLabel(a)}</option>)}
                </select>
              </div>
              <button type="button" className="btn btn-primary fulfillment-fulfill-btn" disabled={!!disabledReason} title={disabledReason} onClick={fulfillSelected}>
                <i className="fa-solid fa-circle-check" /> Fulfill Order
              </button>
              <button type="button" className="btn btn-secondary fulfillment-cancel-btn" onClick={() => setSelectedIds(new Set())}>Cancel</button>
            </div>
          )}
        </div>
        <div className="fulfillment-table-wrap">
          <table className="fulfillment-table">
            <thead>
              <tr>
                <th className="fulfillment-col-check"><input type="checkbox" checked={allSelected} onChange={(e) => toggleSelectAllVisible(e.target.checked)} /></th>
                <th>Order ID</th>
                <th>Name</th>
                <th>Complete Address</th>
                <th>Mobile Number</th>
                <th>Tags</th>
                <th>City</th>
                <th className="fulfillment-th-courier-city">Courier City <i className="fa-solid fa-circle-info" title="Select a courier above to populate this with its supported cities" /></th>
                <th className="fulfillment-th-order-type">Type <i className="fa-solid fa-circle-info" title="The courier's own order type." /></th>
                <th className="fulfillment-th-cod">CoD <i className="fa-solid fa-circle-info" title="Amount the rider collects on delivery." /></th>
                <th className="fulfillment-th-risk">Risk / Customer Status <i className="fa-solid fa-circle-info" title="Based on this customer's past delivered vs. total orders" /></th>
                <th className="fulfillment-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={12} className="empty-state">Loading unfulfilled orders…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={12} className="empty-state">No unfulfilled orders match these filters.</td></tr>
              ) : filtered.map((o) => (
                <tr key={o.id} className={selectedIds.has(o.id) ? 'fulfillment-row--selected' : ''}>
                  <td className="fulfillment-col-check">
                    <input
                      type="checkbox" checked={selectedIds.has(o.id)}
                      onChange={(e) => setSelectedIds((prev) => { const next = new Set(prev); if (e.target.checked) next.add(o.id); else next.delete(o.id); return next; })}
                    />
                  </td>
                  <td className="fulfillment-col-orderid"><span className="fulfillment-order-id">#{o.order_number}</span></td>
                  <td className="fulfillment-col-name" title={o.name}>{o.name}</td>
                  <td><EditableCell value={o.address} onCommit={(v) => updateOrder(o.id, { address: v.trim() || o.address })} /></td>
                  <td><EditableCell value={o.mobile} onCommit={(v) => updateOrder(o.id, { mobile: v.trim() || o.mobile })} /></td>
                  <td><TagsCell tags={o.tags} allTags={allTags} onChange={(tags) => updateOrder(o.id, { tags })} /></td>
                  <td className="fulfillment-city-fixed" title="Entered by the customer">{o.city}</td>
                  <td className="fulfillment-courier-city-cell">
                    <CourierCityPicker value={o.courierCity} cities={courierCities} loading={courierCitiesLoading} onChange={(city) => updateOrder(o.id, { courierCity: city })} />
                  </td>
                  <td className="fulfillment-order-type-cell">
                    {orderTypes.length === 0
                      ? <span className="fulfillment-order-type-none">—</span>
                      : (
                        <select className="fulfillment-order-type-select" value={o.orderType} onChange={(e) => updateOrder(o.id, { orderType: e.target.value })}>
                          {orderTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                  </td>
                  <td className="fulfillment-col-cod">
                    <input
                      type="number" className="fulfillment-cod-input" min={0} step={0.01} defaultValue={o.codAmount}
                      onBlur={(e) => updateOrder(o.id, { codAmount: Math.max(0, parseFloat(e.target.value) || 0) })}
                    />
                  </td>
                  <td className="fulfillment-risk-cell"><RiskCell order={o} /></td>
                  <td className="fulfillment-actions-cell">
                    <button type="button" className="fulfillment-kebab-btn" title="Shipping details" onClick={() => setDetailsForId(o.id)}>&#8942;</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
