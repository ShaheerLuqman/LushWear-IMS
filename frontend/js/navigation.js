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

/** Date range filter popup for orders header button. Fetches the range server-side
 * (loadOrdersForDateRange) into window._ordersDateRange, and marks the period dropdown
 * "Custom" while a range is active. */
function initOrdersDateRangeButton() {
    const triggerBtn = document.getElementById('ordersDateRangeBtn');
    if (!triggerBtn) return;

    const toDateInputValue = (val) => (val == null || val === '') ? '' : formatDateDDMMYYYY(val);

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
        triggerBtn.textContent = window._ordersDateRange ? 'Range set' : 'Date range';
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
        if (ordersGridApi) ordersGridApi.showLoadingOverlay();
        try {
            await loadOrdersForDateRange(from, to);
        } finally {
            if (ordersGridApi) ordersGridApi.hideOverlay();
        }
        triggerBtn.textContent = 'Range set';
    };

    applyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const rawFrom = (fromInput.value || '').trim();
        const rawTo = (toInput.value || '').trim();
        const fromVal = rawFrom ? parseDDMMYYYYToYYYYMMDD(rawFrom) : null;
        const toVal = rawTo ? parseDDMMYYYYToYYYYMMDD(rawTo) : null;
        if (!fromVal || !toVal) return;
        menu.style.display = 'none';
        await applyDateRange(fromVal, toVal);
    });

    clearBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        fromInput.value = '';
        toInput.value = '';
        if (fromPicker) fromPicker.clear();
        if (toPicker) toPicker.clear();
        window._ordersDateRange = null;
        triggerBtn.textContent = 'Date range';
        menu.style.display = 'none';
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
    });

    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display === 'none') {
            const range = window._ordersDateRange;
            if (range) {
                const fromStr = toDateInputValue(range.from);
                const toStr = toDateInputValue(range.to);
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
        'orderFulfillment': 'Order Fulfillment',
        'orderFulfillmentProgress': 'Order Fulfillment',
        'printAirwayBill': 'Print Airway Bill',
        'loadSheetLogs': 'Load Sheet Logs',
        'courierPaymentReport': 'Courier Payment Report',
        'courierPaymentReportDetail': 'Courier Payment Report',
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
    show('ordersDateRangeBtn', isOrders);
    show('ordersMoreActionsWrap', isOrders);
    show('headerOrdersAppActions', isOrders);
    show('deliveryRefreshProgress', false);
    show('transactionDateFilterWrap', viewName === 'transactions');
    show('billsHeaderWrap', viewName === 'bills');
    show('ledgersHeaderWrap', viewName === 'ledgers');
    show('trialBalanceHeaderWrap', viewName === 'trialBalance');
    show('courierPaymentReportHeaderWrap', viewName === 'courierPaymentReport', 'flex');
    show('orderFulfillmentHeaderWrap', viewName === 'orderFulfillment', 'flex');
    show('printAirwayBillHeaderWrap', viewName === 'printAirwayBill', 'flex');
    show('productAnalyticsHeaderWrap', viewName === 'productAnalytics', 'flex');

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

