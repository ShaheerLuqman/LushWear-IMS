// Courier Payment Report: what the courier still owes for delivered/returned orders,
// grouped by the date the courier picked the parcel up and then by courier (mirrors how
// couriers batch-settle - one payment per pickup run), plus which orders are still in
// transit (no final courier outcome yet). Reads the same orders data as the Orders grid
// and reuses its receivable formula (computeReceivable, in orders-grid.js) and status badge
// classes (orderStatusBadgeClass, in orders-columns.js) so nothing here drifts from the
// Orders grid.

let courierPaymentReportGridApi = null;

// Every order, unfiltered - courier/status/search/date-range are all client-side facets
// re-sliced from this on every filter change, so changing a filter never refetches.
let courierPaymentReportOrders = [];

const COURIER_FILTER_ALL = '__all_couriers__';

// RFD/CNA/ICA (return-to-forwarder, consignee unavailable, incomplete address) are
// courier-reported problem states, not a final outcome - they count as still in transit,
// same as plain unfulfilled/fulfilled. Cancelled orders never shipped, so they're left out
// of this page entirely (neither bucket, not shown in the table).
const COURIER_RESOLVED_STATUSES = new Set(['delivered', 'returned']);
const COURIER_IN_TRANSIT_STATUSES = new Set(['unfulfilled', 'fulfilled', 'rfd', 'cna', 'ica']);

function billPickupDateLabel(bill) {
    return formatDateDDMMYYYY(bill.pickupDate);
}

function billCourierLabel(bill) {
    return formatCourierForDisplay(bill.courier);
}

const BILL_STATUS_META = {
    in_transit: { label: 'In Transit', cls: 'grid-status-unfulfilled', barColor: '#7c3aed' },
    paid: { label: 'Paid', cls: 'grid-status-delivered', barColor: '#16a34a' },
    partially_paid: { label: 'Partially Paid', cls: 'grid-status-fulfilled', barColor: '#ca8a04' },
    unpaid: { label: 'Unpaid', cls: 'grid-status-returned', barColor: '#dc2626' },
};

/** Payment Progress stacked-bar segment colors - kept in sync with the matching
 * .payment-progress__segment--* rules in styles.css (used there since the bar itself is
 * built as an HTML string, not styled inline per segment). */
const PAYMENT_PROGRESS_COLORS = {
    received: '#16a34a',
    deductibles: '#f59e0b',
};

/** Default pickup-date range shown on first load: the 1st of this month through today
 * (local calendar, matching pickupDateKey's own convention) - a sensible "this month so
 * far" starting point rather than an unbounded table. */
function defaultCourierPaymentReportDateRange() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yyyyMm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    return { from: `${yyyyMm}-01`, to: `${yyyyMm}-${pad(now.getDate())}` };
}

let courierPaymentReportDateRange = defaultCourierPaymentReportDateRange();

