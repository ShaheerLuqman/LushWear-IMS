// Inventory view: the stat cards, the toolbar wrapped around the products AG Grid
// (which shows every product in one scrollable table, no pagination), and the
// per-product details / stock-adjustment / cost-history modals. The grid itself
// (columns, filters) lives in orders-grid.js; cost editing stays in
// modals-forms.js's editVariantCostsModal, which this view opens as its "Update
// Cost" action.

const INVENTORY_FILTERS_KEY = 'lushwear_inventory_filters_visible';

// Per-column floating filters start hidden so the table reads cleanly; the
// toolbar's Filters button brings them back and the choice sticks per browser.
function inventoryFiltersVisible() {
    return localStorage.getItem(INVENTORY_FILTERS_KEY) === '1';
}

// ============================================
// Stat cards
// ============================================

function formatInventoryDelta(current, previous) {
    if (previous == null || current == null) return '';
    const prev = Number(previous);
    const curr = Number(current);
    if (prev === curr) return '<span class="inventory-delta-flat">No change from last month</span>';
    // A baseline of zero has no percentage - show the absolute move instead.
    const body = prev === 0
        ? `${Math.abs(curr - prev).toLocaleString('en-US')}`
        : `${Math.abs(((curr - prev) / prev) * 100).toFixed(1)}%`;
    const up = curr > prev;
    return `<span class="inventory-delta-${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${body} from last month</span>`;
}

const INVENTORY_STAT_FIELDS = [
    ['invStatTotalProducts', 'total_products', (v) => Number(v).toLocaleString('en-US')],
    ['invStatTotalStock', 'total_stock', (v) => Number(v).toLocaleString('en-US')],
    ['invStatLowStock', 'low_stock_count', (v) => Number(v).toLocaleString('en-US')],
    ['invStatOutOfStock', 'out_of_stock_count', (v) => Number(v).toLocaleString('en-US')],
    ['invStatValue', 'inventory_value', (v) => `PKR ${formatAmount(v)}`],
];

function renderInventoryStats(summary) {
    const current = summary?.current || {};
    const previous = summary?.previous || null;
    for (const [elId, field, format] of INVENTORY_STAT_FIELDS) {
        const valueEl = document.getElementById(elId);
        if (valueEl) valueEl.textContent = current[field] == null ? '—' : format(current[field]);
        const deltaEl = document.getElementById(`${elId}Delta`);
        if (deltaEl) deltaEl.innerHTML = formatInventoryDelta(current[field], previous?.[field]);
    }
}

async function loadInventorySummary() {
    try {
        renderInventoryStats(await apiJson('/products/inventory-summary', { fallback: 'Failed to load inventory summary' }));
    } catch (error) {
        // The cards are supporting detail; the grid below them is still usable.
        console.error('Error loading inventory summary:', error);
    }
}

// ============================================
// Toolbar + pagination
// ============================================

/** Collection options come from the loaded products, same source as the grid's own
 *  collection filter, so the two can't offer different values. */
