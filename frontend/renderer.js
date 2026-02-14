// API Configuration
const API_BASE = 'http://127.0.0.1:8000/api';

// State
let products = [];
let orders = [];
let cashbookEntries = [];
let cashbookDailyBalance = null; // Current day's balance from API
let cashbookSelectedDate = null;
let currentView = 'orders';
let productsGridApi = null;
let ordersGridApi = null;
let cashbookIncomingGridApi = null;
let cashbookOutgoingGridApi = null;
let ledgers = [];
let ledgerEntries = [];
let currentLedger = null;
let ledgerDetailGridApi = null;
let updateFooterRow = null; // Will be set in initOrdersGrid
// Auto-sync orders every 15 minutes; timer is reset when user clicks sync
const ORDERS_AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
let ordersAutoSyncTimerId = null;

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
    initOrdersPeriodFilter();
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
        scheduleOrdersAutoSync();
    }
});

// ============================================
// AG Grid Initialization
// ============================================

function initGrids() {
    initProductsGrid();
    initOrdersGrid();
    initCashbookIncomingGrid();
    initCashbookOutgoingGrid();
    initLedgerDetailGrid();
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

function formatAmount(value) {
    const val = parseFloat(value);
    const safeVal = Number.isNaN(val) ? 0 : val;
    return safeVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseCashbookAmount(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).replace(/,/g, '').trim();
    if (raw === '') return null;
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) return null;
    return parsed;
}

function formatCashbookCell(value) {
    if (value === null || value === undefined || value === '') return '';
    return formatAmount(value);
}

function getPKTDate() {
    // Pakistan Standard Time is UTC+5
    const now = new Date();
    const pktOffset = 5 * 60; // PKT is UTC+5 in minutes
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const pkt = new Date(utc + (pktOffset * 60000));
    return pkt;
}

