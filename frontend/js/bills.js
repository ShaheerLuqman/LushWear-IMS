// Purchase bills (accounts payable). A supplier is a ledger, so the supplier
// picker lists party ledgers. Lines carry no account: a bill is always for
// stock and posts to Inventory.
//
// Payments are not recorded here — they are ordinary transaction entries against
// the supplier's ledger, made when the money actually moves. What each bill
// still owes is derived from that ledger balance, applied oldest-bill-first.

let billsGridApi = null;
let apAgeingGridApi = null;
let bills = [];
let apAgeingAsOf = null;
let editingBillId = null;
// Line rows live here while the modal is open rather than being read back out
// of the DOM on save, so a half-typed row can't silently become a zero line.
let billLineDrafts = [];
// A posted (non-draft) bill opens the same modal in read-only mode so it can
// still be reviewed — editing it would just bounce off the API's status guard.
let billModalReadOnly = false;

const BILL_STATUS_LABELS = {
    draft: 'Draft',
    cancelled: 'Cancelled',
    unpaid: 'Unpaid',
    partially_paid: 'Part paid',
    paid: 'Paid',
};

function partyLedgers() {
    // Falls back to Liability accounts for orgs that haven't marked parties yet,
    // so bills are usable before anyone edits their supplier ledgers.
    const parties = ledgers.filter(l => l.is_party);
    return parties.length ? parties : ledgers.filter(l => l.type === 'Liability');
}

function ledgerName(id) {
    const ledger = ledgers.find(l => l.id === id);
    return ledger ? ledger.name : '';
}

async function loadBills() {
    if (billsGridApi) billsGridApi.showLoadingOverlay();
    try {
        const status = document.getElementById('billsStatusFilter')?.value || '';
        bills = await apiJson(`/bills/${status ? `?status=${status}` : ''}`, {
            fallback: 'Failed to load bills'
        });
    } catch (error) {
        console.error('Error loading bills:', error);
        showToast('Failed to load bills', 'error');
        bills = [];
    }
    if (billsGridApi) {
        billsGridApi.setGridOption('rowData', bills);
        billsGridApi.hideOverlay();
    }
}

// --- Bill modal --------------------------------------------------------------

