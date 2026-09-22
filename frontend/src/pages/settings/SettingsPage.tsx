// Settings: Account, Users, Financial calendar, Integrations, Couriers, Danger zone.
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge, BlockStack, Box, Button, Card, Checkbox, Divider, FormLayout, InlineError, InlineStack, Link, Spinner, Text, TextField,
} from '@shopify/polaris';
import { apiJson, apiRequest } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/ConfirmContext';
import { formatMoney } from '../../logic/ledgers';
import { DatePopover, formatDate } from '../../components/DatePopover';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { FormModal } from '../../components/FormModal';
import { ChangePasswordModal } from './ChangePasswordModal';
import { Dropdown } from '../../components/Dropdown';

const ROLE_OPTIONS = [{ value: 'staff', label: 'Staff' }, { value: 'admin', label: 'Admin' }];

function Section({ title, description, danger, children }: { title: string; description?: string; danger?: boolean; children: ReactNode }) {
  const body = (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <Text as="h2" variant="headingMd" tone={danger ? 'critical' : undefined}>{title}</Text>
        {description && <Text as="p" tone="subdued">{description}</Text>}
      </BlockStack>
      {children}
    </BlockStack>
  );
  // Outlined in red rather than carded, the way GitHub separates its danger zone
  // - a Card's shadow reads as "same as the settings above", which this is not.
  return danger
    ? <Box background="bg-surface-secondary" padding="400" borderRadius="300" borderWidth="025" borderColor="border-critical-secondary">{body}</Box>
    : <Card>{body}</Card>;
}

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

  async function submit() {
    setError('');
    if (!email.trim()) { setError('Email is required'); return; }
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
    <Section title="Users">
      <BlockStack gap="200">
        {(users || []).map((user) => (
          <InlineStack key={user.id} align="space-between" blockAlign="center" gap="300" wrap={false}>
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" tone={user.is_active ? undefined : 'subdued'}>{user.name ? `${user.name} (${user.email})` : user.email}</Text>
              {!user.is_active && <Badge>Inactive</Badge>}
            </InlineStack>
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <Dropdown options={ROLE_OPTIONS} value={user.role} onChange={(v) => changeRole(user, v)} />
              <Button size="slim" loading={busyId === user.id} onClick={() => toggleActive(user)}>{user.is_active ? 'Deactivate' : 'Activate'}</Button>
            </InlineStack>
          </InlineStack>
        ))}
      </BlockStack>
      <Divider />
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormLayout>
          <Text as="h3" variant="headingSm">Add user</Text>
          <FormLayout.Group>
            <TextField label="Name" autoComplete="off" maxLength={200} value={name} onChange={setName} />
            <TextField label="Email" type="email" autoComplete="off" placeholder="teammate@example.com" requiredIndicator value={email} onChange={setEmail} />
          </FormLayout.Group>
          <FormLayout.Group>
            <TextField label="Temporary password" type="password" autoComplete="new-password" helpText="Leave blank if they already have an account elsewhere" value={password} onChange={setPassword} />
            <Dropdown label="Role" fullWidth options={ROLE_OPTIONS} value={role} onChange={(v) => setRole(v as 'staff' | 'admin')} />
          </FormLayout.Group>
          {error && <InlineError message={error} fieldID="addUser" />}
          <InlineStack align="end"><Button variant="primary" submit loading={saving}>Add user</Button></InlineStack>
        </FormLayout>
      </form>
    </Section>
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

  async function submit() {
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
    <Section title="Integrations">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormLayout>
          <TextField
            label="Shopify store URL" autoComplete="off" placeholder="your-store.myshopify.com" value={storeUrl} onChange={setStoreUrl}
            connectedRight={<Button loading={connecting} onClick={connectShopify}>Connect Shopify</Button>} error={connectStatus || undefined}
          />
          <TextField
            label="Shopify access token (advanced)" type="password" autoComplete="new-password" placeholder={tokenConfigured ? TOKEN_PLACEHOLDER_CONFIGURED : TOKEN_PLACEHOLDER_UNSET}
            helpText={`${tokenConfigured ? 'Configured' : 'Not configured'}. Only needed as a manual fallback - "Connect Shopify" above sets this for you.`}
            value={token} onChange={setToken}
          />
          <TextField label="Shopify API version" autoComplete="off" placeholder="e.g. 2024-07" value={apiVersion} onChange={setApiVersion} />
          {error && <InlineError message={error} fieldID="integrations" />}
          <InlineStack align="end"><Button variant="primary" submit loading={saving}>Save integrations</Button></InlineStack>
        </FormLayout>
      </form>
    </Section>
  );
}

