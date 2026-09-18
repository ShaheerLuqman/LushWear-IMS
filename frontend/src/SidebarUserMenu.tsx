// Bottom-of-sidebar "who's logged in" button - opens a popup with
// organizations to switch to (when there's more than one available),
// Settings, and Log out. React port of app-core.js's initUserMenu().
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User } from 'lucide-react';
import { apiJson, setAuthToken } from './api';
import { decodeTokenPayload, rememberLastUsedOrg, useAuth } from './auth/AuthContext';
import { getAuthToken } from './api';
import { useToast } from './toast/ToastContext';

interface Org {
  id: string;
  name: string;
}

export function SidebarUserMenu() {
  const { account, logout } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [impersonating, setImpersonating] = useState(false);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!account) return;
    const payload = decodeTokenPayload(getAuthToken());
    if (!payload) {
      setOrgs([]);
      return;
    }
    const isImpersonating = payload.impersonating === true;
    setImpersonating(isImpersonating);
    setCurrentOrgId(payload.org_id);
    apiJson<Org[]>(isImpersonating ? '/admin/organizations' : '/auth/my-organizations')
      .then((list) => setOrgs(list || []))
      .catch(() => setOrgs([]));
  }, [account]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function toggleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    const opening = !open;
    if (opening && btnRef.current) {
      // Anchored to grow upward - this button sits at the bottom of the sidebar.
      const rect = btnRef.current.getBoundingClientRect();
      setMenuStyle({ top: 'auto', bottom: `${window.innerHeight - rect.bottom}px`, left: `${rect.right + 8}px` });
    }
    setOpen(opening);
  }

  async function switchTo(orgId: string) {
    try {
      const data = impersonating
        ? await apiJson<{ token: string }>(`/admin/organizations/${orgId}/impersonate`, { method: 'POST' })
        : await apiJson<{ token: string }>('/auth/switch-org', { method: 'POST', body: { org_id: orgId } });
      setAuthToken(data.token);
      rememberLastUsedOrg(orgId);
      location.reload();
    } catch (ex: any) {
      showToast(ex?.message || 'Could not switch organization', 'error');
    }
  }

  const current = orgs.find((o) => o.id === currentOrgId);
  const showOrgSection = impersonating || orgs.length > 1;

  return (
    <div className={'sidebar-user-menu-wrap' + (open ? ' open' : '')} ref={wrapRef}>
      <button type="button" className="nav-item" ref={btnRef} aria-haspopup="true" aria-expanded={open} title="Account menu" onClick={toggleOpen}>
        <span className="nav-icon"><User size={18} /></span>
        <span className="nav-tooltip sidebar-user-menu-btn-label">
          <span>{(account && (account.name || account.email)) || 'Account'}</span>
          <span className="sidebar-user-menu-btn-org">{current ? current.name : ''}</span>
        </span>
      </button>
      {open && (
        <div className="sidebar-user-menu" role="menu" style={menuStyle}>
          {showOrgSection && (
            <>
              <div className="sidebar-user-menu-section-label">Organizations</div>
              {orgs.map((org) => {
                const isCurrent = org.id === currentOrgId;
                return (
                  <button
                    key={org.id} type="button"
                    className={'sidebar-user-menu-item' + (isCurrent ? ' sidebar-user-menu-item--selected' : '')}
                    disabled={isCurrent}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={isCurrent ? undefined : () => { setOpen(false); switchTo(org.id); }}
                  >
                    {org.name}
                  </button>
                );
              })}
              <div className="sidebar-user-menu-divider"></div>
            </>
          )}
          <button type="button" className="sidebar-user-menu-item" onClick={() => { setOpen(false); navigate('/settings'); }}>
            Settings
          </button>
          <button type="button" className="sidebar-user-menu-item sidebar-user-menu-item--danger" onClick={() => { setOpen(false); logout(); }}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
