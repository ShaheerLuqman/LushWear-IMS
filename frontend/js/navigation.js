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
            // An explicit period change shows the grid's loading overlay only when that period
            // isn't cached - a cache hit paints instantly instead (see hydrateOrdersFromCache).
            // Other reloads (sync, mutations elsewhere) keep the existing rows visible until
            // the new data lands instead of flashing to a blank/spinner state.
            if (selectEl.value !== CUSTOM_ORDERS_VALUE) {
                window._ordersDateRange = null;
                if (typeof window._ordersDateRangeUpdateButtonLabel === 'function') window._ordersDateRangeUpdateButtonLabel();
                const customOption = [...selectEl.options].find((o) => o.value === CUSTOM_ORDERS_VALUE);
                if (customOption) customOption.remove();
            }
            if (ordersGridApi && !ordersHasCachedOrders(selectEl.value)) ordersGridApi.showLoadingOverlay();
            try {
                if (selectEl.value === ALL_ORDERS_VALUE) {
                    await loadAllOrders();
                } else if (selectEl.value !== CUSTOM_ORDERS_VALUE) {
                    const [month, year] = selectEl.value.split('-').map(Number);
                    await loadOrdersForPeriod(month, year);
                }
            } finally {
                if (ordersGridApi) ordersGridApi.hideOverlay();
            }
        });
    }
}

/** Date range filter popup for orders header button, via the shared createDateRangePicker
 * (utils.js). Fetches the range server-side (loadOrdersForDateRange) into
 * window._ordersDateRange, and marks the period dropdown "Custom" while a range is active. */
function initOrdersDateRangeButton() {
    const triggerBtn = document.getElementById('ordersDateRangeBtn');
    if (!triggerBtn) return;

    // The button's own fixed width (shared with "More actions", for an even toolbar) can't
    // fit a full "dd/mm/yyyy - dd/mm/yyyy" range - shows a short label instead, keeping the
    // full range as the title tooltip.
    function updateButtonLabel() {
        const range = window._ordersDateRange;
        if (range) {
            rangePicker.setLabel('Range set', formatOrdersDateRangeLabel(range.from, range.to));
            rangePicker.setClearable(true);
        } else {
            rangePicker.picker.clear();
            rangePicker.setLabel('Date range', 'Filter by date range');
            rangePicker.setClearable(false);
        }
    }

    // The range is fetched server-side (loadOrdersForDateRange) so it covers every matching
    // order, not just whatever period happened to already be loaded into the grid - a plain
    // AG Grid column filter here would only ever narrow the currently-loaded period's rows.
    const applyDateRange = async (from, to) => {
        window._ordersDateRange = { from, to };
        const selectEl = document.getElementById('ordersPeriodFilter');
        if (selectEl) {
            const label = formatOrdersDateRangeLabel(from, to);
            let customOption = [...selectEl.options].find((o) => o.value === CUSTOM_ORDERS_VALUE);
            if (!customOption) {
                selectEl.insertAdjacentHTML('afterbegin', `<option value="${CUSTOM_ORDERS_VALUE}"></option>`);
                customOption = selectEl.options[0];
            }
            customOption.textContent = label;
            selectEl.value = CUSTOM_ORDERS_VALUE;
        }
        updateButtonLabel();
        if (ordersGridApi) ordersGridApi.showLoadingOverlay();
        try {
            await loadOrdersForDateRange(from, to);
        } finally {
            if (ordersGridApi) ordersGridApi.hideOverlay();
        }
    };

    const rangePicker = createDateRangePicker(triggerBtn, {
        onSelect: applyDateRange,
        onClear: async () => {
            window._ordersDateRange = null;
            updateButtonLabel();
            const selectEl = document.getElementById('ordersPeriodFilter');
            if (selectEl) {
                const customOption = [...selectEl.options].find((o) => o.value === CUSTOM_ORDERS_VALUE);
                if (customOption) customOption.remove();
                const { month, year } = getCurrentOrdersPeriod();
                selectEl.value = `${month}-${year}`;
            }
            if (ordersGridApi) ordersGridApi.showLoadingOverlay();
            try {
                await loadOrders();
            } finally {
                if (ordersGridApi) ordersGridApi.hideOverlay();
            }
        },
    });
    if (!rangePicker) return;
    updateButtonLabel();

    // Expose so onFilterChanged can update button label
    window._ordersDateRangeUpdateButtonLabel = updateButtonLabel;
}

