// Ledgers list, ledger detail grid, and the create/edit ledger modals.

// ============================================
// Ledger Functions
// ============================================

async function loadLedgersList() {
    try {
        ledgers = await apiJson('/ledgers/', { fallback: 'Failed to load ledgers' });
    } catch (error) {
        console.error('Error loading ledgers:', error);
        ledgers = [];
    }
}

async function loadLedgers() {
    await loadLedgersList();
    renderLedgerCards();
    updateCashInHand();
}

let bankLedgerBalances = []; // Store individual ledger balances for tooltip

// Applies balance(s) returned by a transaction entry write (see ledger_balances
// in supabase_schema.sql / TransactionEntry.ledger_balances) to the in-memory
// `ledgers` array, so updateCashInHand() reflects the write with no extra fetch.
function applyLedgerBalancePatches(patches) {
    if (!patches) return;
    (Array.isArray(patches) ? patches : [patches]).forEach(p => {
        if (!p || !p.ledger_id) return;
        const ledger = ledgers.find(l => l.id === p.ledger_id);
        if (ledger) ledger.balance = p.balance;
    });
}

// Natures that sit on the Credit side when healthy. Balances are stored
// Debit-positive for every ledger regardless of Nature (see recalc_ledger_balance
// in supabase_schema.sql), so a Revenue/Liability/Equity ledger in good standing
// carries a *negative* stored balance.
const CREDIT_NORMAL_TYPES = ['Liability', 'Equity', 'Revenue'];

// journal_entries.voucher_type, as shown on a ledger statement.
const LEDGER_VOUCHER_LABELS = {
    transaction: 'Transaction',
    bill: 'Bill',
    opening: 'Opening',
    manual: 'Journal',
};

// Stored balances are Debit-positive, so the sign alone gives the side - no
// per-Nature branch needed here. Shown as a positive number plus Dr/Cr rather
// than a bare negative, so "Sales: -500,000" reads as "Sales: 500,000 Cr".
// Zero sits on neither side and gets no suffix.
function formatBalanceWithSide(value) {
    const val = parseFloat(value) || 0;
    if (!val) return formatMoney(0);
    return `${formatMoney(Math.abs(val))} ${val > 0 ? 'Dr' : 'Cr'}`;
}