interface CourierField { key: string; label: string; configured: boolean }
interface CourierRow { id: string; label: string; enabled: boolean; ledger_id?: string | null; credentials: CourierField[] }

// Couriers whose payment-report format the backend can parse
// (app/services/pre_onboarding.py's PARSERS).
const PRE_ONBOARDING_COURIERS = ['postex'];

interface PreOnboardingResult {
  settled: { matched: number; unmatched: string[] };
  bill: { orders_on_bill?: number; cod_total?: number } | null;
}

function CourierRowView({ courier, financeOn, onChanged }: { courier: CourierRow; financeOn: boolean; onChanged: () => void }) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState(courier.enabled);
  const [toggling, setToggling] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconResult, setReconResult] = useState<PreOnboardingResult | null>(null);

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

  async function uploadPreOnboardingCsv(files: FileList | null) {
    if (!files || !files.length) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append('files', f));
    setReconciling(true);
    try {
      // apiJson would JSON-stringify the FormData; apiRequest sends it as
      // multipart and lets the browser set the boundary.
      const res = await apiRequest(
        `/org-settings/couriers/${courier.id}/pre-onboarding-csv`,
        { method: 'POST', body: form, fallback: 'Could not reconcile those CSVs' },
      );
      const result: PreOnboardingResult = await res.json();
      setReconResult(result);
      showToast(`${result.settled.matched} order(s) settled from the CSVs`, 'success');
      onChanged();
    } catch (ex: any) {
      showToast(ex?.message || 'Could not reconcile those CSVs', 'error');
    } finally {
      setReconciling(false);
    }
  }

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center">
        <Checkbox label={courier.label} checked={enabled} disabled={toggling} onChange={toggle} />
        {enabled && courier.ledger_id && (financeOn
          ? <Link onClick={() => navigate(`/ledgers/${courier.ledger_id}`)}>View ledger</Link>
          : <Text as="span" tone="subdued">Ledger ready</Text>)}
      </InlineStack>
      {enabled && courier.credentials.length > 0 && (
        <FormLayout>
          {courier.credentials.map((field) => (
            <TextField
              key={field.key} label={field.label} type="password" autoComplete="new-password"
              placeholder={field.configured ? TOKEN_PLACEHOLDER_CONFIGURED : TOKEN_PLACEHOLDER_UNSET} helpText={field.configured ? 'Configured' : 'Not configured'}
              value={values[field.key] || ''} onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
            />
          ))}
          <InlineStack align="end"><Button variant="primary" loading={savingKeys} onClick={saveKeys}>Save keys</Button></InlineStack>
        </FormLayout>
      )}
      {enabled && PRE_ONBOARDING_COURIERS.includes(courier.id) && (
        <BlockStack gap="150">
          <Text as="span" tone="subdued">
            Upload {courier.label}'s payment reports covering the two months before your onboarding date.
            Whatever they show as still unpaid becomes a "{courier.label} pre-onboarding remaining orders"
            bill, so that money is on your books. Nothing the reports settle is posted - it arrived before
            your books start. Uploading again rebuilds the bill.
          </Text>
          <InlineStack gap="300" blockAlign="center">
            <label className="pre-onboarding-upload">
              <input type="file" accept=".csv" multiple disabled={reconciling}
                onChange={(e) => { uploadPreOnboardingCsv(e.target.files); e.target.value = ''; }} />
              <Button disabled={reconciling} loading={reconciling}>Upload payment reports</Button>
            </label>
            {reconResult && (
              <Text as="span" tone="subdued">
                {reconResult.settled.matched} settled
                {reconResult.bill?.orders_on_bill
                  ? ` · ${reconResult.bill.orders_on_bill} still owed (${formatMoney(reconResult.bill.cod_total)})`
                  : ' · nothing still owed'}
                {reconResult.settled.unmatched.length ? ` · ${reconResult.settled.unmatched.length} unmatched` : ''}
              </Text>
            )}
          </InlineStack>
        </BlockStack>
      )}
    </BlockStack>
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
    <Section title="Couriers" description="Turn on the couriers you ship with. Enabling a courier opens its integration keys and creates a ledger for it.">
      <BlockStack gap="400">
        {(couriers || []).map((c) => <CourierRowView key={c.id} courier={c} financeOn={financeOn} onChanged={load} />)}
      </BlockStack>
      {error && <InlineError message={error} fieldID="couriers" />}
    </Section>
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

  async function submit() {
    setError('');
    if (!(dayNum >= 1 && dayNum <= 28)) { setError('Start day must be between 1 and 28'); return; }
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
    <Section title="Financial calendar">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormLayout>
          <FormLayout.Group>
            <TextField
              label="Financial month starts on" type="number" autoComplete="off" min={1} max={28} value={day} onChange={setDay}
              helpText="Day of the month a reporting period begins, e.g. 22 means each period runs the 22nd to the 21st of the next month."
            />
            <Dropdown label="Financial year starts in" fullWidth options={FISCAL_MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name }))} value={startMonth} onChange={setStartMonth} />
          </FormLayout.Group>
          <InlineStack gap="600">
            <Text as="span" tone="subdued">Financial year: <Text as="span" fontWeight="semibold">{yearPreview}</Text></Text>
            <Text as="span" tone="subdued">Financial month: <Text as="span" fontWeight="semibold">{monthPreview}</Text></Text>
          </InlineStack>
          {error && <InlineError message={error} fieldID="fiscal" />}
          <InlineStack align="end"><Button variant="primary" submit loading={saving}>Save financial calendar</Button></InlineStack>
        </FormLayout>
      </form>
    </Section>
  );
}