function distinctCouriers(orderRows) {
    const set = new Set();
    orderRows.forEach((order) => {
        const courier = (order.courier || '').trim();
        if (courier) set.add(courier);
    });
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Default the courier filter to PostEx - for now, that's the only courier this report
 * gets used for day to day. Falls back to "All couriers" once PostEx isn't in the list. */
function populateCourierPaymentReportCourierFilter(orderRows) {
    const selectEl = document.getElementById('courierPaymentReportCourierFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const couriers = distinctCouriers(orderRows);
    const options = [
        { value: COURIER_FILTER_ALL, label: 'All couriers' },
        ...couriers.map((c) => ({ value: c, label: c })),
    ];
    selectEl.innerHTML = options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    const postexCourier = couriers.find((c) => c.toLowerCase() === 'postex');
    const defaultVal = postexCourier || COURIER_FILTER_ALL;
    selectEl.value = (currentVal && options.some((o) => o.value === currentVal)) ? currentVal : defaultVal;
}

/** Courier + free-text search are per-order facets (applied before bundling and used for
 * the summary cards too); pickup-date range and payment status are applied later since
 * they depend on how orders get grouped/aggregated. */
function courierPaymentReportFilteredOrders() {
    const courier = document.getElementById('courierPaymentReportCourierFilter')?.value;
    const query = (document.getElementById('courierPaymentReportSearchFilter')?.value || '').trim().toLowerCase();

    return courierPaymentReportOrders.filter((order) => {
        if (courier && courier !== COURIER_FILTER_ALL && (order.courier || '').trim() !== courier) return false;
        if (query) {
            const courierMatch = (order.courier || '').toLowerCase().includes(query);
            const orderNoMatch = String(order.order_number ?? '').toLowerCase().includes(query);
            if (!courierMatch && !orderNoMatch) return false;
        }
        return true;
    });
}

/** netOwed > 0 means the courier owes the shop overall; < 0 means the shop owes the
 * courier (e.g. return handling fees outweighing any COD collected). Ignores the pickup-
 * date range on purpose - these cards are the courier/search-scoped overview, while the
 * date range only narrows which bills the table below shows. */
function courierPaymentReportSummary(orderRows) {
    let inTransit = 0;
    let resolved = 0;
    let netOwed = 0;
    const inTransitByStatus = {};

    orderRows.forEach((order) => {
        const status = (order.order_status || '').toLowerCase();
        if (COURIER_IN_TRANSIT_STATUSES.has(status)) {
            inTransit++;
            inTransitByStatus[order.order_status] = (inTransitByStatus[order.order_status] || 0) + 1;
        } else if (COURIER_RESOLVED_STATUSES.has(status)) {
            resolved++;
            const receivable = computeReceivable(order);
            if (receivable != null) netOwed += receivable;
        }
    });

    return { inTransit, resolved, netOwed, inTransitByStatus };
}

function renderCourierPaymentReportSummary(summary) {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    setText('courierPayReportInTransitCount', summary.inTransit.toLocaleString());
    const breakdown = Object.entries(summary.inTransitByStatus)
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => `${count} ${status}`)
        .join(' · ');
    setText('courierPayReportInTransitDetail', breakdown || 'None in transit');

    setText('courierPayReportResolvedCount', summary.resolved.toLocaleString());

    const net = summary.netOwed;
    const netEl = document.getElementById('courierPayReportNetOwed');
    if (netEl) {
        netEl.textContent = net < 0 ? `-Rs ${formatMoney(-net)}` : `Rs ${formatMoney(net)}`;
        netEl.style.color = net < 0 ? 'var(--danger)' : '';
    }
    setText('courierPayReportNetOwedDetail', net > 0 ? 'Courier owes you' : net < 0 ? 'You owe the courier' : 'Settled');
}

/** Local calendar date of courier_pickup_date as a sortable YYYY-MM-DD key, or null when
 * not yet picked up - those orders are excluded from the grouped table entirely, since
 * there's no date to group them by (buildCourierPaymentReportBills skips them). */
function pickupDateKey(order) {
    if (!order.courier_pickup_date) return null;
    const d = new Date(order.courier_pickup_date);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Cash-on-delivery amount for one order: total minus advance, for every order
 * regardless of status - unlike computeReceivable, this doesn't wait for (or exclude
 * as 0 for returns) a final delivered/returned outcome, since it's just the raw
 * customer-facing COD figure, not a courier settlement amount. */
function computeCod(order) {
    return (parseFloat(order.total_amount) || 0) - (parseFloat(order.advance_amount) || 0);
}

/** Aggregate one bill's orders into its money columns and status. Bill Value, Advance,
 * Gross COD, Delivery Charges and Taxes are summed over every order in the bill (raw
 * customer-facing/courier-cost figures, independent of outcome). Net Receivable is then
 * Gross COD minus those Delivery Charges and Taxes - a bill-level total, not a sum of
 * per-order receivables. Received only accumulates over resolved *and settled* orders
 * (via computeReceivable, since that's the only place an order's own receivable is known),
 * and Remaining is just Net Receivable minus that. */
function aggregateCourierPaymentReportBill(bill) {
    let billValue = 0;
    let advanceTotal = 0;
    let charges = 0;
    let taxes = 0;
    let returnedTotal = 0;
    let receivedAmount = 0;
    let resolvedCount = 0;
    let settledCount = 0;
    let inTransitCount = 0;

    bill.orders.forEach((order) => {
        const status = (order.order_status || '').toLowerCase();
        // Bill Value already nets out the advance (it's what the courier is actually
        // handling), so nothing downstream needs to deduct advance again - advanceTotal
        // is tracked only for reference (the "Advance Received" stat card).
        billValue += computeCod(order);
        advanceTotal += parseFloat(order.advance_amount) || 0;
        charges += parseFloat(order.delivery_charge) || 0;
        taxes += parseFloat(order.tax_amount) || 0;
        if (status === 'returned') returnedTotal += parseFloat(order.total_amount) || 0;

        if (COURIER_IN_TRANSIT_STATUSES.has(status)) {
            inTransitCount++;
            return;
        }
        if (!COURIER_RESOLVED_STATUSES.has(status)) return;
        resolvedCount++;
        if (!order.is_order_settled) return;
        const receivable = computeReceivable(order);
        if (receivable == null) return;
        settledCount++;
        receivedAmount += receivable;
    });

    let status;
    if (resolvedCount === 0) status = 'in_transit';
    else if (settledCount === resolvedCount) status = 'paid';
    else if (settledCount === 0) status = 'unpaid';
    else status = 'partially_paid';

    // Gross COD is Bill Value with the returned orders' full value backed out too - the
    // running total after both deductions, not a separately-tracked figure, so it can't
    // drift out of step with the Bill Value/Returned Orders shown above it.
    const grossCod = billValue - returnedTotal;
    const netReceivable = grossCod - charges - taxes;

    return {
        ...bill,
        totalOrders: bill.orders.length,
        inTransitCount,
        resolvedCount,
        settledCount,
        billValue,
        advanceTotal,
        grossCod,
        charges,
        taxes,
        returnedTotal,
        netReceivable,
        receivedAmount,
        remainingAmount: netReceivable - receivedAmount,
        status,
    };
}

/** Group orders by (pickup date, courier) into one bill row each, newest pickup date
 * first, restricted to the active pickup-date range. Orders with no pickup date yet
 * (delivery status not fetched) are left out entirely - they can't be placed on the
 * pickup-date timeline, but still count in the summary cards above. */
function buildCourierPaymentReportBills(orderRows) {
    const { from, to } = courierPaymentReportDateRange;
    const groups = new Map();
    orderRows.forEach((order) => {
        const dateKey = pickupDateKey(order);
        if (!dateKey) return;
        if (from && dateKey < from) return;
        if (to && dateKey > to) return;
        const courier = (order.courier || '').trim() || 'Unknown';
        const key = `${dateKey}|${courier}`;
        if (!groups.has(key)) {
            groups.set(key, { pickupDate: new Date(order.courier_pickup_date), pickupDateKey: dateKey, courier, orders: [] });
        }
        groups.get(key).orders.push(order);
    });

    return [...groups.values()]
        .map(aggregateCourierPaymentReportBill)
        .sort((a, b) => b.pickupDate - a.pickupDate || a.courier.localeCompare(b.courier, undefined, { sensitivity: 'base' }));
}

/** Payment Progress tracks Bill Value (already net of advance - see
 * aggregateCourierPaymentReportBill) against two claims on it: the amount the courier has
 * actually paid back for settled orders, and the deductibles the courier/the bill itself
 * keeps - delivery charges, taxes, and the full total of any returned orders (never
 * coming back at all). Whatever's left over (billValue minus both) is still outstanding.
 * Shared by the bill grid's stacked bar and the detail screen's pie so both stay in sync.
 * Each ratio is clamped independently, so in an edge case where one claim alone exceeds
 * the bill value the segments can visually overrun 100% rather than silently
 * under-report - that's rare enough in real data not to be worth normalizing away. */
function paymentProgressStats(bill) {
    const billValue = bill.billValue;
    const received = bill.receivedAmount;
    const deductibles = bill.charges + bill.taxes + bill.returnedTotal;
    const accountedFor = received + deductibles;
    const remaining = Math.max(0, billValue - accountedFor);
    const ratio = (amount) => billValue > 0 ? Math.max(0, Math.min(100, Math.round((amount / billValue) * 100))) : 0;
    return {
        billValue,
        received,
        deductibles,
        remaining,
        pct: ratio(accountedFor),
        receivedPct: ratio(received),
        deductiblesPct: ratio(deductibles),
        remainingPct: ratio(remaining),
    };
}

/** Cumulative conic-gradient stops for the detail screen's pie (received, then
 * deductibles, then whatever's left as "remaining"). Computed from running totals rather
 * than the independently-clamped *Pct fields above, so the slices always add up to
 * exactly one full circle even in the edge case where those ratios would overrun. */
function paymentProgressPieStops(stats) {
    const { billValue, received, deductibles } = stats;
    const pct = (amount) => billValue > 0 ? (amount / billValue) * 100 : 0;
    const receivedEnd = Math.min(100, pct(received));
    const deductiblesEnd = Math.min(100, receivedEnd + pct(deductibles));
    return { receivedEnd, deductiblesEnd };
}

function paymentProgressCellHtml(bill) {
    const stats = paymentProgressStats(bill);
    const dot = (color, gapBefore) => `<span class="payment-progress__dot${gapBefore ? ' payment-progress__dot--gap' : ''}" style="background: ${color};"></span>`;
    const meta = `${dot(PAYMENT_PROGRESS_COLORS.received)}Recv Rs ${formatMoney(stats.received)}`
        + `${dot(PAYMENT_PROGRESS_COLORS.deductibles, true)}Ded Rs ${formatMoney(stats.deductibles)}`;
    const tooltip = `Received: Rs ${formatMoney(stats.received)} · `
        + `Deductibles: Rs ${formatMoney(stats.deductibles)} · Remaining: Rs ${formatMoney(stats.remaining)}`;
    return `
        <div class="payment-progress">
            <div class="payment-progress__row">
                <span class="payment-progress__amounts">Rs ${formatMoney(stats.billValue)}</span>
                <span class="payment-progress__pct">${stats.pct}%</span>
            </div>
            <div class="payment-progress__bar payment-progress__bar--stacked" title="${escapeHtml(tooltip)}">
                <div class="payment-progress__segment payment-progress__segment--received" style="width: ${stats.receivedPct}%;"></div>
                <div class="payment-progress__segment payment-progress__segment--deductibles" style="width: ${stats.deductiblesPct}%;"></div>
            </div>
            <div class="payment-progress__meta">${meta}</div>
        </div>`;
}

/** ag-grid cellRenderer wrapper for paymentProgressCellHtml. A returned HTML *string*
 * gets set as innerHTML directly on ag-grid's own cell-value wrapper, which doesn't give
 * the bar a reliable block-level container to size 100% width against (it ends up
 * shrunk to content, not covering the column) - returning an actual DOM element instead
 * (same fix as createCourierPaymentReportViewButton's .bill-cell-center) gives it one. */
function createPaymentProgressCellElement(params) {
    const wrapper = document.createElement('div');
    wrapper.className = 'payment-progress-cell-wrap';
    wrapper.innerHTML = paymentProgressCellHtml(params.data);
    return wrapper;
}

function createCourierPaymentReportViewButton(params) {
    const bill = params.data;
    const wrapper = document.createElement('div');
    wrapper.className = 'bill-cell-center';
    if (!bill) return wrapper;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bill-view-btn';
    btn.innerHTML = '<i class="fa-solid fa-eye"></i><span>View Details</span>';
    btn.title = 'View orders in this bill';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openCourierPaymentReportBillDetail(bill);
    });

    wrapper.appendChild(btn);
    return wrapper;
}

