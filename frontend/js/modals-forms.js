// Shared modal helpers, form wiring, and the bulk-update modals.

// ============================================
// Modal
// ============================================

function closeModal() {
    document.getElementById('editModal').classList.remove('active');
}

// Close modal on backdrop click
document.getElementById('editModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'editModal') {
        closeModal();
    }
});

// Bulk Update Order modal
function openBulkUpdateOrderModal() {
    const formEl = document.getElementById('bulkUpdateOrderForm');
    const resultsEl = document.getElementById('bulkUpdateOrderResults');
    const textarea = document.getElementById('bulkUpdateOrderNumbers');
    if (formEl) formEl.style.display = '';
    if (resultsEl) resultsEl.style.display = 'none';
    if (textarea) {
        // Get selected orders and fill textarea with their order numbers - only when
        // opened from the Orders view itself, so a stale selection left over from an
        // earlier visit there doesn't silently prefill this modal from another page.
        let orderNumbersText = '';
        if (currentView === 'orders' && ordersGridApi) {
            const selectedRows = ordersGridApi.getSelectedRows();
            if (selectedRows.length > 0) {
                // Extract order numbers from selected rows, filter out footer row
                const orderNumbers = selectedRows
                    .filter(row => row && row.id !== '__footer__' && row.order_number)
                    .map(row => row.order_number)
                    .filter(Boolean);
                
                // Remove duplicates and sort
                const uniqueOrderNumbers = [...new Set(orderNumbers)].sort((a, b) => a - b);
                
                orderNumbersText = uniqueOrderNumbers.join('\n');
            }
        }
        textarea.value = orderNumbersText;
        textarea.focus();
        updateBulkUpdateOrderCount();
    }
    document.getElementById('bulkUpdateOrderModal')?.classList.add('active');
}

function updateBulkUpdateOrderCount() {
    const count = parseOrderNumbersFromTextarea().length;
    const countEl = document.getElementById('bulkUpdateOrderCount');
    if (countEl) {
        countEl.textContent = count === 1 ? '1 order' : `${count} orders`;
    }
}

function showBulkUpdateResults(result) {
    const formEl = document.getElementById('bulkUpdateOrderForm');
    const resultsEl = document.getElementById('bulkUpdateOrderResults');
    const successList = document.getElementById('bulkUpdateSuccessList');
    const successEmpty = document.getElementById('bulkUpdateSuccessEmpty');
    const failedList = document.getElementById('bulkUpdateFailedList');
    const failedEmpty = document.getElementById('bulkUpdateFailedEmpty');
    if (!resultsEl || !successList || !failedList) return;

    successList.innerHTML = '';
    failedList.innerHTML = '';
    const updated = result.updated_order_numbers || [];
    const notFound = result.not_found_order_numbers || [];

    if (updated.length === 0) {
        successEmpty.style.display = 'block';
    } else {
        successEmpty.style.display = 'none';
        updated.forEach((num) => {
            const li = document.createElement('li');
            li.textContent = String(num);
            successList.appendChild(li);
        });
    }

    if (notFound.length === 0) {
        failedEmpty.style.display = 'block';
    } else {
        failedEmpty.style.display = 'none';
        notFound.forEach((num) => {
            const li = document.createElement('li');
            li.textContent = String(num);
            failedList.appendChild(li);
        });
    }

    if (formEl) formEl.style.display = 'none';
    resultsEl.style.display = 'block';
}

function closeBulkUpdateOrderModal() {
    document.getElementById('bulkUpdateOrderModal')?.classList.remove('active');
}

function openBulkUpdateDeliveryChargesModal() {
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    const valueEl = document.getElementById('bulkUpdateDeliveryChargesValue');
    if (valueEl) {
        valueEl.value = '';
        valueEl.focus();
    }
    document.getElementById('bulkUpdateDeliveryChargesModal')?.classList.add('active');
}

function closeBulkUpdateDeliveryChargesModal() {
    document.getElementById('bulkUpdateDeliveryChargesModal')?.classList.remove('active');
}

