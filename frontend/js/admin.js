// Superadmin Portal - standalone script for admin.html. Deliberately does not
// import app-core.js/data-api.js (business-app-specific logic irrelevant
// here); reuses only utils.js's apiJson/apiErrorMessage/showToast.

const API_BASE = window.API_BASE;

// Same key/values as the main app (frontend/js/app-core.js's initSettingsView) -
// an inline script in <head> already applies whatever's stored here before
// first paint, so this only needs to sync the toggle buttons and handle clicks.
const THEME_STORAGE_KEY = 'lushwear-theme';

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.settings-theme-btn').forEach((btn) => {
        const selected = btn.dataset.themeChoice === theme;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
}

function initThemeToggle() {
    applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'light');
    document.querySelectorAll('.settings-theme-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const theme = btn.dataset.themeChoice;
            localStorage.setItem(THEME_STORAGE_KEY, theme);
            applyTheme(theme);
        });
    });
}

// localStorage (not sessionStorage) so this survives a new tab or the browser
// restarting - and since index.html shares this origin, its own boot check
// (js/app-core.js's tryResumeSession) reads this same key, so logging in here
// counts as being logged in there too.
const SUPERADMIN_TOKEN_KEY = 'lushwear_superadmin_token';

function getSuperadminToken() {
    try { return localStorage.getItem(SUPERADMIN_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setSuperadminToken(token) {
    try { if (token) localStorage.setItem(SUPERADMIN_TOKEN_KEY, token); } catch (e) { /* ignore */ }
}
function clearSuperadminToken() {
    try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch (e) { /* ignore */ }
}

/** Shared with app-core.js's resolveSuperadminHomeOrgToken()/initUserMenu()
 * - localStorage (not sessionStorage) so it persists across tabs/visits,
 * letting a superadmin who logs in directly on the main app's own gate
 * (instead of via "View as org" here) resume wherever they last were. */
const LAST_USED_ORG_KEY = 'lushwear_last_used_org';

function rememberLastUsedOrg(orgId) {
    try { localStorage.setItem(LAST_USED_ORG_KEY, orgId); } catch (e) { /* ignore */ }
}

/** apiJson (utils.js), with the superadmin's own Bearer token attached. */
function adminApiJson(path, options = {}) {
    const token = getSuperadminToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return apiJson(path, { ...options, headers });
}

function formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

let organizations = [];
/** The org shown on the detail page (js/admin.js's showOrgDetail/showOrgList) -
 * shared by the Users/Features/Integrations sections there, since they all
 * act on whichever org is currently open. */
let currentDetailOrg = null;

function showLogin() {
    document.getElementById('adminGateRoot').hidden = false;
    document.getElementById('adminPortalRoot').hidden = true;
}

function showPortal() {
    document.getElementById('adminGateRoot').hidden = true;
    document.getElementById('adminPortalRoot').hidden = false;
}

function openModal(id) {
    document.getElementById(id).classList.add('active');
}
function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

const MODAL_IDS = ['adminCreateOrgModal'];

function initModalDismissal() {
    MODAL_IDS.forEach((id) => {
        const modal = document.getElementById(id);
        modal.addEventListener('click', (e) => {
            if (e.target.id === id) closeModal(id);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        MODAL_IDS.forEach((id) => {
            if (document.getElementById(id).classList.contains('active')) closeModal(id);
        });
    });
}

function initLoginForm() {
    const form = document.getElementById('adminGateForm');
    const errEl = document.getElementById('adminGateError');
    const submitBtn = document.getElementById('adminGateSubmit');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const email = document.getElementById('adminGateEmail').value.trim();
        const password = document.getElementById('adminGatePassword').value;
        submitBtn.disabled = true;
        const submitLabel = submitBtn.textContent;
        submitBtn.innerHTML = '<span class="btn-spinner"></span>Logging in…';
        try {
            const data = await apiJson('/auth/login', { method: 'POST', body: { email, password } });
            setSuperadminToken(data.token);
            const me = await adminApiJson('/auth/me');
            if (me.is_superadmin !== true) {
                clearSuperadminToken();
                throw new Error('This account does not have platform admin access.');
            }
            showPortal();
            await loadOrganizations();
        } catch (ex) {
            errEl.textContent = ex.message || 'Login failed';
        } finally {
            submitBtn.textContent = submitLabel;
            submitBtn.disabled = false;
        }
    });
}

function initLogoutButton() {
    document.getElementById('adminLogoutBtn').addEventListener('click', () => {
        clearSuperadminToken();
        document.getElementById('adminGateForm').reset();
        showLogin();
    });
}

function renderOrganizations() {
    const list = document.getElementById('adminOrgsList');
    const loadingEl = document.getElementById('adminOrgsLoading');
    const emptyEl = document.getElementById('adminOrgsEmpty');
    loadingEl.style.display = 'none';
    list.innerHTML = '';

    if (organizations.length === 0) {
        emptyEl.style.display = '';
        return;
    }
    emptyEl.style.display = 'none';

    organizations.forEach((org) => {
        const card = document.createElement('div');
        card.className = 'admin-org-card';
        card.title = 'Open organization details';
        card.addEventListener('click', () => showOrgDetail(org));

        const info = document.createElement('div');
        info.className = 'admin-org-card__info';
        const name = document.createElement('span');
        name.className = 'admin-org-card__name';
        name.textContent = org.name;
        info.appendChild(name);
        const meta = document.createElement('span');
        meta.className = 'admin-org-card__meta';
        meta.textContent = org.created_at ? `Created ${formatDate(org.created_at)}` : '';
        info.appendChild(meta);
        card.appendChild(info);

        const controls = document.createElement('div');
        controls.className = 'admin-org-card__actions';

        const viewAsBtn = document.createElement('button');
        viewAsBtn.type = 'button';
        viewAsBtn.className = 'btn btn-primary';
        viewAsBtn.title = 'Open this organization\'s business app in a new tab';
        viewAsBtn.textContent = 'View as org';
        viewAsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // don't also trigger the card's own "open details" click
            viewAsOrganization(org, viewAsBtn);
        });
        controls.appendChild(viewAsBtn);

        card.appendChild(controls);
        list.appendChild(card);
    });
}

async function loadOrganizations() {
    const loadingEl = document.getElementById('adminOrgsLoading');
    loadingEl.style.display = '';
    loadingEl.textContent = 'Loading organizations…';
    try {
        organizations = await adminApiJson('/admin/organizations');
        renderOrganizations();
    } catch (ex) {
        loadingEl.textContent = ex.message || 'Failed to load organizations';
        showToast(ex.message || 'Failed to load organizations', 'error');
    }
}

function initCreateOrgModal() {
    const form = document.getElementById('adminCreateOrgForm');
    const errEl = document.getElementById('adminCreateOrgError');

    document.getElementById('adminOpenCreateOrgBtn').addEventListener('click', () => {
        errEl.textContent = '';
        form.reset();
        openModal('adminCreateOrgModal');
        document.getElementById('adminOrgName').focus();
    });
    document.getElementById('adminCreateOrgModalClose').addEventListener('click', () => closeModal('adminCreateOrgModal'));
    document.getElementById('adminCreateOrgCancelBtn').addEventListener('click', () => closeModal('adminCreateOrgModal'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const org_name = document.getElementById('adminOrgName').value.trim();
        const admin_name = document.getElementById('adminOrgAdminName').value.trim();
        const admin_email = document.getElementById('adminOrgAdminEmail').value.trim();
        const admin_password = document.getElementById('adminOrgAdminPassword').value;
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
            await adminApiJson('/admin/organizations', {
                method: 'POST',
                body: { org_name, admin_name, admin_email, admin_password },
            });
            closeModal('adminCreateOrgModal');
            showToast(`${org_name} created`, 'success');
            await loadOrganizations();
        } catch (ex) {
            errEl.textContent = ex.message || 'Could not create organization';
        } finally {
            submitBtn.disabled = false;
        }
    });
}