function refreshInventoryCollectionOptions() {
    const select = document.getElementById('inventoryCollectionFilter');
    if (!select) return;
    const previous = select.value;
    const values = Array.from(new Set((products || []).map(p => p.collection).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">All Collections</option>' +
        values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (values.includes(previous)) select.value = previous;
}

/** Drives the grid's own column filters from the toolbar selects, so the toolbar and
 *  the (optionally visible) floating filters stay one filter model rather than two. */
function applyInventoryToolbarFilters() {
    if (!productsGridApi) return;
    const model = { ...(productsGridApi.getFilterModel() || {}) };
    const collection = document.getElementById('inventoryCollectionFilter')?.value || '';
    const status = document.getElementById('inventoryStatusFilter')?.value || '';
    if (collection) model.collection = { values: [collection] };
    else delete model.collection;
    if (status) model.stockStatus = { values: [status] };
    else delete model.stockStatus;
    productsGridApi.setFilterModel(model);
}

// ============================================
// Product details
// ============================================

function productThumbHtml(product) {
    return product?.image_url
        ? `<img src="${escapeHtml(product.image_url)}" alt="">`
        : '<div class="grid-image-placeholder">No Img</div>';
}

function productSubtitle(product) {
    const collection = product?.collection || '—';
    const variantCount = (product?.variants || []).length;
    return `Collection: ${escapeHtml(collection)} • ${variantCount} variant${variantCount === 1 ? '' : 's'}`;
}

/** Fills the name/thumb/status/subtitle block shared by all three product modals. */
function renderProductIdentity(prefix, product, withStatus = true) {
    document.getElementById(`${prefix}Thumb`).innerHTML = productThumbHtml(product);
    document.getElementById(`${prefix}Name`).textContent = product.name || '';
    document.getElementById(`${prefix}Sub`).innerHTML = productSubtitle(product);
    if (!withStatus) return;
    const statusEl = document.getElementById(`${prefix}Status`);
    const status = productStockStatus(product);
    statusEl.className = `grid-status-badge ${status}`;
    statusEl.textContent = STOCK_STATUS_LABELS[status];
}

let productDetailsProduct = null;

function openProductDetailsModal(product) {
    if (!product?.id) return;
    productDetailsProduct = product;
    renderProductIdentity('productDetails', product);

    const unitCost = productUnitCost(product);
    const summary = [
        ['Total Stock', (product.total_quantity || 0).toLocaleString('en-US')],
        ['Cost per Unit', unitCost != null ? `PKR ${formatAmount(unitCost)}` : 'Mixed'],
        ['Value', `PKR ${formatAmount(productStockValue(product))}`],
    ];
    const sizes = sortVariantsBySize(product.variants || []).map(v => [v.title, String(v.quantity || 0)]);
    const cells = (rows) => rows.map(([label, value]) => `
        <div class="product-details-stock-cell">
            <span class="product-details-stock-label">${escapeHtml(label)}</span>
            <span class="product-details-stock-value">${escapeHtml(value)}</span>
        </div>`).join('');
    document.getElementById('productDetailsStock').innerHTML =
        `<div class="product-details-stock-grid">${cells(summary)}</div>` +
        (sizes.length ? `<div class="product-details-stock-grid">${cells(sizes)}</div>` : '');

    const meta = [
        ['Selling Price', `PKR ${formatAmount(product.price)}`],
        ['Collection', product.collection || '—'],
        ['Created At', formatDateTimeDDMMYYYY(product.created_at) || '—'],
        ['Last Updated', formatDateTimeDDMMYYYY(product.updated_at) || '—'],
    ];
    document.getElementById('productDetailsMeta').innerHTML = meta.map(([k, v]) => `
        <div class="product-details-meta-row"><dt>${k}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('');

    document.getElementById('productDetailsModal')?.classList.add('active');
    if (window.lucide) lucide.createIcons({ root: document.getElementById('productDetailsModal') });
}

function closeProductDetailsModal() {
    document.getElementById('productDetailsModal')?.classList.remove('active');
}

// ============================================
// Adjust stock
// ============================================

let adjustStockProduct = null;

function openAdjustStockModal(product) {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error', { silent: true });
        return;
    }
    const variants = sortVariantsBySize(product?.variants || []);
    if (!variants.length) {
        showToast('This product has no variants to adjust', 'error', { silent: true });
        return;
    }
    adjustStockProduct = product;
    renderProductIdentity('adjustStock', product);

    document.getElementById('adjustStockVariants').innerHTML = variants.map(v => `
        <div class="adjust-stock-row">
            <span class="adjust-stock-row-title">${escapeHtml(v.title)}<span class="adjust-stock-row-current">in stock: ${v.quantity || 0}</span></span>
            <input type="number" class="form-input adjust-stock-input" data-variant-id="${v.id}" data-current="${v.quantity || 0}" min="0" step="1" placeholder="0">
        </div>`).join('');

    document.querySelector('input[name="adjustStockType"][value="add"]').checked = true;
    document.getElementById('adjustStockReason').value = '';
    document.getElementById('adjustStockNotes').value = '';
    document.getElementById('adjustStockModal')?.classList.add('active');
}

function closeAdjustStockModal() {
    document.getElementById('adjustStockModal')?.classList.remove('active');
}

async function submitAdjustStock() {
    if (!isEditingAllowed()) {
        showToast('Editing is locked', 'error', { silent: true });
        return;
    }
    const reason = document.getElementById('adjustStockReason')?.value || '';
    if (!reason) {
        showToast('Select a reason for this adjustment', 'error', { silent: true });
        return;
    }
    const sign = document.querySelector('input[name="adjustStockType"]:checked')?.value === 'remove' ? -1 : 1;
    const adjustments = [];
    for (const input of document.querySelectorAll('#adjustStockVariants .adjust-stock-input')) {
        const raw = input.value.trim();
        if (raw === '') continue;
        const qty = parseInt(raw, 10);
        if (isNaN(qty) || qty < 0) {
            showToast('Enter a whole quantity of 0 or more', 'error', { silent: true });
            return;
        }
        if (qty === 0) continue;
        if (sign < 0 && qty > parseInt(input.dataset.current, 10)) {
            showToast(`Cannot remove more than the ${input.dataset.current} in stock`, 'error', { silent: true });
            return;
        }
        adjustments.push({ variant_id: input.dataset.variantId, delta: sign * qty });
    }
    if (!adjustments.length) {
        showToast('Enter a quantity for at least one size', 'error', { silent: true });
        return;
    }

    const btn = document.getElementById('adjustStockSubmit');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Updating...';
    }
    try {
        await apiJson(`/products/${adjustStockProduct.id}/adjust-stock`, {
            method: 'POST',
            body: { adjustments, reason, notes: document.getElementById('adjustStockNotes')?.value?.trim() || null },
            fallback: 'Failed to adjust stock'
        });
        closeAdjustStockModal();
        showToast('Stock updated', 'success');
        await loadProducts();
        loadInventorySummary();
    } catch (error) {
        showToast(error.message || 'Failed to adjust stock', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Update Stock';
        }
    }
}

// ============================================
// Cost history
// ============================================

async function openCostHistoryModal(product) {
    if (!product?.id) return;
    renderProductIdentity('costHistory', product, false);
    const body = document.getElementById('costHistoryBody');
    body.innerHTML = tableLoadingRow(5, 'Loading…');
    document.getElementById('costHistoryModal')?.classList.add('active');

    try {
        const rows = await apiJson(`/products/${product.id}/cost-history`, { fallback: 'Failed to load cost history' });
        body.innerHTML = rows.length ? rows.map(r => `
            <tr>
                <td>${escapeHtml(formatDateTimeDDMMYYYY(r.created_at))}</td>
                <td>${escapeHtml(r.variant_title || 'All variants')}</td>
                <td>${r.new_cost_price == null ? '—' : `PKR ${formatAmount(r.new_cost_price)}`}</td>
                <td>${escapeHtml(r.changed_by_name || 'System')}</td>
                <td>${escapeHtml(r.reason || '—')}</td>
            </tr>`).join('')
            : '<tr><td colspan="5" class="cost-history-empty">No cost changes recorded yet. Costs set by receiving a purchase bill are audited on that bill.</td></tr>';
    } catch (error) {
        body.innerHTML = `<tr><td colspan="5" class="cost-history-empty">${escapeHtml(error.message || 'Failed to load cost history')}</td></tr>`;
    }
}

function closeCostHistoryModal() {
    document.getElementById('costHistoryModal')?.classList.remove('active');
}

// ============================================
// Wiring
// ============================================

let inventorySearchTimer = null;
document.getElementById('inventorySearch')?.addEventListener('input', (e) => {
    const value = e.target.value;
    if (inventorySearchTimer) clearTimeout(inventorySearchTimer);
    inventorySearchTimer = setTimeout(() => {
        inventorySearchTimer = null;
        productsGridApi?.setGridOption('quickFilterText', value);
    }, 200);
});
document.getElementById('inventoryCollectionFilter')?.addEventListener('change', applyInventoryToolbarFilters);
document.getElementById('inventoryStatusFilter')?.addEventListener('change', applyInventoryToolbarFilters);

document.getElementById('inventoryFiltersToggle')?.addEventListener('click', (e) => {
    const visible = !inventoryFiltersVisible();
    try { localStorage.setItem(INVENTORY_FILTERS_KEY, visible ? '1' : '0'); } catch (err) { /* ignore */ }
    e.currentTarget.setAttribute('aria-pressed', String(visible));
    productsGridApi?.setGridOption('defaultColDef', {
        sortable: true, resizable: true, filter: true, floatingFilter: visible, minWidth: 80
    });
});

document.getElementById('inventoryExportBtn')?.addEventListener('click', () => exportCurrentGridToExcel());

document.getElementById('productDetailsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'productDetailsModal') closeProductDetailsModal();
});
document.getElementById('closeProductDetailsModal')?.addEventListener('click', closeProductDetailsModal);
document.getElementById('productDetailsClose')?.addEventListener('click', closeProductDetailsModal);
document.getElementById('productDetailsUpdateCost')?.addEventListener('click', () => {
    closeProductDetailsModal();
    openEditVariantCostsModal(productDetailsProduct);
});
document.getElementById('productDetailsAdjustStock')?.addEventListener('click', () => {
    closeProductDetailsModal();
    openAdjustStockModal(productDetailsProduct);
});
document.getElementById('productDetailsHistory')?.addEventListener('click', () => {
    closeProductDetailsModal();
    openCostHistoryModal(productDetailsProduct);
});

document.getElementById('adjustStockModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'adjustStockModal') closeAdjustStockModal();
});
document.getElementById('closeAdjustStockModal')?.addEventListener('click', closeAdjustStockModal);
document.getElementById('adjustStockCancel')?.addEventListener('click', closeAdjustStockModal);
document.getElementById('adjustStockSubmit')?.addEventListener('click', submitAdjustStock);

document.getElementById('costHistoryModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'costHistoryModal') closeCostHistoryModal();
});
document.getElementById('closeCostHistoryModal')?.addEventListener('click', closeCostHistoryModal);
document.getElementById('costHistoryClose')?.addEventListener('click', closeCostHistoryModal);

// Reflect the remembered toolbar state in the controls themselves (the grid picks
// the same value up through inventoryFiltersVisible at init).
document.getElementById('inventoryFiltersToggle')?.setAttribute('aria-pressed', String(inventoryFiltersVisible()));
