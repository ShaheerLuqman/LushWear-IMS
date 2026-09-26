// Bulk update order modal - paste order numbers, then apply a status/settlement
// change to all of them, or select them in the grid. Ported from
// modals-forms.js/orders-actions.js.
import { useMemo, useState } from 'react';
import { Badge, BlockStack, Button, InlineStack, Text, TextField, type ButtonProps } from '@shopify/polaris';
import { FormModal, InfoModal } from '../../components/FormModal';
import { OrderNumbersField } from '../../components/OrderNumbersField';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import type { Order } from '../../logic/orders';
import { useReturnedAdvanceGate } from './ReturnedAdvanceRefund';

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
  open, onClose, onChanged, onSelectOrderNumbers, prefill, orders,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  onSelectOrderNumbers: (orderNumbers: number[]) => { matched: number; notFound: string[] };
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
  const { gate: returnedAdvanceGate, element: returnedAdvanceGateElement } = useReturnedAdvanceGate();

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
    if (!(await returnedAdvanceGate(orderNumbers))) return;
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
    const { matched, notFound } = onSelectOrderNumbers(orderNumbers);
    close();
    if (notFound.length > 0) {
      showToast(`Selected ${matched} order(s). Not found: ${notFound.join(', ')}`, matched > 0 ? 'info' : 'error');
    } else {
      showToast(`Selected ${matched} order(s)`, 'success');
    }
  }

  function close() {
    setResults(null);
    setDeliveryChargesOpen(false);
    onClose();
  }

  const action = (key: string, label: string, onAction: () => void, extra: Partial<ButtonProps> = {}) => (
    <Button key={key} size="slim" disabled={!!busy} loading={busy === key} onClick={onAction} {...extra}>{label}</Button>
  );
  const numberList = (nums: Array<string | number> | undefined) => ((nums?.length ?? 0) === 0
    ? <Text as="p" tone="subdued">None</Text>
    : <InlineStack gap="100">{nums!.map((n) => <Badge key={n}>{String(n)}</Badge>)}</InlineStack>);

  return (
    <>
      <InfoModal title="Bulk update order" onClose={close}>
        {!results ? (
          <BlockStack gap="400">
            <OrderNumbersField value={text} onChange={setText} rows={6} autoFocus />
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Order status</Text>
              <InlineStack gap="200">
                {action('delivered', 'Delivered', () => setStatus('delivered'), { variant: 'primary' })}
                {action('returned', 'Returned', () => setStatus('returned'))}
                {action('cancelled', 'Cancelled', () => setStatus('cancelled'))}
                {action('piece_received', 'Returned + Piece Received', setPieceReceived)}
              </InlineStack>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Courier &amp; charges</Text>
              <InlineStack gap="200">
                {action('settled', 'Mark Order Settled', () => setSettled(true), { variant: 'primary', tone: 'success' })}
                {action('unsettled', 'Mark Order Unsettled', () => setSettled(false))}
                {action('charges', 'Update Delivery Charges', () => { if (requireOrderNumbers()) setDeliveryChargesOpen(true); })}
              </InlineStack>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Grid</Text>
              <InlineStack><Button size="slim" onClick={selectInGrid}>Select in Grid</Button></InlineStack>
            </BlockStack>
          </BlockStack>
        ) : (
          <BlockStack gap="400">
            <BlockStack gap="200"><Text as="h3" variant="headingSm">Updated successfully</Text>{numberList(results.updated_order_numbers)}</BlockStack>
            <BlockStack gap="200"><Text as="h3" variant="headingSm">Not found / failed</Text>{numberList(results.not_found_order_numbers)}</BlockStack>
          </BlockStack>
        )}
      </InfoModal>
      {returnedAdvanceGateElement}
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
    <FormModal title="Update delivery charges" onClose={onClose} onSubmit={submit} submitLabel="Confirm" saving={saving} size="small">
      <TextField
        label="Delivery charges (Rs)" type="number" autoComplete="off" min={0} step={0.01} placeholder="0.00" autoFocus requiredIndicator
        helpText={`Applies to ${orderNumbers.length} order${orderNumbers.length === 1 ? '' : 's'}.`} value={value} onChange={setValue}
      />
    </FormModal>
  );
}
