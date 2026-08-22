// Inline cell saves, order delete, load sheet generation, and load sheet logs.

// ============================================
// Orders Toolbar & Bulk Actions (init)
// ============================================

function initOrdersActions() {
    document.getElementById('syncShopifyBtn')?.addEventListener('click', async () => {
        await syncShopifyProducts();
    });

    document.getElementById('bulkUpdateOrderBtn')?.addEventListener('click', openBulkUpdateOrderModal);
    document.getElementById('bulkUpdateCostPriceBtn')?.addEventListener('click', openBulkUpdateCostPriceModal);
    document.getElementById('recalculateOrderCostsBtn')?.addEventListener('click', openRecalculateOrderCostsModal);
    document.getElementById('bulkUpdateSetDelivered')?.addEventListener('click', () => bulkUpdateOrderStatus('delivered'));
    document.getElementById('bulkUpdateSetReturned')?.addEventListener('click', () => bulkUpdateOrderStatus('returned'));
    document.getElementById('bulkUpdateSetCancelled')?.addEventListener('click', () => bulkUpdateOrderStatus('cancelled'));
    document.getElementById('bulkUpdateSetPieceReceived')?.addEventListener('click', bulkUpdatePieceReceived);
    document.getElementById('bulkUpdateSelectInGrid')?.addEventListener('click', bulkUpdateSelectInGrid);
    document.getElementById('bulkUpdateDeliveryChargesBtn')?.addEventListener('click', openBulkUpdateDeliveryChargesModal);
    document.getElementById('bulkUpdateSetOrderSettled')?.addEventListener('click', () => submitBulkUpdateOrderSettled(true));
    document.getElementById('bulkUpdateSetOrderUnsettled')?.addEventListener('click', () => submitBulkUpdateOrderSettled(false));
    document.getElementById('courierResBulkSettleBtn')?.addEventListener('click', openBulkUpdateOrderModal);

    // Upload PostEx modal: file name display, upload button, close/cancel
    document.getElementById('ordersMoreActionUploadPostEx')?.addEventListener('click', openUploadPostExModal);
    const uploadPostExFileInput = document.getElementById('uploadPostExFileInput');
    const uploadPostExFileNameEl = document.getElementById('uploadPostExFileName');
    if (uploadPostExFileInput && uploadPostExFileNameEl) {
        uploadPostExFileInput.addEventListener('change', () => {
            const file = uploadPostExFileInput.files?.[0];
            uploadPostExFileNameEl.textContent = file ? file.name : 'No file chosen';
        });
    }
    document.getElementById('uploadPostExModalUpload')?.addEventListener('click', async () => {
        const fileInput = document.getElementById('uploadPostExFileInput');
        const file = fileInput?.files?.[0];
        if (!file) {
            showToast('Please select a CSV file', 'error');
            return;
        }
        const assignmentInput = document.getElementById('uploadPostExAssignmentNumber');
        const assignmentNumber = assignmentInput?.value?.trim() || null;
        await uploadPostExCsv(file, assignmentNumber);
    });
    document.getElementById('closeUploadPostExModal')?.addEventListener('click', closeUploadPostExModal);
    document.getElementById('uploadPostExModalCancel')?.addEventListener('click', closeUploadPostExModal);
    const uploadPostExModalEl = document.getElementById('uploadPostExModal');
    if (uploadPostExModalEl) {
        uploadPostExModalEl.addEventListener('click', (e) => { if (e.target === uploadPostExModalEl) closeUploadPostExModal(); });
    }

    // Generate Load Sheet modal
    document.getElementById('ordersMoreActionGenerateLoadSheet')?.addEventListener('click', openGenerateLoadSheetModal);
    document.getElementById('generateLoadSheetModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'generateLoadSheetModal') closeGenerateLoadSheetModal();
    });
    document.getElementById('closeGenerateLoadSheetModal')?.addEventListener('click', closeGenerateLoadSheetModal);
    document.getElementById('loadSheetModalCancel')?.addEventListener('click', closeGenerateLoadSheetModal);
    document.getElementById('loadSheetModalConfirm')?.addEventListener('click', confirmGenerateLoadSheet);
    document.getElementById('loadSheetOrderNumbers')?.addEventListener('input', updateLoadSheetModalState);
    document.getElementById('loadSheetLogsRefreshBtn')?.addEventListener('click', () => loadLoadSheetLogs());

    // Generate Invoice
    document.getElementById('ordersMoreActionGenerateInvoice')?.addEventListener('click', async () => {
        if (!ordersGridApi) {
            showToast('Orders grid not initialized', 'error');
            return;
        }
        const selectedRows = ordersGridApi.getSelectedRows().filter(row => row && row.id !== '__footer__' && row.order_number);
        if (selectedRows.length === 0) {
            showToast('Please select at least one order', 'error');
            return;
        }
        const orderIds = selectedRows.map(row => row.id).filter(Boolean);
        if (orderIds.length === 0) {
            showToast('Selected orders have no ID', 'error');
            return;
        }
        try {
            const res = await apiRequest('/orders/generate-invoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderIds),
                fallback: 'Failed to generate invoice'
            });
            const blob = await res.blob();
            const filename = invoicePdfFilename();
            const url = window.URL.createObjectURL(blob);
            const opened = window.open(url, '_blank', 'noopener,noreferrer');
            if (!opened) {
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
            setTimeout(() => window.URL.revokeObjectURL(url), 60000);
            showToast(`Invoice generated (${orderIds.length} order(s))`, 'success');
        } catch (e) {
            showToast(e.message || 'Failed to generate invoice', 'error');
        }
    });

    // Generate Packaging List (opens modal: enter order numbers or upload labels PDF)
    document.getElementById('ordersMoreActionGeneratePackagingList')?.addEventListener('click', openPackagingListModal);
    document.getElementById('closePackagingListModal')?.addEventListener('click', closePackagingListModal);
    document.getElementById('packagingListModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'packagingListModal') closePackagingListModal();
    });
    document.getElementById('packagingListOrderNumbers')?.addEventListener('input', updatePackagingListOrderCount);
    document.getElementById('packagingListUploadPdfBtn')?.addEventListener('click', () => {
        document.getElementById('packagingListPdfInput')?.click();
    });
    document.getElementById('packagingListPdfInput')?.addEventListener('change', handlePackagingListPdfUpload);
    document.getElementById('packagingListGenerateBtn')?.addEventListener('click', generatePackagingListFromNumbers);

    document.getElementById('ordersMoreActionFetchDeliveryStatus')?.addEventListener('click', () => fetchDeliveryStatusSelected());
    document.getElementById('exportGridExcelBtn')?.addEventListener('click', () => exportCurrentGridToExcel());
    initOrdersMoreActionsMenu();

    // Order table full screen toggle (icon only; Esc to exit)
    document.getElementById('ordersFullScreenBtn')?.addEventListener('click', toggleOrdersFullScreen);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('orders-table-fullscreen')) {
            exitOrdersFullScreen();
        }
    });
    // Sync the UI when the browser leaves fullscreen (e.g. user pressed Esc / F11)
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && document.body.classList.contains('orders-table-fullscreen')) {
            syncOrdersFullScreenExit();
        }
    });
}

