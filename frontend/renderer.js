// API Configuration
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) || 'http://127.0.0.1:8000/api';

// ============================================
// Session-token auth
// The PIN gate exchanges the PIN for a token (see runPinGate). We store it for the
// session and attach it to every API request via a fetch wrapper. A 401 from a
// protected route means the token is missing/expired -> re-open the PIN gate.
// ============================================
const AUTH_TOKEN_KEY = 'lushwear_auth_token';

function getAuthToken() {
    try { return sessionStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setAuthToken(token) {
    _authExpiredHandling = false;
    try { if (token) sessionStorage.setItem(AUTH_TOKEN_KEY, token); } catch (e) { /* ignore */ }
}
function clearAuthToken() {
    try { sessionStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) { /* ignore */ }
}

/** True while we are already re-opening the PIN gate after a 401, to avoid repeats. */
let _authExpiredHandling = false;

function isAuthBootstrapUrl(url) {
    // app-pin endpoints are the login itself; their 401s are handled locally (wrong PIN).
    return url.indexOf(API_BASE + '/app-pin/') === 0;
}

function onAuthExpired() {
    if (_authExpiredHandling) return;
    _authExpiredHandling = true;
    clearAuthToken();
    try { showToast('Session expired. Please enter your PIN.', 'warning'); } catch (e) { /* ignore */ }
    try { lockApp(); } catch (e) { /* ignore */ }
}

// Wrap fetch: inject the token on API calls and catch auth failures globally.
(function installAuthFetch() {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const isApi = typeof url === 'string' && url.indexOf(API_BASE) === 0;
        if (isApi) {
            init = Object.assign({}, init);
            const headers = new Headers((init && init.headers) || {});
            const token = getAuthToken();
            if (token && !headers.has('Authorization')) {
                headers.set('Authorization', 'Bearer ' + token);
            }
            init.headers = headers;
        }
        return origFetch(input, init).then((res) => {
            if (isApi && res.status === 401 && !isAuthBootstrapUrl(url)) {
                onAuthExpired();
            }
            return res;
        });
    };
})();

function formatApiErrorDetail(payload) {
    if (!payload || typeof payload !== 'object') {
        return 'Request failed';
    }
    const d = payload.detail;
    if (typeof d === 'string') {
        return d;
    }
    if (Array.isArray(d)) {
        return d
            .map((x) => (x && typeof x === 'object' && x.msg ? x.msg : String(x)))
            .join(' ');
    }
    return 'Request failed';
}

/** PIN gate form submit handler (removed after success so lock-app can re-open the gate). */
let pinGateSubmitHandler = null;

/**
 * Prefetch promises started as soon as the backend is confirmed ready (while the user types
 * their PIN). Awaited in DOMContentLoaded instead of starting fresh fetches after PIN entry.
 */
let _prefetchProductsPromise = null;
let _prefetchOrdersPromise = null;

// State
let products = [];
let orders = [];
let cashbookEntries = [];
let cashbookDailyBalance = null; // Current day's balance from API
let cashbookSelectedDate = null;
let currentView = 'orders';
let productsGridApi = null;
let ordersGridApi = null;
let cashbookIncomingGridApi = null;
let cashbookOutgoingGridApi = null;
let ledgers = [];
let ledgerEntries = [];
let currentLedger = null;
let ledgerDetailGridApi = null;
let updateFooterRow = null; // Will be set in initOrdersGrid
let loadSheetRiderNames = [];
/** Next assignment number for load sheet (format LW-N). Updated when load sheet logs are fetched. */
let nextLoadSheetAssignmentNumber = 1;
// Auto-sync orders every 15 minutes; timer is reset when user clicks sync
const ORDERS_AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
let ordersAutoSyncTimerId = null;
/** Orders grid date column id (for header date range filter). */
const ORDERS_DATE_COLUMN_ID = 'order_receiving_date';
/** Guard: when Order# filter is a full order number (4+ digits) and 0 results, we fetch from DB; avoid duplicate requests */
let ordersFetchByNumberInFlight = null;
/** IDs of orders added temporarily from "fetch by number" search; removed when filter is cleared or changed */
let ordersFetchedByNumberIds = new Set();

const ORDERS_MORE_ACTION_IDS = [
    'ordersMoreActionCreateReplacement',
    'ordersMoreActionUploadPostEx',
    'ordersMoreActionGenerateLoadSheet',
];

function setOrdersMoreToolbarButtonsVisible(show) {
    const disp = show ? 'inline-flex' : 'none';
    ORDERS_MORE_ACTION_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = disp;
    });
}

function syncOrdersBottomActionsWidth() {
    const topActions = document.getElementById('headerOrdersAppActions');
    const bottomActions = document.getElementById('headerOrdersBottomActions');
    if (!topActions || !bottomActions) return;
    const width = Math.ceil(topActions.getBoundingClientRect().width || 0);
    if (width > 0) {
        bottomActions.style.width = `${width}px`;
    }
}

/** When true, user cannot edit anything (grids, forms, sync, bulk update, etc.). Default: locked on open. */
let editLocked = true;

function isEditingAllowed() {
    return !editLocked;
}

function applyEditLockState() {
    const locked = editLocked;
    const lockBtn = document.getElementById('editLockBtn');
    const lockIcon = document.getElementById('editLockIcon');
    const lockTooltip = document.getElementById('editLockTooltip');
    if (lockBtn) {
        lockBtn.classList.toggle('locked', locked);
        if (lockIcon) lockIcon.textContent = locked ? '🔒' : '🔓';
        if (lockTooltip) lockTooltip.textContent = locked ? 'Unlock editing' : 'Lock editing';
    }
    const editButtons = [
        'createLedgerBtn',
        'editLedgerDeleteBtn',
        'bulkUpdateOrderBtn',
        'bulkUpdateCostPriceBtn',
        'recalculateOrderCostsBtn',
        'bulkUpdateDeliveryChargesBtn',
        'bulkUpdateSetDelivered',
        'bulkUpdateSetReturned',
        'bulkUpdateSetCancelled',
        'bulkUpdateSetPieceReceived',
        'refreshDeliveryStatusSelectedBtn',
        'ordersMoreActionCreateReplacement',
        'ordersMoreActionUploadPostEx',
        'ordersMoreActionGenerateLoadSheet',
        'ordersMoreActionGenerateInvoice',
        'ordersMoreActionGeneratePackagingList',
        'syncShopifyBtn',
        'syncOrdersBtn',
        'submitReplacementOrder',
        'bulkUpdateCostPriceSubmit',
        'recalculateOrderCostsSubmit',
        'bulkUpdateDeliveryChargesConfirm',
        'loadSheetModalConfirm',
    ];
    editButtons.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = locked;
    });
    const editLedgerForm = document.getElementById('editLedgerForm');
    if (editLedgerForm) {
        const submitBtn = editLedgerForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = locked;
    }
    const createLedgerForm = document.getElementById('createLedgerForm');
    if (createLedgerForm) {
        const submitBtn = createLedgerForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = locked;
    }
}

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const toast = document.getElementById('toast');

function initChangePinModal() {
    const modal = document.getElementById('changePinModal');
    const form = document.getElementById('changePinForm');
    const errEl = document.getElementById('changePinError');
    const openBtn = document.getElementById('changePinBtn');
    const closeBtn = document.getElementById('changePinModalClose');
    const cancelBtn = document.getElementById('changePinCancelBtn');
    if (!modal || !form) {
        return;
    }

    function openModal() {
        if (errEl) {
            errEl.textContent = '';
        }
        form.reset();
        modal.classList.add('active');
        const cur = document.getElementById('changePinCurrent');
        if (cur) {
            cur.focus();
        }
    }

    function closeModal() {
        modal.classList.remove('active');
    }

    if (openBtn) {
        openBtn.addEventListener('click', openModal);
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }
    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errEl) {
            errEl.textContent = '';
        }
        const current = (document.getElementById('changePinCurrent') || {}).value || '';
        const newPin = (document.getElementById('changePinNew') || {}).value || '';
        const confirm = (document.getElementById('changePinNewConfirm') || {}).value || '';
        if (newPin !== confirm) {
            if (errEl) {
                errEl.textContent = 'New PINs do not match';
            }
            return;
        }
        const saveBtn = document.getElementById('changePinSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = true;
        }
        try {
            const r = await fetch(`${API_BASE}/app-pin/change`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_pin: current,
                    new_pin: newPin,
                    confirm_pin: confirm
                })
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                throw new Error(formatApiErrorDetail(data));
            }
            showToast('PIN updated', 'success');
            closeModal();
        } catch (ex) {
            if (errEl) {
                errEl.textContent = ex.message || 'Could not update PIN';
            }
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
            }
        }
    });
}

/**
 * Block until PIN is verified or first-time setup completes.
 * @returns {Promise<boolean>} false only if server reports app_pin table missing (503).
 */
function runPinGate() {
    const root = document.getElementById('pinGateRoot');
    const titleEl = document.getElementById('pinGateTitle');
    const errEl = document.getElementById('pinGateError');
    const form = document.getElementById('pinGateForm');
    const pinInput = document.getElementById('pinGatePin');
    const confirmWrap = document.getElementById('pinGateConfirmWrap');
    const confirmInput = document.getElementById('pinGateConfirm');
    const submitBtn = document.getElementById('pinGateSubmit');
    const waitingEl = document.getElementById('pinGateWaiting');
    if (!root || !form || !pinInput || !confirmInput || !submitBtn) {
        return Promise.resolve(true);
    }

    if (errEl) {
        errEl.textContent = '';
    }
    submitBtn.disabled = true;

    if (pinGateSubmitHandler) {
        form.removeEventListener('submit', pinGateSubmitHandler);
        pinGateSubmitHandler = null;
    }

    return new Promise((resolve) => {
        let configured = false;

        function detachPinGateSubmit() {
            if (pinGateSubmitHandler && form) {
                form.removeEventListener('submit', pinGateSubmitHandler);
                pinGateSubmitHandler = null;
            }
        }

        async function loadStatus() {
            // Hide the PIN form and show connecting state while backend isn't ready
            if (form) form.style.display = 'none';
            if (titleEl) titleEl.style.display = 'none';
            if (waitingEl) {
                waitingEl.style.display = 'block';
                waitingEl.innerHTML = '<span class="pin-gate-spinner"></span>Connecting to server…';
            }

            for (;;) {
                try {
                    const r = await fetch(`${API_BASE}/app-pin/status`);
                    const data = await r.json().catch(() => ({}));

                    if (r.status === 503) {
                        // Restore form to show the error message
                        if (waitingEl) waitingEl.style.display = 'none';
                        if (form) form.style.display = '';
                        if (titleEl) titleEl.style.display = '';
                        if (errEl) {
                            errEl.textContent = formatApiErrorDetail(data);
                        }
                        submitBtn.disabled = true;
                        detachPinGateSubmit();
                        resolve(false);
                        return;
                    }
                    if (!r.ok) {
                        throw new Error(formatApiErrorDetail(data));
                    }

                    // Backend is ready. (Data is loaded after PIN verify, once we hold a
                    // token — protected routes reject unauthenticated prefetches.)

                    // Hide connecting state, reveal form
                    if (waitingEl) waitingEl.style.display = 'none';
                    if (form) form.style.display = '';
                    if (titleEl) titleEl.style.display = '';

                    configured = !!data.configured;
                    if (titleEl) {
                        titleEl.textContent = configured ? 'Enter PIN' : 'Create your PIN';
                    }
                    if (confirmWrap) {
                        confirmWrap.style.display = configured ? 'none' : 'block';
                    }
                    if (configured) {
                        confirmInput.removeAttribute('required');
                    } else {
                        confirmInput.setAttribute('required', 'required');
                    }
                    pinInput.value = '';
                    confirmInput.value = '';
                    pinInput.focus();
                    submitBtn.disabled = false;
                    break;
                } catch {
                    if (waitingEl) {
                        waitingEl.style.display = 'block';
                        waitingEl.innerHTML = '<span class="pin-gate-spinner"></span>Waiting for server…';
                    }
                    await new Promise((t) => setTimeout(t, 800));
                }
            }
        }

        pinGateSubmitHandler = async function pinGateOnSubmit(ev) {
            ev.preventDefault();
            if (errEl) {
                errEl.textContent = '';
            }
            const pin = pinInput.value;
            const confirm = confirmInput.value;
            if (!configured && pin !== confirm) {
                if (errEl) {
                    errEl.textContent = 'PINs do not match';
                }
                return;
            }
            submitBtn.disabled = true;
            const submitLabel = submitBtn.textContent;
            submitBtn.innerHTML =
                `<span class="btn-spinner"></span>${configured ? 'Verifying…' : 'Creating PIN…'}`;
            try {
                if (!configured) {
                    const r = await fetch(`${API_BASE}/app-pin/setup`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pin, confirm_pin: confirm })
                    });
                    const data = await r.json().catch(() => ({}));
                    if (!r.ok) {
                        throw new Error(formatApiErrorDetail(data));
                    }
                    setAuthToken(data.token);
                    root.hidden = true;
                    pinInput.value = '';
                    confirmInput.value = '';
                    detachPinGateSubmit();
                    resolve(true);
                    return;
                }
                const r = await fetch(`${API_BASE}/app-pin/verify`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) {
                    if (errEl) {
                        errEl.textContent =
                            r.status === 401 ? 'Incorrect PIN' : formatApiErrorDetail(data);
                    }
                    pinInput.value = '';
                    pinInput.focus();
                    return;
                }
                setAuthToken(data.token);
                root.hidden = true;
                pinInput.value = '';
                confirmInput.value = '';
                detachPinGateSubmit();
                resolve(true);
            } catch (ex) {
                if (errEl) {
                    errEl.textContent = ex.message || 'Something went wrong';
                }
            } finally {
                submitBtn.textContent = submitLabel;
                submitBtn.disabled = false;
            }
        };

        form.addEventListener('submit', pinGateSubmitHandler);
        loadStatus();
    });
}

function lockApp() {
    exitOrdersFullScreen();
    const appContainer = document.querySelector('.app-container');
    const root = document.getElementById('pinGateRoot');
    if (!root) {
        return;
    }
    root.hidden = false;
    if (appContainer) {
        appContainer.style.visibility = 'hidden';
        appContainer.style.opacity = '0';
    }
    runPinGate().then((ok) => {
        if (ok && appContainer) {
            appContainer.style.visibility = 'visible';
            setTimeout(() => {
                appContainer.style.opacity = '1';
            }, 10);
        }
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    const loadingScreen = document.getElementById('loadingScreen');
    const appContainer = document.querySelector('.app-container');

    if (loadingScreen) {
        loadingScreen.style.display = 'none';
    }

    if (appContainer) {
        appContainer.style.visibility = 'hidden';
        appContainer.style.opacity = '0';
    }

    initNavigation();
    initOrdersPeriodFilter();
    initOrdersDateRangeButton();
    initForms();
    initGrids();
    initChangePinModal();
    const lockAppBtn = document.getElementById('lockAppBtn');
    if (lockAppBtn) {
        lockAppBtn.addEventListener('click', () => lockApp());
    }

    const pinOk = await runPinGate();
    if (!pinOk) {
        return;
    }

    if (loadingScreen) {
        loadingScreen.style.display = 'flex';
    }

    let productsLoaded = false;
    let ordersLoaded = false;

    // If prefetch was started during PIN entry, await those promises; otherwise fetch now.
    const loadProductsPromise = (_prefetchProductsPromise || loadProducts())
        .then(() => {
            productsLoaded = true;
        })
        .catch((error) => {
            console.error('Error loading products:', error);
            showToast('Failed to load products', 'error');
            productsLoaded = true;
        });

    const loadOrdersPromise = (_prefetchOrdersPromise || loadOrders())
        .then(() => {
            ordersLoaded = true;
        })
        .catch((error) => {
            console.error('Error loading orders:', error);
            showToast('Failed to load orders', 'error');
            ordersLoaded = true;
        });

    await Promise.all([loadProductsPromise, loadOrdersPromise]);

    if (productsLoaded && ordersLoaded) {
        switchView('orders');
        applyEditLockState();

        if (loadingScreen) {
            loadingScreen.style.display = 'none';
        }

        if (appContainer) {
            appContainer.style.visibility = 'visible';
            setTimeout(() => {
                appContainer.style.opacity = '1';
            }, 10);
        }

        syncShopifyProducts();
        syncShopifyOrders();
        scheduleOrdersAutoSync();
        fetchLoadSheetRiderNames();
    }
});

// ============================================
// AG Grid Initialization
// ============================================

function initGrids() {
    initProductsGrid();
    initOrdersGrid();
    initCashbookIncomingGrid();
    initCashbookOutgoingGrid();
    initLedgerDetailGrid();
}

// Size order mapping for variant sorting
const sizeOrder = {
    'xxs': 1, 'xs': 2, 's': 3, 'small': 3,
    'm': 4, 'medium': 4, 'med': 4,
    'l': 5, 'large': 5,
    'xl': 6, 'x-large': 6,
    'xxl': 7, '2xl': 7,
    'xxxl': 8, '3xl': 8,
    '4xl': 9, '5xl': 10
};

function sortVariantsBySize(variants) {
    if (!variants || !Array.isArray(variants)) return [];
    return [...variants].sort((a, b) => {
        const titleA = (a.title || '').toLowerCase().trim();
        const titleB = (b.title || '').toLowerCase().trim();
        const orderA = sizeOrder[titleA] || 100;
        const orderB = sizeOrder[titleB] || 100;
        if (orderA !== 100 || orderB !== 100) {
            return orderA - orderB;
        }
        return titleA.localeCompare(titleB);
    });
}

function formatAmount(value) {
    const val = parseFloat(value);
    const safeVal = Number.isNaN(val) ? 0 : val;
    return safeVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseCashbookAmount(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).replace(/,/g, '').trim();
    if (raw === '') return null;
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) return null;
    return parsed;
}

function formatCashbookCell(value) {
    if (value === null || value === undefined || value === '') return '';
    return formatAmount(value);
}

function getPKTDate() {
    // Pakistan Standard Time is UTC+5
    const now = new Date();
    const pktOffset = 5 * 60; // PKT is UTC+5 in minutes
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const pkt = new Date(utc + (pktOffset * 60000));
    return pkt;
}

