// Live push from the backend whenever an order/product changes anywhere in the app,
// any user - not just Shopify-webhook-driven ones. Ported from events-stream.js;
// dispatches window CustomEvents instead of calling page-specific reload functions
// directly, since pages are now separate route components that mount/unmount.
import { API_BASE, apiJson } from './api';

export const ORDERS_CHANGED_EVENT = 'lushwear:orders-changed';
export const PRODUCTS_CHANGED_EVENT = 'lushwear:products-changed';

let socket: WebSocket | null = null;
let connecting = false;
let enabled = false;
let listenersBound = false;
let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let staleTimerId: ReturnType<typeof setTimeout> | null = null;
let missedWhileDisconnected = false;

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
// The server pings every 20s, so silence this long means the connection is dead in a way
// that never produced a close event (a half-open socket after sleep/resume or a network switch).
const STALE_TIMEOUT_MS = 50000;

function restartStaleTimer() {
  if (staleTimerId != null) clearTimeout(staleTimerId);
  staleTimerId = setTimeout(() => {
    staleTimerId = null;
    socket?.close(); // onclose then reconnects, same as a real drop
  }, STALE_TIMEOUT_MS);
}

async function connect() {
  connecting = true;
  let ticket: string;
  try {
    ({ ticket } = await apiJson<{ ticket: string }>('/events/ticket', { method: 'POST', fallback: 'Failed to open live updates' }));
  } catch (error) {
    console.error('Error fetching events ticket:', error);
    connecting = false;
    missedWhileDisconnected = true;
    scheduleReconnect();
    return;
  }
  if (!enabled) { connecting = false; return; } // stopped (logout/lock) while the ticket was in flight

  const wsBase = API_BASE.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/events/ws?ticket=${encodeURIComponent(ticket)}`);
  socket = ws;
  connecting = false;
  ws.onerror = (error) => console.error('Events WebSocket error:', error);
  ws.onopen = () => {
    reconnectAttempts = 0;
    restartStaleTimer();
    // Nothing buffers events for a disconnected tab, so whatever changed during the gap
    // has to be picked up by a refetch.
    if (missedWhileDisconnected) {
      missedWhileDisconnected = false;
      window.dispatchEvent(new CustomEvent(ORDERS_CHANGED_EVENT));
      window.dispatchEvent(new CustomEvent(PRODUCTS_CHANGED_EVENT));
    }
  };
  ws.onmessage = (event) => {
    restartStaleTimer();
    let payload: any;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === 'orders_changed') window.dispatchEvent(new CustomEvent(ORDERS_CHANGED_EVENT));
    else if (payload.type === 'products_changed') window.dispatchEvent(new CustomEvent(PRODUCTS_CHANGED_EVENT));
  };
  // Unlike EventSource, a closed WebSocket never retries itself.
  ws.onclose = () => {
    if (socket !== ws) return; // already superseded by a newer connection
    socket = null;
    if (staleTimerId != null) { clearTimeout(staleTimerId); staleTimerId = null; }
    missedWhileDisconnected = true;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!enabled || reconnectTimerId != null || connecting) return;
  const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimerId = setTimeout(() => {
    reconnectTimerId = null;
    connect();
  }, ceiling / 2 + Math.random() * ceiling / 2);
}

function reconnectNow() {
  if (!enabled || socket || connecting) return;
  if (reconnectTimerId != null) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  reconnectAttempts = 0;
  connect();
}

export function startEventsStream(): void {
  if (enabled) return;
  enabled = true;
  if (!listenersBound) {
    listenersBound = true;
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });
  }
  connect();
}

export function stopEventsStream(): void {
  enabled = false;
  if (reconnectTimerId != null) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (staleTimerId != null) { clearTimeout(staleTimerId); staleTimerId = null; }
  if (socket) {
    const s = socket;
    socket = null; // cleared first so onclose above treats this as intentional, not a drop to reconnect from
    s.close();
  }
}
