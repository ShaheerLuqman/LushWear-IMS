// Full report shown right after a PostEx CSV upload: net receivable and the other totals
// the upload derived, plus the per-order breakdown, including any receivable-vs-CSV-NET_AMOUNT
// mismatch and any delivery-status mismatch inline. Built entirely from the upload response -
// no refetch. Ported from delivery-status.js's showPostExUploadReportModal.
interface PostExUploadOrderRow {
  order_number: number | string;
  folio?: string;
  order_status?: string;
  csv_status?: string;
  status_mismatch?: boolean;
  mismatch?: boolean;
  total_amount?: number;
  advance_amount?: number;
  cod?: number;
  delivery_charge?: number;
  tax_amount?: number;
  receivable?: number;
  csv_net_amount?: number | null;
}
interface PostExUploadTotals {
  total_amount?: number; advance_total?: number; cod_total?: number; returned_total?: number;
  delivery_charges?: number; taxes?: number; net_receivable?: number;
}
export interface PostExUploadReportData {
  order_breakdown?: PostExUploadOrderRow[];
  totals?: PostExUploadTotals;
}

function num(v: unknown): string {
  return Number(v || 0).toFixed(2);
}

function StatCard({ label, value, color, raw }: { label: string; value: string | number; color?: string; raw?: boolean }) {
  return (
    <div className="stat-card">
      <div className="stat-info">
        <span className="stat-label">{label}</span>
        <span className="stat-value" style={color ? { color } : undefined}>{raw ? value : `Rs ${num(value)}`}</span>
      </div>
    </div>
  );
}

export function PostExUploadReportModal({ data, onClose }: { data: PostExUploadReportData; onClose: () => void }) {
  const orderNum = (o: PostExUploadOrderRow) => parseInt(String(o.order_number).replace(/\D/g, ''), 10) || 0;
  const flagged = (o: PostExUploadOrderRow) => !!(o.mismatch || o.status_mismatch);
  const orders = [...(data.order_breakdown || [])].sort((a, b) => (Number(flagged(b)) - Number(flagged(a))) || (orderNum(b) - orderNum(a)));
  const t = data.totals || {};
  const netColor = Number(t.net_receivable || 0) < 0 ? 'var(--danger)' : 'var(--success)';
  const mismatchCount = orders.filter((o) => o.mismatch).length;
  const statusMismatchCount = orders.filter((o) => o.status_mismatch).length;

  const summary = `${orders.length} order(s) from this upload, net receivable Rs ${num(t.net_receivable)}.`
    + (mismatchCount > 0 ? ` ${mismatchCount} order(s) differ from the CSV's NET_AMOUNT (highlighted).` : '')
    + (statusMismatchCount > 0 ? ` ${statusMismatchCount} order(s) have a delivery status contradicting this CSV (highlighted).` : '');

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>PostEx CSV upload report</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-description">{summary}</p>
          <div className="stats-grid">
            <StatCard label="Total Order Value" value={t.total_amount || 0} />
            <StatCard label="Advance Received" value={t.advance_total || 0} />
            <StatCard label="Gross COD" value={t.cod_total || 0} />
            <StatCard label="Returned Orders" value={t.returned_total || 0} />
            <StatCard label="Delivery Charges" value={t.delivery_charges || 0} />
            <StatCard label="Taxes (SST)" value={t.taxes || 0} />
            <StatCard label="Net Receivable" value={t.net_receivable || 0} color={netColor} />
            <StatCard label="Mismatched Orders" value={mismatchCount} raw color={mismatchCount > 0 ? 'var(--danger)' : 'var(--success)'} />
            <StatCard label="Status Mismatches" value={statusMismatchCount} raw color={statusMismatchCount > 0 ? 'var(--danger)' : 'var(--success)'} />
          </div>
          <div className="postex-mismatches-table-wrap">
            <table className="postex-mismatches-table">
              <thead>
                <tr>
                  <th>Order #</th><th>Folio</th><th>Status</th><th>Total</th><th>Advance</th><th>COD</th>
                  <th>Delivery Charge</th><th>Tax</th><th>Receivable</th><th>CSV Net</th><th>Diff</th>
                </tr>
              </thead>
              <tbody>
                {orders.length ? orders.map((o, i) => {
                  const diff = o.mismatch ? num((o.receivable || 0) - (o.csv_net_amount || 0)) : null;
                  return (
                    <tr key={i} className={flagged(o) ? 'postex-report-row--mismatch' : ''}>
                      <td>{o.order_number}</td>
                      <td>{o.folio || '-'}</td>
                      <td>{o.status_mismatch ? `${o.order_status || '-'} (CSV: ${o.csv_status || '-'})` : (o.order_status || '-')}</td>
                      <td>{num(o.total_amount)}</td>
                      <td>{num(o.advance_amount)}</td>
                      <td>{num(o.cod)}</td>
                      <td>{num(o.delivery_charge)}</td>
                      <td>{num(o.tax_amount)}</td>
                      <td>{num(o.receivable)}</td>
                      <td>{o.csv_net_amount != null ? num(o.csv_net_amount) : '-'}</td>
                      <td>{diff != null ? diff : '-'}</td>
                    </tr>
                  );
                }) : <tr><td colSpan={11}>No orders were updated by this CSV.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
