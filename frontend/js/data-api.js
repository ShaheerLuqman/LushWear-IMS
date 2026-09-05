// Data loading: products, orders, and the period-scoped order fetches.

// ============================================
// API Functions
// ============================================

async function loadProducts() {
    try {
        products = await apiJson('/products/', { fallback: 'Failed to fetch products' });
        products.sort((a, b) => {
            const nameA = (a.name || '').toLowerCase();
            const nameB = (b.name || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });

        // Update AG Grid
        if (productsGridApi) {
            productsGridApi.setGridOption('rowData', products);
        }
    } catch (error) {
        console.error('Error loading products:', error);
        showToast('Failed to load products', 'error');
    }
}

// Period = month's ordersFiscalMonthStartDay to next month's (ordersFiscalMonthStartDay - 1)
// (same as backend - see app/fiscal_settings.py). ordersFiscalMonthStartDay (app-core.js)
// is resolved once at boot from the org's own setting; defaults to 22 until it loads.
function getOrderDateForPeriod(order) {
    const raw = order.order_receiving_date || order.created_at;
    return raw ? new Date(raw) : null;
}

function getPeriodForDate(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;
    const d = date;
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    if (day >= ordersFiscalMonthStartDay) return { month, year };
    if (month === 1) return { month: 12, year: year - 1 };
    return { month: month - 1, year };
}

function ordersPeriodStartEnd(month, year) {
    const start = new Date(year, month - 1, ordersFiscalMonthStartDay, 0, 0, 0);
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    // Day 0 of nextMonth rolls back to the last day of the month before it - the same
    // trick backend/app/routes/orders.py's _period_start_end_dates uses, so a start day
    // of 1 (a plain calendar month) correctly ends on the month's actual last day.
    const end = new Date(nextYear, nextMonth - 1, ordersFiscalMonthStartDay - 1, 23, 59, 59);
    return { start, end };
}

function formatOrdersPeriodLabel(month, year) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const { end } = ordersPeriodStartEnd(month, year);
    return `${monthNames[month - 1]} ${ordersFiscalMonthStartDay} – ${monthNames[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

/** Current period that contains today in PKT */
function getCurrentOrdersPeriod() {
    return getPeriodForDate(getPKTDate());
}

/** Oldest period in dropdown: the October 2024 period */
const ORDERS_PERIOD_OLDEST_MONTH = 10;
const ORDERS_PERIOD_OLDEST_YEAR = 2024;

/** Build dropdown options: periods from current down to the October 2024 period */
function buildStaticPeriodOptions() {
    const options = [];
    let { month, year } = getCurrentOrdersPeriod();
    while (year > ORDERS_PERIOD_OLDEST_YEAR || (year === ORDERS_PERIOD_OLDEST_YEAR && month >= ORDERS_PERIOD_OLDEST_MONTH)) {
        options.push({ value: `${month}-${year}`, label: formatOrdersPeriodLabel(month, year) });
        if (month === 1) {
            month = 12;
            year -= 1;
        } else {
            month -= 1;
        }
    }
    return options;
}

/** Dropdown value for the "Recent Orders" option - orders across the last few periods. */
const ALL_ORDERS_VALUE = '__all__';

const ORDERS_CACHE_KEY_PREFIX = 'lushwear_orders_cache_';
const ORDERS_FETCH_RETRIES = 3;
const ORDERS_FETCH_RETRY_DELAY_MS = 5000;

function ordersCacheKey(periodKey) {
    return currentOrgId ? `${ORDERS_CACHE_KEY_PREFIX}${currentOrgId}_${periodKey}` : null;
}

function saveOrdersCache(periodKey) {
    const key = ordersCacheKey(periodKey);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(orders)); } catch (e) { /* ignore */ }
}

function ordersHasCachedOrders(periodKey) {
    const key = ordersCacheKey(periodKey);
    return !!key && localStorage.getItem(key) != null;
}

// Paints the grid from the last successful fetch for `periodKey` so switching into it isn't
// blank while the real fetch is in flight. No-op if `orders` already holds this period's data
// (e.g. a reload after a mutation), so it never flickers stale rows over fresh ones.
function hydrateOrdersFromCache(periodKey) {
    if (periodKey === ordersLoadedPeriodKey) return;
    const key = ordersCacheKey(periodKey);
    if (!key) return;
    try {
        const cached = JSON.parse(localStorage.getItem(key) || 'null');
        if (!Array.isArray(cached)) return;
        orders = cached;
        ordersLoadedPeriodKey = periodKey;
        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            ordersGridApi.refreshCells({ columns: ['advance_amount'], force: true });
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (e) { /* ignore */ }
}

// Shared fetch behind loadOrders()/loadAllOrders()/loadOrdersForPeriod(): paints cached rows
// for `periodKey` immediately, then fetches fresh data. A failed attempt retries a few times
// (the backend/network hiccup is usually transient) before giving up; the stale rows - cached
// or from the last successful fetch - stay on screen throughout, never cleared to blank.
async function fetchOrdersForPeriodKey(periodKey, url, fallback) {
    hydrateOrdersFromCache(periodKey);
    for (let attempt = 1; attempt <= ORDERS_FETCH_RETRIES; attempt++) {
        try {
            orders = await apiJson(url, { fallback });
            ordersLoadedPeriodKey = periodKey;
            saveOrdersCache(periodKey);
            if (ordersGridApi) {
                ordersGridApi.setGridOption('rowData', orders);
                ordersGridApi.refreshCells({ columns: ['advance_amount'], force: true });
                setTimeout(() => updateFooterRow(), 0);
            }
            return;
        } catch (error) {
            if (attempt === ORDERS_FETCH_RETRIES) throw error;
            await new Promise((resolve) => setTimeout(resolve, ORDERS_FETCH_RETRY_DELAY_MS));
        }
    }
}

function populateOrdersPeriodFilterDropdown() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const options = [{ value: ALL_ORDERS_VALUE, label: 'Recent Orders' }, ...buildStaticPeriodOptions()];
    selectEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    const { month, year } = getCurrentOrdersPeriod();
    selectEl.value = (currentVal && options.some((o) => o.value === currentVal)) ? currentVal : `${month}-${year}`;
}

/** Loads orders for whichever period is currently selected in the period dropdown, defaulting
 * to the current month period when none is selected yet (e.g. initial load). Single entry point
 * for reloading orders - safe to call after any mutation without silently dropping the user out
 * of a selected period back to the default. */
async function loadOrders() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (selectEl && !selectEl.value) populateOrdersPeriodFilterDropdown();
    const periodVal = selectEl?.value;
    if (periodVal && periodVal !== ALL_ORDERS_VALUE) {
        const [month, year] = periodVal.split('-');
        await loadOrdersForPeriod(Number(month), Number(year));
        return;
    }

    try {
        await fetchOrdersForPeriodKey(ALL_ORDERS_VALUE, '/orders/', 'Failed to fetch orders');

        populateOrdersPeriodFilterDropdown();
        const selectEl = document.getElementById('ordersPeriodFilter');
        if (selectEl) selectEl.value = ALL_ORDERS_VALUE;
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            populateOrdersPeriodFilterDropdown();
            const sel = document.getElementById('ordersPeriodFilter');
            if (sel) sel.value = ALL_ORDERS_VALUE;
            if (ordersGridApi) {
                ordersGridApi.setGridOption('rowData', orders);
                setTimeout(() => updateFooterRow(), 0);
            }
        }
    }
}

/** Load every order across all periods, newest first ("Recent Orders") from the API. */
async function loadAllOrders() {
    try {
        await fetchOrdersForPeriodKey(ALL_ORDERS_VALUE, '/orders/', 'Failed to fetch orders');
    } catch (error) {
        console.error('Error loading all orders:', error);
        showToast('Failed to load orders', 'error');
    }
}

/** Load orders for a specific period from the API. */
async function loadOrdersForPeriod(month, year) {
    try {
        await fetchOrdersForPeriodKey(`${month}-${year}`, `/orders/?month=${month}&year=${year}`, 'Failed to fetch orders for period');
    } catch (error) {
        console.error('Error loading orders for period:', error);
        showToast('Failed to load orders for period', 'error');
    }
}

function getSampleOrders() {
    return [
        { id: '1', order_number: 2719, courier: '1289', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 4247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '2', order_number: 2720, courier: 'RIDER', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 7697, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '3', order_number: 2721, courier: '1287', order_status: 'unfulfilled', piece_received: 'Pending', delivery_status: 'not_delivered', total_amount: 3248, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '4', order_number: 2722, courier: 'RIDER', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 8247, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '5', order_number: 2724, courier: '1293', order_status: 'returned', piece_received: 'Received', delivery_status: 'not_delivered', total_amount: 3247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() }
    ];
}

