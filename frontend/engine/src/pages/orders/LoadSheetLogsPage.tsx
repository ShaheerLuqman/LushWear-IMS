// Load Sheet Logs: every generated load sheet, with re-download/delete. Ported from
// orders-actions.js's loadLoadSheetLogs/deleteLoadSheetLog/downloadLoadSheetLogPdf.
import { useEffect } from 'react';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { useConfirm } from '../../components/ConfirmContext';
import { formatDateTimeDDMMYYYY } from '../../logic/shared';
import { useLoadSheetLogs } from './useLoadSheetLogs';

export function LoadSheetLogsPage() {
  const confirm = useConfirm();
  const { logs, loading, load, deleteLog, downloadLogPdf } = useLoadSheetLogs();

  useEffect(() => { load(); }, [load]);

  usePageHeader({
    title: 'Load Sheet Logs',
    actions: <button type="button" className="btn btn-secondary" onClick={load}>Refresh</button>,
  });

  async function onDelete(logId: string) {
    const confirmed = await confirm({
      title: 'Delete Load Sheet Log', message: 'Are you sure you want to delete this load sheet log? This cannot be undone.',
      confirmText: 'Delete', danger: true,
    });
    if (!confirmed) return;
    if (await deleteLog(logId)) load();
  }

  return (
    <div className="load-sheet-logs-container">
      <div className="load-sheet-logs-table-wrap">
        <table className="load-sheet-logs-table">
          <thead>
            <tr><th>Assignment #</th><th>Rider</th><th>Date time</th><th>Order numbers</th><th>DC</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const orderNumbers = log.order_numbers || [];
              const display = orderNumbers.length <= 3 ? orderNumbers.join(', ') : orderNumbers.slice(0, 3).join(', ') + '...';
              const dc = log.delivery_charge != null && log.delivery_charge !== '' ? Number(log.delivery_charge).toFixed(2) : '—';
              return (
                <tr key={log.id}>
                  <td>{log.assignment_number || ''}</td>
                  <td>{log.rider_name || ''}</td>
                  <td>{log.created_at ? formatDateTimeDDMMYYYY(log.created_at) : ''}</td>
                  <td className="load-sheet-order-numbers-cell" title={orderNumbers.join(', ') || '—'}>{display || '—'}</td>
                  <td>{dc}</td>
                  <td className="load-sheet-actions-cell">
                    <button type="button" className="btn btn-secondary btn-sm" title="Download PDF" onClick={() => downloadLogPdf(log.id, log.rider_name, log.created_at)}><i className="fas fa-download" aria-hidden="true" /></button>
                    <button type="button" className="btn btn-danger btn-sm" title="Delete" onClick={() => onDelete(log.id)}><i className="fas fa-trash" aria-hidden="true" /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && logs.length === 0 && <p className="load-sheet-logs-empty">No load sheet logs yet.</p>}
      </div>
    </div>
  );
}