async function submitBulkUpdateDeliveryCharges() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    const valueEl = document.getElementById('bulkUpdateDeliveryChargesValue');
    const raw = valueEl?.value?.trim();
    const deliveryCharge = raw === '' ? NaN : parseFloat(raw);
    if (isNaN(deliveryCharge) || deliveryCharge < 0) {
        showToast('Enter a valid delivery charge (0 or more)', 'error');
        return;
    }
    const confirmBtn = document.getElementById('bulkUpdateDeliveryChargesConfirm');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Updating...';
    }
    try {
        const result = await apiJson('/orders/bulk-update-delivery-charges', {
            method: 'POST',
            body: { order_numbers: orderNumbers, delivery_charge: deliveryCharge },
            fallback: 'Failed to update delivery charges'
        });
        closeBulkUpdateDeliveryChargesModal();
        showBulkUpdateResults(result);
        loadOrders();
    } catch (error) {
        showToast(error.message || 'Bulk update failed', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm';
        }
    }
}

// Cost is per-variant for a product with variants; for one with none, this
// falls back to a single row for the product itself, saved through the
// product-level batch endpoint instead - same modal either way, opened from
// the products grid's "More actions" menu (see createProductRowMenu in
// orders-grid.js). Also holds "recalculate order costs" for this same
// product, so both actions live in one place instead of two separate modals.
function openEditVariantCostsModal(product) {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const variants = sortVariantsBySize(product.variants || []);
    const rows = variants.length
        ? variants.map(v => ({ kind: 'variant', id: v.id, title: v.title, qty: v.quantity || 0, cost: v.cost_price ?? product.cost_price }))
        : [{ kind: 'product', id: product.id, title: product.name, qty: null, cost: product.cost_price }];

    // Cost is usually the same across a product's variants, so multi-variant
    // products default to one shared field; the toggle below switches to the
    // per-row list for the rare product that actually varies by variant.
    const multiVariant = variants.length > 1;

    document.getElementById('editVariantCostsTitle').textContent =
        `${variants.length ? 'Edit variant costs' : 'Edit cost price'} — ${product.name}`;
    const listEl = document.getElementById('editVariantCostsList');
    listEl.innerHTML = rows.map(r => `
        <div class="edit-variant-costs-row">
            <span class="edit-variant-costs-title">${escapeHtml(r.title)}${r.qty != null ? ` <span class="edit-variant-costs-qty">(qty: ${r.qty})</span>` : ''}</span>
            <input type="number" class="edit-variant-costs-input" data-kind="${r.kind}" data-id="${r.id}" min="0" step="0.01" placeholder="0.00" value="${r.cost ?? ''}">
        </div>
    `).join('');
    listEl.dataset.variantIds = JSON.stringify(rows.map(r => r.id));

    const toggleWrap = document.getElementById('editVariantCostsPerVariantWrap');
    const toggle = document.getElementById('editVariantCostsPerVariantToggle');
    const sharedRow = document.getElementById('editVariantCostsSharedRow');
    const sharedInput = document.getElementById('editVariantCostsSharedInput');
    if (toggleWrap) toggleWrap.style.display = multiVariant ? 'flex' : 'none';
    if (toggle) toggle.checked = false;
    // Shared field saves onto every variant, so seed it from the variants' own cost
    // (blank when they disagree - that's what the per-variant toggle is for), not from
    // product.cost_price, which this modal never writes for a product that has variants.
    const sharedCost = rows.every(r => r.cost === rows[0].cost) ? rows[0].cost : null;
    if (sharedInput) sharedInput.value = sharedCost ?? '';
    if (sharedRow) sharedRow.style.display = multiVariant ? 'block' : 'none';
    listEl.style.display = multiVariant ? 'none' : 'flex';

    document.getElementById('editVariantCostsRecalcProductId').value = product.id;
    const dtEl = document.getElementById('editVariantCostsRecalcCreatedAfter');
    if (dtEl) dtEl.value = '';
    const recalcBtn = document.getElementById('editVariantCostsRecalcSubmit');
    if (recalcBtn) recalcBtn.disabled = true;

    document.getElementById('editVariantCostsModal')?.classList.add('active');
}

function closeEditVariantCostsModal() {
    document.getElementById('editVariantCostsModal')?.classList.remove('active');
}

