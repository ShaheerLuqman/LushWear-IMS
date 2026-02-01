// API Configuration
const API_BASE = 'http://127.0.0.1:8000/api';

// State
let products = [];
let orders = [];
let currentView = 'orders';
let productsGridApi = null;
let ordersGridApi = null;
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
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString()
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
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString(),
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
            filterParams: textFilterContains,
            cellRenderer: (params) => {
                const status = params.value || '';
                let cssClass = 'grid-status-pending';
                if (status === 'fulfilled') cssClass = 'grid-status-fulfilled';
                else if (status === 'returned' || status === 'cancelled') cssClass = 'grid-status-returned';
                return `<span class="grid-status-badge ${cssClass}">${escapeHtml(status)}</span>`;
            }
        },
        {
            headerName: 'Delivery',
            field: 'delivery_status',
            width: 240,
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
                if (hasStoredStatus) {
                    const statusText = ((lastStatus.latest_status || (lastStatus.status_history && lastStatus.status_history[0] && lastStatus.status_history[0].status)) || '').trim();
                    const displayStatus = statusText || '—';
                    const fetchedAt = lastStatus.fetched_at ? new Date(lastStatus.fetched_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
                    const courierEsc = (courier || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    const trackEsc = (order.tracking_number || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    return `<div class="delivery-cell-with-status" title="${escapeHtml(statusText)}">
                        <button type="button" class="grid-delivery-refresh-btn" onclick="event.stopPropagation(); fetchDeliveryStatus('${order.id}', '${courierEsc}', '${trackEsc}')" title="Refresh status"><span>🔄</span></button>
                        <span class="delivery-status-preview">${escapeHtml(displayStatus)}</span>
                        ${fetchedAt ? `<span class="delivery-fetched-at">${escapeHtml(fetchedAt)}</span>` : ''}
                    </div>`;
                }
                const courierEsc = (courier || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const trackEsc = (order.tracking_number || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                return `<button class="grid-delivery-btn" onclick="fetchDeliveryStatus('${order.id}', '${courierEsc}', '${trackEsc}')">
                    <span>Fetch</span><span style="font-size: 10px;">🔄</span>
                </button>`;
            }
        },
        {
            headerName: 'Total',
            field: 'total_amount',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString()
        },
        {
            headerName: 'Received',
            field: 'advance_amount',
            width: 100,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            filterValueGetter: numberFilterValueGetter,
            editable: true,
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString(),
            valueSetter: (params) => {
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
                const total = parseFloat(params.data.total_amount) || 0;
                const advance = parseFloat(params.data.advance_amount) || 0;
                return total - advance;
            },
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString()
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
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString(),
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
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString(),
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
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString(),
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
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString()
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
                const total = parseFloat(params.data.total_amount) || 0;
                const delivery = parseFloat(params.data.delivery_charge) || 0;
                const tax = parseFloat(params.data.tax_amount) || 0;
                const cost = parseFloat(params.data.cost_price) || 0;
                if (status === 'returned') return -delivery;
                return total - (delivery + tax + cost);
            },
            valueFormatter: (params) => Math.round(params.value || 0).toLocaleString(),
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
            headerName: 'Piece With',
            field: 'piece_with',
            width: 120,
            filter: 'agTextColumnFilter',
            filterParams: textFilterContains,
            editable: true,
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agSelectCellEditor',
            cellEditorParams: {
                values: ['Customer', 'Rider', 'Warehouse']
            },
            valueFormatter: (params) => params.value || '-',
            cellRenderer: (params) => {
                const v = (params.value || '').trim();
                if (!v) return '<span style="color: var(--text-muted);">-</span>';
                let cssClass = 'grid-status-pending';
                if (v === 'Customer') cssClass = 'grid-status-fulfilled';
                else if (v === 'Rider') cssClass = 'grid-status-returned';
                return `<span class="grid-status-badge ${cssClass}">${escapeHtml(v)}</span>`;
            },
            valueSetter: (params) => {
                const newValue = (params.newValue || '').trim();
                if (['Customer', 'Rider', 'Warehouse'].includes(newValue)) {
                    params.data.piece_with = newValue;
                    saveOrderField(params.data.id, 'piece_with', newValue);
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
            headerName: 'Final Status',
            field: 'final_status',
            width: 110,
            filter: 'agSetColumnFilter',
            floatingFilter: true,
            filterParams: {
                values: ['OK', 'Warning', 'Alert', 'None']
            },
            sortable: true,
            valueGetter: (params) => {
                const order = params.data;
                const status = (order.order_status || '').toLowerCase();
                const pieceWith = (order.piece_with || '').trim();
                
                // Calculate receivable amount (same logic as Receivable column)
                const total = parseFloat(order.total_amount) || 0;
                const advance = parseFloat(order.advance_amount) || 0;
                const delivery = parseFloat(order.delivery_charge) || 0;
                const tax = parseFloat(order.tax_amount) || 0;
                let receivable = 0;
                
                if (status === 'returned') {
                    receivable = -delivery;
                } else {
                    receivable = total - (advance + delivery + tax);
                }
                
                // Apply status rules
                if (status === 'fulfilled') {
                    if (receivable === 0) {
                        return 'OK';
                    } else {
                        return 'Warning';
                    }
                } else if (status === 'returned') {
                    if (pieceWith === 'Warehouse') {
                        return 'OK';
                    } else {
                        return 'Alert';
                    }
                }
                
                // Default: no indicator for other cases
                return 'None';
            },
            cellRenderer: (params) => {
                const value = params.value || 'None';
                if (value === 'OK') {
                    return '<span style="font-size: 18px;">🟢</span>';
                } else if (value === 'Warning') {
                    return '<span style="font-size: 18px;">🟡</span>';
                } else if (value === 'Alert') {
                    return '<span style="font-size: 18px;">🔴</span>';
                }
                return '<span style="color: var(--text-muted);">-</span>';
            }
        }
    ];

    const gridOptions = {
        columnDefs: columnDefs,
        rowData: [],
        rowSelection: 'multiple',
        suppressRowClickSelection: true,
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
            const status = (params.data.order_status || '').toLowerCase();
            if (status === 'cancelled') {
                return { opacity: '0.5', textDecoration: 'line-through' };
            }
            return null;
        },
        onGridReady: (params) => {
            ordersGridApi = params.api;
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
    if (syncProductsBtn && syncOrdersBtn) {
        if (viewName === 'products') {
            syncProductsBtn.style.display = 'inline-flex';
            syncOrdersBtn.style.display = 'none';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'none';
            if (ordersMonthNav) ordersMonthNav.style.display = 'none';
        } else if (viewName === 'orders') {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'inline-flex';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'inline-flex';
            if (ordersMonthNav) ordersMonthNav.style.display = 'flex';
        } else {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'none';
            if (uploadPostExCsvBtn) uploadPostExCsvBtn.style.display = 'none';
            if (ordersMonthNav) ordersMonthNav.style.display = 'none';
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
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            if (ordersGridApi) {
                ordersGridApi.setGridOption('rowData', orders);
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
        { id: '1', order_number: 2719, courier: '1289', order_status: 'fulfilled', piece_with: 'Customer', delivery_status: 'delivered', total_amount: 4247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '2', order_number: 2720, courier: 'RIDER', order_status: 'fulfilled', piece_with: 'Customer', delivery_status: 'delivered', total_amount: 7697, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '3', order_number: 2721, courier: '1287', order_status: 'pending', piece_with: 'Warehouse', delivery_status: 'not_delivered', total_amount: 3248, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '4', order_number: 2722, courier: 'RIDER', order_status: 'fulfilled', piece_with: 'Customer', delivery_status: 'delivered', total_amount: 8247, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '5', order_number: 2724, courier: '1293', order_status: 'returned', piece_with: 'Rider', delivery_status: 'not_delivered', total_amount: 3247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() }
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
        await loadOrders();
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

async function fetchDeliveryStatus(orderId, courier, trackingNumber) {
    console.log('fetchDeliveryStatus called with:', { orderId, courier, trackingNumber });
    
    if (!orderId) {
        showToast('Order ID not available', 'error');
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
        // Update order in grid so Delivery column shows last status + Refresh
        if (ordersGridApi) {
            ordersGridApi.forEachNode(node => {
                if (node.data && node.data.id === orderId) {
                    node.setData({ ...node.data, delivery_status: data });
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