function getPKTDateString() {
    const pkt = getPKTDate();
    const year = pkt.getFullYear();
    const month = String(pkt.getMonth() + 1).padStart(2, '0');
    const day = String(pkt.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getPKTISOString() {
    const pkt = getPKTDate();
    return pkt.toISOString();
}

function getTodayDateString() {
    return getPKTDateString();
}

/** Format a date for display as DD/MM/YYYY. Accepts Date, ISO string, or YYYY-MM-DD string. */
function formatDateDDMMYYYY(value) {
    if (value == null || value === '') return '';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value || '').slice(0, 10);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

/** Format a date-time for display as DD/MM/YYYY, HH:MM. Accepts Date or ISO string. */
function formatDateTimeDDMMYYYY(value) {
    if (value == null || value === '') return '';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value || '');
    const datePart = formatDateDDMMYYYY(d);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${datePart}, ${hours}:${minutes}`;
}

/** Parse DD/MM/YYYY or D/M/YYYY string to YYYY-MM-DD. Returns null if invalid. */
function parseDDMMYYYYToYYYYMMDD(str) {
    if (str == null || typeof str !== 'string') return null;
    const trimmed = str.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/[/\-.]/);
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

function initProductsGrid() {
    const gridDiv = document.getElementById('productsGrid');
    if (!gridDiv) return;

    const columnDefs = [
        {
            headerName: '',
            colId: 'select',
            width: 52,
            minWidth: 52,
            maxWidth: 52,
            checkboxSelection: true,
            headerCheckboxSelection: true,
            headerCheckboxSelectionFilteredOnly: true,
            filter: ProductsClearFiltersPassThroughFilter,
            sortable: false,
            floatingFilter: true,
            floatingFilterComponent: ProductsClearFiltersFloatingFilter,
            suppressSizeToFit: true
        },
        {
            headerName: 'Image',
            field: 'image_url',
            width: 80,
            filter: false,
            sortable: false,
            cellRenderer: (params) => {
                if (params.value) {
                    return `<div class="grid-image-cell"><img src="${escapeHtml(params.value)}" alt="Product"></div>`;
                }
                return '<div class="grid-image-cell"><div class="grid-image-placeholder">No Img</div></div>';
            }
        },
        {
            headerName: 'Product Name',
            field: 'name',
            flex: 2,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['contains', 'startsWith', 'endsWith'],
                defaultOption: 'contains'
            }
        },
        {
            headerName: 'Collection',
            field: 'collection',
            width: 160,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1,
                textMatcher: ({ filterOption, value, filterText }) => {
                    if (filterOption !== 'equals') return value === filterText;
                    // Sentinel for "empty collection" so AG Grid doesn't treat it as no filter
                    if (filterText === '__empty__') {
                        return (value === '' || value == null);
                    }
                    return value === filterText;
                }
            },
            floatingFilterComponent: CollectionFloatingFilter,
            valueGetter: (params) => {
                const v = params.data?.collection;
                return (v == null || v === '') ? '' : v;
            },
            valueFormatter: (params) => (params.value == null || params.value === '') ? '—' : params.value,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agSelectCellEditor',
            cellEditorParams: {
                values: ['', 'Cami Sets', 'Linen PJs', 'Pajama T-Shirt', 'Silk Collection', 'Trousers']
            },
            valueSetter: (params) => {
                const raw = params.newValue === '' ? '' : params.newValue;
                params.data.collection = raw;
                saveProductCollection(params.data.id, raw);
                return true;
            }
        },
        {
            headerName: 'Price (Rs)',
            field: 'price',
            width: 120,
            filter: 'agNumberColumnFilter',
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
        },
        {
            headerName: 'Variants',
            field: 'variants',
            flex: 2,
            filter: false,
            sortable: false,
            autoHeight: true,
            wrapText: true,
            cellRenderer: (params) => {
                const variants = params.value || [];
                if (variants.length === 0) {
                    return '<span class="grid-variant-tag">No variants</span>';
                }
                const sortedVariants = sortVariantsBySize(variants);
                return `<div class="grid-variants-container">${sortedVariants.map(v => {
                    const qty = v.quantity || 0;
                    const isLow = qty < 10;
                    return `<span class="grid-variant-tag ${isLow ? 'low' : ''}">${escapeHtml(v.title)}: ${qty}</span>`;
                }).join('')}</div>`;
            }
        },
        {
            headerName: 'Total Qty',
            field: 'total_quantity',
            width: 120,
            filter: 'agNumberColumnFilter',
            cellRenderer: (params) => {
                const qty = params.value || 0;
                const cssClass = qty < 10 ? 'low' : 'ok';
                return `<span class="grid-quantity-badge ${cssClass}">${qty}</span>`;
            }
        },
        {
            headerName: 'Cost Price (Rs)',
            field: 'cost_price',
            width: 140,
            filter: 'agNumberColumnFilter',
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.cost_price = newValue;
                    // Save to backend
                    saveCostPrice(params.data.id, newValue);
                    return true;
                }
                return false;
            }
        }
    ];

    const gridOptions = {
        columnDefs: columnDefs,
        rowData: [],
        rowSelection: 'multiple',
        suppressRowClickSelection: true,
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        suppressCellFocus: false,
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        onGridReady: (params) => {
            productsGridApi = params.api;
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

// No-op filter for first column so floating filter cell is rendered (AG Grid only shows floating filter when column has a filter)
function OrdersClearFiltersPassThroughFilter() {}
OrdersClearFiltersPassThroughFilter.prototype.init = function () {};
OrdersClearFiltersPassThroughFilter.prototype.getGui = function () { return document.createElement('div'); };
OrdersClearFiltersPassThroughFilter.prototype.doesRowPassFilter = function () { return true; }; // never filter out rows
OrdersClearFiltersPassThroughFilter.prototype.getModel = function () { return null; };
OrdersClearFiltersPassThroughFilter.prototype.setModel = function () {};

// Custom floating filter for first column: "Clear all filters" button
function ClearFiltersFloatingFilter() {}
ClearFiltersFloatingFilter.prototype.init = function (params) {
    this.eGui = document.createElement('div');
    this.eGui.style.width = '100%';
    this.eGui.style.display = 'flex';
    this.eGui.style.alignItems = 'center';
    this.eGui.style.justifyContent = 'center';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm orders-clear-filters-btn';
    const icon = document.createElement('img');
    icon.src = 'assets/clear_filter.png';
    icon.alt = 'Clear all filters';
    icon.className = 'orders-clear-filters-icon';
    btn.appendChild(icon);
    btn.title = 'Clear column filters (keeps period selection)';
    btn.addEventListener('click', function () {
        const api = params.api;
        if (api) api.setFilterModel(null);
    });
    this.eGui.appendChild(btn);
};
ClearFiltersFloatingFilter.prototype.getGui = function () { return this.eGui; };
ClearFiltersFloatingFilter.prototype.onParentModelChanged = function () {};

// No-op filter for products grid first column (so floating filter cell is rendered)
function ProductsClearFiltersPassThroughFilter() {}
ProductsClearFiltersPassThroughFilter.prototype.init = function () {};
ProductsClearFiltersPassThroughFilter.prototype.getGui = function () { return document.createElement('div'); };
ProductsClearFiltersPassThroughFilter.prototype.doesRowPassFilter = function () { return true; };
ProductsClearFiltersPassThroughFilter.prototype.getModel = function () { return null; };
ProductsClearFiltersPassThroughFilter.prototype.setModel = function () {};

// Clear all filters button for products grid (floating filter in first column)
function ProductsClearFiltersFloatingFilter() {}
ProductsClearFiltersFloatingFilter.prototype.init = function (params) {
    this.eGui = document.createElement('div');
    this.eGui.style.width = '100%';
    this.eGui.style.display = 'flex';
    this.eGui.style.alignItems = 'center';
    this.eGui.style.justifyContent = 'center';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm orders-clear-filters-btn';
    const icon = document.createElement('img');
    icon.src = 'assets/clear_filter.png';
    icon.alt = 'Clear all filters';
    icon.className = 'orders-clear-filters-icon';
    btn.appendChild(icon);
    btn.title = 'Clear all filters';
    btn.addEventListener('click', function () {
        if (params.api) params.api.setFilterModel(null);
    });
    this.eGui.appendChild(btn);
};
ProductsClearFiltersFloatingFilter.prototype.getGui = function () { return this.eGui; };
ProductsClearFiltersFloatingFilter.prototype.onParentModelChanged = function () {};

// Custom floating filter for Order Status: shows a <select> dropdown in the filter row
const ORDER_STATUS_VALUES = ['unfulfilled', 'fulfilled', 'delivered', 'RFD', 'returned', 'cancelled', 'CNA', 'ICA'];
function OrderStatusFloatingFilter() {}
OrderStatusFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.className = 'grid-floating-filter-select';
    select.style.width = '100%';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    select.appendChild(allOption);
    ORDER_STATUS_VALUES.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        const display = (v === 'RFD' || v === 'CNA' || v === 'ICA') ? v : (v.charAt(0).toUpperCase() + v.slice(1));
        opt.textContent = display;
        select.appendChild(opt);
    });
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: val };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
};
OrderStatusFloatingFilter.prototype.getGui = function () { return this.eGui; };
OrderStatusFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null || parentModel.filter === '') {
        this.select.value = '__all__';
    } else if (ORDER_STATUS_VALUES.indexOf(parentModel.filter) !== -1) {
        this.select.value = parentModel.filter;
    } else {
        this.select.value = '__all__';
    }
};

// Custom floating filter for Final Status: dropdown (OK, Warning, None, All)
const FINAL_STATUS_VALUES = ['OK', 'Warning', 'None'];
function FinalStatusFloatingFilter() {}
FinalStatusFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.className = 'grid-floating-filter-select';
    select.style.width = '100%';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    select.appendChild(allOption);
    FINAL_STATUS_VALUES.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
    });
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: val };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
};
FinalStatusFloatingFilter.prototype.getGui = function () { return this.eGui; };
FinalStatusFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null || parentModel.filter === '') {
        this.select.value = '__all__';
    } else if (FINAL_STATUS_VALUES.indexOf(parentModel.filter) !== -1) {
        this.select.value = parentModel.filter;
    } else {
        this.select.value = '__all__';
    }
};

// Custom floating filter for Collection (products): dropdown like Order Status
const COLLECTION_VALUES = ['', 'Cami Sets', 'Linen PJs', 'Pajama T-Shirt', 'Silk Collection', 'Trousers'];
function CollectionFloatingFilter() {}
CollectionFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.className = 'grid-floating-filter-select';
    select.style.width = '100%';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    select.appendChild(allOption);
    COLLECTION_VALUES.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v === '' ? '—' : v;
        select.appendChild(opt);
    });
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            // Use sentinel for empty so AG Grid doesn't treat it as "no filter"
            const filterVal = (val === '') ? '__empty__' : val;
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: filterVal };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
};
CollectionFloatingFilter.prototype.getGui = function () { return this.eGui; };
CollectionFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null) {
        this.select.value = '__all__';
    } else if (parentModel.filter === '__empty__') {
        this.select.value = '';
    } else if (COLLECTION_VALUES.indexOf(parentModel.filter) !== -1) {
        this.select.value = parentModel.filter;
    } else {
        this.select.value = '__all__';
    }
};

// Custom floating filter for Piece Received: dropdown in the filter row
const PIECE_RECEIVED_VALUES = ['Pending', 'Done', 'Received'];
function PieceReceivedFloatingFilter() {}
PieceReceivedFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.className = 'grid-floating-filter-select';
    select.style.width = '100%';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    select.appendChild(allOption);
    PIECE_RECEIVED_VALUES.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
    });
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: val };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
};
PieceReceivedFloatingFilter.prototype.getGui = function () { return this.eGui; };
PieceReceivedFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null || parentModel.filter === '') {
        this.select.value = '__all__';
    } else if (PIECE_RECEIVED_VALUES.indexOf(parentModel.filter) !== -1) {
        this.select.value = parentModel.filter;
    } else {
        this.select.value = '__all__';
    }
};

// Maps an order's advance_status code to a colored indicator + tooltip.
// Codes (kept in sync with backend app/advance_status.py):
//   1 = no advance, 2 = Shopify only, 3 = cashbook only, 4 = match, 5 = mismatch
function advanceStatusMeta(status) {
    switch (Number(status)) {
        case 2: return { color: '#f59e0b', title: 'Shopify advance, no cashbook entry' };      // amber
        case 3: return { color: '#3b82f6', title: 'Cashbook entry, no Shopify advance' };        // blue
        case 4: return { color: '#22c55e', title: 'Advance matches (Shopify & cashbook)' };      // green
        case 5: return { color: '#ef4444', title: 'Advance mismatch (Shopify ≠ cashbook)' };     // red
        case 1:
        default: return { color: '#d1d5db', title: 'No advance amount' };                        // grey
    }
}

function initOrdersGrid() {
    const gridDiv = document.getElementById('ordersGrid');
    if (!gridDiv) return;

    const numberFilterValueGetter = (params) => {
        const v = params.api.getValue(params.column.getColId(), params.node);
        return (v != null && v !== '') ? String(v) : '';
    };
    const textFilterContains = { filterOptions: ['contains'], defaultOption: 'contains' };

    const columnDefs = [
        {
            headerName: '',
            colId: 'select',
            width: 72,
            minWidth: 72,
            maxWidth: 72,
            checkboxSelection: true,
            headerCheckboxSelection: true,
            headerCheckboxSelectionFilteredOnly: true,
            filter: OrdersClearFiltersPassThroughFilter,
            sortable: false,
            floatingFilter: true,
            floatingFilterComponent: ClearFiltersFloatingFilter,
            suppressSizeToFit: true
        },
        {
            headerName: 'Order #',
            field: 'order_number',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const on = params.api.getValue('order_number', params.node);
                if (on == null || on === '') return '';
                const s = String(on);
                const replacementOf = params.data?.replacement_of_order_no;
                if (replacementOf) return `${s} (${replacementOf}-R)`;
                if (/^\d+-R$/i.test(s)) {
                    const base = s.replace(/-R$/i, '');
                    return `${base} (${s})`;
                }
                return s;
            },
            cellStyle: { fontWeight: 'bold' },
            valueFormatter: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const on = params.value;
                if (on == null || on === '') return '';
                const s = String(on);
                const replacementOf = params.data?.replacement_of_order_no;
                if (replacementOf) return `${s} (${replacementOf}-R)`;
                if (/^\d+-R$/i.test(s)) {
                    const base = s.replace(/-R$/i, '');
                    return `${base} (${s})`;
                }
                return s;
            },
            comparator: (a, b) => {
                // Sort numerically, with -R orders right after their parent
                const parseON = (v) => {
                    const s = String(v || '');
                    const m = s.match(/^(\d+)(-R)?$/i);
                    return m ? [parseInt(m[1], 10), m[2] ? 1 : 0] : [0, 0];
                };
                const [numA, suffA] = parseON(a);
                const [numB, suffB] = parseON(b);
                if (numA !== numB) return numA - numB;
                return suffA - suffB;
            }
        },
        {
            headerName: 'Courier',
            field: 'courier',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: (params) => (params.data && params.data.id === '__footer__') ? null : getCourierDisplayName(params.data || {}),
            valueFormatter: (params) => (params.data && params.data.id === '__footer__') ? '' : getCourierDisplayName(params.data || {})
        },
        {
            headerName: 'Tracking #',
            field: 'tracking_number',
            width: 130,
            hide: true,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            valueFormatter: (params) => params.value || '-'
        },
        {
            headerName: 'Order Status',
            field: 'order_status',
            width: 130,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1
            },
            floatingFilterComponent: OrderStatusFloatingFilter,
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const status = params.value || '';
                let cssClass = 'grid-status-unfulfilled';
                if (status === 'fulfilled') cssClass = 'grid-status-fulfilled';
                else if (status === 'delivered') cssClass = 'grid-status-delivered';
                else if (status === 'returned') cssClass = 'grid-status-returned';
                else if (status === 'cancelled') cssClass = 'grid-status-cancelled';
                else if (status === 'RFD') cssClass = 'grid-status-rfd';
                else if (status === 'ICA') cssClass = 'grid-status-rfd';
                else if (status === 'CNA') cssClass = 'grid-status-rfd';
                else if (status === 'pending') cssClass = 'grid-status-unfulfilled'; /* legacy */
                return `<span class="grid-status-badge ${cssClass}">${escapeHtml(status)}</span>`;
            }
        },
        {
            headerName: 'Delivery',
            field: 'delivery_status',
            width: 150,
            filter: false,
            sortable: false,
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const order = params.data;
                const courier = order.courier || '';
                const hasCourier = courier && courier.trim() !== '' && courier.trim().toLowerCase() !== 'unassigned';
                if (!hasCourier) {
                    return '<span style="color: var(--text-muted);">-</span>';
                }
                const lastStatus = order.delivery_status;
                const hasStoredStatus = lastStatus && (lastStatus.latest_status || (lastStatus.status_history && lastStatus.status_history.length > 0));
                const statusText = hasStoredStatus
                    ? (
                        (lastStatus.latest_status)
                        || (
                            lastStatus.status_history
                            && lastStatus.status_history.length > 0
                            && lastStatus.status_history[lastStatus.status_history.length - 1]
                            && lastStatus.status_history[lastStatus.status_history.length - 1].status
                        )
                        || ''
                    ).trim()
                    : '';
                const displayStatus = statusText || '';
                const fetchedAt = hasStoredStatus && lastStatus.fetched_at
                    ? formatDateTimeDDMMYYYY(lastStatus.fetched_at)
                    : '';
                const courierNormalized = (courier || '').trim().toUpperCase();
                const supportsDeliveryRefresh = (
                    courierNormalized === 'POSTEX' ||
                    courierNormalized === 'COURIERS NEXT'
                );
                const courierEsc = (courier || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const trackEsc = (order.tracking_number || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const refreshBtn = supportsDeliveryRefresh
                    ? `<button type="button" class="grid-delivery-refresh-btn" onclick="event.stopPropagation(); fetchDeliveryStatus('${order.id}', '${courierEsc}', '${trackEsc}')" title="Refresh status"><span>🔄</span></button>`
                    : '';
                return `<div class="delivery-cell-with-status" title="${escapeHtml(displayStatus)}">
                    ${refreshBtn}
                    <span class="delivery-status-preview">${escapeHtml(displayStatus)}</span>
                    ${fetchedAt ? `<span class="delivery-fetched-at">${escapeHtml(fetchedAt)}</span>` : ''}
                </div>`;
            }
        },
        {
            headerName: 'Total',
            field: 'total_amount',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: (params) => isEditingAllowed() && params.node?.rowPinned !== 'bottom',
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agNumberCellEditor',
            cellEditorParams: { min: 0, max: 999999999.99, precision: 2 },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                if (params.data?.id === '__footer__') return false;
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.total_amount = newValue;
                    saveOrderField(params.data.id, 'total_amount', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Advance',
            field: 'advance_amount',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: (params) => isEditingAllowed() && params.node?.rowPinned !== 'bottom',
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agNumberCellEditor',
            cellEditorParams: { min: 0, max: 999999999.99, precision: 2 },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellRenderer: (params) => {
                const val = parseFloat(params.value) || 0;
                const formatted = val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                // Footer row: no indicator
                if (params.data && params.data.id === '__footer__') return formatted;
                const meta = advanceStatusMeta(params.data ? params.data.advance_status : 1);
                return `<span class="advance-cell">`
                    + `<span class="advance-dot" style="background:${meta.color}" title="${meta.title}"></span>`
                    + `<span>${formatted}</span>`
                    + `</span>`;
            },
            valueSetter: (params) => {
                if (params.data?.id === '__footer__') return false;
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.advance_amount = newValue;
                    saveOrderField(params.data.id, 'advance_amount', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'CoD',
            field: 'cod',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.cod;
                const status = (params.data.order_status || '').toLowerCase();
                if (status === 'returned') return 0;
                const total = parseFloat(params.data.total_amount) || 0;
                const advance = parseFloat(params.data.advance_amount) || 0;
                return total - advance;
            },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
        },
        {
            headerName: 'D. Charge',
            field: 'delivery_charge',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.delivery_charge = newValue;
                    saveOrderField(params.data.id, 'delivery_charge', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Tax',
            field: 'tax_amount',
            width: 80,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.tax_amount = newValue;
                    saveOrderField(params.data.id, 'tax_amount', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Receivable',
            field: 'receivable',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.receivable;
                const status = (params.data.order_status || '').toLowerCase();
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                // Only show receivable for delivered or returned orders with delivery_charge set
                if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
                const total = parseFloat(params.data.total_amount) || 0;
                const advance = parseFloat(params.data.advance_amount) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                if (status === 'returned') return -delivery;
                return total - (advance + delivery + tax);
            },
            valueFormatter: (params) => {
                if (params.value == null) return '-';
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellStyle: (params) => {
                if (params.value == null) return {};
                return {
                    color: params.value >= 0 ? 'var(--text-primary)' : 'var(--danger)'
                };
            }
        },
        {
            headerName: 'Folio',
            field: 'folio',
            width: 120,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            editable: (params) => isEditingAllowed() && params.node?.rowPinned !== 'bottom',
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => params.value ?? '-',
            valueSetter: (params) => {
                if (params.data?.id === '__footer__') return;
                const newValue = params.newValue != null ? String(params.newValue).trim() : null;
                params.data.folio = newValue || null;
                saveOrderField(params.data.id, 'folio', newValue);
                params.api.refreshCells({ rowNodes: [params.node], force: true });
            }
        },
        {
            headerName: 'Cost Price',
            field: 'cost_price',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.cost_price = newValue;
                    saveOrderField(params.data.id, 'cost_price', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Net Profit',
            field: 'net_profit',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.net_profit;
                const status = (params.data.order_status || '').toLowerCase();
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                // Only show net profit for delivered or returned orders with delivery_charge set
                if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
                const total = parseFloat(params.data.total_amount) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                const cost = parseFloat(params.data.cost_price) || 0;
                if (status === 'returned') return -delivery;
                return total - (delivery + tax + cost);
            },
            valueFormatter: (params) => {
                if (params.value == null) return '-';
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellClass: (params) => {
                if (params.value == null) return '';
                return params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative';
            }
        },
        {
            headerName: 'Profit %',
            field: 'profit_percent',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.profit_percent;
                const status = (params.data.order_status || '').toLowerCase();
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                // Only show profit % for delivered or returned orders with delivery_charge set
                if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
                const total = parseFloat(params.data.total_amount) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                const cost = parseFloat(params.data.cost_price) || 0;
                let netProfit = status === 'returned' ? -delivery : total - (delivery + tax + cost);
                if (total > 0) return (netProfit / total) * 100;
                return 0;
            },
            valueFormatter: (params) => {
                if (params.value == null) return '-';
                return (params.value || 0).toFixed(1) + '%';
            },
            cellClass: (params) => {
                if (params.value == null) return '';
                return params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative';
            }
        },
        {
            headerName: 'Piece Received',
            field: 'piece_received',
            width: 120,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1
            },
            floatingFilterComponent: PieceReceivedFloatingFilter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agSelectCellEditor',
            cellEditorParams: {
                values: ['Pending', 'Done', 'Received']
            },
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return null;
                const stored = (params.data.piece_received || '').trim();
                return ['Pending', 'Done', 'Received'].includes(stored) ? stored : 'Pending';
            },
            valueFormatter: (params) => params.value || '-',
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const v = (params.value || '').trim();
                if (!v) return '<span style="color: var(--text-muted);">-</span>';
                let cssClass = 'grid-piece-pending';
                if (v === 'Done') cssClass = 'grid-piece-done';
                else if (v === 'Received') cssClass = 'grid-piece-received';
                return `<span class="grid-status-badge ${cssClass}">${escapeHtml(v)}</span>`;
            },
            valueSetter: (params) => {
                const newValue = (params.newValue || '').trim();
                if (['Pending', 'Done', 'Received'].includes(newValue)) {
                    params.data.piece_received = newValue;
                    saveOrderField(params.data.id, 'piece_received', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Items',
            field: 'items',
            flex: 1,
            minWidth: 150,
            hide: true,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            valueGetter: (params) => {
                const items = params.data.items;
                if (items && Array.isArray(items) && items.length > 0) {
                    return items.join(', ');
                }
                return '';
            },
            cellRenderer: (params) => {
                if (params.value) {
                    return `<div class="grid-items-cell" title="${escapeHtml(params.value)}">${escapeHtml(params.value)}</div>`;
                }
                return '-';
            }
        },
        {
            headerName: 'Date',
            field: 'order_receiving_date',
            width: 130,
            hide: true,
            floatingFilter: false,
            filter: 'agDateColumnFilter',
            filterParams: {
                filterOptions: ['inRange'],
                defaultOption: 'inRange',
                browserDatePicker: true
            },
            valueGetter: (params) => {
                const date = params.data.order_receiving_date || params.data.created_at;
                return date ? new Date(date) : null;
            },
            valueFormatter: (params) => {
                if (params.value) {
                    return formatDateDDMMYYYY(params.value);
                }
                return '';
            }
        },
        {
            headerName: 'Status',
            field: 'final_status',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1
            },
            floatingFilterComponent: FinalStatusFloatingFilter,
            sortable: true,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return null;
                const order = params.data;
                const status = (order.order_status || '').toLowerCase();
                const pieceReceived = (order.piece_received || '').trim();
                
                // None for cancelled orders
                if (status === 'cancelled') {
                    return 'None';
                }
                
                const delivery = parseFloat(order.delivery_charge) || 0;
                
                // Green (OK) only in 2 scenarios (no receivable condition):
                // 1. Order is delivered AND delivery_charge is non-zero
                // 2. Order is returned AND delivery_charge is non-zero AND piece_received is "Received"
                if (status === 'delivered') {
                    if (delivery > 0) {
                        return 'OK';
                    }
                } else if (status === 'returned') {
                    if (delivery > 0 && pieceReceived === 'Received') {
                        return 'OK';
                    }
                }
                
                // Default: all orders are yellow (Warning)
                return 'Warning';
            },
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const value = params.value || 'Warning';
                if (value === 'OK') {
                    return '<span style="font-size: 18px;">🟢</span>';
                } else if (value === 'None') {
                    return '<span style="color: var(--text-muted);">-</span>';
                } else {
                    return '<span style="font-size: 18px;">🔴</span>';
                }
            }
        },
        {
            headerName: '',
            colId: 'delete',
            width: 60,
            minWidth: 60,
            maxWidth: 60,
            sortable: false,
            filter: false,
            suppressSizeToFit: true,
            suppressMovable: true,
            cellRenderer: (params) => {
                const orderNumber = String(params.data?.order_number || '');
                const isReplacement = /-R$/i.test(orderNumber);
                if (!isReplacement) {
                    return '';
                }
                const orderId = params.data?.id;
                if (!orderId) return '';
                return `<button class="grid-delete-btn" data-order-id="${escapeHtml(orderId)}" title="Delete replacement order" aria-label="Delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line x1="10" y1="11" x2="10" y2="17"></line>
                        <line x1="14" y1="11" x2="14" y2="17"></line>
                    </svg>
                </button>`;
            },
            pinnedRowCellRenderer: () => ''
        }
    ];

    // Function to calculate sums for selected rows (cancelled rows are excluded from sums)
    function calculateSelectedSums() {
        if (!ordersGridApi) return {};
        
        const selectedRows = ordersGridApi.getSelectedRows();
        const rowsForSum = selectedRows.filter(
            (row) => (row.order_status || '').toLowerCase() !== 'cancelled'
        );
        if (rowsForSum.length === 0) {
            return {
                count: 0,
                total_amount: 0,
                advance_amount: 0,
                cod: 0,
                delivery_charge: 0,
                tax_amount: 0,
                receivable: 0,
                cost_price: 0,
                net_profit: 0,
                total_amount_for_profit: 0
            };
        }
        
        let total_amount = 0;
        let advance_amount = 0;
        let delivery_charge = 0;
        let tax_amount = 0;
        let cost_price = 0;
        let cod = 0;
        let receivable = 0;
        let net_profit = 0;
        let total_amount_for_profit = 0; // Total amount for delivered/returned orders only (for profit % calculation)
        
        rowsForSum.forEach(row => {
            const status = (row.order_status || '').toLowerCase();
            const rowTotal = parseFloat(row.total_amount) || 0;
            const rowAdvance = parseFloat(row.advance_amount) || 0;
            const rowDelivery = parseFloat(row.delivery_charge) || 0;
            const rowTax = parseFloat(row.tax_amount) || 0;
            const rowCost = parseFloat(row.cost_price) || 0;
            
            total_amount += rowTotal;
            advance_amount += rowAdvance;
            delivery_charge += rowDelivery;
            tax_amount += rowTax;
            cost_price += rowCost;
            
            // Calculate cod per row (0 for returned orders)
            if (status !== 'returned') {
                cod += rowTotal - rowAdvance;
            }
            
            // Calculate receivable per row (only for delivered or returned orders with delivery_charge set)
            if ((status === 'delivered' || status === 'returned') && rowDelivery > 0) {
                total_amount_for_profit += rowTotal; // Track total for profit % calculation
                if (status === 'returned') {
                    receivable += -rowDelivery;
                } else {
                    receivable += rowTotal - (rowAdvance + rowDelivery + rowTax);
                }
            }
            
            // Calculate net profit per row (only for delivered or returned orders with delivery_charge set)
            if ((status === 'delivered' || status === 'returned') && rowDelivery > 0) {
                if (status === 'returned') {
                    net_profit += -rowDelivery;
                } else {
                    net_profit += rowTotal - (rowDelivery + rowTax + rowCost);
                }
            }
        });
        
        return {
            count: rowsForSum.length,
            total_amount,
            advance_amount,
            cod,
            delivery_charge,
            tax_amount,
            receivable,
            cost_price,
            net_profit,
            total_amount_for_profit
        };
    }
    
    // Function to update footer row (make it accessible globally)
    updateFooterRow = function() {
        if (!ordersGridApi) return;
        
        const sums = calculateSelectedSums();
        const selectedCount = sums.count;
        
        // Update selected count text at bottom right
        const selectedCountEl = document.getElementById('ordersSelectedCount');
        if (selectedCountEl) {
            selectedCountEl.textContent = `${selectedCount} row(s) selected`;
            selectedCountEl.style.display = selectedCount > 0 ? 'block' : 'none';
        }
        
        const footerData = {
            id: '__footer__',
            __isFooter: true,
            order_number: null,
            courier: null,
            tracking_number: null,
            folio: null,
            order_status: null,
            delivery_status: null,
            total_amount: sums.total_amount,
            advance_amount: sums.advance_amount,
            cod: sums.cod,
            delivery_charge: sums.delivery_charge,
            tax_amount: sums.tax_amount,
            receivable: sums.receivable,
            cost_price: sums.cost_price,
            net_profit: sums.net_profit,
            profit_percent: sums.total_amount_for_profit > 0 ? (sums.net_profit / sums.total_amount_for_profit) * 100 : null,
            piece_received: null,
            items: null,
            order_receiving_date: null,
            final_status: null
        };
        
        ordersGridApi.setGridOption('pinnedBottomRowData', selectedCount > 0 ? [footerData] : []);
    }
    
    // Update column definitions to add footer cell renderers
    columnDefs.forEach(col => {
        // Skip checkbox column
        if (col.checkboxSelection) {
            col.pinnedRowCellRenderer = () => '';
            return;
        }
        
        if (col.field === 'order_number') {
            // Order number is not numeric - show nothing in footer
            col.pinnedRowCellRenderer = () => '<span></span>';
        } else if (['total_amount', 'advance_amount', 'cod', 'delivery_charge', 'tax_amount', 'receivable', 'cost_price', 'net_profit'].includes(col.field)) {
            col.pinnedRowCellRenderer = (params) => {
                const val = parseFloat(params.value) || 0;
                const formatted = val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return `<div style="font-weight: bold; padding: 8px; text-align: right;">${formatted}</div>`;
            };
        } else if (col.field === 'profit_percent') {
            col.pinnedRowCellRenderer = (params) => {
                const val = parseFloat(params.value) || 0;
                const formatted = val.toFixed(1) + '%';
                return `<div style="font-weight: bold; padding: 8px; text-align: right;">${formatted}</div>`;
            };
        } else {
            col.pinnedRowCellRenderer = () => '';
        }
    });

    const gridOptions = {
        columnDefs: columnDefs,
        rowData: [],
        rowSelection: 'multiple',
        suppressRowClickSelection: true,
        pinnedBottomRowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 70,
            suppressHeaderMenuButton: true,
            suppressHeaderFilterButton: true,
            suppressFloatingFilterButton: true,
            floatingFilterComponentParams: { suppressFilterButton: true }
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        suppressCellFocus: false,
        stopEditingWhenCellsLoseFocus: true,
        singleClickEdit: true,
        getRowId: (params) => params.data.id,
        getRowStyle: (params) => {
            if (params.data.id === '__footer__') {
                return { 
                    backgroundColor: 'var(--bg-secondary, #f5f5f5)', 
                    borderTop: '2px solid var(--primary, #007bff)',
                    fontWeight: 'bold'
                };
            }
            const status = (params.data.order_status || '').toLowerCase();
            if (status === 'cancelled') {
                return { opacity: '0.5', textDecoration: 'line-through' };
            }
            return null;
        },
        onGridReady: (params) => {
            ordersGridApi = params.api;
            updateFooterRow();
        },
        onFilterChanged: (params) => {
            if (!params.api) return;
            if (typeof window._ordersDateRangeUpdateButtonLabel === 'function') window._ordersDateRangeUpdateButtonLabel();
            // Temporarily added "fetch by number" orders: remove when filter is cleared or Order# is changed
            const filterModel = params.api.getFilterModel() || {};
            const orderNumCol = filterModel.order_number;
            const filterValue = orderNumCol && (orderNumCol.filter != null) ? String(orderNumCol.filter).trim() : '';
            // Order numbers start at 1000, so a full order number is 4 or more digits.
            const isFullOrderNumber = /^\d{4,}$/.test(filterValue);

            function removeFetchedByNumberRows() {
                if (ordersFetchedByNumberIds.size === 0) return;
                const toRemove = [];
                params.api.forEachNode((node) => {
                    if (node.data && node.data.id !== '__footer__' && ordersFetchedByNumberIds.has(node.data.id)) {
                        toRemove.push(node.data);
                    }
                });
                if (toRemove.length) {
                    params.api.applyTransaction({ remove: toRemove });
                    updateFooterRow();
                }
                ordersFetchedByNumberIds.clear();
            }

            // Clear or partial number: remove any temporarily added order and stop
            if (!isFullOrderNumber) {
                removeFetchedByNumberRows();
                return;
            }

            const displayedCount = params.api.getDisplayedRowCount();
            // Same filter but we already have a temporary row for it (e.g. re-apply): no-op
            if (displayedCount > 0) return;

            // New order-number search with 0 results: remove any previous temporary row(s) then fetch this number
            removeFetchedByNumberRows();

            (async () => {
                if (ordersFetchByNumberInFlight === filterValue) return;
                ordersFetchByNumberInFlight = filterValue;
                try {
                    const response = await fetch(`${API_BASE}/orders/by-number/${encodeURIComponent(filterValue)}`);
                    if (!response.ok) {
                        if (response.status === 404) showToast(`Order #${filterValue} not found in database`, 'info');
                        return;
                    }
                    const order = await response.json();
                    if (order && order.id) {
                        ordersFetchedByNumberIds.add(order.id);
                        params.api.applyTransaction({ add: [order], addIndex: 0 });
                        updateFooterRow();
                        showToast(`Order #${filterValue} loaded from database`, 'success');
                    }
                } catch (err) {
                    console.error('Fetch order by number failed:', err);
                    showToast('Failed to fetch order from database', 'error');
                } finally {
                    ordersFetchByNumberInFlight = null;
                }
            })();
        },
        onSelectionChanged: (params) => {
            // Ensure only filtered rows are selected - deselect any non-filtered rows
            if (!params.api) {
                updateFooterRow();
                return;
            }
            
            const selectedNodes = params.api.getSelectedNodes();
            if (selectedNodes.length === 0) {
                updateFooterRow();
                return;
            }
            
            const filteredNodeIds = new Set();
            
            // Build a set of all node IDs that pass the current filter
            params.api.forEachNodeAfterFilter((node) => {
                if (node.data && node.data.id !== '__footer__') {
                    filteredNodeIds.add(node.id);
                }
            });
            
            // Deselect any selected node that doesn't pass the filter
            let hasNonFilteredSelected = false;
            selectedNodes.forEach(node => {
                if (node.data && node.data.id !== '__footer__') {
                    if (!filteredNodeIds.has(node.id)) {
                        hasNonFilteredSelected = true;
                        node.setSelected(false);
                    }
                }
            });
            
            // Update footer (will be called again if selection changed due to deselection, but that's fine)
            updateFooterRow();
        },
        onCellValueChanged: () => {
            // Update footer when cell values change (e.g., after editing)
            setTimeout(() => updateFooterRow(), 0);
        },
        onCellClicked: (params) => {
            // Handle delete button clicks for replacement orders
            if (!params.event || !params.event.target) return;
            
            // Only process clicks in the delete column
            if (params.colDef?.colId !== 'delete') return;
            
            // Find the delete button (could be clicked directly or on SVG inside)
            const target = params.event.target;
            let deleteBtn = null;
            
            if (target.classList && target.classList.contains('grid-delete-btn')) {
                deleteBtn = target;
            } else if (target.closest) {
                deleteBtn = target.closest('.grid-delete-btn');
            }
            
            if (deleteBtn) {
                params.event.preventDefault();
                params.event.stopPropagation();
                const orderId = deleteBtn.getAttribute('data-order-id');
                if (orderId && params.data) {
                    deleteReplacementOrder(orderId, params.data);
                }
            }
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

function isCashbookSystemOrFooterRow(data) {
    if (!data || !data.id) return false;
    const id = String(data.id);
    return id === '__opening__' || id === '__closing__' || id === '__total_in__' || id === '__total_out__' || data._isSystemRow || data._isFooter;
}

function getLedgerNameById(id) {
    if (!id) return '';
    const ledger = ledgers.find(l => l.id === id);
    return ledger ? ledger.name : '';
}

function isCashbookNewRow(data) {
    return data && data.id && String(data.id).startsWith('__new_');
}

/**
 * Folio cell renderer using custom searchable dropdown.
 * Creates a clean, native-feeling dropdown with search functionality.
 */
function createFolioCellRenderer(params, entryType) {
    if (!params || !params.data) return document.createElement('span');
    if (params.node && params.node.rowPinned === 'bottom') return document.createElement('span');
    if (isCashbookSystemOrFooterRow(params.data)) return document.createElement('span');

    const wrapper = document.createElement('div');
    wrapper.className = 'folio-dropdown';

    const currentFolio = params.data.folio || '';
    const currentLedger = ledgers.find(l => l.id === currentFolio);
    const displayText = currentLedger ? currentLedger.name : 'Select ledger... *';

    // Check if this is a new row with other fields filled but no folio - highlight as required
    const isNewRow = isCashbookNewRow(params.data);
    const hasFolio = !!currentFolio;
    const hasOtherData = (params.data.description && String(params.data.description).trim() !== '') || 
                         (params.data.amount != null && params.data.amount > 0);
    const needsHighlight = isNewRow && !hasFolio && hasOtherData;

    // Display text showing selected ledger (like piece_received shows status)
    const displaySpan = document.createElement('span');
    displaySpan.className = 'folio-display-text' + (needsHighlight ? ' folio-required' : '');
    if (currentLedger) {
        displaySpan.textContent = currentLedger.name;
        displaySpan.style.cursor = 'pointer';
    } else {
        displaySpan.textContent = 'Select ledger... *';
        displaySpan.style.color = 'var(--text-muted)';
        displaySpan.style.cursor = 'pointer';
    }

    // Main button that shows current selection (hidden, used for dropdown positioning)
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'folio-dropdown-btn' + (needsHighlight ? ' folio-required' : '');
    button.style.display = 'none';
    button.innerHTML = `<span class="folio-dropdown-text">${escapeHtml(displayText)}</span><span class="folio-dropdown-arrow">▼</span>`;
    
    // Click on display text opens dropdown
    displaySpan.addEventListener('click', (e) => {
        e.stopPropagation();
        openDropdown();
    });

    // Dropdown panel (will be appended to body when opened)
    let dropdownPanel = null;
    let isOpen = false;

    function closeDropdown() {
        if (dropdownPanel && dropdownPanel.parentNode) {
            dropdownPanel.parentNode.removeChild(dropdownPanel);
        }
        dropdownPanel = null;
        isOpen = false;
        button.classList.remove('open');
    }

    function openDropdown() {
        if (isOpen) return;
        isOpen = true;
        button.classList.add('open');

        dropdownPanel = document.createElement('div');
        dropdownPanel.className = 'folio-dropdown-panel';

        // Search input
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'folio-dropdown-search';
        searchInput.placeholder = 'Search ledgers...';
        dropdownPanel.appendChild(searchInput);

        // Options list
        const optionsList = document.createElement('div');
        optionsList.className = 'folio-dropdown-options';
        dropdownPanel.appendChild(optionsList);

        function renderOptions(filter = '') {
            const filterLower = filter.toLowerCase();
            const filtered = ledgers.filter(l => l.name.toLowerCase().includes(filterLower));
            
            optionsList.innerHTML = '';
            
            // Folio is now required - no "None" option

            // Add ledger options
            filtered.forEach(l => {
                const option = document.createElement('div');
                option.className = 'folio-dropdown-option' + (l.id === currentFolio ? ' selected' : '');
                option.textContent = l.name;
                option.addEventListener('click', () => selectOption(l.id, l.name));
                optionsList.appendChild(option);
            });

            if (filtered.length === 0) {
                const noResults = document.createElement('div');
                noResults.className = 'folio-dropdown-empty';
                noResults.textContent = filter ? 'No ledgers found' : 'No ledgers available. Create one first.';
                optionsList.appendChild(noResults);
            }
        }

        function selectOption(id, name) {
            params.data.folio = id || null;
            button.querySelector('.folio-dropdown-text').textContent = id ? name : 'Select ledger... *';
            
            // Update display text (like piece_received shows selected status)
            if (id && name) {
                displaySpan.textContent = name;
                displaySpan.style.color = '';
            } else {
                displaySpan.textContent = 'Select ledger... *';
                displaySpan.style.color = 'var(--text-muted)';
            }
            
            // Update "Go to Ledger" button state
            const goToBtn = wrapper._goToLedgerBtn;
            if (goToBtn) {
                if (id) {
                    goToBtn.style.opacity = '1';
                    goToBtn.style.cursor = 'pointer';
                    goToBtn.title = `Go to ${name}`;
                } else {
                    goToBtn.style.opacity = '0.4';
                    goToBtn.style.cursor = 'not-allowed';
                    goToBtn.title = 'Select a ledger first';
                }
            }
            
            if (params.data.id && !isCashbookNewRow(params.data)) {
                // Update existing entry
                updateCashbookEntry(params.data.id, { folio: id || null });
            } else if (isCashbookNewRow(params.data) && id) {
                // For new entries, check if all required fields are filled and trigger auto-save
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                if (hasDescription && hasAmount && entryType) {
                    tryCreateCashbookEntryFromPinnedRow(params.data, entryType);
                }
            }
            closeDropdown();
        }

        searchInput.addEventListener('input', (e) => {
            renderOptions(e.target.value);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeDropdown();
            }
        });

        renderOptions();

        // Position dropdown below display text
        document.body.appendChild(dropdownPanel);
        const rect = displaySpan.getBoundingClientRect();
        dropdownPanel.style.top = (rect.bottom + 2) + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.minWidth = Math.max(rect.width, 200) + 'px';

        // Focus search input
        setTimeout(() => searchInput.focus(), 0);

        // Close on outside click
        const closeHandler = (e) => {
            if (!dropdownPanel.contains(e.target) && e.target !== displaySpan && e.target !== button && !displaySpan.contains(e.target) && !button.contains(e.target)) {
                closeDropdown();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen) {
            closeDropdown();
        } else {
            openDropdown();
        }
    });

    wrapper.appendChild(displaySpan);
    wrapper.appendChild(button);

    // Add "Go to Ledger" button next to dropdown
    const goToLedgerBtn = document.createElement('button');
    goToLedgerBtn.type = 'button';
    goToLedgerBtn.className = 'folio-goto-btn';
    goToLedgerBtn.innerHTML = '→';
    goToLedgerBtn.title = currentFolio ? `Go to ${displayText}` : 'Select a ledger first';
    if (!currentFolio) {
        goToLedgerBtn.style.opacity = '0.4';
        goToLedgerBtn.style.cursor = 'not-allowed';
    }
    goToLedgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const folioId = params.data.folio;
        if (folioId) {
            openLedgerDetail(folioId);
        }
    });
    
    // Store button reference on wrapper for access inside openDropdown
    wrapper._goToLedgerBtn = goToLedgerBtn;
    
    wrapper.appendChild(goToLedgerBtn);
    return wrapper;
}