// Validates and persists the costs - one shared value applied to every variant
// (the default for a multi-variant product), or the per-row list when the
// "separately for each variant" toggle is on. Returns false without saving if
// a value is invalid. Shared by the plain Save button and Save and recalculate orders.
async function saveVariantCosts() {
    const listEl = document.getElementById('editVariantCostsList');
    const toggle = document.getElementById('editVariantCostsPerVariantToggle');
    const sharedMode = listEl.style.display === 'none' && !(toggle && toggle.checked);

    if (sharedMode) {
        const sharedInput = document.getElementById('editVariantCostsSharedInput');
        const raw = sharedInput?.value.trim() || '';
        const cost = raw === '' ? null : parseFloat(raw);
        if (raw !== '' && (isNaN(cost) || cost < 0)) {
            showToast('Enter a valid cost price (0 or more)', 'error');
            return false;
        }
        const ids = JSON.parse(listEl.dataset.variantIds || '[]');
        if (ids.length) {
            await apiJson('/products/batch-update-variant-cost-prices', {
                method: 'PUT', body: { updates: ids.map(id => ({ id, cost_price: cost })) }, fallback: 'Failed to update variant costs'
            });
        }
        return true;
    }

    const inputs = document.querySelectorAll('#editVariantCostsList .edit-variant-costs-input');
    const variantUpdates = [];
    const productUpdates = [];
    for (const input of inputs) {
        const raw = input.value.trim();
        const cost = raw === '' ? null : parseFloat(raw);
        if (raw !== '' && (isNaN(cost) || cost < 0)) {
            showToast('Enter a valid cost (0 or more) for every row', 'error');
            return false;
        }
        const update = { id: input.dataset.id, cost_price: cost };
        (input.dataset.kind === 'product' ? productUpdates : variantUpdates).push(update);
    }
    if (!variantUpdates.length && !productUpdates.length) return true;

    if (variantUpdates.length) {
        await apiJson('/products/batch-update-variant-cost-prices', {
            method: 'PUT', body: { updates: variantUpdates }, fallback: 'Failed to update variant costs'
        });
    }
    if (productUpdates.length) {
        await apiJson('/products/batch-update-cost-prices', {
            method: 'PUT', body: { updates: productUpdates }, fallback: 'Failed to update cost price'
        });
    }
    return true;
}

async function submitEditVariantCosts() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const saveBtn = document.getElementById('editVariantCostsSave');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
    }
    try {
        if (!(await saveVariantCosts())) return;
        showToast('Cost price updated', 'success');
        closeEditVariantCostsModal();
        await loadProducts();
    } catch (error) {
        showToast(error.message || 'Failed to update cost price', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    }
}

// Saves the costs above, then refreshes order cost totals from them - one
// action so the recalc never runs against costs that weren't actually saved.
async function submitEditVariantCostsSaveAndRecalc() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const productId = document.getElementById('editVariantCostsRecalcProductId')?.value?.trim();
    const raw = document.getElementById('editVariantCostsRecalcCreatedAfter')?.value;
    if (!productId) {
        showToast('No product selected', 'error');
        return;
    }
    if (!raw) {
        showToast('Select date and time', 'error');
        return;
    }
    const d = new Date(raw);
    if (isNaN(d.getTime())) {
        showToast('Invalid date and time', 'error');
        return;
    }
    const submitBtn = document.getElementById('editVariantCostsRecalcSubmit');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
    }
    try {
        if (!(await saveVariantCosts())) return;
        if (submitBtn) submitBtn.textContent = 'Recalculating...';
        const result = await apiJson('/products/recalculate-order-costs', {
            method: 'POST',
            body: { product_id: productId, created_after: d.toISOString() },
            fallback: 'Failed to recalculate'
        });
        const nums = result.updated_order_numbers;
        if (Array.isArray(nums) && nums.length) {
            console.log('[recalculate-order-costs] updated order_numbers:', nums);
        }
        showToast(`Saved. Updated ${result.updated ?? 0} order(s) (${result.scanned ?? 0} checked)`, 'success');
        closeEditVariantCostsModal();
        await loadProducts();
    } catch (error) {
        showToast(error.message || 'Recalculation failed', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save and recalculate orders';
        }
    }
}

document.getElementById('bulkUpdateOrderModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'bulkUpdateOrderModal') closeBulkUpdateOrderModal();
});

document.getElementById('closeBulkUpdateOrderModal')?.addEventListener('click', closeBulkUpdateOrderModal);

document.getElementById('bulkUpdateOrderNumbers')?.addEventListener('input', updateBulkUpdateOrderCount);

