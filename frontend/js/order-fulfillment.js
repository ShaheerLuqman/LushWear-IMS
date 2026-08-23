// Order Fulfillment view - a bulk "select orders, pick a courier, fulfill" screen.
//
// Front-end only for now: orders are mock rows generated in-memory, and Fulfill/Edit/Remove
// actions mutate that local state and re-render instead of calling the API. Wire these up to
// real endpoints once the backend for this view exists.

const FULFILLMENT_TAGS = ['VIP', 'Repeat', 'New', 'Wholesale'];
const FULFILLMENT_CITIES = ['Lahore', 'Karachi', 'Faisalabad', 'Multan', 'Islamabad', 'Gujranwala', 'Rawalpindi', 'Sialkot'];

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

const FULFILLMENT_SEED_ROWS = [
    { name: 'Ayesha Khan', address: 'House 12, Street 5, Block B, DHA Phase 2', mobile: '0312-3456789', tags: ['VIP', 'Repeat'], city: 'Lahore' },
    { name: 'Fatima Ali', address: 'Flat 3, 2nd Floor, Building 7, Clifton', mobile: '0300-9876543', tags: ['New'], city: 'Karachi' },
    { name: 'Hina Malik', address: 'Street 10, House 45, Gulberg 3', mobile: '0321-1234567', tags: ['VIP', 'Wholesale'], city: 'Faisalabad' },
    { name: 'Zainab Raza', address: 'House 98, Street 2, Model Town', mobile: '0333-5556677', tags: ['New'], city: 'Multan' },
    { name: 'Sana Tariq', address: 'Apartment 15, 4th Floor, Emaar Tower', mobile: '0311-2223344', tags: ['Repeat', 'VIP'], city: 'Islamabad' },
    { name: 'Maria Ahmed', address: 'Street 8, House 22, Johar Town', mobile: '0309-8765432', tags: ['New'], city: 'Lahore' },
    { name: 'Nida Hussain', address: 'House 5, Lane 3, PECHS Block 6', mobile: '0322-4445566', tags: ['Wholesale'], city: 'Karachi' },
    { name: 'Iqra Bashir', address: 'Street 1, House 33, Wapda Town', mobile: '0315-1357911', tags: ['Repeat'], city: 'Gujranwala' }
];

const FULFILLMENT_EXTRA_NAMES = [
    'Mahnoor Sheikh', 'Bilal Aslam', 'Rabia Yousaf', 'Usman Ghani', 'Sadia Iqbal',
    'Hamza Farooq', 'Amna Siddiqui', 'Talha Rasheed', 'Areeba Nasir', 'Junaid Akhtar',
    'Laiba Zafar', 'Owais Malik', 'Sundas Riaz', 'Faizan Butt', 'Mehak Younis',
    'Adeel Hashmi', 'Noor Fatima', 'Kamran Shah', 'Zoya Mehmood', 'Salman Qureshi'
];

let fulfillmentOrders = [];
let fulfillmentSelectedIds = new Set();
let fulfillmentFilters = { city: '', cityMode: 'exclude', chipCities: [], tag: '', dateFrom: null, dateTo: null };
let fulfillmentPage = 1;
let fulfillmentPageSize = 10;
let fulfillmentDatePicker = null;
let fulfillmentOpenMenuOrderId = null; // tags or actions menu currently open, if any

function buildFulfillmentMockOrders() {
    const rows = FULFILLMENT_SEED_ROWS.map((seed, i) => ({ ...seed, addressLine2: '' }));
    FULFILLMENT_EXTRA_NAMES.forEach((name, i) => {
        const city = FULFILLMENT_CITIES[i % FULFILLMENT_CITIES.length];
        const tagCount = (i % 3) + 1;
        const tags = FULFILLMENT_TAGS.slice(0, tagCount).map((_, j) => FULFILLMENT_TAGS[(i + j) % FULFILLMENT_TAGS.length]);
        rows.push({
            name,
            address: `House ${10 + i}, Street ${(i % 12) + 1}, ${city} Town`,
            mobile: `03${10 + (i % 30)}-${1000000 + i * 137}`,
            tags: [...new Set(tags)],
            city
        });
    });
    return rows.map((row, i) => ({
        id: `fo-${i + 1}`,
        order_number: 1001 + i,
        name: row.name,
        address: row.address,
        mobile: row.mobile,
        tags: row.tags,
        city: row.city,
        order_date: new Date(Date.now() - (rows.length - i) * 86400000)
    }));
}

