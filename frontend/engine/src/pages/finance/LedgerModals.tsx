// Create / Edit ledger modals - ported from ledgers.js + the createLedgerModal/
// editLedgerModal markup in index.html.
import { useEffect, useState } from 'react';
import { apiJson, apiRequest } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { findLedgerByName, SYSTEM_LEDGER_LABELS, type Ledger } from '../../logic/ledgers';

const LEDGER_TYPES = [
  ['Asset', "Asset (Cash, Bank, Accounts Receivable, Inventory, Equipment)"],
  ['Liability', 'Liability (Accounts Payable, Loans, Taxes Payable)'],
  ['Equity', "Equity (Owner's Capital, Investor's Capital)"],
  ['Revenue', 'Revenue (Sales, Service Revenue)'],
  ['Expense', 'Expense (Rent, Salaries, Advertisement, Fuel, Office Supplies)'],
] as const;

interface PartyFields { tax_number: string | null; phone: string | null; email: string | null; address: string | null }
const EMPTY_PARTY: PartyFields = { tax_number: null, phone: null, email: null, address: null };

function PartyFieldsFields({ prefix, value, onChange }: { prefix: string; value: PartyFields; onChange: (v: PartyFields) => void }) {
  return (
    <>
      <div className="form-group">
        <label htmlFor={`${prefix}LedgerTaxNumber`}>Tax number (NTN)</label>
        <input type="text" id={`${prefix}LedgerTaxNumber`} className="form-input" value={value.tax_number || ''} onChange={(e) => onChange({ ...value, tax_number: e.target.value })} />
      </div>
      <div className="bill-form-row">
        <div className="form-group">
          <label htmlFor={`${prefix}LedgerPhone`}>Phone</label>
          <input type="text" id={`${prefix}LedgerPhone`} className="form-input" value={value.phone || ''} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
        </div>
        <div className="form-group">
          <label htmlFor={`${prefix}LedgerEmail`}>Email</label>
          <input type="text" id={`${prefix}LedgerEmail`} className="form-input" value={value.email || ''} onChange={(e) => onChange({ ...value, email: e.target.value })} />
        </div>
      </div>
      <div className="form-group">
        <label htmlFor={`${prefix}LedgerAddress`}>Address</label>
        <input type="text" id={`${prefix}LedgerAddress`} className="form-input" value={value.address || ''} onChange={(e) => onChange({ ...value, address: e.target.value })} />
      </div>
    </>
  );
}

function partyPayload(v: PartyFields) {
  return {
    tax_number: v.tax_number?.trim() || null,
    phone: v.phone?.trim() || null,
    email: v.email?.trim() || null,
    address: v.address?.trim() || null,
  };
}

