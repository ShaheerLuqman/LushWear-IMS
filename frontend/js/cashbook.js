// Cashbook: entries grid, day navigation, and the entry/advance/bulk modals.

// ============================================
// Cashbook
// ============================================

function normalizeCashbookEntries(entries) {
    return (entries || []).map((entry) => ({
        ...entry,
        entry_date: entry.entry_date ? String(entry.entry_date).slice(0, 10) : ''
    }));
}

// The two grids are the two sides of each entry, not two sets of entries: the
// left shows where money went (TO / debit), the right where it came from
// (FROM / credit). Every entry therefore appears in both, on the same row.
// A null side is cash.
const CASHBOOK_SIDES = { debit: 'to_account_id', credit: 'from_account_id' };

function getEmptyCashbookRow(entryDate = '', side = '') {
    // Use a unique ID each time to ensure AG Grid creates a fresh row
    return {
        id: '__new_' + side + '_' + Date.now() + '__',
        entry_date: entryDate,
        description: '',
        from_account_id: null,
        to_account_id: null,
        amount: null,
        _side: side
    };
}

function sortedCashbookEntries(entries) {
    return [...(entries || [])].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    }).map((entry) => ({ ...entry, amount: parseFloat(entry.amount) || 0 }));
}

// Only entries with a cash side move the cash balance — an entry naming both
// accounts (a bank paying a supplier) never touches it.
function cashMovement(entries) {
    let received = 0;
    let paid = 0;
    (entries || []).forEach((e) => {
        const amount = parseFloat(e.amount) || 0;
        if (!e.to_account_id) received += amount;      // cash is the destination
        if (!e.from_account_id) paid += amount;        // cash is the source
    });
    return { received, paid };
}

// Left grid: TO (Debit). Opening cash balance heads it, as on a cash book.
function buildCashbookDebitWithOpening(entries, carryForward, selectedDate) {
    const opening = parseFloat(carryForward) || 0;
    const rows = sortedCashbookEntries(entries).map((e) => ({ ...e, _side: 'debit' }));
    const { received } = cashMovement(entries);
    const openingRow = {
        id: '__opening__',
        description: "Opening Balance",
        amount: opening,
        _isSystemRow: true
    };
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'debit');
    const totalRow = {
        id: '__total_in__',
        description: 'Total',
        amount: opening + received,
        _isFooter: true
    };
    return { rowData: [openingRow, ...rows, newEntryRow], pinnedBottomRowData: [totalRow] };
}

// Right grid: FROM (Credit), closed off by the cash closing balance.
function buildCashbookCreditWithClosing(entries, carryForward, selectedDate) {
    const opening = parseFloat(carryForward) || 0;
    const { received, paid } = cashMovement(entries);
    const closingBalance = opening + received - paid;
    const rows = sortedCashbookEntries(entries).map((e) => ({ ...e, _side: 'credit' }));
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'credit');
    const closingRow = {
        id: '__closing__',
        description: 'Closing Balance',
        amount: closingBalance,
        _isSystemRow: true
    };
    const totalRow = {
        id: '__total_out__',
        description: 'Total',
        amount: paid + closingBalance,
        _isFooter: true
    };
    return { rowData: [...rows, newEntryRow, closingRow], pinnedBottomRowData: [totalRow] };
}

// Bundles daily-balance + that date's entries — always needed together — into
// the single GET /cashbook/day/{date} request instead of two parallel fetches.
async function loadCashbookDay(targetDate) {
    try {
        const data = await apiJson(`/cashbook/day/${targetDate}`, { fallback: 'Failed to load cashbook day' });
        cashbookDailyBalance = data.daily_balance;
        cashbookEntries = normalizeCashbookEntries(data.entries);
    } catch (error) {
        console.error('Error loading cashbook day:', error);
        showToast('Failed to load cashbook entries', 'error');
        cashbookDailyBalance = {
            balance_date: targetDate,
            opening_balance: 0,
            total_credit: 0,
            total_debit: 0,
            closing_balance: 0
        };
        cashbookEntries = [];
    }
}

function renderCashbook() {
    const selectedDate = cashbookSelectedDate || getTodayDateString();
    const openingBalance = cashbookDailyBalance ? parseFloat(cashbookDailyBalance.opening_balance) || 0 : 0;
    const filteredEntries = cashbookEntries.filter((entry) => entry.entry_date === selectedDate);

    const { rowData: debitRowData, pinnedBottomRowData: debitPinnedBottom } = buildCashbookDebitWithOpening(filteredEntries, openingBalance, selectedDate);
    const { rowData: creditRowData, pinnedBottomRowData: creditPinnedBottom } = buildCashbookCreditWithClosing(filteredEntries, openingBalance, selectedDate);

    if (cashbookDebitGridApi) {
        cashbookDebitGridApi.setGridOption('rowData', debitRowData);
        cashbookDebitGridApi.setGridOption('pinnedTopRowData', []);
        cashbookDebitGridApi.setGridOption('pinnedBottomRowData', debitPinnedBottom);
        cashbookDebitGridApi.setGridOption('pagination', false);
    }
    if (cashbookCreditGridApi) {
        cashbookCreditGridApi.setGridOption('rowData', creditRowData);
        cashbookCreditGridApi.setGridOption('pinnedTopRowData', []);
        cashbookCreditGridApi.setGridOption('pinnedBottomRowData', creditPinnedBottom);
        cashbookCreditGridApi.setGridOption('pagination', false);
    }
}

async function loadCashbook() {
    const dateFilter = document.getElementById('cashbookDateFilter');
    if (!cashbookSelectedDate) {
        cashbookSelectedDate = getTodayDateString();
    }
    if (dateFilter) dateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate);
    
    await Promise.all([
        loadCashbookDay(cashbookSelectedDate),
        loadLedgersList()
    ]);
    renderCashbook();
    updateCashInHand();
}

