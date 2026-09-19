// Load Sheet Logs: every generated load sheet, with re-download/delete.
import { useEffect } from 'react';
import { Button, InlineStack, Text } from '@shopify/polaris';
import { DeleteIcon, ExportIcon } from '@shopify/polaris-icons';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { useConfirm } from '../../components/ConfirmContext';
import { HeaderButton } from '../../components/HeaderButton';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { formatDateTimeDDMMYYYY } from '../../logic/shared';
import { useLoadSheetLogs } from './useLoadSheetLogs';
import type { LoadSheetLog } from '../../logic/loadSheets';

export function LoadSheetLogsPage() {
  const confirm = useConfirm();
  const { logs, loading, load, deleteLog, downloadLogPdf } = useLoadSheetLogs();

  useEffect(() => { load(); }, [load]);

  usePageHeader({ title: 'Load Sheet Logs', actions: <HeaderButton onClick={load}>Refresh</HeaderButton> });

  async function onDelete(logId: string) {
    const confirmed = await confirm({
      title: 'Delete Load Sheet Log', message: 'Are you sure you want to delete this load sheet log? This cannot be undone.',
      confirmText: 'Delete', danger: true,
    });
    if (confirmed && await deleteLog(logId)) load();
  }

  const columns: DataColumn<LoadSheetLog>[] = [
    { key: 'assignment_number', heading: 'Assignment #', render: (l) => <Text as="span" fontWeight="semibold">{l.assignment_number || ''}</Text>, sortValue: (l) => l.assignment_number },
    { key: 'rider_name', heading: 'Rider', render: (l) => l.rider_name || '', sortValue: (l) => l.rider_name },
    { key: 'created_at', heading: 'Date time', render: (l) => (l.created_at ? formatDateTimeDDMMYYYY(l.created_at) : ''), sortValue: (l) => l.created_at },
    {
      key: 'order_numbers', heading: 'Order numbers',
      render: (l) => {
        const nums = (l.order_numbers || []).map(String);
        return <span title={nums.join(', ') || '—'}>{nums.length <= 3 ? nums.join(', ') || '—' : `${nums.slice(0, 3).join(', ')}… (${nums.length})`}</span>;
      },
    },
    { key: 'dc', heading: 'DC', alignment: 'end', render: (l) => (l.delivery_charge != null && l.delivery_charge !== '' ? Number(l.delivery_charge).toFixed(2) : '—'), sortValue: (l) => Number(l.delivery_charge) || 0 },
    {
      key: 'actions', heading: 'Actions', alignment: 'end',
      render: (l) => (
        <InlineStack gap="100" align="end" wrap={false}>
          <Button icon={ExportIcon} size="slim" accessibilityLabel="Download PDF" onClick={() => downloadLogPdf(l.id, l.rider_name, l.created_at)} />
          <Button icon={DeleteIcon} size="slim" tone="critical" accessibilityLabel="Delete" onClick={() => onDelete(l.id)} />
        </InlineStack>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns} rows={logs} rowId={(l) => l.id} loading={loading} initialSort={{ key: 'created_at', direction: 'descending' }}
      resourceName={{ singular: 'load sheet', plural: 'load sheets' }} emptyMessage="No load sheet logs yet."
    />
  );
}