function formatMoney(value) {
    return (parseFloat(value) || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// Physical cash in hand = the balance of the Cash system ledger, which
// every transaction entry's unnamed side posts to (project_transaction_entry_to_journal).
//
// It was the daily closing_balance of transaction_daily_balances, which only ever knew about
// transaction entries: a bill paid in cash, a manual journal line, or an opening
// balance moved the ledger without moving that figure, so the headline drifted
// from the account it claims to report.
//
// Adding this to the included ledgers' balances does not double-count: every
// rupee moved into a bank ledger was credited out of Cash by the same entry, and
// the Cash account itself cannot be flagged include_in_cash_in_hand.
function getPhysicalCashInHand() {
    return parseFloat(getCashLedger()?.balance) || 0;
}

// The org's cash account, which every transaction entry's unnamed side posts to.
// Created with the organization, so it is only ever missing mid-migration.
function getCashLedger() {
    return ledgers.find(l => l.system_key === 'cash') || null;
}

// What an unnamed side is labelled. Reads the account's own name, so renaming it
// renames it everywhere rather than leaving a hardcoded word to drift from it.
function cashSideLabel() {
    return getCashLedger()?.name || 'Cash';
}

// The accounts a user can name on an entry: everything except cash, which is
// what leaving a side empty already means. Offering it too would be a second
// way to write the same entry.
function selectableLedgers() {
    return ledgers.filter(l => l.system_key !== 'cash');
}

// Both parts now come from the in-memory `ledgers` array, kept in sync by
// loadLedgersList() on cold loads and applyLedgerBalancePatches() on every
// transaction write — no extra network call here.
function updateCashInHand() {
    const cashInHandLedgers = ledgers.filter(l => l.include_in_cash_in_hand);

    bankLedgerBalances = cashInHandLedgers.map(l => ({ name: l.name, balance: parseFloat(l.balance) || 0 }));
    const bankTotal = bankLedgerBalances.reduce((sum, b) => sum + b.balance, 0);
    const physicalCashInHand = getPhysicalCashInHand();
    const totalBalance = bankTotal + physicalCashInHand;

    const amountEl = document.getElementById('cashInHandAmount');
    if (amountEl) {
        amountEl.textContent = `Rs ${formatMoney(totalBalance)}`;
    }

    updateCashInHandTooltip(physicalCashInHand);
}

function cashInHandTooltipItem(name, balance) {
    return `
        <div class="cash-in-hand-tooltip-item">
            <span class="cash-in-hand-tooltip-name">${escapeHtml(name)}</span>
            <span class="cash-in-hand-tooltip-balance">Rs ${formatMoney(balance)}</span>
        </div>
    `;
}

function updateCashInHandTooltip(physicalCashInHand) {
    const tooltipEl = document.getElementById('cashInHandTooltip');
    if (!tooltipEl) return;

    const bankItemsHtml = bankLedgerBalances.length
        ? bankLedgerBalances.map(item => cashInHandTooltipItem(item.name, item.balance)).join('')
        : '<div class="cash-in-hand-tooltip-empty">No ledgers included</div>';
    const bankTotal = bankLedgerBalances.reduce((sum, item) => sum + item.balance, 0);
    const grandTotal = physicalCashInHand + bankTotal;

    tooltipEl.innerHTML = `
        <div class="cash-in-hand-tooltip-section">
            <div class="cash-in-hand-tooltip-header">Cash in Hand:</div>
            ${cashInHandTooltipItem(cashSideLabel(), physicalCashInHand)}
        </div>
        <div class="cash-in-hand-tooltip-section">
            <div class="cash-in-hand-tooltip-header">Cash in Bank Ledgers:</div>
            ${bankItemsHtml}
        </div>
        <div class="cash-in-hand-tooltip-footer">
            <span class="cash-in-hand-tooltip-total-label">Total:</span>
            <span class="cash-in-hand-tooltip-total">Rs ${formatMoney(grandTotal)}</span>
        </div>
    `;
}

// System ledgers (Cash, Orders, Inventory, …) are created with the organization
// and are never assigned by a client, so there is nothing to pick — just a note
// saying why this one can't be deleted. Tax on Purchases is the exception: it is
// created by the first bill that carries tax, not up front.
const SYSTEM_LEDGER_LABELS = {
    cash: 'Cash',
    opening_balance_equity: 'Opening Balance Equity',
    orders: 'Orders',
    inventory: 'Inventory',
    tax_on_purchases: 'Tax on Purchases',
};

function renderLedgerSystemNotice(ledger) {
    const el = document.getElementById('editLedgerSystemNotice');
    if (!el) return;
    const role = ledger && ledger.system_key;
    if (!role) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = '';
    el.textContent = `System account (${SYSTEM_LEDGER_LABELS[role] || role}) — used by the app, so it can't be deleted.`;
}

// Ledgers that are bookkeeping plumbing rather than accounts a user reasons
// about day-to-day. Kept out of the type-grouped sections so they don't sit
// at equal weight next to Sales, Rent, etc. Only OBE for now.
const SECTIONED_SYSTEM_KEYS = ['opening_balance_equity'];

function ledgerSectionHtml(title, sectionLedgers) {
    return `
        <div class="ledger-section">
            <h3 class="ledger-section-header">${escapeHtml(title)}</h3>
            <div class="ledger-section-cards">
                ${sectionLedgers.map(l => `
                    <div class="ledger-card" data-id="${l.id}">
                        <div class="ledger-card-info">
                            <span class="ledger-card-name">${escapeHtml(l.name)}</span>
                        </div>
                        <div class="ledger-card-actions">
                            <button type="button" class="ledger-edit-btn" data-id="${l.id}" title="Edit ledger" aria-label="Edit ledger"><img src="assets/edit.png" alt="Edit" class="ledger-edit-icon"></button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function renderLedgerCards() {
    const container = document.getElementById('ledgerCards');
    if (!container) return;

    if (ledgers.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No ledgers yet. Click "Create Ledger" to add one.</p>';
        return;
    }

    const systemLedgers = ledgers.filter(l => SECTIONED_SYSTEM_KEYS.includes(l.system_key));
    const regularLedgers = ledgers.filter(l => !SECTIONED_SYSTEM_KEYS.includes(l.system_key));

    // Group ledgers by type
    const groupedLedgers = {};
    regularLedgers.forEach(l => {
        const type = l.type || 'Uncategorized';
        if (!groupedLedgers[type]) {
            groupedLedgers[type] = [];
        }
        groupedLedgers[type].push(l);
    });

    // Sort types alphabetically
    const sortedTypes = Object.keys(groupedLedgers).sort((a, b) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return a.localeCompare(b);
    });

    // Build HTML grouped by type, then the System section last
    let html = sortedTypes.map(type => ledgerSectionHtml(type, groupedLedgers[type])).join('');
    if (systemLedgers.length) {
        html += ledgerSectionHtml('System', systemLedgers);
    }

    container.innerHTML = html;

    // Click on card (not the edit button) opens detail
    container.querySelectorAll('.ledger-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.ledger-edit-btn')) return;
            const id = card.dataset.id;
            openLedgerDetail(id);
        });
    });

    // Edit buttons
    container.querySelectorAll('.ledger-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            openEditLedgerModal(id);
        });
    });
}