function buildCashbookGridColumns(side) {
    return [
        {
            headerName: 'Description',
            field: 'description',
            flex: 1,
            editable: (params) => isEditingAllowed() && !isCashbookSystemOrFooterRow(params.data) && params.node.rowPinned !== 'bottom',
            cellClass: (params) => {
                if (isCashbookNewRow(params.data)) {
                    // Highlight if amount is filled but description is empty
                    const hasAmount = params.data.amount != null && params.data.amount > 0;
                    const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                    if (hasAmount && !hasDescription) return 'cashbook-required-field';
                }
                return '';
            },
            cellStyle: (params) => isCashbookSystemOrFooterRow(params.data) ? { fontWeight: '600', cursor: 'default' } : { cursor: 'pointer' },
            valueFormatter: (params) => (params.value != null && params.value !== '' ? String(params.value) : ''),
            pinnedRowCellRenderer: (params) => (params.value != null && params.value !== '' ? String(params.value) : ''),
            valueSetter: (params) => {
                if (isCashbookSystemOrFooterRow(params.data) || params.node.rowPinned === 'bottom') return false;
                const val = String(params.newValue ?? '').trim();
                if ((params.data.description || '') === val) return false;
                params.data.description = val;
                if (!params.node.rowPinned && !isCashbookNewRow(params.data)) {
                    updateCashbookEntry(params.data.id, { description: val });
                } else if (isCashbookNewRow(params.data) && params.api) {
                    // Refresh cells to update highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
                return true;
            }
        },
        {
            headerName: 'Folio',
            field: 'folio',
            width: 200,
            minWidth: 150,
            filter: false,
            sortable: false,
            cellRenderer: (params) => createFolioCellRenderer(params, side),
            pinnedRowCellRenderer: () => ''
        },
        {
            headerName: side === 'inflow' ? 'Incoming (Rs)' : 'Outgoing (Rs)',
            field: 'amount',
            width: 100,
            filter: 'agNumberColumnFilter',
            editable: (params) => isEditingAllowed() && !isCashbookSystemOrFooterRow(params.data) && params.node.rowPinned !== 'bottom',
            cellClass: (params) => {
                if (isCashbookNewRow(params.data)) {
                    // Highlight if description is filled but amount is empty
                    const hasAmount = params.data.amount != null && params.data.amount > 0;
                    const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                    if (hasDescription && !hasAmount) return 'cashbook-required-field';
                }
                return '';
            },
            cellStyle: (params) => isCashbookSystemOrFooterRow(params.data) ? { fontWeight: '600', cursor: 'default' } : { cursor: 'pointer' },
            valueFormatter: (params) => formatCashbookCell(params.value),
            pinnedRowCellRenderer: (params) => {
                const val = params.value;
                if (val == null || val === '') return '';
                return formatCashbookCell(val);
            },
            valueSetter: (params) => {
                if (params.node.rowPinned === 'bottom') return false;
                if (params.node.rowPinned === 'top' || isCashbookNewRow(params.data)) {
                    params.data.amount = parseCashbookAmount(params.newValue);
                    // Refresh cells to update highlighting
                    if (params.api) {
                        params.api.refreshCells({ rowNodes: [params.node], force: true });
                    }
                    return true;
                }
                if (isCashbookSystemOrFooterRow(params.data)) return false;
                const next = parseCashbookAmount(params.newValue);
                if (next === null || next <= 0) return false;
                params.data.amount = next;
                updateCashbookEntry(params.data.id, { entry_type: side, amount: next });
                return true;
            }
        },
        {
            headerName: '',
            field: 'actions',
            width: 20,
            filter: false,
            sortable: false,
            cellRenderer: (params) => {
                if (params.node.rowPinned) return '';
                if (isCashbookSystemOrFooterRow(params.data)) return '';
                if (isCashbookNewRow(params.data)) return '';
                const btn = document.createElement('button');
                btn.className = 'cashbook-delete-btn';
                btn.innerHTML = '<i class="fa-solid fa-trash"></i>';
                btn.title = 'Delete entry';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteCashbookEntry(params.data.id);
                });
                return btn;
            },
            pinnedRowCellRenderer: () => ''
        }
    ];
}

