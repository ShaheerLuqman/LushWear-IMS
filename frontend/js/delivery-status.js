// Toasts, Excel export, delivery status fetch/report, and app bootstrap listeners.

// ============================================
// Toast
// ============================================

/**
 * Show in-app confirmation modal. Returns a Promise that resolves to true if user clicked Confirm, false if Cancel/close.
 * @param {{ title: string, message: string, confirmText?: string, danger?: boolean }} options
 */
function showAppConfirm(options) {
    const { title = 'Confirm', message, confirmText = 'Confirm', danger = false } = options || {};
    const modal = document.getElementById('appConfirmModal');
    const titleEl = document.getElementById('appConfirmTitle');
    const messageEl = document.getElementById('appConfirmMessage');
    const okBtn = document.getElementById('appConfirmOkBtn');
    const cancelBtn = document.getElementById('appConfirmCancelBtn');
    const closeBtn = document.getElementById('appConfirmClose');
    if (!modal || !messageEl || !okBtn) return Promise.resolve(false);

    if (titleEl) titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = confirmText;
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

    modal.classList.add('active');

    return new Promise((resolve) => {
        const finish = (result) => {
            modal.classList.remove('active');
            okBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            resolve(result);
        };
        const onConfirm = () => finish(true);
        const onCancel = () => finish(false);
        const onBackdrop = (e) => { if (e.target === modal) finish(false); };

        okBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
    });
}

