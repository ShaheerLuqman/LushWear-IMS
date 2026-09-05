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
        email.textContent = user.name ? `${user.name} (${user.email})` : user.email;
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
        const name = document.getElementById('settingsAddUserName').value.trim();
        const email = document.getElementById('settingsAddUserEmail').value.trim();
        const password = document.getElementById('settingsAddUserPassword').value;
        const role = document.getElementById('settingsAddUserRole').value;
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        // Blank means "this email already has an account elsewhere" - just
        // grants a membership here, no new name/password needed (Multi-Org
        // User Membership plan). Omit the fields rather than send blanks.
        const body = { email, role };
        if (name) body.name = name;
        if (password) body.password = password;
        try {
            await apiJson('/users/', { method: 'POST', body });
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
        const couriersNextEl = document.getElementById('settingsCouriersNextAuthKey');
        const couriersNextStatusEl = document.getElementById('settingsCouriersNextAuthKeyStatus');
        if (storeUrlEl) storeUrlEl.value = settings.shopify_store_url || '';
        if (apiVersionEl) apiVersionEl.value = settings.shopify_api_version || '';
        if (tokenEl) tokenEl.placeholder = settings.shopify_access_token_configured
            ? INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED : INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET;
        if (tokenStatusEl) tokenStatusEl.textContent = settings.shopify_access_token_configured ? 'Configured' : 'Not configured';
        if (postexEl) postexEl.placeholder = settings.postex_merchant_token_configured
            ? INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED : INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET;
        if (postexStatusEl) postexStatusEl.textContent = settings.postex_merchant_token_configured ? 'Configured' : 'Not configured';
        if (couriersNextEl) couriersNextEl.placeholder = settings.couriers_next_auth_key_configured
            ? INTEGRATIONS_TOKEN_PLACEHOLDER_CONFIGURED : INTEGRATIONS_TOKEN_PLACEHOLDER_UNSET;
        if (couriersNextStatusEl) couriersNextStatusEl.textContent = settings.couriers_next_auth_key_configured ? 'Configured' : 'Not configured';
        return settings;
    } catch (ex) {
        showToast(ex.message || 'Failed to load integrations', 'error');
        return null;
    }
}