async function reloadCashbookForCurrentDate() {
    const selectedDate = cashbookSelectedDate || getTodayDateString();
    await loadCashbookDay(selectedDate);
    renderCashbook();
    updateCashInHand();
}

let cashbookReloadTimer = null;

// Debounces the full-day reload (GET /cashbook/day/{date} + re-render): each
// call resets a 500ms timer, so a burst of entry writes (e.g. the two-sided
// entry / order-advance modals, each firing two creates) collapses into one
// refetch after the last one settles, instead of one per write.
function scheduleCashbookReload() {
    if (cashbookReloadTimer) clearTimeout(cashbookReloadTimer);
    cashbookReloadTimer = setTimeout(() => {
        cashbookReloadTimer = null;
        reloadCashbookForCurrentDate();
    }, 500);
}

// --- Create Cashbook Entry modal ---------------------------------------------

// Tracks whether the user has manually edited the Credit amount. Until they do,
// it mirrors whatever is typed in the Debit amount.
let cashbookEntryOutAmountTouched = false;

// The ledger this org posts order advances to: system_key = 'orders', the same
// mechanism every fixed role uses (see backend/app/ledger_roles.py). It began as
// a hardcoded UUID, which predated multi-tenancy and left the advance flow inert
// for every other org. Null until an org assigns the role, which every caller
// below already handles.
function getOrdersLedgerId() {
    return ledgers.find(l => l.system_key === 'orders')?.id || null;
}

