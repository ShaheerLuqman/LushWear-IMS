// Purchase bills (accounts payable). A supplier is a ledger, so the supplier
// picker lists party ledgers. Lines carry no account: a bill is always for
// stock and posts to Inventory.
//
// Payments are not recorded here — they are ordinary transaction entries against
// the supplier's ledger, made when the money actually moves. What each bill
// still owes is derived from that ledger balance, applied oldest-bill-first.

let billsGridApi = null;
let apAgeingGridApi = null;
let bills = [];
let apAgeingAsOf = null;
let editingBillId = null;
// Line rows live here while the modal is open rather than being read back out
// of the DOM on save, so a half-typed row can't silently become a zero line.
let billLineDrafts = [];
// A posted (non-draft) bill opens the same modal in read-only mode so it can
// still be reviewed — editing it would just bounce off the API's status guard.
let billModalReadOnly = false;

const BILL_STATUS_LABELS = {
    draft: 'Draft',
    cancelled: 'Cancelled',
    unpaid: 'Unpaid',
    partially_paid: 'Part paid',
    paid: 'Paid',
};

function partyLedgers() {
    return ledgers.filter(l => l.type === 'Liability');
}

function ledgerName(id) {
    const ledger = ledgers.find(l => l.id === id);
    return ledger ? ledger.name : '';
}

// Mirrors the "Go to Ledger" button on the transactions grid so a supplier's
// account is one click away from the bill referencing it.
function supplierCellRenderer(params) {
    const supplierId = params.data?.supplier_id;
    const wrapper = document.createElement('div');
    wrapper.className = 'folio-dropdown';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'folio-display-text';
    nameSpan.textContent = ledgerName(supplierId);
    wrapper.appendChild(nameSpan);

    const goToLedgerBtn = document.createElement('button');
    goToLedgerBtn.type = 'button';
    goToLedgerBtn.className = 'folio-goto-btn';
    goToLedgerBtn.innerHTML = '<i class="fa-solid fa-arrow-right"></i>';
    goToLedgerBtn.title = supplierId ? `Go to ${nameSpan.textContent}` : 'No supplier';
    if (!supplierId) {
        goToLedgerBtn.style.opacity = '0.4';
        goToLedgerBtn.style.cursor = 'not-allowed';
    }
    goToLedgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (supplierId) openLedgerDetail(supplierId);
    });
    wrapper.appendChild(goToLedgerBtn);

    return wrapper;
}

async function loadBills() {
    if (billsGridApi) billsGridApi.showLoadingOverlay();
    try {
        const status = document.getElementById('billsStatusFilter')?.value || '';
        bills = await apiJson(`/bills/${status ? `?status=${status}` : ''}`, {
            fallback: 'Failed to load bills'
        });
    } catch (error) {
        console.error('Error loading bills:', error);
        showToast('Failed to load bills', 'error');
        bills = [];
    }
    if (billsGridApi) {
        billsGridApi.setGridOption('rowData', bills);
        billsGridApi.hideOverlay();
    }
}

// --- Bill modal --------------------------------------------------------------

