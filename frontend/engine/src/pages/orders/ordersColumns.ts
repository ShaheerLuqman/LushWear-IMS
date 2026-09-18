// Orders grid column definitions - ported from orders-columns.js. Vanilla AG
// Grid treats a plain string-returning cellRenderer function as raw
// innerHTML, but ag-grid-react instead treats ANY plain function passed as
// `cellRenderer` as a React component - so a function returning an HTML
// string here would render as literal escaped text, not markup. htmlRenderer()
// wraps each of those functions in a tiny component using
// dangerouslySetInnerHTML so the exact same markup-returning functions work
// unchanged under ag-grid-react.
import { createElement } from 'react';
import type { ColDef } from 'ag-grid-community';
import { makeCheckboxFloatingFilter, makeCheckboxSetFilter } from '../../gridFilters';
import { escapeHtml, formatDateDDMMYYYY, formatDateTimeDDMMYYYY, getCourierDisplayName } from '../../logic/shared';
import {
  advanceStatusMeta, computeFinalStatus, computeNetProfit, computeReceivable, COURIER_LOGOS,
  FINAL_STATUS_VALUES, ORDER_STATUS_VALUES, orderStatusBadgeClass, orderStatusDisplayLabel,
  type Order,
} from '../../logic/orders';

const REFRESH_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';

function htmlRenderer(fn: (params: any) => string) {
  return (params: any) => createElement('span', { dangerouslySetInnerHTML: { __html: fn(params) } });
}

export interface OrdersColumnsCtx {
  isEditingAllowed: () => boolean;
  saveOrderField: (orderId: string, field: string, value: unknown) => void;
  confirmActionOnTerminalOrders: (orderNumbers: Array<string | number>, actionLabel: string, statuses?: string[]) => Promise<boolean>;
  getOrders: () => Order[];
}

