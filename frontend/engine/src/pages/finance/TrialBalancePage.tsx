// Trial Balance: every account with a non-zero balance, as at a date, split into
// its Debit or Credit column. Ported from trial-balance.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridApi, GridReadyEvent } from 'ag-grid-community';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { formatMoney } from '../../logic/ledgers';
import { getPKTDateString } from '../../logic/shared';

interface TrialBalanceRow { account_id: string; code?: string; name: string; type?: string; debit: number; credit: number; _isFooter?: boolean }
interface TrialBalanceData { rows: TrialBalanceRow[]; total_debit: number; total_credit: number; balanced: boolean }

export function TrialBalancePage() {
  const { showToast } = useToast();
  const [asOf, setAsOf] = useState(getPKTDateString());
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const gridApiRef = useRef<GridApi | null>(null);

  const load = useCallback(async (date: string) => {
    gridApiRef.current?.showLoadingOverlay();
    let rowCount = 0;
    try {
      const data = await apiJson<TrialBalanceData>(`/journal/trial-balance?as_of=${date}`, { fallback: 'Failed to load trial balance' });
      const nextRows = (data.rows || []).map((r) => ({ ...r, debit: parseFloat(String(r.debit)) || 0, credit: parseFloat(String(r.credit)) || 0 }));
      rowCount = nextRows.length;
      setRows(nextRows);
      const difference = (parseFloat(String(data.total_debit)) || 0) - (parseFloat(String(data.total_credit)) || 0);
      setStatus(data.balanced ? { text: 'Balanced', ok: true } : { text: `Out of balance by Rs ${formatMoney(Math.abs(difference))}`, ok: false });
      gridApiRef.current?.setGridOption('pinnedBottomRowData', [{
        account_id: '__total__', code: '', name: 'Total', type: '', debit: parseFloat(String(data.total_debit)) || 0, credit: parseFloat(String(data.total_credit)) || 0, _isFooter: true,
      }]);
    } catch (error) {
      console.error('Error loading trial balance:', error);
      showToast('Failed to load trial balance', 'error');
      setRows([]);
    } finally {
      if (rowCount === 0) gridApiRef.current?.showNoRowsOverlay(); else gridApiRef.current?.hideOverlay();
    }
  }, [showToast]);

  useEffect(() => { load(asOf); }, [asOf, load]);

  const columnDefs: ColDef[] = useMemo(() => [
    { headerName: 'Code', field: 'code', width: 110 },
    { headerName: 'Account', field: 'name', flex: 2, minWidth: 180 },
    { headerName: 'Type', field: 'type', width: 140 },
    // Zero on a trial balance means "this account is on the other side", not "zero
    // rupees" - a blank cell reads that way, 0.00 doesn't.
    { headerName: 'Debit (Rs)', field: 'debit', width: 160, type: 'rightAligned', valueFormatter: (p: any) => (p.value ? formatMoney(p.value) : '') },
    { headerName: 'Credit (Rs)', field: 'credit', width: 160, type: 'rightAligned', valueFormatter: (p: any) => (p.value ? formatMoney(p.value) : '') },
  ], []);

  usePageHeader({
    title: 'Trial Balance',
    actions: (
      <>
        <label htmlFor="trialBalanceAsOf">As at</label>
        <input type="date" id="trialBalanceAsOf" className="form-input trial-balance-date" value={asOf} onChange={(e) => setAsOf(e.target.value || getPKTDateString())} />
        {status && <span className={'trial-balance-status ' + (status.ok ? 'trial-balance-status-ok' : 'trial-balance-status-bad')}>{status.text}</span>}
      </>
    ),
  });

  function onGridReady(e: GridReadyEvent) {
    gridApiRef.current = e.api;
    if (rows.length === 0) e.api.showNoRowsOverlay();
  }

  return (
    <div className="ag-theme-alpine grid-container">
      <AgGridReact
        columnDefs={columnDefs}
        rowData={rows}
        defaultColDef={{ sortable: true, resizable: true, filter: true, minWidth: 90 }}
        animateRows
        pagination={false}
        domLayout="normal"
        getRowId={(p) => p.data.account_id}
        onGridReady={onGridReady}
      />
    </div>
  );
}
