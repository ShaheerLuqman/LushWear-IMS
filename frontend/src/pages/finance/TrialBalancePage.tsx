// Trial Balance: every account with a non-zero balance, as at a date, split into
// its Debit or Credit column.
import { useEffect, useState } from 'react';
import { Badge, Text } from '@shopify/polaris';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { DateField } from '../../components/DateField';
import { formatMoney } from '../../logic/ledgers';
import { getPKTDateString } from '../../logic/shared';

interface TrialBalanceRow { account_id: string; code?: string; name: string; type?: string; debit: number; credit: number }
interface TrialBalanceData { rows: TrialBalanceRow[]; total_debit: number; total_credit: number; balanced: boolean }

const num = (v: unknown) => parseFloat(String(v)) || 0;
// Zero on a trial balance means "this account is on the other side", not "zero rupees".
const money = (v: number) => (v ? formatMoney(v) : '');

export function TrialBalancePage() {
  const { showToast } = useToast();
  const [asOf, setAsOf] = useState(getPKTDateString());
  const [data, setData] = useState<TrialBalanceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiJson<TrialBalanceData>(`/journal/trial-balance?as_of=${asOf}`, { fallback: 'Failed to load trial balance' })
      .then((d) => { if (!cancelled) setData({ ...d, rows: (d.rows || []).map((r) => ({ ...r, debit: num(r.debit), credit: num(r.credit) })) }); })
      .catch((error) => { console.error('Error loading trial balance:', error); showToast('Failed to load trial balance', 'error'); if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [asOf, showToast]);

  const difference = data ? num(data.total_debit) - num(data.total_credit) : 0;

  usePageHeader({
    title: 'Trial Balance',
    actions: (
      <>
        <DateField label="As at" prefix="As at" value={asOf} onChange={(v) => setAsOf(v || getPKTDateString())} />
        {data && (data.balanced
          ? <Badge tone="success">Balanced</Badge>
          : <Badge tone="critical">{`Out of balance by Rs ${formatMoney(Math.abs(difference))}`}</Badge>)}
      </>
    ),
  });

  const bold = (v: string) => <Text as="span" fontWeight="semibold">{v}</Text>;
  const columns: DataColumn<TrialBalanceRow>[] = [
    { key: 'code', heading: 'Code', render: (r) => r.code || '', sortValue: (r) => r.code, footer: '' },
    { key: 'name', heading: 'Account', render: (r) => r.name, sortValue: (r) => r.name, footer: bold('Total') },
    { key: 'type', heading: 'Type', render: (r) => r.type || '', sortValue: (r) => r.type, footer: '' },
    { key: 'debit', heading: 'Debit (Rs)', alignment: 'end', render: (r) => money(r.debit), sortValue: (r) => r.debit, footer: bold(money(num(data?.total_debit))) },
    { key: 'credit', heading: 'Credit (Rs)', alignment: 'end', render: (r) => money(r.credit), sortValue: (r) => r.credit, footer: bold(money(num(data?.total_credit))) },
  ];

  return (
    <DataTable
      columns={columns} rows={data?.rows ?? []} rowId={(r) => r.account_id} loading={loading}
      resourceName={{ singular: 'account', plural: 'accounts' }} emptyMessage="No balances as at this date"
    />
  );
}