export function buildOrdersGridColumns(ctx: OrdersColumnsCtx): ColDef[] {
  const textFilterContains = { filterOptions: ['contains'], defaultOption: 'contains' };
  const numberFilterExact = { filterOptions: ['equals'], defaultOption: 'equals', maxNumConditions: 1 };

  const OrderStatusSetFilter = makeCheckboxSetFilter((row: Order) => row.order_status || '');
  const OrderStatusFloatingFilter = makeCheckboxFloatingFilter(() => ORDER_STATUS_VALUES, orderStatusDisplayLabel);
  const CourierSetFilter = makeCheckboxSetFilter((row: Order) => getCourierDisplayName(row));
  const CourierFloatingFilter = makeCheckboxFloatingFilter(() => {
    const names = new Set<string>();
    ctx.getOrders().forEach((o) => { if (o.id !== '__footer__') names.add(getCourierDisplayName(o)); });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  });
  const FinalStatusSetFilter = makeCheckboxSetFilter(computeFinalStatus);
  const FinalStatusFloatingFilter = makeCheckboxFloatingFilter(() => FINAL_STATUS_VALUES);
  const PIECE_RECEIVED_VALUES = ['Pending', 'Done', 'Received'];
  const PieceReceivedSetFilter = makeCheckboxSetFilter((row: Order) => {
    const stored = (row.piece_received || '').trim();
    return PIECE_RECEIVED_VALUES.includes(stored) ? stored : 'Pending';
  });
  const PieceReceivedFloatingFilter = makeCheckboxFloatingFilter(() => PIECE_RECEIVED_VALUES);

  const columnDefs: ColDef[] = [
    {
      headerName: '', colId: 'select', width: 72, minWidth: 72, maxWidth: 72,
      checkboxSelection: true, headerCheckboxSelection: true, headerCheckboxSelectionFilteredOnly: true,
      sortable: false, floatingFilter: false, suppressSizeToFit: true,
    },
    {
      headerName: 'Order #', field: 'order_number', width: 100,
      filter: 'agTextColumnFilter', filterParams: textFilterContains,
      filterValueGetter: (params: any) => {
        if (params.data && params.data.id === '__footer__') return '';
        const on = params.api.getValue('order_number', params.node);
        if (on == null || on === '') return '';
        const s = String(on);
        const replacementOf = params.data?.replacement_of_order_no;
        return replacementOf ? `${s} (${replacementOf}-R)` : s;
      },
      cellStyle: { fontWeight: 'bold' },
      valueFormatter: (params: any) => {
        if (params.data && params.data.id === '__footer__') return '';
        const on = params.value;
        if (on == null || on === '') return '';
        const s = String(on);
        const replacementOf = params.data?.replacement_of_order_no;
        return replacementOf ? `${s} (${replacementOf}-R)` : s;
      },
      comparator: (a: any, b: any) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0),
    },
    {
      headerName: 'Courier', field: 'courier', width: 100,
      filter: CourierSetFilter, floatingFilterComponent: CourierFloatingFilter,
      valueFormatter: (params: any) => (params.data && params.data.id === '__footer__') ? '' : getCourierDisplayName(params.data || {}),
      cellRenderer: htmlRenderer((params: any) => {
        if (params.data && params.data.id === '__footer__') return '';
        const name = getCourierDisplayName(params.data || {});
        const logo = COURIER_LOGOS[name.trim().toUpperCase()];
        if (logo) return `<span class="grid-courier-logo-wrap"><img src="${logo.src}" alt="${logo.alt}" class="grid-courier-logo ${logo.imgClass}"></span>`;
        return escapeHtml(name);
      }),
    },
    {
      headerName: 'Tracking #', field: 'tracking_number', width: 130, hide: true,
      filter: 'agTextColumnFilter', filterParams: textFilterContains,
      valueFormatter: (params: any) => params.value || '-',
    },
    {
      headerName: 'Order Status', field: 'order_status', width: 130,
      filter: OrderStatusSetFilter, floatingFilterComponent: OrderStatusFloatingFilter,
      cellRenderer: htmlRenderer((params: any) => {
        if (params.data && params.data.id === '__footer__') return '';
        const status = params.value || '';
        return `<span class="grid-status-badge ${orderStatusBadgeClass(status)}">${escapeHtml(status)}</span>`;
      }),
    },
    {
      headerName: 'Delivery', field: 'delivery_status', width: 150, filter: false, sortable: false,
      cellRenderer: htmlRenderer((params: any) => {
        if (params.data && params.data.id === '__footer__') return '';
        const order: Order = params.data;
        const courier = order.courier || '';
        const hasCourier = courier && courier.trim() !== '' && courier.trim().toLowerCase() !== 'unassigned';
        if (!hasCourier) return '<span style="color: var(--text-muted);">-</span>';
        const lastStatus = order.delivery_status;
        const hasStoredStatus = !!(lastStatus && (lastStatus.latest_status || (lastStatus.status_history && lastStatus.status_history.length > 0)));
        const history = lastStatus?.status_history;
        const statusText = hasStoredStatus
          ? (lastStatus?.latest_status || (history && history.length > 0 && history[history.length - 1]?.status) || '').trim()
          : '';
        const fetchedAt = hasStoredStatus && lastStatus?.fetched_at ? formatDateTimeDDMMYYYY(lastStatus.fetched_at) : '';
        const courierNormalized = (courier || '').trim().toUpperCase();
        const isCancelled = (order.order_status || '').trim().toLowerCase() === 'cancelled';
        const supportsDeliveryRefresh = !isCancelled && (courierNormalized === 'POSTEX' || courierNormalized === 'COURIERS NEXT');
        const refreshBtn = supportsDeliveryRefresh
          ? `<button type="button" class="grid-delivery-refresh-btn" data-refresh-order-id="${escapeHtml(order.id)}" title="Refresh status">${REFRESH_ICON_SVG}</button>`
          : '';
        return `<div class="delivery-cell-with-status" title="${escapeHtml(statusText)}">${refreshBtn}<span class="delivery-status-preview">${escapeHtml(statusText)}</span>${fetchedAt ? `<span class="delivery-fetched-at">${escapeHtml(fetchedAt)}</span>` : ''}</div>`;
      }),
    },
    {
      headerName: 'Total', field: 'total_amount', width: 100,
      filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      editable: (params: any) => ctx.isEditingAllowed() && params.node?.rowPinned !== 'bottom',
      cellStyle: { cursor: 'pointer' }, cellEditor: 'agNumberCellEditor',
      cellEditorParams: { min: 0, max: 999999999.99, precision: 2 },
      valueFormatter: (params: any) => (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      valueSetter: (params: any) => {
        if (params.data?.id === '__footer__') return false;
        const newValue = parseFloat(params.newValue);
        if (!isNaN(newValue) && newValue >= 0) {
          params.data.total_amount = newValue;
          ctx.saveOrderField(params.data.id, 'total_amount', newValue);
          return true;
        }
        return false;
      },
    },
    {
      headerName: 'Advance', field: 'advance_amount', width: 100,
      filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      editable: (params: any) => ctx.isEditingAllowed() && params.node?.rowPinned !== 'bottom',
      cellStyle: { cursor: 'pointer' }, cellEditor: 'agNumberCellEditor',
      cellEditorParams: { min: 0, max: 999999999.99, precision: 2 },
      valueFormatter: (params: any) => (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      cellRenderer: htmlRenderer((params: any) => {
        const formatted = (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (params.data && params.data.id === '__footer__') return formatted;
        const meta = advanceStatusMeta(params.data ? params.data.advance_status : 1);
        return `<span class="advance-cell"><span class="advance-dot" style="background:${meta.color}" title="${meta.title}"></span><span>${formatted}</span></span>`;
      }),
      valueSetter: (params: any) => {
        if (params.data?.id === '__footer__') return false;
        const newValue = parseFloat(params.newValue);
        if (!isNaN(newValue) && newValue >= 0) {
          params.data.advance_amount = newValue;
          ctx.saveOrderField(params.data.id, 'advance_amount', newValue);
          return true;
        }
        return false;
      },
    },
    {
      headerName: 'CoD', field: 'cod', width: 100, filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      valueGetter: (params: any) => {
        if (params.data && params.data.id === '__footer__') return params.data.cod;
        const status = (params.data.order_status || '').toLowerCase();
        if (status === 'returned') return 0;
        return (parseFloat(params.data.total_amount) || 0) - (parseFloat(params.data.advance_amount) || 0);
      },
      valueFormatter: (params: any) => (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    },
    {
      headerName: 'D. Charge', field: 'delivery_charge', width: 100,
      filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      editable: () => ctx.isEditingAllowed(), cellStyle: { cursor: 'pointer' },
      valueFormatter: (params: any) => (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      valueSetter: (params: any) => {
        const newValue = parseFloat(params.newValue);
        if (!isNaN(newValue) && newValue >= 0) {
          params.data.delivery_charge = newValue;
          ctx.saveOrderField(params.data.id, 'delivery_charge', newValue);
          return true;
        }
        return false;
      },
    },
    {
      headerName: 'Tax', field: 'tax_amount', width: 80,
      filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      editable: () => ctx.isEditingAllowed(), cellStyle: { cursor: 'pointer' },
      valueFormatter: (params: any) => (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      valueSetter: (params: any) => {
        const newValue = parseFloat(params.newValue);
        if (!isNaN(newValue) && newValue >= 0) {
          params.data.tax_amount = newValue;
          ctx.saveOrderField(params.data.id, 'tax_amount', newValue);
          return true;
        }
        return false;
      },
    },
    {
      headerName: 'Receivable', field: 'receivable', width: 110, filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      valueGetter: (params: any) => {
        if (params.data && params.data.id === '__footer__') return params.data.receivable;
        const status = (params.data.order_status || '').toLowerCase();
        const delivery = parseFloat(params.data.delivery_charge) || 0;
        if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
        const total = parseFloat(params.data.total_amount) || 0;
        const advance = parseFloat(params.data.advance_amount) || 0;
        const tax = parseFloat(params.data.tax_amount) || 0;
        if (status === 'returned') return -delivery;
        return total - (advance + delivery + tax);
      },
      valueFormatter: (params: any) => params.value == null ? '-' : (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      cellStyle: (params: any) => (params.value == null ? undefined : { color: params.value >= 0 ? 'var(--text-primary)' : 'var(--danger)' }) as any,
    },
    {
      headerName: 'Folio', field: 'folio', width: 120, filter: 'agTextColumnFilter', filterParams: textFilterContains,
      editable: (params: any) => ctx.isEditingAllowed() && params.node?.rowPinned !== 'bottom',
      cellStyle: { cursor: 'pointer' },
      valueFormatter: (params: any) => params.value ?? '-',
      valueSetter: (params: any) => {
        if (params.data?.id === '__footer__') return false;
        const newValue = params.newValue != null ? String(params.newValue).trim() : null;
        params.data.folio = newValue || null;
        ctx.saveOrderField(params.data.id, 'folio', newValue);
        return true;
      },
    },
    {
      headerName: 'Cost Price', field: 'cost_price', width: 110, filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      editable: () => ctx.isEditingAllowed(), cellStyle: { cursor: 'pointer' },
      valueFormatter: (params: any) => (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      valueSetter: (params: any) => {
        const newValue = parseFloat(params.newValue);
        if (!isNaN(newValue) && newValue >= 0) {
          params.data.cost_price = newValue;
          ctx.saveOrderField(params.data.id, 'cost_price', newValue);
          return true;
        }
        return false;
      },
    },
    {
      headerName: 'Net Profit', field: 'net_profit', width: 110, filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      valueGetter: (params: any) => (params.data && params.data.id === '__footer__') ? params.data.net_profit : computeNetProfit(params.data),
      valueFormatter: (params: any) => params.value == null ? '-' : (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      cellClass: (params: any) => (params.value == null ? '' : (params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative')),
    },
    {
      headerName: 'Profit %', field: 'profit_percent', width: 100, filter: 'agNumberColumnFilter', filterParams: numberFilterExact,
      valueGetter: (params: any) => {
        if (params.data && params.data.id === '__footer__') return params.data.profit_percent;
        const netProfit = computeNetProfit(params.data);
        if (netProfit == null) return null;
        const total = parseFloat(params.data.total_amount) || 0;
        return total > 0 ? (netProfit / total) * 100 : 0;
      },
      valueFormatter: (params: any) => params.value == null ? '-' : (params.value || 0).toFixed(1) + '%',
      cellClass: (params: any) => (params.value == null ? '' : (params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative')),
    },
    {
      headerName: 'Piece Received', field: 'piece_received', width: 120,
      filter: PieceReceivedSetFilter, floatingFilterComponent: PieceReceivedFloatingFilter,
      editable: () => ctx.isEditingAllowed(), cellStyle: { cursor: 'pointer' },
      cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['Pending', 'Done', 'Received'] },
      valueGetter: (params: any) => {
        if (params.data && params.data.id === '__footer__') return null;
        const stored = (params.data.piece_received || '').trim();
        return ['Pending', 'Done', 'Received'].includes(stored) ? stored : 'Pending';
      },
      valueFormatter: (params: any) => params.value || '-',
      cellRenderer: htmlRenderer((params: any) => {
        if (params.data && params.data.id === '__footer__') return '';
        const v = (params.value || '').trim();
        if (!v) return '<span style="color: var(--text-muted);">-</span>';
        let cssClass = 'grid-piece-pending';
        if (v === 'Done') cssClass = 'grid-piece-done';
        else if (v === 'Received') cssClass = 'grid-piece-received';
        return `<span class="grid-status-badge ${cssClass}">${escapeHtml(v)}</span>`;
      }),
      valueSetter: (params: any) => {
        const newValue = (params.newValue || '').trim();
        if (!['Pending', 'Done', 'Received'].includes(newValue)) return false;
        if (newValue === (params.data.piece_received || '').trim()) return false;
        const applyChange = () => {
          params.data.piece_received = newValue;
          ctx.saveOrderField(params.data.id, 'piece_received', newValue);
          params.api.refreshCells({ rowNodes: [params.node], force: true });
        };
        if (newValue === 'Received' && (params.data.order_status || '').toLowerCase() === 'delivered') {
          ctx.confirmActionOnTerminalOrders([params.data.order_number], 'mark the piece received', ['delivered'])
            .then((ok) => { if (ok) applyChange(); });
          return false;
        }
        applyChange();
        return true;
      },
    },
    {
      headerName: 'Items', field: 'items', flex: 1, minWidth: 150, hide: true,
      filter: 'agTextColumnFilter', filterParams: textFilterContains,
      valueGetter: (params: any) => {
        const lineItems = params.data.line_items;
        if (!Array.isArray(lineItems) || lineItems.length === 0) return '';
        return lineItems.map((li: any) => {
          const name = li.name || '';
          const variant = li.variant_title && li.variant_title !== '-' ? ` - ${li.variant_title}` : '';
          const qty = Number(li.qty) || 1;
          return `${name}${variant}${qty > 1 ? ` ×${qty}` : ''}`;
        }).join(', ');
      },
      cellRenderer: htmlRenderer((params: any) => params.value ? `<div class="grid-items-cell" title="${escapeHtml(params.value)}">${escapeHtml(params.value)}</div>` : '-'),
    },
    {
      headerName: 'Date', field: 'order_receiving_date', width: 130, hide: true, floatingFilter: false,
      filter: 'agDateColumnFilter', filterParams: { filterOptions: ['inRange'], defaultOption: 'inRange', browserDatePicker: true },
      valueGetter: (params: any) => {
        const date = params.data.order_receiving_date || params.data.created_at;
        return date ? new Date(date) : null;
      },
      valueFormatter: (params: any) => params.value ? formatDateDDMMYYYY(params.value) : '',
    },
    {
      headerName: 'Status', field: 'final_status', width: 110,
      filter: FinalStatusSetFilter, floatingFilterComponent: FinalStatusFloatingFilter, sortable: true,
      valueGetter: (params: any) => (params.data && params.data.id === '__footer__') ? null : computeFinalStatus(params.data),
      cellRenderer: htmlRenderer((params: any) => {
        if (params.data && params.data.id === '__footer__') return '';
        const value = params.value || 'Warning';
        if (value === 'OK') return '<span style="font-size: 18px;">🟢</span>';
        if (value === 'None') return '<span style="color: var(--text-muted);">-</span>';
        return '<span style="font-size: 18px;">🔴</span>';
      }),
    },
  ];

  // Note: the original app also set a `pinnedRowCellRenderer` on these columns, but that
  // isn't a real AG Grid Community property (confirmed by AG Grid's own "invalid colDef
  // property" console warning) - it's always been inert. The footer row's actual
  // formatting instead comes from each column's existing cellRenderer/valueFormatter
  // above (which already special-case `id === '__footer__'`) plus CSS on the pinned row.

  return columnDefs;
}

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

/** Sums for the pinned-bottom footer row - cancelled rows are excluded, matching the grid's
 * own computeNetProfit/computeReceivable (which return null for cancelled orders anyway). */
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
