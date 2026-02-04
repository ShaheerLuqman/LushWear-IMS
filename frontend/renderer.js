// API Configuration
const API_BASE = 'http://127.0.0.1:8000/api';

// State
let products = [];
let orders = [];
let currentView = 'orders';
let productsGridApi = null;
let ordersGridApi = null;
let updateFooterRow = null; // Will be set in initOrdersGrid
// Month-based pagination: period is month's 22 to next month's 21
let ordersPeriodMonth = null;
let ordersPeriodYear = null;

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const toast = document.getElementById('toast');


// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Show loading screen
    const loadingScreen = document.getElementById('loadingScreen');
    const appContainer = document.querySelector('.app-container');
    
    if (loadingScreen) {
        loadingScreen.style.display = 'flex';
    }
    
    // Hide main content completely until data is loaded
    if (appContainer) {
        appContainer.style.visibility = 'hidden';
        appContainer.style.opacity = '0';
    }
    
    initNavigation();
    initOrdersMonthNav();
    initForms();
    initGrids();
    
    // Load data in parallel - wait for both to complete successfully
    let productsLoaded = false;
    let ordersLoaded = false;
    
    const loadProductsPromise = loadProducts().then(() => {
        productsLoaded = true;
    }).catch(error => {
        console.error('Error loading products:', error);
        showToast('Failed to load products', 'error');
        productsLoaded = true;
    });
    
    const loadOrdersPromise = loadOrders().then(() => {
        ordersLoaded = true;
    }).catch(error => {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        ordersLoaded = true;
    });
    
    // Wait for both to complete
    await Promise.all([loadProductsPromise, loadOrdersPromise]);
    
    // Only show app when both are loaded
    if (productsLoaded && ordersLoaded) {
        switchView('orders');
        
        // Hide loading screen
        if (loadingScreen) {
            loadingScreen.style.display = 'none';
        }
        
        // Show app with fade-in
        if (appContainer) {
            appContainer.style.visibility = 'visible';
            setTimeout(() => {
                appContainer.style.opacity = '1';
            }, 10);
        }

        syncShopifyProducts();
        syncShopifyOrders();
    }
});

// ============================================
// AG Grid Initialization
// ============================================

function initGrids() {
    initProductsGrid();
    initOrdersGrid();
}

// Size order mapping for variant sorting
const sizeOrder = {
    'xxs': 1, 'xs': 2, 's': 3, 'small': 3,
    'm': 4, 'medium': 4, 'med': 4,
    'l': 5, 'large': 5,
    'xl': 6, 'x-large': 6,
    'xxl': 7, '2xl': 7,
    'xxxl': 8, '3xl': 8,
    '4xl': 9, '5xl': 10
};

function sortVariantsBySize(variants) {
    if (!variants || !Array.isArray(variants)) return [];
    return [...variants].sort((a, b) => {
        const titleA = (a.title || '').toLowerCase().trim();
        const titleB = (b.title || '').toLowerCase().trim();
        const orderA = sizeOrder[titleA] || 100;
        const orderB = sizeOrder[titleB] || 100;
        if (orderA !== 100 || orderB !== 100) {
            return orderA - orderB;
        }
        return titleA.localeCompare(titleB);
    });
}

function initProductsGrid() {
    const gridDiv = document.getElementById('productsGrid');
    if (!gridDiv) return;

    const columnDefs = [
        {
            headerName: 'Image',
            field: 'image_url',
            width: 80,
            filter: false,
            sortable: false,
            cellRenderer: (params) => {
                if (params.value) {
                    return `<div class="grid-image-cell"><img src="${escapeHtml(params.value)}" alt="Product"></div>`;
                }
                return '<div class="grid-image-cell"><div class="grid-image-placeholder">No Img</div></div>';
            }
        },
        {
            headerName: 'Product Name',
            field: 'name',
            flex: 2,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['contains', 'startsWith', 'endsWith'],
                defaultOption: 'contains'
            }
        },
        {
            headerName: 'Price (Rs)',
            field: 'price',
            width: 120,
            filter: 'agNumberColumnFilter',
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
        },
        {
            headerName: 'Variants',
            field: 'variants',
            flex: 2,
            filter: false,
            sortable: false,
            autoHeight: true,
            wrapText: true,
            cellRenderer: (params) => {
                const variants = params.value || [];
                if (variants.length === 0) {
                    return '<span class="grid-variant-tag">No variants</span>';
                }
                const sortedVariants = sortVariantsBySize(variants);
                return `<div class="grid-variants-container">${sortedVariants.map(v => {
                    const qty = v.quantity || 0;
                    const isLow = qty < 10;
                    return `<span class="grid-variant-tag ${isLow ? 'low' : ''}">${escapeHtml(v.title)}: ${qty}</span>`;
                }).join('')}</div>`;
            }
        },
        {
            headerName: 'Total Qty',
            field: 'total_quantity',
            width: 120,
            filter: 'agNumberColumnFilter',
            cellRenderer: (params) => {
                const qty = params.value || 0;
                const cssClass = qty < 10 ? 'low' : 'ok';
                return `<span class="grid-quantity-badge ${cssClass}">${qty}</span>`;
            }
        },
        {
            headerName: 'Cost Price (Rs)',
            field: 'cost_price',
            width: 140,
            filter: 'agNumberColumnFilter',
            editable: true,
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            valueSetter: (params) => {
                const newValue = parseFloat(params.newValue);
                if (!isNaN(newValue) && newValue >= 0) {
                    params.data.cost_price = newValue;
                    // Save to backend
                    saveCostPrice(params.data.id, newValue);
                    return true;
                }
                return false;
            }
        }
    ];

    const gridOptions = {
        columnDefs: columnDefs,
        rowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: true,
        paginationPageSize: 50,
        paginationPageSizeSelector: [25, 50, 100, 200],
        domLayout: 'normal',
        suppressCellFocus: false,
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        onGridReady: (params) => {
            productsGridApi = params.api;
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

// Custom floating filter for Order Status: shows a <select> dropdown in the filter row
const ORDER_STATUS_VALUES = ['unfulfilled', 'fulfilled', 'delivered', 'RFD', 'returned', 'CNA', 'ICA'];
function OrderStatusFloatingFilter() {}
OrderStatusFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.style.width = '100%';
    select.style.padding = '4px 6px';
    select.style.fontSize = '12px';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    select.appendChild(allOption);
    ORDER_STATUS_VALUES.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        const display = (v === 'RFD' || v === 'CNA' || v === 'ICA') ? v : (v.charAt(0).toUpperCase() + v.slice(1));
        opt.textContent = display;
        select.appendChild(opt);
    });
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: val };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
};
OrderStatusFloatingFilter.prototype.getGui = function () { return this.eGui; };
OrderStatusFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null || parentModel.filter === '') {
        this.select.value = '__all__';
    } else if (ORDER_STATUS_VALUES.indexOf(parentModel.filter) !== -1) {
        this.select.value = parentModel.filter;
    } else {
        this.select.value = '__all__';
    }
};