function emptyBillLine() {
    return {
        _key: `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        mode: 'product',
        description: '',
        quantity: '',
        unit_cost: '',
        product_id: null,
        // variant_id + quantity are used for a text line, or a product line
        // whose product can't offer the per-variant grid (no variants, or a
        // product deactivated since the line was set). variantQuantities and
        // variantCosts (variant_id -> qty / unit cost) are used instead once
        // a product with variants is selected - see billLineUsesVariantGrid.
        variant_id: null,
        variantQuantities: {},
        variantCosts: {},
    };
}

function billLineProduct(line) {
    return products.find(p => p.id === line.product_id) || null;
}

// True once a line has a resolvable product that actually has variants - the
// per-variant quantity grid replaces the single quantity field for it.
function billLineUsesVariantGrid(line) {
    if (line.mode !== 'product') return false;
    const product = billLineProduct(line);
    return !!(product && (product.variants || []).length);
}

function billLineTotalQty(line) {
    if (billLineUsesVariantGrid(line)) {
        return Object.values(line.variantQuantities || {})
            .reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
    }
    return parseFloat(line.quantity) || 0;
}

function billLineAmount(line) {
    if (billLineUsesVariantGrid(line)) {
        const qtys = line.variantQuantities || {};
        const costs = line.variantCosts || {};
        let amount = 0;
        for (const variantId of Object.keys(qtys)) {
            const qty = parseFloat(qtys[variantId]) || 0;
            const cost = parseFloat(costs[variantId]);
            if (qty > 0 && !Number.isNaN(cost)) amount += qty * cost;
        }
        return Math.round(amount * 100) / 100;
    }
    const qty = billLineTotalQty(line);
    const cost = parseFloat(line.unit_cost);
    if (!qty || Number.isNaN(cost)) return 0;
    return Math.round(qty * cost * 100) / 100;
}

// The bill only stores a free-text description, so a product/variant's
// description is generated here for display on the bill and its PDF.
function billLineVariantDescription(product, variant) {
    return variant ? `${product.name} — ${variant.title}` : product.name;
}

// A searchable dropdown rather than a plain <select> — there can be enough
// products that scanning a flat list to find one is slower than typing a few
// letters. Reuses the folio-dropdown-* styling/behavior the ledger picker
// (orders-grid.js's createFolioCellRenderer) already established.
let closeOpenBillProductDropdown = null;

function billProductSearchMatches(filter) {
    const q = filter.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p => p.name.toLowerCase().includes(q));
}

function openBillProductDropdown(button, line, index) {
    if (closeOpenBillProductDropdown) closeOpenBillProductDropdown();

    button.classList.add('open');
    const panel = document.createElement('div');
    panel.className = 'folio-dropdown-panel';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'folio-dropdown-search';
    searchInput.placeholder = 'Search products...';
    panel.appendChild(searchInput);

    const optionsList = document.createElement('div');
    optionsList.className = 'folio-dropdown-options';
    panel.appendChild(optionsList);

    function renderOptions(filter) {
        const matches = billProductSearchMatches(filter || '');
        optionsList.innerHTML = '';
        matches.forEach(p => {
            const option = document.createElement('div');
            option.className = 'folio-dropdown-option' + (p.id === line.product_id ? ' selected' : '');
            option.textContent = p.name;
            option.addEventListener('click', () => {
                line.product_id = p.id;
                line.variant_id = null;
                line.variantQuantities = {};
                // Prefilled from the variant's own cost (falling back to the product's,
                // for a variant with none of its own yet) so most purchases need no
                // typing here at all - only a change in price needs editing per variant.
                line.variantCosts = {};
                (p.variants || []).forEach(v => { line.variantCosts[v.id] = v.cost_price ?? p.cost_price ?? ''; });
                line.quantity = '';
                closeDropdown();
                renderBillLines();
            });
            optionsList.appendChild(option);
        });
        if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'folio-dropdown-empty';
            empty.textContent = 'No products found';
            optionsList.appendChild(empty);
        }
    }

    function closeDropdown() {
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        button.classList.remove('open');
        document.removeEventListener('mousedown', outsideClickHandler);
        closeOpenBillProductDropdown = null;
    }
    closeOpenBillProductDropdown = closeDropdown;

    searchInput.addEventListener('input', e => renderOptions(e.target.value));
    searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });
    renderOptions();

    document.body.appendChild(panel);
    const rect = button.getBoundingClientRect();
    panel.style.top = (rect.bottom + 2) + 'px';
    panel.style.left = rect.left + 'px';
    panel.style.minWidth = Math.max(rect.width, 220) + 'px';
    setTimeout(() => searchInput.focus(), 0);

    // mousedown, not click, so this fires (and tears the panel down) before
    // whatever was clicked runs its own handler — including another row's
    // Add line/Remove/product button, which would otherwise call
    // renderBillLines() and orphan this panel (it lives on document.body,
    // outside the #billLines container renderBillLines() replaces).
    const outsideClickHandler = (e) => {
        if (!panel.contains(e.target) && e.target !== button && !button.contains(e.target)) closeDropdown();
    };
    document.addEventListener('mousedown', outsideClickHandler);
}

// One row per variant, so the whole size run of a product can be entered in
// one go instead of one bill line per variant, at its own cost instead of one
// cost for the whole run. Each row reuses .bill-line-main's own column widths
// (see .bill-line-variant-row in styles.css) so its qty/cost/amount sit
// directly under the line's own Qty/Cost/Amount headers, and its title sits
// in the same column as the product name above it, rather than a separate
// side-by-side box - there's no whole-line qty/cost/total anymore once every
// variant can carry its own (see the now-blank qtyCell/costCell in
// renderBillLines for a variant-grid line). Quantity defaults to 0; cost
// defaults to the variant's own current cost price, falling back to the
// product's (set when the product was picked - see the dropdown option's
// click handler above) rather than 0, since most purchases repeat the last
// price and only a change needs editing. landedCosts/lineCounts are null in
// read-only mode (viewing an already-received bill), where there's nothing
// left to land.
function billLineVariantQtyGrid(line, product, variants, disabled, landedCosts, lineCounts) {
    const qtys = line.variantQuantities || {};
    const costs = line.variantCosts || {};
    return `<div class="bill-line-variant-qtys">
        ${variants.map(v => {
            const qty = parseFloat(qtys[v.id]) || 0;
            const cost = parseFloat(costs[v.id]);
            const amount = (qty > 0 && !Number.isNaN(cost)) ? formatMoney(qty * cost) : '';
            const newCost = landedCosts ? landedCosts.get(v.id) : null;
            const costEffect = newCost != null
                ? billLineCostEffectHtml(v.cost_price ?? product.cost_price, newCost, lineCounts.get(v.id) || 1) : '';
            return `
            <div class="bill-line-variant-row" data-variant-id="${v.id}">
                <span class="bill-line-variant-qty-label">
                    ${escapeHtml(v.title)}
                    <span class="bill-line-variant-cost-effect" data-variant-id="${v.id}">${costEffect}</span>
                </span>
                <span></span>
                <input type="number" class="form-input bill-line-variant-qty-input" data-variant-id="${v.id}" min="0" step="1" placeholder="0" value="${qtys[v.id] ?? '0'}" ${disabled}>
                <input type="number" class="form-input bill-line-variant-cost-input" data-variant-id="${v.id}" min="0" step="0.01" placeholder="0.00" value="${costs[v.id] ?? ''}" ${disabled}>
                <span class="bill-line-variant-amount">${amount}</span>
                <span></span>
            </div>`;
        }).join('')}
    </div>`;
}

// A bill's tax/other-expense/discount land on the goods, not just on the lines
// that happen to reference a catalog product, so the per-unit share is spread
// across the whole bill's quantity rather than only the product-tagged lines.
function billLandedCostExtra() {
    const totalQty = billLineDrafts.reduce((sum, l) => sum + billLineTotalQty(l), 0);
    if (totalQty <= 0) return 0;
    const discount = parseFloat(document.getElementById('billDiscount')?.value) || 0;
    const tax = parseFloat(document.getElementById('billTax')?.value) || 0;
    const otherExpense = parseFloat(document.getElementById('billOtherExpense')?.value) || 0;
    return (tax + otherExpense - discount) / totalQty;
}

// Landed cost per variant-less product line referenced on this bill: the
// quantity-weighted average of its own line(s) unit cost (a product can
// appear on more than one line, e.g. bought at a different cost in a
// separate line), plus its even share of the bill's tax/other-expense/
// discount. Lines with a variant grid are excluded - see
// billVariantLandedCosts, their per-variant equivalent - since blending their
// variants into one product-wide figure is exactly what moving cost to
// variant level was meant to stop doing.
function billProductLandedCosts() {
    const extra = billLandedCostExtra();
    const byProduct = new Map();
    for (const line of billLineDrafts) {
        if (line.mode !== 'product' || !line.product_id || billLineUsesVariantGrid(line)) continue;
        const qty = billLineTotalQty(line);
        if (qty <= 0) continue;
        const cost = parseFloat(line.unit_cost) || 0;
        const agg = byProduct.get(line.product_id) || { qty: 0, costTotal: 0 };
        agg.qty += qty;
        agg.costTotal += qty * cost;
        byProduct.set(line.product_id, agg);
    }
    const result = new Map();
    for (const [productId, agg] of byProduct) {
        result.set(productId, Math.round((agg.costTotal / agg.qty + extra) * 100) / 100);
    }
    return result;
}

// Landed cost per variant referenced on this bill (across every variant-grid
// line that gave it a quantity above 0), same formula as
// billProductLandedCosts - this is what apply_bill_stock actually lands on
// shopify_variants.cost_price for each variant on receive.
function billVariantLandedCosts() {
    const extra = billLandedCostExtra();
    const byVariant = new Map();
    for (const line of billLineDrafts) {
        if (line.mode !== 'product' || !line.product_id || !billLineUsesVariantGrid(line)) continue;
        const qtys = line.variantQuantities || {};
        const costs = line.variantCosts || {};
        for (const variantId of Object.keys(qtys)) {
            const qty = parseFloat(qtys[variantId]) || 0;
            if (qty <= 0) continue;
            const cost = parseFloat(costs[variantId]) || 0;
            const agg = byVariant.get(variantId) || { qty: 0, costTotal: 0 };
            agg.qty += qty;
            agg.costTotal += qty * cost;
            byVariant.set(variantId, agg);
        }
    }
    const result = new Map();
    for (const [variantId, agg] of byVariant) {
        result.set(variantId, Math.round((agg.costTotal / agg.qty + extra) * 100) / 100);
    }
    return result;
}

// newCost is already the qty-weighted average landed cost across every entry
// on this bill that references the product/variant (see
// billProductLandedCosts/billVariantLandedCosts) — when it spans more than
// one entry, the label says so, since that average is what actually
// overwrites cost_price on receive (see apply_bill_stock in the DB), not any
// single line's own unit cost.
function billLineCostEffectHtml(currentCost, newCost, lineCount) {
    const current = currentCost || 0;
    const diff = Math.round((newCost - current) * 100) / 100;
    const changeClass = diff > 0 ? 'bill-line-cost-effect-up' : diff < 0 ? 'bill-line-cost-effect-down' : '';
    const change = diff === 0 ? '' : ` <span class="${changeClass}">(${diff > 0 ? '+' : ''}${formatMoney(diff)})</span>`;
    const label = lineCount > 1 ? `New avg cost (wtd across ${lineCount} entries)` : 'New cost price';
    return `${label}: Rs ${formatMoney(current)} → Rs ${formatMoney(newCost)}${change}`;
}

// How many priced entries (bill lines) with a positive quantity reference a
// given variant-less product — >1 means its landed cost above is a blend
// across them.
function billProductLineCounts() {
    const counts = new Map();
    for (const line of billLineDrafts) {
        if (line.mode !== 'product' || !line.product_id || billLineUsesVariantGrid(line)) continue;
        if (billLineTotalQty(line) > 0) counts.set(line.product_id, (counts.get(line.product_id) || 0) + 1);
    }
    return counts;
}

// Same idea, per variant: how many variant-grid rows with a positive quantity
// reference a given variant, across however many bill lines it appears on.
function billVariantLineCounts() {
    const counts = new Map();
    for (const line of billLineDrafts) {
        if (line.mode !== 'product' || !line.product_id || !billLineUsesVariantGrid(line)) continue;
        Object.entries(line.variantQuantities || {}).forEach(([variantId, qty]) => {
            if ((parseFloat(qty) || 0) > 0) counts.set(variantId, (counts.get(variantId) || 0) + 1);
        });
    }
    return counts;
}

// Patches the per-line/per-variant cost-price captions in place rather than a
// full renderBillLines(), so typing into a quantity/cost/tax/discount field
// doesn't blow away the input's focus and cursor position on every keystroke.
// Walks every line rather than just existing .bill-line-cost-effect elements,
// because a line starts with no quantity - so renderBillLines() had nothing
// to show a caption for yet - and the caption element (plus its .bill-line-extra
// wrapper, for a line with no variant grid) has to be created the first time
// a qty/cost value makes the line's landed cost computable.
function updateCostEffects() {
    const landedCosts = billProductLandedCosts();
    const lineCounts = billProductLineCounts();
    const variantLandedCosts = billVariantLandedCosts();
    const variantLineCounts = billVariantLineCounts();
    document.querySelectorAll('.bill-line').forEach(rowEl => {
        const index = parseInt(rowEl.dataset.index, 10);
        const line = billLineDrafts[index];
        const product = line && line.mode === 'product' ? billLineProduct(line) : null;

        if (product && billLineUsesVariantGrid(line)) {
            rowEl.querySelectorAll('.bill-line-variant-cost-effect').forEach(el => {
                const variantId = el.dataset.variantId;
                const variant = (product.variants || []).find(v => v.id === variantId);
                const newCost = variantLandedCosts.get(variantId);
                el.innerHTML = (variant && newCost != null)
                    ? billLineCostEffectHtml(variant.cost_price ?? product.cost_price, newCost, variantLineCounts.get(variantId) || 1)
                    : '';
            });
            return;
        }

        const newCost = product ? landedCosts.get(product.id) : null;
        let el = rowEl.querySelector('.bill-line-cost-effect');
        if (!product || newCost == null) {
            if (el) el.innerHTML = '';
            return;
        }
        if (!el) {
            let extra = rowEl.querySelector('.bill-line-extra');
            if (!extra) {
                extra = document.createElement('div');
                extra.className = 'bill-line-extra';
                // .bill-line-content, not rowEl itself - .bill-line is a 2-part
                // flex row (image, then content), so appending straight to it
                // would add a stray third flex sibling instead of a new row
                // under .bill-line-main inside the content column.
                rowEl.querySelector('.bill-line-content').appendChild(extra);
            }
            el = document.createElement('div');
            el.className = 'bill-line-cost-effect';
            el.dataset.index = index;
            extra.appendChild(el);
        }
        el.innerHTML = billLineCostEffectHtml(product.cost_price, newCost, lineCounts.get(product.id) || 1);
    });
}

function renderBillLines() {
    const container = document.getElementById('billLines');
    if (!container) return;
    // The dropdown panel lives on document.body, outside this container, so
    // it would otherwise survive the innerHTML replace below as an orphan.
    if (closeOpenBillProductDropdown) closeOpenBillProductDropdown();

    const disabled = billModalReadOnly ? 'disabled' : '';
    const landedCosts = billModalReadOnly ? null : billProductLandedCosts();
    const lineCounts = billModalReadOnly ? null : billProductLineCounts();
    const variantLandedCosts = billModalReadOnly ? null : billVariantLandedCosts();
    const variantLineCounts = billModalReadOnly ? null : billVariantLineCounts();
    container.innerHTML = billLineDrafts.map((line, index) => {
        const product = line.mode === 'product' ? billLineProduct(line) : null;
        // The product list only holds active products, so a line referencing one
        // that's since been deactivated has nothing to put in the select — fall
        // back to the description already stored for it rather than show blank.
        const productMissing = line.mode === 'product' && line.product_id && !product;
        const variants = product ? (product.variants || []) : [];
        const usesVariantGrid = !!product && variants.length > 0;

        // Image is its own flex sibling of the rest of the line (see .bill-line
        // in styles.css), stretched to the height of the product row plus its
        // variant rows. Item name/toggle/Qty/Cost are columns of the inner
        // .bill-line-main grid below, so - like qtyCell/costCell already do -
        // every branch still has to render *something* (even an empty span)
        // rather than '', or a missing element would shift every later column
        // left into the wrong header.
        const imageCell = `<div class="bill-line-image-cell">${product
            ? (product.image_url
                ? `<img class="bill-line-product-thumb" src="${escapeHtml(product.image_url)}" alt="">`
                : `<div class="bill-line-product-thumb bill-line-product-thumb-empty">No Img</div>`)
            : ''}</div>`;
        const itemField = productMissing
            ? `<input type="text" class="form-input" value="${escapeHtml(line.description || '')}" disabled>`
            : line.mode === 'product'
            ? `<button type="button" class="folio-dropdown-btn bill-line-product-btn" data-index="${index}" ${disabled}>
                   <span class="folio-dropdown-text">${escapeHtml(product ? product.name : 'Search product...')}</span>
                   <span class="folio-dropdown-arrow">▼</span>
               </button>`
            : `<input type="text" class="form-input bill-line-description" value="${escapeHtml(line.description || '')}" placeholder="e.g. Cotton fabric" ${disabled}>`;
        const toggleTitle = line.mode === 'product' ? 'Switch to typed description' : 'Switch to product selection';
        const toggleIcon = line.mode === 'product' ? 'fa-pen-to-square' : 'fa-list-check';
        const toggle = billModalReadOnly ? '<span></span>' :
            `<button type="button" class="bill-line-mode-toggle" data-index="${index}" title="${toggleTitle}" aria-label="${toggleTitle}"><i class="fa-solid ${toggleIcon}"></i></button>`;

        // A resolvable product with variants replaces the quantity field with a
        // per-variant grid below (one row per variant, aligned under these same
        // Qty/Cost columns) - there's no single qty or cost for the whole product
        // line anymore, so these cells are left blank rather than showing a total.
        // Still an actual (empty) grid item though, not '' - .bill-line relies on
        // DOM-order auto-placement across its column tracks, so dropping the
        // element entirely would shift Amount and the remove button left into
        // the Qty/Cost tracks instead of their own.
        const qtyCell = usesVariantGrid
            ? '<span></span>'
            : `<input type="number" class="form-input bill-line-quantity" value="${line.quantity}" min="0" step="0.001" placeholder="0" ${disabled}>`;

        const costCell = usesVariantGrid
            ? '<span></span>'
            : `<input type="number" class="form-input bill-line-cost" value="${line.unit_cost}" min="0" step="0.01" placeholder="0.00" ${disabled}>`;

        const newCost = product && landedCosts ? landedCosts.get(product.id) : null;
        const costEffect = product && newCost != null
            ? `<div class="bill-line-cost-effect" data-index="${index}">${billLineCostEffectHtml(product.cost_price, newCost, lineCounts.get(product.id) || 1)}</div>` : '';
        const extra = usesVariantGrid || costEffect
            ? `<div class="bill-line-extra">${usesVariantGrid ? billLineVariantQtyGrid(line, product, variants, disabled, variantLandedCosts, variantLineCounts) : ''}${costEffect}</div>`
            : '';

        return `
        <div class="bill-line" data-index="${index}">
            ${imageCell}
            <div class="bill-line-content">
                <div class="bill-line-main">
                    ${itemField}
                    ${toggle}
                    ${qtyCell}
                    ${costCell}
                    <span class="bill-line-amount">${formatMoney(billLineAmount(line))}</span>
                    ${billModalReadOnly ? '' : `<button type="button" class="bill-line-remove" data-index="${index}" aria-label="Remove line">&times;</button>`}
                </div>
                ${extra}
            </div>
        </div>`;
    }).join('');

    if (billModalReadOnly) { renderBillTotals(); return; }

    container.querySelectorAll('.bill-line').forEach(row => {
        const index = parseInt(row.dataset.index, 10);
        const line = billLineDrafts[index];
        const updateAmount = () => {
            row.querySelector('.bill-line-amount').textContent = formatMoney(billLineAmount(line));
            row.querySelectorAll('.bill-line-variant-row').forEach(variantRow => {
                const variantId = variantRow.dataset.variantId;
                const qty = parseFloat(line.variantQuantities?.[variantId]) || 0;
                const cost = parseFloat(line.variantCosts?.[variantId]);
                variantRow.querySelector('.bill-line-variant-amount').textContent =
                    (qty > 0 && !Number.isNaN(cost)) ? formatMoney(qty * cost) : '';
            });
            renderBillTotals();
            updateCostEffects();
        };

        row.querySelector('.bill-line-description')?.addEventListener('input', e => { line.description = e.target.value; });
        row.querySelector('.bill-line-quantity')?.addEventListener('input', e => { line.quantity = e.target.value; updateAmount(); });
        row.querySelector('.bill-line-cost')?.addEventListener('input', e => { line.unit_cost = e.target.value; updateAmount(); });
        row.querySelectorAll('.bill-line-variant-qty-input').forEach(input => {
            input.addEventListener('input', e => {
                line.variantQuantities[e.target.dataset.variantId] = e.target.value;
                updateAmount();
            });
        });
        row.querySelectorAll('.bill-line-variant-cost-input').forEach(input => {
            input.addEventListener('input', e => {
                line.variantCosts[e.target.dataset.variantId] = e.target.value;
                updateAmount();
            });
        });
        row.querySelector('.bill-line-product-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            openBillProductDropdown(e.currentTarget, line, index);
        });
        row.querySelector('.bill-line-mode-toggle')?.addEventListener('click', () => {
            line.mode = line.mode === 'product' ? 'text' : 'product';
            line.product_id = null;
            line.variant_id = null;
            line.variantQuantities = {};
            line.variantCosts = {};
            line.description = '';
            renderBillLines();
        });
    });

    container.querySelectorAll('.bill-line-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            billLineDrafts.splice(parseInt(btn.dataset.index, 10), 1);
            if (!billLineDrafts.length) billLineDrafts.push(emptyBillLine());
            renderBillLines();
            renderBillTotals();
        });
    });

    renderBillTotals();
}

function renderBillTotals() {
    const subtotal = billLineDrafts.reduce((sum, line) => sum + billLineAmount(line), 0);
    const discount = parseFloat(document.getElementById('billDiscount')?.value) || 0;
    const tax = parseFloat(document.getElementById('billTax')?.value) || 0;
    const otherExpense = parseFloat(document.getElementById('billOtherExpense')?.value) || 0;
    const subtotalEl = document.getElementById('billSubtotal');
    const totalEl = document.getElementById('billTotal');
    if (subtotalEl) subtotalEl.textContent = formatMoney(subtotal);
    if (totalEl) totalEl.textContent = formatMoney(subtotal - discount + tax + otherExpense);
}

// Groups a saved bill's flat items back into draft rows for editing: items on
// a product that currently has variants collapse into one row per product,
// with each variant's own saved unit_cost carried into variantCosts, so it
// reopens showing the same per-variant qty+cost grid it would if just
// entered. Everything else (text lines, a variant-less product, or one whose
// product was since deactivated) stays one row per item, as it always was.
function billItemsToDrafts(items) {
    const drafts = [];
    const groups = new Map();

    for (const item of items) {
        const product = item.product_id ? billLineProduct({ product_id: item.product_id }) : null;
        const hasVariants = !!(product && (product.variants || []).length);

        if (hasVariants && item.variant_id) {
            let draft = groups.get(item.product_id);
            if (!draft) {
                draft = {
                    _key: item.id, mode: 'product', description: '',
                    quantity: '', unit_cost: '',
                    product_id: item.product_id, variant_id: null,
                    variantQuantities: {}, variantCosts: {},
                };
                groups.set(item.product_id, draft);
                drafts.push(draft);
            }
            draft.variantQuantities[item.variant_id] = item.quantity;
            draft.variantCosts[item.variant_id] = item.unit_cost;
            continue;
        }

        drafts.push({
            _key: item.id,
            mode: item.product_id ? 'product' : 'text',
            description: item.description || '',
            quantity: item.quantity,
            unit_cost: item.unit_cost,
            product_id: item.product_id || null,
            variant_id: item.variant_id || null,
            variantQuantities: {},
            variantCosts: {},
        });
    }

    return drafts;
}

async function openBillModal(billId) {
    editingBillId = billId || null;
    // The Bills page already loads ledgers on nav (see navigation.js); only
    // re-fetch if the modal is somehow opened before that finished.
    if (!ledgers.length) await loadLedgersList();
    if (!products.length) await loadProducts();

    const supplierSelect = document.getElementById('billSupplier');
    supplierSelect.innerHTML = '<option value="">Select supplier...</option>' +
        partyLedgers().map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');

    let status = null;
    if (billId) {
        let bill;
        try {
            bill = await apiJson(`/bills/${billId}`, { fallback: 'Failed to load bill' });
        } catch (error) {
            console.error('Error loading bill:', error);
            showToast('Failed to load bill', 'error');
            return;
        }
        status = bill.status;
        billModalReadOnly = status !== 'draft';
        document.getElementById('billModalTitle').textContent =
            `${billModalReadOnly ? 'View' : 'Edit'} ${bill.bill_number}`;
        supplierSelect.value = bill.supplier_id;
        document.getElementById('billSupplierRef').value = bill.supplier_ref || '';
        document.getElementById('billDate').value = bill.bill_date;
        document.getElementById('billDiscount').value = bill.discount_amount || 0;
        document.getElementById('billTax').value = bill.tax_amount || 0;
        document.getElementById('billOtherExpense').value = bill.other_expense_amount || 0;
        document.getElementById('billNotes').value = bill.notes || '';
        billLineDrafts = billItemsToDrafts(bill.items || []);
    } else {
        billModalReadOnly = false;
        document.getElementById('billModalTitle').textContent = 'New Bill';
        document.getElementById('billForm').reset();
        document.getElementById('billDate').value = getTodayDateString();
        document.getElementById('billDiscount').value = 0;
        document.getElementById('billTax').value = 0;
        document.getElementById('billOtherExpense').value = 0;
        billLineDrafts = [emptyBillLine()];
    }
    if (!billLineDrafts.length) billLineDrafts = [emptyBillLine()];

    applyBillModalFooter(status);
    renderBillLines();
    document.getElementById('billModal').classList.add('active');
}

// Buttons shown depend on where the bill is in the draft -> received ->
// cancelled workflow; a new/draft bill is the only editable state.
function applyBillModalFooter(status) {
    const readOnly = billModalReadOnly;
    ['billSupplier', 'billSupplierRef', 'billDate', 'billDiscount', 'billTax', 'billOtherExpense', 'billNotes'].forEach(id => {
        document.getElementById(id).disabled = readOnly;
    });
    const addLineBtn = document.getElementById('addBillLineBtn');
    if (addLineBtn) addLineBtn.style.display = readOnly ? 'none' : '';
    const saveBtn = document.getElementById('billSaveBtn');
    if (saveBtn) saveBtn.style.display = readOnly ? 'none' : '';
    const confirmBtn = document.getElementById('billConfirmBtn');
    if (confirmBtn) confirmBtn.style.display = status === 'draft' ? '' : 'none';
    const revertBtn = document.getElementById('billRevertBtn');
    if (revertBtn) revertBtn.style.display = status === 'received' ? '' : 'none';
    const cancelBtn = document.getElementById('billCancelBtn');
    if (cancelBtn) cancelBtn.textContent = readOnly ? 'Close' : 'Cancel';
}

function closeBillModal() {
    if (closeOpenBillProductDropdown) closeOpenBillProductDropdown();
    document.getElementById('billModal').classList.remove('active');
    editingBillId = null;
    billLineDrafts = [];
    billModalReadOnly = false;
}

function collectBillPayload() {
    const supplierId = document.getElementById('billSupplier').value;
    const billDate = document.getElementById('billDate').value;
    if (!supplierId) { showToast('Select a supplier', 'error'); return null; }
    if (!billDate) { showToast('Enter a bill date', 'error'); return null; }

    // A blank trailing row is normal (the form always keeps one), so drop empties
    // rather than failing on them — but a row with only some fields filled is a
    // mistake worth surfacing.
    const filled = billLineDrafts.filter(l => l.quantity !== '' || l.unit_cost !== '' || l.description || l.product_id);
    const items = [];
    for (const line of filled) {
        // A resolvable product with variants expands into one item per variant
        // that was given a quantity above 0 - the rest (left at their default 0)
        // are simply not purchased on this bill - each at its own cost rather
        // than one cost for the whole line.
        if (billLineUsesVariantGrid(line)) {
            const product = billLineProduct(line);
            const picked = (product.variants || [])
                .map(v => ({
                    variant: v,
                    qty: parseFloat(line.variantQuantities[v.id]) || 0,
                    cost: parseFloat(line.variantCosts?.[v.id]),
                }))
                .filter(({ qty }) => qty > 0);
            if (!picked.length) {
                showToast(`Enter a quantity for at least one variant of ${product.name}`, 'error');
                return null;
            }
            if (picked.some(({ cost }) => Number.isNaN(cost) || cost < 0)) {
                showToast(`Enter a cost for every variant with a quantity on ${product.name}`, 'error');
                return null;
            }
            for (const { variant, qty, cost } of picked) {
                items.push({
                    description: billLineVariantDescription(product, variant),
                    quantity: qty,
                    unit_cost: cost,
                    product_id: product.id,
                    variant_id: variant.id,
                });
            }
            continue;
        }

        const cost = parseFloat(line.unit_cost);
        if (Number.isNaN(cost) || cost < 0) {
            showToast('Every line needs a unit cost', 'error');
            return null;
        }

        const qty = parseFloat(line.quantity);
        if (Number.isNaN(qty) || qty <= 0) {
            showToast('Every line needs a quantity above 0', 'error');
            return null;
        }

        let productId = null, variantId = null, description = line.description || null;
        if (line.mode === 'product') {
            const product = billLineProduct(line);
            if (product) {
                // Resolvable, but has no variants to offer a grid for.
                productId = product.id;
                description = billLineVariantDescription(product, null);
            } else if (line.product_id) {
                // References a product deactivated since the line was set — keep
                // the existing reference and its already-stored label untouched.
                productId = line.product_id;
                variantId = line.variant_id || null;
            } else {
                showToast('Select a product for every product line', 'error');
                return null;
            }
        }

        items.push({ description, quantity: qty, unit_cost: cost, product_id: productId, variant_id: variantId });
    }
    if (!items.length) { showToast('Add at least one line', 'error'); return null; }

    return {
        supplier_id: supplierId,
        bill_date: billDate,
        supplier_ref: document.getElementById('billSupplierRef').value.trim() || null,
        discount_amount: parseFloat(document.getElementById('billDiscount').value) || 0,
        tax_amount: parseFloat(document.getElementById('billTax').value) || 0,
        other_expense_amount: parseFloat(document.getElementById('billOtherExpense').value) || 0,
        notes: document.getElementById('billNotes').value.trim() || null,
        items,
    };
}

// Shared by the Save button and Confirm Bill (which must persist edits before
// posting them — otherwise a half-typed change would be silently dropped).
// The cost-price preview shown while editing (see updateCostEffects) is purely
// informational — it's only actually applied to the product when the bill is
// confirmed (receive_bill lands it, unreceive_bill restores the prior price).
async function persistBillPayload(payload) {
    try {
        if (editingBillId) {
            await apiJson(`/bills/${editingBillId}`, { method: 'PUT', body: payload, fallback: 'Failed to update bill' });
        } else {
            await apiJson('/bills/', { method: 'POST', body: payload, fallback: 'Failed to create bill' });
        }
        return true;
    } catch (error) {
        console.error('Error saving bill:', error);
        showToast(error.message || 'Failed to save bill', 'error');
        return false;
    }
}

async function saveBill() {
    const payload = collectBillPayload();
    if (!payload) return;
    const wasNew = !editingBillId;
    if (!(await persistBillPayload(payload))) return;
    showToast(wasNew ? 'Draft bill created' : 'Bill updated', 'success');
    closeBillModal();
    await loadBills();
}

// --- Bill actions ------------------------------------------------------------

async function billAction(billId, action, { confirm } = {}) {
    if (confirm) {
        const ok = await showAppConfirm(confirm);
        if (!ok) return false;
    }
    try {
        await apiJson(`/bills/${billId}/${action}`, { method: 'POST', fallback: `Failed to ${action} bill` });
        await loadBills();
        // receive/unreceive (and cancel, which unreceives first) land or
        // restore product cost_price server-side - refresh the local cache.
        await loadProducts();
        return true;
    } catch (error) {
        console.error(`Error on bill ${action}:`, error);
        showToast(error.message || `Failed to ${action} bill`, 'error');
        return false;
    }
}

function receiveBill(billId) {
    return billAction(billId, 'receive', {
        title: 'Confirm Bill',
        message: 'This posts the bill to the accounts and adds its stock. Continue?',
        confirmText: 'Confirm',
    });
}

function unreceiveBill(billId) {
    return billAction(billId, 'unreceive', {
        title: 'Revert to Draft',
        message: 'This unposts the bill and removes the stock it added. Continue?',
        confirmText: 'Revert to draft',
    });
}

function cancelBill(billId) {
    return billAction(billId, 'cancel', {
        title: 'Cancel Bill',
        message: 'Cancel this bill? A received bill is unposted first.',
        confirmText: 'Cancel bill',
        danger: true,
    });
}

async function deleteBill(billId) {
    const ok = await showAppConfirm({
        title: 'Delete Draft',
        message: 'Delete this draft bill? This cannot be undone.',
        confirmText: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        await apiRequest(`/bills/${billId}`, { method: 'DELETE', fallback: 'Failed to delete bill' });
        showToast('Draft deleted', 'success');
        await loadBills();
    } catch (error) {
        console.error('Error deleting bill:', error);
        showToast(error.message || 'Failed to delete bill', 'error');
    }
}

// --- Grids -------------------------------------------------------------------

function createBillViewButton(params) {
    const bill = params.data;
    const wrapper = document.createElement('div');
    wrapper.className = 'bill-cell-center';
    if (!bill || !bill.id) return wrapper;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bill-view-btn';
    btn.innerHTML = '<i class="fa-solid fa-eye"></i><span>View Bill</span>';
    btn.title = 'View bill';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openBillModal(bill.id);
    });

    wrapper.appendChild(btn);
    return wrapper;
}

// Row actions menu (triple dot), mirroring createTransactionRowMenu in
// orders-grid.js: a menu scales to more actions without another column reshuffle.
function createBillRowMenu(params) {
    const bill = params.data;
    const wrapper = document.createElement('div');
    wrapper.className = 'bill-cell-center';
    if (!bill || !bill.id) return wrapper;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bill-menu-btn';
    btn.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    btn.title = 'More actions';

    let menu = null;

    function closeMenu() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
        btn.classList.remove('open');
    }

    function addOption({ label, icon, danger, onClick }) {
        const option = document.createElement('div');
        option.className = 'folio-dropdown-option' + (danger ? ' bill-menu-option-danger' : '');
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
        menu.className = 'folio-dropdown-panel bill-menu-panel';

        if (bill.status === 'draft') {
            addOption({ label: 'Confirm Bill', icon: 'fa-check', onClick: () => receiveBill(bill.id) });
            addOption({ label: 'Delete', icon: 'fa-trash', danger: true, onClick: () => deleteBill(bill.id) });
        } else if (bill.status === 'received') {
            // Revert to draft stays available even once partly settled: the
            // supplier's balance moves with the bill, so nothing is left dangling.
            addOption({ label: 'Revert to Draft', icon: 'fa-rotate-left', onClick: () => unreceiveBill(bill.id) });
            addOption({ label: 'Cancel', icon: 'fa-ban', danger: true, onClick: () => cancelBill(bill.id) });
        }

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

function initBillsGrid() {
    const gridDiv = document.getElementById('billsGrid');
    if (!gridDiv) return;

    const columnDefs = [
        { headerName: 'Bill #', field: 'bill_number', flex: 12, minWidth: 110 },
        {
            headerName: 'Supplier',
            field: 'supplier_id',
            flex: 25,
            minWidth: 160,
            valueGetter: (params) => ledgerName(params.data?.supplier_id),
            cellRenderer: supplierCellRenderer,
        },
        { headerName: 'Supplier ref', field: 'supplier_ref', flex: 12, minWidth: 120 },
        {
            headerName: 'Date',
            field: 'bill_date',
            flex: 10,
            minWidth: 100,
            valueFormatter: (params) => (params.value ? formatDateDDMMYYYY(params.value) : ''),
        },
        {
            headerName: 'Total (Rs)',
            field: 'total',
            flex: 11,
            minWidth: 110,
            type: 'rightAligned',
            cellClass: 'bill-amount-cell',
            valueFormatter: (params) => formatMoney(params.value),
        },
        {
            headerName: 'Outstanding (Rs)',
            field: 'outstanding',
            flex: 12,
            minWidth: 130,
            type: 'rightAligned',
            cellClass: 'bill-amount-cell',
            valueFormatter: (params) => formatMoney(params.value),
        },
        {
            headerName: 'Status',
            field: 'payment_status',
            flex: 11,
            minWidth: 110,
            valueFormatter: (params) => BILL_STATUS_LABELS[params.value] || params.value || '',
            cellClass: (params) => `bill-status bill-status-${params.value || ''}`,
        },
        {
            headerName: '',
            colId: 'view',
            flex: 8,
            width: 92,
            minWidth: 92,
            sortable: false,
            filter: false,
            cellRenderer: createBillViewButton,
        },
        {
            headerName: '',
            colId: 'actions',
            flex: 3,
            width: 40,
            minWidth: 40,
            sortable: false,
            filter: false,
            cellRenderer: createBillRowMenu,
        },
    ];

    agGrid.createGrid(gridDiv, {
        columnDefs,
        rowData: [],
        defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: false, minWidth: 90 },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.id,
        onGridReady: (params) => { billsGridApi = params.api; },
    });
}

async function loadApAgeing() {
    if (!apAgeingAsOf) apAgeingAsOf = getTodayDateString();
    const input = document.getElementById('apAgeingAsOf');
    if (input) input.value = apAgeingAsOf;

    if (apAgeingGridApi) apAgeingGridApi.showLoadingOverlay();
    let rows;
    try {
        rows = await apiJson(`/bills/ap-ageing?as_of=${apAgeingAsOf}`, { fallback: 'Failed to load outstanding payables' });
    } catch (error) {
        console.error('Error loading outstanding payables:', error);
        showToast('Failed to load outstanding payables', 'error');
        if (apAgeingGridApi) apAgeingGridApi.hideOverlay();
        return;
    }

    const total = rows.reduce((sum, r) => sum + (parseFloat(r.outstanding) || 0), 0);
    const totalEl = document.getElementById('apAgeingTotal');
    if (totalEl) {
        totalEl.className = 'trial-balance-status';
        totalEl.textContent = `Rs ${formatMoney(total)} payable`;
    }
    if (apAgeingGridApi) {
        apAgeingGridApi.setGridOption('rowData', rows);
        apAgeingGridApi.hideOverlay();
    }
}

function initApAgeingGrid() {
    const gridDiv = document.getElementById('apAgeingGrid');
    if (!gridDiv) return;

    const money = (params) => (params.value ? formatMoney(params.value) : '');
    const columnDefs = [
        { headerName: 'Supplier', field: 'supplier_name', flex: 1, minWidth: 180 },
        { headerName: 'Current', field: 'current', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '1–30 days', field: 'd1_30', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '31–60 days', field: 'd31_60', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '61–90 days', field: 'd61_90', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: '90+ days', field: 'd90_plus', width: 130, type: 'rightAligned', valueFormatter: money },
        { headerName: 'Total (Rs)', field: 'outstanding', width: 150, type: 'rightAligned', valueFormatter: money },
    ];

    agGrid.createGrid(gridDiv, {
        columnDefs,
        rowData: [],
        defaultColDef: { sortable: true, resizable: true, filter: true, minWidth: 90 },
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.supplier_id,
        onGridReady: (params) => { apAgeingGridApi = params.api; },
    });
}

function initBills() {
    initBillsGrid();
    initApAgeingGrid();

    document.getElementById('createBillBtn')?.addEventListener('click', () => openBillModal());
    document.getElementById('billsStatusFilter')?.addEventListener('change', loadBills);
    document.getElementById('closeBillModal')?.addEventListener('click', closeBillModal);
    document.getElementById('billCancelBtn')?.addEventListener('click', closeBillModal);
    document.getElementById('addBillLineBtn')?.addEventListener('click', () => {
        billLineDrafts.push(emptyBillLine());
        renderBillLines();
    });
    const onTotalsInputChanged = () => { renderBillTotals(); updateCostEffects(); };
    document.getElementById('billDiscount')?.addEventListener('input', onTotalsInputChanged);
    document.getElementById('billTax')?.addEventListener('input', onTotalsInputChanged);
    document.getElementById('billOtherExpense')?.addEventListener('input', onTotalsInputChanged);
    document.getElementById('billForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!isEditingAllowed()) { showToast('Editing is locked', 'error'); return; }
        saveBill();
    });
    document.getElementById('billConfirmBtn')?.addEventListener('click', async () => {
        if (!editingBillId) return;
        const payload = collectBillPayload();
        if (!payload) return;
        if (!(await persistBillPayload(payload))) return;
        if (await receiveBill(editingBillId)) closeBillModal();
    });
    document.getElementById('billRevertBtn')?.addEventListener('click', async () => {
        if (editingBillId && await unreceiveBill(editingBillId)) closeBillModal();
    });

    document.getElementById('apAgeingAsOf')?.addEventListener('change', (e) => {
        apAgeingAsOf = e.target.value || getTodayDateString();
        loadApAgeing();
    });
}
