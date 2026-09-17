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

/** Date range filter popup for orders header button, via easepick (RangePlugin +
 * PresetPlugin) - preset ranges (Today/Last 7 days/This month/...) alongside a two-month
 * calendar for a custom range. Fetches the range server-side (loadOrdersForDateRange) into
 * window._ordersDateRange, and marks the period dropdown "Custom" while a range is active. */
function initOrdersDateRangeButton() {
    const triggerBtn = document.getElementById('ordersDateRangeBtn');
    const clearBtn = document.getElementById('ordersDateRangeClearBtn');
    if (!triggerBtn || !window.easepick) return;

    // PresetPlugin only auto-fills its 6 built-in ranges when left fully unconfigured, so
    // adding "All Time" means supplying the whole preset list ourselves - built the same way
    // PresetPlugin builds its own defaults, just anchored to PKT "today" (order dates are
    // PKT-based) instead of the browser's local clock, and with the orders data's oldest
    // period (see ORDERS_PERIOD_OLDEST_MONTH/YEAR) as the "All Time" start.
    const DateTime = window.easepick.DateTime;
    const pkt = getPKTDate();
    const y = pkt.getFullYear(), m = pkt.getMonth();
    const today = new Date(y, m, pkt.getDate());
    const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
    const oldestStart = ordersPeriodStartEnd(ORDERS_PERIOD_OLDEST_MONTH, ORDERS_PERIOD_OLDEST_YEAR).start;
    const customPreset = {
        'All Time': [new DateTime(oldestStart), new DateTime(today)],
        'Today': [new DateTime(today), new DateTime(today)],
        'Yesterday': [new DateTime(addDays(-1)), new DateTime(addDays(-1))],
        'Last 7 Days': [new DateTime(addDays(-6)), new DateTime(today)],
        'Last 30 Days': [new DateTime(addDays(-29)), new DateTime(today)],
        'This Month': [new DateTime(new Date(y, m, 1)), new DateTime(new Date(y, m + 1, 0))],
        'Last Month': [new DateTime(new Date(y, m - 1, 1)), new DateTime(new Date(y, m, 0))],
    };

    const picker = new window.easepick.create({
        element: triggerBtn,
        css: ['https://cdn.jsdelivr.net/npm/@easepick/bundle@1.2.1/dist/index.css'],
        zIndex: 9999,
        format: 'DD/MM/YYYY',
        grid: 2,
        calendars: 2,
        // Preset buttons only call setDateRange()+select on click when autoApply is true -
        // with it false they silently stash the pick and wait for a separate Apply click
        // (the footer that autoApply:false would otherwise render), so a preset click looked
        // like a no-op. true also means a plain two-click custom range applies immediately.
        autoApply: true,
        plugins: ['RangePlugin', 'PresetPlugin'],
        PresetPlugin: { position: 'left', customPreset },
    });

    // easepick renders into a shadow root, so the app's own stylesheet can't reach it -
    // these just map its color variables onto the app's own (already theme-aware) ones,
    // which keeps it in sync with light/dark mode without duplicating either palette.
    const themeStyle = document.createElement('style');
    themeStyle.textContent = `
        :host {
            --color-bg-default: var(--bg-card);
            --color-bg-secondary: var(--bg-secondary);
            --color-fg-default: var(--text-primary);
            --color-fg-secondary: var(--text-secondary);
            --color-fg-muted: var(--text-muted);
            --color-fg-primary: var(--accent-primary);
            --color-border-default: var(--border-color);
            --color-bg-inrange: color-mix(in srgb, var(--accent-primary) 18%, transparent);
            --color-btn-primary-bg: var(--accent-primary);
            --color-btn-primary-fg: #fff;
            --color-btn-primary-border: var(--accent-primary);
            --color-btn-secondary-bg: var(--bg-secondary);
            --color-btn-secondary-fg: var(--text-secondary);
            --color-btn-secondary-border: var(--border-color);
            --border-radius: 8px;
            font-family: var(--font-primary);
        }
        .container {
            max-width: calc(100vw - 16px);
            overflow: hidden;
            border-radius: var(--radius-lg);
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-lg);
        }
    `;
    picker.ui.shadowRoot.appendChild(themeStyle);

    // The button's own fixed width (shared with "More actions", for an even toolbar) can't
    // fit a full "dd/mm/yyyy - dd/mm/yyyy" range - overrides easepick's auto-set label
    // (which would otherwise fill the button with that full range and get ellipsed) with a
    // short one, keeping the full range as the title tooltip instead.
    function updateButtonLabel() {
        const range = window._ordersDateRange;
        if (range) {
            triggerBtn.textContent = 'Range set';
            triggerBtn.title = formatOrdersDateRangeLabel(range.from, range.to);
            if (clearBtn) clearBtn.style.display = '';
        } else {
            picker.clear();
            triggerBtn.textContent = 'Date range';
            triggerBtn.title = 'Filter by date range';
            if (clearBtn) clearBtn.style.display = 'none';
        }
    }
    updateButtonLabel();

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

    picker.on('select', (e) => {
        const { start, end } = e.detail;
        if (!start || !end) return;
        applyDateRange(start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'));
    });

    // easepick's own adjustPosition() only flips left/up when there's room for the whole
    // popup on the other side - with the trigger sitting near the header's right edge and a
    // two-month calendar, there often isn't, and it's left overflowing off-screen. Re-clamp
    // its actual rendered box into the viewport after it shows.
    picker.on('show', () => {
        const container = picker.ui.container;
        const rect = container.getBoundingClientRect();
        const left = parseFloat(container.style.left) || 0;
        const top = parseFloat(container.style.top) || 0;
        const overflowRight = rect.right - (window.innerWidth - 8);
        const overflowLeft = 8 - rect.left;
        if (overflowRight > 0) container.style.left = `${left - overflowRight}px`;
        else if (overflowLeft > 0) container.style.left = `${left + overflowLeft}px`;
        const overflowBottom = rect.bottom - (window.innerHeight - 8);
        if (overflowBottom > 0) container.style.top = `${top - overflowBottom}px`;
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
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
        });
    }

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