// Party details (Phase 2). A supplier is a ledger rather than a separate
// contact, so these live on the ledger form; they stay empty on ordinary
// accounts like Rent or Sales.
const LEDGER_PARTY_FIELDS = [
    ['IsParty', 'is_party', 'checkbox'],
    ['TaxNumber', 'tax_number', 'text'],
    ['PaymentTerms', 'payment_terms_days', 'number'],
    ['Phone', 'phone', 'text'],
    ['Email', 'email', 'text'],
    ['Address', 'address', 'text'],
];

function readLedgerPartyFields(prefix) {
    const body = {};
    LEDGER_PARTY_FIELDS.forEach(([suffix, key, kind]) => {
        const el = document.getElementById(`${prefix}Ledger${suffix}`);
        if (!el) return;
        if (kind === 'checkbox') {
            body[key] = el.checked;
        } else if (kind === 'number') {
            const value = parseInt(el.value, 10);
            body[key] = Number.isNaN(value) ? null : value;
        } else {
            body[key] = el.value.trim() || null;
        }
    });
    return body;
}

function fillLedgerPartyFields(prefix, ledger) {
    LEDGER_PARTY_FIELDS.forEach(([suffix, key, kind]) => {
        const el = document.getElementById(`${prefix}Ledger${suffix}`);
        if (!el) return;
        if (kind === 'checkbox') el.checked = !!(ledger && ledger[key]);
        else el.value = (ledger && ledger[key] != null) ? ledger[key] : '';
    });
}

let createLedgerOnCreateCallback = null;

async function createLedger(name, type, includeInCashInHand, openingBalance, reportCategory, partyFields) {
    if (findLedgerByName(name)) {
        showToast('A ledger with this name already exists', 'error');
        return;
    }
    try {
        const created = await apiJson('/ledgers/', {
            method: 'POST',
            body: {
                name,
                type,
                include_in_cash_in_hand: !!includeInCashInHand,
                opening_balance: openingBalance || 0,
                report_category: reportCategory || null,
                ...(partyFields || {})
            },
            fallback: 'Failed to create ledger'
        });
        const onCreated = createLedgerOnCreateCallback;
        showToast('Ledger created', 'success');
        closeCreateLedgerModal();
        await loadLedgers();
        if (onCreated) onCreated(created);
    } catch (error) {
        console.error('Error creating ledger:', error);
        showToast(error.message || 'Failed to create ledger', 'error');
    }
}

function openCreateLedgerModal(onCreated) {
    createLedgerOnCreateCallback = typeof onCreated === 'function' ? onCreated : null;
    document.getElementById('createLedgerName').value = '';
    document.getElementById('createLedgerType').value = '';
    document.getElementById('createLedgerOpeningBalance').value = '';
    document.getElementById('createLedgerReportCategory').value = '';
    document.getElementById('createLedgerCashInHand').checked = false;
    fillLedgerPartyFields('create', null);
    document.getElementById('createLedgerModal').classList.add('active');
}

function closeCreateLedgerModal() {
    document.getElementById('createLedgerModal').classList.remove('active');
    createLedgerOnCreateCallback = null;
}

