// Create Transaction Entry modal - single entry or bulk text entry. Ported from
// transactions.js's openTransactionEntryModal/submitTransactionEntryModal/submitBulkEntry.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { cashSideLabel, selectableLedgers, type Ledger, type LedgerBalancePatch } from '../../logic/ledgers';
import {
  bulkEntryValidationHtml, defaultTransactionParticulars, getOrdersLedgerId, orderAdvanceParticularPlaceholder,
  parseBulkEntryText,
} from '../../logic/transactionsBulkEntry';
import { Banner, BlockStack, Checkbox, Collapsible, FormLayout, List, Text, TextField } from '@shopify/polaris';
import { Dropdown } from '../../components/Dropdown';
import { FormModal } from '../../components/FormModal';
import { CreateLedgerModal } from './LedgerModals';

function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

function LedgerSelect({
  label, value, onChange, ledgers, onCreateLedger,
}: {
  label: string; value: string; onChange: (v: string) => void; ledgers: Ledger[]; onCreateLedger: () => void;
}) {
  return (
    <Dropdown
      label={label} fullWidth searchable value={value} onChange={onChange}
      options={[{ value: '', label: cashSideLabel(ledgers) }, ...selectableLedgers(ledgers).map((l) => ({ value: l.id, label: l.name }))]}
      action={{ content: '+ Create new ledger...', onAction: onCreateLedger }}
    />
  );
}

