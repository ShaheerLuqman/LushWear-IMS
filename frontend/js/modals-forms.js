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
        // Get selected orders and fill textarea with their order numbers
        let orderNumbersText = '';
        if (ordersGridApi) {
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

function openBulkUpdateCostPriceModal() {
    if (!productsGridApi) {
        showToast('Products grid not ready', 'error');
        return;
    }
    const selected = productsGridApi.getSelectedRows();
    if (!selected.length) {
        showToast('Select at least one product using the checkboxes', 'error');
        return;
    }
    const namesEl = document.getElementById('bulkUpdateCostPriceNames');
    const countEl = document.getElementById('bulkUpdateCostPriceCount');
    const priceEl = document.getElementById('bulkUpdateCostPriceValue');
    if (namesEl) namesEl.value = selected.map((r) => r.name || '(no name)').join('\n');
    if (countEl) countEl.textContent = selected.length === 1 ? '1 product' : `${selected.length} products`;
    if (priceEl) priceEl.value = '';
    document.getElementById('bulkUpdateCostPriceModal')?.classList.add('active');
    if (priceEl) priceEl.focus();
}

function closeBulkUpdateCostPriceModal() {
    document.getElementById('bulkUpdateCostPriceModal')?.classList.remove('active');
}

async function submitBulkUpdateCostPrice() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    if (!productsGridApi) return;
    const selected = productsGridApi.getSelectedRows();
    if (!selected.length) {
        showToast('No products selected', 'error');
        return;
    }
    const priceEl = document.getElementById('bulkUpdateCostPriceValue');
    const raw = priceEl?.value?.trim();
    const costPrice = raw === '' ? NaN : parseFloat(raw);
    if (isNaN(costPrice) || costPrice < 0) {
        showToast('Enter a valid cost price (0 or more)', 'error');
        return;
    }
    const submitBtn = document.getElementById('bulkUpdateCostPriceSubmit');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Updating...';
    }
    try {
        const result = await apiJson('/products/batch-update-cost-prices', {
            method: 'PUT',
            body: { updates: selected.map((r) => ({ id: r.id, cost_price: costPrice })) },
            fallback: 'Failed to update cost prices'
        });
        showToast(result.message || `Updated cost price for ${selected.length} product(s)`, 'success');
        closeBulkUpdateCostPriceModal();
        await loadProducts();
    } catch (error) {
        showToast(error.message || 'Bulk update failed', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Update cost price';
        }
    }
}

function openRecalculateOrderCostsModal() {
    if (!productsGridApi) {
        showToast('Products grid not ready', 'error');
        return;
    }
    const selected = productsGridApi.getSelectedRows();
    if (selected.length !== 1) {
        showToast('Select exactly one product', 'error');
        return;
    }
    const row = selected[0];
    const idEl = document.getElementById('recalculateOrderCostsProductId');
    const nameEl = document.getElementById('recalculateOrderCostsProductName');
    const dtEl = document.getElementById('recalculateOrderCostsCreatedAfter');
    if (idEl) idEl.value = row.id || '';
    if (nameEl) nameEl.value = row.name || '';
    if (dtEl) {
        const n = new Date();
        n.setHours(0, 0, 0, 0);
        const pad = (x) => String(x).padStart(2, '0');
        dtEl.value = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
    }
    document.getElementById('recalculateOrderCostsModal')?.classList.add('active');
}

function closeRecalculateOrderCostsModal() {
    document.getElementById('recalculateOrderCostsModal')?.classList.remove('active');
}

async function submitRecalculateOrderCosts() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const idEl = document.getElementById('recalculateOrderCostsProductId');
    const dtEl = document.getElementById('recalculateOrderCostsCreatedAfter');
    const productId = idEl?.value?.trim();
    const raw = dtEl?.value;
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
    const submitBtn = document.getElementById('recalculateOrderCostsSubmit');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Updating...';
    }
    try {
        const result = await apiJson('/products/recalculate-order-costs', {
            method: 'POST',
            body: { product_id: productId, created_after: d.toISOString() },
            fallback: 'Failed to recalculate'
        });
        closeRecalculateOrderCostsModal();
        const nums = result.updated_order_numbers;
        if (Array.isArray(nums) && nums.length) {
            console.log('[recalculate-order-costs] updated order_numbers:', nums);
        }
        showToast(`Updated ${result.updated ?? 0} order(s) (${result.scanned ?? 0} checked)`, 'success');
    } catch (error) {
        showToast(error.message || 'Recalculation failed', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Recalculate';
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

// Bulk update cost price modal
document.getElementById('bulkUpdateCostPriceModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'bulkUpdateCostPriceModal') closeBulkUpdateCostPriceModal();
});
document.getElementById('closeBulkUpdateCostPriceModal')?.addEventListener('click', closeBulkUpdateCostPriceModal);
document.getElementById('bulkUpdateCostPriceCancel')?.addEventListener('click', closeBulkUpdateCostPriceModal);
document.getElementById('bulkUpdateCostPriceSubmit')?.addEventListener('click', submitBulkUpdateCostPrice);

document.getElementById('recalculateOrderCostsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'recalculateOrderCostsModal') closeRecalculateOrderCostsModal();
});
document.getElementById('closeRecalculateOrderCostsModal')?.addEventListener('click', closeRecalculateOrderCostsModal);
document.getElementById('recalculateOrderCostsCancel')?.addEventListener('click', closeRecalculateOrderCostsModal);
document.getElementById('recalculateOrderCostsSubmit')?.addEventListener('click', submitRecalculateOrderCosts);

document.getElementById('bulkUpdateResultsClose')?.addEventListener('click', () => {
    closeBulkUpdateOrderModal();
});

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

