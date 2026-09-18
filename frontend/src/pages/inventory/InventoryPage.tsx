// Inventory (Products) view: stat cards, toolbar-driven grid filters, the AG Grid
// itself, and the product details/adjust stock/cost history/edit cost modals.
// Ported from inventory.js + orders-grid.js's products grid + modals-forms.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import * as XLSX from 'xlsx';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../toast/ToastContext';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { HeaderButton } from '../../components/HeaderButton';
import { formatAmount, formatRelativeTime } from '../../logic/shared';
import { getLastShopifyProductSyncAt, syncShopifyProducts } from '../../shopifySync';
import type { Product } from '../../logic/products';
import { useInventoryData } from './useInventoryData';
import { buildProductsColumnDefs, type ProductsColumnsCtx } from './productsColumns';
import {
  AdjustStockModal, BulkUpdateCostPriceModal, CostHistoryModal, EditVariantCostsModal, ProductDetailsModal,
} from './ProductModals';
import { PRODUCTS_CHANGED_EVENT } from '../../eventsStream';
import { Dropdown } from '../../components/Dropdown';

const FILTERS_VISIBLE_KEY = 'lushwear_inventory_filters_visible';

function inventoryFiltersVisible(): boolean {
  try { return localStorage.getItem(FILTERS_VISIBLE_KEY) === '1'; } catch { return false; }
}

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
  const [collectionFilter, setCollectionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [filtersVisible, setFiltersVisible] = useState(inventoryFiltersVisible);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastProductSyncAt, setLastProductSyncAt] = useState<number | null>(getLastShopifyProductSyncAt);

  // Keeps the "Synced X ago" label ticking forward without a real update.
  useEffect(() => {
    const id = setInterval(() => setLastProductSyncAt(getLastShopifyProductSyncAt()), 30000);
    return () => clearInterval(id);
  }, []);

  const gridApiRef = useRef<GridApi | null>(null);
  const productsRef = useRef(products);
  productsRef.current = products;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      } catch (error) {
        console.error('Error saving collection:', error);
        showToast('Failed to save collection', 'error');
      }
    })();
  }, [showToast]);

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
    getProducts: () => productsRef.current,
  }), [isEditingAllowed, saveProductCollection, showToast]);

  const columnDefs = useMemo(() => buildProductsColumnDefs(columnsCtx), [columnsCtx]);

  const defaultColDef = useMemo(() => ({
    sortable: true, resizable: true, filter: true, floatingFilter: filtersVisible, minWidth: 80,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filtersVisible]);

  function onGridReady(e: GridReadyEvent) {
    gridApiRef.current = e.api;
  }

  function onSelectionChanged() {
    const api = gridApiRef.current;
    setSelectedIds(api ? api.getSelectedRows().map((r) => r.id).filter(Boolean) : []);
  }

  function applyToolbarFilters(nextCollection: string, nextStatus: string) {
    const api = gridApiRef.current;
    if (!api) return;
    const model = { ...(api.getFilterModel() || {}) };
    if (nextCollection) model.collection = { values: [nextCollection] }; else delete model.collection;
    if (nextStatus) model.stockStatus = { values: [nextStatus] }; else delete model.stockStatus;
    api.setFilterModel(model);
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      gridApiRef.current?.setGridOption('quickFilterText', value);
    }, 200);
  }

  function toggleFilters() {
    const next = !filtersVisible;
    setFiltersVisible(next);
    try { localStorage.setItem(FILTERS_VISIBLE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  }

  function exportToExcel() {
    const api = gridApiRef.current;
    if (!api) return;
    const columns = (api.getAllGridColumns() || []).map((col) => {
      const colDef: any = col.getColDef ? col.getColDef() : null;
      if (colDef?.checkboxSelection) return null;
      const field = colDef?.field || col.getColId?.();
      const header = colDef?.headerName || field;
      if (!header) return null;
      return { header, col };
    }).filter(Boolean) as Array<{ header: string; col: any }>;
    const rows: Record<string, unknown>[] = [];
    api.forEachNodeAfterFilterAndSort((node) => {
      if (!node?.data) return;
      const out: Record<string, unknown> = {};
      for (const c of columns) {
        let value = api.getValue(c.col, node);
        if (value == null) { out[c.header] = ''; continue; }
        const colDef = c.col.getColDef?.();
        if (typeof colDef?.valueFormatter === 'function') value = colDef.valueFormatter({ value, data: node.data });
        out[c.header] = Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : value;
      }
      rows.push(out);
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Products');
    XLSX.writeFile(workbook, `products-${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast('Excel exported', 'success');
  }

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    if (loading) api.showLoadingOverlay();
    else if (products.length === 0) api.showNoRowsOverlay();
    else api.hideOverlay();
  }, [loading, products]);

  function closeModal() { setModal(null); }
  async function onModalDone() { closeModal(); await reload(); }

  async function onSyncShopify() {
    setSyncing(true);
    try {
      const result = await syncShopifyProducts();
      const p = result.products || {}, v = result.variants || {};
      showToast(`Sync complete! Products: ${p.created || 0} created, ${p.updated || 0} updated. Variants: ${v.created || 0} created, ${v.updated || 0} updated.`, 'success');
      setLastProductSyncAt(getLastShopifyProductSyncAt());
      await reload();
    } catch (error: any) {
      showToast(error?.message || 'Failed to sync products from Shopify', 'error');
    } finally {
      setSyncing(false);
    }
  }

  usePageHeader({
    title: 'Inventory',
    actions: (
      <>
        <HeaderButton icon={<i className="fa-solid fa-arrow-up-from-bracket" />} onClick={exportToExcel}>Export</HeaderButton>
        <HeaderButton variant="primary" loading={syncing} onClick={onSyncShopify}>Sync with Shopify</HeaderButton>
        {!syncing && lastProductSyncAt != null && (
          <span className="orders-sync-status">Synced {formatRelativeTime(lastProductSyncAt)}</span>
        )}
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
      <div className="stats-grid inventory-stats">
        {STAT_FIELDS.map(({ key, label, format }) => {
          const delta = statDelta(current?.[key], previous?.[key]);
          return (
            <div className={`stat-card inventory-stat inventory-stat--${key}`} key={key}>
              <div className="inventory-stat-top">
                <span className="stat-label">{label}</span>
              </div>
              <span className="stat-value">{current?.[key] == null ? '—' : format(current[key])}</span>
              {delta && <span className={`inventory-delta-${delta.dir}`}>{delta.text}</span>}
            </div>
          );
        })}
      </div>

      <div className="inventory-panel">
        <div className="inventory-toolbar">
          <div className="inventory-search-wrap">
            <i className="fa-solid fa-magnifying-glass inventory-search-icon" />
            <input type="text" className="inventory-search-input" placeholder="Search products..." autoComplete="off" value={search} onChange={(e) => onSearchChange(e.target.value)} />
          </div>
          <Dropdown searchable options={[{ value: '', label: 'All Collections' }, ...collectionOptions]} value={collectionFilter} onChange={(v) => { setCollectionFilter(v); applyToolbarFilters(v, statusFilter); }} />
          <Dropdown
            options={[{ value: '', label: 'All Status' }, { value: 'in', label: 'In Stock' }, { value: 'low', label: 'Low Stock' }, { value: 'out', label: 'Out of Stock' }]}
            value={statusFilter} onChange={(v) => { setStatusFilter(v); applyToolbarFilters(collectionFilter, v); }}
          />
          <button type="button" className="btn btn-secondary inventory-filters-toggle" aria-pressed={filtersVisible} title="Show per-column filters" onClick={toggleFilters}>
            <i className="fa-solid fa-sliders" /><span>Filters</span>
          </button>
        </div>
        <div className="ag-theme-alpine grid-container">
          <AgGridReact
            columnDefs={columnDefs}
            rowData={products}
            rowSelection="multiple"
            suppressRowClickSelection
            defaultColDef={defaultColDef}
            animateRows
            pagination={false}
            domLayout="normal"
            suppressCellFocus={false}
            stopEditingWhenCellsLoseFocus
            getRowId={(p) => p.data.id}
            onGridReady={onGridReady}
            onSelectionChanged={onSelectionChanged}
          />
        </div>
      </div>

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
