// Print Airway Bill view: fulfilled PostEx / Couriers Next orders for a fulfillment-date
// range (today by default), each with a Print action plus a header button that prints the
// whole selection at once. All printing goes through printAirwayBillsForOrders (utils.js),
// which groups by courier and hits the existing airway-bill endpoints - this view adds no
// PDF logic of its own.
//
// Date range and courier are applied server-side (GET /orders/airway-bill-list); the search
// box is the one facet re-sliced locally, mirroring courier-payment-report.js.

function defaultPrintAirwayBillDateRange() {
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return { from: today, to: today };
}

let printAirwayBillOrders = [];
let printAirwayBillDateRange = defaultPrintAirwayBillDateRange();
let printAirwayBillSelectedIds = new Set();
let printAirwayBillLoading = false;

async function loadPrintAirwayBillOrders() {
    printAirwayBillLoading = true;
    renderPrintAirwayBillTable();

    const params = new URLSearchParams();
    const { from, to } = printAirwayBillDateRange;
    if (from) params.append('date_from', from);
    if (to) params.append('date_to', to);
    const courier = document.getElementById('printAirwayBillCourierFilter')?.value;
    if (courier) params.append('courier', courier);

    try {
        printAirwayBillOrders = await apiJson(`/orders/airway-bill-list?${params}`, {
            fallback: 'Failed to load fulfilled orders',
        });
        // Drop selections for orders no longer in the list after a refetch.
        const ids = new Set(printAirwayBillOrders.map((o) => o.id));
        printAirwayBillSelectedIds.forEach((id) => { if (!ids.has(id)) printAirwayBillSelectedIds.delete(id); });
    } catch (error) {
        console.error('Error loading airway bill list:', error);
        showToast(error.message || 'Failed to load fulfilled orders', 'error');
        printAirwayBillOrders = [];
    } finally {
        printAirwayBillLoading = false;
        renderPrintAirwayBillTable();
    }
}

function printAirwayBillVisibleOrders() {
    const query = (document.getElementById('printAirwayBillSearch')?.value || '').trim().toLowerCase();
    if (!query) return printAirwayBillOrders;
    return printAirwayBillOrders.filter((o) =>
        String(o.order_number).includes(query)
        || (o.customer_name || '').toLowerCase().includes(query)
        || (o.customer_phone || '').toLowerCase().includes(query)
        || (o.customer_city || '').toLowerCase().includes(query)
        || (o.tracking_number || '').toLowerCase().includes(query));
}

function renderPrintAirwayBillRow(order) {
    const checked = printAirwayBillSelectedIds.has(order.id);
    return `
        <tr data-order-id="${escapeHtml(order.id)}" class="${checked ? 'fulfillment-row--selected' : ''}">
            <td class="fulfillment-col-check"><input type="checkbox" class="print-awb-row-checkbox" ${checked ? 'checked' : ''}></td>
            <td class="fulfillment-col-orderid"><span class="fulfillment-order-id">#${escapeHtml(String(order.order_number))}</span></td>
            <td class="fulfillment-col-name" title="${escapeHtml(order.customer_name)}">${escapeHtml(order.customer_name)}</td>
            <td class="print-awb-col-address" title="${escapeHtml(order.customer_address)}">${escapeHtml(order.customer_address)}</td>
            <td>${escapeHtml(order.customer_phone)}</td>
            <td>${escapeHtml(order.customer_city)}</td>
            <td class="fulfillment-col-cod">${escapeHtml(formatMoney(order.cod))}</td>
            <td>${escapeHtml(order.tracking_number)}</td>
            <td>${escapeHtml(getCourierDisplayName(order))}</td>
            <td><span class="grid-status-badge grid-status-fulfilled">Fulfilled</span></td>
            <td class="fulfillment-actions-cell">
                <button type="button" class="btn btn-secondary btn-sm print-awb-print-btn"><i data-lucide="printer"></i> Print</button>
            </td>
        </tr>`;
}

