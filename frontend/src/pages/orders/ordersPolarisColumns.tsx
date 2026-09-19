// Orders table cell config for the Polaris IndexTable rebuild (replaces the old AG Grid
// ordersColumns.ts). One entry per visible column: how to render it, how to sort it, and
// how to export it to Excel - single source of truth for all three so they can't drift.
import { Badge, Text, Button, Tooltip } from '@shopify/polaris';
import { RefreshIcon } from '@shopify/polaris-icons';
import { Dropdown } from '../../components/Dropdown';
import { EditableAmount, EditableText } from '../../components/EditableCell';
import { getCourierDisplayName } from '../../logic/shared';
import {
  advanceStatusMeta, computeFinalStatus, computeNetProfit, computeReceivable,
  orderStatusDisplayLabel, type Order,
} from '../../logic/orders';

export interface OrdersColumnCtx {
  isEditingAllowed: () => boolean;
  saveOrderField: (orderId: string, field: string, value: unknown) => void;
  confirmActionOnTerminalOrders: (orderNumbers: Array<string | number>, actionLabel: string, statuses?: string[]) => Promise<boolean>;
  onRefreshDelivery: (orderId: string) => void;
}

export const PIECE_RECEIVED_VALUES = ['Pending', 'Done', 'Received'];

function money(value: unknown): string {
  return (parseFloat(String(value)) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cod(order: Order): number {
  const status = (order.order_status || '').toLowerCase();
  if (status === 'returned') return 0;
  return (parseFloat(String(order.total_amount)) || 0) - (parseFloat(String(order.advance_amount)) || 0);
}

function profitPercent(order: Order): number | null {
  const netProfit = computeNetProfit(order);
  if (netProfit == null) return null;
  const total = parseFloat(String(order.total_amount)) || 0;
  return total > 0 ? (netProfit / total) * 100 : 0;
}

function statusTone(status?: string): 'attention' | 'info' | 'success' | 'warning' | 'critical' {
  const s = (status || '').toLowerCase();
  if (s === 'fulfilled') return 'info';
  if (s === 'delivered') return 'success';
  if (s === 'returned') return 'warning';
  if (s === 'cancelled') return 'critical';
  if (s === 'rfd' || s === 'ica' || s === 'cna') return 'attention';
  return 'attention';
}

function EditableFolio({ order, ctx }: { order: Order; ctx: OrdersColumnCtx }) {
  return <EditableText value={order.folio} editable={ctx.isEditingAllowed()} onSave={(v) => ctx.saveOrderField(order.id, 'folio', v || null)} />;
}

function PieceReceivedCell({ order, ctx }: { order: Order; ctx: OrdersColumnCtx }) {
  const stored = (order.piece_received || '').trim();
  const current = PIECE_RECEIVED_VALUES.includes(stored) ? stored : 'Pending';
  if (!ctx.isEditingAllowed()) {
    return <Badge tone={current === 'Received' ? 'success' : current === 'Done' ? 'info' : 'attention'}>{current}</Badge>;
  }
  return (
    <Dropdown
      size="slim"
      options={PIECE_RECEIVED_VALUES}
      value={current}
      onChange={(newValue) => {
        if (newValue === current) return;
        const applyChange = () => ctx.saveOrderField(order.id, 'piece_received', newValue);
        if (newValue === 'Received' && (order.order_status || '').toLowerCase() === 'delivered') {
          ctx.confirmActionOnTerminalOrders([order.order_number!], 'mark the piece received', ['delivered']).then((ok) => { if (ok) applyChange(); });
          return;
        }
        applyChange();
      }}
    />
  );
}

function DeliveryCell({ order, ctx }: { order: Order; ctx: OrdersColumnCtx }) {
  const courier = order.courier || '';
  const hasCourier = courier.trim() !== '' && courier.trim().toLowerCase() !== 'unassigned';
  if (!hasCourier) return <Text as="span" tone="subdued">-</Text>;
  const lastStatus = order.delivery_status;
  const history = lastStatus?.status_history;
  const hasStoredStatus = !!(lastStatus && (lastStatus.latest_status || (history && history.length > 0)));
  const statusText = hasStoredStatus ? (lastStatus?.latest_status || (history && history[history.length - 1]?.status) || '').trim() : '';
  const courierNormalized = courier.trim().toUpperCase();
  const isCancelled = (order.order_status || '').trim().toLowerCase() === 'cancelled';
  const supportsRefresh = !isCancelled && (courierNormalized === 'POSTEX' || courierNormalized === 'COURIERS NEXT');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={statusText}>
      {supportsRefresh && (
        <Tooltip content="Refresh status">
          <Button icon={RefreshIcon} variant="tertiary" size="micro" accessibilityLabel="Refresh delivery status" onClick={() => ctx.onRefreshDelivery(order.id)} />
        </Tooltip>
      )}
      <div style={{ minWidth: 0 }}>
        <Text as="span" truncate>{statusText || '-'}</Text>
      </div>
    </div>
  );
}

export interface OrdersColumnDef {
  key: string;
  heading: string;
  alignment?: 'start' | 'end';
  sortable?: boolean;
  sortValue?: (order: Order) => number | string;
  exportValue: (order: Order) => string | number;
  render: (order: Order, ctx: OrdersColumnCtx) => React.ReactNode;
}

export const ORDERS_COLUMNS: OrdersColumnDef[] = [
  {
    key: 'order_number', heading: 'Order #', sortable: true,
    sortValue: (o) => o.order_number || 0,
    exportValue: (o) => o.order_number || '',
    render: (o) => (
      <Text as="span" fontWeight="semibold">
        {o.order_number}{o.replacement_of_order_no ? ` (${o.replacement_of_order_no}-R)` : ''}
      </Text>
    ),
  },
  {
    key: 'courier', heading: 'Courier', sortable: true,
    sortValue: (o) => getCourierDisplayName(o),
    exportValue: (o) => getCourierDisplayName(o),
    render: (o) => <Text as="span">{getCourierDisplayName(o)}</Text>,
  },
  {
    key: 'order_status', heading: 'Order Status', sortable: true,
    sortValue: (o) => o.order_status || '',
    exportValue: (o) => o.order_status || '',
    render: (o) => <Badge tone={statusTone(o.order_status)}>{orderStatusDisplayLabel(o.order_status || '')}</Badge>,
  },
  {
    key: 'delivery', heading: 'Delivery',
    exportValue: (o) => o.delivery_status?.latest_status || '',
    render: (o, ctx) => <DeliveryCell order={o} ctx={ctx} />,
  },
  {
    key: 'total_amount', heading: 'Total', alignment: 'end', sortable: true,
    sortValue: (o) => parseFloat(String(o.total_amount)) || 0,
    exportValue: (o) => money(o.total_amount),
    render: (o, ctx) => (
      <EditableAmount
        value={o.total_amount} editable={ctx.isEditingAllowed()}
        onSave={(n) => ctx.saveOrderField(o.id, 'total_amount', n)}
      />
    ),
  },
  {
    key: 'advance_amount', heading: 'Advance', alignment: 'end', sortable: true,
    sortValue: (o) => parseFloat(String(o.advance_amount)) || 0,
    exportValue: (o) => money(o.advance_amount),
    render: (o, ctx) => {
      const meta = advanceStatusMeta(o.advance_status);
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
          <span className="advance-dot" style={{ background: meta.color }} title={meta.title} />
          <EditableAmount value={o.advance_amount} editable={ctx.isEditingAllowed()} onSave={(n) => ctx.saveOrderField(o.id, 'advance_amount', n)} />
        </div>
      );
    },
  },
  {
    key: 'cod', heading: 'CoD', alignment: 'end', sortable: true,
    sortValue: (o) => cod(o),
    exportValue: (o) => money(cod(o)),
    render: (o) => <Text as="span" alignment="end" numeric>{money(cod(o))}</Text>,
  },
  {
    key: 'delivery_charge', heading: 'D. Charge', alignment: 'end', sortable: true,
    sortValue: (o) => parseFloat(String(o.delivery_charge)) || 0,
    exportValue: (o) => money(o.delivery_charge),
    render: (o, ctx) => (
      <EditableAmount value={o.delivery_charge} editable={ctx.isEditingAllowed()} onSave={(n) => ctx.saveOrderField(o.id, 'delivery_charge', n)} />
    ),
  },
  {
    key: 'tax_amount', heading: 'Tax', alignment: 'end', sortable: true,
    sortValue: (o) => parseFloat(String(o.tax_amount)) || 0,
    exportValue: (o) => money(o.tax_amount),
    render: (o, ctx) => (
      <EditableAmount value={o.tax_amount} editable={ctx.isEditingAllowed()} onSave={(n) => ctx.saveOrderField(o.id, 'tax_amount', n)} />
    ),
  },
  {
    key: 'receivable', heading: 'Receivable', alignment: 'end', sortable: true,
    sortValue: (o) => computeReceivable(o) ?? -Infinity,
    exportValue: (o) => { const v = computeReceivable(o); return v == null ? '-' : money(v); },
    render: (o) => {
      const v = computeReceivable(o);
      if (v == null) return <Text as="span" tone="subdued" alignment="end">-</Text>;
      return <Text as="span" alignment="end" numeric tone={v >= 0 ? undefined : 'critical'}>{money(v)}</Text>;
    },
  },
  {
    key: 'folio', heading: 'Folio', sortable: true,
    sortValue: (o) => o.folio || '',
    exportValue: (o) => o.folio || '-',
    render: (o, ctx) => <EditableFolio order={o} ctx={ctx} />,
  },
  {
    key: 'cost_price', heading: 'Cost Price', alignment: 'end', sortable: true,
    sortValue: (o) => parseFloat(String(o.cost_price)) || 0,
    exportValue: (o) => money(o.cost_price),
    render: (o, ctx) => (
      <EditableAmount value={o.cost_price} editable={ctx.isEditingAllowed()} onSave={(n) => ctx.saveOrderField(o.id, 'cost_price', n)} />
    ),
  },
  {
    key: 'net_profit', heading: 'Net Profit', alignment: 'end', sortable: true,
    sortValue: (o) => computeNetProfit(o) ?? -Infinity,
    exportValue: (o) => { const v = computeNetProfit(o); return v == null ? '-' : money(v); },
    render: (o) => {
      const v = computeNetProfit(o);
      if (v == null) return <Text as="span" tone="subdued" alignment="end">-</Text>;
      return <Text as="span" alignment="end" numeric tone={v >= 0 ? 'success' : 'critical'}>{money(v)}</Text>;
    },
  },
  {
    key: 'profit_percent', heading: 'Profit %', alignment: 'end', sortable: true,
    sortValue: (o) => profitPercent(o) ?? -Infinity,
    exportValue: (o) => { const v = profitPercent(o); return v == null ? '-' : `${v.toFixed(1)}%`; },
    render: (o) => {
      const v = profitPercent(o);
      if (v == null) return <Text as="span" tone="subdued" alignment="end">-</Text>;
      return <Text as="span" alignment="end" numeric tone={v >= 0 ? 'success' : 'critical'}>{v.toFixed(1)}%</Text>;
    },
  },
  {
    key: 'piece_received', heading: 'Piece Received', sortable: true,
    sortValue: (o) => { const s = (o.piece_received || '').trim(); return PIECE_RECEIVED_VALUES.includes(s) ? s : 'Pending'; },
    exportValue: (o) => { const s = (o.piece_received || '').trim(); return PIECE_RECEIVED_VALUES.includes(s) ? s : 'Pending'; },
    render: (o, ctx) => <PieceReceivedCell order={o} ctx={ctx} />,
  },
  {
    key: 'final_status', heading: 'Status', sortable: true,
    sortValue: (o) => computeFinalStatus(o),
    exportValue: (o) => computeFinalStatus(o),
    render: (o) => {
      const value = computeFinalStatus(o);
      if (value === 'None') return <Text as="span" tone="subdued">-</Text>;
      return <Badge tone={value === 'OK' ? 'success' : 'warning'}>{value}</Badge>;
    },
  },
];

