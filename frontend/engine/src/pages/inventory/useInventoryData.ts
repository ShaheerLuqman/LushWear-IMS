// Products load + inventory summary stat cards. Ported from data-api.js's
// loadProducts and inventory.js's loadInventorySummary/renderInventoryStats.
import { useCallback, useState } from 'react';
import { apiJson } from '../../api';
import type { Product } from '../../logic/products';

export interface InventorySummaryField {
  current: number | null;
  previous: number | null;
}
export interface InventorySummary {
  current: Record<string, number>;
  previous: Record<string, number> | null;
}

export function useInventoryData() {
  const [products, setProducts] = useState<Product[]>([]);
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProducts = useCallback(async () => {
    try {
      const rows = await apiJson<Product[]>('/products/', { fallback: 'Failed to fetch products' });
      rows.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
      setProducts(rows);
    } catch (error) {
      console.error('Error loading products:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await apiJson<InventorySummary>('/products/inventory-summary', { fallback: 'Failed to load inventory summary' }));
    } catch (error) {
      // The cards are supporting detail; the grid is still usable without them.
      console.error('Error loading inventory summary:', error);
    }
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([loadProducts(), loadSummary()]);
  }, [loadProducts, loadSummary]);

  return { products, setProducts, summary, loading, loadProducts, loadSummary, reload };
}
