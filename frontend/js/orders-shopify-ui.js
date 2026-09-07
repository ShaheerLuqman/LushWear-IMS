// Shopify-style chrome above the orders grid: the summary metrics strip and the
// status view-tabs. Both are read-only views over the already-loaded `orders`
// array and the grid's own `order_status` filter model - no new data source.

// Each tab maps to a set of order_status values fed to the grid's order_status
// checkbox filter (model shape { values: [...] } - see grid-filters.js). RFD/CNA/ICA
// are courier sub-states of a booked order, so they ride along with "Fulfilled".
const ORDERS_VIEW_TABS = [
    { id: 'all', label: 'All', statuses: null },
    { id: 'unfulfilled', label: 'Unfulfilled', statuses: ['unfulfilled'] },
    { id: 'fulfilled', label: 'Fulfilled', statuses: ['fulfilled', 'RFD', 'CNA', 'ICA'] },
    { id: 'delivered', label: 'Delivered', statuses: ['delivered'] },
    { id: 'returned', label: 'Returned', statuses: ['returned'] },
    { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] }
];

function ordersRealRows() {
    return (orders || []).filter((o) => o && o.id !== '__footer__');
}

function orderLineItemQty(order) {
    const lineItems = order.line_items;
    if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
    return lineItems.reduce((sum, li) => sum + (Number(li.qty) || 1), 0);
}

/** Rs with a K/M suffix for the metric tiles, where the full figure would be too wide to scan. */
function ordersCompactRs(value) {
    const v = Math.round(value || 0);
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `Rs ${(v / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `Rs ${Math.round(v / 1_000).toLocaleString('en-US')}K`;
    return `Rs ${v.toLocaleString('en-US')}`;
}

function computeOrdersMetrics() {
    const rows = ordersRealRows();
    let items = 0;
    let cod = 0;
    let delivered = 0;
    let returned = 0;
    let cancelled = 0;
    let netProfit = 0;

    for (const order of rows) {
        const status = (order.order_status || '').toLowerCase();
        if (status === 'cancelled') {
            cancelled += 1;
            continue;
        }
        items += orderLineItemQty(order);
        if (status === 'delivered') {
            delivered += 1;
        } else if (status === 'returned') {
            returned += 1;
        } else {
            // Still out with the courier or the customer.
            cod += (parseFloat(order.total_amount) || 0) - (parseFloat(order.advance_amount) || 0);
        }
        const rowProfit = computeNetProfit(order);
        if (rowProfit != null) netProfit += rowProfit;
    }

    return {
        orders: rows.length - cancelled,
        items,
        cod,
        delivered,
        returned,
        netProfit
    };
}

function renderOrdersMetricsStrip() {
    const strip = document.getElementById('ordersMetricsStrip');
    if (!strip) return;
    const m = computeOrdersMetrics();
    const tiles = [
        { label: 'Orders', value: m.orders.toLocaleString('en-US') },
        { label: 'Items ordered', value: m.items.toLocaleString('en-US') },
        { label: 'COD to collect', value: ordersCompactRs(m.cod) },
        { label: 'Delivered', value: m.delivered.toLocaleString('en-US') },
        { label: 'Returned', value: m.returned.toLocaleString('en-US') },
        { label: 'Net profit', value: ordersCompactRs(m.netProfit), negative: m.netProfit < 0 }
    ];
    strip.innerHTML = tiles.map((t) => `
        <div class="orders-metric">
            <span class="orders-metric__label">${t.label}</span>
            <span class="orders-metric__value${t.negative ? ' orders-metric__value--neg' : ''}">${t.value}</span>
        </div>`).join('');
}

function buildOrdersViewTabs() {
    const tabsEl = document.getElementById('ordersViewTabs');
    if (!tabsEl || tabsEl.dataset.built) return;
    tabsEl.dataset.built = '1';
    tabsEl.innerHTML = ORDERS_VIEW_TABS.map((t) => `
        <button type="button" class="orders-view-tab${t.id === 'all' ? ' active' : ''}"
                data-tab="${t.id}" role="tab" aria-selected="${t.id === 'all'}">
            <span class="orders-view-tab__label">${t.label}</span>
            <span class="orders-view-tab__count" data-count-for="${t.id}"></span>
        </button>`).join('');
    tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.orders-view-tab');
        if (btn) applyOrdersViewTab(btn.dataset.tab);
    });
}

function setActiveOrdersViewTab(tabId) {
    document.querySelectorAll('#ordersViewTabs .orders-view-tab').forEach((btn) => {
        const on = btn.dataset.tab === tabId;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
}

function applyOrdersViewTab(tabId) {
    if (!ordersGridApi) return;
    const tab = ORDERS_VIEW_TABS.find((t) => t.id === tabId) || ORDERS_VIEW_TABS[0];
    const model = { ...(ordersGridApi.getFilterModel() || {}) };
    if (tab.statuses) {
        model.order_status = { values: tab.statuses.slice() };
    } else {
        delete model.order_status;
    }
    ordersGridApi.setFilterModel(model);
    setActiveOrdersViewTab(tab.id);
}

/** Reflect a status filter set some other way (the column's own floating filter, "clear
 * filters") back onto the tabs - matching tab highlighted, or none when it's a custom set. */
function syncOrdersViewTabsFromFilter() {
    if (!ordersGridApi) return;
    const model = (ordersGridApi.getFilterModel() || {}).order_status;
    const values = model && Array.isArray(model.values) ? [...model.values].sort() : null;
    if (!values) {
        setActiveOrdersViewTab('all');
        return;
    }
    const match = ORDERS_VIEW_TABS.find(
        (t) => t.statuses && [...t.statuses].sort().join(',') === values.join(',')
    );
    setActiveOrdersViewTab(match ? match.id : null);
}

function renderOrdersViewTabCounts() {
    const rows = ordersRealRows();
    const counts = { all: rows.length };
    ORDERS_VIEW_TABS.forEach((t) => { if (t.statuses) counts[t.id] = 0; });
    for (const order of rows) {
        const status = order.order_status || '';
        for (const tab of ORDERS_VIEW_TABS) {
            if (tab.statuses && tab.statuses.includes(status)) counts[tab.id] += 1;
        }
    }
    document.querySelectorAll('#ordersViewTabs .orders-view-tab__count').forEach((el) => {
        const c = counts[el.dataset.countFor];
        el.textContent = c != null ? c.toLocaleString('en-US') : '';
    });
}

/** Repaint the strip and tab counts from the current `orders` - called on every grid row-data update. */
function refreshOrdersShopifyUI() {
    renderOrdersMetricsStrip();
    renderOrdersViewTabCounts();
}

function initOrdersShopifyUI() {
    buildOrdersViewTabs();
    refreshOrdersShopifyUI();
}