function toggleOrdersFullScreen() {
    if (document.body.classList.contains('orders-table-fullscreen')) {
        exitOrdersFullScreen();
    } else {
        document.body.classList.add('orders-table-fullscreen');
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
        setTimeout(() => {
            sizeGridColumns(ordersGridApi);
        }, 100);
    }
}

/** Sync UI when fullscreen was exited by the browser (Esc/F11). Do not call exitFullscreen again. */
function syncOrdersFullScreenExit() {
    document.body.classList.remove('orders-table-fullscreen');
    setTimeout(() => {
        sizeGridColumns(ordersGridApi);
    }, 100);
}

/** Exit fullscreen when the user clicks the fullscreen button. */
function exitOrdersFullScreen() {
    document.body.classList.remove('orders-table-fullscreen');
    if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
    }
    setTimeout(() => {
        sizeGridColumns(ordersGridApi);
    }, 100);
}

// ============================================
// Save Functions for Editable Cells
// ============================================

async function saveCostPrice(productId, costPrice) {
    try {
        await apiJson('/products/batch-update-cost-prices', {
            method: 'PUT',
            body: { updates: [{ id: productId, cost_price: costPrice }] },
            fallback: 'Failed to update cost price'
        });
        showToast('Cost price updated', 'success');
    } catch (error) {
        console.error('Error saving cost price:', error);
        showToast('Failed to save cost price', 'error');
    }
}

async function saveProductCollection(productId, collection) {
    try {
        await apiJson(`/products/${productId}`, {
            method: 'PUT',
            body: { collection: collection },
            fallback: 'Failed to update collection'
        });
        showToast('Collection updated', 'success');
    } catch (error) {
        console.error('Error saving collection:', error);
        showToast('Failed to save collection', 'error');
    }
}

