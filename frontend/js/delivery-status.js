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

/** `silent: true` is for instant client-side guard/validation messages (locked editing,
 * missing selection, invalid input) shown while the form/modal that triggered them is
 * still open - the user sees and fixes those in place, so they'd only be noise in
 * notification history. Leave it unset for actual action outcomes (saves, syncs,
 * exports, generations, fetches - success or failure) so those survive the 3s toast. */
function showToast(message, type = 'info', { silent = false } = {}) {
    toast.textContent = message;
    toast.className = `toast ${type} show`;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);

    if (!silent) addNotification(message, type);
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
    // All grid columns, not just the currently displayed ones - hidden columns (e.g. orders'
    // Tracking #, Items, Date) still export, since they hold real data the user may want.
    const cols = (gridApi.getAllGridColumns && gridApi.getAllGridColumns()) || [];
    return cols
        .map((col) => {
            const colDef = col.getColDef ? col.getColDef() : null;
            if (colDef?.checkboxSelection) return null; // row-select column, not real data
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

    // Apply valueFormatter before the array/object fallback below - some columns'
    // valueGetter returns a Date (e.g. order_receiving_date), which is a JS object
    // and would otherwise get JSON.stringify'd instead of formatted.
    if (column?.col?.getColDef) {
        const colDef = column.col.getColDef();
        if (colDef?.valueFormatter && typeof colDef.valueFormatter === 'function') {
            value = colDef.valueFormatter({ value, data: node.data });
        }
    }

    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
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
        showToast('Excel export library is not loaded', 'error', { silent: true });
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
        showToast('No AG Grid is available to export in this view', 'warning', { silent: true });
        return;
    }

    const filename = `inventory-${currentView}-${dateStamp}.xlsx`;
    XLSX.writeFile(workbook, filename);
    showToast(`Excel exported (${sheetCount} sheet${sheetCount > 1 ? 's' : ''})`, 'success');
}

/** Merge freshly-fetched delivery status onto whatever was on file - an empty
 * status_history from the API (transient courier hiccup, etc.) must not blow away
 * history already on record. */
