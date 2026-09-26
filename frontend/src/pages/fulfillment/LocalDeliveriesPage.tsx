// Local Deliveries: orders sent by Local Delivery (a rider booked on demand). Per row, the delivery
// charge and the ledger the rider was paid from - edited in DeliveryChargeModal, which (re)posts
// that payment - and Delivered, which also settles the order and, once the day's orders are
// all delivered, its courier bill. See LOCAL_DELIVERY_PLAN.md.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, BlockStack, Button, InlineStack, Text } from '@shopify/polaris';
import { EditIcon } from '@shopify/polaris-icons';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { ORDERS_CHANGED_EVENT } from '../../eventsStream';
import { formatAmount, formatDateDDMMYYYY, rowMatchesQuery } from '../../logic/shared';
import { useLedgersData } from '../finance/useLedgersData';
import { DeliveryChargeModal } from './DeliveryChargeModal';

interface LocalDelivery {
  id: string;
  order_number: number;
  customer_name: string | null;
  customer_city: string | null;
  tracking_number: string | null;
  fulfilled_at: string | null;
  order_status: string;
  total_amount: number;
  // null = not entered yet; 0 = the customer paid the rider.
  delivery_charge: number | null;
  delivery_charge_ledger_id: string | null;
}

export function LocalDeliveriesPage() {
  const { showToast } = useToast();
  const { isEditingAllowed } = useAuth();
  const { ledgers, loadLedgersList } = useLedgersData();
  const [rows, setRows] = useState<LocalDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // No loading flag on refresh: this also runs on every orders_changed event, including
  // the one each save here triggers, and the table shouldn't blank out for those.
  const load = useCallback(async () => {
    try {
      setRows(await apiJson<LocalDelivery[]>('/orders/local-deliveries', { fallback: 'Failed to load local deliveries' }));
    } catch (error: any) {
      showToast(error?.message || 'Failed to load local deliveries', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); loadLedgersList(); }, [load, loadLedgersList]);
  useEffect(() => {
    window.addEventListener(ORDERS_CHANGED_EVENT, load);
    return () => window.removeEventListener(ORDERS_CHANGED_EVENT, load);
  }, [load]);

  usePageHeader({
    title: 'Local Deliveries',
    search: { value: search, onChange: setSearch },
    actions: <HeaderButton onClick={load}>Refresh</HeaderButton>,
  });

  async function markDelivered(d: LocalDelivery) {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    try {
      await apiJson('/orders/bulk-update-status', {
        method: 'POST', body: { order_numbers: [d.order_number], order_status: 'delivered' }, fallback: 'Failed to mark the order delivered',
      });
      setRows((prev) => prev.map((r) => (r.id === d.id ? { ...r, order_status: 'delivered' } : r)));
      showToast(`Order #${d.order_number} delivered`, 'success');
    } catch (error: any) {
      showToast(error?.message || 'Failed to mark the order delivered', 'error');
    }
  }

  const shown = useMemo(() => rows.filter((r) => rowMatchesQuery(r, search)), [rows, search]);

  const columns: DataColumn<LocalDelivery>[] = [
    { key: 'order', heading: 'Order', render: (d) => <Text as="span" fontWeight="semibold">#{d.order_number}</Text>, sortValue: (d) => d.order_number },
    {
      key: 'customer', heading: 'Customer',
      render: (d) => (
        <BlockStack gap="0">
          <Text as="span">{d.customer_name || '—'}</Text>
          {d.customer_city && <Text as="span" tone="subdued" variant="bodySm">{d.customer_city}</Text>}
        </BlockStack>
      ),
    },
    { key: 'ref', heading: 'Ref', render: (d) => d.tracking_number || '—' },
    { key: 'dispatched', heading: 'Dispatched', render: (d) => formatDateDDMMYYYY(d.fulfilled_at) },
    { key: 'total', heading: 'Total', alignment: 'end', render: (d) => formatAmount(d.total_amount) },
    {
      key: 'dc', heading: 'Delivery charge', alignment: 'end',
      render: (d) => (
        <InlineStack gap="100" align="end" blockAlign="center" wrap={false}>
          {isEditingAllowed() && (
            <Button icon={EditIcon} variant="tertiary" size="slim" accessibilityLabel={`Edit delivery charge for order ${d.order_number}`} onClick={() => setEditingId(d.id)} />
          )}
          {d.delivery_charge == null ? <Text as="span" tone="subdued">—</Text> : formatAmount(d.delivery_charge)}
        </InlineStack>
      ),
    },
    {
      key: 'ledger', heading: 'Paid from',
      render: (d) => {
        const name = ledgers.find((l) => l.id === d.delivery_charge_ledger_id)?.name;
        return name || <Text as="span" tone="subdued">—</Text>;
      },
    },
    {
      key: 'status', heading: 'Status',
      render: (d) => (d.order_status === 'delivered'
        ? <Badge tone="success">Delivered</Badge>
        : <Button size="slim" onClick={() => markDelivered(d)}>Mark delivered</Button>),
    },
  ];

  const editing = editingId ? rows.find((r) => r.id === editingId) : undefined;
  return (
    <>
      <DataTable
        columns={columns} rows={shown} rowId={(d) => d.id} loading={loading} pageSize={50}
        initialSort={{ key: 'order', direction: 'descending' }}
        resourceName={{ singular: 'local delivery', plural: 'local deliveries' }}
        emptyMessage="No orders sent by Local Delivery yet."
      />
      {editing && (
        <DeliveryChargeModal
          order={editing} onClose={() => setEditingId(null)}
          onSaved={(patch) => setRows((prev) => prev.map((r) => (r.id === editing.id ? { ...r, ...patch } : r)))}
        />
      )}
    </>
  );
}