function initCashbookIncomingGrid() {
    const gridDiv = document.getElementById('cashbookIncomingGrid');
    if (!gridDiv) return;

    const gridOptions = {
        columnDefs: buildCashbookGridColumns('inflow'),
        rowData: [],
        pinnedBottomRowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        singleClickEdit: true,
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        getRowStyle: (params) => {
            if (params.node.rowPinned === 'bottom') {
                return { fontWeight: 'bold', borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' };
            }
            if (params.data && params.data.id === '__opening__') {
                return { fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.03)' };
            }
            return null;
        },
        onGridReady: (params) => {
            cashbookIncomingGridApi = params.api;
        },
        onCellValueChanged: (params) => {
            if (isCashbookNewRow(params.data)) {
                // Auto-save when all required fields are filled (description, amount, and folio)
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                const hasFolio = params.data.folio && String(params.data.folio).trim() !== '';
                if (hasDescription && hasAmount && hasFolio) {
                    tryCreateCashbookEntryFromPinnedRow(params.data, 'inflow');
                } else if (params.api) {
                    // Refresh the row to update required field highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
            }
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

function initCashbookOutgoingGrid() {
    const gridDiv = document.getElementById('cashbookOutgoingGrid');
    if (!gridDiv) return;

    const gridOptions = {
        columnDefs: buildCashbookGridColumns('outflow'),
        rowData: [],
        pinnedBottomRowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        singleClickEdit: true,
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        getRowStyle: (params) => {
            if (params.node.rowPinned === 'bottom') {
                return { fontWeight: 'bold', borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' };
            }
            if (params.data && params.data.id === '__closing__') {
                return { fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.03)' };
            }
            return null;
        },
        onGridReady: (params) => {
            cashbookOutgoingGridApi = params.api;
        },
        onCellValueChanged: (params) => {
            if (isCashbookNewRow(params.data)) {
                // Auto-save when all required fields are filled (description, amount, and folio)
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                const hasFolio = params.data.folio && String(params.data.folio).trim() !== '';
                if (hasDescription && hasAmount && hasFolio) {
                    tryCreateCashbookEntryFromPinnedRow(params.data, 'outflow');
                } else if (params.api) {
                    // Refresh the row to update required field highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
            }
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

// ============================================
// Save Functions for Editable Cells
// ============================================

async function saveCostPrice(productId, costPrice) {
    try {
        const response = await fetch(`${API_BASE}/products/batch-update-cost-prices`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: [{ id: productId, cost_price: costPrice }] })
        });

        if (!response.ok) {
            throw new Error('Failed to update cost price');
        }

        showToast('Cost price updated', 'success');
    } catch (error) {
        console.error('Error saving cost price:', error);
        showToast('Failed to save cost price', 'error');
    }
}

async function saveProductCollection(productId, collection) {
    try {
        const response = await fetch(`${API_BASE}/products/${productId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection: collection })
        });

        if (!response.ok) {
            throw new Error('Failed to update collection');
        }

        showToast('Collection updated', 'success');
    } catch (error) {
        console.error('Error saving collection:', error);
        showToast('Failed to save collection', 'error');
    }
}

async function saveOrderField(orderId, field, value) {
    try {
        const response = await fetch(`${API_BASE}/orders/${orderId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value })
        });

        if (!response.ok) {
            throw new Error(`Failed to update ${field}`);
        }

        // When the advance amount changes, the backend recomputes advance_status.
        // Reflect the recomputed status on the grid row so the indicator updates.
        if (field === 'advance_amount') {
            try {
                const updated = await response.json();
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
        const response = await fetch(`${API_BASE}/orders/${orderId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to delete order');
        }

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
                const res = await fetch(`${API_BASE}/orders/extract-order-numbers-from-pdf`, {
                    method: 'POST',
                    body: formData
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to read PDF');
                }
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
        const res = await fetch(`${API_BASE}/orders/generate-packaging-list-by-numbers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_numbers: orderNumbers })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to generate packaging list');
        }
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
        const createRes = await fetch(`${API_BASE}/orders/load-sheet-logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assignment_number: assignmentNumber,
                rider_name: riderName,
                order_numbers: orderNumbers,
                delivery_charge: deliveryCharge
            })
        });
        if (!createRes.ok) {
            const err = await createRes.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to save load sheet log');
        }
        const logData = await createRes.json();
        const logId = logData.id;
        closeGenerateLoadSheetModal();
        const pdfRes = await fetch(`${API_BASE}/orders/load-sheet-logs/${logId}/pdf`);
        if (!pdfRes.ok) throw new Error('Failed to generate PDF');
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
        const response = await fetch(`${API_BASE}/orders/load-sheet-logs`);
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `Failed to load (${response.status})`);
        }
        const logs = await response.json();
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
        const response = await fetch(`${API_BASE}/orders/load-sheet-logs/${logId}`, { method: 'DELETE' });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to delete');
        }
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
        const response = await fetch(`${API_BASE}/orders/load-sheet-logs/${logId}/pdf`);
        if (!response.ok) throw new Error('Failed to generate PDF');
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

// ============================================
// Navigation
// ============================================

function initNavigation() {
    navItems.forEach(item => {
        if (!item.dataset.view) return; // e.g. edit lock button has no data-view
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
        });
    });
    const editLockBtn = document.getElementById('editLockBtn');
    if (editLockBtn) {
        editLockBtn.addEventListener('click', () => {
            editLocked = !editLocked;
            applyEditLockState();
            showToast(editLocked ? 'Editing locked' : 'Editing unlocked', 'success');
        });
    }
}

function initOrdersPeriodFilter() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (selectEl) {
        selectEl.addEventListener('change', () => {
            const val = selectEl.value;
            if (val === '__all__') {
                loadOrders();
            } else {
                const [month, year] = val.split('-').map(Number);
                loadOrdersForPeriod(month, year);
            }
        });
    }
}

/** Date range filter popup for orders header button. Uses ordersGridApi and ORDERS_DATE_COLUMN_ID. */
function initOrdersDateRangeButton() {
    const triggerBtn = document.getElementById('ordersDateRangeBtn');
    if (!triggerBtn) return;

    const toDateInputValue = (val) => (val == null || val === '') ? '' : formatDateDDMMYYYY(val);

    const menu = document.createElement('div');
    menu.className = 'date-range-menu';
    menu.style.display = 'none';

    const fromField = document.createElement('div');
    fromField.className = 'date-range-menu__field';
    const fromLabel = document.createElement('label');
    fromLabel.className = 'date-range-menu__label';
    fromLabel.textContent = 'From';
    const fromInput = document.createElement('input');
    fromInput.type = 'text';
    fromInput.placeholder = 'dd/mm/yyyy';
    fromInput.className = 'grid-floating-filter-date';
    fromField.appendChild(fromLabel);
    fromField.appendChild(fromInput);

    const toField = document.createElement('div');
    toField.className = 'date-range-menu__field';
    const toLabel = document.createElement('label');
    toLabel.className = 'date-range-menu__label';
    toLabel.textContent = 'To';
    const toInput = document.createElement('input');
    toInput.type = 'text';
    toInput.placeholder = 'dd/mm/yyyy';
    toInput.className = 'grid-floating-filter-date';
    toField.appendChild(toLabel);
    toField.appendChild(toInput);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'date-range-menu__actions';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'date-range-menu__btn date-range-menu__btn--clear';
    clearBtn.textContent = 'Clear';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'date-range-menu__btn date-range-menu__btn--apply';
    applyBtn.textContent = 'Apply';
    actionsRow.appendChild(clearBtn);
    actionsRow.appendChild(applyBtn);

    menu.appendChild(fromField);
    menu.appendChild(toField);
    menu.appendChild(actionsRow);

    const flatpickrOpts = { dateFormat: 'd/m/Y', allowInput: true, static: false };
    const fromPicker = window.flatpickr ? window.flatpickr(fromInput, flatpickrOpts) : null;
    const toPicker = window.flatpickr ? window.flatpickr(toInput, flatpickrOpts) : null;

    function updateButtonLabel() {
        if (!ordersGridApi) return;
        const filterModel = ordersGridApi.getFilterModel() || {};
        const colFilter = filterModel[ORDERS_DATE_COLUMN_ID];
        const hasRange = colFilter && colFilter.type === 'inRange';
        triggerBtn.textContent = hasRange ? 'Range set' : 'Date range';
    }

    const updateFilter = () => {
        if (!ordersGridApi) return;
        const rawFrom = (fromInput.value || '').trim();
        const rawTo = (toInput.value || '').trim();
        const fromVal = rawFrom ? parseDDMMYYYYToYYYYMMDD(rawFrom) : null;
        const toVal = rawTo ? parseDDMMYYYYToYYYYMMDD(rawTo) : null;
        const currentModel = ordersGridApi.getFilterModel() || {};
        const newModel = { ...currentModel };
        if (fromVal && toVal) {
            const toDate = new Date(toVal);
            toDate.setDate(toDate.getDate() + 1);
            const toPlusOne = toDate.toISOString().slice(0, 10);
            newModel[ORDERS_DATE_COLUMN_ID] = { filterType: 'date', type: 'inRange', dateFrom: fromVal, dateTo: toPlusOne };
            triggerBtn.textContent = 'Range set';
        } else if (!fromVal && !toVal) {
            delete newModel[ORDERS_DATE_COLUMN_ID];
            triggerBtn.textContent = 'Date range';
        } else return;
        ordersGridApi.setFilterModel(newModel);
    };

    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        updateFilter();
        menu.style.display = 'none';
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fromInput.value = '';
        toInput.value = '';
        if (fromPicker) fromPicker.clear();
        if (toPicker) toPicker.clear();
        if (ordersGridApi) {
            const newModel = { ...(ordersGridApi.getFilterModel() || {}) };
            delete newModel[ORDERS_DATE_COLUMN_ID];
            ordersGridApi.setFilterModel(newModel);
        }
        triggerBtn.textContent = 'Date range';
        menu.style.display = 'none';
    });

    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display === 'none') {
            if (ordersGridApi) {
                const filterModel = ordersGridApi.getFilterModel() || {};
                const colFilter = filterModel[ORDERS_DATE_COLUMN_ID];
                if (colFilter && colFilter.type === 'inRange') {
                    const fromStr = toDateInputValue(colFilter.dateFrom);
                    const toStr = toDateInputValue(colFilter.dateTo);
                    fromInput.value = fromStr;
                    toInput.value = toStr;
                    if (fromPicker) fromPicker.setDate(fromStr || null, false);
                    if (toPicker) toPicker.setDate(toStr || null, false);
                } else {
                    fromInput.value = '';
                    toInput.value = '';
                    if (fromPicker) fromPicker.clear();
                    if (toPicker) toPicker.clear();
                }
            }
            const rect = triggerBtn.getBoundingClientRect();
            menu.style.top = `${rect.bottom + window.scrollY}px`;
            menu.style.left = `${rect.left + window.scrollX}px`;
            menu.style.display = 'block';
        } else {
            menu.style.display = 'none';
        }
    });

    document.body.appendChild(menu);

    // Menu only closes via Apply, Clear, or toggling the trigger button —
    // clicking elsewhere (including the flatpickr calendar) leaves it open.

    // Expose so onFilterChanged can update button label
    window._ordersDateRangeUpdateButtonLabel = updateButtonLabel;
}

function switchView(viewName) {
    currentView = viewName;

    // Update nav (ledgerDetail keeps the ledgers nav active)
    const navView = viewName === 'ledgerDetail' ? 'ledgers' : viewName;
    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === navView);
    });

    // Update views
    views.forEach(view => {
        view.classList.toggle('active', view.id === `${viewName}View`);
    });

    // Update header
    const titles = {
        'dashboard': { title: 'Dashboard', subtitle: 'Overview of your inventory' },
        'orders': { title: 'Orders', subtitle: 'View and manage orders' },
        'cashbook': { title: 'Cashbook', subtitle: 'Track daily cash inflows and outflows' },
        'ledgers': { title: 'Ledgers', subtitle: 'Manage individual account ledgers' },
        'ledgerDetail': { title: 'Ledger', subtitle: 'View ledger entries' },
        'monthSummary': { title: 'Month Summary', subtitle: 'View monthly order summaries' },
        'monthDetail': { title: 'Month Details', subtitle: 'View detailed month statistics' },
        'products': { title: 'Products', subtitle: 'Manage your product catalog' },
        'loadSheetLogs': { title: 'Load Sheet Logs', subtitle: 'View and download past load sheets' }
    };

    document.getElementById('viewTitle').textContent = titles[viewName].title;
    document.getElementById('viewSubtitle').textContent = titles[viewName].subtitle;

    // Show/hide buttons based on view
    const editCostPricesBtn = document.getElementById('editCostPricesBtn');
    const syncProductsBtn = document.getElementById('syncShopifyBtn');
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    const bulkUpdateOrderBtn = document.getElementById('bulkUpdateOrderBtn');
    const bulkUpdateCostPriceBtn = document.getElementById('bulkUpdateCostPriceBtn');
    const recalculateOrderCostsBtn = document.getElementById('recalculateOrderCostsBtn');
    const cashbookDateFilterWrap = document.getElementById('cashbookDateFilterWrap');

    if (editCostPricesBtn) {
        editCostPricesBtn.style.display = 'none'; // Hide since editing is inline now
    }

    if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'none';
    if (bulkUpdateCostPriceBtn) bulkUpdateCostPriceBtn.style.display = 'none';
    if (recalculateOrderCostsBtn) recalculateOrderCostsBtn.style.display = 'none';

    const ordersPeriodFilterWrap = document.getElementById('ordersPeriodFilterWrap');
    const headerOrdersAppActions = document.getElementById('headerOrdersAppActions');
    const headerOrdersBottomActions = document.getElementById('headerOrdersBottomActions');
    const ordersDateRangeBtn = document.getElementById('ordersDateRangeBtn');
    const ordersMoreActionGenerateInvoice = document.getElementById('ordersMoreActionGenerateInvoice');
    const ordersMoreActionGeneratePackagingList = document.getElementById('ordersMoreActionGeneratePackagingList');
    const exportGridExcelBtn = document.getElementById('exportGridExcelBtn');
    if (syncProductsBtn && syncOrdersBtn) {
        if (viewName === 'products') {
            syncProductsBtn.style.display = 'inline-flex';
            syncOrdersBtn.style.display = 'none';
            if (bulkUpdateCostPriceBtn) bulkUpdateCostPriceBtn.style.display = 'inline-flex';
            if (recalculateOrderCostsBtn) recalculateOrderCostsBtn.style.display = 'inline-flex';
            setOrdersMoreToolbarButtonsVisible(false);
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'none';
            if (headerOrdersAppActions) headerOrdersAppActions.style.display = 'none';
            if (headerOrdersBottomActions) headerOrdersBottomActions.style.display = 'none';
            if (ordersDateRangeBtn) ordersDateRangeBtn.style.display = 'none';
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'none';
            if (ordersMoreActionGenerateInvoice) ordersMoreActionGenerateInvoice.style.display = 'none';
            if (ordersMoreActionGeneratePackagingList) ordersMoreActionGeneratePackagingList.style.display = 'none';
            if (exportGridExcelBtn) exportGridExcelBtn.style.display = 'none';
            exitOrdersFullScreen();
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'none';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
        } else if (viewName === 'orders') {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'inline-flex';
            setOrdersMoreToolbarButtonsVisible(true);
            if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'inline-flex';
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'flex';
            if (headerOrdersAppActions) headerOrdersAppActions.style.display = 'inline-flex';
            if (headerOrdersBottomActions) headerOrdersBottomActions.style.display = 'inline-flex';
            if (ordersDateRangeBtn) ordersDateRangeBtn.style.display = 'inline-flex';
            if (typeof window._ordersDateRangeUpdateButtonLabel === 'function') window._ordersDateRangeUpdateButtonLabel();
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'none';
            if (ordersMoreActionGenerateInvoice) ordersMoreActionGenerateInvoice.style.display = 'inline-flex';
            if (ordersMoreActionGeneratePackagingList) ordersMoreActionGeneratePackagingList.style.display = 'inline-flex';
            if (exportGridExcelBtn) exportGridExcelBtn.style.display = 'inline-flex';
            requestAnimationFrame(() => syncOrdersBottomActionsWidth());
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'inline-flex';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
        } else if (viewName === 'cashbook') {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'none';
            setOrdersMoreToolbarButtonsVisible(false);
            if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'none';
            if (bulkUpdateCostPriceBtn) bulkUpdateCostPriceBtn.style.display = 'none';
            if (recalculateOrderCostsBtn) recalculateOrderCostsBtn.style.display = 'none';
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'none';
            if (headerOrdersAppActions) headerOrdersAppActions.style.display = 'none';
            if (headerOrdersBottomActions) headerOrdersBottomActions.style.display = 'none';
            if (ordersDateRangeBtn) ordersDateRangeBtn.style.display = 'none';
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'inline-flex';
            if (ordersMoreActionGenerateInvoice) ordersMoreActionGenerateInvoice.style.display = 'none';
            if (ordersMoreActionGeneratePackagingList) ordersMoreActionGeneratePackagingList.style.display = 'none';
            if (exportGridExcelBtn) exportGridExcelBtn.style.display = 'none';
            exitOrdersFullScreen();
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'none';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
        } else {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'none';
            setOrdersMoreToolbarButtonsVisible(false);
            if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'none';
            if (bulkUpdateCostPriceBtn) bulkUpdateCostPriceBtn.style.display = 'none';
            if (recalculateOrderCostsBtn) recalculateOrderCostsBtn.style.display = 'none';
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'none';
            if (headerOrdersAppActions) headerOrdersAppActions.style.display = 'none';
            if (headerOrdersBottomActions) headerOrdersBottomActions.style.display = 'none';
            if (ordersDateRangeBtn) ordersDateRangeBtn.style.display = 'none';
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'none';
            if (ordersMoreActionGenerateInvoice) ordersMoreActionGenerateInvoice.style.display = 'none';
            if (ordersMoreActionGeneratePackagingList) ordersMoreActionGeneratePackagingList.style.display = 'none';
            if (exportGridExcelBtn) exportGridExcelBtn.style.display = 'none';
            exitOrdersFullScreen();
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'none';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
        }
    }

    // Refresh data and resize grids when switching views
    if (viewName === 'products') {
        loadProducts();
        setTimeout(() => {
            if (productsGridApi) productsGridApi.sizeColumnsToFit();
        }, 100);
    } else if (viewName === 'orders') {
        loadOrders();
        setTimeout(() => {
            if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
        }, 100);
    } else if (viewName === 'cashbook') {
        loadCashbook();
        setTimeout(() => {
            if (cashbookIncomingGridApi) cashbookIncomingGridApi.sizeColumnsToFit();
            if (cashbookOutgoingGridApi) cashbookOutgoingGridApi.sizeColumnsToFit();
        }, 100);
    } else if (viewName === 'loadSheetLogs') {
        loadLoadSheetLogs();
    } else if (viewName === 'ledgers') {
        loadLedgers();
    } else if (viewName === 'ledgerDetail') {
        // Handled by openLedgerDetail
        setTimeout(() => {
            if (ledgerDetailGridApi) ledgerDetailGridApi.sizeColumnsToFit();
        }, 100);
    } else if (viewName === 'monthSummary') {
        loadMonthSummaryList();
    } else if (viewName === 'monthDetail') {
        // Handled by openMonthDetail
    } else if (viewName === 'dashboard') {
        loadProducts();
    }
}

// ============================================
// API Functions
// ============================================

async function loadProducts() {
    try {
        const response = await fetch(`${API_BASE}/products/`);
        if (!response.ok) throw new Error('Failed to fetch products');

        products = await response.json();
        products.sort((a, b) => {
            const nameA = (a.name || '').toLowerCase();
            const nameB = (b.name || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });
        
        updateDashboard();
        
        // Update AG Grid
        if (productsGridApi) {
            productsGridApi.setGridOption('rowData', products);
        }
    } catch (error) {
        console.error('Error loading products:', error);
        showToast('Failed to load products', 'error');
    }
}

// Period = month's 22 to next month's 21 (same as backend)
function getOrderDateForPeriod(order) {
    const raw = order.order_receiving_date || order.created_at;
    return raw ? new Date(raw) : null;
}

function getPeriodForDate(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;
    const d = date;
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    if (day >= 22) return { month, year };
    if (month === 1) return { month: 12, year: year - 1 };
    return { month: month - 1, year };
}

function ordersPeriodStartEnd(month, year) {
    const start = new Date(year, month - 1, 22, 0, 0, 0);
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const end = new Date(nextYear, nextMonth - 1, 21, 23, 59, 59);
    return { start, end };
}

function isOrderInPeriod(order, month, year) {
    const date = getOrderDateForPeriod(order);
    if (!date) return false;
    const { start, end } = ordersPeriodStartEnd(month, year);
    return date >= start && date <= end;
}

function formatOrdersPeriodLabel(month, year) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${monthNames[month - 1]} 22 – ${monthNames[nextMonth - 1]} 21, ${nextMonth === 1 ? nextYear : year}`;
}

/** Current period (month 22 – next 21) that contains today in PKT */
function getCurrentOrdersPeriod() {
    return getPeriodForDate(getPKTDate());
}

/** True if the given period (month 22 – next 21) has fully ended in PKT */
function isPeriodPassed(month, year) {
    const pkt = getPKTDate();
    const todayY = pkt.getFullYear();
    const todayM = pkt.getMonth() + 1;
    const todayD = pkt.getDate();
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    if (todayY > nextYear) return true;
    if (todayY < nextYear) return false;
    if (todayM > nextMonth) return true;
    if (todayM < nextMonth) return false;
    return todayD > 21;
}

/** Oldest period in dropdown: Oct 22 – Nov 21, 2024 */
const ORDERS_PERIOD_OLDEST_MONTH = 10;
const ORDERS_PERIOD_OLDEST_YEAR = 2024;

/** Build dropdown options: "All orders" + periods from current down to Oct 22 – Nov 21, 2024 */
function buildStaticPeriodOptions() {
    const options = [{ value: '__all__', label: 'All orders (recent)' }];
    let { month, year } = getCurrentOrdersPeriod();
    while (year > ORDERS_PERIOD_OLDEST_YEAR || (year === ORDERS_PERIOD_OLDEST_YEAR && month >= ORDERS_PERIOD_OLDEST_MONTH)) {
        options.push({ value: `${month}-${year}`, label: formatOrdersPeriodLabel(month, year) });
        if (month === 1) {
            month = 12;
            year -= 1;
        } else {
            month -= 1;
        }
    }
    return options;
}

function populateOrdersPeriodFilterDropdown() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const options = buildStaticPeriodOptions();
    selectEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    if (currentVal && options.some((o) => o.value === currentVal)) {
        selectEl.value = currentVal;
    } else {
        selectEl.value = '__all__';
    }
}

async function loadOrders() {
    if (ordersGridApi) ordersGridApi.showLoadingOverlay();
    try {
        const response = await fetch(`${API_BASE}/orders/`);
        if (!response.ok) throw new Error('Failed to fetch orders');

        orders = await response.json();

        populateOrdersPeriodFilterDropdown();
        const selectEl = document.getElementById('ordersPeriodFilter');
        if (selectEl) selectEl.value = '__all__';

        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            // advance_status isn't a column field, so a delta rowData update won't
            // re-render the Advance cell when only the status changed. Force it.
            ordersGridApi.refreshCells({ columns: ['advance_amount'], force: true });
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            populateOrdersPeriodFilterDropdown();
            const sel = document.getElementById('ordersPeriodFilter');
            if (sel) sel.value = '__all__';
            if (ordersGridApi) {
                ordersGridApi.setGridOption('rowData', orders);
                setTimeout(() => updateFooterRow(), 0);
            }
        }
    } finally {
        if (ordersGridApi) ordersGridApi.hideOverlay();
        void updateDashboard();
    }
}

/** Load orders for a specific period from API (for older months beyond the initial 1000) */
async function loadOrdersForPeriod(month, year) {
    if (ordersGridApi) ordersGridApi.showLoadingOverlay();
    try {
        const response = await fetch(`${API_BASE}/orders/?month=${month}&year=${year}`);
        if (!response.ok) throw new Error('Failed to fetch orders for period');

        orders = await response.json();

        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            ordersGridApi.refreshCells({ columns: ['advance_amount'], force: true });
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (error) {
        console.error('Error loading orders for period:', error);
        showToast('Failed to load orders for period', 'error');
        if (ordersGridApi) ordersGridApi.setGridOption('rowData', []);
    } finally {
        if (ordersGridApi) ordersGridApi.hideOverlay();
        void updateDashboard();
    }
}

function getSampleOrders() {
    return [
        { id: '1', order_number: 2719, courier: '1289', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 4247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '2', order_number: 2720, courier: 'RIDER', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 7697, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '3', order_number: 2721, courier: '1287', order_status: 'unfulfilled', piece_received: 'Pending', delivery_status: 'not_delivered', total_amount: 3248, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '4', order_number: 2722, courier: 'RIDER', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 8247, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '5', order_number: 2724, courier: '1293', order_status: 'returned', piece_received: 'Received', delivery_status: 'not_delivered', total_amount: 3247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() }
    ];
}

// ============================================
// Cashbook
// ============================================

function normalizeCashbookEntries(entries) {
    return (entries || []).map((entry) => ({
        ...entry,
        entry_date: entry.entry_date ? String(entry.entry_date).slice(0, 10) : ''
    }));
}

function getEmptyCashbookRow(entryDate = '', side = '') {
    // Use a unique ID each time to ensure AG Grid creates a fresh row
    return {
        id: '__new_' + side + '_' + Date.now() + '__',
        entry_date: entryDate,
        description: '',
        folio: null,
        amount: null,
        running_total: null
    };
}

function buildCashbookRows(entries, openingBalance) {
    const sorted = [...entries].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });

    let running = parseFloat(openingBalance) || 0;
    let totalInflow = 0;
    let totalOutflow = 0;
    const dailySummary = [];
    let currentDate = null;
    let dayOpening = running;
    let dayInflow = 0;
    let dayOutflow = 0;

    const rows = sorted.map((entry) => {
        const entryDate = entry.entry_date || '';
        if (currentDate !== null && entryDate !== currentDate) {
            dailySummary.push({
                date: currentDate,
                opening: dayOpening,
                inflow: dayInflow,
                outflow: dayOutflow,
                closing: running
            });
            dayOpening = running;
            dayInflow = 0;
            dayOutflow = 0;
        }

        if (currentDate !== entryDate) {
            currentDate = entryDate;
        }

        const amount = parseFloat(entry.amount) || 0;
        const inflow = entry.entry_type === 'inflow' ? amount : 0;
        const outflow = entry.entry_type === 'outflow' ? amount : 0;
        totalInflow += inflow;
        totalOutflow += outflow;
        running += inflow - outflow;
        dayInflow += inflow;
        dayOutflow += outflow;

        return {
            ...entry,
            inflow,
            outflow,
            running_balance: running
        };
    });

    if (currentDate !== null) {
        dailySummary.push({
            date: currentDate,
            opening: dayOpening,
            inflow: dayInflow,
            outflow: dayOutflow,
            closing: running
        });
    }

    return {
        rows,
        dailySummary,
        totals: {
            totalInflow,
            totalOutflow,
            closingBalance: running
        }
    };
}

function buildCashbookSideRows(entries, side) {
    const filtered = (entries || []).filter((entry) => entry.entry_type === side);
    const sorted = [...filtered].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    return sorted.map((entry) => ({
        ...entry,
        amount: parseFloat(entry.amount) || 0
    }));
}

function buildCashbookIncomingWithOpening(entries, carryForward, selectedDate) {
    const opening = parseFloat(carryForward) || 0;
    const rows = buildCashbookSideRows(entries, 'inflow');
    const totalInflow = rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const openingRow = {
        id: '__opening__',
        description: "Opening Balance",
        amount: opening,
        _isSystemRow: true
    };
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'inflow');
    const totalRow = {
        id: '__total_in__',
        description: 'Total',
        amount: opening + totalInflow,
        _isFooter: true
    };
    return { rowData: [openingRow, ...rows, newEntryRow], pinnedBottomRowData: [totalRow], totalInflow };
}

function buildCashbookOutgoingWithClosing(entries, carryForward, selectedDate) {
    const inflowEntries = (entries || []).filter((e) => e.entry_type === 'inflow');
    const outflowEntries = (entries || []).filter((e) => e.entry_type === 'outflow');
    const totalInflow = inflowEntries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const totalOutflow = outflowEntries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const opening = parseFloat(carryForward) || 0;
    const closingBalance = opening + totalInflow - totalOutflow;
    const rows = buildCashbookSideRows(entries, 'outflow');
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'outflow');
    const closingRow = {
        id: '__closing__',
        description: 'Closing Balance',
        amount: closingBalance,
        _isSystemRow: true
    };
    const totalRow = {
        id: '__total_out__',
        description: 'Total',
        amount: totalOutflow + closingBalance,
        _isFooter: true
    };
    return { rowData: [...rows, newEntryRow, closingRow], pinnedBottomRowData: [totalRow], totalOutflow };
}

async function loadDailyBalance(targetDate) {
    try {
        const response = await fetch(`${API_BASE}/cashbook/daily-balance/${targetDate}`);
        if (!response.ok) throw new Error('Failed to load daily balance');
        cashbookDailyBalance = await response.json();
    } catch (error) {
        console.error('Error loading daily balance:', error);
        // Default to zero if balance can't be loaded
        cashbookDailyBalance = {
            balance_date: targetDate,
            opening_balance: 0,
            total_inflow: 0,
            total_outflow: 0,
            closing_balance: 0
        };
    }
}

async function loadCashbookEntriesForDate(targetDate, showLoading = true) {
    if (showLoading) {
        if (cashbookIncomingGridApi) cashbookIncomingGridApi.showLoadingOverlay();
        if (cashbookOutgoingGridApi) cashbookOutgoingGridApi.showLoadingOverlay();
    }
    try {
        const response = await fetch(`${API_BASE}/cashbook/entries?start_date=${targetDate}&end_date=${targetDate}`);
        if (!response.ok) throw new Error('Failed to load cashbook entries');
        cashbookEntries = normalizeCashbookEntries(await response.json());
    } catch (error) {
        console.error('Error loading cashbook entries:', error);
        showToast('Failed to load cashbook entries', 'error');
        cashbookEntries = [];
    } finally {
        if (showLoading) {
            if (cashbookIncomingGridApi) cashbookIncomingGridApi.hideOverlay();
            if (cashbookOutgoingGridApi) cashbookOutgoingGridApi.hideOverlay();
        }
    }
}

function renderCashbook() {
    const selectedDate = cashbookSelectedDate || getTodayDateString();
    const openingBalance = cashbookDailyBalance ? parseFloat(cashbookDailyBalance.opening_balance) || 0 : 0;
    const filteredEntries = cashbookEntries.filter((entry) => entry.entry_date === selectedDate);

    const { rowData: incomingRowData, pinnedBottomRowData: incomingPinnedBottom } = buildCashbookIncomingWithOpening(filteredEntries, openingBalance, selectedDate);
    const { rowData: outgoingRowData, pinnedBottomRowData: outgoingPinnedBottom } = buildCashbookOutgoingWithClosing(filteredEntries, openingBalance, selectedDate);

    if (cashbookIncomingGridApi) {
        cashbookIncomingGridApi.setGridOption('rowData', incomingRowData);
        cashbookIncomingGridApi.setGridOption('pinnedTopRowData', []);
        cashbookIncomingGridApi.setGridOption('pinnedBottomRowData', incomingPinnedBottom);
        cashbookIncomingGridApi.setGridOption('pagination', false);
    }
    if (cashbookOutgoingGridApi) {
        cashbookOutgoingGridApi.setGridOption('rowData', outgoingRowData);
        cashbookOutgoingGridApi.setGridOption('pinnedTopRowData', []);
        cashbookOutgoingGridApi.setGridOption('pinnedBottomRowData', outgoingPinnedBottom);
        cashbookOutgoingGridApi.setGridOption('pagination', false);
    }
}

async function loadCashbook() {
    const dateFilter = document.getElementById('cashbookDateFilter');
    if (!cashbookSelectedDate) {
        cashbookSelectedDate = getTodayDateString();
    }
    if (dateFilter) dateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate);
    
    await Promise.all([
        loadDailyBalance(cashbookSelectedDate),
        loadCashbookEntriesForDate(cashbookSelectedDate),
        loadLedgersList()
    ]);
    renderCashbook();
    updateCashInHand();
}

async function reloadCashbookForCurrentDate(showLoading = true) {
    const selectedDate = cashbookSelectedDate || getTodayDateString();
    await Promise.all([
        loadDailyBalance(selectedDate),
        loadCashbookEntriesForDate(selectedDate, showLoading)
    ]);
    renderCashbook();
    updateCashInHand();
}

async function addCashbookEntry() {
    const dateInput = document.getElementById('cashbookEntryDate');
    const typeInput = document.getElementById('cashbookEntryType');
    const amountInput = document.getElementById('cashbookEntryAmount');
    const descInput = document.getElementById('cashbookEntryDescription');
    if (!dateInput || !typeInput || !amountInput) return;

    const entryDate = String(dateInput.value || '').trim();
    const entryType = String(typeInput.value || '').trim();
    const amount = parseFloat(amountInput.value);
    const description = descInput ? String(descInput.value || '').trim() : '';

    if (!entryDate) {
        showToast('Select an entry date', 'error');
        return;
    }
    if (!entryType || (entryType !== 'inflow' && entryType !== 'outflow')) {
        showToast('Select a valid entry type', 'error');
        return;
    }
    if (Number.isNaN(amount) || amount <= 0) {
        showToast('Enter a valid amount', 'error');
        return;
    }

    await createCashbookEntry({
        entry_date: entryDate,
        entry_type: entryType,
        amount,
        description
    });
    if (amountInput) amountInput.value = '';
    if (descInput) descInput.value = '';
}

// --- Create Cashbook Entry modal ---------------------------------------------

// Tracks whether the user has manually edited the outgoing amount. Until they do,
// the outgoing amount mirrors whatever is typed in the incoming amount.
let cashbookEntryOutAmountTouched = false;

function cashbookEntryLedgerName(ledgerId) {
    const ledger = ledgers.find(l => l.id === ledgerId);
    return ledger ? ledger.name : '';
}

function cashbookEntryParticularPlaceholder(side, ledgerId) {
    const name = cashbookEntryLedgerName(ledgerId);
    if (!name) return side === 'inflow' ? 'Amount received from...' : 'Amount transferred to...';
    return side === 'inflow' ? `Amount received from ${name}` : `Amount transferred to ${name}`;
}

function refreshCashbookEntryParticularPlaceholders() {
    const inLedger = document.getElementById('cashbookEntryInLedger');
    const outLedger = document.getElementById('cashbookEntryOutLedger');
    const inPart = document.getElementById('cashbookEntryInParticular');
    const outPart = document.getElementById('cashbookEntryOutParticular');
    if (inPart) inPart.placeholder = cashbookEntryParticularPlaceholder('inflow', inLedger ? inLedger.value : '');
    if (outPart) outPart.placeholder = cashbookEntryParticularPlaceholder('outflow', outLedger ? outLedger.value : '');
}

// Enables/disables one side of the entry modal. A disabled (skipped) side will not
// create an entry; its `required` attributes are removed so the form can still submit.
function setCashbookEntrySideSkipped(side, skipped) {
    const prefix = side === 'inflow' ? 'cashbookEntryIn' : 'cashbookEntryOut';
    const ledger = document.getElementById(prefix + 'Ledger');
    const amount = document.getElementById(prefix + 'Amount');
    const part = document.getElementById(prefix + 'Particular');
    [ledger, amount, part].forEach((el) => {
        if (!el) return;
        el.disabled = skipped;
        // required only applies to ledger + amount; particulars is optional anyway.
        if (el === ledger || el === amount) {
            if (skipped) el.removeAttribute('required');
            else el.setAttribute('required', '');
        }
    });
    const fieldset = ledger ? ledger.closest('.cashbook-entry-side') : null;
    if (fieldset) fieldset.classList.toggle('cashbook-entry-side-skipped', skipped);
}

function populateCashbookEntryLedgerSelect(select) {
    if (!select) return;
    const current = select.value;
    const options = ['<option value="">Select ledger...</option>']
        .concat(ledgers.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`));
    select.innerHTML = options.join('');
    if (current && ledgers.some(l => l.id === current)) select.value = current;
}

function openCashbookEntryModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    cashbookEntryOutAmountTouched = false;
    const inLedger = document.getElementById('cashbookEntryInLedger');
    const outLedger = document.getElementById('cashbookEntryOutLedger');
    const inAmount = document.getElementById('cashbookEntryInAmount');
    const outAmount = document.getElementById('cashbookEntryOutAmount');
    const inPart = document.getElementById('cashbookEntryInParticular');
    const outPart = document.getElementById('cashbookEntryOutParticular');

    populateCashbookEntryLedgerSelect(inLedger);
    populateCashbookEntryLedgerSelect(outLedger);
    if (inLedger) inLedger.value = '';
    if (outLedger) outLedger.value = '';
    if (inAmount) inAmount.value = '';
    if (outAmount) outAmount.value = '';
    if (inPart) inPart.value = '';
    if (outPart) outPart.value = '';

    const inSkip = document.getElementById('cashbookEntryInSkip');
    const outSkip = document.getElementById('cashbookEntryOutSkip');
    if (inSkip) inSkip.checked = false;
    if (outSkip) outSkip.checked = false;
    setCashbookEntrySideSkipped('inflow', false);
    setCashbookEntrySideSkipped('outflow', false);

    if (ledgers.length === 0) {
        showToast('No ledgers available. Create a ledger first.', 'error');
    }

    refreshCashbookEntryParticularPlaceholders();
    document.getElementById('cashbookEntryModal').classList.add('active');
    if (inLedger) inLedger.focus();
}

function closeCashbookEntryModal() {
    document.getElementById('cashbookEntryModal').classList.remove('active');
}

async function submitCashbookEntryModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const skipIn = document.getElementById('cashbookEntryInSkip').checked;
    const skipOut = document.getElementById('cashbookEntryOutSkip').checked;

    if (skipIn && skipOut) {
        showToast('At least one side must be entered', 'error');
        return;
    }

    const inLedger = document.getElementById('cashbookEntryInLedger').value;
    const outLedger = document.getElementById('cashbookEntryOutLedger').value;
    const inAmount = parseFloat(document.getElementById('cashbookEntryInAmount').value);
    const outAmount = parseFloat(document.getElementById('cashbookEntryOutAmount').value);
    const inPartEl = document.getElementById('cashbookEntryInParticular');
    const outPartEl = document.getElementById('cashbookEntryOutParticular');

    if (!skipIn) {
        if (!inLedger) { showToast('Select an incoming ledger', 'error'); return; }
        if (Number.isNaN(inAmount) || inAmount <= 0) { showToast('Enter a valid incoming amount', 'error'); return; }
    }
    if (!skipOut) {
        if (!outLedger) { showToast('Select an outgoing ledger', 'error'); return; }
        if (Number.isNaN(outAmount) || outAmount <= 0) { showToast('Enter a valid outgoing amount', 'error'); return; }
    }

    const entryDate = cashbookSelectedDate || getTodayDateString();
    const requests = [];

    if (!skipIn) {
        // If the particulars field is left empty, fall back to the default placeholder text.
        const inDescription = (inPartEl.value.trim()) || cashbookEntryParticularPlaceholder('inflow', inLedger);
        requests.push(createCashbookEntry({ entry_date: entryDate, entry_type: 'inflow', amount: inAmount, description: inDescription, folio: inLedger }));
    }
    if (!skipOut) {
        const outDescription = (outPartEl.value.trim()) || cashbookEntryParticularPlaceholder('outflow', outLedger);
        requests.push(createCashbookEntry({ entry_date: entryDate, entry_type: 'outflow', amount: outAmount, description: outDescription, folio: outLedger }));
    }

    closeCashbookEntryModal();
    await Promise.all(requests);
}

// --- Order Advance Amount modal ----------------------------------------------

// The "Orders" ledger that order advances are always posted to (hardcoded).
const ORDERS_LEDGER_ID = '020dbc00-d5da-4110-89e9-fa22edf002f6';

// Tracks whether the user has manually edited the outgoing amount in the order
// advance modal. Until they do, it mirrors the advance (incoming) amount.
let orderAdvanceOutAmountTouched = false;

// Default incoming particulars text for an order advance.
function orderAdvanceParticularPlaceholder(orderNumber) {
    const num = String(orderNumber || '').trim().replace(/^#/, '');
    return num ? `Amount received for Order #${num}` : 'Amount received for Order #...';
}

function refreshOrderAdvanceParticularPlaceholder() {
    const orderNumber = document.getElementById('orderAdvanceOrderNumber');
    const inPart = document.getElementById('orderAdvanceInParticular');
    if (inPart) inPart.placeholder = orderAdvanceParticularPlaceholder(orderNumber ? orderNumber.value : '');
}

function refreshOrderAdvanceOutParticularPlaceholder() {
    const orderNumber = document.getElementById('orderAdvanceOrderNumber');
    const outPart = document.getElementById('orderAdvanceOutParticular');
    if (outPart) outPart.placeholder = orderAdvanceParticularPlaceholder(orderNumber ? orderNumber.value : '');
}

function openOrderAdvanceModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const orderNumber = document.getElementById('orderAdvanceOrderNumber');
    const amount = document.getElementById('orderAdvanceAmount');
    const inPart = document.getElementById('orderAdvanceInParticular');
    const outLedger = document.getElementById('orderAdvanceOutLedger');
    const outAmount = document.getElementById('orderAdvanceOutAmount');
    const outPart = document.getElementById('orderAdvanceOutParticular');

    populateCashbookEntryLedgerSelect(outLedger);
    if (orderNumber) orderNumber.value = '';
    if (amount) amount.value = '';
    if (inPart) inPart.value = '';
    if (outLedger) outLedger.value = '';
    if (outAmount) outAmount.value = '';
    if (outPart) outPart.value = '';

    orderAdvanceOutAmountTouched = false;
    refreshOrderAdvanceParticularPlaceholder();
    refreshOrderAdvanceOutParticularPlaceholder();
    document.getElementById('orderAdvanceModal').classList.add('active');
    if (orderNumber) orderNumber.focus();
}

function closeOrderAdvanceModal() {
    document.getElementById('orderAdvanceModal').classList.remove('active');
}

async function submitOrderAdvanceModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    const orderNumber = document.getElementById('orderAdvanceOrderNumber').value.trim();
    const inAmount = parseFloat(document.getElementById('orderAdvanceAmount').value);
    const inPartEl = document.getElementById('orderAdvanceInParticular');
    const outLedger = document.getElementById('orderAdvanceOutLedger').value;
    const outAmount = parseFloat(document.getElementById('orderAdvanceOutAmount').value);
    const outPartEl = document.getElementById('orderAdvanceOutParticular');

    if (!orderNumber) { showToast('Enter an order number', 'error'); return; }
    if (Number.isNaN(inAmount) || inAmount <= 0) { showToast('Enter a valid advance amount', 'error'); return; }
    if (!outLedger) { showToast('Select an outgoing ledger', 'error'); return; }
    if (Number.isNaN(outAmount) || outAmount <= 0) { showToast('Enter a valid outgoing amount', 'error'); return; }

    const entryDate = cashbookSelectedDate || getTodayDateString();
    const inDescription = (inPartEl.value.trim()) || orderAdvanceParticularPlaceholder(orderNumber);
    const outDescription = (outPartEl.value.trim()) || orderAdvanceParticularPlaceholder(orderNumber);

    closeOrderAdvanceModal();
    // Tag the incoming (advance) entry with the order number so it can be reconciled
    // against the order's Shopify advance amount.
    const normalizedOrderNumber = orderNumber.replace(/^#/, '').trim();
    await Promise.all([
        createCashbookEntry({ entry_date: entryDate, entry_type: 'inflow', amount: inAmount, description: inDescription, folio: ORDERS_LEDGER_ID, order_number: normalizedOrderNumber }),
        createCashbookEntry({ entry_date: entryDate, entry_type: 'outflow', amount: outAmount, description: outDescription, folio: outLedger })
    ]);
    // Refresh orders so the advance status indicator updates for this order.
    if (typeof loadOrders === 'function') { try { await loadOrders(); } catch (e) {} }
}

// --- Bulk Text Entry modal ---------------------------------------------------

// Holds the most recent parse result so the submit handler can reuse it.
let bulkEntryParsed = null;

function openBulkEntryModal() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error');
        return;
    }
    if (ledgers.length === 0) {
        showToast('No ledgers available. Create a ledger first.', 'error');
        return;
    }
    const input = document.getElementById('bulkEntryInput');
    if (input) { input.value = ''; input.disabled = false; }
    const validation = document.getElementById('bulkEntryValidation');
    if (validation) { validation.style.display = 'none'; validation.innerHTML = ''; }
    const cancelBtn = document.getElementById('bulkEntryCancelBtn');
    if (cancelBtn) cancelBtn.disabled = false;
    setBulkEntryProgress('');
    bulkEntryParsed = null;
    setBulkEntrySubmitEnabled(false);
    document.getElementById('bulkEntryModal').classList.add('active');
    if (input) input.focus();
}

