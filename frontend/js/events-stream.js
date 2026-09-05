// Live push from the backend (app/routes/events.py, app/services/event_bus.py) whenever
// an order changes - anywhere in the app, any user, not just Shopify-webhook-driven ones
// (see that module's docstring for the full list of write paths that publish). Refreshes
// the Orders/Products grids the instant it happens, instead of waiting on a manual reload
// or the polling backstop (ledgers.js's ORDERS_AUTO_SYNC_INTERVAL_MS).
//
// The WebSocket handshake can't carry an Authorization header, so a connection (and every
// reconnection) fetches a short-lived, single-purpose ticket first and puts it in the URL
// instead of the session token - see routes/events.py's docstring.

let eventsSocket = null;
let eventsReconnectTimerId = null;
const EVENTS_RECONNECT_DELAY_MS = 5000;

let ordersChangedReloadTimer = null;
let productsChangedReloadTimer = null;

// Debounced like transactions.js's scheduleTransactionsReload - a burst of pushes for the
// same change (e.g. a bulk edit touching many orders) should collapse into one refetch,
// not one per event.
function scheduleOrdersChangedReload() {
    if (ordersChangedReloadTimer) clearTimeout(ordersChangedReloadTimer);
    ordersChangedReloadTimer = setTimeout(async () => {
        ordersChangedReloadTimer = null;
        await loadOrders();
        lastOrdersSyncAt = Date.now();
        updateSyncOrdersLastSyncLabel();
    }, 500);
}

function scheduleProductsChangedReload() {
    if (productsChangedReloadTimer) clearTimeout(productsChangedReloadTimer);
    productsChangedReloadTimer = setTimeout(() => {
        productsChangedReloadTimer = null;
        loadProducts();
    }, 500);
}

async function connectEventsStream() {
    let ticket;
    try {
        ({ ticket } = await apiJson('/events/ticket', { method: 'POST', fallback: 'Failed to open live updates' }));
    } catch (error) {
        console.error('Error fetching events ticket:', error);
        scheduleEventsReconnect();
        return;
    }

    // API_BASE is http(s)://host/api - same origin/port, just a different scheme.
    const wsBase = API_BASE.replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsBase}/events/ws?ticket=${encodeURIComponent(ticket)}`);
    eventsSocket = socket;
    socket.onmessage = (event) => {
        let payload;
        try {
            payload = JSON.parse(event.data);
        } catch (error) {
            return;
        }
        if (payload.type === 'orders_changed') scheduleOrdersChangedReload();
        else if (payload.type === 'products_changed') scheduleProductsChangedReload();
        // 'ping' (the server's keepalive) needs no handling - receiving anything at all
        // already proves the connection is alive.
    };
    // Unlike EventSource, a closed WebSocket never retries itself - reconnecting is
    // entirely on us, whether the close was a rejected/expired ticket, a network drop,
    // or the backend restarting.
    socket.onclose = () => {
        if (eventsSocket !== socket) return; // already superseded by a newer connection
        eventsSocket = null;
        scheduleEventsReconnect();
    };
}

function scheduleEventsReconnect() {
    if (eventsReconnectTimerId != null) return;
    eventsReconnectTimerId = setTimeout(() => {
        eventsReconnectTimerId = null;
        connectEventsStream();
    }, EVENTS_RECONNECT_DELAY_MS);
}

function initEventsStream() {
    if (eventsSocket || eventsReconnectTimerId != null) return; // already connected/connecting
    connectEventsStream();
}

function stopEventsStream() {
    if (eventsReconnectTimerId != null) {
        clearTimeout(eventsReconnectTimerId);
        eventsReconnectTimerId = null;
    }
    if (eventsSocket) {
        const socket = eventsSocket;
        eventsSocket = null; // cleared first so the onclose handler above treats this as intentional, not a drop to reconnect from
        socket.close();
    }
}