// Custom floating filter for Final Status: dropdown (OK, Warning, None, All)
const FINAL_STATUS_VALUES = ['OK', 'Warning', 'None'];
function FinalStatusFloatingFilter() {}
FinalStatusFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.style.width = '100%';
    select.style.padding = '4px 6px';
    select.style.fontSize = '12px';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    select.appendChild(allOption);
    FINAL_STATUS_VALUES.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
    });
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: val };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
};
FinalStatusFloatingFilter.prototype.getGui = function () { return this.eGui; };
FinalStatusFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null || parentModel.filter === '') {
        this.select.value = '__all__';
    } else if (FINAL_STATUS_VALUES.indexOf(parentModel.filter) !== -1) {
        this.select.value = parentModel.filter;
    } else {
        this.select.value = '__all__';
    }
};

// Custom floating filter for Piece Received: dropdown in the filter row
const PIECE_RECEIVED_VALUES = ['Pending', 'Done', 'Received'];
function PieceReceivedFloatingFilter() {}
PieceReceivedFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.style.width = '100%';
    select.style.padding = '4px 6px';
    select.style.fontSize = '12px';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    select.appendChild(allOption);
    PIECE_RECEIVED_VALUES.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
    });
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: val };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
};
PieceReceivedFloatingFilter.prototype.getGui = function () { return this.eGui; };
PieceReceivedFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null || parentModel.filter === '') {
        this.select.value = '__all__';
    } else if (PIECE_RECEIVED_VALUES.indexOf(parentModel.filter) !== -1) {
        this.select.value = parentModel.filter;
    } else {
        this.select.value = '__all__';
    }
};

