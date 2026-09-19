// Delivery status report (from Orders' "Track Delivery Status" action) + the PostEx
// shipper-advice (retry/return) flow it opens for a parcel parked under review.
// Ported from delivery-status.js's showDeliveryStatusReportModal/renderDeliveryStatusReportDetail
// /openShipperAdviceModal/submitShipperAdvice.
import { useMemo, useState } from 'react';
import { Badge, BlockStack, Button, Checkbox, ChoiceList, FormLayout, InlineStack, Tabs, Text, TextField } from '@shopify/polaris';
import { FormModal, InfoModal } from '../../components/FormModal';
import { ReportTable } from '../../components/ReportTable';
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

  const activeLabel = (DELIVERY_REPORT_CATEGORIES.find((c) => c.key === activeKey) || {}).label;
  const allAdviseSelected = adviseIndexes.length > 0 && selectedAdvise.size === adviseIndexes.length;

  return (
    <>
      <InfoModal title="Delivery status report" onClose={onClose} size="large">
        <BlockStack gap="400">
          <Text as="p" tone="subdued">Delivery status for {total} selected order{total === 1 ? '' : 's'}.</Text>
          <Tabs
            tabs={visibleCategories.map(({ key, label }) => {
              const count = key === 'all' ? grandTotal : entries[key as keyof DeliveryReport].length;
              const pct = grandTotal ? Math.round((count / grandTotal) * 100) : 0;
              return { id: key, content: `${label} · ${pct}%`, badge: String(count) };
            })}
            selected={Math.max(0, visibleCategories.findIndex((c) => c.key === activeKey))}
            onSelect={(i) => { setActiveKey(visibleCategories[i].key); setSelectedAdvise(new Set()); }}
          />
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">{activeLabel} ({activeEntries.length})</Text>
            {bulkEligible && (
              <InlineStack gap="300" blockAlign="center">
                <Checkbox label="Select all under review" checked={allAdviseSelected} onChange={(checked) => setSelectedAdvise(checked ? new Set(adviseIndexes) : new Set())} />
                <Button size="slim" disabled={selectedAdvise.size === 0} onClick={() => setAdviseFor([...selectedAdvise].map((i) => activeEntries[i]))}>{`Advise selected (${selectedAdvise.size})`}</Button>
              </InlineStack>
            )}
          </InlineStack>
          <ReportTable
            headings={[...(bulkEligible ? [''] : []), 'Order #', 'Courier', 'Tracking', ...(showIssueColumn ? ['Issue'] : []), 'Latest status', '']}
            emptyMessage="No orders in this category."
            rows={activeEntries.map((m, i) => [
              ...(bulkEligible ? [m.canAdvise && !m.advised
                ? <Checkbox label="" labelHidden checked={selectedAdvise.has(i)} onChange={(checked) => setSelectedAdvise((prev) => { const next = new Set(prev); if (checked) next.add(i); else next.delete(i); return next; })} />
                : ''] : []),
              String(m.order.order_number || ''), formatCourierForDisplay(m.order.courier) || '', m.order.tracking_number || '',
              ...(showIssueColumn ? [m.issueType ? <Badge tone="attention">{m.issueType}</Badge> : ''] : []),
              m.note || '',
              <InlineStack gap="100" align="end" wrap={false}>
                {m.canViewDetails && <Button size="micro" onClick={() => onViewOrder(m.order)}>View</Button>}
                {m.canAdvise && (m.advised
                  ? <Button size="micro" disabled>{`${m.advised} sent`}</Button>
                  : <Button size="micro" variant="primary" onClick={() => setAdviseFor([m])}>Advise</Button>)}
              </InlineStack>,
            ])}
          />
        </BlockStack>
      </InfoModal>
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
    <FormModal title="Advise PostEx" onClose={onClose} onSubmit={submit} submitLabel="Send" saving={sending}>
      <FormLayout>
        <Text as="p" tone="subdued">{summary}</Text>
        <ChoiceList
          title="Decision" selected={[advice]} onChange={(v) => setAdvice(v[0] as 'retry' | 'return')}
          choices={[
            { value: 'retry', label: 'Reattempt delivery', helpText: 'Ask PostEx to try the customer again.' },
            { value: 'return', label: 'Return the parcel', helpText: 'Send it back to the warehouse.' },
          ]}
        />
        <TextField label="Remarks for the rider" autoComplete="off" multiline={4} autoFocus placeholder="e.g. Customer asked to deliver after 5pm; correct address is House 21, Street 37" value={remarks} onChange={setRemarks} />
      </FormLayout>
    </FormModal>
  );
}
