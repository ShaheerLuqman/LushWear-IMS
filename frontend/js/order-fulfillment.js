// Order Fulfillment view - a bulk "select orders, pick a courier, fulfill" screen.
//
// The order list itself is real (GET /orders/unfulfilled). Editing a row's address/mobile/tags/
// city, and the Fulfill/Duplicate/Remove actions, still only mutate local state and re-render
// instead of calling the API - wire those up to real endpoints once this view's write side exists.

// Couriers actually integrated elsewhere in the app (orders-columns.js COURIER_LOGOS) get their
// real logo; the rest are shown as plain monogram chips since no logo asset exists for them.
const FULFILLMENT_COURIERS = [
    { id: 'postex', name: 'PostEx', logo: 'assets/postex_logo.png' },
    { id: 'couriers_next', name: 'Couriers Next', logo: 'assets/courier_next_logo.png' },
    { id: 'leopards', name: 'Leopards Courier', monogram: 'LC', color: '#c45c2e' },
    { id: 'tcs', name: 'TCS', monogram: 'TCS', color: '#c4342e' },
    { id: 'trax', name: 'Trax', monogram: 'TX', color: '#2e5fc4' },
    { id: 'bykea', name: 'Bykea', monogram: 'BK', color: '#1fa35c' },
    { id: 'other', name: 'Other', monogram: '···', color: '#6d6d78' }
];

let fulfillmentOrders = [];
let fulfillmentLoading = false;
let fulfillmentAllCities = [];
let fulfillmentAllTags = [];
let fulfillmentSelectedIds = new Set();
let fulfillmentFilters = { city: '', cityMode: 'exclude', chipCities: [], tag: '', dateFrom: null, dateTo: null };
let fulfillmentDatePicker = null;
let fulfillmentOpenMenuOrderId = null; // tags or actions menu currently open, if any

/** Fetch the real unfulfilled-orders list and refresh the filter option lists derived from it. */
async function fetchFulfillmentOrders() {
    fulfillmentLoading = true;
    renderFulfillmentTable();
    let ok = true;
    try {
        const rows = await apiJson('/orders/unfulfilled', { fallback: 'Failed to fetch unfulfilled orders' });
        fulfillmentOrders = rows.map(o => ({ ...o, order_date: new Date(o.order_date) }));
    } catch (error) {
        console.error('Error loading unfulfilled orders:', error);
        showToast(error.message || 'Failed to load unfulfilled orders', 'error');
        fulfillmentOrders = [];
        ok = false;
    } finally {
        fulfillmentLoading = false;
        renderFulfillmentFilterOptions();
        renderFulfillmentTable();
    }
    return ok;
}

/** Rebuild the city/tag filter dropdowns (and per-row edit option lists) from whatever
 * cities/tags actually appear in fulfillmentOrders - real orders don't come from a fixed
 * set of either, unlike the mock data this view used to show. */
function renderFulfillmentFilterOptions() {
    fulfillmentAllCities = [...new Set(fulfillmentOrders.map(o => o.city).filter(Boolean))].sort();
    fulfillmentAllTags = [...new Set(fulfillmentOrders.flatMap(o => o.tags))].sort();

    const cityFilterEl = document.getElementById('fulfillmentCityFilter');
    if (cityFilterEl) {
        const current = cityFilterEl.value;
        cityFilterEl.innerHTML = '<option value="">All Cities</option>' + fulfillmentAllCities.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        cityFilterEl.value = fulfillmentAllCities.includes(current) ? current : '';
    }

    const tagsFilterEl = document.getElementById('fulfillmentTagsFilter');
    if (tagsFilterEl) {
        const current = tagsFilterEl.value;
        tagsFilterEl.innerHTML = '<option value="">All Tags</option>' + fulfillmentAllTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        tagsFilterEl.value = fulfillmentAllTags.includes(current) ? current : '';
    }

    const chipOptionsEl = document.getElementById('fulfillmentCityChipOptions');
    if (chipOptionsEl) {
        chipOptionsEl.innerHTML = fulfillmentAllCities.map(c => `<option value="${escapeHtml(c)}">`).join('');
    }
}

