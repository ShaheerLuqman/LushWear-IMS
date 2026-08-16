// Transactions: entries grid, day navigation, and the entry/advance/bulk modals.

// ============================================
// Transactions
// ============================================

function normalizeTransactionEntries(entries) {
    return (entries || []).map((entry) => ({
        ...entry,
        entry_date: entry.entry_date ? String(entry.entry_date).slice(0, 10) : ''
    }));
}

function getEmptyTransactionRow(entryDate = '') {
    // Use a unique ID each time to ensure AG Grid creates a fresh row
    return {
        id: '__new_' + Date.now() + '__',
        entry_date: entryDate,
        description: '',
        from_account_id: null,
        to_account_id: null,
        amount: null
    };
}

function sortedTransactionEntries(entries) {
    return [...(entries || [])].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    }).map((entry) => ({ ...entry, amount: parseFloat(entry.amount) || 0 }));
}

// The response also carries that day's cash balance, which nothing reads any
// more: the grid shows entries only, and Available Cash comes off the Cash in
// Hand ledger (getPhysicalCashInHand in ledgers.js).
async function loadTransactionDay(targetDate) {
    try {
        const data = await apiJson(`/transactions/day/${targetDate}`, { fallback: 'Failed to load transactions day' });
        transactionEntries = normalizeTransactionEntries(data.entries);
    } catch (error) {
        console.error('Error loading transactions day:', error);
        showToast('Failed to load transaction entries', 'error');
        transactionEntries = [];
    }
}

// One row per entry, both of its sides named, closed off by the blank row a new
// entry is typed into. The day's cash balance lives in the header's Available
// Cash, not in rows of the table.
function renderTransactions() {
    if (!transactionsGridApi) return;
    const selectedDate = transactionSelectedDate || getTodayDateString();
    const entries = transactionEntries.filter((entry) => entry.entry_date === selectedDate);
    transactionsGridApi.setGridOption('rowData', [
        ...sortedTransactionEntries(entries),
        getEmptyTransactionRow(selectedDate)
    ]);
}

async function loadTransactions() {
    const dateFilter = document.getElementById('transactionDateFilter');
    if (!transactionSelectedDate) {
        transactionSelectedDate = getTodayDateString();
    }
    if (dateFilter) dateFilter.value = formatDateDDMMYYYY(transactionSelectedDate);

    await Promise.all([
        loadTransactionDay(transactionSelectedDate),
        loadLedgersList()
    ]);
    renderTransactions();
    updateCashInHand();
}

async function reloadTransactionsForCurrentDate() {
    const selectedDate = transactionSelectedDate || getTodayDateString();
    await loadTransactionDay(selectedDate);
    renderTransactions();
    updateCashInHand();
}

let transactionsReloadTimer = null;

// Debounces the full-day reload (GET /transactions/day/{date} + re-render): each
// call resets a 500ms timer, so a burst of entry writes (e.g. the two-sided
// entry / order-advance modals, each firing two creates) collapses into one
// refetch after the last one settles, instead of one per write.
function scheduleTransactionsReload() {
    if (transactionsReloadTimer) clearTimeout(transactionsReloadTimer);
    transactionsReloadTimer = setTimeout(() => {
        transactionsReloadTimer = null;
        reloadTransactionsForCurrentDate();
    }, 500);
}

// --- Create Transaction Entry modal ------------------------------------------

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

function transactionEntryLedgerName(ledgerId) {
    const ledger = ledgers.find(l => l.id === ledgerId);
    return ledger ? ledger.name : '';
}

// Describes an entry by the sides it names; an unnamed side is cash and goes
// unmentioned, which is how a plain cash entry has always read.
function defaultTransactionParticulars(fromName, toName) {
    if (fromName && toName) return `${fromName} to ${toName}`;
    if (fromName) return `Amount received from ${fromName}`;
    if (toName) return `Amount transferred to ${toName}`;
    return '';
}

