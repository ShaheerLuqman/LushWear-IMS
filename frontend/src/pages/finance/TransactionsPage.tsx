// Transactions: one day's entries grid, day navigation, Cash In Hand, and the
// create-entry modal. Ported from transactions.js + ledgers.js's Cash In Hand bits.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { Box, ButtonGroup, Popover } from '@shopify/polaris';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from '@shopify/polaris-icons';
import { HeaderButton } from '../../components/HeaderButton';
import { DateField } from '../../components/DateField';
import { KeyValueList } from '../../components/KeyValueList';
import { getPKTDateString, rowMatchesQuery } from '../../logic/shared';
import { formatMoney, type LedgerBalancePatch } from '../../logic/ledgers';
import { useLedgersData } from './useLedgersData';
import { DataTable } from '../../components/DataTable';
import { buildTransactionColumns, isTransactionNewRow, type TransactionRow } from './TransactionsGridCells';
import { TransactionEntryModal } from './TransactionEntryModal';
import { CreateLedgerModal } from './LedgerModals';

function emptyRow(entryDate: string): TransactionRow {
  return { id: `__new_${Date.now()}__`, entry_date: entryDate, description: '', from_account_id: null, to_account_id: null, amount: null };
}

function sortedEntries(entries: TransactionRow[]): TransactionRow[] {
  return [...entries].sort((a, b) => {
    const dateA = a.entry_date || '';
    const dateB = b.entry_date || '';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  }).map((e) => ({ ...e, amount: parseFloat(String(e.amount)) || 0 }));
}