function initOrderFulfillment() {
    fulfillmentOrders = buildFulfillmentMockOrders();

    const cityFilterEl = document.getElementById('fulfillmentCityFilter');
    if (cityFilterEl) {
        cityFilterEl.innerHTML = '<option value="">All Cities</option>' + FULFILLMENT_CITIES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        cityFilterEl.addEventListener('change', () => {
            fulfillmentFilters.city = cityFilterEl.value;
            fulfillmentPage = 1;
            renderFulfillmentTable();
        });
    }

    const tagsFilterEl = document.getElementById('fulfillmentTagsFilter');
    if (tagsFilterEl) {
        tagsFilterEl.innerHTML = '<option value="">All Tags</option>' + FULFILLMENT_TAGS.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        tagsFilterEl.addEventListener('change', () => {
            fulfillmentFilters.tag = tagsFilterEl.value;
            fulfillmentPage = 1;
            renderFulfillmentTable();
        });
    }

    const cityModeEl = document.getElementById('fulfillmentCityMode');
    if (cityModeEl) {
        cityModeEl.addEventListener('change', () => {
            fulfillmentFilters.cityMode = cityModeEl.value;
            fulfillmentPage = 1;
            renderFulfillmentTable();
        });
    }

    const chipOptionsEl = document.getElementById('fulfillmentCityChipOptions');
    if (chipOptionsEl) {
        chipOptionsEl.innerHTML = FULFILLMENT_CITIES.map(c => `<option value="${escapeHtml(c)}">`).join('');
    }

    const chipInput = document.getElementById('fulfillmentCityChipInput');
    if (chipInput) {
        chipInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const val = chipInput.value.trim();
            if (val && FULFILLMENT_CITIES.includes(val) && !fulfillmentFilters.chipCities.includes(val)) {
                fulfillmentFilters.chipCities.push(val);
                fulfillmentPage = 1;
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
                    fulfillmentPage = 1;
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
        fulfillmentPage = 1;
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

    document.getElementById('fulfillmentPrevPageBtn')?.addEventListener('click', () => {
        if (fulfillmentPage > 1) {
            fulfillmentPage--;
            renderFulfillmentTable();
        }
    });
    document.getElementById('fulfillmentNextPageBtn')?.addEventListener('click', () => {
        const totalPages = Math.max(1, Math.ceil(getFulfillmentFilteredOrders().length / fulfillmentPageSize));
        if (fulfillmentPage < totalPages) {
            fulfillmentPage++;
            renderFulfillmentTable();
        }
    });
    document.getElementById('fulfillmentPageSize')?.addEventListener('change', (e) => {
        fulfillmentPageSize = parseInt(e.target.value, 10) || 10;
        fulfillmentPage = 1;
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
    document.getElementById('orderFulfillmentRefreshBtn')?.addEventListener('click', () => {
        renderOrderFulfillmentView();
        showToast('Refreshed', 'success');
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
            fulfillmentPage = 1;
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
    const filtered = getFulfillmentFilteredOrders();
    const start = (fulfillmentPage - 1) * fulfillmentPageSize;
    const pageRows = filtered.slice(start, start + fulfillmentPageSize);
    pageRows.forEach(o => {
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

function renderFulfillmentRow(order) {
    const checked = fulfillmentSelectedIds.has(order.id);
    const tagsHtml = order.tags.map(t => `<span class="fulfillment-tag-badge ${fulfillmentTagBadgeClass(t)}">${escapeHtml(t)}</span>`).join('');
    const tagsMenuOptions = FULFILLMENT_TAGS.map(t => `
        <label><input type="checkbox" data-tag-toggle="${escapeHtml(t)}" ${order.tags.includes(t) ? 'checked' : ''}> ${escapeHtml(t)}</label>
    `).join('');
    const cityOptions = FULFILLMENT_CITIES.map(c => `<option value="${escapeHtml(c)}" ${c === order.city ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');

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

function renderFulfillmentPagination(totalCount) {
    const totalPages = Math.max(1, Math.ceil(totalCount / fulfillmentPageSize));
    fulfillmentPage = Math.min(fulfillmentPage, totalPages);
    const start = totalCount === 0 ? 0 : (fulfillmentPage - 1) * fulfillmentPageSize + 1;
    const end = Math.min(fulfillmentPage * fulfillmentPageSize, totalCount);

    const label = document.getElementById('fulfillmentPaginationLabel');
    if (label) label.textContent = `Showing ${start} to ${end} of ${totalCount} orders`;

    const prevBtn = document.getElementById('fulfillmentPrevPageBtn');
    const nextBtn = document.getElementById('fulfillmentNextPageBtn');
    if (prevBtn) prevBtn.disabled = fulfillmentPage <= 1;
    if (nextBtn) nextBtn.disabled = fulfillmentPage >= totalPages;

    const pageNumbers = document.getElementById('fulfillmentPageNumbers');
    if (pageNumbers) {
        let html = '';
        for (let p = 1; p <= totalPages; p++) {
            html += `<button type="button" class="fulfillment-page-btn ${p === fulfillmentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }
        pageNumbers.innerHTML = html;
        pageNumbers.querySelectorAll('[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                fulfillmentPage = parseInt(btn.dataset.page, 10);
                renderFulfillmentTable();
            });
        });
    }
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

    const start = (fulfillmentPage - 1) * fulfillmentPageSize;
    const pageRows = filtered.slice(start, start + fulfillmentPageSize);

    const tbody = document.getElementById('fulfillmentTableBody');
    if (tbody) {
        tbody.innerHTML = pageRows.length
            ? pageRows.map(renderFulfillmentRow).join('')
            : '<tr><td colspan="8" class="empty-state">No orders match these filters.</td></tr>';
        attachFulfillmentRowHandlers(tbody);
        if (window.lucide) lucide.createIcons();
    }

    const allSelected = pageRows.length > 0 && pageRows.every(o => fulfillmentSelectedIds.has(o.id));
    const someSelected = !allSelected && pageRows.some(o => fulfillmentSelectedIds.has(o.id));
    [document.getElementById('fulfillmentHeaderCheckbox'), document.getElementById('fulfillmentSelectAll')].forEach(cb => {
        if (!cb) return;
        cb.checked = allSelected;
        cb.indeterminate = someSelected;
    });

    const selectedCountLabel = document.getElementById('fulfillmentSelectedCountLabel');
    if (selectedCountLabel) selectedCountLabel.textContent = `${fulfillmentSelectedIds.size} selected`;

    renderFulfillmentPagination(filtered.length);
    renderFulfillmentSidePanel();
}

function renderOrderFulfillmentView() {
    fulfillmentPage = 1;
    renderFulfillmentTable();
}
