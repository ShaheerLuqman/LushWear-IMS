// Create/edit/view a purchase bill - line editor with per-variant qty/cost grids
// and a landed-cost preview. Ported from bills.js's openBillModal/renderBillLines/
// collectBillPayload.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { formatMoney, type Ledger } from '../../logic/ledgers';
import { sortVariantsBySize, type Product } from '../../logic/products';
import { getPKTDateString } from '../../logic/shared';
import {
  billItemsToDrafts, billLineAmount, billLineCostEffect, billLineProduct,
  billLineUsesVariantGrid, billLineVariantDescription, billProductLandedCosts,
  billProductLineCounts, billVariantLandedCosts, billVariantLineCounts, emptyBillLine, partyLedgers, type BillLineDraft,
} from '../../logic/bills';

function CostEffectLabel({ current, newCost, diff, label }: { current: number; newCost: number; diff: number; label: string }) {
  const changeClass = diff > 0 ? 'bill-line-cost-effect-up' : diff < 0 ? 'bill-line-cost-effect-down' : '';
  return (
    <>
      {label}: Rs {formatMoney(current)} → Rs {formatMoney(newCost)}
      {diff !== 0 && <span className={changeClass}> ({diff > 0 ? '+' : ''}{formatMoney(diff)})</span>}
    </>
  );
}

