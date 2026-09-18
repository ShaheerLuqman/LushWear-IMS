// Product/inventory business logic - ported 1:1 from orders-grid.js.
export interface ProductVariant {
  id: string;
  title?: string;
  quantity?: number;
  cost_price?: number | null;
  [key: string]: unknown;
}

export interface Product {
  id: string;
  name?: string;
  image_url?: string;
  collection?: string | null;
  price?: number;
  total_quantity?: number;
  cost_price?: number | null;
  variants?: ProductVariant[];
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

// Mirrors LOW_STOCK_THRESHOLD in backend/app/routes/products.py - the badges, the
// status filter and the stat cards must all agree on one number.
export const LOW_STOCK_THRESHOLD = 10;

export const STOCK_STATUS_LABELS: Record<string, string> = { in: 'In Stock', low: 'Low Stock', out: 'Out of Stock' };

export function productStockStatus(product: Product | null | undefined): 'in' | 'low' | 'out' {
  const qty = product?.total_quantity || 0;
  // <= 0, not === 0: an oversold product (negative qty) is worse than merely low.
  if (qty <= 0) return 'out';
  return qty < LOW_STOCK_THRESHOLD ? 'low' : 'in';
}

/** The one cost each unit of this product is carried at, or null when its variants
 *  disagree - the grid shows "Mixed" then and the details panel breaks it down. */
export function productUnitCost(product: Product | null | undefined): number | null {
  const variants = product?.variants || [];
  if (!variants.length) return product?.cost_price ?? null;
  const costs = variants.map((v) => v.cost_price ?? product?.cost_price ?? null);
  return costs.every((c) => c === costs[0]) ? costs[0] : null;
}

/** Stock at cost: each variant at its own cost, falling back to the product's. */
export function productStockValue(product: Product | null | undefined): number {
  const variants = product?.variants || [];
  return variants.reduce((sum, v) => sum + (v.quantity || 0) * (v.cost_price ?? product?.cost_price ?? 0), 0);
}

const sizeOrder: Record<string, number> = {
  xxs: 1, xs: 2, s: 3, small: 3,
  m: 4, medium: 4, med: 4,
  l: 5, large: 5,
  xl: 6, 'x-large': 6,
  xxl: 7, '2xl': 7,
  xxxl: 8, '3xl': 8,
  '4xl': 9, '5xl': 10,
};

/** Multi-option variants arrive as one joined title ("L / FULL SLEEVES"), so fall
 *  back to the leading token - otherwise every such variant sorts alphabetically. */
function variantSizeOrder(title: string | undefined): number {
  const t = (title || '').toLowerCase().trim();
  return sizeOrder[t] ?? sizeOrder[t.split('/')[0].trim()] ?? 100;
}

export function sortVariantsBySize(variants: ProductVariant[] | null | undefined): ProductVariant[] {
  if (!variants || !Array.isArray(variants)) return [];
  return [...variants].sort((a, b) => {
    const orderA = variantSizeOrder(a.title);
    const orderB = variantSizeOrder(b.title);
    if (orderA !== orderB) return orderA - orderB;
    return (a.title || '').toLowerCase().trim().localeCompare((b.title || '').toLowerCase().trim());
  });
}
