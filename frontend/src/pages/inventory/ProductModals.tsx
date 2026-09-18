// Product details / adjust stock / cost history / edit variant costs / bulk cost
// price modals. Ported from inventory.js + modals-forms.js.
import { useEffect, useState } from 'react';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { formatAmount, formatDateTimeDDMMYYYY } from '../../logic/shared';
import { Dropdown } from '../../components/Dropdown';
import {
  productStockStatus, productStockValue, productUnitCost, sortVariantsBySize, STOCK_STATUS_LABELS, type Product,
} from '../../logic/products';

function productThumb(product: Product | null | undefined) {
  return product?.image_url
    ? <img src={product.image_url} alt="" />
    : <div className="grid-image-placeholder">No Img</div>;
}

function productSubtitle(product: Product | null | undefined) {
  const collection = product?.collection || '—';
  const count = (product?.variants || []).length;
  return `Collection: ${collection} • ${count} variant${count === 1 ? '' : 's'}`;
}

function ProductIdentity({ product, withStatus = true }: { product: Product | null | undefined; withStatus?: boolean }) {
  const status = product ? productStockStatus(product) : null;
  return (
    <div className="product-details-identity">
      <div className="product-details-thumb">{productThumb(product)}</div>
      <div className="product-details-identity-text">
        <div className="product-details-name-row">
          <h3>{product?.name || ''}</h3>
          {withStatus && status && <span className={`grid-status-badge ${status}`}>{STOCK_STATUS_LABELS[status]}</span>}
        </div>
        <p className="product-details-sub">{productSubtitle(product)}</p>
      </div>
    </div>
  );
}

function StockGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="product-details-stock-grid">
      {rows.map(([label, value]) => (
        <div className="product-details-stock-cell" key={label}>
          <span className="product-details-stock-label">{label}</span>
          <span className="product-details-stock-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function ProductDetailsModal({
  product, onClose, onUpdateCost, onAdjustStock, onHistory,
}: {
  product: Product | null;
  onClose: () => void;
  onUpdateCost: (p: Product) => void;
  onAdjustStock: (p: Product) => void;
  onHistory: (p: Product) => void;
}) {
  if (!product) return null;
  const unitCost = productUnitCost(product);
  const summary: Array<[string, string]> = [
    ['Total Stock', (product.total_quantity || 0).toLocaleString('en-US')],
    ['Cost per Unit', unitCost != null ? `PKR ${formatAmount(unitCost)}` : 'Mixed'],
    ['Value', `PKR ${formatAmount(productStockValue(product))}`],
  ];
  const sizes: Array<[string, string]> = sortVariantsBySize(product.variants || []).map((v) => [v.title || '', String(v.quantity || 0)]);
  const meta: Array<[string, string]> = [
    ['Selling Price', `PKR ${formatAmount(product.price)}`],
    ['Collection', product.collection || '—'],
    ['Created At', formatDateTimeDDMMYYYY(product.created_at) || '—'],
    ['Last Updated', formatDateTimeDDMMYYYY(product.updated_at) || '—'],
  ];

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content product-details-modal-content">
        <div className="modal-header">
          <h2>Product Details</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <ProductIdentity product={product} />
          <div className="product-details-stock">
            <StockGrid rows={summary} />
            {sizes.length > 0 && <StockGrid rows={sizes} />}
          </div>
          <dl className="product-details-meta">
            {meta.map(([k, v]) => (
              <div className="product-details-meta-row" key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </div>
        <div className="modal-pinned-footer product-details-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-secondary" onClick={() => onUpdateCost(product)}><i className="fa-solid fa-tag" /> Update Cost</button>
          <button type="button" className="btn btn-secondary" onClick={() => onAdjustStock(product)}><i className="fa-solid fa-boxes-stacked" /> Adjust Stock</button>
          <button type="button" className="btn btn-primary" onClick={() => onHistory(product)}><i className="fa-solid fa-clock-rotate-left" /> View History</button>
        </div>
      </div>
    </div>
  );
}

export function AdjustStockModal({
  product, onClose, onDone,
}: {
  product: Product | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const [type, setType] = useState<'add' | 'remove'>('add');
  const [qtyByVariant, setQtyByVariant] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const variants = sortVariantsBySize(product?.variants || []);

  useEffect(() => {
    setType('add');
    setQtyByVariant({});
    setReason('');
    setNotes('');
  }, [product]);

  if (!product) return null;
  if (variants.length === 0) {
    // Guarded at the open() call site too - this only shows if that check is bypassed.
    return null;
  }

  async function submit() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    if (!reason) { showToast('Select a reason for this adjustment', 'error', { silent: true }); return; }
    const sign = type === 'remove' ? -1 : 1;
    const adjustments: Array<{ variant_id: string; delta: number }> = [];
    for (const v of variants) {
      const raw = (qtyByVariant[v.id] || '').trim();
      if (raw === '') continue;
      const qty = parseInt(raw, 10);
      if (isNaN(qty) || qty < 0) { showToast('Enter a whole quantity of 0 or more', 'error', { silent: true }); return; }
      if (qty === 0) continue;
      if (sign < 0 && qty > (v.quantity || 0)) { showToast(`Cannot remove more than the ${v.quantity || 0} in stock`, 'error', { silent: true }); return; }
      adjustments.push({ variant_id: v.id, delta: sign * qty });
    }
    if (!adjustments.length) { showToast('Enter a quantity for at least one size', 'error', { silent: true }); return; }

    setSaving(true);
    try {
      await apiJson(`/products/${product!.id}/adjust-stock`, {
        method: 'POST', body: { adjustments, reason, notes: notes.trim() || null }, fallback: 'Failed to adjust stock',
      });
      showToast('Stock updated', 'success');
      onDone();
    } catch (error: any) {
      showToast(error?.message || 'Failed to adjust stock', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Adjust Stock</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <ProductIdentity product={product} />
          <div className="form-group">
            <label>Adjustment type</label>
            <div className="adjust-stock-type">
              <label className="adjust-stock-radio"><input type="radio" name="adjustStockType" checked={type === 'add'} onChange={() => setType('add')} /><span>Add Stock</span></label>
              <label className="adjust-stock-radio"><input type="radio" name="adjustStockType" checked={type === 'remove'} onChange={() => setType('remove')} /><span>Remove Stock</span></label>
            </div>
          </div>
          <div className="adjust-stock-variants">
            {variants.map((v) => (
              <div className="adjust-stock-row" key={v.id}>
                <span className="adjust-stock-row-title">{v.title}<span className="adjust-stock-row-current">in stock: {v.quantity || 0}</span></span>
                <input
                  type="number" className="form-input adjust-stock-input" min={0} step={1} placeholder="0"
                  value={qtyByVariant[v.id] || ''}
                  onChange={(e) => setQtyByVariant((prev) => ({ ...prev, [v.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="adjust-stock-meta">
            <div className="form-group">
              <label htmlFor="adjustStockReason">Reason *</label>
              <select id="adjustStockReason" className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Select reason</option>
                <option value="Stock Count Correction">Stock Count Correction</option>
                <option value="Damaged / Written Off">Damaged / Written Off</option>
                <option value="Returned to Supplier">Returned to Supplier</option>
                <option value="Customer Return">Customer Return</option>
                <option value="Transfer">Transfer</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="adjustStockNotes">Notes (optional)</label>
              <textarea id="adjustStockNotes" className="form-input adjust-stock-notes" rows={3} placeholder="Add a note..." value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? 'Updating...' : 'Update Stock'}</button>
        </div>
      </div>
    </div>
  );
}

interface CostHistoryRow {
  created_at?: string;
  variant_title?: string;
  new_cost_price?: number | null;
  changed_by_name?: string;
  reason?: string;
}

export function CostHistoryModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const [rows, setRows] = useState<CostHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!product) return;
    setRows(null);
    setError(null);
    apiJson<CostHistoryRow[]>(`/products/${product.id}/cost-history`, { fallback: 'Failed to load cost history' })
      .then(setRows)
      .catch((e: any) => setError(e?.message || 'Failed to load cost history'));
  }, [product]);

  if (!product) return null;

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content cost-history-modal-content">
        <div className="modal-header">
          <h2>Cost History</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <ProductIdentity product={product} withStatus={false} />
          <div className="cost-history-table-wrap">
            <table className="cost-history-table">
              <thead><tr><th>Date</th><th>Variant</th><th>Cost per Unit</th><th>Changed By</th><th>Reason</th></tr></thead>
              <tbody>
                {error ? (
                  <tr><td colSpan={5} className="cost-history-empty">{error}</td></tr>
                ) : rows == null ? (
                  <tr><td colSpan={5} className="cost-history-empty">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={5} className="cost-history-empty">No cost changes recorded yet. Costs set by receiving a purchase bill are audited on that bill.</td></tr>
                ) : rows.map((r, i) => (
                  <tr key={i}>
                    <td>{formatDateTimeDDMMYYYY(r.created_at)}</td>
                    <td>{r.variant_title || 'All variants'}</td>
                    <td>{r.new_cost_price == null ? '—' : `PKR ${formatAmount(r.new_cost_price)}`}</td>
                    <td>{r.changed_by_name || 'System'}</td>
                    <td>{r.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

const COST_REASONS = ['Price Update', 'Supplier Change', 'Correction', 'Initial Cost'];

export function EditVariantCostsModal({
  product, onClose, onDone,
}: {
  product: Product | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const variants = sortVariantsBySize(product?.variants || []);
  const multiVariant = variants.length > 1;
  const rows = variants.length
    ? variants.map((v) => ({ kind: 'variant' as const, id: v.id, title: v.title || '', qty: v.quantity ?? null, cost: v.cost_price ?? product?.cost_price ?? null }))
    : product ? [{ kind: 'product' as const, id: product.id, title: product.name || '', qty: null as number | null, cost: product.cost_price ?? null }] : [];

  const [perVariant, setPerVariant] = useState(false);
  const [sharedCost, setSharedCost] = useState('');
  const [rowCosts, setRowCosts] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [reason, setReason] = useState('');
  const [recalcAfter, setRecalcAfter] = useState('');
  const [saving, setSaving] = useState<'save' | 'recalc' | null>(null);

  useEffect(() => {
    if (!product) return;
    setPerVariant(false);
    const shared = rows.length && rows.every((r) => r.cost === rows[0].cost) ? rows[0].cost : null;
    setSharedCost(shared != null ? String(shared) : '');
    setRowCosts(Object.fromEntries(rows.map((r) => [r.id, r.cost != null ? String(r.cost) : ''])));
    setEffectiveFrom(new Date().toISOString().slice(0, 10));
    setReason('');
    setRecalcAfter('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product]);

  if (!product) return null;

  const currentCost = productUnitCost(product);
  const sharedMode = multiVariant && !perVariant;

  /** Validates and persists the costs above; returns false (with a toast) if invalid. */
  async function saveCosts(): Promise<boolean> {
    const audit = { reason: reason || null, effective_from: effectiveFrom || null };
    if (!multiVariant || sharedMode) {
      const raw = sharedCost.trim();
      const cost = raw === '' ? null : parseFloat(raw);
      if (raw !== '' && (isNaN(cost as number) || (cost as number) < 0)) {
        showToast('Enter a valid cost price (0 or more)', 'error', { silent: true });
        return false;
      }
      const ids = rows.map((r) => r.id);
      if (ids.length) {
        await apiJson('/products/batch-update-variant-cost-prices', {
          method: 'PUT', body: { updates: ids.map((id) => ({ id, cost_price: cost })), ...audit }, fallback: 'Failed to update variant costs',
        });
      }
      return true;
    }

    const variantUpdates: Array<{ id: string; cost_price: number | null }> = [];
    const productUpdates: Array<{ id: string; cost_price: number | null }> = [];
    for (const r of rows) {
      const raw = (rowCosts[r.id] || '').trim();
      const cost = raw === '' ? null : parseFloat(raw);
      if (raw !== '' && (isNaN(cost as number) || (cost as number) < 0)) {
        showToast('Enter a valid cost (0 or more) for every row', 'error', { silent: true });
        return false;
      }
      (r.kind === 'product' ? productUpdates : variantUpdates).push({ id: r.id, cost_price: cost });
    }
    if (!variantUpdates.length && !productUpdates.length) return true;
    if (variantUpdates.length) {
      await apiJson('/products/batch-update-variant-cost-prices', { method: 'PUT', body: { updates: variantUpdates, ...audit }, fallback: 'Failed to update variant costs' });
    }
    if (productUpdates.length) {
      await apiJson('/products/batch-update-cost-prices', { method: 'PUT', body: { updates: productUpdates, ...audit }, fallback: 'Failed to update cost price' });
    }
    return true;
  }

  async function submitSave() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    setSaving('save');
    try {
      if (!(await saveCosts())) return;
      showToast('Cost price updated', 'success');
      onDone();
    } catch (error: any) {
      showToast(error?.message || 'Failed to update cost price', 'error');
    } finally {
      setSaving(null);
    }
  }

  async function submitSaveAndRecalc() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    if (!recalcAfter) { showToast('Select date and time', 'error', { silent: true }); return; }
    const d = new Date(recalcAfter);
    if (isNaN(d.getTime())) { showToast('Invalid date and time', 'error', { silent: true }); return; }
    setSaving('recalc');
    try {
      if (!(await saveCosts())) return;
      const result = await apiJson<{ updated?: number; scanned?: number }>('/products/recalculate-order-costs', {
        method: 'POST', body: { product_id: product!.id, created_after: d.toISOString() }, fallback: 'Failed to recalculate',
      });
      showToast(`Saved. Updated ${result.updated ?? 0} order(s) (${result.scanned ?? 0} checked)`, 'success');
      onDone();
    } catch (error: any) {
      showToast(error?.message || 'Recalculation failed', 'error');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Update Cost — {product.name}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-description">Blank falls back to the product's own cost price.</p>
          {multiVariant && (
            <label className="ledger-form-toggle">
              <input type="checkbox" checked={perVariant} onChange={(e) => setPerVariant(e.target.checked)} />
              <span>Set cost price separately for each variant</span>
            </label>
          )}
          <div className="edit-variant-costs-current">
            <span className="edit-variant-costs-current-label">Current cost per unit</span>
            <span className="edit-variant-costs-current-value">{currentCost != null ? `PKR ${formatAmount(currentCost)}` : (variants.length ? 'Mixed across variants' : '—')}</span>
          </div>
          {sharedMode ? (
            <div className="form-group">
              <label htmlFor="editVariantCostsSharedInput">New cost per unit (Rs)</label>
              <input type="number" id="editVariantCostsSharedInput" className="form-input" min={0} step={0.01} placeholder="0.00" value={sharedCost} onChange={(e) => setSharedCost(e.target.value)} />
            </div>
          ) : (
            <div className="edit-variant-costs-list">
              {rows.map((r) => (
                <div className="edit-variant-costs-row" key={r.id}>
                  <span className="edit-variant-costs-title">{r.title}{r.qty != null && <span className="edit-variant-costs-qty"> (qty: {r.qty})</span>}</span>
                  <input
                    type="number" className="edit-variant-costs-input" min={0} step={0.01} placeholder="0.00"
                    value={rowCosts[r.id] || ''} onChange={(e) => setRowCosts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="edit-variant-costs-meta">
            <div className="form-group">
              <label htmlFor="editVariantCostsEffectiveFrom">Applicable from</label>
              <input type="date" id="editVariantCostsEffectiveFrom" className="form-input" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="editVariantCostsReason">Reason (optional)</label>
              <Dropdown id="editVariantCostsReason" fullWidth placeholder="Select reason" options={COST_REASONS} value={reason} onChange={setReason} />
            </div>
          </div>
          <div className="edit-variant-costs-recalc">
            <h3>Recalculate order costs</h3>
            <p className="modal-description">Refresh order cost totals from the costs above. Only orders on or after the date below that include this product are updated.</p>
            <div className="form-group">
              <label htmlFor="editVariantCostsRecalcCreatedAfter">Update orders created on or after *</label>
              <input type="datetime-local" id="editVariantCostsRecalcCreatedAfter" className="form-input" required value={recalcAfter} onChange={(e) => setRecalcAfter(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!!saving} onClick={submitSave}>{saving === 'save' ? 'Saving...' : 'Save'}</button>
          <button type="button" className="btn btn-secondary" disabled={!!saving || !recalcAfter} onClick={submitSaveAndRecalc}>
            {saving === 'recalc' ? 'Saving...' : 'Save and recalculate orders'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BulkUpdateCostPriceModal({
  productIds, onClose, onDone,
}: {
  productIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const [cost, setCost] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [recalcAfter, setRecalcAfter] = useState('');
  const [saving, setSaving] = useState<'save' | 'recalc' | null>(null);

  if (productIds.length === 0) return null;

  async function save(): Promise<boolean> {
    const raw = cost.trim();
    const value = raw === '' ? NaN : parseFloat(raw);
    if (isNaN(value) || value < 0) {
      showToast('Enter a valid cost price (0 or more)', 'error', { silent: true });
      return false;
    }
    await apiJson('/products/bulk-update-cost-price', {
      method: 'PUT', body: { product_ids: productIds, cost_price: value, reason: reason || null, effective_from: effectiveFrom || null },
      fallback: 'Failed to update cost prices',
    });
    return true;
  }

  async function submitSave() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    setSaving('save');
    try {
      if (!(await save())) return;
      showToast(`Updated ${productIds.length} product(s)`, 'success');
      onDone();
    } catch (error: any) {
      showToast(error?.message || 'Bulk update failed', 'error');
    } finally {
      setSaving(null);
    }
  }

  async function submitSaveAndRecalc() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    if (!recalcAfter) { showToast('Select date and time', 'error', { silent: true }); return; }
    const d = new Date(recalcAfter);
    if (isNaN(d.getTime())) { showToast('Invalid date and time', 'error', { silent: true }); return; }
    setSaving('recalc');
    try {
      if (!(await save())) return;
      const result = await apiJson<{ updated?: number; scanned?: number }>('/products/recalculate-order-costs', {
        method: 'POST', body: { product_ids: productIds, created_after: d.toISOString() }, fallback: 'Failed to recalculate',
      });
      showToast(`Saved. Updated ${result.updated ?? 0} order(s) (${result.scanned ?? 0} checked)`, 'success');
      onDone();
    } catch (error: any) {
      showToast(error?.message || 'Recalculation failed', 'error');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Bulk update cost price</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-description">Set the cost price (Rs) for {productIds.length === 1 ? '1 product' : `${productIds.length} products`}. This also applies to every variant of each selected product.</p>
          <div className="form-group" style={{ marginTop: 16 }}>
            <label htmlFor="bulkUpdateCostPriceValue">Cost price (Rs) *</label>
            <input type="number" id="bulkUpdateCostPriceValue" className="form-input" min={0} step={0.01} placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} autoFocus />
          </div>
          <div className="edit-variant-costs-meta">
            <div className="form-group">
              <label htmlFor="bulkUpdateCostPriceEffectiveFrom">Applicable from</label>
              <input type="date" id="bulkUpdateCostPriceEffectiveFrom" className="form-input" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="bulkUpdateCostPriceReason">Reason (optional)</label>
              <Dropdown id="bulkUpdateCostPriceReason" fullWidth placeholder="Select reason" options={COST_REASONS} value={reason} onChange={setReason} />
            </div>
          </div>
          <div className="edit-variant-costs-recalc">
            <h3>Recalculate order costs</h3>
            <p className="modal-description">Refresh order cost totals from the new costs. Only orders on or after the date below that include one of the selected products are updated.</p>
            <div className="form-group">
              <label htmlFor="bulkUpdateCostPriceRecalcCreatedAfter">Update orders created on or after *</label>
              <input type="datetime-local" id="bulkUpdateCostPriceRecalcCreatedAfter" className="form-input" value={recalcAfter} onChange={(e) => setRecalcAfter(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="bulk-update-actions modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!!saving} onClick={submitSave}>{saving === 'save' ? 'Updating...' : 'Confirm'}</button>
          <button type="button" className="btn btn-secondary" disabled={!!saving || !recalcAfter} onClick={submitSaveAndRecalc}>
            {saving === 'recalc' ? 'Saving...' : 'Save and recalculate orders'}
          </button>
        </div>
      </div>
    </div>
  );
}
