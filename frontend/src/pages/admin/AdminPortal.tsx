// Superadmin Portal - org list, org detail (users/features/integrations), create
// org. React port of admin.html/admin.js. Deliberately does NOT use useAuth() - a
// pure superadmin's session there auto-resolves into a home org (see
// resolveSuperadminHomeOrgToken in AuthContext.tsx) and would never show this UI, so
// this keeps its own separate token, same as the original standalone page did.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { apiJson, type ApiJsonOptions } from '../../api';
import { useToast } from '../../toast/ToastContext';

const SUPERADMIN_TOKEN_KEY = 'lushwear_superadmin_token';
const LAST_USED_ORG_KEY = 'lushwear_last_used_org';

function getSuperadminToken(): string {
  try { return localStorage.getItem(SUPERADMIN_TOKEN_KEY) || ''; } catch { return ''; }
}
function setSuperadminToken(token: string): void {
  try { if (token) localStorage.setItem(SUPERADMIN_TOKEN_KEY, token); } catch { /* ignore */ }
}
function clearSuperadminToken(): void {
  try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch { /* ignore */ }
}
function rememberLastUsedOrg(orgId: string): void {
  try { localStorage.setItem(LAST_USED_ORG_KEY, orgId); } catch { /* ignore */ }
}

function adminApiJson<T = any>(path: string, options: ApiJsonOptions = {}): Promise<T> {
  const token = getSuperadminToken();
  return apiJson<T>(path, {
    ...options,
    headers: { ...(options.headers as Record<string, string> | undefined), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
}

interface AdminOrg { id: string; name: string; created_at?: string }
interface AdminOrgUser { id: string; name?: string; email: string; role: 'admin' | 'staff'; is_active: boolean }

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function viewAsOrganization(org: AdminOrg, showToast: ReturnType<typeof useToast>['showToast']): Promise<void> {
  try {
    const data = await adminApiJson<{ token: string }>(`/admin/organizations/${org.id}/impersonate`, { method: 'POST' });
    rememberLastUsedOrg(org.id);
    // Hash (not a query param) so the token never hits a server access log - consumed
    // by AuthContext's consumeImpersonationToken() regardless of which route it lands on.
    window.open(`/#impersonate=${encodeURIComponent(data.token)}`, '_blank');
  } catch (ex: any) {
    showToast(ex?.message || 'Could not view as organization', 'error');
  }
}

function AdminGate({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const data = await apiJson<{ token: string }>('/auth/login', { method: 'POST', body: { email, password } });
      setSuperadminToken(data.token);
      const me = await adminApiJson<{ is_superadmin: boolean }>('/auth/me');
      if (me.is_superadmin !== true) {
        clearSuperadminToken();
        throw new Error('This account does not have platform admin access.');
      }
      onLoggedIn();
    } catch (ex: any) {
      setError(ex?.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-gate-root">
      <div className="auth-gate-card">
        <img src="/assets/Logo_Large.png" alt="" className="auth-gate-logo" />
        <h2 className="auth-gate-title">Super Admin login</h2>
        <form className="auth-gate-form" autoComplete="off" onSubmit={handleSubmit}>
          <label className="auth-gate-label" htmlFor="adminGateEmail">Email</label>
          <input type="email" id="adminGateEmail" className="auth-gate-input" required autoComplete="username" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <label className="auth-gate-label" htmlFor="adminGatePassword">Password</label>
          <input type="password" id="adminGatePassword" className="auth-gate-input" required autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="auth-gate-error" role="alert">{error}</p>
          <button type="submit" className="btn btn-primary auth-gate-submit" disabled={submitting}>
            {submitting ? <><span className="btn-spinner"></span>Logging in…</> : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  );
}

function AdminHeader({ onLogout }: { onLogout: () => void }) {
  return (
    <header className="admin-portal-header">
      <div className="admin-portal-header__brand">
        <img src="/assets/Logo.png" alt="" className="admin-portal-header__logo" />
        <div><h1>Super Admin Portal</h1></div>
      </div>
      <div className="admin-portal-header__actions">
        <button type="button" className="btn btn-secondary" onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}

function CreateOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { showToast } = useToast();
  const [orgName, setOrgName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError('');
    setSaving(true);
    try {
      await adminApiJson('/admin/organizations', {
        method: 'POST',
        body: { org_name: orgName, admin_name: adminName, admin_email: adminEmail, admin_password: adminPassword },
      });
      showToast(`${orgName} created`, 'success');
      onCreated();
    } catch (ex: any) {
      setError(ex?.message || 'Could not create organization');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Create organization</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <p className="modal-description">Creates the organization and its first admin user in one step. That admin logs in themselves afterwards with the credentials you set here.</p>
            <div className="form-group">
              <label htmlFor="adminOrgName">Organization name</label>
              <input type="text" id="adminOrgName" className="form-input" required placeholder="e.g. Acme Co" value={orgName} onChange={(e) => setOrgName(e.target.value)} autoFocus />
            </div>
            <div className="form-group">
              <label htmlFor="adminOrgAdminName">First admin name</label>
              <input type="text" id="adminOrgAdminName" className="form-input" required placeholder="e.g. Jane Doe" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="adminOrgAdminEmail">First admin email</label>
              <input type="email" id="adminOrgAdminEmail" className="form-input" required placeholder="owner@acme.com" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="adminOrgAdminPassword">First admin password</label>
              <input type="password" id="adminOrgAdminPassword" className="form-input" required minLength={8} placeholder="At least 8 characters" autoComplete="new-password" data-lpignore="true" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
            </div>
            {error && <p className="auth-gate-error" role="alert">{error}</p>}
          </form>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? 'Creating...' : 'Create organization'}</button>
        </div>
      </div>
    </div>
  );
}

function AdminOrgListPage({ orgs, loading, reload }: { orgs: AdminOrg[]; loading: boolean; reload: () => void }) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <section className="admin-portal-section">
      <div className="admin-portal-section__header">
        <h2 className="settings-section__title">Organizations</h2>
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create organization</button>
      </div>
      {loading && <p className="admin-portal-empty"><span className="btn-loading-spinner"></span>Loading organizations…</p>}
      {!loading && orgs.length === 0 && (
        <p className="admin-portal-empty">No organizations yet — create the first one above.</p>
      )}
      {!loading && orgs.length > 0 && (
        <div className="admin-org-list">
          {orgs.map((org) => (
            <div key={org.id} className="admin-org-card" title="Open organization details" onClick={() => navigate(`/admin/organizations/${org.id}`)}>
              <div className="admin-org-card__info">
                <span className="admin-org-card__name">{org.name}</span>
                <span className="admin-org-card__meta">{org.created_at ? `Created ${formatDate(org.created_at)}` : ''}</span>
              </div>
              <div className="admin-org-card__actions">
                <button
                  type="button" className="btn btn-primary" title="Open this organization's business app in a new tab"
                  onClick={(e) => { e.stopPropagation(); viewAsOrganization(org, showToast); }}
                >
                  View as org
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showCreate && <CreateOrgModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />}
    </section>
  );
}

const TOKEN_PLACEHOLDER_CONFIGURED = 'Configured — leave blank to keep it';
const TOKEN_PLACEHOLDER_UNSET = 'Not configured';

function AdminOrgDetailPage({ orgs }: { orgs: AdminOrg[] }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const org = orgs.find((o) => o.id === id) || null;

  const [users, setUsers] = useState<AdminOrgUser[] | null>(null);
  const [features, setFeatures] = useState({ orders: false, finance: false });
  const [featuresError, setFeaturesError] = useState('');
  const [savingFeatures, setSavingFeatures] = useState(false);
  const [storeUrl, setStoreUrl] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [tokenPlaceholder, setTokenPlaceholder] = useState('Loading…');
  const [postexPlaceholder, setPostexPlaceholder] = useState('Loading…');
  const [couriersNextPlaceholder, setCouriersNextPlaceholder] = useState('Loading…');
  const [shopifyToken, setShopifyToken] = useState('');
  const [postexToken, setPostexToken] = useState('');
  const [couriersNextAuthKey, setCouriersNextAuthKey] = useState('');
  const [integrationsError, setIntegrationsError] = useState('');
  const [savingIntegrations, setSavingIntegrations] = useState(false);
  const [viewAsBusy, setViewAsBusy] = useState(false);

  const loadIntegrations = useCallback(async (orgId: string) => {
    setShopifyToken(''); setPostexToken(''); setCouriersNextAuthKey('');
    setTokenPlaceholder('Loading…'); setPostexPlaceholder('Loading…'); setCouriersNextPlaceholder('Loading…');
    try {
      const settings = await adminApiJson<any>(`/admin/organizations/${orgId}/integration-settings`);
      setStoreUrl(settings.shopify_store_url || '');
      setApiVersion(settings.shopify_api_version || '');
      setTokenPlaceholder(settings.shopify_access_token_configured ? TOKEN_PLACEHOLDER_CONFIGURED : TOKEN_PLACEHOLDER_UNSET);
      setPostexPlaceholder(settings.postex_merchant_token_configured ? TOKEN_PLACEHOLDER_CONFIGURED : TOKEN_PLACEHOLDER_UNSET);
      setCouriersNextPlaceholder(settings.couriers_next_auth_key_configured ? TOKEN_PLACEHOLDER_CONFIGURED : TOKEN_PLACEHOLDER_UNSET);
    } catch (ex: any) {
      showToast(ex?.message || 'Failed to load integrations', 'error');
    }
  }, [showToast]);

  useEffect(() => {
    if (!org) return;
    setUsers(null);
    adminApiJson<AdminOrgUser[]>(`/admin/organizations/${org.id}/users`)
      .then(setUsers)
      .catch((ex: any) => { setUsers([]); showToast(ex?.message || 'Failed to load users', 'error'); });

    setFeaturesError('');
    adminApiJson<{ enabled_features: string[] }>(`/admin/organizations/${org.id}/features`)
      .then((data) => {
        const enabled = new Set(data.enabled_features || []);
        setFeatures({ orders: enabled.has('orders'), finance: enabled.has('finance') });
      })
      .catch((ex: any) => showToast(ex?.message || 'Failed to load features', 'error'));

    loadIntegrations(org.id);
  }, [org?.id, loadIntegrations, showToast]);

  if (!org) return <Navigate to="/admin" replace />;

  async function saveFeatures(e: FormEvent) {
    e.preventDefault();
    setFeaturesError('');
    const enabled_features = [...(features.orders ? ['orders'] : []), ...(features.finance ? ['finance'] : [])];
    setSavingFeatures(true);
    try {
      await adminApiJson(`/admin/organizations/${org!.id}/features`, { method: 'PUT', body: { enabled_features } });
      showToast('Features saved', 'success');
    } catch (ex: any) {
      setFeaturesError(ex?.message || 'Could not save features');
    } finally {
      setSavingFeatures(false);
    }
  }

  async function saveIntegrations(e: FormEvent) {
    e.preventDefault();
    setIntegrationsError('');
    const body: Record<string, any> = {
      shopify_store_url: storeUrl.trim() || null,
      shopify_api_version: apiVersion.trim() || null,
    };
    if (shopifyToken) body.shopify_access_token = shopifyToken;
    if (postexToken) body.postex_merchant_token = postexToken;
    if (couriersNextAuthKey) body.couriers_next_auth_key = couriersNextAuthKey;
    setSavingIntegrations(true);
    try {
      await adminApiJson(`/admin/organizations/${org!.id}/integration-settings`, { method: 'PUT', body });
      showToast('Integrations saved', 'success');
      await loadIntegrations(org!.id);
    } catch (ex: any) {
      setIntegrationsError(ex?.message || 'Could not save integrations');
    } finally {
      setSavingIntegrations(false);
    }
  }

  return (
    <section className="admin-portal-section">
      <div className="admin-portal-section__header">
        <div className="admin-org-detail-heading">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate('/admin')}><i className="fa-solid fa-arrow-left"></i> Organizations</button>
          <h2 className="settings-section__title">{org.name}</h2>
        </div>
        <button
          type="button" className="btn btn-primary" disabled={viewAsBusy}
          onClick={async () => { setViewAsBusy(true); await viewAsOrganization(org, showToast); setViewAsBusy(false); }}
        >
          View as org
        </button>
      </div>

      <div className="settings-section">
        <h3 className="settings-section__title">Users</h3>
        {users === null && <p className="admin-portal-empty"><span className="btn-loading-spinner"></span>Loading users…</p>}
        {users !== null && users.length === 0 && <p className="admin-portal-empty">No users in this organization yet.</p>}
        {users !== null && users.length > 0 && (
          <div className="settings-users-list">
            {users.map((u) => (
              <div key={u.id} className={'settings-user-row' + (u.is_active ? '' : ' settings-user-row--inactive')}>
                <span className="settings-user-row__email">{u.name ? `${u.name} (${u.email})` : u.email}</span>
                <span className="settings-user-row__controls">{u.role === 'admin' ? 'Admin' : 'Staff'}</span>
              </div>
            ))}
          </div>
        )}
        <p className="form-hint">Read-only. To add or manage users, use "View as org" and open that org's own Settings &gt; Users.</p>
      </div>

      <div className="settings-section">
        <h3 className="settings-section__title">Features</h3>
        <p className="modal-description">Choose which sections this organization's users can see and use in the sidebar.</p>
        <form onSubmit={saveFeatures}>
          <label className="ledger-form-toggle">
            <input type="checkbox" checked={features.orders} onChange={(e) => setFeatures((f) => ({ ...f, orders: e.target.checked }))} />
            <span>Shopify order management (Dashboard, Orders, Products, Month Summary, Load Sheet Logs)</span>
          </label>
          <label className="ledger-form-toggle">
            <input type="checkbox" checked={features.finance} onChange={(e) => setFeatures((f) => ({ ...f, finance: e.target.checked }))} />
            <span>Finance (Transactions, Ledgers)</span>
          </label>
          {featuresError && <p className="auth-gate-error" role="alert">{featuresError}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={savingFeatures}>{savingFeatures ? 'Saving...' : 'Save features'}</button>
          </div>
        </form>
      </div>

      <div className="settings-section">
        <h3 className="settings-section__title">Integrations</h3>
        <form onSubmit={saveIntegrations}>
          <div className="form-group">
            <label htmlFor="adminShopifyStoreUrl">Shopify store URL</label>
            <input type="text" id="adminShopifyStoreUrl" className="form-input" placeholder="your-store.myshopify.com" value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="adminShopifyAccessToken">Shopify access token</label>
            <input type="password" id="adminShopifyAccessToken" className="form-input" placeholder={tokenPlaceholder} autoComplete="new-password" data-lpignore="true" value={shopifyToken} onChange={(e) => setShopifyToken(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="adminShopifyApiVersion">Shopify API version</label>
            <input type="text" id="adminShopifyApiVersion" className="form-input" placeholder="e.g. 2024-07" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="adminPostexToken">PostEx merchant token</label>
            <input type="password" id="adminPostexToken" className="form-input" placeholder={postexPlaceholder} autoComplete="new-password" data-lpignore="true" value={postexToken} onChange={(e) => setPostexToken(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="adminCouriersNextAuthKey">Couriers Next auth key</label>
            <input type="password" id="adminCouriersNextAuthKey" className="form-input" placeholder={couriersNextPlaceholder} autoComplete="new-password" data-lpignore="true" value={couriersNextAuthKey} onChange={(e) => setCouriersNextAuthKey(e.target.value)} />
          </div>
          {integrationsError && <p className="auth-gate-error" role="alert">{integrationsError}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={savingIntegrations}>{savingIntegrations ? 'Saving...' : 'Save integrations'}</button>
          </div>
        </form>
      </div>
    </section>
  );
}

export function AdminPortal() {
  const { showToast } = useToast();
  const [status, setStatus] = useState<'loading' | 'gate' | 'ready'>('loading');
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);

  // admin.html is a standalone scrolling page, unlike the main app's fixed-viewport
  // layout - styles.css keys this off body.admin-portal-page.
  useEffect(() => {
    document.body.classList.add('admin-portal-page');
    return () => document.body.classList.remove('admin-portal-page');
  }, []);

  const reloadOrgs = useCallback(async () => {
    setOrgsLoading(true);
    try {
      setOrgs(await adminApiJson<AdminOrg[]>('/admin/organizations'));
    } catch (ex: any) {
      showToast(ex?.message || 'Failed to load organizations', 'error');
    } finally {
      setOrgsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    (async () => {
      if (!getSuperadminToken()) { setStatus('gate'); return; }
      try {
        const me = await adminApiJson<{ is_superadmin: boolean }>('/auth/me');
        if (me.is_superadmin !== true) throw new Error('not a superadmin');
        setStatus('ready');
      } catch {
        clearSuperadminToken();
        setStatus('gate');
      }
    })();
  }, []);

  useEffect(() => {
    if (status === 'ready') reloadOrgs();
  }, [status, reloadOrgs]);

  if (status === 'loading') return null;
  if (status === 'gate') return <AdminGate onLoggedIn={() => setStatus('ready')} />;

  return (
    <div className="admin-portal-root">
      <AdminHeader onLogout={() => { clearSuperadminToken(); setStatus('gate'); }} />
      <Routes>
        <Route index element={<AdminOrgListPage orgs={orgs} loading={orgsLoading} reload={reloadOrgs} />} />
        <Route path="organizations/:id" element={<AdminOrgDetailPage orgs={orgs} />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
}