async function saveOrderField(orderId, field, value) {
    try {
        const updated = await apiJson(`/orders/${orderId}`, {
            method: 'PUT',
            body: { [field]: value },
            fallback: `Failed to update ${field}`
        });

        // When the advance amount changes, the backend recomputes advance_status.
        // Reflect the recomputed status on the grid row so the indicator updates.
        if (field === 'advance_amount') {
            try {
                if (updated && ordersGridApi) {
                    const rowNode = ordersGridApi.getRowNode(orderId);
                    if (rowNode && updated.advance_status !== undefined) {
                        // advance_status isn't its own column, so set it on row data directly
                        // and force a re-render of the Advance cell (which draws the indicator).
                        rowNode.data.advance_status = updated.advance_status;
                        ordersGridApi.refreshCells({ rowNodes: [rowNode], columns: ['advance_amount'], force: true });
                    }
                }
            } catch (e) { /* non-fatal */ }
        }

        showToast(`Order ${field.replace('_', ' ')} updated`, 'success');
    } catch (error) {
        console.error(`Error saving ${field}:`, error);
        showToast(`Failed to save ${field}`, 'error');
    }
}

// ============================================
// Generate Load Sheet modal & Load Sheet Logs
// ============================================

const MONTH_ABBREV = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function loadSheetFilenameFromDateAndRider(date, riderName) {
    const d = date instanceof Date ? date : new Date(date);
    const day = d.getDate();
    const month = MONTH_ABBREV[d.getMonth()] || 'Jan';
    const year = d.getFullYear();
    const rider = (riderName || 'LoadSheet').replace(/\s+/g, '_').replace(/[/\\:*?"<>|]/g, '');
    return `${day}_${month}_${year}_${rider}.pdf`;
}

/** Local date + time; safe for Windows filenames (no colons). */
function invoicePdfFilename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `invoice_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
}

function packagingListPdfFilename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `packaging_list_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
}

// --- Packaging List modal (enter order numbers or upload labels PDF) ---
function parsePackagingListOrderNumbers() {
    const textarea = document.getElementById('packagingListOrderNumbers');
    if (!textarea) return [];
    const lines = textarea.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
        const n = parseInt(line, 10);
        if (!Number.isNaN(n) && n > 0) results.push(n);
    }
    return [...new Set(results)];
}

function updatePackagingListOrderCount() {
    const count = parsePackagingListOrderNumbers().length;
    const countEl = document.getElementById('packagingListOrderCount');
    if (countEl) countEl.textContent = count === 1 ? '1 order' : `${count} orders`;
}

function openPackagingListModal() {
    const textarea = document.getElementById('packagingListOrderNumbers');
    if (textarea) {
        // Prefill from current grid selection (order numbers), like Bulk update order
        let orderNumbersText = '';
        if (ordersGridApi) {
            const selectedRows = ordersGridApi.getSelectedRows();
            if (selectedRows.length > 0) {
                const orderNumbers = selectedRows
                    .filter(row => row && row.id !== '__footer__' && row.order_number)
                    .map(row => row.order_number)
                    .filter(Boolean);
                const uniqueOrderNumbers = [...new Set(orderNumbers)].sort((a, b) => {
                    const numA = parseInt(a, 10);
                    const numB = parseInt(b, 10);
                    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
                    return String(a).localeCompare(String(b));
                });
                orderNumbersText = uniqueOrderNumbers.join('\n');
            }
        }
        textarea.value = orderNumbersText;
        textarea.focus();
        updatePackagingListOrderCount();
    }
    document.getElementById('packagingListModal')?.classList.add('active');
}

function closePackagingListModal() {
    document.getElementById('packagingListModal')?.classList.remove('active');
}

