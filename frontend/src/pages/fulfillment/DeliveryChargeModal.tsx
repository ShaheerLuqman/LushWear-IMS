// A Local Delivery order's delivery charge and the ledger the rider was paid from
// (PUT /orders/{id}/local-delivery; a trigger posts the payment). Shared by the Local
// Deliveries page and the order details popup.
import { useEffect, useState } from 'react';
import { FormLayout, TextField } from '@shopify/polaris';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { Dropdown } from '../../components/Dropdown';
import { FormModal } from '../../components/FormModal';
import { getCashLedger, postExCashLedgerOptions } from '../../logic/ledgers';
import { useLedgersData } from '../finance/useLedgersData';

export interface DeliveryChargePatch { delivery_charge: number | null; delivery_charge_ledger_id: string | null }

export function DeliveryChargeModal({ order, onClose, onSaved }: {
  order: { id: string; order_number?: number; delivery_charge?: number | null; delivery_charge_ledger_id?: string | null };
  onClose: () => void;
  onSaved: (patch: DeliveryChargePatch) => void;
}) {
  const { showToast } = useToast();
  const { ledgers, loadLedgersList } = useLedgersData();
  useEffect(() => { loadLedgersList(); }, [loadLedgersList]);
  const [amount, setAmount] = useState(order.delivery_charge == null ? '' : String(order.delivery_charge));
  const [pickedLedgerId, setLedgerId] = useState(order.delivery_charge_ledger_id || '');
  // Ledgers may still be loading when the popup opens, so the Cash default is derived, not frozen at mount.
  const ledgerId = pickedLedgerId || getCashLedger(ledgers)?.id || '';
  const [saving, setSaving] = useState(false);
  const charge = amount.trim() === '' ? null : parseFloat(amount);

  async function save() {
    if (charge != null && (Number.isNaN(charge) || charge < 0)) { showToast('Enter a valid amount', 'error', { silent: true }); return; }
    // Blank (not known yet) or 0 (the customer paid the rider): nothing was paid from a ledger.
    const patch: DeliveryChargePatch = { delivery_charge: charge, delivery_charge_ledger_id: charge ? ledgerId : null };
    if (charge && !ledgerId) { showToast('Select the ledger it was paid from', 'error', { silent: true }); return; }
    setSaving(true);
    try {
      await apiJson(`/orders/${order.id}/local-delivery`, {
        method: 'PUT', body: { delivery_charge: patch.delivery_charge, ledger_id: patch.delivery_charge_ledger_id },
        fallback: 'Failed to save the delivery charge',
      });
      showToast(`Delivery charge saved for order #${order.order_number}`, 'success');
      onSaved(patch);
      onClose();
    } catch (error: any) {
      showToast(error?.message || 'Failed to save the delivery charge', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal title={`Delivery charge: order #${order.order_number}`} onClose={onClose} onSubmit={save} saving={saving}>
      <FormLayout>
        <TextField
          label="Delivery charge" type="number" autoComplete="off" min={0} step={0.01} value={amount} onChange={setAmount}
          helpText="0 if the customer paid the rider. Leave blank if it isn't known yet."
        />
        {!!charge && (
          <Dropdown
            label="Paid from" fullWidth placeholder="Select ledger..."
            options={postExCashLedgerOptions(ledgers).map((l) => ({ value: l.id, label: l.name }))} value={ledgerId} onChange={setLedgerId}
          />
        )}
      </FormLayout>
    </FormModal>
  );
}
