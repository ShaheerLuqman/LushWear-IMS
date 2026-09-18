// Bulk update order modal - paste order numbers, then apply a status/settlement
// change to all of them, or select them in the grid. Ported from
// modals-forms.js/orders-actions.js.
import { useMemo, useState } from 'react';
import type { GridApi } from 'ag-grid-community';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import type { Order } from '../../logic/orders';

interface BulkResult {
  updated_order_numbers?: Array<string | number>;
  not_found_order_numbers?: Array<string | number>;
}

function parseOrderNumbers(text: string): number[] {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const results: number[] = [];
  for (const line of lines) {
    const n = parseInt(line, 10);
    if (!Number.isNaN(n) && n > 0) results.push(n);
  }
  return [...new Set(results)];
}

export function BulkUpdateOrderModal({
  open, onClose, onChanged, gridApi, prefill, orders,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  gridApi: GridApi | null;
  prefill: string;
  orders: Order[];
}) {
  const { isEditingAllowed } = useAuth();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [text, setText] = useState(prefill);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<BulkResult | null>(null);
  const [deliveryChargesOpen, setDeliveryChargesOpen] = useState(false);

  const orderNumbers = useMemo(() => parseOrderNumbers(text), [text]);

  if (!open) return null;

  function guardEditing(): boolean {
    if (!isEditingAllowed()) {
      showToast('Editing is locked', 'error', { silent: true });
      return false;
    }
    return true;
  }

  function requireOrderNumbers(): boolean {
    if (orderNumbers.length === 0) {
      showToast('Enter at least one valid order number (one per line).', 'error', { silent: true });
      return false;
    }
    return true;
  }

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(orderStatus: 'delivered' | 'returned' | 'cancelled') {
    if (!guardEditing() || !requireOrderNumbers()) return;
    const actionLabels: Record<string, string> = { delivered: 'mark them Delivered', returned: 'mark them Returned', cancelled: 'mark them Cancelled' };
    const conflicting = ['delivered', 'returned'].filter((s) => s !== orderStatus);
    if (!(await confirmActionOnTerminalOrders(orders, orderNumbers, actionLabels[orderStatus], conflicting, confirm))) return;
    await withBusy(orderStatus, async () => {
      try {
        const result = await apiJson<BulkResult>('/orders/bulk-update-status', {
          method: 'POST', body: { order_numbers: orderNumbers, order_status: orderStatus }, fallback: 'Bulk update failed',
        });
        setResults(result);
        onChanged();
      } catch (e: any) {
        showToast(e?.message || 'Bulk update failed', 'error');
      }
    });
  }

  async function setPieceReceived() {
    if (!guardEditing() || !requireOrderNumbers()) return;
    if (!(await confirmActionOnTerminalOrders(orders, orderNumbers, 'mark them Returned + Piece Received', ['delivered'], confirm))) return;
    await withBusy('piece_received', async () => {
      try {
        const result = await apiJson<BulkResult>('/orders/bulk-update-status', {
          method: 'POST', body: { order_numbers: orderNumbers, order_status: 'returned', piece_received: 'Received' }, fallback: 'Bulk update failed',
        });
        setResults(result);
        onChanged();
      } catch (e: any) {
        showToast(e?.message || 'Bulk update failed', 'error');
      }
    });
  }

  async function setSettled(settled: boolean) {
    if (!guardEditing() || !requireOrderNumbers()) return;
    await withBusy(settled ? 'settled' : 'unsettled', async () => {
      try {
        const result = await apiJson<BulkResult>('/orders/bulk-update-order-settled', {
          method: 'POST', body: { order_numbers: orderNumbers, is_order_settled: settled }, fallback: 'Bulk update failed',
        });
        setResults(result);
        onChanged();
      } catch (e: any) {
        showToast(e?.message || 'Bulk update failed', 'error');
      }
    });
  }

  function selectInGrid() {
    if (!requireOrderNumbers()) return;
    if (!gridApi) {
      showToast('Orders grid is not available', 'error', { silent: true });
      return;
    }
    const wanted = new Set(orderNumbers.map(String));
    const matched = new Set<string>();
    gridApi.deselectAll();
    gridApi.forEachNode((node) => {
      const data = node.data;
      if (!data || data.id === '__footer__') return;
      const num = String(data.order_number);
      if (wanted.has(num)) {
        node.setSelected(true);
        matched.add(num);
      }
    });
    const selectedRows = gridApi.getSelectedRows();
    if (selectedRows.length > 0) gridApi.ensureNodeVisible(selectedRows[0], 'middle');
    const notFound = [...wanted].filter((n) => !matched.has(n));
    close();
    if (notFound.length > 0) {
      showToast(`Selected ${matched.size} order(s). Not in grid: ${notFound.join(', ')}`, matched.size > 0 ? 'info' : 'error');
    } else {
      showToast(`Selected ${matched.size} order(s) in grid`, 'success');
    }
  }

  function close() {
    setResults(null);
    setDeliveryChargesOpen(false);
    onClose();
  }

  return (
    <>
      <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="modal-content">
          <div className="modal-header">
            <h2>Bulk update order</h2>
            <button type="button" className="modal-close" aria-label="Close" onClick={close}>&times;</button>
          </div>
          <div className="modal-body">
            {!results ? (
              <div>
                <p className="modal-description">Enter order numbers, one per line:</p>
                <textarea
                  className="bulk-update-textarea" rows={6} placeholder={'e.g. 2721\n2722\n2723'}
                  value={text} onChange={(e) => setText(e.target.value)} autoFocus
                />
                <p className="bulk-update-order-count">{orderNumbers.length === 1 ? '1 order' : `${orderNumbers.length} orders`}</p>

                <div className="bulk-update-action-group">
                  <span className="bulk-update-action-group-label">Order status</span>
                  <div className="bulk-update-actions">
                    <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => setStatus('delivered')}>
                      {busy === 'delivered' && <span className="btn-loading-spinner" />}Delivered
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setStatus('returned')}>
                      {busy === 'returned' && <span className="btn-loading-spinner" />}Returned
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setStatus('cancelled')}>
                      {busy === 'cancelled' && <span className="btn-loading-spinner" />}Cancelled
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={setPieceReceived}>
                      {busy === 'piece_received' && <span className="btn-loading-spinner" />}Returned + Piece Received
                    </button>
                  </div>
                </div>

                <div className="bulk-update-action-group">
                  <span className="bulk-update-action-group-label">Courier &amp; charges</span>
                  <div className="bulk-update-actions">
                    <button type="button" className="btn btn-success" disabled={!!busy} onClick={() => setSettled(true)}>
                      {busy === 'settled' && <span className="btn-loading-spinner" />}Mark Order Settled
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setSettled(false)}>
                      {busy === 'unsettled' && <span className="btn-loading-spinner" />}Mark Order Unsettled
                    </button>
                    <button
                      type="button" className="btn btn-secondary" disabled={!!busy}
                      onClick={() => { if (requireOrderNumbers()) setDeliveryChargesOpen(true); }}
                    >
                      Update Delivery Charges
                    </button>
                  </div>
                </div>

                <div className="bulk-update-action-group">
                  <span className="bulk-update-action-group-label">Grid</span>
                  <div className="bulk-update-actions">
                    <button type="button" className="btn btn-secondary" onClick={selectInGrid}>Select in Grid</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bulk-update-results">
                <p className="bulk-update-results-title">Results</p>
                <div className="bulk-update-result-section">
                  <strong>Updated successfully:</strong>
                  {(results.updated_order_numbers?.length ?? 0) === 0
                    ? <p className="bulk-update-empty">None</p>
                    : <ul className="bulk-update-list">{results.updated_order_numbers!.map((n) => <li key={n}>{n}</li>)}</ul>}
                </div>
                <div className="bulk-update-result-section">
                  <strong>Not found / failed:</strong>
                  {(results.not_found_order_numbers?.length ?? 0) === 0
                    ? <p className="bulk-update-empty">None</p>
                    : <ul className="bulk-update-list">{results.not_found_order_numbers!.map((n) => <li key={n}>{n}</li>)}</ul>}
                </div>
                <div className="bulk-update-actions">
                  <button type="button" className="btn btn-primary" onClick={close}>Close</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {deliveryChargesOpen && (
        <BulkUpdateDeliveryChargesModal
          orderNumbers={orderNumbers}
          onClose={() => setDeliveryChargesOpen(false)}
          onDone={(result) => { setDeliveryChargesOpen(false); setResults(result); onChanged(); }}
        />
      )}
    </>
  );
}