async function handlePackagingListPdfUpload(event) {
    const input = event.target;
    const files = input?.files ? Array.from(input.files) : [];
    if (files.length === 0) return;
    const uploadBtn = document.getElementById('packagingListUploadPdfBtn');
    const prevText = uploadBtn ? uploadBtn.textContent : '';
    if (uploadBtn) { uploadBtn.disabled = true; }

    // Start from order numbers already entered so multiple uploads accumulate.
    const merged = [];
    const seen = new Set();
    const addNumbers = (nums) => {
        for (const n of nums) {
            const key = String(n).trim();
            if (key && !seen.has(key)) {
                seen.add(key);
                merged.push(key);
            }
        }
    };
    addNumbers(parsePackagingListOrderNumbers());

    const failed = [];
    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (uploadBtn) {
                uploadBtn.textContent =
                    files.length > 1 ? `Reading PDF ${i + 1}/${files.length}…` : 'Reading PDF…';
            }
            try {
                const formData = new FormData();
                formData.append('file', file);
                const res = await apiRequest('/orders/extract-order-numbers-from-pdf', {
                    method: 'POST',
                    body: formData,
                    fallback: 'Failed to read PDF'
                });
                const data = await res.json();
                addNumbers(data.order_numbers || []);
            } catch (e) {
                failed.push(file.name);
                console.error(`Failed to read ${file.name}:`, e);
            }
        }

        const textarea = document.getElementById('packagingListOrderNumbers');
        if (textarea) {
            textarea.value = merged.join('\n');
            updatePackagingListOrderCount();
        }

        if (failed.length) {
            showToast(`Could not read ${failed.length} PDF(s): ${failed.join(', ')}`, 'error');
        } else if (merged.length === 0) {
            showToast('No order numbers found in the selected PDF(s)', 'error');
        } else {
            const label = files.length > 1 ? `${files.length} PDFs` : 'PDF';
            showToast(`Found ${merged.length} order number(s) from ${label}`, 'success');
        }
    } finally {
        if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = prevText; }
        if (input) input.value = '';  // allow re-uploading the same file(s)
    }
}

async function generatePackagingListFromNumbers() {
    const orderNumbers = parsePackagingListOrderNumbers();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    const generateBtn = document.getElementById('packagingListGenerateBtn');
    const prevText = generateBtn ? generateBtn.textContent : '';
    if (generateBtn) { generateBtn.disabled = true; generateBtn.textContent = 'Generating…'; }
    try {
        const res = await apiRequest('/orders/generate-packaging-list-by-numbers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_numbers: orderNumbers }),
            fallback: 'Failed to generate packaging list'
        });
        const matchedCount = parseInt(res.headers.get('X-Matched-Count') || '0', 10);
        const notFoundHeader = res.headers.get('X-Not-Found') || '';
        const cancelledHeader = res.headers.get('X-Cancelled') || '';
        const blob = await res.blob();
        const filename = packagingListPdfFilename();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 60000);
        closePackagingListModal();
        const notFound = notFoundHeader ? notFoundHeader.split(',').filter(Boolean) : [];
        const cancelled = cancelledHeader ? cancelledHeader.split(',').filter(Boolean) : [];
        const notes = [];
        if (notFound.length > 0) notes.push(`Not found: ${notFound.join(', ')}`);
        if (cancelled.length > 0) notes.push(`Cancelled (excluded): ${cancelled.join(', ')}`);
        if (notes.length > 0) {
            showToast(`Packaging list saved (${matchedCount} order(s)). ${notes.join('. ')}`, 'info');
        } else {
            showToast(`Packaging list saved (${matchedCount} order(s))`, 'success');
        }
    } catch (e) {
        showToast(e.message || 'Failed to generate packaging list', 'error');
    } finally {
        if (generateBtn) { generateBtn.disabled = false; generateBtn.textContent = prevText; }
    }
}

