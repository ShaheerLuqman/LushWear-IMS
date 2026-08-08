// View switching, sidebar nav, and the orders period/date-range filters.

// ============================================
// Navigation
// ============================================

/** Open/close the off-canvas nav drawer (mobile only; a no-op layout on desktop). */
function setMobileNavOpen(open) {
    const toggle = document.getElementById('mobileNavToggle');
    const scrim = document.getElementById('sidebarScrim');
    document.body.classList.toggle('mobile-nav-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (scrim) scrim.hidden = !open;
}

function initMobileNav() {
    const toggle = document.getElementById('mobileNavToggle');
    const scrim = document.getElementById('sidebarScrim');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
        setMobileNavOpen(!document.body.classList.contains('mobile-nav-open'));
    });
    scrim?.addEventListener('click', () => setMobileNavOpen(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setMobileNavOpen(false);
    });
    // Leaving mobile widths with the drawer open would strand the scrim over the app.
    window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).addEventListener('change', (e) => {
        if (!e.matches) setMobileNavOpen(false);
    });
}

function initNavigation() {
    initMobileNav();
    navItems.forEach(item => {
        if (!item.dataset.view) return; // e.g. edit lock button has no data-view
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
            setMobileNavOpen(false);
        });
    });
    const editLockBtn = document.getElementById('editLockBtn');
    if (editLockBtn) {
        editLockBtn.addEventListener('click', () => {
            editLocked = !editLocked;
            applyEditLockState();
            showToast(editLocked ? 'Editing locked' : 'Editing unlocked', 'success');
        });
    }
}

function initOrdersPeriodFilter() {
    const selectEl = document.getElementById('ordersPeriodFilter');
    if (selectEl) {
        selectEl.addEventListener('change', async () => {
            const [month, year] = selectEl.value.split('-').map(Number);
            // Only an explicit period change shows the grid's loading overlay - other
            // reloads (sync, mutations elsewhere) keep the existing rows visible until the
            // new data lands instead of flashing to a blank/spinner state.
            if (ordersGridApi) ordersGridApi.showLoadingOverlay();
            try {
                await loadOrdersForPeriod(month, year);
            } finally {
                if (ordersGridApi) ordersGridApi.hideOverlay();
            }
        });
    }
}