export interface SelectionSums {
  count: number;
  cancelledCount: number;
  total_amount: number;
  advance_amount: number;
  cod: number;
  delivery_charge: number;
  tax_amount: number;
  receivable: number;
  cost_price: number;
  net_profit: number;
  profit_percent: number | null;
}

/** Sums for the selection summary bar - cancelled rows are excluded, matching computeNetProfit
 * /computeReceivable (which return null for cancelled orders anyway). */
export function calculateSelectedSums(selectedRows: Order[]): SelectionSums {
  const rowsForSum = selectedRows.filter((row) => (row.order_status || '').toLowerCase() !== 'cancelled');
  const cancelledCount = selectedRows.length - rowsForSum.length;
  const sums = {
    count: rowsForSum.length, cancelledCount,
    total_amount: 0, advance_amount: 0, cod: 0, delivery_charge: 0, tax_amount: 0,
    receivable: 0, cost_price: 0, net_profit: 0,
  };
  let totalForProfit = 0;
  rowsForSum.forEach((row) => {
    const status = (row.order_status || '').toLowerCase();
    const rowTotal = parseFloat(String(row.total_amount)) || 0;
    const rowAdvance = parseFloat(String(row.advance_amount)) || 0;
    const rowDelivery = parseFloat(String(row.delivery_charge)) || 0;
    const rowTax = parseFloat(String(row.tax_amount)) || 0;
    const rowCost = parseFloat(String(row.cost_price)) || 0;
    sums.total_amount += rowTotal;
    sums.advance_amount += rowAdvance;
    sums.delivery_charge += rowDelivery;
    sums.tax_amount += rowTax;
    sums.cost_price += rowCost;
    if (status !== 'returned') sums.cod += rowTotal - rowAdvance;
    if ((status === 'delivered' || status === 'returned') && rowDelivery > 0) {
      totalForProfit += rowTotal;
      sums.receivable += computeReceivable(row) || 0;
    }
    const rowNetProfit = computeNetProfit(row);
    if (rowNetProfit != null) sums.net_profit += rowNetProfit;
  });
  return { ...sums, profit_percent: totalForProfit > 0 ? (sums.net_profit / totalForProfit) * 100 : null };
}
