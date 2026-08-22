// Courier Payment Report: what the courier still owes for delivered/returned orders,
// bundled by the date the courier picked the parcel up and then by courier (mirrors how
// couriers batch-settle - one payment per pickup run), plus which orders are still in
// transit (no final courier outcome yet). Reads the same orders data as the Orders grid
// and reuses its receivable formula (computeReceivable, in orders-grid.js) and status badge
// classes (orderStatusBadgeClass, in orders-columns.js) so nothing here drifts from the
// Orders grid.

let courierPaymentReportGridApi = null;

// Raw orders for the currently selected period (unfiltered by courier) - the courier
// filter re-slices this in place rather than refetching, since it's a client-side facet.
let courierPaymentReportOrders = [];

const COURIER_FILTER_ALL = '__all_couriers__';

// RFD/CNA/ICA (return-to-forwarder, consignee unavailable, incomplete address) are
// courier-reported problem states, not a final outcome - they count as still in transit,
// same as plain unfulfilled/fulfilled. Cancelled orders never shipped, so they're left out
// of this page entirely (neither bucket, not shown in the table).
const COURIER_RESOLVED_STATUSES = new Set(['delivered', 'returned']);
const COURIER_IN_TRANSIT_STATUSES = new Set(['unfulfilled', 'fulfilled', 'rfd', 'cna', 'ica']);

const NO_PICKUP_DATE_KEY = '__no_pickup_date__';

/** The "no pickup date" bundle can span multiple couriers (that's the one thing it isn't
 * grouped by), so its date/courier columns need their own placeholder labels instead of
 * the normal per-bundle date/courier formatting. */
function bundlePickupDateLabel(bundle) {
    return bundle.pickupDateKey === NO_PICKUP_DATE_KEY ? 'No pickup date' : formatDateDDMMYYYY(bundle.pickupDate);
}

function bundleCourierLabel(bundle) {
    return bundle.pickupDateKey === NO_PICKUP_DATE_KEY ? 'Mixed couriers' : formatCourierForDisplay(bundle.courier);
}

const BUNDLE_STATUS_META = {
    in_transit: { label: 'In Transit', cls: 'grid-status-unfulfilled' },
    paid: { label: 'Paid', cls: 'grid-status-delivered' },
    partially_paid: { label: 'Partially Paid', cls: 'grid-status-fulfilled' },
    pending: { label: 'Pending', cls: 'grid-status-returned' },
};

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

/** Periods only (no "Recent Orders") - this page always looks at one period at a time,
 * defaulting to the last fully-completed one rather than whatever's still in progress. */
