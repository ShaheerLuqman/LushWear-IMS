// Products grid column definitions - ported from orders-grid.js's
// buildProductsColumnDefs/createProductRowMenu/createProductViewButton.
import { createElement, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ColDef } from 'ag-grid-community';
import { makeCheckboxFloatingFilter, makeCheckboxSetFilter } from '../../gridFilters';
import { escapeHtml, formatAmount } from '../../logic/shared';
import { productStockStatus, productStockValue, productUnitCost, STOCK_STATUS_LABELS, type Product } from '../../logic/products';

function htmlRenderer(fn: (params: any) => string) {
  return (params: any) => createElement('span', { dangerouslySetInnerHTML: { __html: fn(params) } });
}

export interface ProductsColumnsCtx {
  isEditingAllowed: () => boolean;
  saveProductCollection: (productId: string, collection: string) => void;
  openProductDetails: (product: Product) => void;
  openEditVariantCosts: (product: Product) => void;
  openAdjustStock: (product: Product) => void;
  openCostHistory: (product: Product) => void;
  getProducts: () => Product[];
}

function ProductViewButton({ data, ctx }: { data: Product; ctx: ProductsColumnsCtx }) {
  if (!data?.id) return null;
  return (
    <div className="bill-cell-center">
      <button type="button" className="product-view-btn" title="View product details" onClick={() => ctx.openProductDetails(data)}>
        <i className="fa-solid fa-eye" /><span>View</span>
      </button>
    </div>
  );
}

const ROW_MENU_WIDTH = 190;

