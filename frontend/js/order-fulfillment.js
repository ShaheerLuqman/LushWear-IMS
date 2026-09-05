// Order Fulfillment view - a bulk "select orders, pick a courier, fulfill" screen.
//
// The order list (GET /orders/unfulfilled) and Fulfill (POST /orders/fulfill, which books
// real shipments with the courier) are both live. Editing a row's address/mobile/tags/city
// and the Duplicate/Remove actions still only mutate local state - those edits are NOT sent
// to the courier, which books from what is stored on the order.

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

// Order types each courier's booking API accepts, keyed by courier id. Mirrors
// postex.ORDER_TYPES on the backend; a courier absent here (Couriers Next included) has
// no equivalent field, so its Type cells render as a plain dash.
const FULFILLMENT_ORDER_TYPES = {
    postex: ['Normal', 'Reversed', 'Replacement']
};
const FULFILLMENT_DEFAULT_ORDER_TYPE = 'Normal';
// Pre-filled into the details modal's Remarks; the courier prints it on the airway
// bill. A Fragile handling pick adds a "- FRAGILE" bullet server-side (see _book_one_order).
const FULFILLMENT_DEFAULT_REMARK = '- THIS ORDER IS 100% CONFIRMED';

let fulfillmentOrders = [];
let fulfillmentLoading = false;
let fulfillmentAllCities = [];
let fulfillmentAllTags = [];
let fulfillmentSelectedIds = new Set();
// Snapshot of the orders in the current (or just-finished) fulfillment run, driving the
// Order Fulfillment progress screen - see renderFulfillmentProgress. Each entry carries
// the display fields the run needs plus its live outcome:
//   {id, order_number, name, city, courier,
//    state: 'pending' | 'booking' | 'ok' | 'fail', tracking_number, error}
let fulfillmentProgressOrders = [];
let fulfillmentProgressPhase = 'idle'; // 'idle' | 'booking' | 'shopify_sync' | 'done'
// cities/tags are null while nothing narrows them (every value ticked), which reads as "no filter".
let fulfillmentFilters = { cities: null, tags: null, dateFrom: null, dateTo: null };

// Multi-select checkbox filters (grid-filters.js) replacing the old single-select dropdowns.
let fulfillmentCityFilterControl = null;
let fulfillmentTagsFilterControl = null;
let fulfillmentDatePicker = null;
let fulfillmentSelectedCourier = null; // the courier picked in the side panel, or null
let fulfillmentFulfilling = false; // a booking request is in flight - guards against double-submit
let fulfillmentPickupAddresses = []; // warehouses the picked courier can collect from
let fulfillmentCourierCities = []; // cities the currently-picked courier supports; empty until one is picked
let fulfillmentCourierCitiesLoading = false;
// The open courier-city dropdown's own closer, if one is open - that panel lives in
// document.body (so it can escape the table's overflow:auto clipping), not inside the row
// it belongs to, so re-rendering the table (tbody.innerHTML = ...) destroys the row's button
// without it. Closed explicitly before every re-render so it can never get orphaned on screen.
let fulfillmentOpenCourierCityCloser = null;

/** The picked courier's order types, or [] for one whose API has no such field. */
function fulfillmentOrderTypes() {
    return (fulfillmentSelectedCourier && FULFILLMENT_ORDER_TYPES[fulfillmentSelectedCourier.id]) || [];
}

/** Pre-fills each order's courier city with the customer-entered one when the courier
 * actually serves a city of that name, so only the genuine mismatches ("DHA Phase 5",
 * a misspelling, a city the courier doesn't cover) are left to pick by hand.
 *
 * Matched case- and whitespace-insensitively, since the customer types their city
 * freehand while the courier's list is canonically cased ("lahore" vs "Lahore"). The
 * courier's own spelling is what gets stored, not the customer's - it is what the
 * booking has to send. Never overwrites a city already picked. */
function autoSelectFulfillmentCourierCities() {
    if (fulfillmentCourierCities.length === 0) return;
    const byNormalizedName = new Map(fulfillmentCourierCities.map(c => [c.trim().toLowerCase(), c]));
    fulfillmentOrders.forEach(o => {
        if (o.courierCity) return;
        o.courierCity = byNormalizedName.get((o.city || '').trim().toLowerCase()) || null;
    });
}

/** Loads the pickup identities this org can dispatch under and renders the picker.
 *
 * Neither bookable courier accepts an order without one: PostEx refuses a booking that
 * names no pickup address ("BOTH PICKUP ADDRESS CODE AND STORE ADDRESS CODE MUST NOT BE
 * NULL AT THE SAME TIME"), despite its own guide marking the field optional, and Couriers
 * Next needs the shipper profile the parcel ships under. Both come back in the same
 * {code,label,city,address} shape, so this has to resolve before any booking can go
 * through, but does not care which courier it is resolving for. */
async function loadFulfillmentPickupAddresses(courierId) {
    fulfillmentPickupAddresses = [];
    renderFulfillmentPickupAddresses();
    try {
        const result = await apiJson(`/orders/courier-pickup-addresses?courier=${encodeURIComponent(courierId)}`, {
            fallback: 'Failed to fetch pickup addresses'
        });
        fulfillmentPickupAddresses = result.addresses || [];
    } catch (error) {
        console.error('Error loading pickup addresses:', error);
        showToast(error.message || 'Failed to fetch pickup addresses', 'error');
        fulfillmentPickupAddresses = [];
    }
    renderFulfillmentPickupAddresses();
}

