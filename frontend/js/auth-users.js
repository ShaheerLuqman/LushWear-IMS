// Settings > Account/Users/Integrations - populated when the Settings view is opened
// (see navigation.js's switchView 'settings' branch). Users/Integrations are admin-only;
// staff only ever see the Account section.

let currentAccount = null;

function renderUsersList(users) {
    const list = document.getElementById('settingsUsersList');
    if (!list) return;
    list.innerHTML = '';
    users.forEach((user) => {
        const row = document.createElement('div');
        row.className = 'settings-user-row' + (user.is_active ? '' : ' settings-user-row--inactive');

        const email = document.createElement('span');
        email.className = 'settings-user-row__email';
        email.textContent = user.email;
        row.appendChild(email);

        const controls = document.createElement('div');
        controls.className = 'settings-user-row__controls';

        const roleSelect = document.createElement('select');
        roleSelect.className = 'settings-user-row__role-select';
        ['staff', 'admin'].forEach((role) => {
            const opt = document.createElement('option');
            opt.value = role;
            opt.textContent = role === 'admin' ? 'Admin' : 'Staff';
            opt.selected = user.role === role;
            roleSelect.appendChild(opt);
        });
        roleSelect.addEventListener('change', async () => {
            const previous = user.role;
            try {
                await apiJson(`/users/${user.id}`, { method: 'PUT', body: { role: roleSelect.value } });
                user.role = roleSelect.value;
                showToast('Role updated', 'success');
            } catch (ex) {
                roleSelect.value = previous;
                showToast(ex.message || 'Could not update role', 'error');
            }
        });
        controls.appendChild(roleSelect);

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn btn-secondary';
        toggleBtn.textContent = user.is_active ? 'Deactivate' : 'Activate';
        toggleBtn.addEventListener('click', async () => {
            const nextActive = !user.is_active;
            toggleBtn.disabled = true;
            try {
                await apiJson(`/users/${user.id}`, { method: 'PUT', body: { is_active: nextActive } });
                user.is_active = nextActive;
                await loadUsersSection();
                showToast(nextActive ? 'User activated' : 'User deactivated', 'success');
            } catch (ex) {
                showToast(ex.message || 'Could not update user', 'error');
            } finally {
                toggleBtn.disabled = false;
            }
        });
        controls.appendChild(toggleBtn);

        row.appendChild(controls);
        list.appendChild(row);
    });
}

async function loadUsersSection() {
    try {
        const users = await apiJson('/users/', { fallback: 'Failed to load users' });
        renderUsersList(users);
    } catch (ex) {
        showToast(ex.message || 'Failed to load users', 'error');
    }
}

function initAddUserForm() {
    const form = document.getElementById('settingsAddUserForm');
    const errEl = document.getElementById('settingsAddUserError');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errEl) errEl.textContent = '';
        const email = document.getElementById('settingsAddUserEmail').value.trim();
        const password = document.getElementById('settingsAddUserPassword').value;
        const role = document.getElementById('settingsAddUserRole').value;
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        try {
            await apiJson('/users/', { method: 'POST', body: { email, password, role } });
            form.reset();
            showToast('User added', 'success');
            await loadUsersSection();
        } catch (ex) {
            if (errEl) errEl.textContent = ex.message || 'Could not add user';
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

/** Shown as a placeholder so a blank field means "leave unchanged", not "clear it". */
const INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED = 'Configured — leave blank to keep it';
const INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET = 'Not configured';

async function loadIntegrationsSection() {
    try {
        const settings = await apiJson('/org-settings/', { fallback: 'Failed to load integrations' });
        const storeUrlEl = document.getElementById('settingsShopifyStoreUrl');
        const apiVersionEl = document.getElementById('settingsShopifyApiVersion');
        const tokenEl = document.getElementById('settingsShopifyAccessToken');
        const tokenStatusEl = document.getElementById('settingsShopifyTokenStatus');
        const postexEl = document.getElementById('settingsPostexToken');
        const postexStatusEl = document.getElementById('settingsPostexTokenStatus');
        if (storeUrlEl) storeUrlEl.value = settings.shopify_store_url || '';
        if (apiVersionEl) apiVersionEl.value = settings.shopify_api_version || '';
        if (tokenEl) tokenEl.placeholder = settings.shopify_access_token_configured
            ? INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED : INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET;
        if (tokenStatusEl) tokenStatusEl.textContent = settings.shopify_access_token_configured ? 'Configured' : 'Not configured';
        if (postexEl) postexEl.placeholder = settings.postex_merchant_token_configured
            ? INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED : INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET;
        if (postexStatusEl) postexStatusEl.textContent = settings.postex_merchant_token_configured ? 'Configured' : 'Not configured';
    } catch (ex) {
        showToast(ex.message || 'Failed to load integrations', 'error');
    }
}

function initIntegrationsForm() {
    const form = document.getElementById('settingsIntegrationsForm');
    const errEl = document.getElementById('settingsIntegrationsError');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errEl) errEl.textContent = '';
        const storeUrl = document.getElementById('settingsShopifyStoreUrl').value.trim();
        const apiVersion = document.getElementById('settingsShopifyApiVersion').value.trim();
        const token = document.getElementById('settingsShopifyAccessToken').value;
        const postexToken = document.getElementById('settingsPostexToken').value;
        const body = {
            shopify_store_url: storeUrl || null,
            shopify_api_version: apiVersion || null,
        };
        // Blank means "leave unchanged" - only send a token field the admin actually typed.
        if (token) body.shopify_access_token = token;
        if (postexToken) body.postex_merchant_token = postexToken;

        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        try {
            await apiJson('/org-settings/', { method: 'PUT', body });
            document.getElementById('settingsShopifyAccessToken').value = '';
            document.getElementById('settingsPostexToken').value = '';
            showToast('Integrations saved', 'success');
            await loadIntegrationsSection();
        } catch (ex) {
            if (errEl) errEl.textContent = ex.message || 'Could not save integrations';
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

/** Populates the Settings > Account row, and (admin only) the Users/Integrations sections. */
async function loadAccountSettings() {
    initAddUserForm();
    initIntegrationsForm();

    const emailEl = document.getElementById('settingsAccountEmail');
    const roleEl = document.getElementById('settingsAccountRole');
    const usersSection = document.getElementById('settingsUsersSection');
    const integrationsSection = document.getElementById('settingsIntegrationsSection');

    try {
        currentAccount = await apiJson('/auth/me', { fallback: 'Failed to load account' });
    } catch (ex) {
        currentAccount = null;
    }

    if (emailEl) emailEl.textContent = currentAccount ? currentAccount.email : '—';
    if (roleEl) roleEl.textContent = currentAccount ? (currentAccount.role === 'admin' ? 'Admin' : 'Staff') : '';

    const isAdmin = !!currentAccount && currentAccount.role === 'admin';
    if (usersSection) usersSection.style.display = isAdmin ? '' : 'none';
    if (integrationsSection) integrationsSection.style.display = isAdmin ? '' : 'none';

    if (isAdmin) {
        await Promise.all([loadUsersSection(), loadIntegrationsSection()]);
    }
}