export function TransactionsPage() {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const location = useLocation();
  const { ledgers, loadLedgersList, applyLedgerBalancePatches, cashInHand } = useLedgersData();

  const [selectedDate, setSelectedDate] = useState(getPKTDateString());
  const [entries, setEntries] = useState<TransactionRow[]>([]);
  const [newRow, setNewRow] = useState<TransactionRow>(() => emptyRow(getPKTDateString()));
  const [search, setSearch] = useState('');
  const [entryModal, setEntryModal] = useState<'single' | 'bulk' | null>(null);
  const [cashTooltipOpen, setCashTooltipOpen] = useState(false);
  const [createLedgerFor, setCreateLedgerFor] = useState<{ rowId: string; field: 'from_account_id' | 'to_account_id' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [flashRowId, setFlashRowId] = useState<string | null>(null);

  const loadDay = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const data = await apiJson<{ entries: TransactionRow[] }>(`/transactions/day/${date}`, { fallback: 'Failed to load transactions day' });
      setEntries((data.entries || []).map((e) => ({ ...e, entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : '' })));
    } catch (error) {
      console.error('Error loading transactions day:', error);
      showToast('Failed to load transaction entries', 'error');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    // A "Go to transaction" link from a ledger statement lands here with a date/id to focus;
    // a PWA shortcut (see DefaultRedirect) lands with an entry mode to open the modal in.
    const state = location.state as { focusDate?: string; focusId?: string; entryMode?: 'single' | 'bulk' } | null;
    loadLedgersList().then(() => { if (state?.entryMode) setEntryModal(state.entryMode); });
    const initialDate = state?.focusDate || getPKTDateString();
    setSelectedDate(initialDate);
    setNewRow(emptyRow(initialDate));
    loadDay(initialDate).then(() => { if (state?.focusId) setFlashRowId(state.focusId); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeDate(date: string) {
    setSelectedDate(date);
    setNewRow(emptyRow(date));
    loadDay(date);
  }

  function shiftDay(delta: number) {
    const [y, m, d] = selectedDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + delta);
    changeDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  }

  async function onFieldChange(rowId: string, field: string, value: unknown) {
    if (rowId === newRow.id) {
      const next = { ...newRow, [field]: value };
      setNewRow(next);
      const hasAmount = next.amount != null && Number(next.amount) > 0;
      const hasAccount = !!(next.from_account_id || next.to_account_id);
      if (hasAmount && hasAccount) {
        if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
        if (next.from_account_id && next.from_account_id === next.to_account_id) {
          showToast('From and To must be different accounts', 'error', { silent: true });
          return;
        }
        try {
          const created = await apiJson<{ ledger_balances?: LedgerBalancePatch | LedgerBalancePatch[] }>('/transactions/entries', {
            method: 'POST',
            body: {
              idempotency_key: crypto.randomUUID(), entry_date: selectedDate, amount: Number(next.amount),
              description: String(next.description || '').trim(), from_account_id: next.from_account_id || null, to_account_id: next.to_account_id || null,
            },
            fallback: 'Failed to add transaction entry',
          });
          applyLedgerBalancePatches(created.ledger_balances);
          setNewRow(emptyRow(selectedDate));
          showToast('Entry added', 'success');
          await loadDay(selectedDate);
        } catch (error: any) {
          showToast(error?.message || 'Failed to add entry', 'error');
        }
      }
      return;
    }

    const original = entries.find((e) => e.id === rowId);
    setEntries((prev) => prev.map((e) => (e.id === rowId ? { ...e, [field]: value } : e)));
    try {
      const updated = await apiJson<{ ledger_balances?: LedgerBalancePatch | LedgerBalancePatch[] }>(`/transactions/entries/${rowId}`, {
        method: 'PUT', body: { [field]: value }, fallback: 'Failed to update transaction entry',
      });
      applyLedgerBalancePatches(updated.ledger_balances);
      showToast('Entry updated', 'success');
    } catch (error) {
      console.error('Error updating transaction entry:', error);
      if (original) setEntries((prev) => prev.map((e) => (e.id === rowId ? original : e)));
      showToast('Failed to update entry', 'error');
    }
  }

  async function onDeleteRow(rowId: string) {
    const removed = entries.find((e) => e.id === rowId);
    setEntries((prev) => prev.filter((e) => e.id !== rowId));
    try {
      const deleted = await apiJson<{ ledger_balances?: LedgerBalancePatch | LedgerBalancePatch[] }>(`/transactions/entries/${rowId}`, { method: 'DELETE', fallback: 'Failed to delete transaction entry' });
      applyLedgerBalancePatches(deleted.ledger_balances);
      showToast('Entry deleted', 'success');
    } catch (error) {
      console.error('Error deleting transaction entry:', error);
      if (removed) setEntries((prev) => [...prev, removed]);
      showToast('Failed to delete entry', 'error');
    }
  }

  const columns = useMemo(() => buildTransactionColumns({
    ledgers, isEditingAllowed, onFieldChange, onDeleteRow,
    onCreateLedger: (rowId, field) => setCreateLedgerFor({ rowId, field }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ledgers, isEditingAllowed, entries, newRow]);

  const rows = useMemo(() => [...sortedEntries(entries).filter((e) => rowMatchesQuery(e, search)), newRow], [entries, newRow, search]);

  usePageHeader({
    title: 'Transactions',
    search: { value: search, onChange: setSearch },
    actions: (
      <>
        <Popover
          active={cashTooltipOpen} onClose={() => setCashTooltipOpen(false)} preferredAlignment="right"
          activator={<HeaderButton disclosure onClick={() => setCashTooltipOpen((v) => !v)}>{`Available Cash: Rs ${formatMoney(cashInHand.total)}`}</HeaderButton>}
        >
          <Box padding="300" minWidth="260px">
            <KeyValueList rows={[
              { label: 'Cash in hand', value: `Rs ${formatMoney(cashInHand.physicalCashInHand)}` },
              { label: 'Cash in bank ledgers', value: '', kind: 'head' },
              ...(cashInHand.bankLedgerBalances.length === 0
                ? [{ label: 'No ledgers included', value: '' }]
                : cashInHand.bankLedgerBalances.map((b) => ({ label: b.name, value: `Rs ${formatMoney(b.balance)}` }))),
              { label: 'Total', value: `Rs ${formatMoney(cashInHand.total)}`, kind: 'subtotal' },
            ]} />
          </Box>
        </Popover>
        <ButtonGroup variant="segmented">
          <HeaderButton icon={ChevronLeftIcon} accessibilityLabel="Previous day" onClick={() => shiftDay(-1)} />
          <HeaderButton icon={ChevronRightIcon} accessibilityLabel="Next day" onClick={() => shiftDay(1)} />
        </ButtonGroup>
        <DateField label="Day" value={selectedDate} onChange={(v) => { if (v) changeDate(v); }} />
        <HeaderButton onClick={() => changeDate(getPKTDateString())}>Today</HeaderButton>
        <HeaderButton variant="primary" icon={PlusIcon} onClick={() => setEntryModal('single')}>New Transaction</HeaderButton>
      </>
    ),
  });

  return (
    <>
      <DataTable
        columns={columns} rows={rows} rowId={(r) => r.id} loading={loading} flashRowId={flashRowId}
        rowTone={(r) => (isTransactionNewRow(r.id) ? 'subdued' : undefined)}
        resourceName={{ singular: 'entry', plural: 'entries' }} emptyMessage="No entries on this day"
      />
      {entryModal && (
        <TransactionEntryModal
          ledgers={ledgers}
          initialMode={entryModal}
          entryDate={selectedDate}
          onClose={() => setEntryModal(null)}
          onLedgersChanged={loadLedgersList}
          onDone={async (patches) => {
            applyLedgerBalancePatches(patches);
            setEntryModal(null);
            await loadDay(selectedDate);
          }}
        />
      )}
      {createLedgerFor && (
        <CreateLedgerModal
          ledgers={ledgers}
          onClose={() => setCreateLedgerFor(null)}
          onCreated={(created) => {
            loadLedgersList();
            onFieldChange(createLedgerFor.rowId, createLedgerFor.field, created.id);
            setCreateLedgerFor(null);
          }}
        />
      )}
    </>
  );
}