/** One pickup option's text. Leads with the street address, since PostEx's own label is
 * a generic address *type* ("Pickup Address") that reads identically for every warehouse
 * a merchant has - the address is the only part that tells them apart. Falls back to the
 * label when a courier returns no address, and keeps the city for the ones whose address
 * doesn't already name it. */
function fulfillmentPickupAddressLabel(a) {
    const address = (a.address || '').trim();
    if (!address) return [a.label, a.city].filter(Boolean).join(' - ');
    const city = (a.city || '').trim();
    const hasCity = city && address.toLowerCase().includes(city.toLowerCase());
    return hasCity || !city ? address : `${address}, ${city}`;
}

function renderFulfillmentPickupAddresses() {
    const select = document.getElementById('fulfillmentPickupSelect');
    if (!select) return;

    // Disabled (rather than hidden) until a courier with pickup identities is picked -
    // the picker is meaningless for couriers still fulfilled in their own portal.
    select.disabled = fulfillmentPickupAddresses.length === 0;
    const previous = select.value;
    select.innerHTML = fulfillmentPickupAddresses.length
        ? fulfillmentPickupAddresses
            .map(a => `<option value="${escapeHtml(a.code)}" title="${escapeHtml(fulfillmentPickupAddressLabel(a))}">${escapeHtml(fulfillmentPickupAddressLabel(a))}</option>`)
            .join('')
        : `<option value="">Select courier first</option>`;
    if (fulfillmentPickupAddresses.some(a => a.code === previous)) {
        select.value = previous;
    } else {
        // Both couriers flag one pickup identity as their own default (PostEx's
        // addressType "Default Address", Couriers Next's is_default "1" - see
        // postex.fetch_pickup_addresses and couriers_next.fetch_shippers) - pre-select
        // it instead of leaving whichever one the browser puts first, which is just
        // API response order.
        const defaultAddress = fulfillmentPickupAddresses.find(a => a.is_default);
        if (defaultAddress) select.value = defaultAddress.code;
    }
    // The side panel is only 300px wide, so a full street address truncates hard once
    // picked and the dropdown closes - the option's own title stops being reachable then.
    // Mirroring it onto the closed <select> keeps the full address a hover away.
    select.title = select.selectedOptions[0]?.title || '';
    updateFulfillmentFulfillBtnState();
}

/** Fetches the supported-city list for the courier just picked in the side panel
 * (PostEx/Couriers Next only - see backend GET /orders/courier-cities) and clears
 * any previously-picked courier city, since it may not be valid for the new courier. */
async function loadFulfillmentCourierCities(courierId) {
    fulfillmentCourierCitiesLoading = true;
    fulfillmentCourierCities = [];
    // Both are courier-specific: a city the previous courier served may not exist for
    // this one, and so may an order type.
    fulfillmentOrders.forEach(o => {
        o.courierCity = null;
        o.orderType = FULFILLMENT_DEFAULT_ORDER_TYPE;
    });
    renderFulfillmentTable();
    try {
        const result = await apiJson(`/orders/courier-cities?courier=${encodeURIComponent(courierId)}`, {
            fallback: 'Failed to fetch supported cities'
        });
        fulfillmentCourierCities = result.cities || [];
        autoSelectFulfillmentCourierCities();
    } catch (error) {
        console.error('Error loading courier cities:', error);
        showToast(error.message || 'Failed to fetch supported cities', 'error');
        fulfillmentCourierCities = [];
    } finally {
        fulfillmentCourierCitiesLoading = false;
        renderFulfillmentTable();
    }
}

// Cap on rendered options in the courier-city search dropdown at once - the list can run to
// 1000+ cities, and building that many DOM nodes on every keystroke is real, felt latency
// (this is what made switching couriers slow, not the fetch itself). Narrows as you type.
const FULFILLMENT_COURIER_CITY_MAX_OPTIONS = 100;

/** Floating searchable dropdown for one row's courier-city field - same DOM/CSS pattern
 * (.folio-dropdown-panel/-search/-options/-option) as the Transactions grid's ledger picker
 * (createFolioCellRenderer in orders-grid.js), reused here instead of a native <select> or
 * <datalist> since either would mean duplicating a 1000+-city list once per visible row. */
