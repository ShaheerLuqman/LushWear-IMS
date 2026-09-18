// Shared between the Load Sheet Logs page and the Generate Load Sheet modal (rider-name
// suggestions + next assignment number). Ported from orders-actions.js's
// fetchLoadSheetRiderNames/loadLoadSheetLogs/updateNextLoadSheetAssignmentNumber.
import { useCallback, useState } from 'react';
import { apiJson, apiRequest } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { loadSheetFilenameFromDateAndRider, nextAssignmentNumberFromLogs, riderNamesFromLogs, type LoadSheetLog } from '../../logic/loadSheets';

export function useLoadSheetLogs() {
  const { showToast } = useToast();
  const [logs, setLogs] = useState<LoadSheetLog[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiJson<LoadSheetLog[]>('/orders/load-sheet-logs', { fallback: 'Failed to load' });
      setLogs(rows);
    } catch (error: any) {
      showToast(error?.message || 'Failed to load load sheet logs', 'error');
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  async function deleteLog(logId: string): Promise<boolean> {
    try {
      await apiRequest(`/orders/load-sheet-logs/${logId}`, { method: 'DELETE', fallback: 'Failed to delete' });
      showToast('Load sheet log deleted', 'success');
      return true;
    } catch (error: any) {
      showToast(error?.message || 'Failed to delete load sheet log', 'error');
      return false;
    }
  }

  async function downloadLogPdf(logId: string, riderName: string | undefined, createdAt: string | undefined): Promise<void> {
    try {
      const response = await apiRequest(`/orders/load-sheet-logs/${logId}/pdf`, { fallback: 'Failed to generate PDF' });
      const blob = await response.blob();
      const filename = loadSheetFilenameFromDateAndRider(createdAt || new Date(), riderName);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast('PDF downloaded', 'success');
    } catch (error: any) {
      showToast(error?.message || 'Failed to download PDF', 'error');
    }
  }

  return {
    logs, loading, load, deleteLog, downloadLogPdf,
    riderNames: riderNamesFromLogs(logs),
    nextAssignmentNumber: nextAssignmentNumberFromLogs(logs),
  };
}