// The bill currently shown on the detail screen - guards the async shipping-info
// fetch below against applying stale results after the user navigates to a different
// bill (or back to the list) before that fetch resolves.
let courierPaymentReportCurrentBill = null;

function renderCourierPaymentReportDetailHeader(bill) {
    const badge = document.getElementById('courierPaymentReportDetailStatusBadge');
    if (badge) {
        const meta = BILL_STATUS_META[bill.status] || BILL_STATUS_META.unpaid;
        badge.className = `grid-status-badge ${meta.cls}`;
        badge.textContent = meta.label;
    }
    const subtitle = document.getElementById('courierPaymentReportDetailSubtitle');
    if (subtitle) {
        subtitle.textContent = `${billPickupDateLabel(bill)} · ${billCourierLabel(bill)} · `
            + `${bill.totalOrders} order${bill.totalOrders === 1 ? '' : 's'}`;
    }
}

function renderCourierPaymentReportDetailStats(bill) {
    const grid = document.getElementById('courierPaymentReportDetailStatsGrid');
    if (!grid) return;
    const netColor = bill.netReceivable < 0 ? 'var(--danger)' : 'var(--success)';
    grid.innerHTML = `
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Total Orders</span>
                <span class="stat-detail">${bill.resolvedCount} resolved${bill.inTransitCount > 0 ? ` · ${bill.inTransitCount} in transit` : ''}</span>
                <span class="stat-value">${bill.totalOrders}</span>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Bill Value</span>
                <span class="stat-value">Rs ${formatMoney(bill.billValue)}</span>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Advance Received</span>
                <span class="stat-value">Rs ${formatMoney(bill.advanceTotal)}</span>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Returned Orders</span>
                <span class="stat-value">- Rs ${formatMoney(bill.returnedTotal)}</span>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Gross COD</span>
                <span class="stat-value">Rs ${formatMoney(bill.grossCod)}</span>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Total Delivery Charges</span>
                <span class="stat-value">- Rs ${formatMoney(bill.charges)}</span>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Total Taxes (SST)</span>
                <span class="stat-value">- Rs ${formatMoney(bill.taxes)}</span>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">Net Receivable</span>
                <span class="stat-value" style="color: ${netColor};">Rs ${formatMoney(bill.netReceivable)}</span>
            </div>
        </div>`;
}