function initOrderFulfillment() {
    const cityFilterEl = document.getElementById('fulfillmentCityFilter');
    if (cityFilterEl) {
        cityFilterEl.addEventListener('change', () => {
            fulfillmentFilters.city = cityFilterEl.value;
            renderFulfillmentTable();
        });
    }

    const tagsFilterEl = document.getElementById('fulfillmentTagsFilter');
    if (tagsFilterEl) {
        tagsFilterEl.addEventListener('change', () => {
            fulfillmentFilters.tag = tagsFilterEl.value;
            renderFulfillmentTable();
        });
    }

    const cityModeEl = document.getElementById('fulfillmentCityMode');
    if (cityModeEl) {
        cityModeEl.addEventListener('change', () => {
            fulfillmentFilters.cityMode = cityModeEl.value;
            renderFulfillmentTable();
        });
    }

    const chipInput = document.getElementById('fulfillmentCityChipInput');
    if (chipInput) {
        chipInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const val = chipInput.value.trim();
            if (val && fulfillmentAllCities.includes(val) && !fulfillmentFilters.chipCities.includes(val)) {
                fulfillmentFilters.chipCities.push(val);
                renderFulfillmentCityChips();
                renderFulfillmentTable();
            }
            chipInput.value = '';
        });
    }

    const dateInput = document.getElementById('fulfillmentDateRangeInput');
    if (dateInput && window.flatpickr) {
        fulfillmentDatePicker = window.flatpickr(dateInput, {
            mode: 'range',
            dateFormat: 'd/m/Y',
            onChange: (selectedDates) => {
                fulfillmentFilters.dateFrom = selectedDates[0] || null;
                fulfillmentFilters.dateTo = selectedDates[1] || null;
                if (selectedDates.length === 2) {
                    renderFulfillmentTable();
                }
            }
        });
    }

    document.getElementById('fulfillmentClearFiltersBtn')?.addEventListener('click', () => {
        fulfillmentFilters = { city: '', cityMode: 'exclude', chipCities: [], tag: '', dateFrom: null, dateTo: null };
        if (cityFilterEl) cityFilterEl.value = '';
        if (cityModeEl) cityModeEl.value = 'exclude';
        if (tagsFilterEl) tagsFilterEl.value = '';
        if (fulfillmentDatePicker) fulfillmentDatePicker.clear();
        renderFulfillmentCityChips();
        renderFulfillmentTable();
    });

    document.getElementById('fulfillmentHeaderCheckbox')?.addEventListener('change', (e) => {
        toggleFulfillmentSelectAllVisible(e.target.checked);
    });
    document.getElementById('fulfillmentSelectAll')?.addEventListener('change', (e) => {
        toggleFulfillmentSelectAllVisible(e.target.checked);
    });
    document.getElementById('fulfillmentClearSelectionBtn')?.addEventListener('click', () => {
        fulfillmentSelectedIds.clear();
        renderFulfillmentTable();
    });

    document.getElementById('fulfillmentCourierSelectBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('fulfillmentCourierMenu')?.classList.toggle('open');
    });

    document.getElementById('fulfillmentCancelSelectionBtn')?.addEventListener('click', () => {
        fulfillmentSelectedIds.clear();
        renderFulfillmentTable();
    });

    document.getElementById('fulfillmentFulfillBtn')?.addEventListener('click', () => {
        const courierLabel = document.getElementById('fulfillmentCourierSelectLabel')?.textContent || '';
        if (!courierLabel || courierLabel === 'Select Courier') {
            showToast('Select a courier first', 'error');
            return;
        }
        showToast(`Fulfillment isn't wired up to the backend yet (${fulfillmentSelectedIds.size} order(s), ${courierLabel})`, 'info');
    });

    document.getElementById('orderFulfillmentExportBtn')?.addEventListener('click', () => {
        showToast('Export not implemented yet', 'info');
    });
    document.getElementById('orderFulfillmentRefreshBtn')?.addEventListener('click', async () => {
        if (await renderOrderFulfillmentView()) showToast('Refreshed', 'success');
    });

    document.addEventListener('click', () => {
        closeFulfillmentOpenMenus();
        document.getElementById('fulfillmentCourierMenu')?.classList.remove('open');
    });

    renderFulfillmentCourierMenu();
    renderFulfillmentCityChips();
}

