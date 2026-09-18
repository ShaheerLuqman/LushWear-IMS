// Transactions grid column defs + cell renderers - ported from orders-grid.js's
// createFolioCellRenderer/createTransactionRowMenu/transactionCellWithPlaceholder
// and transactions.js's buildTransactionGridColumns.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { ColDef } from 'ag-grid-community';
import { cashSideLabel, ledgerNameById, selectableLedgers, type Ledger } from '../../logic/ledgers';
import { formatAmount } from '../../logic/shared';
import { Dropdown } from '../../components/Dropdown';

export interface TransactionRow {
  id: string;
  entry_date?: string;
  description?: string;
  from_account_id?: string | null;
  to_account_id?: string | null;
  amount?: number | null;
  order_number?: string;
  [key: string]: unknown;
}

export function isTransactionNewRow(id: string | undefined): boolean {
  return !!id && id.startsWith('__new_');
}

function parseTransactionAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/,/g, '').trim();
  if (raw === '') return null;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatTransactionCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return formatAmount(value);
}

export interface TransactionsColumnsCtx {
  ledgers: Ledger[];
  isEditingAllowed: () => boolean;
  onFieldChange: (rowId: string, field: string, value: unknown) => void;
  onDeleteRow: (rowId: string) => void;
  onCreateLedger: (rowId: string, field: 'from_account_id' | 'to_account_id') => void;
}

function FolioCell({ data, accountField, ctx }: { data: TransactionRow; accountField: 'from_account_id' | 'to_account_id'; ctx: TransactionsColumnsCtx }) {
  const navigate = useNavigate();
  const currentFolio = data[accountField] as string | null | undefined;
  const emptyLabel = cashSideLabel(ctx.ledgers);
  const cashLedger = ctx.ledgers.find((l) => l.system_key === 'cash');
  const shownLedger = currentFolio ? ctx.ledgers.find((l) => l.id === currentFolio) : cashLedger;
  const displayText = shownLedger ? shownLedger.name : emptyLabel;
  const canEdit = ctx.isEditingAllowed();

  return (
    <div className="folio-dropdown" onClick={(e) => e.stopPropagation()}>
      {canEdit ? (
        <Dropdown
          variant="tertiary" size="slim" searchable fullWidth value={currentFolio || ''}
          options={[{ value: '', label: emptyLabel }, ...selectableLedgers(ctx.ledgers).map((l) => ({ value: l.id, label: l.name }))]}
          onChange={(id) => ctx.onFieldChange(data.id, accountField, id || null)}
          action={{ content: '+ Create new ledger...', onAction: () => ctx.onCreateLedger(data.id, accountField) }}
        />
      ) : <span className="folio-display-text">{displayText}</span>}
      <button
        type="button" className="folio-goto-btn" title={shownLedger ? `Go to ${displayText}` : 'Select a ledger first'}
        style={{ opacity: shownLedger ? 1 : 0.4, cursor: shownLedger ? 'pointer' : 'not-allowed' }}
        onClick={(e) => { e.stopPropagation(); const id = shownLedger?.id || (currentFolio ? null : cashLedger?.id); if (id) navigate(`/ledgers/${id}`); }}
      >
        <i className="fa-solid fa-arrow-right" />
      </button>
    </div>
  );
}

function CellWithPlaceholder({ value, isNewRow, placeholder }: { value: string; isNewRow: boolean; placeholder: string }) {
  if (value === '' && isNewRow) return <span className="transaction-placeholder">{placeholder}</span>;
  return <span>{value}</span>;
}

function RowMenu({ data, ctx }: { data: TransactionRow; ctx: TransactionsColumnsCtx }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.transaction-menu-panel') && target !== btnRef.current) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (isTransactionNewRow(data.id)) return null;

  return (
    <div>
      <button
        ref={btnRef} type="button" className={'transaction-menu-btn' + (open ? ' open' : '')} title="More actions"
        onClick={(e) => { e.stopPropagation(); if (!open && btnRef.current) { const r = btnRef.current.getBoundingClientRect(); setPos({ top: r.bottom + 2, left: Math.max(r.right - 160, 8) }); } setOpen((v) => !v); }}
      >
        <i className="fa-solid fa-ellipsis" />
      </button>
      {open && createPortal(
        <div className="folio-dropdown-panel transaction-menu-panel" style={{ position: 'fixed', top: pos.top, left: pos.left }}>
          <div className="folio-dropdown-option transaction-menu-option-danger" onClick={() => { setOpen(false); ctx.onDeleteRow(data.id); }}>
            <i className="fa-solid fa-trash" /><span>Delete</span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export function buildTransactionColumnDefs(ctx: TransactionsColumnsCtx): ColDef[] {
  return [
    {
      headerName: '#', colId: 'rowNum', flex: 5, minWidth: 40, filter: false, sortable: false,
      valueGetter: (p: any) => (isTransactionNewRow(p.data?.id) ? '' : p.node.rowIndex + 1),
    },
    {
      headerName: 'From Account (Credit)', field: 'from_account_id', flex: 20, minWidth: 130, filter: false, sortable: false,
      cellRenderer: (p: any) => <FolioCell data={p.data} accountField="from_account_id" ctx={ctx} />,
      valueFormatter: (p: any) => (p.value ? ledgerNameById(ctx.ledgers, p.value) : cashSideLabel(ctx.ledgers)),
    },
    {
      headerName: 'To Account (Debit)', field: 'to_account_id', flex: 20, minWidth: 130, filter: false, sortable: false,
      cellRenderer: (p: any) => <FolioCell data={p.data} accountField="to_account_id" ctx={ctx} />,
      valueFormatter: (p: any) => (p.value ? ledgerNameById(ctx.ledgers, p.value) : cashSideLabel(ctx.ledgers)),
    },
    {
      headerName: 'Amount (PKR)', field: 'amount', flex: 15, minWidth: 100, filter: 'agNumberColumnFilter',
      editable: () => ctx.isEditingAllowed(),
      cellStyle: { cursor: 'pointer' } as any,
      valueFormatter: (p: any) => formatTransactionCell(p.value),
      cellRenderer: (p: any) => <CellWithPlaceholder value={formatTransactionCell(p.value)} isNewRow={isTransactionNewRow(p.data?.id)} placeholder="0.00" />,
      valueSetter: (p: any) => {
        const next = parseTransactionAmount(p.newValue);
        if (!isTransactionNewRow(p.data.id) && (next === null || next <= 0)) return false;
        ctx.onFieldChange(p.data.id, 'amount', next);
        return true;
      },
    },
    {
      headerName: 'Description', field: 'description', flex: 35, minWidth: 160, editable: () => ctx.isEditingAllowed(),
      cellStyle: { cursor: 'pointer' } as any,
      valueFormatter: (p: any) => (p.value != null && p.value !== '' ? String(p.value) : ''),
      cellRenderer: (p: any) => <CellWithPlaceholder value={p.value != null ? String(p.value) : ''} isNewRow={isTransactionNewRow(p.data?.id)} placeholder="What was this for?" />,
      valueSetter: (p: any) => {
        const val = String(p.newValue ?? '').trim();
        if ((p.data.description || '') === val) return false;
        ctx.onFieldChange(p.data.id, 'description', val);
        return true;
      },
    },
    {
      headerName: '', field: 'actions', flex: 5, minWidth: 40, filter: false, sortable: false,
      cellRenderer: (p: any) => <RowMenu data={p.data} ctx={ctx} />,
    },
  ];
}
