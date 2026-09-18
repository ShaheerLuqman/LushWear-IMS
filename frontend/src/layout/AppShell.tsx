// Sidebar + header chrome, wrapping every routed page via <Outlet/>. Replaces
// navigation.js's switchView()/initNavigation() - nav highlighting now comes
// from Polaris's Navigation (matched against useLocation()) inside a Polaris
// Frame app shell, per-view header content from PageHeaderContext (see
// usePageHeader in each page component) instead of ~15 imperative show/hide calls.
import { useEffect, useState } from 'react';
import type { SVGProps } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Frame, Navigation } from '@shopify/polaris';
import type { LucideIcon } from 'lucide-react';
import { Menu } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { NotificationBell } from '../toast/NotificationBell';
import { SidebarUserMenu } from '../SidebarUserMenu';
import type { NavGroup } from './navConfig';
import { NAV_SECTIONS, SETTINGS_NAV_ITEM, getNavIconForPath } from './navConfig';
import { PageHeaderProvider, useCurrentPageHeader } from './PageHeaderContext';
import { SearchField } from '../components/SearchField';

const MOBILE_BREAKPOINT = 820;

// Polaris's Icon picks its render path via `typeof source === 'function'`, but lucide-react
// icons are React.forwardRef objects (typeof 'object'), so they'd silently fall through to
// Polaris's "external image" branch and render as a broken image. Thin plain-function wrapper.
// Also: Polaris's CSS forces `.Polaris-Icon svg { fill: currentColor }` for its own filled
// icon set, which beats lucide's inline `fill="none"` attribute and turns every closed shape
// solid black - only an inline `style` (higher priority than that stylesheet rule) wins it back.
function toIconSource(LucideIcon: LucideIcon) {
  return function IconSource(props: SVGProps<SVGSVGElement>) {
    return <LucideIcon {...props} style={{ fill: 'none' }} />;
  };
}

function toNavItem(group: NavGroup, onNavigate: () => void) {
  return {
    url: group.to,
    label: group.label,
    icon: toIconSource(group.icon),
    onClick: onNavigate,
    subNavigationItems: group.children?.map((child) => ({
      url: child.to, label: child.label, onClick: onNavigate,
    })),
  };
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { hasFeature } = useAuth();
  const location = useLocation();

  return (
    // Frame's own nav wrapper is `display:flex` with no flex-direction:column set - it only
    // stacks its *own* Navigation component vertically, not arbitrary siblings we add next to
    // it. Without this wrapper, logo/nav/lock-wrap lay out as a flex row instead of a column.
    <div className="sidebar-nav-column">
      <div className="logo">
        <img src="/assets/Logo.png" alt="SoftLush" className="logo-img" />
        <span className="logo-text">SoftLush</span>
      </div>
      <Navigation location={location.pathname}>
        {/* A single Section for the main groups - Polaris puts visible spacing between
            Sections, which would otherwise pull Finance/Courier Payment Report away from
            Inventory. Settings gets its own Section pinned to the bottom, Shopify-admin style. */}
        <div className="sidebar-nav-scroll">
          <Navigation.Section
            items={NAV_SECTIONS.filter((section) => hasFeature(section.feature))
              .flatMap((section) => section.groups)
              .map((group) => toNavItem(group, onNavigate))}
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
  const TitleIcon = getNavIconForPath(location.pathname);
  return (
    <header className="header">
      <button type="button" className="mobile-nav-toggle" aria-label="Open navigation" onClick={onToggleMobileNav}>
        <Menu size={20} />
      </button>
      <div className="header-title">
        <div className="header-title-row">
          {TitleIcon && <TitleIcon size={20} className="header-title-icon" />}
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
      </Frame>
    </PageHeaderProvider>
  );
}
