// One ledger's statement: read-only, grouped into collapsible month blocks with a
// running balance. Ported from ledgers.js's openLedgerDetail/renderLedgerDetailGrid.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridApi, GridReadyEvent } from 'ag-grid-community';
import { apiJson } from '../../api';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { formatAmount, formatDateDDMMYYYY } from '../../logic/shared';
import {
  CREDIT_NORMAL_TYPES, formatBalanceWithSide, LEDGER_VOUCHER_LABELS, withLedgerMonthRows,
  type Ledger, type LedgerStatementEntry,
} from '../../logic/ledgers';

function formatTransactionCell(value: unknown): string {
  if (value == null || value === '' || value === 0) return '';
  return formatAmount(value);
}

function ParticularsCell({ entry }: { entry: LedgerStatementEntry }) {
  const navigate = useNavigate();
  const canGoTo = (entry.source_type === 'transaction_entry' || entry.source_type === 'bill') && !!entry.source_id;
  return (
    <div className="folio-dropdown">
      <span className="folio-display-text">{entry.particulars || ''}</span>
      {canGoTo && (
        <button
          type="button" className="folio-goto-btn" title={entry.source_type === 'bill' ? 'Go to bill' : 'Go to transaction'}
          onClick={(e) => {
            e.stopPropagation();
            if (entry.source_type === 'transaction_entry') {
              navigate('/transactions', { state: { focusDate: entry.entry_date, focusId: entry.source_id } });
            } else {
              navigate('/bills', { state: { focusId: entry.source_id } });
            }
          }}
        >
          <i className="fa-solid fa-arrow-right" />
        </button>
      )}
    </div>
  );
}

function MonthRow({ collapsed, label, balance, onToggle }: { collapsed: boolean; label: string; balance: number; onToggle: () => void }) {
  return (
    <div className={'ledger-month-row' + (collapsed ? ' ledger-month-row-collapsed' : '')} onClick={onToggle}>
      <span className="ledger-month-row-label"><i className={`fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}`} />{label}</span>
      <span className="ledger-month-row-balance">{formatBalanceWithSide(balance)}</span>
    </div>
  );
}

export function LedgerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [entries, setEntries] = useState<LedgerStatementEntry[]>([]);
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());
  const gridApiRef = useRef<GridApi | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      gridApiRef.current?.showLoadingOverlay();
      let entryCount = 0;
      try {
        const [ledgerData, rawEntries] = await Promise.all([
          apiJson<Ledger>(`/ledgers/${id}`, { fallback: 'Failed to load ledger' }),
          apiJson<LedgerStatementEntry[]>(`/ledgers/${id}/entries`, { fallback: 'Failed to load ledger entries' }),
        ]);
        if (cancelled) return;
        setLedger(ledgerData);
        const normalized = rawEntries.map((e) => ({ ...e, entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : '' }));
        entryCount = normalized.length;
        setEntries(normalized);
        // Only the current month starts expanded; every other month collapses by default.
        const currentMonth = new Date().toISOString().slice(0, 7);
        setCollapsedMonths(new Set(normalized.map((e) => (e.entry_date || '').slice(0, 7)).filter((m) => m && m !== currentMonth)));
      } catch (error) {
        console.error('Error loading ledger:', error);
        navigate('/ledgers');
      } finally {
        if (!cancelled) { if (entryCount === 0) gridApiRef.current?.showNoRowsOverlay(); else gridApiRef.current?.hideOverlay(); }
      }
    })();
    return () => { cancelled = true; };
  }, [id, navigate]);

  // New Balance = Previous Balance + Debit - Credit, the same for every ledger regardless
  // of Nature. No synthetic opening-balance row: it's a real journal line, so it arrives
  // like any other row. Rows are already ordered by the get_ledger_statement RPC.
  const rowsWithBalance = useMemo(() => {
    let running = 0;
    return entries.map((entry) => {
      const debit = parseFloat(String(entry.debit)) || 0;
      const credit = parseFloat(String(entry.credit)) || 0;
      running += debit - credit;
      return { ...entry, debit, credit, balance: running };
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

  const columnDefs: ColDef[] = useMemo(() => [
    { headerName: 'Date', field: 'entry_date', width: 130, editable: false, valueFormatter: (p: any) => (p.value ? formatDateDDMMYYYY(p.value) : '') },
    {
      headerName: 'Particulars', field: 'particulars', flex: 2, editable: false,
      cellRenderer: (p: any) => <ParticularsCell entry={p.data} />,
    },
    {
      headerName: 'Type', field: 'voucher_type', width: 110, editable: false,
      valueFormatter: (p: any) => LEDGER_VOUCHER_LABELS[p.value] || p.value || '',
    },
    { headerName: 'Debit (Rs)', field: 'debit', width: 140, editable: false, valueFormatter: (p: any) => formatTransactionCell(p.value) },
    { headerName: 'Credit (Rs)', field: 'credit', width: 140, editable: false, valueFormatter: (p: any) => formatTransactionCell(p.value) },
    {
      headerName: 'Balance (Rs)', field: 'balance', width: 160, editable: false,
      valueFormatter: (p: any) => (p.value === '' || p.value == null ? '' : formatBalanceWithSide(p.value)),
      cellStyle: (p: any) => {
        const val = parseFloat(p.value);
        if (Number.isNaN(val) || val === 0) return { color: 'var(--text-primary)' };
        const isBad = CREDIT_NORMAL_TYPES.includes(ledger?.type || '') ? val > 0 : val < 0;
        return { color: isBad ? 'var(--danger)' : 'var(--text-primary)' };
      },
    },
  ], [ledger]);

  usePageHeader({ title: ledger?.name || 'Ledger' });

  return (
    <>
      <div className="ledger-detail-header">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/ledgers')}><i className="fa-solid fa-arrow-left" /> Back to Ledgers</button>
        <h2 className="ledger-detail-title">{ledger?.name || ''}</h2>
      </div>
      <div className="ag-theme-alpine grid-container">
        <AgGridReact
          columnDefs={columnDefs}
          rowData={monthRows}
          defaultColDef={{ sortable: true, resizable: true, filter: true, floatingFilter: true, minWidth: 80 }}
          animateRows
          pagination={false}
          domLayout="normal"
          getRowId={(p) => p.data.id}
          isFullWidthRow={(p) => !!(p.rowNode.data as any)?.month_row}
          fullWidthCellRenderer={(p: any) => <MonthRow collapsed={p.data.collapsed} label={p.data.label} balance={p.data.balance} onToggle={() => toggleMonth(p.data.month)} />}
          getRowHeight={(p) => ((p.data as any)?.month_row ? 40 : undefined)}
          onGridReady={(e: GridReadyEvent) => { gridApiRef.current = e.api; }}
        />
      </div>
    </>
  );
}
