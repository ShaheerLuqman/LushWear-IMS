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
 * The PostEx PDF is downloaded as a file; Couriers Next's HTML page is opened in a tab,
 * blank up front before any await and navigated once its URL is known (see
 * openBlankTab/navigateTab) - opened the instant the button is clicked, with no
 * popup-blocker delay or duplicate fallback tab.
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
        const a = document.createElement('a');
        a.href = url;
        a.download = airwayBillsPdfFilename();
        document.body.appendChild(a);
        a.click();
        a.remove();
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

/** A `<tr>` spanning the whole table with a spinner, for a tbody's loading state. */
function tableLoadingRow(colspan, text) {
    return `<tr><td colspan="${colspan}" class="table-loading-cell">
        <div class="content-loading-spinner"></div>${escapeHtml(text)}</td></tr>`;
}

/** AG Grid's `overlayLoadingTemplate` - fills the overlay area itself (rather than
 *  relying on ag-grid's own centering, which the alpine theme doesn't apply here) so the
 *  spinner is centered over the grid instead of stuck at the left. */
const AG_GRID_LOADING_OVERLAY_HTML = `<div class="content-loading" style="width: 100%; height: 100%; min-height: 0;">
    <div class="content-loading-spinner"></div><p class="content-loading-text">Loading...</p>
</div>`;

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
// Date Range Picker (easepick)
// ============================================

/** Preset ranges shared by every date-range popup in the app: Today/Yesterday/Last 7 &
 * 30 Days/This & Last Month, anchored to PKT "today" since order/bill dates are PKT-based
 * (not the browser's local clock), plus "All Time" back to the oldest orders period (see
 * ORDERS_PERIOD_OLDEST_MONTH/YEAR in data-api.js) - omit it with `includeAllTime: false`
 * where fetching every order ever isn't a range worth offering (the Orders page itself).
 * PresetPlugin only auto-fills its own 6 built-in ranges when left fully unconfigured, so
 * adding "All Time" means building the whole list ourselves - the same way PresetPlugin
 * builds its own defaults. */
function buildDateRangePresets({ includeAllTime = true } = {}) {
    const DateTime = window.easepick.DateTime;
    const pkt = getPKTDate();
    const y = pkt.getFullYear(), m = pkt.getMonth();
    const today = new Date(y, m, pkt.getDate());
    const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
    const presets = {};
    if (includeAllTime) {
        const oldestStart = ordersPeriodStartEnd(ORDERS_PERIOD_OLDEST_MONTH, ORDERS_PERIOD_OLDEST_YEAR).start;
        presets['All Time'] = [new DateTime(oldestStart), new DateTime(today)];
    }
    return Object.assign(presets, {
        'Today': [new DateTime(today), new DateTime(today)],
        'Yesterday': [new DateTime(addDays(-1)), new DateTime(addDays(-1))],
        'Last 7 Days': [new DateTime(addDays(-6)), new DateTime(today)],
        'Last 30 Days': [new DateTime(addDays(-29)), new DateTime(today)],
        'This Month': [new DateTime(new Date(y, m, 1)), new DateTime(new Date(y, m + 1, 0))],
        'Last Month': [new DateTime(new Date(y, m - 1, 1)), new DateTime(new Date(y, m, 0))],
    });
}

/**
 * Wire an easepick date-range popup (RangePlugin + PresetPlugin) onto `triggerBtn` -
 * single-month calendar, viewport-clamped, themed to the app's own colors/radius/shadow,
 * plus a small "x" button inserted right after `triggerBtn` to clear it. This is the one
 * mechanism behind every date-range filter in the app (Orders, Courier Performance, Courier
 * Payment Report, Print Airway Bill, Product/City Analytics) - each caller keeps owning its
 * own {from,to} state, button label, and reload; this only drives the popup and the "x"
 * itself:
 *   - onSelect(from, to) fires with YYYY-MM-DD strings for a picked range (a preset or a
 *     plain two-click custom range - both auto-apply and close immediately).
 *   - onClear() fires when the "x" is clicked. Omit it (leave `setClearable(true)` uncalled)
 *     on a screen that has no "no range" state to clear to, like the analytics views, which
 *     always show *some* period - the "x" then just stays hidden.
 *   - presets overrides the default preset list with a caller-built customPreset object (see
 *     buildDateRangePresets for the shape) - product/city analytics need their own (e.g. a
 *     "last 7 days" ending yesterday, not today, since today's data is still incomplete).
 * Returns { picker, setLabel(text, title), setClearable(bool) } so the caller can keep the
 * trigger's own text/tooltip and the "x" button's visibility in sync after any change to
 * its range state - not just a select/clear here, but e.g. a page-wide "Clear filters"
 * button resetting this range too.
 */
