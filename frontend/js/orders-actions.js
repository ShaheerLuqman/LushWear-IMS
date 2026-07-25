// Inline cell saves, order delete, load sheet generation, and load sheet logs.

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

let pendingDeleteOrderId = null;
let pendingDeleteOrderData = null;

function openDeleteConfirmModal(orderId, orderData) {
    const orderNumber = String(orderData?.order_number || '');
    if (!/-R$/i.test(orderNumber)) {
        showToast('Only replacement orders can be deleted', 'error');
        return;
    }

    pendingDeleteOrderId = orderId;
    pendingDeleteOrderData = orderData;
    
    const orderNumberEl = document.getElementById('deleteConfirmOrderNumber');
    if (orderNumberEl) {
        orderNumberEl.textContent = orderNumber;
    }
    
    document.getElementById('deleteConfirmModal')?.classList.add('active');
}

function closeDeleteConfirmModal() {
    document.getElementById('deleteConfirmModal')?.classList.remove('active');
    pendingDeleteOrderId = null;
    pendingDeleteOrderData = null;
}

async function confirmDeleteReplacementOrder() {
    if (!pendingDeleteOrderId || !pendingDeleteOrderData) {
        return;
    }

    const orderId = pendingDeleteOrderId;
    const orderData = pendingDeleteOrderData;
    const orderNumber = String(orderData.order_number || '');

    closeDeleteConfirmModal();

    const confirmBtn = document.getElementById('confirmDeleteBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Deleting...';
    }

    try {
        await apiRequest(`/orders/${orderId}`, {
            method: 'DELETE',
            fallback: 'Failed to delete order'
        });
        showToast(`Replacement order ${orderNumber} deleted`, 'success');
        loadOrders();
    } catch (error) {
        console.error('Error deleting replacement order:', error);
        showToast(error.message || 'Failed to delete replacement order', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Delete';
        }
    }
}

function deleteReplacementOrder(orderId, orderData) {
    openDeleteConfirmModal(orderId, orderData);
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
        const replMatch = line.match(/^(\d+)-R$/i);
        if (replMatch) {
            results.push(`${replMatch[1]}-R`);
            continue;
        }
        const n = parseInt(line, 10);
        if (!Number.isNaN(n) && n > 0) results.push(String(n));
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
        if (notFound.length > 0) {
            showToast(`Packaging list saved (${matchedCount} order(s)). Not found: ${notFound.join(', ')}`, 'info');
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
        const unique = [...new Set(orderNumbers)].sort((a, b) => {
            const na = parseInt(a, 10);
            const nb = parseInt(b, 10);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return String(a).localeCompare(String(b));
        });
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
        showToast(`Load sheet saved and PDF downloaded (${orderNumbers.length} order(s))`, 'success');
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

