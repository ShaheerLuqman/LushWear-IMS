import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, InlineStack, Text } from '@shopify/polaris';
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, ChevronRightIcon } from '@shopify/polaris-icons';
import { apiJson } from '../../api';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { formatAmount, formatDateDDMMYYYY } from '../../logic/shared';
import {
  CREDIT_NORMAL_TYPES, formatBalanceWithSide, LEDGER_VOUCHER_LABELS, withLedgerMonthRows,
  type Ledger, type LedgerMonthRow, type LedgerStatementEntry,
} from '../../logic/ledgers';

type StatementEntry = LedgerStatementEntry & { balance: number; monthBalance: number };
type StatementRow = StatementEntry | LedgerMonthRow;
const isMonthRow = (r: StatementRow): r is LedgerMonthRow => (r as LedgerMonthRow).month_row === true;

function formatTransactionCell(value: unknown): string {
  if (value == null || value === '' || value === 0) return '';
  return formatAmount(value);
}

function ParticularsCell({ entry }: { entry: LedgerStatementEntry }) {
  const navigate = useNavigate();
  const canGoTo = (entry.source_type === 'transaction_entry' || entry.source_type === 'bill') && !!entry.source_id;
  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <span>{entry.particulars || ''}</span>
      {canGoTo && (
        <Button
          icon={ArrowRightIcon} variant="tertiary" size="micro" accessibilityLabel={entry.source_type === 'bill' ? 'Go to bill' : 'Go to transaction'}
          onClick={() => {
            if (entry.source_type === 'transaction_entry') navigate('/transactions', { state: { focusDate: entry.entry_date, focusId: entry.source_id } });
            else navigate('/bills', { state: { focusId: entry.source_id } });
          }}
        />
      )}
    </InlineStack>
  );
}

export function LedgerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [entries, setEntries] = useState<LedgerStatementEntry[]>([]);
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [ledgerData, rawEntries] = await Promise.all([
          apiJson<Ledger>(`/ledgers/${id}`, { fallback: 'Failed to load ledger' }),
          apiJson<LedgerStatementEntry[]>(`/ledgers/${id}/entries`, { fallback: 'Failed to load ledger entries' }),
        ]);
        if (cancelled) return;
        setLedger(ledgerData);
        const normalized = rawEntries.map((e) => ({ ...e, entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : '' }));
        setEntries(normalized);
        // Only the current month starts expanded; every other month collapses by default.
        const currentMonth = new Date().toISOString().slice(0, 7);
        setCollapsedMonths(new Set(normalized.map((e) => (e.entry_date || '').slice(0, 7)).filter((m) => m && m !== currentMonth)));
      } catch (error) {
        console.error('Error loading ledger:', error);
        navigate('/ledgers');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, navigate]);

  // New Balance = Previous Balance + Debit - Credit, the same for every ledger regardless
  // of Nature. No synthetic opening-balance row: it's a real journal line, so it arrives
  // like any other row. Rows are already ordered by the get_ledger_statement RPC.
  const rowsWithBalance = useMemo(() => {
    let running = 0, monthRunning = 0, prevMonth = '';
    return entries.map((entry) => {
      const month = (entry.entry_date || '').slice(0, 7);
      if (month !== prevMonth) { monthRunning = 0; prevMonth = month; }
      const debit = parseFloat(String(entry.debit)) || 0;
      const credit = parseFloat(String(entry.credit)) || 0;
      running += debit - credit;
      monthRunning += debit - credit;
      return { ...entry, debit, credit, balance: running, monthBalance: monthRunning };
    });
  }, [entries]);

  const monthRows = useMemo(
    () => withLedgerMonthRows([...rowsWithBalance].reverse(), collapsedMonths),
    [rowsWithBalance, collapsedMonths],
  );

  function toggleMonth(month: string) {
    setCollapsedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month); else next.add(month);
      return next;
    });
  }

  const balanceTone = (val: number) => {
    if (!val) return undefined;
    const isBad = CREDIT_NORMAL_TYPES.includes(ledger?.type || '') ? val > 0 : val < 0;
    return isBad ? 'critical' as const : undefined;
  };
  const entry = (r: StatementRow) => r as StatementEntry;
  const balanceCell = (r: StatementRow, value: number) => (
    <Text as="span" tone={balanceTone(value)} fontWeight={isMonthRow(r) ? 'semibold' : undefined}>{formatBalanceWithSide(value)}</Text>
  );
  const columns: DataColumn<StatementRow>[] = [
    {
      key: 'entry_date', heading: 'Date',
      render: (r) => (isMonthRow(r) ? (
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Button icon={r.collapsed ? ChevronRightIcon : ChevronDownIcon} variant="tertiary" size="micro" accessibilityLabel={r.collapsed ? 'Expand month' : 'Collapse month'} onClick={() => toggleMonth(r.month)} />
          <Text as="span" variant="headingXs">{r.label}</Text>
        </InlineStack>
      ) : entry(r).entry_date ? formatDateDDMMYYYY(entry(r).entry_date!) : ''),
    },
    { key: 'particulars', heading: 'Particulars', render: (r) => (isMonthRow(r) ? '' : <ParticularsCell entry={entry(r)} />) },
    { key: 'voucher_type', heading: 'Type', render: (r) => (isMonthRow(r) ? '' : LEDGER_VOUCHER_LABELS[entry(r).voucher_type || ''] || entry(r).voucher_type || '') },
    { key: 'debit', heading: 'Debit (Rs)', alignment: 'end', render: (r) => (isMonthRow(r) ? '' : formatTransactionCell(entry(r).debit)) },
    { key: 'credit', heading: 'Credit (Rs)', alignment: 'end', render: (r) => (isMonthRow(r) ? '' : formatTransactionCell(entry(r).credit)) },
    { key: 'month_balance', heading: 'Month Balance (Rs)', alignment: 'end', render: (r) => balanceCell(r, isMonthRow(r) ? r.balance : entry(r).monthBalance) },
    { key: 'balance', heading: 'Balance (Rs)', alignment: 'end', render: (r) => balanceCell(r, isMonthRow(r) ? r.runningBalance : entry(r).balance) },
  ];

  usePageHeader({
    title: ledger?.name || 'Ledger',
    actions: <Button icon={ArrowLeftIcon} onClick={() => navigate('/ledgers')}>Back to Ledgers</Button>,
  });

  return (
    <DataTable
      columns={columns} rows={monthRows as StatementRow[]} rowId={(r) => r.id} loading={loading}
      resourceName={{ singular: 'entry', plural: 'entries' }} emptyMessage="No entries yet"
      rowTone={(r) => (isMonthRow(r) ? 'subdued' : undefined)}
    />
  );
}