function switchView(viewName, { skipReload = false } = {}) {
    currentView = viewName;
    if (!NON_RESTORABLE_VIEWS.has(viewName)) {
        try { localStorage.setItem(CURRENT_VIEW_KEY, viewName); } catch (e) { /* ignore */ }
    }

    // Update nav (ledgerDetail/courierPaymentReportDetail keep their list's nav item active)
    const navView = viewName === 'ledgerDetail' ? 'ledgers'
        : viewName === 'courierPaymentReportDetail' ? 'courierPaymentReport'
        : viewName === 'orderFulfillmentProgress' ? 'orderFulfillment'
        : viewName;
    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === navView);
    });

    // A child view keeps its parent row highlighted too (e.g. orderFulfillment under Orders).
    document.querySelectorAll('.nav-group').forEach((group) => {
        const isActiveChild = !!group.querySelector('.nav-children .nav-item.active');
        group.querySelector('.nav-item-parent')?.classList.toggle('nav-item-parent-highlight', isActiveChild);
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
        'monthSummary': 'Finance',
        'monthDetail': 'Month Details',
        'products': 'Inventory',
        'productAnalytics': 'Product Analytics',
        'cityAnalytics': 'Analytics by City',
        'orderFulfillment': 'Order Fulfillment',
        'orderFulfillmentProgress': 'Order Fulfillment',
        'printAirwayBill': 'Print Airway Bill',
        'loadSheetLogs': 'Load Sheet Logs',
        'courierPaymentReport': 'Courier Payment Report',
        'courierPaymentReportDetail': 'Courier Payment Report',
        'courierPerformance': 'Courier Performance',
        'settings': 'Settings'
    };

    document.getElementById('viewTitle').textContent = titles[viewName];

    // Only the Inventory view carries a subtitle so far; the element stays hidden
    // elsewhere rather than collapsing to an empty line under the title.
    const subtitleEl = document.getElementById('viewSubtitle');
    const subtitle = viewName === 'products' ? 'Manage and track your product inventory in real-time.' : '';
    subtitleEl.textContent = subtitle;
    subtitleEl.style.display = subtitle ? 'block' : 'none';

    // Show/hide buttons based on view
    const isOrders = viewName === 'orders';
    const isProducts = viewName === 'products';
    const show = (id, visible, disp = 'inline-flex') => {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? disp : 'none';
    };

    show('syncShopifyBtn', isProducts);
    show('inventoryExportBtn', isProducts);
    show('bulkUpdateCostPriceBtn', isProducts);
    if (isProducts) updateSyncShopifyLastSyncLabel();

    show('syncOrdersLastSync', isOrders, 'inline-block');
    if (isOrders) updateSyncOrdersLastSyncLabel();
    show('ordersPeriodFilterWrap', isOrders, 'flex');
    show('ordersDateRangeWrap', isOrders);
    show('ordersMoreActionsWrap', isOrders);
    show('headerOrdersAppActions', isOrders);
    show('deliveryRefreshProgress', false);
    show('transactionDateFilterWrap', viewName === 'transactions');
    show('billsHeaderWrap', viewName === 'bills');
    show('ledgersHeaderWrap', viewName === 'ledgers');
    show('trialBalanceHeaderWrap', viewName === 'trialBalance');
    show('courierPaymentReportHeaderWrap', viewName === 'courierPaymentReport', 'flex');
    show('courierPerformanceHeaderWrap', viewName === 'courierPerformance', 'flex');
    show('orderFulfillmentHeaderWrap', viewName === 'orderFulfillment', 'flex');
    show('printAirwayBillHeaderWrap', viewName === 'printAirwayBill', 'flex');
    show('productAnalyticsHeaderWrap', viewName === 'productAnalytics', 'flex');
    show('cityAnalyticsHeaderWrap', viewName === 'cityAnalytics', 'flex');

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
    } else if (viewName === 'productAnalytics') {
        initProductAnalyticsView();
    } else if (viewName === 'cityAnalytics') {
        initCityAnalyticsView();
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
        // have to be loaded before the grid renders. The list itself rarely
        // changes, so only fetch if it isn't already cached in memory - unlike
        // Ledgers/Transactions, this view never shows a balance to go stale.
        (ledgers.length ? Promise.resolve() : loadLedgersList()).then(loadBills);
        setTimeout(() => {
            sizeGridColumns(billsGridApi);
        }, 100);
    } else if (viewName === 'courierPaymentReport') {
        loadCourierPaymentReport();
        setTimeout(() => {
            sizeGridColumns(courierPaymentReportGridApi);
        }, 100);
    } else if (viewName === 'courierPerformance') {
        loadCourierPerformance();
    } else if (viewName === 'orderFulfillment') {
        renderOrderFulfillmentView();
    } else if (viewName === 'printAirwayBill') {
        renderPrintAirwayBillView();
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