function mergeDeliveryStatusData(previous, incoming) {
    if (incoming && Array.isArray(incoming.status_history) && incoming.status_history.length > 0) return incoming;
    if (previous && Array.isArray(previous.status_history) && previous.status_history.length > 0) {
        return { ...incoming, status_history: previous.status_history };
    }
    return incoming;
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

/** Live-fetch delivery status for selected orders (skipping cancelled orders and anything
 * not on PostEx/Couriers Next with a tracking number, since those are the only couriers the
 * bulk-fetch endpoint supports), then always show the delivery status report - orders that
 * couldn't be live-fetched are still included in the report from whatever data is on file. */
async function fetchDeliveryStatusSelected() {
    if (!ordersGridApi) return;
    const selected = ordersGridApi.getSelectedRows().filter(row => row && row.id !== '__footer__' && (row.order_status || '').toLowerCase() !== 'cancelled');
    if (selected.length === 0) {
        showToast('Select orders to fetch delivery status for', 'warning', { silent: true });
        return;
    }
    const fetchable = selected.filter(row => {
        const courierNormalized = (row.courier || '').trim().toUpperCase();
        const track = (row.tracking_number || '').trim();
        return (courierNormalized === 'POSTEX' || courierNormalized === 'COURIERS NEXT') && track && track !== '-';
    });
    if (fetchable.length === 0) {
        refreshDeliveryStatusSelected();
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
            const data = mergeDeliveryStatusData(node.data.delivery_status, result.delivery_status);
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
        refreshDeliveryStatusSelected();
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
        showToast('Select orders to include in the report', 'warning', { silent: true });
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
                const data = mergeDeliveryStatusData(node.data.delivery_status, result.delivery_status);
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

/** Normalize a Pakistani phone number to E.164 digits (92XXXXXXXXXX, no "+") - handles
 * the common local "03XXXXXXXXX" format Shopify addresses are usually entered in, as well
 * as numbers already given with a "92" or "+92" country code. */
function normalizePakPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) return '92' + digits.slice(1);
    if (digits.startsWith('92')) return digits;
    if (digits.startsWith('3')) return '92' + digits;
    return digits;
}

/** Customer name/phone (same /orders/shipping-info endpoint the Courier Payment Report
 * uses - reads shopify_orders' stored customer_name/customer_phone, captured once at
 * order-sync time, not a live Shopify lookup) alongside the courier delivery status.
 * Errors are swallowed - the popup still works without this. */
async function fetchOrderCustomerInfo(orderId) {
    try {
        const results = await apiJson('/orders/shipping-info', { method: 'POST', body: [orderId], fallback: 'Failed to load customer info' });
        const info = results?.[0];
        return { name: info?.customer_name || '', phone: info?.phone || '' };
    } catch (error) {
        console.error('Error loading customer info:', error);
        return { name: '', phone: '' };
    }
}

async function fetchDeliveryStatus(orderId, courier, trackingNumber, force = false) {
    if (!orderId) {
        showToast('Order ID not available', 'error', { silent: true });
        return;
    }

    const courierNormalized = (courier || '').trim().toUpperCase();
    const supportsDeliveryRefresh = (
        courierNormalized === 'POSTEX' ||
        courierNormalized === 'COURIERS NEXT'
    );
    if (!supportsDeliveryRefresh) {
        showToast('Delivery status is only available for PostEx and Couriers Next courier', 'warning', { silent: true });
        return;
    }

    if (!trackingNumber || trackingNumber === '' || trackingNumber === '-') {
        showToast('Tracking number not available', 'error', { silent: true });
        return;
    }

    const modal = document.getElementById('deliveryStatusModal');
    const content = document.getElementById('deliveryStatusContent');

    if (!modal || !content) {
        console.error('Modal elements not found');
        showToast('Error: Modal not found', 'error', { silent: true });
        return;
    }
    
    modal.classList.add('active');
    // Keep whatever's already shown (e.g. a previous fetch's data) visible while
    // this one is in flight, instead of blanking the modal - only show the loading
    // state on a genuinely first fetch, when there's nothing to preserve.
    const hasExistingData = !!content.querySelector('.delivery-status-info');
    const refreshBtn = content.querySelector('.delivery-status-btn');
    if (hasExistingData && refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing...';
    } else {
        content.innerHTML = '<div class="loading">Fetching delivery status...</div>';
    }

    try {
        const url = `${API_BASE}/orders/${orderId}/delivery-status?save=true${force ? '&force=true' : ''}`;
        const [response, customerInfo] = await Promise.all([
            fetch(url, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            }),
            fetchOrderCustomerInfo(orderId)
        ]);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const detail = Array.isArray(error.detail) ? error.detail.join(' ') : (error.detail || 'Failed to fetch delivery status');
            throw new Error(detail);
        }

        const data = await response.json();
        let displayedData = data;
        // Update order in grid: Delivery, Piece With, order_status (backend already saved when save=true)
        if (ordersGridApi) {
            ordersGridApi.forEachNode(node => {
                if (node.data && node.data.id === orderId) {
                    const merged = mergeDeliveryStatusData(node.data.delivery_status, data);
                    displayedData = merged;
                    const updated = { ...node.data, delivery_status: merged };
                    // Derive order_status from the LAST courier status, same as backend.
                    const derivedStatus = deriveOrderStatusFromLatest(merged);
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
        displayDeliveryStatus(displayedData, orderId, customerInfo);
    } catch (error) {
        console.error('Error fetching delivery status:', error);
        if (hasExistingData) {
            showToast(error.message || 'Failed to fetch delivery status', 'error');
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = 'Refresh status';
            }
        } else {
            content.innerHTML = `<div class="error-message">Error: ${escapeHtml(error.message)}</div>`;
        }
    }
}

function displayDeliveryStatus(data, orderId, customerInfo) {
    const content = document.getElementById('deliveryStatusContent');
    const { name, phone } = customerInfo || {};

    let html = `
        <div class="delivery-status-info">
            <div class="info-row">
                <strong>Courier:</strong> ${escapeHtml(formatCourierForDisplay(data.courier) || '')}
            </div>
            <div class="info-row">
                <strong>Tracking Number:</strong> ${escapeHtml(data.tracking_number || '')}
            </div>
    `;

    if (name) {
        html += `<div class="info-row"><strong>Customer Name:</strong> ${escapeHtml(name)}</div>`;
    }
    if (phone) {
        const waNumber = normalizePakPhone(phone);
        const displayPhone = waNumber ? `+${waNumber}` : phone;
        const waLink = waNumber
            ? `<a href="https://web.whatsapp.com/send?phone=${waNumber}" target="_blank" rel="noopener noreferrer" class="whatsapp-chat-link" title="Chat on WhatsApp"><i class="fa-brands fa-whatsapp"></i></a>`
            : '';
        html += `<div class="info-row"><strong>Phone:</strong> ${escapeHtml(displayPhone)} ${waLink}</div>`;
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
        fetchDeliveryStatus(orderId, data.courier, data.tracking_number, true);
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

/** PostEx timestamps carry their own +0500 offset; take the calendar date from the string
 *  rather than via Date, which would shift it for viewers in other timezones. */
function formatPostExDate(value) {
    if (!value) return '-';
    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '-';
}

function showPostExSettlementsModal(data) {
    const modal = document.getElementById('postExSettlementsModal');
    const tbody = document.getElementById('postExSettlementsBody');
    const summaryEl = document.getElementById('postExSettlementsSummary');
    const noteEl = document.getElementById('postExSettlementsNote');
    if (!modal || !tbody) return;

    const rows = data.settlements || [];
    const num = (v) => Number(v || 0).toFixed(2);
    tbody.innerHTML = rows.length
        ? rows.map(r => `<tr><td>${r.order_number}${r.corrected ? ' <em>(corrected)</em>' : ''}</td><td>${r.folio || '-'}</td><td>${r.order_status}</td>` +
            `<td>${formatPostExDate(r.settlement_date)}</td><td>${num(r.invoice_payment)}</td>` +
            `<td>${num(r.delivery_charge)}</td><td>${num(r.tax_amount)}</td><td>${num(r.receivable)}</td></tr>`).join('')
        : '<tr><td colspan="8">No orders were ready to settle.</td></tr>';

    if (summaryEl) {
        const totalReceivable = rows.reduce((sum, r) => sum + Number(r.receivable || 0), 0);
        summaryEl.textContent = `${data.message || ''} Checked ${data.checked || 0} order(s); ` +
            `total receivable across the ${rows.length} listed: ${totalReceivable.toFixed(2)}.`;
    }
    if (noteEl) {
        noteEl.textContent = rows.length
            ? 'Tax is derived from the order value (2% income + 2% sales withholding); PostEx does not report it. Uploading the CPR CSV later replaces it with the exact figures.'
            : '';
    }
    modal.classList.add('active');
}

function closePostExSettlementsModal() {
    const modal = document.getElementById('postExSettlementsModal');
    if (modal) modal.classList.remove('active');
}

/** Full report shown right after a PostEx CSV upload: net receivable and the other
 * totals the upload derived, plus the per-order breakdown behind them, including any
 * receivable-vs-CSV-NET_AMOUNT mismatch inline (mismatch rows highlighted, no separate
 * popup). Built entirely from the upload response (order_breakdown/totals) - no refetch. */
function showPostExUploadReportModal(data) {
    const modal = document.getElementById('postExUploadReportModal');
    const statsEl = document.getElementById('postExUploadReportStats');
    const tbody = document.getElementById('postExUploadReportBody');
    const summaryEl = document.getElementById('postExUploadReportSummary');
    if (!modal || !statsEl || !tbody) return;

    const orderNum = (o) => parseInt(String(o.order_number).replace(/\D/g, ''), 10) || 0;
    const orders = [...(data.order_breakdown || [])].sort((a, b) =>
        (b.mismatch - a.mismatch) || (orderNum(b) - orderNum(a)));
    const t = data.totals || {};
    const num = (v) => Number(v || 0).toFixed(2);
    const stat = (label, value, opts = {}) => `
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">${escapeHtml(label)}</span>
                <span class="stat-value"${opts.color ? ` style="color: ${opts.color};"` : ''}>${opts.raw ? value : `Rs ${num(value)}`}</span>
            </div>
        </div>`;
    const netColor = Number(t.net_receivable || 0) < 0 ? 'var(--danger)' : 'var(--success)';
    const mismatchCount = orders.filter((o) => o.mismatch).length;
    statsEl.innerHTML = [
        stat('Total Order Value', t.total_amount),
        stat('Advance Received', t.advance_total),
        stat('Gross COD', t.cod_total),
        stat('Returned Orders', t.returned_total),
        stat('Delivery Charges', t.delivery_charges),
        stat('Taxes (SST)', t.taxes),
        stat('Net Receivable', t.net_receivable, { color: netColor }),
        stat('Mismatched Orders', mismatchCount, { raw: true, color: mismatchCount > 0 ? 'var(--danger)' : 'var(--success)' }),
    ].join('');

    tbody.innerHTML = orders.length
        ? orders.map((o) => {
            const diff = o.mismatch ? num(o.receivable - o.csv_net_amount) : null;
            return `
            <tr class="${o.mismatch ? 'postex-report-row--mismatch' : ''}">
                <td>${escapeHtml(String(o.order_number ?? ''))}</td>
                <td>${escapeHtml(o.folio || '-')}</td>
                <td>${escapeHtml(o.order_status || '-')}</td>
                <td>${num(o.total_amount)}</td>
                <td>${num(o.advance_amount)}</td>
                <td>${num(o.cod)}</td>
                <td>${num(o.delivery_charge)}</td>
                <td>${num(o.tax_amount)}</td>
                <td>${num(o.receivable)}</td>
                <td>${o.csv_net_amount != null ? num(o.csv_net_amount) : '-'}</td>
                <td>${diff != null ? diff : '-'}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="11">No orders were updated by this CSV.</td></tr>';

    if (summaryEl) {
        summaryEl.textContent = `${orders.length} order(s) from this upload, net receivable Rs ${num(t.net_receivable)}.`
            + (mismatchCount > 0 ? ` ${mismatchCount} order(s) differ from the CSV's NET_AMOUNT (highlighted).` : '');
    }
    modal.classList.add('active');
}

function closePostExUploadReportModal() {
    const modal = document.getElementById('postExUploadReportModal');
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

    // PostEx settlements modal
    const settlementsModal = document.getElementById('postExSettlementsModal');
    if (settlementsModal) {
        settlementsModal.addEventListener('click', (e) => {
            if (e.target === settlementsModal) closePostExSettlementsModal();
        });
    }
    document.getElementById('closePostExSettlementsModal')?.addEventListener('click', closePostExSettlementsModal);
    document.getElementById('closePostExSettlementsBtn')?.addEventListener('click', closePostExSettlementsModal);

    // PostEx upload report modal
    const uploadReportModal = document.getElementById('postExUploadReportModal');
    if (uploadReportModal) {
        uploadReportModal.addEventListener('click', (e) => {
            if (e.target === uploadReportModal) closePostExUploadReportModal();
        });
    }
    document.getElementById('closePostExUploadReportModal')?.addEventListener('click', closePostExUploadReportModal);
    document.getElementById('closePostExUploadReportBtn')?.addEventListener('click', closePostExUploadReportModal);

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

