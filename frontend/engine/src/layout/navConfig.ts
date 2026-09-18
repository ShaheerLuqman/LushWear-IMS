import type { LucideIcon } from 'lucide-react';
import {
  BarChart2, BarChart3, Boxes, CalendarDays, ClipboardList, LayoutDashboard,
  MapPin, Package, PackageCheck, Printer, Receipt, Scale, Truck, Wallet, BookOpen,
} from 'lucide-react';

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
        to: '/orders', label: 'Orders', icon: Package,
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
