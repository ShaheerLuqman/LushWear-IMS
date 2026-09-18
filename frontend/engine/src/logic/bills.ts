// Purchase bill business logic - ported 1:1 from bills.js. Pure functions take
// `products`/`ledgers` explicitly instead of module-level globals.
import type { Ledger } from './ledgers';
import type { Product } from './products';

export const BILL_STATUSES = ['draft', 'received', 'cancelled'];
export const BILL_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', cancelled: 'Cancelled', unpaid: 'Unpaid', partially_paid: 'Part paid', paid: 'Paid',
};

export function partyLedgers(ledgers: Ledger[]): Ledger[] {
  return ledgers.filter((l) => l.type === 'Liability');
}

export interface BillLineDraft {
  _key: string;
  mode: 'product' | 'text';
  description: string;
  quantity: string;
  unit_cost: string;
  product_id: string | null;
  variant_id: string | null;
  variantQuantities: Record<string, string>;
  variantCosts: Record<string, string>;
}

export function emptyBillLine(): BillLineDraft {
  return {
    _key: `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    mode: 'product', description: '', quantity: '', unit_cost: '',
    product_id: null, variant_id: null, variantQuantities: {}, variantCosts: {},
  };
}

export function billLineProduct(products: Product[], line: BillLineDraft): Product | null {
  return products.find((p) => p.id === line.product_id) || null;
}

/** True once a line has a resolvable product that actually has variants - the
 * per-variant quantity grid replaces the single quantity field for it. */
export function billLineUsesVariantGrid(products: Product[], line: BillLineDraft): boolean {
  if (line.mode !== 'product') return false;
  const product = billLineProduct(products, line);
  return !!(product && (product.variants || []).length);
}

export function billLineTotalQty(products: Product[], line: BillLineDraft): number {
  if (billLineUsesVariantGrid(products, line)) {
    return Object.values(line.variantQuantities || {}).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
  }
  return parseFloat(line.quantity) || 0;
}

export function billLineAmount(products: Product[], line: BillLineDraft): number {
  if (billLineUsesVariantGrid(products, line)) {
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
  const qty = billLineTotalQty(products, line);
  const cost = parseFloat(line.unit_cost);
  if (!qty || Number.isNaN(cost)) return 0;
  return Math.round(qty * cost * 100) / 100;
}

export function billLineVariantDescription(product: Product, variant: { title?: string } | null): string {
  return variant ? `${product.name} — ${variant.title}` : product.name || '';
}

export interface BillTotalsInput { discount: number; tax: number; otherExpense: number }

/** A bill's tax/other-expense/discount land on the goods, not just on the lines
 * that happen to reference a catalog product, so the per-unit share is spread
 * across the whole bill's quantity. */
export function billLandedCostExtra(products: Product[], lines: BillLineDraft[], totals: BillTotalsInput): number {
  const totalQty = lines.reduce((sum, l) => sum + billLineTotalQty(products, l), 0);
  if (totalQty <= 0) return 0;
  return (totals.tax + totals.otherExpense - totals.discount) / totalQty;
}

/** Landed cost per variant-less product line: qty-weighted average of its own
 * line(s) unit cost, plus its even share of the bill's tax/other-expense/discount. */
export function billProductLandedCosts(products: Product[], lines: BillLineDraft[], totals: BillTotalsInput): Map<string, number> {
  const extra = billLandedCostExtra(products, lines, totals);
  const byProduct = new Map<string, { qty: number; costTotal: number }>();
  for (const line of lines) {
    if (line.mode !== 'product' || !line.product_id || billLineUsesVariantGrid(products, line)) continue;
    const qty = billLineTotalQty(products, line);
    if (qty <= 0) continue;
    const cost = parseFloat(line.unit_cost) || 0;
    const agg = byProduct.get(line.product_id) || { qty: 0, costTotal: 0 };
    agg.qty += qty;
    agg.costTotal += qty * cost;
    byProduct.set(line.product_id, agg);
  }
  const result = new Map<string, number>();
  for (const [productId, agg] of byProduct) result.set(productId, Math.round((agg.costTotal / agg.qty + extra) * 100) / 100);
  return result;
}

/** Same idea, per variant across every variant-grid line that gave it a qty > 0. */
export function billVariantLandedCosts(products: Product[], lines: BillLineDraft[], totals: BillTotalsInput): Map<string, number> {
  const extra = billLandedCostExtra(products, lines, totals);
  const byVariant = new Map<string, { qty: number; costTotal: number }>();
  for (const line of lines) {
    if (line.mode !== 'product' || !line.product_id || !billLineUsesVariantGrid(products, line)) continue;
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
  const result = new Map<string, number>();
  for (const [variantId, agg] of byVariant) result.set(variantId, Math.round((agg.costTotal / agg.qty + extra) * 100) / 100);
  return result;
}

export function billProductLineCounts(products: Product[], lines: BillLineDraft[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.mode !== 'product' || !line.product_id || billLineUsesVariantGrid(products, line)) continue;
    if (billLineTotalQty(products, line) > 0) counts.set(line.product_id, (counts.get(line.product_id) || 0) + 1);
  }
  return counts;
}

export function billVariantLineCounts(products: Product[], lines: BillLineDraft[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.mode !== 'product' || !line.product_id || !billLineUsesVariantGrid(products, line)) continue;
    Object.entries(line.variantQuantities || {}).forEach(([variantId, qty]) => {
      if ((parseFloat(qty) || 0) > 0) counts.set(variantId, (counts.get(variantId) || 0) + 1);
    });
  }
  return counts;
}

export interface CostEffect { current: number; newCost: number; diff: number; label: string }

/** newCost is already the qty-weighted average landed cost across every entry on
 * this bill that references the product/variant - when it spans more than one
 * entry, the label says so, since that average is what actually overwrites
 * cost_price on receive, not any single line's own unit cost. */
export function billLineCostEffect(currentCost: number | null | undefined, newCost: number, lineCount: number): CostEffect {
  const current = currentCost || 0;
  const diff = Math.round((newCost - current) * 100) / 100;
  const label = lineCount > 1 ? `New avg cost (wtd across ${lineCount} entries)` : 'New cost price';
  return { current, newCost, diff, label };
}

interface BillItem {
  id?: string; description?: string | null; quantity: number | string; unit_cost: number | string;
  product_id?: string | null; variant_id?: string | null;
}

/** Groups a saved bill's flat items back into draft rows for editing: items on a
 * product that currently has variants collapse into one row per product. */
export function billItemsToDrafts(products: Product[], items: BillItem[]): BillLineDraft[] {
  const drafts: BillLineDraft[] = [];
  const groups = new Map<string, BillLineDraft>();

  for (const item of items) {
    const product = item.product_id ? products.find((p) => p.id === item.product_id) || null : null;
    const hasVariants = !!(product && (product.variants || []).length);

    if (hasVariants && item.variant_id) {
      let draft = groups.get(item.product_id!);
      if (!draft) {
        draft = {
          _key: item.id || `item_${item.product_id}`, mode: 'product', description: '', quantity: '', unit_cost: '',
          product_id: item.product_id!, variant_id: null, variantQuantities: {}, variantCosts: {},
        };
        groups.set(item.product_id!, draft);
        drafts.push(draft);
      }
      draft.variantQuantities[item.variant_id] = String(item.quantity);
      draft.variantCosts[item.variant_id] = String(item.unit_cost);
      continue;
    }

    drafts.push({
      _key: item.id || `item_${drafts.length}`,
      mode: item.product_id ? 'product' : 'text',
      description: item.description || '',
      quantity: String(item.quantity ?? ''),
      unit_cost: String(item.unit_cost ?? ''),
      product_id: item.product_id || null,
      variant_id: item.variant_id || null,
      variantQuantities: {},
      variantCosts: {},
    });
  }

  return drafts;
}