// True while bulk entries are being created; blocks closing the modal mid-run.
let bulkEntryCreating = false;

function closeBulkEntryModal() {
    if (bulkEntryCreating) return;
    document.getElementById('bulkEntryModal').classList.remove('active');
}

function setBulkEntrySubmitEnabled(enabled) {
    const btn = document.getElementById('bulkEntrySubmitBtn');
    if (btn) btn.disabled = !enabled;
}

// Find a ledger by name (case-insensitive, trimmed). Returns the ledger or null.
function findLedgerByName(name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    return ledgers.find(l => String(l.name || '').trim().toLowerCase() === target) || null;
}

/**
 * Extract an order number from particulars text. Looks for "order" and/or "#"
 * followed by a number of 4 or more digits, allowing spaces between the tokens.
 * Order numbers start at 1000 and can grow beyond 9999 (10000+).
 * Examples matched: "Order #9865", "order# 9865", "Order  9865", "#9865", "#12345".
 * Returns the digits as a string, or null if none found.
 */
function extractOrderNumberFromText(text) {
    const s = String(text || '');
    // "order" then optional "#", then 4+ digits (spaces allowed between tokens)
    let m = s.match(/order\s*#?\s*(\d{4,})\b/i);
    if (m) return m[1];
    // bare "#" then 4+ digits
    m = s.match(/#\s*(\d{4,})\b/);
    if (m) return m[1];
    return null;
}

/**
 * Parse one line of bulk-entry text.
 * Format: <KIND>: <AMOUNT> <PARTICULARS> "<LEDGER1>" ["<LEDGER2>"]
 * Returns { ok, errors: [str], lineNo, raw, kind, amount, particulars, entries: [{entry_type, amount, description, folio}] }
 */
function parseBulkEntryLine(raw, lineNo) {
    const result = { ok: false, errors: [], lineNo, raw };
    const line = String(raw || '').trim();
    if (!line) { result.blank = true; return result; }

    // Find the KIND token (IN / OUT / XFER followed by ':') anywhere in the line and
    // ignore anything before it. This lets pasted lines keep prefixes like a
    // WhatsApp timestamp, e.g. "[3:32 am, 10/06/2026] Arham Ghory: IN: 16400 ...".
    const kindMatch = line.match(/\b(IN|OUT|XFER)\s*:\s*(.*)$/i);
    if (!kindMatch) {
        result.errors.push('Missing "<KIND>:" prefix (use IN:, OUT:, or XFER:).');
        return result;
    }
    const kind = kindMatch[1].toUpperCase();
    const rest = kindMatch[2];
    result.kind = kind;
    // The cleaned line (from KIND: onward) without any pasted prefix such as a
    // WhatsApp timestamp. Shown in the validation list instead of the raw line.
    result.cleaned = `${kind}: ${rest.trim()}`;

    // Extract quoted ledger names (in order).
    const quoted = [];
    const quoteRe = /"([^"]*)"/g;
    let m;
    while ((m = quoteRe.exec(rest)) !== null) quoted.push(m[1]);

    // The portion before the first quote holds amount + particulars.
    const firstQuoteIdx = rest.indexOf('"');
    const head = (firstQuoteIdx === -1 ? rest : rest.slice(0, firstQuoteIdx)).trim();

    // Amount is the first token of head.
    const headMatch = head.match(/^([0-9][0-9,]*(?:\.[0-9]+)?)\s*(.*)$/);
    if (!headMatch) {
        result.errors.push('Missing or invalid amount (must come right after the colon).');
    } else {
        const amount = parseFloat(headMatch[1].replace(/,/g, ''));
        if (Number.isNaN(amount) || amount <= 0) {
            result.errors.push('Amount must be a number greater than 0.');
        } else {
            result.amount = amount;
        }
        result.particulars = (headMatch[2] || '').trim();
    }

    // Validate quoted-ledger count per kind.
    const expected = kind === 'XFER' ? 2 : 1;
    if (quoted.length < expected) {
        result.errors.push(`${kind} requires ${expected} quoted ledger name${expected > 1 ? 's' : ''}; found ${quoted.length}.`);
    } else if (quoted.length > expected) {
        result.errors.push(`${kind} expects ${expected} quoted ledger name${expected > 1 ? 's' : ''}; found ${quoted.length}.`);
    }

    // Resolve ledger names against existing ledgers.
    const resolved = quoted.map(name => ({ name, ledger: findLedgerByName(name) }));
    resolved.forEach(r => {
        if (!r.ledger) result.errors.push(`Ledger "${r.name}" not found.`);
    });

    if (result.errors.length > 0) return result;

    // Build cashbook entries. Particulars default to a placeholder if empty.
    const description = result.particulars || `${kind} entry`;

    // An inflow to the "Orders" ledger is an order-advance entry; tag it with the
    // order number parsed from the particulars so advance reconciliation works.
    const orderNumber = extractOrderNumberFromText(result.particulars);
    const makeInflow = (ledger) => {
        const entry = { entry_type: 'inflow', amount: result.amount, description, folio: ledger.id };
        if (ledger.id === ORDERS_LEDGER_ID && orderNumber) entry.order_number = orderNumber;
        return entry;
    };

    const entries = [];
    if (kind === 'IN') {
        entries.push(makeInflow(resolved[0].ledger));
    } else if (kind === 'OUT') {
        entries.push({ entry_type: 'outflow', amount: result.amount, description, folio: resolved[0].ledger.id });
    } else { // XFER: LEDGER1 in, LEDGER2 out
        entries.push(makeInflow(resolved[0].ledger));
        entries.push({ entry_type: 'outflow', amount: result.amount, description, folio: resolved[1].ledger.id });
    }
    result.entries = entries;
    result.orderNumber = orderNumber || null;
    result.ok = true;
    return result;
}

