// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Show Fedex as TCS in the app. */
function formatCourierForDisplay(courier) {
    if (courier == null || String(courier).trim() === '') return courier;
    if (String(courier).trim().toLowerCase() === 'fedex') return 'TCS';
    return courier;
}

/** When courier is "Other" and tracking_number is not purely numeric, show tracking_number in the Courier column. Fedex is shown as TCS. */
function getCourierDisplayName(order) {
    if (!order) return '-';
    const courier = (order.courier != null) ? String(order.courier).trim() : '';
    const tracking = (order.tracking_number != null) ? String(order.tracking_number).trim() : '';
    const isOther = courier.toLowerCase() === 'other';
    const trackingIsNotNumeric = tracking !== '' && !/^\d+$/.test(tracking);
    if (isOther && trackingIsNotNumeric) return tracking;
    const raw = courier || '-';
    if (raw === '-') return raw;
    return formatCourierForDisplay(raw) || '-';
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ============================================
// Delivery Status Helpers
// ============================================

function deliveryStatusIncludes(data, needle) {
    if (!data) return false;
    if ((data.latest_status || '').includes(needle)) return true;
    const history = data.status_history || [];
    for (const item of history) {
        if ((item.status || '').includes(needle)) return true;
    }
    return false;
}

/** True if delivery status contains "Return to KARACHI" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesReturned(data) {
    return deliveryStatusIncludes(data, 'Return to KARACHI');
}

/** True if delivery status contains "Delivered to Customer" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesDelivered(data) {
    return deliveryStatusIncludes(data, 'Delivered to Customer');
}

/** True if delivery status contains "Attempt Made: RFD" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesRFD(data) {
    return deliveryStatusIncludes(data, 'Attempt Made: RFD');
}

/** True if delivery status contains "Attempt Made: ICA" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesICA(data) {
    return deliveryStatusIncludes(data, 'Attempt Made: ICA');
}

/** True if delivery status contains "Attempt Made: CNA" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesCNA(data) {
    return deliveryStatusIncludes(data, 'Attempt Made: CNA');
}

/**
 * Classify a status text into one of the relevant order statuses.
 */
function classifyStatus(statusText) {
    if (!statusText) return null;
    const statusLower = statusText.toLowerCase();
    // Check for return-related statuses (Return to KARACHI, Returned at Merchant Warehouse, etc.)
    if (statusLower.includes('return')) return 'returned';
    if (statusLower.includes('delivered to customer')) return 'delivered';
    if (statusLower.includes('attempt made: rfd')) return 'RFD';
    if (statusLower.includes('attempt made: ica')) return 'ICA';
    if (statusLower.includes('attempt made: cna')) return 'CNA';
    return null;
}

/**
 * Derive order_status by finding the most recent RELEVANT status from delivery history.
 * Relevant statuses are: delivered, returned, RFD, ICA, CNA.
 * Mirrors backend _derive_order_status_from_latest behaviour.
 */
function deriveOrderStatusFromLatest(data) {
    if (!data) return null;

    const history = data.status_history || [];
    
    // Sort by datetime ascending (oldest first, newest last)
    const sorted = [...history].sort((a, b) => {
        const dtA = a.datetime || '';
        const dtB = b.datetime || '';
        return dtA.localeCompare(dtB);
    });
    
    // Find the last relevant status by iterating from newest to oldest
    for (let i = sorted.length - 1; i >= 0; i--) {
        const statusText = (sorted[i].status || '').trim();
        const classified = classifyStatus(statusText);
        if (classified) return classified;
    }
    
    // Fallback: check latest_status field if no relevant status found in history
    const latest = (data.latest_status || '').trim();
    if (latest) {
        const classified = classifyStatus(latest);
        if (classified) return classified;
    }
    
    return null;
}
