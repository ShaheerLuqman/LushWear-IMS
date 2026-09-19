// Month Summary: cards grouped by year, one per fiscal period. Ported from
// sync-summary.js's loadMonthSummaryList/displayMonthSummaryCards.
import { useEffect, useState } from 'react';
import { Badge, BlockStack, Card, InlineGrid, InlineStack, Spinner, Text } from '@shopify/polaris';
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

  usePageHeader({ title: 'Month Summary' });

  if (!months) return <div className="page-loading"><Spinner size="small" /><Text as="span" tone="subdued">Loading months...</Text></div>;
  if (months.length === 0) return <Text as="p" tone="subdued">No month data available</Text>;

  const byYear = new Map<number, MonthSummaryRow[]>();
  for (const m of months) {
    if (!byYear.has(m.year)) byYear.set(m.year, []);
    byYear.get(m.year)!.push(m);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);

  return (
    <BlockStack gap="600">
      {years.map((year) => (
        <BlockStack gap="300" key={year}>
          <Text as="h2" variant="headingMd">{String(year)}</Text>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 4 }} gap="300">
            {byYear.get(year)!.map((month) => {
              const warningCount = month.warning_orders_count || 0;
              const totalOrders = month.total_orders || 0;
              const completedCount = month.completed_orders_count || 0;
              return (
                <div className="card-link" key={`${month.month}-${month.year}`} role="link" tabIndex={0} onClick={() => navigate(`/month-summary/${month.month}-${month.year}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/month-summary/${month.month}-${month.year}`); }}>
                  <Card>
                    <BlockStack gap="200">
                      <BlockStack gap="050">
                        <Text as="h3" variant="headingSm">{MONTH_NAMES[month.month - 1]} {month.year}</Text>
                        <Text as="span" tone="subdued" variant="bodySm">{formatOrdersPeriodLabel(month.month, month.year, fiscalMonthStartDay)}</Text>
                      </BlockStack>
                      <InlineStack gap="200">
                        <Badge tone="success">{`${completedCount}/${totalOrders} completed`}</Badge>
                        {warningCount > 0 && <Badge tone="warning">{`${warningCount} on warning`}</Badge>}
                      </InlineStack>
                    </BlockStack>
                  </Card>
                </div>
              );
            })}
          </InlineGrid>
        </BlockStack>
      ))}
    </BlockStack>
  );
}
