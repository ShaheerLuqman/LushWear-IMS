// Shopify sync, PostEx CSV upload, dashboard stats, and month summary/detail.

// ============================================
// UI Updates
// ============================================

function renderDashboardCollectionsBreakdown() {
    const container = document.getElementById('dashboardCollectionsGrid');
    if (!container) return;

    const agg = new Map();
    for (const p of products) {
        const raw = (p.collection != null ? String(p.collection) : '').trim();
        const label = raw || 'Uncategorized';
        const price = parseFloat(p.price) || 0;
        const qty = p.total_quantity || 0;
        if (!agg.has(label)) {
            agg.set(label, { count: 0, value: 0 });
        }
        const row = agg.get(label);
        row.count += 1;
        row.value += price * qty;
    }

    const rows = [...agg.entries()].map(([collection, data]) => ({ collection, ...data }));
    rows.sort((a, b) => {
        if (a.collection === 'Uncategorized') return 1;
        if (b.collection === 'Uncategorized') return -1;
        return a.collection.localeCompare(b.collection, undefined, { sensitivity: 'base' });
    });

    if (rows.length === 0) {
        container.innerHTML = '<p class="dashboard-collections-empty">No products to show.</p>';
        return;
    }

    container.innerHTML = rows
        .map(({ collection, count, value }) => {
            const countLabel = count === 1 ? '1 product' : `${count.toLocaleString()} products`;
            return `<div class="stat-card">
                <div class="stat-info">
                    <span class="stat-label">${escapeHtml(collection)}</span>
                    <span class="stat-detail">${countLabel}</span>
                    <span class="stat-value">Rs ${Math.round(value).toLocaleString()}</span>
                </div>
            </div>`;
        })
        .join('');
}

async function updateDashboard() {
    const totalProducts = products.length;
    const totalVariantRows = products.reduce(
        (sum, p) => sum + (Array.isArray(p.variants) ? p.variants.length : 0),
        0
    );
    const totalProductsAndVariants = totalProducts + totalVariantRows;
    const totalStock = products.reduce((sum, p) => sum + (p.total_quantity || 0), 0);
    const totalValue = products.reduce((sum, p) => sum + ((p.price || 0) * (p.total_quantity || 0)), 0);

    document.getElementById('totalProducts').textContent = totalProducts;
    const productsVariantsEl = document.getElementById('totalProductsAndVariants');
    if (productsVariantsEl) {
        productsVariantsEl.textContent = totalProductsAndVariants.toLocaleString();
    }
    document.getElementById('totalStock').textContent = totalStock.toLocaleString();
    document.getElementById('totalValue').textContent = `Rs ${Math.round(totalValue).toLocaleString()}`;

    renderDashboardCollectionsBreakdown();

    const returnedDeliveryEl = document.getElementById('returnedDeliveryChargesSum');
    if (returnedDeliveryEl) {
        try {
            const response = await fetch(`${API_BASE}/orders/returned-delivery-charges-sum`);
            if (response.ok) {
                const data = await response.json();
                const sum = parseFloat(data.sum) || 0;
                returnedDeliveryEl.textContent = `Rs ${Math.round(sum).toLocaleString()}`;
            } else {
                returnedDeliveryEl.textContent = '—';
            }
        } catch (e) {
            console.error('Error fetching returned delivery charges sum:', e);
            returnedDeliveryEl.textContent = '—';
        }
    }
}

// ============================================
// Forms
// ============================================

// ============================================
// Month Summary Functions
// ============================================

let currentMonthDetail = null;

async function loadMonthSummaryList() {
    try {
        const months = await apiJson('/orders/month-summary/list', { fallback: 'Failed to fetch month summary list' });
        displayMonthSummaryCards(months);
    } catch (error) {
        console.error('Error loading month summary list:', error);
        showToast('Failed to load month summaries', 'error');
    }
}