let editLedgerId = null;
let editLedgerHasEntries = false;
let editLedgerIsSystem = false;
let editLedgerOriginalOpeningBalance = 0;

async function openEditLedgerModal(ledgerId) {
    if (!ledgerId) return;
    editLedgerId = ledgerId;
    try {
        const ledger = await apiJson(`/ledgers/${ledgerId}`, { fallback: 'Failed to load ledger' });
        editLedgerHasEntries = !!ledger.has_entries;

        const nameInput = document.getElementById('editLedgerName');
        const typeSelect = document.getElementById('editLedgerType');
        if (nameInput) {
            nameInput.value = ledger.name || '';
            nameInput.removeAttribute('readonly');
            nameInput.removeAttribute('disabled');
        }
        if (typeSelect) typeSelect.value = ledger.type || '';
        editLedgerOriginalOpeningBalance = parseFloat(ledger.opening_balance) || 0;
        const openingBalanceInput = document.getElementById('editLedgerOpeningBalance');
        if (openingBalanceInput) {
            openingBalanceInput.value = editLedgerOriginalOpeningBalance || '';
        }
        const cashInHandCheckbox = document.getElementById('editLedgerCashInHand');
        if (cashInHandCheckbox) cashInHandCheckbox.checked = !!ledger.include_in_cash_in_hand;
        const reportCategorySelect = document.getElementById('editLedgerReportCategory');
        if (reportCategorySelect) reportCategorySelect.value = ledger.report_category || '';
        renderLedgerSystemNotice(ledger);
        fillLedgerPartyFields('edit', ledger);

        editLedgerIsSystem = !!ledger.system_key;
        const cannotDelete = editLedgerHasEntries || editLedgerIsSystem;
        const deleteBtn = document.getElementById('editLedgerDeleteBtn');
        const deleteWrap = document.getElementById('editLedgerDeleteWrap');
        if (deleteBtn) {
            deleteBtn.disabled = cannotDelete;
            deleteBtn.classList.toggle('ledger-edit-delete-btn-has-entries', cannotDelete);
        }
        if (deleteWrap) {
            deleteWrap.title = editLedgerIsSystem
                ? 'Cannot delete: system account'
                : (editLedgerHasEntries ? 'Cannot delete: ledger has entries' : 'Delete ledger (no entries)');
        }

        document.getElementById('editLedgerModal').classList.add('active');
        setTimeout(() => { if (nameInput) nameInput.focus(); }, 50);
    } catch (error) {
        console.error('Error opening edit ledger:', error);
        showToast('Failed to load ledger', 'error');
    }
}

function closeEditLedgerModal() {
    document.getElementById('editLedgerModal').classList.remove('active');
    editLedgerId = null;
}

async function saveEditLedger() {
    if (!editLedgerId) return;
    const name = (document.getElementById('editLedgerName').value || '').trim();
    const type = (document.getElementById('editLedgerType').value || '').trim();
    const includeInCashInHand = document.getElementById('editLedgerCashInHand').checked;
    const openingBalance = parseFloat(document.getElementById('editLedgerOpeningBalance').value) || 0;
    const reportCategory = document.getElementById('editLedgerReportCategory').value;
    if (!name || !type) {
        showToast('Name and type are required', 'error');
        return;
    }
    const existing = findLedgerByName(name);
    if (existing && existing.id !== editLedgerId) {
        showToast('A ledger with this name already exists', 'error');
        return;
    }
    const confirmed = await showAppConfirm({ title: 'Update Ledger', message: 'Are you sure you want to update this ledger?', confirmText: 'Save' });
    if (!confirmed) return;
    const body = {
        name, type,
        include_in_cash_in_hand: includeInCashInHand,
        report_category: reportCategory || null,
        ...readLedgerPartyFields('edit'),
    };
    if (openingBalance !== editLedgerOriginalOpeningBalance) body.opening_balance = openingBalance;
    try {
        await apiJson(`/ledgers/${editLedgerId}`, {
            method: 'PUT',
            body,
            fallback: 'Failed to update ledger'
        });
        showToast('Ledger updated', 'success');
        closeEditLedgerModal();
        await loadLedgers();
    } catch (error) {
        console.error('Error updating ledger:', error);
        showToast(error.message || 'Failed to update ledger', 'error');
    }
}

