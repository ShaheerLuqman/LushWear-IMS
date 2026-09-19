// Product details / adjust stock / cost history / edit variant costs / bulk cost
// price modals. Ported from inventory.js + modals-forms.js.
import { useEffect, useState } from 'react';
import { BlockStack, Box, Checkbox, ChoiceList, DescriptionList, FormLayout, InlineStack, Text, TextField } from '@shopify/polaris';
import { ProductIdentity } from '../../components/ProductIdentity';
import { StatGrid } from '../../components/StatGrid';
import { FormModal, InfoModal } from '../../components/FormModal';
import { ReportTable } from '../../components/ReportTable';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { formatAmount, formatDateTimeDDMMYYYY } from '../../logic/shared';
import { Dropdown } from '../../components/Dropdown';
import {
  productStockStatus, productStockValue, productUnitCost, sortVariantsBySize, STOCK_STATUS_LABELS, type Product,
} from '../../logic/products';

const STOCK_TONE = { in: 'success', low: 'warning', out: 'critical' } as const;

function ProductHeader({ product, withStatus = true }: { product: Product; withStatus?: boolean }) {
  const status = productStockStatus(product);
  const count = (product.variants || []).length;
  return (
    <ProductIdentity
      name={product.name || ''} imageUrl={product.image_url}
      subtitle={`Collection: ${product.collection || '—'} · ${count} variant${count === 1 ? '' : 's'}`}
      badge={withStatus ? { label: STOCK_STATUS_LABELS[status], tone: STOCK_TONE[status] } : undefined}
    />
  );
}