function parseLoadSheetOrderNumbersFromBox() {
    const textarea = document.getElementById('loadSheetOrderNumbers');
    if (!textarea) return [];
    const raw = (textarea.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const unique = [...new Set(raw)].sort((a, b) => {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return String(a).localeCompare(String(b));
    });
    return unique;
}

function updateLoadSheetModalState() {
    const orderNumbers = parseLoadSheetOrderNumbersFromBox();
    const countEl = document.getElementById('loadSheetOrderCount');
    const confirmBtn = document.getElementById('loadSheetModalConfirm');
    if (countEl) countEl.textContent = orderNumbers.length === 0 ? '0 orders' : (orderNumbers.length === 1 ? '1 order' : `${orderNumbers.length} orders`);
    if (confirmBtn) confirmBtn.disabled = orderNumbers.length === 0;
}

function openGenerateLoadSheetModal() {
    const countEl = document.getElementById('loadSheetOrderCount');
    const textarea = document.getElementById('loadSheetOrderNumbers');
    const assignmentEl = document.getElementById('loadSheetAssignmentNumber');
    const riderEl = document.getElementById('loadSheetRiderName');
    const deliveryChargeEl = document.getElementById('loadSheetDeliveryCharge');
    if (ordersGridApi) {
        const selectedRows = ordersGridApi.getSelectedRows().filter(row => row && row.id !== '__footer__' && row.order_number);
        const orderNumbers = selectedRows.map(row => row.order_number).filter(Boolean);
        const unique = [...new Set(orderNumbers)].sort((a, b) => a - b);
        if (textarea) textarea.value = unique.join('\n');
    } else {
        if (textarea) textarea.value = '';
    }
    if (countEl) countEl.textContent = '0 orders';
    if (assignmentEl) assignmentEl.value = `LW-${nextLoadSheetAssignmentNumber}`;
    if (riderEl) riderEl.value = '';
    if (deliveryChargeEl) deliveryChargeEl.value = '';
    syncLoadSheetRiderNameDatalist();
    document.getElementById('generateLoadSheetModal')?.classList.add('active');
    updateLoadSheetModalState();
    if (textarea && textarea.value.trim()) assignmentEl?.focus(); else textarea?.focus();
}

function closeGenerateLoadSheetModal() {
    document.getElementById('generateLoadSheetModal')?.classList.remove('active');
}

async function confirmGenerateLoadSheet() {
    const assignmentEl = document.getElementById('loadSheetAssignmentNumber');
    const riderEl = document.getElementById('loadSheetRiderName');
    const deliveryChargeEl = document.getElementById('loadSheetDeliveryCharge');
    const assignmentNumber = assignmentEl?.value?.trim();
    const riderName = riderEl?.value?.trim();
    const deliveryChargeRaw = deliveryChargeEl?.value?.trim();
    const deliveryCharge = deliveryChargeRaw === '' ? null : parseFloat(deliveryChargeRaw);
    if (!assignmentNumber) {
        showToast('Enter assignment number', 'error');
        return;
    }
    if (!riderName) {
        showToast('Enter rider name', 'error');
        return;
    }
    if (deliveryCharge !== null && (Number.isNaN(deliveryCharge) || deliveryCharge < 0)) {
        showToast('Delivery charges must be 0 or greater', 'error');
        return;
    }
    const orderNumbers = parseLoadSheetOrderNumbersFromBox().map(String);
    if (orderNumbers.length === 0) return; // button is disabled, but guard anyway
    const confirmBtn = document.getElementById('loadSheetModalConfirm');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Saving & generating...';
    }
    try {
        const logData = await apiJson('/orders/load-sheet-logs', {
            method: 'POST',
            body: {
                assignment_number: assignmentNumber,
                rider_name: riderName,
                order_numbers: orderNumbers,
                delivery_charge: deliveryCharge
            },
            fallback: 'Failed to save load sheet log'
        });
        const logId = logData.id;
        closeGenerateLoadSheetModal();
        const pdfRes = await apiRequest(`/orders/load-sheet-logs/${logId}/pdf`, { fallback: 'Failed to generate PDF' });
        const blob = await pdfRes.blob();
        const filename = loadSheetFilenameFromDateAndRider(new Date(), riderName);
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        const savedCount = Array.isArray(logData.order_numbers) ? logData.order_numbers.length : orderNumbers.length;
        const cancelledSkipped = logData.cancelled_order_numbers || [];
        const skippedNote = cancelledSkipped.length
            ? ` (${cancelledSkipped.length} cancelled order(s) skipped: ${cancelledSkipped.join(', ')})`
            : '';
        showToast(`Load sheet saved and PDF downloaded (${savedCount} order(s))${skippedNote}`, 'success');
        if (currentView === 'loadSheetLogs') {
            loadLoadSheetLogs();
        } else {
            fetchLoadSheetRiderNames();
        }
        loadOrders();
    } catch (error) {
        showToast(error.message || 'Failed to generate load sheet', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Generate & Download PDF';
        }
    }
}

async function fetchLoadSheetRiderNames() {
    try {
        const response = await fetch(`${API_BASE}/orders/load-sheet-logs`);
        if (!response.ok) return;
        const logs = await response.json();
        const namesSet = new Set();
        logs.forEach((log) => {
            const name = (log && typeof log.rider_name === 'string') ? log.rider_name.trim() : '';
            if (name) namesSet.add(name);
        });
        loadSheetRiderNames = Array.from(namesSet).sort((a, b) => a.localeCompare(b));
        updateNextLoadSheetAssignmentNumber(logs);
        syncLoadSheetRiderNameDatalist();
    } catch {
        // Ignore errors; suggestions are a convenience only
    }
}