async function deleteLedgerFromEditModal() {
    if (!editLedgerId) return;
    if (editLedgerHasEntries || editLedgerIsSystem) return;
    const confirmed = await showAppConfirm({ title: 'Delete Ledger', message: 'Are you sure you want to delete this ledger? This cannot be undone.', confirmText: 'Delete', danger: true });
    if (!confirmed) return;
    try {
        await apiRequest(`/ledgers/${editLedgerId}`, { method: 'DELETE', fallback: 'Failed to delete ledger' });
        showToast('Ledger deleted', 'success');
        closeEditLedgerModal();
        await loadLedgers();
    } catch (error) {
        console.error('Error deleting ledger:', error);
        showToast('Failed to delete ledger', 'error');
    }
}

async function deleteLedger(ledgerId) {
    if (!ledgerId) return;
    if (!confirm('Are you sure you want to delete this ledger? This cannot be undone.')) return;
    try {
        await apiRequest(`/ledgers/${ledgerId}`, { method: 'DELETE', fallback: 'Failed to delete ledger' });
        showToast('Ledger deleted', 'success');
        await loadLedgers();
    } catch (error) {
        console.error('Error deleting ledger:', error);
        showToast('Failed to delete ledger', 'error');
    }
}

async function openLedgerDetail(ledgerId) {
    try {
        currentLedger = await apiJson(`/ledgers/${ledgerId}`, { fallback: 'Failed to load ledger' });
    } catch (error) {
        console.error('Error loading ledger:', error);
        showToast('Failed to load ledger', 'error');
        return;
    }

    document.getElementById('ledgerDetailName').textContent = currentLedger.name;
    switchView('ledgerDetail');
    await loadLedgerEntries(ledgerId);
}

async function loadLedgerEntries(ledgerId) {
    if (!ledgerId) ledgerId = currentLedger?.id;
    if (!ledgerId) return;

    if (ledgerDetailGridApi) ledgerDetailGridApi.showLoadingOverlay();
    try {
        ledgerEntries = (await apiJson(`/ledgers/${ledgerId}/entries`, { fallback: 'Failed to load ledger entries' })).map(e => ({
            ...e,
            entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : ''
        }));
    } catch (error) {
        console.error('Error loading ledger entries:', error);
        showToast('Failed to load ledger entries', 'error');
        ledgerEntries = [];
    } finally {
        if (ledgerDetailGridApi) ledgerDetailGridApi.hideOverlay();
    }

    renderLedgerDetailGrid();
}

function renderLedgerDetailGrid() {
    if (!ledgerDetailGridApi) return;

    // New Balance = Previous Balance + Debit - Credit, the same for every ledger
    // regardless of Nature (see recalc_ledger_balance in supabase_schema.sql).
    //
    // No synthetic opening-balance row: since Phase 1 the opening balance is a
    // real journal line posted against Opening Balance Equity, so it arrives in
    // the statement like any other row and adding one here would double it.
    // The rows are already ordered by the get_ledger_statement RPC, which breaks
    // same-date ties by posting time so the running balance is stable.
    let running = 0;
    const rowsWithBalance = ledgerEntries.map(entry => {
        const debit = parseFloat(entry.debit) || 0;
        const credit = parseFloat(entry.credit) || 0;
        running += debit - credit;
        return {
            ...entry,
            debit: debit,
            credit: credit,
            balance: running
        };
    });

    // Read-only: every row is a posted journal line, corrected by posting again
    // rather than by editing history in place. Display is most-recent-first,
    // but the running balance above must stay computed in chronological order.
    ledgerDetailGridApi.setGridOption('rowData', rowsWithBalance.slice().reverse());
    // The Balance column's cellStyle also depends on currentLedger.type, which AG
    // Grid can't see as a dependency. With getRowId in play, setting rowData updates
    // matching rows in place rather than rebuilding them, so cellStyle isn't guaranteed to
    // re-run just from the row data change — force it.
    ledgerDetailGridApi.refreshCells({ force: true });
}

