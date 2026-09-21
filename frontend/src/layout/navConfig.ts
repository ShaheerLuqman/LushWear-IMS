import {
  BookOpenIcon, ChartLineIcon, ChartVerticalIcon, ClipboardIcon, DeliveryIcon, HomeIcon,
  BarcodeIcon, InventoryIcon, LocationIcon, MeasurementWeightIcon, OrderIcon, PackageFulfilledIcon, PrintIcon, ReceiptIcon,
  SettingsIcon, TransactionIcon, WalletIcon,
} from '@shopify/polaris-icons';

export type NavIcon = typeof HomeIcon;

export interface NavChild {
  to: string;
  label: string;
  icon: NavIcon;
}

export interface NavGroup {
  to: string;
  label: string;
  icon: NavIcon;
  children?: NavChild[];
}

export interface NavSection {
  feature: 'orders' | 'finance';
  groups: NavGroup[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    feature: 'orders',
    groups: [{ to: '/dashboard', label: 'Dashboard', icon: HomeIcon }],
  },
  {
    feature: 'orders',
    groups: [
      {
        to: '/orders', label: 'Orders', icon: OrderIcon,
        children: [
          { to: '/order-fulfillment', label: 'Order Fulfillment', icon: PackageFulfilledIcon },
          { to: '/print-airway-bill', label: 'Print Airway Bill', icon: PrintIcon },
          { to: '/scan-barcode', label: 'Scan Barcode', icon: BarcodeIcon },
        ],
      },
      {
        to: '/products', label: 'Inventory', icon: InventoryIcon,
        children: [
          { to: '/product-analytics', label: 'Product Analytics', icon: ChartVerticalIcon },
          { to: '/city-analytics', label: 'Analytics by City', icon: LocationIcon },
        ],
      },
    ],
  },
  {
    feature: 'finance',
    groups: [
      {
        to: '/month-summary', label: 'Finance', icon: WalletIcon,
        children: [
          { to: '/transactions', label: 'Transactions', icon: TransactionIcon },
          { to: '/ledgers', label: 'Ledgers', icon: BookOpenIcon },
          { to: '/bills', label: 'Purchase Bills', icon: ReceiptIcon },
          { to: '/trial-balance', label: 'Trial Balance', icon: MeasurementWeightIcon },
        ],
      },
    ],
  },
  {
    feature: 'orders',
    groups: [
      {
        to: '/courier-payment-report', label: 'Courier Payment Report', icon: DeliveryIcon,
        children: [
          { to: '/load-sheet-logs', label: 'Load Sheet Logs', icon: ClipboardIcon },
          { to: '/courier-performance', label: 'Courier Performance', icon: ChartLineIcon },
        ],
      },
    ],
  },
];

// Not feature-gated like the sections above - every account can reach its own settings,
// so it's appended to the sidebar's item list directly (see AppShell.tsx) rather than
// living inside a NavSection.
export const SETTINGS_NAV_ITEM: NavGroup = { to: '/settings', label: 'Settings', icon: SettingsIcon };

// Parent = the group for a child page, the list page for a detail route (/ledgers/:id), and
// none for a top-level group - which is what disables the header back button.
export function getNavEntryForPath(pathname: string): { icon: NavIcon; parent?: string } | undefined {
  const entries = [...NAV_SECTIONS.flatMap((s) => s.groups), SETTINGS_NAV_ITEM]
    .flatMap((g) => [g, ...(g.children ?? []).map((c) => ({ ...c, parent: g.to }))]);
  const match = entries
    .filter((e) => pathname === e.to || pathname.startsWith(e.to + '/'))
    .sort((a, b) => b.to.length - a.to.length)[0] as (NavGroup & { parent?: string }) | undefined;
  if (!match) return undefined;
  return { icon: match.icon, parent: pathname === match.to ? match.parent : match.to };
}
