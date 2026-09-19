// Superadmin Portal - org list, org detail (users/features/integrations), create
// org. React port of admin.html/admin.js. Deliberately does NOT use useAuth() - a
// pure superadmin's session there auto-resolves into a home org (see
// resolveSuperadminHomeOrgToken in AuthContext.tsx) and would never show this UI, so
// this keeps its own separate token, same as the original standalone page did.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { apiJson, type ApiJsonOptions } from '../../api';
import { ToastHost, useToast } from '../../toast/ToastContext';
import { Badge, BlockStack, Button, Card, ChoiceList, FormLayout, Frame, InlineError, InlineGrid, InlineStack, Spinner, Text, TextField } from '@shopify/polaris';
import { ArrowLeftIcon, PlusIcon } from '@shopify/polaris-icons';
import { FormModal } from '../../components/FormModal';

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
    if (!email.trim() || !password) { setError('Enter your email and password'); return; }
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
        <Text as="h2" variant="headingLg" alignment="center">Super Admin login</Text>
        <form autoComplete="off" onSubmit={handleSubmit}>
          <FormLayout>
            <TextField label="Email" type="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={setEmail} autoFocus />
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
            {error && <InlineError message={error} fieldID="adminGate" />}
            <Button variant="primary" submit fullWidth loading={submitting}>Log in</Button>
          </FormLayout>
        </form>
      </div>
    </div>
  );
}

function AdminHeader({ onLogout }: { onLogout: () => void }) {
  return (
    <header className="admin-portal-header">
      <InlineStack gap="300" blockAlign="center">
        <img src="/assets/Logo.png" alt="" className="admin-portal-header__logo" />
        <Text as="h1" variant="headingLg">Super Admin Portal</Text>
      </InlineStack>
      <Button onClick={onLogout}>Log out</Button>
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
    <FormModal title="Create organization" onClose={onClose} onSubmit={submit} submitLabel="Create organization" saving={saving}>
      <FormLayout>
        <Text as="p" tone="subdued">Creates the organization and its first admin user in one step. That admin logs in themselves afterwards with the credentials you set here.</Text>
        <TextField label="Organization name" autoComplete="off" placeholder="e.g. Acme Co" requiredIndicator autoFocus value={orgName} onChange={setOrgName} />
        <TextField label="First admin name" autoComplete="off" placeholder="e.g. Jane Doe" requiredIndicator value={adminName} onChange={setAdminName} />
        <TextField label="First admin email" type="email" autoComplete="off" placeholder="owner@acme.com" requiredIndicator value={adminEmail} onChange={setAdminEmail} />
        <TextField label="First admin password" type="password" autoComplete="new-password" placeholder="At least 8 characters" requiredIndicator value={adminPassword} onChange={setAdminPassword} />
        {error && <InlineError message={error} fieldID="adminOrgForm" />}
      </FormLayout>
    </FormModal>
  );
}

