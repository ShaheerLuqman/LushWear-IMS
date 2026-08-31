// Courier Payment Report: what the courier still owes for delivered/returned orders,
// grouped by the date the courier picked the parcel up and then by courier (mirrors how
// couriers batch-settle - one payment per pickup run), plus which orders are still in
// transit (no final courier outcome yet).
//
// Bills are persisted (shopify_courier_bills) and their money is derived by the
// shopify_courier_bills_with_totals view, so this file no longer groups or aggregates
// anything - it fetches /courier-bills/ and renders it. That view is the single source of
// truth the PDF service reads too. The orders table on a bill's detail screen still uses
// computeReceivable (orders-grid.js) and orderStatusBadgeClass (orders-columns.js) for its
// per-order cells, so those stay in step with the Orders grid.

let courierPaymentReportGridApi = null;

// Bills as last returned by /courier-bills/, already scoped to the active pickup-date
// range and courier/status filters (all applied server-side). Search is the one facet
// still re-sliced locally, since it's a free-text match over already-loaded rows.
let courierPaymentReportBills = [];

// Multi-select checkbox filters (grid-filters.js) replacing the old single-select dropdowns.
// getSelected() is null until the user narrows the list, which reads as "no filter".
let courierPaymentReportCourierFilter = null;
let courierPaymentReportStatusFilter = null;

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

/** Bill detail pie-chart segment colors. "Remaining" matches the violet used for the
 * same figure in renderCourierPaymentReportDetailFinancialSummary. */
const PAYMENT_PROGRESS_COLORS = {
    received: '#16a34a',
    returned: '#dc2626',
    charges: '#f59e0b',
    taxes: '#0ea5e9',
    remaining: '#7c3aed',
};

/** Default pickup-date range shown on first load: all of last month (local calendar,
 * matching pickupDateKey's own convention) - courier payouts land after the pickup
 * month closes, so last month is the range you actually reconcile against. */
function defaultCourierPaymentReportDateRange() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = firstOfLastMonth.getFullYear();
    const m = firstOfLastMonth.getMonth(); // 0-indexed
    const lastDay = new Date(y, m + 1, 0).getDate();
    return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

let courierPaymentReportDateRange = defaultCourierPaymentReportDateRange();

// Courier options for the filter. Kept separate from courierPaymentReportBills and only
// grown, never rebuilt from the current page of bills: filtering to one courier must not
// remove the others from the picker the user needs to get back to them.
let courierPaymentReportCouriers = [];

