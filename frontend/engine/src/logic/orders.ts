import { getCourierDisplayName } from './shared';

// Orders business logic - ported 1:1 from orders-grid.js/orders-columns.js.
// Single source of truth for the grid columns, the selection footer, and (for
// computeNetProfit) the backend's month-summary aggregate - keep in sync with
// backend's get_month_summary_totals SQL function if this changes.
export interface Order {
  id: string;
  order_number?: number;
  courier?: string;
  tracking_number?: string;
  order_status?: string;
  delivery_status?: {
    latest_status?: string;
    fetched_at?: string;
    status_history?: Array<{ status?: string; datetime?: string; status_code?: string }>;
  } | null;
  total_amount?: number;
  advance_amount?: number;
  advance_status?: number;
  delivery_charge?: number;
  tax_amount?: number;
  cost_price?: number;
  folio?: string | null;
  piece_received?: string;
  order_receiving_date?: string;
  created_at?: string;
  line_items?: Array<{ name?: string; variant_title?: string; qty?: number }>;
  replacement_of_order_no?: number;
  [key: string]: unknown;
}

export const ORDER_STATUS_VALUES = ['unfulfilled', 'fulfilled', 'delivered', 'RFD', 'returned', 'cancelled', 'CNA', 'ICA'];

export function orderStatusDisplayLabel(v: string): string {
  return v === 'RFD' || v === 'CNA' || v === 'ICA' ? v : v.charAt(0).toUpperCase() + v.slice(1);
}

export function orderStatusBadgeClass(status?: string): string {
  if (status === 'fulfilled') return 'grid-status-fulfilled';
  if (status === 'delivered') return 'grid-status-delivered';
  if (status === 'returned') return 'grid-status-returned';
  if (status === 'cancelled') return 'grid-status-cancelled';
  if (status === 'RFD' || status === 'ICA' || status === 'CNA') return 'grid-status-rfd';
  return 'grid-status-unfulfilled';
}

export const COURIER_LOGOS: Record<string, { src: string; alt: string; imgClass: string }> = {
  POSTEX: { src: '/assets/postex_logo.png', alt: 'PostEx', imgClass: '' },
  'COURIERS NEXT': { src: '/assets/courier_next_logo.png', alt: 'Couriers Next', imgClass: 'grid-courier-logo--couriersnext' },
};

export const FINAL_STATUS_VALUES = ['OK', 'Warning', 'None'];

/** Health indicator for one order row, shown in the Status column and filtered on by
 * FinalStatusSetFilter - single source of truth for both. */
export function computeFinalStatus(row: Order): string {
  const status = (row.order_status || '').toLowerCase();
  if (status === 'cancelled') return 'None';
  const delivery = parseFloat(String(row.delivery_charge)) || 0;
  if (status === 'delivered' && delivery > 0) return 'OK';
  if (status === 'returned' && delivery > 0 && (row.piece_received || '').trim() === 'Received') return 'OK';
  return 'Warning';
}

/** Net profit for one order row: total - (delivery + tax + cost), or -delivery for a returned
 * order. null when not applicable. */
export function computeNetProfit(row: Order): number | null {
  const status = (row.order_status || '').toLowerCase();
  const delivery = parseFloat(String(row.delivery_charge)) || 0;
  if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
  if (status === 'returned') return -delivery;
  const total = parseFloat(String(row.total_amount)) || 0;
  const tax = parseFloat(String(row.tax_amount)) || 0;
  const cost = parseFloat(String(row.cost_price)) || 0;
  return total - (delivery + tax + cost);
}

/** Amount the courier still owes for one order: total - (advance + delivery + tax), or
 * -delivery for a returned order. null when not delivered/returned or no delivery_charge yet. */
export function computeReceivable(row: Order): number | null {
  const status = (row.order_status || '').toLowerCase();
  const delivery = parseFloat(String(row.delivery_charge)) || 0;
  if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
  if (status === 'returned') return -delivery;
  const total = parseFloat(String(row.total_amount)) || 0;
  const advance = parseFloat(String(row.advance_amount)) || 0;
  const tax = parseFloat(String(row.tax_amount)) || 0;
  return total - (advance + delivery + tax);
}

/** True when an order can produce a printable airway bill - both couriers need only a
 * tracking number; the airway bill itself is always fetched live from the backend. */
export function orderHasAirwayBill(order: Order | null | undefined): boolean {
  if (!order) return false;
  const courier = getCourierDisplayName(order);
  return (courier === 'PostEx' || courier === 'Couriers Next') && !!order.tracking_number;
}

/** Maps an order's advance_status code to a colored indicator + tooltip. Codes kept in
 * sync with backend app/advance_status.py. */
export function advanceStatusMeta(status: unknown): { color: string; title: string } {
  switch (Number(status)) {
    case 2: return { color: '#f59e0b', title: 'Shopify advance, no transaction entry' };
    case 3: return { color: '#3b82f6', title: 'Transaction entry, no Shopify advance' };
    case 4: return { color: '#22c55e', title: 'Advance matches (Shopify & transaction, within Rs. 5)' };
    case 5: return { color: '#ef4444', title: 'Advance mismatch (Shopify vs transaction differ by Rs. 5+)' };
    default: return { color: '#d1d5db', title: 'No advance amount' };
  }
}