/** Parse the whole textarea. Returns { lines: [parsed], hasError, hasAny }. */
function parseBulkEntryText(text) {
    const rawLines = String(text || '').split(/\r?\n/);
    const lines = [];
    let hasError = false;
    let hasAny = false;
    rawLines.forEach((raw, i) => {
        const parsed = parseBulkEntryLine(raw, i + 1);
        if (parsed.blank) return; // ignore blank lines
        lines.push(parsed);
        hasAny = true;
        if (!parsed.ok) hasError = true;
    });
    return { lines, hasError, hasAny };
}

/** Validate the textarea and render results. Returns the parse result. */
function validateBulkEntry() {
    const input = document.getElementById('bulkEntryInput');
    const validation = document.getElementById('bulkEntryValidation');
    const parsed = parseBulkEntryText(input ? input.value : '');
    bulkEntryParsed = parsed;

    if (!validation) return parsed;
    if (!parsed.hasAny) {
        validation.style.display = 'block';
        validation.innerHTML = '<div class="bulk-entry-msg bulk-entry-msg-error">No entries to validate.</div>';
        setBulkEntrySubmitEnabled(false);
        return parsed;
    }

    const rows = parsed.lines.map(p => {
        // Show the cleaned line (KIND: onward) so pasted prefixes like WhatsApp
        // timestamps don't appear; fall back to raw when there's no KIND token.
        const displayText = p.cleaned || p.raw;
        if (p.ok) {
            const summary = p.entries
                .map(e => {
                    const dir = e.entry_type === 'inflow' ? '▲ in' : '▼ out';
                    const tag = e.order_number ? ` [Order #${escapeHtml(e.order_number)}]` : '';
                    return `${dir} ${formatBulkAmount(e.amount)} → ${escapeHtml(ledgerNameById(e.folio))}${tag}`;
                })
                .join(' , ');
            return `<div class="bulk-entry-line bulk-entry-line-ok">`
                + `<span class="bulk-entry-line-no">${p.lineNo}</span>`
                + `<span class="bulk-entry-line-text">${escapeHtml(displayText)}</span>`
                + `<span class="bulk-entry-line-detail">${summary}</span>`
                + `</div>`;
        }
        return `<div class="bulk-entry-line bulk-entry-line-error">`
            + `<span class="bulk-entry-line-no">${p.lineNo}</span>`
            + `<span class="bulk-entry-line-text">${escapeHtml(displayText)}</span>`
            + `<span class="bulk-entry-line-detail">${p.errors.map(escapeHtml).join(' ')}</span>`
            + `</div>`;
    }).join('');

    validation.style.display = 'block';
    validation.innerHTML = rows;
    setBulkEntrySubmitEnabled(!parsed.hasError);
    return parsed;
}

function ledgerNameById(id) {
    const l = ledgers.find(x => x.id === id);
    return l ? l.name : '(unknown)';
}

function formatBulkAmount(val) {
    const n = parseFloat(val) || 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function submitBulkEntry() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error'); return; }
    // Re-validate to be safe (the textarea may have changed since last validate).
    const parsed = validateBulkEntry();
    if (!parsed.hasAny) { showToast('No entries to create', 'error'); return; }
    if (parsed.hasError) { showToast('Fix the highlighted entries first', 'error'); return; }

    const entryDate = cashbookSelectedDate || getTodayDateString();
    const payloads = [];
    parsed.lines.forEach(p => {
        p.entries.forEach(e => payloads.push({ ...e, entry_date: entryDate }));
    });

    const total = payloads.length;
    const submitBtn = document.getElementById('bulkEntrySubmitBtn');
    const cancelBtn = document.getElementById('bulkEntryCancelBtn');
    const input = document.getElementById('bulkEntryInput');

    // Lock the modal while creating so the user can't edit or close mid-run.
    bulkEntryCreating = true;
    setBulkEntrySubmitEnabled(false);
    if (cancelBtn) cancelBtn.disabled = true;
    if (input) input.disabled = true;

    let created = 0;
    let failed = 0;
    // Create sequentially so daily-balance recalculation stays consistent, and so
    // a single failure doesn't abort the remaining entries.
    for (const payload of payloads) {
        setBulkEntryProgress(`Creating entries… ${created + failed + 1} of ${total}`);
        try {
            const response = await fetch(`${API_BASE}/cashbook/entries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error('Failed to create entry');
            created += 1;
        } catch (error) {
            console.error('Error creating bulk entry:', error, payload);
            failed += 1;
        }
    }

    // If any order-advance entries were created, refresh orders so the advance
    // status indicators update.
    const createdOrderAdvance = payloads.some(p => p.order_number);

    if (failed === 0) {
        // All entries created: show the count, reload, then close the popup.
        setBulkEntryProgress(`Created ${created} of ${total} entries.`, 'ok');
        showToast(`Created ${created} entr${created === 1 ? 'y' : 'ies'}`, 'success');
        await reloadCashbookForCurrentDate(true);
        if (createdOrderAdvance && typeof loadOrders === 'function') { try { await loadOrders(); } catch (e) {} }
        bulkEntryCreating = false;
        if (input) input.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        closeBulkEntryModal();
    } else {
        // Some failed: keep the popup open so the user can review/retry.
        setBulkEntryProgress(`Created ${created} of ${total}. ${failed} failed — review and retry.`, 'error');
        showToast(`${created} created, ${failed} failed`, 'error');
        await reloadCashbookForCurrentDate(true);
        if (createdOrderAdvance && typeof loadOrders === 'function') { try { await loadOrders(); } catch (e) {} }
        bulkEntryCreating = false;
        if (input) input.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        setBulkEntrySubmitEnabled(true);
    }
}

// Show a progress/result message in the bulk-entry modal footer area.
function setBulkEntryProgress(text, kind) {
    const el = document.getElementById('bulkEntryProgress');
    if (!el) return;
    el.style.display = text ? 'block' : 'none';
    el.textContent = text || '';
    el.className = 'bulk-entry-progress'
        + (kind === 'ok' ? ' bulk-entry-progress-ok' : '')
        + (kind === 'error' ? ' bulk-entry-progress-error' : '');
}

async function createCashbookEntry(payload) {
    // Optimistic update: add entry to local array immediately
    const tempId = '__temp_' + Date.now();
    const tempEntry = {
        ...payload,
        id: tempId,
        entry_date: String(payload.entry_date || '').slice(0, 10),
        created_at: getPKTISOString(),
        updated_at: getPKTISOString()
    };
    cashbookEntries.push(tempEntry);
    renderCashbook();

    try {
        const response = await fetch(`${API_BASE}/cashbook/entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error('Failed to add cashbook entry');
        
        // Silently refresh in background to get real ID and updated balance
        await reloadCashbookForCurrentDate(false);
        showToast('Entry added', 'success');
    } catch (error) {
        console.error('Error adding cashbook entry:', error);
        // Remove the temp entry on failure
        cashbookEntries = cashbookEntries.filter(e => e.id !== tempId);
        renderCashbook();
        showToast('Failed to add entry', 'error');
    }
}

function tryCreateCashbookEntryFromPinnedRow(row, entryType) {
    const entryDate = String(row.entry_date || '').trim();
    const amount = parseCashbookAmount(row.amount);
    if (amount === null || amount <= 0) return;
    if (!entryDate) {
        showToast('Select an entry date for this row.', 'error');
        return;
    }
    const description = String(row.description || '').trim();
    const folio = row.folio || null;
    
    // Folio is now required
    if (!folio) {
        showToast('Please select a ledger (folio) for this entry.', 'error');
        return;
    }

    createCashbookEntry({
        entry_date: entryDate,
        entry_type: entryType,
        amount,
        description,
        folio
    });
}

async function updateCashbookEntry(entryId, updates) {
    if (!entryId || !updates || Object.keys(updates).length === 0) return;
    
    // Optimistic update: apply changes immediately
    const entryIndex = cashbookEntries.findIndex(e => e.id === entryId);
    const originalEntry = entryIndex >= 0 ? { ...cashbookEntries[entryIndex] } : null;
    if (entryIndex >= 0) {
        cashbookEntries[entryIndex] = { ...cashbookEntries[entryIndex], ...updates };
        renderCashbook();
    }

    try {
        const response = await fetch(`${API_BASE}/cashbook/entries/${entryId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        if (!response.ok) throw new Error('Failed to update cashbook entry');
        
        // Silently refresh in background to get updated balance
        await reloadCashbookForCurrentDate(false);
        showToast('Entry updated', 'success');
    } catch (error) {
        console.error('Error updating cashbook entry:', error);
        // Revert on failure
        if (originalEntry && entryIndex >= 0) {
            cashbookEntries[entryIndex] = originalEntry;
            renderCashbook();
        }
        showToast('Failed to update entry', 'error');
    }
}

async function deleteCashbookEntry(entryId) {
    if (!entryId) return;
    
    // Optimistic update: remove immediately
    const entryIndex = cashbookEntries.findIndex(e => e.id === entryId);
    const removedEntry = entryIndex >= 0 ? cashbookEntries[entryIndex] : null;
    if (entryIndex >= 0) {
        cashbookEntries.splice(entryIndex, 1);
        renderCashbook();
    }

    try {
        const response = await fetch(`${API_BASE}/cashbook/entries/${entryId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete cashbook entry');
        
        // Silently refresh in background to get updated balance
        await reloadCashbookForCurrentDate(false);
        showToast('Entry deleted', 'success');
    } catch (error) {
        console.error('Error deleting cashbook entry:', error);
        // Restore on failure
        if (removedEntry) {
            cashbookEntries.push(removedEntry);
            renderCashbook();
        }
        showToast('Failed to delete entry', 'error');
    }
}

// ============================================
// Ledger Functions
// ============================================

async function loadLedgersList() {
    try {
        const response = await fetch(`${API_BASE}/ledgers/`);
        if (!response.ok) throw new Error('Failed to load ledgers');
        ledgers = await response.json();
    } catch (error) {
        console.error('Error loading ledgers:', error);
        ledgers = [];
    }
}

async function loadLedgers() {
    await loadLedgersList();
    renderLedgerCards();
    updateCashInHand();
}

let bankLedgerBalances = []; // Store individual ledger balances for tooltip

async function updateCashInHand() {
    try {
        // Get all Bank section ledgers
        const bankLedgers = ledgers.filter(l => l.section === 'Bank');
        
        if (bankLedgers.length === 0) {
            const amountEl = document.getElementById('cashInHandAmount');
            if (amountEl) amountEl.textContent = 'Rs 0.00';
            bankLedgerBalances = [];
            updateCashInHandTooltip();
            return;
        }

        // Fetch entries for all Bank ledgers and calculate balances
        let totalBalance = 0;
        bankLedgerBalances = [];
        
        for (const ledger of bankLedgers) {
            try {
                const response = await fetch(`${API_BASE}/ledgers/${ledger.id}/entries`);
                if (!response.ok) continue;
                
                const entries = await response.json();
                
                // Calculate running balance for this ledger
                const sorted = [...entries].sort((a, b) => {
                    const dateA = a.entry_date || '';
                    const dateB = b.entry_date || '';
                    if (dateA !== dateB) return dateA.localeCompare(dateB);
                    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
                });
                
                let balance = 0;
                // Bank ledgers: reversed sum — add debit side, subtract credit side (per heading) = outgoing - incoming.
                sorted.forEach(entry => {
                    const incoming = parseFloat(entry.incoming) || 0;
                    const outgoing = parseFloat(entry.outgoing) || 0;
                    balance += outgoing - incoming;
                });
                
                bankLedgerBalances.push({
                    name: ledger.name,
                    balance: balance
                });
                
                totalBalance += balance;
            } catch (error) {
                console.error(`Error loading entries for ledger ${ledger.id}:`, error);
            }
        }
        
        // Update display
        const amountEl = document.getElementById('cashInHandAmount');
        if (amountEl) {
            const formatted = totalBalance.toLocaleString('en-US', { 
                minimumFractionDigits: 2, 
                maximumFractionDigits: 2 
            });
            amountEl.textContent = `Rs ${formatted}`;
        }
        
        updateCashInHandTooltip();
    } catch (error) {
        console.error('Error updating Cash In Hand:', error);
        const amountEl = document.getElementById('cashInHandAmount');
        if (amountEl) amountEl.textContent = 'Rs 0.00';
        bankLedgerBalances = [];
        updateCashInHandTooltip();
    }
}

function updateCashInHandTooltip() {
    const tooltipEl = document.getElementById('cashInHandTooltip');
    if (!tooltipEl) return;
    
    if (bankLedgerBalances.length === 0) {
        tooltipEl.innerHTML = '<div class="cash-in-hand-tooltip-empty">No Bank ledgers</div>';
        return;
    }
    
    const itemsHtml = bankLedgerBalances.map(item => {
        const formatted = item.balance.toLocaleString('en-US', { 
            minimumFractionDigits: 2, 
            maximumFractionDigits: 2 
        });
        return `
            <div class="cash-in-hand-tooltip-item">
                <span class="cash-in-hand-tooltip-name">${escapeHtml(item.name)}</span>
                <span class="cash-in-hand-tooltip-balance">Rs ${formatted}</span>
            </div>
        `;
    }).join('');
    
    const totalFormatted = bankLedgerBalances.reduce((sum, item) => sum + item.balance, 0)
        .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    tooltipEl.innerHTML = `
        <div class="cash-in-hand-tooltip-header">Bank Ledgers</div>
        ${itemsHtml}
        <div class="cash-in-hand-tooltip-footer">
            <span class="cash-in-hand-tooltip-total-label">Total:</span>
            <span class="cash-in-hand-tooltip-total">Rs ${totalFormatted}</span>
        </div>
    `;
}

function renderLedgerCards() {
    const container = document.getElementById('ledgerCards');
    if (!container) return;

    if (ledgers.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No ledgers yet. Click "Create Ledger" to add one.</p>';
        return;
    }

    // Group ledgers by section
    const groupedLedgers = {};
    ledgers.forEach(l => {
        const section = l.section || 'Uncategorized';
        if (!groupedLedgers[section]) {
            groupedLedgers[section] = [];
        }
        groupedLedgers[section].push(l);
    });

    // Sort sections alphabetically
    const sortedSections = Object.keys(groupedLedgers).sort((a, b) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return a.localeCompare(b);
    });

    // Build HTML with sections
    let html = '';
    sortedSections.forEach(section => {
        const sectionLedgers = groupedLedgers[section];
        html += `
            <div class="ledger-section">
                <h3 class="ledger-section-header">${escapeHtml(section)}</h3>
                <div class="ledger-section-cards">
                    ${sectionLedgers.map(l => `
                        <div class="ledger-card" data-id="${l.id}">
                            <div class="ledger-card-info">
                                <span class="ledger-card-name">${escapeHtml(l.name)}</span>
                            </div>
                            <div class="ledger-card-actions">
                                <button type="button" class="ledger-edit-btn" data-id="${l.id}" title="Edit ledger" aria-label="Edit ledger"><img src="assets/edit.png" alt="Edit" class="ledger-edit-icon"></button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    // Click on card (not the edit button) opens detail
    container.querySelectorAll('.ledger-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.ledger-edit-btn')) return;
            const id = card.dataset.id;
            openLedgerDetail(id);
        });
    });

    // Edit buttons
    container.querySelectorAll('.ledger-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            openEditLedgerModal(id);
        });
    });
}

async function createLedger(name, section) {
    try {
        const response = await fetch(`${API_BASE}/ledgers/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, section })
        });
        if (!response.ok) throw new Error('Failed to create ledger');
        showToast('Ledger created', 'success');
        closeCreateLedgerModal();
        await loadLedgers();
    } catch (error) {
        console.error('Error creating ledger:', error);
        showToast('Failed to create ledger', 'error');
    }
}

function openCreateLedgerModal() {
    document.getElementById('createLedgerName').value = '';
    document.getElementById('createLedgerSection').value = '';
    document.getElementById('createLedgerModal').classList.add('active');
}

function closeCreateLedgerModal() {
    document.getElementById('createLedgerModal').classList.remove('active');
}

let editLedgerId = null;
let editLedgerHasEntries = false;

async function openEditLedgerModal(ledgerId) {
    if (!ledgerId) return;
    editLedgerId = ledgerId;
    try {
        const [ledgerRes, entriesRes] = await Promise.all([
            fetch(`${API_BASE}/ledgers/${ledgerId}`),
            fetch(`${API_BASE}/ledgers/${ledgerId}/entries`)
        ]);
        if (!ledgerRes.ok) throw new Error('Failed to load ledger');
        if (!entriesRes.ok) throw new Error('Failed to load entries');
        const ledger = await ledgerRes.json();
        const entries = await entriesRes.json();
        editLedgerHasEntries = Array.isArray(entries) && entries.length > 0;

        const nameInput = document.getElementById('editLedgerName');
        const sectionSelect = document.getElementById('editLedgerSection');
        if (nameInput) {
            nameInput.value = ledger.name || '';
            nameInput.removeAttribute('readonly');
            nameInput.removeAttribute('disabled');
        }
        if (sectionSelect) sectionSelect.value = ledger.section || '';

        const deleteBtn = document.getElementById('editLedgerDeleteBtn');
        const deleteWrap = document.getElementById('editLedgerDeleteWrap');
        if (deleteBtn) {
            deleteBtn.disabled = editLedgerHasEntries;
            deleteBtn.classList.toggle('ledger-edit-delete-btn-has-entries', editLedgerHasEntries);
        }
        if (deleteWrap) {
            deleteWrap.title = editLedgerHasEntries ? 'Cannot delete: ledger has entries' : 'Delete ledger (no entries)';
        }

        document.getElementById('editLedgerModal').classList.add('active');
        setTimeout(() => { if (nameInput) nameInput.focus(); }, 50);
    } catch (error) {
        console.error('Error opening edit ledger:', error);
        showToast('Failed to load ledger', 'error');
    }
}

function closeEditLedgerModal() {
    document.getElementById('editLedgerModal').classList.remove('active');
    editLedgerId = null;
}

async function saveEditLedger() {
    if (!editLedgerId) return;
    const name = (document.getElementById('editLedgerName').value || '').trim();
    const section = (document.getElementById('editLedgerSection').value || '').trim();
    if (!name || !section) {
        showToast('Name and section are required', 'error');
        return;
    }
    const confirmed = await showAppConfirm({ title: 'Update Ledger', message: 'Are you sure you want to update this ledger?', confirmText: 'Save' });
    if (!confirmed) return;
    try {
        const response = await fetch(`${API_BASE}/ledgers/${editLedgerId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, section })
        });
        if (!response.ok) throw new Error('Failed to update ledger');
        showToast('Ledger updated', 'success');
        closeEditLedgerModal();
        await loadLedgers();
    } catch (error) {
        console.error('Error updating ledger:', error);
        showToast('Failed to update ledger', 'error');
    }
}

