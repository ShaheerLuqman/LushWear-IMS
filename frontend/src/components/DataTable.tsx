// The app's table: Polaris IndexTable inside the shared .table-card frame (Orders is the
// reference look), with client-side sort, optional pagination/selection, a loading panel,
// an empty row, optional group (subheader) rows and a pinned footer row.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IndexTable, Pagination, useIndexResourceState, type IndexTableProps } from '@shopify/polaris';

export type SortValue = string | number | null | undefined;

export interface DataColumn<T> {
  key: string;
  heading: ReactNode;
  alignment?: 'start' | 'center' | 'end';
  render: (row: T, index: number) => ReactNode;
  /** Present = sortable. */
  sortValue?: (row: T) => SortValue;
  /** Cell for the footer row (totals etc.), rendered only when any column defines one. */
  footer?: ReactNode;
  /** Cell for the filter subheader row under the headings, shown while `showFilters`. */
  filter?: ReactNode;
}

export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  rowId: (row: T) => string;
  resourceName: { singular: string; plural: string };
  loading?: boolean;
  emptyMessage?: string;
  pageSize?: number;
  initialSort?: { key: string; direction: 'ascending' | 'descending' };
  /** Enables the checkbox column; selection is reported as row ids. */
  onSelectionChange?: (ids: string[]) => void;
  rowTone?: (row: T) => 'subdued' | 'success' | 'warning' | 'critical' | undefined;
  /** Rows for which this returns content render as a full-width group header instead. */
  groupRow?: (row: T) => ReactNode | null;
  /** Id of a row to scroll to and flash once (e.g. arriving via a "go to" link). */
  flashRowId?: string | null;
  /** Rendered between the rows and the pagination (e.g. a selection summary bar). */
  below?: ReactNode;
  /** Rendered above the table inside the card, right-aligned (e.g. filter toggle/clear). */
  toolbar?: ReactNode;
  showFilters?: boolean;
}

function cellClass(col: { alignment?: DataColumn<never>['alignment'] }): string | undefined {
  return col.alignment === 'end' ? 'table-cell--end' : col.alignment === 'center' ? 'table-cell--center' : undefined;
}

function compare(a: SortValue, b: SortValue): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function DataTable<T>({
  columns, rows, rowId, resourceName, loading, emptyMessage = 'Nothing to show', pageSize, initialSort,
  onSelectionChange, rowTone, groupRow, flashRowId, below, toolbar, showFilters,
}: DataTableProps<T>) {
  const [sort, setSort] = useState(() => {
    const index = initialSort ? columns.findIndex((c) => c.key === initialSort.key) : -1;
    return index >= 0 ? { index, direction: initialSort!.direction } : null;
  });
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const col = sort ? columns[sort.index] : undefined;
    if (!col?.sortValue) return rows;
    const dir = sort!.direction === 'ascending' ? 1 : -1;
    // Group rows aren't sortable data; keep them in place only when nothing is sorted.
    return [...rows].filter((r) => !groupRow?.(r)).sort((a, b) => dir * compare(col.sortValue!(a), col.sortValue!(b)));
  }, [rows, sort, columns, groupRow]);

  const pageCount = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  useEffect(() => { if (page > pageCount - 1) setPage(0); }, [page, pageCount]);
  const pageRows = pageSize ? sorted.slice(page * pageSize, (page + 1) * pageSize) : sorted;

  const resources = useMemo(() => rows.map((r) => ({ id: rowId(r) })), [rows, rowId]);
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(resources);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => { onSelectionChangeRef.current?.(selectedResources); }, [selectedResources]);

  useEffect(() => {
    if (!flashRowId) return;
    const el = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(flashRowId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('table-row-flash');
    const t = setTimeout(() => el.classList.remove('table-row-flash'), 2400);
    return () => clearTimeout(t);
  }, [flashRowId, pageRows]);

  const hasFooter = columns.some((c) => c.footer !== undefined);
  const selectable = !!onSelectionChange;

  return (
    <div className="table-card">
      {toolbar && <div className="table-card-toolbar">{toolbar}</div>}
      <IndexTable
        resourceName={resourceName}
        // itemCount 0 makes Polaris swap the whole table (headings included) for its own
        // empty state - keep the headings and show the empty message as a row instead.
        itemCount={pageRows.length || 1}
        selectable={selectable}
        selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
        onSelectionChange={handleSelectionChange}
        headings={columns.map((c) => ({ title: c.heading, alignment: c.alignment })) as IndexTableProps['headings']}
        sortable={columns.map((c) => !!c.sortValue)}
        sortColumnIndex={sort?.index}
        sortDirection={sort?.direction}
        onSort={(index, direction) => setSort({ index, direction })}
        loading={loading}
      >
        {showFilters && (
          <IndexTable.Row id="__filters__" position={-2} rowType="subheader" hideSelectable>
            {columns.map((col) => <IndexTable.Cell key={col.key}>{col.filter}</IndexTable.Cell>)}
          </IndexTable.Row>
        )}
        {pageRows.length === 0 && !loading && (
          <IndexTable.Row id="__empty__" position={-1} hideSelectable>
            <IndexTable.Cell colSpan={columns.length + (selectable ? 1 : 0)}>
              <div className="table-empty">{emptyMessage}</div>
            </IndexTable.Cell>
          </IndexTable.Row>
        )}
        {pageRows.map((row, index) => {
          const id = rowId(row);
          const group = groupRow?.(row);
          if (group) {
            return (
              <IndexTable.Row id={id} key={id} position={index} rowType="subheader" hideSelectable>
                <IndexTable.Cell colSpan={columns.length + (selectable ? 1 : 0)}><div data-row-id={id}>{group}</div></IndexTable.Cell>
              </IndexTable.Row>
            );
          }
          return (
            <IndexTable.Row id={id} key={id} position={index} selected={selectedResources.includes(id)} tone={rowTone?.(row)} onClick={() => {}}>
              {columns.map((col, ci) => (
                <IndexTable.Cell key={col.key}>
                  <div data-row-id={ci === 0 ? id : undefined} className={cellClass(col)}>{col.render(row, index)}</div>
                </IndexTable.Cell>
              ))}
            </IndexTable.Row>
          );
        })}
        {hasFooter && pageRows.length > 0 && (
          <IndexTable.Row id="__footer__" position={pageRows.length} rowType="subheader" hideSelectable>
            {columns.map((col) => <IndexTable.Cell key={col.key}><div className={cellClass(col)}>{col.footer}</div></IndexTable.Cell>)}
          </IndexTable.Row>
        )}
      </IndexTable>
      {below}
      {pageSize && (
        <div className="table-pagination">
          <Pagination
            type="table"
            hasNext={page < pageCount - 1}
            hasPrevious={page > 0}
            onNext={() => setPage((p) => p + 1)}
            onPrevious={() => setPage((p) => p - 1)}
            label={`${sorted.length === 0 ? 0 : page * pageSize + 1}-${Math.min((page + 1) * pageSize, sorted.length)} of ${sorted.length}`}
          />
        </div>
      )}
    </div>
  );
}
