// Upload PostEx CSV modal - uploads a Consolidated Payment Report CSV, settling every
// order it covers. Ported from orders-actions.js's openUploadPostExModal wiring +
// ledgers.js's uploadPostExCsv/postExFolioFromDate.
import { useState } from 'react';
import { DropZone, FormLayout, Text, TextField } from '@shopify/polaris';
import { apiRequest } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { postExCashLedgerOptions, type Ledger } from '../../logic/ledgers';
import { Dropdown } from '../../components/Dropdown';
import { FormModal } from '../../components/FormModal';

// Mirrors backend/app/services/postex.py's _folio_from_date: unpadded day/month, 2-digit
// year (e.g. "2/9/26"), so a CSV upload's default folio parses the same way a PostEx
// tracking-API-derived one does.
function postExFolioFromDate(isoDate: string): string {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return '';
  return `${day}/${month}/${String(year).slice(2)}`;
}

export function UploadPostExModal({
  ledgers, onClose, onUploaded,
}: {
  ledgers: Ledger[];
  onClose: () => void;
  onUploaded: (data: any) => void;
}) {
  const { showToast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [cprDate, setCprDate] = useState('');
  const [assignmentNumber, setAssignmentNumber] = useState('');
  const [assignmentAutofilled, setAssignmentAutofilled] = useState(true);
  const [cashLedgerId, setCashLedgerId] = useState('');
  const [uploading, setUploading] = useState(false);

  function onCprDateChange(value: string) {
    setCprDate(value);
    // Only overwrite a folio the user hasn't typed over themselves - re-picking the date
    // after a manual edit must not clobber it.
    if (assignmentAutofilled) setAssignmentNumber(postExFolioFromDate(value));
  }

  async function upload() {
    if (!file) { showToast('Please select a CSV file', 'error', { silent: true }); return; }
    if (!cprDate) { showToast('Please select the CPR date', 'error', { silent: true }); return; }
    if (!cashLedgerId) { showToast('Please select where the amount was received', 'error', { silent: true }); return; }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const trimmedAssignment = assignmentNumber.trim();
      if (trimmedAssignment) formData.append('assignment_number', trimmedAssignment);
      formData.append('cash_ledger_id', cashLedgerId);
      const res = await apiRequest('/orders/upload-postex-csv', { method: 'POST', body: formData, fallback: 'Upload failed' });
      const data = await res.json();
      const postedSuffix = data.voucher_posted ? ' Posted to ledger.' : '';
      showToast((data.message || `Updated ${data.updated || 0} order(s).`) + postedSuffix, 'success');
      onClose();
      if ((data.order_breakdown || []).length > 0) onUploaded(data);
    } catch (error: any) {
      console.error('Error uploading PostEx CSV', error);
      showToast(error?.message || 'Failed to upload PostEx CSV', 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <FormModal title="Upload PostEx CSV" onClose={onClose} onSubmit={upload} submitLabel="Upload" saving={uploading}>
      <FormLayout>
        <Text as="p" tone="subdued">Select a PostEx CSV file and the CPR date it settles.</Text>
        <DropZone label="CSV File" accept=".csv" type="file" allowMultiple={false} variableHeight onDrop={(files) => setFile(files[0] || null)}>
          {file ? <div className="dropzone-selected"><Text as="p">{file.name}</Text></div> : <DropZone.FileUpload actionTitle="Choose CSV" actionHint="or drop it here" />}
        </DropZone>
        <TextField label="CPR Date" type="date" autoComplete="off" value={cprDate} onChange={onCprDateChange} requiredIndicator />
        <TextField label="Folio" autoComplete="off" placeholder="e.g. 2/9/26" value={assignmentNumber} onChange={(v) => { setAssignmentNumber(v); setAssignmentAutofilled(false); }} />
        <Dropdown label="Amount Received In" fullWidth placeholder="Select ledger..." options={postExCashLedgerOptions(ledgers).map((l) => ({ value: l.id, label: l.name }))} value={cashLedgerId} onChange={setCashLedgerId} />
      </FormLayout>
    </FormModal>
  );
}