function displayMonthSummaryCards(months) {
    const container = document.getElementById('monthSummaryCards');
    if (!container) return;
    
    if (months.length === 0) {
        container.innerHTML = '<div class="no-data-message">No month data available</div>';
        return;
    }
    
    // Group by year (descending: newest year first)
    const byYear = new Map();
    for (const m of months) {
        if (!byYear.has(m.year)) byYear.set(m.year, []);
        byYear.get(m.year).push(m);
    }
    const years = [...byYear.keys()].sort((a, b) => b - a);
    
    const sectionsHtml = years.map(year => {
        const yearMonths = byYear.get(year);
        const cardsHtml = yearMonths.map(month => {
            const monthName = getMonthName(month.month);
            const periodLabel = formatOrdersPeriodLabel(month.month, month.year);
            return `
                <div class="month-summary-card" data-month="${month.month}" data-year="${month.year}">
                    <div class="month-summary-card-header">
                        <h3 class="month-summary-card-title">${monthName} ${month.year}</h3>
                        <span class="month-summary-card-period">${periodLabel}</span>
                    </div>
                </div>
            `;
        }).join('');
        return `
            <section class="month-summary-year-section">
                <h2 class="month-summary-year-heading">${year}</h2>
                <div class="month-summary-cards-in-section">${cardsHtml}</div>
            </section>
        `;
    }).join('');
    
    container.innerHTML = sectionsHtml;
    
    // Add click handlers - entire card is clickable
    container.querySelectorAll('.month-summary-card').forEach(card => {
        card.addEventListener('click', () => {
            const month = parseInt(card.dataset.month);
            const year = parseInt(card.dataset.year);
            openMonthDetail(month, year);
        });
    });
}

function getMonthName(month) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
    return months[month - 1];
}

async function openMonthDetail(month, year) {
    currentMonthDetail = { month, year };
    const container = document.getElementById('monthDetailContent');
    const titleEl = document.getElementById('monthDetailTitle');
    const monthName = getMonthName(month);
    const periodLabel = formatOrdersPeriodLabel(month, year);

    // Set title and show loading immediately, then navigate
    if (titleEl) titleEl.textContent = `${monthName} ${year} - ${periodLabel}`;
    if (container) {
        container.innerHTML = `
            <div class="content-loading">
                <div class="content-loading-spinner"></div>
                <p class="content-loading-text">Loading period data...</p>
            </div>
        `;
    }
    switchView('monthDetail');

    try {
        const data = await apiJson(`/orders/month-summary/${month}/${year}`, { fallback: 'Failed to fetch month detail' });
        displayMonthDetail(data);
    } catch (error) {
        console.error('Error loading month detail:', error);
        showToast('Failed to load month details', 'error');
        if (container) {
            container.innerHTML = '<div class="no-data-message">Failed to load period data. Please try again.</div>';
        }
    }
}

