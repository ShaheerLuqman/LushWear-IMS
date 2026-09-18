// Session/auth state as a React Context - replaces the old window-global
// model (frontend/engine's earlier auth.ts) now that every consumer is a
// React component. Handles: session resume at boot, the superadmin
// "impersonate an org" flow, multi-org switch-to-last-used, and edit lock /
// enabled-features state that pages read via useAuth().
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiJson, clearAuthToken, getAuthToken, setAuthToken, setOnAuthExpired } from '../api';
import { startEventsStream, stopEventsStream } from '../eventsStream';
import { runBootShopifyProductSync, startOrdersAutoSync, stopOrdersAutoSync } from '../shopifySync';

const SUPERADMIN_TOKEN_KEY = 'lushwear_superadmin_token';
const LAST_USED_ORG_KEY = 'lushwear_last_used_org';

export interface Account {
  id: string;
  email: string;
  name?: string;
  role: 'admin' | 'staff';
  org_id: string | null;
  is_superadmin: boolean;
  enabled_features: string[];
  fiscal_month_start_day?: number;
  fiscal_year_start_month?: number;
}

type Status = 'loading' | 'gate' | 'ready';

interface AuthContextValue {
  status: Status;
  account: Account | null;
  enabledFeatures: string[];
  hasFeature: (key: string) => boolean;
  fiscalMonthStartDay: number;
  editLocked: boolean;
  isEditingAllowed: () => boolean;
  toggleEditLock: () => void;
  /** Called by AuthGate right after a successful /auth/login or /auth/bootstrap - resolves
   * org (superadmin/multi-org), fetches the account, and flips status to 'ready'. */
  completeLogin: (token: string, user?: { org_id?: string | null; is_superadmin?: boolean }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() used outside <AuthProvider>');
  return ctx;
}

/** Decodes a JWT's payload without verifying its signature - fine for a client-side
 * "should I show this UI" decision; the server independently re-validates every real call. */
function decodeTokenPayload(token: string): any {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function rememberLastUsedOrg(orgId: string): void {
  try {
    localStorage.setItem(LAST_USED_ORG_KEY, orgId);
  } catch {
    /* ignore */
  }
}

/** A pure superadmin (no real memberships) has no org_id, so their own token can't load
 * business data - resolve one: the last used on this browser, else the earliest-created org. */
async function resolveSuperadminHomeOrgToken(): Promise<string | null> {
  async function tryImpersonate(orgId: string): Promise<string | null> {
    try {
      const data = await apiJson<{ token: string }>(`/admin/organizations/${orgId}/impersonate`, { method: 'POST' });
      rememberLastUsedOrg(orgId);
      return data.token;
    } catch {
      return null;
    }
  }

  let lastOrgId: string | null = null;
  try {
    lastOrgId = localStorage.getItem(LAST_USED_ORG_KEY);
  } catch {
    /* ignore */
  }
  if (lastOrgId) {
    const token = await tryImpersonate(lastOrgId);
    if (token) return token;
  }
  try {
    const orgs = await apiJson<Array<{ id: string }>>('/admin/organizations');
    if (!orgs.length) return null;
    return await tryImpersonate(orgs[0].id);
  } catch {
    return null;
  }
}

/** /auth/login always resolves to the user's *first* membership. If a different org was
 * last used on this browser, switch to it. Not fatal if this fails. */
async function switchToLastUsedOrgIfDifferent(currentOrgId: string): Promise<void> {
  let lastOrgId: string | null = null;
  try {
    lastOrgId = localStorage.getItem(LAST_USED_ORG_KEY);
  } catch {
    /* ignore */
  }
  if (!lastOrgId || lastOrgId === currentOrgId) {
    rememberLastUsedOrg(currentOrgId);
    return;
  }
  try {
    const data = await apiJson<{ token: string }>('/auth/switch-org', { method: 'POST', body: { org_id: lastOrgId } });
    setAuthToken(data.token);
    rememberLastUsedOrg(lastOrgId);
  } catch {
    rememberLastUsedOrg(currentOrgId);
  }
}

/** Consumes a Superadmin Portal "View as org" token from #impersonate=<token> (the portal
 * opens the main app in a new tab this way). Using the hash means the token never hits a
 * server access log. */
function consumeImpersonationToken(): boolean {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('impersonate');
  if (!token) return false;
  setAuthToken(token);
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

async function tryResumeSession(): Promise<Account | null> {
  if (getAuthToken()) {
    try {
      return await apiJson<Account>('/auth/me');
    } catch {
      clearAuthToken();
    }
  }

  let superadminToken = '';
  try {
    superadminToken = localStorage.getItem(SUPERADMIN_TOKEN_KEY) || '';
  } catch {
    /* ignore */
  }
  if (!superadminToken) return null;

  setAuthToken(superadminToken);
  try {
    let account = await apiJson<Account>('/auth/me');
    if (account.is_superadmin !== true) {
      clearAuthToken();
      try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch { /* ignore */ }
      return null;
    }
    if (!account.org_id) {
      const orgToken = await resolveSuperadminHomeOrgToken();
      if (!orgToken) {
        clearAuthToken();
        return null;
      }
      setAuthToken(orgToken);
      account = await apiJson<Account>('/auth/me');
    }
    return account;
  } catch {
    clearAuthToken();
    try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch { /* ignore */ }
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [account, setAccount] = useState<Account | null>(null);
  const [editLocked, setEditLocked] = useState(false);

  const onAuthExpired = useCallback(() => {
    clearAuthToken();
    setAccount(null);
    setStatus('gate');
  }, []);

  useEffect(() => {
    setOnAuthExpired(onAuthExpired);
    return () => setOnAuthExpired(null);
  }, [onAuthExpired]);

  useEffect(() => {
    if (status === 'ready') startEventsStream(); else stopEventsStream();
    return () => stopEventsStream();
  }, [status]);

  useEffect(() => {
    if (status === 'ready') startOrdersAutoSync(); else stopOrdersAutoSync();
    return () => stopOrdersAutoSync();
  }, [status]);

  // Boot-time product sync, matching app-core.js firing syncShopifyProducts()
  // unconditionally alongside the two effects above whenever 'orders' is enabled.
  useEffect(() => {
    if (status === 'ready' && account?.enabled_features?.includes('orders')) runBootShopifyProductSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    (async () => {
      const impersonating = consumeImpersonationToken();
      const resumed = impersonating ? await apiJson<Account>('/auth/me').catch(() => null) : await tryResumeSession();
      if (resumed) {
        setAccount(resumed);
        setStatus('ready');
      } else {
        setStatus('gate');
      }
    })();
  }, []);

  const completeLogin = useCallback(async (token: string, user?: { org_id?: string | null; is_superadmin?: boolean }) => {
    setAuthToken(token);
    if (user?.is_superadmin === true && !user.org_id) {
      const orgToken = await resolveSuperadminHomeOrgToken();
      if (!orgToken) {
        clearAuthToken();
        throw new Error('No organizations exist yet to view.');
      }
      setAuthToken(orgToken);
    } else if (user?.org_id) {
      await switchToLastUsedOrgIfDifferent(user.org_id);
    }
    const fresh = await apiJson<Account>('/auth/me');
    setAccount(fresh);
    setStatus('ready');
  }, []);

  const logout = useCallback(() => {
    clearAuthToken();
    try { localStorage.removeItem(SUPERADMIN_TOKEN_KEY); } catch { /* ignore */ }
    setAccount(null);
    setStatus('gate');
  }, []);

  const toggleEditLock = useCallback(() => setEditLocked((v) => !v), []);
  const isEditingAllowed = useCallback(() => !editLocked, [editLocked]);

  const enabledFeatures = account?.enabled_features || [];
  const hasFeature = useCallback((key: string) => enabledFeatures.includes(key), [enabledFeatures]);

  const value = useMemo<AuthContextValue>(() => ({
    status,
    account,
    enabledFeatures,
    hasFeature,
    fiscalMonthStartDay: account?.fiscal_month_start_day || 22,
    editLocked,
    isEditingAllowed,
    toggleEditLock,
    completeLogin,
    logout,
  }), [status, account, enabledFeatures, hasFeature, editLocked, isEditingAllowed, toggleEditLock, completeLogin, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export { decodeTokenPayload, rememberLastUsedOrg };