// Default particulars text for an order advance.
function orderAdvanceParticularPlaceholder(orderNumber) {
    const num = String(orderNumber || '').trim().replace(/^#/, '');
    return num ? `Amount received for Order #${num}` : 'Amount received for Order #...';
}

function cashbookEntryLedgerName(ledgerId) {
    const ledger = ledgers.find(l => l.id === ledgerId);
    return ledger ? ledger.name : '';
}

function cashbookEntryParticularPlaceholder(side, ledgerId) {
    const name = cashbookEntryLedgerName(ledgerId);
    if (!name) return side === 'credit' ? 'Amount received from...' : 'Amount transferred to...';
    return side === 'credit' ? `Amount received from ${name}` : `Amount transferred to ${name}`;
}

function refreshCashbookEntryParticularPlaceholders() {
    const inLedger = document.getElementById('cashbookEntryInLedger');
    const outLedger = document.getElementById('cashbookEntryOutLedger');
    const inPart = document.getElementById('cashbookEntryInParticular');
    const outPart = document.getElementById('cashbookEntryOutParticular');
    // An order advance describes both legs by the order it belongs to.
    if (isCashbookEntryOrderAdvance()) {
        const orderNumber = document.getElementById('cashbookEntryOrderNumber');
        const text = orderAdvanceParticularPlaceholder(orderNumber ? orderNumber.value : '');
        if (inPart) inPart.placeholder = text;
        if (outPart) outPart.placeholder = text;
        return;
    }
    if (inPart) inPart.placeholder = cashbookEntryParticularPlaceholder('credit', inLedger ? inLedger.value : '');
    if (outPart) outPart.placeholder = cashbookEntryParticularPlaceholder('debit', outLedger ? outLedger.value : '');
}

function isCashbookEntryOrderAdvance() {
    const cb = document.getElementById('cashbookEntryOrderAdvance');
    return !!(cb && cb.checked);
}

/**
 * Toggle order-advance mode: the Debit side is locked to the Orders ledger and
 * an order number becomes required.
 */
function setCashbookEntryOrderAdvance(enabled) {
    const group = document.getElementById('cashbookEntryOrderNumberGroup');
    const orderNumber = document.getElementById('cashbookEntryOrderNumber');
    const inLedger = document.getElementById('cashbookEntryInLedger');
    // "Paid with Cash" (on the Credit side) skips the folio-credit leg, which an
    // order advance always needs.
    const creditSkip = document.getElementById('cashbookEntryInSkip');

    if (group) group.style.display = enabled ? '' : 'none';
    if (orderNumber) {
        if (enabled) orderNumber.setAttribute('required', '');
        else { orderNumber.removeAttribute('required'); orderNumber.value = ''; }
    }
    // Must run before the ledger is locked below — it re-enables the credit fields.
    if (enabled && creditSkip && creditSkip.checked) {
        creditSkip.checked = false;
        setCashbookEntrySideSkipped('credit', false);
    }
    if (creditSkip) creditSkip.disabled = enabled;
    // The Debit-side ledger is always Orders for an advance, so hide the field
    // rather than showing a locked select.
    const inLedgerGroup = document.getElementById('cashbookEntryInLedgerGroup');
    if (inLedgerGroup) inLedgerGroup.style.display = enabled ? 'none' : '';
    if (inLedger) {
        inLedger.disabled = enabled;
        if (enabled) inLedger.value = getOrdersLedgerId() || '';
    }

    refreshCashbookEntryParticularPlaceholders();
    if (enabled && orderNumber) orderNumber.focus();
}

// Enables/disables one side of the entry modal. A disabled (skipped) side will not
// create an entry; its `required` attributes are removed so the form can still submit.
function setCashbookEntrySideSkipped(side, skipped) {
    const prefix = side === 'credit' ? 'cashbookEntryIn' : 'cashbookEntryOut';
    const ledger = document.getElementById(prefix + 'Ledger');
    const amount = document.getElementById(prefix + 'Amount');
    const part = document.getElementById(prefix + 'Particular');
    [ledger, amount, part].forEach((el) => {
        if (!el) return;
        el.disabled = skipped;
        // required only applies to ledger + amount; particulars is optional anyway.
        if (el === ledger || el === amount) {
            if (skipped) el.removeAttribute('required');
            else el.setAttribute('required', '');
        }
    });
    const fieldset = ledger ? ledger.closest('.cashbook-entry-side') : null;
    if (fieldset) fieldset.classList.toggle('cashbook-entry-side-skipped', skipped);
}

const CREATE_LEDGER_OPTION_VALUE = '__create_ledger__';

function populateCashbookEntryLedgerSelect(select) {
    if (!select) return;
    const current = select.value;
    const options = ['<option value="">Select ledger...</option>']
        .concat(ledgers.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`))
        .concat([`<option value="${CREATE_LEDGER_OPTION_VALUE}">+ Create new ledger...</option>`]);
    select.innerHTML = options.join('');
    if (current && ledgers.some(l => l.id === current)) select.value = current;
}

function handleLedgerSelectChange(e) {
    if (e.target.value === CREATE_LEDGER_OPTION_VALUE) {
        const selectId = e.target.id;
        e.target.value = '';
        openCreateLedgerModal((created) => {
            ['cashbookEntryInLedger', 'cashbookEntryOutLedger'].forEach((id) => {
                populateCashbookEntryLedgerSelect(document.getElementById(id));
            });
            const select = document.getElementById(selectId);
            if (select) {
                select.value = created.id;
                select.dispatchEvent(new Event('change'));
            }
        });
    }
}

function openCashbookEntryModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    cashbookEntryOutAmountTouched = false;
    const inLedger = document.getElementById('cashbookEntryInLedger');
    const outLedger = document.getElementById('cashbookEntryOutLedger');
    const inAmount = document.getElementById('cashbookEntryInAmount');
    const outAmount = document.getElementById('cashbookEntryOutAmount');
    const inPart = document.getElementById('cashbookEntryInParticular');
    const outPart = document.getElementById('cashbookEntryOutParticular');

    populateCashbookEntryLedgerSelect(inLedger);
    populateCashbookEntryLedgerSelect(outLedger);
    if (inLedger) inLedger.value = '';
    if (outLedger) outLedger.value = '';
    if (inAmount) inAmount.value = '';
    if (outAmount) outAmount.value = '';
    if (inPart) inPart.value = '';
    if (outPart) outPart.value = '';

    const inSkip = document.getElementById('cashbookEntryInSkip');
    const outSkip = document.getElementById('cashbookEntryOutSkip');
    if (inSkip) inSkip.checked = false;
    if (outSkip) outSkip.checked = false;
    setCashbookEntrySideSkipped('credit', false);
    setCashbookEntrySideSkipped('debit', false);

    const orderAdvance = document.getElementById('cashbookEntryOrderAdvance');
    if (orderAdvance) orderAdvance.checked = false;
    setCashbookEntryOrderAdvance(false);

    if (ledgers.length === 0) {
        showToast('No ledgers available. Create a ledger first.', 'error');
    }

    refreshCashbookEntryParticularPlaceholders();
    setCashbookEntryMode('single');
    document.getElementById('cashbookEntryModal').classList.add('active');
    if (inLedger) inLedger.focus();
}

function closeCashbookEntryModal() {
    if (bulkEntryCreating) return;
    document.getElementById('cashbookEntryModal').classList.remove('active');
}

/** Switch the shared Create Entry modal between 'single' and 'bulk' input modes. */
function setCashbookEntryMode(mode) {
    if (bulkEntryCreating) return;
    const bulk = mode === 'bulk';
    const form = document.getElementById('cashbookEntryForm');
    const panel = document.getElementById('cashbookEntryBulkPanel');
    const singleBtn = document.getElementById('cashbookEntryModeSingle');
    const bulkBtn = document.getElementById('cashbookEntryModeBulk');

    if (form) form.style.display = bulk ? 'none' : '';
    if (panel) panel.style.display = bulk ? '' : 'none';
    const singleSubmit = document.getElementById('cashbookEntrySubmitBtn');
    if (singleSubmit) singleSubmit.style.display = bulk ? 'none' : '';
    const bulkSubmit = document.getElementById('bulkEntrySubmitBtn');
    if (bulkSubmit) bulkSubmit.style.display = bulk ? '' : 'none';
    if (singleBtn) {
        singleBtn.classList.toggle('active', !bulk);
        singleBtn.setAttribute('aria-selected', String(!bulk));
    }
    if (bulkBtn) {
        bulkBtn.classList.toggle('active', bulk);
        bulkBtn.setAttribute('aria-selected', String(bulk));
    }
    if (bulk) {
        resetBulkEntryFields();
        const input = document.getElementById('bulkEntryInput');
        if (input) input.focus();
    } else {
        const inLedger = document.getElementById('cashbookEntryInLedger');
        if (inLedger) inLedger.focus();
    }
}

async function submitCashbookEntryModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const skipIn = document.getElementById('cashbookEntryInSkip').checked;
    const skipOut = document.getElementById('cashbookEntryOutSkip').checked;

    if (skipIn && skipOut) {
        showToast('At least one side must be entered', 'error');
        return;
    }

    const inLedger = document.getElementById('cashbookEntryInLedger').value;
    const outLedger = document.getElementById('cashbookEntryOutLedger').value;
    const inAmount = parseFloat(document.getElementById('cashbookEntryInAmount').value);
    const outAmount = parseFloat(document.getElementById('cashbookEntryOutAmount').value);
    const inPartEl = document.getElementById('cashbookEntryInParticular');
    const outPartEl = document.getElementById('cashbookEntryOutParticular');

    const isAdvance = isCashbookEntryOrderAdvance();
    const orderNumber = isAdvance
        ? document.getElementById('cashbookEntryOrderNumber').value.trim().replace(/^#/, '')
        : '';
    if (isAdvance && !orderNumber) { showToast('Enter an order number', 'error'); return; }
    // A select silently drops a value with no matching option, so a missing Orders
    // ledger would otherwise surface as a confusing "select a ledger" error.
    if (isAdvance && !getOrdersLedgerId()) {
        showToast('No Orders ledger is set. Assign the Orders role in Edit Ledger.', 'error');
        return;
    }

    if (!skipIn) {
        if (!inLedger) { showToast('Select a ledger on the Debit side', 'error'); return; }
        if (Number.isNaN(inAmount) || inAmount <= 0) { showToast('Enter a valid Debit amount', 'error'); return; }
    }
    if (!skipOut) {
        if (!outLedger) { showToast('Select a ledger on the Credit side', 'error'); return; }
        if (Number.isNaN(outAmount) || outAmount <= 0) { showToast('Enter a valid Credit amount', 'error'); return; }
    }

    const entryDate = cashbookSelectedDate || getTodayDateString();
    const defaultDescription = (side, ledgerId) => (isAdvance
        ? orderAdvanceParticularPlaceholder(orderNumber)
        : cashbookEntryParticularPlaceholder(side, ledgerId));
    const payloads = [];

    if (!skipIn) {
        // If the particulars field is left empty, fall back to the default placeholder text.
        const inDescription = (inPartEl.value.trim()) || defaultDescription('credit', inLedger);
        const inPayload = { entry_date: entryDate, amount: inAmount, description: inDescription, from_account_id: inLedger, to_account_id: null };
        // Tag the advance so it can be reconciled against the order's Shopify advance amount.
        if (isAdvance) inPayload.order_number = orderNumber;
        payloads.push(inPayload);
    }
    if (!skipOut) {
        const outDescription = (outPartEl.value.trim()) || defaultDescription('debit', outLedger);
        payloads.push({ entry_date: entryDate, amount: outAmount, description: outDescription, from_account_id: null, to_account_id: outLedger });
    }

    closeCashbookEntryModal();
    // Both legs in one atomic bulk request instead of two racing POSTs.
    await createCashbookEntriesBulk(payloads);
    // Refresh orders so the advance status indicator updates for this order.
    if (isAdvance && typeof loadOrders === 'function') { try { await loadOrders(); } catch (e) {} }
}

function closeBulkEntryInfoCard() {
    document.getElementById('bulkEntryInfoCard')?.classList.remove('open');
    document.getElementById('bulkEntryInfoBtn')?.setAttribute('aria-expanded', 'false');
}

function initCashbookActions() {
    const cashbookDateFilter = document.getElementById('cashbookDateFilter');
    if (cashbookDateFilter) {
        const applyDateFromInput = () => {
            const parsed = parseDDMMYYYYToYYYYMMDD(cashbookDateFilter.value);
            if (parsed) {
                cashbookSelectedDate = parsed;
                cashbookDateFilter.value = formatDateDDMMYYYY(parsed);
                reloadCashbookForCurrentDate();
            } else if (cashbookDateFilter.value.trim() !== '') {
                showToast('Enter date as DD/MM/YYYY', 'error');
                cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
            }
        };
        cashbookDateFilter.addEventListener('change', applyDateFromInput);
        cashbookDateFilter.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyDateFromInput();
            }
        });
        cashbookDateFilter.addEventListener('blur', () => {
            if (cashbookDateFilter.value.trim() !== '') {
                const parsed = parseDDMMYYYYToYYYYMMDD(cashbookDateFilter.value);
                if (parsed) {
                    cashbookSelectedDate = parsed;
                    cashbookDateFilter.value = formatDateDDMMYYYY(parsed);
                } else {
                    cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
                }
            } else {
                cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
            }
        });
    }
    document.getElementById('cashbookTodayBtn')?.addEventListener('click', () => {
        const today = getTodayDateString();
        cashbookSelectedDate = today;
        if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(today);
        reloadCashbookForCurrentDate();
    });
    document.getElementById('cashbookPrevDayBtn')?.addEventListener('click', () => {
        const current = cashbookSelectedDate || getTodayDateString();
        const [year, month, day] = current.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        date.setDate(date.getDate() - 1);
        const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        cashbookSelectedDate = newDate;
        if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(newDate);
        reloadCashbookForCurrentDate();
    });
    document.getElementById('cashbookNextDayBtn')?.addEventListener('click', () => {
        const current = cashbookSelectedDate || getTodayDateString();
        const [year, month, day] = current.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        date.setDate(date.getDate() + 1);
        const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        cashbookSelectedDate = newDate;
        if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(newDate);
        reloadCashbookForCurrentDate();
    });

    // Cashbook/order advance ledger selects: picking "+ Create new ledger..." opens the create ledger modal
    ['cashbookEntryInLedger', 'cashbookEntryOutLedger'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', handleLedgerSelectChange);
    });

    document.getElementById('cashbookCreateEntryBtn')?.addEventListener('click', openCashbookEntryModal);
    document.getElementById('cashbookEntryOrderAdvance')?.addEventListener('change', (e) => {
        setCashbookEntryOrderAdvance(e.target.checked);
    });
    document.getElementById('cashbookEntryOrderNumber')?.addEventListener('input', refreshCashbookEntryParticularPlaceholders);
    document.getElementById('cashbookEntryModeSingle')?.addEventListener('click', () => setCashbookEntryMode('single'));
    document.getElementById('cashbookEntryModeBulk')?.addEventListener('click', () => setCashbookEntryMode('bulk'));
    document.getElementById('bulkEntrySubmitBtn')?.addEventListener('click', submitBulkEntry);
    initBulkEntryInfoCard();
    // Re-validate as the user types (debounced lightly) and reset submit state.
    document.getElementById('bulkEntryInput')?.addEventListener('input', () => {
        autoResizeBulkEntryInput();
        setBulkEntrySubmitEnabled(false);
        clearTimeout(window.__bulkEntryDebounce);
        window.__bulkEntryDebounce = setTimeout(validateBulkEntry, 300);
    });
    document.getElementById('closeCashbookEntryModal')?.addEventListener('click', closeCashbookEntryModal);
    document.getElementById('cashbookEntryCancelBtn')?.addEventListener('click', closeCashbookEntryModal);
    document.getElementById('cashbookEntryModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'cashbookEntryModal') closeCashbookEntryModal();
    });
    document.getElementById('cashbookEntryForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        submitCashbookEntryModal();
    });
    // Mirror the Debit amount into Credit until the user edits the Credit amount.
    document.getElementById('cashbookEntryInAmount')?.addEventListener('input', (e) => {
        const outAmount = document.getElementById('cashbookEntryOutAmount');
        // If both fields are now empty, re-arm mirroring (back to default mode).
        if (e.target.value === '' && outAmount && outAmount.value === '') {
            cashbookEntryOutAmountTouched = false;
        }
        if (!cashbookEntryOutAmountTouched && outAmount) {
            outAmount.value = e.target.value;
        }
    });
    document.getElementById('cashbookEntryOutAmount')?.addEventListener('input', (e) => {
        const inAmount = document.getElementById('cashbookEntryInAmount');
        // If both fields are now empty, re-arm mirroring (back to default mode).
        if (e.target.value === '' && inAmount && inAmount.value === '') {
            cashbookEntryOutAmountTouched = false;
        } else {
            cashbookEntryOutAmountTouched = true;
        }
    });
    // Update particulars placeholders dynamically as ledgers are chosen.
    document.getElementById('cashbookEntryInLedger')?.addEventListener('change', refreshCashbookEntryParticularPlaceholders);
    document.getElementById('cashbookEntryOutLedger')?.addEventListener('change', refreshCashbookEntryParticularPlaceholders);
    // Single-sided entry toggles: skip a side's entry and disable its fields.
    // Only one may be ticked at a time.
    document.getElementById('cashbookEntryInSkip')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const other = document.getElementById('cashbookEntryOutSkip');
            if (other && other.checked) { other.checked = false; setCashbookEntrySideSkipped('debit', false); }
        }
        setCashbookEntrySideSkipped('credit', e.target.checked);
    });
    document.getElementById('cashbookEntryOutSkip')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const other = document.getElementById('cashbookEntryInSkip');
            if (other && other.checked) { other.checked = false; setCashbookEntrySideSkipped('credit', false); }
        }
        setCashbookEntrySideSkipped('debit', e.target.checked);
    });
}

function initBulkEntryInfoCard() {
    const btn = document.getElementById('bulkEntryInfoBtn');
    const wrap = btn ? btn.closest('.bulk-entry-info-wrap') : null;
    const card = document.getElementById('bulkEntryInfoCard');
    if (!btn || !wrap || !card) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = card.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) closeBulkEntryInfoCard();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeBulkEntryInfoCard();
    });
}

// --- Bulk Text Entry modal ---------------------------------------------------

// Holds the most recent parse result so the submit handler can reuse it.
let bulkEntryParsed = null;

// Grows the textarea to fit its content instead of scrolling internally, so
// the modal body's own scrollbar is the only one — shared with the validation
// list below it — rather than a separate scroll region per element.
function autoResizeBulkEntryInput() {
    const input = document.getElementById('bulkEntryInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
}

function resetBulkEntryFields() {
    const input = document.getElementById('bulkEntryInput');
    if (input) { input.value = ''; input.disabled = false; input.style.height = ''; }
    const validation = document.getElementById('bulkEntryValidation');
    if (validation) { validation.style.display = 'none'; validation.innerHTML = ''; }
    const cancelBtn = document.getElementById('cashbookEntryCancelBtn');
    if (cancelBtn) cancelBtn.disabled = false;
    setBulkEntryProgress('');
    bulkEntryParsed = null;
    setBulkEntrySubmitEnabled(false);
    closeBulkEntryInfoCard();
}

// True while bulk entries are being created; blocks closing the modal mid-run.
let bulkEntryCreating = false;

function setBulkEntrySubmitEnabled(enabled) {
    const btn = document.getElementById('bulkEntrySubmitBtn');
    if (btn) btn.disabled = !enabled;
}

// Find a ledger by name (case-insensitive, trimmed). Returns the ledger or null.
function findLedgerByName(name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    return ledgers.find(l => String(l.name || '').trim().toLowerCase() === target) || null;
}

/**
 * Extract an order number from particulars text. Looks for "order" and/or "#"
 * followed by a number of 4 or more digits, allowing spaces between the tokens.
 * Order numbers start at 1000 and can grow beyond 9999 (10000+).
 * Examples matched: "Order #9865", "order# 9865", "Order  9865", "#9865", "#12345".
 * Returns the digits as a string, or null if none found.
 */
function extractOrderNumberFromText(text) {
    const s = String(text || '');
    // "order"/"orders" then optional "#", then 4+ digits (spaces allowed between tokens)
    let m = s.match(/orders?\s*#?\s*(\d{4,})\b/i);
    if (m) return m[1];
    // bare "#" then 4+ digits
    m = s.match(/#\s*(\d{4,})\b/);
    if (m) return m[1];
    return null;
}

/**
 * Parse one line of bulk-entry text.
 *
 * Format: <AMOUNT> from <LEDGER> to <LEDGER> (<PARTICULARS>)
 *
 * Either side may be omitted, and the omitted one is cash:
 *   "5000 from Sales"                       cash received from Sales
 *   "3000 to Rent"                          rent paid in cash
 *   "5000 from Meezan Bank to Fabric Supp"  bank pays supplier, cash untouched
 *
 * Anything before the amount is ignored, so a pasted WhatsApp line keeps its
 * timestamp prefix.
 *
 * Returns { ok, errors: [str], lineNo, raw, cleaned, amount, particulars,
 *           entries: [{amount, description, from_account_id, to_account_id}] }
 */
function parseBulkEntryLine(raw, lineNo) {
    const result = { ok: false, errors: [], lineNo, raw };
    const line = String(raw || '').trim();
    if (!line) { result.blank = true; return result; }

    // Start at the first "<amount> from|to", ignoring any pasted prefix.
    const startMatch = line.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s+(from|to)\b/i);
    if (!startMatch) {
        result.errors.push('Expected "<amount> from <ledger> to <ledger>".');
        return result;
    }
    const rest = line.slice(startMatch.index).trim();
    result.cleaned = rest;

    // Optional trailing "(particulars)".
    let particulars = null;
    let head = rest;
    const parenMatch = rest.match(/\(([^)]*)\)\s*$/);
    if (parenMatch) {
        particulars = parenMatch[1].trim();
        head = rest.slice(0, parenMatch.index).trim();
    }

    const amountMatch = head.match(/^([0-9][0-9,]*(?:\.[0-9]+)?)\s+(.*)$/);
    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (Number.isNaN(amount) || amount <= 0) {
        result.errors.push('Amount must be a number greater than 0.');
        return result;
    }
    result.amount = amount;

    const sides = splitFromTo(amountMatch[2].trim());
    if (sides.error) {
        result.errors.push(sides.error);
        return result;
    }

    const from = sides.fromName ? resolveBulkLedger(sides.fromName) : null;
    const to = sides.toName ? resolveBulkLedger(sides.toName) : null;
    if (sides.fromName && !from) result.errors.push(`Ledger "${sides.fromName}" not found.`);
    if (sides.toName && !to) result.errors.push(`Ledger "${sides.toName}" not found.`);
    if (result.errors.length > 0) return result;

    // An order advance is money received FROM the Orders account; the order
    // number comes from the "Order# NNNN" shorthand or out of the particulars.
    const ordersId = getOrdersLedgerId();
    const fromIsOrders = from && from.ledger.id === ordersId;
    const orderNumber = (from && from.orderNumber)
        || (fromIsOrders ? extractOrderNumberFromText(particulars) : null);

    const description = particulars
        || (fromIsOrders && orderNumber ? orderAdvanceParticularPlaceholder(orderNumber) : bulkEntryDefaultParticulars(from, to));
    result.particulars = particulars || '';

    const entry = {
        amount: result.amount,
        description,
        from_account_id: from ? from.ledger.id : null,
        to_account_id: to ? to.ledger.id : null,
    };
    if (fromIsOrders && orderNumber) entry.order_number = orderNumber;

    result.entries = [entry];
    result.orderNumber = orderNumber || null;
    result.ok = true;
    return result;
}

/**
 * Split "from A to B" / "from A" / "to B" into its two names.
 *
 * A ledger name can itself contain " to " ("Cash to Bank Transfers"), so when
 * both sides are present every possible split point is tried and the first one
 * where BOTH names resolve to a real ledger wins. Falling back to the last
 * split keeps the error message pointing at the most likely intent.
 */
function splitFromTo(text) {
    const lower = text.toLowerCase();

    if (lower.startsWith('to ')) {
        const name = text.slice(3).trim();
        return name ? { fromName: null, toName: name } : { error: 'Missing ledger name after "to".' };
    }
    if (!lower.startsWith('from ')) {
        return { error: 'Expected "from <ledger>" or "to <ledger>" after the amount.' };
    }

    const afterFrom = text.slice(5);
    const splits = [];
    const re = /\s+to\s+/gi;
    let m;
    while ((m = re.exec(afterFrom)) !== null) {
        splits.push({ index: m.index, length: m[0].length });
    }

    if (!splits.length) {
        const name = afterFrom.trim();
        return name ? { fromName: name, toName: null } : { error: 'Missing ledger name after "from".' };
    }

    for (const split of splits) {
        const fromName = afterFrom.slice(0, split.index).trim();
        const toName = afterFrom.slice(split.index + split.length).trim();
        if (fromName && toName && resolveBulkLedger(fromName) && resolveBulkLedger(toName)) {
            return { fromName, toName };
        }
    }

    // No split resolved, so the " to " is part of the name itself
    // ("900 from Cash to Bank Transfers" is one account, not two).
    const whole = afterFrom.trim();
    if (resolveBulkLedger(whole)) {
        return { fromName: whole, toName: null };
    }

    const last = splits[splits.length - 1];
    return {
        fromName: afterFrom.slice(0, last.index).trim(),
        toName: afterFrom.slice(last.index + last.length).trim(),
    };
}

/**
 * Resolve one side's name to a ledger. "Order# 11473" (or "Orders 11473")
 * resolves to the Orders account and carries the order number with it.
 */
function resolveBulkLedger(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;

    const orderShorthand = trimmed.match(/^orders?\s*#?\s*(\d{4,})$/i);
    if (orderShorthand) {
        const ordersId = getOrdersLedgerId();
        const ledger = ledgers.find(l => l.id === ordersId);
        return ledger ? { ledger, orderNumber: orderShorthand[1] } : null;
    }

    const ledger = findLedgerByName(trimmed);
    return ledger ? { ledger, orderNumber: null } : null;
}

function bulkEntryDefaultParticulars(from, to) {
    if (from && to) return `${from.ledger.name} to ${to.ledger.name}`;
    if (from) return `Amount received from ${from.ledger.name}`;
    if (to) return `Amount transferred to ${to.ledger.name}`;
    return '';
}

/** Parse the whole textarea. Returns { lines: [parsed], hasError, hasAny }. */
function parseBulkEntryText(text) {
    const rawLines = String(text || '').split(/\r?\n/);
    const lines = [];
    let hasError = false;
    let hasAny = false;
    rawLines.forEach((raw, i) => {
        const parsed = parseBulkEntryLine(raw, i + 1);
        if (parsed.blank) return; // ignore blank lines
        lines.push(parsed);
        hasAny = true;
        if (!parsed.ok) hasError = true;
    });
    return { lines, hasError, hasAny };
}

/** Validate the textarea and render results. Returns the parse result. */
function validateBulkEntry() {
    const input = document.getElementById('bulkEntryInput');
    const validation = document.getElementById('bulkEntryValidation');
    const parsed = parseBulkEntryText(input ? input.value : '');
    bulkEntryParsed = parsed;

    if (!validation) return parsed;
    if (!parsed.hasAny) {
        validation.style.display = 'block';
        validation.innerHTML = '<div class="bulk-entry-msg bulk-entry-msg-error">No entries to validate.</div>';
        setBulkEntrySubmitEnabled(false);
        return parsed;
    }

    const rows = parsed.lines.map(p => {
        // Show the cleaned line (amount onward) so pasted prefixes like WhatsApp
        // timestamps don't appear; fall back to raw when the amount wasn't found.
        const displayText = p.cleaned || p.raw;
        if (p.ok) {
            const summary = p.entries
                .map(e => {
                    // An empty side is cash — spelling it out is the only way to
                    // see, before saving, whether a line will move the cash balance.
                    const from = e.from_account_id ? ledgerNameById(e.from_account_id) : 'Cash';
                    const to = e.to_account_id ? ledgerNameById(e.to_account_id) : 'Cash';
                    const tag = e.order_number ? ` [Order #${escapeHtml(e.order_number)}]` : '';
                    return `${formatBulkAmount(e.amount)} ${escapeHtml(from)} → ${escapeHtml(to)}${tag}`;
                })
                .join(' , ');
            return `<div class="bulk-entry-line bulk-entry-line-ok">`
                + `<span class="bulk-entry-line-no">${p.lineNo}</span>`
                + `<span class="bulk-entry-line-text">${escapeHtml(displayText)}</span>`
                + `<span class="bulk-entry-line-detail">${summary}</span>`
                + `</div>`;
        }
        return `<div class="bulk-entry-line bulk-entry-line-error">`
            + `<span class="bulk-entry-line-no">${p.lineNo}</span>`
            + `<span class="bulk-entry-line-text">${escapeHtml(displayText)}</span>`
            + `<span class="bulk-entry-line-detail">${p.errors.map(escapeHtml).join(' ')}</span>`
            + `</div>`;
    }).join('');

    validation.style.display = 'block';
    validation.innerHTML = rows;
    setBulkEntrySubmitEnabled(!parsed.hasError);
    return parsed;
}