function displayMonthDetail(data) {
    const container = document.getElementById('monthDetailContent');
    const titleEl = document.getElementById('monthDetailTitle');
    
    if (!container) return;
    
    const monthName = getMonthName(data.month);
    const periodLabel = formatOrdersPeriodLabel(data.month, data.year);
    
    if (titleEl) {
        titleEl.textContent = `${monthName} ${data.year} - ${periodLabel}`;
    }
    
    const fmt = (n) => (typeof n === 'number' && !Number.isInteger(n))
        ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : (n ?? 0).toLocaleString('en-US');

    container.innerHTML = `
        <div class="month-detail-sections">
            <div class="month-detail-column">
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Sales</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">Total Gross Sale</span><span class="month-detail-line-value">Rs ${fmt(data.total_gross_sale)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Total Return Amount</span><span class="month-detail-line-value">Rs ${fmt(data.total_return_amount)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Net Sales</span><span class="month-detail-line-value">Rs ${fmt(data.net_sales)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Net Profit</span><span class="month-detail-line-value">Rs ${fmt(data.net_profit ?? 0)}</span></div>
                    </div>
                </section>
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Expenses</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">Shopify Expense</span><span class="month-detail-line-value">Rs ${fmt(data.shopify_expense ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Ad Expense</span><span class="month-detail-line-value">Rs ${fmt(data.ad_expense ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Other Expenses</span><span class="month-detail-line-value">Rs ${fmt(data.other_expense ?? 0)}</span></div>
                    </div>
                </section>
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Products Sold by Collection</h3>
                    <div class="month-detail-lines">
                        ${(data.products_sold_by_collection || []).map(row => `
                            <div class="month-detail-line">
                                <span class="month-detail-line-label">${row.collection || 'Others'}</span>
                                <span class="month-detail-line-value">${fmt(row.count)} units · Rs ${fmt(row.sum)}</span>
                            </div>
                        `).join('')}
                    </div>
                </section>
            </div>
            <div class="month-detail-column">
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Orders</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">Total Orders</span><span class="month-detail-line-value">${fmt(data.total_orders)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Delivered Orders</span><span class="month-detail-line-value">${fmt(data.delivered_orders_count)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Return Orders</span><span class="month-detail-line-value">${fmt(data.return_orders_count)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Enroute Orders</span><span class="month-detail-line-value">${fmt(data.enroute_orders_count ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Unfulfilled Orders</span><span class="month-detail-line-value">${fmt(data.unfulfilled_orders_count ?? 0)}</span></div>
                    </div>
                </section>
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">DC Charges</h3>
                    <div class="month-detail-lines">
                        <div class="month-detail-line"><span class="month-detail-line-label">DC Charges (Delivered)</span><span class="month-detail-line-value">Rs ${fmt(data.dc_charges_delivered ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">DC Charges (Returned)</span><span class="month-detail-line-value">Rs ${fmt(data.dc_charges_returned ?? 0)}</span></div>
                        <div class="month-detail-line"><span class="month-detail-line-label">Total DC Charges</span><span class="month-detail-line-value">Rs ${fmt(data.dc_charges_total ?? 0)}</span></div>
                    </div>
                </section>
            </div>
        </div>
    `;
}

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

    // Bulk update cost price (products)
    const bulkUpdateCostPriceBtn = document.getElementById('bulkUpdateCostPriceBtn');
    if (bulkUpdateCostPriceBtn) {
        bulkUpdateCostPriceBtn.addEventListener('click', openBulkUpdateCostPriceModal);
    }

    const recalculateOrderCostsBtn = document.getElementById('recalculateOrderCostsBtn');
    if (recalculateOrderCostsBtn) {
        recalculateOrderCostsBtn.addEventListener('click', openRecalculateOrderCostsModal);
    }

    document.getElementById('bulkUpdateSetDelivered')?.addEventListener('click', () => bulkUpdateOrderStatus('delivered'));
    document.getElementById('bulkUpdateSetReturned')?.addEventListener('click', () => bulkUpdateOrderStatus('returned'));
    document.getElementById('bulkUpdateSetCancelled')?.addEventListener('click', () => bulkUpdateOrderStatus('cancelled'));
    document.getElementById('bulkUpdateSetPieceReceived')?.addEventListener('click', bulkUpdatePieceReceived);
    document.getElementById('bulkUpdateSelectInGrid')?.addEventListener('click', bulkUpdateSelectInGrid);
    document.getElementById('bulkUpdateDeliveryChargesBtn')?.addEventListener('click', openBulkUpdateDeliveryChargesModal);

    // Orders toolbar actions: Upload PostEx CSV, Generate Load Sheet, Create Replacement
    const ordersMoreActionUploadPostEx = document.getElementById('ordersMoreActionUploadPostEx');
    if (ordersMoreActionUploadPostEx) {
        ordersMoreActionUploadPostEx.addEventListener('click', openUploadPostExModal);
    }
    // Upload PostEx modal: file name display, upload button, close/cancel
    const uploadPostExFileInput = document.getElementById('uploadPostExFileInput');
    const uploadPostExFileNameEl = document.getElementById('uploadPostExFileName');
    if (uploadPostExFileInput && uploadPostExFileNameEl) {
        uploadPostExFileInput.addEventListener('change', () => {
            const file = uploadPostExFileInput.files?.[0];
            uploadPostExFileNameEl.textContent = file ? file.name : 'No file chosen';
        });
    }
    const uploadPostExModalUploadBtn = document.getElementById('uploadPostExModalUpload');
    if (uploadPostExModalUploadBtn) {
        uploadPostExModalUploadBtn.addEventListener('click', async () => {
            const fileInput = document.getElementById('uploadPostExFileInput');
            const file = fileInput?.files?.[0];
            if (!file) {
                showToast('Please select a CSV file', 'error');
                return;
            }
            const assignmentInput = document.getElementById('uploadPostExAssignmentNumber');
            const assignmentNumber = assignmentInput?.value?.trim() || null;
            await uploadPostExCsv(file, assignmentNumber);
        });
    }
    document.getElementById('closeUploadPostExModal')?.addEventListener('click', closeUploadPostExModal);
    document.getElementById('uploadPostExModalCancel')?.addEventListener('click', closeUploadPostExModal);
    const uploadPostExModalEl = document.getElementById('uploadPostExModal');
    if (uploadPostExModalEl) {
        uploadPostExModalEl.addEventListener('click', (e) => { if (e.target === uploadPostExModalEl) closeUploadPostExModal(); });
    }
    const ordersMoreActionGenerateLoadSheet = document.getElementById('ordersMoreActionGenerateLoadSheet');
    if (ordersMoreActionGenerateLoadSheet) {
        ordersMoreActionGenerateLoadSheet.addEventListener('click', openGenerateLoadSheetModal);
    }
    const ordersMoreActionGenerateInvoice = document.getElementById('ordersMoreActionGenerateInvoice');
    if (ordersMoreActionGenerateInvoice) {
        ordersMoreActionGenerateInvoice.addEventListener('click', async () => {
            if (!ordersGridApi) {
                showToast('Orders grid not initialized', 'error');
                return;
            }
            const selectedRows = ordersGridApi.getSelectedRows().filter(row => row && row.id !== '__footer__' && row.order_number);
            if (selectedRows.length === 0) {
                showToast('Please select at least one order', 'error');
                return;
            }
            const orderIds = selectedRows.map(row => row.id).filter(Boolean);
            if (orderIds.length === 0) {
                showToast('Selected orders have no ID', 'error');
                return;
            }
            try {
                const res = await apiRequest('/orders/generate-invoice', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderIds),
                    fallback: 'Failed to generate invoice'
                });
                const blob = await res.blob();
                const filename = invoicePdfFilename();
                const url = window.URL.createObjectURL(blob);
                const opened = window.open(url, '_blank', 'noopener,noreferrer');
                if (!opened) {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }
                setTimeout(() => window.URL.revokeObjectURL(url), 60000);
                showToast(`Invoice generated (${orderIds.length} order(s))`, 'success');
            } catch (e) {
                showToast(e.message || 'Failed to generate invoice', 'error');
            }
        });
    }

    // Generate Packaging List (opens modal: enter order numbers or upload labels PDF)
    const ordersMoreActionGeneratePackagingList = document.getElementById('ordersMoreActionGeneratePackagingList');
    if (ordersMoreActionGeneratePackagingList) {
        ordersMoreActionGeneratePackagingList.addEventListener('click', openPackagingListModal);
    }
    document.getElementById('closePackagingListModal')?.addEventListener('click', closePackagingListModal);
    document.getElementById('packagingListModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'packagingListModal') closePackagingListModal();
    });
    document.getElementById('packagingListOrderNumbers')?.addEventListener('input', updatePackagingListOrderCount);
    document.getElementById('packagingListUploadPdfBtn')?.addEventListener('click', () => {
        document.getElementById('packagingListPdfInput')?.click();
    });
    document.getElementById('packagingListPdfInput')?.addEventListener('change', handlePackagingListPdfUpload);
    document.getElementById('packagingListGenerateBtn')?.addEventListener('click', generatePackagingListFromNumbers);

    // Create Replacement Order
    const ordersMoreActionCreateReplacement = document.getElementById('ordersMoreActionCreateReplacement');
    if (ordersMoreActionCreateReplacement) {
        ordersMoreActionCreateReplacement.addEventListener('click', () => openReplacementOrderModal());
    }

    // Replacement Order modal
    const replacementOrderModal = document.getElementById('replacementOrderModal');
    const closeReplacementOrderModalBtn = document.getElementById('closeReplacementOrderModal');
    const cancelReplacementOrderBtn = document.getElementById('cancelReplacementOrder');
    const replacementOrderForm = document.getElementById('replacementOrderForm');

    const closeReplacementModal = () => replacementOrderModal?.classList.remove('active');
    closeReplacementOrderModalBtn?.addEventListener('click', closeReplacementModal);
    cancelReplacementOrderBtn?.addEventListener('click', closeReplacementModal);
    replacementOrderModal?.addEventListener('click', (e) => {
        if (e.target === replacementOrderModal) closeReplacementModal();
    });

    if (replacementOrderForm) {
        replacementOrderForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = document.getElementById('submitReplacementOrder');
            const originalNum = document.getElementById('replOrderNumber').value.trim();
            const courier = document.getElementById('replCourier').value;
            const total = parseFloat(document.getElementById('replTotal').value) || 0;
            const advance = parseFloat(document.getElementById('replAdvance').value) || 0;
            const costPrice = parseFloat(document.getElementById('replCostPrice').value) || 0;
            const tracking = document.getElementById('replTracking').value.trim();

            if (!originalNum) {
                showToast('Please enter the original order number', 'error');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating...';
            try {
                const result = await apiJson('/orders/create-replacement', {
                    method: 'POST',
                    body: {
                        original_order_number: originalNum,
                        total_amount: total,
                        advance_amount: advance,
                        cost_price: costPrice,
                        courier: courier,
                        tracking_number: tracking || null,
                    },
                    fallback: 'Failed to create replacement order'
                });
                showToast(`Replacement order ${result.order_number} created`, 'success');
                closeReplacementModal();
                loadOrders();
            } catch (error) {
                showToast(error.message || 'Failed to create replacement order', 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create';
            }
        });
    }

    // Delete Confirmation Modal
    const deleteConfirmModal = document.getElementById('deleteConfirmModal');
    const closeDeleteConfirmModalBtn = document.getElementById('closeDeleteConfirmModal');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

    closeDeleteConfirmModalBtn?.addEventListener('click', closeDeleteConfirmModal);
    cancelDeleteBtn?.addEventListener('click', closeDeleteConfirmModal);
    confirmDeleteBtn?.addEventListener('click', confirmDeleteReplacementOrder);
    deleteConfirmModal?.addEventListener('click', (e) => {
        if (e.target === deleteConfirmModal) closeDeleteConfirmModal();
    });

    // Generate Load Sheet modal
    document.getElementById('generateLoadSheetModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'generateLoadSheetModal') closeGenerateLoadSheetModal();
    });
    document.getElementById('closeGenerateLoadSheetModal')?.addEventListener('click', closeGenerateLoadSheetModal);
    document.getElementById('loadSheetModalCancel')?.addEventListener('click', closeGenerateLoadSheetModal);
    document.getElementById('loadSheetModalConfirm')?.addEventListener('click', confirmGenerateLoadSheet);
    document.getElementById('loadSheetOrderNumbers')?.addEventListener('input', updateLoadSheetModalState);

    // Load Sheet Logs page
    document.getElementById('loadSheetLogsRefreshBtn')?.addEventListener('click', () => loadLoadSheetLogs());

    // Refresh delivery status for selected orders
    const refreshDeliveryStatusSelectedBtn = document.getElementById('refreshDeliveryStatusSelectedBtn');
    if (refreshDeliveryStatusSelectedBtn) {
        refreshDeliveryStatusSelectedBtn.addEventListener('click', () => refreshDeliveryStatusSelected());
    }
    const exportGridExcelBtn = document.getElementById('exportGridExcelBtn');
    if (exportGridExcelBtn) {
        exportGridExcelBtn.addEventListener('click', () => exportCurrentGridToExcel());
    }
    initOrdersMoreActionsMenu();

    // Cashbook actions
    const cashbookDateFilter = document.getElementById('cashbookDateFilter');
    if (cashbookDateFilter) {
        const applyDateFromInput = () => {
            const parsed = parseDDMMYYYYToYYYYMMDD(cashbookDateFilter.value);
            if (parsed) {
                cashbookSelectedDate = parsed;
                cashbookDateFilter.value = formatDateDDMMYYYY(parsed);
                reloadCashbookForCurrentDate();
            } else if (cashbookDateFilter.value.trim() !== '') {
                showToast('Enter date as DD/MM/YYYY', 'error');
                cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
            }
        };
        cashbookDateFilter.addEventListener('change', applyDateFromInput);
        cashbookDateFilter.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyDateFromInput();
            }
        });
        cashbookDateFilter.addEventListener('blur', () => {
            if (cashbookDateFilter.value.trim() !== '') {
                const parsed = parseDDMMYYYYToYYYYMMDD(cashbookDateFilter.value);
                if (parsed) {
                    cashbookSelectedDate = parsed;
                    cashbookDateFilter.value = formatDateDDMMYYYY(parsed);
                } else {
                    cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
                }
            } else {
                cashbookDateFilter.value = formatDateDDMMYYYY(cashbookSelectedDate || getTodayDateString());
            }
        });
    }
    const cashbookTodayBtn = document.getElementById('cashbookTodayBtn');
    if (cashbookTodayBtn) {
        cashbookTodayBtn.addEventListener('click', () => {
            const today = getTodayDateString();
            cashbookSelectedDate = today;
            if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(today);
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
            if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(newDate);
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
            if (cashbookDateFilter) cashbookDateFilter.value = formatDateDDMMYYYY(newDate);
            reloadCashbookForCurrentDate();
        });
    }

    // Ledger: create button opens modal
    const createLedgerBtn = document.getElementById('createLedgerBtn');
    if (createLedgerBtn) {
        createLedgerBtn.addEventListener('click', () => openCreateLedgerModal());
    }
    // Cashbook/order advance ledger selects: picking "+ Create new ledger..." opens the create ledger modal
    ['cashbookEntryInLedger', 'cashbookEntryOutLedger'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', handleLedgerSelectChange);
    });

    // Cashbook: create entry button opens modal
    document.getElementById('cashbookCreateEntryBtn')?.addEventListener('click', openCashbookEntryModal);
    // Cashbook: order advance mode within the create entry modal
    document.getElementById('cashbookEntryOrderAdvance')?.addEventListener('change', (e) => {
        setCashbookEntryOrderAdvance(e.target.checked);
    });
    document.getElementById('cashbookEntryOrderNumber')?.addEventListener('input', refreshCashbookEntryParticularPlaceholders);
    // Cashbook: bulk text entry mode within the create entry modal
    document.getElementById('cashbookEntryModeSingle')?.addEventListener('click', () => setCashbookEntryMode('single'));
    document.getElementById('cashbookEntryModeBulk')?.addEventListener('click', () => setCashbookEntryMode('bulk'));
    document.getElementById('bulkEntrySubmitBtn')?.addEventListener('click', submitBulkEntry);
    // Re-validate as the user types (debounced lightly) and reset submit state.
    document.getElementById('bulkEntryInput')?.addEventListener('input', () => {
        setBulkEntrySubmitEnabled(false);
        clearTimeout(window.__bulkEntryDebounce);
        window.__bulkEntryDebounce = setTimeout(validateBulkEntry, 300);
    });
    document.getElementById('closeCashbookEntryModal')?.addEventListener('click', closeCashbookEntryModal);
    document.getElementById('cashbookEntryCancelBtn')?.addEventListener('click', closeCashbookEntryModal);
    document.getElementById('cashbookEntryModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'cashbookEntryModal') closeCashbookEntryModal();
    });
    document.getElementById('cashbookEntryForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        submitCashbookEntryModal();
    });
    // Mirror incoming amount into outgoing until the user edits the outgoing amount.
    document.getElementById('cashbookEntryInAmount')?.addEventListener('input', (e) => {
        const outAmount = document.getElementById('cashbookEntryOutAmount');
        // If both fields are now empty, re-arm mirroring (back to default mode).
        if (e.target.value === '' && outAmount && outAmount.value === '') {
            cashbookEntryOutAmountTouched = false;
        }
        if (!cashbookEntryOutAmountTouched && outAmount) {
            outAmount.value = e.target.value;
        }
    });
    document.getElementById('cashbookEntryOutAmount')?.addEventListener('input', (e) => {
        const inAmount = document.getElementById('cashbookEntryInAmount');
        // If both fields are now empty, re-arm mirroring (back to default mode).
        if (e.target.value === '' && inAmount && inAmount.value === '') {
            cashbookEntryOutAmountTouched = false;
        } else {
            cashbookEntryOutAmountTouched = true;
        }
    });
    // Update particulars placeholders dynamically as ledgers are chosen.
    document.getElementById('cashbookEntryInLedger')?.addEventListener('change', refreshCashbookEntryParticularPlaceholders);
    document.getElementById('cashbookEntryOutLedger')?.addEventListener('change', refreshCashbookEntryParticularPlaceholders);
    // Single-sided entry toggles: skip a side's entry and disable its fields.
    // Only one may be ticked at a time.
    document.getElementById('cashbookEntryInSkip')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const other = document.getElementById('cashbookEntryOutSkip');
            if (other && other.checked) { other.checked = false; setCashbookEntrySideSkipped('outflow', false); }
        }
        setCashbookEntrySideSkipped('inflow', e.target.checked);
    });
    document.getElementById('cashbookEntryOutSkip')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const other = document.getElementById('cashbookEntryInSkip');
            if (other && other.checked) { other.checked = false; setCashbookEntrySideSkipped('inflow', false); }
        }
        setCashbookEntrySideSkipped('outflow', e.target.checked);
    });
    // Back to Month Summary button
    const backToMonthSummaryBtn = document.getElementById('backToMonthSummaryBtn');
    if (backToMonthSummaryBtn) {
        backToMonthSummaryBtn.addEventListener('click', () => {
            switchView('monthSummary');
        });
    }

    // Create Ledger modal: form submit and close
    const createLedgerForm = document.getElementById('createLedgerForm');
    if (createLedgerForm) {
        createLedgerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!isEditingAllowed()) {
                showToast('Editing is locked', 'error');
                return;
            }
            const name = document.getElementById('createLedgerName').value.trim();
            const type = document.getElementById('createLedgerType').value;
            const includeInCashInHand = document.getElementById('createLedgerCashInHand').checked;
            const openingBalanceAmount = document.getElementById('createLedgerOpeningBalanceAmount').value;
            const openingBalanceSide = document.getElementById('createLedgerOpeningBalanceSide').value;
            if (!name) {
                showToast('Enter a ledger name', 'error');
                return;
            }
            if (!type) {
                showToast('Select a type', 'error');
                return;
            }
            const openingBalance = openingBalanceToSigned(openingBalanceAmount, openingBalanceSide);
            createLedger(name, type, includeInCashInHand, openingBalance);
        });
    }
    document.getElementById('closeCreateLedgerModal')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerCancelBtn')?.addEventListener('click', closeCreateLedgerModal);
    document.getElementById('createLedgerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'createLedgerModal') closeCreateLedgerModal();
    });

    // Edit Ledger modal
    document.getElementById('closeEditLedgerModal')?.addEventListener('click', closeEditLedgerModal);
    document.getElementById('editLedgerCancelBtn')?.addEventListener('click', closeEditLedgerModal);
    document.getElementById('editLedgerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'editLedgerModal') closeEditLedgerModal();
    });
    const editLedgerModalContent = document.querySelector('#editLedgerModal .modal-content');
    if (editLedgerModalContent) {
        editLedgerModalContent.addEventListener('click', (e) => e.stopPropagation());
    }
    const editLedgerForm = document.getElementById('editLedgerForm');
    if (editLedgerForm) {
        editLedgerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!isEditingAllowed()) {
                showToast('Editing is locked', 'error');
                return;
            }
            saveEditLedger();
        });
    }
    document.getElementById('editLedgerDeleteBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!isEditingAllowed()) {
            showToast('Editing is locked', 'error');
            return;
        }
        deleteLedgerFromEditModal();
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
    // Sync the UI when the browser leaves fullscreen (e.g. user pressed Esc / F11)
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && document.body.classList.contains('orders-table-fullscreen')) {
            syncOrdersFullScreenExit();
        }
    });
}

function toggleOrdersFullScreen() {
    if (document.body.classList.contains('orders-table-fullscreen')) {
        exitOrdersFullScreen();
    } else {
        document.body.classList.add('orders-table-fullscreen');
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
        setTimeout(() => {
            sizeGridColumns(ordersGridApi);
        }, 100);
    }
}

/** Sync UI when fullscreen was exited by the browser (Esc/F11). Do not call exitFullscreen again. */
function syncOrdersFullScreenExit() {
    document.body.classList.remove('orders-table-fullscreen');
    setTimeout(() => {
        sizeGridColumns(ordersGridApi);
    }, 100);
}

/** Exit fullscreen when the user clicks the fullscreen button. */
function exitOrdersFullScreen() {
    document.body.classList.remove('orders-table-fullscreen');
    if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
    }
    setTimeout(() => {
        sizeGridColumns(ordersGridApi);
    }, 100);
}