function createFulfillmentCourierCityDropdown(order) {
    const hasCities = fulfillmentCourierCities.length > 0;
    const placeholder = fulfillmentCourierCitiesLoading ? 'Loading…' : (hasCities ? 'Select city' : '—');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'folio-dropdown-btn fulfillment-courier-city-btn';
    button.disabled = !hasCities;
    button.innerHTML = `<span class="folio-dropdown-text">${escapeHtml(order.courierCity || placeholder)}</span><span class="folio-dropdown-arrow">▼</span>`;

    let dropdownPanel = null;
    let isOpen = false;

    function closeDropdown() {
        if (dropdownPanel && dropdownPanel.parentNode) dropdownPanel.parentNode.removeChild(dropdownPanel);
        dropdownPanel = null;
        isOpen = false;
        button.classList.remove('open');
        if (fulfillmentOpenCourierCityCloser === closeDropdown) fulfillmentOpenCourierCityCloser = null;
    }

    function selectOption(city) {
        order.courierCity = city || null;
        button.querySelector('.folio-dropdown-text').textContent = city || placeholder;
        closeDropdown();
        updateFulfillmentFulfillBtnState();
    }

    function renderOptions(optionsList, filter) {
        const filterLower = filter.trim().toLowerCase();
        const filtered = filterLower
            ? fulfillmentCourierCities.filter(c => c.toLowerCase().includes(filterLower))
            : fulfillmentCourierCities;

        optionsList.innerHTML = '';
        filtered.slice(0, FULFILLMENT_COURIER_CITY_MAX_OPTIONS).forEach(c => {
            const option = document.createElement('div');
            option.className = 'folio-dropdown-option' + (c === order.courierCity ? ' selected' : '');
            option.textContent = c;
            option.addEventListener('click', () => selectOption(c));
            optionsList.appendChild(option);
        });

        if (filtered.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'folio-dropdown-empty';
            noResults.textContent = 'No cities found';
            optionsList.appendChild(noResults);
        } else if (filtered.length > FULFILLMENT_COURIER_CITY_MAX_OPTIONS) {
            const more = document.createElement('div');
            more.className = 'folio-dropdown-empty';
            more.textContent = `${filtered.length - FULFILLMENT_COURIER_CITY_MAX_OPTIONS} more - keep typing to narrow down`;
            optionsList.appendChild(more);
        }
    }

    function openDropdown() {
        if (isOpen || !hasCities) return;
        // Only one of these floats in document.body at a time - close whichever other
        // row's is currently open first (it wouldn't close on its own; see the flag's
        // own comment above).
        if (fulfillmentOpenCourierCityCloser) fulfillmentOpenCourierCityCloser();
        isOpen = true;
        fulfillmentOpenCourierCityCloser = closeDropdown;
        button.classList.add('open');

        dropdownPanel = document.createElement('div');
        dropdownPanel.className = 'folio-dropdown-panel';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'folio-dropdown-search';
        searchInput.placeholder = 'Search cities...';
        dropdownPanel.appendChild(searchInput);

        const optionsList = document.createElement('div');
        optionsList.className = 'folio-dropdown-options';
        dropdownPanel.appendChild(optionsList);
        renderOptions(optionsList, '');

        document.body.appendChild(dropdownPanel);
        const rect = button.getBoundingClientRect();
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.minWidth = Math.max(rect.width, 200) + 'px';
        // Flip above the button when a row near the bottom of the viewport wouldn't
        // leave room for the panel below it.
        const panelHeight = dropdownPanel.offsetHeight;
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < panelHeight + 2 && rect.top > spaceBelow) {
            dropdownPanel.style.top = Math.max(2, rect.top - panelHeight - 2) + 'px';
        } else {
            dropdownPanel.style.top = (rect.bottom + 2) + 'px';
        }

        searchInput.addEventListener('input', (e) => renderOptions(optionsList, e.target.value));
        searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });
        setTimeout(() => searchInput.focus(), 0);

        const closeHandler = (e) => {
            if (!dropdownPanel.contains(e.target) && !button.contains(e.target)) {
                closeDropdown();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen) closeDropdown(); else openDropdown();
    });

    return button;
}

