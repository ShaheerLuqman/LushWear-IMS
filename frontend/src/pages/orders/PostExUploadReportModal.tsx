// Full report shown right after a PostEx CSV upload: net receivable and the other totals
// the upload derived, plus the per-order breakdown, including any receivable-vs-CSV-NET_AMOUNT
// mismatch and any delivery-status mismatch inline. Built entirely from the upload response -
// no refetch.
import { BlockStack, Text } from '@shopify/polaris';
import { InfoModal } from '../../components/FormModal';
import { MetricsStrip } from '../../components/MetricsStrip';
import { ReportTable } from '../../components/ReportTable';
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

export function PostExUploadReportModal({ data, onClose }: { data: PostExUploadReportData; onClose: () => void }) {
  const orderNum = (o: PostExUploadOrderRow) => parseInt(String(o.order_number).replace(/\D/g, ''), 10) || 0;
  const flagged = (o: PostExUploadOrderRow) => !!(o.mismatch || o.status_mismatch);
  const orders = [...(data.order_breakdown || [])].sort((a, b) => (Number(flagged(b)) - Number(flagged(a))) || (orderNum(b) - orderNum(a)));
  const t = data.totals || {};
  const mismatchCount = orders.filter((o) => o.mismatch).length;
  const statusMismatchCount = orders.filter((o) => o.status_mismatch).length;

  const summary = `${orders.length} order(s) from this upload, net receivable Rs ${num(t.net_receivable)}.`
    + (mismatchCount > 0 ? ` ${mismatchCount} order(s) differ from the CSV's NET_AMOUNT (highlighted).` : '')
    + (statusMismatchCount > 0 ? ` ${statusMismatchCount} order(s) have a delivery status contradicting this CSV (highlighted).` : '');

  const money = (label: string, value: unknown, negative?: boolean) => ({ label, value: `Rs ${num(value)}`, negative });
  const flag = (o: PostExUploadOrderRow, v: string) => (flagged(o) ? <Text as="span" tone="critical" fontWeight="semibold">{v}</Text> : v);

  return (
    <InfoModal title="PostEx CSV upload report" onClose={onClose} size="large">
      <BlockStack gap="400">
        <Text as="p" tone="subdued">{summary}</Text>
        <MetricsStrip
          label="Upload totals" wrap
          tiles={[
            money('Total Order Value', t.total_amount), money('Advance Received', t.advance_total), money('Gross COD', t.cod_total),
            money('Returned Orders', t.returned_total), money('Delivery Charges', t.delivery_charges), money('Taxes (SST)', t.taxes),
            money('Net Receivable', t.net_receivable, Number(t.net_receivable || 0) < 0),
            { label: 'Mismatched Orders', value: String(mismatchCount), negative: mismatchCount > 0 },
            { label: 'Status Mismatches', value: String(statusMismatchCount), negative: statusMismatchCount > 0 },
          ]}
        />
        <ReportTable
          headings={['Order #', 'Folio', 'Status', 'Total', 'Advance', 'COD', 'Delivery Charge', 'Tax', 'Receivable', 'CSV Net', 'Diff']}
          numeric={[3, 4, 5, 6, 7, 8, 9, 10]}
          emptyMessage="No orders were updated by this CSV."
          rows={orders.map((o) => [
            flag(o, String(o.order_number)), o.folio || '-',
            flag(o, o.status_mismatch ? `${o.order_status || '-'} (CSV: ${o.csv_status || '-'})` : (o.order_status || '-')),
            num(o.total_amount), num(o.advance_amount), num(o.cod), num(o.delivery_charge), num(o.tax_amount), num(o.receivable),
            o.csv_net_amount != null ? num(o.csv_net_amount) : '-',
            o.mismatch ? flag(o, num((o.receivable || 0) - (o.csv_net_amount || 0))) : '-',
          ])}
        />
      </BlockStack>
    </InfoModal>
  );
}
