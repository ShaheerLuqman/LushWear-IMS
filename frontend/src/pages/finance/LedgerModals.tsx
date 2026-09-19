// Create / Edit ledger modals - ported from ledgers.js + the createLedgerModal/
// editLedgerModal markup in index.html.
import { useEffect, useState } from 'react';
import { apiJson, apiRequest } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { findLedgerByName, SYSTEM_LEDGER_LABELS, type Ledger } from '../../logic/ledgers';
import { Banner, BlockStack, Checkbox, FormLayout, TextField } from '@shopify/polaris';
import { Dropdown } from '../../components/Dropdown';
import { FormModal } from '../../components/FormModal';

const LEDGER_TYPE_OPTIONS = [
  { value: 'Asset', label: 'Asset (Cash, Bank, Accounts Receivable, Inventory, Equipment)' },
  { value: 'Liability', label: 'Liability (Accounts Payable, Loans, Taxes Payable)' },
  { value: 'Equity', label: "Equity (Owner's Capital, Investor's Capital)" },
  { value: 'Revenue', label: 'Revenue (Sales, Service Revenue)' },
  { value: 'Expense', label: 'Expense (Rent, Salaries, Advertisement, Fuel, Office Supplies)' },
];

interface PartyFields { tax_number: string | null; phone: string | null; email: string | null; address: string | null }
const EMPTY_PARTY: PartyFields = { tax_number: null, phone: null, email: null, address: null };

interface LedgerFormState { name: string; type: string; openingBalance: string; cashInHand: boolean; monthSummary: boolean; party: PartyFields }

function LedgerFormFields({ v, onChange, nameReadOnly, autoFocus }: { v: LedgerFormState; onChange: (patch: Partial<LedgerFormState>) => void; nameReadOnly?: boolean; autoFocus?: boolean }) {
  const party = (patch: Partial<PartyFields>) => onChange({ party: { ...v.party, ...patch } });
  return (
    <FormLayout>
      <TextField label="Ledger name" autoComplete="off" placeholder="e.g. Main Bank Account" requiredIndicator readOnly={nameReadOnly} autoFocus={autoFocus} value={v.name} onChange={(name) => onChange({ name })} />
      <Dropdown label="Type (Nature)" fullWidth placeholder="Select type..." options={LEDGER_TYPE_OPTIONS} value={v.type} onChange={(type) => onChange({ type })} />
      <TextField label="Opening balance" type="number" autoComplete="off" placeholder="0.00" step={0.01} helpText="Positive is a Debit amount, negative is a Credit amount." value={v.openingBalance} onChange={(openingBalance) => onChange({ openingBalance })} />
      {v.type === 'Asset' && <Checkbox label="Include in Cash In Hand" checked={v.cashInHand} onChange={(cashInHand) => onChange({ cashInHand })} />}
      {v.type === 'Expense' && <Checkbox label="Show in Month Summary" checked={v.monthSummary} onChange={(monthSummary) => onChange({ monthSummary })} />}
      <TextField label="Tax number (NTN)" autoComplete="off" value={v.party.tax_number || ''} onChange={(tax_number) => party({ tax_number })} />
      <FormLayout.Group>
        <TextField label="Phone" autoComplete="off" value={v.party.phone || ''} onChange={(phone) => party({ phone })} />
        <TextField label="Email" autoComplete="off" value={v.party.email || ''} onChange={(email) => party({ email })} />
      </FormLayout.Group>
      <TextField label="Address" autoComplete="off" value={v.party.address || ''} onChange={(address) => party({ address })} />
    </FormLayout>
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

  const form = { name, type, openingBalance, cashInHand, monthSummary, party };
  const onChange = (patch: Partial<LedgerFormState>) => {
    if (patch.name !== undefined) setName(patch.name);
    if (patch.type !== undefined) setType(patch.type);
    if (patch.openingBalance !== undefined) setOpeningBalance(patch.openingBalance);
    if (patch.cashInHand !== undefined) setCashInHand(patch.cashInHand);
    if (patch.monthSummary !== undefined) setMonthSummary(patch.monthSummary);
    if (patch.party !== undefined) setParty(patch.party);
  };

  return (
    <FormModal title="Create Ledger" onClose={onClose} onSubmit={submit} submitLabel="Create" saving={saving}>
      <LedgerFormFields v={form} onChange={onChange} autoFocus />
    </FormModal>
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

  const form = { name, type, openingBalance, cashInHand, monthSummary, party };
  const onChange = (patch: Partial<LedgerFormState>) => {
    if (patch.name !== undefined) setName(patch.name);
    if (patch.type !== undefined) setType(patch.type);
    if (patch.openingBalance !== undefined) setOpeningBalance(patch.openingBalance);
    if (patch.cashInHand !== undefined) setCashInHand(patch.cashInHand);
    if (patch.monthSummary !== undefined) setMonthSummary(patch.monthSummary);
    if (patch.party !== undefined) setParty(patch.party);
  };

  return (
    <FormModal
      title="Edit Ledger" onClose={onClose} onSubmit={submit} saving={saving}
      extraActions={[{ content: 'Delete', destructive: true, disabled: cannotDelete, onAction: remove }]}
    >
      <BlockStack gap="400">
        {isSystem && <Banner tone="info">System account ({SYSTEM_LEDGER_LABELS[ledger.system_key!] || ledger.system_key}) — used by the app, so it can't be deleted.</Banner>}
        {!isSystem && hasEntries && <Banner tone="info">This ledger has entries, so it can't be deleted.</Banner>}
        <LedgerFormFields v={form} onChange={onChange} nameReadOnly={isSystem} />
      </BlockStack>
    </FormModal>
  );
}
