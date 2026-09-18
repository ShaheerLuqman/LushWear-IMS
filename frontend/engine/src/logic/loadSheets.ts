// Load sheet log helpers - ported 1:1 from orders-actions.js.
export interface LoadSheetLog {
  id: string;
  assignment_number?: string;
  rider_name?: string;
  created_at?: string;
  order_numbers?: Array<string | number>;
  cancelled_order_numbers?: Array<string | number>;
  delivery_charge?: number | string | null;
}

const MONTH_ABBREV = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function loadSheetFilenameFromDateAndRider(date: Date | string, riderName?: string): string {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getDate();
  const month = MONTH_ABBREV[d.getMonth()] || 'Jan';
  const year = d.getFullYear();
  const rider = (riderName || 'LoadSheet').replace(/\s+/g, '_').replace(/[/\\:*?"<>|]/g, '');
  return `${day}_${month}_${year}_${rider}.pdf`;
}

export function riderNamesFromLogs(logs: LoadSheetLog[]): string[] {
  const names = new Set<string>();
  logs.forEach((log) => {
    const name = typeof log.rider_name === 'string' ? log.rider_name.trim() : '';
    if (name) names.add(name);
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function nextAssignmentNumberFromLogs(logs: LoadSheetLog[]): number {
  let max = 0;
  logs.forEach((log) => {
    const an = log.assignment_number;
    if (typeof an === 'string') {
      const m = an.trim().match(/^LW-(\d+)$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  });
  return max + 1;
}

export function parseOrderNumbersFromText(text: string): string[] {
  const raw = (text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(raw)].sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}