/** Fetch the real unfulfilled-orders list and refresh the filter option lists derived from it. */
async function fetchFulfillmentOrders() {
    fulfillmentLoading = true;
    renderFulfillmentTable();
    let ok = true;
    try {
        const rows = await apiJson('/orders/unfulfilled', { fallback: 'Failed to fetch unfulfilled orders' });
        // courierCity is picked in the UI and lives nowhere on the server, so it has to be
        // carried across a refresh by hand - otherwise refreshing (or the reload after a
        // partial fulfillment) silently blanks every picked city while the courier still
        // reads as selected.
        const courierCityByOrderId = new Map(fulfillmentOrders.filter(o => o.courierCity).map(o => [o.id, o.courierCity]));
        const orderTypeByOrderId = new Map(fulfillmentOrders.map(o => [o.id, o.orderType]));
        // Shipping-details fields (row kebab / CoD cell) live only in the UI too, so
        // they are carried across a refresh the same way. CoD defaults to the order
        // total less any advance paid - what the rider collects; Pieces to the summed
        // line-item quantity; Invoice Division to 1 (PostEx's own default).
        const detailsByOrderId = new Map(fulfillmentOrders.map(o => [o.id,
            { codAmount: o.codAmount, email: o.email, instructions: o.instructions, pieces: o.pieces, invoiceDivision: o.invoiceDivision, handling: o.handling }]));
        fulfillmentOrders = rows.map(o => {
            const carried = detailsByOrderId.get(o.id) || {};
            return {
                ...o,
                order_date: new Date(o.order_date),
                courierCity: courierCityByOrderId.get(o.id) || null,
                orderType: orderTypeByOrderId.get(o.id) || FULFILLMENT_DEFAULT_ORDER_TYPE,
                codAmount: carried.codAmount != null ? carried.codAmount : Math.max(0, (o.total_amount || 0) - (o.advance_amount || 0)),
                email: carried.email || '',
                instructions: carried.instructions != null ? carried.instructions : FULFILLMENT_DEFAULT_REMARK,
                pieces: carried.pieces != null ? carried.pieces : (fulfillmentLineItemCount(o.line_items) || 1),
                invoiceDivision: carried.invoiceDivision != null ? carried.invoiceDivision : 1,
                handling: carried.handling || 'Standard',
            };
        });
        // Orders that arrived in this refresh have no picked city yet - fill in the ones
        // whose city the already-picked courier recognises.
        autoSelectFulfillmentCourierCities();
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

    fulfillmentCityFilterControl?.refresh();
    fulfillmentTagsFilterControl?.refresh();
}

function initOrderFulfillment() {
    fulfillmentCityFilterControl = createCheckboxFilterControl('fulfillmentCityFilter', {
        allLabel: 'All Cities',
        getValues: () => fulfillmentAllCities,
        onChange: (selected) => {
            fulfillmentFilters.cities = selected.length === fulfillmentAllCities.length ? null : selected;
            renderFulfillmentTable();
        }
    });

    fulfillmentTagsFilterControl = createCheckboxFilterControl('fulfillmentTagsFilter', {
        allLabel: 'All Tags',
        getValues: () => fulfillmentAllTags,
        onChange: (selected) => {
            fulfillmentFilters.tags = selected.length === fulfillmentAllTags.length ? null : selected;
            renderFulfillmentTable();
        }
    });

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
        fulfillmentFilters = { cities: null, tags: null, dateFrom: null, dateTo: null };
        fulfillmentCityFilterControl?.reset();
        fulfillmentTagsFilterControl?.reset();
        if (fulfillmentDatePicker) fulfillmentDatePicker.clear();
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

    // Keeps the closed select's own tooltip in sync when the user changes it by hand -
    // renderFulfillmentPickupAddresses only sets it on (re)populate, not on selection.
    document.getElementById('fulfillmentPickupSelect')?.addEventListener('change', (e) => {
        e.target.title = e.target.selectedOptions[0]?.title || '';
        updateFulfillmentFulfillBtnState();
    });

    document.getElementById('fulfillmentCancelSelectionBtn')?.addEventListener('click', () => {
        fulfillmentSelectedIds.clear();
        renderFulfillmentTable();
    });

    document.getElementById('fulfillmentFulfillBtn')?.addEventListener('click', fulfillSelectedOrders);
    document.getElementById('fulfillmentProgressPrintBtn')?.addEventListener('click', async () => {
        try {
            await printAirwayBillsForOrders(fulfillmentProgressOrders);
        } catch (error) {
            showToast(error.message || 'Failed to print airway bills', 'error');
        }
    });
    document.getElementById('fulfillmentProgressDoneBtn')?.addEventListener('click', () => switchView('orderFulfillment'));

    document.getElementById('orderFulfillmentExportBtn')?.addEventListener('click', () => {
        showToast('Export not implemented yet', 'info', { silent: true });
    });
    document.getElementById('orderFulfillmentRefreshBtn')?.addEventListener('click', async () => {
        if (await renderOrderFulfillmentView()) showToast('Refreshed', 'success');
    });

    document.addEventListener('click', () => {
        closeFulfillmentOpenMenus();
        document.getElementById('fulfillmentCourierMenu')?.classList.remove('open');
    });

    renderFulfillmentCourierMenu();
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
            fulfillmentSelectedCourier = courier;
            if (!courier) return;
            const labelEl = document.getElementById('fulfillmentCourierSelectLabel');
            const icon = courier.logo
                ? `<span class="fulfillment-courier-logo-chip"><img src="${courier.logo}" alt="${escapeHtml(courier.name)}"></span>`
                : `<span class="fulfillment-courier-monogram" style="background:${courier.color}">${escapeHtml(courier.monogram)}</span>`;
            if (labelEl) labelEl.innerHTML = `${icon}${escapeHtml(courier.name)}`;
            menu.classList.remove('open');
            loadFulfillmentCourierCities(courier.id);
            loadFulfillmentPickupAddresses(courier.id);
        });
    });
}

function closeFulfillmentOpenMenus() {
    document.querySelectorAll('.fulfillment-tags-menu.open').forEach(el => el.classList.remove('open'));
}

/** "1 x Ruby Camisole Set L", dropping the size for a product with no variants
 * ("-"). Matches the backend's _order_detail_string label. */
function fulfillmentLineItemLabel(li) {
    const size = (li.variant_title || '').trim();
    const name = li.name || '';
    return size && size !== '-' ? `${name} ${size}` : name;
}

function fulfillmentLineItemCount(lineItems) {
    return (lineItems || []).reduce((sum, li) => sum + (parseInt(li.qty, 10) || 0), 0);
}

/** The bracketed contents string PostEx/Couriers Next print on the airway bill -
 * mirrors the backend's _order_detail_string so the modal shows what will be sent. */
function fulfillmentOrderDetailString(lineItems) {
    return (lineItems || [])
        .filter(li => li.name)
        .map(li => `[ ${li.qty} x ${fulfillmentLineItemLabel(li)} ]`)
        .join(' ');
}

