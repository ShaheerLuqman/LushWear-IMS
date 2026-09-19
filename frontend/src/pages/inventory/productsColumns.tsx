// Products table columns: how each is rendered and sorted.
import { Badge, Button, InlineStack, Text, Thumbnail } from '@shopify/polaris';
import { ImageIcon, ViewIcon } from '@shopify/polaris-icons';
import type { DataColumn } from '../../components/DataTable';
import { Dropdown } from '../../components/Dropdown';
import { RowActions } from '../../components/RowActions';
import { formatAmount } from '../../logic/shared';
import { productStockStatus, productStockValue, productUnitCost, STOCK_STATUS_LABELS, type Product } from '../../logic/products';

export interface ProductsColumnsCtx {
  isEditingAllowed: () => boolean;
  saveProductCollection: (productId: string, collection: string) => void;
  openProductDetails: (product: Product) => void;
  openEditVariantCosts: (product: Product) => void;
  openAdjustStock: (product: Product) => void;
  openCostHistory: (product: Product) => void;
}

export const COLLECTIONS = ['Cami Sets', 'Linen PJs', 'Pajama T-Shirt', 'Silk Collection', 'Trousers'];
const STOCK_TONE = { in: 'success', low: 'warning', out: 'critical' } as const;

const money = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Null unit cost means the variants carry different costs, not "no cost".
const unitCostLabel = (p: Product) => { const c = productUnitCost(p); return c != null ? `PKR ${formatAmount(c)}` : ((p.variants || []).length ? 'Mixed' : '—'); };

export function buildProductsColumns(ctx: ProductsColumnsCtx): DataColumn<Product>[] {
  return [
    {
      key: 'name', heading: 'Product', sortValue: (p) => p.name,
      render: (p) => (
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Thumbnail size="small" source={p.image_url || ImageIcon} alt="" />
          <Text as="span" fontWeight="semibold">{p.name}</Text>
        </InlineStack>
      ),
    },
    {
      key: 'collection', heading: 'Collection', sortValue: (p) => p.collection || '',
      render: (p) => (ctx.isEditingAllowed()
        ? <Dropdown size="slim" variant="tertiary" placeholder="—" options={[{ value: '', label: '—' }, ...COLLECTIONS]} value={p.collection || ''} onChange={(v) => ctx.saveProductCollection(p.id, v)} />
        : p.collection || '—'),
    },
    { key: 'price', heading: 'Price (Rs)', alignment: 'end', sortValue: (p) => Number(p.price) || 0, render: (p) => money(Number(p.price) || 0) },
    {
      key: 'total_quantity', heading: 'Total Stock', sortValue: (p) => p.total_quantity || 0,
      render: (p) => {
        const count = (p.variants || []).length;
        return (
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Badge tone={STOCK_TONE[productStockStatus(p)]}>{String(p.total_quantity || 0)}</Badge>
            {count > 0 && <Text as="span" tone="subdued">in stock · {count} variant{count === 1 ? '' : 's'}</Text>}
          </InlineStack>
        );
      },
    },
    {
      key: 'status', heading: 'Status', sortValue: (p) => productStockStatus(p),
      render: (p) => <Badge tone={STOCK_TONE[productStockStatus(p)]}>{STOCK_STATUS_LABELS[productStockStatus(p)]}</Badge>,
    },
    { key: 'unitCost', heading: 'Cost per Unit', alignment: 'end', sortValue: (p) => productUnitCost(p), render: unitCostLabel },
    { key: 'stockValue', heading: 'Value', alignment: 'end', sortValue: (p) => productStockValue(p), render: (p) => `PKR ${formatAmount(productStockValue(p))}` },
    {
      key: 'actions', heading: 'Actions', alignment: 'end',
      render: (p) => (
        <InlineStack gap="100" blockAlign="center" align="end" wrap={false}>
          <Button icon={ViewIcon} size="slim" accessibilityLabel="View product details" onClick={() => ctx.openProductDetails(p)} />
          <RowActions items={[
            { content: 'View details', onAction: () => ctx.openProductDetails(p) },
            { content: (p.variants || []).length ? 'Update variant price' : 'Update cost price', onAction: () => ctx.openEditVariantCosts(p) },
            { content: 'Adjust stock', onAction: () => ctx.openAdjustStock(p) },
            { content: 'View history', onAction: () => ctx.openCostHistory(p) },
          ]} />
        </InlineStack>
      ),
    },
  ];
}