function renderCourierPaymentReportDetailFinancialSummary(bill) {
    const el = document.getElementById('courierPaymentReportDetailFinancialSummary');
    if (!el) return;
    const row = (label, value, opts = {}) => `
        <div class="bill-detail-summary-row${opts.total ? ' bill-detail-summary-row--total' : ''}">
            <span>${escapeHtml(label)}</span>
            <span style="${opts.color ? `color: ${opts.color};` : ''}${opts.bold ? ' font-weight: 700;' : ''}">${value}</span>
        </div>`;
    el.innerHTML = [
        row('Bill Value', `Rs ${formatMoney(bill.billValue)}`),
        row('Less: Returned Orders', `- Rs ${formatMoney(bill.returnedTotal)}`),
        row('Gross COD', `Rs ${formatMoney(bill.grossCod)}`, { total: true }),
        row('Less: Delivery Charges', `- Rs ${formatMoney(bill.charges)}`),
        row('Less: Taxes (SST)', `- Rs ${formatMoney(bill.taxes)}`),
        row('Net Receivable', `Rs ${formatMoney(bill.netReceivable)}`, { total: true, color: 'var(--text-primary)' }),
        row('Total Received', `Rs ${formatMoney(bill.receivedAmount)}`),
        row('Remaining', `Rs ${formatMoney(bill.remainingAmount)}`, { color: '#7c3aed', bold: true }),
    ].join('');
}