function initOrdersGrid() {
    const gridDiv = document.getElementById('ordersGrid');
    if (!gridDiv) return;

    const numberFilterValueGetter = (params) => {
        const v = params.api.getValue(params.column.getColId(), params.node);
        return (v != null && v !== '') ? String(v) : '';
    };
    const textFilterContains = { filterOptions: ['contains'], defaultOption: 'contains' };

    const columnDefs = [
        {
            headerName: '',
            width: 48,
            minWidth: 48,
            maxWidth: 48,
            checkboxSelection: true,
            headerCheckboxSelection: true,
            headerCheckboxSelectionFilteredOnly: true,
            filter: false,
            sortable: false,
            floatingFilter: false,
            suppressSizeToFit: true
        },
        {
            headerName: 'Order #',
            field: 'order_number',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            cellStyle: { fontWeight: 'bold' }
        },
        {
            headerName: 'Courier',
            field: 'courier',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            valueFormatter: (params) => getCourierDisplayName(params.data || {})
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
                const order = params.data;
                const courier = order.courier || '';
                const hasCourier = courier && courier.trim() !== '' && courier.trim().toLowerCase() !== 'unassigned';
                if (!hasCourier) {
                    return '<span style="color: var(--text-muted);">-</span>';
                }
                const lastStatus = order.delivery_status;
                const hasStoredStatus = lastStatus && (lastStatus.latest_status || (lastStatus.status_history && lastStatus.status_history.length > 0));
                const statusText = hasStoredStatus
                    ? ((lastStatus.latest_status || (lastStatus.status_history && lastStatus.status_history[0] && lastStatus.status_history[0].status)) || '').trim()
                    : '';
                const displayStatus = statusText || '';
                const fetchedAt = hasStoredStatus && lastStatus.fetched_at
                    ? new Date(lastStatus.fetched_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                    : '';
                const isPostEx = (courier || '').trim().toUpperCase() === 'POSTEX';
                const courierEsc = (courier || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const trackEsc = (order.tracking_number || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const refreshBtn = isPostEx
                    ? `<button type="button" class="grid-delivery-refresh-btn" onclick="event.stopPropagation(); fetchDeliveryStatus('${order.id}', '${courierEsc}', '${trackEsc}')" title="Refresh status"><span>🔄</span></button>`
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
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
        },
        {
            headerName: 'Advance',
            field: 'advance_amount',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: false,
            cellStyle: { cursor: 'default' },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
            editable: true,
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
            editable: true,
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
                const status = (params.data.order_status || '').toLowerCase();
                const total = parseFloat(params.data.total_amount) || 0;
                const advance = parseFloat(params.data.advance_amount) || 0;
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                if (status === 'returned') return -delivery;
                return total - (advance + delivery + tax);
            },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellStyle: (params) => ({
                color: params.value >= 0 ? 'var(--text-primary)' : 'var(--danger)'
            })
        },
        {
            headerName: 'Cost Price',
            field: 'cost_price',
            width: 110,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
                const status = (params.data.order_status || '').toLowerCase();
                if (status === 'cancelled') return 0;
                const total = parseFloat(params.data.total_amount) || 0;
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                const cost = parseFloat(params.data.cost_price) || 0;
                if (status === 'returned') return -delivery;
                return total - (delivery + tax + cost);
            },
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
            cellClass: (params) => params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative'
        },
        {
            headerName: 'Profit %',
            field: 'profit_percent',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueGetter: (params) => {
                const status = (params.data.order_status || '').toLowerCase();
                const total = parseFloat(params.data.total_amount) || 0;
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                const cost = parseFloat(params.data.cost_price) || 0;
                let netProfit = status === 'returned' ? -delivery : total - (delivery + tax + cost);
                if (total > 0) return (netProfit / total) * 100;
                return 0;
            },
            valueFormatter: (params) => (params.value || 0).toFixed(1) + '%',
            cellClass: (params) => params.value >= 0 ? 'grid-profit-positive' : 'grid-profit-negative'
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
            editable: true,
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agSelectCellEditor',
            cellEditorParams: {
                values: ['Pending', 'Done', 'Received']
            },
            valueGetter: (params) => {
                const order = params.data;
                const status = (order.order_status || '').toLowerCase();
                if (status === 'delivered') return 'Done';
                const stored = (order.piece_received || '').trim();
                return ['Pending', 'Done', 'Received'].includes(stored) ? stored : 'Pending';
            },
            valueFormatter: (params) => params.value || '-',
            cellRenderer: (params) => {
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
                const items = params.data.items;
                if (items && Array.isArray(items) && items.length > 0) {
                    return items.join(', ');
                }
                return '';
            },
            cellRenderer: (params) => {
                if (params.value) {
                    return `<div class="grid-items-cell" title="${escapeHtml(params.value)}">${escapeHtml(params.value)}</div>`;
                }
                return '-';
            }
        },
        {
            headerName: 'Order Date',
            field: 'order_receiving_date',
            width: 130,
            hide: true,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: (params) => {
                const v = params.api.getValue(params.column.getColId(), params.node);
                if (v instanceof Date) return v.toISOString().slice(0, 10);
                if (v) return String(v).slice(0, 10);
                return '';
            },
            valueGetter: (params) => {
                const date = params.data.order_receiving_date || params.data.created_at;
                return date ? new Date(date) : null;
            },
            valueFormatter: (params) => {
                if (params.value) {
                    return params.value.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
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
                const value = params.value || 'Warning';
                if (value === 'OK') {
                    return '<span style="font-size: 18px;">🟢</span>';
                } else if (value === 'None') {
                    return '<span style="color: var(--text-muted);">-</span>';
                } else {
                    return '<span style="font-size: 18px;">🔴</span>';
                }
            }
        }
    ];

    // Function to calculate sums for selected rows
    function calculateSelectedSums() {
        if (!ordersGridApi) return {};
        
        const selectedRows = ordersGridApi.getSelectedRows();
        if (selectedRows.length === 0) {
            return {
                count: 0,
                total_amount: 0,
                advance_amount: 0,
                cod: 0,
                delivery_charge: 0,
                tax_amount: 0,
                receivable: 0,
                cost_price: 0,
                net_profit: 0
            };
        }
        
        let total_amount = 0;
        let advance_amount = 0;
        let delivery_charge = 0;
        let tax_amount = 0;
        let cost_price = 0;
        let cod = 0;
        let receivable = 0;
        let net_profit = 0;
        
        selectedRows.forEach(row => {
            const status = (row.order_status || '').toLowerCase();
            const rowTotal = parseFloat(row.total_amount) || 0;
            const rowAdvance = parseFloat(row.advance_amount) || 0;
            const rowDelivery = parseFloat(row.delivery_charge) || 0;
            const rowTax = parseFloat(row.tax_amount) || 0;
            const rowCost = parseFloat(row.cost_price) || 0;
            
            total_amount += rowTotal;
            advance_amount += rowAdvance;
            delivery_charge += rowDelivery;
            tax_amount += rowTax;
            cost_price += rowCost;
            
            // Calculate cod per row (0 for returned orders)
            if (status !== 'returned') {
                cod += rowTotal - rowAdvance;
            }
            
            // Calculate receivable per row
            if (status === 'returned') {
                receivable += -rowDelivery;
            } else {
                receivable += rowTotal - (rowAdvance + rowDelivery + rowTax);
            }
            
            // Calculate net profit per row
            if (status === 'cancelled') {
                // Net profit is 0 for cancelled orders
            } else if (status === 'returned') {
                net_profit += -rowDelivery;
            } else {
                net_profit += rowTotal - (rowDelivery + rowTax + rowCost);
            }
        });
        
        return {
            count: selectedRows.length,
            total_amount,
            advance_amount,
            cod,
            delivery_charge,
            tax_amount,
            receivable,
            cost_price,
            net_profit
        };
    }
    
    // Function to update footer row (make it accessible globally)
    updateFooterRow = function() {
        if (!ordersGridApi) return;
        
        const sums = calculateSelectedSums();
        const selectedCount = sums.count;
        
        // Update selected count text at bottom right
        const selectedCountEl = document.getElementById('ordersSelectedCount');
        if (selectedCountEl) {
            selectedCountEl.textContent = `${selectedCount} row(s) selected`;
            selectedCountEl.style.display = selectedCount > 0 ? 'block' : 'none';
        }
        
        const footerData = {
            id: '__footer__',
            // order_number omitted - not numeric, do not show in footer
            courier: '',
            tracking_number: '',
            order_status: '',
            delivery_status: '',
            total_amount: sums.total_amount,
            advance_amount: sums.advance_amount,
            cod: sums.cod,
            delivery_charge: sums.delivery_charge,
            tax_amount: sums.tax_amount,
            receivable: sums.receivable,
            cost_price: sums.cost_price,
            net_profit: sums.net_profit,
            profit_percent: sums.total_amount > 0 ? (sums.net_profit / sums.total_amount) * 100 : 0,
            piece_received: '',
            items: '',
            order_receiving_date: '',
            final_status: ''
        };
        
        ordersGridApi.setGridOption('pinnedBottomRowData', selectedCount > 0 ? [footerData] : []);
    }
    
    // Update column definitions to add footer cell renderers
    columnDefs.forEach(col => {
        // Skip checkbox column
        if (col.checkboxSelection) {
            col.pinnedRowCellRenderer = () => '';
            return;
        }
        
        if (col.field === 'order_number') {
            // Order number is not numeric - show nothing in footer
            col.pinnedRowCellRenderer = () => '<span></span>';
        } else if (['total_amount', 'advance_amount', 'cod', 'delivery_charge', 'tax_amount', 'receivable', 'cost_price', 'net_profit'].includes(col.field)) {
            col.pinnedRowCellRenderer = (params) => {
                const val = parseFloat(params.value) || 0;
                const formatted = val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return `<div style="font-weight: bold; padding: 8px; text-align: right;">${formatted}</div>`;
            };
        } else if (col.field === 'profit_percent') {
            col.pinnedRowCellRenderer = (params) => {
                const val = parseFloat(params.value) || 0;
                const formatted = val.toFixed(1) + '%';
                return `<div style="font-weight: bold; padding: 8px; text-align: right;">${formatted}</div>`;
            };
        } else {
            col.pinnedRowCellRenderer = () => '';
        }
    });

    const gridOptions = {
        columnDefs: columnDefs,
        rowData: [],
        rowSelection: 'multiple',
        suppressRowClickSelection: true,
        pinnedBottomRowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 70,
            suppressHeaderMenuButton: true,
            suppressHeaderFilterButton: true,
            suppressFloatingFilterButton: true,
            floatingFilterComponentParams: { suppressFilterButton: true }
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        suppressCellFocus: false,
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        getRowStyle: (params) => {
            if (params.data.id === '__footer__') {
                return { 
                    backgroundColor: 'var(--bg-secondary, #f5f5f5)', 
                    borderTop: '2px solid var(--primary, #007bff)',
                    fontWeight: 'bold'
                };
            }
            const status = (params.data.order_status || '').toLowerCase();
            if (status === 'cancelled') {
                return { opacity: '0.5', textDecoration: 'line-through' };
            }
            return null;
        },
        onGridReady: (params) => {
            ordersGridApi = params.api;
            updateFooterRow();
        },
        onSelectionChanged: () => {
            updateFooterRow();
        },
        onCellValueChanged: () => {
            // Update footer when cell values change (e.g., after editing)
            setTimeout(() => updateFooterRow(), 0);
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

// ============================================
// Save Functions for Editable Cells
// ============================================

async function saveCostPrice(productId, costPrice) {
    try {
        const response = await fetch(`${API_BASE}/products/batch-update-cost-prices`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: [{ id: productId, cost_price: costPrice }] })
        });

        if (!response.ok) {
            throw new Error('Failed to update cost price');
        }

        showToast('Cost price updated', 'success');
    } catch (error) {
        console.error('Error saving cost price:', error);
        showToast('Failed to save cost price', 'error');
    }
}

async function saveOrderField(orderId, field, value) {
    try {
        const response = await fetch(`${API_BASE}/orders/${orderId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value })
        });

        if (!response.ok) {
            throw new Error(`Failed to update ${field}`);
        }

        showToast(`Order ${field.replace('_', ' ')} updated`, 'success');
    } catch (error) {
        console.error(`Error saving ${field}:`, error);
        showToast(`Failed to save ${field}`, 'error');
    }
}

// ============================================
// Navigation
// ============================================

function initNavigation() {
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
        });
    });
}

function initOrdersMonthNav() {
    const prevBtn = document.getElementById('ordersMonthPrev');
    const nextBtn = document.getElementById('ordersMonthNext');
    if (prevBtn) prevBtn.addEventListener('click', ordersMonthPrev);
    if (nextBtn) nextBtn.addEventListener('click', ordersMonthNext);
}

function switchView(viewName) {
    currentView = viewName;

    // Update nav
    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Update views
    views.forEach(view => {
        view.classList.toggle('active', view.id === `${viewName}View`);
    });

    // Update header
    const titles = {
        'dashboard': { title: 'Dashboard', subtitle: 'Overview of your inventory' },
        'orders': { title: 'Orders', subtitle: 'View and manage orders' },
        'products': { title: 'Products', subtitle: 'Manage your product catalog' }
    };

    document.getElementById('viewTitle').textContent = titles[viewName].title;
    document.getElementById('viewSubtitle').textContent = titles[viewName].subtitle;

    // Show/hide buttons based on view
    const editCostPricesBtn = document.getElementById('editCostPricesBtn');
    const syncProductsBtn = document.getElementById('syncShopifyBtn');
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    const uploadPostExCsvBtn = document.getElementById('uploadPostExCsvBtn');
    
    if (editCostPricesBtn) {
        editCostPricesBtn.style.display = 'none'; // Hide since editing is inline now
    }
    
    const ordersMonthNav = document.getElementById('ordersMonthNav');
    const ordersFullScreenBtn = document.getElementById('ordersFullScreenBtn');
    if (syncProductsBtn && syncOrdersBtn) {
        if (viewName === 'products') {
            syncProductsBtn.style.display = 'inline-flex';
            syncOrdersBtn.style.display = 'none';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'none';
            if (ordersMonthNav) ordersMonthNav.style.display = 'none';
            if (ordersFullScreenBtn) ordersFullScreenBtn.style.display = 'none';
            exitOrdersFullScreen();
        } else if (viewName === 'orders') {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'inline-flex';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'inline-flex';
            if (ordersMonthNav) ordersMonthNav.style.display = 'flex';
            if (ordersFullScreenBtn) ordersFullScreenBtn.style.display = 'inline-flex';
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'inline-flex';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
        } else {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'none';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'none';
            if (ordersMonthNav) ordersMonthNav.style.display = 'none';
            if (ordersFullScreenBtn) ordersFullScreenBtn.style.display = 'none';
            exitOrdersFullScreen();
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'none';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
        }
    }

    // Refresh data and resize grids when switching views
    if (viewName === 'products') {
        loadProducts();
        setTimeout(() => {
            if (productsGridApi) productsGridApi.sizeColumnsToFit();
        }, 100);
    } else if (viewName === 'orders') {
        loadOrders();
        setTimeout(() => {
            if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
        }, 100);
    } else if (viewName === 'dashboard') {
        loadProducts();
    }
}

// ============================================
// API Functions
// ============================================

async function loadProducts() {
    try {
        const response = await fetch(`${API_BASE}/products/`);
        if (!response.ok) throw new Error('Failed to fetch products');

        products = await response.json();
        products.sort((a, b) => {
            const nameA = (a.name || '').toLowerCase();
            const nameB = (b.name || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });
        
        updateDashboard();
        
        // Update AG Grid
        if (productsGridApi) {
            productsGridApi.setGridOption('rowData', products);
        }
    } catch (error) {
        console.error('Error loading products:', error);
        showToast('Failed to load products', 'error');
    }
}

function getOrdersPeriodForToday() {
    const d = new Date();
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    if (day >= 22) return { month, year };
    if (month === 1) return { month: 12, year: year - 1 };
    return { month: month - 1, year };
}

function formatOrdersPeriodLabel(month, year) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${monthNames[month - 1]} 22 – ${monthNames[nextMonth - 1]} 21, ${nextMonth === 1 ? nextYear : year}`;
}

function updateOrdersMonthLabel() {
    if (ordersPeriodMonth == null || ordersPeriodYear == null) return;
    const el = document.getElementById('ordersMonthLabel');
    if (el) el.textContent = formatOrdersPeriodLabel(ordersPeriodMonth, ordersPeriodYear);
}

async function loadOrders() {
    if (ordersPeriodMonth == null || ordersPeriodYear == null) {
        const { month, year } = getOrdersPeriodForToday();
        ordersPeriodMonth = month;
        ordersPeriodYear = year;
    }
    updateOrdersMonthLabel();
    if (ordersGridApi) ordersGridApi.showLoadingOverlay();
    try {
        const url = `${API_BASE}/orders/?month=${ordersPeriodMonth}&year=${ordersPeriodYear}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch orders');

        orders = await response.json();

        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            // Update footer after data is loaded
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            if (ordersGridApi) {
                ordersGridApi.setGridOption('rowData', orders);
                // Update footer after data is loaded
                setTimeout(() => updateFooterRow(), 0);
            }
        }
    } finally {
        if (ordersGridApi) ordersGridApi.hideOverlay();
    }
}

function ordersMonthPrev() {
    if (ordersPeriodMonth === 1) {
        ordersPeriodMonth = 12;
        ordersPeriodYear -= 1;
    } else {
        ordersPeriodMonth -= 1;
    }
    loadOrders();
}

function ordersMonthNext() {
    if (ordersPeriodMonth === 12) {
        ordersPeriodMonth = 1;
        ordersPeriodYear += 1;
    } else {
        ordersPeriodMonth += 1;
    }
    loadOrders();
}

function getSampleOrders() {
    return [
        { id: '1', order_number: 2719, courier: '1289', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 4247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '2', order_number: 2720, courier: 'RIDER', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 7697, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '3', order_number: 2721, courier: '1287', order_status: 'unfulfilled', piece_received: 'Pending', delivery_status: 'not_delivered', total_amount: 3248, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '4', order_number: 2722, courier: 'RIDER', order_status: 'fulfilled', piece_received: 'Done', delivery_status: 'delivered', total_amount: 8247, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '5', order_number: 2724, courier: '1293', order_status: 'returned', piece_received: 'Received', delivery_status: 'not_delivered', total_amount: 3247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() }
    ];
}

async function syncShopifyProducts() {
    const btn = document.getElementById('syncShopifyBtn');
    const originalText = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = '<span style="margin-right: 8px;">⏳</span>Syncing...';

    try {
        const response = await fetch(`${API_BASE}/products/sync-shopify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to sync products from Shopify');
        }

        const result = await response.json();
        const productsInfo = result.products || {};
        const variantsInfo = result.variants || {};
        showToast(
            `Sync complete! Products: ${productsInfo.created || 0} created, ${productsInfo.updated || 0} updated. Variants: ${variantsInfo.created || 0} created, ${variantsInfo.updated || 0} updated.`,
            'success'
        );

        loadProducts();
    } catch (error) {
        console.error('Error syncing Shopify products:', error);
        showToast(error.message || 'Failed to sync products from Shopify', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function syncShopifyOrders() {
    const btn = document.getElementById('syncOrdersBtn');
    if (!btn) return;

    const originalText = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = '<span style="margin-right: 8px;">⏳</span>Syncing...';

    try {
        const response = await fetch(`${API_BASE}/orders/sync-shopify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to sync orders from Shopify');
        }

        const result = await response.json();
        showToast(
            `Sync complete! ${result.synced} orders synced (${result.created} created, ${result.updated} updated)`,
            'success'
        );

        loadOrders();
    } catch (error) {
        console.error('Error syncing Shopify orders:', error);
        showToast(error.message || 'Failed to sync orders from Shopify', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function uploadPostExCsv(file) {
    const btn = document.getElementById('uploadPostExCsvBtn');
    const originalText = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span style="margin-right: 8px;">⏳</span>Uploading...';
    }
    try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`${API_BASE}/orders/upload-postex-csv`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = Array.isArray(data.detail) ? data.detail.map(d => d.msg || d).join(' ') : data.detail;
            throw new Error(detail || response.statusText || 'Upload failed');
        }
        showToast(data.message || `Updated ${data.updated || 0} order(s).`, 'success');
        
        // Store updated order IDs to select them after reload
        const updatedOrderIds = data.updated_order_ids || [];
        
        await loadOrders();
        
        // Select the updated rows in the grid
        if (ordersGridApi && updatedOrderIds.length > 0) {
            // Wait a bit for the grid to finish rendering
            setTimeout(() => {
                if (ordersGridApi) {
                    // Clear existing selection
                    ordersGridApi.deselectAll();
                    
                    // Select rows by their IDs
                    ordersGridApi.forEachNode(node => {
                        if (updatedOrderIds.includes(node.data.id)) {
                            node.setSelected(true);
                        }
                    });
                    
                    // Scroll to first selected row if any
                    const selectedRows = ordersGridApi.getSelectedRows();
                    if (selectedRows.length > 0) {
                        ordersGridApi.ensureNodeVisible(selectedRows[0], 'middle');
                    }
                }
            }, 100);
        }
    } catch (error) {
        console.error('Error uploading PostEx CSV', error);
        showToast(error.message || 'Failed to upload PostEx CSV', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// ============================================
// UI Updates
// ============================================

function updateDashboard() {
    const totalProducts = products.length;
    const totalStock = products.reduce((sum, p) => sum + (p.total_quantity || 0), 0);
    const lowStock = products.filter(p => (p.total_quantity || 0) < 10).length;
    const totalValue = products.reduce((sum, p) => sum + ((p.price || 0) * (p.total_quantity || 0)), 0);

    document.getElementById('totalProducts').textContent = totalProducts;
    document.getElementById('totalStock').textContent = totalStock.toLocaleString();
    document.getElementById('lowStock').textContent = lowStock;
    document.getElementById('totalValue').textContent = `Rs ${Math.round(totalValue).toLocaleString()}`;
}

// ============================================
// Forms
// ============================================

function initForms() {
    // Sync Shopify Products Button
    const syncBtn = document.getElementById('syncShopifyBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            await syncShopifyProducts();
        });
    }

    // Sync Shopify Orders Button
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    if (syncOrdersBtn) {
        syncOrdersBtn.addEventListener('click', async () => {
            await syncShopifyOrders();
        });
    }

    // Upload PostEx CSV Button
    const uploadPostExCsvBtn = document.getElementById('uploadPostExCsvBtn');
    const postExCsvInput = document.getElementById('postExCsvInput');
    if (uploadPostExCsvBtn && postExCsvInput) {
        uploadPostExCsvBtn.addEventListener('click', () => postExCsvInput.click());
        postExCsvInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            await uploadPostExCsv(file);
        });
    }

    // Refresh delivery status for selected orders
    const refreshDeliveryStatusSelectedBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
    if (refreshDeliveryStatusSelectedBtn) {
        refreshDeliveryStatusSelectedBtn.addEventListener('click', () => refreshDeliveryStatusSelected());
    }

    // Order table full screen toggle (icon only; Esc to exit)
    const ordersFullScreenBtn = document.getElementById('ordersFullScreenBtn');
    if (ordersFullScreenBtn) {
        ordersFullScreenBtn.addEventListener('click', toggleOrdersFullScreen);
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('orders-table-fullscreen')) {
            exitOrdersFullScreen();
        }
    });
    if (window.electronAPI && window.electronAPI.onFullScreenChange) {
        window.electronAPI.onFullScreenChange((isFullScreen) => {
            if (!isFullScreen) syncOrdersFullScreenExit();
        });
    }
}

function toggleOrdersFullScreen() {
    if (document.body.classList.contains('orders-table-fullscreen')) {
        exitOrdersFullScreen();
    } else {
        document.body.classList.add('orders-table-fullscreen');
        if (window.electronAPI && window.electronAPI.setFullScreen) {
            window.electronAPI.setFullScreen(true);
        }
        setTimeout(() => {
            if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
        }, 100);
    }
}

/** Sync UI when fullscreen was exited by ESC or native leave-full-screen. Do not call setFullScreen(false). */
function syncOrdersFullScreenExit() {
    document.body.classList.remove('orders-table-fullscreen');
    setTimeout(() => {
        if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
    }, 100);
}

/** Exit fullscreen when user clicks the fullscreen button (we tell Electron to leave fullscreen). */
function exitOrdersFullScreen() {
    document.body.classList.remove('orders-table-fullscreen');
    if (window.electronAPI && window.electronAPI.setFullScreen) {
        window.electronAPI.setFullScreen(false);
    }
    setTimeout(() => {
        if (ordersGridApi) ordersGridApi.sizeColumnsToFit();
    }, 100);
}

// ============================================
// Modal
// ============================================

function closeModal() {
    document.getElementById('editModal').classList.remove('active');
}

// Close modal on backdrop click
document.getElementById('editModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'editModal') {
        closeModal();
    }
});

// ============================================
// Toast
// ============================================

function showToast(message, type = 'info') {
    toast.textContent = message;
    toast.className = `toast ${type} show`;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** When courier is "Other" and tracking_number is not purely numeric, show tracking_number in the Courier column. */
function getCourierDisplayName(order) {
    if (!order) return '-';
    const courier = (order.courier != null) ? String(order.courier).trim() : '';
    const tracking = (order.tracking_number != null) ? String(order.tracking_number).trim() : '';
    const isOther = courier.toLowerCase() === 'other';
    const trackingIsNotNumeric = tracking !== '' && !/^\d+$/.test(tracking);
    if (isOther && trackingIsNotNumeric) return tracking;
    return courier || '-';
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ============================================
// Delivery Status Functions
// ============================================

/** True if delivery status contains "Return to KARACHI" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesReturned(data) {
    if (!data) return false;
    const needle = 'Return to KARACHI';
    if ((data.latest_status || '').includes(needle)) return true;
    const history = data.status_history || [];
    for (const item of history) {
        if ((item.status || '').includes(needle)) return true;
    }
    return false;
}

/** True if delivery status contains "Delivered to Customer" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesDelivered(data) {
    if (!data) return false;
    const needle = 'Delivered to Customer';
    if ((data.latest_status || '').includes(needle)) return true;
    const history = data.status_history || [];
    for (const item of history) {
        if ((item.status || '').includes(needle)) return true;
    }
    return false;
}

/** True if delivery status contains "Attempt Made: RFD" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesRFD(data) {
    if (!data) return false;
    const needle = 'Attempt Made: RFD';
    if ((data.latest_status || '').includes(needle)) return true;
    const history = data.status_history || [];
    for (const item of history) {
        if ((item.status || '').includes(needle)) return true;
    }
    return false;
}

/** True if delivery status contains "Attempt Made: ICA" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesICA(data) {
    if (!data) return false;
    const needle = 'Attempt Made: ICA';
    if ((data.latest_status || '').includes(needle)) return true;
    const history = data.status_history || [];
    for (const item of history) {
        if ((item.status || '').includes(needle)) return true;
    }
    return false;
}

/** True if delivery status contains "Attempt Made: CNA" anywhere (latest_status or status_history). */
function deliveryStatusIndicatesCNA(data) {
    if (!data) return false;
    const needle = 'Attempt Made: CNA';
    if ((data.latest_status || '').includes(needle)) return true;
    const history = data.status_history || [];
    for (const item of history) {
        if ((item.status || '').includes(needle)) return true;
    }
    return false;
}

/** Fetch delivery status for one order (no modal). Returns data or throws. */
async function fetchDeliveryStatusForOrder(orderId, courier, trackingNumber) {
    const url = `${API_BASE}/orders/${orderId}/delivery-status?save=true`;
    const response = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const detail = Array.isArray(error.detail) ? error.detail.join(' ') : (error.detail || 'Failed to fetch delivery status');
        throw new Error(detail);
    }
    return response.json();
}

/** Refresh delivery status for all selected orders: sequential fetch, row-by-row update, progress shown. No modals. */
async function refreshDeliveryStatusSelected() {
    if (!ordersGridApi) return;
    const selected = ordersGridApi.getSelectedRows();
    const toFetch = selected.filter(row => {
        const courier = (row.courier || '').trim();
        const track = (row.tracking_number || '').trim();
        return courier && courier.toUpperCase() === 'POSTEX' && track && track !== '-';
    });
    if (toFetch.length === 0) {
        showToast('Select PostEx orders with tracking number to refresh delivery status', 'warning');
        return;
    }
    const progressEl = document.getElementById('deliveryRefreshProgress');
    const btn = document.getElementById('refreshDeliveryStatusSelectedBtn');
    if (progressEl) progressEl.style.display = 'inline';
    if (btn) btn.disabled = true;
    const total = toFetch.length;
    let fetched = 0;
    const updateProgress = () => {
        if (progressEl) progressEl.textContent = `Fetched ${fetched} / ${total}`;
    };
    updateProgress();
    for (const order of toFetch) {
        try {
            const data = await fetchDeliveryStatusForOrder(order.id, order.courier, order.tracking_number);
            ordersGridApi.forEachNode(node => {
                if (node.data && node.data.id === order.id) {
                    const updated = { ...node.data, delivery_status: data };
                    // Check delivery status and update order_status accordingly
                    // Priority: Return > Delivered > RFD > ICA > CNA
                    if (deliveryStatusIndicatesReturned(data)) {
                        updated.order_status = 'returned';
                    } else if (deliveryStatusIndicatesDelivered(data)) {
                        updated.order_status = 'delivered';
                        updated.piece_received = 'Done';
                    } else if (deliveryStatusIndicatesRFD(data)) {
                        updated.order_status = 'RFD';
                    } else if (deliveryStatusIndicatesICA(data)) {
                        updated.order_status = 'ICA';
                    } else if (deliveryStatusIndicatesCNA(data)) {
                        updated.order_status = 'CNA';
                    }
                    node.setData(updated);
                }
            });
        } catch (err) {
            console.warn('Delivery status fetch failed for order', order.id, err.message);
        }
        fetched += 1;
        updateProgress();
    }
    if (progressEl) progressEl.style.display = 'none';
    if (btn) btn.disabled = false;
    showToast(`Updated delivery status for ${fetched} of ${total} selected orders`, 'success');
}

async function fetchDeliveryStatus(orderId, courier, trackingNumber) {
    console.log('fetchDeliveryStatus called with:', { orderId, courier, trackingNumber });
    
    if (!orderId) {
        showToast('Order ID not available', 'error');
        return;
    }
    
    if ((courier || '').trim().toUpperCase() !== 'POSTEX') {
        showToast('Delivery status is only available for PostEx courier', 'warning');
        return;
    }
    
    if (!trackingNumber || trackingNumber === '' || trackingNumber === '-') {
        showToast('Tracking number not available', 'error');
        return;
    }
    
    const modal = document.getElementById('deliveryStatusModal');
    const content = document.getElementById('deliveryStatusContent');
    
    if (!modal || !content) {
        console.error('Modal elements not found');
        showToast('Error: Modal not found', 'error');
        return;
    }
    
    modal.style.display = 'flex';
    content.innerHTML = '<div class="loading">Fetching delivery status...</div>';
    
    try {
        const url = `${API_BASE}/orders/${orderId}/delivery-status?save=true`;
        console.log('Making request to:', url);
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('Response status:', response.status);
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const detail = Array.isArray(error.detail) ? error.detail.join(' ') : (error.detail || 'Failed to fetch delivery status');
            throw new Error(detail);
        }
        
        const data = await response.json();
        console.log('Received data:', data);
        displayDeliveryStatus(data, orderId);
        // Update order in grid: Delivery, Piece With, order_status (backend already saved when save=true)
        if (ordersGridApi) {
            ordersGridApi.forEachNode(node => {
                if (node.data && node.data.id === orderId) {
                    const updated = { ...node.data, delivery_status: data };
                    // Check delivery status and update order_status accordingly
                    // Priority: Return > Delivered > RFD > ICA > CNA
                    if (deliveryStatusIndicatesReturned(data)) {
                        updated.order_status = 'returned';
                    } else if (deliveryStatusIndicatesDelivered(data)) {
                        updated.order_status = 'delivered';
                        updated.piece_received = 'Done';
                    } else if (deliveryStatusIndicatesRFD(data)) {
                        updated.order_status = 'RFD';
                    } else if (deliveryStatusIndicatesICA(data)) {
                        updated.order_status = 'ICA';
                    } else if (deliveryStatusIndicatesCNA(data)) {
                        updated.order_status = 'CNA';
                    }
                    node.setData(updated);
                }
            });
        }
    } catch (error) {
        console.error('Error fetching delivery status:', error);
        content.innerHTML = `<div class="error-message">Error: ${escapeHtml(error.message)}</div>`;
    }
}

function displayDeliveryStatus(data, orderId) {
    const content = document.getElementById('deliveryStatusContent');
    const courierSafe = (data.courier || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const trackingSafe = (data.tracking_number || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    
    let html = `
        <div class="delivery-status-info">
            <div class="info-row">
                <strong>Courier:</strong> ${escapeHtml(data.courier || '')}
            </div>
            <div class="info-row">
                <strong>Tracking Number:</strong> ${escapeHtml(data.tracking_number || '')}
            </div>
    `;
    
    if (data.customer_name) {
        html += `<div class="info-row"><strong>Customer Name:</strong> ${escapeHtml(data.customer_name)}</div>`;
    }
    if (data.recipient_name) {
        html += `<div class="info-row"><strong>Recipient Name:</strong> ${escapeHtml(data.recipient_name)}</div>`;
    }
    if (data.recipient_contact) {
        html += `<div class="info-row"><strong>Recipient Contact:</strong> ${escapeHtml(data.recipient_contact)}</div>`;
    }
    if (data.order_pickup_date) {
        html += `<div class="info-row"><strong>Pickup Date:</strong> ${escapeHtml(data.order_pickup_date)}</div>`;
    }
    
    html += `</div><h3 style="margin-top: 20px; margin-bottom: 10px;">Status History</h3><div class="status-timeline">`;
    
    if (data.status_history && data.status_history.length > 0) {
        data.status_history.forEach((status, index) => {
            const isActive = status.is_active || index === 0;
            html += `
                <div class="timeline-item ${isActive ? 'active' : ''}">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                        <div class="timeline-date">${escapeHtml(status.datetime || '')}</div>
                        <div class="timeline-status">${escapeHtml(status.status || '')}</div>
                    </div>
                </div>
            `;
        });
    } else {
        html += '<div class="no-status">No status history available</div>';
    }
    
    html += '</div>';
    html += `<div class="delivery-status-modal-actions"><button type="button" class="btn btn-primary delivery-status-btn" onclick="fetchDeliveryStatus('${orderId}', '${courierSafe}', '${trackingSafe}')">Refresh status</button></div>`;
    content.innerHTML = html;
}

function closeDeliveryStatusModal() {
    const modal = document.getElementById('deliveryStatusModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Close modal when clicking outside or on close button
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('deliveryStatusModal');
    const closeButton = document.getElementById('closeDeliveryStatusModal');
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeDeliveryStatusModal();
            }
        });
    }
    
    if (closeButton) {
        closeButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeDeliveryStatusModal();
        });
    }
});

// Make functions globally accessible
window.closeModal = closeModal;
window.syncShopifyProducts = syncShopifyProducts;
window.fetchDeliveryStatus = fetchDeliveryStatus;
window.closeDeliveryStatusModal = closeDeliveryStatusModal;
