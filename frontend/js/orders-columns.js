// Column definitions for the orders grid.
//
// Split out of initOrdersGrid() (orders-grid.js), which was ~925 lines. The
// footer (pinned bottom row) renderers are still attached there, since they
// depend on the selection-sum logic that lives with the grid.

function buildOrdersGridColumns() {
    const numberFilterValueGetter = (params) => {
        const v = params.api.getValue(params.column.getColId(), params.node);
        return (v != null && v !== '') ? String(v) : '';
    };
    const textFilterContains = { filterOptions: ['contains'], defaultOption: 'contains' };

    const columnDefs = [
        {
            headerName: '',
            colId: 'select',
            width: 72,
            minWidth: 72,
            maxWidth: 72,
            checkboxSelection: true,
            headerCheckboxSelection: true,
            headerCheckboxSelectionFilteredOnly: true,
            filter: OrdersClearFiltersPassThroughFilter,
            sortable: false,
            floatingFilter: true,
            floatingFilterComponent: ClearFiltersFloatingFilter,
            suppressSizeToFit: true
        },
        {
            headerName: 'Order #',
            field: 'order_number',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const on = params.api.getValue('order_number', params.node);
                if (on == null || on === '') return '';
                const s = String(on);
                const replacementOf = params.data?.replacement_of_order_no;
                return replacementOf ? `${s} (${replacementOf}-R)` : s;
            },
            cellStyle: { fontWeight: 'bold' },
            valueFormatter: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const on = params.value;
                if (on == null || on === '') return '';
                const s = String(on);
                const replacementOf = params.data?.replacement_of_order_no;
                return replacementOf ? `${s} (${replacementOf}-R)` : s;
            },
            comparator: (a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0)
        },
        {
            headerName: 'Courier',
            field: 'courier',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: (params) => (params.data && params.data.id === '__footer__') ? null : getCourierDisplayName(params.data || {}),
            valueFormatter: (params) => (params.data && params.data.id === '__footer__') ? '' : getCourierDisplayName(params.data || {})
        },
        {
            headerName: 'Tracking #',
            field: 'tracking_number',
            width: 130,
            hide: true,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            valueFormatter: (params) => params.value || '-'
        },
        {
            headerName: 'Order Status',
            field: 'order_status',
            width: 130,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1
            },
            floatingFilterComponent: OrderStatusFloatingFilter,
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const status = params.value || '';
                let cssClass = 'grid-status-unfulfilled';
                if (status === 'fulfilled') cssClass = 'grid-status-fulfilled';
                else if (status === 'delivered') cssClass = 'grid-status-delivered';
                else if (status === 'returned') cssClass = 'grid-status-returned';
                else if (status === 'cancelled') cssClass = 'grid-status-cancelled';
                else if (status === 'RFD') cssClass = 'grid-status-rfd';
                else if (status === 'ICA') cssClass = 'grid-status-rfd';
                else if (status === 'CNA') cssClass = 'grid-status-rfd';
                else if (status === 'pending') cssClass = 'grid-status-unfulfilled'; /* legacy */
                return `<span class="grid-status-badge ${cssClass}">${escapeHtml(status)}</span>`;
            }
        },
        {
            headerName: 'Delivery',
            field: 'delivery_status',
            width: 150,
            filter: false,
            sortable: false,
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const order = params.data;
                const courier = order.courier || '';
                const hasCourier = courier && courier.trim() !== '' && courier.trim().toLowerCase() !== 'unassigned';
                if (!hasCourier) {
                    return '<span style="color: var(--text-muted);">-</span>';
                }
                const lastStatus = order.delivery_status;
                const hasStoredStatus = lastStatus && (lastStatus.latest_status || (lastStatus.status_history && lastStatus.status_history.length > 0));
                const statusText = hasStoredStatus
                    ? (
                        (lastStatus.latest_status)
                        || (
                            lastStatus.status_history
                            && lastStatus.status_history.length > 0
                            && lastStatus.status_history[lastStatus.status_history.length - 1]
                            && lastStatus.status_history[lastStatus.status_history.length - 1].status
                        )
                        || ''
                    ).trim()
                    : '';
                const displayStatus = statusText || '';
                const fetchedAt = hasStoredStatus && lastStatus.fetched_at
                    ? formatDateTimeDDMMYYYY(lastStatus.fetched_at)
                    : '';
                const courierNormalized = (courier || '').trim().toUpperCase();
                const isCancelled = (order.order_status || '').trim().toLowerCase() === 'cancelled';
                const supportsDeliveryRefresh = !isCancelled && (
                    courierNormalized === 'POSTEX' ||
                    courierNormalized === 'COURIERS NEXT'
                );
                const refreshBtn = supportsDeliveryRefresh
                    ? `<button type="button" class="grid-delivery-refresh-btn" data-refresh-order-id="${escapeHtml(order.id)}" title="Refresh status"><span>🔄</span></button>`
                    : '';
                return `<div class="delivery-cell-with-status" title="${escapeHtml(displayStatus)}">
                    ${refreshBtn}
                    <span class="delivery-status-preview">${escapeHtml(displayStatus)}</span>
                    ${fetchedAt ? `<span class="delivery-fetched-at">${escapeHtml(fetchedAt)}</span>` : ''}
                </div>`;
            }
        },
        {
            headerName: 'Total',
            field: 'total_amount',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: (params) => isEditingAllowed() && params.node?.rowPinned !== 'bottom',
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agNumberCellEditor',
            cellEditorParams: { min: 0, max: 999999999.99, precision: 2 },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                if (params.data?.id === '__footer__') return false;
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.total_amount = newValue;
                    saveOrderField(params.data.id, 'total_amount', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Advance',
            field: 'advance_amount',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: (params) => isEditingAllowed() && params.node?.rowPinned !== 'bottom',
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agNumberCellEditor',
            cellEditorParams: { min: 0, max: 999999999.99, precision: 2 },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellRenderer: (params) => {
                const val = parseFloat(params.value) || 0;
                const formatted = val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                // Footer row: no indicator
                if (params.data && params.data.id === '__footer__') return formatted;
                const meta = advanceStatusMeta(params.data ? params.data.advance_status : 1);
                return `<span class="advance-cell">`
                    + `<span class="advance-dot" style="background:${meta.color}" title="${meta.title}"></span>`
                    + `<span>${formatted}</span>`
                    + `</span>`;
            },
            valueSetter: (params) => {
                if (params.data?.id === '__footer__') return false;
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.advance_amount = newValue;
                    saveOrderField(params.data.id, 'advance_amount', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'CoD',
            field: 'cod',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.cod;
                const status = (params.data.order_status || '').toLowerCase();
                if (status === 'returned') return 0;
                const total = parseFloat(params.data.total_amount) || 0;
                const advance = parseFloat(params.data.advance_amount) || 0;
                return total - advance;
            },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
        },
        {
            headerName: 'D. Charge',
            field: 'delivery_charge',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.delivery_charge = newValue;
                    saveOrderField(params.data.id, 'delivery_charge', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Tax',
            field: 'tax_amount',
            width: 80,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.tax_amount = newValue;
                    saveOrderField(params.data.id, 'tax_amount', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Receivable',
            field: 'receivable',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.receivable;
                const status = (params.data.order_status || '').toLowerCase();
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                // Only show receivable for delivered or returned orders with delivery_charge set
                if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
                const total = parseFloat(params.data.total_amount) || 0;
                const advance = parseFloat(params.data.advance_amount) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                if (status === 'returned') return -delivery;
                return total - (advance + delivery + tax);
            },
            valueFormatter: (params) => {
                if (params.value == null) return '-';
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellStyle: (params) => {
                if (params.value == null) return {};
                return {
                    color: params.value >= 0 ? 'var(--text-primary)' : 'var(--danger)'
                };
            }
        },
        {
            headerName: 'Folio',
            field: 'folio',
            width: 120,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            editable: (params) => isEditingAllowed() && params.node?.rowPinned !== 'bottom',
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => params.value ?? '-',
            valueSetter: (params) => {
                if (params.data?.id === '__footer__') return;
                const newValue = params.newValue != null ? String(params.newValue).trim() : null;
                params.data.folio = newValue || null;
                saveOrderField(params.data.id, 'folio', newValue);
                params.api.refreshCells({ rowNodes: [params.node], force: true });
            }
        },
        {
            headerName: 'Cost Price',
            field: 'cost_price',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.cost_price = newValue;
                    saveOrderField(params.data.id, 'cost_price', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Net Profit',
            field: 'net_profit',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.net_profit;
                return computeNetProfit(params.data);
            },
            valueFormatter: (params) => {
                if (params.value == null) return '-';
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellClass: (params) => {
                if (params.value == null) return '';
                return params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative';
            }
        },
        {
            headerName: 'Profit %',
            field: 'profit_percent',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return params.data.profit_percent;
                const netProfit = computeNetProfit(params.data);
                if (netProfit == null) return null;
                const total = parseFloat(params.data.total_amount) || 0;
                if (total > 0) return (netProfit / total) * 100;
                return 0;
            },
            valueFormatter: (params) => {
                if (params.value == null) return '-';
                return (params.value || 0).toFixed(1) + '%';
            },
            cellClass: (params) => {
                if (params.value == null) return '';
                return params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative';
            }
        },
        {
            headerName: 'Piece Received',
            field: 'piece_received',
            width: 120,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1
            },
            floatingFilterComponent: PieceReceivedFloatingFilter,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agSelectCellEditor',
            cellEditorParams: {
                values: ['Pending', 'Done', 'Received']
            },
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return null;
                const stored = (params.data.piece_received || '').trim();
                return ['Pending', 'Done', 'Received'].includes(stored) ? stored : 'Pending';
            },
            valueFormatter: (params) => params.value || '-',
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const v = (params.value || '').trim();
                if (!v) return '<span style="color: var(--text-muted);">-</span>';
                let cssClass = 'grid-piece-pending';
                if (v === 'Done') cssClass = 'grid-piece-done';
                else if (v === 'Received') cssClass = 'grid-piece-received';
                return `<span class="grid-status-badge ${cssClass}">${escapeHtml(v)}</span>`;
            },
            valueSetter: (params) => {
                const newValue = (params.newValue || '').trim();
                if (['Pending', 'Done', 'Received'].includes(newValue)) {
                    params.data.piece_received = newValue;
                    saveOrderField(params.data.id, 'piece_received', newValue);
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                    return true;
                }
                return false;
            }
        },
        {
            headerName: 'Items',
            field: 'items',
            flex: 1,
            minWidth: 150,
            hide: true,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            valueGetter: (params) => {
                const lineItems = params.data.line_items;
                if (!Array.isArray(lineItems) || lineItems.length === 0) return '';
                return lineItems.map(li => {
                    const name = li.name || '';
                    const variant = li.variant_title && li.variant_title !== '-' ? ` - ${li.variant_title}` : '';
                    const qty = Number(li.qty) || 1;
                    const qtyStr = qty > 1 ? ` ×${qty}` : '';
                    return `${name}${variant}${qtyStr}`;
                }).join(', ');
            },
            cellRenderer: (params) => {
                if (params.value) {
                    return `<div class="grid-items-cell" title="${escapeHtml(params.value)}">${escapeHtml(params.value)}</div>`;
                }
                return '-';
            }
        },
        {
            headerName: 'Date',
            field: 'order_receiving_date',
            width: 130,
            hide: true,
            floatingFilter: false,
            filter: 'agDateColumnFilter',
            filterParams: {
                filterOptions: ['inRange'],
                defaultOption: 'inRange',
                browserDatePicker: true
            },
            valueGetter: (params) => {
                const date = params.data.order_receiving_date || params.data.created_at;
                return date ? new Date(date) : null;
            },
            valueFormatter: (params) => {
                if (params.value) {
                    return formatDateDDMMYYYY(params.value);
                }
                return '';
            }
        },
        {
            headerName: 'Status',
            field: 'final_status',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1
            },
            floatingFilterComponent: FinalStatusFloatingFilter,
            sortable: true,
            valueGetter: (params) => {
                if (params.data && params.data.id === '__footer__') return null;
                const order = params.data;
                const status = (order.order_status || '').toLowerCase();
                const pieceReceived = (order.piece_received || '').trim();
                
                // None for cancelled orders
                if (status === 'cancelled') {
                    return 'None';
                }
                
                const delivery = parseFloat(order.delivery_charge) || 0;
                
                // Green (OK) only in 2 scenarios (no receivable condition):
                // 1. Order is delivered AND delivery_charge is non-zero
                // 2. Order is returned AND delivery_charge is non-zero AND piece_received is "Received"
                if (status === 'delivered') {
                    if (delivery > 0) {
                        return 'OK';
                    }
                } else if (status === 'returned') {
                    if (delivery > 0 && pieceReceived === 'Received') {
                        return 'OK';
                    }
                }
                
                // Default: all orders are yellow (Warning)
                return 'Warning';
            },
            cellRenderer: (params) => {
                if (params.data && params.data.id === '__footer__') return '';
                const value = params.value || 'Warning';
                if (value === 'OK') {
                    return '<span style="font-size: 18px;">🟢</span>';
                } else if (value === 'None') {
                    return '<span style="color: var(--text-muted);">-</span>';
                } else {
                    return '<span style="font-size: 18px;">🔴</span>';
                }
            }
        },
    ];

    return columnDefs;
}
