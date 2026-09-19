// Generate Load Sheet modal - saves a load sheet log then downloads its PDF. Ported from
// orders-actions.js's openGenerateLoadSheetModal/confirmGenerateLoadSheet.
import { useState } from 'react';
import { FormLayout, TextField } from '@shopify/polaris';
import { FormModal } from '../../components/FormModal';
import { OrderNumbersField } from '../../components/OrderNumbersField';
import { SuggestField } from '../../components/SuggestField';
import { apiJson, apiRequest } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { loadSheetFilenameFromDateAndRider, parseOrderNumbersFromText, type LoadSheetLog } from '../../logic/loadSheets';

export function GenerateLoadSheetModal({
  initialOrderNumbers, riderNames, nextAssignmentNumber, onClose, onDone,
}: {
  initialOrderNumbers: Array<string | number>;
  riderNames: string[];
  nextAssignmentNumber: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [orderNumbersText, setOrderNumbersText] = useState(() => [...new Set(initialOrderNumbers.map(String))].join('\n'));
  const [assignmentNumber, setAssignmentNumber] = useState(() => `LW-${nextAssignmentNumber}`);
  const [riderName, setRiderName] = useState('');
  const [deliveryCharge, setDeliveryCharge] = useState('');
  const [saving, setSaving] = useState(false);

  const orderNumbers = parseOrderNumbersFromText(orderNumbersText);

  async function confirm() {
    const trimmedAssignment = assignmentNumber.trim();
    const trimmedRider = riderName.trim();
    if (!trimmedAssignment) { showToast('Enter assignment number', 'error', { silent: true }); return; }
    if (!trimmedRider) { showToast('Enter rider name', 'error', { silent: true }); return; }
    const dcRaw = deliveryCharge.trim();
    const dc = dcRaw === '' ? null : parseFloat(dcRaw);
    if (dc !== null && (Number.isNaN(dc) || dc < 0)) { showToast('Delivery charges must be 0 or greater', 'error', { silent: true }); return; }
    if (orderNumbers.length === 0) return;

    setSaving(true);
    try {
      const logData = await apiJson<LoadSheetLog>('/orders/load-sheet-logs', {
        method: 'POST',
        body: { assignment_number: trimmedAssignment, rider_name: trimmedRider, order_numbers: orderNumbers, delivery_charge: dc },
        fallback: 'Failed to save load sheet log',
      });
      onClose();
      const pdfRes = await apiRequest(`/orders/load-sheet-logs/${logData.id}/pdf`, { fallback: 'Failed to generate PDF' });
      const blob = await pdfRes.blob();
      const filename = loadSheetFilenameFromDateAndRider(new Date(), trimmedRider);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      const savedCount = Array.isArray(logData.order_numbers) ? logData.order_numbers.length : orderNumbers.length;
      const cancelledSkipped = logData.cancelled_order_numbers || [];
      const skippedNote = cancelledSkipped.length ? ` (${cancelledSkipped.length} cancelled order(s) skipped: ${cancelledSkipped.join(', ')})` : '';
      showToast(`Load sheet saved and PDF downloaded (${savedCount} order(s))${skippedNote}`, 'success');
      onDone();
    } catch (error: any) {
      showToast(error?.message || 'Failed to generate load sheet', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title="Generate Load Sheet" onClose={onClose} onSubmit={confirm} submitLabel="Generate & Download PDF"
      saving={saving} disabled={orderNumbers.length === 0}
    >
      <FormLayout>
        <OrderNumbersField value={orderNumbersText} onChange={setOrderNumbersText} />
        <TextField label="Assignment number" autoComplete="off" value={assignmentNumber} onChange={setAssignmentNumber} />
        <SuggestField label="Rider name" value={riderName} onChange={setRiderName} suggestions={riderNames} />
        <TextField label="Delivery charges (Rs)" type="number" autoComplete="off" min={0} step={0.01} placeholder="0.00" value={deliveryCharge} onChange={setDeliveryCharge} />
      </FormLayout>
    </FormModal>
  );
}
