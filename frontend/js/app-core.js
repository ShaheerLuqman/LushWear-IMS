// Config, session-token auth (patches window.fetch - must load first),
// shared app state, edit lock, and the login gate.

// API Configuration
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) || 'http://127.0.0.1:8000/api';

// ============================================
// Session-token auth
// The login gate exchanges email+password for a token (see runAuthGate). We store it
// for the session and attach it to every API request via a fetch wrapper. A 401 from a
// protected route means the token is missing/expired -> re-open the login gate.
// ============================================
// localStorage (not sessionStorage) so a login survives a new tab or the
// browser restarting, not just a same-tab reload - it's the JWT's own exp
// claim that ends a session, not where it happens to be stored.
const AUTH_TOKEN_KEY = 'lushwear_auth_token';

function getAuthToken() {
    try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setAuthToken(token) {
    _authExpiredHandling = false;
    try { if (token) localStorage.setItem(AUTH_TOKEN_KEY, token); } catch (e) { /* ignore */ }
}
function clearAuthToken() {
    try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) { /* ignore */ }
}

/** Same key js/admin.js's Superadmin Portal uses for its own session token -
 * both pages share one origin, so localStorage already carries a login made
 * on one page over to the other; tryResumeSession() below is what actually
 * acts on it. */
const SUPERADMIN_TOKEN_KEY = 'lushwear_superadmin_token';

/** True while we are already re-opening the login gate after a 401, to avoid repeats. */
let _authExpiredHandling = false;

function isAuthBootstrapUrl(url) {
    // auth/login and auth/bootstrap are the login itself; their 401s are handled locally
    // (wrong password) rather than treated as an expired session.
    return url.indexOf(API_BASE + '/auth/login') === 0 || url.indexOf(API_BASE + '/auth/bootstrap') === 0;
}

function onAuthExpired() {
    if (_authExpiredHandling) return;
    _authExpiredHandling = true;
    clearAuthToken();
    try { showToast('Session expired. Please log in again.', 'warning'); } catch (e) { /* ignore */ }
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

/** Auth gate form submit handler (removed after success so lock-app can re-open the gate). */
let authGateSubmitHandler = null;

/**
 * Prefetch promise started as soon as the backend is confirmed ready (while the user types
 * their credentials). Awaited in DOMContentLoaded instead of starting a fresh fetch after login.
 */
let _prefetchOrdersPromise = null;

/** This org's enabled sections (Feature Access plan), from /auth/me's
 * enabled_features - resolved once at boot and used to hide disabled sidebar
 * sections/nav items. Backend enforcement (app/features.py's require_feature)
 * is the real access control; this is only the UI-hiding half of it. */
let enabledFeatures = [];

function hasFeature(key) {
    return enabledFeatures.includes(key);
}

/** Hides each sidebar nav-section whose feature isn't enabled for this org. */
function applyFeatureVisibility() {
    document.querySelectorAll('.nav-section[data-feature-section]').forEach((section) => {
        section.style.display = hasFeature(section.dataset.featureSection) ? '' : 'none';
    });
}

// State
let products = [];
let orders = [];
/** Period key ('__all__' or 'M-YYYY') that `orders`/the grid currently holds - lets
 * hydrateOrdersFromCache() skip repainting when it's already showing that period. */
let ordersLoadedPeriodKey = null;
let transactionEntries = [];
let transactionSelectedDate = null;
let currentView = 'orders';
/** localStorage so the last view survives a reload (dev live-reload, accidental
 * refresh, etc.) - restored in runAuthGate's post-login boot. Detail views
 * (ledgerDetail, monthDetail, courierPaymentReportDetail) need extra context
 * beyond the view name, so they're excluded in switchView/restoreLastView. */
const CURRENT_VIEW_KEY = 'lushwear_current_view';
const NON_RESTORABLE_VIEWS = new Set(['ledgerDetail', 'monthDetail', 'courierPaymentReportDetail', 'orderFulfillmentProgress']);
let productsGridApi = null;
let ordersGridApi = null;
let transactionsGridApi = null;
let ledgers = [];
let currentOrgId = null;
let ledgerEntries = [];
let currentLedger = null;
let ledgerDetailGridApi = null;
let updateFooterRow = null; // Will be set in initOrdersGrid
let loadSheetRiderNames = [];
/** Next assignment number for load sheet (format LW-N). Updated when load sheet logs are fetched. */
let nextLoadSheetAssignmentNumber = 1;
// Orders sync once on app load, then every 5 minutes; the timer is reset whenever a sync
// completes. The backend's lock (sync_status.in_progress, capped at
// _SYNC_LOCK_STALE_AFTER=5min in orders.py) keeps overlapping tabs/devices from ever
// syncing concurrently - a load-time sync racing another tab's gets already_syncing back.
const ORDERS_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
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

/** When true, user cannot edit anything (grids, forms, sync, bulk update, etc.). Default: unlocked on open. */
let editLocked = false;

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
        if (lockIcon) {
            lockIcon.innerHTML = `<i data-lucide="${locked ? 'lock' : 'lock-open'}"></i>`;
            if (window.lucide) lucide.createIcons({ root: lockIcon });
        }
        if (lockTooltip) lockTooltip.textContent = locked ? 'Unlock editing' : 'Lock editing';
    }
    const editButtons = [
        'createLedgerBtn',
        'createLedgerSubmitBtn',
        'editLedgerDeleteBtn',
        'editLedgerSubmitBtn',
        'bulkUpdateOrderBtn',
        'bulkUpdateCostPriceBtn',
        'bulkUpdateDeliveryChargesBtn',
        'bulkUpdateSetDelivered',
        'bulkUpdateSetReturned',
        'bulkUpdateSetCancelled',
        'bulkUpdateSetPieceReceived',
        'bulkUpdateSetOrderSettled',
        'bulkUpdateSetOrderUnsettled',
        'bulkUpdateCostPriceSubmit',
        'bulkUpdateDeliveryChargesConfirm',
        'editVariantCostsSave',
        'editVariantCostsRecalcSubmit',
    ];
    editButtons.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = locked;
    });
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

function initChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    const form = document.getElementById('changePasswordForm');
    const errEl = document.getElementById('changePasswordError');
    const openBtn = document.getElementById('settingsChangePasswordBtn');
    const closeBtn = document.getElementById('changePasswordModalClose');
    const cancelBtn = document.getElementById('changePasswordCancelBtn');
    if (!modal || !form) {
        return;
    }

    function openModal() {
        if (errEl) {
            errEl.textContent = '';
        }
        form.reset();
        modal.classList.add('active');
        const cur = document.getElementById('changePasswordCurrent');
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
        const current = (document.getElementById('changePasswordCurrent') || {}).value || '';
        const newPassword = (document.getElementById('changePasswordNew') || {}).value || '';
        const confirm = (document.getElementById('changePasswordNewConfirm') || {}).value || '';
        if (newPassword !== confirm) {
            if (errEl) {
                errEl.textContent = 'New passwords do not match';
            }
            return;
        }
        const saveBtn = document.getElementById('changePasswordSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = true;
        }
        try {
            await apiJson('/auth/change-password', {
                method: 'POST',
                body: { current_password: current, new_password: newPassword }
            });
            showToast('Password updated', 'success');
            closeModal();
        } catch (ex) {
            if (errEl) {
                errEl.textContent = ex.message || 'Could not update password';
            }
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
            }
        }
    });
}

/**
 * Block until login succeeds, or first-time org+admin setup completes.
 * @returns {Promise<boolean>} false only if server reports the Organizations & Users
 *   tables are missing (503) - i.e. the Phase 2 migrations haven't been applied yet.
 */