function initShopifyConnectButton() {
    const btn = document.getElementById('settingsShopifyConnectBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';

    btn.addEventListener('click', async () => {
        const statusEl = document.getElementById('settingsShopifyConnectStatus');
        const shop = document.getElementById('settingsShopifyStoreUrl').value.trim();
        if (!shop) {
            if (statusEl) statusEl.textContent = 'Enter your store URL first (your-store.myshopify.com)';
            return;
        }
        if (statusEl) statusEl.textContent = '';
        btn.disabled = true;
        try {
            const { url } = await apiJson(`/org-settings/shopify/install?shop=${encodeURIComponent(shop)}`);
            const popup = window.open(url, 'shopify-connect', 'width=500,height=720');
            if (!popup) {
                if (statusEl) statusEl.textContent = 'Popup blocked - allow popups for this site and try again';
                btn.disabled = false;
                return;
            }
            // The popup's final page is served by the backend (cross-origin), and some
            // browsers null out window.opener once the popup has navigated through
            // Shopify's own pages - so it can't reliably postMessage its result back.
            // Instead, wait for the popup to close (the callback closes it itself once
            // done) and just re-fetch to see whether it actually got configured.
            const closedCheck = setInterval(async () => {
                if (!popup.closed) return;
                clearInterval(closedCheck);
                const settings = await loadIntegrationsSection();
                btn.disabled = false;
                if (settings && settings.shopify_access_token_configured) {
                    if (statusEl) statusEl.textContent = '';
                    showToast('Shopify connected', 'success');
                } else if (statusEl) {
                    statusEl.textContent = 'Connection window closed before finishing';
                }
            }, 500);
        } catch (ex) {
            if (statusEl) statusEl.textContent = ex.message || 'Could not start Shopify connect';
            btn.disabled = false;
        }
    });
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
        const couriersNextAuthKey = document.getElementById('settingsCouriersNextAuthKey').value;
        const body = {
            shopify_store_url: storeUrl || null,
            shopify_api_version: apiVersion || null,
        };
        // Blank means "leave unchanged" - only send a token field the admin actually typed.
        if (token) body.shopify_access_token = token;
        if (postexToken) body.postex_merchant_token = postexToken;
        if (couriersNextAuthKey) body.couriers_next_auth_key = couriersNextAuthKey;

        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        try {
            await apiJson('/org-settings/', { method: 'PUT', body });
            document.getElementById('settingsShopifyAccessToken').value = '';
            document.getElementById('settingsPostexToken').value = '';
            document.getElementById('settingsCouriersNextAuthKey').value = '';
            showToast('Integrations saved', 'success');
            await loadIntegrationsSection();
        } catch (ex) {
            if (errEl) errEl.textContent = ex.message || 'Could not save integrations';
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

const FISCAL_MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/** "1st"/"2nd"/"3rd"/"4th"... (11th-13th stay "th"). */
function ordinal(n) {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

/** Live preview of what the two Financial calendar fields mean, updated as the
 * admin edits them (before saving) - e.g. "January – December" / "22nd – 21st
 * of the next month". */
function updateFiscalPreview() {
    const dayEl = document.getElementById('settingsFiscalMonthStartDay');
    const monthEl = document.getElementById('settingsFiscalYearStartMonth');
    const yearPreviewEl = document.getElementById('settingsFiscalYearPreview');
    const monthPreviewEl = document.getElementById('settingsFiscalMonthPreview');
    if (!dayEl || !monthEl || !yearPreviewEl || !monthPreviewEl) return;

    const startMonth = parseInt(monthEl.value, 10);
    if (startMonth >= 1 && startMonth <= 12) {
        const endMonth = startMonth === 1 ? 12 : startMonth - 1;
        yearPreviewEl.textContent = `${FISCAL_MONTH_NAMES[startMonth - 1]} – ${FISCAL_MONTH_NAMES[endMonth - 1]}`;
    } else {
        yearPreviewEl.textContent = '—';
    }

    const startDay = parseInt(dayEl.value, 10);
    if (startDay >= 1 && startDay <= 28) {
        // A start day of 1 is a plain calendar month - "last day of the month" rather
        // than a literal "0th", same start_day=1 special case as data-api.js's
        // ordersPeriodStartEnd/backend's _period_start_end_dates.
        monthPreviewEl.textContent = startDay === 1
            ? `${ordinal(1)} – last day of the month`
            : `${ordinal(startDay)} – ${ordinal(startDay - 1)} of the next month`;
    } else {
        monthPreviewEl.textContent = '—';
    }
}

async function loadFiscalSection() {
    try {
        const settings = await apiJson('/org-settings/fiscal', { fallback: 'Failed to load financial calendar' });
        const dayEl = document.getElementById('settingsFiscalMonthStartDay');
        const monthEl = document.getElementById('settingsFiscalYearStartMonth');
        if (dayEl) dayEl.value = settings.fiscal_month_start_day;
        if (monthEl) monthEl.value = String(settings.fiscal_year_start_month);
        updateFiscalPreview();
        return settings;
    } catch (ex) {
        showToast(ex.message || 'Failed to load financial calendar', 'error');
        return null;
    }
}

function initFiscalForm() {
    const form = document.getElementById('settingsFiscalForm');
    const errEl = document.getElementById('settingsFiscalError');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';

    document.getElementById('settingsFiscalMonthStartDay').addEventListener('input', updateFiscalPreview);
    document.getElementById('settingsFiscalYearStartMonth').addEventListener('change', updateFiscalPreview);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errEl) errEl.textContent = '';
        const body = {
            fiscal_month_start_day: parseInt(document.getElementById('settingsFiscalMonthStartDay').value, 10),
            fiscal_year_start_month: parseInt(document.getElementById('settingsFiscalYearStartMonth').value, 10),
        };
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        try {
            await apiJson('/org-settings/fiscal', { method: 'PUT', body });
            showToast('Financial calendar saved - reloading…', 'success');
            // Period boundaries are computed client-side too (data-api.js) from the
            // value cached at boot - simplest way to keep everything consistent is
            // to reload rather than patch every period-dependent view in place.
            location.reload();
        } catch (ex) {
            if (errEl) errEl.textContent = ex.message || 'Could not save financial calendar';
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

/** Populates the Settings > Account row, and (admin only) the Users/Integrations/Financial sections. */
async function loadAccountSettings() {
    initAddUserForm();
    initIntegrationsForm();
    initShopifyConnectButton();
    initFiscalForm();

    const nameEl = document.getElementById('settingsAccountName');
    const emailEl = document.getElementById('settingsAccountEmail');
    const roleEl = document.getElementById('settingsAccountRole');
    const usersSection = document.getElementById('settingsUsersSection');
    const integrationsSection = document.getElementById('settingsIntegrationsSection');
    const fiscalSection = document.getElementById('settingsFiscalSection');

    try {
        currentAccount = await apiJson('/auth/me', { fallback: 'Failed to load account' });
    } catch (ex) {
        currentAccount = null;
    }

    if (nameEl) nameEl.textContent = currentAccount ? (currentAccount.name || currentAccount.email) : '—';
    if (emailEl) emailEl.textContent = currentAccount && currentAccount.name ? currentAccount.email : '';
    if (roleEl) roleEl.textContent = currentAccount ? (currentAccount.role === 'admin' ? 'Admin' : 'Staff') : '';

    const isAdmin = !!currentAccount && currentAccount.role === 'admin';
    if (usersSection) usersSection.style.display = isAdmin ? '' : 'none';
    if (integrationsSection) integrationsSection.style.display = isAdmin ? '' : 'none';
    if (fiscalSection) fiscalSection.style.display = isAdmin ? '' : 'none';

    if (isAdmin) {
        await Promise.all([loadUsersSection(), loadIntegrationsSection(), loadFiscalSection()]);
    }
}
