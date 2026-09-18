// Delivery status derivation - ported 1:1 from utils.js/delivery-status.js.
import type { Order } from './orders';

export interface DeliveryStatusHistoryItem { status?: string; datetime?: string; status_code?: string; is_active?: boolean }
export interface DeliveryStatusData {
  courier?: string; tracking_number?: string; latest_status?: string; status_history?: DeliveryStatusHistoryItem[];
  recipient_name?: string; recipient_contact?: string; order_pickup_date?: string;
}

/** Merge freshly-fetched delivery status onto whatever was on file - an empty
 * status_history from the API must not blow away history already on record. */
export function mergeDeliveryStatusData(previous: DeliveryStatusData | null | undefined, incoming: DeliveryStatusData): DeliveryStatusData {
  if (incoming && Array.isArray(incoming.status_history) && incoming.status_history.length > 0) return incoming;
  if (previous && Array.isArray(previous.status_history) && previous.status_history.length > 0) {
    return { ...incoming, status_history: previous.status_history };
  }
  return incoming;
}

/* PostEx parks a parcel here after failed attempts and waits for the merchant to say
   retry-or-return. Matched on the history code, not the message. Mirrors backend
   POSTEX_UNDER_REVIEW_CODE. */
const POSTEX_UNDER_REVIEW_CODE = '0008';

export function deliveryStatusIsUnderReview(data: DeliveryStatusData | null | undefined): boolean {
  if (!data) return false;
  const history = data.status_history || [];
  if (history.length > 0) {
    const newest = history.reduce((a, b) => ((b.datetime || '') >= (a.datetime || '') ? b : a));
    return String(newest.status_code || '').trim() === POSTEX_UNDER_REVIEW_CODE;
  }
  return (data.latest_status || '').trim().toLowerCase() === 'delivery under review';
}

function normalizeCourierName(courier: string | undefined): string {
  return (courier || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Return detection is courier-specific. Mirrors backend _classify_status exactly. */
function classifyStatus(statusText: string, courierNormalized: string): string | null {
  if (!statusText) return null;
  const statusLower = statusText.toLowerCase();
  if (courierNormalized === 'postex' && statusLower.includes('en route to merchant warehouse')) return 'returned';
  if ((courierNormalized === 'couriersnext' || courierNormalized === 'couriernext') && statusLower.includes('parcel return to office')) return 'returned';
  if (statusLower.includes('delivered to customer') || (statusLower.includes('delivered') && !statusLower.includes('undelivered'))) return 'delivered';
  if (statusLower.includes('attempt made: rfd')) return 'RFD';
  if (statusLower.includes('attempt made: ica')) return 'ICA';
  if (statusLower.includes('attempt made: cna')) return 'CNA';
  return null;
}

export function deriveOrderStatusFromLatest(data: DeliveryStatusData | null | undefined): string | null {
  if (!data) return null;
  const courierNormalized = normalizeCourierName(data.courier);
  const history = data.status_history || [];
  const sorted = [...history].sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const classified = classifyStatus((sorted[i].status || '').trim(), courierNormalized);
    if (classified) return classified;
  }
  const latest = (data.latest_status || '').trim();
  if (latest) {
    const classified = classifyStatus(latest, courierNormalized);
    if (classified) return classified;
  }
  return null;
}

/** Normalize a Pakistani phone number to E.164 digits (92XXXXXXXXXX, no "+"). */
export function normalizePakPhone(phone: string | null | undefined): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return '92' + digits.slice(1);
  if (digits.startsWith('92')) return digits;
  if (digits.startsWith('3')) return '92' + digits;
  return digits;
}

export interface DeliveryReportEntry { order: Order; note: string; issueType?: string | null; advised?: string }
export interface DeliveryReport {
  delivered: DeliveryReportEntry[]; returned: DeliveryReportEntry[]; unfulfilled: DeliveryReportEntry[];
  transit: DeliveryReportEntry[]; review: DeliveryReportEntry[]; issues: DeliveryReportEntry[]; failed: DeliveryReportEntry[];
}

/** Build the delivery status report for a set of orders from data already on each row. */
export function buildDeliveryStatusReport(selected: Order[]): DeliveryReport {
  const report: DeliveryReport = { delivered: [], returned: [], unfulfilled: [], transit: [], review: [], issues: [], failed: [] };
  for (const row of selected) {
    const status = (row.order_status || '').toLowerCase();
    if (status === 'delivered' || status === 'returned' || status === 'unfulfilled') {
      (report as any)[status].push({ order: row, note: (row.delivery_status as any)?.latest_status || '' });
      continue;
    }
    const derivedStatus = deriveOrderStatusFromLatest(row.delivery_status as any);
    const isIssue = ['CNA', 'ICA', 'RFD'].includes(derivedStatus || '');
    const underReview = deliveryStatusIsUnderReview(row.delivery_status as any);
    const bucket: keyof DeliveryReport = underReview ? 'review' : (isIssue ? 'issues' : ((derivedStatus as keyof DeliveryReport) || 'transit'));
    (report[bucket] || report.transit).push({ order: row, note: (row.delivery_status as any)?.latest_status || '', issueType: isIssue ? derivedStatus : null });
  }
  return report;
}

export const DELIVERY_REPORT_CATEGORIES: Array<{ key: keyof DeliveryReport | 'all'; label: string }> = [
  { key: 'all', label: 'All orders' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'returned', label: 'Returned' },
  { key: 'transit', label: 'In transit' },
  { key: 'review', label: 'Under review' },
  { key: 'issues', label: 'Issues' },
  { key: 'unfulfilled', label: 'Unfulfilled' },
  { key: 'failed', label: 'Fetch failed' },
];

export const SHIPPER_ADVICE_LABELS: Record<string, string> = { retry: 'Reattempt', return: 'Return' };
