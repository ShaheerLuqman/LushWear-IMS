// Shopify sync status shared across pages - ported from ledgers.js's
// syncShopifyOrders/initOrdersAutoSync/scheduleOrdersAutoSync (orders: a silent 30-minute
// backstop timer, webhooks cover the near-real-time case) and syncShopifyProducts (products:
// a manual button on the Inventory page). Orders don't need an explicit reload after sync -
// the backend already publishes "orders_changed" over the live events stream (eventsStream.ts).
import { apiJson } from './api';
import { PRODUCTS_CHANGED_EVENT } from './eventsStream';

const ORDERS_AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const SHOPIFY_PRODUCT_SYNC_STORAGE_KEY = 'lushwear_last_shopify_product_sync';

export const ORDERS_SYNC_STATUS_CHANGED_EVENT = 'lushwear:orders-sync-status-changed';

let lastOrdersSyncAt: number | null = null;
let ordersAutoSyncTimerId: ReturnType<typeof setTimeout> | null = null;
let ordersAutoSyncEnabled = false;

function setLastOrdersSyncAt(ms: number | null) {
  lastOrdersSyncAt = ms;
  window.dispatchEvent(new CustomEvent(ORDERS_SYNC_STATUS_CHANGED_EVENT));
}

export function getLastOrdersSyncAt(): number | null {
  return lastOrdersSyncAt;
}

function scheduleOrdersAutoSync(delayMs = ORDERS_AUTO_SYNC_INTERVAL_MS) {
  if (!ordersAutoSyncEnabled) return;
  if (ordersAutoSyncTimerId != null) clearTimeout(ordersAutoSyncTimerId);
  ordersAutoSyncTimerId = setTimeout(async () => {
    ordersAutoSyncTimerId = null;
    try {
      const result = await apiJson<{ already_syncing?: boolean; last_synced_at?: string }>(
        '/orders/sync-shopify', { method: 'POST', fallback: 'Failed to sync orders from Shopify' },
      );
      if (result.last_synced_at) setLastOrdersSyncAt(new Date(result.last_synced_at).getTime());
    } catch (error) {
      console.error('Error syncing Shopify orders:', error);
    } finally {
      scheduleOrdersAutoSync();
    }
  }, delayMs);
}

/** Does not sync on app load/reload - just shows the server's last-sync time and arms the
 * 30-minute backstop timer. */
export async function startOrdersAutoSync(): Promise<void> {
  if (ordersAutoSyncEnabled) return;
  ordersAutoSyncEnabled = true;
  try {
    const status = await apiJson<{ last_synced_at?: string }>('/orders/sync-status', { fallback: 'Failed to fetch sync status' });
    if (status.last_synced_at) setLastOrdersSyncAt(new Date(status.last_synced_at).getTime());
  } catch (error) {
    console.error('Error fetching orders sync status:', error);
  }
  scheduleOrdersAutoSync();
}

export function stopOrdersAutoSync(): void {
  ordersAutoSyncEnabled = false;
  if (ordersAutoSyncTimerId != null) { clearTimeout(ordersAutoSyncTimerId); ordersAutoSyncTimerId = null; }
}

function getLastShopifyProductSyncAt(): number | null {
  const raw = localStorage.getItem(SHOPIFY_PRODUCT_SYNC_STORAGE_KEY);
  const ms = raw ? parseInt(raw, 10) : NaN;
  return isNaN(ms) ? null : ms;
}

export interface ShopifyProductSyncResult {
  products?: { created?: number; updated?: number };
  variants?: { created?: number; updated?: number };
}

async function syncShopifyProducts(): Promise<ShopifyProductSyncResult> {
  const result = await apiJson<ShopifyProductSyncResult>('/products/sync-shopify', {
    method: 'POST', fallback: 'Failed to sync products from Shopify',
  });
  localStorage.setItem(SHOPIFY_PRODUCT_SYNC_STORAGE_KEY, Date.now().toString());
  return result;
}

/** Once per boot for orgs with the 'orders' feature - a full background product sync,
 * same as app-core.js's boot sequence calling syncShopifyProducts() unconditionally
 * alongside initOrdersAutoSync/initEventsStream (not just the Inventory page's manual
 * button). Silent - errors are logged, not toasted, since there's no page guaranteed
 * to be mounted to show one. */
export async function runBootShopifyProductSync(): Promise<void> {
  try {
    await syncShopifyProducts();
    window.dispatchEvent(new CustomEvent(PRODUCTS_CHANGED_EVENT));
  } catch (error) {
    console.error('Boot Shopify product sync failed:', error);
  }
}

export { getLastShopifyProductSyncAt, syncShopifyProducts };