function createDateRangePicker(triggerBtn, { onSelect, onClear, presets } = {}) {
    if (!triggerBtn || !window.easepick) return null;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'date-range-picker-clear';
    clearBtn.style.display = 'none';
    clearBtn.title = 'Clear date range';
    clearBtn.innerHTML = '&times;';
    triggerBtn.insertAdjacentElement('afterend', clearBtn);
    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof onClear === 'function') onClear();
    });

    const picker = new window.easepick.create({
        element: triggerBtn,
        css: ['https://cdn.jsdelivr.net/npm/@easepick/bundle@1.2.1/dist/index.css'],
        zIndex: 9999,
        format: 'DD/MM/YYYY',
        grid: 1,
        calendars: 1,
        // Preset buttons only call setDateRange()+select on click when autoApply is true -
        // with it false they silently stash the pick and wait for a separate Apply click
        // (the footer autoApply:false would otherwise render), so a preset click looks like
        // a no-op. true also means a plain two-click custom range applies immediately.
        autoApply: true,
        plugins: ['RangePlugin', 'PresetPlugin'],
        PresetPlugin: { position: 'left', customPreset: presets || buildDateRangePresets() },
    });

    // easepick renders into a shadow root, so the app's own stylesheet can't reach it -
    // these just map its color variables onto the app's own (already theme-aware) ones,
    // which keeps it in sync with light/dark mode without duplicating either palette.
    const themeStyle = document.createElement('style');
    themeStyle.textContent = `
        :host {
            --color-bg-default: var(--bg-card);
            --color-bg-secondary: var(--bg-secondary);
            --color-fg-default: var(--text-primary);
            --color-fg-secondary: var(--text-secondary);
            --color-fg-muted: var(--text-muted);
            --color-fg-primary: var(--accent-primary);
            --color-border-default: var(--border-color);
            --color-bg-inrange: color-mix(in srgb, var(--accent-primary) 18%, transparent);
            --color-btn-primary-bg: var(--accent-primary);
            --color-btn-primary-fg: #fff;
            --color-btn-primary-border: var(--accent-primary);
            --color-btn-secondary-bg: var(--bg-secondary);
            --color-btn-secondary-fg: var(--text-secondary);
            --color-btn-secondary-border: var(--border-color);
            --border-radius: 8px;
            font-family: var(--font-primary);
        }
        .container {
            max-width: calc(100vw - 16px);
            overflow: hidden;
            border-radius: var(--radius-lg);
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-lg);
        }
    `;
    picker.ui.shadowRoot.appendChild(themeStyle);

    picker.on('select', (e) => {
        const { start, end } = e.detail;
        if (start && end && typeof onSelect === 'function') onSelect(start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'));
    });

    // easepick's own adjustPosition() only flips left/up when there's room for the whole
    // popup on the other side, which there often isn't near a header's right-aligned
    // button - re-clamp its actual rendered box into the viewport after it shows.
    picker.on('show', () => {
        const container = picker.ui.container;
        const rect = container.getBoundingClientRect();
        const left = parseFloat(container.style.left) || 0;
        const top = parseFloat(container.style.top) || 0;
        const overflowRight = rect.right - (window.innerWidth - 8);
        const overflowLeft = 8 - rect.left;
        if (overflowRight > 0) container.style.left = `${left - overflowRight}px`;
        else if (overflowLeft > 0) container.style.left = `${left + overflowLeft}px`;
        const overflowBottom = rect.bottom - (window.innerHeight - 8);
        if (overflowBottom > 0) container.style.top = `${top - overflowBottom}px`;
    });

    return {
        picker,
        setLabel(text, title) {
            triggerBtn.textContent = text;
            if (title !== undefined) triggerBtn.title = title;
        },
        setClearable(clearable) {
            clearBtn.style.display = clearable ? '' : 'none';
        },
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

/* PostEx parks a parcel here after failed attempts and waits for the merchant to say
   retry-or-return. Matched on the history code, not the message, which PostEx words
   differently across endpoints. Mirrors backend POSTEX_UNDER_REVIEW_CODE. */
const POSTEX_UNDER_REVIEW_CODE = '0008';

/**
 * True if the parcel is awaiting shipper advice right now - i.e. under review is the
 * NEWEST event, not one a later attempt or return has already superseded. Only these can
 * be advised - reattempted or returned. Mirrors backend _delivery_status_is_under_review.
 */
function deliveryStatusIsUnderReview(data) {
    if (!data) return false;
    const history = data.status_history || [];
    if (history.length > 0) {
        const newest = history.reduce((a, b) => ((b.datetime || '') >= (a.datetime || '') ? b : a));
        return String(newest.status_code || '').trim() === POSTEX_UNDER_REVIEW_CODE;
    }
    return (data.latest_status || '').trim().toLowerCase() === 'delivery under review';
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
