// Local Deliveries: orders sent by Local Delivery (a rider booked on demand). Per row, the delivery
// charge and the ledger the rider was paid from - saving (re)posts that payment (PUT
// /orders/{id}/local-delivery) - and Delivered, which also settles the order and, once the
// day's orders are all delivered, its courier bill. See LOCAL_DELIVERY_PLAN.md.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, BlockStack, Button, Text } from '@shopify/polaris';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { Dropdown } from '../../components/Dropdown';
import { EditableAmount } from '../../components/EditableCell';
import { ORDERS_CHANGED_EVENT } from '../../eventsStream';
import { postExCashLedgerOptions } from '../../logic/ledgers';
import { formatAmount, formatDateDDMMYYYY, rowMatchesQuery } from '../../logic/shared';
import { useLedgersData } from '../finance/useLedgersData';

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

function needsAttention(d: LocalDelivery): boolean {
  return d.order_status !== 'delivered' || d.delivery_charge == null || (d.delivery_charge > 0 && !d.delivery_charge_ledger_id);
}

export function LocalDeliveriesPage() {
  const { showToast } = useToast();
  const { isEditingAllowed } = useAuth();
  const { ledgers, loadLedgersList } = useLedgersData();
  const [rows, setRows] = useState<LocalDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

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

  async function save(d: LocalDelivery, patch: Partial<Pick<LocalDelivery, 'delivery_charge' | 'delivery_charge_ledger_id'>>) {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    const next = { ...d, ...patch };
    try {
      await apiJson(`/orders/${d.id}/local-delivery`, {
        method: 'PUT',
        body: { delivery_charge: next.delivery_charge, ledger_id: next.delivery_charge_ledger_id },
        fallback: 'Failed to save the delivery charge',
      });
      setRows((prev) => prev.map((r) => (r.id === d.id ? next : r)));
    } catch (error: any) {
      showToast(error?.message || 'Failed to save the delivery charge', 'error');
    }
  }

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

  const ledgerOptions = useMemo(() => postExCashLedgerOptions(ledgers).map((l) => ({ value: l.id, label: l.name })), [ledgers]);
  // Pending rows first; the server's newest-dispatch-first order is kept within each group.
  const shown = useMemo(() => {
    const matched = rows.filter((r) => rowMatchesQuery(r, search));
    return [...matched.filter(needsAttention), ...matched.filter((r) => !needsAttention(r))];
  }, [rows, search]);

  const columns: DataColumn<LocalDelivery>[] = [
    { key: 'order', heading: 'Order', render: (d) => <Text as="span" fontWeight="semibold">#{d.order_number}</Text> },
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
      render: (d) => <EditableAmount value={d.delivery_charge} placeholder="—" editable onSave={(n) => save(d, { delivery_charge: n })} />,
    },
    {
      key: 'ledger', heading: 'Paid from',
      render: (d) => (
        <Dropdown
          size="slim" placeholder={d.delivery_charge ? 'Select ledger' : '—'} disabled={!d.delivery_charge}
          options={ledgerOptions} value={d.delivery_charge_ledger_id || ''}
          onChange={(id) => save(d, { delivery_charge_ledger_id: id })}
        />
      ),
    },
    {
      key: 'status', heading: 'Status',
      render: (d) => (d.order_status === 'delivered'
        ? <Badge tone="success">Delivered</Badge>
        : <Button size="slim" onClick={() => markDelivered(d)}>Mark delivered</Button>),
    },
  ];

  return (
    <DataTable
      columns={columns} rows={shown} rowId={(d) => d.id} loading={loading} pageSize={50}
      resourceName={{ singular: 'local delivery', plural: 'local deliveries' }}
      emptyMessage="No orders sent by Local Delivery yet."
    />
  );
}
