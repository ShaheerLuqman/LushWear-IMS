// Inventory (Products) view: summary strip, toolbar filters, the products table, and the
// product details/adjust stock/cost history/edit cost modals.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { TextField, Tooltip } from '@shopify/polaris';
import { Filter, FilterX } from 'lucide-react';
import { HeaderButton } from '../../components/HeaderButton';
import { DataTable } from '../../components/DataTable';
import { MetricsStrip } from '../../components/MetricsStrip';
import { formatAmount, rowMatchesQuery } from '../../logic/shared';
import { syncShopifyProducts } from '../../shopifySync';
import { productStockStatus, productStockValue, productUnitCost, STOCK_STATUS_LABELS, type Product } from '../../logic/products';
import { useInventoryData } from './useInventoryData';
import { buildProductsColumns, type ProductsColumnsCtx } from './productsColumns';
import {
  AdjustStockModal, BulkUpdateCostPriceModal, CostHistoryModal, EditVariantCostsModal, ProductDetailsModal,
} from './ProductModals';
import { PRODUCTS_CHANGED_EVENT } from '../../eventsStream';
import { Dropdown } from '../../components/Dropdown';

type ModalState =
  | { type: 'details' | 'adjustStock' | 'costHistory' | 'editCost'; product: Product }
  | { type: 'bulkCost'; ids: string[] }
  | null;

const STAT_FIELDS: Array<{ key: string; label: string; format: (v: number) => string }> = [
  { key: 'total_products', label: 'Total Products', format: (v) => v.toLocaleString('en-US') },
  { key: 'total_stock', label: 'Total Stock', format: (v) => v.toLocaleString('en-US') },
  { key: 'low_stock_count', label: 'Low Stock Items', format: (v) => v.toLocaleString('en-US') },
  { key: 'out_of_stock_count', label: 'Out of Stock Items', format: (v) => v.toLocaleString('en-US') },
  { key: 'inventory_value', label: 'Inventory Value', format: (v) => `PKR ${formatAmount(v)}` },
];

const STOCK_STATUS_OPTIONS = Object.entries(STOCK_STATUS_LABELS).map(([value, label]) => ({ value, label }));
// Text-filterable columns: what the typed query is matched against, per column key.
const TEXT_FILTER_VALUE: Record<string, (p: Product) => string> = {
  name: (p) => p.name || '',
  price: (p) => String(p.price ?? ''),
  total_quantity: (p) => String(p.total_quantity ?? 0),
  unitCost: (p) => String(productUnitCost(p) ?? ''),
  stockValue: (p) => String(productStockValue(p)),
};

function statDelta(current: number | undefined, previous: number | undefined | null): { text: string; dir: 'up' | 'down' | 'flat' } | null {
  if (previous == null || current == null) return null;
  if (previous === current) return { text: 'No change from last month', dir: 'flat' };
  const up = current > previous;
  const body = previous === 0 ? `${Math.abs(current - previous).toLocaleString('en-US')}` : `${Math.abs(((current - previous) / previous) * 100).toFixed(1)}%`;
  return { text: `${up ? '↑' : '↓'} ${body} from last month`, dir: up ? 'up' : 'down' };
}

