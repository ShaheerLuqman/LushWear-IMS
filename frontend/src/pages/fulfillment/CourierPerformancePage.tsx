// Courier Performance: delivery/return/failed rates per city per courier. Ported
// from courier-performance.js.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { createDateRangePicker, type DateRangePickerHandle } from '../../dateRangePicker';
import { formatDateDDMMYYYY } from '../../logic/shared';
import { formatMoney } from '../../logic/ledgers';

interface PerfRow {
  city: string; courier: string; orders: number; delivered: number; returned: number; failed: number;
  delivery_pct: number; return_pct: number; failed_pct: number; cod_collected: number; shipping_cost: number;
}

export function CourierPerformancePage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [city, setCity] = useState('');
  const [courier, setCourier] = useState('');
  const [dateRange, setDateRange] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [dateLabel, setDateLabel] = useState('Date range');
  const [dateBtnNode, setDateBtnNode] = useState<HTMLButtonElement | null>(null);
  const pickerRef = useRef<DateRangePickerHandle | null>(null);

  async function load() {
    const params = new URLSearchParams();
    if (dateRange.from) params.append('date_from', dateRange.from);
    if (dateRange.to) params.append('date_to', dateRange.to);
    try {
      const { rows: res } = await apiJson<{ rows: PerfRow[] }>(`/orders/courier-performance-by-city?${params}`, { fallback: 'Failed to load courier performance data' });
      setRows(res);
    } catch (error: any) {
      console.error('Error loading courier performance:', error);
      showToast('Failed to load courier performance data', 'error');
    }
  }

  useEffect(() => { load(); }, [dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dateBtnNode) return;
    const handle = createDateRangePicker(dateBtnNode, {
      onSelect: (from, to) => {
        setDateRange({ from, to });
        setDateLabel(`${formatDateDDMMYYYY(from)} – ${formatDateDDMMYYYY(to)}`);
        handle?.setClearable(true);
      },
      onClear: () => {
        setDateRange({ from: null, to: null });
        setDateLabel('Date range');
        handle?.picker.clear();
        handle?.setClearable(false);
      },
    });
    pickerRef.current = handle;
    return () => handle?.destroy();
  }, [dateBtnNode]);

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
        <button ref={setDateBtnNode} type="button" className="btn btn-secondary header-toolbar-btn" title="Filter by fulfilled date range">{dateLabel}</button>
        <select className="orders-period-filter" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="">All Cities</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="orders-period-filter" value={courier} onChange={(e) => setCourier(e.target.value)}>
          <option value="">All Couriers</option>
          {couriers.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </>
    ),
  });

  return (
    <>
      <div className="stats-grid courier-performance-stats-grid">
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total Shipments</span><span className="stat-value">{totals.orders.toLocaleString()}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Delivered %</span><span className="stat-value">{totals.orders ? `${(totals.delivered / totals.orders * 100).toFixed(1)}%` : '0%'}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Return %</span><span className="stat-value">{totals.orders ? `${(totals.returned / totals.orders * 100).toFixed(1)}%` : '0%'}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Failed %</span><span className="stat-value">{totals.orders ? `${(totals.failed / totals.orders * 100).toFixed(1)}%` : '0%'}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">COD Collected</span><span className="stat-value">Rs {formatMoney(totals.cod)}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Shipping Cost</span><span className="stat-value">Rs {formatMoney(totals.shipping)}</span></div></div>
      </div>
      <div className="bill-detail-card courier-performance-table-card">
        <h3>City Wise Courier Performance</h3>
        <div className="postex-mismatches-table-wrap">
          <table className="postex-mismatches-table">
            <thead>
              <tr>
                <th>City</th><th>Courier</th><th>Orders</th><th>Delivered</th><th>Delivery %</th>
                <th>Returned</th><th>Return %</th><th>Failed %</th><th>COD Collected</th><th>Shipping Cost</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={i}>
                  <td>{r.city}</td><td>{r.courier}</td><td>{r.orders.toLocaleString()}</td><td>{r.delivered.toLocaleString()}</td>
                  <td><span className="grid-status-badge grid-status-delivered">{r.delivery_pct}%</span></td>
                  <td>{r.returned.toLocaleString()}</td>
                  <td><span className="grid-status-badge grid-status-returned">{r.return_pct}%</span></td>
                  <td><span className="grid-status-badge grid-status-cancelled">{r.failed_pct}%</span></td>
                  <td>Rs {formatMoney(r.cod_collected)}</td>
                  <td>Rs {formatMoney(r.shipping_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <p className="courier-performance-empty">No fulfilled orders in this range.</p>}
      </div>
    </>
  );
}
