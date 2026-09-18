// Single-order delivery status popup, opened from a grid row's refresh button.
// Ported from delivery-status.js's fetchDeliveryStatus/displayDeliveryStatus.
import { useEffect, useState } from 'react';
import { apiJson } from '../../api';
import { formatCourierForDisplay, formatDateDDMMYYYY, formatDateTimeDDMMYYYY } from '../../logic/shared';
import { mergeDeliveryStatusData, normalizePakPhone, type DeliveryStatusData } from '../../logic/deliveryStatus';
import { useToast } from '../../toast/ToastContext';

export function DeliveryStatusModal({
  orderId, courier, trackingNumber, existing, onClose, onUpdated,
}: {
  orderId: string;
  courier: string | undefined;
  trackingNumber: string | undefined;
  existing: DeliveryStatusData | null | undefined;
  onClose: () => void;
  onUpdated: (merged: DeliveryStatusData) => void;
}) {
  const { showToast } = useToast();
  const [data, setData] = useState<DeliveryStatusData | null>(existing || null);
  const [customer, setCustomer] = useState<{ name: string; phone: string }>({ name: '', phone: '' });
  const [loading, setLoading] = useState(!existing);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchStatus(force: boolean) {
    const courierNormalized = (courier || '').trim().toUpperCase();
    if (courierNormalized !== 'POSTEX' && courierNormalized !== 'COURIERS NEXT') {
      setError('Delivery status is only available for PostEx and Couriers Next courier');
      setLoading(false);
      return;
    }
    if (!trackingNumber || trackingNumber === '-') {
      setError('Tracking number not available');
      setLoading(false);
      return;
    }
    if (force) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const [fresh, customerResults] = await Promise.all([
        apiJson<DeliveryStatusData>(`/orders/${orderId}/delivery-status?save=true${force ? '&force=true' : ''}`, { fallback: 'Failed to fetch delivery status' }),
        apiJson<Array<{ customer_name?: string; phone?: string }>>('/orders/shipping-info', { method: 'POST', body: [orderId], fallback: 'Failed to load customer info' }).catch(() => []),
      ]);
      const merged = mergeDeliveryStatusData(data, fresh);
      setData(merged);
      const info = customerResults?.[0];
      setCustomer({ name: info?.customer_name || '', phone: info?.phone || '' });
      onUpdated(merged);
    } catch (err: any) {
      console.error('Error fetching delivery status:', err);
      const message = err?.message || 'Failed to fetch delivery status';
      setError(message);
      // A refresh failure with old data still on screen never hits the error-only render
      // branch below, so it needs its own toast or it'd fail completely silently.
      if (force && data) showToast(message, 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { fetchStatus(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const history = [...(data?.status_history || [])].reverse();

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Delivery Status</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="content-loading"><div className="content-loading-spinner" /><p className="content-loading-text">Fetching delivery status...</p></div>
          ) : error && !data ? (
            <div className="error-message">Error: {error}</div>
          ) : data && (
            <>
              <div className="delivery-status-info">
                <div className="info-row"><strong>Courier:</strong> {formatCourierForDisplay(data.courier) || ''}</div>
                <div className="info-row"><strong>Tracking Number:</strong> {data.tracking_number || ''}</div>
                {customer.name && <div className="info-row"><strong>Customer Name:</strong> {customer.name}</div>}
                {customer.phone && (() => {
                  const waNumber = normalizePakPhone(customer.phone);
                  return (
                    <div className="info-row">
                      <strong>Phone:</strong> {waNumber ? `+${waNumber}` : customer.phone}{' '}
                      {waNumber && <a href={`https://web.whatsapp.com/send?phone=${waNumber}`} target="_blank" rel="noopener noreferrer" className="whatsapp-chat-link" title="Chat on WhatsApp"><i className="fa-brands fa-whatsapp" /></a>}
                    </div>
                  );
                })()}
                {data.recipient_name && <div className="info-row"><strong>Recipient Name:</strong> {data.recipient_name}</div>}
                {data.recipient_contact && <div className="info-row"><strong>Recipient Contact:</strong> {data.recipient_contact}</div>}
                {data.order_pickup_date && <div className="info-row"><strong>Pickup Date:</strong> {formatDateDDMMYYYY(data.order_pickup_date)}</div>}
              </div>
              <h3 style={{ marginTop: 20, marginBottom: 10 }}>Status History</h3>
              <div className="status-timeline">
                {history.length > 0 ? history.map((s, i) => (
                  <div className={'timeline-item' + (s.is_active || i === 0 ? ' active' : '')} key={i}>
                    <div className="timeline-dot" />
                    <div className="timeline-content">
                      <div className="timeline-date">{s.datetime ? formatDateTimeDDMMYYYY(s.datetime) : ''}</div>
                      <div className="timeline-status">{s.status || ''}</div>
                    </div>
                  </div>
                )) : <div className="no-status">No status history available</div>}
              </div>
              <div className="delivery-status-modal-actions">
                <button type="button" className="btn btn-primary delivery-status-btn" disabled={refreshing} onClick={() => fetchStatus(true)}>{refreshing ? 'Refreshing...' : 'Refresh status'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
