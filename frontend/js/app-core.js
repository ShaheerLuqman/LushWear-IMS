// Config, session-token auth (patches window.fetch - must load first),
// shared app state, edit lock, and the PIN gate.

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

/** PIN gate form submit handler (removed after success so lock-app can re-open the gate). */
let pinGateSubmitHandler = null;

/**
 * Prefetch promise started as soon as the backend is confirmed ready (while the user types
 * their PIN). Awaited in DOMContentLoaded instead of starting a fresh fetch after PIN entry.
 */
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
// Auto-sync orders 10 minutes after the last sync (server-tracked via /orders/sync-status,
// not per-tab); timer is reset whenever a sync (manual or auto) completes. The backend's
// lock (sync_status.in_progress) keeps overlapping tabs/devices from ever syncing concurrently.
const ORDERS_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
let ordersAutoSyncTimerId = null;
let lastOrdersSyncAt = null; // ms epoch
/** Orders grid date column id (for header date range filter). */
const ORDERS_DATE_COLUMN_ID = 'order_receiving_date';
/** Guard: when Order# filter is a full order number (4+ digits) and 0 results, we fetch from DB; avoid duplicate requests */
let ordersFetchByNumberInFlight = null;
/** IDs of orders added temporarily from "fetch by number" search; removed when filter is cleared or changed */
let ordersFetchedByNumberIds = new Set();

function closeOrdersMoreActionsMenu() {
    const wrap = document.getElementById('ordersMoreActionsWrap');
    const btn = document.getElementById('ordersMoreActionsBtn');
    if (wrap) wrap.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function initOrdersMoreActionsMenu() {
    const wrap = document.getElementById('ordersMoreActionsWrap');
    const btn = document.getElementById('ordersMoreActionsBtn');
    const menu = document.getElementById('ordersMoreActionsMenu');
    if (!wrap || !btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = wrap.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            const rect = btn.getBoundingClientRect();
            menu.style.top = `${rect.bottom + 4}px`;
            // Right-align to the button, clamped so the menu can't run off-screen.
            menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
        }
    });
    // Each item keeps its own handler (bound elsewhere by id); this just dismisses the menu.
    menu.addEventListener('click', (e) => {
        if (e.target.closest('.orders-more-actions__item')) closeOrdersMoreActionsMenu();
    });
    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) closeOrdersMoreActionsMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeOrdersMoreActionsMenu();
    });
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
        'bulkUpdateCostPriceSubmit',
        'recalculateOrderCostsSubmit',
        'bulkUpdateDeliveryChargesConfirm',
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

const THEME_STORAGE_KEY = 'lushwear-theme';

function applyTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    // AG Grid ships its own dark theme; swapping the container class picks up all of
    // its internals (menus, popups, chart panels) rather than only the vars we override.
    document.querySelectorAll('.grid-container').forEach((el) => {
        el.classList.toggle('ag-theme-alpine-dark', dark);
        el.classList.toggle('ag-theme-alpine', !dark);
    });
    document.querySelectorAll('.settings-theme-btn').forEach((btn) => {
        const selected = btn.dataset.themeChoice === theme;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
}

function initSettingsView() {
    // The theme itself is set pre-paint by an inline script in index.html; this just
    // syncs the toggle's selected state and handles changes.
    applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'light');

    document.querySelectorAll('.settings-theme-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const theme = btn.dataset.themeChoice;
            localStorage.setItem(THEME_STORAGE_KEY, theme);
            applyTheme(theme);
        });
    });
}

// ============================================
// Desktop install prompt (PWA) — lets the browser add a desktop shortcut
// ============================================
const INSTALL_PROMPT_DISMISSED_KEY = 'lushwear_install_prompt_dismissed';
let deferredInstallPrompt = null;

// Safari (macOS) has no beforeinstallprompt/install API - "Add to Dock" is a manual
// File-menu action only the user can trigger, so we just point them at it.
function isMacSafari() {
    const ua = navigator.userAgent;
    return /Macintosh/.test(ua) && /^((?!chrome|android|crios|edg|opr).)*safari/i.test(ua);
}

