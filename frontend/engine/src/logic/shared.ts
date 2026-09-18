// Small pure helpers used across pages/grids. Ported from utils.js /
// orders-grid.js - unchanged behavior, just TypeScript.

/** Escape for both text and double-quoted attribute contexts - used inside AG Grid
 * cellRenderer functions that return raw HTML strings (AG Grid Community accepts a
 * plain string-returning function as a cellRenderer, React component or not). */
export function escapeHtml(text: unknown): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML.replace(/"/g, '&quot;');
}

export function formatAmount(value: unknown): string {
  const val = parseFloat(value as string);
  const safeVal = Number.isNaN(val) ? 0 : val;
  return safeVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Show Fedex as TCS in the app. */
export function formatCourierForDisplay(courier: unknown): string {
  if (courier == null || String(courier).trim() === '') return courier as string;
  if (String(courier).trim().toLowerCase() === 'fedex') return 'TCS';
  return String(courier);
}

/** When courier is "Other" and tracking_number is not purely numeric, show tracking_number
 * in the Courier column. Fedex is shown as TCS. */
export function getCourierDisplayName(order: { courier?: string; tracking_number?: string } | null | undefined): string {
  if (!order) return '-';
  const courier = order.courier != null ? String(order.courier).trim() : '';
  const tracking = order.tracking_number != null ? String(order.tracking_number).trim() : '';
  const isOther = courier.toLowerCase() === 'other';
  const trackingIsNotNumeric = tracking !== '' && !/^\d+$/.test(tracking);
  if (isOther && trackingIsNotNumeric) return tracking;
  const raw = courier || '-';
  if (raw === '-') return raw;
  return formatCourierForDisplay(raw) || '-';
}

export function getPKTDate(): Date {
  // Pakistan Standard Time is UTC+5
  const now = new Date();
  const pktOffset = 5 * 60;
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + pktOffset * 60000);
}

export function getPKTDateString(): string {
  const pkt = getPKTDate();
  const year = pkt.getFullYear();
  const month = String(pkt.getMonth() + 1).padStart(2, '0');
  const day = String(pkt.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** DD/MM/YYYY - accepts Date, ISO string, or YYYY-MM-DD string. */
export function formatDateDDMMYYYY(value: unknown): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value as string);
  if (isNaN(d.getTime())) return String(value || '').slice(0, 10);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/** DD/MM/YYYY, HH:MM - accepts Date or ISO string. */
export function formatDateTimeDDMMYYYY(value: unknown): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value as string);
  if (isNaN(d.getTime())) return String(value || '');
  const datePart = formatDateDDMMYYYY(d);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${datePart}, ${hours}:${minutes}`;
}

/** Parse DD/MM/YYYY or D/M/YYYY string to YYYY-MM-DD. Returns null if invalid. */
export function parseDDMMYYYYToYYYYMMDD(str: unknown): string | null {
  if (str == null || typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[/\-.]/);
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function formatRelativeTime(timestampMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