function renderFulfillmentCityChips() {
    const wrap = document.getElementById('fulfillmentCityChips');
    if (!wrap) return;
    const input = document.getElementById('fulfillmentCityChipInput');
    wrap.querySelectorAll('.fulfillment-chip').forEach(el => el.remove());
    fulfillmentFilters.chipCities.forEach(city => {
        const chip = document.createElement('span');
        chip.className = 'fulfillment-chip';
        chip.innerHTML = `${escapeHtml(city)} <button type="button" aria-label="Remove ${escapeHtml(city)}">&times;</button>`;
        chip.querySelector('button').addEventListener('click', () => {
            fulfillmentFilters.chipCities = fulfillmentFilters.chipCities.filter(c => c !== city);
            renderFulfillmentCityChips();
            renderFulfillmentTable();
        });
        wrap.insertBefore(chip, input);
    });
}

function renderFulfillmentCourierMenu() {
    const menu = document.getElementById('fulfillmentCourierMenu');
    if (!menu) return;
    menu.innerHTML = FULFILLMENT_COURIERS.map(c => {
        const icon = c.logo
            ? `<span class="fulfillment-courier-logo-chip"><img src="${c.logo}" alt="${escapeHtml(c.name)}"></span>`
            : `<span class="fulfillment-courier-monogram" style="background:${c.color}">${escapeHtml(c.monogram)}</span>`;
        return `<div class="fulfillment-courier-menu-item" data-courier-id="${c.id}">${icon}<span>${escapeHtml(c.name)}</span></div>`;
    }).join('');
    menu.querySelectorAll('.fulfillment-courier-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const courier = FULFILLMENT_COURIERS.find(c => c.id === item.dataset.courierId);
            if (!courier) return;
            const labelEl = document.getElementById('fulfillmentCourierSelectLabel');
            const icon = courier.logo
                ? `<span class="fulfillment-courier-logo-chip"><img src="${courier.logo}" alt="${escapeHtml(courier.name)}"></span>`
                : `<span class="fulfillment-courier-monogram" style="background:${courier.color}">${escapeHtml(courier.monogram)}</span>`;
            if (labelEl) labelEl.innerHTML = `${icon}${escapeHtml(courier.name)}`;
            menu.classList.remove('open');
        });
    });
}

function closeFulfillmentOpenMenus() {
    document.querySelectorAll('.fulfillment-tags-menu.open, .fulfillment-actions-menu.open').forEach(el => el.classList.remove('open'));
}

function getFulfillmentFilteredOrders() {
    return fulfillmentOrders.filter(o => {
        if (fulfillmentFilters.city && o.city !== fulfillmentFilters.city) return false;
        if (fulfillmentFilters.tag && !o.tags.includes(fulfillmentFilters.tag)) return false;
        if (fulfillmentFilters.chipCities.length > 0) {
            const inChips = fulfillmentFilters.chipCities.includes(o.city);
            if (fulfillmentFilters.cityMode === 'exclude' && inChips) return false;
            if (fulfillmentFilters.cityMode === 'include' && !inChips) return false;
        }
        if (fulfillmentFilters.dateFrom && o.order_date < fulfillmentFilters.dateFrom) return false;
        if (fulfillmentFilters.dateTo) {
            const endOfDay = new Date(fulfillmentFilters.dateTo);
            endOfDay.setHours(23, 59, 59, 999);
            if (o.order_date > endOfDay) return false;
        }
        return true;
    });
}

function toggleFulfillmentSelectAllVisible(checked) {
    getFulfillmentFilteredOrders().forEach(o => {
        if (checked) fulfillmentSelectedIds.add(o.id);
        else fulfillmentSelectedIds.delete(o.id);
    });
    renderFulfillmentTable();
}

function fulfillmentTagBadgeClass(tag) {
    return {
        VIP: 'fulfillment-tag-vip',
        Repeat: 'fulfillment-tag-repeat',
        New: 'fulfillment-tag-new',
        Wholesale: 'fulfillment-tag-wholesale'
    }[tag] || 'fulfillment-tag-new';
}

const FULFILLMENT_RISK_ICONS = { trusted: 'shield-check', new: 'user-plus' }; // low/medium/high get a plain dot instead

function renderFulfillmentRiskCell(order) {
    const status = order.customer_status || { tier: 'new', label: 'New Customer', received: 0, total: 0 };
    const icon = FULFILLMENT_RISK_ICONS[status.tier]
        ? `<i data-lucide="${FULFILLMENT_RISK_ICONS[status.tier]}"></i>`
        : '<span class="fulfillment-risk-dot"></span>';
    const subtitle = status.total === 0 ? 'No previous orders' : `${status.received}/${status.total} orders delivered`;
    return `
        <div class="fulfillment-risk-badge fulfillment-risk-badge--${status.tier}">${icon}<span>${escapeHtml(status.label)}</span></div>
        <div class="fulfillment-risk-sub">
            <span>${escapeHtml(subtitle)}</span>
            <i data-lucide="info" title="Based on this customer's past delivered vs. total orders"></i>
        </div>
    `;
}