/** Date range filter popup for orders header button. Uses ordersGridApi and ORDERS_DATE_COLUMN_ID. */
function initOrdersDateRangeButton() {
    const triggerBtn = document.getElementById('ordersDateRangeBtn');
    if (!triggerBtn) return;

    const toDateInputValue = (val) => (val == null || val === '') ? '' : formatDateDDMMYYYY(val);

    const shiftDays = (yyyymmdd, days) => {
        if (!yyyymmdd) return '';
        const d = new Date(`${String(yyyymmdd).slice(0, 10)}T00:00:00`);
        d.setDate(d.getDate() + days);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    const menu = document.createElement('div');
    menu.className = 'date-range-menu';
    menu.style.display = 'none';

    const fromField = document.createElement('div');
    fromField.className = 'date-range-menu__field';
    const fromLabel = document.createElement('label');
    fromLabel.className = 'date-range-menu__label';
    fromLabel.textContent = 'From';
    const fromInput = document.createElement('input');
    fromInput.type = 'text';
    fromInput.placeholder = 'dd/mm/yyyy';
    fromInput.className = 'grid-floating-filter-date';
    fromField.appendChild(fromLabel);
    fromField.appendChild(fromInput);

    const toField = document.createElement('div');
    toField.className = 'date-range-menu__field';
    const toLabel = document.createElement('label');
    toLabel.className = 'date-range-menu__label';
    toLabel.textContent = 'To';
    const toInput = document.createElement('input');
    toInput.type = 'text';
    toInput.placeholder = 'dd/mm/yyyy';
    toInput.className = 'grid-floating-filter-date';
    toField.appendChild(toLabel);
    toField.appendChild(toInput);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'date-range-menu__actions';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'date-range-menu__btn date-range-menu__btn--clear';
    clearBtn.textContent = 'Clear';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'date-range-menu__btn date-range-menu__btn--apply';
    applyBtn.textContent = 'Apply';
    actionsRow.appendChild(clearBtn);
    actionsRow.appendChild(applyBtn);

    menu.appendChild(fromField);
    menu.appendChild(toField);
    menu.appendChild(actionsRow);

    const flatpickrOpts = { dateFormat: 'd/m/Y', allowInput: true, static: false };
    const fromPicker = window.flatpickr ? window.flatpickr(fromInput, flatpickrOpts) : null;
    const toPicker = window.flatpickr ? window.flatpickr(toInput, flatpickrOpts) : null;

    function updateButtonLabel() {
        if (!ordersGridApi) return;
        const filterModel = ordersGridApi.getFilterModel() || {};
        const colFilter = filterModel[ORDERS_DATE_COLUMN_ID];
        const hasRange = colFilter && colFilter.type === 'inRange';
        triggerBtn.textContent = hasRange ? 'Range set' : 'Date range';
    }

    const updateFilter = () => {
        if (!ordersGridApi) return;
        const rawFrom = (fromInput.value || '').trim();
        const rawTo = (toInput.value || '').trim();
        const fromVal = rawFrom ? parseDDMMYYYYToYYYYMMDD(rawFrom) : null;
        const toVal = rawTo ? parseDDMMYYYYToYYYYMMDD(rawTo) : null;
        const currentModel = ordersGridApi.getFilterModel() || {};
        const newModel = { ...currentModel };
        if (fromVal && toVal) {
            // agDateColumnFilter's inRange upper bound is compared against row dates that
            // carry a time component, so push it to the next day to include the whole end
            // day - equal from/to then still matches that single day.
            newModel[ORDERS_DATE_COLUMN_ID] = { filterType: 'date', type: 'inRange', dateFrom: fromVal, dateTo: shiftDays(toVal, 1) };
            triggerBtn.textContent = 'Range set';
        } else if (!fromVal && !toVal) {
            delete newModel[ORDERS_DATE_COLUMN_ID];
            triggerBtn.textContent = 'Date range';
        } else return;
        ordersGridApi.setFilterModel(newModel);
    };

    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        updateFilter();
        menu.style.display = 'none';
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fromInput.value = '';
        toInput.value = '';
        if (fromPicker) fromPicker.clear();
        if (toPicker) toPicker.clear();
        if (ordersGridApi) {
            const newModel = { ...(ordersGridApi.getFilterModel() || {}) };
            delete newModel[ORDERS_DATE_COLUMN_ID];
            ordersGridApi.setFilterModel(newModel);
        }
        triggerBtn.textContent = 'Date range';
        menu.style.display = 'none';
    });

    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display === 'none') {
            if (ordersGridApi) {
                const filterModel = ordersGridApi.getFilterModel() || {};
                const colFilter = filterModel[ORDERS_DATE_COLUMN_ID];
                if (colFilter && colFilter.type === 'inRange') {
                    const fromStr = toDateInputValue(colFilter.dateFrom);
                    // dateTo is stored as the day after the picked end date (see updateFilter),
                    // so shift it back to show the user the date they actually chose.
                    const toStr = toDateInputValue(shiftDays(colFilter.dateTo, -1));
                    fromInput.value = fromStr;
                    toInput.value = toStr;
                    if (fromPicker) fromPicker.setDate(fromStr || null, false);
                    if (toPicker) toPicker.setDate(toStr || null, false);
                } else {
                    fromInput.value = '';
                    toInput.value = '';
                    if (fromPicker) fromPicker.clear();
                    if (toPicker) toPicker.clear();
                }
            }
            const rect = triggerBtn.getBoundingClientRect();
            menu.style.display = 'block';
            // Display first so offsetWidth is measurable, then centre on the button,
            // clamped so the popup can't hang off either edge of the viewport.
            const left = rect.left + window.scrollX + (rect.width - menu.offsetWidth) / 2;
            const maxLeft = window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8;
            menu.style.top = `${rect.bottom + window.scrollY}px`;
            menu.style.left = `${Math.max(window.scrollX + 8, Math.min(left, maxLeft))}px`;
        } else {
            menu.style.display = 'none';
        }
    });

    document.body.appendChild(menu);

    // Menu only closes via Apply, Clear, or toggling the trigger button —
    // clicking elsewhere (including the flatpickr calendar) leaves it open.

    // Expose so onFilterChanged can update button label
    window._ordersDateRangeUpdateButtonLabel = updateButtonLabel;
}