function OnboardingDateModal({ onClose }: { onClose: () => void }) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [onboardingDate, setOnboardingDate] = useState('');
  // The org's oldest entry/bill - the backend refuses anything later without a purge.
  const [earliest, setEarliest] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const settings = await apiJson<{ onboarding_date: string | null; earliest_financial_date: string | null }>('/org-settings/onboarding', { fallback: 'Failed to load onboarding date' });
        setOnboardingDate(settings.onboarding_date || '');
        setEarliest(settings.earliest_financial_date);
      } catch (ex: any) {
        showToast(ex?.message || 'Failed to load onboarding date', 'error');
        onClose();
        return;
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Past the org's oldest entry the plain setter refuses: that date can only be
  // reached by purging everything before it, which is irreversible.
  const purging = !!(onboardingDate && earliest && onboardingDate > earliest);

  async function submit() {
    setError('');
    if (!onboardingDate) { setError('Pick an onboarding date'); return; }
    if (purging && !await confirm({
      title: 'Delete everything before this date?',
      message: `Every entry, bill and receipt before ${onboardingDate} will be deleted for good, and the amounts on them are not carried over — each ledger keeps whatever opening balance it already has. Check those opening balances afterwards. This cannot be undone.`,
      confirmText: 'Delete and move date',
      danger: true,
      holdSeconds: 5,
    })) return;

    setSaving(true);
    try {
      if (purging) {
        const result = await apiJson<{ transaction_entries_deleted: number; journal_entries_deleted: number; bills_deleted: number }>(
          '/org-settings/onboarding/cutoff', { method: 'POST', body: { onboarding_date: onboardingDate } });
        showToast(`Removed ${result.transaction_entries_deleted} entries, ${result.journal_entries_deleted} vouchers and ${result.bills_deleted} bills`, 'success');
      } else {
        await apiJson('/org-settings/onboarding', { method: 'PUT', body: { onboarding_date: onboardingDate } });
        showToast('Onboarding date saved', 'success');
      }
      onClose();
    } catch (ex: any) {
      setError(ex?.message || 'Could not save onboarding date');
      setSaving(false);
    }
  }

  return (
    <FormModal
      title="Onboarding date" onClose={onClose} onSubmit={submit} saving={saving} disabled={loading}
      destructive={purging} submitLabel={purging ? 'Delete and move date' : 'Save onboarding date'}
    >
      {loading ? (
        <InlineStack align="center" gap="200" blockAlign="center"><Spinner size="small" /><Text as="span" tone="subdued">Loading onboarding date...</Text></InlineStack>
      ) : (
        <BlockStack gap="300">
          <Text as="p" tone="subdued">
            {earliest
              ? `Your books start on this day — nothing can be dated before it. Your oldest entry is ${formatDate(earliest)}; pick a later date and everything before it is deleted, leaving each ledger on its existing opening balance.`
              : 'Your books start on this day — nothing can be dated before it.'}
          </Text>
          <DatePopover value={onboardingDate} onChange={setOnboardingDate} title="Onboarding date" clearable={false} />
          {error && <InlineError message={error} fieldID="onboarding" />}
        </BlockStack>
      )}
    </FormModal>
  );
}

