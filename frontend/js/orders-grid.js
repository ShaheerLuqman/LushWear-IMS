// Orders and products AG Grid setup: column definitions, cell renderers,
// and the grid-level event wiring.

// ============================================
// AG Grid Initialization
// ============================================

function initGrids() {
    initProductsGrid();
    initOrdersGrid();
    initTransactionsGrid();
    initLedgerDetailGrid();
    initTrialBalance();
    initBills();
    initCourierPaymentReport();
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

function parseTransactionAmount(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).replace(/,/g, '').trim();
    if (raw === '') return null;
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) return null;
    return parsed;
}

function formatTransactionCell(value) {
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

/** Format a date for display as DD/MM/YYYY. Accepts Date, ISO string, or YYYY-MM-DD string. */
function formatDateDDMMYYYY(value) {
    if (value == null || value === '') return '';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value || '').slice(0, 10);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

/** Format a date-time for display as DD/MM/YYYY, HH:MM. Accepts Date or ISO string. */
function formatDateTimeDDMMYYYY(value) {
    if (value == null || value === '') return '';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value || '');
    const datePart = formatDateDDMMYYYY(d);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${datePart}, ${hours}:${minutes}`;
}

/** Parse DD/MM/YYYY or D/M/YYYY string to YYYY-MM-DD. Returns null if invalid. */
function parseDDMMYYYYToYYYYMMDD(str) {
    if (str == null || typeof str !== 'string') return null;
    const trimmed = str.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/[/\-.]/);
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

// Row actions menu (triple dot) for a product row, mirroring
// createBillRowMenu/createTransactionRowMenu's pattern: a menu scales to more
// actions without another column reshuffle. Currently just the one action -
// open editVariantCostsModal, which also handles the recalculate-order-costs
// action for the same product.
function createProductRowMenu(params) {
    const product = params.data;
    const wrapper = document.createElement('div');
    wrapper.className = 'bill-cell-center';
    if (!product || !product.id) return wrapper;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'product-menu-btn';
    btn.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    btn.title = 'More actions';

    let menu = null;

    function closeMenu() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
        btn.classList.remove('open');
    }

    function addOption({ label, icon, onClick }) {
        const option = document.createElement('div');
        option.className = 'folio-dropdown-option';
        option.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
        option.addEventListener('click', () => {
            closeMenu();
            onClick();
        });
        menu.appendChild(option);
    }

    function openMenu() {
        if (menu) return;
        btn.classList.add('open');

        menu = document.createElement('div');
        menu.className = 'folio-dropdown-panel product-menu-panel';

        addOption({
            label: (product.variants || []).length ? 'Update variant price' : 'Update cost price',
            icon: 'fa-tag',
            onClick: () => openEditVariantCostsModal(product)
        });

        document.body.appendChild(menu);
        const rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 2) + 'px';
        menu.style.left = Math.max(rect.right - menu.offsetWidth, 8) + 'px';

        const closeHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                closeMenu();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu) closeMenu();
        else openMenu();
    });

    wrapper.appendChild(btn);
    return wrapper;
}

function initProductsGrid() {
    const gridDiv = document.getElementById('productsGrid');
    if (!gridDiv) return;

    const columnDefs = [
        {
            headerName: '',
            colId: 'select',
            width: 52,
            minWidth: 52,
            maxWidth: 52,
            checkboxSelection: true,
            headerCheckboxSelection: true,
            headerCheckboxSelectionFilteredOnly: true,
            filter: ProductsClearFiltersPassThroughFilter,
            sortable: false,
            floatingFilter: true,
            floatingFilterComponent: ProductsClearFiltersFloatingFilter,
            suppressSizeToFit: true
        },
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
            flex: 1.8,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['contains', 'startsWith', 'endsWith'],
                defaultOption: 'contains'
            }
        },
        {
            headerName: 'Collection',
            field: 'collection',
            width: 130,
            filter: 'agTextColumnFilter',
            filterParams: {
                filterOptions: ['equals'],
                defaultOption: 'equals',
                maxNumConditions: 1,
                textMatcher: ({ filterOption, value, filterText }) => {
                    if (filterOption !== 'equals') return value === filterText;
                    // Sentinel for "empty collection" so AG Grid doesn't treat it as no filter
                    if (filterText === '__empty__') {
                        return (value === '' || value == null);
                    }
                    return value === filterText;
                }
            },
            floatingFilterComponent: CollectionFloatingFilter,
            valueGetter: (params) => {
                const v = params.data?.collection;
                return (v == null || v === '') ? '' : v;
            },
            valueFormatter: (params) => (params.value == null || params.value === '') ? '—' : params.value,
            editable: () => isEditingAllowed(),
            cellStyle: { cursor: 'pointer' },
            cellEditor: 'agSelectCellEditor',
            cellEditorParams: {
                values: ['', 'Cami Sets', 'Linen PJs', 'Pajama T-Shirt', 'Silk Collection', 'Trousers']
            },
            valueSetter: (params) => {
                const raw = params.newValue === '' ? '' : params.newValue;
                params.data.collection = raw;
                saveProductCollection(params.data.id, raw);
                return true;
            }
        },
        {
            headerName: 'Price (Rs)',
            field: 'price',
            width: 100,
            filter: 'agNumberColumnFilter',
            valueFormatter: (params) => {
                const val = parseFloat(params.value) || 0;
                return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
        },
        {
            headerName: 'Variants',
            field: 'variants',
            flex: 3.2,
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
                // Falls back to the product's own cost_price for a variant with none of
                // its own yet - same fallback used when prefilling a purchase bill line.
                const fallbackCost = params.data?.cost_price;
                return `<div class="grid-variants-container">${sortedVariants.map(v => {
                    const qty = v.quantity || 0;
                    const isLow = qty < 10;
                    const cost = v.cost_price ?? fallbackCost;
                    const costText = cost != null ? ` @ ${formatAmount(cost)}` : '';
                    return `<span class="grid-variant-tag ${isLow ? 'low' : ''}">${escapeHtml(v.title)}: ${qty}${costText}</span>`;
                }).join('')}</div>`;
            }
        },
        {
            headerName: 'Total Qty',
            field: 'total_quantity',
            width: 100,
            filter: 'agNumberColumnFilter',
            cellRenderer: (params) => {
                const qty = params.value || 0;
                const cssClass = qty < 10 ? 'low' : 'ok';
                return `<span class="grid-quantity-badge ${cssClass}">${qty}</span>`;
            }
        },
        {
            headerName: 'More actions',
            colId: 'moreActions',
            width: 110,
            filter: false,
            sortable: false,
            cellRenderer: createProductRowMenu
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
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
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

// No-op filter for first column so floating filter cell is rendered (AG Grid only shows floating filter when column has a filter)
function OrdersClearFiltersPassThroughFilter() {}
OrdersClearFiltersPassThroughFilter.prototype.init = function () {};
OrdersClearFiltersPassThroughFilter.prototype.getGui = function () { return document.createElement('div'); };
OrdersClearFiltersPassThroughFilter.prototype.doesRowPassFilter = function () { return true; }; // never filter out rows
OrdersClearFiltersPassThroughFilter.prototype.getModel = function () { return null; };
OrdersClearFiltersPassThroughFilter.prototype.setModel = function () {};

// Custom floating filter for first column: "Clear all filters" button
function ClearFiltersFloatingFilter() {}
ClearFiltersFloatingFilter.prototype.init = function (params) {
    this.eGui = document.createElement('div');
    this.eGui.style.width = '100%';
    this.eGui.style.display = 'flex';
    this.eGui.style.alignItems = 'center';
    this.eGui.style.justifyContent = 'center';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm orders-clear-filters-btn';
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'filter-x');
    icon.setAttribute('aria-hidden', 'true');
    icon.className = 'orders-clear-filters-icon';
    btn.appendChild(icon);
    btn.title = 'Clear column filters (keeps period selection)';
    btn.addEventListener('click', function () {
        const api = params.api;
        if (api) api.setFilterModel(null);
    });
    if (window.lucide) {
        lucide.createIcons({ root: btn });
    }
    this.eGui.appendChild(btn);
};
ClearFiltersFloatingFilter.prototype.getGui = function () { return this.eGui; };
ClearFiltersFloatingFilter.prototype.onParentModelChanged = function () {};

// No-op filter for products grid first column (so floating filter cell is rendered)
function ProductsClearFiltersPassThroughFilter() {}
ProductsClearFiltersPassThroughFilter.prototype.init = function () {};
ProductsClearFiltersPassThroughFilter.prototype.getGui = function () { return document.createElement('div'); };
ProductsClearFiltersPassThroughFilter.prototype.doesRowPassFilter = function () { return true; };
ProductsClearFiltersPassThroughFilter.prototype.getModel = function () { return null; };
ProductsClearFiltersPassThroughFilter.prototype.setModel = function () {};

// Clear all filters button for products grid (floating filter in first column)
function ProductsClearFiltersFloatingFilter() {}
ProductsClearFiltersFloatingFilter.prototype.init = function (params) {
    this.eGui = document.createElement('div');
    this.eGui.style.width = '100%';
    this.eGui.style.display = 'flex';
    this.eGui.style.alignItems = 'center';
    this.eGui.style.justifyContent = 'center';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm orders-clear-filters-btn';
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'filter-x');
    icon.setAttribute('aria-hidden', 'true');
    icon.className = 'orders-clear-filters-icon';
    btn.appendChild(icon);
    btn.title = 'Clear all filters';
    btn.addEventListener('click', function () {
        if (params.api) params.api.setFilterModel(null);
    });
    if (window.lucide) {
        lucide.createIcons({ root: btn });
    }
    this.eGui.appendChild(btn);
};
ProductsClearFiltersFloatingFilter.prototype.getGui = function () { return this.eGui; };
ProductsClearFiltersFloatingFilter.prototype.onParentModelChanged = function () {};

// Order Status filtering: a checkbox popup (multiple statuses at once) rather than a
// single-select dropdown. Two parts, like AG Grid's own filter/floating-filter split:
// OrderStatusSetFilter is the real column filter (model: { values: [...] } - order_status
// must be one of `values`; no model = no filtering), OrderStatusFloatingFilter is the
// checkbox popup that drives it via api.setFilterModel().
const ORDER_STATUS_VALUES = ['unfulfilled', 'fulfilled', 'delivered', 'RFD', 'returned', 'cancelled', 'CNA', 'ICA'];
function orderStatusDisplayLabel(v) {
    return (v === 'RFD' || v === 'CNA' || v === 'ICA') ? v : (v.charAt(0).toUpperCase() + v.slice(1));
}

function OrderStatusSetFilter() {}
OrderStatusSetFilter.prototype.init = function (params) { this.params = params; this.model = null; };
OrderStatusSetFilter.prototype.getGui = function () {
    if (!this.eGui) this.eGui = document.createElement('div'); // no popup UI - the floating filter is the only UI
    return this.eGui;
};
OrderStatusSetFilter.prototype.doesFilterPass = function (params) {
    if (!this.model) return true;
    return this.model.values.indexOf((params.data && params.data.order_status) || '') !== -1;
};
OrderStatusSetFilter.prototype.isFilterActive = function () { return !!this.model; };
OrderStatusSetFilter.prototype.getModel = function () { return this.model; };
OrderStatusSetFilter.prototype.setModel = function (model) { this.model = model || null; };

function OrderStatusFloatingFilter() {}
OrderStatusFloatingFilter.prototype.init = function (params) {
    this.params = params;
    const api = params.api;
    const columnId = params.column.getColId();

    this.eGui = document.createElement('div');
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grid-floating-filter-select';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.textContent = 'All';
    this.btn = btn;
    this.eGui.appendChild(btn);

    const menu = document.createElement('div');
    menu.className = 'date-range-menu order-status-filter-menu';
    menu.style.display = 'none';

    const checkboxes = {};
    const applySelection = () => {
        const selected = ORDER_STATUS_VALUES.filter((v) => checkboxes[v].checked);
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (selected.length === ORDER_STATUS_VALUES.length) {
            delete newModel[columnId];
        } else {
            newModel[columnId] = { values: selected };
        }
        api.setFilterModel(newModel);
        this.updateButtonLabel(selected);
    };

    const allRow = document.createElement('label');
    allRow.className = 'order-status-filter-option order-status-filter-option--all';
    const allCb = document.createElement('input');
    allCb.type = 'checkbox';
    allCb.checked = true;
    const allLabel = document.createElement('span');
    allLabel.textContent = 'All';
    allRow.appendChild(allCb);
    allRow.appendChild(allLabel);
    menu.appendChild(allRow);
    allCb.addEventListener('change', () => {
        ORDER_STATUS_VALUES.forEach((v) => { checkboxes[v].checked = allCb.checked; });
        applySelection();
    });

    ORDER_STATUS_VALUES.forEach((v) => {
        const row = document.createElement('label');
        row.className = 'order-status-filter-option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        const label = document.createElement('span');
        label.textContent = orderStatusDisplayLabel(v);
        row.appendChild(cb);
        row.appendChild(label);
        menu.appendChild(row);
        checkboxes[v] = cb;
        cb.addEventListener('change', () => {
            allCb.checked = ORDER_STATUS_VALUES.every((sv) => checkboxes[sv].checked);
            applySelection();
        });
    });

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display === 'none') {
            const rect = btn.getBoundingClientRect();
            menu.style.display = 'block';
            const left = rect.left + window.scrollX;
            const maxLeft = window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8;
            menu.style.top = `${rect.bottom + window.scrollY}px`;
            menu.style.left = `${Math.max(window.scrollX + 8, Math.min(left, maxLeft))}px`;
        } else {
            menu.style.display = 'none';
        }
    });
    this._outsideClickHandler = (e) => {
        if (menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== btn) {
            menu.style.display = 'none';
        }
    };
    document.addEventListener('click', this._outsideClickHandler);

    document.body.appendChild(menu);
    this.menu = menu;
    this.checkboxes = checkboxes;
    this.allCb = allCb;
};
OrderStatusFloatingFilter.prototype.updateButtonLabel = function (selected) {
    this.btn.textContent = selected.length === ORDER_STATUS_VALUES.length ? 'All'
        : selected.length === 0 ? 'None'
        : `${selected.length} selected`;
};
OrderStatusFloatingFilter.prototype.getGui = function () { return this.eGui; };
OrderStatusFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    const selected = (parentModel && Array.isArray(parentModel.values)) ? parentModel.values : ORDER_STATUS_VALUES.slice();
    ORDER_STATUS_VALUES.forEach((v) => { this.checkboxes[v].checked = selected.indexOf(v) !== -1; });
    this.allCb.checked = selected.length === ORDER_STATUS_VALUES.length;
    this.updateButtonLabel(selected);
};
OrderStatusFloatingFilter.prototype.destroy = function () {
    if (this.menu && this.menu.parentNode) this.menu.parentNode.removeChild(this.menu);
    document.removeEventListener('click', this._outsideClickHandler);
};

// Custom floating filter for Final Status: dropdown (OK, Warning, None, All)
const FINAL_STATUS_VALUES = ['OK', 'Warning', 'None'];
function FinalStatusFloatingFilter() {}
FinalStatusFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.eGui = document.createElement('div');
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.className = 'grid-floating-filter-select';
    select.style.width = '100%';
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

// Custom floating filter for Collection (products): dropdown like Order Status, but
// its options are the distinct collection values actually on the loaded products
// (not a fixed list) - refreshCollectionFilterValues() rebuilds them after each
// loadProducts(), since products (and this filter) load after the grid itself does.
function collectionValuesFromProducts() {
    const values = new Set(['']);
    (products || []).forEach((p) => values.add(p.collection || ''));
    return ['', ...Array.from(values).filter((v) => v !== '').sort((a, b) => a.localeCompare(b))];
}

const collectionFloatingFilterInstances = [];

function refreshCollectionFilterValues() {
    const values = collectionValuesFromProducts();
    collectionFloatingFilterInstances.forEach((instance) => instance.setValues(values));
}

function CollectionFloatingFilter() {}
CollectionFloatingFilter.prototype.init = function (params) {
    this.params = params;
    this.values = collectionValuesFromProducts();
    this.eGui = document.createElement('div');
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.className = 'grid-floating-filter-select';
    select.style.width = '100%';
    const api = params.api;
    const columnId = params.column.getColId();
    select.addEventListener('change', function () {
        const val = select.value;
        const currentModel = api.getFilterModel() || {};
        const newModel = Object.assign({}, currentModel);
        if (val === '__all__') {
            delete newModel[columnId];
        } else {
            // Use sentinel for empty so AG Grid doesn't treat it as "no filter"
            const filterVal = (val === '') ? '__empty__' : val;
            newModel[columnId] = { filterType: 'text', type: 'equals', filter: filterVal };
        }
        api.setFilterModel(newModel);
    });
    this.eGui.appendChild(select);
    this.select = select;
    this.setValues(this.values);
    collectionFloatingFilterInstances.push(this);
};
CollectionFloatingFilter.prototype.setValues = function (values) {
    this.values = values;
    const current = this.select.value || '__all__';
    this.select.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'All';
    this.select.appendChild(allOption);
    values.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v === '' ? '—' : v;
        this.select.appendChild(opt);
    }, this);
    // Keep the current selection if it's still a valid option, else fall back to "All".
    this.select.value = (current === '__all__' || values.indexOf(current) !== -1) ? current : '__all__';
};
CollectionFloatingFilter.prototype.getGui = function () { return this.eGui; };
CollectionFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
    if (!parentModel || parentModel.filter === undefined || parentModel.filter === null) {
        this.select.value = '__all__';
    } else if (parentModel.filter === '__empty__') {
        this.select.value = '';
    } else if (this.values.indexOf(parentModel.filter) !== -1) {
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
    this.eGui.className = 'grid-floating-filter-wrap';
    this.eGui.style.width = '100%';
    const select = document.createElement('select');
    select.className = 'grid-floating-filter-select';
    select.style.width = '100%';
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

// Maps an order's advance_status code to a colored indicator + tooltip.
// Codes (kept in sync with backend app/advance_status.py):
//   1 = no advance, 2 = Shopify only, 3 = transaction only, 4 = match, 5 = mismatch
function advanceStatusMeta(status) {
    switch (Number(status)) {
        case 2: return { color: '#f59e0b', title: 'Shopify advance, no transaction entry' };      // amber
        case 3: return { color: '#3b82f6', title: 'Transaction entry, no Shopify advance' };        // blue
        case 4: return { color: '#22c55e', title: 'Advance matches (Shopify & transaction, within Rs. 5)' };  // green
        case 5: return { color: '#ef4444', title: 'Advance mismatch (Shopify vs transaction differ by Rs. 5+)' }; // red
        case 1:
        default: return { color: '#d1d5db', title: 'No advance amount' };                        // grey
    }
}

/** Net profit for one order row: total - (delivery + tax + cost), or -delivery for a
 * returned order. null when not applicable (not delivered/returned, or no delivery_charge
 * recorded yet). Single source of truth for the net_profit column, profit_percent column,
 * and the selected-rows footer sum below - keep all three reading from here instead of
 * recomputing so the definition can't drift between them.
 * Backend's month-summary net_profit (get_month_summary_totals SQL function) mirrors this
 * same per-row formula, just summed as a period aggregate over unfiltered orders instead of
 * selected rows - a separate implementation by necessity, so keep both in sync if this changes. */
function computeNetProfit(row) {
    const status = (row.order_status || '').toLowerCase();
    const delivery = parseFloat(row.delivery_charge) || 0;
    if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
    if (status === 'returned') return -delivery;
    const total = parseFloat(row.total_amount) || 0;
    const tax = parseFloat(row.tax_amount) || 0;
    const cost = parseFloat(row.cost_price) || 0;
    return total - (delivery + tax + cost);
}

/** Amount the courier still owes for one order: total - (advance + delivery + tax), or
 * -delivery for a returned order (a negative result means the shop owes the courier
 * instead, e.g. a return handling fee). null when not delivered/returned or delivery_charge
 * not yet recorded. Single source of truth for the receivable column/footer sum here and
 * for the Courier Payment Report page (courier-payment-report.js) - keep both reading from here. */
function computeReceivable(row) {
    const status = (row.order_status || '').toLowerCase();
    const delivery = parseFloat(row.delivery_charge) || 0;
    if ((status !== 'delivered' && status !== 'returned') || delivery === 0) return null;
    if (status === 'returned') return -delivery;
    const total = parseFloat(row.total_amount) || 0;
    const advance = parseFloat(row.advance_amount) || 0;
    const tax = parseFloat(row.tax_amount) || 0;
    return total - (advance + delivery + tax);
}

function initOrdersGrid() {
    const gridDiv = document.getElementById('ordersGrid');
    if (!gridDiv) return;

    const columnDefs = buildOrdersGridColumns();

    // Function to calculate sums for selected rows (cancelled rows are excluded from sums)
    function calculateSelectedSums() {
        if (!ordersGridApi) return {};
        
        const selectedRows = ordersGridApi.getSelectedRows();
        const rowsForSum = selectedRows.filter(
            (row) => (row.order_status || '').toLowerCase() !== 'cancelled'
        );
        const cancelledCount = selectedRows.length - rowsForSum.length;
        if (rowsForSum.length === 0) {
            return {
                count: 0,
                cancelledCount,
                total_amount: 0,
                advance_amount: 0,
                cod: 0,
                delivery_charge: 0,
                tax_amount: 0,
                receivable: 0,
                cost_price: 0,
                net_profit: 0,
                total_amount_for_profit: 0
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
        let total_amount_for_profit = 0; // Total amount for delivered/returned orders only (for profit % calculation)
        
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
            
            // Calculate receivable per row (only for delivered or returned orders with delivery_charge set)
            if ((status === 'delivered' || status === 'returned') && rowDelivery > 0) {
                total_amount_for_profit += rowTotal; // Track total for profit % calculation
                receivable += computeReceivable(row);
            }
            
            const rowNetProfit = computeNetProfit(row);
            if (rowNetProfit != null) {
                net_profit += rowNetProfit;
            }
        });
        
        return {
            count: rowsForSum.length,
            cancelledCount,
            total_amount,
            advance_amount,
            cod,
            delivery_charge,
            tax_amount,
            receivable,
            cost_price,
            net_profit,
            total_amount_for_profit
        };
    }
    
    // Function to update footer row (make it accessible globally)
    updateFooterRow = function() {
        if (!ordersGridApi) return;
        
        const sums = calculateSelectedSums();
        const selectedCount = sums.count;
        const cancelledCount = sums.cancelledCount || 0;

        // Update selected count text at bottom right
        const selectedCountEl = document.getElementById('ordersSelectedCount');
        if (selectedCountEl) {
            selectedCountEl.textContent = cancelledCount > 0
                ? `${selectedCount} rows selected + ${cancelledCount} cancelled rows`
                : `${selectedCount} row(s) selected`;
            selectedCountEl.style.display = (selectedCount > 0 || cancelledCount > 0) ? 'block' : 'none';
        }
        
        const footerData = {
            id: '__footer__',
            __isFooter: true,
            order_number: null,
            courier: null,
            tracking_number: null,
            from_account_id: null,
            to_account_id: null,
            order_status: null,
            delivery_status: null,
            total_amount: sums.total_amount,
            advance_amount: sums.advance_amount,
            cod: sums.cod,
            delivery_charge: sums.delivery_charge,
            tax_amount: sums.tax_amount,
            receivable: sums.receivable,
            cost_price: sums.cost_price,
            net_profit: sums.net_profit,
            profit_percent: sums.total_amount_for_profit > 0 ? (sums.net_profit / sums.total_amount_for_profit) * 100 : null,
            piece_received: null,
            order_receiving_date: null,
            courier_pickup_date: null,
            final_status: null
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
            // Summing order numbers would be meaningless - show nothing in footer
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
        singleClickEdit: true,
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
        onFilterChanged: (params) => {
            if (!params.api) return;
            if (typeof window._ordersDateRangeUpdateButtonLabel === 'function') window._ordersDateRangeUpdateButtonLabel();
            // Temporarily added "fetch by number" orders: remove when filter is cleared or Order# is changed
            const filterModel = params.api.getFilterModel() || {};
            const orderNumCol = filterModel.order_number;
            const filterValue = orderNumCol && (orderNumCol.filter != null) ? String(orderNumCol.filter).trim() : '';
            // Order numbers start at 1000, so a full order number is 4 or more digits.
            const isFullOrderNumber = /^\d{4,}$/.test(filterValue);

            function removeFetchedByNumberRows() {
                if (ordersFetchedByNumberIds.size === 0) return;
                const toRemove = [];
                params.api.forEachNode((node) => {
                    if (node.data && node.data.id !== '__footer__' && ordersFetchedByNumberIds.has(node.data.id)) {
                        toRemove.push(node.data);
                    }
                });
                if (toRemove.length) {
                    params.api.applyTransaction({ remove: toRemove });
                    updateFooterRow();
                }
                ordersFetchedByNumberIds.clear();
            }

            // Clear or partial number: remove any temporarily added order and stop
            if (!isFullOrderNumber) {
                removeFetchedByNumberRows();
                return;
            }

            const displayedCount = params.api.getDisplayedRowCount();
            // Same filter but we already have a temporary row for it (e.g. re-apply): no-op
            if (displayedCount > 0) return;

            // New order-number search with 0 results: remove any previous temporary row(s) then fetch this number
            removeFetchedByNumberRows();

            (async () => {
                if (ordersFetchByNumberInFlight === filterValue) return;
                ordersFetchByNumberInFlight = filterValue;
                try {
                    const response = await fetch(`${API_BASE}/orders/by-number/${encodeURIComponent(filterValue)}`);
                    if (!response.ok) {
                        if (response.status === 404) showToast(`Order #${filterValue} not found in database`, 'info');
                        return;
                    }
                    const order = await response.json();
                    if (order && order.id) {
                        ordersFetchedByNumberIds.add(order.id);
                        params.api.applyTransaction({ add: [order], addIndex: 0 });
                        updateFooterRow();
                        showToast(`Order #${filterValue} loaded from database`, 'success');
                    }
                } catch (err) {
                    console.error('Fetch order by number failed:', err);
                    showToast('Failed to fetch order from database', 'error');
                } finally {
                    ordersFetchByNumberInFlight = null;
                }
            })();
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

    // Delegated so the per-row refresh button carries only an id - courier and tracking
    // are read from row data instead of being interpolated into an inline onclick.
    gridDiv.addEventListener('click', (e) => {
        const btn = e.target.closest('.grid-delivery-refresh-btn');
        if (!btn) return;
        e.stopPropagation();
        const id = btn.dataset.refreshOrderId;
        const node = id && ordersGridApi && ordersGridApi.getRowNode(id);
        if (node && node.data) {
            fetchDeliveryStatus(node.data.id, node.data.courier, node.data.tracking_number);
        }
    });
}