/** Per-order shipping details, opened from the row's kebab - the same fields
 * PostEx's own booking screen has. Fields PostEx has but Couriers Next lacks
 * ([data-postex-only]) are hidden when that courier is picked. Edits are written
 * straight onto the order object (browser memory, like courierCity/orderType) and
 * sent with POST /orders/fulfill, so Save just repaints the row. */
function openFulfillmentDetailsModal(order) {
    const modal = document.getElementById('fulfillmentDetailsModal');
    const form = document.getElementById('fulfillmentDetailsForm');
    const emailInput = document.getElementById('fulfillmentDetailsEmail');
    const instructionsInput = document.getElementById('fulfillmentDetailsInstructions');
    const instructionsLabel = document.getElementById('fulfillmentDetailsInstructionsLabel');
    const handlingSelect = document.getElementById('fulfillmentDetailsHandling');
    const piecesInput = document.getElementById('fulfillmentDetailsPieces');
    const invoiceDivisionInput = document.getElementById('fulfillmentDetailsInvoiceDivision');
    const pickupInput = document.getElementById('fulfillmentDetailsPickup');
    const productsEl = document.getElementById('fulfillmentDetailsProducts');
    const productStringEl = document.getElementById('fulfillmentDetailsProductString');
    const subtitle = document.getElementById('fulfillmentDetailsSubtitle');
    const cancelBtn = document.getElementById('fulfillmentDetailsCancelBtn');
    const closeBtn = document.getElementById('fulfillmentDetailsClose');
    if (!modal || !form) return;

    const isCouriersNext = fulfillmentSelectedCourier?.id === 'couriers_next';
    modal.querySelectorAll('[data-postex-only]').forEach(el => { el.hidden = isCouriersNext; });
    instructionsLabel.textContent = isCouriersNext ? 'Special Instructions' : 'Remarks';

    const pickupSelect = document.getElementById('fulfillmentPickupSelect');
    pickupInput.value = (pickupSelect && !pickupSelect.disabled && pickupSelect.selectedOptions[0]?.textContent) || '—';

    const lineItems = order.line_items || [];
    productsEl.innerHTML = lineItems.length
        ? lineItems.map(li => `<li>${escapeHtml(String(li.qty))} &times; ${escapeHtml(fulfillmentLineItemLabel(li))}</li>`).join('')
        : '<li class="fulfillment-details-empty">No products on this order</li>';
    productStringEl.value = fulfillmentOrderDetailString(lineItems);

    subtitle.textContent = `Order #${order.order_number} · ${order.name}`;
    emailInput.value = order.email || '';
    instructionsInput.value = order.instructions || '';
    handlingSelect.value = order.handling || 'Standard';
    piecesInput.value = order.pieces ?? 1;
    invoiceDivisionInput.value = order.invoiceDivision ?? 1;
    // Show the "- FRAGILE" bullet live while the modal is open; the backend also
    // adds it at send time (idempotently) for any booking that skips this modal.
    syncFragileLine();
    modal.classList.add('active');
    setTimeout(() => emailInput.focus(), 0);

    function syncFragileLine() {
        const lines = instructionsInput.value.split('\n').filter(l => l.trim().toUpperCase() !== '- FRAGILE');
        if (handlingSelect.value === 'Fragile') {
            while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
            lines.push('- FRAGILE');
        }
        instructionsInput.value = lines.join('\n');
    }

    const close = () => {
        modal.classList.remove('active');
        form.removeEventListener('submit', onSubmit);
        handlingSelect.removeEventListener('change', syncFragileLine);
        cancelBtn.removeEventListener('click', close);
        closeBtn.removeEventListener('click', close);
        modal.removeEventListener('click', onBackdrop);
    };
    const onSubmit = (e) => {
        e.preventDefault();
        order.email = emailInput.value.trim();
        order.instructions = instructionsInput.value.trim();
        order.handling = handlingSelect.value;
        order.pieces = Math.max(1, parseInt(piecesInput.value, 10) || 1);
        order.invoiceDivision = Math.max(1, parseInt(invoiceDivisionInput.value, 10) || 1);
        close();
        renderFulfillmentTable();
    };
    const onBackdrop = (e) => { if (e.target === modal) close(); };

    form.addEventListener('submit', onSubmit);
    handlingSelect.addEventListener('change', syncFragileLine);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', onBackdrop);
}

