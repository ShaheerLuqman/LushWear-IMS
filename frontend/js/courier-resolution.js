// Courier Resolution: which delivered/returned orders the courier still owes money for,
// which orders are still in transit (no final courier outcome yet), and which resolved
// orders the courier has actually paid out. Reads the same orders data as the Orders grid
// and reuses its receivable formula (computeReceivable, in orders-grid.js) and status badge
// classes (orderStatusBadgeClass, in orders-columns.js) so nothing here drifts from the
// Orders grid.

let courierResolutionGridApi = null;

// Raw orders for the currently selected period (unfiltered by courier) - the courier
// filter re-slices this in place rather than refetching, since it's a client-side facet.
let courierResolutionOrders = [];

const COURIER_FILTER_ALL = '__all_couriers__';

// RFD/CNA/ICA (return-to-forwarder, consignee unavailable, incomplete address) are
// courier-reported problem states, not a final outcome - they count as still in transit,
// same as plain unfulfilled/fulfilled. Cancelled orders never shipped, so they're left out
// of this page entirely (neither bucket, not shown in the table).
const COURIER_RESOLVED_STATUSES = new Set(['delivered', 'returned']);
const COURIER_IN_TRANSIT_STATUSES = new Set(['unfulfilled', 'fulfilled', 'rfd', 'cna', 'ica']);