function renderCourierPaymentReportDetailCourierSummary(bill) {
    const titleEl = document.getElementById('courierPaymentReportDetailCourierSummaryTitle');
    if (titleEl) titleEl.textContent = 'Courier Summary';
    const el = document.getElementById('courierPaymentReportDetailCourierSummary');
    if (!el) return;
    const row = (label, value) => `
        <div class="bill-detail-summary-row">
            <span>${escapeHtml(label)}</span>
            <span>${escapeHtml(String(value))}</span>
        </div>`;
    el.innerHTML = [
        row('Courier', billCourierLabel(bill)),
        row('Pickup Date', billPickupDateLabel(bill)),
        row('Total Parcels', bill.totalOrders),
        row('Resolved', bill.resolvedCount),
        row('In Transit', bill.inTransitCount),
        row('Settled', `${bill.settledCount} / ${bill.resolvedCount}`),
    ].join('');
}

function renderCourierPaymentReportDetailProgressRing(bill) {
    const el = document.getElementById('courierPaymentReportDetailProgressRing');
    if (!el) return;
    const stats = paymentProgressStats(bill);
    const { receivedEnd, deductiblesEnd } = paymentProgressPieStops(stats);
    const pieBackground = `conic-gradient(`
        + `${PAYMENT_PROGRESS_COLORS.received} 0% ${receivedEnd}%, `
        + `${PAYMENT_PROGRESS_COLORS.deductibles} ${receivedEnd}% ${deductiblesEnd}%, `
        + `var(--danger) ${deductiblesEnd}% 100%)`;
    const legendRow = (color, label, value, pct) => `
        <div class="progress-ring-legend__item">
            <span class="progress-ring-legend__label"><span class="progress-ring-legend__dot" style="background: ${color};"></span>${label}</span>
            <span class="progress-ring-legend__value">Rs ${formatMoney(value)} <span style="color: var(--text-muted); font-weight: 400;">(${pct}%)</span></span>
        </div>`;
    el.innerHTML = `
        <div class="bill-detail-progress-ring-wrap">
            <div class="progress-ring" style="background: ${pieBackground};">
                <div class="progress-ring__inner">
                    <span class="progress-ring__pct">${stats.pct}%</span>
                    <span class="progress-ring__label">Settled</span>
                </div>
            </div>
            <div class="progress-ring-legend">
                ${legendRow('var(--text-muted)', 'Bill Value (Total Amount)', stats.billValue, 100)}
                ${legendRow(PAYMENT_PROGRESS_COLORS.received, 'Received', stats.received, stats.receivedPct)}
                ${legendRow(PAYMENT_PROGRESS_COLORS.deductibles, 'Deductibles', stats.deductibles, stats.deductiblesPct)}
                ${legendRow('var(--danger)', 'Remaining', stats.remaining, stats.remainingPct)}
            </div>
        </div>`;
}