/** Audit + "recalculate orders" fields shared by the cost-price modals. */
function CostAuditFields({ effectiveFrom, setEffectiveFrom, reason, setReason, recalcAfter, setRecalcAfter, scopeNote }: {
  effectiveFrom: string; setEffectiveFrom: (v: string) => void; reason: string; setReason: (v: string) => void;
  recalcAfter: string; setRecalcAfter: (v: string) => void; scopeNote: string;
}) {
  return (
    <>
      <FormLayout.Group>
        <TextField label="Applicable from" type="date" autoComplete="off" value={effectiveFrom} onChange={setEffectiveFrom} />
        <Dropdown label="Reason (optional)" fullWidth placeholder="Select reason" options={COST_REASONS} value={reason} onChange={setReason} />
      </FormLayout.Group>
      <Box paddingBlockStart="200" borderBlockStartWidth="025" borderColor="border">
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Recalculate order costs</Text>
          <Text as="p" tone="subdued">{scopeNote}</Text>
          <TextField label="Update orders created on or after" type="datetime-local" autoComplete="off" value={recalcAfter} onChange={setRecalcAfter} />
        </BlockStack>
      </Box>
    </>
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
    <InfoModal
      title="Product Details" onClose={onClose}
      actions={[
        { content: 'Update Cost', onAction: () => onUpdateCost(product) },
        { content: 'Adjust Stock', onAction: () => onAdjustStock(product) },
        { content: 'View History', onAction: () => onHistory(product) },
      ]}
    >
      <BlockStack gap="400">
        <ProductHeader product={product} />
        <StatGrid rows={summary} />
        {sizes.length > 0 && <StatGrid rows={sizes} />}
        <DescriptionList gap="tight" items={meta.map(([term, description]) => ({ term, description }))} />
      </BlockStack>
    </InfoModal>
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
    <FormModal title="Adjust Stock" onClose={onClose} onSubmit={submit} submitLabel="Update Stock" saving={saving}>
      <BlockStack gap="400">
        <ProductHeader product={product} />
        <ChoiceList
          title="Adjustment type" selected={[type]} onChange={(v) => setType(v[0] as 'add' | 'remove')}
          choices={[{ value: 'add', label: 'Add Stock' }, { value: 'remove', label: 'Remove Stock' }]}
        />
        <FormLayout>
          {variants.map((v) => (
            <TextField
              key={v.id} label={`${v.title} · in stock: ${v.quantity || 0}`} type="number" autoComplete="off" min={0} step={1} placeholder="0"
              value={qtyByVariant[v.id] || ''} onChange={(val) => setQtyByVariant((prev) => ({ ...prev, [v.id]: val }))}
            />
          ))}
          <Dropdown
            label="Reason" fullWidth placeholder="Select reason" value={reason} onChange={setReason}
            options={['Stock Count Correction', 'Damaged / Written Off', 'Returned to Supplier', 'Customer Return', 'Transfer', 'Other']}
          />
          <TextField label="Notes (optional)" autoComplete="off" multiline={3} placeholder="Add a note..." value={notes} onChange={setNotes} />
        </FormLayout>
      </BlockStack>
    </FormModal>
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
    <InfoModal title="Cost History" onClose={onClose} size="large">
      <BlockStack gap="400">
        <ProductHeader product={product} withStatus={false} />
        <ReportTable
          headings={['Date', 'Variant', 'Cost per Unit', 'Changed By', 'Reason']} numeric={[2]}
          emptyMessage={error || (rows == null ? 'Loading…' : 'No cost changes recorded yet. Costs set by receiving a purchase bill are audited on that bill.')}
          rows={(error ? [] : rows || []).map((r) => [
            formatDateTimeDDMMYYYY(r.created_at), r.variant_title || 'All variants',
            r.new_cost_price == null ? '—' : `PKR ${formatAmount(r.new_cost_price)}`, r.changed_by_name || 'System', r.reason || '—',
          ])}
        />
      </BlockStack>
    </InfoModal>
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
    <FormModal
      title={`Update Cost — ${product.name}`} onClose={onClose} onSubmit={submitSave} saving={saving === 'save'} disabled={!!saving}
      extraActions={[{ content: 'Save and recalculate orders', loading: saving === 'recalc', disabled: !!saving || !recalcAfter, onAction: submitSaveAndRecalc }]}
    >
      <FormLayout>
        <Text as="p" tone="subdued">Blank falls back to the product's own cost price.</Text>
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" tone="subdued">Current cost per unit:</Text>
          <Text as="span" fontWeight="semibold">{currentCost != null ? `PKR ${formatAmount(currentCost)}` : (variants.length ? 'Mixed across variants' : '—')}</Text>
        </InlineStack>
        {multiVariant && <Checkbox label="Set cost price separately for each variant" checked={perVariant} onChange={setPerVariant} />}
        {sharedMode ? (
          <TextField label="New cost per unit (Rs)" type="number" autoComplete="off" min={0} step={0.01} placeholder="0.00" value={sharedCost} onChange={setSharedCost} />
        ) : rows.map((r) => (
          <TextField
            key={r.id} label={r.qty != null ? `${r.title} (qty: ${r.qty})` : r.title} type="number" autoComplete="off" min={0} step={0.01} placeholder="0.00"
            value={rowCosts[r.id] || ''} onChange={(val) => setRowCosts((prev) => ({ ...prev, [r.id]: val }))}
          />
        ))}
        <CostAuditFields
          effectiveFrom={effectiveFrom} setEffectiveFrom={setEffectiveFrom} reason={reason} setReason={setReason} recalcAfter={recalcAfter} setRecalcAfter={setRecalcAfter}
          scopeNote="Refresh order cost totals from the costs above. Only orders on or after the date below that include this product are updated."
        />
      </FormLayout>
    </FormModal>
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
    <FormModal
      title="Bulk update cost price" onClose={onClose} onSubmit={submitSave} submitLabel="Confirm" saving={saving === 'save'} disabled={!!saving}
      extraActions={[{ content: 'Save and recalculate orders', loading: saving === 'recalc', disabled: !!saving || !recalcAfter, onAction: submitSaveAndRecalc }]}
    >
      <FormLayout>
        <Text as="p" tone="subdued">Set the cost price (Rs) for {productIds.length === 1 ? '1 product' : `${productIds.length} products`}. This also applies to every variant of each selected product.</Text>
        <TextField label="Cost price (Rs)" type="number" autoComplete="off" min={0} step={0.01} placeholder="0.00" requiredIndicator autoFocus value={cost} onChange={setCost} />
        <CostAuditFields
          effectiveFrom={effectiveFrom} setEffectiveFrom={setEffectiveFrom} reason={reason} setReason={setReason} recalcAfter={recalcAfter} setRecalcAfter={setRecalcAfter}
          scopeNote="Refresh order cost totals from the new costs. Only orders on or after the date below that include one of the selected products are updated."
        />
      </FormLayout>
    </FormModal>
  );
}
