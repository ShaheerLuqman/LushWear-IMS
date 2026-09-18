// Bills grid column defs + cell renderers - ported from bills.js's
// supplierCellRenderer/createBillViewButton/createBillRowMenu.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { ColDef } from 'ag-grid-community';
import { formatMoney, ledgerNameById, type Ledger } from '../../logic/ledgers';
import { formatDateDDMMYYYY } from '../../logic/shared';
import { BILL_STATUS_LABELS } from '../../logic/bills';

export interface Bill {
  id: string; bill_number?: string; supplier_id?: string; supplier_ref?: string; bill_date?: string;
  total?: number; outstanding?: number; payment_status?: string; status?: string;
}

export interface BillsColumnsCtx {
  ledgers: Ledger[];
  onView: (bill: Bill) => void;
  onReceive: (bill: Bill) => void;
  onUnreceive: (bill: Bill) => void;
  onCancel: (bill: Bill) => void;
  onDelete: (bill: Bill) => void;
}

function SupplierCell({ bill, ctx }: { bill: Bill; ctx: BillsColumnsCtx }) {
  const navigate = useNavigate();
  const name = ledgerNameById(ctx.ledgers, bill.supplier_id);
  return (
    <div className="folio-dropdown">
      <span className="folio-display-text">{bill.supplier_id ? name : ''}</span>
      <button
        type="button" className="folio-goto-btn" title={bill.supplier_id ? `Go to ${name}` : 'No supplier'}
        style={{ opacity: bill.supplier_id ? 1 : 0.4, cursor: bill.supplier_id ? 'pointer' : 'not-allowed' }}
        onClick={(e) => { e.stopPropagation(); if (bill.supplier_id) navigate(`/ledgers/${bill.supplier_id}`); }}
      >
        <i className="fa-solid fa-arrow-right" />
      </button>
    </div>
  );
}

function ViewButton({ bill, ctx }: { bill: Bill; ctx: BillsColumnsCtx }) {
  if (!bill?.id) return null;
  return (
    <div className="bill-cell-center">
      <button type="button" className="bill-view-btn" title="View bill" onClick={() => ctx.onView(bill)}>
        <i className="fa-solid fa-eye" /><span>View Bill</span>
      </button>
    </div>
  );
}

function RowMenu({ bill, ctx }: { bill: Bill; ctx: BillsColumnsCtx }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.bill-menu-panel') && target !== btnRef.current) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!bill?.id || (bill.status !== 'draft' && bill.status !== 'received')) return null;

  function toggle() {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 2, left: Math.max(rect.right - 180, 8) });
    }
    setOpen((v) => !v);
  }

  const item = (label: string, icon: string, danger: boolean, onClick: () => void) => (
    <div className={'folio-dropdown-option' + (danger ? ' bill-menu-option-danger' : '')} onClick={() => { setOpen(false); onClick(); }}>
      <i className={`fa-solid ${icon}`} /><span>{label}</span>
    </div>
  );

  return (
    <div className="bill-cell-center">
      <button ref={btnRef} type="button" className={'bill-menu-btn' + (open ? ' open' : '')} title="More actions" onClick={(e) => { e.stopPropagation(); toggle(); }}>
        <i className="fa-solid fa-ellipsis" />
      </button>
      {open && createPortal(
        <div className="folio-dropdown-panel bill-menu-panel" style={{ top: pos.top, left: pos.left }}>
          {bill.status === 'draft' && item('Confirm Bill', 'fa-check', false, () => ctx.onReceive(bill))}
          {bill.status === 'draft' && item('Delete', 'fa-trash', true, () => ctx.onDelete(bill))}
          {bill.status === 'received' && item('Revert to Draft', 'fa-rotate-left', false, () => ctx.onUnreceive(bill))}
          {bill.status === 'received' && item('Cancel', 'fa-ban', true, () => ctx.onCancel(bill))}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function buildBillsColumnDefs(ctx: BillsColumnsCtx): ColDef[] {
  return [
    { headerName: 'Bill #', field: 'bill_number', flex: 12, minWidth: 110 },
    {
      headerName: 'Supplier', field: 'supplier_id', flex: 25, minWidth: 160,
      valueGetter: (p: any) => ledgerNameById(ctx.ledgers, p.data?.supplier_id),
      cellRenderer: (p: any) => <SupplierCell bill={p.data} ctx={ctx} />,
    },
    { headerName: 'Supplier ref', field: 'supplier_ref', flex: 12, minWidth: 120 },
    { headerName: 'Date', field: 'bill_date', flex: 10, minWidth: 100, valueFormatter: (p: any) => (p.value ? formatDateDDMMYYYY(p.value) : '') },
    { headerName: 'Total (Rs)', field: 'total', flex: 11, minWidth: 110, type: 'rightAligned', cellClass: 'bill-amount-cell', valueFormatter: (p: any) => formatMoney(p.value) },
    { headerName: 'Outstanding (Rs)', field: 'outstanding', flex: 12, minWidth: 130, type: 'rightAligned', cellClass: 'bill-amount-cell', valueFormatter: (p: any) => formatMoney(p.value) },
    {
      headerName: 'Status', field: 'payment_status', flex: 11, minWidth: 110,
      valueFormatter: (p: any) => BILL_STATUS_LABELS[p.value] || p.value || '',
      cellClass: (p: any) => `bill-status bill-status-${p.value || ''}`,
    },
    { headerName: '', colId: 'view', flex: 8, width: 92, minWidth: 92, sortable: false, filter: false, cellRenderer: (p: any) => <ViewButton bill={p.data} ctx={ctx} /> },
    { headerName: '', colId: 'actions', flex: 3, width: 40, minWidth: 40, sortable: false, filter: false, cellRenderer: (p: any) => <RowMenu bill={p.data} ctx={ctx} /> },
  ];
}