function renderCourierPaymentReportDetailOrdersTable(bill) {
    const countEl = document.getElementById('courierPaymentReportDetailOrdersCount');
    if (countEl) countEl.textContent = String(bill.totalOrders);

    const body = document.getElementById('courierPaymentReportDetailOrdersBody');
    if (!body) return;

    body.innerHTML = bill.orders.map((order) => {
        const status = order.order_status || '';
        const isResolved = COURIER_RESOLVED_STATUSES.has(status.toLowerCase());
        const receivable = isResolved ? computeReceivable(order) : null;
        const cod = computeCod(order);
        const settledBadge = order.is_order_settled
            ? '<span class="grid-status-badge grid-status-delivered">Settled</span>'
            : '<span class="grid-status-badge grid-status-fulfilled">Unsettled</span>';
        return `
        <tr data-order-number="${escapeHtml(String(order.order_number ?? ''))}">
            <td>${escapeHtml(String(order.order_number ?? ''))}</td>
            <td>${escapeHtml(order.folio || '-')}</td>
            <td class="cpr-detail-customer-name">Loading…</td>
            <td>${escapeHtml(order.tracking_number || '-')}</td>
            <td><span class="grid-status-badge ${orderStatusBadgeClass(status)}">${escapeHtml(status)}</span></td>
            <td>${formatMoney(order.total_amount)}</td>
            <td>${formatMoney(order.advance_amount)}</td>
            <td>${formatMoney(cod)}</td>
            <td>${formatMoney(order.delivery_charge)}</td>
            <td>${formatMoney(order.tax_amount)}</td>
            <td>${receivable != null ? formatMoney(receivable) : '-'}</td>
            <td>${isResolved ? settledBadge : '-'}</td>
        </tr>`;
    }).join('');
}

/** shopify_orders doesn't persist customer name, so the orders table starts with a
 * "Loading…" placeholder and this patches it in once the live Shopify lookup (new
 * /orders/shipping-info endpoint) resolves. Guarded by courierPaymentReportCurrentBill
 * in case the user has since navigated to a different bill or back to the list. */
async function fetchCourierPaymentReportShippingInfo(bill) {
    const orderIds = bill.orders.map((o) => o.id).filter(Boolean);
    const body = document.getElementById('courierPaymentReportDetailOrdersBody');
    if (orderIds.length === 0) return;

    let results;
    try {
        results = await apiJson('/orders/shipping-info', {
            method: 'POST',
            body: orderIds,
            fallback: 'Failed to load customer details from Shopify',
        });
    } catch (error) {
        console.error('Error loading shipping info:', error);
        if (courierPaymentReportCurrentBill === bill && body) {
            body.querySelectorAll('.cpr-detail-customer-name')
                .forEach((cell) => { cell.textContent = '-'; });
        }
        return;
    }
    if (courierPaymentReportCurrentBill !== bill || !body) return;

    const byOrderNumber = new Map(results.map((r) => [String(r.order_number), r]));
    bill.orders.forEach((order) => {
        const info = byOrderNumber.get(String(order.order_number));
        const row = body.querySelector(`tr[data-order-number="${CSS.escape(String(order.order_number ?? ''))}"]`);
        if (!row) return;
        row.querySelector('.cpr-detail-customer-name').textContent = info?.customer_name || '-';
    });
}

function openCourierPaymentReportBillDetail(bill) {
    courierPaymentReportCurrentBill = bill;
    renderCourierPaymentReportDetailHeader(bill);
    renderCourierPaymentReportDetailStats(bill);
    renderCourierPaymentReportDetailFinancialSummary(bill);
    renderCourierPaymentReportDetailCourierSummary(bill);
    renderCourierPaymentReportDetailProgressRing(bill);
    renderCourierPaymentReportDetailOrdersTable(bill);
    switchView('courierPaymentReportDetail');
    fetchCourierPaymentReportShippingInfo(bill);
}

/** Re-slice the already-fetched orders by courier/search/date-range/status and redraw the
 * summary + bill table - no refetch, since all of those are client-side facets. */
function renderCourierPaymentReportView() {
    const filtered = courierPaymentReportFilteredOrders();
    renderCourierPaymentReportSummary(courierPaymentReportSummary(filtered));

    let bills = buildCourierPaymentReportBills(filtered);
    const statusFilter = document.getElementById('courierPaymentReportStatusFilter')?.value;
    if (statusFilter && statusFilter !== 'all') {
        bills = bills.filter((b) => b.status === statusFilter);
    }

    if (courierPaymentReportGridApi) {
        courierPaymentReportGridApi.setGridOption('rowData', bills);
    }
}

async function loadCourierPaymentReport() {
    if (courierPaymentReportGridApi) courierPaymentReportGridApi.showLoadingOverlay();

    try {
        courierPaymentReportOrders = await apiJson('/orders/', { fallback: 'Failed to load courier payment report data' });
    } catch (error) {
        console.error('Error loading courier payment report:', error);
        showToast('Failed to load courier payment report data', 'error');
        if (courierPaymentReportGridApi) courierPaymentReportGridApi.hideOverlay();
        return;
    }

    populateCourierPaymentReportCourierFilter(courierPaymentReportOrders);
    renderCourierPaymentReportView();
    if (courierPaymentReportGridApi) courierPaymentReportGridApi.hideOverlay();
}