function ledgerNameById(id) {
    const l = ledgers.find(x => x.id === id);
    return l ? l.name : '(unknown)';
}

function formatBulkAmount(val) {
    const n = parseFloat(val) || 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function submitBulkEntry() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error'); return; }
    // Re-validate to be safe (the textarea may have changed since last validate).
    const parsed = validateBulkEntry();
    if (!parsed.hasAny) { showToast('No entries to create', 'error'); return; }
    if (parsed.hasError) { showToast('Fix the highlighted entries first', 'error'); return; }

    const entryDate = cashbookSelectedDate || getTodayDateString();
    const payloads = [];
    parsed.lines.forEach(p => {
        p.entries.forEach(e => payloads.push({ ...e, entry_date: entryDate }));
    });

    const total = payloads.length;
    const cancelBtn = document.getElementById('cashbookEntryCancelBtn');
    const input = document.getElementById('bulkEntryInput');

    // Lock the modal while creating so the user can't edit or close mid-run.
    bulkEntryCreating = true;
    setBulkEntrySubmitEnabled(false);
    if (cancelBtn) cancelBtn.disabled = true;
    if (input) input.disabled = true;

    // One INSERT for the whole batch. All-or-nothing, but everything reaching
    // this point already passed validateBulkEntry() — amount > 0 and each
    // ledger name resolved against the live-loaded ledger list — so a DB-level
    // rejection here should be rare (e.g. a ledger deleted moments ago).
    setBulkEntryProgress(`Creating ${total} entr${total === 1 ? 'y' : 'ies'}…`);
    const createdOrderAdvance = payloads.some(p => p.order_number);
    try {
        await postCashbookEntriesBulk(payloads);

        setBulkEntryProgress(`Created ${total} entr${total === 1 ? 'y' : 'ies'}.`, 'ok');
        showToast(`Created ${total} entr${total === 1 ? 'y' : 'ies'}`, 'success');
        await reloadCashbookForCurrentDate();
        if (createdOrderAdvance && typeof loadOrders === 'function') { try { await loadOrders(); } catch (e) {} }
        bulkEntryCreating = false;
        if (input) input.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        closeCashbookEntryModal();
    } catch (error) {
        console.error('Error creating bulk entries:', error);
        setBulkEntryProgress('Failed to create entries — nothing was saved. Review and retry.', 'error');
        showToast('Failed to create entries', 'error');
        bulkEntryCreating = false;
        if (input) input.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        setBulkEntrySubmitEnabled(true);
    }
}

