// Printing/downloading airway bills - shared by Order Fulfillment and Print Airway
// Bill. Ported 1:1 from utils.js's printAirwayBillsForOrders and friends.
import { apiJson, apiRequest } from '../api';
import { getCourierDisplayName } from './shared';
import { orderHasAirwayBill, type Order } from './orders';

function openBlankTab(): Window | null {
  return window.open('', '_blank');
}

/** Point an already-open tab at a URL, once it's known. No-ops if the popup was
 * blocked after all (handle exists but navigation is inert). */
function navigateTab(tab: Window | null, url: string): void {
  if (!tab || tab.closed) return;
  tab.location.href = url;
}

function airwayBillsPdfFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `airway_bills_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
}

/** Prints/downloads one or more orders' airway bills as a single grouped action.
 * PostEx orders combine into one downloaded PDF; Couriers Next orders open in a tab
 * (opened synchronously before any await, so the popup isn't blocked), pointed at a
 * resolved URL once known. Returns the number of orders skipped (no airway bill available). */
export async function printAirwayBillsForOrders(orders: Order[]): Promise<number> {
  const eligible = orders.filter(orderHasAirwayBill);
  const skipped = orders.length - eligible.length;
  if (eligible.length === 0) throw new Error('No selected orders have an airway bill available');

  const postexOrders = eligible.filter((o) => getCourierDisplayName(o) === 'PostEx');
  const couriersNextOrders = eligible.filter((o) => getCourierDisplayName(o) === 'Couriers Next');

  const couriersNextTab = couriersNextOrders.length > 0 ? openBlankTab() : null;

  if (postexOrders.length > 0) {
    const res = await apiRequest('/orders/postex-airway-bills', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postexOrders.map((o) => o.id)), fallback: 'Failed to fetch airway bills',
    });
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = airwayBillsPdfFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 60000);
  }

  if (couriersNextOrders.length > 0) {
    const { url } = await apiJson<{ url: string }>('/orders/couriers-next-airway-bills', {
      method: 'POST', body: couriersNextOrders.map((o) => o.id), fallback: 'Failed to fetch airway bills',
    });
    navigateTab(couriersNextTab, url);
  }

  return skipped;
}