export function CreateLedgerModal({
  ledgers, onClose, onCreated,
}: {
  ledgers: Ledger[];
  onClose: () => void;
  onCreated: (l: Ledger) => void;
}) {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [cashInHand, setCashInHand] = useState(false);
  const [monthSummary, setMonthSummary] = useState(true);
  const [party, setParty] = useState<PartyFields>(EMPTY_PARTY);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    const trimmedName = name.trim();
    if (!trimmedName) { showToast('Enter a ledger name', 'error', { silent: true }); return; }
    if (!type) { showToast('Select a type', 'error', { silent: true }); return; }
    if (findLedgerByName(ledgers, trimmedName)) { showToast('A ledger with this name already exists', 'error', { silent: true }); return; }
    setSaving(true);
    try {
      const created = await apiJson<Ledger>('/ledgers/', {
        method: 'POST',
        body: {
          name: trimmedName, type,
          include_in_cash_in_hand: type === 'Asset' && cashInHand,
          show_in_month_summary: type === 'Expense' && monthSummary,
          opening_balance: parseFloat(openingBalance) || 0,
          ...partyPayload(party),
        },
        fallback: 'Failed to create ledger',
      });
      showToast('Ledger created', 'success');
      onCreated(created);
    } catch (error: any) {
      showToast(error?.message || 'Failed to create ledger', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Create Ledger</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <form className="ledger-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="form-group">
              <label htmlFor="createLedgerName">Ledger name *</label>
              <input type="text" id="createLedgerName" className="form-input" placeholder="e.g. Main Bank Account" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="createLedgerType">Type (Nature) *</label>
              <select id="createLedgerType" className="form-input" required value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">Select type...</option>
                {LEDGER_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="createLedgerOpeningBalance">Opening balance</label>
              <input type="number" id="createLedgerOpeningBalance" className="form-input" placeholder="0.00" step={0.01} value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
              <span className="form-hint">Positive is a Debit amount, negative is a Credit amount.</span>
            </div>
            {type === 'Asset' && (
              <label className="ledger-form-toggle"><input type="checkbox" checked={cashInHand} onChange={(e) => setCashInHand(e.target.checked)} /><span>Include in Cash In Hand</span></label>
            )}
            {type === 'Expense' && (
              <label className="ledger-form-toggle"><input type="checkbox" checked={monthSummary} onChange={(e) => setMonthSummary(e.target.checked)} /><span>Show in Month Summary</span></label>
            )}
            <PartyFieldsFields prefix="create" value={party} onChange={setParty} />
          </form>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? 'Creating...' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

export function EditLedgerModal({
  ledgers, ledgerId, onClose, onSaved, onDeleted,
}: {
  ledgers: Ledger[];
  ledgerId: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { isEditingAllowed } = useAuth();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [originalOpeningBalance, setOriginalOpeningBalance] = useState(0);
  const [cashInHand, setCashInHand] = useState(false);
  const [monthSummary, setMonthSummary] = useState(false);
  const [party, setParty] = useState<PartyFields>(EMPTY_PARTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const l = await apiJson<Ledger>(`/ledgers/${ledgerId}`, { fallback: 'Failed to load ledger' });
        setLedger(l);
        setName(l.name || '');
        setType(l.type || '');
        const opening = parseFloat(String(l.opening_balance)) || 0;
        setOriginalOpeningBalance(opening);
        setOpeningBalance(opening ? String(opening) : '');
        setCashInHand(!!l.include_in_cash_in_hand);
        setMonthSummary(l.show_in_month_summary !== false);
        setParty({ tax_number: l.tax_number ?? null, phone: l.phone ?? null, email: l.email ?? null, address: l.address ?? null });
      } catch (error) {
        console.error('Error opening edit ledger:', error);
        showToast('Failed to load ledger', 'error');
        onClose();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerId]);

  if (!ledger) return null;

  const isSystem = !!ledger.system_key;
  const hasEntries = !!ledger.has_entries;
  const cannotDelete = isSystem || hasEntries;

  async function submit() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    const trimmedName = name.trim();
    const trimmedType = type.trim();
    if (!trimmedName || !trimmedType) { showToast('Name and type are required', 'error', { silent: true }); return; }
    const existing = findLedgerByName(ledgers, trimmedName);
    if (existing && existing.id !== ledgerId) { showToast('A ledger with this name already exists', 'error', { silent: true }); return; }
    const confirmed = await confirm({ title: 'Update Ledger', message: 'Are you sure you want to update this ledger?', confirmText: 'Save' });
    if (!confirmed) return;
    const opening = parseFloat(openingBalance) || 0;
    const body: Record<string, unknown> = {
      name: trimmedName, type: trimmedType,
      include_in_cash_in_hand: trimmedType === 'Asset' && cashInHand,
      show_in_month_summary: trimmedType === 'Expense' && monthSummary,
      ...partyPayload(party),
    };
    if (opening !== originalOpeningBalance) body.opening_balance = opening;
    setSaving(true);
    try {
      await apiJson(`/ledgers/${ledgerId}`, { method: 'PUT', body, fallback: 'Failed to update ledger' });
      showToast('Ledger updated', 'success');
      onSaved();
    } catch (error: any) {
      showToast(error?.message || 'Failed to update ledger', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (cannotDelete) return;
    const confirmed = await confirm({ title: 'Delete Ledger', message: 'Are you sure you want to delete this ledger? This cannot be undone.', confirmText: 'Delete', danger: true });
    if (!confirmed) return;
    try {
      await apiRequest(`/ledgers/${ledgerId}`, { method: 'DELETE', fallback: 'Failed to delete ledger' });
      showToast('Ledger deleted', 'success');
      onDeleted();
    } catch (error) {
      console.error('Error deleting ledger:', error);
      showToast('Failed to delete ledger', 'error');
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Edit Ledger</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body" onClick={(e) => e.stopPropagation()}>
          <form className="ledger-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {isSystem && (
              <p className="ledger-system-notice">System account ({SYSTEM_LEDGER_LABELS[ledger.system_key!] || ledger.system_key}) — used by the app, so it can't be deleted.</p>
            )}
            <div className="form-group">
              <label htmlFor="editLedgerName">Ledger name *</label>
              <input type="text" id="editLedgerName" className="form-input" placeholder="e.g. Main Bank Account" required readOnly={isSystem} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="editLedgerType">Type (Nature) *</label>
              <select id="editLedgerType" className="form-input" required value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">Select type...</option>
                {LEDGER_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="editLedgerOpeningBalance">Opening balance</label>
              <input type="number" id="editLedgerOpeningBalance" className="form-input" placeholder="0.00" step={0.01} value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
              <span className="form-hint">Positive is a Debit amount, negative is a Credit amount.</span>
            </div>
            {type === 'Asset' && (
              <label className="ledger-form-toggle"><input type="checkbox" checked={cashInHand} onChange={(e) => setCashInHand(e.target.checked)} /><span>Include in Cash In Hand</span></label>
            )}
            {type === 'Expense' && (
              <label className="ledger-form-toggle"><input type="checkbox" checked={monthSummary} onChange={(e) => setMonthSummary(e.target.checked)} /><span>Show in Month Summary</span></label>
            )}
            <PartyFieldsFields prefix="edit" value={party} onChange={setParty} />
          </form>
        </div>
        <div className="modal-pinned-footer edit-ledger-actions">
          <span className="ledger-edit-delete-wrap" title={isSystem ? 'Cannot delete: system account' : (hasEntries ? 'Cannot delete: ledger has entries' : 'Delete ledger (no entries)')}>
            <button type="button" className={'btn btn-danger ledger-edit-delete-btn' + (cannotDelete ? ' ledger-edit-delete-btn-has-entries' : '')} disabled={cannotDelete} onClick={remove}>Delete</button>
          </span>
          <div className="edit-ledger-actions-right">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