// ---- Org detail page: Users/Features/Integrations for one org, all in one
// place instead of separate popups (each acts on currentDetailOrg). ----

function showOrgList() {
    document.getElementById('adminOrgListSection').hidden = false;
    document.getElementById('adminOrgDetailView').hidden = true;
    currentDetailOrg = null;
}

function showOrgDetail(org) {
    currentDetailOrg = org;
    document.getElementById('adminOrgListSection').hidden = true;
    document.getElementById('adminOrgDetailView').hidden = false;
    document.getElementById('adminOrgDetailName').textContent = org.name;
    loadOrgUsers(org);
    loadOrgFeatures(org);
    loadOrgIntegrations(org);
}

async function loadOrgUsers(org) {
    const list = document.getElementById('adminUsersList');
    const loadingEl = document.getElementById('adminUsersLoading');
    const emptyEl = document.getElementById('adminUsersEmpty');
    list.innerHTML = '';
    emptyEl.style.display = 'none';
    loadingEl.style.display = '';
    loadingEl.textContent = 'Loading users…';

    try {
        const users = await adminApiJson(`/admin/organizations/${org.id}/users`);
        loadingEl.style.display = 'none';
        if (!users.length) {
            emptyEl.style.display = '';
            return;
        }
        users.forEach((user) => {
            const row = document.createElement('div');
            row.className = 'settings-user-row' + (user.is_active ? '' : ' settings-user-row--inactive');

            const email = document.createElement('span');
            email.className = 'settings-user-row__email';
            email.textContent = user.name ? `${user.name} (${user.email})` : user.email;
            row.appendChild(email);

            const role = document.createElement('span');
            role.className = 'settings-user-row__controls';
            role.textContent = user.role === 'admin' ? 'Admin' : 'Staff';
            row.appendChild(role);

            list.appendChild(row);
        });
    } catch (ex) {
        loadingEl.style.display = 'none';
        showToast(ex.message || 'Failed to load users', 'error');
    }
}

