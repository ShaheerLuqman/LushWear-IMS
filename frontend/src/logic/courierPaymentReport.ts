// Courier Payment Report business logic - ported 1:1 from courier-payment-report.js.
import { formatDateDDMMYYYY, formatCourierForDisplay } from './shared';

export interface CourierBillOrder {
  id: string; order_number?: number; folio?: string; tracking_number?: string; order_status?: string;
  total_amount?: number; advance_amount?: number; delivery_charge?: number; tax_amount?: number; cost_price?: number;
  is_order_settled?: boolean;
}

export interface CourierBill {
  id: string; courier: string; pickupDate: Date; pickupDateKey: string; workflowStatus?: string; notes?: string;
  totalOrders: number; inTransitCount: number; inTransitByStatus: Record<string, number>; resolvedCount: number;
  settledCount: number; billValue: number; advanceTotal: number; grossCod: number; charges: number; taxes: number;
  costTotal: number; returnedTotal: number; netReceivable: number; receivedAmount: number; remainingAmount: number;
  status: string; orders: CourierBillOrder[] | null;
}

export function mapCourierBillRow(row: any): CourierBill {
  return {
    id: row.id, courier: row.courier, pickupDate: new Date(`${row.pickup_date}T00:00:00`), pickupDateKey: row.pickup_date,
    workflowStatus: row.workflow_status, notes: row.notes, totalOrders: row.total_orders, inTransitCount: row.in_transit_count,
    inTransitByStatus: row.in_transit_by_status || {}, resolvedCount: row.resolved_count, settledCount: row.settled_count,
    billValue: row.bill_value, advanceTotal: row.advance_total, grossCod: row.gross_cod, charges: row.charges, taxes: row.taxes,
    costTotal: row.cost_total, returnedTotal: row.returned_total, netReceivable: row.net_receivable,
    receivedAmount: row.received_amount, remainingAmount: row.remaining_amount, status: row.payment_status, orders: null,
  };
}

export function billPickupDateLabel(bill: CourierBill): string {
  return formatDateDDMMYYYY(bill.pickupDate);
}
export function billCourierLabel(bill: CourierBill): string {
  return formatCourierForDisplay(bill.courier) as string;
}

export const BILL_STATUS_META: Record<string, { label: string; cls: string; barColor: string }> = {
  in_transit: { label: 'In Transit', cls: 'grid-status-unfulfilled', barColor: '#7c3aed' },
  paid: { label: 'Paid', cls: 'grid-status-delivered', barColor: '#16a34a' },
  partially_paid: { label: 'Partially Paid', cls: 'grid-status-fulfilled', barColor: '#ca8a04' },
  unpaid: { label: 'Unpaid', cls: 'grid-status-returned', barColor: '#dc2626' },
};

export const PAYMENT_PROGRESS_COLORS = { received: '#16a34a', returned: '#dc2626', charges: '#f59e0b', taxes: '#0ea5e9', remaining: '#7c3aed' };

export const COURIER_PAYMENT_STATUSES = ['paid', 'partially_paid', 'unpaid', 'in_transit'];
export const COURIER_PAYMENT_STATUS_LABELS: Record<string, string> = { paid: 'Paid', partially_paid: 'Partially Paid', unpaid: 'Unpaid', in_transit: 'In Transit' };

export const COURIER_RESOLVED_STATUSES = new Set(['delivered', 'returned']);

/** Cash-on-delivery for one order: total minus advance, for every order regardless of
 * status - unlike computeReceivable, doesn't wait for a final delivered/returned outcome. */
export function computeCod(order: { total_amount?: number; advance_amount?: number }): number {
  return (parseFloat(String(order.total_amount)) || 0) - (parseFloat(String(order.advance_amount)) || 0);
}

export interface CourierBillsSummary { inTransit: number; resolved: number; netOwed: number; inTransitByStatus: Record<string, number> }

export function courierPaymentReportSummary(bills: CourierBill[]): CourierBillsSummary {
  let inTransit = 0, resolved = 0, netOwed = 0;
  const inTransitByStatus: Record<string, number> = {};
  bills.forEach((bill) => {
    inTransit += bill.inTransitCount;
    resolved += bill.resolvedCount;
    netOwed += bill.remainingAmount;
    Object.entries(bill.inTransitByStatus).forEach(([status, count]) => { inTransitByStatus[status] = (inTransitByStatus[status] || 0) + count; });
  });
  return { inTransit, resolved, netOwed: Math.round(netOwed * 100) / 100, inTransitByStatus };
}

export interface PaymentProgressStats {
  billValue: number; received: number; returned: number; charges: number; taxes: number; remaining: number;
  pct: number; receivedPct: number; returnedPct: number; chargesPct: number; taxesPct: number; remainingPct: number;
}

/** Payment Progress tracks Bill Value against four claims on it. Each ratio is clamped
 * independently, so in an edge case the segments can visually overrun 100% rather than
 * silently under-report. */
export function paymentProgressStats(bill: CourierBill): PaymentProgressStats {
  const { billValue, receivedAmount: received, returnedTotal: returned, charges, taxes } = bill;
  const accountedFor = received + returned + charges + taxes;
  const remaining = Math.max(0, billValue - accountedFor);
  const ratio = (amount: number) => (billValue > 0 ? Math.max(0, Math.min(100, Math.round((amount / billValue) * 100))) : 0);
  return {
    billValue, received, returned, charges, taxes, remaining, pct: ratio(accountedFor),
    receivedPct: ratio(received), returnedPct: ratio(returned), chargesPct: ratio(charges), taxesPct: ratio(taxes), remainingPct: ratio(remaining),
  };
}

/** Cumulative conic-gradient stops for the detail screen's pie, computed from running
 * totals so the slices always add up to exactly one full circle. */
export function paymentProgressPieStops(stats: PaymentProgressStats) {
  const { billValue, received, returned, charges, taxes } = stats;
  const pct = (amount: number) => (billValue > 0 ? (amount / billValue) * 100 : 0);
  const receivedEnd = Math.min(100, pct(received));
  const returnedEnd = Math.min(100, receivedEnd + pct(returned));
  const chargesEnd = Math.min(100, returnedEnd + pct(charges));
  const taxesEnd = Math.min(100, chargesEnd + pct(taxes));
  return { receivedEnd, returnedEnd, chargesEnd, taxesEnd };
}
