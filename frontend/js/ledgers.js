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

// Applies balance(s) returned by a cashbook entry write (see ledger_balances
// in supabase_schema.sql / CashbookEntry.ledger_balances) to the in-memory
// `ledgers` array, so updateCashInHand() reflects the write with no extra fetch.
function applyLedgerBalancePatches(patches) {
    if (!patches) return;
    (Array.isArray(patches) ? patches : [patches]).forEach(p => {
        if (!p || !p.ledger_id) return;
        const ledger = ledgers.find(l => l.id === p.ledger_id);
        if (ledger) ledger.balance = p.balance;
    });
}

function formatMoney(value) {
    return (parseFloat(value) || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// Physical cash in hand = the last day's net cash movement (closing - opening balance),
// i.e. cash taken in that hasn't been deposited to a bank ledger yet.
function getPhysicalCashInHand() {
    if (!cashbookDailyBalance) return 0;
    const closing = parseFloat(cashbookDailyBalance.closing_balance) || 0;
    const opening = parseFloat(cashbookDailyBalance.opening_balance) || 0;
    return closing - opening;
}

// Bank-ledger part is computed from the in-memory `ledgers` array (kept in sync by
// loadLedgersList() on cold loads and applyLedgerBalancePatches() on every cashbook
// write); the physical part reads the already-loaded `cashbookDailyBalance` — neither
// needs an extra network call here.
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
            ${cashInHandTooltipItem('Cash', physicalCashInHand)}
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

function renderLedgerCards() {
    const container = document.getElementById('ledgerCards');
    if (!container) return;

    if (ledgers.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No ledgers yet. Click "Create Ledger" to add one.</p>';
        return;
    }

    // Group ledgers by type
    const groupedLedgers = {};
    ledgers.forEach(l => {
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

    // Build HTML grouped by type
    let html = '';
    sortedTypes.forEach(type => {
        const typeLedgers = groupedLedgers[type];
        html += `
            <div class="ledger-section">
                <h3 class="ledger-section-header">${escapeHtml(type)}</h3>
                <div class="ledger-section-cards">
                    ${typeLedgers.map(l => `
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
    });

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

// Opening balance is stored signed in the same incoming-outgoing convention as
// ledger_balances: positive = incoming (Credit), negative = outgoing (Debit).
function openingBalanceToSigned(amount, side) {
    const magnitude = Math.abs(parseFloat(amount)) || 0;
    if (!magnitude) return 0;
    return side === 'debit' ? -magnitude : magnitude;
}

function signedToOpeningBalanceSide(signedValue) {
    return signedValue > 0 ? 'credit' : 'debit';
}

let createLedgerOnCreateCallback = null;

async function createLedger(name, type, includeInCashInHand, openingBalance) {
    if (findLedgerByName(name)) {
        showToast('A ledger with this name already exists', 'error');
        return;
    }
    try {
        const created = await apiJson('/ledgers/', {
            method: 'POST',
            body: { name, type, include_in_cash_in_hand: !!includeInCashInHand, opening_balance: openingBalance || 0 },
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
    document.getElementById('createLedgerOpeningBalanceAmount').value = '';
    document.getElementById('createLedgerOpeningBalanceSide').value = 'debit';
    document.getElementById('createLedgerCashInHand').checked = false;
    document.getElementById('createLedgerModal').classList.add('active');
}

function closeCreateLedgerModal() {
    document.getElementById('createLedgerModal').classList.remove('active');
    createLedgerOnCreateCallback = null;
}

let editLedgerId = null;
let editLedgerHasEntries = false;
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
        const openingBalanceAmountInput = document.getElementById('editLedgerOpeningBalanceAmount');
        const openingBalanceSideSelect = document.getElementById('editLedgerOpeningBalanceSide');
        if (openingBalanceAmountInput) {
            openingBalanceAmountInput.value = editLedgerOriginalOpeningBalance ? Math.abs(editLedgerOriginalOpeningBalance) : '';
        }
        if (openingBalanceSideSelect) {
            openingBalanceSideSelect.value = signedToOpeningBalanceSide(editLedgerOriginalOpeningBalance);
        }
        const cashInHandCheckbox = document.getElementById('editLedgerCashInHand');
        if (cashInHandCheckbox) cashInHandCheckbox.checked = !!ledger.include_in_cash_in_hand;

        const deleteBtn = document.getElementById('editLedgerDeleteBtn');
        const deleteWrap = document.getElementById('editLedgerDeleteWrap');
        if (deleteBtn) {
            deleteBtn.disabled = editLedgerHasEntries;
            deleteBtn.classList.toggle('ledger-edit-delete-btn-has-entries', editLedgerHasEntries);
        }
        if (deleteWrap) {
            deleteWrap.title = editLedgerHasEntries ? 'Cannot delete: ledger has entries' : 'Delete ledger (no entries)';
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
    const openingBalanceAmount = document.getElementById('editLedgerOpeningBalanceAmount').value;
    const openingBalanceSide = document.getElementById('editLedgerOpeningBalanceSide').value;
    const openingBalance = openingBalanceToSigned(openingBalanceAmount, openingBalanceSide);
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
    const body = { name, type, include_in_cash_in_hand: includeInCashInHand };
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
    if (editLedgerHasEntries) return;
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

    // Compute running balance
    const sorted = [...ledgerEntries].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });

    // opening_balance is stored signed in the same incoming-outgoing convention as
    // ledger_balances: positive = incoming (Credit), negative = outgoing (Debit).
    const openingBalance = parseFloat(currentLedger?.opening_balance) || 0;
    const openingRow = openingBalance ? [{
        id: 'opening-balance',
        entry_date: '',
        particulars: 'Opening Balance',
        incoming: openingBalance > 0 ? openingBalance : 0,
        outgoing: openingBalance < 0 ? -openingBalance : 0,
    }] : [];

    let running = 0;
    const rowsWithBalance = [...openingRow, ...sorted].map(entry => {
        const incoming = parseFloat(entry.incoming) || 0;
        const outgoing = parseFloat(entry.outgoing) || 0;
        running += incoming - outgoing;
        return {
            ...entry,
            incoming: incoming,
            outgoing: outgoing,
            balance: running
        };
    });

    // Ledger entries are now read-only (derived from cashbook entries)
    ledgerDetailGridApi.setGridOption('rowData', rowsWithBalance);
}

function initLedgerDetailGrid() {
    const gridDiv = document.getElementById('ledgerDetailGrid');
    if (!gridDiv) return;

    // Ledger detail grid is now read-only - entries come from cashbook
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
            headerName: 'Debit (Rs)',
            field: 'outgoing',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
        },
        {
            headerName: 'Credit (Rs)',
            field: 'incoming',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
        },
        {
            headerName: 'Balance (Rs)',
            field: 'balance',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
            cellStyle: (params) => {
                const val = parseFloat(params.value);
                if (Number.isNaN(val)) return {};
                if (val < 0) return { color: 'var(--danger)' };
                return {};
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

// NOTE: Ledger entries are now read-only and derived from cashbook entries.
// The CRUD operations for ledger entries have been removed.
// To add/edit/delete ledger entries, use the Cashbook with the appropriate folio.

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
    label.textContent = lastOrdersSyncAt ? `Synced ${formatRelativeTime(lastOrdersSyncAt)}` : '';
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
    if (labelEl) labelEl.textContent = 'Syncing...';

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

