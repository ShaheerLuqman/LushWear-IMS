// Courier Performance: delivery/return/failed rates per city per courier. Ported
// from courier-performance.js.
import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { DateRangePopover, type DateRange } from '../../components/DateRangePopover';
import { formatMoney } from '../../logic/ledgers';
import { Badge } from '@shopify/polaris';
import { Dropdown } from '../../components/Dropdown';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { MetricsStrip } from '../../components/MetricsStrip';

interface PerfRow {
  city: string; courier: string; orders: number; delivered: number; returned: number; failed: number;
  delivery_pct: number; return_pct: number; failed_pct: number; cod_collected: number; shipping_cost: number;
}

export function CourierPerformancePage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [city, setCity] = useState('');
  const [courier, setCourier] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);

  async function load() {
    const params = new URLSearchParams();
    if (dateRange) { params.append('date_from', dateRange.from); params.append('date_to', dateRange.to); }
    setLoading(true);
    try {
      const { rows: res } = await apiJson<{ rows: PerfRow[] }>(`/orders/courier-performance-by-city?${params}`, { fallback: 'Failed to load courier performance data' });
      setRows(res);
    } catch (error: any) {
      console.error('Error loading courier performance:', error);
      showToast('Failed to load courier performance data', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

  const cities = useMemo(() => [...new Set(rows.map((r) => r.city))].sort(), [rows]);
  const couriers = useMemo(() => [...new Set(rows.map((r) => r.courier))].sort(), [rows]);
  const visible = useMemo(() => rows.filter((r) => (!city || r.city === city) && (!courier || r.courier === courier)), [rows, city, courier]);

  const totals = useMemo(() => visible.reduce((acc, r) => ({
    orders: acc.orders + r.orders, delivered: acc.delivered + r.delivered, returned: acc.returned + r.returned,
    failed: acc.failed + r.failed, cod: acc.cod + r.cod_collected, shipping: acc.shipping + r.shipping_cost,
  }), { orders: 0, delivered: 0, returned: 0, failed: 0, cod: 0, shipping: 0 }), [visible]);

  usePageHeader({
    title: 'Courier Performance',
    actions: (
      <>
        <DateRangePopover value={dateRange} onChange={setDateRange} title="Filter by fulfilled date range" />
        <Dropdown searchable options={[{ value: '', label: 'All Cities' }, ...cities]} value={city} onChange={setCity} />
        <Dropdown options={[{ value: '', label: 'All Couriers' }, ...couriers]} value={courier} onChange={setCourier} />
      </>
    ),
  });

  const pct = (n: number) => (totals.orders ? `${(n / totals.orders * 100).toFixed(1)}%` : '0%');
  const columns: DataColumn<PerfRow>[] = [
    { key: 'city', heading: 'City', render: (r) => r.city, sortValue: (r) => r.city },
    { key: 'courier', heading: 'Courier', render: (r) => r.courier, sortValue: (r) => r.courier },
    { key: 'orders', heading: 'Orders', alignment: 'end', render: (r) => r.orders.toLocaleString(), sortValue: (r) => r.orders },
    { key: 'delivered', heading: 'Delivered', alignment: 'end', render: (r) => r.delivered.toLocaleString(), sortValue: (r) => r.delivered },
    { key: 'delivery_pct', heading: 'Delivery %', render: (r) => <Badge tone="success">{`${r.delivery_pct}%`}</Badge>, sortValue: (r) => r.delivery_pct },
    { key: 'returned', heading: 'Returned', alignment: 'end', render: (r) => r.returned.toLocaleString(), sortValue: (r) => r.returned },
    { key: 'return_pct', heading: 'Return %', render: (r) => <Badge tone="warning">{`${r.return_pct}%`}</Badge>, sortValue: (r) => r.return_pct },
    { key: 'failed_pct', heading: 'Failed %', render: (r) => <Badge tone="critical">{`${r.failed_pct}%`}</Badge>, sortValue: (r) => r.failed_pct },
    { key: 'cod', heading: 'COD Collected', alignment: 'end', render: (r) => `Rs ${formatMoney(r.cod_collected)}`, sortValue: (r) => r.cod_collected },
    { key: 'shipping', heading: 'Shipping Cost', alignment: 'end', render: (r) => `Rs ${formatMoney(r.shipping_cost)}`, sortValue: (r) => r.shipping_cost },
  ];

  return (
    <>
      <MetricsStrip
        label="Courier performance summary"
        tiles={[
          { label: 'Total Shipments', value: totals.orders.toLocaleString() },
          { label: 'Delivered %', value: pct(totals.delivered) },
          { label: 'Return %', value: pct(totals.returned) },
          { label: 'Failed %', value: pct(totals.failed) },
          { label: 'COD Collected', value: `Rs ${formatMoney(totals.cod)}` },
          { label: 'Shipping Cost', value: `Rs ${formatMoney(totals.shipping)}` },
        ]}
      />
      <DataTable
        columns={columns} rows={visible} rowId={(r) => `${r.city}|${r.courier}`} loading={loading} initialSort={{ key: 'orders', direction: 'descending' }}
        resourceName={{ singular: 'city', plural: 'cities' }} emptyMessage="No fulfilled orders in this range."
      />
    </>
  );
}
