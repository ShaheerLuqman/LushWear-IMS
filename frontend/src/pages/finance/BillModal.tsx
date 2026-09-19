// Create/edit/view a purchase bill - line editor with per-variant qty/cost grids
// and a landed-cost preview. Ported from bills.js's openBillModal/renderBillLines/
// collectBillPayload.
import { useEffect, useMemo, useState } from 'react';
import { BlockStack, Button, FormLayout, InlineStack, Modal, TextField, Thumbnail } from '@shopify/polaris';
import { EditIcon, ImageIcon, ListBulletedIcon, XIcon } from '@shopify/polaris-icons';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/ConfirmContext';
import { useToast } from '../../toast/ToastContext';
import { formatMoney, type Ledger } from '../../logic/ledgers';
import { sortVariantsBySize, type Product } from '../../logic/products';
import { getPKTDateString } from '../../logic/shared';
import { Dropdown } from '../../components/Dropdown';
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
        {product && <Thumbnail size="large" source={product.image_url || ImageIcon} alt="" />}
      </div>
      <div className="bill-line-content">
        <div className="bill-line-main">
          {productMissing ? (
            <TextField label="Item" labelHidden autoComplete="off" value={line.description || ''} disabled />
          ) : line.mode === 'product' ? (
            <Dropdown
              searchable fullWidth disabled={disabled} placeholder="Search product..."
              options={products.map((p) => ({ value: p.id, label: p.name || '' }))}
              value={line.product_id || ''} onChange={(id) => pickProduct(products.find((p) => p.id === id)!)}
            />
          ) : (
            <TextField label="Description" labelHidden autoComplete="off" placeholder="e.g. Cotton fabric" disabled={disabled} value={line.description} onChange={(description) => onChange({ description })} />
          )}
          {disabled ? <span /> : (
            <Button icon={line.mode === 'product' ? EditIcon : ListBulletedIcon} variant="tertiary" accessibilityLabel={line.mode === 'product' ? 'Switch to typed description' : 'Switch to product selection'} onClick={toggleMode} />
          )}
          {usesVariantGrid ? <span /> : (
            <TextField label="Qty" labelHidden type="number" autoComplete="off" min={0} step={0.001} placeholder="0" disabled={disabled} value={line.quantity} onChange={(quantity) => onChange({ quantity })} />
          )}
          {usesVariantGrid ? <span /> : (
            <TextField label="Unit cost" labelHidden type="number" autoComplete="off" min={0} step={0.01} placeholder="0.00" disabled={disabled} value={line.unit_cost} onChange={(unit_cost) => onChange({ unit_cost })} />
          )}
          <span className="bill-line-amount">{formatMoney(amount)}</span>
          {!disabled && canRemove !== false ? <Button icon={XIcon} variant="tertiary" tone="critical" accessibilityLabel="Remove line" onClick={onRemove} /> : <span />}
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
                      <TextField
                        label="Qty" labelHidden type="number" autoComplete="off" size="slim" min={0} step={1} placeholder="0" disabled={disabled}
                        value={line.variantQuantities[v.id] ?? '0'}
                        onChange={(val) => onChange({ variantQuantities: { ...line.variantQuantities, [v.id]: val } })}
                      />
                      <TextField
                        label="Cost" labelHidden type="number" autoComplete="off" size="slim" min={0} step={0.01} placeholder="0.00" disabled={disabled}
                        value={line.variantCosts[v.id] ?? ''}
                        onChange={(val) => onChange({ variantCosts: { ...line.variantCosts, [v.id]: val } })}
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

  const totalLine = (label: string, value: string, grand = false) => (
    <div className={'bill-total-line' + (grand ? ' bill-total-grand' : '')}><span>{label}</span><span>{value}</span></div>
  );
  const totalInput = (label: string, value: string, onChange: (v: string) => void) => (
    <div className="bill-total-line"><span>{label}</span><TextField label={label} labelHidden type="number" autoComplete="off" size="slim" align="right" step={0.01} min={0} disabled={readOnly} value={value} onChange={onChange} /></div>
  );

  return (
    <Modal
      open onClose={onClose} size="large" title={billId ? `${readOnly ? 'View' : 'Edit'} ${billNumber}` : 'New Bill'}
      primaryAction={!readOnly ? { content: 'Save draft', onAction: save, loading: saving === 'save', disabled: !!saving } : undefined}
      secondaryActions={[
        ...(status === 'draft' && billId ? [{ content: 'Confirm Bill', onAction: confirmBill, loading: saving === 'confirm', disabled: !!saving }] : []),
        ...(status === 'received' ? [{ content: 'Revert to Draft', onAction: revertBill, loading: saving === 'revert', disabled: !!saving }] : []),
        { content: readOnly ? 'Close' : 'Cancel', onAction: onClose },
      ]}
    >
      <Modal.Section>
        <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (!readOnly) save(); }}>
          <BlockStack gap="400">
            <FormLayout>
              <FormLayout.Group>
                <Dropdown label="Supplier" helpText="Party ledgers. Mark a ledger as a party in Edit Ledger." fullWidth searchable placeholder="Select supplier..." disabled={readOnly} options={partyLedgers(ledgers).map((l) => ({ value: l.id, label: l.name }))} value={supplierId} onChange={setSupplierId} />
                <TextField label={"Supplier's bill #"} autoComplete="off" placeholder="e.g. INV-2291" disabled={readOnly} value={supplierRef} onChange={setSupplierRef} />
                <TextField label="Bill date" type="date" autoComplete="off" requiredIndicator disabled={readOnly} value={billDate} onChange={setBillDate} />
              </FormLayout.Group>
            </FormLayout>

            <div className="bill-lines-wrap">
              <div className="bill-lines-header">
                <span>Image</span><span>Item</span><span /><span>Qty</span><span>Unit cost</span><span>Amount</span><span />
              </div>
              <div>
                {lines.map((line) => (
                  <BillLineRow
                    key={line._key} line={line} products={products} disabled={readOnly}
                    landedCosts={landedCosts} lineCounts={lineCounts} variantLandedCosts={variantLandedCosts} variantLineCounts={variantLineCounts}
                    onChange={(patch) => updateLine(line._key, patch)} onRemove={() => removeLine(line._key)} canRemove={lines.length > 1}
                  />
                ))}
              </div>
              {!readOnly && <InlineStack><Button size="slim" onClick={() => setLines((prev) => [...prev, emptyBillLine()])}>Add line</Button></InlineStack>}
            </div>

            <div className="bill-totals">
              {totalLine('Subtotal', formatMoney(subtotal))}
              {totalInput('Discount', discount, setDiscount)}
              {totalInput('Tax', tax, setTax)}
              {totalInput('Other expense', otherExpense, setOtherExpense)}
              {totalLine('Total', formatMoney(total), true)}
            </div>

            <TextField label="Notes" autoComplete="off" disabled={readOnly} value={notes} onChange={setNotes} />
            <button type="submit" hidden />
          </BlockStack>
        </form>
      </Modal.Section>
    </Modal>
  );
}