async function deleteLedgerFromEditModal() {
    if (!editLedgerId) return;
    if (editLedgerHasEntries) return;
    const confirmed = await showAppConfirm({ title: 'Delete Ledger', message: 'Are you sure you want to delete this ledger? This cannot be undone.', confirmText: 'Delete', danger: true });
    if (!confirmed) return;
    try {
        const response = await fetch(`${API_BASE}/ledgers/${editLedgerId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete ledger');
        showToast('Ledger deleted', 'success');
        closeEditLedgerModal();
        await loadLedgers();
    } catch (error) {
        console.error('Error deleting ledger:', error);
        showToast('Failed to delete ledger', 'error');
    }
}

async function deleteLedger(ledgerId) {
    if (!ledgerId) return;
    if (!confirm('Are you sure you want to delete this ledger? This cannot be undone.')) return;
    try {
        const response = await fetch(`${API_BASE}/ledgers/${ledgerId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete ledger');
        showToast('Ledger deleted', 'success');
        await loadLedgers();
    } catch (error) {
        console.error('Error deleting ledger:', error);
        showToast('Failed to delete ledger', 'error');
    }
}

async function openLedgerDetail(ledgerId) {
    try {
        const response = await fetch(`${API_BASE}/ledgers/${ledgerId}`);
        if (!response.ok) throw new Error('Failed to load ledger');
        currentLedger = await response.json();
    } catch (error) {
        console.error('Error loading ledger:', error);
        showToast('Failed to load ledger', 'error');
        return;
    }

    document.getElementById('ledgerDetailName').textContent = currentLedger.name;
    switchView('ledgerDetail');
    await loadLedgerEntries(ledgerId);
}

async function loadLedgerEntries(ledgerId) {
    if (!ledgerId) ledgerId = currentLedger?.id;
    if (!ledgerId) return;

    if (ledgerDetailGridApi) ledgerDetailGridApi.showLoadingOverlay();
    try {
        const response = await fetch(`${API_BASE}/ledgers/${ledgerId}/entries`);
        if (!response.ok) throw new Error('Failed to load ledger entries');
        ledgerEntries = (await response.json()).map(e => ({
            ...e,
            entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : ''
        }));
    } catch (error) {
        console.error('Error loading ledger entries:', error);
        showToast('Failed to load ledger entries', 'error');
        ledgerEntries = [];
    } finally {
        if (ledgerDetailGridApi) ledgerDetailGridApi.hideOverlay();
    }

    renderLedgerDetailGrid();
}

function renderLedgerDetailGrid() {
    if (!ledgerDetailGridApi) return;

    // Check if this is a Bank section ledger (invert debit/credit)
    const isBankSection = currentLedger?.section === 'Bank';

    // Update column definitions to swap fields for Bank section
    const columnDefs = ledgerDetailGridApi.getGridOption('columnDefs');
    if (columnDefs && columnDefs.length >= 4) {
        // Swap Debit and Credit column fields for Bank section
        if (isBankSection) {
            columnDefs[2].field = 'incoming'; // Debit shows incoming
            columnDefs[3].field = 'outgoing'; // Credit shows outgoing
        } else {
            columnDefs[2].field = 'outgoing'; // Debit shows outgoing
            columnDefs[3].field = 'incoming'; // Credit shows incoming
        }
        ledgerDetailGridApi.setGridOption('columnDefs', columnDefs);
    }

    // Compute running balance
    const sorted = [...ledgerEntries].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });

    let running = 0;
    // Bank ledgers: reversed — add debit side (outgoing in data), subtract credit side (incoming in data) = outgoing - incoming. Non-Bank: incoming - outgoing.
    const balanceDelta = isBankSection ? (inc, out) => out - inc : (inc, out) => inc - out;
    const rowsWithBalance = sorted.map(entry => {
        const incoming = parseFloat(entry.incoming) || 0;
        const outgoing = parseFloat(entry.outgoing) || 0;
        running += balanceDelta(incoming, outgoing);
        return { 
            ...entry, 
            incoming: incoming,
            outgoing: outgoing,
            balance: running 
        };
    });

    // Ledger entries are now read-only (derived from cashbook entries)
    ledgerDetailGridApi.setGridOption('rowData', rowsWithBalance);
}

function initLedgerDetailGrid() {
    const gridDiv = document.getElementById('ledgerDetailGrid');
    if (!gridDiv) return;

    // Ledger detail grid is now read-only - entries come from cashbook
    const columnDefs = [
        {
            headerName: 'Date',
            field: 'entry_date',
            width: 130,
            editable: false,
            valueFormatter: (params) => (params.value ? formatDateDDMMYYYY(params.value) : ''),
        },
        {
            headerName: 'Particulars',
            field: 'particulars',
            flex: 2,
            editable: false,
        },
        {
            headerName: 'Debit (Rs)',
            field: 'outgoing',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
        },
        {
            headerName: 'Credit (Rs)',
            field: 'incoming',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
        },
        {
            headerName: 'Balance (Rs)',
            field: 'balance',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
            cellStyle: (params) => {
                const val = parseFloat(params.value);
                if (Number.isNaN(val)) return {};
                if (val < 0) return { color: 'var(--danger)' };
                return {};
            }
        }
    ];

    const gridOptions = {
        columnDefs,
        rowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.id,
        onGridReady: (params) => {
            ledgerDetailGridApi = params.api;
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

// NOTE: Ledger entries are now read-only and derived from cashbook entries.
// The CRUD operations for ledger entries have been removed.
// To add/edit/delete ledger entries, use the Cashbook with the appropriate folio.

async function syncShopifyProducts() {
    const btn = document.getElementById('syncShopifyBtn');
    const originalText = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = 'Syncing...';

    try {
        const response = await fetch(`${API_BASE}/products/sync-shopify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to sync products from Shopify');
        }

        const result = await response.json();
        const productsInfo = result.products || {};
        const variantsInfo = result.variants || {};
        showToast(
            `Sync complete! Products: ${productsInfo.created || 0} created, ${productsInfo.updated || 0} updated. Variants: ${variantsInfo.created || 0} created, ${variantsInfo.updated || 0} updated.`,
            'success'
        );

        loadProducts();
    } catch (error) {
        console.error('Error syncing Shopify products:', error);
        showToast(error.message || 'Failed to sync products from Shopify', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function syncShopifyOrders() {
    const btn = document.getElementById('syncOrdersBtn');
    if (!btn) return;

    const originalText = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = 'Syncing...';

    try {
        const response = await fetch(`${API_BASE}/orders/sync-shopify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to sync orders from Shopify');
        }

        const result = await response.json();
        showToast(
            `Sync complete! ${result.synced} orders synced (${result.created} created, ${result.updated} updated)`,
            'success'
        );
        // Do not auto-reload the grid; user can change period or refresh to see updated data
    } catch (error) {
        console.error('Error syncing Shopify orders:', error);
        showToast(error.message || 'Failed to sync orders from Shopify', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

function scheduleOrdersAutoSync() {
    if (ordersAutoSyncTimerId != null) {
        clearTimeout(ordersAutoSyncTimerId);
        ordersAutoSyncTimerId = null;
    }
    ordersAutoSyncTimerId = setTimeout(async () => {
        ordersAutoSyncTimerId = null;
        await syncShopifyOrders();
        scheduleOrdersAutoSync();
    }, ORDERS_AUTO_SYNC_INTERVAL_MS);
}

async function uploadPostExCsv(file, assignmentNumber) {
    const btn = document.getElementById('uploadPostExModalUpload');
    const originalText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Uploading...';
    }
    try {
        const formData = new FormData();
        formData.append('file', file);
        if (assignmentNumber != null && String(assignmentNumber).trim() !== '') {
            formData.append('assignment_number', String(assignmentNumber).trim());
        }
        const response = await fetch(`${API_BASE}/orders/upload-postex-csv`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = Array.isArray(data.detail) ? data.detail.map(d => d.msg || d).join(' ') : data.detail;
            throw new Error(detail || response.statusText || 'Upload failed');
        }
        showToast(data.message || `Updated ${data.updated || 0} order(s).`, 'success');
        closeUploadPostExModal();

        // Show popup if any orders have receivable != CSV NET_AMOUNT
        const mismatches = data.amount_mismatches || [];
        if (mismatches.length > 0) {
            showPostExAmountMismatchesModal(mismatches);
        }
        
        // CSV may contain orders from multiple periods; we have all orders in the grid (period filter may hide some).
        // Select all rows in the current view that were updated by the CSV.
        const updatedOrderIds = data.updated_order_ids || [];
        const matchedOrderNumbers = new Set((data.matched_order_numbers || []).map(String));
        
        await loadOrders();
        
        if (ordersGridApi && (updatedOrderIds.length > 0 || matchedOrderNumbers.size > 0)) {
            setTimeout(() => {
                if (ordersGridApi) {
                    ordersGridApi.deselectAll();
                    ordersGridApi.forEachNode(node => {
                        const data = node.data;
                        if (!data || data.id === '__footer__') return;
                        if (updatedOrderIds.includes(data.id) || matchedOrderNumbers.has(String(data.order_number))) {
                            node.setSelected(true);
                        }
                    });
                    const selectedRows = ordersGridApi.getSelectedRows();
                    if (selectedRows.length > 0) {
                        ordersGridApi.ensureNodeVisible(selectedRows[0], 'middle');
                    }
                    if (typeof updateFooterRow === 'function') updateFooterRow();
                }
            }, 100);
        }
    } catch (error) {
        console.error('Error uploading PostEx CSV', error);
        showToast(error.message || 'Failed to upload PostEx CSV', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

function openUploadPostExModal() {
    const modal = document.getElementById('uploadPostExModal');
    const fileInput = document.getElementById('uploadPostExFileInput');
    const fileNameEl = document.getElementById('uploadPostExFileName');
    const assignmentInput = document.getElementById('uploadPostExAssignmentNumber');
    if (fileInput) {
        fileInput.value = '';
        if (fileNameEl) fileNameEl.textContent = 'No file chosen';
    }
    if (assignmentInput) assignmentInput.value = '';
    if (modal) modal.classList.add('active');
}

function closeUploadPostExModal() {
    const modal = document.getElementById('uploadPostExModal');
    if (modal) modal.classList.remove('active');
}

// ============================================
// UI Updates
// ============================================

function renderDashboardCollectionsBreakdown() {
    const container = document.getElementById('dashboardCollectionsGrid');
    if (!container) return;

    const agg = new Map();
    for (const p of products) {
        const raw = (p.collection != null ? String(p.collection) : '').trim();
        const label = raw || 'Uncategorized';
        const price = parseFloat(p.price) || 0;
        const qty = p.total_quantity || 0;
        if (!agg.has(label)) {
            agg.set(label, { count: 0, value: 0 });
        }
        const row = agg.get(label);
        row.count += 1;
        row.value += price * qty;
    }

    const rows = [...agg.entries()].map(([collection, data]) => ({ collection, ...data }));
    rows.sort((a, b) => {
        if (a.collection === 'Uncategorized') return 1;
        if (b.collection === 'Uncategorized') return -1;
        return a.collection.localeCompare(b.collection, undefined, { sensitivity: 'base' });
    });

    if (rows.length === 0) {
        container.innerHTML = '<p class="dashboard-collections-empty">No products to show.</p>';
        return;
    }

    container.innerHTML = rows
        .map(({ collection, count, value }) => {
            const countLabel = count === 1 ? '1 product' : `${count.toLocaleString()} products`;
            return `<div class="stat-card">
                <div class="stat-info">
                    <span class="stat-label">${escapeHtml(collection)}</span>
                    <span class="stat-detail">${countLabel}</span>
                    <span class="stat-value">Rs ${Math.round(value).toLocaleString()}</span>
                </div>
            </div>`;
        })
        .join('');
}

async function updateDashboard() {
    const totalProducts = products.length;
    const totalVariantRows = products.reduce(
        (sum, p) => sum + (Array.isArray(p.variants) ? p.variants.length : 0),
        0
    );
    const totalProductsAndVariants = totalProducts + totalVariantRows;
    const totalStock = products.reduce((sum, p) => sum + (p.total_quantity || 0), 0);
    const totalValue = products.reduce((sum, p) => sum + ((p.price || 0) * (p.total_quantity || 0)), 0);

    document.getElementById('totalProducts').textContent = totalProducts;
    const productsVariantsEl = document.getElementById('totalProductsAndVariants');
    if (productsVariantsEl) {
        productsVariantsEl.textContent = totalProductsAndVariants.toLocaleString();
    }
    document.getElementById('totalStock').textContent = totalStock.toLocaleString();
    document.getElementById('totalValue').textContent = `Rs ${Math.round(totalValue).toLocaleString()}`;

    renderDashboardCollectionsBreakdown();

    const returnedDeliveryEl = document.getElementById('returnedDeliveryChargesSum');
    if (returnedDeliveryEl) {
        try {
            const response = await fetch(`${API_BASE}/orders/returned-delivery-charges-sum`);
            if (response.ok) {
                const data = await response.json();
                const sum = parseFloat(data.sum) || 0;
                returnedDeliveryEl.textContent = `Rs ${Math.round(sum).toLocaleString()}`;
            } else {
                returnedDeliveryEl.textContent = '—';
            }
        } catch (e) {
            console.error('Error fetching returned delivery charges sum:', e);
            returnedDeliveryEl.textContent = '—';
        }
    }
}

// ============================================
// Forms
// ============================================

// ============================================
// Month Summary Functions
// ============================================

let currentMonthDetail = null;

async function loadMonthSummaryList() {
    try {
        const response = await fetch(`${API_BASE}/orders/month-summary/list`);
        if (!response.ok) throw new Error('Failed to fetch month summary list');
        
        const months = await response.json();
        displayMonthSummaryCards(months);
    } catch (error) {
        console.error('Error loading month summary list:', error);
        showToast('Failed to load month summaries', 'error');
    }
}

function displayMonthSummaryCards(months) {
    const container = document.getElementById('monthSummaryCards');
    if (!container) return;
    
    if (months.length === 0) {
        container.innerHTML = '<div class="no-data-message">No month data available</div>';
        return;
    }
    
    // Group by year (descending: newest year first)
    const byYear = new Map();
    for (const m of months) {
        if (!byYear.has(m.year)) byYear.set(m.year, []);
        byYear.get(m.year).push(m);
    }
    const years = [...byYear.keys()].sort((a, b) => b - a);
    
    const sectionsHtml = years.map(year => {
        const yearMonths = byYear.get(year);
        const cardsHtml = yearMonths.map(month => {
            const monthName = getMonthName(month.month);
            const periodLabel = formatOrdersPeriodLabel(month.month, month.year);
            return `
                <div class="month-summary-card" data-month="${month.month}" data-year="${month.year}">
                    <div class="month-summary-card-header">
                        <h3 class="month-summary-card-title">${monthName} ${month.year}</h3>
                        <span class="month-summary-card-period">${periodLabel}</span>
                    </div>
                </div>
            `;
        }).join('');
        return `
            <section class="month-summary-year-section">
                <h2 class="month-summary-year-heading">${year}</h2>
                <div class="month-summary-cards-in-section">${cardsHtml}</div>
            </section>
        `;
    }).join('');
    
    container.innerHTML = sectionsHtml;
    
    // Add click handlers - entire card is clickable
    container.querySelectorAll('.month-summary-card').forEach(card => {
        card.addEventListener('click', () => {
            const month = parseInt(card.dataset.month);
            const year = parseInt(card.dataset.year);
            openMonthDetail(month, year);
        });
    });
}

function getMonthName(month) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
    return months[month - 1];
}

async function openMonthDetail(month, year) {
    currentMonthDetail = { month, year };
    const container = document.getElementById('monthDetailContent');
    const titleEl = document.getElementById('monthDetailTitle');
    const monthName = getMonthName(month);
    const periodLabel = formatOrdersPeriodLabel(month, year);

    // Set title and show loading immediately, then navigate
    if (titleEl) titleEl.textContent = `${monthName} ${year} - ${periodLabel}`;
    if (container) {
        container.innerHTML = `
            <div class="month-detail-loading">
                <div class="month-detail-loading-spinner"></div>
                <p class="month-detail-loading-text">Loading period data...</p>
            </div>
        `;
    }
    switchView('monthDetail');

    try {
        const response = await fetch(`${API_BASE}/orders/month-summary/${month}/${year}`);
        if (!response.ok) throw new Error('Failed to fetch month detail');
        const data = await response.json();
        displayMonthDetail(data);
    } catch (error) {
        console.error('Error loading month detail:', error);
        showToast('Failed to load month details', 'error');
        if (container) {
            container.innerHTML = '<div class="no-data-message">Failed to load period data. Please try again.</div>';
        }
    }
}

function displayMonthDetail(data) {
    const container = document.getElementById('monthDetailContent');
    const titleEl = document.getElementById('monthDetailTitle');
    
    if (!container) return;
    
    const monthName = getMonthName(data.month);
    const periodLabel = formatOrdersPeriodLabel(data.month, data.year);
    
    if (titleEl) {
        titleEl.textContent = `${monthName} ${data.year} - ${periodLabel}`;
    }
    
    const fmt = (n) => (typeof n === 'number' && !Number.isInteger(n))
        ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : (n ?? 0).toLocaleString('en-US');

    container.innerHTML = `
        <div class="month-detail-sections">
            <div class="month-detail-column">
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Sales</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">Total Gross Sale</span><span class="month-detail-line-value">Rs ${fmt(data.total_gross_sale)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Total Return Amount</span><span class="month-detail-line-value">Rs ${fmt(data.total_return_amount)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Net Sales</span><span class="month-detail-line-value">Rs ${fmt(data.net_sales)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Net Profit</span><span class="month-detail-line-value">Rs ${fmt(data.net_profit ?? 0)}</span></div>
                    </div>
                </section>
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Expenses</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">Shopify Expense</span><span class="month-detail-line-value">Rs ${fmt(data.shopify_expense ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Ad Expense</span><span class="month-detail-line-value">Rs ${fmt(data.ad_expense ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Other Expenses</span><span class="month-detail-line-value">Rs ${fmt(data.other_expense ?? 0)}</span></div>
                    </div>
                </section>
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Products Sold by Collection</h3>
                    <div class="month-detail-lines">
                        ${(data.products_sold_by_collection || []).map(row => `
                            <div class="month-detail-line">
                                <span class="month-detail-line-label">${row.collection || 'Others'}</span>
                                <span class="month-detail-line-value">${fmt(row.count)} units · Rs ${fmt(row.sum)}</span>
                            </div>
                        `).join('')}
                    </div>
                </section>
            </div>
            <div class="month-detail-column">
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Orders</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">Total Orders</span><span class="month-detail-line-value">${fmt(data.total_orders)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Delivered Orders</span><span class="month-detail-line-value">${fmt(data.delivered_orders_count)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Return Orders</span><span class="month-detail-line-value">${fmt(data.return_orders_count)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Enroute Orders</span><span class="month-detail-line-value">${fmt(data.enroute_orders_count ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Unfulfilled Orders</span><span class="month-detail-line-value">${fmt(data.unfulfilled_orders_count ?? 0)}</span></div>
                    </div>
                </section>
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">DC Charges</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">DC Charges (Delivered)</span><span class="month-detail-line-value">Rs ${fmt(data.dc_charges_delivered ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">DC Charges (Returned)</span><span class="month-detail-line-value">Rs ${fmt(data.dc_charges_returned ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Total DC Charges</span><span class="month-detail-line-value">Rs ${fmt(data.dc_charges_total ?? 0)}</span></div>
                    </div>
                </section>
            </div>
        </div>
    `;
}

function initForms() {
    // Sync Shopify Products Button
    const syncBtn = document.getElementById('syncShopifyBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            await syncShopifyProducts();
        });
    }

    // Sync Shopify Orders Button (manual sync resets the 15-min auto-sync timer)
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    if (syncOrdersBtn) {
        syncOrdersBtn.addEventListener('click', async () => {
            await syncShopifyOrders();
            scheduleOrdersAutoSync();
        });
    }

    // Bulk update order button
    const bulkUpdateOrderBtn = document.getElementById('bulkUpdateOrderBtn');
    if (bulkUpdateOrderBtn) {
        bulkUpdateOrderBtn.addEventListener('click', openBulkUpdateOrderModal);
    }

    // Bulk update cost price (products)
    const bulkUpdateCostPriceBtn = document.getElementById('bulkUpdateCostPriceBtn');
    if (bulkUpdateCostPriceBtn) {
        bulkUpdateCostPriceBtn.addEventListener('click', openBulkUpdateCostPriceModal);
    }

    const recalculateOrderCostsBtn = document.getElementById('recalculateOrderCostsBtn');
    if (recalculateOrderCostsBtn) {
        recalculateOrderCostsBtn.addEventListener('click', openRecalculateOrderCostsModal);
    }

    document.getElementById('bulkUpdateSetDelivered')?.addEventListener('click', () => bulkUpdateOrderStatus('delivered'));
    document.getElementById('bulkUpdateSetReturned')?.addEventListener('click', () => bulkUpdateOrderStatus('returned'));
    document.getElementById('bulkUpdateSetCancelled')?.addEventListener('click', () => bulkUpdateOrderStatus('cancelled'));
    document.getElementById('bulkUpdateSetPieceReceived')?.addEventListener('click', bulkUpdatePieceReceived);
    document.getElementById('bulkUpdateSelectInGrid')?.addEventListener('click', bulkUpdateSelectInGrid);
    document.getElementById('bulkUpdateDeliveryChargesBtn')?.addEventListener('click', openBulkUpdateDeliveryChargesModal);

    // Orders toolbar actions: Upload PostEx CSV, Generate Load Sheet, Create Replacement
    const ordersMoreActionUploadPostEx = document.getElementById('ordersMoreActionUploadPostEx');
    if (ordersMoreActionUploadPostEx) {
        ordersMoreActionUploadPostEx.addEventListener('click', openUploadPostExModal);
    }
    // Upload PostEx modal: file name display, upload button, close/cancel
    const uploadPostExFileInput = document.getElementById('uploadPostExFileInput');
    const uploadPostExFileNameEl = document.getElementById('uploadPostExFileName');
    if (uploadPostExFileInput && uploadPostExFileNameEl) {
        uploadPostExFileInput.addEventListener('change', () => {
            const file = uploadPostExFileInput.files?.[0];
            uploadPostExFileNameEl.textContent = file ? file.name : 'No file chosen';
        });
    }
    const uploadPostExModalUploadBtn = document.getElementById('uploadPostExModalUpload');
    if (uploadPostExModalUploadBtn) {
        uploadPostExModalUploadBtn.addEventListener('click', async () => {
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
    }
    document.getElementById('closeUploadPostExModal')?.addEventListener('click', closeUploadPostExModal);
    document.getElementById('uploadPostExModalCancel')?.addEventListener('click', closeUploadPostExModal);
    const uploadPostExModalEl = document.getElementById('uploadPostExModal');
    if (uploadPostExModalEl) {
        uploadPostExModalEl.addEventListener('click', (e) => { if (e.target === uploadPostExModalEl) closeUploadPostExModal(); });
    }
    const ordersMoreActionGenerateLoadSheet = document.getElementById('ordersMoreActionGenerateLoadSheet');
    if (ordersMoreActionGenerateLoadSheet) {
        ordersMoreActionGenerateLoadSheet.addEventListener('click', openGenerateLoadSheetModal);
    }
    const ordersMoreActionGenerateInvoice = document.getElementById('ordersMoreActionGenerateInvoice');
    if (ordersMoreActionGenerateInvoice) {
        ordersMoreActionGenerateInvoice.addEventListener('click', async () => {
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
                const res = await fetch(`${API_BASE}/orders/generate-invoice`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderIds)
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to generate invoice');
                }
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
    }

    // Generate Packaging List (opens modal: enter order numbers or upload labels PDF)
    const ordersMoreActionGeneratePackagingList = document.getElementById('ordersMoreActionGeneratePackagingList');
    if (ordersMoreActionGeneratePackagingList) {
        ordersMoreActionGeneratePackagingList.addEventListener('click', openPackagingListModal);
    }
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

    // Create Replacement Order
    const ordersMoreActionCreateReplacement = document.getElementById('ordersMoreActionCreateReplacement');
    if (ordersMoreActionCreateReplacement) {
        ordersMoreActionCreateReplacement.addEventListener('click', () => openReplacementOrderModal());
    }

    // Replacement Order modal
    const replacementOrderModal = document.getElementById('replacementOrderModal');
    const closeReplacementOrderModalBtn = document.getElementById('closeReplacementOrderModal');
    const cancelReplacementOrderBtn = document.getElementById('cancelReplacementOrder');
    const replacementOrderForm = document.getElementById('replacementOrderForm');

    const closeReplacementModal = () => replacementOrderModal?.classList.remove('active');
    closeReplacementOrderModalBtn?.addEventListener('click', closeReplacementModal);
    cancelReplacementOrderBtn?.addEventListener('click', closeReplacementModal);
    replacementOrderModal?.addEventListener('click', (e) => {
        if (e.target === replacementOrderModal) closeReplacementModal();
    });

    if (replacementOrderForm) {
        replacementOrderForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!isEditingAllowed()) {
                showToast('Editing is locked', 'error');
                return;
            }
            const submitBtn = document.getElementById('submitReplacementOrder');
            const originalNum = document.getElementById('replOrderNumber').value.trim();
            const courier = document.getElementById('replCourier').value;
            const total = parseFloat(document.getElementById('replTotal').value) || 0;
            const advance = parseFloat(document.getElementById('replAdvance').value) || 0;
            const costPrice = parseFloat(document.getElementById('replCostPrice').value) || 0;
            const tracking = document.getElementById('replTracking').value.trim();

            if (!originalNum) {
                showToast('Please enter the original order number', 'error');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating...';
            try {
                const response = await fetch(`${API_BASE}/orders/create-replacement`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        original_order_number: originalNum,
                        total_amount: total,
                        advance_amount: advance,
                        cost_price: costPrice,
                        courier: courier,
                        tracking_number: tracking || null,
                    }),
                });
                if (!response.ok) {
                    const err = await response.json();
                    throw new Error(err.detail || 'Failed to create replacement order');
                }
                const result = await response.json();
                showToast(`Replacement order ${result.order_number} created`, 'success');
                closeReplacementModal();
                loadOrders();
            } catch (error) {
                showToast(error.message || 'Failed to create replacement order', 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create';
            }
        });
    }

    // Delete Confirmation Modal
    const deleteConfirmModal = document.getElementById('deleteConfirmModal');
    const closeDeleteConfirmModalBtn = document.getElementById('closeDeleteConfirmModal');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

    closeDeleteConfirmModalBtn?.addEventListener('click', closeDeleteConfirmModal);
    cancelDeleteBtn?.addEventListener('click', closeDeleteConfirmModal);
    confirmDeleteBtn?.addEventListener('click', confirmDeleteReplacementOrder);
    deleteConfirmModal?.addEventListener('click', (e) => {
        if (e.target === deleteConfirmModal) closeDeleteConfirmModal();
    });

    // Generate Load Sheet modal
    document.getElementById('generateLoadSheetModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'generateLoadSheetModal') closeGenerateLoadSheetModal();
    });
    document.getElementById('closeGenerateLoadSheetModal')?.addEventListener('click', closeGenerateLoadSheetModal);
    document.getElementById('loadSheetModalCancel')?.addEventListener('click', closeGenerateLoadSheetModal);
    document.getElementById('loadSheetModalConfirm')?.addEventListener('click', confirmGenerateLoadSheet);
    document.getElementById('loadSheetOrderNumbers')?.addEventListener('input', updateLoadSheetModalState);

    // Load Sheet Logs page
    document.getElementById('loadSheetLogsRefreshBtn')?.addEventListener('click', () => loadLoadSheetLogs());

    // Refresh delivery status for selected orders
    const refreshDeliveryStatusSelectedBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
    if (refreshDeliveryStatusSelectedBtn) {
        refreshDeliveryStatusSelectedBtn.addEventListener('click', () => refreshDeliveryStatusSelected());
    }
    const exportGridExcelBtn = document.getElementById('exportGridExcelBtn');
    if (exportGridExcelBtn) {
        exportGridExcelBtn.addEventListener('click', () => exportCurrentGridToExcel());
    }
    window.addEventListener('resize', () => {
        if (currentView === 'orders') {
            syncOrdersBottomActionsWidth();
        }
    });

    // Cashbook actions
    const cashbookDateFilter = document.getElementById('cashbookDateFilter');
    if (cashbookDateFilter) {
        const applyDateFromInput = () => {
            const parsed = parseDDMMYYYYToYYYYMMDD(cashbookDateFilter.value);
            if (parsed) {
                cashbookSelectedDate = parsed;
                cashbookDateFilter.value = formatDateDDMMYYYY(parsed);
                reloadCashbookForCurrentDate();
            } else if (cashbookDateFilter.value.trim() !== '') {
                showToast('Enter date as DD/MM/YYYY', 'error');
                cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
            }
        };
        cashbookDateFilter.addEventListener('change', applyDateFromInput);
        cashbookDateFilter.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyDateFromInput();
            }
        });
        cashbookDateFilter.addEventListener('blur', () => {
            if (cashbookDateFilter.value.trim() !== '') {
                const parsed = parseDDMMYYYYToYYYYMMDD(cashbookDateFilter.value);
                if (parsed) {
                    cashbookSelectedDate = parsed;
                    cashbookDateFilter.value = formatDateDDMMYYYY(parsed);
                } else {
                    cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
                }
            } else {
                cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
            }
        });
    }
    const cashbookTodayBtn = document.getElementById('cashbookTodayBtn');
    if (cashbookTodayBtn) {
        cashbookTodayBtn.addEventListener('click', () => {
            const today = getTodayDateString();
            cashbookSelectedDate = today;
            if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(today);
            reloadCashbookForCurrentDate();
        });
    }
    const cashbookPrevDayBtn = document.getElementById('cashbookPrevDayBtn');
    if (cashbookPrevDayBtn) {
        cashbookPrevDayBtn.addEventListener('click', () => {
            const current = cashbookSelectedDate || getTodayDateString();
            const [year, month, day] = current.split('-').map(Number);
            const date = new Date(year, month - 1, day);
            date.setDate(date.getDate() - 1);
            const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            cashbookSelectedDate = newDate;
            if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(newDate);
            reloadCashbookForCurrentDate();
        });
    }
    const cashbookNextDayBtn = document.getElementById('cashbookNextDayBtn');
    if (cashbookNextDayBtn) {
        cashbookNextDayBtn.addEventListener('click', () => {
            const current = cashbookSelectedDate || getTodayDateString();
            const [year, month, day] = current.split('-').map(Number);
            const date = new Date(year, month - 1, day);
            date.setDate(date.getDate() + 1);
            const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            cashbookSelectedDate = newDate;
            if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(newDate);
            reloadCashbookForCurrentDate();
        });
    }

    // Ledger: create button opens modal
    const createLedgerBtn = document.getElementById('createLedgerBtn');
    if (createLedgerBtn) {
        createLedgerBtn.addEventListener('click', openCreateLedgerModal);
    }

    // Cashbook: create entry button opens modal
    document.getElementById('cashbookCreateEntryBtn')?.addEventListener('click', openCashbookEntryModal);
    // Cashbook: order advance amount button opens its modal
    document.getElementById('cashbookOrderAdvanceBtn')?.addEventListener('click', openOrderAdvanceModal);
    document.getElementById('closeOrderAdvanceModal')?.addEventListener('click', closeOrderAdvanceModal);
    document.getElementById('orderAdvanceCancelBtn')?.addEventListener('click', closeOrderAdvanceModal);
    document.getElementById('orderAdvanceModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'orderAdvanceModal') closeOrderAdvanceModal();
    });
    document.getElementById('orderAdvanceForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        submitOrderAdvanceModal();
    });
    document.getElementById('orderAdvanceOrderNumber')?.addEventListener('input', () => {
        refreshOrderAdvanceParticularPlaceholder();
        refreshOrderAdvanceOutParticularPlaceholder();
    });
    // Mirror the advance amount into the outgoing amount until the user edits it.
    document.getElementById('orderAdvanceAmount')?.addEventListener('input', (e) => {
        const outAmount = document.getElementById('orderAdvanceOutAmount');
        if (e.target.value === '' && outAmount && outAmount.value === '') {
            orderAdvanceOutAmountTouched = false;
        }
        if (!orderAdvanceOutAmountTouched && outAmount) {
            outAmount.value = e.target.value;
        }
    });
    document.getElementById('orderAdvanceOutAmount')?.addEventListener('input', (e) => {
        const inAmount = document.getElementById('orderAdvanceAmount');
        if (e.target.value === '' && inAmount && inAmount.value === '') {
            orderAdvanceOutAmountTouched = false;
        } else {
            orderAdvanceOutAmountTouched = true;
        }
    });
    // Cashbook: bulk text entry modal
    document.getElementById('cashbookBulkEntryBtn')?.addEventListener('click', openBulkEntryModal);
    document.getElementById('closeBulkEntryModal')?.addEventListener('click', closeBulkEntryModal);
    document.getElementById('bulkEntryCancelBtn')?.addEventListener('click', closeBulkEntryModal);
    document.getElementById('bulkEntryModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'bulkEntryModal') closeBulkEntryModal();
    });
    document.getElementById('bulkEntryValidateBtn')?.addEventListener('click', validateBulkEntry);
    document.getElementById('bulkEntrySubmitBtn')?.addEventListener('click', submitBulkEntry);
    // Re-validate as the user types (debounced lightly) and reset submit state.
    document.getElementById('bulkEntryInput')?.addEventListener('input', () => {
        setBulkEntrySubmitEnabled(false);
        clearTimeout(window.__bulkEntryDebounce);
        window.__bulkEntryDebounce = setTimeout(validateBulkEntry, 300);
    });
    document.getElementById('closeCashbookEntryModal')?.addEventListener('click', closeCashbookEntryModal);
    document.getElementById('cashbookEntryCancelBtn')?.addEventListener('click', closeCashbookEntryModal);
    document.getElementById('cashbookEntryModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'cashbookEntryModal') closeCashbookEntryModal();
    });
    document.getElementById('cashbookEntryForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        submitCashbookEntryModal();
    });
    // Mirror incoming amount into outgoing until the user edits the outgoing amount.
    document.getElementById('cashbookEntryInAmount')?.addEventListener('input', (e) => {
        const outAmount = document.getElementById('cashbookEntryOutAmount');
        // If both fields are now empty, re-arm mirroring (back to default mode).
        if (e.target.value === '' && outAmount && outAmount.value === '') {
            cashbookEntryOutAmountTouched = false;
        }
        if (!cashbookEntryOutAmountTouched && outAmount) {
            outAmount.value = e.target.value;
        }
    });
    document.getElementById('cashbookEntryOutAmount')?.addEventListener('input', (e) => {
        const inAmount = document.getElementById('cashbookEntryInAmount');
        // If both fields are now empty, re-arm mirroring (back to default mode).
        if (e.target.value === '' && inAmount && inAmount.value === '') {
            cashbookEntryOutAmountTouched = false;
        } else {
            cashbookEntryOutAmountTouched = true;
        }
    });
    // Update particulars placeholders dynamically as ledgers are chosen.
    document.getElementById('cashbookEntryInLedger')?.addEventListener('change', refreshCashbookEntryParticularPlaceholders);
    document.getElementById('cashbookEntryOutLedger')?.addEventListener('change', refreshCashbookEntryParticularPlaceholders);
    // Single-sided entry toggles: skip a side's entry and disable its fields.
    // Only one may be ticked at a time.
    document.getElementById('cashbookEntryInSkip')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const other = document.getElementById('cashbookEntryOutSkip');
            if (other && other.checked) { other.checked = false; setCashbookEntrySideSkipped('outflow', false); }
        }
        setCashbookEntrySideSkipped('inflow', e.target.checked);
    });
    document.getElementById('cashbookEntryOutSkip')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const other = document.getElementById('cashbookEntryInSkip');
            if (other && other.checked) { other.checked = false; setCashbookEntrySideSkipped('inflow', false); }
        }
        setCashbookEntrySideSkipped('outflow', e.target.checked);
    });
    // Back to Month Summary button
    const backToMonthSummaryBtn = document.getElementById('backToMonthSummaryBtn');
    if (backToMonthSummaryBtn) {
        backToMonthSummaryBtn.addEventListener('click', () => {
            switchView('monthSummary');
        });
    }

    // Create Ledger modal: form submit and close
    const createLedgerForm = document.getElementById('createLedgerForm');
    if (createLedgerForm) {
        createLedgerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!isEditingAllowed()) {
                showToast('Editing is locked', 'error');
                return;
            }
            const name = document.getElementById('createLedgerName').value.trim();
            const section = document.getElementById('createLedgerSection').value;
            if (!name) {
                showToast('Enter a ledger name', 'error');
                return;
            }
            if (!section) {
                showToast('Select a section', 'error');
                return;
            }
            createLedger(name, section);
        });
    }
    document.getElementById('closeCreateLedgerModal')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerCancelBtn')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'createLedgerModal') closeCreateLedgerModal();
    });

    // Edit Ledger modal
    document.getElementById('closeEditLedgerModal')?.addEventListener('click', closeEditLedgerModal);
    document.getElementById('editLedgerCancelBtn')?.addEventListener('click', closeEditLedgerModal);
    document.getElementById('editLedgerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'editLedgerModal') closeEditLedgerModal();
    });
    const editLedgerModalContent = document.querySelector('#editLedgerModal .modal-content');
    if (editLedgerModalContent) {
        editLedgerModalContent.addEventListener('click', (e) => e.stopPropagation());
    }
    const editLedgerForm = document.getElementById('editLedgerForm');
    if (editLedgerForm) {
        editLedgerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!isEditingAllowed()) {
                showToast('Editing is locked', 'error');
                return;
            }
            saveEditLedger();
        });
    }
    document.getElementById('editLedgerDeleteBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!isEditingAllowed()) {
            showToast('Editing is locked', 'error');
            return;
        }
        deleteLedgerFromEditModal();
    });

    // Ledger: back button
    const ledgerBackBtn = document.getElementById('ledgerBackBtn');
    if (ledgerBackBtn) {
        ledgerBackBtn.addEventListener('click', () => {
            switchView('ledgers');
        });
    }

    // Order table full screen toggle (icon only; Esc to exit)
    const ordersFullScreenBtn = document.getElementById('ordersFullScreenBtn');
    if (ordersFullScreenBtn) {
        ordersFullScreenBtn.addEventListener('click', toggleOrdersFullScreen);
    }
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
            if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
        }, 100);
    }
}

