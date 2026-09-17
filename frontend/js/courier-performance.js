// Courier Performance view: delivery/return/failed rates per city per courier.

let courierPerformanceDateRange = { from: null, to: null };
let courierPerformanceRows = [];

function courierPerformanceFilteredRows() {
    const city = document.getElementById('courierPerformanceCityFilter')?.value || '';
    const courier = document.getElementById('courierPerformanceCourierFilter')?.value || '';
    return courierPerformanceRows.filter((r) =>
        (!city || r.city === city) && (!courier || r.courier === courier)
    );
}

function renderCourierPerformanceView() {
    const rows = courierPerformanceFilteredRows();

    const totals = rows.reduce((acc, r) => {
        acc.orders += r.orders;
        acc.delivered += r.delivered;
        acc.returned += r.returned;
        acc.failed += r.failed;
        acc.cod += r.cod_collected;
        acc.shipping += r.shipping_cost;
        return acc;
    }, { orders: 0, delivered: 0, returned: 0, failed: 0, cod: 0, shipping: 0 });

    document.getElementById('courierPerfTotalShipments').textContent = totals.orders.toLocaleString();
    document.getElementById('courierPerfDeliveredPct').textContent = totals.orders ? `${(totals.delivered / totals.orders * 100).toFixed(1)}%` : '0%';
    document.getElementById('courierPerfReturnPct').textContent = totals.orders ? `${(totals.returned / totals.orders * 100).toFixed(1)}%` : '0%';
    document.getElementById('courierPerfFailedPct').textContent = totals.orders ? `${(totals.failed / totals.orders * 100).toFixed(1)}%` : '0%';
    document.getElementById('courierPerfCodCollected').textContent = `Rs ${formatMoney(totals.cod)}`;
    document.getElementById('courierPerfShippingCost').textContent = `Rs ${formatMoney(totals.shipping)}`;

    const pctBadge = (pct, kind) => `<span class="grid-status-badge grid-status-${kind}">${pct}%</span>`;

    const tbody = document.getElementById('courierPerformanceBody');
    tbody.innerHTML = rows.map((r) => `
        <tr>
            <td>${escapeHtml(r.city)}</td>
            <td>${escapeHtml(r.courier)}</td>
            <td>${r.orders.toLocaleString()}</td>
            <td>${r.delivered.toLocaleString()}</td>
            <td>${pctBadge(r.delivery_pct, 'delivered')}</td>
            <td>${r.returned.toLocaleString()}</td>
            <td>${pctBadge(r.return_pct, 'returned')}</td>
            <td>${pctBadge(r.failed_pct, 'cancelled')}</td>
            <td>Rs ${formatMoney(r.cod_collected)}</td>
            <td>Rs ${formatMoney(r.shipping_cost)}</td>
        </tr>
    `).join('');

    document.getElementById('courierPerformanceEmpty').style.display = rows.length ? 'none' : 'block';
}

function populateCourierPerformanceFilters() {
    const fillSelect = (id, allLabel, values) => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        select.innerHTML = `<option value="">${allLabel}</option>` +
            values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        if (values.includes(current)) select.value = current;
    };
    const cities = [...new Set(courierPerformanceRows.map((r) => r.city))].sort();
    const couriers = [...new Set(courierPerformanceRows.map((r) => r.courier))].sort();
    fillSelect('courierPerformanceCityFilter', 'All Cities', cities);
    fillSelect('courierPerformanceCourierFilter', 'All Couriers', couriers);
}

async function loadCourierPerformance() {
    const params = new URLSearchParams();
    const { from, to } = courierPerformanceDateRange;
    if (from) params.append('date_from', from);
    if (to) params.append('date_to', to);

    try {
        const { rows } = await apiJson(`/orders/courier-performance-by-city?${params}`, { fallback: 'Failed to load courier performance data' });
        courierPerformanceRows = rows;
    } catch (error) {
        console.error('Error loading courier performance:', error);
        showToast('Failed to load courier performance data', 'error');
        return;
    }

    populateCourierPerformanceFilters();
    renderCourierPerformanceView();
}

/** Fulfilled-date range popover, via the shared createDateRangePicker (utils.js). */
function initCourierPerformanceDateRangeButton() {
    const triggerBtn = document.getElementById('courierPerformanceDateRangeBtn');
    if (!triggerBtn) return;

    function updateButtonLabel() {
        const { from, to } = courierPerformanceDateRange;
        rangePicker.setLabel((from || to)
            ? `${from ? formatDateDDMMYYYY(from) : '…'} – ${to ? formatDateDDMMYYYY(to) : '…'}`
            : 'Date range');
        rangePicker.setClearable(!!(from || to));
    }

    const rangePicker = createDateRangePicker(triggerBtn, {
        onSelect: (from, to) => {
            courierPerformanceDateRange = { from, to };
            updateButtonLabel();
            loadCourierPerformance();
        },
        onClear: () => {
            rangePicker.picker.clear();
            courierPerformanceDateRange = { from: null, to: null };
            updateButtonLabel();
            loadCourierPerformance();
        },
    });
    if (!rangePicker) return;
    updateButtonLabel();
}

function initCourierPerformance() {
    initCourierPerformanceDateRangeButton();
    document.getElementById('courierPerformanceCityFilter')?.addEventListener('change', renderCourierPerformanceView);
    document.getElementById('courierPerformanceCourierFilter')?.addEventListener('change', renderCourierPerformanceView);
}
