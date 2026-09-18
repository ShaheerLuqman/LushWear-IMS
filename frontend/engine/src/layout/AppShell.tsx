// Sidebar + header chrome, wrapping every routed page via <Outlet/>. Replaces
// navigation.js's switchView()/initNavigation() - nav highlighting now comes
// from react-router's NavLink, per-view header content from PageHeaderContext
// (see usePageHeader in each page component) instead of ~15 imperative
// show/hide calls.
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Lock, LockOpen, Menu } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { NotificationBell } from '../toast/NotificationBell';
import { SidebarUserMenu } from '../SidebarUserMenu';
import { NAV_SECTIONS } from './navConfig';
import { PageHeaderProvider, useCurrentPageHeader } from './PageHeaderContext';

const MOBILE_BREAKPOINT = 820;

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { hasFeature, editLocked, toggleEditLock } = useAuth();
  const location = useLocation();

  return (
    <div className="sidebar-rail">
      <aside className="sidebar">
        <div className="logo">
          <img src="/assets/Logo.png" alt="SoftLush" className="logo-img" />
          <span className="logo-text">SoftLush</span>
        </div>
        <nav className="nav-menu">
          {NAV_SECTIONS.map((section, i) => {
            if (!hasFeature(section.feature)) return null;
            return (
              <div className="nav-section" key={i}>
                {section.groups.map((group) => {
                  const GroupIcon = group.icon;
                  const isActiveChild = group.children?.some((c) => location.pathname.startsWith(c.to)) ?? false;
                  if (!group.children) {
                    return (
                      <NavLink
                        key={group.to} to={group.to} onClick={onNavigate}
                        className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                        title={group.label}
                      >
                        <span className="nav-icon"><GroupIcon size={18} /></span>
                        <span className="nav-tooltip">{group.label}</span>
                      </NavLink>
                    );
                  }
                  return (
                    <div className="nav-group" key={group.to}>
                      <NavLink
                        to={group.to} onClick={onNavigate}
                        className={({ isActive }) => 'nav-item nav-item-parent' + (isActive ? ' active' : '') + (isActiveChild ? ' nav-item-parent-highlight' : '')}
                        title={group.label}
                      >
                        <span className="nav-icon"><GroupIcon size={18} /></span>
                        <span className="nav-tooltip">{group.label}</span>
                      </NavLink>
                      <div className="nav-children">
                        {group.children.map((child) => {
                          const ChildIcon = child.icon;
                          return (
                            <NavLink
                              key={child.to} to={child.to} onClick={onNavigate}
                              className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                              title={child.label}
                            >
                              <span className="nav-icon"><ChildIcon size={18} /></span>
                              <span className="nav-tooltip">{child.label}</span>
                            </NavLink>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-lock-wrap">
          <button
            type="button" className={'nav-item sidebar-lock-btn' + (editLocked ? ' locked' : '')}
            title={editLocked ? 'Unlock editing' : 'Lock editing'} onClick={toggleEditLock}
          >
            <span className="nav-icon">{editLocked ? <Lock size={18} /> : <LockOpen size={18} />}</span>
            <span className="nav-tooltip">{editLocked ? 'Unlock editing' : 'Lock editing'}</span>
          </button>
          <SidebarUserMenu />
        </div>
      </aside>
    </div>
  );
}

function Header({ onToggleMobileNav }: { onToggleMobileNav: () => void }) {
  const header = useCurrentPageHeader();
  return (
    <header className="header">
      <button type="button" className="mobile-nav-toggle" aria-label="Open navigation" onClick={onToggleMobileNav}>
        <Menu size={20} />
      </button>
      <div className="header-title">
        <h1>{header.title}</h1>
        {header.subtitle && <p className="header-subtitle">{header.subtitle}</p>}
      </div>
      <div className="header-actions">{header.actions}</div>
      <NotificationBell />
    </header>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Leaving mobile widths (or navigating) with the drawer open would strand it over the app.
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const onChange = (e: MediaQueryListEvent) => { if (!e.matches) setMobileOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('mobile-nav-open', mobileOpen);
  }, [mobileOpen]);

  return (
    <PageHeaderProvider>
      <div className="app-container" style={{ visibility: 'visible', opacity: 1 }}>
        <div className="sidebar-scrim" hidden={!mobileOpen} onClick={() => setMobileOpen(false)} />
        <Sidebar onNavigate={() => setMobileOpen(false)} />
        <main className="main-content">
          <Header onToggleMobileNav={() => setMobileOpen((v) => !v)} />
          <div className="content-area">
            <Outlet />
          </div>
        </main>
      </div>
    </PageHeaderProvider>
  );
}