/** Pickup-date range popover, mirroring the Orders page's own date-range button
 * (initOrdersDateRangeButton in navigation.js) but filtering courierPaymentReportOrders
 * client-side instead of an ag-grid filter model. */
function initCourierPaymentReportDateRangeButton() {
    const triggerBtn = document.getElementById('courierPaymentReportDateRangeBtn');
    if (!triggerBtn) return;

    const menu = document.createElement('div');
    menu.className = 'date-range-menu';
    menu.style.display = 'none';

    const fromField = document.createElement('div');
    fromField.className = 'date-range-menu__field';
    const fromLabel = document.createElement('label');
    fromLabel.className = 'date-range-menu__label';
    fromLabel.textContent = 'From';
    const fromInput = document.createElement('input');
    fromInput.type = 'text';
    fromInput.placeholder = 'dd/mm/yyyy';
    fromInput.className = 'grid-floating-filter-date';
    fromField.appendChild(fromLabel);
    fromField.appendChild(fromInput);

    const toField = document.createElement('div');
    toField.className = 'date-range-menu__field';
    const toLabel = document.createElement('label');
    toLabel.className = 'date-range-menu__label';
    toLabel.textContent = 'To';
    const toInput = document.createElement('input');
    toInput.type = 'text';
    toInput.placeholder = 'dd/mm/yyyy';
    toInput.className = 'grid-floating-filter-date';
    toField.appendChild(toLabel);
    toField.appendChild(toInput);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'date-range-menu__actions';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'date-range-menu__btn date-range-menu__btn--clear';
    clearBtn.textContent = 'Clear';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'date-range-menu__btn date-range-menu__btn--apply';
    applyBtn.textContent = 'Apply';
    actionsRow.appendChild(clearBtn);
    actionsRow.appendChild(applyBtn);

    menu.appendChild(fromField);
    menu.appendChild(toField);
    menu.appendChild(actionsRow);

    const flatpickrOpts = { dateFormat: 'd/m/Y', allowInput: true, static: false };
    const fromPicker = window.flatpickr ? window.flatpickr(fromInput, flatpickrOpts) : null;
    const toPicker = window.flatpickr ? window.flatpickr(toInput, flatpickrOpts) : null;

    function updateButtonLabel() {
        const { from, to } = courierPaymentReportDateRange;
        triggerBtn.textContent = (from || to)
            ? `${from ? formatDateDDMMYYYY(from) : '…'} – ${to ? formatDateDDMMYYYY(to) : '…'}`
            : 'Date range';
    }

    const clearRange = () => {
        fromInput.value = '';
        toInput.value = '';
        if (fromPicker) fromPicker.clear();
        if (toPicker) toPicker.clear();
        courierPaymentReportDateRange = { from: null, to: null };
        updateButtonLabel();
    };

    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rawFrom = (fromInput.value || '').trim();
        const rawTo = (toInput.value || '').trim();
        courierPaymentReportDateRange = {
            from: rawFrom ? parseDDMMYYYYToYYYYMMDD(rawFrom) : null,
            to: rawTo ? parseDDMMYYYYToYYYYMMDD(rawTo) : null,
        };
        updateButtonLabel();
        renderCourierPaymentReportView();
        menu.style.display = 'none';
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearRange();
        renderCourierPaymentReportView();
        menu.style.display = 'none';
    });

    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display === 'none') {
            const { from, to } = courierPaymentReportDateRange;
            fromInput.value = from ? formatDateDDMMYYYY(from) : '';
            toInput.value = to ? formatDateDDMMYYYY(to) : '';
            if (fromPicker) fromPicker.setDate(fromInput.value || null, false);
            if (toPicker) toPicker.setDate(toInput.value || null, false);

            const rect = triggerBtn.getBoundingClientRect();
            menu.style.display = 'block';
            // Display first so offsetWidth is measurable, then centre on the button,
            // clamped so the popup can't hang off either edge of the viewport.
            const left = rect.left + window.scrollX + (rect.width - menu.offsetWidth) / 2;
            const maxLeft = window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8;
            menu.style.top = `${rect.bottom + window.scrollY}px`;
            menu.style.left = `${Math.max(window.scrollX + 8, Math.min(left, maxLeft))}px`;
        } else {
            menu.style.display = 'none';
        }
    });

    document.body.appendChild(menu);
    updateButtonLabel();

    // Exposed so the Clear Filters button can reset this popover's own input state too.
    window._courierPaymentReportResetDateRange = () => {
        clearRange();
    };
}