// Show a progress/result message in the bulk-entry modal footer area.
function setBulkEntryProgress(text, kind) {
    const el = document.getElementById('bulkEntryProgress');
    if (!el) return;
    el.style.display = text ? 'block' : 'none';
    el.textContent = text || '';
    el.className = 'bulk-entry-progress'
        + (kind === 'ok' ? ' bulk-entry-progress-ok' : '')
        + (kind === 'error' ? ' bulk-entry-progress-error' : '');
}

// Per-submission key so a retried/duplicated create request is recognized
// server-side and returns the original row instead of inserting a duplicate.
function generateIdempotencyKey() {
    return crypto.randomUUID();
}

async function createCashbookEntry(payload) {
    // Optimistic update: add entry to local array immediately
    const tempId = '__temp_' + Date.now();
    const tempEntry = {
        ...payload,
        id: tempId,
        entry_date: String(payload.entry_date || '').slice(0, 10),
        created_at: getPKTISOString(),
        updated_at: getPKTISOString()
    };
    cashbookEntries.push(tempEntry);
    renderCashbook();

    try {
        const created = await apiJson('/cashbook/entries', {
            method: 'POST',
            body: { idempotency_key: generateIdempotencyKey(), ...payload },
            fallback: 'Failed to add cashbook entry'
        });
        applyLedgerBalancePatches(created.ledger_balances);
        updateCashInHand();

        // Debounced: waits to see if another write is on the way (e.g. the
        // other side of a two-sided entry) before refetching real IDs/grid.
        scheduleCashbookReload();
        showToast('Entry added', 'success');
    } catch (error) {
        console.error('Error adding cashbook entry:', error);
        // Remove the temp entry on failure
        cashbookEntries = cashbookEntries.filter(e => e.id !== tempId);
        renderCashbook();
        showToast('Failed to add entry', 'error');
    }
}