function getFulfillmentFilteredOrders() {
    return fulfillmentOrders.filter(o => {
        if (fulfillmentFilters.cities && !fulfillmentFilters.cities.includes(o.city)) return false;
        if (fulfillmentFilters.tags && !fulfillmentFilters.tags.some((t) => o.tags.includes(t))) return false;
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

/** The order's courier order type, as a picker for couriers that have the field
 * (PostEx) and a plain dash for the ones that don't - and before a courier is picked
 * at all, since which types exist is the courier's own business. */
function renderFulfillmentOrderTypeCell(order) {
    const types = fulfillmentOrderTypes();
    if (types.length === 0) return '<span class="fulfillment-order-type-none">—</span>';
    return `<select class="fulfillment-order-type-select" data-order-type-select>
        ${types.map(t => `<option value="${escapeHtml(t)}" ${t === order.orderType ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
    </select>`;
}

function renderFulfillmentRow(order) {
    const checked = fulfillmentSelectedIds.has(order.id);
    const tagsHtml = order.tags.map(t => `<span class="fulfillment-tag-badge ${fulfillmentTagBadgeClass(t)}">${escapeHtml(t)}</span>`).join('');
    const tagsMenuOptions = fulfillmentAllTags.map(t => `
        <label><input type="checkbox" data-tag-toggle="${escapeHtml(t)}" ${order.tags.includes(t) ? 'checked' : ''}> ${escapeHtml(t)}</label>
    `).join('');
    return `
        <tr data-order-id="${order.id}" class="${checked ? 'fulfillment-row--selected' : ''}">
            <td class="fulfillment-col-check"><input type="checkbox" class="fulfillment-row-checkbox" ${checked ? 'checked' : ''}></td>
            <td class="fulfillment-col-orderid"><span class="fulfillment-order-id">#${order.order_number}</span></td>
            <td class="fulfillment-col-name" title="${escapeHtml(order.name)}">${escapeHtml(order.name)}</td>
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
            <td class="fulfillment-city-fixed" title="Entered by the customer">${escapeHtml(order.city)}</td>
            <td class="fulfillment-courier-city-cell" data-courier-city-cell></td>
            <td class="fulfillment-order-type-cell">${renderFulfillmentOrderTypeCell(order)}</td>
            <td class="fulfillment-col-cod">
                <input type="number" class="fulfillment-cod-input" min="0" step="0.01" value="${escapeHtml(String(order.codAmount ?? 0))}">
            </td>
            <td class="fulfillment-risk-cell">${renderFulfillmentRiskCell(order)}</td>
            <td class="fulfillment-actions-cell">
                <button type="button" class="fulfillment-kebab-btn" data-actions-toggle title="Shipping details">&#8942;</button>
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

        const courierCityCell = tr.querySelector('[data-courier-city-cell]');
        if (courierCityCell) courierCityCell.appendChild(createFulfillmentCourierCityDropdown(order));

        // No re-render: the <select>/<input> already shows the new value, and redrawing
        // the table would close the row's menus for nothing.
        tr.querySelector('[data-order-type-select]')?.addEventListener('change', (e) => {
            order.orderType = e.target.value;
        });
        tr.querySelector('.fulfillment-cod-input')?.addEventListener('change', (e) => {
            order.codAmount = Math.max(0, parseFloat(e.target.value) || 0);
            e.target.value = String(order.codAmount);
        });

        tr.querySelector('[data-actions-toggle]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openFulfillmentDetailsModal(order);
        });
    });
}

/** Books every selected order with the picked courier via POST /orders/fulfill, streaming
 * the result onto the Order Fulfillment progress screen row by row.
 *
 * Confirms first: unlike everything else on this screen, this creates real shipments the
 * courier will come and collect, so an accidental click must not dispatch a table full of
 * parcels. The backend books orders one at a time and reports each outcome as it lands, so
 * a partial success is the normal case to render, not an edge case - successfully booked
 * orders are dropped from the underlying list, the failures keep their reason on screen. */
async function fulfillSelectedOrders() {
    if (fulfillmentFulfilling) return;
    if (!fulfillmentSelectedCourier) {
        showToast('Select a courier first', 'error', { silent: true });
        return;
    }

    const selectedOrders = fulfillmentOrders.filter(o => fulfillmentSelectedIds.has(o.id));
    if (selectedOrders.length === 0) {
        showToast('Select at least one order', 'error', { silent: true });
        return;
    }

    const pickupAddressCode = document.getElementById('fulfillmentPickupSelect')?.value;
    if (!pickupAddressCode) {
        showToast(
            fulfillmentPickupAddresses.length === 0
                ? 'No pickup location is configured for this courier - add one in the courier portal first'
                : 'Select a pickup location first',
            'error',
            { silent: true }
        );
        return;
    }

    // The courier books to its own city list, not the customer-entered one, so a row
    // without a courier city picked cannot be sent.
    const missingCity = selectedOrders.filter(o => !o.courierCity);
    if (missingCity.length > 0) {
        showToast(
            `Pick a courier city for ${missingCity.length === 1 ? `order #${missingCity[0].order_number}` : `${missingCity.length} orders`} first`,
            'error',
            { silent: true }
        );
        return;
    }

    const pickup = fulfillmentPickupAddresses.find(a => a.code === pickupAddressCode);
    const confirmed = await showAppConfirm({
        title: 'Fulfill Orders',
        message:
            `Book ${selectedOrders.length} order(s) with ${fulfillmentSelectedCourier.name}?\n\n` +
            `Pickup from: ${pickup ? fulfillmentPickupAddressLabel(pickup) : pickupAddressCode}\n\n` +
            `This creates real shipments the courier will collect, and marks the orders fulfilled in Shopify.`,
        confirmText: 'Fulfill'
    });
    if (!confirmed) return;

    // Snapshot the display fields now - a booked order is dropped from fulfillmentOrders
    // as its result lands, so its name/city would be gone by the next progress re-render.
    fulfillmentProgressOrders = selectedOrders.map(o => ({
        id: o.id,
        order_number: o.order_number,
        name: o.name,
        city: o.city,
        courier: fulfillmentSelectedCourier.name,
        state: 'pending',
        tracking_number: null,
        error: null,
    }));
    fulfillmentProgressOrders[0].state = 'booking';
    fulfillmentProgressPhase = 'booking';
    fulfillmentFulfilling = true;
    switchView('orderFulfillmentProgress');
    renderFulfillmentProgress();

    const courierName = fulfillmentSelectedCourier.name;
    try {
        for await (const event of apiJsonStream('/orders/fulfill', {
            body: {
                courier: fulfillmentSelectedCourier.id,
                pickup_address_code: pickupAddressCode,
                orders: selectedOrders.map(o => ({
                    order_id: o.id,
                    courier_city: o.courierCity,
                    order_type: o.orderType,
                    cod_amount: o.codAmount,
                    customer_email: o.email || null,
                    instructions: o.instructions || null,
                    pieces: o.pieces,
                    invoice_division: o.invoiceDivision,
                    handling: o.handling,
                })),
            },
            fallback: 'Failed to fulfill orders',
        })) {
            if (event.type === 'order') applyFulfillmentProgressResult(event.result);
            else if (event.type === 'shopify_sync') fulfillmentProgressPhase = 'shopify_sync';
            renderFulfillmentProgress();
        }
    } catch (error) {
        console.error('Error fulfilling orders:', error);
        showToast(error.message || 'Failed to fulfill orders', 'error');
        // The connection dropped mid-run - anything not yet resolved never got a booking.
        fulfillmentProgressOrders.forEach(o => {
            if (o.state === 'pending' || o.state === 'booking') {
                o.state = 'fail';
                o.error = o.error || 'Fulfillment interrupted - not booked';
            }
        });
    } finally {
        fulfillmentFulfilling = false;
        fulfillmentProgressPhase = 'done';
        renderFulfillmentProgress();
    }

    const booked = fulfillmentProgressOrders.filter(o => o.state === 'ok').length;
    const failed = fulfillmentProgressOrders.filter(o => o.state === 'fail').length;
    showToast(
        failed === 0
            ? `Booked ${booked} order(s) with ${courierName}`
            : `Booked ${booked}, failed ${failed}`,
        failed === 0 ? 'success' : (booked > 0 ? 'info' : 'error')
    );
}

/** Fold one streamed booking outcome into the progress list, drop a booked order from the
 * working set, and move the next still-pending row to "booking". */
function applyFulfillmentProgressResult(result) {
    const entry = fulfillmentProgressOrders.find(o => o.id === result.order_id);
    if (entry) {
        entry.state = result.ok ? 'ok' : 'fail';
        entry.tracking_number = result.tracking_number || null;
        entry.error = result.error || null;
    }
    if (result.ok) {
        fulfillmentOrders = fulfillmentOrders.filter(o => o.id !== result.order_id);
        fulfillmentSelectedIds.delete(result.order_id);
    }
    const next = fulfillmentProgressOrders.find(o => o.state === 'pending');
    if (next) next.state = 'booking';
}

const FULFILLMENT_PROGRESS_STATE_META = {
    pending: { badge: 'Pending', icon: 'circle' },
    booking: { badge: 'Booking…', icon: 'loader' },
    ok: { badge: 'Fulfilled', icon: 'check-circle-2' },
    fail: { badge: 'Failed', icon: 'x-circle' },
};

function renderFulfillmentProgressRow(o) {
    const meta = FULFILLMENT_PROGRESS_STATE_META[o.state] || FULFILLMENT_PROGRESS_STATE_META.pending;
    const detail = o.state === 'fail'
        ? `<span class="fulfillment-progress-row-error" title="${escapeHtml(o.error || 'Failed')}">${escapeHtml(o.error || 'Failed')}</span>`
        : o.tracking_number
            ? `<span class="fulfillment-progress-row-tracking">${escapeHtml(o.tracking_number)}</span>`
            : '';
    const awbBtn = orderHasAirwayBill(o)
        ? `<button type="button" class="fulfillment-progress-awb-btn" data-awb-order-id="${escapeHtml(o.id)}"><i data-lucide="file-down"></i> Airway Bill</button>`
        : '';
    return `
        <div class="fulfillment-progress-row" data-state="${o.state}">
            <span class="fulfillment-progress-row-icon"><i data-lucide="${meta.icon}"></i></span>
            <div class="fulfillment-progress-row-main">
                <span class="fulfillment-progress-row-order">#${escapeHtml(String(o.order_number))}</span>
                <span class="fulfillment-progress-row-sub">${escapeHtml([o.name, o.city].filter(Boolean).join(' · '))}</span>
            </div>
            <div class="fulfillment-progress-row-status">
                <span class="fulfillment-progress-badge fulfillment-progress-badge--${o.state}">${meta.badge}</span>
                ${detail}
            </div>
            ${awbBtn}
        </div>
    `;
}

/** Paints the whole progress screen from fulfillmentProgressOrders + fulfillmentProgressPhase. */
function renderFulfillmentProgress() {
    const total = fulfillmentProgressOrders.length;
    const ok = fulfillmentProgressOrders.filter(o => o.state === 'ok').length;
    const failed = fulfillmentProgressOrders.filter(o => o.state === 'fail').length;
    const done = fulfillmentProgressPhase === 'done';

    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    setText('fulfillmentProgressTotal', total);
    setText('fulfillmentProgressCompleted', ok);
    setText('fulfillmentProgressFailed', failed);
    setText('fulfillmentProgressRemaining', total - ok - failed);
    setText('fulfillmentProgressCourier', fulfillmentProgressOrders[0] ? `via ${fulfillmentProgressOrders[0].courier}` : '');

    const pill = document.getElementById('fulfillmentProgressStatusPill');
    if (pill) {
        pill.textContent = fulfillmentProgressPhase === 'shopify_sync' ? 'Updating Shopify…'
            : done ? (failed ? 'Completed with errors' : 'Fulfillment complete')
            : 'Live fulfillment in progress';
        pill.classList.toggle('fulfillment-progress-pill--live', !done);
        pill.classList.toggle('fulfillment-progress-pill--done', done && failed === 0);
        pill.classList.toggle('fulfillment-progress-pill--warn', done && failed > 0);
    }

    const fill = document.getElementById('fulfillmentProgressBarFill');
    if (fill) fill.style.width = total ? `${Math.round(((ok + failed) / total) * 100)}%` : '0%';

    const list = document.getElementById('fulfillmentProgressList');
    if (list) {
        list.innerHTML = fulfillmentProgressOrders.map(renderFulfillmentProgressRow).join('');
        list.querySelectorAll('[data-awb-order-id]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const entry = fulfillmentProgressOrders.find(o => o.id === btn.dataset.awbOrderId);
                if (!entry) return;
                try {
                    await printAirwayBillsForOrders([entry]);
                } catch (error) {
                    showToast(error.message || 'Failed to print airway bill', 'error');
                }
            });
        });
    }

    const printBtn = document.getElementById('fulfillmentProgressPrintBtn');
    if (printBtn) printBtn.disabled = !fulfillmentProgressOrders.some(orderHasAirwayBill);
    const doneBtn = document.getElementById('fulfillmentProgressDoneBtn');
    if (doneBtn) doneBtn.disabled = !done;

    if (window.lucide) lucide.createIcons();
}