function isTransactionNewRow(data) {
    return data && data.id && String(data.id).startsWith('__new_');
}

/**
 * Account cell renderer using custom searchable dropdown.
 * Creates a clean, native-feeling dropdown with search functionality.
 * `accountField` is the side this column shows: 'from_account_id' or 'to_account_id'.
 */
function createFolioCellRenderer(params, accountField) {
    if (!params || !params.data) return document.createElement('span');

    const wrapper = document.createElement('div');
    wrapper.className = 'folio-dropdown';

    const currentFolio = params.data[accountField] || '';

    // An empty side is cash, not a missing value: it is stored as NULL but the
    // journal posts it to the cash account, so it reads as that account and its
    // statement opens from here like any other side's would.
    const emptyLabel = cashSideLabel();
    const shownLedger = currentFolio ? ledgers.find(l => l.id === currentFolio) : getCashLedger();
    const shownLedgerId = shownLedger ? shownLedger.id : '';
    const displayText = shownLedger ? shownLedger.name : emptyLabel;

    // Cash on both sides moves nothing, so a new row still needs one account.
    const isNewRow = isTransactionNewRow(params.data);
    const hasOtherData = (params.data.description && String(params.data.description).trim() !== '') ||
                         (params.data.amount != null && params.data.amount > 0);
    const needsHighlight = isNewRow && hasOtherData
        && !params.data.from_account_id && !params.data.to_account_id;

    // Display text showing selected ledger (like piece_received shows status)
    const isCashSide = !!(shownLedger && shownLedger.system_key === 'cash');
    const displaySpan = document.createElement('span');
    displaySpan.className = 'folio-display-text'
        + (needsHighlight ? ' folio-required' : (isNewRow ? ' folio-pending' : ''))
        + (isCashSide ? ' folio-cash' : '');
    displaySpan.textContent = displayText;
    displaySpan.style.cursor = isEditingAllowed() ? 'pointer' : 'default';

    // Main button that shows current selection (hidden, used for dropdown positioning)
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'folio-dropdown-btn' + (needsHighlight ? ' folio-required' : '');
    button.style.display = 'none';
    button.innerHTML = `<span class="folio-dropdown-text">${escapeHtml(displayText)}</span><span class="folio-dropdown-arrow">▼</span>`;
    
    // Click on display text opens dropdown (locked: read-only, same as the
    // Description/Amount cells which silently refuse edits while locked)
    displaySpan.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isEditingAllowed()) return;
        openDropdown();
    });

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
            const filtered = selectableLedgers().filter(l => l.name.toLowerCase().includes(filterLower));

            optionsList.innerHTML = '';

            // Cash is the empty side, not one of the options below it - picking
            // it clears the side rather than naming the account.
            const cashOption = document.createElement('div');
            cashOption.className = 'folio-dropdown-option' + (currentFolio ? '' : ' selected');
            cashOption.textContent = emptyLabel;
            cashOption.addEventListener('click', () => selectOption('', emptyLabel));
            optionsList.appendChild(cashOption);

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
                noResults.textContent = filter ? 'No ledgers found' : 'No ledgers available.';
                optionsList.appendChild(noResults);
            }

            // Create new ledger option, always last
            const createOption = document.createElement('div');
            createOption.className = 'folio-dropdown-option folio-dropdown-create';
            createOption.textContent = '+ Create new ledger...';
            createOption.addEventListener('click', () => {
                closeDropdown();
                openCreateLedgerModal((created) => selectOption(created.id, created.name));
            });
            optionsList.appendChild(createOption);
        }

        function selectOption(id, name) {
            params.data[accountField] = id || null;
            // Clearing the side leaves it on cash, which is an account like any
            // other here - same label, same statement behind the arrow.
            const shownName = id ? name : emptyLabel;
            const goToId = id || (getCashLedger()?.id || '');
            button.querySelector('.folio-dropdown-text').textContent = shownName;
            displaySpan.textContent = shownName;

            const goToBtn = wrapper._goToLedgerBtn;
            if (goToBtn) {
                goToBtn.style.opacity = goToId ? '1' : '0.4';
                goToBtn.style.cursor = goToId ? 'pointer' : 'not-allowed';
                goToBtn.title = goToId ? `Go to ${shownName}` : 'Select a ledger first';
                goToBtn._ledgerId = goToId;
            }


            if (params.data.id && !isTransactionNewRow(params.data)) {
                // Update existing entry
                updateTransactionEntry(params.data.id, { [accountField]: id || null });
            } else if (isTransactionNewRow(params.data) && id) {
                // For new entries, check if all required fields are filled and trigger auto-save
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                if (hasDescription && hasAmount) {
                    tryCreateTransactionEntryFromNewRow(params.data);
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

        // Position dropdown below display text
        document.body.appendChild(dropdownPanel);
        const rect = displaySpan.getBoundingClientRect();
        dropdownPanel.style.top = (rect.bottom + 2) + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.minWidth = Math.max(rect.width, 200) + 'px';

        // Focus search input
        setTimeout(() => searchInput.focus(), 0);

        // Close on outside click
        const closeHandler = (e) => {
            if (!dropdownPanel.contains(e.target) && e.target !== displaySpan && e.target !== button && !displaySpan.contains(e.target) && !button.contains(e.target)) {
                closeDropdown();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isEditingAllowed()) return;
        if (isOpen) {
            closeDropdown();
        } else {
            openDropdown();
        }
    });

    wrapper.appendChild(displaySpan);
    wrapper.appendChild(button);

    // Add "Go to Ledger" button next to dropdown
    const goToLedgerBtn = document.createElement('button');
    goToLedgerBtn.type = 'button';
    goToLedgerBtn.className = 'folio-goto-btn';
    goToLedgerBtn.innerHTML = '<i class="fa-solid fa-arrow-right"></i>';
    goToLedgerBtn.title = shownLedgerId ? `Go to ${displayText}` : 'Select a ledger first';
    if (!shownLedgerId) {
        goToLedgerBtn.style.opacity = '0.4';
        goToLedgerBtn.style.cursor = 'not-allowed';
    }
    // Held on the button rather than re-read from the row: a cash side is stored
    // as NULL, so the row alone cannot say which account to open.
    goToLedgerBtn._ledgerId = shownLedgerId;
    goToLedgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (goToLedgerBtn._ledgerId) {
            openLedgerDetail(goToLedgerBtn._ledgerId);
        }
    });
    
    // Store button reference on wrapper for access inside openDropdown
    wrapper._goToLedgerBtn = goToLedgerBtn;
    
    wrapper.appendChild(goToLedgerBtn);
    return wrapper;
}