function AdminOrgListPage({ orgs, loading, reload }: { orgs: AdminOrg[]; loading: boolean; reload: () => void }) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <section className="admin-portal-section">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Organizations</Text>
          <Button variant="primary" icon={PlusIcon} onClick={() => setShowCreate(true)}>Create organization</Button>
        </InlineStack>
        {loading && <div className="page-loading"><Spinner size="small" /><Text as="span" tone="subdued">Loading organizations…</Text></div>}
        {!loading && orgs.length === 0 && <Text as="p" tone="subdued">No organizations yet — create the first one above.</Text>}
        {!loading && orgs.length > 0 && (
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
            {orgs.map((org) => (
              <div key={org.id} className="card-link" role="link" tabIndex={0} onClick={() => navigate(`/admin/organizations/${org.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/organizations/${org.id}`); }}>
                <Card>
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">{org.name}</Text>
                      <Text as="span" tone="subdued" variant="bodySm">{org.created_at ? `Created ${formatDate(org.created_at)}` : ''}</Text>
                    </BlockStack>
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button size="slim" onClick={() => viewAsOrganization(org, showToast)}>View as org</Button>
                    </span>
                  </InlineStack>
                </Card>
              </div>
            ))}
          </InlineGrid>
        )}
      </BlockStack>
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

  async function saveFeatures() {    const enabled_features = [...(features.orders ? ['orders'] : []), ...(features.finance ? ['finance'] : [])];
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

  async function saveIntegrations() {    const body: Record<string, any> = {
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
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Button icon={ArrowLeftIcon} onClick={() => navigate('/admin')}>Organizations</Button>
            <Text as="h2" variant="headingMd">{org.name}</Text>
          </InlineStack>
          <Button variant="primary" loading={viewAsBusy} onClick={async () => { setViewAsBusy(true); await viewAsOrganization(org, showToast); setViewAsBusy(false); }}>View as org</Button>
        </InlineStack>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">Users</Text>
            {users === null && <div className="page-loading"><Spinner size="small" /><Text as="span" tone="subdued">Loading users…</Text></div>}
            {users !== null && users.length === 0 && <Text as="p" tone="subdued">No users in this organization yet.</Text>}
            {users !== null && users.length > 0 && users.map((u) => (
              <InlineStack key={u.id} align="space-between" blockAlign="center">
                <Text as="span" tone={u.is_active ? undefined : 'subdued'}>{u.name ? `${u.name} (${u.email})` : u.email}</Text>
                <Badge>{u.role === 'admin' ? 'Admin' : 'Staff'}</Badge>
              </InlineStack>
            ))}
            <Text as="p" tone="subdued" variant="bodySm">Read-only. To add or manage users, use "View as org" and open that org's own Settings &gt; Users.</Text>
          </BlockStack>
        </Card>

        <Card>
          <form onSubmit={(e) => { e.preventDefault(); saveFeatures(); }}>
            <FormLayout>
              <Text as="h3" variant="headingMd">Features</Text>
              <ChoiceList
                title="Choose which sections this organization's users can see and use in the sidebar." allowMultiple
                selected={[...(features.orders ? ['orders'] : []), ...(features.finance ? ['finance'] : [])]}
                onChange={(v) => setFeatures({ orders: v.includes('orders'), finance: v.includes('finance') })}
                choices={[
                  { value: 'orders', label: 'Shopify order management', helpText: 'Dashboard, Orders, Products, Month Summary, Load Sheet Logs' },
                  { value: 'finance', label: 'Finance', helpText: 'Transactions, Ledgers' },
                ]}
              />
              {featuresError && <InlineError message={featuresError} fieldID="features" />}
              <InlineStack align="end"><Button variant="primary" submit loading={savingFeatures}>Save features</Button></InlineStack>
            </FormLayout>
          </form>
        </Card>

        <Card>
          <form onSubmit={(e) => { e.preventDefault(); saveIntegrations(); }}>
            <FormLayout>
              <Text as="h3" variant="headingMd">Integrations</Text>
              <TextField label="Shopify store URL" autoComplete="off" placeholder="your-store.myshopify.com" value={storeUrl} onChange={setStoreUrl} />
              <TextField label="Shopify access token" type="password" autoComplete="new-password" placeholder={tokenPlaceholder} value={shopifyToken} onChange={setShopifyToken} />
              <TextField label="Shopify API version" autoComplete="off" placeholder="e.g. 2024-07" value={apiVersion} onChange={setApiVersion} />
              <TextField label="PostEx merchant token" type="password" autoComplete="new-password" placeholder={postexPlaceholder} value={postexToken} onChange={setPostexToken} />
              <TextField label="Couriers Next auth key" type="password" autoComplete="new-password" placeholder={couriersNextPlaceholder} value={couriersNextAuthKey} onChange={setCouriersNextAuthKey} />
              {integrationsError && <InlineError message={integrationsError} fieldID="integrations" />}
              <InlineStack align="end"><Button variant="primary" submit loading={savingIntegrations}>Save integrations</Button></InlineStack>
            </FormLayout>
          </form>
        </Card>
      </BlockStack>
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

  return (
    <Frame>
      {status === 'gate' ? <AdminGate onLoggedIn={() => setStatus('ready')} /> : (
        <div className="admin-portal-root">
          <AdminHeader onLogout={() => { clearSuperadminToken(); setStatus('gate'); }} />
          <Routes>
            <Route index element={<AdminOrgListPage orgs={orgs} loading={orgsLoading} reload={reloadOrgs} />} />
            <Route path="organizations/:id" element={<AdminOrgDetailPage orgs={orgs} />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </div>
      )}
      <ToastHost />
    </Frame>
  );
}
