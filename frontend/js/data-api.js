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

// Period = month's 22 to next month's 21 (same as backend)
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
    if (day >= 22) return { month, year };
    if (month === 1) return { month: 12, year: year - 1 };
    return { month: month - 1, year };
}

function ordersPeriodStartEnd(month, year) {
    const start = new Date(year, month - 1, 22, 0, 0, 0);
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const end = new Date(nextYear, nextMonth - 1, 21, 23, 59, 59);
    return { start, end };
}

function isOrderInPeriod(order, month, year) {
    const date = getOrderDateForPeriod(order);
    if (!date) return false;
    const { start, end } = ordersPeriodStartEnd(month, year);
    return date >= start && date <= end;
}

function formatOrdersPeriodLabel(month, year) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${monthNames[month - 1]} 22 – ${monthNames[nextMonth - 1]} 21, ${nextMonth === 1 ? nextYear : year}`;
}

/** Current period (month 22 – next 21) that contains today in PKT */
function getCurrentOrdersPeriod() {
    return getPeriodForDate(getPKTDate());
}

/** True if the given period (month 22 – next 21) has fully ended in PKT */
function isPeriodPassed(month, year) {
    const pkt = getPKTDate();
    const todayY = pkt.getFullYear();
    const todayM = pkt.getMonth() + 1;
    const todayD = pkt.getDate();
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    if (todayY > nextYear) return true;
    if (todayY < nextYear) return false;
    if (todayM > nextMonth) return true;
    if (todayM < nextMonth) return false;
    return todayD > 21;
}

/** Oldest period in dropdown: Oct 22 – Nov 21, 2024 */
const ORDERS_PERIOD_OLDEST_MONTH = 10;
const ORDERS_PERIOD_OLDEST_YEAR = 2024;

/** Build dropdown options: "All orders" + periods from current down to Oct 22 – Nov 21, 2024 */
function buildStaticPeriodOptions() {
    const options = [{ value: '__all__', label: 'All orders (recent)' }];
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

function populateOrdersPeriodFilterDropdown() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const options = buildStaticPeriodOptions();
    selectEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    if (currentVal && options.some((o) => o.value === currentVal)) {
        selectEl.value = currentVal;
    } else {
        selectEl.value = '__all__';
    }
}

async function loadOrders() {
    if (ordersGridApi) ordersGridApi.showLoadingOverlay();
    try {
        orders = await apiJson('/orders/', { fallback: 'Failed to fetch orders' });

        populateOrdersPeriodFilterDropdown();
        const selectEl = document.getElementById('ordersPeriodFilter');
        if (selectEl) selectEl.value = '__all__';

        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            // advance_status isn't a column field, so a delta rowData update won't
            // re-render the Advance cell when only the status changed. Force it.
            ordersGridApi.refreshCells({ columns: ['advance_amount'], force: true });
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            populateOrdersPeriodFilterDropdown();
            const sel = document.getElementById('ordersPeriodFilter');
            if (sel) sel.value = '__all__';
            if (ordersGridApi) {
                ordersGridApi.setGridOption('rowData', orders);
                setTimeout(() => updateFooterRow(), 0);
            }
        }
    } finally {
        if (ordersGridApi) ordersGridApi.hideOverlay();
    }
}

/** Reload orders while preserving whichever period view is currently selected - loadOrders()
 * always resets the period dropdown to "All orders", which would silently drop a selected
 * period out from under the user (e.g. after a background sync). */
async function refreshOrdersView() {
    const periodVal = document.getElementById('ordersPeriodFilter')?.value;
    if (periodVal && periodVal !== '__all__') {
        const [month, year] = periodVal.split('-');
        await loadOrdersForPeriod(Number(month), Number(year));
    } else {
        await loadOrders();
    }
}

/** Load orders for a specific period from API (for older months beyond the initial 1000) */
async function loadOrdersForPeriod(month, year) {
    if (ordersGridApi) ordersGridApi.showLoadingOverlay();
    try {
        orders = await apiJson(`/orders/?month=${month}&year=${year}`, { fallback: 'Failed to fetch orders for period' });

        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            ordersGridApi.refreshCells({ columns: ['advance_amount'], force: true });
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (error) {
        console.error('Error loading orders for period:', error);
        showToast('Failed to load orders for period', 'error');
        if (ordersGridApi) ordersGridApi.setGridOption('rowData', []);
    } finally {
        if (ordersGridApi) ordersGridApi.hideOverlay();
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