function OnboardingDateOption() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm" fontWeight="bold">Onboarding date</Text>
        <Text as="p" tone="subdued">Your books start on this day — nothing can be dated before it. Moving it forward deletes everything dated earlier.</Text>
        <InlineStack align="end"><Button onClick={() => setOpen(true)}>Set onboarding date</Button></InlineStack>
      </BlockStack>
      {open && <OnboardingDateModal onClose={() => setOpen(false)} />}
    </Card>
  );
}

/** Settings that can destroy data. The red outline is the zone; each option is a
 *  standalone card inside it - add the next one as a sibling in this stack. */
function DangerZoneSection() {
  return (
    <Section danger title="Danger zone" description="Changes here can delete data permanently.">
      <BlockStack gap="500">
        <OnboardingDateOption />
      </BlockStack>
    </Section>
  );
}

export function SettingsPage() {
  const { account } = useAuth();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  usePageHeader({ title: 'Settings' });

  const isAdmin = account?.role === 'admin';
  const financeOn = !!account?.enabled_features?.includes('finance');

  return (
    <div className="settings-container">
      <BlockStack gap="400">
        <Section title="Account">
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="050">
              <Text as="span" fontWeight="semibold">{account ? (account.name || account.email) : '—'}</Text>
              <Text as="span" tone="subdued">{account?.name ? account.email : ''}</Text>
              {account && <InlineStack><Badge>{account.role === 'admin' ? 'Admin' : 'Staff'}</Badge></InlineStack>}
            </BlockStack>
            <Button onClick={() => setChangePasswordOpen(true)}>Change password</Button>
          </InlineStack>
        </Section>

        {isAdmin && <UsersSection />}
        {isAdmin && <FiscalSection />}
        {isAdmin && <IntegrationsSection />}
        {isAdmin && <CouriersSection financeOn={financeOn} />}
        {isAdmin && <DangerZoneSection />}
      </BlockStack>

      {changePasswordOpen && <ChangePasswordModal onClose={() => setChangePasswordOpen(false)} />}
    </div>
  );
}
