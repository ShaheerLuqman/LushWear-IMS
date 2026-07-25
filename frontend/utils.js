// ============================================
// Utilities
// ============================================

/** Viewport below which the app switches to its mobile layout. Keep in sync with
 *  the `max-width: 820px` breakpoint in styles.css. */
const MOBILE_BREAKPOINT = 820;

function isMobileViewport() {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

/**
 * Fit columns to the viewport on desktop only.
 *
 * The orders grid alone is ~2100px of columns; squeezing that into a phone
 * viewport makes every cell unreadable. On mobile we keep the columns at their
 * natural widths and let AG Grid scroll horizontally instead.
 */
function sizeGridColumns(api) {
    if (!api || isMobileViewport()) return;
    api.sizeColumnsToFit();
}

/**
 * Fetch `path` (relative to API_BASE) and throw a normalised Error on failure.
 *
 * FastAPI returns errors as `{detail: ...}` where detail is a string, or an array
 * of validation objects for a 422. `fallback` is used when the body has no usable
 * detail (empty body, HTML error page, network-level failure).
 *
 * Returns the raw Response - callers read .json()/.blob()/.headers themselves.
 */
async function apiRequest(path, { fallback = 'Request failed', ...options } = {}) {
    const response = await fetch(`${API_BASE}${path}`, options);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(apiErrorMessage(body, `${fallback} (${response.status})`));
    }
    return response;
}

/** JSON-in/JSON-out wrapper around apiRequest. Pass `body` to send it as JSON. */
async function apiJson(path, { body, ...options } = {}) {
    const opts = { ...options };
    if (body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        opts.body = JSON.stringify(body);
    }
    const response = await apiRequest(path, opts);
    if (response.status === 204) return null;
    return response.json();
}

/** Pull a displayable message out of a FastAPI error body. */
function apiErrorMessage(body, fallback) {
    const detail = body && body.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
        return detail.map((d) => (typeof d === 'string' ? d : d.msg || JSON.stringify(d))).join(' ');
    }
    return fallback;
}

/** Escape for both text and double-quoted attribute contexts. textContent/innerHTML
 *  escapes & < > but leaves `"` raw, which breaks out of an attribute value. */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;');
}

/** Humanize a past timestamp (ms epoch) as "just now" / "5 min ago" / "3 hr ago" / "2 days ago". */
function formatRelativeTime(timestampMs) {
    const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
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
    if (
        statusLower.includes('return') ||
        statusLower.includes('refused by consignee') ||
        statusLower.includes('shipper advice')
    ) return 'returned';
    // Handle both PostEx ("Delivered to Customer") and Courier Next ("Delivered") variants.
    if (statusLower.includes('delivered to customer') || (statusLower.includes('delivered') && !statusLower.includes('undelivered'))) return 'delivered';
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