function switchView(viewName, { skipReload = false } = {}) {
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
        'dashboard': 'Dashboard',
        'orders': 'Orders',
        'transactions': 'Transactions',
        'ledgers': 'Ledgers',
        'ledgerDetail': 'Ledger',
        'trialBalance': 'Trial Balance',
        'bills': 'Purchase Bills',
        'apAgeing': 'Payables Ageing',
        'monthSummary': 'Month Summary',
        'monthDetail': 'Month Details',
        'products': 'Products',
        'loadSheetLogs': 'Load Sheet Logs',
        'settings': 'Settings'
    };

    document.getElementById('viewTitle').textContent = titles[viewName];

    // Show/hide buttons based on view
    const isOrders = viewName === 'orders';
    const isProducts = viewName === 'products';
    const show = (id, visible, disp = 'inline-flex') => {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? disp : 'none';
    };

    show('syncShopifyBtn', isProducts);
    if (isProducts) updateSyncShopifyLastSyncLabel();
    show('bulkUpdateCostPriceBtn', isProducts);
    show('recalculateOrderCostsBtn', isProducts);

    show('syncOrdersLastSync', isOrders, 'inline-block');
    if (isOrders) updateSyncOrdersLastSyncLabel();
    show('ordersPeriodFilterWrap', isOrders, 'flex');
    show('ordersDateRangeBtn', isOrders);
    show('ordersMoreActionsWrap', isOrders);
    show('headerOrdersAppActions', isOrders);
    show('deliveryRefreshProgress', false);
    show('transactionDateFilterWrap', viewName === 'transactions');

    if (isOrders) {
        if (typeof window._ordersDateRangeUpdateButtonLabel === 'function') window._ordersDateRangeUpdateButtonLabel();
    } else {
        closeOrdersMoreActionsMenu();
        exitOrdersFullScreen();
    }

    // Refresh data and resize grids when switching views
    if (viewName === 'products') {
        loadProducts();
        setTimeout(() => {
            sizeGridColumns(productsGridApi);
        }, 100);
    } else if (viewName === 'orders') {
        if (!skipReload) loadOrders();
        setTimeout(() => {
            sizeGridColumns(ordersGridApi);
        }, 100);
    } else if (viewName === 'transactions') {
        if (!skipReload) loadTransactions();
        setTimeout(() => {
            sizeGridColumns(transactionsGridApi);
        }, 100);
    } else if (viewName === 'loadSheetLogs') {
        loadLoadSheetLogs();
    } else if (viewName === 'ledgers') {
        loadLedgers();
    } else if (viewName === 'trialBalance') {
        loadTrialBalance();
        setTimeout(() => {
            sizeGridColumns(trialBalanceGridApi);
        }, 100);
    } else if (viewName === 'bills') {
        // Ledgers back the supplier column and the line-account picker, so they
        // have to be loaded before the grid renders.
        loadLedgersList().then(loadBills);
        setTimeout(() => {
            sizeGridColumns(billsGridApi);
        }, 100);
    } else if (viewName === 'apAgeing') {
        loadApAgeing();
        setTimeout(() => {
            sizeGridColumns(apAgeingGridApi);
        }, 100);
    } else if (viewName === 'ledgerDetail') {
        // Handled by openLedgerDetail
        setTimeout(() => {
            sizeGridColumns(ledgerDetailGridApi);
        }, 100);
    } else if (viewName === 'monthSummary') {
        loadMonthSummaryList();
    } else if (viewName === 'monthDetail') {
        // Handled by openMonthDetail
    } else if (viewName === 'dashboard') {
        // Dashboard-only data is bundled here so it's fetched only when the dashboard is
        // actually opened, not on every products/orders load elsewhere in the app.
        const loadingEl = document.getElementById('dashboardLoading');
        const contentEl = document.getElementById('dashboardContent');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (contentEl) contentEl.style.display = 'none';
        loadProducts().then(() => updateDashboard()).finally(() => {
            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) contentEl.style.display = '';
        });
    } else if (viewName === 'settings') {
        loadAccountSettings();
    }
}

