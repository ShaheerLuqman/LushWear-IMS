// Print Airway Bill: fulfilled PostEx/Couriers Next orders for a fulfillment-date
// range, each with a Print action plus a header button to print the whole selection
// at once. Ported from print-airway-bill.js.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Text } from '@shopify/polaris';
import { PrintIcon } from '@shopify/polaris-icons';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { DateRangePopover, type DateRange } from '../../components/DateRangePopover';
import { getCourierDisplayName, getPKTDateString, rowMatchesQuery } from '../../logic/shared';
import { formatMoney } from '../../logic/ledgers';
import { printAirwayBillsForOrders } from '../../logic/airwayBills';
import type { Order } from '../../logic/orders';
import { Dropdown } from '../../components/Dropdown';
import { DataTable, type DataColumn } from '../../components/DataTable';

export function PrintAirwayBillPage() {
  const { showToast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Backend filters fulfilled_at by PKT day, so "today" must be PKT too.
  const today = getPKTDateString();
  const [dateRange, setDateRange] = useState<DateRange | null>({ from: today, to: today });
  const [courier, setCourier] = useState('PostEx');
  const [search, setSearch] = useState('');
  const [printing, setPrinting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (dateRange) { params.append('date_from', dateRange.from); params.append('date_to', dateRange.to); }
    if (courier) params.append('courier', courier);
    try {
      const rows = await apiJson<Order[]>(`/orders/airway-bill-list?${params}`, { fallback: 'Failed to load fulfilled orders' });
      setOrders(rows);
    } catch (error: any) {
      console.error('Error loading airway bill list:', error);
      showToast(error?.message || 'Failed to load fulfilled orders', 'error');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [dateRange, courier]);

  const visible = useMemo(() => orders.filter((o) => rowMatchesQuery(o, search)), [orders, search]);

  function clearFilters() {
    setCourier('PostEx');
    setSearch('');
    setDateRange({ from: today, to: today });
  }

  async function printOne(order: Order) {
    setPrinting(order.id);
    try {
      await printAirwayBillsForOrders([order]);
    } catch (error: any) {
      showToast(error?.message || 'Failed to print airway bill', 'error');
    } finally {
      setPrinting(null);
    }
  }

  async function printSelected() {
    const selected = orders.filter((o) => selectedIds.includes(o.id));
    const targets = selected.length ? selected : visible;
    if (targets.length === 0) { showToast('No orders to print', 'error', { silent: true }); return; }
    try {
      const skipped = await printAirwayBillsForOrders(targets);
      showToast(`Airway bills ready${skipped > 0 ? ` (${skipped} order(s) skipped)` : ''}`, 'success');
    } catch (error: any) {
      showToast(error?.message || 'Failed to print airway bills', 'error');
    }
  }

  usePageHeader({
    title: 'Print Airway Bill',
    search: { value: search, onChange: setSearch },
    actions: (
      <>
        <DateRangePopover value={dateRange} onChange={setDateRange} title="Filter by fulfillment date range" />
        <Dropdown options={['PostEx', 'Couriers Next']} value={courier} onChange={setCourier} />
        <HeaderButton onClick={clearFilters}>Clear Filters</HeaderButton>
        <HeaderButton variant="primary" icon={PrintIcon} onClick={printSelected}>Print Airway Bill</HeaderButton>
      </>
    ),
  });

  const columns: DataColumn<Order>[] = [
    { key: 'order_number', heading: 'Order ID', render: (o) => <Text as="span" fontWeight="semibold">#{o.order_number}</Text>, sortValue: (o) => o.order_number },
    { key: 'customer_name', heading: 'Customer Name', render: (o) => String(o.customer_name || ''), sortValue: (o) => String(o.customer_name || '') },
    { key: 'customer_address', heading: 'Complete Address', render: (o) => <div className="table-cell--wrap">{String(o.customer_address || '')}</div> },
    { key: 'customer_phone', heading: 'Mobile Number', render: (o) => String(o.customer_phone || '') },
    { key: 'customer_city', heading: 'City', render: (o) => String(o.customer_city || ''), sortValue: (o) => String(o.customer_city || '') },
    { key: 'cod', heading: 'COD (PKR)', alignment: 'end', render: (o) => formatMoney(o.cod as number), sortValue: (o) => Number(o.cod) || 0 },
    { key: 'tracking_number', heading: 'Tracking ID', render: (o) => o.tracking_number || '' },
    { key: 'courier', heading: 'Courier', render: (o) => getCourierDisplayName(o), sortValue: (o) => getCourierDisplayName(o) },
    { key: 'status', heading: 'Status', render: () => <Badge tone="info">Fulfilled</Badge> },
    { key: 'print', heading: 'Airway Bill', alignment: 'end', render: (o) => <Button icon={PrintIcon} size="slim" loading={printing === o.id} onClick={() => printOne(o)}>Print</Button> },
  ];
  const onSelectionChange = useCallback((ids: string[]) => setSelectedIds(ids), []);

  return (
    <DataTable
      columns={columns} rows={visible} rowId={(o) => o.id} loading={loading} onSelectionChange={onSelectionChange}
      resourceName={{ singular: 'order', plural: 'orders' }} emptyMessage="No fulfilled orders for this date range."
      below={(
        <div className="table-status-bar">
          <Text as="span" tone="subdued">Total Orders: {orders.length}</Text>
          {selectedIds.length > 0 && <Badge tone="info">{`${selectedIds.length} selected`}</Badge>}
        </div>
      )}
    />
  );
}