// POSTs a batch of cashbook entries as one atomic request (used for two-sided
// entries so the paired credit/debit rows can't half-succeed), applies the
// returned ledger balance patches, and updates Cash In Hand immediately.
// Returns the created/replayed entries (each carries ledger_balances).
async function postCashbookEntriesBulk(payloads) {
    const withKeys = payloads.map(p => ({ idempotency_key: generateIdempotencyKey(), ...p }));
    const created = await apiJson('/cashbook/entries/bulk', {
        method: 'POST',
        body: withKeys,
        fallback: 'Failed to create cashbook entries'
    });
    applyLedgerBalancePatches(created[0]?.ledger_balances);
    updateCashInHand();
    return created;
}

// Optimistic-UI wrapper around postCashbookEntriesBulk for the two-sided
// entry / order-advance modals: renders temp rows immediately, reverts them
// on failure. The debounced day reload picks up the real IDs.
async function createCashbookEntriesBulk(payloads) {
    if (!payloads || payloads.length === 0) return;

    const tempEntries = payloads.map((payload, i) => ({
        ...payload,
        id: `__temp_${Date.now()}_${i}`,
        entry_date: String(payload.entry_date || '').slice(0, 10),
        created_at: getPKTISOString(),
        updated_at: getPKTISOString()
    }));
    cashbookEntries.push(...tempEntries);
    renderCashbook();

    try {
        await postCashbookEntriesBulk(payloads);
        scheduleCashbookReload();
        showToast(payloads.length > 1 ? 'Entries added' : 'Entry added', 'success');
    } catch (error) {
        console.error('Error adding cashbook entries:', error);
        const tempIds = new Set(tempEntries.map(e => e.id));
        cashbookEntries = cashbookEntries.filter(e => !tempIds.has(e.id));
        renderCashbook();
        showToast('Failed to add entries', 'error');
    }
}

