// Shopify sync status shared across pages - ported from ledgers.js's
// syncShopifyOrders/initOrdersAutoSync/scheduleOrdersAutoSync (orders: a silent 30-minute
// backstop timer, webhooks cover the near-real-time case) and syncShopifyProducts (products:
// a manual button on the Inventory page). Orders don't need an explicit reload after sync -
// the backend already publishes "orders_changed" over the live events stream (eventsStream.ts).
import { apiJson } from './api';
import { PRODUCTS_CHANGED_EVENT } from './eventsStream';

const ORDERS_AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

let ordersAutoSyncTimerId: ReturnType<typeof setTimeout> | null = null;
let ordersAutoSyncEnabled = false;

function scheduleOrdersAutoSync(delayMs = ORDERS_AUTO_SYNC_INTERVAL_MS) {
  if (!ordersAutoSyncEnabled) return;
  if (ordersAutoSyncTimerId != null) clearTimeout(ordersAutoSyncTimerId);
  ordersAutoSyncTimerId = setTimeout(async () => {
    ordersAutoSyncTimerId = null;
    try {
      await apiJson('/orders/sync-shopify', { method: 'POST', fallback: 'Failed to sync orders from Shopify' });
    } catch (error) {
      console.error('Error syncing Shopify orders:', error);
    } finally {
      scheduleOrdersAutoSync();
    }
  }, delayMs);
}

/** Does not sync on app load/reload - just arms the 30-minute backstop timer. */
export function startOrdersAutoSync(): void {
  if (ordersAutoSyncEnabled) return;
  ordersAutoSyncEnabled = true;
  scheduleOrdersAutoSync();
}

export function stopOrdersAutoSync(): void {
  ordersAutoSyncEnabled = false;
  if (ordersAutoSyncTimerId != null) { clearTimeout(ordersAutoSyncTimerId); ordersAutoSyncTimerId = null; }
}

export interface ShopifyProductSyncResult {
  products?: { created?: number; updated?: number };
  variants?: { created?: number; updated?: number };
}

function syncShopifyProducts(): Promise<ShopifyProductSyncResult> {
  return apiJson<ShopifyProductSyncResult>('/products/sync-shopify', {
    method: 'POST', fallback: 'Failed to sync products from Shopify',
  });
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

export { syncShopifyProducts };