function showInstallBanner() {
    if (localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)) return;
    const banner = document.getElementById('installAppBanner');
    if (banner) banner.style.display = 'flex';
}

function hideInstallBanner() {
    const banner = document.getElementById('installAppBanner');
    if (banner) banner.style.display = 'none';
}

function initInstallPrompt() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').catch(() => { /* installability only - safe to ignore */ });
    }

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        showInstallBanner();
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        hideInstallBanner();
    });

    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            hideInstallBanner();
        });
    }

    const dismissBtn = document.getElementById('installAppDismissBtn');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
            localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, '1');
            hideInstallBanner();
        });
    }

    if (isMacSafari()) {
        const titleEl = document.getElementById('installAppBannerTitle');
        const subtitleEl = document.getElementById('installAppBannerSubtitle');
        if (titleEl) titleEl.textContent = 'Install LushWear IMS';
        if (subtitleEl) subtitleEl.textContent = 'In the Safari menu bar: File → Add to Dock';
        if (installBtn) installBtn.style.display = 'none';
        showInstallBanner();
    }
}

function initChangePinModal() {
    const modal = document.getElementById('changePinModal');
    const form = document.getElementById('changePinForm');
    const errEl = document.getElementById('changePinError');
    const openBtn = document.getElementById('settingsChangePinBtn');
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
                throw new Error(apiErrorMessage(data, 'Request failed'));
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
                waitingEl.style.display = '';
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
                            errEl.textContent = apiErrorMessage(data, 'Request failed');
                        }
                        submitBtn.disabled = true;
                        detachPinGateSubmit();
                        resolve(false);
                        return;
                    }
                    if (!r.ok) {
                        throw new Error(apiErrorMessage(data, 'Request failed'));
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
                        waitingEl.style.display = '';
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
                        throw new Error(apiErrorMessage(data, 'Request failed'));
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
                            r.status === 401 ? 'Incorrect PIN' : apiErrorMessage(data, 'Request failed');
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
    initSettingsView();
    initInstallPrompt();
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

    let ordersLoaded = false;

    // If prefetch was started during PIN entry, await that promise; otherwise fetch now.
    // Products aren't fetched here - nothing on the landing (Orders) view needs them, and
    // Products/Dashboard fetch their own fresh copy when visited (see switchView).
    const loadOrdersPromise = (_prefetchOrdersPromise || loadOrders())
        .then(() => {
            ordersLoaded = true;
        })
        .catch((error) => {
            console.error('Error loading orders:', error);
            showToast('Failed to load orders', 'error');
            ordersLoaded = true;
        });

    await loadOrdersPromise;

    if (ordersLoaded) {
        // Orders are already freshly loaded above - skip switchView's normal reload so
        // startup doesn't fetch the same data twice before the background syncs kick off.
        switchView('orders', { skipReload: true });
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
        initOrdersAutoSync();
        fetchLoadSheetRiderNames();
        autoFetchRecentDeliveryStatus();

        await applyStartupDeepLink();
    }
});

/**
 * Handle ?action= deep links (e.g. a phone shortcut to record an entry).
 * Runs after the PIN gate so the target view has data and a valid token.
 */
async function applyStartupDeepLink() {
    // Also accept the hash form (#action=...): static hosts that redirect
    // /index.html to / drop the query string, but never the hash.
    const action = new URLSearchParams(window.location.search).get('action')
        || new URLSearchParams(window.location.hash.replace(/^#/, '')).get('action');
    if (action !== 'create-entry' && action !== 'bulk-entry') {
        return;
    }
    // Editing defaults to locked on open, which would make openCashbookEntryModal
    // bail with a toast. The link exists to record an entry, so unlock for it.
    editLocked = false;
    applyEditLockState();
    // The entry modal needs the ledger list, so load before opening rather than
    // letting switchView kick off an un-awaited fetch.
    switchView('cashbook', { skipReload: true });
    await loadCashbook();
    openCashbookEntryModal();
    if (action === 'bulk-entry') {
        setCashbookEntryMode('bulk');
    }
    // Drop the query/hash so a refresh or back-navigation doesn't re-open the modal.
    history.replaceState(null, '', window.location.pathname);

}

