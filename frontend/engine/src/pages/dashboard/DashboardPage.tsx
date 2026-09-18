// Dashboard: product/stock stat cards + inventory value by collection. Ported
// from sync-summary.js's updateDashboard/renderDashboardCollectionsBreakdown.
import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../api';
import { usePageHeader } from '../../layout/PageHeaderContext';
import type { Product } from '../../logic/products';

/** Sums each variant's own cost_price (falling back to the product's), same fallback
 * used in bills.js/orders-grid.js. */
function productCostValue(p: Product): number {
  const variants = p.variants || [];
  if (variants.length === 0) return (parseFloat(String(p.cost_price)) || 0) * (p.total_quantity || 0);
  return variants.reduce((sum, v) => sum + ((parseFloat(String(v.cost_price ?? p.cost_price)) || 0) * (v.quantity || 0)), 0);
}

export function DashboardPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [returnedDeliveryCharges, setReturnedDeliveryCharges] = useState<string>('—');

  useEffect(() => {
    (async () => {
      try {
        setProducts(await apiJson<Product[]>('/products/', { fallback: 'Failed to fetch products' }));
      } catch (error) {
        console.error('Error loading products:', error);
        setProducts([]);
      }
    })();
    (async () => {
      try {
        const data = await apiJson<{ sum: number }>('/orders/returned-delivery-charges-sum');
        setReturnedDeliveryCharges(`Rs ${Math.round(parseFloat(String(data.sum)) || 0).toLocaleString()}`);
      } catch (error) {
        console.error('Error fetching returned delivery charges sum:', error);
        setReturnedDeliveryCharges('—');
      }
    })();
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

  if (!products) {
    return (
      <div className="content-loading"><div className="content-loading-spinner" /><p className="content-loading-text">Loading dashboard...</p></div>
    );
  }

  const totalProducts = products.length;
  const totalVariantRows = products.reduce((sum, p) => sum + (Array.isArray(p.variants) ? p.variants.length : 0), 0);
  const totalStock = products.reduce((sum, p) => sum + (p.total_quantity || 0), 0);
  const totalValue = products.reduce((sum, p) => sum + productCostValue(p), 0);

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total Products</span><span className="stat-value">{totalProducts}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total variants</span><span className="stat-value">{(totalProducts + totalVariantRows).toLocaleString()}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Items in Stock</span><span className="stat-value">{totalStock.toLocaleString()}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Total Value</span><span className="stat-value">Rs {Math.round(totalValue).toLocaleString()}</span></div></div>
        <div className="stat-card"><div className="stat-info"><span className="stat-label">Delivery charges (returned orders)</span><span className="stat-value">{returnedDeliveryCharges}</span></div></div>
      </div>
      <section className="dashboard-collections-section" aria-label="Inventory by collection">
        <div className="dashboard-collections-grid">
          {collections.length === 0 ? (
            <p className="dashboard-collections-empty">No products to show.</p>
          ) : collections.map(({ collection, count, value }) => (
            <div className="stat-card" key={collection}>
              <div className="stat-info">
                <span className="stat-label">{collection}</span>
                <span className="stat-detail">{count === 1 ? '1 product' : `${count.toLocaleString()} products`}</span>
                <span className="stat-value">Rs {Math.round(value).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
