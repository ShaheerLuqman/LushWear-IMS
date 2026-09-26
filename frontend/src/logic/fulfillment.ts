// Order Fulfillment business logic - ported 1:1 from order-fulfillment.js.
export interface FulfillmentCourier {
  id: string; name: string; logo?: string; monogram?: string; color?: string;
  // A rider booked on demand (no booking API, pickup, courier city or COD) - mirrors
  // COURIER_CATALOG's `kind` on the backend.
  kind?: 'local_delivery';
}

// Couriers with a real logo asset show it; the rest use a plain monogram chip.
export const FULFILLMENT_COURIERS: FulfillmentCourier[] = [
  { id: 'postex', name: 'PostEx', logo: '/assets/postex_logo.png' },
  { id: 'couriers_next', name: 'Couriers Next', logo: '/assets/courier_next_logo.png' },
  { id: 'leopards', name: 'Leopards Courier', monogram: 'LC', color: '#c45c2e' },
  { id: 'tcs', name: 'TCS', monogram: 'TCS', color: '#c4342e' },
  { id: 'trax', name: 'Trax', monogram: 'TX', color: '#2e5fc4' },
  { id: 'local_delivery', name: 'Local Delivery', monogram: 'LD', color: '#1fa35c', kind: 'local_delivery' },
  { id: 'other', name: 'Other', monogram: '···', color: '#6d6d78' },
];

export function isLocalDeliveryCourier(courier: string | null | undefined): boolean {
  return FULFILLMENT_COURIERS.some((c) => c.kind === 'local_delivery' && c.name === courier);
}

// Order types each courier's booking API accepts, keyed by courier id. Mirrors
// postex.ORDER_TYPES on the backend; a courier absent here has no equivalent field.
export const FULFILLMENT_ORDER_TYPES: Record<string, string[]> = {
  postex: ['Normal', 'Reversed', 'Replacement'],
};
export const FULFILLMENT_DEFAULT_ORDER_TYPE = 'Normal';
// Pre-filled into the details modal's Remarks; the courier prints it on the airway bill.
export const FULFILLMENT_DEFAULT_REMARK = '- THIS ORDER IS 100% CONFIRMED';

export interface FulfillmentLineItem { name?: string; variant_title?: string; qty?: number | string }
export interface CustomerStatus { tier: 'trusted' | 'new' | 'low' | 'medium' | 'high'; label: string; received: number; total: number }

export interface FulfillmentOrder {
  id: string;
  order_number: number;
  name: string;
  address: string;
  mobile: string;
  tags: string[];
  city: string;
  order_date: Date;
  total_amount: number;
  advance_amount: number;
  line_items?: FulfillmentLineItem[];
  customer_status?: CustomerStatus;
  tracking_number?: string | null;
  courier?: string;
  courierCity: string | null;
  orderType: string;
  codAmount: number;
  email: string;
  instructions: string;
  pieces: number;
  invoiceDivision: number;
  handling: string;
  // Local Delivery only: the rider's booking ID or phone, optional.
  trackingRef?: string;
}

/** "1 x Ruby Camisole Set L", dropping the size for a product with no variants ("-").
 * Matches the backend's _order_detail_string label. */
export function fulfillmentLineItemLabel(li: FulfillmentLineItem): string {
  const size = (li.variant_title || '').trim();
  const name = li.name || '';
  return size && size !== '-' ? `${name} ${size}` : name;
}

export function fulfillmentLineItemCount(lineItems: FulfillmentLineItem[] | undefined): number {
  return (lineItems || []).reduce((sum, li) => sum + (parseInt(String(li.qty), 10) || 0), 0);
}

/** The bracketed contents string PostEx/Couriers Next print on the airway bill. */
export function fulfillmentOrderDetailString(lineItems: FulfillmentLineItem[] | undefined): string {
  return (lineItems || []).filter((li) => li.name).map((li) => `[ ${li.qty} x ${fulfillmentLineItemLabel(li)} ]`).join(' ');
}

/** Per-column filter-row values keyed by column key: a string is a case-insensitive
 * "contains" match, an array is a set of accepted values (any match for multi-valued tags). */
export type FulfillmentColumnFilters = Record<string, string | string[]>;
export interface FulfillmentFilters { columns: FulfillmentColumnFilters; dateFrom: Date | null; dateTo: Date | null }

export const FULFILLMENT_COLUMN_VALUE: Record<string, (o: FulfillmentOrder) => string | string[]> = {
  order_number: (o) => String(o.order_number),
  name: (o) => o.name,
  address: (o) => o.address,
  mobile: (o) => o.mobile,
  tags: (o) => o.tags,
  city: (o) => o.city,
  courier_city: (o) => o.courierCity || '',
  order_type: (o) => o.orderType,
  cod: (o) => String(o.codAmount),
  risk: (o) => o.customer_status?.tier || 'new',
};

/** Header search: any column's value contains `query` (risk matches its badge label). */
export function fulfillmentRowMatchesQuery(o: FulfillmentOrder, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [...Object.values(FULFILLMENT_COLUMN_VALUE).map((get) => get(o)), o.customer_status?.label || 'New Customer']
    .flat().some((v) => v.toLowerCase().includes(q));
}

export function fulfillmentFilteredOrders(orders: FulfillmentOrder[], filters: FulfillmentFilters): FulfillmentOrder[] {
  const active = Object.entries(filters.columns)
    .filter(([key, raw]) => FULFILLMENT_COLUMN_VALUE[key] && (Array.isArray(raw) || raw.trim()))
    .map(([key, raw]) => [FULFILLMENT_COLUMN_VALUE[key], Array.isArray(raw) ? raw : raw.trim().toLowerCase()] as const);
  return orders.filter((o) => {
    for (const [get, want] of active) {
      const v = get(o);
      const values = Array.isArray(v) ? v : [v];
      if (!values.some((x) => (Array.isArray(want) ? want.includes(x) : x.toLowerCase().includes(want)))) return false;
    }
    if (filters.dateFrom && o.order_date < filters.dateFrom) return false;
    if (filters.dateTo) {
      const endOfDay = new Date(filters.dateTo);
      endOfDay.setHours(23, 59, 59, 999);
      if (o.order_date > endOfDay) return false;
    }
    return true;
  });
}

export interface PickupAddress { code: string; label?: string; city?: string; address?: string; is_default?: boolean }

/** Leads with the street address, since the courier's own label is a generic address
 * *type* that reads identically for every warehouse a merchant has. */
export function fulfillmentPickupAddressLabel(a: PickupAddress): string {
  const address = (a.address || '').trim();
  if (!address) return [a.label, a.city].filter(Boolean).join(' - ');
  const city = (a.city || '').trim();
  const hasCity = city && address.toLowerCase().includes(city.toLowerCase());
  return hasCity || !city ? address : `${address}, ${city}`;
}

export type FulfillmentProgressState = 'pending' | 'booking' | 'ok' | 'fail';
export interface FulfillmentProgressOrder {
  id: string; order_number: number; name: string; city: string; courier: string;
  state: FulfillmentProgressState; tracking_number: string | null; error: string | null;
}
export const FULFILLMENT_PROGRESS_STATE_META: Record<FulfillmentProgressState, { badge: string; icon: string }> = {
  pending: { badge: 'Pending', icon: 'circle' },
  booking: { badge: 'Booking…', icon: 'loader' },
  ok: { badge: 'Fulfilled', icon: 'check-circle-2' },
  fail: { badge: 'Failed', icon: 'x-circle' },
};
