// Dashboard: product/stock summary + inventory value by collection.
import { useEffect, useMemo, useState } from 'react';
import { BlockStack, Spinner, Text } from '@shopify/polaris';
import { apiJson } from '../../api';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { MetricsStrip } from '../../components/MetricsStrip';
import { StatCardGrid } from '../../components/StatCardGrid';
import type { Product } from '../../logic/products';

/** Sums each variant's own cost_price (falling back to the product's). */
function productCostValue(p: Product): number {
  const variants = p.variants || [];
  if (variants.length === 0) return (parseFloat(String(p.cost_price)) || 0) * (p.total_quantity || 0);
  return variants.reduce((sum, v) => sum + ((parseFloat(String(v.cost_price ?? p.cost_price)) || 0) * (v.quantity || 0)), 0);
}

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString()}`;

export function DashboardPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [returnedDeliveryCharges, setReturnedDeliveryCharges] = useState('—');

  useEffect(() => {
    apiJson<Product[]>('/products/', { fallback: 'Failed to fetch products' })
      .then(setProducts)
      .catch((error) => { console.error('Error loading products:', error); setProducts([]); });
    apiJson<{ sum: number }>('/orders/returned-delivery-charges-sum')
      .then((data) => setReturnedDeliveryCharges(rs(parseFloat(String(data.sum)) || 0)))
      .catch((error) => { console.error('Error fetching returned delivery charges sum:', error); });
  }, []);

  usePageHeader({ title: 'Dashboard' });

  const collections = useMemo(() => {
    if (!products) return [];
    const agg = new Map<string, { count: number; value: number }>();
    for (const p of products) {
      const label = (p.collection != null ? String(p.collection) : '').trim() || 'Uncategorized';
      const row = agg.get(label) || { count: 0, value: 0 };
      row.count += 1;
      row.value += productCostValue(p);
      agg.set(label, row);
    }
    return [...agg.entries()].map(([collection, data]) => ({ collection, ...data })).sort((a, b) => {
      if (a.collection === 'Uncategorized') return 1;
      if (b.collection === 'Uncategorized') return -1;
      return a.collection.localeCompare(b.collection, undefined, { sensitivity: 'base' });
    });
  }, [products]);

  if (!products) return <div className="page-loading"><Spinner size="small" /><Text as="span" tone="subdued">Loading dashboard...</Text></div>;

  const totalProducts = products.length;
  const totalVariantRows = products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);
  const totalStock = products.reduce((sum, p) => sum + (p.total_quantity || 0), 0);
  const totalValue = products.reduce((sum, p) => sum + productCostValue(p), 0);

  return (
    <BlockStack gap="400">
      <MetricsStrip
        label="Inventory summary"
        tiles={[
          { label: 'Total Products', value: totalProducts.toLocaleString() },
          { label: 'Total variants', value: (totalProducts + totalVariantRows).toLocaleString() },
          { label: 'Items in Stock', value: totalStock.toLocaleString() },
          { label: 'Total Value', value: rs(totalValue) },
          { label: 'Delivery charges (returned orders)', value: returnedDeliveryCharges },
        ]}
      />
      <Text as="h2" variant="headingSm">Inventory by collection</Text>
      {collections.length === 0
        ? <Text as="p" tone="subdued">No products to show.</Text>
        : <StatCardGrid tiles={collections.map((c) => ({ label: c.collection, value: rs(c.value), detail: c.count === 1 ? '1 product' : `${c.count.toLocaleString()} products` }))} />}
    </BlockStack>
  );
}
