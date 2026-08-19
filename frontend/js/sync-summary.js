// Dashboard stats and month summary/detail.

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
            const warningCount = month.warning_orders_count || 0;
            const warningHtml = warningCount > 0
                ? `<div class="month-summary-card-body">
                        <span class="month-summary-card-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${warningCount} on warning</span>
                    </div>`
                : '';
            return `
                <div class="month-summary-card" data-month="${month.month}" data-year="${month.year}">
                    <div class="month-summary-card-header">
                        <h3 class="month-summary-card-title">${monthName} ${month.year}</h3>
                        <span class="month-summary-card-period">${periodLabel}</span>
                    </div>
                    ${warningHtml}
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
                        ${(data.expense_lines || []).map(line => `
                        <div class="month-detail-line"><span class="month-detail-line-label">${escapeHtml(line.name)}</span><span class="month-detail-line-value">Rs ${fmt(line.amount ?? 0)}</span></div>`).join('')}
                    </div>
                </section>
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Products Sold by Collection</h3>
                    <div class="month-detail-lines collection-breakdown">
                        ${(data.products_sold_by_collection || []).map(row => `
                            <div class="collection-breakdown-group">
                                <button type="button" class="month-detail-line collection-breakdown-toggle" ${(row.products || []).length ? '' : 'disabled'}>
                                    <span class="month-detail-line-label">
                                        ${(row.products || []).length ? '<span class="collection-breakdown-chevron">▸</span>' : ''}
                                        ${escapeHtml(row.collection || 'Others')}
                                    </span>
                                    <span class="month-detail-line-value">${fmt(row.count)} units · Rs ${fmt(row.sum)}</span>
                                </button>
                                <div class="collection-breakdown-products">
                                    ${(row.products || []).map(p => `
                                        <div class="month-detail-line collection-breakdown-product">
                                            <span class="month-detail-line-label">${escapeHtml(p.name)}</span>
                                            <span class="month-detail-line-value">${fmt(p.count)} units · Rs ${fmt(p.sum)}</span>
                                        </div>
                                    `).join('')}
                                </div>
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
                        <div class="month-detail-line"><span class="month-detail-line-label">Cancelled Orders</span><span class="month-detail-line-value">${fmt(data.cancelled_orders_count ?? 0)}</span></div>
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
                <section class="month-detail-section">
                    <h3 class="month-detail-section-heading">Carrier Health</h3>
                    <div class="month-detail-lines">
                        ${(data.carrier_health || []).map(row => {
                            const pct = row.total_count > 0 ? Math.round((row.delivered_count / row.total_count) * 100) : 0;
                            return `
                                <div class="month-detail-line">
                                    <span class="month-detail-line-label">${escapeHtml(row.courier)}</span>
                                    <span class="month-detail-line-value">${row.delivered_count}/${row.total_count} (${pct}%)</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </section>
            </div>
        </div>
    `;
}

/** Back to Month Summary button, on the Month Detail view. */
function initMonthSummaryNav() {
    document.getElementById('backToMonthSummaryBtn')?.addEventListener('click', () => {
        switchView('monthSummary');
    });
    document.getElementById('monthDetailContent')?.addEventListener('click', (e) => {
        e.target.closest('.collection-breakdown-toggle')?.parentElement.classList.toggle('expanded');
    });
}

