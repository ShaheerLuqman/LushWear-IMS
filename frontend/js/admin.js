// Superadmin Portal - standalone script for admin.html. Deliberately does not
// import app-core.js/data-api.js (business-app-specific logic irrelevant
// here); reuses only utils.js's apiJson/apiErrorMessage/showToast.

const API_BASE = window.API_BASE;

const SUPERADMIN_TOKEN_KEY = 'lushwear_superadmin_token';

function getSuperadminToken() {
    try { return sessionStorage.getItem(SUPERADMIN_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setSuperadminToken(token) {
    try { if (token) sessionStorage.setItem(SUPERADMIN_TOKEN_KEY, token); } catch (e) { /* ignore */ }
}
function clearSuperadminToken() {
    try { sessionStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch (e) { /* ignore */ }
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
let selectedOrg = null;

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

function initModalDismissal() {
    ['adminCreateOrgModal', 'adminIntegrationsModal'].forEach((id) => {
        const modal = document.getElementById(id);
        modal.addEventListener('click', (e) => {
            if (e.target.id === id) closeModal(id);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.getElementById('adminCreateOrgModal').classList.contains('active')) closeModal('adminCreateOrgModal');
        if (document.getElementById('adminIntegrationsModal').classList.contains('active')) closeModal('adminIntegrationsModal');
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
            if (me.role !== 'superadmin') {
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

        const integrationsBtn = document.createElement('button');
        integrationsBtn.type = 'button';
        integrationsBtn.className = 'btn btn-secondary';
        integrationsBtn.textContent = 'Integrations';
        integrationsBtn.addEventListener('click', () => openIntegrationsModal(org));
        controls.appendChild(integrationsBtn);

        const viewAsBtn = document.createElement('button');
        viewAsBtn.type = 'button';
        viewAsBtn.className = 'btn btn-primary';
        viewAsBtn.title = 'Open this organization\'s business app in a new tab';
        viewAsBtn.textContent = 'View as org';
        viewAsBtn.addEventListener('click', () => viewAsOrganization(org, viewAsBtn));
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
        const admin_email = document.getElementById('adminOrgAdminEmail').value.trim();
        const admin_password = document.getElementById('adminOrgAdminPassword').value;
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
            await adminApiJson('/admin/organizations', {
                method: 'POST',
                body: { org_name, admin_email, admin_password },
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

const INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED = 'Configured — leave blank to keep it';
const INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET = 'Not configured';

async function openIntegrationsModal(org) {
    selectedOrg = org;
    document.getElementById('adminIntegrationsOrgName').textContent = org.name;
    document.getElementById('adminIntegrationsError').textContent = '';
    openModal('adminIntegrationsModal');

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

function initIntegrationsModal() {
    const form = document.getElementById('adminIntegrationsForm');
    const errEl = document.getElementById('adminIntegrationsError');

    document.getElementById('adminIntegrationsModalClose').addEventListener('click', () => closeModal('adminIntegrationsModal'));
    document.getElementById('adminIntegrationsCloseBtn').addEventListener('click', () => closeModal('adminIntegrationsModal'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!selectedOrg) return;
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
            const org = selectedOrg;
            await adminApiJson(`/admin/organizations/${org.id}/integration-settings`, { method: 'PUT', body });
            showToast('Integrations saved', 'success');
            await openIntegrationsModal(org);
        } catch (ex) {
            errEl.textContent = ex.message || 'Could not save integrations';
        } finally {
            submitBtn.disabled = false;
        }
    });
}

async function viewAsOrganization(org, triggerBtn) {
    triggerBtn.disabled = true;
    try {
        const data = await adminApiJson(`/admin/organizations/${org.id}/impersonate`, { method: 'POST' });
        window.open(`index.html#impersonate=${encodeURIComponent(data.token)}`, '_blank');
    } catch (ex) {
        showToast(ex.message || 'Could not view as organization', 'error');
    } finally {
        triggerBtn.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    initLoginForm();
    initLogoutButton();
    initCreateOrgModal();
    initIntegrationsModal();
    initModalDismissal();

    if (getSuperadminToken()) {
        try {
            const me = await adminApiJson('/auth/me');
            if (me.role === 'superadmin') {
                showPortal();
                await loadOrganizations();
                return;
            }
        } catch (ex) { /* fall through to login */ }
        clearSuperadminToken();
    }
    showLogin();
});