function runAuthGate() {
    const root = document.getElementById('authGateRoot');
    const titleEl = document.getElementById('authGateTitle');
    const errEl = document.getElementById('authGateError');
    const form = document.getElementById('authGateForm');
    const orgNameWrap = document.getElementById('authGateOrgNameWrap');
    const orgNameInput = document.getElementById('authGateOrgName');
    const nameWrap = document.getElementById('authGateNameWrap');
    const nameInput = document.getElementById('authGateName');
    const emailInput = document.getElementById('authGateEmail');
    const passwordInput = document.getElementById('authGatePassword');
    const confirmWrap = document.getElementById('authGateConfirmWrap');
    const confirmInput = document.getElementById('authGateConfirmPassword');
    const submitBtn = document.getElementById('authGateSubmit');
    const waitingEl = document.getElementById('authGateWaiting');
    if (!root || !form || !emailInput || !passwordInput || !confirmInput || !submitBtn) {
        return Promise.resolve(true);
    }

    if (errEl) {
        errEl.textContent = '';
    }
    submitBtn.disabled = true;

    if (authGateSubmitHandler) {
        form.removeEventListener('submit', authGateSubmitHandler);
        authGateSubmitHandler = null;
    }

    return new Promise((resolve) => {
        let hasUsers = false;

        function detachAuthGateSubmit() {
            if (authGateSubmitHandler && form) {
                form.removeEventListener('submit', authGateSubmitHandler);
                authGateSubmitHandler = null;
            }
        }

        async function loadStatus() {
            // Hide the form and show connecting state while backend isn't ready
            if (form) form.style.display = 'none';
            if (titleEl) titleEl.style.display = 'none';
            if (waitingEl) {
                waitingEl.style.display = '';
                waitingEl.innerHTML = '<span class="auth-gate-spinner"></span>Connecting to server…';
            }

            for (;;) {
                try {
                    const r = await fetch(`${API_BASE}/auth/status`);
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
                        detachAuthGateSubmit();
                        resolve(false);
                        return;
                    }
                    if (!r.ok) {
                        throw new Error(apiErrorMessage(data, 'Request failed'));
                    }

                    // Backend is ready. (Data is loaded after login, once we hold a
                    // token — protected routes reject unauthenticated prefetches.)

                    // Hide connecting state, reveal form
                    if (waitingEl) waitingEl.style.display = 'none';
                    if (form) form.style.display = '';
                    if (titleEl) titleEl.style.display = '';

                    hasUsers = !!data.has_users;
                    if (titleEl) {
                        titleEl.textContent = hasUsers ? 'Log in' : 'Set up your organization';
                    }
                    if (orgNameWrap) {
                        orgNameWrap.style.display = hasUsers ? 'none' : 'flex';
                    }
                    if (nameWrap) {
                        nameWrap.style.display = hasUsers ? 'none' : 'flex';
                    }
                    if (confirmWrap) {
                        confirmWrap.style.display = hasUsers ? 'none' : 'flex';
                    }
                    if (hasUsers) {
                        confirmInput.removeAttribute('required');
                        orgNameInput.removeAttribute('required');
                        if (nameInput) nameInput.removeAttribute('required');
                        passwordInput.setAttribute('autocomplete', 'current-password');
                    } else {
                        confirmInput.setAttribute('required', 'required');
                        orgNameInput.setAttribute('required', 'required');
                        if (nameInput) nameInput.setAttribute('required', 'required');
                        passwordInput.setAttribute('autocomplete', 'new-password');
                    }
                    emailInput.value = '';
                    passwordInput.value = '';
                    confirmInput.value = '';
                    orgNameInput.value = '';
                    if (nameInput) nameInput.value = '';
                    emailInput.focus();
                    submitBtn.disabled = false;
                    break;
                } catch {
                    if (waitingEl) {
                        waitingEl.style.display = '';
                        waitingEl.innerHTML = '<span class="auth-gate-spinner"></span>Waiting for server…';
                    }
                    await new Promise((t) => setTimeout(t, 800));
                }
            }
        }

        authGateSubmitHandler = async function authGateOnSubmit(ev) {
            ev.preventDefault();
            if (errEl) {
                errEl.textContent = '';
            }
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            const confirm = confirmInput.value;
            const orgName = orgNameInput.value.trim();
            const name = nameInput ? nameInput.value.trim() : '';
            if (!hasUsers && password !== confirm) {
                if (errEl) {
                    errEl.textContent = 'Passwords do not match';
                }
                return;
            }
            submitBtn.disabled = true;
            const submitLabel = submitBtn.textContent;
            submitBtn.innerHTML =
                `<span class="btn-spinner"></span>${hasUsers ? 'Logging in…' : 'Setting up…'}`;
            try {
                if (!hasUsers) {
                    const r = await fetch(`${API_BASE}/auth/bootstrap`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ org_name: orgName, name, email, password })
                    });
                    const data = await r.json().catch(() => ({}));
                    if (!r.ok) {
                        throw new Error(apiErrorMessage(data, 'Request failed'));
                    }
                    setAuthToken(data.token);
                    root.hidden = true;
                    detachAuthGateSubmit();
                    resolve(true);
                    return;
                }
                const r = await fetch(`${API_BASE}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) {
                    if (errEl) {
                        errEl.textContent =
                            r.status === 401 ? 'Incorrect email or password' : apiErrorMessage(data, 'Request failed');
                    }
                    passwordInput.value = '';
                    passwordInput.focus();
                    return;
                }
                setAuthToken(data.token);
                if (data.user && data.user.is_superadmin === true && !data.user.org_id) {
                    // A pure superadmin (no memberships at all) has no org_id, so this
                    // token alone can't load any business data - resolve to their
                    // last-used (or default) org via the portal's impersonate flow.
                    const orgToken = await resolveSuperadminHomeOrgToken();
                    if (!orgToken) {
                        clearAuthToken();
                        if (errEl) errEl.textContent = 'No organizations exist yet to view.';
                        return;
                    }
                    setAuthToken(orgToken);
                } else if (data.user && data.user.org_id) {
                    // Login already resolved a valid org (their first membership, or a
                    // superadmin who also holds a real one) - if a *different* org was
                    // last used on this browser, switch to it. Not fatal if this fails;
                    // login's own default token is already valid on its own.
                    await switchToLastUsedOrgIfDifferent(data.user.org_id);
                }
                root.hidden = true;
                detachAuthGateSubmit();
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

        form.addEventListener('submit', authGateSubmitHandler);
        loadStatus();
    });
}

function lockApp() {
    exitOrdersFullScreen();
    const appContainer = document.querySelector('.app-container');
    const root = document.getElementById('authGateRoot');
    if (!root) {
        return;
    }
    root.hidden = false;
    if (appContainer) {
        appContainer.style.visibility = 'hidden';
        appContainer.style.opacity = '0';
    }
    runAuthGate().then((ok) => {
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

    if (window.lucide) lucide.createIcons();
    initNavigation();
    initOrdersPeriodFilter();
    initOrdersDateRangeButton();
    initOrdersActions();
    initTransactionsActions();
    initLedgerModals();
    initMonthSummaryNav();
    initGrids();
    initChangePasswordModal();
    initSettingsView();
    initInstallPrompt();
    initOrderFulfillment();

    const impersonating = consumeImpersonationToken();
    let resumedAccount = impersonating ? null : await tryResumeSession();
    if (resumedAccount) {
        // Bypassing runAuthGate() entirely - it's the one that normally hides
        // this overlay on success, so do that ourselves here.
        const gateRoot = document.getElementById('authGateRoot');
        if (gateRoot) gateRoot.hidden = true;
    }
    const authOk = impersonating || !!resumedAccount || await runAuthGate();
    if (!authOk) {
        return;
    }

    let account = null;
    try {
        // Already fetched by tryResumeSession() above - no need to ask twice.
        account = resumedAccount || await apiJson('/auth/me');
        enabledFeatures = account.enabled_features || [];
    } catch (e) {
        enabledFeatures = [];
    }
    currentOrgId = account?.org_id || null;
    // Shape-only consumers (bill/order ledger pickers) get last session's list
    // immediately instead of waiting on a fetch - loadLedgers()/loadLedgersList()
    // still hit the network for whichever view actually shows balances.
    hydrateLedgersFromCache();
    applyFeatureVisibility();
    initUserMenu(account);

    if (loadingScreen) {
        loadingScreen.style.display = 'flex';
    }

    // Land on the first section this org actually has enabled, rather than
    // assuming Orders - a finance-only org would otherwise boot straight into
    // a hidden/blocked view.
    const ordersEnabled = hasFeature('orders');
    const financeEnabled = hasFeature('finance');
    let defaultView = ordersEnabled ? 'orders' : financeEnabled ? 'transactions' : 'settings';

    // Resume the last view (e.g. after a dev reload) if it's still reachable for
    // this org - the nav item is only in the DOM and visible when its feature section
    // (applyFeatureVisibility, called above) is enabled.
    try {
        const lastView = localStorage.getItem(CURRENT_VIEW_KEY);
        if (lastView && !NON_RESTORABLE_VIEWS.has(lastView)) {
            const navItem = document.querySelector(`.nav-item[data-view="${lastView}"]`);
            if (navItem && navItem.offsetParent !== null) defaultView = lastView;
        }
    } catch (e) { /* ignore */ }

    let dataLoaded = false;

    // If prefetch was started during login, await that promise; otherwise fetch now.
    // Products aren't fetched here - nothing on the landing (Orders) view needs them, and
    // Products/Dashboard fetch their own fresh copy when visited (see switchView).
    const loadDataPromise = (ordersEnabled ? (_prefetchOrdersPromise || loadOrders()) : financeEnabled ? loadTransactions() : Promise.resolve())
        .then(() => {
            dataLoaded = true;
        })
        .catch((error) => {
            console.error(`Error loading ${defaultView}:`, error);
            showToast(`Failed to load ${defaultView}`, 'error');
            dataLoaded = true;
        });

    await loadDataPromise;

    if (dataLoaded) {
        // The default view's data is already freshly loaded above - skip switchView's
        // normal reload so startup doesn't fetch the same data twice.
        switchView(defaultView, { skipReload: true });
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

        if (ordersEnabled) {
            syncShopifyProducts();
            initOrdersAutoSync();
            fetchLoadSheetRiderNames();
            autoFetchRecentDeliveryStatus();
        }

        await applyStartupDeepLink();
    }
});

/**
 * Handle ?action= deep links (e.g. a phone shortcut to record an entry).
 * Runs after the login gate so the target view has data and a valid token.
 */
async function applyStartupDeepLink() {
    // Also accept the hash form (#action=...): static hosts that redirect
    // /index.html to / drop the query string, but never the hash.
    const action = new URLSearchParams(window.location.search).get('action')
        || new URLSearchParams(window.location.hash.replace(/^#/, '')).get('action');
    if (action !== 'create-entry' && action !== 'bulk-entry') {
        return;
    }
    if (!hasFeature('finance')) {
        history.replaceState(null, '', window.location.pathname);
        return;
    }
    // The entry modal needs the ledger list, so load before opening rather than
    // letting switchView kick off an un-awaited fetch.
    switchView('transactions', { skipReload: true });
    await loadTransactions();
    openTransactionEntryModal();
    if (action === 'bulk-entry') {
        setTransactionEntryMode('bulk');
    }
    // Drop the query/hash so a refresh or back-navigation doesn't re-open the modal.
    history.replaceState(null, '', window.location.pathname);

}

/**
 * Consumes a Superadmin Portal "View as org" token from #impersonate=<token>
 * (admin.html opens this app in a new tab that way - see js/admin.js). Using
 * the hash rather than a ?query param means the token is never sent to the
 * server in a request and never appears in server access logs.
 * @returns {boolean} true if a token was found and stored (login gate can be skipped).
 */
function consumeImpersonationToken() {
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('impersonate');
    if (!token) return false;
    setAuthToken(token);
    history.replaceState(null, '', window.location.pathname);
    // runAuthGate() is skipped entirely on this path, so nothing else hides the
    // gate overlay (it's visible by default, showing its "Connecting..." state,
    // until runAuthGate() would normally hide it on success).
    const root = document.getElementById('authGateRoot');
    if (root) root.hidden = true;
    return true;
}

/** Decodes a JWT's payload without verifying its signature - fine for a
 * client-side "should I show this UI" decision, since the server independently
 * re-validates the signature on every real API call regardless of what the
 * client displays. JWTs use base64url (not plain base64), hence the swap. */
function decodeTokenPayload(token) {
    try {
        const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
        return JSON.parse(atob(padded));
    } catch (e) {
        return null;
    }
}

/** Shared with admin.js's "View as org" (localStorage, not sessionStorage, so
 * it persists across tabs/visits on this browser) - lets anyone with more
 * than one org available (a superadmin, or a real multi-org member) resume
 * wherever they last were on their next login, instead of always landing on
 * whichever org /auth/login defaults to. */
const LAST_USED_ORG_KEY = 'lushwear_last_used_org';

function rememberLastUsedOrg(orgId) {
    try { localStorage.setItem(LAST_USED_ORG_KEY, orgId); } catch (e) { /* ignore */ }
}

/**
 * A superadmin's own account has no org_id when they hold no real memberships
 * (see Superadmin Portal plan), so logging in directly on this app's gate -
 * rather than via admin.html's "View as org" - yields a token that can't load
 * any business data. Resolves an org to view: the last one used on this
 * browser if it still exists, else the earliest-created org (LushWear, org
 * #1), and exchanges the superadmin token for a real impersonation token
 * scoped to it.
 * @returns {Promise<string|null>} an impersonation token, or null if no org exists at all.
 */
async function resolveSuperadminHomeOrgToken() {
    async function tryImpersonate(orgId) {
        try {
            const data = await apiJson(`/admin/organizations/${orgId}/impersonate`, { method: 'POST' });
            rememberLastUsedOrg(orgId);
            return data.token;
        } catch (e) {
            return null;
        }
    }

    let lastOrgId = null;
    try { lastOrgId = localStorage.getItem(LAST_USED_ORG_KEY); } catch (e) { /* ignore */ }
    if (lastOrgId) {
        const token = await tryImpersonate(lastOrgId);
        if (token) return token;
    }

    // No stored org, or it no longer resolves (e.g. deleted) - fall back to the
    // earliest-created org. GET /admin/organizations orders by created_at, so
    // index 0 is always LushWear (org #1) today.
    try {
        const orgs = await apiJson('/admin/organizations');
        if (!orgs.length) return null;
        return await tryImpersonate(orgs[0].id);
    } catch (e) {
        return null;
    }
}

/**
 * Resumes an already-authenticated session at boot instead of always
 * re-showing the login gate (js/admin.js's own boot check already does this
 * for the Superadmin Portal - this is the equivalent for the main app).
 * Checks, in order: (1) this page's own token, still valid; (2) a superadmin
 * session already established on the Superadmin Portal (admin.html) - same
 * origin, so it shares this browser's localStorage, and is treated as the
 * same login rather than asking for credentials again.
 * @returns {Promise<object|null>} the account (AccountPublic) if a session
 * was resumed, else null - caller falls back to runAuthGate().
 */
async function tryResumeSession() {
    if (getAuthToken()) {
        try {
            return await apiJson('/auth/me');
        } catch (e) {
            clearAuthToken();
        }
    }

    let superadminToken = '';
    try { superadminToken = localStorage.getItem(SUPERADMIN_TOKEN_KEY) || ''; } catch (e) { /* ignore */ }
    if (!superadminToken) return null;

    setAuthToken(superadminToken);
    try {
        let account = await apiJson('/auth/me');
        if (account.is_superadmin !== true) {
            clearAuthToken();
            try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch (e2) { /* ignore */ }
            return null;
        }
        if (!account.org_id) {
            const orgToken = await resolveSuperadminHomeOrgToken();
            if (!orgToken) {
                clearAuthToken();
                return null;
            }
            setAuthToken(orgToken);
            account = await apiJson('/auth/me');
        }
        return account;
    } catch (e) {
        // The shared superadmin token itself is gone/expired (not just this
        // page's own derived token) - drop it so a reload doesn't keep
        // silently retrying it.
        clearAuthToken();
        try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch (e2) { /* ignore */ }
        return null;
    }
}

/**
 * Applies to a regular multi-org member (or a superadmin who also holds a
 * real membership): /auth/login always resolves to their *first* membership
 * as a stable default. If a *different* org was last used on this browser,
 * switch to it via /auth/switch-org. Not fatal if this fails (the org may no
 * longer exist, or the membership may have been revoked) - login's own
 * default token is already valid on its own.
 */
async function switchToLastUsedOrgIfDifferent(currentOrgId) {
    let lastOrgId = null;
    try { lastOrgId = localStorage.getItem(LAST_USED_ORG_KEY); } catch (e) { /* ignore */ }
    if (!lastOrgId || lastOrgId === currentOrgId) {
        rememberLastUsedOrg(currentOrgId);
        return;
    }
    try {
        const data = await apiJson('/auth/switch-org', { method: 'POST', body: { org_id: lastOrgId } });
        setAuthToken(data.token);
        rememberLastUsedOrg(lastOrgId);
    } catch (ex) {
        rememberLastUsedOrg(currentOrgId);
    }
}

/** Adds a "switch organization" nav item to the sidebar whenever the current
 * session has more than one org available: a superadmin impersonating any org
 * (GET /admin/organizations lists every org that exists) or a regular member
 * of more than one real org (GET /auth/my-organizations lists just theirs).
 * Hidden for the common single-org case - no menu, no nav item at all. */
/** Bottom-of-sidebar "who's logged in" button - opens a popup with
 * organizations to switch to (when there's more than one available),
 * Settings, and Log out. `account` is the already-fetched /auth/me result
 * (avoids a second fetch just for the display name). */
async function initUserMenu(account) {
    const wrap = document.getElementById('sidebarUserMenuWrap');
    const btn = document.getElementById('sidebarUserMenuBtn');
    const menu = document.getElementById('sidebarUserMenu');
    const label = document.getElementById('sidebarUserMenuLabel');
    const orgLabel = document.getElementById('sidebarUserMenuOrgLabel');
    if (!wrap || !btn || !menu || !label) return;

    label.textContent = (account && (account.name || account.email)) || 'Account';

    function closeMenu() {
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = !wrap.classList.contains('open');
        wrap.classList.toggle('open', opening);
        btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        if (opening) {
            // Anchored to grow upward - this button sits at the bottom of the sidebar.
            const rect = btn.getBoundingClientRect();
            menu.style.top = 'auto';
            menu.style.bottom = `${window.innerHeight - rect.bottom}px`;
            menu.style.left = `${rect.right + 8}px`;
        }
    });
    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });

    menu.innerHTML = '';

    const payload = decodeTokenPayload(getAuthToken());
    if (payload) {
        const impersonating = payload.impersonating === true;
        let orgs = [];
        try {
            orgs = impersonating
                ? await apiJson('/admin/organizations')
                : await apiJson('/auth/my-organizations');
        } catch (ex) {
            orgs = [];
        }

        const current = orgs.find((o) => o.id === payload.org_id);
        if (orgLabel) orgLabel.textContent = current ? current.name : '';

        if (impersonating || orgs.length > 1) {
            const sectionLabel = document.createElement('div');
            sectionLabel.className = 'sidebar-user-menu-section-label';
            sectionLabel.textContent = 'Organizations';
            menu.appendChild(sectionLabel);

            async function switchTo(orgId) {
                try {
                    const data = impersonating
                        ? await apiJson(`/admin/organizations/${orgId}/impersonate`, { method: 'POST' })
                        : await apiJson('/auth/switch-org', { method: 'POST', body: { org_id: orgId } });
                    setAuthToken(data.token);
                    rememberLastUsedOrg(orgId);
                    location.reload();
                } catch (ex) {
                    showToast(ex.message || 'Could not switch organization', 'error');
                }
            }

            orgs.forEach((org) => {
                const isCurrent = org.id === payload.org_id;
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'sidebar-user-menu-item' + (isCurrent ? ' sidebar-user-menu-item--selected' : '');
                item.textContent = org.name;
                if (isCurrent) {
                    item.disabled = true;
                    item.setAttribute('aria-current', 'true');
                } else {
                    item.addEventListener('click', () => { closeMenu(); switchTo(org.id); });
                }
                menu.appendChild(item);
            });

            const divider = document.createElement('div');
            divider.className = 'sidebar-user-menu-divider';
            menu.appendChild(divider);
        }
    }

    const settingsItem = document.createElement('button');
    settingsItem.type = 'button';
    settingsItem.className = 'sidebar-user-menu-item';
    settingsItem.textContent = 'Settings';
    settingsItem.addEventListener('click', () => {
        closeMenu();
        switchView('settings');
    });
    menu.appendChild(settingsItem);

    const logoutItem = document.createElement('button');
    logoutItem.type = 'button';
    logoutItem.className = 'sidebar-user-menu-item sidebar-user-menu-item--danger';
    logoutItem.textContent = 'Log out';
    logoutItem.addEventListener('click', () => {
        closeMenu();
        clearAuthToken();
        // Symmetric with tryResumeSession()'s "same login on either page" -
        // logging out here also logs out of the Superadmin Portal.
        try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch (ex) { /* ignore */ }
        location.reload();
    });
    menu.appendChild(logoutItem);
}