function initLedgerModals() {
    document.getElementById('createLedgerBtn')?.addEventListener('click', () => openCreateLedgerModal());

    const createLedgerForm = document.getElementById('createLedgerForm');
    if (createLedgerForm) {
        createLedgerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!isEditingAllowed()) {
                showToast('Editing is locked', 'error');
                return;
            }
            const name = document.getElementById('createLedgerName').value.trim();
            const type = document.getElementById('createLedgerType').value;
            const includeInCashInHand = document.getElementById('createLedgerCashInHand').checked;
            const openingBalance = parseFloat(document.getElementById('createLedgerOpeningBalance').value) || 0;
            const reportCategory = document.getElementById('createLedgerReportCategory').value;
            if (!name) {
                showToast('Enter a ledger name', 'error');
                return;
            }
            if (!type) {
                showToast('Select a type', 'error');
                return;
            }
            createLedger(name, type, includeInCashInHand, openingBalance, reportCategory,
                readLedgerPartyFields('create'));
        });
    }
    document.getElementById('closeCreateLedgerModal')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerCancelBtn')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'createLedgerModal') closeCreateLedgerModal();
    });

    document.getElementById('closeEditLedgerModal')?.addEventListener('click', closeEditLedgerModal);
    document.getElementById('editLedgerCancelBtn')?.addEventListener('click', closeEditLedgerModal);
    document.getElementById('editLedgerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'editLedgerModal') closeEditLedgerModal();
    });
    document.querySelector('#editLedgerModal .modal-content')?.addEventListener('click', (e) => e.stopPropagation());
    const editLedgerForm = document.getElementById('editLedgerForm');
    if (editLedgerForm) {
        editLedgerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!isEditingAllowed()) {
                showToast('Editing is locked', 'error');
                return;
            }
            saveEditLedger();
        });
    }
    document.getElementById('editLedgerDeleteBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!isEditingAllowed()) {
            showToast('Editing is locked', 'error');
            return;
        }
        deleteLedgerFromEditModal();
    });

    document.getElementById('ledgerBackBtn')?.addEventListener('click', () => {
        switchView('ledgers');
    });
}

