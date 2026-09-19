// Ledger business logic - ported 1:1 from ledgers.js. Pure functions take the
// ledgers array explicitly instead of reading a module-level global.
export interface Ledger {
  id: string;
  name: string;
  type?: string;
  system_key?: string | null;
  balance?: number;
  opening_balance?: number;
  include_in_cash_in_hand?: boolean;
  show_in_month_summary?: boolean;
  has_entries?: boolean;
  tax_number?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  [key: string]: unknown;
}

export interface LedgerBalancePatch { ledger_id: string; balance: number }

// Natures that sit on the Credit side when healthy. Balances are stored
// Debit-positive for every ledger regardless of Nature (see recalc_ledger_balance
// in supabase_schema.sql), so a Revenue/Liability/Equity ledger in good standing
// carries a *negative* stored balance.
export const CREDIT_NORMAL_TYPES = ['Liability', 'Equity', 'Revenue'];

export const LEDGER_VOUCHER_LABELS: Record<string, string> = {
  transaction: 'Transaction',
  bill: 'Bill',
  opening: 'Opening',
  manual: 'Journal',
};

export const SYSTEM_LEDGER_LABELS: Record<string, string> = {
  cash: 'Cash',
  opening_balance_equity: 'Opening Balance Equity',
  orders: 'Orders',
  inventory: 'Inventory',
  tax_on_purchases: 'Tax on Purchases',
  other_expenses: 'Other Expenses',
};

// Ledgers that are bookkeeping plumbing rather than accounts a user reasons about
// day-to-day - kept out of the type-grouped sections. Only OBE for now.
export const SECTIONED_SYSTEM_KEYS = ['opening_balance_equity'];

export function formatMoney(value: unknown): string {
  return (parseFloat(value as string) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Stored balances are Debit-positive, so the sign alone gives the side. Shown as a
// positive number plus Dr/Cr rather than a bare negative. Zero gets no suffix.
export function formatBalanceWithSide(value: unknown): string {
  const val = parseFloat(value as string) || 0;
  if (!val) return formatMoney(0);
  return `${formatMoney(Math.abs(val))} ${val > 0 ? 'Dr' : 'Cr'}`;
}

export function getCashLedger(ledgers: Ledger[]): Ledger | null {
  return ledgers.find((l) => l.system_key === 'cash') || null;
}

export function cashSideLabel(ledgers: Ledger[]): string {
  return getCashLedger(ledgers)?.name || 'Cash';
}

// The accounts a user can name on an entry: everything except cash, which is what
// leaving a side empty already means.
// Asset ledgers a payout's "amount received" leg can post to - excludes courier
// receivables (Asset-typed but not a deposit destination), same filter shape as
// partyLedgers() in logic/bills.ts.
export function postExCashLedgerOptions(ledgers: Ledger[]): Ledger[] {
  return ledgers.filter((l) => l.type === 'Asset' && !(l.system_key || '').startsWith('courier_'));
}

export function selectableLedgers(ledgers: Ledger[]): Ledger[] {
  return ledgers.filter((l) => l.system_key !== 'cash');
}

export function findLedgerByName(ledgers: Ledger[], name: string): Ledger | null {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  return ledgers.find((l) => String(l.name || '').trim().toLowerCase() === target) || null;
}

export function ledgerNameById(ledgers: Ledger[], id: string | null | undefined): string {
  const l = ledgers.find((x) => x.id === id);
  return l ? l.name : '(unknown)';
}

export interface LedgerStatementEntry {
  id: string;
  entry_date?: string;
  particulars?: string;
  voucher_type?: string;
  debit?: number;
  credit?: number;
  balance?: number;
  source_type?: 'transaction_entry' | 'bill';
  source_id?: string;
  [key: string]: unknown;
}
export interface LedgerMonthRow {
  id: string;
  month_row: true;
  month: string;
  collapsed: boolean;
  label: string;
  balance: number;
  runningBalance: number;
}

export function ledgerMonthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Inserts a divider row (month name, the month's own net movement and the running
 * balance at its close) ahead of each month's first entry. Rows must be newest-first
 * so the first row seen for a month is its closing one. Entries whose month is in
 * collapsedMonths are left out entirely, leaving just the clickable header behind. */
export function withLedgerMonthRows<R extends { entry_date?: string; balance: number; monthBalance: number }>(
  rows: R[], collapsedMonths: Set<string>,
): Array<R | LedgerMonthRow> {
  const out: Array<R | LedgerMonthRow> = [];
  let prevMonth: string | null = null;
  rows.forEach((row) => {
    const month = (row.entry_date || '').slice(0, 7);
    if (month && month !== prevMonth) {
      out.push({
        id: `__month__${month}`, month_row: true, month, collapsed: collapsedMonths.has(month), label: ledgerMonthLabel(month),
        balance: row.monthBalance, runningBalance: row.balance,
      });
      prevMonth = month;
    }
    if (!month || !collapsedMonths.has(month)) out.push(row);
  });
  return out;
}