// The blank row at the bottom is a form, not an entry: its empty cells say what
// they want rather than reading as a saved row someone left half-filled.
//
// Always an element, never a string - AG Grid puts a returned string through
// innerHTML, which would render a description someone typed as markup.
function transactionCellWithPlaceholder(params, placeholder) {
    const shown = params.valueFormatted != null ? params.valueFormatted : '';
    const span = document.createElement('span');
    if (shown === '' && isTransactionNewRow(params.data)) {
        span.className = 'transaction-placeholder';
        span.textContent = placeholder;
    } else {
        span.textContent = shown;
    }
    return span;
}
// Row actions menu (triple dot) for the transactions grid - just Delete for
// now, but a menu rather than a bare button so more actions can land here
// without another column reshuffle.
function createTransactionRowMenu(params) {
    const wrapper = document.createElement('div');
    if (isTransactionNewRow(params.data)) return wrapper;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'transaction-menu-btn';
    btn.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    btn.title = 'More actions';

    let menu = null;

    function closeMenu() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
        btn.classList.remove('open');
    }

    function openMenu() {
        if (menu) return;
        btn.classList.add('open');

        menu = document.createElement('div');
        menu.className = 'folio-dropdown-panel transaction-menu-panel';

        const deleteOption = document.createElement('div');
        deleteOption.className = 'folio-dropdown-option transaction-menu-option-danger';
        deleteOption.innerHTML = '<i class="fa-solid fa-trash"></i><span>Delete</span>';
        deleteOption.addEventListener('click', () => {
            closeMenu();
            deleteTransactionEntry(params.data.id);
        });
        menu.appendChild(deleteOption);

        document.body.appendChild(menu);
        const rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 2) + 'px';
        menu.style.left = Math.max(rect.right - menu.offsetWidth, 8) + 'px';

        const closeHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                closeMenu();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu) closeMenu();
        else openMenu();
    });

    wrapper.appendChild(btn);
    return wrapper;
}