function initCourierPaymentReportGrid() {
    const gridDiv = document.getElementById('courierPaymentReportGrid');
    if (!gridDiv) return;

    const money = (params) => (params.value != null ? formatMoney(params.value) : '');
    const columnDefs = [
        {
            headerName: 'Date', field: 'pickupDate', width: 110, minWidth: 110,
            valueFormatter: (params) => billPickupDateLabel(params.data),
        },
        {
            headerName: 'Courier',
            field: 'courier',
            width: 130,
            minWidth: 110,
            valueFormatter: (params) => billCourierLabel(params.data),
            cellRenderer: (params) => {
                const bill = params.data;
                const label = billCourierLabel(bill);
                const logo = COURIER_LOGOS[label.trim().toUpperCase()];
                if (logo) {
                    return `<span class="grid-courier-logo-wrap"><img src="${logo.src}" alt="${logo.alt}" class="grid-courier-logo ${logo.imgClass}"></span>`;
                }
                return escapeHtml(label);
            },
        },
        {
            headerName: 'Bill Value',
            field: 'billValue',
            width: 140,
            minWidth: 130,
            cellClass: 'ag-right-aligned-cell',
            valueFormatter: money,
        },
        {
            headerName: 'Settled Orders',
            colId: 'settledOrders',
            field: 'settledCount',
            width: 130,
            minWidth: 120,
            cellClass: 'ag-right-aligned-cell',
            valueFormatter: (params) => `${params.data.settledCount} / ${params.data.totalOrders}`,
        },
        {
            headerName: 'Payment Progress',
            colId: 'paymentProgress',
            field: 'billValue',
            width: 300,
            minWidth: 240,
            cellRenderer: createPaymentProgressCellElement,
        },
        {
            headerName: 'Status',
            field: 'status',
            width: 130,
            minWidth: 120,
            cellRenderer: (params) => {
                const meta = BILL_STATUS_META[params.value] || BILL_STATUS_META.unpaid;
                return `<span class="grid-status-badge ${meta.cls}">${meta.label}</span>`;
            },
        },
        {
            headerName: 'Actions',
            colId: 'viewOrders',
            width: 130,
            minWidth: 130,
            sortable: false,
            filter: false,
            cellRenderer: createCourierPaymentReportViewButton,
        },
    ];

    agGrid.createGrid(gridDiv, {
        columnDefs,
        rowData: [],
        rowHeight: 74,
        defaultColDef: { sortable: true, resizable: true, filter: true, minWidth: 90 },
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => `${params.data.pickupDateKey}|${params.data.courier}`,
        onGridReady: (params) => {
            courierPaymentReportGridApi = params.api;
        },
    });
}

function initCourierPaymentReport() {
    initCourierPaymentReportGrid();
    initCourierPaymentReportDateRangeButton();

    document.getElementById('courierPaymentReportCourierFilter')?.addEventListener('change', () => renderCourierPaymentReportView());
    document.getElementById('courierPaymentReportStatusFilter')?.addEventListener('change', () => renderCourierPaymentReportView());
    document.getElementById('courierPaymentReportSearchFilter')?.addEventListener('input', debounce(() => renderCourierPaymentReportView(), 250));

    document.getElementById('courierPaymentReportClearFiltersBtn')?.addEventListener('click', () => {
        const courierSelect = document.getElementById('courierPaymentReportCourierFilter');
        if (courierSelect) courierSelect.value = COURIER_FILTER_ALL;
        const statusSelect = document.getElementById('courierPaymentReportStatusFilter');
        if (statusSelect) statusSelect.value = 'all';
        const searchInput = document.getElementById('courierPaymentReportSearchFilter');
        if (searchInput) searchInput.value = '';
        if (typeof window._courierPaymentReportResetDateRange === 'function') window._courierPaymentReportResetDateRange();
        renderCourierPaymentReportView();
    });

    // Same PostEx payment-reconciliation CSV as the Orders page's "Upload PostEx CSV"
    // action (openUploadPostExModal, in ledgers.js) - surfaced here too since this page is
    // where that reconciliation actually gets used.
    document.getElementById('courierPaymentReportImportCsvBtn')?.addEventListener('click', () => openUploadPostExModal());

    document.getElementById('courierPaymentReportDetailBackBtn')?.addEventListener('click', () => switchView('courierPaymentReport'));
    // No backend PDF generation for this bill summary yet - just a placeholder for now.
    document.getElementById('courierPaymentReportDetailDownloadBtn')?.addEventListener('click', () => {
        showToast('PDF export is coming soon', 'info');
    });
}
