// Sidebar + header chrome, wrapping every routed page via <Outlet/>. Replaces
// navigation.js's switchView()/initNavigation() - nav highlighting now comes
// from Polaris's Navigation (matched against useLocation()) inside a Polaris
// Frame app shell, per-view header content from PageHeaderContext (see
// usePageHeader in each page component) instead of ~15 imperative show/hide calls.
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button, Frame, Icon, Navigation } from '@shopify/polaris';
import { ArrowLeftIcon } from '@shopify/polaris-icons';
import { Menu } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { NotificationBell } from '../toast/NotificationBell';
import { SidebarUserMenu } from '../SidebarUserMenu';
import type { NavGroup } from './navConfig';
import { NAV_SECTIONS, SETTINGS_NAV_ITEM, getNavEntryForPath } from './navConfig';
import { PageHeaderProvider, useCurrentPageHeader } from './PageHeaderContext';
import { ToastHost } from '../toast/ToastContext';
import { SearchField } from '../components/SearchField';

const MOBILE_BREAKPOINT = 820;

function toNavItem(group: NavGroup, onNavigate: () => void, hover?: HoverState) {
  return {
    url: group.to,
    label: group.label,
    icon: group.icon,
    onClick: onNavigate,
    // Polaris only renders a group's sub-items while it's selected (Section overwrites the
    // `expanded` prop with its own state), so forcing `selected` on a hovered group is the
    // only way to open a nest without first navigating to its parent. `undefined` keeps
    // Polaris's own URL matching for the rest. Groups stay open until the pointer leaves the
    // whole rail - closing on item mouse-leave shifted the list under the cursor mid-move.
    selected: hover?.opened.includes(group.label) ? true : undefined,
    onMouseEnter: hover?.open,
    // SubNavigationItem's type omits `icon`, but Polaris spreads every sub-item prop into
    // the same Item component, so it renders the icon just like a top-level entry.
    subNavigationItems: group.children?.map((child) => ({
      url: child.to, label: child.label, icon: child.icon, onClick: onNavigate,
    })),
  };
}

type HoverState = { opened: string[]; open: (label: string) => void };

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { hasFeature } = useAuth();
  const location = useLocation();
  const [opened, setOpened] = useState<string[]>([]);
  const hover: HoverState = {
    opened,
    open: (label) => setOpened((prev) => (prev.includes(label) ? prev : [...prev, label])),
  };

  return (
    // Frame's own nav wrapper is `display:flex` with no flex-direction:column set - it only
    // stacks its *own* Navigation component vertically, not arbitrary siblings we add next to
    // it. Without this wrapper, logo/nav/lock-wrap lay out as a flex row instead of a column.
    <div className="sidebar-nav-column" onMouseLeave={() => setOpened([])}>
      <div className="logo">
        <img src="/assets/Logo.png" alt="QuikMerchant" className="logo-img" />
        <span className="logo-text">QuikMerchant</span>
      </div>
      <Navigation location={location.pathname}>
        {/* A single Section for the main groups - Polaris puts visible spacing between
            Sections, which would otherwise pull Finance/Courier Payment Report away from
            Inventory. Settings gets its own Section pinned to the bottom, Shopify-admin style. */}
        <div className="sidebar-nav-scroll">
          <Navigation.Section
            items={NAV_SECTIONS.filter((section) => hasFeature(section.feature))
              .flatMap((section) => section.groups)
              .map((group) => toNavItem(group, onNavigate, hover))}
          />
        </div>
        <div className="sidebar-nav-settings">
          <Navigation.Section items={[toNavItem(SETTINGS_NAV_ITEM, onNavigate)]} />
        </div>
      </Navigation>
      <div className="sidebar-lock-wrap">
        <SidebarUserMenu />
      </div>
    </div>
  );
}

function Header({ onToggleMobileNav }: { onToggleMobileNav: () => void }) {
  const header = useCurrentPageHeader();
  const location = useLocation();
  const navigate = useNavigate();
  const nav = getNavEntryForPath(location.pathname);
  return (
    <header className="header">
      <button type="button" className="mobile-nav-toggle" aria-label="Open navigation" onClick={onToggleMobileNav}>
        <Menu size={20} />
      </button>
      <div className="header-title">
        <div className="header-title-row">
          <Button
            icon={ArrowLeftIcon}
            accessibilityLabel="Back"
            disabled={!nav?.parent}
            // idx is react-router's position in the session history: 0 means the app was opened
            // straight onto this page (deep link / reload), so there's nothing in-app to go back to.
            onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate(nav!.parent!))}
          />
          {nav && <span className="header-title-icon"><Icon source={nav.icon} /></span>}
          <h1>{header.title}</h1>
        </div>
        {header.subtitle && <p className="header-subtitle">{header.subtitle}</p>}
      </div>
      {header.search && (
        <div className="header-search">
          <SearchField value={header.search.value} onChange={header.search.onChange} placeholder={header.search.placeholder} />
        </div>
      )}
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

  return (
    <PageHeaderProvider>
      <Frame
        navigation={<Sidebar onNavigate={() => setMobileOpen(false)} />}
        showMobileNavigation={mobileOpen}
        onNavigationDismiss={() => setMobileOpen(false)}
      >
        <div className="main-content">
          <Header onToggleMobileNav={() => setMobileOpen((v) => !v)} />
          <div className="content-area">
            <Outlet />
          </div>
        </div>
        <ToastHost />
      </Frame>
    </PageHeaderProvider>
  );
}
