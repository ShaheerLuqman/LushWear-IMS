// A returned order's advance is never kept, so marking Piece Received first refunds the
// advance of every order that still holds one. The ledger and Shopify side live in the
// backend's refund_returned_advances (POST /orders/returned-advances/refund).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FormLayout, List, Text, TextField } from '@shopify/polaris';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { useConfirm } from '../../components/ConfirmContext';
import { Dropdown } from '../../components/Dropdown';
import { FormModal } from '../../components/FormModal';
import { getCashLedger, postExCashLedgerOptions } from '../../logic/ledgers';
import { getPKTDateString } from '../../logic/shared';
import { useLedgersData } from '../finance/useLedgersData';
import { money } from './ordersPolarisColumns';

interface PendingAdvance { order_number: number; advance_amount: number }

function ReturnedAdvanceRefundModal({ pending, onDone }: { pending: PendingAdvance[]; onDone: (refunded: boolean) => void }) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { ledgers, loadLedgersList } = useLedgersData();
  const [pickedLedgerId, setLedgerId] = useState('');
  // Ledgers may still be loading when the popup opens, so the Cash default is derived, not frozen at mount.
  const ledgerId = pickedLedgerId || getCashLedger(ledgers)?.id || '';
  const [entryDate, setEntryDate] = useState(getPKTDateString());
  const [saving, setSaving] = useState(false);
  const total = pending.reduce((sum, p) => sum + p.advance_amount, 0);

  useEffect(() => { loadLedgersList(); }, [loadLedgersList]);

  async function refund() {
    if (!ledgerId) { showToast('Select the account the refund is paid from', 'error', { silent: true }); return; }
    if (!await confirm({
      title: `Refund ${money(total)}?`,
      message: 'This refunds the advance of every order listed, on Shopify too where it was marked paid, and cannot be undone.',
      confirmText: 'Refund',
      danger: true,
    })) return;
    setSaving(true);
    try {
      await apiJson('/orders/returned-advances/refund', {
        method: 'POST',
        body: { order_numbers: pending.map((p) => p.order_number), ledger_id: ledgerId, entry_date: entryDate },
        fallback: 'Failed to refund the advances',
      });
      showToast(`Refunded ${money(total)}`, 'success');
      onDone(true);
    } catch (error: any) {
      showToast(error?.message || 'Failed to refund the advances', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal title="Refund advances first" onClose={() => onDone(false)} onSubmit={refund} submitLabel="Refund" destructive saving={saving}>
      <FormLayout>
        <Text as="p">A returned order's advance is always refunded. These orders hold one, so it is refunded before they are marked Piece Received:</Text>
        <List>
          {pending.map((p) => <List.Item key={p.order_number}>#{p.order_number}: {money(p.advance_amount)}</List.Item>)}
        </List>
        <Dropdown
          label="Refunded from" fullWidth placeholder="Select ledger..."
          options={postExCashLedgerOptions(ledgers).map((l) => ({ value: l.id, label: l.name }))} value={ledgerId} onChange={setLedgerId}
        />
        <TextField label="Date" type="date" autoComplete="off" requiredIndicator value={entryDate} onChange={setEntryDate} />
      </FormLayout>
    </FormModal>
  );
}

/** `gate(orderNumbers)` resolves true once none of them holds an unrefunded advance -
 * straight away, or after the refund popup (`element`, to be rendered) - and false if the
 * user backs out or the check fails. */
export function useReturnedAdvanceGate(): { gate: (orderNumbers: number[]) => Promise<boolean>; element: ReactNode } {
  const { showToast } = useToast();
  const [pending, setPending] = useState<{ orders: PendingAdvance[]; resolve: (ok: boolean) => void } | null>(null);

  const gate = useCallback(async (orderNumbers: number[]) => {
    try {
      const orders = await apiJson<PendingAdvance[]>('/orders/returned-advances/pending', {
        method: 'POST', body: { order_numbers: orderNumbers }, fallback: 'Failed to check the advances',
      });
      return orders.length === 0 || new Promise<boolean>((resolve) => setPending({ orders, resolve }));
    } catch (error: any) {
      showToast(error?.message || 'Failed to check the advances', 'error');
      return false;
    }
  }, [showToast]);

  const element = pending && (
    <ReturnedAdvanceRefundModal pending={pending.orders} onDone={(ok) => { pending.resolve(ok); setPending(null); }} />
  );
  return { gate, element };
}