function renderPrintAirwayBillTable() {
    const filtered = printAirwayBillVisibleOrders();

    const totalLabel = document.getElementById('printAirwayBillTotalLabel');
    if (totalLabel) totalLabel.textContent = `Total Orders: ${printAirwayBillOrders.length}`;

    const tbody = document.getElementById('printAirwayBillTableBody');
    if (tbody) {
        if (printAirwayBillLoading) {
            tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Loading fulfilled orders…</td></tr>';
        } else {
            tbody.innerHTML = filtered.length
                ? filtered.map(renderPrintAirwayBillRow).join('')
                : '<tr><td colspan="11" class="empty-state">No fulfilled orders for this date range.</td></tr>';
            attachPrintAirwayBillRowHandlers(tbody);
            if (window.lucide) lucide.createIcons({ root: tbody });
        }
    }

    const allSelected = filtered.length > 0 && filtered.every((o) => printAirwayBillSelectedIds.has(o.id));
    const someSelected = !allSelected && filtered.some((o) => printAirwayBillSelectedIds.has(o.id));
    [document.getElementById('printAirwayBillHeaderCheckbox'), document.getElementById('printAirwayBillSelectAll')].forEach((cb) => {
        if (!cb) return;
        cb.checked = allSelected;
        cb.indeterminate = someSelected;
    });

    const countLabel = document.getElementById('printAirwayBillSelectedCountLabel');
    if (countLabel) {
        countLabel.textContent = `${printAirwayBillSelectedIds.size} selected`;
        countLabel.style.display = printAirwayBillSelectedIds.size === 0 ? 'none' : '';
    }
}

function attachPrintAirwayBillRowHandlers(tbody) {
    tbody.querySelectorAll('tr').forEach((tr) => {
        const orderId = tr.dataset.orderId;
        const order = printAirwayBillOrders.find((o) => o.id === orderId);
        if (!order) return;

        tr.querySelector('.print-awb-row-checkbox')?.addEventListener('change', (e) => {
            if (e.target.checked) printAirwayBillSelectedIds.add(orderId);
            else printAirwayBillSelectedIds.delete(orderId);
            renderPrintAirwayBillTable();
        });

        tr.querySelector('.print-awb-print-btn')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
                await printAirwayBillsForOrders([order]);
            } catch (error) {
                showToast(error.message || 'Failed to print airway bill', 'error');
            } finally {
                btn.disabled = false;
            }
        });
    });
}

function togglePrintAirwayBillSelectAll(checked) {
    printAirwayBillVisibleOrders().forEach((o) => {
        if (checked) printAirwayBillSelectedIds.add(o.id);
        else printAirwayBillSelectedIds.delete(o.id);
    });
    renderPrintAirwayBillTable();
}

