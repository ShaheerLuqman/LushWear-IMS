// Bills table columns and row cells.
import { useNavigate } from 'react-router-dom';
import { Badge, Button, InlineStack, Text } from '@shopify/polaris';
import { ArrowRightIcon, ViewIcon } from '@shopify/polaris-icons';
import type { DataColumn } from '../../components/DataTable';
import { RowActions } from '../../components/RowActions';
import { formatMoney, ledgerNameById, type Ledger } from '../../logic/ledgers';
import { formatDateDDMMYYYY } from '../../logic/shared';
import { BILL_STATUS_LABELS } from '../../logic/bills';

export interface Bill {
  id: string; bill_number?: string; supplier_id?: string; supplier_ref?: string; bill_date?: string;
  total?: number; outstanding?: number; payment_status?: string; status?: string;
}

export interface BillsColumnsCtx {
  ledgers: Ledger[];
  onView: (bill: Bill) => void;
  onReceive: (bill: Bill) => void;
  onUnreceive: (bill: Bill) => void;
  onCancel: (bill: Bill) => void;
  onDelete: (bill: Bill) => void;
}

const STATUS_TONE: Record<string, 'success' | 'attention' | 'critical' | 'info'> = { paid: 'success', partially_paid: 'attention', unpaid: 'attention', cancelled: 'critical' };

/** Ledger name with a "go to ledger" arrow - shared with the Transactions folio cells. */
export function LedgerLink({ id, name }: { id?: string | null; name: string }) {
  const navigate = useNavigate();
  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      {name && <Text as="span" fontWeight="semibold">{name}</Text>}
      <Button icon={ArrowRightIcon} variant="tertiary" size="micro" disabled={!id} accessibilityLabel={id ? `Go to ${name}` : 'No ledger'} onClick={() => { if (id) navigate(`/ledgers/${id}`); }} />
    </InlineStack>
  );
}

export function buildBillsColumns(ctx: BillsColumnsCtx): DataColumn<Bill>[] {
  const supplier = (b: Bill) => (b.supplier_id ? ledgerNameById(ctx.ledgers, b.supplier_id) : '');
  return [
    { key: 'bill_number', heading: 'Bill #', render: (b) => <Text as="span" fontWeight="semibold">{b.bill_number || ''}</Text>, sortValue: (b) => b.bill_number },
    { key: 'supplier', heading: 'Supplier', render: (b) => <LedgerLink id={b.supplier_id} name={supplier(b)} />, sortValue: supplier },
    { key: 'supplier_ref', heading: 'Supplier ref', render: (b) => b.supplier_ref || '', sortValue: (b) => b.supplier_ref },
    { key: 'bill_date', heading: 'Date', render: (b) => (b.bill_date ? formatDateDDMMYYYY(b.bill_date) : ''), sortValue: (b) => b.bill_date },
    { key: 'total', heading: 'Total (Rs)', alignment: 'end', render: (b) => formatMoney(b.total), sortValue: (b) => Number(b.total) || 0 },
    { key: 'outstanding', heading: 'Outstanding (Rs)', alignment: 'end', render: (b) => formatMoney(b.outstanding), sortValue: (b) => Number(b.outstanding) || 0 },
    {
      key: 'payment_status', heading: 'Status', sortValue: (b) => b.payment_status,
      render: (b) => <Badge tone={STATUS_TONE[b.payment_status || '']}>{BILL_STATUS_LABELS[b.payment_status || ''] || b.payment_status || ''}</Badge>,
    },
    {
      key: 'actions', heading: '', alignment: 'end',
      render: (b) => (
        <InlineStack gap="100" blockAlign="center" align="end" wrap={false}>
          <Button icon={ViewIcon} size="slim" onClick={() => ctx.onView(b)}>View Bill</Button>
          <RowActions items={[
            ...(b.status === 'draft' ? [
              { content: 'Confirm Bill', onAction: () => ctx.onReceive(b) },
              { content: 'Delete', destructive: true, onAction: () => ctx.onDelete(b) },
            ] : []),
            ...(b.status === 'received' ? [
              { content: 'Revert to Draft', onAction: () => ctx.onUnreceive(b) },
              { content: 'Cancel', destructive: true, onAction: () => ctx.onCancel(b) },
            ] : []),
          ]} />
        </InlineStack>
      ),
    },
  ];
}
