// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** When courier is "Other" and tracking_number is not purely numeric, show tracking_number in the Courier column. */
function getCourierDisplayName(order) {
    if (!order) return '-';
    const courier = (order.courier != null) ? String(order.courier).trim() : '';
    const tracking = (order.tracking_number != null) ? String(order.tracking_number).trim() : '';
    const isOther = courier.toLowerCase() === 'other';
    const trackingIsNotNumeric = tracking !== '' && !/^\d+$/.test(tracking);
    if (isOther && trackingIsNotNumeric) return tracking;
    return courier || '-';
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
