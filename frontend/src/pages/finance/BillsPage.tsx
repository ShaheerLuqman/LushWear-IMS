// Purchase Bills: grid + status filter + the create/view bill modal. Ported from
// bills.js's loadBills/initBillsGrid/initBills.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import { apiJson, apiRequest } from '../../api';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { Dropdown } from '../../components/Dropdown';
import { BILL_STATUSES, BILL_STATUS_LABELS } from '../../logic/bills';
import { useLedgersData } from './useLedgersData';
import { useInventoryData } from '../inventory/useInventoryData';
import { buildBillsColumnDefs, type Bill } from './BillsGridCells';
import { BillModal } from './BillModal';

export function BillsPage() {
  const location = useLocation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { ledgers, loadLedgersList } = useLedgersData();
  const { products, loadProducts, reload: reloadProducts } = useInventoryData();

  const [bills, setBills] = useState<Bill[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[] | null>(null);
  const [modalBillId, setModalBillId] = useState<string | null | undefined>(undefined);
  const gridApiRef = useRef<GridApi | null>(null);

  const loadBills = useCallback(async () => {
    gridApiRef.current?.showLoadingOverlay();
    let rows: Bill[] = [];
    try {
      if (!(statusFilter && statusFilter.length === 0)) {
        const query = statusFilter ? `?${statusFilter.map((s) => `status=${encodeURIComponent(s)}`).join('&')}` : '';
        rows = await apiJson<Bill[]>(`/bills/${query}`, { fallback: 'Failed to load bills' });
      }
      setBills(rows);
    } catch (error) {
      console.error('Error loading bills:', error);
      showToast('Failed to load bills', 'error');
      rows = [];
      setBills(rows);
    } finally {
      if (rows.length === 0) gridApiRef.current?.showNoRowsOverlay(); else gridApiRef.current?.hideOverlay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, showToast]);

  useEffect(() => {
    loadLedgersList();
    loadProducts();
  }, [loadLedgersList, loadProducts]);

  useEffect(() => { loadBills(); }, [loadBills]);

  useEffect(() => {
    const state = location.state as { focusId?: string } | null;
    if (!state?.focusId) return;
    setStatusFilter(null);
    const t = setTimeout(() => {
      const api = gridApiRef.current;
      const node = api?.getRowNode(state.focusId!);
      if (!api || !node) return;
      api.ensureNodeVisible(node, 'middle');
      const flash = () => api.flashCells({ rowNodes: [node], flashDelay: 600, fadeDelay: 600 });
      flash();
      setTimeout(flash, 1200);
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onReceive(bill: Bill) {
    const ok = await confirm({ title: 'Confirm Bill', message: 'This posts the bill to the accounts and adds its stock. Continue?', confirmText: 'Confirm' });
    if (!ok) return;
    await billAction(bill.id, 'receive');
  }
  async function onUnreceive(bill: Bill) {
    const ok = await confirm({ title: 'Revert to Draft', message: 'This unposts the bill and removes the stock it added. Continue?', confirmText: 'Revert to draft' });
    if (!ok) return;
    await billAction(bill.id, 'unreceive');
  }
  async function onCancel(bill: Bill) {
    const ok = await confirm({ title: 'Cancel Bill', message: 'Cancel this bill? A received bill is unposted first.', confirmText: 'Cancel bill', danger: true });
    if (!ok) return;
    await billAction(bill.id, 'cancel');
  }
  async function billAction(billId: string, action: string) {
    try {
      await apiJson(`/bills/${billId}/${action}`, { method: 'POST', fallback: `Failed to ${action} bill` });
      await loadBills();
      await reloadProducts();
    } catch (error: any) {
      console.error(`Error on bill ${action}:`, error);
      showToast(error?.message || `Failed to ${action} bill`, 'error');
    }
  }
  async function onDelete(bill: Bill) {
    const ok = await confirm({ title: 'Delete Draft', message: 'Delete this draft bill? This cannot be undone.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await apiRequest(`/bills/${bill.id}`, { method: 'DELETE', fallback: 'Failed to delete bill' });
      showToast('Draft deleted', 'success');
      await loadBills();
    } catch (error: any) {
      console.error('Error deleting bill:', error);
      showToast(error?.message || 'Failed to delete bill', 'error');
    }
  }

  const columnDefs = useMemo(() => buildBillsColumnDefs({
    ledgers, onView: (b) => setModalBillId(b.id), onReceive, onUnreceive, onCancel, onDelete,
  }), [ledgers]);

  function onGridReady(e: GridReadyEvent) {
    gridApiRef.current = e.api;
    if (bills.length === 0) e.api.showNoRowsOverlay();
  }

  usePageHeader({
    title: 'Purchase Bills',
    actions: (
      <>
        <Dropdown multiple allLabel="All statuses" options={BILL_STATUSES.map((v) => ({ value: v, label: BILL_STATUS_LABELS[v] || v }))} value={statusFilter} onChange={setStatusFilter} />
        <HeaderButton variant="primary" icon={<i className="fa-solid fa-plus" />} onClick={() => setModalBillId(null)}>New Bill</HeaderButton>
      </>
    ),
  });

  return (
    <>
      <div className="ag-theme-alpine grid-container">
        <AgGridReact
          columnDefs={columnDefs}
          rowData={bills}
          defaultColDef={{ sortable: true, resizable: true, filter: true, floatingFilter: false, minWidth: 90 }}
          animateRows
          pagination={false}
          domLayout="normal"
          getRowId={(p) => p.data.id}
          onGridReady={onGridReady}
        />
      </div>
      {modalBillId !== undefined && (
        <BillModal
          billId={modalBillId}
          ledgers={ledgers}
          products={products}
          onClose={() => setModalBillId(undefined)}
          onDone={() => { setModalBillId(undefined); loadBills(); }}
        />
      )}
    </>
  );
}
