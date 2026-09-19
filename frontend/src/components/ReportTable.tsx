// Static, read-only table for reports inside modals/cards (Polaris DataTable).
import { DataTable as PolarisDataTable, type DataTableProps } from '@shopify/polaris';

export function ReportTable({ headings, rows, numeric = [], emptyMessage = 'Nothing to show' }: {
  headings: string[];
  rows: DataTableProps['rows'];
  /** Indices of right-aligned numeric columns. */
  numeric?: number[];
  emptyMessage?: string;
}) {
  const types = headings.map((_, i) => (numeric.includes(i) ? 'numeric' : 'text')) as DataTableProps['columnContentTypes'];
  return (
    <div className="report-table">
      <PolarisDataTable
        columnContentTypes={types} headings={headings} rows={rows.length ? rows : [[emptyMessage, ...headings.slice(1).map(() => '')]]}
        increasedTableDensity verticalAlign="middle"
      />
    </div>
  );
}
