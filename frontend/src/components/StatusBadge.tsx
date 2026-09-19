// Order-status pill with the app's tone mapping (Orders table is the reference).
import { Badge } from '@shopify/polaris';

export function orderStatusTone(status?: string): 'attention' | 'info' | 'success' | 'warning' | 'critical' {
  const s = (status || '').toLowerCase();
  if (s === 'fulfilled') return 'info';
  if (s === 'delivered') return 'success';
  if (s === 'returned') return 'warning';
  if (s === 'cancelled') return 'critical';
  return 'attention';
}

export function StatusBadge({ status, label }: { status?: string; label?: string }) {
  return <Badge tone={orderStatusTone(status)}>{label ?? status ?? ''}</Badge>;
}
