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
let eventsConnecting = false;
let eventsStreamEnabled = false;
let eventsListenersBound = false;
let eventsReconnectTimerId = null;
let eventsReconnectAttempts = 0;
let eventsStaleTimerId = null;
let missedEventsWhileDisconnected = false;

const EVENTS_RECONNECT_BASE_MS = 2000;
const EVENTS_RECONNECT_MAX_MS = 60000;
// The server pings every 20s (events.py's _KEEPALIVE_SECONDS), so silence this long means
// the connection is dead in a way that never produced a close event - a half-open socket
// after a sleep/resume or a network switch, which otherwise leaves the tab silently stale.
const EVENTS_STALE_TIMEOUT_MS = 50000;

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

function restartEventsStaleTimer() {
    if (eventsStaleTimerId != null) clearTimeout(eventsStaleTimerId);
    eventsStaleTimerId = setTimeout(() => {
        eventsStaleTimerId = null;
        if (eventsSocket) eventsSocket.close(); // onclose then reconnects, same as a real drop
    }, EVENTS_STALE_TIMEOUT_MS);
}

async function connectEventsStream() {
    eventsConnecting = true;
    let ticket;
    try {
        ({ ticket } = await apiJson('/events/ticket', { method: 'POST', fallback: 'Failed to open live updates' }));
    } catch (error) {
        console.error('Error fetching events ticket:', error);
        eventsConnecting = false;
        missedEventsWhileDisconnected = true;
        scheduleEventsReconnect();
        return;
    }
    if (!eventsStreamEnabled) {
        eventsConnecting = false; // stopped (logout/lock) while the ticket was in flight
        return;
    }

    // API_BASE is http(s)://host/api - same origin/port, just a different scheme. Also
    // needs to be allowed by index.html's connect-src CSP directive alongside the http(s) origin.
    const wsBase = API_BASE.replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsBase}/events/ws?ticket=${encodeURIComponent(ticket)}`);
    eventsSocket = socket;
    eventsConnecting = false;
    socket.onerror = (error) => console.error('Events WebSocket error:', error);
    socket.onopen = () => {
        eventsReconnectAttempts = 0;
        restartEventsStaleTimer();
        // Nothing buffers events for a disconnected tab (event_bus.py publishes to live
        // queues only), so whatever changed during the gap has to be picked up by a refetch.
        if (missedEventsWhileDisconnected) {
            missedEventsWhileDisconnected = false;
            scheduleOrdersChangedReload();
            scheduleProductsChangedReload();
        }
    };
    socket.onmessage = (event) => {
        restartEventsStaleTimer();
        let payload;
        try {
            payload = JSON.parse(event.data);
        } catch (error) {
            return;
        }
        if (payload.type === 'orders_changed') scheduleOrdersChangedReload();
        else if (payload.type === 'products_changed') scheduleProductsChangedReload();
        // 'ping' (the server's keepalive) needs no handling beyond the stale-timer reset
        // above - receiving anything at all already proves the connection is alive.
    };
    // Unlike EventSource, a closed WebSocket never retries itself - reconnecting is
    // entirely on us, whether the close was a rejected/expired ticket, a network drop,
    // or the backend restarting.
    socket.onclose = () => {
        if (eventsSocket !== socket) return; // already superseded by a newer connection
        eventsSocket = null;
        if (eventsStaleTimerId != null) {
            // Cleared here, not left to the next onopen: a stale timer armed for this socket
            // would otherwise be free to fire against the replacement one.
            clearTimeout(eventsStaleTimerId);
            eventsStaleTimerId = null;
        }
        missedEventsWhileDisconnected = true;
        scheduleEventsReconnect();
    };
}

function scheduleEventsReconnect() {
    if (!eventsStreamEnabled || eventsReconnectTimerId != null || eventsConnecting) return;
    // Backed off (with jitter) rather than a flat retry: while the backend is down every
    // open tab is retrying, and each attempt costs a POST /events/ticket against the same
    // per-IP rate limit the rest of the app shares.
    const ceiling = Math.min(EVENTS_RECONNECT_BASE_MS * 2 ** eventsReconnectAttempts, EVENTS_RECONNECT_MAX_MS);
    eventsReconnectAttempts += 1;
    eventsReconnectTimerId = setTimeout(() => {
        eventsReconnectTimerId = null;
        connectEventsStream();
    }, ceiling / 2 + Math.random() * ceiling / 2);
}

function reconnectEventsStreamNow() {
    if (!eventsStreamEnabled || eventsSocket || eventsConnecting) return;
    if (eventsReconnectTimerId != null) {
        clearTimeout(eventsReconnectTimerId);
        eventsReconnectTimerId = null;
    }
    eventsReconnectAttempts = 0; // the thing that was broken (offline/backgrounded) just changed
    connectEventsStream();
}

function initEventsStream() {
    if (eventsStreamEnabled) return;
    eventsStreamEnabled = true;
    if (!eventsListenersBound) {
        // A backed-off retry can be minutes out by the time the network returns or the tab is
        // looked at again; both are a much better signal than the timer that a retry will work
        // now. Bound once for the page's lifetime - lockApp() stops and restarts the stream.
        eventsListenersBound = true;
        window.addEventListener('online', reconnectEventsStreamNow);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) reconnectEventsStreamNow();
        });
    }
    connectEventsStream();
}

function stopEventsStream() {
    eventsStreamEnabled = false;
    if (eventsReconnectTimerId != null) {
        clearTimeout(eventsReconnectTimerId);
        eventsReconnectTimerId = null;
    }
    if (eventsStaleTimerId != null) {
        clearTimeout(eventsStaleTimerId);
        eventsStaleTimerId = null;
    }
    if (eventsSocket) {
        const socket = eventsSocket;
        eventsSocket = null; // cleared first so the onclose handler above treats this as intentional, not a drop to reconnect from
        socket.close();
    }
}
