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

/** Fulfilled-date range popover, mirroring initCourierPaymentReportDateRangeButton. */
function initCourierPerformanceDateRangeButton() {
    const triggerBtn = document.getElementById('courierPerformanceDateRangeBtn');
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
        const { from, to } = courierPerformanceDateRange;
        triggerBtn.textContent = (from || to)
            ? `${from ? formatDateDDMMYYYY(from) : '…'} – ${to ? formatDateDDMMYYYY(to) : '…'}`
            : 'Date range';
    }

    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rawFrom = (fromInput.value || '').trim();
        const rawTo = (toInput.value || '').trim();
        courierPerformanceDateRange = {
            from: rawFrom ? parseDDMMYYYYToYYYYMMDD(rawFrom) : null,
            to: rawTo ? parseDDMMYYYYToYYYYMMDD(rawTo) : null,
        };
        updateButtonLabel();
        loadCourierPerformance();
        menu.style.display = 'none';
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fromInput.value = '';
        toInput.value = '';
        if (fromPicker) fromPicker.clear();
        if (toPicker) toPicker.clear();
        courierPerformanceDateRange = { from: null, to: null };
        updateButtonLabel();
        loadCourierPerformance();
        menu.style.display = 'none';
    });

    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display === 'none') {
            const { from, to } = courierPerformanceDateRange;
            fromInput.value = from ? formatDateDDMMYYYY(from) : '';
            toInput.value = to ? formatDateDDMMYYYY(to) : '';
            if (fromPicker) fromPicker.setDate(fromInput.value || null, false);
            if (toPicker) toPicker.setDate(toInput.value || null, false);

            const rect = triggerBtn.getBoundingClientRect();
            menu.style.display = 'block';
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
}

function initCourierPerformance() {
    initCourierPerformanceDateRangeButton();
    document.getElementById('courierPerformanceCityFilter')?.addEventListener('change', renderCourierPerformanceView);
    document.getElementById('courierPerformanceCourierFilter')?.addEventListener('change', renderCourierPerformanceView);
}