export function TransactionEntryModal({
  ledgers, entryDate, initialMode, onClose, onDone, onLedgersChanged,
}: {
  ledgers: Ledger[];
  initialMode: 'single' | 'bulk';
  entryDate: string;
  onClose: () => void;
  onDone: (patches: LedgerBalancePatch | LedgerBalancePatch[] | undefined) => void;
  onLedgersChanged: () => void;
}) {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const [mode, setMode] = useState(initialMode);
  const [isAdvance, setIsAdvance] = useState(false);
  const [orderNumber, setOrderNumber] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [particular, setParticular] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [bulkValidated, setBulkValidated] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [creatingFor, setCreatingFor] = useState<'from' | 'to' | null>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ text: string; kind?: 'ok' | 'error' } | null>(null);
  const bulkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (ledgers.length === 0) showToast('No ledgers available. Create a ledger first.', 'error', { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ledgerName(id: string) { return ledgers.find((l) => l.id === id)?.name || ''; }

  const particularPlaceholder = isAdvance
    ? orderAdvanceParticularPlaceholder(orderNumber)
    : defaultTransactionParticulars(ledgerName(fromId), ledgerName(toId)) || 'Amount received from...';

  const bulkParsed = useMemo(() => parseBulkEntryText(ledgers, bulkText), [ledgers, bulkText]);

  function onBulkChange(value: string) {
    setBulkText(value);
    setBulkValidated(false);
    if (bulkTimer.current) clearTimeout(bulkTimer.current);
    bulkTimer.current = setTimeout(() => setBulkValidated(true), 300);
  }

  async function submitSingle() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    if (isAdvance && !getOrdersLedgerId(ledgers)) {
      showToast('No Orders ledger is set. Assign the Orders role in Edit Ledger.', 'error', { silent: true });
      return;
    }
    const trimmedOrderNumber = isAdvance ? orderNumber.trim().replace(/^#/, '') : '';
    if (isAdvance && !trimmedOrderNumber) { showToast('Enter an order number', 'error', { silent: true }); return; }

    const from = (isAdvance ? getOrdersLedgerId(ledgers) : fromId) || null;
    const to = toId || null;
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) { showToast('Enter a valid amount', 'error', { silent: true }); return; }
    if (!from && !to) { showToast(`Both sides are ${cashSideLabel(ledgers)} — name an account on one side`, 'error', { silent: true }); return; }
    if (from && from === to) { showToast('From and To must be different accounts', 'error', { silent: true }); return; }

    const payload: Record<string, unknown> = {
      entry_date: entryDate,
      amount: amountNum,
      description: particular.trim() || particularPlaceholder,
      from_account_id: from,
      to_account_id: to,
    };
    if (isAdvance) payload.order_number = trimmedOrderNumber;

    setSaving(true);
    try {
      const created = await apiJson<{ ledger_balances?: LedgerBalancePatch | LedgerBalancePatch[] }>('/transactions/entries', {
        method: 'POST', body: { idempotency_key: generateIdempotencyKey(), ...payload }, fallback: 'Failed to add transaction entry',
      });
      showToast('Entry added', 'success');
      onDone(created.ledger_balances);
    } catch (error: any) {
      showToast(error?.message || 'Failed to add entry', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function submitBulk() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    setBulkValidated(true);
    if (!bulkParsed.hasAny) { showToast('No entries to create', 'error', { silent: true }); return; }
    if (bulkParsed.hasError) { showToast('Fix the highlighted entries first', 'error', { silent: true }); return; }

    const payloads: Array<Record<string, unknown>> = [];
    bulkParsed.lines.forEach((p) => p.entries!.forEach((e) => payloads.push({ ...e, entry_date: entryDate })));
    const total = payloads.length;

    setSaving(true);
    setProgress({ text: `Creating ${total} entr${total === 1 ? 'y' : 'ies'}…` });
    try {
      const withKeys = payloads.map((p) => ({ idempotency_key: generateIdempotencyKey(), ...p }));
      const created = await apiJson<Array<{ ledger_balances?: LedgerBalancePatch | LedgerBalancePatch[] }>>('/transactions/entries/bulk', {
        method: 'POST', body: withKeys, fallback: 'Failed to create transaction entries',
      });
      setProgress({ text: `Created ${total} entr${total === 1 ? 'y' : 'ies'}.`, kind: 'ok' });
      showToast(`Created ${total} entr${total === 1 ? 'y' : 'ies'}`, 'success');
      onDone(created[0]?.ledger_balances);
    } catch (error) {
      console.error('Error creating bulk entries:', error);
      setProgress({ text: 'Failed to create entries — nothing was saved. Review and retry.', kind: 'error' });
      showToast('Failed to create entries', 'error');
    } finally {
      setSaving(false);
    }
  }

  const bulkDisabled = !bulkValidated || bulkParsed.hasError || !bulkParsed.hasAny;

  return (
    <>
      <FormModal
        title="Create Transaction Entry" onClose={onClose} saving={saving}
        onSubmit={mode === 'single' ? submitSingle : submitBulk} submitLabel={mode === 'single' ? 'Create' : 'Create entries'}
        disabled={mode === 'bulk' && bulkDisabled}
      >
        <BlockStack gap="400">
          <div className="entry-mode-toggle" data-mode={mode} role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'single'} disabled={saving} onClick={() => setMode('single')}>Single Entry</button>
            <button type="button" role="tab" aria-selected={mode === 'bulk'} disabled={saving} onClick={() => setMode('bulk')}>Bulk Text Entry</button>
          </div>
          <div className="entry-mode-body">
          {mode === 'single' ? (
            <FormLayout>
              <Checkbox label="Order Advance Amount" checked={isAdvance} onChange={setIsAdvance} />
              {isAdvance && <TextField label="Order number" autoComplete="off" placeholder="e.g. 1234" requiredIndicator value={orderNumber} onChange={setOrderNumber} />}
              <TextField label="Amount" type="number" autoComplete="off" min={0.01} step={0.01} placeholder="0.00" requiredIndicator value={amount} onChange={setAmount} />
              <FormLayout.Group>
                {!isAdvance && <LedgerSelect label="From Account (Credit)" value={fromId} onChange={setFromId} ledgers={ledgers} onCreateLedger={() => setCreatingFor('from')} />}
                <LedgerSelect label="To Account (Debit)" value={toId} onChange={setToId} ledgers={ledgers} onCreateLedger={() => setCreatingFor('to')} />
              </FormLayout.Group>
              <Text as="p" tone="subdued">An empty side is Cash. Name both and the money moves without touching cash.</Text>
              <TextField label="Particulars" autoComplete="off" placeholder={particularPlaceholder} value={particular} onChange={setParticular} />
            </FormLayout>
          ) : (
            <BlockStack gap="300">
              <TextField
                label="Entries" autoComplete="off" multiline={11} spellCheck={false} monospaced disabled={saving}
                placeholder="2064 from TCS (Received order payment)" value={bulkText} onChange={onBulkChange}
                labelAction={{ content: infoOpen ? 'Hide format help' : 'Format help', onAction: () => setInfoOpen((v) => !v) }}
              />
              <Collapsible open={infoOpen} id="bulkEntryHelp">
                <Banner>
                  <BlockStack gap="200">
                    <Text as="p">One entry per line. Format: <code>&lt;AMOUNT&gt; from &lt;LEDGER&gt; to &lt;LEDGER&gt; [(&lt;PARTICULARS&gt;)]</code></Text>
                    <Text as="p" fontWeight="semibold">Leave a side out and that side is cash.</Text>
                    <List>
                      <List.Item><code>2064 from TCS (Received order payment)</code> — cash received from TCS</List.Item>
                      <List.Item><code>2064 to Meezan Bank</code> — cash paid to Meezan Bank</List.Item>
                      <List.Item><code>2064 from Meezan Bank to Fabric Supplier</code> — bank pays the supplier; cash is not touched</List.Item>
                    </List>
                    <Text as="p">Particulars are optional — omit them and a default description is generated.</Text>
                    <Text as="p">Order advance shorthand — use <code>Order#</code> in place of a ledger name to post straight to the Orders ledger: <code>3500 from Order# 11473</code></Text>
                  </BlockStack>
                </Banner>
              </Collapsible>
              {bulkValidated && (!bulkParsed.hasAny
                ? <Banner tone="warning">No entries to validate.</Banner>
                : <div className="bulk-entry-validation" dangerouslySetInnerHTML={{ __html: bulkEntryValidationHtml(ledgers, bulkParsed) }} />)}
              {progress && <Banner tone={progress.kind === 'ok' ? 'success' : progress.kind === 'error' ? 'critical' : 'info'}>{progress.text}</Banner>}
            </BlockStack>
          )}
          </div>
        </BlockStack>
      </FormModal>
      {creatingFor && (
        <CreateLedgerModal
          ledgers={ledgers}
          onClose={() => setCreatingFor(null)}
          onCreated={(created) => {
            onLedgersChanged();
            if (creatingFor === 'from') setFromId(created.id); else setToId(created.id);
            setCreatingFor(null);
          }}
        />
      )}
    </>
  );
}