function renderFulfillmentRow(order) {
    const checked = fulfillmentSelectedIds.has(order.id);
    const tagsHtml = order.tags.map(t => `<span class="fulfillment-tag-badge ${fulfillmentTagBadgeClass(t)}">${escapeHtml(t)}</span>`).join('');
    const tagsMenuOptions = fulfillmentAllTags.map(t => `
        <label><input type="checkbox" data-tag-toggle="${escapeHtml(t)}" ${order.tags.includes(t) ? 'checked' : ''}> ${escapeHtml(t)}</label>
    `).join('');
    const cityOptions = fulfillmentAllCities.map(c => `<option value="${escapeHtml(c)}" ${c === order.city ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');

    return `
        <tr data-order-id="${order.id}" class="${checked ? 'fulfillment-row--selected' : ''}">
            <td class="fulfillment-col-check"><input type="checkbox" class="fulfillment-row-checkbox" ${checked ? 'checked' : ''}></td>
            <td><span class="fulfillment-order-id">#${order.order_number}</span></td>
            <td>${escapeHtml(order.name)}</td>
            <td>
                <div class="fulfillment-editable-cell" data-field="address">
                    <span class="fulfillment-editable-text" title="${escapeHtml(order.address)}">${escapeHtml(order.address)}</span>
                    <button type="button" class="fulfillment-edit-btn" data-edit-field="address" title="Edit address"><i data-lucide="pencil"></i></button>
                </div>
            </td>
            <td>
                <div class="fulfillment-editable-cell" data-field="mobile">
                    <span class="fulfillment-editable-text">${escapeHtml(order.mobile)}</span>
                    <button type="button" class="fulfillment-edit-btn" data-edit-field="mobile" title="Edit mobile number"><i data-lucide="pencil"></i></button>
                </div>
            </td>
            <td>
                <div class="fulfillment-tags-cell">
                    ${tagsHtml}
                    <button type="button" class="fulfillment-tags-toggle" data-tags-toggle title="Edit tags"><i data-lucide="chevron-down"></i></button>
                    <div class="fulfillment-tags-menu">${tagsMenuOptions}</div>
                </div>
            </td>
            <td><select class="fulfillment-city-select" data-city-select>${cityOptions}</select></td>
            <td class="fulfillment-risk-cell">${renderFulfillmentRiskCell(order)}</td>
            <td class="fulfillment-actions-cell">
                <button type="button" class="fulfillment-kebab-btn" data-actions-toggle title="More actions">&#8942;</button>
                <div class="fulfillment-actions-menu">
                    <button type="button" data-action="view">View Order</button>
                    <button type="button" data-action="duplicate">Duplicate</button>
                    <button type="button" class="fulfillment-actions-menu__danger" data-action="remove">Remove from list</button>
                </div>
            </td>
        </tr>
    `;
}

function attachFulfillmentRowHandlers(tbody) {
    tbody.querySelectorAll('tr').forEach(tr => {
        const orderId = tr.dataset.orderId;
        const order = fulfillmentOrders.find(o => o.id === orderId);
        if (!order) return;

        tr.querySelector('.fulfillment-row-checkbox')?.addEventListener('change', (e) => {
            if (e.target.checked) fulfillmentSelectedIds.add(orderId);
            else fulfillmentSelectedIds.delete(orderId);
            renderFulfillmentTable();
        });

        tr.querySelectorAll('[data-edit-field]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const field = btn.dataset.editField;
                const cell = btn.closest('.fulfillment-editable-cell');
                const textEl = cell.querySelector('.fulfillment-editable-text');
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'fulfillment-edit-input';
                input.value = order[field];
                const commit = () => {
                    order[field] = input.value.trim() || order[field];
                    renderFulfillmentTable();
                };
                input.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') commit();
                    if (ev.key === 'Escape') renderFulfillmentTable();
                });
                input.addEventListener('blur', commit);
                cell.replaceChild(input, textEl);
                btn.style.display = 'none';
                input.focus();
                input.select();
            });
        });

        tr.querySelector('[data-tags-toggle]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = tr.querySelector('.fulfillment-tags-menu');
            const isOpen = menu.classList.contains('open');
            closeFulfillmentOpenMenus();
            if (!isOpen) menu.classList.add('open');
        });
        tr.querySelectorAll('[data-tag-toggle]').forEach(cb => {
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', (e) => {
                const tag = cb.dataset.tagToggle;
                if (e.target.checked) {
                    if (!order.tags.includes(tag)) order.tags.push(tag);
                } else {
                    order.tags = order.tags.filter(t => t !== tag);
                }
                renderFulfillmentTable();
            });
        });

        tr.querySelector('[data-city-select]')?.addEventListener('change', (e) => {
            order.city = e.target.value;
            renderFulfillmentTable();
        });

        tr.querySelector('[data-actions-toggle]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = tr.querySelector('.fulfillment-actions-menu');
            const isOpen = menu.classList.contains('open');
            closeFulfillmentOpenMenus();
            if (!isOpen) menu.classList.add('open');
        });
        tr.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (action === 'remove') {
                    fulfillmentOrders = fulfillmentOrders.filter(o => o.id !== orderId);
                    fulfillmentSelectedIds.delete(orderId);
                    renderFulfillmentTable();
                } else if (action === 'duplicate') {
                    const newOrder = { ...order, id: `fo-${Date.now()}`, order_number: Math.max(...fulfillmentOrders.map(o => o.order_number)) + 1, tags: [...order.tags] };
                    fulfillmentOrders.push(newOrder);
                    renderFulfillmentTable();
                } else {
                    showToast(`Order #${order.order_number}`, 'info');
                }
            });
        });
    });
}

