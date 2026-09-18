import type { LucideIcon } from 'lucide-react';
import {
  BarChart2, BarChart3, Boxes, CalendarDays, ClipboardList, LayoutDashboard,
  MapPin, PackageCheck, Printer, Receipt, Scale, Settings, Truck, Wallet, BookOpen, createLucideIcon,
} from 'lucide-react';

// Shopify's admin "Orders" icon (Polaris OrderIcon), so the sidebar matches Shopify's own nav.
export const ShopifyOrderIcon: LucideIcon = createLucideIcon('ShopifyOrder', [
  ['path', {
    fillRule: 'evenodd',
    fill: 'currentColor',
    stroke: 'none',
    transform: 'scale(1.2)',
    d: 'M6.976 3.5a2.75 2.75 0 0 0-2.72 2.347l-.662 4.46a8.75 8.75 0 0 0-.094 1.282v1.661a3.25 3.25 0 0 0 3.25 3.25h6.5a3.25 3.25 0 0 0 3.25-3.25v-1.66c0-.43-.032-.858-.095-1.283l-.66-4.46a2.75 2.75 0 0 0-2.72-2.347h-6.05Zm-1.237 2.567a1.25 1.25 0 0 1 1.237-1.067h6.048c.62 0 1.146.454 1.237 1.067l.583 3.933h-2.484a1.25 1.25 0 0 0-1.185.855l-.159.474a.25.25 0 0 1-.237.171h-1.558a.25.25 0 0 1-.237-.17l-.159-.475a1.25 1.25 0 0 0-1.185-.855h-2.484l.583-3.933Zm-.738 5.433-.001.09v1.66c0 .966.784 1.75 1.75 1.75h6.5a1.75 1.75 0 0 0 1.75-1.75v-1.75h-2.46l-.1.303a1.75 1.75 0 0 1-1.66 1.197h-1.56a1.75 1.75 0 0 1-1.66-1.197l-.1-.303h-2.46Z',
  }],
]);

export interface NavChild {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  to: string;
  label: string;
  icon: LucideIcon;
  children?: NavChild[];
}

export interface NavSection {
  feature: 'orders' | 'finance';
  groups: NavGroup[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    feature: 'orders',
    groups: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    feature: 'orders',
    groups: [
      {
        to: '/orders', label: 'Orders', icon: ShopifyOrderIcon,
        children: [
          { to: '/order-fulfillment', label: 'Order Fulfillment', icon: PackageCheck },
          { to: '/print-airway-bill', label: 'Print Airway Bill', icon: Printer },
        ],
      },
      {
        to: '/products', label: 'Inventory', icon: Boxes,
        children: [
          { to: '/product-analytics', label: 'Product Analytics', icon: BarChart2 },
          { to: '/city-analytics', label: 'Analytics by City', icon: MapPin },
        ],
      },
    ],
  },
  {
    feature: 'finance',
    groups: [
      {
        to: '/month-summary', label: 'Finance', icon: CalendarDays,
        children: [
          { to: '/transactions', label: 'Transactions', icon: Wallet },
          { to: '/ledgers', label: 'Ledgers', icon: BookOpen },
          { to: '/bills', label: 'Purchase Bills', icon: Receipt },
          { to: '/trial-balance', label: 'Trial Balance', icon: Scale },
        ],
      },
    ],
  },
  {
    feature: 'orders',
    groups: [
      {
        to: '/courier-payment-report', label: 'Courier Payment Report', icon: Truck,
        children: [
          { to: '/load-sheet-logs', label: 'Load Sheet Logs', icon: ClipboardList },
          { to: '/courier-performance', label: 'Courier Performance', icon: BarChart3 },
        ],
      },
    ],
  },
];

// Not feature-gated like the sections above - every account can reach its own settings,
// so it's appended to the sidebar's item list directly (see AppShell.tsx) rather than
// living inside a NavSection.
export const SETTINGS_NAV_ITEM: NavGroup = { to: '/settings', label: 'Settings', icon: Settings };

export function getNavIconForPath(pathname: string): LucideIcon | undefined {
  const entries = [...NAV_SECTIONS.flatMap((s) => s.groups), SETTINGS_NAV_ITEM].flatMap((g) => [g, ...(g.children ?? [])]);
  const match = entries
    .filter((e) => pathname === e.to || pathname.startsWith(e.to + '/'))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.icon;
}
