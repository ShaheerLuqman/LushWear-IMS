// Month Summary: cards grouped by year, one per fiscal period. Ported from
// sync-summary.js's loadMonthSummaryList/displayMonthSummaryCards.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { formatOrdersPeriodLabel } from '../orders/useOrdersData';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface MonthSummaryRow {
  month: number; year: number; total_orders?: number; completed_orders_count?: number; warning_orders_count?: number;
}

export function MonthSummaryPage() {
  const { account } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [months, setMonths] = useState<MonthSummaryRow[] | null>(null);
  const fiscalMonthStartDay = account?.fiscal_month_start_day || 22;

  useEffect(() => {
    (async () => {
      try {
        setMonths(await apiJson<MonthSummaryRow[]>('/orders/month-summary/list', { fallback: 'Failed to fetch month summary list' }));
      } catch (error) {
        console.error('Error loading month summary list:', error);
        showToast('Failed to load month summaries', 'error');
        setMonths([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePageHeader({ title: 'Finance' });

  if (!months) return null;
  if (months.length === 0) return <div className="no-data-message">No month data available</div>;

  const byYear = new Map<number, MonthSummaryRow[]>();
  for (const m of months) {
    if (!byYear.has(m.year)) byYear.set(m.year, []);
    byYear.get(m.year)!.push(m);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);

  return (
    <div className="month-summary-container">
      <div className="month-summary-cards">
        {years.map((year) => (
          <section className="month-summary-year-section" key={year}>
            <h2 className="month-summary-year-heading">{year}</h2>
            <div className="month-summary-cards-in-section">
              {byYear.get(year)!.map((month) => {
                const warningCount = month.warning_orders_count || 0;
                const totalOrders = month.total_orders || 0;
                const completedCount = month.completed_orders_count || 0;
                return (
                  <div className="month-summary-card" key={`${month.month}-${month.year}`} onClick={() => navigate(`/month-summary/${month.month}-${month.year}`)}>
                    <div className="month-summary-card-header">
                      <h3 className="month-summary-card-title">{MONTH_NAMES[month.month - 1]} {month.year}</h3>
                      <span className="month-summary-card-period">{formatOrdersPeriodLabel(month.month, month.year, fiscalMonthStartDay)}</span>
                    </div>
                    <div className="month-summary-card-body">
                      <span className="month-summary-card-completed"><i className="fa-solid fa-circle-check" /> {completedCount}/{totalOrders} completed</span>
                      {warningCount > 0 && <span className="month-summary-card-warning"><i className="fa-solid fa-triangle-exclamation" /> {warningCount} on warning</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