/** Sync UI when fullscreen was exited by the browser (Esc/F11). Do not call exitFullscreen again. */
function syncOrdersFullScreenExit() {
    document.body.classList.remove('orders-table-fullscreen');
    setTimeout(() => {
        if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
    }, 100);
}

/** Exit fullscreen when the user clicks the fullscreen button. */
function exitOrdersFullScreen() {
    document.body.classList.remove('orders-table-fullscreen');
    if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
    }
    setTimeout(() => {
        if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
    }, 100);
}

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

// Replacement Order modal
function openReplacementOrderModal() {
    const form = document.getElementById('replacementOrderForm');
    if (form) form.reset();
    // Pre-fill order number from selected row if exactly one is selected
    if (ordersGridApi) {
        const selected = ordersGridApi.getSelectedRows().filter(r => r && r.id !== '__footer__');
        if (selected.length === 1) {
            const orderNum = String(selected[0].order_number || '').replace(/-R$/i, '');
            document.getElementById('replOrderNumber').value = orderNum;
        }
    }
    document.getElementById('replacementOrderModal')?.classList.add('active');
    document.getElementById('replOrderNumber')?.focus();
}

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
                const uniqueOrderNumbers = [...new Set(orderNumbers)].sort((a, b) => {
                    const numA = parseInt(a, 10);
                    const numB = parseInt(b, 10);
                    if (!isNaN(numA) && !isNaN(numB)) {
                        return numA - numB;
                    }
                    return String(a).localeCompare(String(b));
                });
                
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
        const response = await fetch(`${API_BASE}/orders/bulk-update-delivery-charges`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_numbers: orderNumbers, delivery_charge: deliveryCharge }),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to update delivery charges');
        }
        const result = await response.json();
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
        const response = await fetch(`${API_BASE}/products/batch-update-cost-prices`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                updates: selected.map((r) => ({ id: r.id, cost_price: costPrice }))
            })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to update cost prices');
        }
        const result = await response.json();
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
        const response = await fetch(`${API_BASE}/products/recalculate-order-costs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                product_id: productId,
                created_after: d.toISOString()
            })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const detail = err.detail;
            const msg = typeof detail === 'string' ? detail : (Array.isArray(detail) ? JSON.stringify(detail) : 'Failed to recalculate');
            throw new Error(msg);
        }
        const result = await response.json();
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
        // Support both numeric order numbers and replacement orders like "4807-R"
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
        const response = await fetch(`${API_BASE}/orders/bulk-update-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_numbers: orderNumbers, order_status: orderStatus }),
        });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Bulk update failed');
        }
        const result = await response.json();
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
        const pieceReceivedResponse = await fetch(`${API_BASE}/orders/bulk-update-piece-received`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_numbers: orderNumbers }),
        });
        if (!pieceReceivedResponse.ok) {
            const err = await pieceReceivedResponse.json();
            throw new Error(err.detail || 'Failed to update piece received');
        }
        const pieceReceivedResult = await pieceReceivedResponse.json();
        
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

    if (currentView === 'cashbook') {
        const incomingRows = _buildExportSheetRows(cashbookIncomingGridApi);
        const outgoingRows = _buildExportSheetRows(cashbookOutgoingGridApi);
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(incomingRows), 'Incoming');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(outgoingRows), 'Outgoing');
        sheetCount = 2;
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

/** Fetch delivery status for one order (no modal). Returns data or throws. */
async function fetchDeliveryStatusForOrder(orderId, courier, trackingNumber) {
    const url = `${API_BASE}/orders/${orderId}/delivery-status?save=true`;
    const response = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const detail = Array.isArray(error.detail) ? error.detail.join(' ') : (error.detail || 'Failed to fetch delivery status');
        throw new Error(detail);
    }
    return response.json();
}

const FETCH_DELIVERY_BTN_DEFAULT_TEXT = 'Fetch Delivery Status';

/** Refresh delivery status for all selected orders: sequential fetch, row-by-row update. Status shown in button; continues in background when user changes page. */
async function refreshDeliveryStatusSelected() {
    if (!ordersGridApi) return;
    const selected = ordersGridApi.getSelectedRows();
    const toFetch = selected.filter(row => {
        const status = (row.order_status || '').toLowerCase();
        if (status === 'delivered' || status === 'returned') return false;
        const courier = (row.courier || '').trim();
        const track = (row.tracking_number || '').trim();
        const courierNormalized = courier.toUpperCase();
        const supportsDeliveryRefresh = (
            courierNormalized === 'POSTEX' ||
            courierNormalized === 'COURIERS NEXT'
        );
        return supportsDeliveryRefresh && track && track !== '-';
    });
    if (toFetch.length === 0) {
        showToast('Select PostEx/Couriers Next orders with tracking number (delivered and returned are skipped)', 'warning');
        return;
    }
    const btn = document.getElementById('refreshDeliveryStatusSelectedBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = `Fetching 0/${toFetch.length}`;
    }
    const total = toFetch.length;
    let fetched = 0;
    const updateProgress = () => {
        const b = document.getElementById('refreshDeliveryStatusSelectedBtn');
        if (b) b.textContent = `Fetching ${fetched}/${total}`;
    };
    try {
        for (const order of toFetch) {
            try {
                const data = await fetchDeliveryStatusForOrder(order.id, order.courier, order.tracking_number);
                if (ordersGridApi) {
                    ordersGridApi.forEachNode(node => {
                        if (node.data && node.data.id === order.id) {
                            const updated = { ...node.data, delivery_status: data };
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
            } catch (err) {
                console.warn('Delivery status fetch failed for order', order.id, err.message);
            }
            fetched += 1;
            updateProgress();
        }
        showToast(`Updated delivery status for ${fetched} of ${total} selected orders`, 'success');
    } finally {
        const b = document.getElementById('refreshDeliveryStatusSelectedBtn');
        if (b) {
            b.disabled = false;
            b.textContent = FETCH_DELIVERY_BTN_DEFAULT_TEXT;
        }
    }
}

async function fetchDeliveryStatus(orderId, courier, trackingNumber) {
    console.log('fetchDeliveryStatus called with:', { orderId, courier, trackingNumber });
    
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
    
    modal.style.display = 'flex';
    content.innerHTML = '<div class="loading">Fetching delivery status...</div>';
    
    try {
        const url = `${API_BASE}/orders/${orderId}/delivery-status?save=true`;
        console.log('Making request to:', url);
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('Response status:', response.status);
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const detail = Array.isArray(error.detail) ? error.detail.join(' ') : (error.detail || 'Failed to fetch delivery status');
            throw new Error(detail);
        }
        
        const data = await response.json();
        console.log('Received data:', data);
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
    const courierSafe = (data.courier || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const trackingSafe = (data.tracking_number || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    
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
        data.status_history.forEach((status, index) => {
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
    html += `<div class="delivery-status-modal-actions"><button type="button" class="btn btn-primary delivery-status-btn" onclick="fetchDeliveryStatus('${orderId}', '${courierSafe}', '${trackingSafe}')">Refresh status</button></div>`;
    content.innerHTML = html;
}

function closeDeliveryStatusModal() {
    const modal = document.getElementById('deliveryStatusModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function showPostExAmountMismatchesModal(mismatches) {
    const modal = document.getElementById('postExAmountMismatchesModal');
    const tbody = document.getElementById('postExAmountMismatchesBody');
    if (!modal || !tbody) return;
    tbody.innerHTML = mismatches.map(m => {
        const diff = (m.receivable - m.csv_net_amount).toFixed(2);
        return `<tr><td>${m.order_number}</td><td>${m.receivable.toFixed(2)}</td><td>${m.csv_net_amount.toFixed(2)}</td><td>${diff}</td></tr>`;
    }).join('');
    modal.style.display = 'flex';
}

function closePostExAmountMismatchesModal() {
    const modal = document.getElementById('postExAmountMismatchesModal');
    if (modal) modal.style.display = 'none';
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
});

// Make functions globally accessible
window.closeModal = closeModal;
window.syncShopifyProducts = syncShopifyProducts;
window.fetchDeliveryStatus = fetchDeliveryStatus;
window.closeDeliveryStatusModal = closeDeliveryStatusModal;
