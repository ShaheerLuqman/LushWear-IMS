// Delivery status report (from Orders' "Track Delivery Status" action) + the PostEx
// shipper-advice (retry/return) flow it opens for a parcel parked under review.
// Ported from delivery-status.js's showDeliveryStatusReportModal/renderDeliveryStatusReportDetail
// /openShipperAdviceModal/submitShipperAdvice.
import { useMemo, useState } from 'react';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { formatCourierForDisplay } from '../../logic/shared';
import { DELIVERY_REPORT_CATEGORIES, SHIPPER_ADVICE_LABELS, deliveryStatusIsUnderReview, type DeliveryReport, type DeliveryReportEntry } from '../../logic/deliveryStatus';

interface EntryMeta extends DeliveryReportEntry { canViewDetails: boolean; canAdvise: boolean }

export function DeliveryStatusReportModal({
  report, total, onClose, onViewOrder,
}: {
  report: DeliveryReport;
  total: number;
  onClose: () => void;
  onViewOrder: (order: DeliveryReportEntry['order']) => void;
}) {
  const [entries, setEntries] = useState(report);
  const visibleCategories = DELIVERY_REPORT_CATEGORIES.filter((c) => c.key !== 'failed' || entries.failed.length > 0);
  const grandTotal = visibleCategories.reduce((sum, c) => sum + (c.key === 'all' ? 0 : entries[c.key as keyof DeliveryReport].length), 0);
  const [activeKey, setActiveKey] = useState<string>(grandTotal > 0 ? 'all' : visibleCategories[0].key);
  const [adviseFor, setAdviseFor] = useState<EntryMeta[] | null>(null);
  const [selectedAdvise, setSelectedAdvise] = useState<Set<number>>(new Set());

  const activeEntries: EntryMeta[] = useMemo(() => {
    const raw = activeKey === 'all'
      ? DELIVERY_REPORT_CATEGORIES.filter((c) => c.key !== 'all').flatMap((c) => entries[c.key as keyof DeliveryReport]).sort((a, b) => (b.order.order_number || 0) - (a.order.order_number || 0))
      : entries[activeKey as keyof DeliveryReport] || [];
    return raw.map((e) => {
      const courierNormalized = (e.order.courier || '').trim().toUpperCase();
      const track = (e.order.tracking_number || '').trim();
      const canViewDetails = (courierNormalized === 'POSTEX' || courierNormalized === 'COURIERS NEXT') && !!track && track !== '-';
      const canAdvise = courierNormalized === 'POSTEX' && !!track && track !== '-' && deliveryStatusIsUnderReview(e.order.delivery_status as any);
      return { ...e, canViewDetails, canAdvise };
    });
  }, [activeKey, entries]);

  const showIssueColumn = activeKey === 'issues' || activeKey === 'all';
  const adviseIndexes = activeEntries.reduce<number[]>((acc, m, i) => { if (m.canAdvise && !m.advised) acc.push(i); return acc; }, []);
  const bulkEligible = adviseIndexes.length > 1;

  function markAdvised(orderIds: Set<string>, label: string) {
    setEntries((prev) => {
      const next: DeliveryReport = { ...prev };
      (Object.keys(next) as Array<keyof DeliveryReport>).forEach((key) => {
        next[key] = next[key].map((e) => (orderIds.has(e.order.id) ? { ...e, advised: label } : e));
      });
      return next;
    });
  }

  return (
    <>
      <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal-content">
          <div className="modal-header">
            <h2>Delivery status report</h2>
            <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
          </div>
          <div className="modal-body">
            <p className="modal-description">Delivery status for {total} selected order{total === 1 ? '' : 's'}.</p>
            <div className="status-report-cards">
              {visibleCategories.map(({ key, label }) => {
                const count = key === 'all' ? grandTotal : entries[key as keyof DeliveryReport].length;
                const pct = grandTotal ? Math.round((count / grandTotal) * 100) : 0;
                return (
                  <button type="button" key={key} className={`status-report-card status-report-card--${key}` + (activeKey === key ? ' active' : '')} onClick={() => setActiveKey(key)}>
                    <span className="status-report-card__count">{count}<span className="status-report-card__pct">{pct}%</span></span>
                    <span className="status-report-card__label">{label}</span>
                  </button>
                );
              })}
            </div>
            <div className="status-report-detail">
              <h3 className="status-report-detail__title">{(DELIVERY_REPORT_CATEGORIES.find((c) => c.key === activeKey) || {}).label} ({activeEntries.length})</h3>
              {activeEntries.length === 0 ? (
                <div className="no-status">No orders in this category.</div>
              ) : (
                <>
                  {bulkEligible && (
                    <div className="status-report-bulk-bar">
                      <label className="status-report-bulk-select-all">
                        <input
                          type="checkbox" checked={selectedAdvise.size === adviseIndexes.length && adviseIndexes.length > 0}
                          onChange={(e) => setSelectedAdvise(e.target.checked ? new Set(adviseIndexes) : new Set())}
                        />
                        Select all under review
                      </label>
                      <button
                        type="button" className="btn btn-secondary btn-sm" disabled={selectedAdvise.size === 0}
                        onClick={() => setAdviseFor([...selectedAdvise].map((i) => activeEntries[i]))}
                      >
                        Advise selected ({selectedAdvise.size})
                      </button>
                    </div>
                  )}
                  <div className="postex-mismatches-table-wrap">
                    <table className="postex-mismatches-table">
                      <thead>
                        <tr>
                          {bulkEligible && <th />}
                          <th>Order #</th><th>Courier</th><th>Tracking</th>
                          {showIssueColumn && <th>Issue</th>}
                          <th>Latest status</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {activeEntries.map((m, i) => (
                          <tr key={m.order.id}>
                            {bulkEligible && (
                              <td className="status-report-select">
                                {m.canAdvise && !m.advised && (
                                  <input
                                    type="checkbox" checked={selectedAdvise.has(i)}
                                    onChange={(e) => setSelectedAdvise((prev) => { const next = new Set(prev); if (e.target.checked) next.add(i); else next.delete(i); return next; })}
                                  />
                                )}
                              </td>
                            )}
                            <td>{m.order.order_number || ''}</td>
                            <td>{formatCourierForDisplay(m.order.courier) || ''}</td>
                            <td>{m.order.tracking_number || ''}</td>
                            {showIssueColumn && <td>{m.issueType && <span className="grid-status-badge grid-status-rfd">{m.issueType}</span>}</td>}
                            <td>{m.note || ''}</td>
                            <td className="status-report-actions">
                              {m.canViewDetails && <button type="button" className="status-report-view-btn" onClick={() => onViewOrder(m.order)}>View</button>}
                              {m.canAdvise && (m.advised
                                ? <button type="button" className="status-report-view-btn" disabled>{m.advised} sent</button>
                                : <button type="button" className="status-report-view-btn status-report-advise-btn" onClick={() => setAdviseFor([m])}>Advise</button>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="modal-pinned-footer">
            <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
      {adviseFor && (
        <ShipperAdviceModal
          entries={adviseFor}
          onClose={() => setAdviseFor(null)}
          onSent={(orderIds, label) => { markAdvised(orderIds, label); setAdviseFor(null); setSelectedAdvise(new Set()); }}
        />
      )}
    </>
  );
}

function ShipperAdviceModal({
  entries, onClose, onSent,
}: {
  entries: EntryMeta[];
  onClose: () => void;
  onSent: (orderIds: Set<string>, label: string) => void;
}) {
  const { showToast } = useToast();
  const [advice, setAdvice] = useState<'retry' | 'return'>('retry');
  const [remarks, setRemarks] = useState('');
  const [sending, setSending] = useState(false);

  const summary = entries.length === 1
    ? `Order ${entries[0].order.order_number} (${entries[0].order.tracking_number}) is with PostEx awaiting your decision on what to do with the parcel. Your remarks are shown to the rider.`
    : `${entries.length} orders are with PostEx awaiting your decision on what to do with the parcel. The same decision and remarks are sent for all of them, and shown to the rider.`;

  async function submit() {
    const trimmed = remarks.trim();
    if (!trimmed) { showToast('Enter remarks for the rider', 'warning', { silent: true }); return; }
    const label = SHIPPER_ADVICE_LABELS[advice];
    setSending(true);
    try {
      const results = await apiJson<Array<{ order_id: string; ok: boolean; error?: string }>>('/orders/postex-shipper-advice', {
        method: 'POST', body: { order_ids: entries.map((e) => e.order.id), advice, remarks: trimmed }, fallback: `Failed to send ${label.toLowerCase()} to PostEx`,
      });
      const resultsById = new Map(results.map((r) => [r.order_id, r]));
      const succeededIds = new Set<string>();
      const failed: Array<{ order_number?: number; error?: string }> = [];
      for (const entry of entries) {
        const result = resultsById.get(entry.order.id);
        if (result?.ok) succeededIds.add(entry.order.id);
        else failed.push({ order_number: entry.order.order_number, error: result?.error });
      }
      if (succeededIds.size === 0) throw new Error(failed[0]?.error || 'PostEx did not accept the advice');

      const summaryMsg = entries.length === 1 ? `${label} requested for order ${entries[0].order.order_number}` : `${label} requested for ${succeededIds.size} order${succeededIds.size === 1 ? '' : 's'}`;
      showToast(failed.length ? `${summaryMsg}; failed for ${failed.map((f) => f.order_number).join(', ')}` : summaryMsg, failed.length ? 'warning' : 'success');
      onSent(succeededIds, label);
    } catch (error: any) {
      showToast(error?.message || 'Failed to send advice to PostEx', 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Advise PostEx</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-description">{summary}</p>
          <div className="form-group">
            <label>Decision</label>
            <div className="shipper-advice-options">
              <label className="shipper-advice-option">
                <input type="radio" name="shipperAdviceType" checked={advice === 'retry'} onChange={() => setAdvice('retry')} />
                <span><strong>Reattempt delivery</strong> — ask PostEx to try the customer again.</span>
              </label>
              <label className="shipper-advice-option">
                <input type="radio" name="shipperAdviceType" checked={advice === 'return'} onChange={() => setAdvice('return')} />
                <span><strong>Return the parcel</strong> — send it back to the warehouse.</span>
              </label>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="shipperAdviceRemarks">Remarks for the rider</label>
            <textarea id="shipperAdviceRemarks" className="form-input" rows={4} placeholder="e.g. Customer asked to deliver after 5pm; correct address is House 21, Street 37" value={remarks} onChange={(e) => setRemarks(e.target.value)} autoFocus />
          </div>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={sending} onClick={submit}>{sending ? 'Sending...' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}