function initLedgerDetailGrid() {
    const gridDiv = document.getElementById('ledgerDetailGrid');
    if (!gridDiv) return;

    // Ledger detail grid is now read-only - entries come from transactions
    const columnDefs = [
        {
            headerName: 'Date',
            field: 'entry_date',
            width: 130,
            editable: false,
            valueFormatter: (params) => (params.value ? formatDateDDMMYYYY(params.value) : ''),
        },
        {
            headerName: 'Particulars',
            field: 'particulars',
            flex: 2,
            editable: false,
        },
        {
            headerName: 'Type',
            field: 'voucher_type',
            width: 110,
            editable: false,
            // What put this line on the account: a transaction entry, a purchase
            // bill, the opening balance, or a hand-written journal entry.
            valueFormatter: (params) => LEDGER_VOUCHER_LABELS[params.value] || params.value || '',
        },
        {
            headerName: 'Debit (Rs)',
            field: 'debit',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatTransactionCell(params.value),
        },
        {
            headerName: 'Credit (Rs)',
            field: 'credit',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatTransactionCell(params.value),
        },
        {
            headerName: 'Balance (Rs)',
            field: 'balance',
            width: 160,
            editable: false,
            valueFormatter: (params) => (params.value === '' || params.value == null
                ? ''
                : formatBalanceWithSide(params.value)),
            cellStyle: (params) => {
                const val = parseFloat(params.value);
                // Always return an explicit color (never {}) — AG Grid doesn't reliably
                // clear a previously-applied inline color from an empty style object,
                // which left cells stuck red after switching from a negative-balance
                // ledger back to a positive one.
                if (Number.isNaN(val) || val === 0) return { color: 'var(--text-primary)' };
                // The Dr/Cr suffix already carries the side, so red means "on the wrong
                // side for this Nature", not "negative" — a Credit-normal ledger showing
                // Dr is the abnormal case, and vice versa.
                const isBad = CREDIT_NORMAL_TYPES.includes(currentLedger?.type) ? val > 0 : val < 0;
                return { color: isBad ? 'var(--danger)' : 'var(--text-primary)' };
            }
        }
    ];

    const gridOptions = {
        columnDefs,
        rowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.id,
        onGridReady: (params) => {
            ledgerDetailGridApi = params.api;
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

// NOTE: Ledger entries are now read-only and derived from transaction entries.
// The CRUD operations for ledger entries have been removed.
// To add/edit/delete ledger entries, use Transactions with the appropriate folio.

const SHOPIFY_PRODUCT_SYNC_STORAGE_KEY = 'lushwear_last_shopify_product_sync';

function updateLastSyncLabel(labelId, storageKey) {
    const label = document.getElementById(labelId);
    if (!label) return;
    const raw = localStorage.getItem(storageKey);
    const timestamp = raw ? parseInt(raw, 10) : NaN;
    label.textContent = isNaN(timestamp) ? '' : `Synced ${formatRelativeTime(timestamp)}`;
}

function updateSyncShopifyLastSyncLabel() {
    updateLastSyncLabel('syncShopifyLastSync', SHOPIFY_PRODUCT_SYNC_STORAGE_KEY);
}

// Orders' last-sync time comes from the server (sync_status table), not localStorage - keeps
// it consistent across tabs/devices instead of resetting whenever a browser's storage is cleared.
function updateSyncOrdersLastSyncLabel() {
    const label = document.getElementById('syncOrdersLastSync');
    if (!label) return;
    label.textContent = lastOrdersSyncAt ? `Synced with Shopify ${formatRelativeTime(lastOrdersSyncAt)}` : '';
}

setInterval(() => {
    updateSyncShopifyLastSyncLabel();
    updateSyncOrdersLastSyncLabel();
}, 30000);

async function syncShopifyProducts() {
    const btn = document.getElementById('syncShopifyBtn');
    const labelEl = document.getElementById('syncShopifyBtnLabel');

    btn.disabled = true;
    labelEl.textContent = 'Syncing...';

    try {
        const result = await apiJson('/products/sync-shopify', {
            method: 'POST',
            fallback: 'Failed to sync products from Shopify'
        });
        const productsInfo = result.products || {};
        const variantsInfo = result.variants || {};
        showToast(
            `Sync complete! Products: ${productsInfo.created || 0} created, ${productsInfo.updated || 0} updated. Variants: ${variantsInfo.created || 0} created, ${variantsInfo.updated || 0} updated.`,
            'success'
        );

        localStorage.setItem(SHOPIFY_PRODUCT_SYNC_STORAGE_KEY, Date.now().toString());
        updateSyncShopifyLastSyncLabel();
        loadProducts();
    } catch (error) {
        console.error('Error syncing Shopify products:', error);
        showToast(error.message || 'Failed to sync products from Shopify', 'error');
    } finally {
        btn.disabled = false;
        labelEl.textContent = 'Sync from Shopify';
    }
}

// Orders sync automatically (see initOrdersAutoSync/scheduleOrdersAutoSync below) - there's
// no manual button, just the "Synced X ago" status text. The backend locks around the actual
// sync (sync_status.in_progress), so if another tab/device (or the auto-sync timer) is already
// syncing, this gets result.already_syncing back instead of racing it.
async function syncShopifyOrders() {
    const labelEl = document.getElementById('syncOrdersLastSync');
    if (labelEl) labelEl.textContent = 'Syncing with Shopify...';

    try {
        const result = await apiJson('/orders/sync-shopify', {
            method: 'POST',
            fallback: 'Failed to sync orders from Shopify'
        });
        if (result.already_syncing) {
            showToast(result.message || 'Sync already in progress', 'info');
        } else {
            showToast(
                `Sync complete! ${result.synced} orders synced (${result.created} created, ${result.updated} updated)`,
                'success'
            );
            await refreshOrdersView();
        }
        if (result.last_synced_at) {
            lastOrdersSyncAt = new Date(result.last_synced_at).getTime();
        }
    } catch (error) {
        console.error('Error syncing Shopify orders:', error);
        showToast(error.message || 'Failed to sync orders from Shopify', 'error');
    } finally {
        // Always restore the status text (covers the already-syncing/failed cases too, where
        // there's no fresh last_synced_at to report) and reschedule so the loop continues.
        updateSyncOrdersLastSyncLabel();
        scheduleOrdersAutoSync();
    }
}

/** Fetches the server's last-sync time on startup and schedules the first auto-sync relative
 *  to it (rather than always syncing immediately), so multiple tabs/devices don't each force
 *  a fresh sync on load when another one already ran recently. */
async function initOrdersAutoSync() {
    try {
        const status = await apiJson('/orders/sync-status', { fallback: 'Failed to fetch sync status' });
        if (status.last_synced_at) {
            lastOrdersSyncAt = new Date(status.last_synced_at).getTime();
            updateSyncOrdersLastSyncLabel();
        }
    } catch (error) {
        console.error('Error fetching orders sync status:', error);
    }

    const elapsed = lastOrdersSyncAt ? Date.now() - lastOrdersSyncAt : Infinity;
    if (elapsed >= ORDERS_AUTO_SYNC_INTERVAL_MS) {
        await syncShopifyOrders();
    } else {
        scheduleOrdersAutoSync(ORDERS_AUTO_SYNC_INTERVAL_MS - elapsed);
    }
}

function scheduleOrdersAutoSync(delayMs = ORDERS_AUTO_SYNC_INTERVAL_MS) {
    if (ordersAutoSyncTimerId != null) {
        clearTimeout(ordersAutoSyncTimerId);
        ordersAutoSyncTimerId = null;
    }
    ordersAutoSyncTimerId = setTimeout(async () => {
        ordersAutoSyncTimerId = null;
        await syncShopifyOrders();
    }, delayMs);
}

async function uploadPostExCsv(file, assignmentNumber) {
    const btn = document.getElementById('uploadPostExModalUpload');
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Uploading...';
    }
    try {
        const formData = new FormData();
        formData.append('file', file);
        if (assignmentNumber != null && String(assignmentNumber).trim() !== '') {
            formData.append('assignment_number', String(assignmentNumber).trim());
        }
        const response = await fetch(`${API_BASE}/orders/upload-postex-csv`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = Array.isArray(data.detail) ? data.detail.map(d => d.msg || d).join(' ') : data.detail;
            throw new Error(detail || response.statusText || 'Upload failed');
        }
        showToast(data.message || `Updated ${data.updated || 0} order(s).`, 'success');
        closeUploadPostExModal();

        // Show popup if any orders have receivable != CSV NET_AMOUNT
        const mismatches = data.amount_mismatches || [];
        if (mismatches.length > 0) {
            showPostExAmountMismatchesModal(mismatches);
        }
        
        // CSV may contain orders from multiple periods; we have all orders in the grid (period filter may hide some).
        // Select all rows in the current view that were updated by the CSV.
        const updatedOrderIds = data.updated_order_ids || [];
        const matchedOrderNumbers = new Set((data.matched_order_numbers || []).map(String));
        
        await loadOrders();
        
        if (ordersGridApi && (updatedOrderIds.length > 0 || matchedOrderNumbers.size > 0)) {
            setTimeout(() => {
                if (ordersGridApi) {
                    ordersGridApi.deselectAll();
                    ordersGridApi.forEachNode(node => {
                        const data = node.data;
                        if (!data || data.id === '__footer__') return;
                        if (updatedOrderIds.includes(data.id) || matchedOrderNumbers.has(String(data.order_number))) {
                            node.setSelected(true);
                        }
                    });
                    const selectedRows = ordersGridApi.getSelectedRows();
                    if (selectedRows.length > 0) {
                        ordersGridApi.ensureNodeVisible(selectedRows[0], 'middle');
                    }
                    if (typeof updateFooterRow === 'function') updateFooterRow();
                }
            }, 100);
        }
    } catch (error) {
        console.error('Error uploading PostEx CSV', error);
        showToast(error.message || 'Failed to upload PostEx CSV', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

function openUploadPostExModal() {
    const modal = document.getElementById('uploadPostExModal');
    const fileInput = document.getElementById('uploadPostExFileInput');
    const fileNameEl = document.getElementById('uploadPostExFileName');
    const assignmentInput = document.getElementById('uploadPostExAssignmentNumber');
    if (fileInput) {
        fileInput.value = '';
        if (fileNameEl) fileNameEl.textContent = 'No file chosen';
    }
    if (assignmentInput) assignmentInput.value = '';
    if (modal) modal.classList.add('active');
}

function closeUploadPostExModal() {
    const modal = document.getElementById('uploadPostExModal');
    if (modal) modal.classList.remove('active');
}