/** Print every selected order, or every visible one when nothing is ticked. */
async function printSelectedAirwayBills() {
    const selected = printAirwayBillOrders.filter((o) => printAirwayBillSelectedIds.has(o.id));
    const orders = selected.length ? selected : printAirwayBillVisibleOrders();
    if (orders.length === 0) {
        showToast('No orders to print', 'error', { silent: true });
        return;
    }
    const btn = document.getElementById('printAirwayBillBulkBtn');
    if (btn) btn.disabled = true;
    try {
        const skipped = await printAirwayBillsForOrders(orders);
        showToast(
            `Airway bills ready${skipped > 0 ? ` (${skipped} order(s) skipped)` : ''}`,
            'success'
        );
    } catch (error) {
        showToast(error.message || 'Failed to print airway bills', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/** Fulfillment-date range popover - mirrors initCourierPaymentReportDateRangeButton
 * (courier-payment-report.js), refetching the list on Apply / Clear. */
function initPrintAirwayBillDateRangeButton() {
    const triggerBtn = document.getElementById('printAirwayBillDateRangeBtn');
    if (!triggerBtn) return;

    const menu = document.createElement('div');
    menu.className = 'date-range-menu';
    menu.style.display = 'none';

    const makeField = (labelText) => {
        const field = document.createElement('div');
        field.className = 'date-range-menu__field';
        const label = document.createElement('label');
        label.className = 'date-range-menu__label';
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'dd/mm/yyyy';
        input.className = 'grid-floating-filter-date';
        field.appendChild(label);
        field.appendChild(input);
        return { field, input };
    };

    const from = makeField('From');
    const to = makeField('To');

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

    menu.appendChild(from.field);
    menu.appendChild(to.field);
    menu.appendChild(actionsRow);

    const flatpickrOpts = { dateFormat: 'd/m/Y', allowInput: true, static: false };
    const fromPicker = window.flatpickr ? window.flatpickr(from.input, flatpickrOpts) : null;
    const toPicker = window.flatpickr ? window.flatpickr(to.input, flatpickrOpts) : null;

    function updateButtonLabel() {
        const { from: f, to: t } = printAirwayBillDateRange;
        triggerBtn.textContent = (f || t)
            ? `${f ? formatDateDDMMYYYY(f) : '…'} – ${t ? formatDateDDMMYYYY(t) : '…'}`
            : 'Date range';
    }

    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        printAirwayBillDateRange = {
            from: parseDDMMYYYYToYYYYMMDD((from.input.value || '').trim()),
            to: parseDDMMYYYYToYYYYMMDD((to.input.value || '').trim()),
        };
        updateButtonLabel();
        loadPrintAirwayBillOrders();
        menu.style.display = 'none';
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        from.input.value = '';
        to.input.value = '';
        if (fromPicker) fromPicker.clear();
        if (toPicker) toPicker.clear();
        printAirwayBillDateRange = { from: null, to: null };
        updateButtonLabel();
        loadPrintAirwayBillOrders();
        menu.style.display = 'none';
    });

    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display === 'none') {
            const { from: f, to: t } = printAirwayBillDateRange;
            from.input.value = f ? formatDateDDMMYYYY(f) : '';
            to.input.value = t ? formatDateDDMMYYYY(t) : '';
            if (fromPicker) fromPicker.setDate(from.input.value || null, false);
            if (toPicker) toPicker.setDate(to.input.value || null, false);

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

    window._printAirwayBillResetDateRange = () => {
        printAirwayBillDateRange = defaultPrintAirwayBillDateRange();
        from.input.value = '';
        to.input.value = '';
        if (fromPicker) fromPicker.clear();
        if (toPicker) toPicker.clear();
        updateButtonLabel();
    };
}

function initPrintAirwayBill() {
    initPrintAirwayBillDateRangeButton();

    document.getElementById('printAirwayBillCourierFilter')?.addEventListener('change', () => loadPrintAirwayBillOrders());
    document.getElementById('printAirwayBillSearch')?.addEventListener('input', debounce(() => renderPrintAirwayBillTable(), 250));

    document.getElementById('printAirwayBillClearFiltersBtn')?.addEventListener('click', () => {
        const courierSelect = document.getElementById('printAirwayBillCourierFilter');
        if (courierSelect) courierSelect.value = 'PostEx';
        const search = document.getElementById('printAirwayBillSearch');
        if (search) search.value = '';
        if (typeof window._printAirwayBillResetDateRange === 'function') window._printAirwayBillResetDateRange();
        loadPrintAirwayBillOrders();
    });

    document.getElementById('printAirwayBillHeaderCheckbox')?.addEventListener('change', (e) => togglePrintAirwayBillSelectAll(e.target.checked));
    document.getElementById('printAirwayBillSelectAll')?.addEventListener('change', (e) => togglePrintAirwayBillSelectAll(e.target.checked));
    document.getElementById('printAirwayBillClearSelectionBtn')?.addEventListener('click', () => {
        printAirwayBillSelectedIds.clear();
        renderPrintAirwayBillTable();
    });

    document.getElementById('printAirwayBillBulkBtn')?.addEventListener('click', printSelectedAirwayBills);
}

function renderPrintAirwayBillView() {
    return loadPrintAirwayBillOrders();
}