function renderFulfillmentSidePanel() {
    const empty = document.getElementById('fulfillmentSidePanelEmpty');
    const content = document.getElementById('fulfillmentSidePanelContent');
    const count = fulfillmentSelectedIds.size;

    if (count === 0) {
        if (empty) empty.style.display = 'flex';
        if (content) content.style.display = 'none';
        return;
    }

    if (empty) empty.style.display = 'none';
    if (content) content.style.display = 'block';

    const selectedOrders = fulfillmentOrders.filter(o => fulfillmentSelectedIds.has(o.id));
    const title = document.getElementById('fulfillmentSidePanelTitle');
    const orderIdEl = document.getElementById('fulfillmentSidePanelOrderId');
    if (title) title.textContent = count === 1 ? '1 Order Selected' : `${count} Orders Selected`;
    if (orderIdEl) {
        const ids = selectedOrders.slice(0, 4).map(o => `#${o.order_number}`).join(', ');
        orderIdEl.textContent = count > 4 ? `${ids} +${count - 4} more` : ids;
    }
}

function renderFulfillmentTable() {
    const filtered = getFulfillmentFilteredOrders();

    const totalOrdersLabel = document.getElementById('fulfillmentTotalOrdersLabel');
    const unfulfilledBadge = document.getElementById('fulfillmentUnfulfilledBadge');
    if (totalOrdersLabel) totalOrdersLabel.textContent = `Total Orders: ${fulfillmentOrders.length}`;
    if (unfulfilledBadge) unfulfilledBadge.textContent = `Unfulfilled: ${fulfillmentOrders.length}`;

    const tbody = document.getElementById('fulfillmentTableBody');
    if (tbody) {
        if (fulfillmentLoading) {
            tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Loading unfulfilled orders…</td></tr>';
        } else {
            tbody.innerHTML = filtered.length
                ? filtered.map(renderFulfillmentRow).join('')
                : '<tr><td colspan="9" class="empty-state">No unfulfilled orders match these filters.</td></tr>';
            attachFulfillmentRowHandlers(tbody);
            if (window.lucide) lucide.createIcons();
        }
    }

    const allSelected = filtered.length > 0 && filtered.every(o => fulfillmentSelectedIds.has(o.id));
    const someSelected = !allSelected && filtered.some(o => fulfillmentSelectedIds.has(o.id));
    [document.getElementById('fulfillmentHeaderCheckbox'), document.getElementById('fulfillmentSelectAll')].forEach(cb => {
        if (!cb) return;
        cb.checked = allSelected;
        cb.indeterminate = someSelected;
    });

    const selectedCountLabel = document.getElementById('fulfillmentSelectedCountLabel');
    if (selectedCountLabel) selectedCountLabel.textContent = `${fulfillmentSelectedIds.size} selected`;

    renderFulfillmentSidePanel();
}

async function renderOrderFulfillmentView() {
    return fetchFulfillmentOrders();
}