function recordCourierPaymentReportCouriers(bills) {
    const set = new Set(courierPaymentReportCouriers);
    bills.forEach((bill) => { if (bill.courier) set.add(bill.courier); });
    courierPaymentReportCouriers = [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Payment status of a bill, as derived by shopify_courier_bills_with_totals. */
const COURIER_PAYMENT_STATUSES = ['paid', 'partially_paid', 'unpaid', 'in_transit'];
const COURIER_PAYMENT_STATUS_LABELS = {
    paid: 'Paid',
    partially_paid: 'Partially Paid',
    unpaid: 'Unpaid',
    in_transit: 'In Transit'
};

/** Map one row of /courier-bills/ onto the camelCase shape the rest of this file (and the
 * grid's column defs) already use. The money arrives derived from the member orders by
 * shopify_courier_bills_with_totals, so nothing here recomputes it - this is a rename, not
 * an aggregation. `orders` is absent from the list endpoint and filled in on demand when a
 * bill's detail screen opens. */
function mapCourierBillRow(row) {
    return {
        id: row.id,
        courier: row.courier,
        pickupDate: new Date(`${row.pickup_date}T00:00:00`),
        pickupDateKey: row.pickup_date,
        workflowStatus: row.workflow_status,
        notes: row.notes,
        totalOrders: row.total_orders,
        inTransitCount: row.in_transit_count,
        inTransitByStatus: row.in_transit_by_status || {},
        resolvedCount: row.resolved_count,
        settledCount: row.settled_count,
        billValue: row.bill_value,
        advanceTotal: row.advance_total,
        grossCod: row.gross_cod,
        charges: row.charges,
        taxes: row.taxes,
        returnedTotal: row.returned_total,
        netReceivable: row.net_receivable,
        receivedAmount: row.received_amount,
        remainingAmount: row.remaining_amount,
        status: row.payment_status,
        orders: null,
    };
}

/** Free-text search over the loaded bills. Courier, pickup-date range and payment status
 * are applied by the server (see loadCourierPaymentReport), so this is all that's left to
 * do locally - matching the old behaviour of searching courier name and order number, the
 * latter only once a bill's orders have been loaded. */
function courierPaymentReportVisibleBills() {
    const query = (document.getElementById('courierPaymentReportSearchFilter')?.value || '').trim().toLowerCase();
    if (!query) return courierPaymentReportBills;
    return courierPaymentReportBills.filter((bill) =>
        bill.courier.toLowerCase().includes(query)
        || (bill.orders || []).some((o) => String(o.order_number ?? '').toLowerCase().includes(query)));
}

/** Cash-on-delivery amount for one order: total minus advance, for every order
 * regardless of status - unlike computeReceivable, this doesn't wait for (or exclude
 * as 0 for returns) a final delivered/returned outcome, since it's just the raw
 * customer-facing COD figure, not a courier settlement amount. */
function computeCod(order) {
    return (parseFloat(order.total_amount) || 0) - (parseFloat(order.advance_amount) || 0);
}

/** The cards summarise exactly the bills the table below is showing, so all four filters
 * reach them: courier, pickup-date range and payment status via the server query, search
 * via courierPaymentReportVisibleBills. Orders with no pickup date are on no bill at all
 * and so appear in neither - they can't be placed on the pickup-date timeline. */
function courierPaymentReportSummary(bills) {
    let inTransit = 0;
    let resolved = 0;
    let netOwed = 0;
    const inTransitByStatus = {};
    bills.forEach((bill) => {
        inTransit += bill.inTransitCount;
        resolved += bill.resolvedCount;
        netOwed += bill.remainingAmount;
        Object.entries(bill.inTransitByStatus).forEach(([status, count]) => {
            inTransitByStatus[status] = (inTransitByStatus[status] || 0) + count;
        });
    });
    return { inTransit, resolved, netOwed: Math.round(netOwed * 100) / 100, inTransitByStatus };
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

/** Payment Progress tracks Bill Value (already net of advance - see
 * the bill totals view) against four claims on it: the amount the courier has
 * actually paid back for settled orders, and the three things the courier/the bill itself
 * keeps instead - delivery charges, taxes, and the full total of any settled returned orders
 * (never coming back at all). Whatever's left over (billValue minus all four) is still
 * outstanding, including returns not yet settled with the courier.
 * Feeds the detail screen's pie. Each ratio is clamped independently, so in an edge case
 * where one claim alone exceeds the bill value the segments can visually overrun 100%
 * rather than silently under-report - that's rare enough in real data not to be worth
 * normalizing away. */
function paymentProgressStats(bill) {
    const billValue = bill.billValue;
    const received = bill.receivedAmount;
    const returned = bill.returnedTotal;
    const charges = bill.charges;
    const taxes = bill.taxes;
    const accountedFor = received + returned + charges + taxes;
    const remaining = Math.max(0, billValue - accountedFor);
    const ratio = (amount) => billValue > 0 ? Math.max(0, Math.min(100, Math.round((amount / billValue) * 100))) : 0;
    return {
        billValue,
        received,
        returned,
        charges,
        taxes,
        remaining,
        pct: ratio(accountedFor),
        receivedPct: ratio(received),
        returnedPct: ratio(returned),
        chargesPct: ratio(charges),
        taxesPct: ratio(taxes),
        remainingPct: ratio(remaining),
    };
}

/** Cumulative conic-gradient stops for the detail screen's pie: received, then returned,
 * then delivery charges, then taxes, then whatever's left as "remaining". Computed from
 * running totals rather than the independently-clamped *Pct fields above, so the slices
 * always add up to exactly one full circle even in the edge case where those ratios would
 * overrun. */
function paymentProgressPieStops(stats) {
    const { billValue, received, returned, charges, taxes } = stats;
    const pct = (amount) => billValue > 0 ? (amount / billValue) * 100 : 0;
    const receivedEnd = Math.min(100, pct(received));
    const returnedEnd = Math.min(100, receivedEnd + pct(returned));
    const chargesEnd = Math.min(100, returnedEnd + pct(charges));
    const taxesEnd = Math.min(100, chargesEnd + pct(taxes));
    return { receivedEnd, returnedEnd, chargesEnd, taxesEnd };
}

function settledOrdersCellHtml(bill) {
    const { settledCount, totalOrders } = bill;
    const pct = totalOrders > 0 ? Math.round((settledCount / totalOrders) * 100) : 0;
    return `
        <div class="payment-progress">
            <div class="payment-progress__row">
                <span class="payment-progress__amounts">${settledCount} / ${totalOrders} Orders</span>
                <span class="payment-progress__pct">${pct}%</span>
            </div>
            <div class="payment-progress__bar">
                <div class="payment-progress__segment payment-progress__segment--received" style="width: ${pct}%;"></div>
            </div>
        </div>`;
}

/** ag-grid cellRenderer wrapper for settledOrdersCellHtml. A returned HTML *string*
 * gets set as innerHTML directly on ag-grid's own cell-value wrapper, which doesn't give
 * the bar a reliable block-level container to size 100% width against (it ends up
 * shrunk to content, not covering the column) - returning an actual DOM element instead
 * (same fix as createCourierPaymentReportViewButton's .bill-cell-center) gives it one. */
function createSettledOrdersCellElement(params) {
    const wrapper = document.createElement('div');
    wrapper.className = 'payment-progress-cell-wrap';
    wrapper.innerHTML = settledOrdersCellHtml(params.data);
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
    const { receivedEnd, returnedEnd, chargesEnd, taxesEnd } = paymentProgressPieStops(stats);
    const pieBackground = `conic-gradient(`
        + `${PAYMENT_PROGRESS_COLORS.received} 0% ${receivedEnd}%, `
        + `${PAYMENT_PROGRESS_COLORS.returned} ${receivedEnd}% ${returnedEnd}%, `
        + `${PAYMENT_PROGRESS_COLORS.charges} ${returnedEnd}% ${chargesEnd}%, `
        + `${PAYMENT_PROGRESS_COLORS.taxes} ${chargesEnd}% ${taxesEnd}%, `
        + `${PAYMENT_PROGRESS_COLORS.remaining} ${taxesEnd}% 100%)`;
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
                ${legendRow(PAYMENT_PROGRESS_COLORS.returned, 'Returned Orders', stats.returned, stats.returnedPct)}
                ${legendRow(PAYMENT_PROGRESS_COLORS.charges, 'Delivery Charges', stats.charges, stats.chargesPct)}
                ${legendRow(PAYMENT_PROGRESS_COLORS.taxes, 'Taxes (SST)', stats.taxes, stats.taxesPct)}
                ${legendRow(PAYMENT_PROGRESS_COLORS.remaining, 'Remaining', stats.remaining, stats.remainingPct)}
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
            <td>${settledBadge}</td>
        </tr>`;
    }).join('');
}

/** The main /orders/ list this report is built from omits customer_name (see
 * ORDERS_LIST_SELECT - deliberately trimmed since that list can be hundreds/1000+ rows),
 * so the orders table starts with a "Loading…" placeholder and this patches it in from a
 * /orders/shipping-info lookup (a DB read of shopify_orders' stored customer_name, not a
 * live Shopify call) scoped to just this bill's orders. Guarded by
 * courierPaymentReportCurrentBill in case the user has since navigated to a different
 * bill or back to the list. */
async function fetchCourierPaymentReportShippingInfo(bill) {
    const orderIds = bill.orders.map((o) => o.id).filter(Boolean);
    const body = document.getElementById('courierPaymentReportDetailOrdersBody');
    if (orderIds.length === 0) return;

    let results;
    try {
        results = await apiJson('/orders/shipping-info', {
            method: 'POST',
            body: orderIds,
            fallback: 'Failed to load customer details',
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

/** The list endpoint returns bills without their member orders (a few hundred bills, not
 * every order behind them), so the detail screen fetches them on open. Everything above the
 * orders table is already on the bill row and renders immediately. */
async function openCourierPaymentReportBillDetail(bill) {
    courierPaymentReportCurrentBill = bill;
    renderCourierPaymentReportDetailHeader(bill);
    renderCourierPaymentReportDetailStats(bill);
    renderCourierPaymentReportDetailFinancialSummary(bill);
    renderCourierPaymentReportDetailCourierSummary(bill);
    renderCourierPaymentReportDetailProgressRing(bill);
    switchView('courierPaymentReportDetail');

    if (!bill.orders) {
        try {
            const detail = await apiJson(`/courier-bills/${bill.id}`, { fallback: 'Failed to load bill orders' });
            bill.orders = detail.orders;
        } catch (error) {
            console.error('Error loading bill orders:', error);
            showToast('Failed to load bill orders', 'error');
            return;
        }
        if (courierPaymentReportCurrentBill !== bill) return;
    }

    renderCourierPaymentReportDetailOrdersTable(bill);
    fetchCourierPaymentReportShippingInfo(bill);
}

/** The bill is a client-side grouping with no id of its own, so the endpoint is given the
 * (pickup date, courier) pair that defines it and re-derives the same totals server-side. */
async function downloadCourierPaymentReportBillPdf() {
    const bill = courierPaymentReportCurrentBill;
    if (!bill) return;

    const btn = document.getElementById('courierPaymentReportDetailDownloadBtn');
    if (btn) btn.disabled = true;
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
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast('Summary downloaded', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to download summary', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/** Redraw the summary + bill table from the loaded bills, applying the search box. The
 * other three facets were applied by the server, so they need a refetch, not a re-slice -
 * see loadCourierPaymentReport. */
function renderCourierPaymentReportView() {
    const bills = courierPaymentReportVisibleBills();
    renderCourierPaymentReportSummary(courierPaymentReportSummary(bills));
    if (courierPaymentReportGridApi) {
        courierPaymentReportGridApi.setGridOption('rowData', bills);
    }
}

/** Fetch the bills for the active pickup-date range, courier and payment-status filters.
 * Unlike the old client-side grouping over /orders/, the range is applied in the database,
 * so it reaches the whole order history rather than only the three periods /orders/
 * returns - picking a range from six months ago now shows those bills instead of nothing. */
async function loadCourierPaymentReport() {
    if (courierPaymentReportGridApi) courierPaymentReportGridApi.showLoadingOverlay();

    const params = new URLSearchParams();
    const { from, to } = courierPaymentReportDateRange;
    if (from) params.append('date_from', from);
    if (to) params.append('date_to', to);
    courierPaymentReportCourierFilter?.getSelected()?.forEach((c) => params.append('courier', c));
    courierPaymentReportStatusFilter?.getSelected()?.forEach((s) => params.append('payment_status', s));

    const courierFilterBefore = courierPaymentReportCourierFilter?.getSelected();
    try {
        const rows = await apiJson(`/courier-bills/?${params}`, { fallback: 'Failed to load courier payment report data' });
        courierPaymentReportBills = rows.map(mapCourierBillRow);
        recordCourierPaymentReportCouriers(courierPaymentReportBills);
    } catch (error) {
        console.error('Error loading courier payment report:', error);
        showToast('Failed to load courier payment report data', 'error');
        if (courierPaymentReportGridApi) courierPaymentReportGridApi.hideOverlay();
        return;
    }

    courierPaymentReportCourierFilter?.refresh();
    // refresh() can only promote the data-derived default (PostEx alone) to a real
    // selection once the courier list is known - which is after this first fetch, so the
    // bills we just loaded ignored it. Refetch once with the now-known selection applied.
    if (courierFilterBefore == null && courierPaymentReportCourierFilter?.getSelected()?.length) {
        return loadCourierPaymentReport();
    }
    renderCourierPaymentReportView();
    if (courierPaymentReportGridApi) courierPaymentReportGridApi.hideOverlay();
}

/** Pickup-date range popover, mirroring the Orders page's own date-range button
 * (initOrdersDateRangeButton in navigation.js) but refetching the courier bills for the
 * new range instead of driving an ag-grid filter model. */
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
        loadCourierPaymentReport();
        menu.style.display = 'none';
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearRange();
        loadCourierPaymentReport();
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
            headerName: 'Remaining',
            field: 'remainingAmount',
            width: 140,
            minWidth: 130,
            cellClass: 'ag-right-aligned-cell',
            valueFormatter: money,
        },
        {
            headerName: 'Settled Orders',
            colId: 'settledOrders',
            field: 'settledCount',
            width: 300,
            minWidth: 240,
            cellRenderer: createSettledOrdersCellElement,
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
        getRowId: (params) => params.data.id,
        onGridReady: (params) => {
            courierPaymentReportGridApi = params.api;
        },
    });
}

function initCourierPaymentReport() {
    initCourierPaymentReportGrid();
    initCourierPaymentReportDateRangeButton();

    // Defaults to PostEx alone - for now, that's the only courier this report gets used for
    // day to day. Falls back to every courier once PostEx isn't in the list.
    courierPaymentReportCourierFilter = createCheckboxFilterControl('courierPaymentReportCourierFilter', {
        allLabel: 'All couriers',
        getValues: () => courierPaymentReportCouriers,
        defaultSelected: (couriers) => {
            const postex = couriers.find((c) => c.toLowerCase() === 'postex');
            return postex ? [postex] : couriers;
        },
        // Courier and payment status are server-side filters now, so narrowing them has to
        // refetch rather than re-slice - only the search box can be answered locally.
        onChange: () => loadCourierPaymentReport()
    });

    courierPaymentReportStatusFilter = createCheckboxFilterControl('courierPaymentReportStatusFilter', {
        allLabel: 'All Status',
        getValues: () => COURIER_PAYMENT_STATUSES,
        displayLabel: (v) => COURIER_PAYMENT_STATUS_LABELS[v],
        onChange: () => loadCourierPaymentReport()
    });

    document.getElementById('courierPaymentReportSearchFilter')?.addEventListener('input', debounce(() => renderCourierPaymentReportView(), 250));

    document.getElementById('courierPaymentReportClearFiltersBtn')?.addEventListener('click', () => {
        courierPaymentReportCourierFilter?.reset();
        courierPaymentReportStatusFilter?.reset();
        const searchInput = document.getElementById('courierPaymentReportSearchFilter');
        if (searchInput) searchInput.value = '';
        if (typeof window._courierPaymentReportResetDateRange === 'function') window._courierPaymentReportResetDateRange();
        loadCourierPaymentReport();
    });

    // Same PostEx payment-reconciliation CSV as the Orders page's "Upload PostEx CSV"
    // action (openUploadPostExModal, in ledgers.js) - surfaced here too since this page is
    // where that reconciliation actually gets used.
    document.getElementById('courierPaymentReportImportCsvBtn')?.addEventListener('click', () => openUploadPostExModal());
    document.getElementById('courierPaymentReportFetchSettlementsBtn')?.addEventListener('click', fetchPostExSettlements);

    document.getElementById('courierPaymentReportDetailBackBtn')?.addEventListener('click', () => switchView('courierPaymentReport'));
    document.getElementById('courierPaymentReportDetailDownloadBtn')?.addEventListener('click', downloadCourierPaymentReportBillPdf);
}