function showToast(message, type = 'info') {
    toast.textContent = message;
    toast.className = `toast ${type} show`;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function _collectGridRowsForExport(gridApi) {
    const rows = [];
    if (!gridApi) return rows;
    gridApi.forEachNodeAfterFilterAndSort((node) => {
        if (!node || !node.data) return;
        rows.push(node);
    });
    return rows;
}

function _collectGridColumnsForExport(gridApi) {
    if (!gridApi) return [];
    const cols = (gridApi.getAllDisplayedColumns && gridApi.getAllDisplayedColumns()) || [];
    return cols
        .map((col) => {
            const colDef = col.getColDef ? col.getColDef() : null;
            const field = colDef?.field || col.getColId?.();
            const header = colDef?.headerName || field;
            if (!header) return null;
            return { field, header, col };
        })
        .filter(Boolean);
}

function _getExportCellValue(gridApi, column, node) {
    if (!node) return '';
    let value = null;
    // Prefer the grid's computed value so columns backed by a valueGetter
    // (e.g. Net Profit, Profit %) export correctly instead of reading a raw
    // field that was never stored on node.data.
    if (gridApi?.getValue && column?.col) {
        value = gridApi.getValue(column.col, node);
    } else if (column?.field && node.data) {
        value = node.data[column.field];
    }
    if (value == null) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    
    // Apply valueFormatter if it exists in the column definition
    if (column?.col?.getColDef) {
        const colDef = column.col.getColDef();
        if (colDef?.valueFormatter && typeof colDef.valueFormatter === 'function') {
            value = colDef.valueFormatter({ value, data: node.data });
        }
    }
    
    // Force text format in Excel for values containing special characters or parentheses
    // by prefixing with apostrophe - this ensures Excel treats it as text, not a formula
    const stringValue = String(value);
    if (stringValue.includes('(') || stringValue.includes('-') || stringValue.includes('=')) {
        // Prepend space and apostrophe to force text format in Excel
        // The apostrophe is invisible in Excel but forces text interpretation
        return `'${stringValue}`;
    }
    
    return value;
}

function _buildExportSheetRows(gridApi) {
    const columns = _collectGridColumnsForExport(gridApi);
    const sourceNodes = _collectGridRowsForExport(gridApi);
    return sourceNodes.map((node) => {
        const out = {};
        for (const col of columns) {
            out[col.header] = _getExportCellValue(gridApi, col, node);
        }
        return out;
    });
}

function exportCurrentGridToExcel() {
    if (typeof XLSX === 'undefined') {
        showToast('Excel export library is not loaded', 'error');
        return;
    }

    const workbook = XLSX.utils.book_new();
    let sheetCount = 0;
    const dateStamp = new Date().toISOString().slice(0, 10);

    if (currentView === 'transactions') {
        const rows = _buildExportSheetRows(transactionsGridApi);
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Transactions');
        sheetCount = 1;
    } else if (currentView === 'orders') {
        const rows = _buildExportSheetRows(ordersGridApi);
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Orders');
        sheetCount = 1;
    } else if (currentView === 'products') {
        const rows = _buildExportSheetRows(productsGridApi);
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Products');
        sheetCount = 1;
    } else if (currentView === 'ledgerDetail') {
        const rows = _buildExportSheetRows(ledgerDetailGridApi);
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Ledger Detail');
        sheetCount = 1;
    } else {
        showToast('No AG Grid is available to export in this view', 'warning');
        return;
    }

    const filename = `inventory-${currentView}-${dateStamp}.xlsx`;
    XLSX.writeFile(workbook, filename);
    showToast(`Excel exported (${sheetCount} sheet${sheetCount > 1 ? 's' : ''})`, 'success');
}

/** Fetch delivery status for many orders in one request (PostEx orders are batched
 * server-side via track-bulk-order). Returns [{order_id, delivery_status} | {order_id, error}]. */
async function fetchDeliveryStatusBulk(orderIds) {
    return apiJson('/orders/delivery-status/bulk?save=true', {
        method: 'POST',
        body: orderIds,
        fallback: 'Failed to fetch delivery status'
    });
}

/** Live-fetch delivery status from the courier for selected orders and update the grid.
 * Skips cancelled orders and anything not on PostEx/Couriers Next with a tracking number,
 * since those are the only couriers the bulk-fetch endpoint supports. */
async function fetchDeliveryStatusSelected() {
    if (!ordersGridApi) return;
    const selected = ordersGridApi.getSelectedRows().filter(row => row && row.id !== '__footer__' && (row.order_status || '').toLowerCase() !== 'cancelled');
    if (selected.length === 0) {
        showToast('Select orders to fetch delivery status for', 'warning');
        return;
    }
    const fetchable = selected.filter(row => {
        const courierNormalized = (row.courier || '').trim().toUpperCase();
        const track = (row.tracking_number || '').trim();
        return (courierNormalized === 'POSTEX' || courierNormalized === 'COURIERS NEXT') && track && track !== '-';
    });
    if (fetchable.length === 0) {
        showToast('Selected orders have no PostEx/Couriers Next tracking to fetch', 'warning');
        return;
    }

    const btn = document.getElementById('ordersMoreActionFetchDeliveryStatus');
    if (btn) btn.disabled = true;
    try {
        const results = await fetchDeliveryStatusBulk(fetchable.map(o => o.id));
        const resultsById = new Map(results.map(r => [r.order_id, r]));
        let updated = 0, failed = 0;
        ordersGridApi.forEachNode(node => {
            const result = node.data && resultsById.get(node.data.id);
            if (!result) return;
            if (result.error) { failed++; return; }
            const data = result.delivery_status;
            const updatedRow = { ...node.data, delivery_status: data };
            const derivedStatus = deriveOrderStatusFromLatest(data);
            if (derivedStatus) {
                updatedRow.order_status = derivedStatus;
                if (derivedStatus === 'delivered' && (node.data.piece_received || '').trim().toLowerCase() === 'pending') {
                    updatedRow.piece_received = 'Done';
                }
            }
            node.setData(updatedRow);
            updated++;
        });
        showToast(`Delivery status fetched for ${updated} order${updated === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, failed && !updated ? 'error' : 'success');
    } catch (err) {
        showToast(err.message || 'Failed to fetch delivery status', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/** Build the delivery status report for selected orders from data already on each row -
 * no courier API call. (Live refreshing is what the auto-fetch-on-load and per-row actions
 * are for; this report is just a snapshot of current data.) */
function refreshDeliveryStatusSelected() {
    if (!ordersGridApi) return;
    const selected = ordersGridApi.getSelectedRows().filter(row => (row.order_status || '').toLowerCase() !== 'cancelled');
    if (selected.length === 0) {
        showToast('Select orders to include in the report', 'warning');
        return;
    }
    const report = { delivered: [], returned: [], unfulfilled: [], transit: [], issues: [], failed: [] };
    for (const row of selected) {
        const status = (row.order_status || '').toLowerCase();
        if (status === 'delivered' || status === 'returned' || status === 'unfulfilled') {
            report[status].push({ order: row, note: (row.delivery_status && row.delivery_status.latest_status) || '' });
            continue;
        }
        // Not yet terminal per order_status - fall back to whatever the last stored
        // delivery_status says (CNA/ICA/RFD are delivery-attempt issues, grouped together;
        // no relevant status yet means still in transit, or never fetched at all).
        const derivedStatus = deriveOrderStatusFromLatest(row.delivery_status);
        const isIssue = ['CNA', 'ICA', 'RFD'].includes(derivedStatus);
        const bucket = isIssue ? 'issues' : (derivedStatus || 'transit');
        (report[bucket] || report.transit).push({
            order: row,
            note: (row.delivery_status && row.delivery_status.latest_status) || '',
            issueType: isIssue ? derivedStatus : null
        });
    }
    showDeliveryStatusReportModal(report, selected.length);
}

/** Silently refresh delivery status for non-terminal orders from the last 2 months.
 * Fired once at startup, right after orders finish loading. */
async function autoFetchRecentDeliveryStatus() {
    if (!Array.isArray(orders) || orders.length === 0) return;

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 2);

    const toFetch = orders.filter((order) => {
        const status = (order.order_status || '').toLowerCase();
        if (status === 'delivered' || status === 'returned' || status === 'cancelled') return false;
        const courierNormalized = (order.courier || '').trim().toUpperCase();
        if (courierNormalized !== 'POSTEX' && courierNormalized !== 'COURIERS NEXT') return false;
        const track = (order.tracking_number || '').trim();
        if (!track || track === '-') return false;
        const date = getOrderDateForPeriod(order);
        return !!date && date >= cutoff;
    });
    if (toFetch.length === 0) return;

    try {
        const results = await fetchDeliveryStatusBulk(toFetch.map(o => o.id));
        const resultsById = new Map(results.map(r => [r.order_id, r]));
        if (ordersGridApi) {
            ordersGridApi.forEachNode(node => {
                const result = node.data && resultsById.get(node.data.id);
                if (!result || result.error) return;
                const data = result.delivery_status;
                const updated = { ...node.data, delivery_status: data };
                const derivedStatus = deriveOrderStatusFromLatest(data);
                if (derivedStatus) {
                    updated.order_status = derivedStatus;
                    if (derivedStatus === 'delivered' && (node.data.piece_received || '').trim().toLowerCase() === 'pending') {
                        updated.piece_received = 'Done';
                    }
                }
                node.setData(updated);
            });
        }
    } catch (err) {
        console.error('Auto delivery status fetch failed:', err);
    }
}

async function fetchDeliveryStatus(orderId, courier, trackingNumber) {
    if (!orderId) {
        showToast('Order ID not available', 'error');
        return;
    }
    
    const courierNormalized = (courier || '').trim().toUpperCase();
    const supportsDeliveryRefresh = (
        courierNormalized === 'POSTEX' ||
        courierNormalized === 'COURIERS NEXT'
    );
    if (!supportsDeliveryRefresh) {
        showToast('Delivery status is only available for PostEx and Couriers Next courier', 'warning');
        return;
    }
    
    if (!trackingNumber || trackingNumber === '' || trackingNumber === '-') {
        showToast('Tracking number not available', 'error');
        return;
    }
    
    const modal = document.getElementById('deliveryStatusModal');
    const content = document.getElementById('deliveryStatusContent');
    
    if (!modal || !content) {
        console.error('Modal elements not found');
        showToast('Error: Modal not found', 'error');
        return;
    }
    
    modal.classList.add('active');
    content.innerHTML = '<div class="loading">Fetching delivery status...</div>';
    
    try {
        const url = `${API_BASE}/orders/${orderId}/delivery-status?save=true`;
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const detail = Array.isArray(error.detail) ? error.detail.join(' ') : (error.detail || 'Failed to fetch delivery status');
            throw new Error(detail);
        }
        
        const data = await response.json();
        displayDeliveryStatus(data, orderId);
        // Update order in grid: Delivery, Piece With, order_status (backend already saved when save=true)
        if (ordersGridApi) {
            ordersGridApi.forEachNode(node => {
                if (node.data && node.data.id === orderId) {
                    const updated = { ...node.data, delivery_status: data };
                    // Derive order_status from the LAST courier status, same as backend.
                    const derivedStatus = deriveOrderStatusFromLatest(data);
                    if (derivedStatus) {
                        updated.order_status = derivedStatus;
                        if (derivedStatus === 'delivered' && (node.data.piece_received || '').trim().toLowerCase() === 'pending') {
                            updated.piece_received = 'Done';
                        }
                    }
                    node.setData(updated);
                }
            });
        }
    } catch (error) {
        console.error('Error fetching delivery status:', error);
        content.innerHTML = `<div class="error-message">Error: ${escapeHtml(error.message)}</div>`;
    }
}

function displayDeliveryStatus(data, orderId) {
    const content = document.getElementById('deliveryStatusContent');

    let html = `
        <div class="delivery-status-info">
            <div class="info-row">
                <strong>Courier:</strong> ${escapeHtml(formatCourierForDisplay(data.courier) || '')}
            </div>
            <div class="info-row">
                <strong>Tracking Number:</strong> ${escapeHtml(data.tracking_number || '')}
            </div>
    `;
    
    if (data.customer_name) {
        html += `<div class="info-row"><strong>Customer Name:</strong> ${escapeHtml(data.customer_name)}</div>`;
    }
    if (data.recipient_name) {
        html += `<div class="info-row"><strong>Recipient Name:</strong> ${escapeHtml(data.recipient_name)}</div>`;
    }
    if (data.recipient_contact) {
        html += `<div class="info-row"><strong>Recipient Contact:</strong> ${escapeHtml(data.recipient_contact)}</div>`;
    }
    if (data.order_pickup_date) {
        html += `<div class="info-row"><strong>Pickup Date:</strong> ${escapeHtml(formatDateDDMMYYYY(data.order_pickup_date))}</div>`;
    }
    
    html += `</div><h3 style="margin-top: 20px; margin-bottom: 10px;">Status History</h3><div class="status-timeline">`;
    
    if (data.status_history && data.status_history.length > 0) {
        // API returns oldest first; show most recent first.
        [...data.status_history].reverse().forEach((status, index) => {
            const isActive = status.is_active || index === 0;
            const dateDisplay = status.datetime ? formatDateTimeDDMMYYYY(status.datetime) : '';
            html += `
                <div class="timeline-item ${isActive ? 'active' : ''}">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                        <div class="timeline-date">${escapeHtml(dateDisplay)}</div>
                        <div class="timeline-status">${escapeHtml(status.status || '')}</div>
                    </div>
                </div>
            `;
        });
    } else {
        html += '<div class="no-status">No status history available</div>';
    }
    
    html += '</div>';
    html += '<div class="delivery-status-modal-actions"><button type="button" class="btn btn-primary delivery-status-btn">Refresh status</button></div>';
    content.innerHTML = html;
    content.querySelector('.delivery-status-btn')?.addEventListener('click', () => {
        fetchDeliveryStatus(orderId, data.courier, data.tracking_number);
    });
}

function closeDeliveryStatusModal() {
    const modal = document.getElementById('deliveryStatusModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

const DELIVERY_REPORT_CATEGORIES = [
    { key: 'all', label: 'All orders' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'returned', label: 'Returned' },
    { key: 'transit', label: 'In transit' },
    { key: 'issues', label: 'Issues' },
    { key: 'unfulfilled', label: 'Unfulfilled' },
    { key: 'failed', label: 'Fetch failed' },
];

let deliveryStatusReport = null;

function renderDeliveryStatusReportDetail(key) {
    const detail = document.getElementById('deliveryStatusReportDetail');
    const cards = document.getElementById('deliveryStatusReportCards');
    if (!detail || !deliveryStatusReport) return;
    cards?.querySelectorAll('.status-report-card').forEach(card => {
        card.classList.toggle('active', card.dataset.category === key);
    });
    const entries = key === 'all'
        ? DELIVERY_REPORT_CATEGORIES.filter(c => c.key !== 'all').flatMap(c => deliveryStatusReport[c.key] || []).sort((a, b) => (b.order.order_number || 0) - (a.order.order_number || 0))
        : (deliveryStatusReport[key] || []);
    const label = (DELIVERY_REPORT_CATEGORIES.find(c => c.key === key) || {}).label || key;
    if (entries.length === 0) {
        detail.innerHTML = `<div class="no-status">No orders in ${escapeHtml(label)}.</div>`;
        return;
    }
    const showIssueColumn = key === 'issues' || key === 'all';
    const rows = entries.map(({ order, note, issueType }, i) => {
        const courierNormalized = (order.courier || '').trim().toUpperCase();
        const track = (order.tracking_number || '').trim();
        // Full details come from the courier API, so only offer it where that call can work.
        const canViewDetails = (
            (courierNormalized === 'POSTEX' || courierNormalized === 'COURIERS NEXT') &&
            track && track !== '-'
        );
        return `
        <tr>
            <td>${escapeHtml(order.order_number || '')}</td>
            <td>${escapeHtml(formatCourierForDisplay(order.courier) || '')}</td>
            <td>${escapeHtml(order.tracking_number || '')}</td>
            ${showIssueColumn ? `<td>${issueType ? `<span class="grid-status-badge grid-status-rfd">${escapeHtml(issueType)}</span>` : ''}</td>` : ''}
            <td>${escapeHtml(note || '')}</td>
            <td>${canViewDetails ? `<button type="button" class="status-report-view-btn" data-index="${i}">View</button>` : ''}</td>
        </tr>`;
    }).join('');
    detail.innerHTML = `
        <h3 class="status-report-detail__title">${escapeHtml(label)} (${entries.length})</h3>
        <div class="postex-mismatches-table-wrap">
            <table class="postex-mismatches-table">
                <thead><tr><th>Order #</th><th>Courier</th><th>Tracking</th>${showIssueColumn ? '<th>Issue</th>' : ''}<th>Latest status</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    detail.querySelectorAll('.status-report-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const { order } = entries[Number(btn.dataset.index)];
            fetchDeliveryStatus(order.id, order.courier, order.tracking_number);
        });
    });
}