/** Confirm before an action lands on orders already in one of `statuses` (usually a
 * slip) - only orders in the currently-loaded period are checked, matching orders.ts's
 * own `orders` state; a number not on the grid is left for the backend to handle.
 * Resolves true when there's nothing to warn about (no confirm shown) or the user confirms. */
async function confirmActionOnTerminalOrders(
  orders: Order[], orderNumbers: number[], actionLabel: string, statuses: string[], confirm: ReturnType<typeof useConfirm>,
): Promise<boolean> {
  const wanted = new Set(orderNumbers.map(String));
  const already = orders
    .filter((o) => o && o.id !== '__footer__' && wanted.has(String(o.order_number)) && statuses.includes((o.order_status || '').toLowerCase()))
    .map((o) => o.order_number!);
  if (already.length === 0) return true;
  const list = [...already].sort((a, b) => a - b).join(', ');
  const statusLabel = statuses.join(' or ');
  return confirm({
    title: `Order already ${statusLabel}`,
    message: `${already.length} order(s) are already ${statusLabel}: ${list}.\n\nAre you sure you want to ${actionLabel}?`,
    confirmText: 'Continue',
    danger: true,
  });
}

function BulkUpdateDeliveryChargesModal({
  orderNumbers, onClose, onDone,
}: {
  orderNumbers: number[];
  onClose: () => void;
  onDone: (result: BulkResult) => void;
}) {
  const { showToast } = useToast();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const deliveryCharge = value.trim() === '' ? NaN : parseFloat(value);
    if (Number.isNaN(deliveryCharge) || deliveryCharge < 0) {
      showToast('Enter a valid delivery charge (0 or more)', 'error', { silent: true });
      return;
    }
    setSaving(true);
    try {
      const result = await apiJson<BulkResult>('/orders/bulk-update-delivery-charges', {
        method: 'POST', body: { order_numbers: orderNumbers, delivery_charge: deliveryCharge }, fallback: 'Failed to update delivery charges',
      });
      onDone(result);
    } catch (e: any) {
      showToast(e?.message || 'Bulk update failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Update delivery charges</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-description">Set delivery charges (Rs) for all selected orders:</p>
          <div className="form-group" style={{ marginTop: 16 }}>
            <label htmlFor="bulkUpdateDeliveryChargesValue">Delivery charges (Rs) *</label>
            <input
              type="number" id="bulkUpdateDeliveryChargesValue" className="form-input" min={0} step={0.01} placeholder="0.00"
              value={value} onChange={(e) => setValue(e.target.value)} autoFocus
            />
          </div>
        </div>
        <div className="bulk-update-actions modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? 'Updating...' : 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}