function populateCourierPaymentReportPeriodFilter() {
    const selectEl = document.getElementById('courierPaymentReportPeriodFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const options = buildStaticPeriodOptions();
    selectEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    const lastMonthVal = options[1]?.value || options[0]?.value;
    selectEl.value = (currentVal && options.some((o) => o.value === currentVal)) ? currentVal : lastMonthVal;
}

function courierPaymentReportFilteredOrders() {
    const courier = document.getElementById('courierPaymentReportCourierFilter')?.value;
    if (!courier || courier === COURIER_FILTER_ALL) return courierPaymentReportOrders;
    return courierPaymentReportOrders.filter((order) => (order.courier || '').trim() === courier);
}

/** netOwed > 0 means the courier owes the shop overall; < 0 means the shop owes the
 * courier (e.g. return handling fees outweighing any COD collected). */
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
 * not yet picked up - those orders can't be grouped by date yet, so buildCourierPaymentReportBundles
 * puts them in the separate "No pickup date" bundle instead. */
function pickupDateKey(order) {
    if (!order.courier_pickup_date) return null;
    const d = new Date(order.courier_pickup_date);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Aggregate one bundle's orders into its money columns and status. Gross COD/Charges/
 * Taxes/Net Receivable/Received only accumulate over resolved orders in the bundle,
 * matching computeReceivable's own definition - in-transit orders still count toward
 * totalOrders/inTransitCount but contribute nothing to those money columns since their
 * outcome (and so their receivable) isn't known yet. */
function aggregateCourierPaymentReportBundle(bundle) {
    let grossCod = 0;
    let charges = 0;
    let taxes = 0;
    let netReceivable = 0;
    let receivedAmount = 0;
    let resolvedCount = 0;
    let settledCount = 0;
    let inTransitCount = 0;

    bundle.orders.forEach((order) => {
        const status = (order.order_status || '').toLowerCase();
        if (COURIER_IN_TRANSIT_STATUSES.has(status)) {
            inTransitCount++;
            return;
        }
        if (!COURIER_RESOLVED_STATUSES.has(status)) return;
        resolvedCount++;
        grossCod += status === 'returned'
            ? 0
            : (parseFloat(order.total_amount) || 0) - (parseFloat(order.advance_amount) || 0);
        charges += parseFloat(order.delivery_charge) || 0;
        taxes += parseFloat(order.tax_amount) || 0;
        const receivable = computeReceivable(order);
        if (receivable == null) return;
        netReceivable += receivable;
        if (order.is_order_settled) {
            settledCount++;
            receivedAmount += receivable;
        }
    });

    let status;
    if (resolvedCount === 0) status = 'in_transit';
    else if (settledCount === resolvedCount) status = 'paid';
    else if (settledCount === 0) status = 'pending';
    else status = 'partially_paid';

    return {
        ...bundle,
        totalOrders: bundle.orders.length,
        inTransitCount,
        resolvedCount,
        settledCount,
        grossCod,
        charges,
        taxes,
        netReceivable,
        receivedAmount,
        remainingAmount: netReceivable - receivedAmount,
        status,
    };
}

/** Group orders by (pickup date, courier) into one bundle row each, newest pickup date
 * first. Orders with no pickup date yet (delivery status not fetched) go into a single
 * "No pickup date" bundle pinned at the very top instead, since they can't be placed on
 * the pickup-date timeline yet but still need to be visible somewhere on this page. */
function buildCourierPaymentReportBundles(orderRows) {
    const groups = new Map();
    const noPickupDateOrders = [];
    orderRows.forEach((order) => {
        const dateKey = pickupDateKey(order);
        if (!dateKey) {
            noPickupDateOrders.push(order);
            return;
        }
        const courier = (order.courier || '').trim() || 'Unknown';
        const key = `${dateKey}|${courier}`;
        if (!groups.has(key)) {
            groups.set(key, { pickupDate: new Date(order.courier_pickup_date), pickupDateKey: dateKey, courier, orders: [] });
        }
        groups.get(key).orders.push(order);
    });

    const bundles = [...groups.values()]
        .map(aggregateCourierPaymentReportBundle)
        .sort((a, b) => b.pickupDate - a.pickupDate || a.courier.localeCompare(b.courier, undefined, { sensitivity: 'base' }));

    if (noPickupDateOrders.length > 0) {
        bundles.unshift(aggregateCourierPaymentReportBundle({
            pickupDate: null,
            pickupDateKey: NO_PICKUP_DATE_KEY,
            courier: null,
            orders: noPickupDateOrders,
        }));
    }

    return bundles;
}

function createCourierPaymentReportViewButton(params) {
    const bundle = params.data;
    const wrapper = document.createElement('div');
    wrapper.className = 'bill-cell-center';
    if (!bundle) return wrapper;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bill-view-btn';
    btn.innerHTML = '<i class="fa-solid fa-eye"></i><span>View Orders</span>';
    btn.title = 'View orders in this bundle';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showCourierPaymentReportOrdersModal(bundle);
    });

    wrapper.appendChild(btn);
    return wrapper;
}

function showCourierPaymentReportOrdersModal(bundle) {
    const modal = document.getElementById('courierPaymentReportOrdersModal');
    const title = document.getElementById('courierPaymentReportOrdersModalTitle');
    const summary = document.getElementById('courierPaymentReportOrdersModalSummary');
    const body = document.getElementById('courierPaymentReportOrdersModalBody');
    if (!modal || !body) return;

    if (title) title.textContent = `${bundlePickupDateLabel(bundle)} — ${bundleCourierLabel(bundle)}`;
    if (summary) {
        summary.textContent = `${bundle.totalOrders} order${bundle.totalOrders === 1 ? '' : 's'}`
            + (bundle.inTransitCount > 0 ? `, ${bundle.inTransitCount} still in transit` : '') + '.';
    }

    body.innerHTML = bundle.orders.map((order) => {
        const status = order.order_status || '';
        const isResolved = COURIER_RESOLVED_STATUSES.has(status.toLowerCase());
        const receivable = isResolved ? computeReceivable(order) : null;
        const cod = isResolved
            ? (status.toLowerCase() === 'returned' ? 0 : (parseFloat(order.total_amount) || 0) - (parseFloat(order.advance_amount) || 0))
            : null;
        const settledBadge = order.is_order_settled
            ? '<span class="grid-status-badge grid-status-delivered">Settled</span>'
            : '<span class="grid-status-badge grid-status-fulfilled">Unsettled</span>';
        return `
        <tr>
            <td>${escapeHtml(String(order.order_number ?? ''))}</td>
            <td>${escapeHtml(getCourierDisplayName(order))}</td>
            <td><span class="grid-status-badge ${orderStatusBadgeClass(status)}">${escapeHtml(status)}</span></td>
            <td>${order.order_receiving_date ? formatDateDDMMYYYY(order.order_receiving_date) : ''}</td>
            <td>${formatMoney(order.total_amount)}</td>
            <td>${formatMoney(order.advance_amount)}</td>
            <td>${cod != null ? formatMoney(cod) : '-'}</td>
            <td>${formatMoney(order.delivery_charge)}</td>
            <td>${formatMoney(order.tax_amount)}</td>
            <td>${receivable != null ? formatMoney(receivable) : '-'}</td>
            <td>${isResolved ? settledBadge : '-'}</td>
        </tr>`;
    }).join('');

    modal.classList.add('active');
}