// `side` is which grid the row was typed into: 'debit' (left, TO) or 'credit'
// (right, FROM). The account picked there fills that side and the other stays
// cash — typing a row into the cash book is by definition a cash movement.
function tryCreateCashbookEntryFromPinnedRow(row, side) {
    const entryDate = String(row.entry_date || '').trim();
    const amount = parseCashbookAmount(row.amount);
    if (amount === null || amount <= 0) return;
    if (!entryDate) {
        showToast('Select an entry date for this row.', 'error');
        return;
    }

    const accountField = CASHBOOK_SIDES[side];
    const accountId = row[accountField] || null;
    if (!accountId) {
        showToast('Please select a ledger for this entry.', 'error');
        return;
    }

    createCashbookEntry({
        entry_date: entryDate,
        amount,
        description: String(row.description || '').trim(),
        from_account_id: side === 'credit' ? accountId : null,
        to_account_id: side === 'debit' ? accountId : null,
    });
}

async function updateCashbookEntry(entryId, updates) {
    if (!entryId || !updates || Object.keys(updates).length === 0) return;
    
    // Optimistic update: apply changes immediately
    const entryIndex = cashbookEntries.findIndex(e => e.id === entryId);
    const originalEntry = entryIndex >= 0 ? { ...cashbookEntries[entryIndex] } : null;
    if (entryIndex >= 0) {
        cashbookEntries[entryIndex] = { ...cashbookEntries[entryIndex], ...updates };
        renderCashbook();
    }

    try {
        const updated = await apiJson(`/cashbook/entries/${entryId}`, {
            method: 'PUT',
            body: updates,
            fallback: 'Failed to update cashbook entry'
        });
        applyLedgerBalancePatches(updated.ledger_balances);
        updateCashInHand();

        // Debounced: collapses a burst of edits into a single day refetch.
        scheduleCashbookReload();
        showToast('Entry updated', 'success');
    } catch (error) {
        console.error('Error updating cashbook entry:', error);
        // Revert on failure
        if (originalEntry && entryIndex >= 0) {
            cashbookEntries[entryIndex] = originalEntry;
            renderCashbook();
        }
        showToast('Failed to update entry', 'error');
    }
}

async function deleteCashbookEntry(entryId) {
    if (!entryId) return;
    
    // Optimistic update: remove immediately
    const entryIndex = cashbookEntries.findIndex(e => e.id === entryId);
    const removedEntry = entryIndex >= 0 ? cashbookEntries[entryIndex] : null;
    if (entryIndex >= 0) {
        cashbookEntries.splice(entryIndex, 1);
        renderCashbook();
    }

    try {
        const deleted = await apiJson(`/cashbook/entries/${entryId}`, {
            method: 'DELETE',
            fallback: 'Failed to delete cashbook entry'
        });
        applyLedgerBalancePatches(deleted.ledger_balances);
        updateCashInHand();

        // Debounced: collapses a burst of deletes into a single day refetch.
        scheduleCashbookReload();
        showToast('Entry deleted', 'success');
    } catch (error) {
        console.error('Error deleting cashbook entry:', error);
        // Restore on failure
        if (removedEntry) {
            cashbookEntries.push(removedEntry);
            renderCashbook();
        }
        showToast('Failed to delete entry', 'error');
    }
}

