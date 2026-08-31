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

/** POST `body` as JSON and yield each newline-delimited JSON object from the response
 * as it streams in, rather than waiting for the whole body. Used by endpoints that
 * report progress incrementally (POST /orders/fulfill books parcels one at a time). */
async function* apiJsonStream(path, { body, fallback = 'Request failed', ...options } = {}) {
    const response = await apiRequest(path, {
        method: 'POST',
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: JSON.stringify(body),
        fallback,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) yield JSON.parse(line);
        }
    }
    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail);
}

/** True when an order can produce a printable airway bill - both couriers need only a
 * tracking number; the airway bill itself (PDF for PostEx, resolved link for Couriers
 * Next) is always fetched live from the backend, never read off the order object. */
function orderHasAirwayBill(order) {
    if (!order) return false;
    const courier = getCourierDisplayName(order);
    return (courier === 'PostEx' || courier === 'Couriers Next') && !!order.tracking_number;
}

/** Open a blank tab right now, synchronously, so it's still inside the click handler's
 * call stack - a plain window.open called AFTER an await falls outside that window in
 * most browsers and gets blocked (with an inconsistent, sometimes-delayed fallback UI,
 * not a clean single tab). Navigate the returned handle to the real URL once it's known,
 * via navigateTab, instead of calling window.open a second time. */
function openBlankTab() {
    return window.open('', '_blank');
}

/** Point an already-open tab (from openBlankTab) at a URL, once it's known. Closes the
 * tab instead if the popup was blocked after all (handle exists but navigation is a
 * no-op), so a silently-blocked tab doesn't sit open on about:blank. */
function navigateTab(tab, url) {
    if (!tab || tab.closed) return;
    tab.location.href = url;
}

function airwayBillsPdfFilename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `airway_bills_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
}

/** Prints/downloads one or more orders' airway bills as a single grouped action - no
 * per-order button, this is the only entry point. Both couriers combine every requested
 * order into one document: the backend returns every PostEx order's bill as one merged
 * PDF (chunking get-invoice calls as needed); Couriers Next's invoicehtml.php accepts a
 * comma-separated order_id list and renders every one on the same page (resolved live
 * through the backend, since only GetOrderList.php - not any tracking lookup - ever
 * returns their internal order_id again after booking).
 *
 * Every destination tab is opened blank up front, before any await, and navigated once
 * its URL is known (see openBlankTab/navigateTab) - exactly one tab per document, opened
 * the instant the button is clicked, with no popup-blocker delay or duplicate fallback tab.
 *
 * Returns the count of orders that had nothing to print (no tracking number yet, or an
 * unsupported courier) so the caller can report it. */
async function printAirwayBillsForOrders(orders) {
    const eligible = orders.filter(orderHasAirwayBill);
    const skipped = orders.length - eligible.length;
    if (eligible.length === 0) {
        throw new Error('No selected orders have an airway bill available');
    }

    const postexOrders = eligible.filter(o => getCourierDisplayName(o) === 'PostEx');
    const couriersNextOrders = eligible.filter(o => getCourierDisplayName(o) === 'Couriers Next');

    // Opened synchronously, still within this click's call stack, before any fetch starts.
    const postexTab = postexOrders.length > 0 ? openBlankTab() : null;
    const couriersNextTab = couriersNextOrders.length > 0 ? openBlankTab() : null;

    if (postexOrders.length > 0) {
        const res = await apiRequest('/orders/postex-airway-bills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(postexOrders.map(o => o.id)),
            fallback: 'Failed to fetch airway bills'
        });
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        navigateTab(postexTab, url);
        setTimeout(() => window.URL.revokeObjectURL(url), 60000);
    }

    if (couriersNextOrders.length > 0) {
        const { url } = await apiJson('/orders/couriers-next-airway-bills', {
            method: 'POST',
            body: couriersNextOrders.map(o => o.id),
            fallback: 'Failed to fetch airway bills'
        });
        navigateTab(couriersNextTab, url);
    }

    return skipped;
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

/** Normalize courier names for resilient matching. Mirrors backend _normalize_courier_name. */
function normalizeCourierName(courier) {
    return (courier || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Classify a status text into one of the relevant order statuses.
 * Return detection is courier-specific: PostEx flags a return as soon as the parcel is en
 * route back to the merchant warehouse; Couriers Next only reports the parcel reaching its
 * office. Mirrors backend _classify_status exactly.
 */
function classifyStatus(statusText, courierNormalized) {
    if (!statusText) return null;
    const statusLower = statusText.toLowerCase();
    if (courierNormalized === 'postex' && statusLower.includes('en route to merchant warehouse')) return 'returned';
    if ((courierNormalized === 'couriersnext' || courierNormalized === 'couriernext') && statusLower.includes('parcel return to office')) return 'returned';
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

    const courierNormalized = normalizeCourierName(data.courier);
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
        const classified = classifyStatus(statusText, courierNormalized);
        if (classified) return classified;
    }

    // Fallback: check latest_status field if no relevant status found in history
    const latest = (data.latest_status || '').trim();
    if (latest) {
        const classified = classifyStatus(latest, courierNormalized);
        if (classified) return classified;
    }

    return null;
}