function ProductPicker({
  products, line, disabled, onPick,
}: {
  products: Product[];
  line: BillLineDraft;
  disabled: boolean;
  onPick: (product: Product) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0, minWidth: 220 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const product = products.find((p) => p.id === line.product_id) || null;

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.folio-dropdown-panel') && target !== btnRef.current) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const matches = query.trim() ? products.filter((p) => (p.name || '').toLowerCase().includes(query.trim().toLowerCase())) : products;

  return (
    <>
      <button
        ref={btnRef} type="button" className={'folio-dropdown-btn bill-line-product-btn' + (open ? ' open' : '')} disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!btnRef.current) return;
          const rect = btnRef.current.getBoundingClientRect();
          setPos({ top: rect.bottom + 2, left: rect.left, minWidth: Math.max(rect.width, 220) });
          setQuery('');
          setOpen(true);
        }}
      >
        <span className="folio-dropdown-text">{product ? product.name : 'Search product...'}</span>
        <span className="folio-dropdown-arrow">▼</span>
      </button>
      {open && createPortal(
        <div className="folio-dropdown-panel" style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}>
          <input ref={inputRef} type="text" className="folio-dropdown-search" placeholder="Search products..." value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} />
          <div className="folio-dropdown-options">
            {matches.map((p) => (
              <div key={p.id} className={'folio-dropdown-option' + (p.id === line.product_id ? ' selected' : '')} onClick={() => { onPick(p); setOpen(false); }}>{p.name}</div>
            ))}
            {matches.length === 0 && <div className="folio-dropdown-empty">No products found</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function BillLineRow({
  line, products, disabled, landedCosts, lineCounts, variantLandedCosts, variantLineCounts, onChange, onRemove, canRemove,
}: {
  line: BillLineDraft;
  products: Product[];
  disabled: boolean;
  landedCosts: Map<string, number>;
  lineCounts: Map<string, number>;
  variantLandedCosts: Map<string, number>;
  variantLineCounts: Map<string, number>;
  onChange: (patch: Partial<BillLineDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const product = line.mode === 'product' ? billLineProduct(products, line) : null;
  const productMissing = line.mode === 'product' && !!line.product_id && !product;
  const variants = product ? sortVariantsBySize(product.variants || []) : [];
  const usesVariantGrid = !!product && variants.length > 0;
  const amount = billLineAmount(products, line);

  function pickProduct(p: Product) {
    const variantCosts: Record<string, string> = {};
    (p.variants || []).forEach((v) => { variantCosts[v.id] = String(v.cost_price ?? p.cost_price ?? ''); });
    onChange({ product_id: p.id, variant_id: null, variantQuantities: {}, variantCosts, quantity: '' });
  }

  function toggleMode() {
    onChange({ mode: line.mode === 'product' ? 'text' : 'product', product_id: null, variant_id: null, variantQuantities: {}, variantCosts: {}, description: '' });
  }

  const newCost = product && !usesVariantGrid ? landedCosts.get(product.id) : null;

  return (
    <div className="bill-line">
      <div className="bill-line-image-cell">
        {product && (product.image_url
          ? <img className="bill-line-product-thumb" src={product.image_url} alt="" />
          : <div className="bill-line-product-thumb bill-line-product-thumb-empty">No Img</div>)}
      </div>
      <div className="bill-line-content">
        <div className="bill-line-main">
          {productMissing ? (
            <input type="text" className="form-input" value={line.description || ''} disabled />
          ) : line.mode === 'product' ? (
            <ProductPicker products={products} line={line} disabled={disabled} onPick={pickProduct} />
          ) : (
            <input type="text" className="form-input bill-line-description" placeholder="e.g. Cotton fabric" disabled={disabled} value={line.description} onChange={(e) => onChange({ description: e.target.value })} />
          )}
          {disabled ? <span /> : (
            <button type="button" className="bill-line-mode-toggle" title={line.mode === 'product' ? 'Switch to typed description' : 'Switch to product selection'} onClick={toggleMode}>
              <i className={`fa-solid ${line.mode === 'product' ? 'fa-pen-to-square' : 'fa-list-check'}`} />
            </button>
          )}
          {usesVariantGrid ? <span /> : (
            <input type="number" className="form-input bill-line-quantity" min={0} step={0.001} placeholder="0" disabled={disabled} value={line.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
          )}
          {usesVariantGrid ? <span /> : (
            <input type="number" className="form-input bill-line-cost" min={0} step={0.01} placeholder="0.00" disabled={disabled} value={line.unit_cost} onChange={(e) => onChange({ unit_cost: e.target.value })} />
          )}
          <span className="bill-line-amount">{formatMoney(amount)}</span>
          {!disabled && canRemove !== false && <button type="button" className="bill-line-remove" aria-label="Remove line" onClick={onRemove}>&times;</button>}
        </div>
        {(usesVariantGrid || newCost != null) && (
          <div className="bill-line-extra">
            {usesVariantGrid && (
              <div className="bill-line-variant-qtys">
                {variants.map((v) => {
                  const qty = parseFloat(line.variantQuantities[v.id]) || 0;
                  const cost = parseFloat(line.variantCosts[v.id]);
                  const variantAmount = qty > 0 && !Number.isNaN(cost) ? formatMoney(qty * cost) : '';
                  const newVariantCost = variantLandedCosts.get(v.id);
                  const effect = newVariantCost != null ? billLineCostEffect(v.cost_price ?? product!.cost_price, newVariantCost, variantLineCounts.get(v.id) || 1) : null;
                  return (
                    <div className="bill-line-variant-row" key={v.id}>
                      <span className="bill-line-variant-qty-label">
                        {v.title}
                        <span className="bill-line-variant-cost-effect">{effect && <CostEffectLabel {...effect} />}</span>
                      </span>
                      <span />
                      <input
                        type="number" className="form-input bill-line-variant-qty-input" min={0} step={1} placeholder="0" disabled={disabled}
                        value={line.variantQuantities[v.id] ?? '0'}
                        onChange={(e) => onChange({ variantQuantities: { ...line.variantQuantities, [v.id]: e.target.value } })}
                      />
                      <input
                        type="number" className="form-input bill-line-variant-cost-input" min={0} step={0.01} placeholder="0.00" disabled={disabled}
                        value={line.variantCosts[v.id] ?? ''}
                        onChange={(e) => onChange({ variantCosts: { ...line.variantCosts, [v.id]: e.target.value } })}
                      />
                      <span className="bill-line-variant-amount">{variantAmount}</span>
                      <span />
                    </div>
                  );
                })}
              </div>
            )}
            {!usesVariantGrid && newCost != null && (
              <div className="bill-line-cost-effect"><CostEffectLabel {...billLineCostEffect(product!.cost_price, newCost, lineCounts.get(product!.id) || 1)} /></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface BillDetail {
  bill_number?: string; status?: string; supplier_id?: string; supplier_ref?: string; bill_date?: string;
  discount_amount?: number; tax_amount?: number; other_expense_amount?: number; notes?: string;
  items?: Array<{ id?: string; description?: string | null; quantity: number; unit_cost: number; product_id?: string | null; variant_id?: string | null }>;
}

export function BillModal({
  billId, ledgers, products, onClose, onDone,
}: {
  billId: string | null;
  ledgers: Ledger[];
  products: Product[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { isEditingAllowed } = useAuth();
  const confirm = useConfirm();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(!!billId);
  const [readOnly, setReadOnly] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [billNumber, setBillNumber] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [billDate, setBillDate] = useState(getPKTDateString());
  const [discount, setDiscount] = useState('0');
  const [tax, setTax] = useState('0');
  const [otherExpense, setOtherExpense] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<BillLineDraft[]>([emptyBillLine()]);
  const [saving, setSaving] = useState<'save' | 'confirm' | 'revert' | null>(null);

  useEffect(() => {
    if (!billId) { setLoading(false); return; }
    (async () => {
      try {
        const bill = await apiJson<BillDetail>(`/bills/${billId}`, { fallback: 'Failed to load bill' });
        setStatus(bill.status || null);
        setReadOnly(bill.status !== 'draft');
        setBillNumber(bill.bill_number || '');
        setSupplierId(bill.supplier_id || '');
        setSupplierRef(bill.supplier_ref || '');
        setBillDate(bill.bill_date || getPKTDateString());
        setDiscount(String(bill.discount_amount || 0));
        setTax(String(bill.tax_amount || 0));
        setOtherExpense(String(bill.other_expense_amount || 0));
        setNotes(bill.notes || '');
        const drafts = billItemsToDrafts(products, bill.items || []);
        setLines(drafts.length ? drafts : [emptyBillLine()]);
      } catch (error) {
        console.error('Error loading bill:', error);
        showToast('Failed to load bill', 'error');
        onClose();
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billId]);

  const totalsInput = useMemo(() => ({ discount: parseFloat(discount) || 0, tax: parseFloat(tax) || 0, otherExpense: parseFloat(otherExpense) || 0 }), [discount, tax, otherExpense]);
  const landedCosts = useMemo(() => billProductLandedCosts(products, lines, totalsInput), [products, lines, totalsInput]);
  const lineCounts = useMemo(() => billProductLineCounts(products, lines), [products, lines]);
  const variantLandedCosts = useMemo(() => billVariantLandedCosts(products, lines, totalsInput), [products, lines, totalsInput]);
  const variantLineCounts = useMemo(() => billVariantLineCounts(products, lines), [products, lines]);
  const subtotal = useMemo(() => lines.reduce((sum, l) => sum + billLineAmount(products, l), 0), [products, lines]);
  const total = subtotal - totalsInput.discount + totalsInput.tax + totalsInput.otherExpense;

  function updateLine(key: string, patch: Partial<BillLineDraft>) {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setLines((prev) => {
      const next = prev.filter((l) => l._key !== key);
      return next.length ? next : [emptyBillLine()];
    });
  }

  function collectPayload(): Record<string, unknown> | null {
    if (!supplierId) { showToast('Select a supplier', 'error', { silent: true }); return null; }
    if (!billDate) { showToast('Enter a bill date', 'error', { silent: true }); return null; }

    const filled = lines.filter((l) => l.quantity !== '' || l.unit_cost !== '' || l.description || l.product_id);
    const items: Array<Record<string, unknown>> = [];
    for (const line of filled) {
      if (billLineUsesVariantGrid(products, line)) {
        const product = billLineProduct(products, line)!;
        const picked = (product.variants || [])
          .map((v) => ({ variant: v, qty: parseFloat(line.variantQuantities[v.id]) || 0, cost: parseFloat(line.variantCosts?.[v.id] ?? '') }))
          .filter(({ qty }) => qty > 0);
        if (!picked.length) { showToast(`Enter a quantity for at least one variant of ${product.name}`, 'error', { silent: true }); return null; }
        if (picked.some(({ cost }) => Number.isNaN(cost) || cost < 0)) { showToast(`Enter a cost for every variant with a quantity on ${product.name}`, 'error', { silent: true }); return null; }
        for (const { variant, qty, cost } of picked) {
          items.push({ description: billLineVariantDescription(product, variant), quantity: qty, unit_cost: cost, product_id: product.id, variant_id: variant.id });
        }
        continue;
      }

      const cost = parseFloat(line.unit_cost);
      if (Number.isNaN(cost) || cost < 0) { showToast('Every line needs a unit cost', 'error', { silent: true }); return null; }
      const qty = parseFloat(line.quantity);
      if (Number.isNaN(qty) || qty <= 0) { showToast('Every line needs a quantity above 0', 'error', { silent: true }); return null; }

      let productId: string | null = null, variantId: string | null = null, description = line.description || null;
      if (line.mode === 'product') {
        const product = billLineProduct(products, line);
        if (product) {
          productId = product.id;
          description = billLineVariantDescription(product, null);
        } else if (line.product_id) {
          productId = line.product_id;
          variantId = line.variant_id || null;
        } else {
          showToast('Select a product for every product line', 'error', { silent: true });
          return null;
        }
      }
      items.push({ description, quantity: qty, unit_cost: cost, product_id: productId, variant_id: variantId });
    }
    if (!items.length) { showToast('Add at least one line', 'error', { silent: true }); return null; }

    return {
      supplier_id: supplierId, bill_date: billDate, supplier_ref: supplierRef.trim() || null,
      discount_amount: totalsInput.discount, tax_amount: totalsInput.tax, other_expense_amount: totalsInput.otherExpense,
      notes: notes.trim() || null, items,
    };
  }

  async function persist(payload: Record<string, unknown>): Promise<boolean> {
    try {
      if (billId) await apiJson(`/bills/${billId}`, { method: 'PUT', body: payload, fallback: 'Failed to update bill' });
      else await apiJson('/bills/', { method: 'POST', body: payload, fallback: 'Failed to create bill' });
      return true;
    } catch (error: any) {
      console.error('Error saving bill:', error);
      showToast(error?.message || 'Failed to save bill', 'error');
      return false;
    }
  }

  async function save() {
    if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
    const payload = collectPayload();
    if (!payload) return;
    setSaving('save');
    try {
      if (await persist(payload)) {
        showToast(billId ? 'Bill updated' : 'Draft bill created', 'success');
        onDone();
      }
    } finally {
      setSaving(null);
    }
  }

  async function billAction(action: string): Promise<boolean> {
    try {
      await apiJson(`/bills/${billId}/${action}`, { method: 'POST', fallback: `Failed to ${action} bill` });
      return true;
    } catch (error: any) {
      console.error(`Error on bill ${action}:`, error);
      showToast(error?.message || `Failed to ${action} bill`, 'error');
      return false;
    }
  }

  async function confirmBill() {
    if (!billId) return;
    const payload = collectPayload();
    if (!payload) return;
    setSaving('confirm');
    try {
      if (!(await persist(payload))) return;
      const ok = await confirm({ title: 'Confirm Bill', message: 'This posts the bill to the accounts and adds its stock. Continue?', confirmText: 'Confirm' });
      if (!ok) return;
      if (await billAction('receive')) onDone();
    } finally {
      setSaving(null);
    }
  }

  async function revertBill() {
    if (!billId) return;
    const ok = await confirm({ title: 'Revert to Draft', message: 'This unposts the bill and removes the stock it added. Continue?', confirmText: 'Revert to draft' });
    if (!ok) return;
    setSaving('revert');
    try {
      if (await billAction('unreceive')) onDone();
    } finally {
      setSaving(null);
    }
  }

  if (loading) return null;

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content bill-modal-content">
        <div className="modal-header">
          <h2>{billId ? `${readOnly ? 'View' : 'Edit'} ${billNumber}` : 'New Bill'}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <form className="ledger-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <div className="bill-form-row bill-form-row-3col">
              <div className="form-group">
                <label htmlFor="billSupplier">Supplier *</label>
                <select id="billSupplier" className="form-input" required disabled={readOnly} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Select supplier...</option>
                  {partyLedgers(ledgers).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <span className="form-hint">Party ledgers. Mark a ledger as a party in Edit Ledger.</span>
              </div>
              <div className="form-group">
                <label htmlFor="billSupplierRef">Supplier's bill #</label>
                <input type="text" id="billSupplierRef" className="form-input" placeholder="e.g. INV-2291" disabled={readOnly} value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
              </div>
              <div className="form-group">
                <label htmlFor="billDate">Bill date *</label>
                <input type="date" id="billDate" className="form-input" required disabled={readOnly} value={billDate} onChange={(e) => setBillDate(e.target.value)} />
              </div>
            </div>

            <div className="bill-lines-wrap">
              <div className="bill-lines-header">
                <span>Image</span><span>Item</span><span /><span>Qty</span><span>Unit cost</span><span>Amount</span><span />
              </div>
              <div id="billLines">
                {lines.map((line) => (
                  <BillLineRow
                    key={line._key} line={line} products={products} disabled={readOnly}
                    landedCosts={landedCosts} lineCounts={lineCounts} variantLandedCosts={variantLandedCosts} variantLineCounts={variantLineCounts}
                    onChange={(patch) => updateLine(line._key, patch)} onRemove={() => removeLine(line._key)} canRemove={lines.length > 1}
                  />
                ))}
              </div>
              {!readOnly && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((prev) => [...prev, emptyBillLine()])}>Add line</button>}
            </div>

            <div className="bill-totals">
              <div className="bill-total-line"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
              <div className="bill-total-line">
                <label htmlFor="billDiscount">Discount</label>
                <input type="number" id="billDiscount" className="form-input bill-tax-input" step={0.01} min={0} disabled={readOnly} value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </div>
              <div className="bill-total-line">
                <label htmlFor="billTax">Tax</label>
                <input type="number" id="billTax" className="form-input bill-tax-input" step={0.01} min={0} disabled={readOnly} value={tax} onChange={(e) => setTax(e.target.value)} />
              </div>
              <div className="bill-total-line">
                <label htmlFor="billOtherExpense" title="e.g. transport, loading, courier">Other expense</label>
                <input type="number" id="billOtherExpense" className="form-input bill-tax-input" step={0.01} min={0} disabled={readOnly} value={otherExpense} onChange={(e) => setOtherExpense(e.target.value)} />
              </div>
              <div className="bill-total-line bill-total-grand"><span>Total</span><span>{formatMoney(total)}</span></div>
            </div>

            <div className="form-group">
              <label htmlFor="billNotes">Notes</label>
              <input type="text" id="billNotes" className="form-input" disabled={readOnly} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </form>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {status === 'received' && <button type="button" className="btn btn-secondary" disabled={!!saving} onClick={revertBill}>{saving === 'revert' ? 'Reverting...' : 'Revert to Draft'}</button>}
          {status === 'draft' && billId && <button type="button" className="btn btn-primary" disabled={!!saving} onClick={confirmBill}>{saving === 'confirm' ? 'Confirming...' : 'Confirm Bill'}</button>}
          {!readOnly && <button type="button" className="btn btn-primary" disabled={!!saving} onClick={save}>{saving === 'save' ? 'Saving...' : 'Save draft'}</button>}
        </div>
      </div>
    </div>
  );
}