function transactionEntryDefaultDescription() {
    if (isTransactionEntryOrderAdvance()) {
        const orderNumber = document.getElementById('transactionEntryOrderNumber');
        return orderAdvanceParticularPlaceholder(orderNumber ? orderNumber.value : '');
    }
    const fromName = transactionEntryLedgerName(document.getElementById('transactionEntryFrom').value);
    const toName = transactionEntryLedgerName(document.getElementById('transactionEntryTo').value);
    return defaultTransactionParticulars(fromName, toName);
}

function refreshTransactionEntryParticularPlaceholder() {
    const part = document.getElementById('transactionEntryParticular');
    if (part) part.placeholder = transactionEntryDefaultDescription() || 'Amount received from...';
}

function isTransactionEntryOrderAdvance() {
    const cb = document.getElementById('transactionEntryOrderAdvance');
    return !!(cb && cb.checked);
}

/**
 * Toggle order-advance mode: the From side is locked to the Orders ledger and an
 * order number becomes required. To stays free, so an advance paid straight into
 * a bank account is one entry that never touches cash.
 */
function setTransactionEntryOrderAdvance(enabled) {
    const group = document.getElementById('transactionEntryOrderNumberGroup');
    const orderNumber = document.getElementById('transactionEntryOrderNumber');

    if (group) group.style.display = enabled ? '' : 'none';
    if (orderNumber) {
        if (enabled) orderNumber.setAttribute('required', '');
        else { orderNumber.removeAttribute('required'); orderNumber.value = ''; }
    }
    // From is always Orders for an advance, so hide the field rather than
    // showing a locked select.
    const fromGroup = document.getElementById('transactionEntryFromGroup');
    const from = document.getElementById('transactionEntryFrom');
    if (fromGroup) fromGroup.style.display = enabled ? 'none' : '';
    if (from) {
        from.disabled = enabled;
        if (enabled) from.value = getOrdersLedgerId() || '';
    }

    refreshTransactionEntryParticularPlaceholder();
    if (enabled && orderNumber) orderNumber.focus();
}

const CREATE_LEDGER_OPTION_VALUE = '__create_ledger__';

