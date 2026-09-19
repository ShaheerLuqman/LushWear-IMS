// Shared by Product Analytics and City Analytics - both read from a get_*_analytics
// RPC that aggregates the picked range plus the equal-length window before it, and
// both use the same time-preset set (deliberately not the shared buildDateRangePresets
// in DateRangePopover.tsx - these presets end "yesterday" for last7/last30 since today's
// figures are still accumulating, and keep "Maximum"/"This week" wording).
import { getPKTDate } from './shared';

export interface TimePreset { key: string; label: string; }

export const ANALYTICS_OLDEST = new Date(2024, 9, 22); // 22 Oct 2024
export const ANALYTICS_TIME_PRESETS: TimePreset[] = [
  { key: 'max', label: 'All Time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'thisMonth', label: 'This month' },
];

export function analyticsToday(): Date {
  const d = getPKTDate();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
export function analyticsIsoDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
export function analyticsShortDate(date: Date, withYear?: boolean): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
}

export interface CustomRange { start: string; end: string }

export function analyticsRangeDates(key: string, custom: CustomRange): [Date, Date] {
  const today = analyticsToday();
  switch (key) {
    case 'max': return [ANALYTICS_OLDEST, today];
    case 'today': return [today, today];
    case 'yesterday': { const y = addDays(today, -1); return [y, y]; }
    case 'last7': return [addDays(today, -7), addDays(today, -1)];
    case 'last30': return [addDays(today, -30), addDays(today, -1)];
    case 'thisWeek': { const dow = (today.getDay() + 6) % 7; return [addDays(today, -dow), today]; }
    case 'thisMonth': return [new Date(today.getFullYear(), today.getMonth(), 1), today];
    case 'custom': {
      const s = custom.start ? new Date(`${custom.start}T00:00:00`) : addDays(today, -30);
      const e = custom.end ? new Date(`${custom.end}T00:00:00`) : today;
      return s <= e ? [s, e] : [e, s];
    }
    default: return [new Date(today.getFullYear(), today.getMonth(), 1), today];
  }
}

export function analyticsRangeLabel(key: string, custom: CustomRange): string {
  if (key === 'custom' && (!custom.start || !custom.end)) return 'Custom date range';
  const [start, end] = analyticsRangeDates(key, custom);
  const preset = ANALYTICS_TIME_PRESETS.find((p) => p.key === key);
  const sameDay = analyticsIsoDate(start) === analyticsIsoDate(end);
  const withYear = key === 'max' || start.getFullYear() !== end.getFullYear();
  const range = sameDay ? analyticsShortDate(start, withYear) : `${analyticsShortDate(start, withYear)} – ${analyticsShortDate(end, withYear)}`;
  return preset ? `${preset.label} (${range})` : range;
}

export function analyticsComparisonWord(key: string): string {
  return ({ thisMonth: 'vs last month', today: 'vs yesterday', yesterday: 'vs day before', thisWeek: 'vs last week' } as Record<string, string>)[key]
    || 'vs previous period';
}

export const analyticsN = (n: number) => Math.round(n || 0).toLocaleString('en-US');
export const analyticsPct = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

// For fixed-size spots (donut center, stat tiles) where a big total would otherwise overflow.
export function analyticsCompactN(n: number): string {
  const v = Math.round(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `${Math.round(v / 1_000).toLocaleString('en-US')}K`;
  return v.toLocaleString('en-US');
}

export interface DeltaInfo { dir: 'up' | 'down' | 'flat' | 'new'; text: string }

export function analyticsDelta(cur: number, prev: number, hasPrev: boolean): DeltaInfo | null {
  if (!hasPrev || (prev === 0 && cur === 0)) return null;
  if (prev === 0) return { dir: 'new', text: 'new' };
  const pct = ((cur - prev) / prev) * 100;
  const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  return { dir, text: `${Math.abs(pct).toFixed(1)}%` };
}