// Bulk update delivery charges modal
document.getElementById('bulkUpdateDeliveryChargesModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'bulkUpdateDeliveryChargesModal') closeBulkUpdateDeliveryChargesModal();
});
document.getElementById('closeBulkUpdateDeliveryChargesModal')?.addEventListener('click', closeBulkUpdateDeliveryChargesModal);
document.getElementById('bulkUpdateDeliveryChargesCancel')?.addEventListener('click', closeBulkUpdateDeliveryChargesModal);
document.getElementById('bulkUpdateDeliveryChargesConfirm')?.addEventListener('click', submitBulkUpdateDeliveryCharges);

// Edit variant costs modal (also holds the save-and-recalculate-order-costs action)
document.getElementById('editVariantCostsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'editVariantCostsModal') closeEditVariantCostsModal();
});
document.getElementById('closeEditVariantCostsModal')?.addEventListener('click', closeEditVariantCostsModal);
document.getElementById('editVariantCostsCancel')?.addEventListener('click', closeEditVariantCostsModal);
document.getElementById('editVariantCostsSave')?.addEventListener('click', submitEditVariantCosts);
document.getElementById('editVariantCostsRecalcSubmit')?.addEventListener('click', submitEditVariantCostsSaveAndRecalc);
document.getElementById('editVariantCostsPerVariantToggle')?.addEventListener('change', (e) => {
    document.getElementById('editVariantCostsSharedRow').style.display = e.target.checked ? 'none' : 'block';
    document.getElementById('editVariantCostsList').style.display = e.target.checked ? 'flex' : 'none';
});
document.getElementById('editVariantCostsRecalcCreatedAfter')?.addEventListener('input', (e) => {
    const btn = document.getElementById('editVariantCostsRecalcSubmit');
    if (btn) btn.disabled = !e.target.value;
});

document.getElementById('bulkUpdateResultsClose')?.addEventListener('click', () => {
    closeBulkUpdateOrderModal();
});

/** Mark (or unmark) the pasted order numbers as settled (paid out by the courier) - shares
 * the Bulk Update Order modal's textarea/results panel with the order-status actions above. */