function initFeaturesForm() {
    document.getElementById('adminFeaturesForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentDetailOrg) return;
        const errEl = document.getElementById('adminFeaturesError');
        errEl.textContent = '';
        const enabled_features = [];
        if (document.getElementById('adminFeatureOrders').checked) enabled_features.push('orders');
        if (document.getElementById('adminFeatureFinance').checked) enabled_features.push('finance');

        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
            await adminApiJson(`/admin/organizations/${currentDetailOrg.id}/features`, {
                method: 'PUT',
                body: { enabled_features },
            });
            showToast('Features saved', 'success');
        } catch (ex) {
            errEl.textContent = ex.message || 'Could not save features';
        } finally {
            submitBtn.disabled = false;
        }
    });
}

async function loadOrgFeatures(org) {
    document.getElementById('adminFeaturesError').textContent = '';
    try {
        const data = await adminApiJson(`/admin/organizations/${org.id}/features`);
        const enabled = new Set(data.enabled_features || []);
        document.getElementById('adminFeatureOrders').checked = enabled.has('orders');
        document.getElementById('adminFeatureFinance').checked = enabled.has('finance');
    } catch (ex) {
        showToast(ex.message || 'Failed to load features', 'error');
    }
}

const INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED = 'Configured — leave blank to keep it';
const INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET = 'Not configured';

async function loadOrgIntegrations(org) {
    document.getElementById('adminIntegrationsError').textContent = '';

    const storeUrlEl = document.getElementById('adminShopifyStoreUrl');
    const apiVersionEl = document.getElementById('adminShopifyApiVersion');
    const tokenEl = document.getElementById('adminShopifyAccessToken');
    const postexEl = document.getElementById('adminPostexToken');
    storeUrlEl.value = '';
    apiVersionEl.value = '';
    tokenEl.value = '';
    postexEl.value = '';
    tokenEl.placeholder = 'Loading…';
    postexEl.placeholder = 'Loading…';

    try {
        const settings = await adminApiJson(`/admin/organizations/${org.id}/integration-settings`);
        storeUrlEl.value = settings.shopify_store_url || '';
        apiVersionEl.value = settings.shopify_api_version || '';
        tokenEl.placeholder = settings.shopify_access_token_configured
            ? INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED : INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET;
        document.getElementById('adminShopifyTokenStatus').textContent =
            settings.shopify_access_token_configured ? 'Configured' : 'Not configured';
        postexEl.placeholder = settings.postex_merchant_token_configured
            ? INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED : INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET;
        document.getElementById('adminPostexTokenStatus').textContent =
            settings.postex_merchant_token_configured ? 'Configured' : 'Not configured';
    } catch (ex) {
        showToast(ex.message || 'Failed to load integrations', 'error');
    }
}

function initIntegrationsForm() {
    const form = document.getElementById('adminIntegrationsForm');
    const errEl = document.getElementById('adminIntegrationsError');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentDetailOrg) return;
        errEl.textContent = '';
        const storeUrl = document.getElementById('adminShopifyStoreUrl').value.trim();
        const apiVersion = document.getElementById('adminShopifyApiVersion').value.trim();
        const token = document.getElementById('adminShopifyAccessToken').value;
        const postexToken = document.getElementById('adminPostexToken').value;
        const body = {
            shopify_store_url: storeUrl || null,
            shopify_api_version: apiVersion || null,
        };
        if (token) body.shopify_access_token = token;
        if (postexToken) body.postex_merchant_token = postexToken;

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
            const org = currentDetailOrg;
            await adminApiJson(`/admin/organizations/${org.id}/integration-settings`, { method: 'PUT', body });
            showToast('Integrations saved', 'success');
            await loadOrgIntegrations(org);
        } catch (ex) {
            errEl.textContent = ex.message || 'Could not save integrations';
        } finally {
            submitBtn.disabled = false;
        }
    });
}

function initOrgDetailView() {
    document.getElementById('adminOrgDetailBackBtn').addEventListener('click', showOrgList);
    document.getElementById('adminOrgDetailViewAsBtn').addEventListener('click', (e) => {
        if (currentDetailOrg) viewAsOrganization(currentDetailOrg, e.currentTarget);
    });
    initFeaturesForm();
    initIntegrationsForm();
}

async function viewAsOrganization(org, triggerBtn) {
    triggerBtn.disabled = true;
    try {
        const data = await adminApiJson(`/admin/organizations/${org.id}/impersonate`, { method: 'POST' });
        rememberLastUsedOrg(org.id);
        window.open(`index.html#impersonate=${encodeURIComponent(data.token)}`, '_blank');
    } catch (ex) {
        showToast(ex.message || 'Could not view as organization', 'error');
    } finally {
        triggerBtn.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    initThemeToggle();
    initLoginForm();
    initLogoutButton();
    initCreateOrgModal();
    initOrgDetailView();
    initModalDismissal();

    if (getSuperadminToken()) {
        try {
            const me = await adminApiJson('/auth/me');
            if (me.is_superadmin === true) {
                showPortal();
                await loadOrganizations();
                return;
            }
        } catch (ex) { /* fall through to login */ }
        clearSuperadminToken();
    }
    showLogin();
});