export function InventoryPage() {
  const { isEditingAllowed } = useAuth();
  const { showToast } = useToast();
  const { products, summary, loading, reload } = useInventoryData();

  const [search, setSearch] = useState('');
  const [collectionFilter, setCollectionFilter] = useState<string[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string[] | null>(null);
  const [textFilters, setTextFilters] = useState<Record<string, string>>({});
  const [showFilterRow, setShowFilterRow] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => { reload(); }, [reload]);

  // Live push from the backend whenever a product changes anywhere in the app.
  useEffect(() => {
    const onProductsChanged = () => { reload(); };
    window.addEventListener(PRODUCTS_CHANGED_EVENT, onProductsChanged);
    return () => window.removeEventListener(PRODUCTS_CHANGED_EVENT, onProductsChanged);
  }, [reload]);

  const collectionOptions = useMemo(
    () => Array.from(new Set(products.map((p) => p.collection).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b)),
    [products],
  );

  const saveProductCollection = useCallback((productId: string, collection: string) => {
    (async () => {
      try {
        await apiJson(`/products/${productId}`, { method: 'PUT', body: { collection }, fallback: 'Failed to update collection' });
        showToast('Collection updated', 'success');
        reload();
      } catch (error) {
        console.error('Error saving collection:', error);
        showToast('Failed to save collection', 'error');
      }
    })();
  }, [showToast, reload]);

  const columnsCtx: ProductsColumnsCtx = useMemo(() => ({
    isEditingAllowed,
    saveProductCollection,
    openProductDetails: (product) => setModal({ type: 'details', product }),
    openEditVariantCosts: (product) => {
      if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
      setModal({ type: 'editCost', product });
    },
    openAdjustStock: (product) => {
      if (!isEditingAllowed()) { showToast('Editing is locked', 'error', { silent: true }); return; }
      if (!(product.variants || []).length) { showToast('This product has no variants to adjust', 'error', { silent: true }); return; }
      setModal({ type: 'adjustStock', product });
    },
    openCostHistory: (product) => setModal({ type: 'costHistory', product }),
  }), [isEditingAllowed, saveProductCollection, showToast]);

  const columns = useMemo(() => {
    const textFilter = (key: string) => (
      <TextField
        label="" labelHidden autoComplete="off" variant="borderless" size="slim" clearButton placeholder="Search..."
        value={textFilters[key] || ''}
        onChange={(v) => setTextFilters((f) => ({ ...f, [key]: v }))}
        onClearButtonClick={() => setTextFilters((f) => ({ ...f, [key]: '' }))}
      />
    );
    const filters: Record<string, ReactNode> = {
      collection: <Dropdown multiple searchable fullWidth allLabel="All" options={collectionOptions} value={collectionFilter} onChange={setCollectionFilter} />,
      status: <Dropdown multiple fullWidth allLabel="All" options={STOCK_STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} />,
    };
    return buildProductsColumns(columnsCtx).map((c) => ({ ...c, filter: filters[c.key] ?? (TEXT_FILTER_VALUE[c.key] ? textFilter(c.key) : undefined) }));
  }, [columnsCtx, collectionOptions, collectionFilter, statusFilter, textFilters]);

  const activeTextFilters = useMemo(() => Object.entries(textFilters).filter(([, v]) => v.trim()).map(([k, v]) => [TEXT_FILTER_VALUE[k], v.trim().toLowerCase()] as const), [textFilters]);
  const visible = useMemo(() => products.filter((p) => (
    (!collectionFilter || collectionFilter.includes(p.collection || ''))
    && (!statusFilter || statusFilter.includes(productStockStatus(p)))
    && activeTextFilters.every(([get, q]) => get(p).toLowerCase().includes(q))
    && rowMatchesQuery(p, search)
  )), [products, collectionFilter, statusFilter, activeTextFilters, search]);
  const hasFilters = !!(collectionFilter || statusFilter || activeTextFilters.length);
  function clearFilters() { setCollectionFilter(null); setStatusFilter(null); setTextFilters({}); }

  const onSelectionChange = useCallback((ids: string[]) => setSelectedIds(ids), []);

  function closeModal() { setModal(null); }
  async function onModalDone() { closeModal(); await reload(); }

  async function onSyncShopify() {
    setSyncing(true);
    try {
      const result = await syncShopifyProducts();
      const p = result.products || {}, v = result.variants || {};
      showToast(`Sync complete! Products: ${p.created || 0} created, ${p.updated || 0} updated. Variants: ${v.created || 0} created, ${v.updated || 0} updated.`, 'success');
      await reload();
    } catch (error: any) {
      showToast(error?.message || 'Failed to sync products from Shopify', 'error');
    } finally {
      setSyncing(false);
    }
  }

  usePageHeader({
    title: 'Inventory',
    search: { value: search, onChange: setSearch },
    actions: (
      <>
        <HeaderButton variant="primary" loading={syncing} onClick={onSyncShopify}>Sync with Shopify</HeaderButton>
        {selectedIds.length > 0 && (
          <HeaderButton onClick={() => setModal({ type: 'bulkCost', ids: selectedIds })}>Bulk update cost price</HeaderButton>
        )}
      </>
    ),
  });

  const current = summary?.current;
  const previous = summary?.previous;

  return (
    <>
      <MetricsStrip
        label="Inventory summary"
        tiles={STAT_FIELDS.map(({ key, label, format }) => ({
          label, value: current?.[key] == null ? '—' : format(current[key]), detail: statDelta(current?.[key], previous?.[key])?.text,
        }))}
      />
      <DataTable
        columns={columns} rows={visible} rowId={(p) => p.id} loading={loading} onSelectionChange={onSelectionChange}
        initialSort={{ key: 'name', direction: 'ascending' }}
        resourceName={{ singular: 'product', plural: 'products' }} emptyMessage="No products match these filters"
        showFilters={showFilterRow}
        toolbar={(
          <>
            {hasFilters && (
              <Tooltip content="Clear filters">
                <HeaderButton icon={<FilterX size={16} />} accessibilityLabel="Clear filters" onClick={clearFilters} variant="tertiary" />
              </Tooltip>
            )}
            <Tooltip content={showFilterRow ? 'Hide filters' : 'Show filters'}>
              <HeaderButton icon={<Filter size={16} />} accessibilityLabel="Toggle filters" onClick={() => setShowFilterRow((v) => !v)} variant="tertiary" pressed={showFilterRow} />
            </Tooltip>
          </>
        )}
      />

      {modal?.type === 'details' && (
        <ProductDetailsModal
          product={modal.product}
          onClose={closeModal}
          onUpdateCost={(p) => setModal({ type: 'editCost', product: p })}
          onAdjustStock={(p) => setModal({ type: 'adjustStock', product: p })}
          onHistory={(p) => setModal({ type: 'costHistory', product: p })}
        />
      )}
      {modal?.type === 'adjustStock' && <AdjustStockModal product={modal.product} onClose={closeModal} onDone={onModalDone} />}
      {modal?.type === 'costHistory' && <CostHistoryModal product={modal.product} onClose={closeModal} />}
      {modal?.type === 'editCost' && <EditVariantCostsModal product={modal.product} onClose={closeModal} onDone={onModalDone} />}
      {modal?.type === 'bulkCost' && <BulkUpdateCostPriceModal productIds={modal.ids} onClose={closeModal} onDone={onModalDone} />}
    </>
  );
}
