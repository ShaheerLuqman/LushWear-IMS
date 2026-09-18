// Orders data loading: period-scoped fetches, "Recent Orders", custom date
// range, and the per-period localStorage cache that paints stale rows
// immediately while a fresh fetch is in flight. Ported from data-api.js.
import { useCallback, useRef, useState } from 'react';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import type { Order } from '../../logic/orders';
import { getPKTDate } from '../../logic/shared';

export const ALL_ORDERS_VALUE = '__all__';
export const CUSTOM_ORDERS_VALUE = '__custom__';
const ORDERS_PERIOD_OLDEST_MONTH = 10;
const ORDERS_PERIOD_OLDEST_YEAR = 2024;
const ORDERS_CACHE_KEY_PREFIX = 'lushwear_orders_cache_';
const ORDERS_FETCH_RETRIES = 3;
const ORDERS_FETCH_RETRY_DELAY_MS = 5000;

// Period = fiscalMonthStartDay of one month to (fiscalMonthStartDay - 1) of the next -
// same as backend (app/fiscal_settings.py).
function getPeriodForDate(date: Date | null, fiscalMonthStartDay: number): { month: number; year: number } | null {
  if (!date || isNaN(date.getTime())) return null;
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  if (day >= fiscalMonthStartDay) return { month, year };
  if (month === 1) return { month: 12, year: year - 1 };
  return { month: month - 1, year };
}

function ordersPeriodStartEnd(month: number, year: number, fiscalMonthStartDay: number) {
  const start = new Date(year, month - 1, fiscalMonthStartDay, 0, 0, 0);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = new Date(nextYear, nextMonth - 1, fiscalMonthStartDay - 1, 23, 59, 59);
  return { start, end };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatOrdersPeriodLabel(month: number, year: number, fiscalMonthStartDay: number): string {
  const { end } = ordersPeriodStartEnd(month, year, fiscalMonthStartDay);
  return `${MONTH_NAMES[month - 1]} ${fiscalMonthStartDay} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

export function formatOrdersDateRangeLabel(fromYyyyMmDd: string, toYyyyMmDd: string): string {
  const [fy, fm, fd] = fromYyyyMmDd.split('-').map(Number);
  const [ty, tm, td] = toYyyyMmDd.split('-').map(Number);
  const from = fy === ty ? `${MONTH_NAMES[fm - 1]} ${fd}` : `${MONTH_NAMES[fm - 1]} ${fd}, ${fy}`;
  return `${from} – ${MONTH_NAMES[tm - 1]} ${td}, ${ty}`;
}

export function getCurrentOrdersPeriod(fiscalMonthStartDay: number): { month: number; year: number } {
  return getPeriodForDate(getPKTDate(), fiscalMonthStartDay)!;
}

export interface PeriodOption {
  value: string;
  label: string;
}

export function buildStaticPeriodOptions(fiscalMonthStartDay: number): PeriodOption[] {
  const options: PeriodOption[] = [];
  let { month, year } = getCurrentOrdersPeriod(fiscalMonthStartDay);
  while (year > ORDERS_PERIOD_OLDEST_YEAR || (year === ORDERS_PERIOD_OLDEST_YEAR && month >= ORDERS_PERIOD_OLDEST_MONTH)) {
    options.push({ value: `${month}-${year}`, label: formatOrdersPeriodLabel(month, year, fiscalMonthStartDay) });
    if (month === 1) { month = 12; year -= 1; } else { month -= 1; }
  }
  return options;
}

export interface DateRange {
  from: string;
  to: string;
}

export function useOrdersData() {
  const { account } = useAuth();
  const currentOrgId = account?.org_id || null;
  const { showToast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedPeriodKeyRef = useRef<string | null>(null);

  function cacheKey(periodKey: string): string | null {
    return currentOrgId ? `${ORDERS_CACHE_KEY_PREFIX}${currentOrgId}_${periodKey}` : null;
  }

  function saveCache(periodKey: string, rows: Order[]) {
    const key = cacheKey(periodKey);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(rows)); } catch { /* ignore */ }
  }

  const hasCachedOrders = useCallback((periodKey: string): boolean => {
    const key = cacheKey(periodKey);
    return !!key && localStorage.getItem(key) != null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrgId]);

  function hydrateFromCache(periodKey: string) {
    if (periodKey === loadedPeriodKeyRef.current) return;
    const key = cacheKey(periodKey);
    if (!key) return;
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (!Array.isArray(cached)) return;
      setOrders(cached);
      loadedPeriodKeyRef.current = periodKey;
    } catch { /* ignore */ }
  }

  const fetchForPeriodKey = useCallback(async (periodKey: string, url: string, fallback: string) => {
    hydrateFromCache(periodKey);
    setLoading(true);
    for (let attempt = 1; attempt <= ORDERS_FETCH_RETRIES; attempt++) {
      try {
        const rows = await apiJson<Order[]>(url, { fallback });
        setOrders(rows);
        loadedPeriodKeyRef.current = periodKey;
        saveCache(periodKey, rows);
        setLoading(false);
        return;
      } catch (error) {
        if (attempt === ORDERS_FETCH_RETRIES) {
          setLoading(false);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, ORDERS_FETCH_RETRY_DELAY_MS));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrgId]);

  const loadAllOrders = useCallback(async () => {
    try {
      await fetchForPeriodKey(ALL_ORDERS_VALUE, '/orders/', 'Failed to fetch orders');
    } catch (error: any) {
      console.error('Error loading all orders:', error);
      showToast('Failed to load orders', 'error');
    }
  }, [fetchForPeriodKey, showToast]);

  const loadOrdersForPeriod = useCallback(async (month: number, year: number) => {
    try {
      await fetchForPeriodKey(`${month}-${year}`, `/orders/?month=${month}&year=${year}`, 'Failed to fetch orders for period');
    } catch (error: any) {
      console.error('Error loading orders for period:', error);
      showToast('Failed to load orders for period', 'error');
    }
  }, [fetchForPeriodKey, showToast]);

  const loadOrdersForDateRange = useCallback(async (from: string, to: string) => {
    try {
      const params = new URLSearchParams();
      if (from) params.append('date_from', from);
      if (to) params.append('date_to', to);
      await fetchForPeriodKey(`${CUSTOM_ORDERS_VALUE}-${from}-${to}`, `/orders/?${params}`, 'Failed to fetch orders for date range');
    } catch (error: any) {
      console.error('Error loading orders for date range:', error);
      showToast('Failed to load orders for date range', 'error');
    }
  }, [fetchForPeriodKey, showToast]);

  return {
    orders,
    setOrders,
    loading,
    hasCachedOrders,
    loadAllOrders,
    loadOrdersForPeriod,
    loadOrdersForDateRange,
  };
}
