// Popup with everything on file for one order, opened from a row's View button
// (or a tap on the row on mobile). The list rows carry a slimmed column set, so the full
// row (customer, address, delivery history, tags) is fetched on open.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Badge, BlockStack, Button, Card, DescriptionList, InlineGrid, InlineStack, Link, Spinner, Text,
} from '@shopify/polaris';
import { EditIcon } from '@shopify/polaris-icons';
import { InfoModal } from '../../components/FormModal';
import { KeyValueList } from '../../components/KeyValueList';
import { apiJson } from '../../api';
import { computeFinalStatus, computeNetProfit, computeReceivable, orderStatusDisplayLabel, type Order } from '../../logic/orders';
import { formatDateDDMMYYYY, formatDateTimeDDMMYYYY, getCourierDisplayName } from '../../logic/shared';
import { normalizePakPhone, type DeliveryStatusData } from '../../logic/deliveryStatus';
import { RowActions } from '../../components/RowActions';
import { ORDERS_COLUMNS, cod, money, orderActionItems, profitPercent, statusTone, type OrdersColumnCtx } from './ordersPolarisColumns';
import { isLocalDeliveryCourier } from '../../logic/fulfillment';
import { DeliveryChargeModal, type DeliveryChargePatch } from '../fulfillment/DeliveryChargeModal';

type FullOrder = Order & {
  customer_name?: string; customer_phone?: string; customer_address?: string; customer_city?: string;
  courier_pickup_date?: string; fulfilled_at?: string; returned_at?: string; tags?: string;
  delivery_charge_ledger_id?: string | null;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">{title}</Text>
        {children}
      </BlockStack>
    </Card>
  );
}

/** A value with a pencil button that swaps in its editor; the editor saves on blur (Enter
 *  blurs it), and blurring also returns to the plain value. `end` puts the pencil on the
 *  left so right-aligned values stay lined up with rows that have no pencil. */
function PencilEdit({ label, display, editor, end }: { label: string; display: ReactNode; editor: ReactNode; end?: boolean }) {
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (editing) editorRef.current?.querySelector('input')?.focus(); }, [editing]);

  if (editing) {
    return (
      <div ref={editorRef} onBlur={() => setEditing(false)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); }}>
        {editor}
      </div>
    );
  }
  const pencil = <Button icon={EditIcon} variant="tertiary" size="slim" accessibilityLabel={`Edit ${label}`} onClick={() => setEditing(true)} />;
  return (
    <InlineStack gap="100" blockAlign="center" align={end ? 'end' : 'start'} wrap={false}>
      {end && pencil}{display}{!end && pencil}
    </InlineStack>
  );
}

const dash = (v: unknown) => (v == null || String(v).trim() === '' ? '-' : String(v));

