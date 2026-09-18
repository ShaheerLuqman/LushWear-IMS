// Settings: Appearance, Account, Users, Financial calendar, Integrations, Couriers.
// Ported from auth-users.js's loadAccountSettings + the settingsView markup.
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { ChangePasswordModal } from './ChangePasswordModal';

interface UserRow { id: string; name?: string; email: string; role: 'admin' | 'staff'; is_active: boolean }

function UsersSection() {
  const { showToast } = useToast();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'staff' | 'admin'>('staff');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setUsers(await apiJson<UserRow[]>('/users/', { fallback: 'Failed to load users' }));
    } catch (ex: any) {
      showToast(ex?.message || 'Failed to load users', 'error');
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeRole(user: UserRow, nextRole: string) {
    const previous = user.role;
    setUsers((prev) => prev!.map((u) => (u.id === user.id ? { ...u, role: nextRole as any } : u)));
    try {
      await apiJson(`/users/${user.id}`, { method: 'PUT', body: { role: nextRole } });
      showToast('Role updated', 'success');
    } catch (ex: any) {
      setUsers((prev) => prev!.map((u) => (u.id === user.id ? { ...u, role: previous } : u)));
      showToast(ex?.message || 'Could not update role', 'error');
    }
  }

  async function toggleActive(user: UserRow) {
    setBusyId(user.id);
    try {
      await apiJson(`/users/${user.id}`, { method: 'PUT', body: { is_active: !user.is_active } });
      showToast(!user.is_active ? 'User activated' : 'User deactivated', 'success');
      await load();
    } catch (ex: any) {
      showToast(ex?.message || 'Could not update user', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const body: Record<string, unknown> = { email: email.trim(), role };
    if (name.trim()) body.name = name.trim();
    if (password) body.password = password;
    setSaving(true);
    try {
      await apiJson('/users/', { method: 'POST', body });
      setName(''); setEmail(''); setPassword(''); setRole('staff');
      showToast('User added', 'success');
      await load();
    } catch (ex: any) {
      setError(ex?.message || 'Could not add user');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Users</h2>
      <div className="settings-users-list">
        {(users || []).map((user) => (
          <div className={'settings-user-row' + (user.is_active ? '' : ' settings-user-row--inactive')} key={user.id}>
            <span className="settings-user-row__email">{user.name ? `${user.name} (${user.email})` : user.email}</span>
            <div className="settings-user-row__controls">
              <select className="settings-user-row__role-select" value={user.role} onChange={(e) => changeRole(user, e.target.value)}>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
              <button type="button" className="btn btn-secondary" disabled={busyId === user.id} onClick={() => toggleActive(user)}>
                {user.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        ))}
      </div>
      <form className="settings-add-user-form" onSubmit={submit}>
        <div className="form-group">
          <label htmlFor="settingsAddUserName">Name</label>
          <input type="text" id="settingsAddUserName" className="form-input" maxLength={200} placeholder="Leave blank if they already have an account elsewhere" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="settingsAddUserEmail">Email</label>
          <input type="email" id="settingsAddUserEmail" className="form-input" required placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="settingsAddUserPassword">Temporary password</label>
          <input type="password" id="settingsAddUserPassword" className="form-input" minLength={8} placeholder="Leave blank if they already have an account elsewhere" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="settingsAddUserRole">Role</label>
          <select id="settingsAddUserRole" className="form-input" value={role} onChange={(e) => setRole(e.target.value as 'staff' | 'admin')}>
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        {error && <p className="auth-gate-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding...' : 'Add user'}</button>
        </div>
      </form>
    </section>
  );
}

const TOKEN_PLACEHOLDER_CONFIGURED = 'Configured — leave blank to keep it';
const TOKEN_PLACEHOLDER_UNSET = 'Not configured';

function IntegrationsSection() {
  const { showToast } = useToast();
  const [storeUrl, setStoreUrl] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [token, setToken] = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [connectStatus, setConnectStatus] = useState('');
  const [connecting, setConnecting] = useState(false);

  async function load() {
    try {
      const settings = await apiJson<{ shopify_store_url?: string; shopify_api_version?: string; shopify_access_token_configured?: boolean }>('/org-settings/', { fallback: 'Failed to load integrations' });
      setStoreUrl(settings.shopify_store_url || '');
      setApiVersion(settings.shopify_api_version || '');
      setTokenConfigured(!!settings.shopify_access_token_configured);
      return settings;
    } catch (ex: any) {
      showToast(ex?.message || 'Failed to load integrations', 'error');
      return null;
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function connectShopify() {
    const shop = storeUrl.trim();
    if (!shop) { setConnectStatus('Enter your store URL first (your-store.myshopify.com)'); return; }
    setConnectStatus('');
    setConnecting(true);
    (async () => {
      try {
        const { url } = await apiJson<{ url: string }>(`/org-settings/shopify/install?shop=${encodeURIComponent(shop)}`);
        const popup = window.open(url, 'shopify-connect', 'width=500,height=720');
        if (!popup) {
          setConnectStatus('Popup blocked - allow popups for this site and try again');
          setConnecting(false);
          return;
        }
        const closedCheck = setInterval(async () => {
          if (!popup.closed) return;
          clearInterval(closedCheck);
          const settings = await load();
          setConnecting(false);
          if (settings && settings.shopify_access_token_configured) {
            setConnectStatus('');
            showToast('Shopify connected', 'success');
          } else {
            setConnectStatus('Connection window closed before finishing');
          }
        }, 500);
      } catch (ex: any) {
        setConnectStatus(ex?.message || 'Could not start Shopify connect');
        setConnecting(false);
      }
    })();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const body: Record<string, unknown> = { shopify_store_url: storeUrl.trim() || null, shopify_api_version: apiVersion.trim() || null };
    if (token) body.shopify_access_token = token;
    setSaving(true);
    try {
      await apiJson('/org-settings/', { method: 'PUT', body });
      setToken('');
      showToast('Integrations saved', 'success');
      await load();
    } catch (ex: any) {
      setError(ex?.message || 'Could not save integrations');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Integrations</h2>
      <form onSubmit={submit}>
        <div className="form-group">
          <label htmlFor="settingsShopifyStoreUrl">Shopify store URL</label>
          <input type="text" id="settingsShopifyStoreUrl" className="form-input" placeholder="your-store.myshopify.com" value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} />
          <div className="settings-inline-actions">
            <button type="button" className="btn btn-secondary" disabled={connecting} onClick={connectShopify}>Connect Shopify</button>
            <span className="form-hint">{connectStatus}</span>
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="settingsShopifyAccessToken">Shopify access token (advanced)</label>
          <input
            type="password" id="settingsShopifyAccessToken" className="form-input" placeholder={tokenConfigured ? TOKEN_PLACEHOLDER_CONFIGURED : TOKEN_PLACEHOLDER_UNSET}
            autoComplete="new-password" data-lpignore="true" value={token} onChange={(e) => setToken(e.target.value)}
          />
          <span className="form-hint">{tokenConfigured ? 'Configured' : 'Not configured'}</span>
          <span className="form-hint">Only needed as a manual fallback - "Connect Shopify" above sets this for you.</span>
        </div>
        <div className="form-group">
          <label htmlFor="settingsShopifyApiVersion">Shopify API version</label>
          <input type="text" id="settingsShopifyApiVersion" className="form-input" placeholder="e.g. 2024-07" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
        </div>
        {error && <p className="auth-gate-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save integrations'}</button>
        </div>
      </form>
    </section>
  );
}

interface CourierField { key: string; label: string; configured: boolean }
interface CourierRow { id: string; label: string; enabled: boolean; ledger_id?: string | null; credentials: CourierField[] }

function CourierRowView({ courier, financeOn, onChanged }: { courier: CourierRow; financeOn: boolean; onChanged: () => void }) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState(courier.enabled);
  const [toggling, setToggling] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);

  async function toggle(checked: boolean) {
    setEnabled(checked);
    setToggling(true);
    try {
      await apiJson(`/org-settings/couriers/${courier.id}`, { method: 'PUT', body: { enabled: checked } });
      showToast(checked ? `${courier.label} enabled` : `${courier.label} disabled`, 'success');
      onChanged();
    } catch (ex: any) {
      setEnabled(!checked);
      showToast(ex?.message || 'Could not update courier', 'error');
    } finally {
      setToggling(false);
    }
  }

  async function saveKeys() {
    const credentials: Record<string, string> = {};
    Object.entries(values).forEach(([k, v]) => { if (v) credentials[k] = v; });
    setSavingKeys(true);
    try {
      await apiJson(`/org-settings/couriers/${courier.id}`, { method: 'PUT', body: { enabled: true, credentials } });
      showToast(`${courier.label} keys saved`, 'success');
      onChanged();
    } catch (ex: any) {
      showToast(ex?.message || 'Could not save keys', 'error');
    } finally {
      setSavingKeys(false);
    }
  }

  return (
    <div className="settings-couriers-row">
      <div className="settings-couriers-row__head">
        <label className="settings-couriers-row__toggle">
          <input type="checkbox" checked={enabled} disabled={toggling} onChange={(e) => toggle(e.target.checked)} />
          <span>{courier.label}</span>
        </label>
        <span className="settings-couriers-row__ledger">
          {enabled && courier.ledger_id && (financeOn
            ? <a href={`/ledgers/${courier.ledger_id}`} onClick={(e) => { e.preventDefault(); navigate(`/ledgers/${courier.ledger_id}`); }}>View ledger</a>
            : 'Ledger ready')}
        </span>
      </div>
      {enabled && courier.credentials.length > 0 && (
        <div className="settings-couriers-row__body">
          {courier.credentials.map((field) => (
            <div className="form-group" key={field.key}>
              <label>{field.label}</label>
              <input
                type="password" className="form-input" autoComplete="new-password" data-lpignore="true"
                placeholder={field.configured ? TOKEN_PLACEHOLDER_CONFIGURED : TOKEN_PLACEHOLDER_UNSET}
                value={values[field.key] || ''} onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
              <span className="form-hint">{field.configured ? 'Configured' : 'Not configured'}</span>
            </div>
          ))}
          <div className="settings-couriers-row__actions">
            <button type="button" className="btn btn-primary" disabled={savingKeys} onClick={saveKeys}>{savingKeys ? 'Saving...' : 'Save keys'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CouriersSection({ financeOn }: { financeOn: boolean }) {
  const [couriers, setCouriers] = useState<CourierRow[] | null>(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      setCouriers(await apiJson<CourierRow[]>('/org-settings/couriers', { fallback: 'Failed to load couriers' }));
    } catch (ex: any) {
      setError(ex?.message || 'Failed to load couriers');
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Couriers</h2>
      <p className="settings-section__desc">Turn on the couriers you ship with. Enabling a courier opens its integration keys and creates a ledger for it.</p>
      <div className="settings-couriers-list">
        {(couriers || []).map((c) => <CourierRowView key={c.id} courier={c} financeOn={financeOn} onChanged={load} />)}
      </div>
      {error && <p className="auth-gate-error" role="alert">{error}</p>}
    </section>
  );
}

const FISCAL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function FiscalSection() {
  const { showToast } = useToast();
  const [day, setDay] = useState('22');
  const [startMonth, setStartMonth] = useState('1');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const settings = await apiJson<{ fiscal_month_start_day: number; fiscal_year_start_month: number }>('/org-settings/fiscal', { fallback: 'Failed to load financial calendar' });
        setDay(String(settings.fiscal_month_start_day));
        setStartMonth(String(settings.fiscal_year_start_month));
      } catch (ex: any) {
        showToast(ex?.message || 'Failed to load financial calendar', 'error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startMonthNum = parseInt(startMonth, 10);
  const yearPreview = startMonthNum >= 1 && startMonthNum <= 12
    ? `${FISCAL_MONTH_NAMES[startMonthNum - 1]} – ${FISCAL_MONTH_NAMES[(startMonthNum === 1 ? 12 : startMonthNum - 1) - 1]}`
    : '—';
  const dayNum = parseInt(day, 10);
  const monthPreview = dayNum >= 1 && dayNum <= 28
    ? (dayNum === 1 ? `${ordinal(1)} – last day of the month` : `${ordinal(dayNum)} – ${ordinal(dayNum - 1)} of the next month`)
    : '—';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await apiJson('/org-settings/fiscal', { method: 'PUT', body: { fiscal_month_start_day: dayNum, fiscal_year_start_month: startMonthNum } });
      showToast('Financial calendar saved - reloading…', 'success');
      // Period boundaries are computed client-side too, from the value cached at boot -
      // simplest way to keep everything consistent is to reload.
      window.location.reload();
    } catch (ex: any) {
      setError(ex?.message || 'Could not save financial calendar');
      setSaving(false);
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Financial calendar</h2>
      <form onSubmit={submit}>
        <div className="form-group">
          <label htmlFor="settingsFiscalMonthStartDay">Financial month starts on</label>
          <input type="number" id="settingsFiscalMonthStartDay" className="form-input" min={1} max={28} required value={day} onChange={(e) => setDay(e.target.value)} />
          <span className="form-hint">Day of the month a reporting period begins, e.g. 22 means each period runs the 22nd to the 21st of the next month.</span>
        </div>
        <div className="form-group">
          <label htmlFor="settingsFiscalYearStartMonth">Financial year starts in</label>
          <select id="settingsFiscalYearStartMonth" className="form-input" value={startMonth} onChange={(e) => setStartMonth(e.target.value)}>
            {FISCAL_MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
          </select>
        </div>
        <div className="settings-fiscal-preview">
          <span>Financial year: <strong>{yearPreview}</strong></span>
          <span>Financial month: <strong>{monthPreview}</strong></span>
        </div>
        {error && <p className="auth-gate-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save financial calendar'}</button>
        </div>
      </form>
    </section>
  );
}

export function SettingsPage() {
  const { account } = useAuth();
  const { theme, setTheme } = useTheme();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  usePageHeader({ title: 'Settings' });

  const isAdmin = account?.role === 'admin';
  const financeOn = !!account?.enabled_features?.includes('finance');

  return (
    <div className="settings-container">
      <section className="settings-section">
        <h2 className="settings-section__title">Appearance</h2>
        <div className="settings-row">
          <div className="settings-row__text">
            <span className="settings-row__label">Theme</span>
            <span className="settings-row__hint">Choose a light or dark appearance.</span>
          </div>
          <div className="settings-theme-toggle" role="radiogroup" aria-label="Theme">
            <button type="button" className="settings-theme-btn" role="radio" aria-checked={theme === 'light'} onClick={() => setTheme('light')}>Light</button>
            <button type="button" className="settings-theme-btn" role="radio" aria-checked={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Account</h2>
        <div className="settings-row">
          <div className="settings-row__text">
            <span className="settings-row__label">{account ? (account.name || account.email) : '—'}</span>
            <span className="settings-row__hint">{account?.name ? account.email : ''}</span>
            <span className="settings-row__hint">{account ? (account.role === 'admin' ? 'Admin' : 'Staff') : ''}</span>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => setChangePasswordOpen(true)}>Change password</button>
        </div>
      </section>

      {isAdmin && <UsersSection />}
      {isAdmin && <FiscalSection />}
      {isAdmin && <IntegrationsSection />}
      {isAdmin && <CouriersSection financeOn={financeOn} />}

      {changePasswordOpen && <ChangePasswordModal onClose={() => setChangePasswordOpen(false)} />}
    </div>
  );
}