function updateNextLoadSheetAssignmentNumber(logs) {
    let max = 0;
    (logs || []).forEach((log) => {
        const an = log && log.assignment_number;
        if (typeof an === 'string') {
            const m = an.trim().match(/^LW-(\d+)$/i);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
    });
    nextLoadSheetAssignmentNumber = max + 1;
}

function syncLoadSheetRiderNameDatalist() {
    const datalist = document.getElementById('loadSheetRiderNameList');
    if (!datalist) return;
    datalist.innerHTML = '';
    loadSheetRiderNames.forEach((name) => {
        const option = document.createElement('option');
        option.value = name;
        datalist.appendChild(option);
    });
}

async function loadLoadSheetLogs() {
    const tbody = document.getElementById('loadSheetLogsTableBody');
    const emptyEl = document.getElementById('loadSheetLogsEmpty');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'none';
    try {
        const logs = await apiJson('/orders/load-sheet-logs', { fallback: 'Failed to load' });
        updateNextLoadSheetAssignmentNumber(logs);
        fetchLoadSheetRiderNames();
        if (logs.length === 0) {
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }
        logs.forEach((log) => {
            const tr = document.createElement('tr');
            const created = log.created_at ? formatDateTimeDDMMYYYY(log.created_at) : '';
            const orderNumbers = Array.isArray(log.order_numbers) ? log.order_numbers : [];
            const orderNumbersDisplay = orderNumbers.length <= 3
                ? orderNumbers.join(', ')
                : orderNumbers.slice(0, 3).join(', ') + '...';
            const orderNumbersTitle = orderNumbers.join(', ') || '—';
            const dc = log.delivery_charge != null && log.delivery_charge !== '' ? Number(log.delivery_charge).toFixed(2) : '—';
            tr.innerHTML = `
                <td>${escapeHtml(log.assignment_number || '')}</td>
                <td>${escapeHtml(log.rider_name || '')}</td>
                <td>${escapeHtml(created)}</td>
                <td class="load-sheet-order-numbers-cell" title="${escapeHtml(orderNumbersTitle)}">${escapeHtml(orderNumbersDisplay || '—')}</td>
                <td>${escapeHtml(dc)}</td>
                <td class="load-sheet-actions-cell">
                    <button type="button" class="btn btn-secondary btn-sm load-sheet-download-pdf" data-log-id="${escapeHtml(log.id)}" data-rider-name="${escapeHtml(log.rider_name || '')}" data-created-at="${escapeHtml(log.created_at || '')}" title="Download PDF"><i class="fas fa-download" aria-hidden="true"></i></button>
                    <button type="button" class="btn btn-danger btn-sm load-sheet-delete-log" data-log-id="${escapeHtml(log.id)}" title="Delete"><i class="fas fa-trash" aria-hidden="true"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('.load-sheet-download-pdf').forEach(btn => {
            btn.addEventListener('click', () => downloadLoadSheetLogPdf(btn.getAttribute('data-log-id'), btn.getAttribute('data-rider-name'), btn.getAttribute('data-created-at')));
        });
        tbody.querySelectorAll('.load-sheet-delete-log').forEach(btn => {
            btn.addEventListener('click', () => deleteLoadSheetLog(btn.getAttribute('data-log-id')));
        });
    } catch (error) {
        showToast(error.message || 'Failed to load load sheet logs', 'error');
        if (emptyEl) emptyEl.style.display = 'block';
    }
}

async function deleteLoadSheetLog(logId) {
    if (!logId) return;
    const confirmed = await showAppConfirm({
        title: 'Delete Load Sheet Log',
        message: 'Are you sure you want to delete this load sheet log? This cannot be undone.',
        confirmText: 'Delete',
        danger: true
    });
    if (!confirmed) return;
    try {
        await apiRequest(`/orders/load-sheet-logs/${logId}`, { method: 'DELETE', fallback: 'Failed to delete' });
        showToast('Load sheet log deleted', 'success');
        loadLoadSheetLogs();
        loadOrders();
    } catch (error) {
        showToast(error.message || 'Failed to delete load sheet log', 'error');
    }
}

async function downloadLoadSheetLogPdf(logId, riderName, createdAt) {
    if (!logId) return;
    try {
        const response = await apiRequest(`/orders/load-sheet-logs/${logId}/pdf`, { fallback: 'Failed to generate PDF' });
        const blob = await response.blob();
        const filename = loadSheetFilenameFromDateAndRider(createdAt || new Date(), riderName);
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast('PDF downloaded', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to download PDF', 'error');
    }
}