function populateTransactionEntryLedgerSelect(select) {
    if (!select) return;
    const current = select.value;
    // The empty option is not a blank: an unnamed side IS the cash account, which
    // is why that account is not among the options below it.
    const options = [`<option value="">${escapeHtml(cashSideLabel())}</option>`]
        .concat(selectableLedgers().map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`))
        .concat([`<option value="${CREATE_LEDGER_OPTION_VALUE}">+ Create new ledger...</option>`]);
    select.innerHTML = options.join('');
    if (current && ledgers.some(l => l.id === current)) select.value = current;
}

function handleLedgerSelectChange(e) {
    if (e.target.value === CREATE_LEDGER_OPTION_VALUE) {
        const selectId = e.target.id;
        e.target.value = '';
        openCreateLedgerModal((created) => {
            ['transactionEntryFrom', 'transactionEntryTo'].forEach((id) => {
                populateTransactionEntryLedgerSelect(document.getElementById(id));
            });
            const select = document.getElementById(selectId);
            if (select) {
                select.value = created.id;
                select.dispatchEvent(new Event('change'));
            }
        });
    }
}

function openTransactionEntryModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const from = document.getElementById('transactionEntryFrom');
    const to = document.getElementById('transactionEntryTo');
    const amount = document.getElementById('transactionEntryAmount');
    const part = document.getElementById('transactionEntryParticular');

    populateTransactionEntryLedgerSelect(from);
    populateTransactionEntryLedgerSelect(to);
    if (from) from.value = '';
    if (to) to.value = '';
    if (amount) amount.value = '';
    if (part) part.value = '';

    const orderAdvance = document.getElementById('transactionEntryOrderAdvance');
    if (orderAdvance) orderAdvance.checked = false;
    setTransactionEntryOrderAdvance(false);

    if (ledgers.length === 0) {
        showToast('No ledgers available. Create a ledger first.', 'error');
    }

    refreshTransactionEntryParticularPlaceholder();
    setTransactionEntryMode('single');
    document.getElementById('transactionEntryModal').classList.add('active');
    if (amount) amount.focus();
}

function closeTransactionEntryModal() {
    if (bulkEntryCreating) return;
    document.getElementById('transactionEntryModal').classList.remove('active');
}

/** Switch the shared Create Entry modal between 'single' and 'bulk' input modes. */
function setTransactionEntryMode(mode) {
    if (bulkEntryCreating) return;
    const bulk = mode === 'bulk';
    const form = document.getElementById('transactionEntryForm');
    const panel = document.getElementById('transactionEntryBulkPanel');
    const singleBtn = document.getElementById('transactionEntryModeSingle');
    const bulkBtn = document.getElementById('transactionEntryModeBulk');

    if (form) form.style.display = bulk ? 'none' : '';
    if (panel) panel.style.display = bulk ? '' : 'none';
    const singleSubmit = document.getElementById('transactionEntrySubmitBtn');
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
        const amount = document.getElementById('transactionEntryAmount');
        if (amount) amount.focus();
    }
}

async function submitTransactionEntryModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const isAdvance = isTransactionEntryOrderAdvance();
    // A select silently drops a value with no matching option, so a missing Orders
    // ledger would otherwise surface as a confusing "select an account" error.
    if (isAdvance && !getOrdersLedgerId()) {
        showToast('No Orders ledger is set. Assign the Orders role in Edit Ledger.', 'error');
        return;
    }
    const orderNumber = isAdvance
        ? document.getElementById('transactionEntryOrderNumber').value.trim().replace(/^#/, '')
        : '';
    if (isAdvance && !orderNumber) { showToast('Enter an order number', 'error'); return; }

    const fromId = (isAdvance ? getOrdersLedgerId() : document.getElementById('transactionEntryFrom').value) || null;
    const toId = document.getElementById('transactionEntryTo').value || null;
    const amount = parseFloat(document.getElementById('transactionEntryAmount').value);

    if (Number.isNaN(amount) || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }
    if (!fromId && !toId) { showToast(`Both sides are ${cashSideLabel()} — name an account on one side`, 'error'); return; }
    if (fromId && fromId === toId) { showToast('From and To must be different accounts', 'error'); return; }

    const payload = {
        entry_date: transactionSelectedDate || getTodayDateString(),
        amount,
        // If the particulars field is left empty, fall back to the placeholder text.
        description: document.getElementById('transactionEntryParticular').value.trim() || transactionEntryDefaultDescription(),
        from_account_id: fromId,
        to_account_id: toId
    };
    // Tag the advance so it can be reconciled against the order's Shopify advance amount.
    if (isAdvance) payload.order_number = orderNumber;

    closeTransactionEntryModal();
    await createTransactionEntry(payload);
    // Refresh orders so the advance status indicator updates for this order.
    if (isAdvance && typeof loadOrders === 'function') { try { await loadOrders(); } catch (e) {} }
}

function closeBulkEntryInfoCard() {
    document.getElementById('bulkEntryInfoCard')?.classList.remove('open');
    document.getElementById('bulkEntryInfoBtn')?.setAttribute('aria-expanded', 'false');
}

function initTransactionsActions() {
    const transactionDateFilter = document.getElementById('transactionDateFilter');
    if (transactionDateFilter) {
        const applyDateFromInput = () => {
            const parsed = parseDDMMYYYYToYYYYMMDD(transactionDateFilter.value);
            if (parsed) {
                transactionSelectedDate = parsed;
                transactionDateFilter.value = formatDateDDMMYYYY(parsed);
                reloadTransactionsForCurrentDate();
            } else if (transactionDateFilter.value.trim() !== '') {
                showToast('Enter date as DD/MM/YYYY', 'error');
                transactionDateFilter.value = formatDateDDMMYYYY(transactionSelectedDate || getTodayDateString());
            }
        };
        transactionDateFilter.addEventListener('change', applyDateFromInput);
        transactionDateFilter.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyDateFromInput();
            }
        });
        transactionDateFilter.addEventListener('blur', () => {
            if (transactionDateFilter.value.trim() !== '') {
                const parsed = parseDDMMYYYYToYYYYMMDD(transactionDateFilter.value);
                if (parsed) {
                    transactionSelectedDate = parsed;
                    transactionDateFilter.value = formatDateDDMMYYYY(parsed);
                } else {
                    transactionDateFilter.value = formatDateDDMMYYYY(transactionSelectedDate || getTodayDateString());
                }
            } else {
                transactionDateFilter.value = formatDateDDMMYYYY(transactionSelectedDate || getTodayDateString());
            }
        });
    }
    document.getElementById('transactionTodayBtn')?.addEventListener('click', () => {
        const today = getTodayDateString();
        transactionSelectedDate = today;
        if (transactionDateFilter) transactionDateFilter.value = formatDateDDMMYYYY(today);
        reloadTransactionsForCurrentDate();
    });
    // Matches against every searchable field at once (accounts, amount,
    // description, order number) via each column's getQuickFilterText.
    document.getElementById('transactionSearchFilter')?.addEventListener('input', (e) => {
        transactionsGridApi?.setGridOption('quickFilterText', e.target.value);
    });
    document.getElementById('transactionPrevDayBtn')?.addEventListener('click', () => {
        const current = transactionSelectedDate || getTodayDateString();
        const [year, month, day] = current.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        date.setDate(date.getDate() - 1);
        const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        transactionSelectedDate = newDate;
        if (transactionDateFilter) transactionDateFilter.value = formatDateDDMMYYYY(newDate);
        reloadTransactionsForCurrentDate();
    });
    document.getElementById('transactionNextDayBtn')?.addEventListener('click', () => {
        const current = transactionSelectedDate || getTodayDateString();
        const [year, month, day] = current.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        date.setDate(date.getDate() + 1);
        const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        transactionSelectedDate = newDate;
        if (transactionDateFilter) transactionDateFilter.value = formatDateDDMMYYYY(newDate);
        reloadTransactionsForCurrentDate();
    });

    // Transaction entry account selects: picking "+ Create new ledger..." opens the create ledger modal
    ['transactionEntryFrom', 'transactionEntryTo'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', handleLedgerSelectChange);
    });

    document.getElementById('transactionCreateEntryBtn')?.addEventListener('click', openTransactionEntryModal);
    document.getElementById('transactionEntryOrderAdvance')?.addEventListener('change', (e) => {
        setTransactionEntryOrderAdvance(e.target.checked);
    });
    document.getElementById('transactionEntryOrderNumber')?.addEventListener('input', refreshTransactionEntryParticularPlaceholder);
    document.getElementById('transactionEntryModeSingle')?.addEventListener('click', () => setTransactionEntryMode('single'));
    document.getElementById('transactionEntryModeBulk')?.addEventListener('click', () => setTransactionEntryMode('bulk'));
    document.getElementById('bulkEntrySubmitBtn')?.addEventListener('click', submitBulkEntry);
    initBulkEntryInfoCard();
    // Re-validate as the user types (debounced lightly) and reset submit state.
    document.getElementById('bulkEntryInput')?.addEventListener('input', () => {
        autoResizeBulkEntryInput();
        setBulkEntrySubmitEnabled(false);
        clearTimeout(window.__bulkEntryDebounce);
        window.__bulkEntryDebounce = setTimeout(validateBulkEntry, 300);
    });
    document.getElementById('closeTransactionEntryModal')?.addEventListener('click', closeTransactionEntryModal);
    document.getElementById('transactionEntryCancelBtn')?.addEventListener('click', closeTransactionEntryModal);
    document.getElementById('transactionEntryModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'transactionEntryModal') closeTransactionEntryModal();
    });
    document.getElementById('transactionEntryForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        submitTransactionEntryModal();
    });
    // Update the particulars placeholder dynamically as accounts are chosen.
    document.getElementById('transactionEntryFrom')?.addEventListener('change', refreshTransactionEntryParticularPlaceholder);
    document.getElementById('transactionEntryTo')?.addEventListener('change', refreshTransactionEntryParticularPlaceholder);
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
    const cancelBtn = document.getElementById('transactionEntryCancelBtn');
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

    const named = { from: sides.fromName ? resolveBulkLedger(sides.fromName) : null,
                    to: sides.toName ? resolveBulkLedger(sides.toName) : null };
    if (sides.fromName && !named.from) result.errors.push(`Ledger "${sides.fromName}" not found.`);
    if (sides.toName && !named.to) result.errors.push(`Ledger "${sides.toName}" not found.`);
    if (result.errors.length > 0) return result;

    // Naming the cash account is the same fact as leaving the side out, so it
    // collapses to the empty side rather than becoming a second way to write it.
    const cashId = getCashLedger()?.id || null;
    const from = named.from && named.from.ledger.id !== cashId ? named.from : null;
    const to = named.to && named.to.ledger.id !== cashId ? named.to : null;
    if (!from && !to) {
        result.errors.push(`Both sides are ${cashSideLabel()} — name an account on one side.`);
        return result;
    }

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
    return defaultTransactionParticulars(from ? from.ledger.name : '', to ? to.ledger.name : '');
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
                    const from = e.from_account_id ? ledgerNameById(e.from_account_id) : cashSideLabel();
                    const to = e.to_account_id ? ledgerNameById(e.to_account_id) : cashSideLabel();
                    const tag = e.order_number ? ` [Order #${escapeHtml(e.order_number)}]` : '';
                    return `${formatBulkAmount(e.amount)} ${escapeHtml(from)} <i class="fa-solid fa-arrow-right"></i> ${escapeHtml(to)}${tag}`;
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

    const entryDate = transactionSelectedDate || getTodayDateString();
    const payloads = [];
    parsed.lines.forEach(p => {
        p.entries.forEach(e => payloads.push({ ...e, entry_date: entryDate }));
    });

    const total = payloads.length;
    const cancelBtn = document.getElementById('transactionEntryCancelBtn');
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
        await postTransactionEntriesBulk(payloads);

        setBulkEntryProgress(`Created ${total} entr${total === 1 ? 'y' : 'ies'}.`, 'ok');
        showToast(`Created ${total} entr${total === 1 ? 'y' : 'ies'}`, 'success');
        await reloadTransactionsForCurrentDate();
        if (createdOrderAdvance && typeof loadOrders === 'function') { try { await loadOrders(); } catch (e) {} }
        bulkEntryCreating = false;
        if (input) input.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        closeTransactionEntryModal();
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

async function createTransactionEntry(payload) {
    // Optimistic update: add entry to local array immediately
    const tempId = '__temp_' + Date.now();
    const tempEntry = {
        ...payload,
        id: tempId,
        entry_date: String(payload.entry_date || '').slice(0, 10),
        created_at: getPKTISOString(),
        updated_at: getPKTISOString()
    };
    transactionEntries.push(tempEntry);
    renderTransactions();

    try {
        const created = await apiJson('/transactions/entries', {
            method: 'POST',
            body: { idempotency_key: generateIdempotencyKey(), ...payload },
            fallback: 'Failed to add transaction entry'
        });
        applyLedgerBalancePatches(created.ledger_balances);
        updateCashInHand();

        // Debounced: waits to see if another write is on the way (e.g. the
        // other side of a two-sided entry) before refetching real IDs/grid.
        scheduleTransactionsReload();
        showToast('Entry added', 'success');
    } catch (error) {
        console.error('Error adding transaction entry:', error);
        // Remove the temp entry on failure
        transactionEntries = transactionEntries.filter(e => e.id !== tempId);
        renderTransactions();
        showToast('Failed to add entry', 'error');
    }
}

// POSTs a batch of transaction entries as one atomic request (bulk text entry, so a
// pasted block can't half-succeed), applies the returned ledger balance patches,
// and updates Cash In Hand immediately.
// Returns the created/replayed entries (each carries ledger_balances).
async function postTransactionEntriesBulk(payloads) {
    const withKeys = payloads.map(p => ({ idempotency_key: generateIdempotencyKey(), ...p }));
    const created = await apiJson('/transactions/entries/bulk', {
        method: 'POST',
        body: withKeys,
        fallback: 'Failed to create transaction entries'
    });
    applyLedgerBalancePatches(created[0]?.ledger_balances);
    updateCashInHand();
    return created;
}

// The new-entry row at the bottom of the grid. An empty side is cash, so only
// one of them has to name an account.
function tryCreateTransactionEntryFromNewRow(row) {
    const entryDate = String(row.entry_date || '').trim();
    const amount = parseTransactionAmount(row.amount);
    if (amount === null || amount <= 0) return;
    if (!entryDate) {
        showToast('Select an entry date for this row.', 'error');
        return;
    }

    const fromId = row.from_account_id || null;
    const toId = row.to_account_id || null;
    if (!fromId && !toId) {
        showToast(`Both sides are ${cashSideLabel()} — name an account on one side`, 'error');
        return;
    }
    if (fromId && fromId === toId) {
        showToast('From and To must be different accounts', 'error');
        return;
    }

    createTransactionEntry({
        entry_date: entryDate,
        amount,
        description: String(row.description || '').trim(),
        from_account_id: fromId,
        to_account_id: toId
    });
}

async function updateTransactionEntry(entryId, updates) {
    if (!entryId || !updates || Object.keys(updates).length === 0) return;

    // Optimistic update: apply changes immediately
    const entryIndex = transactionEntries.findIndex(e => e.id === entryId);
    const originalEntry = entryIndex >= 0 ? { ...transactionEntries[entryIndex] } : null;
    if (entryIndex >= 0) {
        transactionEntries[entryIndex] = { ...transactionEntries[entryIndex], ...updates };
        renderTransactions();
    }

    try {
        const updated = await apiJson(`/transactions/entries/${entryId}`, {
            method: 'PUT',
            body: updates,
            fallback: 'Failed to update transaction entry'
        });
        applyLedgerBalancePatches(updated.ledger_balances);
        updateCashInHand();

        // Debounced: collapses a burst of edits into a single day refetch.
        scheduleTransactionsReload();
        showToast('Entry updated', 'success');
    } catch (error) {
        console.error('Error updating transaction entry:', error);
        // Revert on failure
        if (originalEntry && entryIndex >= 0) {
            transactionEntries[entryIndex] = originalEntry;
            renderTransactions();
        }
        showToast('Failed to update entry', 'error');
    }
}

async function deleteTransactionEntry(entryId) {
    if (!entryId) return;

    // Optimistic update: remove immediately
    const entryIndex = transactionEntries.findIndex(e => e.id === entryId);
    const removedEntry = entryIndex >= 0 ? transactionEntries[entryIndex] : null;
    if (entryIndex >= 0) {
        transactionEntries.splice(entryIndex, 1);
        renderTransactions();
    }

    try {
        const deleted = await apiJson(`/transactions/entries/${entryId}`, {
            method: 'DELETE',
            fallback: 'Failed to delete transaction entry'
        });
        applyLedgerBalancePatches(deleted.ledger_balances);
        updateCashInHand();

        // Debounced: collapses a burst of deletes into a single day refetch.
        scheduleTransactionsReload();
        showToast('Entry deleted', 'success');
    } catch (error) {
        console.error('Error deleting transaction entry:', error);
        // Restore on failure
        if (removedEntry) {
            transactionEntries.push(removedEntry);
            renderTransactions();
        }
        showToast('Failed to delete entry', 'error');
    }
}