/** Fulfill stays disabled until every input POST /orders/fulfill needs is set: a courier,
 * a pickup identity, at least one selected order, and a courier city on every one of them.
 * Mirrors the guard checks in fulfillSelectedOrders so the button never offers an action
 * that would only toast an error, and its title spells out what is still missing. */
function updateFulfillmentFulfillBtnState() {
    const btn = document.getElementById('fulfillmentFulfillBtn');
    if (!btn) return;
    const selectedOrders = fulfillmentOrders.filter(o => fulfillmentSelectedIds.has(o.id));
    const missingCity = selectedOrders.filter(o => !o.courierCity);
    let reason = '';
    if (fulfillmentFulfilling) reason = 'Booking in progress…';
    else if (!fulfillmentSelectedCourier) reason = 'Select a courier first';
    else if (!document.getElementById('fulfillmentPickupSelect')?.value) reason = 'Select a pickup location first';
    else if (selectedOrders.length === 0) reason = 'Select at least one order';
    else if (missingCity.length > 0) {
        reason = `Pick a courier city for ${missingCity.length === 1
            ? `order #${missingCity[0].order_number}` : `${missingCity.length} orders`} first`;
    }
    btn.disabled = !!reason;
    btn.title = reason;
}

function renderFulfillmentSidePanel() {
    const content = document.getElementById('fulfillmentSidePanelContent');
    if (content) content.style.display = fulfillmentSelectedIds.size === 0 ? 'none' : 'flex';
}