function closeCourierPaymentReportOrdersModal() {
    document.getElementById('courierPaymentReportOrdersModal')?.classList.remove('active');
}

/** Re-slice the already-fetched period data by the selected courier and redraw the
 * summary + bundle table - no refetch, since courier is a client-side facet on top of
 * the period. */
function renderCourierPaymentReportView() {
    const filtered = courierPaymentReportFilteredOrders();
    renderCourierPaymentReportSummary(courierPaymentReportSummary(filtered));

    const bundles = buildCourierPaymentReportBundles(filtered);
    if (courierPaymentReportGridApi) {
        courierPaymentReportGridApi.setGridOption('rowData', bundles);
    }
}

async function loadCourierPaymentReport() {
    const periodVal = document.getElementById('courierPaymentReportPeriodFilter')?.value;
    if (courierPaymentReportGridApi) courierPaymentReportGridApi.showLoadingOverlay();

    try {
        const [month, year] = (periodVal || '').split('-');
        const query = (month && year) ? `?month=${month}&year=${year}` : '';
        courierPaymentReportOrders = await apiJson(`/orders/${query}`, { fallback: 'Failed to load courier payment report data' });
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

function initCourierPaymentReportGrid() {
    const gridDiv = document.getElementById('courierPaymentReportGrid');
    if (!gridDiv) return;

    const money = (params) => (params.value != null ? formatMoney(params.value) : '');
    const columnDefs = [
        {
            headerName: 'Pickup Date', field: 'pickupDate', width: 130,
            valueFormatter: (params) => bundlePickupDateLabel(params.data),
        },
        {
            headerName: 'Courier', field: 'courier', width: 140,
            valueFormatter: (params) => bundleCourierLabel(params.data),
        },
        {
            headerName: 'Total Orders',
            field: 'totalOrders',
            width: 170,
            type: 'rightAligned',
            cellRenderer: (params) => {
                const bundle = params.data;
                const sub = bundle.inTransitCount > 0
                    ? ` <span style="font-size: 11px; color: var(--text-muted);">(${bundle.inTransitCount} in transit)</span>`
                    : '';
                return `<span style="white-space: nowrap;">${bundle.totalOrders}${sub}</span>`;
            },
        },
        { headerName: 'Gross COD', field: 'grossCod', width: 120, type: 'rightAligned', valueFormatter: money },
        { headerName: 'Charges', field: 'charges', width: 110, type: 'rightAligned', valueFormatter: money },
        { headerName: 'Taxes', field: 'taxes', width: 100, type: 'rightAligned', valueFormatter: money },
        {
            headerName: 'Net Receivable',
            field: 'netReceivable',
            width: 150,
            type: 'rightAligned',
            cellRenderer: (params) => {
                const val = parseFloat(params.value) || 0;
                const color = val < 0 ? 'var(--danger)' : 'var(--success)';
                const label = val < 0 ? `-Rs ${formatMoney(-val)}` : `Rs ${formatMoney(val)}`;
                return `<span style="color: ${color}; font-weight: 600;">${label}</span>`;
            },
        },
        { headerName: 'Received Amount', field: 'receivedAmount', width: 140, type: 'rightAligned', valueFormatter: money },
        { headerName: 'Remaining Amount', field: 'remainingAmount', width: 150, type: 'rightAligned', valueFormatter: money },
        {
            headerName: 'Paid Orders',
            field: 'settledCount',
            width: 120,
            cellRenderer: (params) => {
                const bundle = params.data;
                return bundle.resolvedCount > 0 ? `${bundle.settledCount} / ${bundle.resolvedCount}` : '-';
            },
        },
        {
            headerName: 'Status',
            field: 'status',
            width: 140,
            cellRenderer: (params) => {
                const meta = BUNDLE_STATUS_META[params.value] || BUNDLE_STATUS_META.pending;
                return `<span class="grid-status-badge ${meta.cls}">${meta.label}</span>`;
            },
        },
        {
            headerName: '',
            colId: 'viewOrders',
            width: 130,
            sortable: false,
            filter: false,
            cellRenderer: createCourierPaymentReportViewButton,
        },
    ];

    agGrid.createGrid(gridDiv, {
        columnDefs,
        rowData: [],
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
    populateCourierPaymentReportPeriodFilter();
    document.getElementById('courierPaymentReportPeriodFilter')?.addEventListener('change', () => loadCourierPaymentReport());
    document.getElementById('courierPaymentReportCourierFilter')?.addEventListener('change', () => renderCourierPaymentReportView());

    document.getElementById('closeCourierPaymentReportOrdersModal')?.addEventListener('click', closeCourierPaymentReportOrdersModal);
    document.getElementById('closeCourierPaymentReportOrdersModalBtn')?.addEventListener('click', closeCourierPaymentReportOrdersModal);
    document.getElementById('courierPaymentReportOrdersModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'courierPaymentReportOrdersModal') closeCourierPaymentReportOrdersModal();
    });
}