function ProductRowMenu({ data, ctx }: { data: Product; ctx: ProductsColumnsCtx }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.product-menu-panel') && target !== btnRef.current) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!data?.id) return null;

  function toggle() {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 2, left: Math.max(rect.right - ROW_MENU_WIDTH, 8) });
    }
    setOpen((v) => !v);
  }

  const item = (label: string, icon: string, onClick: () => void) => (
    <div className="folio-dropdown-option" onClick={() => { setOpen(false); onClick(); }}>
      <i className={`fa-solid ${icon}`} /><span>{label}</span>
    </div>
  );

  return (
    <div className="bill-cell-center">
      <button ref={btnRef} type="button" className={'product-menu-btn' + (open ? ' open' : '')} title="More actions" onClick={toggle}>
        <i className="fa-solid fa-ellipsis" />
      </button>
      {open && createPortal(
        // Portaled to <body>, not left as a normal cell child - AG Grid rows are
        // translate()'d for virtualization, which makes a `position: fixed` descendant
        // clip/mis-position against that row's containing block instead of the viewport.
        <div className="folio-dropdown-panel product-menu-panel" style={pos}>
          {item('View details', 'fa-circle-info', () => ctx.openProductDetails(data))}
          {item((data.variants || []).length ? 'Update variant price' : 'Update cost price', 'fa-tag', () => ctx.openEditVariantCosts(data))}
          {item('Adjust stock', 'fa-boxes-stacked', () => ctx.openAdjustStock(data))}
          {item('View history', 'fa-clock-rotate-left', () => ctx.openCostHistory(data))}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function buildProductsColumnDefs(ctx: ProductsColumnsCtx): ColDef[] {
  const CollectionSetFilter = makeCheckboxSetFilter((row: Product) => row.collection || '');
  const CollectionFloatingFilter = makeCheckboxFloatingFilter(
    () => {
      const values = new Set<string>(['']);
      ctx.getProducts().forEach((p) => values.add(p.collection || ''));
      return ['', ...Array.from(values).filter((v) => v !== '').sort((a, b) => a.localeCompare(b))];
    },
    (v: string) => (v === '' ? '—' : v),
  );
  const StockStatusSetFilter = makeCheckboxSetFilter(productStockStatus);
  const StockStatusFloatingFilter = makeCheckboxFloatingFilter(() => ['in', 'low', 'out'], (v: string) => STOCK_STATUS_LABELS[v]);

  return [
    {
      headerName: '', colId: 'select', width: 52, minWidth: 52, maxWidth: 52,
      checkboxSelection: true, headerCheckboxSelection: true, headerCheckboxSelectionFilteredOnly: true,
      sortable: false, filter: false, floatingFilter: false, suppressSizeToFit: true,
    },
    {
      headerName: 'Product', field: 'name', flex: 2, minWidth: 220,
      filter: 'agTextColumnFilter', filterParams: { filterOptions: ['contains', 'startsWith', 'endsWith'], defaultOption: 'contains' },
      cellRenderer: htmlRenderer((params: any) => {
        const img = params.data?.image_url
          ? `<img src="${escapeHtml(params.data.image_url)}" alt="">`
          : '<div class="grid-image-placeholder">No Img</div>';
        return `<div class="grid-product-cell"><div class="grid-image-cell">${img}</div><span class="grid-product-name">${escapeHtml(params.value || '')}</span></div>`;
      }),
    },
    {
      headerName: 'Collection', field: 'collection', width: 130,
      filter: CollectionSetFilter, floatingFilterComponent: CollectionFloatingFilter,
      valueGetter: (params: any) => params.data?.collection ?? '',
      valueFormatter: (params: any) => (params.value == null || params.value === '' ? '—' : params.value),
      editable: () => ctx.isEditingAllowed(),
      cellStyle: { cursor: 'pointer' } as any,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: ['', 'Cami Sets', 'Linen PJs', 'Pajama T-Shirt', 'Silk Collection', 'Trousers'] },
      valueSetter: (params: any) => {
        const raw = params.newValue === '' ? '' : params.newValue;
        params.data.collection = raw;
        ctx.saveProductCollection(params.data.id, raw);
        return true;
      },
    },
    {
      headerName: 'Price (Rs)', field: 'price', width: 100, filter: 'agNumberColumnFilter',
      valueFormatter: (params: any) => (parseFloat(params.value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    },
    {
      headerName: 'Total Stock', field: 'total_quantity', width: 200, filter: 'agNumberColumnFilter',
      cellRenderer: htmlRenderer((params: any) => {
        const badge = `<span class="grid-quantity-badge ${productStockStatus(params.data)}">${params.value || 0}</span>`;
        const count = (params.data?.variants || []).length;
        if (!count) return badge;
        return `${badge}<span class="grid-stock-variants">in stock · ${count} variant${count === 1 ? '' : 's'}</span>`;
      }),
    },
    {
      headerName: 'Status', colId: 'stockStatus', width: 130,
      filter: StockStatusSetFilter, floatingFilterComponent: StockStatusFloatingFilter,
      valueGetter: (params: any) => productStockStatus(params.data),
      valueFormatter: (params: any) => STOCK_STATUS_LABELS[params.value] || '',
      cellRenderer: htmlRenderer((params: any) => `<span class="grid-status-badge ${params.value}">${STOCK_STATUS_LABELS[params.value]}</span>`),
    },
    {
      headerName: 'Cost per Unit', colId: 'unitCost', width: 140, filter: 'agNumberColumnFilter',
      valueGetter: (params: any) => productUnitCost(params.data),
      // Null means the variants carry different costs, not "no cost".
      valueFormatter: (params: any) => (params.value != null ? `PKR ${formatAmount(params.value)}` : ((params.data?.variants || []).length ? 'Mixed' : '—')),
    },
    {
      headerName: 'Value', colId: 'stockValue', width: 150, filter: 'agNumberColumnFilter',
      valueGetter: (params: any) => productStockValue(params.data),
      valueFormatter: (params: any) => `PKR ${formatAmount(params.value)}`,
    },
    {
      headerName: '', colId: 'view', width: 92, minWidth: 92, filter: false, sortable: false,
      cellRenderer: (params: any) => <ProductViewButton data={params.data} ctx={ctx} />,
    },
    {
      headerName: 'Actions', colId: 'moreActions', width: 110, filter: false, sortable: false,
      cellRenderer: (params: any) => <ProductRowMenu data={params.data} ctx={ctx} />,
    },
  ];
}