function renderFulfillmentTable() {
    // About to blow away tbody's rows - an open courier-city dropdown lives outside them
    // (document.body), so it has to be closed explicitly or it's orphaned on screen.
    if (fulfillmentOpenCourierCityCloser) fulfillmentOpenCourierCityCloser();

    const filtered = getFulfillmentFilteredOrders();

    const totalOrdersLabel = document.getElementById('fulfillmentTotalOrdersLabel');
    if (totalOrdersLabel) totalOrdersLabel.textContent = `Total Orders: ${fulfillmentOrders.length}`;

    const tbody = document.getElementById('fulfillmentTableBody');
    if (tbody) {
        if (fulfillmentLoading) {
            tbody.innerHTML = '<tr><td colspan="12" class="empty-state">Loading unfulfilled orders…</td></tr>';
        } else {
            tbody.innerHTML = filtered.length
                ? filtered.map(renderFulfillmentRow).join('')
                : '<tr><td colspan="12" class="empty-state">No unfulfilled orders match these filters.</td></tr>';
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
    if (selectedCountLabel) {
        selectedCountLabel.textContent = `${fulfillmentSelectedIds.size} selected`;
        selectedCountLabel.style.display = fulfillmentSelectedIds.size === 0 ? 'none' : '';
    }

    renderFulfillmentSidePanel();
    updateFulfillmentFulfillBtnState();
}

async function renderOrderFulfillmentView() {
    return fetchFulfillmentOrders();
}
