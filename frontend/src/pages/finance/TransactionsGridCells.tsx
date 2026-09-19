// Transactions table columns: ledger pickers, inline-editable amount/description, row menu.
import { Text } from '@shopify/polaris';
import type { DataColumn } from '../../components/DataTable';
import { Dropdown } from '../../components/Dropdown';
import { EditableAmount, EditableText } from '../../components/EditableCell';
import { RowActions } from '../../components/RowActions';
import { cashSideLabel, selectableLedgers, type Ledger } from '../../logic/ledgers';
import { formatAmount } from '../../logic/shared';
import { LedgerLink } from './BillsGridCells';

export interface TransactionRow {
  id: string;
  entry_date?: string;
  description?: string;
  from_account_id?: string | null;
  to_account_id?: string | null;
  amount?: number | null;
  order_number?: string;
  [key: string]: unknown;
}

export function isTransactionNewRow(id: string | undefined): boolean {
  return !!id && id.startsWith('__new_');
}

export interface TransactionsColumnsCtx {
  ledgers: Ledger[];
  isEditingAllowed: () => boolean;
  onFieldChange: (rowId: string, field: string, value: unknown) => void;
  onDeleteRow: (rowId: string) => void;
  onCreateLedger: (rowId: string, field: 'from_account_id' | 'to_account_id') => void;
}

function FolioCell({ data, accountField, ctx }: { data: TransactionRow; accountField: 'from_account_id' | 'to_account_id'; ctx: TransactionsColumnsCtx }) {
  const currentFolio = data[accountField];
  const emptyLabel = cashSideLabel(ctx.ledgers);
  const cashLedger = ctx.ledgers.find((l) => l.system_key === 'cash');
  const shownLedger = currentFolio ? ctx.ledgers.find((l) => l.id === currentFolio) : cashLedger;
  const name = shownLedger ? shownLedger.name : emptyLabel;
  if (!ctx.isEditingAllowed()) return <LedgerLink id={shownLedger?.id} name={name} />;
  return (
    <div className="transaction-folio">
      <Dropdown
        variant="tertiary" size="slim" searchable value={currentFolio || ''}
        options={[{ value: '', label: emptyLabel }, ...selectableLedgers(ctx.ledgers).map((l) => ({ value: l.id, label: l.name }))]}
        onChange={(id) => ctx.onFieldChange(data.id, accountField, id || null)}
        action={{ content: '+ Create new ledger...', onAction: () => ctx.onCreateLedger(data.id, accountField) }}
      />
      <LedgerLink id={shownLedger?.id} name="" />
    </div>
  );
}

export function buildTransactionColumns(ctx: TransactionsColumnsCtx): DataColumn<TransactionRow>[] {
  const isNew = (r: TransactionRow) => isTransactionNewRow(r.id);
  return [
    { key: 'rowNum', heading: '#', render: (r, i) => (isNew(r) ? '' : <Text as="span" tone="subdued">{i + 1}</Text>) },
    { key: 'from', heading: 'From Account (Credit)', render: (r) => <FolioCell data={r} accountField="from_account_id" ctx={ctx} /> },
    { key: 'to', heading: 'To Account (Debit)', render: (r) => <FolioCell data={r} accountField="to_account_id" ctx={ctx} /> },
    {
      key: 'amount', heading: 'Amount (PKR)', alignment: 'end', sortValue: (r) => (isNew(r) ? null : Number(r.amount) || 0),
      render: (r) => (isNew(r)
        ? <EditableAmount value={r.amount ?? null} editable={ctx.isEditingAllowed()} placeholder="0.00" onSave={(n) => ctx.onFieldChange(r.id, 'amount', n)} />
        : ctx.isEditingAllowed()
          ? <EditableAmount value={r.amount} editable onSave={(n) => { if (n > 0) ctx.onFieldChange(r.id, 'amount', n); }} />
          : <Text as="span" alignment="end" numeric fontWeight="semibold">{formatAmount(r.amount)}</Text>),
    },
    {
      key: 'description', heading: 'Description', sortValue: (r) => r.description || '',
      render: (r) => <EditableText value={r.description} editable={ctx.isEditingAllowed()} placeholder={isNew(r) ? 'What was this for?' : undefined} emptyLabel="" onSave={(v) => ctx.onFieldChange(r.id, 'description', v)} />,
    },
    {
      key: 'actions', heading: '', alignment: 'end',
      render: (r) => (isNew(r) ? null : <RowActions items={[{ content: 'Delete', destructive: true, onAction: () => ctx.onDeleteRow(r.id) }]} />),
    },
  ];
}
