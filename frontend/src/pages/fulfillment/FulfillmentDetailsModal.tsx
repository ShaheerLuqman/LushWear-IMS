// Per-order shipping details, opened from a fulfillment row's kebab. Mirrors
// PostEx's own booking screen; fields it lacks are hidden for Couriers Next.
import { useEffect, useState } from 'react';
import { BlockStack, FormLayout, List, Text, TextField } from '@shopify/polaris';
import { fulfillmentLineItemLabel, fulfillmentOrderDetailString, type FulfillmentOrder } from '../../logic/fulfillment';
import { Dropdown } from '../../components/Dropdown';
import { FormModal } from '../../components/FormModal';

export function FulfillmentDetailsModal({
  order, isCouriersNext, pickupLabel, onClose, onSave,
}: {
  order: FulfillmentOrder;
  isCouriersNext: boolean;
  pickupLabel: string;
  onClose: () => void;
  onSave: (patch: Partial<FulfillmentOrder>) => void;
}) {
  const [email, setEmail] = useState(order.email || '');
  const [instructions, setInstructions] = useState(order.instructions || '');
  const [handling, setHandling] = useState(order.handling || 'Standard');
  const [pieces, setPieces] = useState(String(order.pieces ?? 1));
  const [invoiceDivision, setInvoiceDivision] = useState(String(order.invoiceDivision ?? 1));

  // Shows the "- FRAGILE" bullet live while the modal is open; the backend also
  // adds it at send time (idempotently) for any booking that skips this modal.
  useEffect(() => {
    setInstructions((prev) => {
      const lines = prev.split('\n').filter((l) => l.trim().toUpperCase() !== '- FRAGILE');
      if (handling === 'Fragile') {
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        lines.push('- FRAGILE');
      }
      return lines.join('\n');
    });
  }, [handling]);

  const lineItems = order.line_items || [];

  function submit() {
    onSave({
      email: email.trim(),
      instructions: instructions.trim(),
      handling,
      pieces: Math.max(1, parseInt(pieces, 10) || 1),
      invoiceDivision: Math.max(1, parseInt(invoiceDivision, 10) || 1),
    });
  }

  return (
    <FormModal title="Shipping Details" onClose={onClose} onSubmit={submit}>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">Order #{order.order_number} · {order.name}</Text>
        <FormLayout>
          <TextField label="Pickup Location" autoComplete="off" readOnly value={pickupLabel} />
          {!isCouriersNext && <Dropdown label="Handling" fullWidth options={['Standard', 'Fragile']} value={handling} onChange={setHandling} />}
          <TextField label="Email Address" type="email" autoComplete="email" placeholder="user@user.com" value={email} onChange={setEmail} autoFocus />
          <FormLayout.Group>
            <TextField label="Pieces" type="number" autoComplete="off" min={1} step={1} value={pieces} onChange={setPieces} />
            {!isCouriersNext && (
              <TextField label="Invoice Division" type="number" autoComplete="off" min={1} step={1} value={invoiceDivision} onChange={setInvoiceDivision} />
            )}
          </FormLayout.Group>
          {!isCouriersNext && <TextField label="Payment Method" autoComplete="off" readOnly value="Manual" />}
          <BlockStack gap="100">
            <Text as="span" variant="bodyMd">Fulfillment Products</Text>
            {lineItems.length
              ? <List>{lineItems.map((li, i) => <List.Item key={i}>{String(li.qty)} × {fulfillmentLineItemLabel(li)}</List.Item>)}</List>
              : <Text as="p" tone="subdued">No products on this order</Text>}
          </BlockStack>
          <TextField label="Products" autoComplete="off" multiline={2} readOnly value={fulfillmentOrderDetailString(lineItems)} />
          <TextField label={isCouriersNext ? 'Special Instructions' : 'Remarks'} autoComplete="off" multiline={3} value={instructions} onChange={setInstructions} />
        </FormLayout>
      </BlockStack>
    </FormModal>
  );
}