function showDeliveryStatusReportModal(report, total) {
    deliveryStatusReport = report;
    const modal = document.getElementById('deliveryStatusReportModal');
    const summary = document.getElementById('deliveryStatusReportSummary');
    const cards = document.getElementById('deliveryStatusReportCards');
    if (!modal || !cards) return;

    if (summary) {
        summary.textContent = `Delivery status for ${total} selected order${total === 1 ? '' : 's'}.`;
    }

    const visible = DELIVERY_REPORT_CATEGORIES.filter(c => c.key !== 'failed' || (report.failed || []).length > 0);
    const grandTotal = visible.reduce((sum, c) => sum + (c.key === 'all' ? 0 : (report[c.key] || []).length), 0);
    cards.innerHTML = visible.map(({ key, label }) => {
        const count = key === 'all' ? grandTotal : (report[key] || []).length;
        const pct = grandTotal ? Math.round((count / grandTotal) * 100) : 0;
        return `
        <button type="button" class="status-report-card status-report-card--${key}" data-category="${key}">
            <span class="status-report-card__count">${count}<span class="status-report-card__pct">${pct}%</span></span>
            <span class="status-report-card__label">${escapeHtml(label)}</span>
        </button>`;
    }).join('');
    cards.querySelectorAll('.status-report-card').forEach(card => {
        card.addEventListener('click', () => renderDeliveryStatusReportDetail(card.dataset.category));
    });

    renderDeliveryStatusReportDetail(grandTotal > 0 ? 'all' : visible[0].key);
    modal.classList.add('active');
}

