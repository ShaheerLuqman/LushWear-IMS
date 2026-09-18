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
import { CreateLedgerModal } from './LedgerModals';

const CREATE_LEDGER_OPTION_VALUE = '__create_ledger__';

function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

function LedgerSelect({
  id, label, value, onChange, ledgers, disabled, onCreateLedger,
}: {
  id: string; label: string; value: string; onChange: (v: string) => void; ledgers: Ledger[]; disabled?: boolean; onCreateLedger: () => void;
}) {
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <select
        id={id} className="form-input" disabled={disabled} value={value}
        onChange={(e) => {
          if (e.target.value === CREATE_LEDGER_OPTION_VALUE) { onCreateLedger(); return; }
          onChange(e.target.value);
        }}
      >
        <option value="">{cashSideLabel(ledgers)}</option>
        {selectableLedgers(ledgers).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        <option value={CREATE_LEDGER_OPTION_VALUE}>+ Create new ledger...</option>
      </select>
    </div>
  );
}

export function TransactionEntryModal({
  ledgers, entryDate, onClose, onDone, onLedgersChanged,
}: {
  ledgers: Ledger[];
  entryDate: string;
  onClose: () => void;
  onDone: (patches: LedgerBalancePatch | LedgerBalancePatch[] | undefined) => void;
  onLedgersChanged: () => void;
}) {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
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

  useEffect(() => {
    if (!infoOpen) return;
    function close(e: Event) { if (!(e.target as HTMLElement).closest('.bulk-entry-info-wrap')) setInfoOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setInfoOpen(false); }
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  }, [infoOpen]);

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

  return (
    <>
      <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
        <div className="modal-content transaction-entry-modal-content">
          <div className="modal-header">
            <h2>Create Transaction Entry</h2>
            <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>&times;</button>
          </div>
          <div className="modal-body">
            <div className="transaction-entry-mode" role="tablist" aria-label="Entry mode">
              <button type="button" className={'transaction-entry-mode-btn' + (mode === 'single' ? ' active' : '')} role="tab" aria-selected={mode === 'single'} disabled={saving} onClick={() => setMode('single')}>Single Entry</button>
              <button type="button" className={'transaction-entry-mode-btn' + (mode === 'bulk' ? ' active' : '')} role="tab" aria-selected={mode === 'bulk'} disabled={saving} onClick={() => setMode('bulk')}>Bulk Text Entry</button>
            </div>

            {mode === 'single' ? (
              <form className="ledger-form" onSubmit={(e) => { e.preventDefault(); submitSingle(); }}>
                <label className="transaction-entry-toggle">
                  <input type="checkbox" checked={isAdvance} onChange={(e) => setIsAdvance(e.target.checked)} />
                  <span>Order Advance Amount</span>
                </label>
                {isAdvance && (
                  <div className="form-group">
                    <label htmlFor="transactionEntryOrderNumber">Order number *</label>
                    <input type="text" id="transactionEntryOrderNumber" className="form-input" placeholder="e.g. 1234" autoComplete="off" required value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="transactionEntryAmount">Amount *</label>
                  <input type="number" id="transactionEntryAmount" className="form-input" min={0.01} step={0.01} placeholder="0.00" required value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div className="transaction-entry-sides">
                  {!isAdvance && (
                    <LedgerSelect id="transactionEntryFrom" label="From Account (Credit)" value={fromId} onChange={setFromId} ledgers={ledgers} onCreateLedger={() => setCreatingFor('from')} />
                  )}
                  <LedgerSelect id="transactionEntryTo" label="To Account (Debit)" value={toId} onChange={setToId} ledgers={ledgers} onCreateLedger={() => setCreatingFor('to')} />
                </div>
                <p className="form-hint">An empty side is Cash. Name both and the money moves without touching cash.</p>
                <div className="form-group">
                  <label htmlFor="transactionEntryParticular">Particulars</label>
                  <input type="text" id="transactionEntryParticular" className="form-input" autoComplete="off" placeholder={particularPlaceholder} value={particular} onChange={(e) => setParticular(e.target.value)} />
                </div>
              </form>
            ) : (
              <div>
                <div className="form-group">
                  <div className="bulk-entry-label-row">
                    <label htmlFor="bulkEntryInput">Entries</label>
                    <div className="bulk-entry-info-wrap">
                      <button type="button" className="bulk-entry-info-btn" aria-expanded={infoOpen} onClick={(e) => { e.stopPropagation(); setInfoOpen((v) => !v); }}>ⓘ Format help</button>
                      {infoOpen && (
                        <div className="bulk-entry-help bulk-entry-info-card open">
                          <p>One entry per line. Format: <b><code>&lt;AMOUNT&gt; from &lt;LEDGER&gt; to &lt;LEDGER&gt; [(&lt;PARTICULARS&gt;)]</code></b></p>
                          <p><strong>Leave a side out and that side is cash.</strong></p>
                          <ul>
                            <li><b><code>2064 from TCS (Received order payment)</code></b> — cash received from TCS</li>
                            <li><b><code>2064 to Meezan Bank</code></b> — cash paid to Meezan Bank</li>
                            <li><b><code>2064 from Meezan Bank to Fabric Supplier</code></b> — bank pays the supplier; <strong>cash is not touched</strong></li>
                          </ul>
                          <p>Particulars are optional — omit them and a default description is generated.</p>
                          <p>Order advance shorthand — use <code>Order#</code> in place of a ledger name to post straight to the Orders ledger:</p>
                          <code>3500 from Order# 11473<br />3500 from Order# 11473 to Meezan Bank</code>
                        </div>
                      )}
                    </div>
                  </div>
                  <textarea
                    id="bulkEntryInput" className="form-input bulk-entry-textarea" rows={6} spellCheck={false}
                    placeholder="2064 from TCS (Received order payment)" disabled={saving}
                    value={bulkText} onChange={(e) => onBulkChange(e.target.value)}
                  />
                  {bulkValidated && (
                    !bulkParsed.hasAny ? (
                      <div className="bulk-entry-validation" style={{ display: 'block' }}><div className="bulk-entry-msg bulk-entry-msg-error">No entries to validate.</div></div>
                    ) : (
                      <div className="bulk-entry-validation" style={{ display: 'block' }} dangerouslySetInnerHTML={{ __html: bulkEntryValidationHtml(ledgers, bulkParsed) }} />
                    )
                  )}
                </div>
                {progress && (
                  <div className={'bulk-entry-progress' + (progress.kind === 'ok' ? ' bulk-entry-progress-ok' : '') + (progress.kind === 'error' ? ' bulk-entry-progress-error' : '')} style={{ display: 'block' }}>
                    {progress.text}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="modal-pinned-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            {mode === 'single' ? (
              <button type="button" className="btn btn-primary" disabled={saving} onClick={submitSingle}>{saving ? 'Creating...' : 'Create'}</button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={saving || !bulkValidated || bulkParsed.hasError || !bulkParsed.hasAny} onClick={submitBulk}>
                {saving ? 'Creating...' : 'Create entries'}
              </button>
            )}
          </div>
        </div>
      </div>
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
