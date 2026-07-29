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

function getEmptyCashbookRow(entryDate = '', side = '') {
    // Use a unique ID each time to ensure AG Grid creates a fresh row
    return {
        id: '__new_' + side + '_' + Date.now() + '__',
        entry_date: entryDate,
        description: '',
        folio: null,
        amount: null,
        running_total: null
    };
}

function buildCashbookSideRows(entries, side) {
    const filtered = (entries || []).filter((entry) => entry.entry_type === side);
    const sorted = [...filtered].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    return sorted.map((entry) => ({
        ...entry,
        amount: parseFloat(entry.amount) || 0
    }));
}

function buildCashbookIncomingWithOpening(entries, carryForward, selectedDate) {
    const opening = parseFloat(carryForward) || 0;
    const rows = buildCashbookSideRows(entries, 'credit');
    const totalCredit = rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const openingRow = {
        id: '__opening__',
        description: "Opening Balance",
        amount: opening,
        _isSystemRow: true
    };
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'credit');
    const totalRow = {
        id: '__total_in__',
        description: 'Total',
        amount: opening + totalCredit,
        _isFooter: true
    };
    return { rowData: [openingRow, ...rows, newEntryRow], pinnedBottomRowData: [totalRow], totalCredit };
}

function buildCashbookOutgoingWithClosing(entries, carryForward, selectedDate) {
    const creditEntries = (entries || []).filter((e) => e.entry_type === 'credit');
    const debitEntries = (entries || []).filter((e) => e.entry_type === 'debit');
    const totalCredit = creditEntries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const totalDebit = debitEntries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const opening = parseFloat(carryForward) || 0;
    const closingBalance = opening + totalCredit - totalDebit;
    const rows = buildCashbookSideRows(entries, 'debit');
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'debit');
    const closingRow = {
        id: '__closing__',
        description: 'Closing Balance',
        amount: closingBalance,
        _isSystemRow: true
    };
    const totalRow = {
        id: '__total_out__',
        description: 'Total',
        amount: totalDebit + closingBalance,
        _isFooter: true
    };
    return { rowData: [...rows, newEntryRow, closingRow], pinnedBottomRowData: [totalRow], totalDebit };
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

    const { rowData: incomingRowData, pinnedBottomRowData: incomingPinnedBottom } = buildCashbookIncomingWithOpening(filteredEntries, openingBalance, selectedDate);
    const { rowData: outgoingRowData, pinnedBottomRowData: outgoingPinnedBottom } = buildCashbookOutgoingWithClosing(filteredEntries, openingBalance, selectedDate);

    if (cashbookIncomingGridApi) {
        cashbookIncomingGridApi.setGridOption('rowData', incomingRowData);
        cashbookIncomingGridApi.setGridOption('pinnedTopRowData', []);
        cashbookIncomingGridApi.setGridOption('pinnedBottomRowData', incomingPinnedBottom);
        cashbookIncomingGridApi.setGridOption('pagination', false);
    }
    if (cashbookOutgoingGridApi) {
        cashbookOutgoingGridApi.setGridOption('rowData', outgoingRowData);
        cashbookOutgoingGridApi.setGridOption('pinnedTopRowData', []);
        cashbookOutgoingGridApi.setGridOption('pinnedBottomRowData', outgoingPinnedBottom);
        cashbookOutgoingGridApi.setGridOption('pagination', false);
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

// Tracks whether the user has manually edited the outgoing amount. Until they do,
// the outgoing amount mirrors whatever is typed in the incoming amount.
let cashbookEntryOutAmountTouched = false;

// The "Orders" ledger that order advances are always posted to (hardcoded).
const ORDERS_LEDGER_ID = '4bc067af-cf91-4700-8b52-b70ad4a991df';

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
 * Toggle order-advance mode: the incoming side is locked to the Orders ledger and
 * an order number becomes required.
 */
function setCashbookEntryOrderAdvance(enabled) {
    const group = document.getElementById('cashbookEntryOrderNumberGroup');
    const orderNumber = document.getElementById('cashbookEntryOrderNumber');
    const inLedger = document.getElementById('cashbookEntryInLedger');
    // "Paid with Cash" (on the Outgoing side) skips the credit leg, which an
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
    // The incoming ledger is always Orders for an advance, so hide the field
    // rather than showing a locked select.
    const inLedgerGroup = document.getElementById('cashbookEntryInLedgerGroup');
    if (inLedgerGroup) inLedgerGroup.style.display = enabled ? 'none' : '';
    if (inLedger) {
        inLedger.disabled = enabled;
        if (enabled) inLedger.value = ORDERS_LEDGER_ID;
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
    if (isAdvance && !ledgers.some(l => l.id === ORDERS_LEDGER_ID)) {
        showToast('The Orders ledger is missing. Recreate it to record advances.', 'error');
        return;
    }

    if (!skipIn) {
        if (!inLedger) { showToast('Select an incoming ledger', 'error'); return; }
        if (Number.isNaN(inAmount) || inAmount <= 0) { showToast('Enter a valid incoming amount', 'error'); return; }
    }
    if (!skipOut) {
        if (!outLedger) { showToast('Select an outgoing ledger', 'error'); return; }
        if (Number.isNaN(outAmount) || outAmount <= 0) { showToast('Enter a valid outgoing amount', 'error'); return; }
    }

    const entryDate = cashbookSelectedDate || getTodayDateString();
    const defaultDescription = (side, ledgerId) => (isAdvance
        ? orderAdvanceParticularPlaceholder(orderNumber)
        : cashbookEntryParticularPlaceholder(side, ledgerId));
    const payloads = [];

    if (!skipIn) {
        // If the particulars field is left empty, fall back to the default placeholder text.
        const inDescription = (inPartEl.value.trim()) || defaultDescription('credit', inLedger);
        const inPayload = { entry_date: entryDate, entry_type: 'credit', amount: inAmount, description: inDescription, folio: inLedger };
        // Tag the advance so it can be reconciled against the order's Shopify advance amount.
        if (isAdvance) inPayload.order_number = orderNumber;
        payloads.push(inPayload);
    }
    if (!skipOut) {
        const outDescription = (outPartEl.value.trim()) || defaultDescription('debit', outLedger);
        payloads.push({ entry_date: entryDate, entry_type: 'debit', amount: outAmount, description: outDescription, folio: outLedger });
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

// Bulk-entry KIND tokens: FROM/CR mean money received (credit), TO/DR mean
// money paid out (debit) — Cr/Dr follow the cash account's own perspective
// (cash is debited on receipt, credited on payment).
const BULK_ENTRY_KIND_TO_ENTRY_TYPE = { FROM: 'credit', CR: 'credit', TO: 'debit', DR: 'debit' };

/**
 * Parse one line of bulk-entry text.
 * Format: <KIND>: <AMOUNT> <LEDGER> [(<PARTICULARS>)]
 * KIND is From/Cr (credit to LEDGER) or To/Dr (debit from LEDGER). Particulars
 * are optional; when omitted, the same default text as the manual entry form is used.
 * Returns { ok, errors: [str], lineNo, raw, kind, amount, particulars, entries: [{entry_type, amount, description, folio}] }
 */
function parseBulkEntryLine(raw, lineNo) {
    const result = { ok: false, errors: [], lineNo, raw };
    const line = String(raw || '').trim();
    if (!line) { result.blank = true; return result; }

    // Find the KIND token (From/To/Cr/Dr followed by ':') anywhere in the line
    // and ignore anything before it. This lets pasted lines keep prefixes like
    // a WhatsApp timestamp, e.g. "[3:32 am, 10/06/2026] Arham Ghory: From: 16400 ...".
    const kindMatch = line.match(/\b(FROM|TO|CR|DR)\s*:\s*(.*)$/i);
    if (!kindMatch) {
        result.errors.push('Missing "<KIND>:" prefix (use From:, To:, Cr: or Dr:).');
        return result;
    }
    const kind = kindMatch[1].toUpperCase();
    const rest = kindMatch[2].trim();
    result.kind = kind;
    // The cleaned line (from KIND: onward) without any pasted prefix such as a
    // WhatsApp timestamp. Shown in the validation list instead of the raw line.
    result.cleaned = `${kind}: ${rest}`;

    // Optional trailing "(particulars)" - everything before it is "<AMOUNT> <LEDGER>".
    let particulars = null;
    let head = rest;
    const parenMatch = rest.match(/\(([^)]*)\)\s*$/);
    if (parenMatch) {
        particulars = parenMatch[1].trim();
        head = rest.slice(0, parenMatch.index).trim();
    }

    const headMatch = head.match(/^([0-9][0-9,]*(?:\.[0-9]+)?)\s+(.+)$/);
    if (!headMatch) {
        result.errors.push('Missing amount or ledger name (format: "<AMOUNT> <LEDGER>").');
        return result;
    }

    const amount = parseFloat(headMatch[1].replace(/,/g, ''));
    if (Number.isNaN(amount) || amount <= 0) {
        result.errors.push('Amount must be a number greater than 0.');
    } else {
        result.amount = amount;
    }

    // Shorthand for an order advance: "Order# 11473" (or "Orders# 11473") in
    // place of a ledger name resolves straight to the Orders ledger, tagged
    // with that order number.
    const ledgerName = headMatch[2].trim();
    const orderShorthand = ledgerName.match(/^orders?\s*#?\s*(\d{4,})$/i);
    const ledger = orderShorthand
        ? ledgers.find(l => l.id === ORDERS_LEDGER_ID) || null
        : findLedgerByName(ledgerName);
    if (!ledger) result.errors.push(orderShorthand ? 'Orders ledger not found.' : `Ledger "${ledgerName}" not found.`);

    if (result.errors.length > 0) return result;

    const entryType = BULK_ENTRY_KIND_TO_ENTRY_TYPE[kind];
    // A credit to the "Orders" ledger is an order-advance entry; tag it with the
    // order number parsed from the particulars (or the "Order# ..." shorthand)
    // so advance reconciliation works.
    const orderNumber = orderShorthand ? orderShorthand[1] : (entryType === 'credit' ? extractOrderNumberFromText(particulars) : null);
    const description = particulars || (orderNumber && ledger.id === ORDERS_LEDGER_ID
        ? orderAdvanceParticularPlaceholder(orderNumber)
        : cashbookEntryParticularPlaceholder(entryType, ledger.id));
    result.particulars = particulars || '';

    const entry = { entry_type: entryType, amount: result.amount, description, folio: ledger.id };
    if (ledger.id === ORDERS_LEDGER_ID && orderNumber) entry.order_number = orderNumber;

    result.entries = [entry];
    result.orderNumber = orderNumber || null;
    result.ok = true;
    return result;
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
        // Show the cleaned line (KIND: onward) so pasted prefixes like WhatsApp
        // timestamps don't appear; fall back to raw when there's no KIND token.
        const displayText = p.cleaned || p.raw;
        if (p.ok) {
            const summary = p.entries
                .map(e => {
                    const dir = e.entry_type === 'credit' ? '▲ in' : '▼ out';
                    const tag = e.order_number ? ` [Order #${escapeHtml(e.order_number)}]` : '';
                    return `${dir} ${formatBulkAmount(e.amount)} → ${escapeHtml(ledgerNameById(e.folio))}${tag}`;
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

function tryCreateCashbookEntryFromPinnedRow(row, entryType) {
    const entryDate = String(row.entry_date || '').trim();
    const amount = parseCashbookAmount(row.amount);
    if (amount === null || amount <= 0) return;
    if (!entryDate) {
        showToast('Select an entry date for this row.', 'error');
        return;
    }
    const description = String(row.description || '').trim();
    const folio = row.folio || null;
    
    // Folio is now required
    if (!folio) {
        showToast('Please select a ledger (folio) for this entry.', 'error');
        return;
    }

    createCashbookEntry({
        entry_date: entryDate,
        entry_type: entryType,
        amount,
        description,
        folio
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