function closeDeliveryStatusReportModal() {
    const modal = document.getElementById('deliveryStatusReportModal');
    if (modal) modal.classList.remove('active');
}

function showPostExAmountMismatchesModal(mismatches) {
    const modal = document.getElementById('postExAmountMismatchesModal');
    const tbody = document.getElementById('postExAmountMismatchesBody');
    if (!modal || !tbody) return;
    tbody.innerHTML = mismatches.map(m => {
        const diff = (m.receivable - m.csv_net_amount).toFixed(2);
        return `<tr><td>${m.order_number}</td><td>${m.receivable.toFixed(2)}</td><td>${m.csv_net_amount.toFixed(2)}</td><td>${diff}</td></tr>`;
    }).join('');
    modal.classList.add('active');
}

function closePostExAmountMismatchesModal() {
    const modal = document.getElementById('postExAmountMismatchesModal');
    if (modal) modal.classList.remove('active');
}

// Close modal when clicking outside or on close button
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('deliveryStatusModal');
    const closeButton = document.getElementById('closeDeliveryStatusModal');
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeDeliveryStatusModal();
            }
        });
    }
    
    if (closeButton) {
        closeButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeDeliveryStatusModal();
        });
    }

    // PostEx amount mismatches modal
    const mismatchesModal = document.getElementById('postExAmountMismatchesModal');
    const closeMismatchesBtn = document.getElementById('closePostExAmountMismatchesModal');
    const closeMismatchesBtn2 = document.getElementById('closePostExAmountMismatchesBtn');
    if (mismatchesModal) {
        mismatchesModal.addEventListener('click', (e) => {
            if (e.target === mismatchesModal) closePostExAmountMismatchesModal();
        });
    }
    if (closeMismatchesBtn) closeMismatchesBtn.addEventListener('click', closePostExAmountMismatchesModal);
    if (closeMismatchesBtn2) closeMismatchesBtn2.addEventListener('click', closePostExAmountMismatchesModal);

    const reportModal = document.getElementById('deliveryStatusReportModal');
    if (reportModal) {
        reportModal.addEventListener('click', (e) => {
            if (e.target === reportModal) closeDeliveryStatusReportModal();
        });
    }
    document.getElementById('closeDeliveryStatusReportModal')?.addEventListener('click', closeDeliveryStatusReportModal);
    document.getElementById('closeDeliveryStatusReportBtn')?.addEventListener('click', closeDeliveryStatusReportModal);
});

// Referenced by inline onclick handlers in index.html.
window.closeModal = closeModal;