function emptyBillLine() {
    return {
        _key: `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        description: '',
        quantity: '',
        unit_cost: '',
    };
}

function billLineAmount(line) {
    const qty = parseFloat(line.quantity);
    const cost = parseFloat(line.unit_cost);
    if (Number.isNaN(qty) || Number.isNaN(cost)) return 0;
    return Math.round(qty * cost * 100) / 100;
}

function renderBillLines() {
    const container = document.getElementById('billLines');
    if (!container) return;

    const disabled = billModalReadOnly ? 'disabled' : '';
    container.innerHTML = billLineDrafts.map((line, index) => `
        <div class="bill-line" data-index="${index}">
            <input type="text" class="form-input bill-line-description" value="${escapeHtml(line.description || '')}" placeholder="e.g. Cotton fabric" ${disabled}>
            <input type="number" class="form-input bill-line-quantity" value="${line.quantity}" min="0" step="0.001" placeholder="0" ${disabled}>
            <input type="number" class="form-input bill-line-cost" value="${line.unit_cost}" min="0" step="0.01" placeholder="0.00" ${disabled}>
            <span class="bill-line-amount">${formatMoney(billLineAmount(line))}</span>
            ${billModalReadOnly ? '' : `<button type="button" class="bill-line-remove" data-index="${index}" aria-label="Remove line">&times;</button>`}
        </div>
    `).join('');

    if (billModalReadOnly) { renderBillTotals(); return; }

    container.querySelectorAll('.bill-line').forEach(row => {
        const index = parseInt(row.dataset.index, 10);
        const update = (field, value) => {
            billLineDrafts[index][field] = value;
            row.querySelector('.bill-line-amount').textContent =
                formatMoney(billLineAmount(billLineDrafts[index]));
            renderBillTotals();
        };
        row.querySelector('.bill-line-description').addEventListener('input', e => update('description', e.target.value));
        row.querySelector('.bill-line-quantity').addEventListener('input', e => update('quantity', e.target.value));
        row.querySelector('.bill-line-cost').addEventListener('input', e => update('unit_cost', e.target.value));
    });

    container.querySelectorAll('.bill-line-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            billLineDrafts.splice(parseInt(btn.dataset.index, 10), 1);
            if (!billLineDrafts.length) billLineDrafts.push(emptyBillLine());
            renderBillLines();
            renderBillTotals();
        });
    });

    renderBillTotals();
}

function renderBillTotals() {
    const subtotal = billLineDrafts.reduce((sum, line) => sum + billLineAmount(line), 0);
    const discount = parseFloat(document.getElementById('billDiscount')?.value) || 0;
    const tax = parseFloat(document.getElementById('billTax')?.value) || 0;
    const otherExpense = parseFloat(document.getElementById('billOtherExpense')?.value) || 0;
    const subtotalEl = document.getElementById('billSubtotal');
    const totalEl = document.getElementById('billTotal');
    if (subtotalEl) subtotalEl.textContent = formatMoney(subtotal);
    if (totalEl) totalEl.textContent = formatMoney(subtotal - discount + tax + otherExpense);
}

// Suppliers can carry payment terms; a new bill defaults its due date from them
// so the AP ageing buckets mean something without extra typing.
function applySupplierPaymentTerms() {
    const supplierId = document.getElementById('billSupplier')?.value;
    const billDate = document.getElementById('billDate')?.value;
    const dueDateEl = document.getElementById('billDueDate');
    if (!supplierId || !billDate || !dueDateEl || dueDateEl.dataset.touched === 'true') return;

    const supplier = ledgers.find(l => l.id === supplierId);
    const days = supplier && supplier.payment_terms_days;
    if (days == null) return;

    const due = new Date(billDate);
    due.setDate(due.getDate() + days);
    dueDateEl.value = due.toISOString().slice(0, 10);
}

async function openBillModal(billId) {
    editingBillId = billId || null;
    await loadLedgersList();

    const supplierSelect = document.getElementById('billSupplier');
    supplierSelect.innerHTML = '<option value="">Select supplier...</option>' +
        partyLedgers().map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');

    const dueDateEl = document.getElementById('billDueDate');
    dueDateEl.dataset.touched = 'false';

    let status = null;
    if (billId) {
        let bill;
        try {
            bill = await apiJson(`/bills/${billId}`, { fallback: 'Failed to load bill' });
        } catch (error) {
            console.error('Error loading bill:', error);
            showToast('Failed to load bill', 'error');
            return;
        }
        status = bill.status;
        billModalReadOnly = status !== 'draft';
        document.getElementById('billModalTitle').textContent =
            `${billModalReadOnly ? 'View' : 'Edit'} ${bill.bill_number}`;
        supplierSelect.value = bill.supplier_id;
        document.getElementById('billSupplierRef').value = bill.supplier_ref || '';
        document.getElementById('billDate').value = bill.bill_date;
        dueDateEl.value = bill.due_date || '';
        dueDateEl.dataset.touched = 'true';
        document.getElementById('billDiscount').value = bill.discount_amount || 0;
        document.getElementById('billTax').value = bill.tax_amount || 0;
        document.getElementById('billOtherExpense').value = bill.other_expense_amount || 0;
        document.getElementById('billNotes').value = bill.notes || '';
        billLineDrafts = (bill.items || []).map(item => ({
            _key: item.id,
            description: item.description || '',
            quantity: item.quantity,
            unit_cost: item.unit_cost,
        }));
    } else {
        billModalReadOnly = false;
        document.getElementById('billModalTitle').textContent = 'New Bill';
        document.getElementById('billForm').reset();
        document.getElementById('billDate').value = getTodayDateString();
        document.getElementById('billDiscount').value = 0;
        document.getElementById('billTax').value = 0;
        document.getElementById('billOtherExpense').value = 0;
        billLineDrafts = [emptyBillLine()];
    }
    if (!billLineDrafts.length) billLineDrafts = [emptyBillLine()];

    applyBillModalFooter(status);
    renderBillLines();
    document.getElementById('billModal').classList.add('active');
}

// Buttons shown depend on where the bill is in the draft -> received ->
// cancelled workflow; a new/draft bill is the only editable state.
function applyBillModalFooter(status) {
    const readOnly = billModalReadOnly;
    ['billSupplier', 'billSupplierRef', 'billDate', 'billDueDate', 'billDiscount', 'billTax', 'billOtherExpense', 'billNotes'].forEach(id => {
        document.getElementById(id).disabled = readOnly;
    });
    const addLineBtn = document.getElementById('addBillLineBtn');
    if (addLineBtn) addLineBtn.style.display = readOnly ? 'none' : '';
    const saveBtn = document.getElementById('billSaveBtn');
    if (saveBtn) saveBtn.style.display = readOnly ? 'none' : '';
    const confirmBtn = document.getElementById('billConfirmBtn');
    if (confirmBtn) confirmBtn.style.display = status === 'draft' ? '' : 'none';
    const revertBtn = document.getElementById('billRevertBtn');
    if (revertBtn) revertBtn.style.display = status === 'received' ? '' : 'none';
    const cancelBtn = document.getElementById('billCancelBtn');
    if (cancelBtn) cancelBtn.textContent = readOnly ? 'Close' : 'Cancel';
}

function closeBillModal() {
    document.getElementById('billModal').classList.remove('active');
    editingBillId = null;
    billLineDrafts = [];
    billModalReadOnly = false;
}

function collectBillPayload() {
    const supplierId = document.getElementById('billSupplier').value;
    const billDate = document.getElementById('billDate').value;
    if (!supplierId) { showToast('Select a supplier', 'error'); return null; }
    if (!billDate) { showToast('Enter a bill date', 'error'); return null; }

    // A blank trailing row is normal (the form always keeps one), so drop empties
    // rather than failing on them — but a row with only some fields filled is a
    // mistake worth surfacing.
    const filled = billLineDrafts.filter(l => l.quantity !== '' || l.unit_cost !== '' || l.description);
    const items = [];
    for (const line of filled) {
        const qty = parseFloat(line.quantity);
        const cost = parseFloat(line.unit_cost);
        if (Number.isNaN(qty) || qty <= 0 || Number.isNaN(cost) || cost < 0) {
            showToast('Every line needs a quantity above 0 and a unit cost', 'error');
            return null;
        }
        items.push({
            description: line.description || null,
            quantity: qty,
            unit_cost: cost,
        });
    }
    if (!items.length) { showToast('Add at least one line', 'error'); return null; }

    const dueDate = document.getElementById('billDueDate').value;
    return {
        supplier_id: supplierId,
        bill_date: billDate,
        due_date: dueDate || null,
        supplier_ref: document.getElementById('billSupplierRef').value.trim() || null,
        discount_amount: parseFloat(document.getElementById('billDiscount').value) || 0,
        tax_amount: parseFloat(document.getElementById('billTax').value) || 0,
        other_expense_amount: parseFloat(document.getElementById('billOtherExpense').value) || 0,
        notes: document.getElementById('billNotes').value.trim() || null,
        items,
    };
}

// Shared by the Save button and Confirm Bill (which must persist edits before
// posting them — otherwise a half-typed change would be silently dropped).
async function persistBillPayload(payload) {
    try {
        if (editingBillId) {
            await apiJson(`/bills/${editingBillId}`, { method: 'PUT', body: payload, fallback: 'Failed to update bill' });
        } else {
            await apiJson('/bills/', { method: 'POST', body: payload, fallback: 'Failed to create bill' });
        }
        return true;
    } catch (error) {
        console.error('Error saving bill:', error);
        showToast(error.message || 'Failed to save bill', 'error');
        return false;
    }
}

async function saveBill() {
    const payload = collectBillPayload();
    if (!payload) return;
    const wasNew = !editingBillId;
    if (!(await persistBillPayload(payload))) return;
    showToast(wasNew ? 'Draft bill created' : 'Bill updated', 'success');
    closeBillModal();
    await loadBills();
}

// --- Bill actions ------------------------------------------------------------

async function billAction(billId, action, { confirm } = {}) {
    if (confirm) {
        const ok = await showAppConfirm(confirm);
        if (!ok) return false;
    }
    try {
        await apiJson(`/bills/${billId}/${action}`, { method: 'POST', fallback: `Failed to ${action} bill` });
        await loadBills();
        return true;
    } catch (error) {
        console.error(`Error on bill ${action}:`, error);
        showToast(error.message || `Failed to ${action} bill`, 'error');
        return false;
    }
}

function receiveBill(billId) {
    return billAction(billId, 'receive', {
        title: 'Confirm Bill',
        message: 'This posts the bill to the accounts and adds its stock. Continue?',
        confirmText: 'Confirm',
    });
}

function unreceiveBill(billId) {
    return billAction(billId, 'unreceive', {
        title: 'Revert to Draft',
        message: 'This unposts the bill and removes the stock it added. Continue?',
        confirmText: 'Revert to draft',
    });
}

function cancelBill(billId) {
    return billAction(billId, 'cancel', {
        title: 'Cancel Bill',
        message: 'Cancel this bill? A received bill is unposted first.',
        confirmText: 'Cancel bill',
        danger: true,
    });
}

async function deleteBill(billId) {
    const ok = await showAppConfirm({
        title: 'Delete Draft',
        message: 'Delete this draft bill? This cannot be undone.',
        confirmText: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        await apiRequest(`/bills/${billId}`, { method: 'DELETE', fallback: 'Failed to delete bill' });
        showToast('Draft deleted', 'success');
        await loadBills();
    } catch (error) {
        console.error('Error deleting bill:', error);
        showToast(error.message || 'Failed to delete bill', 'error');
    }
}

// --- Grids -------------------------------------------------------------------

// Row actions menu (triple dot), mirroring createTransactionRowMenu in
// orders-grid.js: a menu scales to more actions without another column reshuffle.
function createBillRowMenu(params) {
    const bill = params.data;
    const wrapper = document.createElement('div');
    if (!bill || !bill.id) return wrapper;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bill-menu-btn';
    btn.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    btn.title = 'More actions';

    let menu = null;

    function closeMenu() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
        btn.classList.remove('open');
    }

    function addOption({ label, icon, danger, onClick }) {
        const option = document.createElement('div');
        option.className = 'folio-dropdown-option' + (danger ? ' bill-menu-option-danger' : '');
        option.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
        option.addEventListener('click', () => {
            closeMenu();
            onClick();
        });
        menu.appendChild(option);
    }

    function openMenu() {
        if (menu) return;
        btn.classList.add('open');

        menu = document.createElement('div');
        menu.className = 'folio-dropdown-panel bill-menu-panel';

        addOption({ label: 'View', icon: 'fa-eye', onClick: () => openBillModal(bill.id) });
        if (bill.status === 'draft') {
            addOption({ label: 'Confirm Bill', icon: 'fa-check', onClick: () => receiveBill(bill.id) });
            addOption({ label: 'Delete', icon: 'fa-trash', danger: true, onClick: () => deleteBill(bill.id) });
        } else if (bill.status === 'received') {
            // Revert to draft stays available even once partly settled: the
            // supplier's balance moves with the bill, so nothing is left dangling.
            addOption({ label: 'Revert to Draft', icon: 'fa-rotate-left', onClick: () => unreceiveBill(bill.id) });
            addOption({ label: 'Cancel', icon: 'fa-ban', danger: true, onClick: () => cancelBill(bill.id) });
        }

        document.body.appendChild(menu);
        const rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 2) + 'px';
        menu.style.left = Math.max(rect.right - menu.offsetWidth, 8) + 'px';

        const closeHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                closeMenu();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu) closeMenu();
        else openMenu();
    });

    wrapper.appendChild(btn);
    return wrapper;
}

function initBillsGrid() {
    const gridDiv = document.getElementById('billsGrid');
    if (!gridDiv) return;

    const columnDefs = [
        { headerName: 'Bill #', field: 'bill_number', flex: 12, minWidth: 110 },
        {
            headerName: 'Supplier',
            field: 'supplier_id',
            flex: 25,
            minWidth: 160,
            valueGetter: (params) => ledgerName(params.data?.supplier_id),
        },
        { headerName: 'Supplier ref', field: 'supplier_ref', flex: 12, minWidth: 120 },
        {
            headerName: 'Date',
            field: 'bill_date',
            flex: 10,
            minWidth: 100,
            valueFormatter: (params) => (params.value ? formatDateDDMMYYYY(params.value) : ''),
        },
        {
            headerName: 'Due',
            field: 'due_date',
            flex: 10,
            minWidth: 100,
            valueFormatter: (params) => (params.value ? formatDateDDMMYYYY(params.value) : ''),
            cellStyle: (params) => {
                const bill = params.data;
                if (!params.value || !bill || bill.status !== 'received' || bill.outstanding <= 0) {
                    return { color: 'var(--text-primary)' };
                }
                const overdue = params.value < getTodayDateString();
                return { color: overdue ? 'var(--danger)' : 'var(--text-primary)' };
            },
        },
        {
            headerName: 'Total (Rs)',
            field: 'total',
            flex: 11,
            minWidth: 110,
            type: 'rightAligned',
            cellClass: 'bill-amount-cell',
            valueFormatter: (params) => formatMoney(params.value),
        },
        {
            headerName: 'Outstanding (Rs)',
            field: 'outstanding',
            flex: 12,
            minWidth: 130,
            type: 'rightAligned',
            cellClass: 'bill-amount-cell',
            valueFormatter: (params) => formatMoney(params.value),
        },
        {
            headerName: 'Status',
            field: 'payment_status',
            flex: 11,
            minWidth: 110,
            valueFormatter: (params) => BILL_STATUS_LABELS[params.value] || params.value || '',
            cellClass: (params) => `bill-status bill-status-${params.value || ''}`,
        },
        {
            headerName: '',
            colId: 'actions',
            flex: 5,
            minWidth: 56,
            sortable: false,
            filter: false,
            cellRenderer: createBillRowMenu,
        },
    ];

    agGrid.createGrid(gridDiv, {
        columnDefs,
        rowData: [],
        defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: false, minWidth: 90 },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.id,
        onGridReady: (params) => { billsGridApi = params.api; },
        onCellClicked: (params) => {
            // A posted bill opens the same modal read-only (see
            // applyBillModalFooter) instead of being excluded here.
            if (params.colDef.colId === 'actions') return;
            if (params.data?.id) openBillModal(params.data.id);
        },
    });
}

async function loadApAgeing() {
    if (!apAgeingAsOf) apAgeingAsOf = getTodayDateString();
    const input = document.getElementById('apAgeingAsOf');
    if (input) input.value = apAgeingAsOf;

    if (apAgeingGridApi) apAgeingGridApi.showLoadingOverlay();
    let rows;
    try {
        rows = await apiJson(`/bills/ap-ageing?as_of=${apAgeingAsOf}`, { fallback: 'Failed to load AP ageing' });
    } catch (error) {
        console.error('Error loading AP ageing:', error);
        showToast('Failed to load AP ageing', 'error');
        if (apAgeingGridApi) apAgeingGridApi.hideOverlay();
        return;
    }

    const total = rows.reduce((sum, r) => sum + (parseFloat(r.outstanding) || 0), 0);
    const totalEl = document.getElementById('apAgeingTotal');
    if (totalEl) {
        totalEl.className = 'trial-balance-status';
        totalEl.textContent = `Rs ${formatMoney(total)} payable`;
    }
    if (apAgeingGridApi) {
        apAgeingGridApi.setGridOption('rowData', rows);
        apAgeingGridApi.hideOverlay();
    }
}

function initApAgeingGrid() {
    const gridDiv = document.getElementById('apAgeingGrid');
    if (!gridDiv) return;

    const money = (params) => (params.value ? formatMoney(params.value) : '');
    const columnDefs = [
        { headerName: 'Supplier', field: 'supplier_name', flex: 1, minWidth: 180 },
        { headerName: 'Not due', field: 'not_due', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '1–30 days', field: 'd1_30', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '31–60 days', field: 'd31_60', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '61–90 days', field: 'd61_90', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '90+ days', field: 'd90_plus', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: 'Total (Rs)', field: 'outstanding', width: 150, type: 'rightAligned', valueFormatter: money },
    ];

    agGrid.createGrid(gridDiv, {
        columnDefs,
        rowData: [],
        defaultColDef: { sortable: true, resizable: true, filter: true, minWidth: 90 },
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.supplier_id,
        onGridReady: (params) => { apAgeingGridApi = params.api; },
    });
}

function initBills() {
    initBillsGrid();
    initApAgeingGrid();

    document.getElementById('createBillBtn')?.addEventListener('click', () => openBillModal());
    document.getElementById('billsStatusFilter')?.addEventListener('change', loadBills);
    document.getElementById('closeBillModal')?.addEventListener('click', closeBillModal);
    document.getElementById('billCancelBtn')?.addEventListener('click', closeBillModal);
    document.getElementById('addBillLineBtn')?.addEventListener('click', () => {
        billLineDrafts.push(emptyBillLine());
        renderBillLines();
    });
    document.getElementById('billDiscount')?.addEventListener('input', renderBillTotals);
    document.getElementById('billTax')?.addEventListener('input', renderBillTotals);
    document.getElementById('billOtherExpense')?.addEventListener('input', renderBillTotals);
    document.getElementById('billSupplier')?.addEventListener('change', applySupplierPaymentTerms);
    document.getElementById('billDate')?.addEventListener('change', applySupplierPaymentTerms);
    document.getElementById('billDueDate')?.addEventListener('input', (e) => {
        e.target.dataset.touched = 'true';
    });
    document.getElementById('billForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!isEditingAllowed()) { showToast('Editing is locked', 'error'); return; }
        saveBill();
    });
    document.getElementById('billConfirmBtn')?.addEventListener('click', async () => {
        if (!editingBillId) return;
        const payload = collectBillPayload();
        if (!payload) return;
        if (!(await persistBillPayload(payload))) return;
        if (await receiveBill(editingBillId)) closeBillModal();
    });
    document.getElementById('billRevertBtn')?.addEventListener('click', async () => {
        if (editingBillId && await unreceiveBill(editingBillId)) closeBillModal();
    });

    document.getElementById('apAgeingAsOf')?.addEventListener('change', (e) => {
        apAgeingAsOf = e.target.value || getTodayDateString();
        loadApAgeing();
    });
}
