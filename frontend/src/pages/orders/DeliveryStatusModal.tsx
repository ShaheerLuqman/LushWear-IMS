// Single-order delivery status popup, opened from a grid row's refresh button.
// Ported from delivery-status.js's fetchDeliveryStatus/displayDeliveryStatus.
import { useEffect, useState } from 'react';
import { Banner, BlockStack, DescriptionList, InlineStack, Link, Spinner, Text } from '@shopify/polaris';
import { InfoModal } from '../../components/FormModal';
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
  const waNumber = customer.phone ? normalizePakPhone(customer.phone) : null;
  const items = data ? [
    { term: 'Courier', description: formatCourierForDisplay(data.courier) || '' },
    { term: 'Tracking Number', description: data.tracking_number || '' },
    ...(customer.name ? [{ term: 'Customer Name', description: customer.name }] : []),
    ...(customer.phone ? [{
      term: 'Phone',
      description: (
        <InlineStack gap="200" blockAlign="center">
          <span>{waNumber ? `+${waNumber}` : customer.phone}</span>
          {waNumber && <Link url={`https://web.whatsapp.com/send?phone=${waNumber}`} target="_blank">Chat on WhatsApp</Link>}
        </InlineStack>
      ),
    }] : []),
    ...(data.recipient_name ? [{ term: 'Recipient Name', description: data.recipient_name }] : []),
    ...(data.recipient_contact ? [{ term: 'Recipient Contact', description: data.recipient_contact }] : []),
    ...(data.order_pickup_date ? [{ term: 'Pickup Date', description: formatDateDDMMYYYY(data.order_pickup_date) }] : []),
  ] : [];

  return (
    <InfoModal title="Delivery Status" onClose={onClose} actions={data ? [{ content: 'Refresh status', loading: refreshing, onAction: () => fetchStatus(true) }] : []}>
      {loading ? (
        <InlineStack align="center" gap="200" blockAlign="center"><Spinner size="small" /><Text as="span" tone="subdued">Fetching delivery status...</Text></InlineStack>
      ) : error && !data ? (
        <Banner tone="critical">{error}</Banner>
      ) : data && (
        <BlockStack gap="400">
          <DescriptionList items={items} gap="tight" />
          <Text as="h3" variant="headingSm">Status History</Text>
          <div className="status-timeline">
            {history.length > 0 ? history.map((s, i) => (
              <div className={'timeline-item' + (s.is_active || i === 0 ? ' active' : '')} key={i}>
                <div className="timeline-dot" />
                <div className="timeline-content">
                  <Text as="p" tone="subdued" variant="bodySm">{s.datetime ? formatDateTimeDDMMYYYY(s.datetime) : ''}</Text>
                  <Text as="p" fontWeight={i === 0 ? 'semibold' : 'regular'}>{s.status || ''}</Text>
                </div>
              </div>
            )) : <Text as="p" tone="subdued">No status history available</Text>}
          </div>
        </BlockStack>
      )}
    </InfoModal>
  );
}
