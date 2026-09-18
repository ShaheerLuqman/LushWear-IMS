// Upload PostEx CSV modal - uploads a Consolidated Payment Report CSV, settling every
// order it covers. Ported from orders-actions.js's openUploadPostExModal wiring +
// ledgers.js's uploadPostExCsv/postExFolioFromDate.
import { useState } from 'react';
import { apiRequest } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { postExCashLedgerOptions, type Ledger } from '../../logic/ledgers';

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
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget && !uploading) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Upload PostEx CSV</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={uploading}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-description">Select a PostEx CSV file and the CPR date it settles.</p>
          <div className="form-group">
            <label htmlFor="uploadPostExFileInput">CSV File *</label>
            <div className="upload-postex-file-row">
              <input type="file" id="uploadPostExFileInput" accept=".csv" className="form-input" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <span className="upload-postex-filename">{file ? file.name : 'No file chosen'}</span>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="uploadPostExCprDate">CPR Date *</label>
            <input type="date" id="uploadPostExCprDate" className="form-input" value={cprDate} onChange={(e) => onCprDateChange(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="uploadPostExAssignmentNumber">Folio</label>
            <input
              type="text" id="uploadPostExAssignmentNumber" className="form-input" placeholder="e.g. 2/9/26"
              value={assignmentNumber}
              onChange={(e) => { setAssignmentNumber(e.target.value); setAssignmentAutofilled(false); }}
            />
          </div>
          <div className="form-group">
            <label htmlFor="uploadPostExCashLedger">Amount Received In *</label>
            <select id="uploadPostExCashLedger" className="form-input" value={cashLedgerId} onChange={(e) => setCashLedgerId(e.target.value)}>
              <option value="">Select ledger...</option>
              {postExCashLedgerOptions(ledgers).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={uploading}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={uploading} onClick={upload}>{uploading ? 'Uploading...' : 'Upload'}</button>
        </div>
      </div>
    </div>
  );
}
