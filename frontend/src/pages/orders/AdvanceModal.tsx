// Receive or edit a customer's advance on an unbooked order, or refund it once the order
// is fully paid. The ledger and Shopify side live in the backend's set_order_advance
// (PUT /orders/{id}/advance).
import { useState } from 'react';
import { FormLayout, Text, TextField } from '@shopify/polaris';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { useConfirm } from '../../components/ConfirmContext';
import { getCashLedger, postExCashLedgerOptions, type Ledger } from '../../logic/ledgers';
import type { Order } from '../../logic/orders';
import { getPKTDateString } from '../../logic/shared';
import { Dropdown } from '../../components/Dropdown';
import { FormModal } from '../../components/FormModal';
import { isFullyPaid, money } from './ordersPolarisColumns';

export function AdvanceModal({
  order, ledgers, onClose, onSaved,
}: {
  order: Pick<Order, 'id' | 'order_number' | 'total_amount' | 'advance_amount'>;
  ledgers: Ledger[];
  onClose: () => void;
  onSaved: (patch: Pick<Order, 'advance_amount' | 'advance_status' | 'tags'>) => void;
}) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const total = Number(order.total_amount) || 0;
  const current = Number(order.advance_amount) || 0;
  const refundMode = isFullyPaid(order);
  const [amount, setAmount] = useState(String(current || total));
  const [pickedLedgerId, setLedgerId] = useState('');
  // Ledgers may still be loading when the popup opens, so the Cash default is derived, not frozen at mount.
  const ledgerId = pickedLedgerId || getCashLedger(ledgers)?.id || '';
  const [entryDate, setEntryDate] = useState(getPKTDateString());
  const [particulars, setParticulars] = useState('');
  const [saving, setSaving] = useState(false);
  const returning = !refundMode && parseFloat(amount) < current;

  async function save() {
    // A refund is always the whole advance.
    const advance = refundMode ? 0 : parseFloat(amount);
    if (Number.isNaN(advance) || advance < 0) { showToast('Enter a valid amount', 'error', { silent: true }); return; }
    if (advance > total) { showToast(`The advance cannot exceed the order total (${money(total)})`, 'error', { silent: true }); return; }
    if (!ledgerId) { showToast('Select the account for the advance', 'error', { silent: true }); return; }
    if (refundMode && !await confirm({
      title: `Refund ${money(current - advance)} on order #${order.order_number}?`,
      message: "This refunds the payment on Shopify and cannot be undone. The order's advance is locked afterwards: no more advance can be received or refunded on it.",
      confirmText: 'Refund',
      danger: true,
    })) return;
    setSaving(true);
    try {
      const { already_refunded_on_shopify: alreadyRefunded, ...saved } = await apiJson<
        Pick<Order, 'advance_amount' | 'advance_status' | 'tags'> & { already_refunded_on_shopify: boolean }
      >(`/orders/${order.id}/advance`, {
        method: 'PUT',
        body: { advance, ledger_id: ledgerId, entry_date: entryDate, description: particulars.trim() || null, idempotency_key: crypto.randomUUID() },
        fallback: refundMode ? 'Failed to refund the advance' : 'Failed to save the advance',
      });
      showToast(
        refundMode ? (alreadyRefunded
          ? `Order #${order.order_number} was already refunded on Shopify; recorded the refund here`
          : `Refunded ${money(current - advance)} on order #${order.order_number}`)
          : advance === total ? `Order #${order.order_number} marked paid` : `Advance saved for order #${order.order_number}`,
        'success',
      );
      onSaved(saved);
      onClose();
    } catch (error: any) {
      showToast(error?.message || 'Failed to save the advance', 'error');
    } finally {
      setSaving(false);
    }
  }

  const verb = refundMode ? 'Refund' : current ? 'Edit' : 'Receive';
  return (
    <FormModal
      title={`${verb} advance: order #${order.order_number}`} onClose={onClose} onSubmit={save} saving={saving}
      submitLabel={refundMode ? 'Refund' : 'Save'} destructive={refundMode}
    >
      <FormLayout>
        {refundMode ? (
          <Text as="p">
            Order #{order.order_number} is fully paid. This refunds the full advance of {money(current)} to the customer.
          </Text>
        ) : (
          <>
            <Text as="p" tone="subdued">
              Order total {money(total)}{current ? `, advance so far ${money(current)}` : ''}. The full total marks the order paid on Shopify.
            </Text>
            <TextField
              label="Advance received" type="number" autoComplete="off" min={0} max={total} step={0.01} requiredIndicator
              value={amount} onChange={setAmount} helpText="The order's total advance, not the amount being added."
            />
          </>
        )}
        <Dropdown
          label={refundMode ? 'Refunded from' : returning ? 'Returned from' : 'Received in'} fullWidth placeholder="Select ledger..."
          options={postExCashLedgerOptions(ledgers).map((l) => ({ value: l.id, label: l.name }))} value={ledgerId} onChange={setLedgerId}
        />
        <TextField label="Date" type="date" autoComplete="off" requiredIndicator value={entryDate} onChange={setEntryDate} />
        <TextField
          label="Particulars" autoComplete="off" value={particulars} onChange={setParticulars}
          placeholder={`${refundMode ? 'Advance refunded' : returning ? 'Advance returned' : current ? 'Additional advance received' : 'Advance received'} for Order #${order.order_number}`}
        />
      </FormLayout>
    </FormModal>
  );
}