function buildTransactionGridColumns() {
    return [
        {
            headerName: '#',
            colId: 'rowNum',
            flex: 5,
            minWidth: 40,
            filter: false,
            sortable: false,
            headerClass: 'transaction-row-num-header',
            cellClass: 'transaction-row-num-cell',
            // Position in the day's list, not a stored id - the blank row at the
            // bottom isn't numbered since it isn't an entry yet.
            valueGetter: (params) => (isTransactionNewRow(params.data) ? '' : params.node.rowIndex + 1),
            getQuickFilterText: () => ''
        },
        {
            // Both sides of the entry, named. An empty side is the cash account.
            // From is the account money came from, i.e. the credited side.
            headerName: 'From Account (Credit)',
            field: 'from_account_id',
            flex: 20,
            minWidth: 130,
            filter: false,
            sortable: false,
            cellRenderer: (params) => createFolioCellRenderer(params, 'from_account_id'),
            // Only the Excel export reads this - the renderer draws the cell itself.
            valueFormatter: (params) => (params.value ? ledgerNameById(params.value) : cashSideLabel()),
            getQuickFilterText: (params) => (params.value ? ledgerNameById(params.value) : cashSideLabel())
        },
        {
            // To is the account money went to, i.e. the debited side.
            headerName: 'To Account (Debit)',
            field: 'to_account_id',
            flex: 20,
            minWidth: 130,
            filter: false,
            sortable: false,
            cellRenderer: (params) => createFolioCellRenderer(params, 'to_account_id'),
            valueFormatter: (params) => (params.value ? ledgerNameById(params.value) : cashSideLabel()),
            getQuickFilterText: (params) => (params.value ? ledgerNameById(params.value) : cashSideLabel())
        },
        {
            headerName: 'Amount (PKR)',
            field: 'amount',
            flex: 15,
            minWidth: 100,
            filter: 'agNumberColumnFilter',
            editable: () => isEditingAllowed(),
            cellClass: (params) => {
                if (isTransactionNewRow(params.data)) {
                    // Highlight if description is filled but amount is empty
                    const hasAmount = params.data.amount != null && params.data.amount > 0;
                    const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                    if (hasDescription && !hasAmount) return ['transaction-required-field', 'transaction-amount-cell'];
                }
                return 'transaction-amount-cell';
            },
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => formatTransactionCell(params.value),
            getQuickFilterText: (params) => formatTransactionCell(params.value),
            cellRenderer: (params) => transactionCellWithPlaceholder(params, '0.00'),
            valueSetter: (params) => {
                if (isTransactionNewRow(params.data)) {
                    params.data.amount = parseTransactionAmount(params.newValue);
                    // Refresh cells to update highlighting
                    if (params.api) {
                        params.api.refreshCells({ rowNodes: [params.node], force: true });
                    }
                    return true;
                }
                const next = parseTransactionAmount(params.newValue);
                if (next === null || next <= 0) return false;
                params.data.amount = next;
                // Only the amount changed — the entry's two sides are edited
                // through their own cells, so resending them here would just
                // risk overwriting one with a stale value.
                updateTransactionEntry(params.data.id, { amount: next });
                return true;
            }
        },
        {
            headerName: 'Description',
            field: 'description',
            flex: 35,
            minWidth: 160,
            editable: () => isEditingAllowed(),
            cellClass: (params) => {
                if (isTransactionNewRow(params.data)) {
                    // Highlight if amount is filled but description is empty
                    const hasAmount = params.data.amount != null && params.data.amount > 0;
                    const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                    if (hasAmount && !hasDescription) return 'transaction-required-field';
                }
                return '';
            },
            cellStyle: { cursor: 'pointer' },
            valueFormatter: (params) => (params.value != null && params.value !== '' ? String(params.value) : ''),
            // Order number isn't its own column, but a search for it should still
            // find the entry even when the particulars text doesn't spell it out.
            getQuickFilterText: (params) => `${params.value || ''} ${params.data.order_number || ''}`.trim(),
            cellRenderer: (params) => transactionCellWithPlaceholder(params, 'What was this for?'),
            valueSetter: (params) => {
                const val = String(params.newValue ?? '').trim();
                if ((params.data.description || '') === val) return false;
                params.data.description = val;
                if (!isTransactionNewRow(params.data)) {
                    updateTransactionEntry(params.data.id, { description: val });
                } else if (params.api) {
                    // Refresh cells to update highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
                return true;
            }
        },
        {
            headerName: '',
            field: 'actions',
            flex: 5,
            minWidth: 40,
            filter: false,
            sortable: false,
            cellRenderer: (params) => createTransactionRowMenu(params),
            getQuickFilterText: () => ''
        }
    ];
}

function initTransactionsGrid() {
    const gridDiv = document.getElementById('transactionsGrid');
    if (!gridDiv) return;

    const gridOptions = {
        columnDefs: buildTransactionGridColumns(),
        rowData: [],
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            floatingFilter: false,
            minWidth: 80
        },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        singleClickEdit: true,
        stopEditingWhenCellsLoseFocus: true,
        getRowId: (params) => params.data.id,
        getRowClass: (params) => (isTransactionNewRow(params.data) ? 'transaction-new-row' : ''),
        onGridReady: (params) => {
            transactionsGridApi = params.api;
        },
        onCellValueChanged: (params) => {
            if (isTransactionNewRow(params.data)) {
                // Auto-save once the row is complete: an account on at least one
                // side (the other one being cash), plus a description and amount.
                const hasDescription = params.data.description && String(params.data.description).trim() !== '';
                const hasAmount = params.data.amount != null && params.data.amount > 0;
                const hasAccount = !!(params.data.from_account_id || params.data.to_account_id);
                if (hasDescription && hasAmount && hasAccount) {
                    tryCreateTransactionEntryFromNewRow(params.data);
                } else if (params.api) {
                    // Refresh the row to update required field highlighting
                    params.api.refreshCells({ rowNodes: [params.node], force: true });
                }
            }
        }
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