function distinctCouriers(orderRows) {
    const set = new Set();
    orderRows.forEach((order) => {
        const courier = (order.courier || '').trim();
        if (courier) set.add(courier);
    });
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function populateCourierResolutionCourierFilter(orderRows) {
    const selectEl = document.getElementById('courierResolutionCourierFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const options = [
        { value: COURIER_FILTER_ALL, label: 'All couriers' },
        ...distinctCouriers(orderRows).map((c) => ({ value: c, label: c })),
    ];
    selectEl.innerHTML = options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    selectEl.value = (currentVal && options.some((o) => o.value === currentVal)) ? currentVal : COURIER_FILTER_ALL;
}

/** Periods only (no "Recent Orders") - this page always looks at one period at a time,
 * defaulting to the last fully-completed one rather than whatever's still in progress. */
function populateCourierResolutionPeriodFilter() {
    const selectEl = document.getElementById('courierResolutionPeriodFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const options = buildStaticPeriodOptions();
    selectEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    const lastMonthVal = options[1]?.value || options[0]?.value;
    selectEl.value = (currentVal && options.some((o) => o.value === currentVal)) ? currentVal : lastMonthVal;
}

function courierResolutionFilteredOrders() {
    const courier = document.getElementById('courierResolutionCourierFilter')?.value;
    if (!courier || courier === COURIER_FILTER_ALL) return courierResolutionOrders;
    return courierResolutionOrders.filter((order) => (order.courier || '').trim() === courier);
}

/** netOwed > 0 means the courier owes the shop overall; < 0 means the shop owes the
 * courier (e.g. return handling fees outweighing any COD collected). */
function courierResolutionSummary(orderRows) {
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

function renderCourierResolutionSummary(summary) {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    setText('courierResInTransitCount', summary.inTransit.toLocaleString());
    const breakdown = Object.entries(summary.inTransitByStatus)
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => `${count} ${status}`)
        .join(' · ');
    setText('courierResInTransitDetail', breakdown || 'None in transit');

    setText('courierResResolvedCount', summary.resolved.toLocaleString());

    const net = summary.netOwed;
    const netEl = document.getElementById('courierResNetOwed');
    if (netEl) {
        netEl.textContent = net < 0 ? `-Rs ${formatMoney(-net)}` : `Rs ${formatMoney(net)}`;
        netEl.style.color = net < 0 ? 'var(--danger)' : '';
    }
    setText('courierResNetOwedDetail', net > 0 ? 'Courier owes you' : net < 0 ? 'You owe the courier' : 'Settled');
}

/** Re-slice the already-fetched period data by the selected courier and redraw the
 * summary + grid - no refetch, since courier is a client-side facet on top of the period.
 * The grid shows both resolved (delivered/returned) and in-transit orders; only resolved
 * rows get a receivable/COD/paid figure, since that's only known once the courier outcome
 * is final. */
function renderCourierResolutionView() {
    const filtered = courierResolutionFilteredOrders();
    renderCourierResolutionSummary(courierResolutionSummary(filtered));

    const rows = filtered
        .filter((order) => {
            const status = (order.order_status || '').toLowerCase();
            return COURIER_RESOLVED_STATUSES.has(status) || COURIER_IN_TRANSIT_STATUSES.has(status);
        })
        .map((order) => {
            const isResolved = COURIER_RESOLVED_STATUSES.has((order.order_status || '').toLowerCase());
            return {
                ...order,
                receivable: isResolved ? computeReceivable(order) : null,
                cod_collected: isResolved
                    ? ((order.order_status || '').toLowerCase() === 'returned'
                        ? 0
                        : (parseFloat(order.total_amount) || 0) - (parseFloat(order.advance_amount) || 0))
                    : null,
                _paidApplicable: isResolved,
            };
        });

    if (courierResolutionGridApi) {
        courierResolutionGridApi.setGridOption('rowData', rows);
    }
}

async function loadCourierResolution() {
    const periodVal = document.getElementById('courierResolutionPeriodFilter')?.value;
    if (courierResolutionGridApi) courierResolutionGridApi.showLoadingOverlay();

    try {
        const [month, year] = (periodVal || '').split('-');
        const query = (month && year) ? `?month=${month}&year=${year}` : '';
        courierResolutionOrders = await apiJson(`/orders/${query}`, { fallback: 'Failed to load courier resolution data' });
    } catch (error) {
        console.error('Error loading courier resolution:', error);
        showToast('Failed to load courier resolution data', 'error');
        if (courierResolutionGridApi) courierResolutionGridApi.hideOverlay();
        return;
    }

    populateCourierResolutionCourierFilter(courierResolutionOrders);
    renderCourierResolutionView();
    if (courierResolutionGridApi) courierResolutionGridApi.hideOverlay();
}

function initCourierResolutionGrid() {
    const gridDiv = document.getElementById('courierResolutionGrid');
    if (!gridDiv) return;

    const money = (params) => (params.value != null ? formatMoney(params.value) : '');
    const columnDefs = [
        { headerName: 'Order #', field: 'order_number', width: 110 },
        { headerName: 'Courier', field: 'courier', width: 130 },
        { headerName: 'Tracking #', field: 'tracking_number', width: 150 },
        {
            headerName: 'Status',
            field: 'order_status',
            width: 130,
            cellRenderer: (params) => {
                const status = params.value || '';
                return `<span class="grid-status-badge ${orderStatusBadgeClass(status)}">${escapeHtml(status)}</span>`;
            },
        },
        {
            headerName: 'Order Date',
            field: 'order_receiving_date',
            width: 120,
            valueFormatter: (params) => (params.value ? formatDateDDMMYYYY(params.value) : ''),
        },
        {
            headerName: 'Pickup Date',
            field: 'courier_pickup_date',
            width: 120,
            valueFormatter: (params) => (params.value ? formatDateDDMMYYYY(params.value) : ''),
        },
        { headerName: 'Total', field: 'total_amount', width: 110, type: 'rightAligned', valueFormatter: money },
        { headerName: 'Advance', field: 'advance_amount', width: 110, type: 'rightAligned', valueFormatter: money },
        {
            headerName: 'COD Collected', field: 'cod_collected', width: 130, type: 'rightAligned',
            valueFormatter: (params) => (params.value != null ? formatMoney(params.value) : '-'),
        },
        { headerName: 'Delivery Charge', field: 'delivery_charge', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: 'Tax', field: 'tax_amount', width: 100, type: 'rightAligned', valueFormatter: money },
        {
            headerName: 'Owed by Courier',
            field: 'receivable',
            width: 160,
            type: 'rightAligned',
            cellRenderer: (params) => {
                if (params.value == null) return '<span style="color: var(--text-muted);">-</span>';
                const val = parseFloat(params.value) || 0;
                const color = val < 0 ? 'var(--danger)' : 'var(--success)';
                const label = val < 0 ? `-Rs ${formatMoney(-val)}` : `Rs ${formatMoney(val)}`;
                return `<span style="color: ${color}; font-weight: 600;">${label}</span>`;
            },
        },
        {
            headerName: 'Settled',
            field: 'is_order_settled',
            width: 110,
            cellRenderer: (params) => {
                if (!params.data?._paidApplicable) return '<span style="color: var(--text-muted);">-</span>';
                return params.value
                    ? '<span class="grid-status-badge grid-status-delivered">Settled</span>'
                    : '<span class="grid-status-badge grid-status-fulfilled">Unsettled</span>';
            },
        },
    ];

    agGrid.createGrid(gridDiv, {
        columnDefs,
        rowData: [],
        defaultColDef: { sortable: true, resizable: true, filter: true, minWidth: 90 },
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.id,
        onGridReady: (params) => {
            courierResolutionGridApi = params.api;
        },
    });
}

function initCourierResolution() {
    initCourierResolutionGrid();
    populateCourierResolutionPeriodFilter();
    document.getElementById('courierResolutionPeriodFilter')?.addEventListener('change', () => loadCourierResolution());
    document.getElementById('courierResolutionCourierFilter')?.addEventListener('change', () => renderCourierResolutionView());
}