export function OrderDetailsModal({ order, ctx, onClose }: { order: Order; ctx: OrdersColumnCtx; onClose: () => void }) {
  const [full, setFull] = useState<FullOrder | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // A Local Delivery charge is edited in its own popup (it also records the ledger the rider
  // was paid from); what it saved overrides both the fetched row and the list row.
  const [editingCharge, setEditingCharge] = useState(false);
  const [chargePatch, setChargePatch] = useState<DeliveryChargePatch | null>(null);

  useEffect(() => {
    apiJson<FullOrder>(`/orders/${order.id}`, { fallback: 'Failed to load order' }).then(setFull, () => setLoadFailed(true));
  }, [order.id]);

  // The list row wins for fields edited inline since the fetch; the fetched row adds the rest.
  const o: FullOrder = { ...full, ...order, ...chargePatch, delivery_status: full?.delivery_status ?? order.delivery_status };
  const status = o.order_status || '';
  const finalStatus = computeFinalStatus(o);
  const lineItems = o.line_items || [];
  const history = [...((o.delivery_status as DeliveryStatusData | null)?.status_history || [])].reverse();
  const waNumber = o.customer_phone ? normalizePakPhone(o.customer_phone) : null;
  const receivable = computeReceivable(o);
  const netProfit = computeNetProfit(o);
  const pct = profitPercent(o);
  const loading = !full && !loadFailed;
  const tags = (o.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  // The table's own cells: rendered with editing forced off for the plain value, and as-is
  // for the editor, so saves go through the same path and honour the same edit lock.
  const readOnlyCtx: OrdersColumnCtx = { ...ctx, isEditingAllowed: () => false };
  const render = (key: string, c: OrdersColumnCtx) => ORDERS_COLUMNS.find((col) => col.key === key)!.render(o, c);
  const field = (key: string, label: string, end = true) => (ctx.isEditingAllowed()
    ? <PencilEdit label={label} display={render(key, readOnlyCtx)} editor={render(key, ctx)} end={end} />
    : render(key, readOnlyCtx));
  const localDelivery = isLocalDeliveryCourier(o.courier);
  const chargeField = localDelivery && ctx.isEditingAllowed()
    ? (
      <InlineStack gap="100" blockAlign="center" align="end" wrap={false}>
        <Button icon={EditIcon} variant="tertiary" size="slim" accessibilityLabel="Edit delivery charge" disabled={loading} onClick={() => setEditingCharge(true)} />
        {render('delivery_charge', readOnlyCtx)}
      </InlineStack>
    )
    : field('delivery_charge', 'delivery charge');

  return (
    <InfoModal title={`Order #${o.order_number}`} onClose={onClose} size="large">
      <div className="order-details">
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={statusTone(status)}>{orderStatusDisplayLabel(status)}</Badge>
              {finalStatus !== 'None' && <Badge tone={finalStatus === 'OK' ? 'success' : 'warning'}>{finalStatus}</Badge>}
              <Badge tone={o.is_order_settled ? 'success' : undefined}>{o.is_order_settled ? 'Settled' : 'Unsettled'}</Badge>
              {o.replacement_of_order_no && <Badge tone="info">{`Replacement of #${o.replacement_of_order_no}`}</Badge>}
              <Text as="span" tone="subdued">{formatDateTimeDDMMYYYY(o.order_receiving_date || o.created_at)}</Text>
            </InlineStack>
            {ctx.isEditingAllowed() && <RowActions label="More actions" items={orderActionItems(o, ctx)} />}
          </InlineStack>

          <InlineGrid columns={{ xs: 1, md: '3fr 2fr' }} gap="400" alignItems="start">
            <BlockStack gap="400">
              <Section title={`Items (${lineItems.reduce((sum, li) => sum + (Number(li.qty) || 1), 0)})`}>
                {lineItems.length === 0 ? <Text as="p" tone="subdued">No line items</Text> : lineItems.map((li, i) => {
                  const qty = Number(li.qty) || 1;
                  return (
                    <InlineStack key={i} align="space-between" blockAlign="start" gap="300" wrap={false}>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="medium">{li.name || '-'}</Text>
                        {li.variant_title && <Text as="span" tone="subdued" variant="bodySm">{li.variant_title}</Text>}
                      </BlockStack>
                      <BlockStack gap="050" inlineAlign="end">
                        <Text as="span" numeric>{li.unit_price != null ? money(li.unit_price * qty) : '-'}</Text>
                        <Text as="span" tone="subdued" variant="bodySm" numeric>
                          {li.unit_price != null ? `${qty} × ${money(li.unit_price)}` : `Qty ${qty}`}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  );
                })}
              </Section>

              <Section title="Payment">
                <KeyValueList rows={[
                  { label: 'Total', value: render('total_amount', readOnlyCtx), kind: 'subtotal' },
                  { label: 'Advance', value: render('advance_amount', readOnlyCtx) },
                  { label: 'CoD', value: money(cod(o)) },
                  { label: 'Delivery charge', value: chargeField },
                  { label: 'Tax', value: field('tax_amount', 'tax') },
                  { label: 'Cost price', value: field('cost_price', 'cost price') },
                  { label: 'Receivable', value: receivable == null ? '-' : money(receivable), kind: receivable != null && receivable < 0 ? 'negative' : 'subtotal' },
                  { label: 'Net profit', value: netProfit == null ? '-' : `${money(netProfit)}${pct == null ? '' : ` (${pct.toFixed(1)}%)`}`, kind: netProfit != null && netProfit < 0 ? 'negative' : 'final' },
                ]} />
              </Section>

              {history.length > 0 && (
                <Section title="Delivery history">
                  <div className="status-timeline">
                    {history.map((s, i) => (
                      <div className={'timeline-item' + (i === 0 ? ' active' : '')} key={i}>
                        <div className="timeline-dot" />
                        <div className="timeline-content">
                          <Text as="p" tone="subdued" variant="bodySm">{s.datetime ? formatDateTimeDDMMYYYY(s.datetime) : ''}</Text>
                          <Text as="p" fontWeight={i === 0 ? 'semibold' : 'regular'}>{s.status || ''}</Text>
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </BlockStack>

            <BlockStack gap="400">
              <Section title="Customer">
                {loading ? <Spinner size="small" /> : loadFailed ? <Text as="p" tone="critical">Couldn't load customer details</Text> : (
                  <DescriptionList gap="tight" items={[
                    { term: 'Name', description: dash(o.customer_name) },
                    {
                      term: 'Phone',
                      description: waNumber ? (
                        <InlineStack gap="200" blockAlign="center">
                          <span>+{waNumber}</span>
                          <Link url={`https://web.whatsapp.com/send?phone=${waNumber}`} target="_blank">WhatsApp</Link>
                        </InlineStack>
                      ) : dash(o.customer_phone),
                    },
                    { term: 'Address', description: dash(o.customer_address) },
                    { term: 'City', description: dash(o.customer_city) },
                  ]} />
                )}
              </Section>

              <Section title="Shipping">
                <DescriptionList gap="tight" items={[
                  { term: 'Courier', description: getCourierDisplayName(o) },
                  { term: 'Tracking #', description: dash(o.tracking_number) },
                  { term: 'Delivery status', description: dash(o.delivery_status?.latest_status) },
                  { term: 'Folio', description: field('folio', 'folio', false) },
                  { term: 'Piece received', description: render('piece_received', ctx) },
                  { term: 'Picked up', description: dash(formatDateDDMMYYYY(o.courier_pickup_date)) },
                  { term: 'Fulfilled', description: dash(formatDateTimeDDMMYYYY(o.fulfilled_at)) },
                  { term: 'Returned', description: dash(formatDateTimeDDMMYYYY(o.returned_at)) },
                ]} />
              </Section>

              {tags.length > 0 && (
                <Section title="Tags">
                  <InlineStack gap="100">{tags.map((t) => <Badge key={t}>{t}</Badge>)}</InlineStack>
                </Section>
              )}
            </BlockStack>
          </InlineGrid>
        </BlockStack>
      </div>
      {editingCharge && (
        <DeliveryChargeModal order={o} onClose={() => setEditingCharge(false)} onSaved={setChargePatch} />
      )}
    </InfoModal>
  );
}
