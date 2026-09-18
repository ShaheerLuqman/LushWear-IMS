// Transactions: one day's entries grid, day navigation, Cash In Hand, and the
// create-entry modal. Ported from transactions.js + ledgers.js's Cash In Hand bits.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { formatDateDDMMYYYY, getPKTDateString, parseDDMMYYYYToYYYYMMDD } from '../../logic/shared';
import { formatMoney, type LedgerBalancePatch } from '../../logic/ledgers';
import { useLedgersData } from './useLedgersData';
import { buildTransactionColumnDefs, isTransactionNewRow, type TransactionRow } from './TransactionsGridCells';
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
  const [dateInput, setDateInput] = useState(formatDateDDMMYYYY(getPKTDateString()));
  const [entries, setEntries] = useState<TransactionRow[]>([]);
  const [newRow, setNewRow] = useState<TransactionRow>(() => emptyRow(getPKTDateString()));
  const [search, setSearch] = useState('');
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [cashTooltipOpen, setCashTooltipOpen] = useState(false);
  const [createLedgerFor, setCreateLedgerFor] = useState<{ rowId: string; field: 'from_account_id' | 'to_account_id' } | null>(null);

  const gridApiRef = useRef<GridApi | null>(null);

  const loadDay = useCallback(async (date: string) => {
    const api = gridApiRef.current;
    if (api) api.showLoadingOverlay();
    try {
      const data = await apiJson<{ entries: TransactionRow[] }>(`/transactions/day/${date}`, { fallback: 'Failed to load transactions day' });
      setEntries((data.entries || []).map((e) => ({ ...e, entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : '' })));
    } catch (error) {
      console.error('Error loading transactions day:', error);
      showToast('Failed to load transaction entries', 'error');
      setEntries([]);
    } finally {
      gridApiRef.current?.hideOverlay();
    }
  }, [showToast]);

  useEffect(() => {
    loadLedgersList();
    // A "Go to transaction" link from a ledger statement lands here with a date/id to focus.
    const state = location.state as { focusDate?: string; focusId?: string } | null;
    const initialDate = state?.focusDate || getPKTDateString();
    setSelectedDate(initialDate);
    setDateInput(formatDateDDMMYYYY(initialDate));
    setNewRow(emptyRow(initialDate));
    loadDay(initialDate).then(() => {
      if (state?.focusId) flashRow(state.focusId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flashRow(rowId: string) {
    const api = gridApiRef.current;
    if (!api) return;
    setTimeout(() => {
      const node = api.getRowNode(rowId);
      if (!node) return;
      api.ensureNodeVisible(node, 'middle');
      const flash = () => api.flashCells({ rowNodes: [node], flashDelay: 600, fadeDelay: 600 });
      flash();
      setTimeout(flash, 1200);
    }, 200);
  }

  function changeDate(date: string) {
    setSelectedDate(date);
    setDateInput(formatDateDDMMYYYY(date));
    setNewRow(emptyRow(date));
    loadDay(date);
  }

  function shiftDay(delta: number) {
    const [y, m, d] = selectedDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + delta);
    changeDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  }

  function applyDateFromInput() {
    const parsed = parseDDMMYYYYToYYYYMMDD(dateInput);
    if (parsed) changeDate(parsed);
    else if (dateInput.trim() !== '') {
      showToast('Enter date as DD/MM/YYYY', 'error', { silent: true });
      setDateInput(formatDateDDMMYYYY(selectedDate));
    }
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

  const columnDefs = useMemo(() => buildTransactionColumnDefs({
    ledgers, isEditingAllowed, onFieldChange, onDeleteRow,
    onCreateLedger: (rowId, field) => setCreateLedgerFor({ rowId, field }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ledgers, isEditingAllowed, entries, newRow]);

  const rowData = useMemo(() => [...sortedEntries(entries), newRow], [entries, newRow]);

  function onGridReady(e: GridReadyEvent) { gridApiRef.current = e.api; }

  usePageHeader({
    title: 'Transactions',
    actions: (
      <>
        <div className="transaction-search-wrap">
          <i className="fa-solid fa-magnifying-glass transaction-search-icon" />
          <input className="transaction-search-filter" placeholder="Search this day's entries..." autoComplete="off" value={search} onChange={(e) => { setSearch(e.target.value); gridApiRef.current?.setGridOption('quickFilterText', e.target.value); }} />
        </div>
        <div className={'cash-in-hand-display' + (cashTooltipOpen ? ' cash-in-hand-tooltip-open' : '')} onClick={(e) => { e.stopPropagation(); setCashTooltipOpen((v) => !v); }}>
          <span className="cash-in-hand-label">Available Cash:</span>
          <span className="cash-in-hand-amount">Rs {formatMoney(cashInHand.total)}</span>
          <div className="cash-in-hand-tooltip">
            <div className="cash-in-hand-tooltip-section">
              <div className="cash-in-hand-tooltip-header">Cash in Hand:</div>
              <div className="cash-in-hand-tooltip-item"><span className="cash-in-hand-tooltip-name">Cash</span><span className="cash-in-hand-tooltip-balance">Rs {formatMoney(cashInHand.physicalCashInHand)}</span></div>
            </div>
            <div className="cash-in-hand-tooltip-section">
              <div className="cash-in-hand-tooltip-header">Cash in Bank Ledgers:</div>
              {cashInHand.bankLedgerBalances.length === 0
                ? <div className="cash-in-hand-tooltip-empty">No ledgers included</div>
                : cashInHand.bankLedgerBalances.map((b) => (
                  <div className="cash-in-hand-tooltip-item" key={b.name}><span className="cash-in-hand-tooltip-name">{b.name}</span><span className="cash-in-hand-tooltip-balance">Rs {formatMoney(b.balance)}</span></div>
                ))}
            </div>
            <div className="cash-in-hand-tooltip-footer">
              <span className="cash-in-hand-tooltip-total-label">Total:</span>
              <span className="cash-in-hand-tooltip-total">Rs {formatMoney(cashInHand.total)}</span>
            </div>
          </div>
        </div>
        <button type="button" className="btn btn-secondary btn-icon-sm" title="Previous day" onClick={() => shiftDay(-1)}><i className="fa-solid fa-chevron-left" /></button>
        <input
          type="text" className="transaction-date-filter" placeholder="DD/MM/YYYY" maxLength={10} autoComplete="off"
          value={dateInput} onChange={(e) => setDateInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyDateFromInput(); } }}
          onBlur={applyDateFromInput}
        />
        <button type="button" className="btn btn-secondary btn-icon-sm" title="Next day" onClick={() => shiftDay(1)}><i className="fa-solid fa-chevron-right" /></button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => changeDate(getPKTDateString())}>Today</button>
        <button type="button" className="btn btn-primary btn-sm" title="Create a new transaction entry" onClick={() => setEntryModalOpen(true)}><i className="fa-solid fa-plus" /> New Transaction</button>
      </>
    ),
  });

  useEffect(() => {
    function onDocClick() { setCashTooltipOpen(false); }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  return (
    <>
      <div className="ag-theme-alpine grid-container">
        <AgGridReact
          columnDefs={columnDefs}
          rowData={rowData}
          defaultColDef={{ sortable: true, resizable: true, filter: true, floatingFilter: false, minWidth: 80 }}
          animateRows
          pagination={false}
          domLayout="normal"
          singleClickEdit
          stopEditingWhenCellsLoseFocus
          getRowId={(p) => p.data.id}
          getRowClass={(p) => (isTransactionNewRow(p.data?.id) ? 'transaction-new-row' : '')}
          onGridReady={onGridReady}
        />
      </div>
      {entryModalOpen && (
        <TransactionEntryModal
          ledgers={ledgers}
          entryDate={selectedDate}
          onClose={() => setEntryModalOpen(false)}
          onLedgersChanged={loadLedgersList}
          onDone={async (patches) => {
            applyLedgerBalancePatches(patches);
            setEntryModalOpen(false);
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