async function submitBulkUpdateOrderSettled(settled) {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    const btn = document.getElementById(settled ? 'bulkUpdateSetOrderSettled' : 'bulkUpdateSetOrderUnsettled');
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-loading-spinner"></span>' + originalText;
    }
    try {
        const result = await apiJson('/orders/bulk-update-order-settled', {
            method: 'POST',
            body: { order_numbers: orderNumbers, is_order_settled: settled },
            fallback: 'Bulk update failed'
        });
        showBulkUpdateResults(result);
        loadOrders();
        if (currentView === 'courierPaymentReport') loadCourierPaymentReport();
    } catch (error) {
        showToast(error.message || 'Bulk update failed', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

function parseOrderNumbersFromTextarea() {
    const textarea = document.getElementById('bulkUpdateOrderNumbers');
    if (!textarea) return [];
    const lines = textarea.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
        const n = parseInt(line, 10);
        if (!Number.isNaN(n) && n > 0) results.push(n);
    }
    return [...new Set(results)];
}

function bulkUpdateSelectInGrid() {
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    if (!ordersGridApi) {
        showToast('Orders grid is not available', 'error');
        return;
    }
    const wanted = new Set(orderNumbers.map(String));
    const matched = new Set();
    ordersGridApi.deselectAll();
    ordersGridApi.forEachNode(node => {
        const data = node.data;
        if (!data || data.id === '__footer__') return;
        const num = String(data.order_number);
        if (wanted.has(num)) {
            node.setSelected(true);
            matched.add(num);
        }
    });
    const selectedRows = ordersGridApi.getSelectedRows();
    if (selectedRows.length > 0) {
        ordersGridApi.ensureNodeVisible(selectedRows[0], 'middle');
    }
    if (typeof updateFooterRow === 'function') updateFooterRow();

    const notFound = [...wanted].filter(n => !matched.has(n));
    closeBulkUpdateOrderModal();
    if (notFound.length > 0) {
        showToast(`Selected ${matched.size} order(s). Not in grid: ${notFound.join(', ')}`, matched.size > 0 ? 'info' : 'error');
    } else {
        showToast(`Selected ${matched.size} order(s) in grid`, 'success');
    }
}

async function bulkUpdateOrderStatus(orderStatus) {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    if (orderStatus === 'returned'
        && !(await confirmActionOnTerminalOrders(orderNumbers, 'mark them Returned'))) {
        return;
    }
    const btnDelivered = document.getElementById('bulkUpdateSetDelivered');
    const btnReturned = document.getElementById('bulkUpdateSetReturned');
    const btnCancelled = document.getElementById('bulkUpdateSetCancelled');
    const btnPieceReceived = document.getElementById('bulkUpdateSetPieceReceived');

    // Determine which button was clicked based on orderStatus
    let activeButton = null;
    if (orderStatus === 'delivered') {
        activeButton = btnDelivered;
    } else if (orderStatus === 'returned') {
        activeButton = btnReturned;
    } else if (orderStatus === 'cancelled') {
        activeButton = btnCancelled;
    }
    
    const buttons = [btnDelivered, btnReturned, btnCancelled, btnPieceReceived];
    const originalTexts = buttons.map(b => {
        if (!b) return '';
        // Get text content, preserving structure but trimming whitespace
        return b.textContent.trim();
    });
    
    // Disable all buttons and show loading on active button
    buttons.forEach((b, index) => {
        if (b) {
            b.disabled = true;
            if (b === activeButton) {
                // Add loading spinner to the active button
                b.innerHTML = '<span class="btn-loading-spinner"></span>' + originalTexts[index];
            }
        }
    });
    
    try {
        const result = await apiJson('/orders/bulk-update-status', {
            method: 'POST',
            body: { order_numbers: orderNumbers, order_status: orderStatus },
            fallback: 'Bulk update failed'
        });
        showBulkUpdateResults(result);
        loadOrders();
    } catch (error) {
        showToast(error.message || 'Bulk update failed', 'error');
    } finally {
        // Restore original button texts
        buttons.forEach((b, index) => {
            if (b) {
                b.disabled = false;
                b.innerHTML = originalTexts[index];
            }
        });
    }
}

async function bulkUpdatePieceReceived() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    if (!(await confirmActionOnTerminalOrders(orderNumbers, 'mark them Returned + Piece Received'))) {
        return;
    }
    const btnDelivered = document.getElementById('bulkUpdateSetDelivered');
    const btnReturned = document.getElementById('bulkUpdateSetReturned');
    const btnCancelled = document.getElementById('bulkUpdateSetCancelled');
    const btnPieceReceived = document.getElementById('bulkUpdateSetPieceReceived');
    const buttons = [btnDelivered, btnReturned, btnCancelled, btnPieceReceived];
    const originalTexts = buttons.map(b => {
        if (!b) return '';
        // Get text content, preserving structure but trimming whitespace
        return b.textContent.trim();
    });
    
    // Disable all buttons and show loading on the active button
    buttons.forEach((b, index) => {
        if (b) {
            b.disabled = true;
            if (b === btnPieceReceived) {
                // Add loading spinner to the active button
                b.innerHTML = '<span class="btn-loading-spinner"></span>' + originalTexts[index];
            }
        }
    });
    
    try {
        // First, update piece_received to "Received"
        const pieceReceivedResult = await apiJson('/orders/bulk-update-piece-received', {
            method: 'POST',
            body: { order_numbers: orderNumbers },
            fallback: 'Failed to update piece received'
        });
        
        // Then, automatically set order status to "returned"
        let statusUpdateResult = null;
        let statusUpdateError = null;
        try {
            const statusResponse = await fetch(`${API_BASE}/orders/bulk-update-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_numbers: orderNumbers, order_status: 'returned' }),
            });
            if (!statusResponse.ok) {
                const err = await statusResponse.json();
                statusUpdateError = err.detail || 'Failed to update order status';
            } else {
                statusUpdateResult = await statusResponse.json();
            }
        } catch (error) {
            statusUpdateError = error.message || 'Failed to update order status';
        }
        
        // Show results - prioritize piece received result, but mention status update
        if (statusUpdateError) {
            showToast(`Piece received updated, but failed to set status to Returned: ${statusUpdateError}`, 'warning');
        } else {
            showToast(`Piece received updated and order status set to Returned for ${orderNumbers.length} order(s)`, 'success');
        }
        
        // Show the piece received results (this is the primary operation)
        showBulkUpdateResults(pieceReceivedResult);
        loadOrders();
    } catch (error) {
        showToast(error.message || 'Bulk update failed', 'error');
    } finally {
        // Restore original button texts
        buttons.forEach((b, index) => {
            if (b) {
                b.disabled = false;
                b.innerHTML = originalTexts[index];
            }
        });
    }
}