function getPKTDateString() {
    const pkt = getPKTDate();
    const year = pkt.getFullYear();
    const month = String(pkt.getMonth() + 1).padStart(2, '0');
    const day = String(pkt.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getPKTISOString() {
    const pkt = getPKTDate();
    return pkt.toISOString();
}

function getTodayDateString() {
    return getPKTDateString();
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
const ORDER_STATUS_VALUES = ['unfulfilled', 'fulfilled', 'delivered', 'RFD', 'returned', 'cancelled', 'CNA', 'ICA'];
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
                if (params.data && params.data.id === '__footer__') return params.data.receivable;
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
                if (params.data && params.data.id === '__footer__') return params.data.profit_percent;
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

    // Function to calculate sums for selected rows (cancelled rows are excluded from sums)
    function calculateSelectedSums() {
        if (!ordersGridApi) return {};
        
        const selectedRows = ordersGridApi.getSelectedRows();
        const rowsForSum = selectedRows.filter(
            (row) => (row.order_status || '').toLowerCase() !== 'cancelled'
        );
        if (rowsForSum.length === 0) {
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
        
        rowsForSum.forEach(row => {
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
            count: rowsForSum.length,
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
        onSelectionChanged: (params) => {
            // Ensure only filtered rows are selected - deselect any non-filtered rows
            if (!params.api) {
                updateFooterRow();
                return;
            }
            
            const selectedNodes = params.api.getSelectedNodes();
            if (selectedNodes.length === 0) {
                updateFooterRow();
                return;
            }
            
            const filteredNodeIds = new Set();
            
            // Build a set of all node IDs that pass the current filter
            params.api.forEachNodeAfterFilter((node) => {
                if (node.data && node.data.id !== '__footer__') {
                    filteredNodeIds.add(node.id);
                }
            });
            
            // Deselect any selected node that doesn't pass the filter
            let hasNonFilteredSelected = false;
            selectedNodes.forEach(node => {
                if (node.data && node.data.id !== '__footer__') {
                    if (!filteredNodeIds.has(node.id)) {
                        hasNonFilteredSelected = true;
                        node.setSelected(false);
                    }
                }
            });
            
            // Update footer (will be called again if selection changed due to deselection, but that's fine)
            updateFooterRow();
        },
        onCellValueChanged: () => {
            // Update footer when cell values change (e.g., after editing)
            setTimeout(() => updateFooterRow(), 0);
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

function isCashbookSystemOrFooterRow(data) {
    if (!data || !data.id) return false;
    const id = String(data.id);
    return id === '__opening__' || id === '__closing__' || id === '__total_in__' || id === '__total_out__' || data._isSystemRow || data._isFooter;
}

function getLedgerNameById(id) {
    if (!id) return '';
    const ledger = ledgers.find(l => l.id === id);
    return ledger ? ledger.name : '';
}

function isCashbookNewRow(data) {
    return data && data.id && String(data.id).startsWith('__new_');
}

/**
 * Folio cell renderer using custom searchable dropdown.
 * Creates a clean, native-feeling dropdown with search functionality.
 */
function createFolioCellRenderer(params, entryType) {
    if (!params || !params.data) return document.createElement('span');
    if (params.node && params.node.rowPinned === 'bottom') return document.createElement('span');
    if (isCashbookSystemOrFooterRow(params.data)) return document.createElement('span');

    const wrapper = document.createElement('div');
    wrapper.className = 'folio-dropdown';

    const currentFolio = params.data.folio || '';
    const currentLedger = ledgers.find(l => l.id === currentFolio);
    const displayText = currentLedger ? currentLedger.name : 'Select ledger... *';

    // Check if this is a new row with other fields filled but no folio - highlight as required
    const isNewRow = isCashbookNewRow(params.data);
    const hasFolio = !!currentFolio;
    const hasOtherData = (params.data.description && String(params.data.description).trim() !== '') || 
                         (params.data.amount != null && params.data.amount > 0);
    const needsHighlight = isNewRow && !hasFolio && hasOtherData;

    // Main button that shows current selection
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'folio-dropdown-btn' + (needsHighlight ? ' folio-required' : '');
    button.innerHTML = `<span class="folio-dropdown-text">${escapeHtml(displayText)}</span><span class="folio-dropdown-arrow">▼</span>`;

    // Dropdown panel (will be appended to body when opened)
    let dropdownPanel = null;
    let isOpen = false;

    function closeDropdown() {
        if (dropdownPanel && dropdownPanel.parentNode) {
            dropdownPanel.parentNode.removeChild(dropdownPanel);
        }
        dropdownPanel = null;
        isOpen = false;
        button.classList.remove('open');
    }

    function openDropdown() {
        if (isOpen) return;
        isOpen = true;
        button.classList.add('open');

        dropdownPanel = document.createElement('div');
        dropdownPanel.className = 'folio-dropdown-panel';

        // Search input
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'folio-dropdown-search';
        searchInput.placeholder = 'Search ledgers...';
        dropdownPanel.appendChild(searchInput);

        // Options list
        const optionsList = document.createElement('div');
        optionsList.className = 'folio-dropdown-options';
        dropdownPanel.appendChild(optionsList);

        function renderOptions(filter = '') {
            const filterLower = filter.toLowerCase();
            const filtered = ledgers.filter(l => l.name.toLowerCase().includes(filterLower));
            
            optionsList.innerHTML = '';
            
            // Folio is now required - no "None" option

            // Add ledger options
            filtered.forEach(l => {
                const option = document.createElement('div');
                option.className = 'folio-dropdown-option' + (l.id === currentFolio ? ' selected' : '');
                option.textContent = l.name;
                option.addEventListener('click', () => selectOption(l.id, l.name));
                optionsList.appendChild(option);
            });

            if (filtered.length === 0) {
                const noResults = document.createElement('div');
                noResults.className = 'folio-dropdown-empty';
                noResults.textContent = filter ? 'No ledgers found' : 'No ledgers available. Create one first.';
                optionsList.appendChild(noResults);
            }
        }

        function selectOption(id, name) {
            params.data.folio = id || null;
            button.querySelector('.folio-dropdown-text').textContent = id ? name : 'Select ledger... *';
            if (params.data.id && !isCashbookNewRow(params.data)) {
                // Update existing entry
                updateCashbookEntry(params.data.id, { folio: id || null });
            } else if (isCashbookNewRow(params.data) && id) {
                // For new entries, check if all required fields are filled and trigger auto-save
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                if (hasDescription && hasAmount && entryType) {
                    tryCreateCashbookEntryFromPinnedRow(params.data, entryType);
                }
            }
            closeDropdown();
        }

        searchInput.addEventListener('input', (e) => {
            renderOptions(e.target.value);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeDropdown();
            }
        });

        renderOptions();

        // Position dropdown below button
        document.body.appendChild(dropdownPanel);
        const rect = button.getBoundingClientRect();
        dropdownPanel.style.top = (rect.bottom + 2) + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.minWidth = Math.max(rect.width, 200) + 'px';

        // Focus search input
        setTimeout(() => searchInput.focus(), 0);

        // Close on outside click
        const closeHandler = (e) => {
            if (!dropdownPanel.contains(e.target) && e.target !== button && !button.contains(e.target)) {
                closeDropdown();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen) {
            closeDropdown();
        } else {
            openDropdown();
        }
    });

    wrapper.appendChild(button);
    return wrapper;
}

function buildCashbookGridColumns(side) {
    return [
        {
            headerName: 'Description',
            field: 'description',
            flex: 2,
            editable: (params) => !isCashbookSystemOrFooterRow(params.data) && params.node.rowPinned !== 'bottom',
            cellClass: (params) => {
                if (isCashbookNewRow(params.data)) {
                    // Highlight if amount is filled but description is empty
                    const hasAmount = params.data.amount != null && params.data.amount > 0;
                    const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                    if (hasAmount && !hasDescription) return 'cashbook-required-field';
                }
                return '';
            },
            cellStyle: (params) => isCashbookSystemOrFooterRow(params.data) ? { fontWeight: '600', cursor: 'default' } : { cursor: 'pointer' },
            valueFormatter: (params) => (params.value != null && params.value !== '' ? String(params.value) : ''),
            pinnedRowCellRenderer: (params) => (params.value != null && params.value !== '' ? String(params.value) : ''),
            valueSetter: (params) => {
                if (isCashbookSystemOrFooterRow(params.data) || params.node.rowPinned === 'bottom') return false;
                const val = String(params.newValue ?? '').trim();
                if ((params.data.description || '') === val) return false;
                params.data.description = val;
                if (!params.node.rowPinned && !isCashbookNewRow(params.data)) {
                    updateCashbookEntry(params.data.id, { description: val });
                } else if (isCashbookNewRow(params.data) && params.api) {
                    // Refresh cells to update highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
                return true;
            }
        },
        {
            headerName: 'Folio',
            field: 'folio',
            width: 180,
            minWidth: 150,
            filter: false,
            sortable: false,
            cellRenderer: (params) => createFolioCellRenderer(params, side),
            pinnedRowCellRenderer: () => ''
        },
        {
            headerName: side === 'inflow' ? 'Incoming (Rs)' : 'Outgoing (Rs)',
            field: 'amount',
            width: 160,
            filter: 'agNumberColumnFilter',
            editable: (params) => !isCashbookSystemOrFooterRow(params.data) && params.node.rowPinned !== 'bottom',
            cellClass: (params) => {
                if (isCashbookNewRow(params.data)) {
                    // Highlight if description is filled but amount is empty
                    const hasAmount = params.data.amount != null && params.data.amount > 0;
                    const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                    if (hasDescription && !hasAmount) return 'cashbook-required-field';
                }
                return '';
            },
            cellStyle: (params) => isCashbookSystemOrFooterRow(params.data) ? { fontWeight: '600', cursor: 'default' } : { cursor: 'pointer' },
            valueFormatter: (params) => formatCashbookCell(params.value),
            pinnedRowCellRenderer: (params) => {
                const val = params.value;
                if (val == null || val === '') return '';
                return formatCashbookCell(val);
            },
            valueSetter: (params) => {
                if (params.node.rowPinned === 'bottom') return false;
                if (params.node.rowPinned === 'top' || isCashbookNewRow(params.data)) {
                    params.data.amount = parseCashbookAmount(params.newValue);
                    // Refresh cells to update highlighting
                    if (params.api) {
                        params.api.refreshCells({ rowNodes: [params.node], force: true });
                    }
                    return true;
                }
                if (isCashbookSystemOrFooterRow(params.data)) return false;
                const next = parseCashbookAmount(params.newValue);
                if (next === null || next <= 0) return false;
                params.data.amount = next;
                updateCashbookEntry(params.data.id, { entry_type: side, amount: next });
                return true;
            }
        },
        {
            headerName: '',
            field: 'actions',
            width: 60,
            filter: false,
            sortable: false,
            cellRenderer: (params) => {
                if (params.node.rowPinned) return '';
                if (isCashbookSystemOrFooterRow(params.data)) return '';
                if (isCashbookNewRow(params.data)) return '';
                const btn = document.createElement('button');
                btn.className = 'cashbook-delete-btn';
                btn.innerHTML = '<i class="fa-solid fa-trash"></i>';
                btn.title = 'Delete entry';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteCashbookEntry(params.data.id);
                });
                return btn;
            },
            pinnedRowCellRenderer: () => ''
        }
    ];
}

function initCashbookIncomingGrid() {
    const gridDiv = document.getElementById('cashbookIncomingGrid');
    if (!gridDiv) return;

    const gridOptions = {
        columnDefs: buildCashbookGridColumns('inflow'),
        rowData: [],
        pinnedBottomRowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        getRowStyle: (params) => {
            if (params.node.rowPinned === 'bottom') {
                return { fontWeight: 'bold', borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' };
            }
            if (params.data && params.data.id === '__opening__') {
                return { fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.03)' };
            }
            return null;
        },
        onGridReady: (params) => {
            cashbookIncomingGridApi = params.api;
        },
        onCellValueChanged: (params) => {
            if (isCashbookNewRow(params.data)) {
                // Auto-save when all required fields are filled (description, amount, and folio)
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                const hasFolio = params.data.folio && String(params.data.folio).trim() !== '';
                if (hasDescription && hasAmount && hasFolio) {
                    tryCreateCashbookEntryFromPinnedRow(params.data, 'inflow');
                } else if (params.api) {
                    // Refresh the row to update required field highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
            }
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

function initCashbookOutgoingGrid() {
    const gridDiv = document.getElementById('cashbookOutgoingGrid');
    if (!gridDiv) return;

    const gridOptions = {
        columnDefs: buildCashbookGridColumns('outflow'),
        rowData: [],
        pinnedBottomRowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        getRowStyle: (params) => {
            if (params.node.rowPinned === 'bottom') {
                return { fontWeight: 'bold', borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' };
            }
            if (params.data && params.data.id === '__closing__') {
                return { fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.03)' };
            }
            return null;
        },
        onGridReady: (params) => {
            cashbookOutgoingGridApi = params.api;
        },
        onCellValueChanged: (params) => {
            if (isCashbookNewRow(params.data)) {
                // Auto-save when all required fields are filled (description, amount, and folio)
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                const hasFolio = params.data.folio && String(params.data.folio).trim() !== '';
                if (hasDescription && hasAmount && hasFolio) {
                    tryCreateCashbookEntryFromPinnedRow(params.data, 'outflow');
                } else if (params.api) {
                    // Refresh the row to update required field highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
            }
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

function initOrdersPeriodFilter() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (selectEl) {
        selectEl.addEventListener('change', () => {
            const val = selectEl.value;
            if (val === '__all__') {
                loadOrders();
            } else {
                const [month, year] = val.split('-').map(Number);
                loadOrdersForPeriod(month, year);
            }
        });
    }
}

function switchView(viewName) {
    currentView = viewName;

    // Update nav (ledgerDetail keeps the ledgers nav active)
    const navView = viewName === 'ledgerDetail' ? 'ledgers' : viewName;
    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === navView);
    });

    // Update views
    views.forEach(view => {
        view.classList.toggle('active', view.id === `${viewName}View`);
    });

    // Update header
    const titles = {
        'dashboard': { title: 'Dashboard', subtitle: 'Overview of your inventory' },
        'orders': { title: 'Orders', subtitle: 'View and manage orders' },
        'cashbook': { title: 'Cashbook', subtitle: 'Track daily cash inflows and outflows' },
        'ledgers': { title: 'Ledgers', subtitle: 'Manage individual account ledgers' },
        'ledgerDetail': { title: 'Ledger', subtitle: 'View ledger entries' },
        'products': { title: 'Products', subtitle: 'Manage your product catalog' }
    };

    document.getElementById('viewTitle').textContent = titles[viewName].title;
    document.getElementById('viewSubtitle').textContent = titles[viewName].subtitle;

    // Show/hide buttons based on view
    const editCostPricesBtn = document.getElementById('editCostPricesBtn');
    const syncProductsBtn = document.getElementById('syncShopifyBtn');
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    const uploadPostExCsvBtn = document.getElementById('uploadPostExCsvBtn');
    const bulkUpdateOrderBtn = document.getElementById('bulkUpdateOrderBtn');
    const cashbookDateFilterWrap = document.getElementById('cashbookDateFilterWrap');

    if (editCostPricesBtn) {
        editCostPricesBtn.style.display = 'none'; // Hide since editing is inline now
    }

    if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'none';

    const ordersPeriodFilterWrap = document.getElementById('ordersPeriodFilterWrap');
    const ordersFullScreenBtn = document.getElementById('ordersFullScreenBtn');
    if (syncProductsBtn && syncOrdersBtn) {
        if (viewName === 'products') {
            syncProductsBtn.style.display = 'inline-flex';
            syncOrdersBtn.style.display = 'none';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'none';
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'none';
            if (ordersFullScreenBtn) ordersFullScreenBtn.style.display = 'none';
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'none';
            exitOrdersFullScreen();
        } else if (viewName === 'orders') {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'inline-flex';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'inline-flex';
            if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'inline-flex';
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'flex';
            if (ordersFullScreenBtn) ordersFullScreenBtn.style.display = 'inline-flex';
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'none';
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            const generateInvoiceBtn = document.getElementById('generateInvoiceBtn');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'inline-flex';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
            if (generateInvoiceBtn) generateInvoiceBtn.style.display = 'inline-flex';
        } else if (viewName === 'cashbook') {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'none';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'none';
            if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'none';
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'none';
            if (ordersFullScreenBtn) ordersFullScreenBtn.style.display = 'none';
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'inline-flex';
            exitOrdersFullScreen();
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            const generateInvoiceBtn = document.getElementById('generateInvoiceBtn');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'none';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
            if (generateInvoiceBtn) generateInvoiceBtn.style.display = 'none';
        } else {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'none';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'none';
            if (bulkUpdateOrderBtn) bulkUpdateOrderBtn.style.display = 'none';
            if (ordersPeriodFilterWrap) ordersPeriodFilterWrap.style.display = 'none';
            if (ordersFullScreenBtn) ordersFullScreenBtn.style.display = 'none';
            if (cashbookDateFilterWrap) cashbookDateFilterWrap.style.display = 'none';
            exitOrdersFullScreen();
            const refreshDeliveryBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
            const deliveryProgress = document.getElementById('deliveryRefreshProgress');
            const generateInvoiceBtn = document.getElementById('generateInvoiceBtn');
            if (refreshDeliveryBtn) refreshDeliveryBtn.style.display = 'none';
            if (deliveryProgress) deliveryProgress.style.display = 'none';
            if (generateInvoiceBtn) generateInvoiceBtn.style.display = 'none';
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
    } else if (viewName === 'cashbook') {
        loadCashbook();
        setTimeout(() => {
            if (cashbookIncomingGridApi) cashbookIncomingGridApi.sizeColumnsToFit();
            if (cashbookOutgoingGridApi) cashbookOutgoingGridApi.sizeColumnsToFit();
        }, 100);
    } else if (viewName === 'ledgers') {
        loadLedgers();
    } else if (viewName === 'ledgerDetail') {
        // Handled by openLedgerDetail
        setTimeout(() => {
            if (ledgerDetailGridApi) ledgerDetailGridApi.sizeColumnsToFit();
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

// Period = month's 22 to next month's 21 (same as backend)
function getOrderDateForPeriod(order) {
    const raw = order.order_receiving_date || order.created_at;
    return raw ? new Date(raw) : null;
}

function getPeriodForDate(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;
    const d = date;
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    if (day >= 22) return { month, year };
    if (month === 1) return { month: 12, year: year - 1 };
    return { month: month - 1, year };
}

function ordersPeriodStartEnd(month, year) {
    const start = new Date(year, month - 1, 22, 0, 0, 0);
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const end = new Date(nextYear, nextMonth - 1, 21, 23, 59, 59);
    return { start, end };
}

function isOrderInPeriod(order, month, year) {
    const date = getOrderDateForPeriod(order);
    if (!date) return false;
    const { start, end } = ordersPeriodStartEnd(month, year);
    return date >= start && date <= end;
}

function formatOrdersPeriodLabel(month, year) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${monthNames[month - 1]} 22 – ${monthNames[nextMonth - 1]} 21, ${nextMonth === 1 ? nextYear : year}`;
}

/** Current period (month 22 – next 21) that contains today in PKT */
function getCurrentOrdersPeriod() {
    return getPeriodForDate(getPKTDate());
}

/** Oldest period in dropdown: Oct 22 – Nov 21, 2024 */
const ORDERS_PERIOD_OLDEST_MONTH = 10;
const ORDERS_PERIOD_OLDEST_YEAR = 2024;

/** Build dropdown options: "All orders" + periods from current down to Oct 22 – Nov 21, 2024 */
function buildStaticPeriodOptions() {
    const options = [{ value: '__all__', label: 'All orders (recent)' }];
    let { month, year } = getCurrentOrdersPeriod();
    while (year > ORDERS_PERIOD_OLDEST_YEAR || (year === ORDERS_PERIOD_OLDEST_YEAR && month >= ORDERS_PERIOD_OLDEST_MONTH)) {
        options.push({ value: `${month}-${year}`, label: formatOrdersPeriodLabel(month, year) });
        if (month === 1) {
            month = 12;
            year -= 1;
        } else {
            month -= 1;
        }
    }
    return options;
}

function populateOrdersPeriodFilterDropdown() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (!selectEl) return;
    const currentVal = selectEl.value;
    const options = buildStaticPeriodOptions();
    selectEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    if (currentVal && options.some((o) => o.value === currentVal)) {
        selectEl.value = currentVal;
    } else {
        selectEl.value = '__all__';
    }
}

async function loadOrders() {
    if (ordersGridApi) ordersGridApi.showLoadingOverlay();
    try {
        const response = await fetch(`${API_BASE}/orders/`);
        if (!response.ok) throw new Error('Failed to fetch orders');

        orders = await response.json();

        populateOrdersPeriodFilterDropdown();
        const selectEl = document.getElementById('ordersPeriodFilter');
        if (selectEl) selectEl.value = '__all__';

        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            populateOrdersPeriodFilterDropdown();
            const sel = document.getElementById('ordersPeriodFilter');
            if (sel) sel.value = '__all__';
            if (ordersGridApi) {
                ordersGridApi.setGridOption('rowData', orders);
                setTimeout(() => updateFooterRow(), 0);
            }
        }
    } finally {
        if (ordersGridApi) ordersGridApi.hideOverlay();
    }
}

/** Load orders for a specific period from API (for older months beyond the initial 1000) */
async function loadOrdersForPeriod(month, year) {
    if (ordersGridApi) ordersGridApi.showLoadingOverlay();
    try {
        const response = await fetch(`${API_BASE}/orders/?month=${month}&year=${year}`);
        if (!response.ok) throw new Error('Failed to fetch orders for period');

        orders = await response.json();

        if (ordersGridApi) {
            ordersGridApi.setGridOption('rowData', orders);
            setTimeout(() => updateFooterRow(), 0);
        }
    } catch (error) {
        console.error('Error loading orders for period:', error);
        showToast('Failed to load orders for period', 'error');
        if (ordersGridApi) ordersGridApi.setGridOption('rowData', []);
    } finally {
        if (ordersGridApi) ordersGridApi.hideOverlay();
    }
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

// ============================================
// Cashbook
// ============================================

function normalizeCashbookEntries(entries) {
    return (entries || []).map((entry) => ({
        ...entry,
        entry_date: entry.entry_date ? String(entry.entry_date).slice(0, 10) : ''
    }));
}

function getEmptyCashbookRow(entryDate = '', side = '') {
    // Use a unique ID each time to ensure AG Grid creates a fresh row
    return {
        id: '__new_' + side + '_' + Date.now() + '__',
        entry_date: entryDate,
        description: '',
        folio: null,
        amount: null,
        running_total: null
    };
}

function buildCashbookRows(entries, openingBalance) {
    const sorted = [...entries].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });

    let running = parseFloat(openingBalance) || 0;
    let totalInflow = 0;
    let totalOutflow = 0;
    const dailySummary = [];
    let currentDate = null;
    let dayOpening = running;
    let dayInflow = 0;
    let dayOutflow = 0;

    const rows = sorted.map((entry) => {
        const entryDate = entry.entry_date || '';
        if (currentDate !== null && entryDate !== currentDate) {
            dailySummary.push({
                date: currentDate,
                opening: dayOpening,
                inflow: dayInflow,
                outflow: dayOutflow,
                closing: running
            });
            dayOpening = running;
            dayInflow = 0;
            dayOutflow = 0;
        }

        if (currentDate !== entryDate) {
            currentDate = entryDate;
        }

        const amount = parseFloat(entry.amount) || 0;
        const inflow = entry.entry_type === 'inflow' ? amount : 0;
        const outflow = entry.entry_type === 'outflow' ? amount : 0;
        totalInflow += inflow;
        totalOutflow += outflow;
        running += inflow - outflow;
        dayInflow += inflow;
        dayOutflow += outflow;

        return {
            ...entry,
            inflow,
            outflow,
            running_balance: running
        };
    });

    if (currentDate !== null) {
        dailySummary.push({
            date: currentDate,
            opening: dayOpening,
            inflow: dayInflow,
            outflow: dayOutflow,
            closing: running
        });
    }

    return {
        rows,
        dailySummary,
        totals: {
            totalInflow,
            totalOutflow,
            closingBalance: running
        }
    };
}

function buildCashbookSideRows(entries, side) {
    const filtered = (entries || []).filter((entry) => entry.entry_type === side);
    const sorted = [...filtered].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    return sorted.map((entry) => ({
        ...entry,
        amount: parseFloat(entry.amount) || 0
    }));
}

function buildCashbookIncomingWithOpening(entries, carryForward, selectedDate) {
    const opening = parseFloat(carryForward) || 0;
    const rows = buildCashbookSideRows(entries, 'inflow');
    const totalInflow = rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const openingRow = {
        id: '__opening__',
        description: "Opening Balance",
        amount: opening,
        _isSystemRow: true
    };
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'inflow');
    const totalRow = {
        id: '__total_in__',
        description: 'Total',
        amount: opening + totalInflow,
        _isFooter: true
    };
    return { rowData: [openingRow, ...rows, newEntryRow], pinnedBottomRowData: [totalRow], totalInflow };
}

function buildCashbookOutgoingWithClosing(entries, carryForward, selectedDate) {
    const inflowEntries = (entries || []).filter((e) => e.entry_type === 'inflow');
    const outflowEntries = (entries || []).filter((e) => e.entry_type === 'outflow');
    const totalInflow = inflowEntries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const totalOutflow = outflowEntries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const opening = parseFloat(carryForward) || 0;
    const closingBalance = opening + totalInflow - totalOutflow;
    const rows = buildCashbookSideRows(entries, 'outflow');
    const newEntryRow = getEmptyCashbookRow(selectedDate || '', 'outflow');
    const closingRow = {
        id: '__closing__',
        description: 'Closing Balance',
        amount: closingBalance,
        _isSystemRow: true
    };
    const totalRow = {
        id: '__total_out__',
        description: 'Total',
        amount: totalOutflow + closingBalance,
        _isFooter: true
    };
    return { rowData: [...rows, newEntryRow, closingRow], pinnedBottomRowData: [totalRow], totalOutflow };
}

async function loadDailyBalance(targetDate) {
    try {
        const response = await fetch(`${API_BASE}/cashbook/daily-balance/${targetDate}`);
        if (!response.ok) throw new Error('Failed to load daily balance');
        cashbookDailyBalance = await response.json();
    } catch (error) {
        console.error('Error loading daily balance:', error);
        // Default to zero if balance can't be loaded
        cashbookDailyBalance = {
            balance_date: targetDate,
            opening_balance: 0,
            total_inflow: 0,
            total_outflow: 0,
            closing_balance: 0
        };
    }
}

async function loadCashbookEntriesForDate(targetDate, showLoading = true) {
    if (showLoading) {
        if (cashbookIncomingGridApi) cashbookIncomingGridApi.showLoadingOverlay();
        if (cashbookOutgoingGridApi) cashbookOutgoingGridApi.showLoadingOverlay();
    }
    try {
        const response = await fetch(`${API_BASE}/cashbook/entries?start_date=${targetDate}&end_date=${targetDate}`);
        if (!response.ok) throw new Error('Failed to load cashbook entries');
        cashbookEntries = normalizeCashbookEntries(await response.json());
    } catch (error) {
        console.error('Error loading cashbook entries:', error);
        showToast('Failed to load cashbook entries', 'error');
        cashbookEntries = [];
    } finally {
        if (showLoading) {
            if (cashbookIncomingGridApi) cashbookIncomingGridApi.hideOverlay();
            if (cashbookOutgoingGridApi) cashbookOutgoingGridApi.hideOverlay();
        }
    }
}

function renderCashbook() {
    const selectedDate = cashbookSelectedDate || getTodayDateString();
    const openingBalance = cashbookDailyBalance ? parseFloat(cashbookDailyBalance.opening_balance) || 0 : 0;
    const filteredEntries = cashbookEntries.filter((entry) => entry.entry_date === selectedDate);

    const { rowData: incomingRowData, pinnedBottomRowData: incomingPinnedBottom } = buildCashbookIncomingWithOpening(filteredEntries, openingBalance, selectedDate);
    const { rowData: outgoingRowData, pinnedBottomRowData: outgoingPinnedBottom } = buildCashbookOutgoingWithClosing(filteredEntries, openingBalance, selectedDate);

    if (cashbookIncomingGridApi) {
        cashbookIncomingGridApi.setGridOption('rowData', incomingRowData);
        cashbookIncomingGridApi.setGridOption('pinnedTopRowData', []);
        cashbookIncomingGridApi.setGridOption('pinnedBottomRowData', incomingPinnedBottom);
        cashbookIncomingGridApi.setGridOption('pagination', false);
    }
    if (cashbookOutgoingGridApi) {
        cashbookOutgoingGridApi.setGridOption('rowData', outgoingRowData);
        cashbookOutgoingGridApi.setGridOption('pinnedTopRowData', []);
        cashbookOutgoingGridApi.setGridOption('pinnedBottomRowData', outgoingPinnedBottom);
        cashbookOutgoingGridApi.setGridOption('pagination', false);
    }
}

async function loadCashbook() {
    const dateFilter = document.getElementById('cashbookDateFilter');
    if (!cashbookSelectedDate) {
        cashbookSelectedDate = getTodayDateString();
    }
    if (dateFilter) dateFilter.value = cashbookSelectedDate;
    
    await Promise.all([
        loadDailyBalance(cashbookSelectedDate),
        loadCashbookEntriesForDate(cashbookSelectedDate),
        loadLedgersList()
    ]);
    renderCashbook();
}

async function reloadCashbookForCurrentDate(showLoading = true) {
    const selectedDate = cashbookSelectedDate || getTodayDateString();
    await Promise.all([
        loadDailyBalance(selectedDate),
        loadCashbookEntriesForDate(selectedDate, showLoading)
    ]);
    renderCashbook();
}

async function addCashbookEntry() {
    const dateInput = document.getElementById('cashbookEntryDate');
    const typeInput = document.getElementById('cashbookEntryType');
    const amountInput = document.getElementById('cashbookEntryAmount');
    const descInput = document.getElementById('cashbookEntryDescription');
    if (!dateInput || !typeInput || !amountInput) return;

    const entryDate = String(dateInput.value || '').trim();
    const entryType = String(typeInput.value || '').trim();
    const amount = parseFloat(amountInput.value);
    const description = descInput ? String(descInput.value || '').trim() : '';

    if (!entryDate) {
        showToast('Select an entry date', 'error');
        return;
    }
    if (!entryType || (entryType !== 'inflow' && entryType !== 'outflow')) {
        showToast('Select a valid entry type', 'error');
        return;
    }
    if (Number.isNaN(amount) || amount <= 0) {
        showToast('Enter a valid amount', 'error');
        return;
    }

    await createCashbookEntry({
        entry_date: entryDate,
        entry_type: entryType,
        amount,
        description
    });
    if (amountInput) amountInput.value = '';
    if (descInput) descInput.value = '';
}

async function createCashbookEntry(payload) {
    // Optimistic update: add entry to local array immediately
    const tempId = '__temp_' + Date.now();
    const tempEntry = {
        ...payload,
        id: tempId,
        entry_date: String(payload.entry_date || '').slice(0, 10),
        created_at: getPKTISOString(),
        updated_at: getPKTISOString()
    };
    cashbookEntries.push(tempEntry);
    renderCashbook();

    try {
        const response = await fetch(`${API_BASE}/cashbook/entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error('Failed to add cashbook entry');
        
        // Silently refresh in background to get real ID and updated balance
        await reloadCashbookForCurrentDate(false);
        showToast('Entry added', 'success');
    } catch (error) {
        console.error('Error adding cashbook entry:', error);
        // Remove the temp entry on failure
        cashbookEntries = cashbookEntries.filter(e => e.id !== tempId);
        renderCashbook();
        showToast('Failed to add entry', 'error');
    }
}

function tryCreateCashbookEntryFromPinnedRow(row, entryType) {
    const entryDate = String(row.entry_date || '').trim();
    const amount = parseCashbookAmount(row.amount);
    if (amount === null || amount <= 0) return;
    if (!entryDate) {
        showToast('Select an entry date for this row.', 'error');
        return;
    }
    const description = String(row.description || '').trim();
    const folio = row.folio || null;
    
    // Folio is now required
    if (!folio) {
        showToast('Please select a ledger (folio) for this entry.', 'error');
        return;
    }

    createCashbookEntry({
        entry_date: entryDate,
        entry_type: entryType,
        amount,
        description,
        folio
    });
}

async function updateCashbookEntry(entryId, updates) {
    if (!entryId || !updates || Object.keys(updates).length === 0) return;
    
    // Optimistic update: apply changes immediately
    const entryIndex = cashbookEntries.findIndex(e => e.id === entryId);
    const originalEntry = entryIndex >= 0 ? { ...cashbookEntries[entryIndex] } : null;
    if (entryIndex >= 0) {
        cashbookEntries[entryIndex] = { ...cashbookEntries[entryIndex], ...updates };
        renderCashbook();
    }

    try {
        const response = await fetch(`${API_BASE}/cashbook/entries/${entryId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        if (!response.ok) throw new Error('Failed to update cashbook entry');
        
        // Silently refresh in background to get updated balance
        await reloadCashbookForCurrentDate(false);
        showToast('Entry updated', 'success');
    } catch (error) {
        console.error('Error updating cashbook entry:', error);
        // Revert on failure
        if (originalEntry && entryIndex >= 0) {
            cashbookEntries[entryIndex] = originalEntry;
            renderCashbook();
        }
        showToast('Failed to update entry', 'error');
    }
}

async function deleteCashbookEntry(entryId) {
    if (!entryId) return;
    
    // Optimistic update: remove immediately
    const entryIndex = cashbookEntries.findIndex(e => e.id === entryId);
    const removedEntry = entryIndex >= 0 ? cashbookEntries[entryIndex] : null;
    if (entryIndex >= 0) {
        cashbookEntries.splice(entryIndex, 1);
        renderCashbook();
    }

    try {
        const response = await fetch(`${API_BASE}/cashbook/entries/${entryId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete cashbook entry');
        
        // Silently refresh in background to get updated balance
        await reloadCashbookForCurrentDate(false);
        showToast('Entry deleted', 'success');
    } catch (error) {
        console.error('Error deleting cashbook entry:', error);
        // Restore on failure
        if (removedEntry) {
            cashbookEntries.push(removedEntry);
            renderCashbook();
        }
        showToast('Failed to delete entry', 'error');
    }
}

// ============================================
// Ledger Functions
// ============================================

async function loadLedgersList() {
    try {
        const response = await fetch(`${API_BASE}/ledgers/`);
        if (!response.ok) throw new Error('Failed to load ledgers');
        ledgers = await response.json();
    } catch (error) {
        console.error('Error loading ledgers:', error);
        ledgers = [];
    }
}

async function loadLedgers() {
    await loadLedgersList();
    renderLedgerCards();
}

function renderLedgerCards() {
    const container = document.getElementById('ledgerCards');
    if (!container) return;

    if (ledgers.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No ledgers yet. Click "Create Ledger" to add one.</p>';
        return;
    }

    container.innerHTML = ledgers.map(l => `
        <div class="ledger-card" data-id="${l.id}">
            <div class="ledger-card-info">
                <span class="ledger-card-name">${escapeHtml(l.name)}</span>
                <span class="ledger-card-section">${escapeHtml(l.section || '')}</span>
            </div>
            <div class="ledger-card-actions">
                <button class="btn btn-danger btn-sm ledger-delete-btn" data-id="${l.id}" title="Delete ledger">Delete</button>
            </div>
        </div>
    `).join('');

    // Click on card (not the delete button) opens detail
    container.querySelectorAll('.ledger-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.ledger-delete-btn')) return;
            const id = card.dataset.id;
            openLedgerDetail(id);
        });
    });

    // Delete buttons
    container.querySelectorAll('.ledger-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            deleteLedger(id);
        });
    });
}

async function createLedger(name, section) {
    try {
        const response = await fetch(`${API_BASE}/ledgers/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, section })
        });
        if (!response.ok) throw new Error('Failed to create ledger');
        showToast('Ledger created', 'success');
        closeCreateLedgerModal();
        await loadLedgers();
    } catch (error) {
        console.error('Error creating ledger:', error);
        showToast('Failed to create ledger', 'error');
    }
}

function openCreateLedgerModal() {
    document.getElementById('createLedgerName').value = '';
    document.getElementById('createLedgerSection').value = '';
    document.getElementById('createLedgerModal').classList.add('active');
}

function closeCreateLedgerModal() {
    document.getElementById('createLedgerModal').classList.remove('active');
}

async function deleteLedger(ledgerId) {
    if (!ledgerId) return;
    try {
        const response = await fetch(`${API_BASE}/ledgers/${ledgerId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete ledger');
        showToast('Ledger deleted', 'success');
        await loadLedgers();
    } catch (error) {
        console.error('Error deleting ledger:', error);
        showToast('Failed to delete ledger', 'error');
    }
}

async function openLedgerDetail(ledgerId) {
    try {
        const response = await fetch(`${API_BASE}/ledgers/${ledgerId}`);
        if (!response.ok) throw new Error('Failed to load ledger');
        currentLedger = await response.json();
    } catch (error) {
        console.error('Error loading ledger:', error);
        showToast('Failed to load ledger', 'error');
        return;
    }

    document.getElementById('ledgerDetailName').textContent = currentLedger.name;
    switchView('ledgerDetail');
    await loadLedgerEntries(ledgerId);
}

async function loadLedgerEntries(ledgerId) {
    if (!ledgerId) ledgerId = currentLedger?.id;
    if (!ledgerId) return;

    if (ledgerDetailGridApi) ledgerDetailGridApi.showLoadingOverlay();
    try {
        const response = await fetch(`${API_BASE}/ledgers/${ledgerId}/entries`);
        if (!response.ok) throw new Error('Failed to load ledger entries');
        ledgerEntries = (await response.json()).map(e => ({
            ...e,
            entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : ''
        }));
    } catch (error) {
        console.error('Error loading ledger entries:', error);
        showToast('Failed to load ledger entries', 'error');
        ledgerEntries = [];
    } finally {
        if (ledgerDetailGridApi) ledgerDetailGridApi.hideOverlay();
    }

    renderLedgerDetailGrid();
}

function renderLedgerDetailGrid() {
    if (!ledgerDetailGridApi) return;

    // Compute running balance
    const sorted = [...ledgerEntries].sort((a, b) => {
        const dateA = a.entry_date || '';
        const dateB = b.entry_date || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });

    let running = 0;
    const rowsWithBalance = sorted.map(entry => {
        const incoming = parseFloat(entry.incoming) || 0;
        const outgoing = parseFloat(entry.outgoing) || 0;
        running += incoming - outgoing;
        return { ...entry, balance: running };
    });

    // Ledger entries are now read-only (derived from cashbook entries)
    ledgerDetailGridApi.setGridOption('rowData', rowsWithBalance);
}

function initLedgerDetailGrid() {
    const gridDiv = document.getElementById('ledgerDetailGrid');
    if (!gridDiv) return;

    // Ledger detail grid is now read-only - entries come from cashbook
    const columnDefs = [
        {
            headerName: 'Date',
            field: 'entry_date',
            width: 130,
            editable: false,
            valueFormatter: (params) => params.value || '',
        },
        {
            headerName: 'Particulars',
            field: 'particulars',
            flex: 2,
            editable: false,
        },
        {
            headerName: 'Debit (Rs)',
            field: 'outgoing',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
        },
        {
            headerName: 'Credit (Rs)',
            field: 'incoming',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
        },
        {
            headerName: 'Balance (Rs)',
            field: 'balance',
            width: 140,
            editable: false,
            valueFormatter: (params) => formatCashbookCell(params.value),
            cellStyle: (params) => {
                const val = parseFloat(params.value);
                if (Number.isNaN(val)) return {};
                if (val < 0) return { color: 'var(--danger)' };
                return {};
            }
        }
    ];

    const gridOptions = {
        columnDefs,
        rowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: true,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.id,
        onGridReady: (params) => {
            ledgerDetailGridApi = params.api;
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

// NOTE: Ledger entries are now read-only and derived from cashbook entries.
// The CRUD operations for ledger entries have been removed.
// To add/edit/delete ledger entries, use the Cashbook with the appropriate folio.

async function syncShopifyProducts() {
    const btn = document.getElementById('syncShopifyBtn');
    const originalText = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = 'Syncing...';

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
    btn.innerHTML = 'Syncing...';

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

function scheduleOrdersAutoSync() {
    if (ordersAutoSyncTimerId != null) {
        clearTimeout(ordersAutoSyncTimerId);
        ordersAutoSyncTimerId = null;
    }
    ordersAutoSyncTimerId = setTimeout(async () => {
        ordersAutoSyncTimerId = null;
        await syncShopifyOrders();
        scheduleOrdersAutoSync();
    }, ORDERS_AUTO_SYNC_INTERVAL_MS);
}

async function uploadPostExCsv(file) {
    const btn = document.getElementById('uploadPostExCsvBtn');
    const originalText = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = 'Uploading...';
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

        // Show popup if any orders have receivable != CSV NET_AMOUNT
        const mismatches = data.amount_mismatches || [];
        if (mismatches.length > 0) {
            showPostExAmountMismatchesModal(mismatches);
        }
        
        // CSV may contain orders from multiple periods; we have all orders in the grid (period filter may hide some).
        // Select all rows in the current view that were updated by the CSV.
        const updatedOrderIds = data.updated_order_ids || [];
        const matchedOrderNumbers = new Set((data.matched_order_numbers || []).map(Number));
        
        await loadOrders();
        
        if (ordersGridApi && (updatedOrderIds.length > 0 || matchedOrderNumbers.size > 0)) {
            setTimeout(() => {
                if (ordersGridApi) {
                    ordersGridApi.deselectAll();
                    ordersGridApi.forEachNode(node => {
                        const data = node.data;
                        if (!data || data.id === '__footer__') return;
                        if (updatedOrderIds.includes(data.id) || matchedOrderNumbers.has(Number(data.order_number))) {
                            node.setSelected(true);
                        }
                    });
                    const selectedRows = ordersGridApi.getSelectedRows();
                    if (selectedRows.length > 0) {
                        ordersGridApi.ensureNodeVisible(selectedRows[0], 'middle');
                    }
                    if (typeof updateFooterRow === 'function') updateFooterRow();
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

    // Sync Shopify Orders Button (manual sync resets the 15-min auto-sync timer)
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    if (syncOrdersBtn) {
        syncOrdersBtn.addEventListener('click', async () => {
            await syncShopifyOrders();
            scheduleOrdersAutoSync();
        });
    }

    // Bulk update order button
    const bulkUpdateOrderBtn = document.getElementById('bulkUpdateOrderBtn');
    if (bulkUpdateOrderBtn) {
        bulkUpdateOrderBtn.addEventListener('click', openBulkUpdateOrderModal);
    }

    document.getElementById('bulkUpdateSetDelivered')?.addEventListener('click', () => bulkUpdateOrderStatus('delivered'));
    document.getElementById('bulkUpdateSetReturned')?.addEventListener('click', () => bulkUpdateOrderStatus('returned'));
    document.getElementById('bulkUpdateSetCancelled')?.addEventListener('click', () => bulkUpdateOrderStatus('cancelled'));
    document.getElementById('bulkUpdateSetPieceReceived')?.addEventListener('click', bulkUpdatePieceReceived);

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

    // Generate invoice button
    const generateInvoiceBtn = document.getElementById('generateInvoiceBtn');
    if (generateInvoiceBtn) {
        generateInvoiceBtn.addEventListener('click', async () => {
            if (!ordersGridApi) {
                showToast('Orders grid not initialized', 'error');
                return;
            }
            
            const selectedRows = ordersGridApi.getSelectedRows();
            if (selectedRows.length === 0) {
                showToast('Please select at least one order', 'error');
                return;
            }
            
            const orderIds = selectedRows.map(row => row.id);
            
            generateInvoiceBtn.disabled = true;
            const originalText = generateInvoiceBtn.textContent;
            generateInvoiceBtn.textContent = 'Generating...';
            
            try {
                const response = await fetch(`${API_BASE}/orders/generate-invoice`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderIds)
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.detail || 'Failed to generate invoice');
                }
                
                // Get the blob and create download link
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'invoice.xlsx';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                
                showToast(`Invoice generated for ${selectedRows.length} order(s)`, 'success');
            } catch (error) {
                console.error('Error generating invoice:', error);
                showToast(error.message || 'Failed to generate invoice', 'error');
            } finally {
                generateInvoiceBtn.disabled = false;
                generateInvoiceBtn.textContent = originalText;
            }
        });
    }

    // Cashbook actions
    const cashbookDateFilter = document.getElementById('cashbookDateFilter');
    if (cashbookDateFilter) {
        cashbookDateFilter.addEventListener('change', () => {
            cashbookSelectedDate = cashbookDateFilter.value || getTodayDateString();
            reloadCashbookForCurrentDate();
        });
    }
    const cashbookTodayBtn = document.getElementById('cashbookTodayBtn');
    if (cashbookTodayBtn) {
        cashbookTodayBtn.addEventListener('click', () => {
            const today = getTodayDateString();
            cashbookSelectedDate = today;
            if (cashbookDateFilter) cashbookDateFilter.value = today;
            reloadCashbookForCurrentDate();
        });
    }
    const cashbookPrevDayBtn = document.getElementById('cashbookPrevDayBtn');
    if (cashbookPrevDayBtn) {
        cashbookPrevDayBtn.addEventListener('click', () => {
            const current = cashbookSelectedDate || getTodayDateString();
            const [year, month, day] = current.split('-').map(Number);
            const date = new Date(year, month - 1, day);
            date.setDate(date.getDate() - 1);
            const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            cashbookSelectedDate = newDate;
            if (cashbookDateFilter) cashbookDateFilter.value = newDate;
            reloadCashbookForCurrentDate();
        });
    }
    const cashbookNextDayBtn = document.getElementById('cashbookNextDayBtn');
    if (cashbookNextDayBtn) {
        cashbookNextDayBtn.addEventListener('click', () => {
            const current = cashbookSelectedDate || getTodayDateString();
            const [year, month, day] = current.split('-').map(Number);
            const date = new Date(year, month - 1, day);
            date.setDate(date.getDate() + 1);
            const newDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            cashbookSelectedDate = newDate;
            if (cashbookDateFilter) cashbookDateFilter.value = newDate;
            reloadCashbookForCurrentDate();
        });
    }

    // Ledger: create button opens modal
    const createLedgerBtn = document.getElementById('createLedgerBtn');
    if (createLedgerBtn) {
        createLedgerBtn.addEventListener('click', openCreateLedgerModal);
    }
    // Create Ledger modal: form submit and close
    const createLedgerForm = document.getElementById('createLedgerForm');
    if (createLedgerForm) {
        createLedgerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('createLedgerName').value.trim();
            const section = document.getElementById('createLedgerSection').value;
            if (!name) {
                showToast('Enter a ledger name', 'error');
                return;
            }
            if (!section) {
                showToast('Select a section', 'error');
                return;
            }
            createLedger(name, section);
        });
    }
    document.getElementById('closeCreateLedgerModal')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerCancelBtn')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'createLedgerModal') closeCreateLedgerModal();
    });

    // Ledger: back button
    const ledgerBackBtn = document.getElementById('ledgerBackBtn');
    if (ledgerBackBtn) {
        ledgerBackBtn.addEventListener('click', () => {
            switchView('ledgers');
        });
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

// Bulk Update Order modal
function openBulkUpdateOrderModal() {
    const formEl = document.getElementById('bulkUpdateOrderForm');
    const resultsEl = document.getElementById('bulkUpdateOrderResults');
    const textarea = document.getElementById('bulkUpdateOrderNumbers');
    if (formEl) formEl.style.display = '';
    if (resultsEl) resultsEl.style.display = 'none';
    if (textarea) {
        // Get selected orders and fill textarea with their order numbers
        let orderNumbersText = '';
        if (ordersGridApi) {
            const selectedRows = ordersGridApi.getSelectedRows();
            if (selectedRows.length > 0) {
                // Extract order numbers from selected rows, filter out footer row
                const orderNumbers = selectedRows
                    .filter(row => row && row.id !== '__footer__' && row.order_number)
                    .map(row => row.order_number)
                    .filter(Boolean);
                
                // Remove duplicates and sort
                const uniqueOrderNumbers = [...new Set(orderNumbers)].sort((a, b) => {
                    const numA = parseInt(a, 10);
                    const numB = parseInt(b, 10);
                    if (!isNaN(numA) && !isNaN(numB)) {
                        return numA - numB;
                    }
                    return String(a).localeCompare(String(b));
                });
                
                orderNumbersText = uniqueOrderNumbers.join('\n');
            }
        }
        textarea.value = orderNumbersText;
        textarea.focus();
    }
    document.getElementById('bulkUpdateOrderModal')?.classList.add('active');
}

function showBulkUpdateResults(result) {
    const formEl = document.getElementById('bulkUpdateOrderForm');
    const resultsEl = document.getElementById('bulkUpdateOrderResults');
    const successList = document.getElementById('bulkUpdateSuccessList');
    const successEmpty = document.getElementById('bulkUpdateSuccessEmpty');
    const failedList = document.getElementById('bulkUpdateFailedList');
    const failedEmpty = document.getElementById('bulkUpdateFailedEmpty');
    if (!resultsEl || !successList || !failedList) return;

    successList.innerHTML = '';
    failedList.innerHTML = '';
    const updated = result.updated_order_numbers || [];
    const notFound = result.not_found_order_numbers || [];

    if (updated.length === 0) {
        successEmpty.style.display = 'block';
    } else {
        successEmpty.style.display = 'none';
        updated.forEach((num) => {
            const li = document.createElement('li');
            li.textContent = String(num);
            successList.appendChild(li);
        });
    }

    if (notFound.length === 0) {
        failedEmpty.style.display = 'block';
    } else {
        failedEmpty.style.display = 'none';
        notFound.forEach((num) => {
            const li = document.createElement('li');
            li.textContent = String(num);
            failedList.appendChild(li);
        });
    }

    if (formEl) formEl.style.display = 'none';
    resultsEl.style.display = 'block';
}

function closeBulkUpdateOrderModal() {
    document.getElementById('bulkUpdateOrderModal')?.classList.remove('active');
}

document.getElementById('bulkUpdateOrderModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'bulkUpdateOrderModal') closeBulkUpdateOrderModal();
});

document.getElementById('closeBulkUpdateOrderModal')?.addEventListener('click', closeBulkUpdateOrderModal);

document.getElementById('bulkUpdateResultsClose')?.addEventListener('click', () => {
    closeBulkUpdateOrderModal();
});

function parseOrderNumbersFromTextarea() {
    const textarea = document.getElementById('bulkUpdateOrderNumbers');
    if (!textarea) return [];
    const lines = textarea.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const numbers = [];
    for (const line of lines) {
        const n = parseInt(line, 10);
        if (!Number.isNaN(n) && n > 0) numbers.push(n);
    }
    return [...new Set(numbers)];
}

async function bulkUpdateOrderStatus(orderStatus) {
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    const btnDelivered = document.getElementById('bulkUpdateSetDelivered');
    const btnReturned = document.getElementById('bulkUpdateSetReturned');
    const btnCancelled = document.getElementById('bulkUpdateSetCancelled');
    const btnPieceReceived = document.getElementById('bulkUpdateSetPieceReceived');
    
    // Determine which button was clicked based on orderStatus
    let activeButton = null;
    if (orderStatus === 'delivered') {
        activeButton = btnDelivered;
    } else if (orderStatus === 'returned') {
        activeButton = btnReturned;
    } else if (orderStatus === 'cancelled') {
        activeButton = btnCancelled;
    }
    
    const buttons = [btnDelivered, btnReturned, btnCancelled, btnPieceReceived];
    const originalTexts = buttons.map(b => {
        if (!b) return '';
        // Get text content, preserving structure but trimming whitespace
        return b.textContent.trim();
    });
    
    // Disable all buttons and show loading on active button
    buttons.forEach((b, index) => {
        if (b) {
            b.disabled = true;
            if (b === activeButton) {
                // Add loading spinner to the active button
                b.innerHTML = '<span class="btn-loading-spinner"></span>' + originalTexts[index];
            }
        }
    });
    
    try {
        const response = await fetch(`${API_BASE}/orders/bulk-update-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_numbers: orderNumbers, order_status: orderStatus }),
        });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Bulk update failed');
        }
        const result = await response.json();
        showBulkUpdateResults(result);
        loadOrders();
    } catch (error) {
        showToast(error.message || 'Bulk update failed', 'error');
    } finally {
        // Restore original button texts
        buttons.forEach((b, index) => {
            if (b) {
                b.disabled = false;
                b.innerHTML = originalTexts[index];
            }
        });
    }
}

async function bulkUpdatePieceReceived() {
    const orderNumbers = parseOrderNumbersFromTextarea();
    if (orderNumbers.length === 0) {
        showToast('Enter at least one valid order number (one per line).', 'error');
        return;
    }
    const btnDelivered = document.getElementById('bulkUpdateSetDelivered');
    const btnReturned = document.getElementById('bulkUpdateSetReturned');
    const btnCancelled = document.getElementById('bulkUpdateSetCancelled');
    const btnPieceReceived = document.getElementById('bulkUpdateSetPieceReceived');
    const buttons = [btnDelivered, btnReturned, btnCancelled, btnPieceReceived];
    const originalTexts = buttons.map(b => {
        if (!b) return '';
        // Get text content, preserving structure but trimming whitespace
        return b.textContent.trim();
    });
    
    // Disable all buttons and show loading on the active button
    buttons.forEach((b, index) => {
        if (b) {
            b.disabled = true;
            if (b === btnPieceReceived) {
                // Add loading spinner to the active button
                b.innerHTML = '<span class="btn-loading-spinner"></span>' + originalTexts[index];
            }
        }
    });
    
    try {
        // First, update piece_received to "Received"
        const pieceReceivedResponse = await fetch(`${API_BASE}/orders/bulk-update-piece-received`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_numbers: orderNumbers }),
        });
        if (!pieceReceivedResponse.ok) {
            const err = await pieceReceivedResponse.json();
            throw new Error(err.detail || 'Failed to update piece received');
        }
        const pieceReceivedResult = await pieceReceivedResponse.json();
        
        // Then, automatically set order status to "returned"
        let statusUpdateResult = null;
        let statusUpdateError = null;
        try {
            const statusResponse = await fetch(`${API_BASE}/orders/bulk-update-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_numbers: orderNumbers, order_status: 'returned' }),
            });
            if (!statusResponse.ok) {
                const err = await statusResponse.json();
                statusUpdateError = err.detail || 'Failed to update order status';
            } else {
                statusUpdateResult = await statusResponse.json();
            }
        } catch (error) {
            statusUpdateError = error.message || 'Failed to update order status';
        }
        
        // Show results - prioritize piece received result, but mention status update
        if (statusUpdateError) {
            showToast(`Piece received updated, but failed to set status to Returned: ${statusUpdateError}`, 'warning');
        } else {
            showToast(`Piece received updated and order status set to Returned for ${orderNumbers.length} order(s)`, 'success');
        }
        
        // Show the piece received results (this is the primary operation)
        showBulkUpdateResults(pieceReceivedResult);
        loadOrders();
    } catch (error) {
        showToast(error.message || 'Bulk update failed', 'error');
    } finally {
        // Restore original button texts
        buttons.forEach((b, index) => {
            if (b) {
                b.disabled = false;
                b.innerHTML = originalTexts[index];
            }
        });
    }
}

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

function showPostExAmountMismatchesModal(mismatches) {
    const modal = document.getElementById('postExAmountMismatchesModal');
    const tbody = document.getElementById('postExAmountMismatchesBody');
    if (!modal || !tbody) return;
    tbody.innerHTML = mismatches.map(m => {
        const diff = (m.receivable - m.csv_net_amount).toFixed(2);
        return `<tr><td>${m.order_number}</td><td>${m.receivable.toFixed(2)}</td><td>${m.csv_net_amount.toFixed(2)}</td><td>${diff}</td></tr>`;
    }).join('');
    modal.style.display = 'flex';
}

function closePostExAmountMismatchesModal() {
    const modal = document.getElementById('postExAmountMismatchesModal');
    if (modal) modal.style.display = 'none';
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

    // PostEx amount mismatches modal
    const mismatchesModal = document.getElementById('postExAmountMismatchesModal');
    const closeMismatchesBtn = document.getElementById('closePostExAmountMismatchesModal');
    const closeMismatchesBtn2 = document.getElementById('closePostExAmountMismatchesBtn');
    if (mismatchesModal) {
        mismatchesModal.addEventListener('click', (e) => {
            if (e.target === mismatchesModal) closePostExAmountMismatchesModal();
        });
    }
    if (closeMismatchesBtn) closeMismatchesBtn.addEventListener('click', closePostExAmountMismatchesModal);
    if (closeMismatchesBtn2) closeMismatchesBtn2.addEventListener('click', closePostExAmountMismatchesModal);
});

// Make functions globally accessible
window.closeModal = closeModal;
window.syncShopifyProducts = syncShopifyProducts;
window.fetchDeliveryStatus = fetchDeliveryStatus;
window.closeDeliveryStatusModal = closeDeliveryStatusModal;
