// Bulk text entry parsing for the Create Transaction Entry modal - ported 1:1 from
// transactions.js. Pure functions take `ledgers` explicitly instead of a global.
import { cashSideLabel, findLedgerByName, ledgerNameById, type Ledger } from './ledgers';
import { escapeHtml, formatAmount } from './shared';

export function getOrdersLedgerId(ledgers: Ledger[]): string | null {
  return ledgers.find((l) => l.system_key === 'orders')?.id || null;
}

export function orderAdvanceParticularPlaceholder(orderNumber: unknown): string {
  const num = String(orderNumber || '').trim().replace(/^#/, '');
  return num ? `Amount received for Order #${num}` : 'Amount received for Order #...';
}

/** Describes an entry by the sides it names; an unnamed side is cash and goes
 * unmentioned, which is how a plain cash entry has always read. */
export function defaultTransactionParticulars(fromName: string, toName: string): string {
  if (fromName && toName) return `${fromName} to ${toName}`;
  if (fromName) return `Amount received from ${fromName}`;
  if (toName) return `Amount transferred to ${toName}`;
  return '';
}

/** Multiple WhatsApp messages pasted together each carry their own
 * "[date, time] Name:" prefix - strip it so it isn't mistaken for part of the entry. */
export function stripWhatsappPrefix(line: string): string {
  return line.replace(/^\[[^\]]*\]\s*[^:]*:\s*/, '');
}

/** "order"/"orders" then optional "#" then 4+ digits, or a bare "#" then 4+ digits. */
export function extractOrderNumberFromText(text: string | null): string | null {
  const s = String(text || '');
  let m = s.match(/orders?\s*#?\s*(\d{4,})\b/i);
  if (m) return m[1];
  m = s.match(/#\s*(\d{4,})\b/);
  if (m) return m[1];
  return null;
}

interface ResolvedLedger { ledger: Ledger; orderNumber: string | null }

/** Resolve one side's name to a ledger. "Order# 11473" (or "Orders 11473") resolves
 * to the Orders account and carries the order number with it. */
function resolveBulkLedger(ledgers: Ledger[], name: string): ResolvedLedger | null {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const orderShorthand = trimmed.match(/^orders?\s*#?\s*(\d{4,})$/i);
  if (orderShorthand) {
    const ordersId = getOrdersLedgerId(ledgers);
    const ledger = ledgers.find((l) => l.id === ordersId);
    return ledger ? { ledger, orderNumber: orderShorthand[1] } : null;
  }
  const ledger = findLedgerByName(ledgers, trimmed);
  return ledger ? { ledger, orderNumber: null } : null;
}

type SplitResult = { fromName: string | null; toName: string | null; error?: undefined } | { error: string; fromName?: undefined; toName?: undefined };

/** Split "from A to B" / "from A" / "to B" into its two names. A ledger name can
 * itself contain " to " ("Cash to Bank Transfers"), so every possible split point
 * is tried and the first one where BOTH names resolve to a real ledger wins. */
function splitFromTo(ledgers: Ledger[], text: string): SplitResult {
  const lower = text.toLowerCase();

  if (lower.startsWith('to ')) {
    const name = text.slice(3).trim();
    return name ? { fromName: null, toName: name } : { error: 'Missing ledger name after "to".' };
  }
  if (!lower.startsWith('from ')) {
    return { error: 'Expected "from <ledger>" or "to <ledger>" after the amount.' };
  }

  const afterFrom = text.slice(5);
  const splits: Array<{ index: number; length: number }> = [];
  const re = /\s+to\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(afterFrom)) !== null) splits.push({ index: m.index, length: m[0].length });

  if (!splits.length) {
    const name = afterFrom.trim();
    return name ? { fromName: name, toName: null } : { error: 'Missing ledger name after "from".' };
  }

  for (const split of splits) {
    const fromName = afterFrom.slice(0, split.index).trim();
    const toName = afterFrom.slice(split.index + split.length).trim();
    if (fromName && toName && resolveBulkLedger(ledgers, fromName) && resolveBulkLedger(ledgers, toName)) {
      return { fromName, toName };
    }
  }

  // No split resolved, so the " to " is part of the name itself.
  const whole = afterFrom.trim();
  if (resolveBulkLedger(ledgers, whole)) return { fromName: whole, toName: null };

  const last = splits[splits.length - 1];
  return { fromName: afterFrom.slice(0, last.index).trim(), toName: afterFrom.slice(last.index + last.length).trim() };
}

export interface ParsedBulkEntry { amount: number; description: string; from_account_id: string | null; to_account_id: string | null; order_number?: string }
export interface ParsedBulkLine {
  ok: boolean; errors: string[]; lineNo: number; raw: string; blank?: boolean;
  cleaned?: string; amount?: number; particulars?: string; entries?: ParsedBulkEntry[]; orderNumber?: string | null;
}

/**
 * Parse one line of bulk-entry text: "<AMOUNT> from <LEDGER> to <LEDGER> (<PARTICULARS>)".
 * Either side may be omitted, and the omitted one is cash.
 */
export function parseBulkEntryLine(ledgers: Ledger[], raw: string, lineNo: number): ParsedBulkLine {
  const result: ParsedBulkLine = { ok: false, errors: [], lineNo, raw };
  const line = stripWhatsappPrefix(String(raw || '').trim());
  if (!line) return { ...result, blank: true };

  if (!/^[0-9][0-9,]*(?:\.[0-9]+)?\s+(from|to)\b/i.test(line)) {
    result.errors.push('Expected "<amount> from <ledger> to <ledger>".');
    return result;
  }
  result.cleaned = line;

  let particulars: string | null = null;
  let head = line;
  const parenMatch = line.match(/\(([^)]*)\)\s*$/);
  if (parenMatch) {
    particulars = parenMatch[1].trim();
    head = line.slice(0, parenMatch.index).trim();
  }

  const amountMatch = head.match(/^([0-9][0-9,]*(?:\.[0-9]+)?)\s+(.*)$/)!;
  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  if (Number.isNaN(amount) || amount <= 0) {
    result.errors.push('Amount must be a number greater than 0.');
    return result;
  }
  result.amount = amount;

  const sides = splitFromTo(ledgers, amountMatch[2].trim());
  if (sides.error) {
    result.errors.push(sides.error);
    return result;
  }

  const named = {
    from: sides.fromName ? resolveBulkLedger(ledgers, sides.fromName) : null,
    to: sides.toName ? resolveBulkLedger(ledgers, sides.toName) : null,
  };
  if (sides.fromName && !named.from) result.errors.push(`Ledger "${sides.fromName}" not found.`);
  if (sides.toName && !named.to) result.errors.push(`Ledger "${sides.toName}" not found.`);
  if (result.errors.length > 0) return result;

  // Naming the cash account is the same fact as leaving the side out.
  const cashId = ledgers.find((l) => l.system_key === 'cash')?.id || null;
  const from = named.from && named.from.ledger.id !== cashId ? named.from : null;
  const to = named.to && named.to.ledger.id !== cashId ? named.to : null;
  if (!from && !to) {
    result.errors.push(`Both sides are ${cashSideLabel(ledgers)} — name an account on one side.`);
    return result;
  }

  const ordersId = getOrdersLedgerId(ledgers);
  const fromIsOrders = !!(from && from.ledger.id === ordersId);
  const orderNumber = (from && from.orderNumber) || (fromIsOrders ? extractOrderNumberFromText(particulars) : null);

  const description = particulars
    || (fromIsOrders && orderNumber ? orderAdvanceParticularPlaceholder(orderNumber) : defaultTransactionParticulars(from?.ledger.name || '', to?.ledger.name || ''));
  result.particulars = particulars || '';

  const entry: ParsedBulkEntry = {
    amount: result.amount,
    description,
    from_account_id: from ? from.ledger.id : null,
    to_account_id: to ? to.ledger.id : null,
  };
  if (fromIsOrders && orderNumber) entry.order_number = orderNumber;

  result.entries = [entry];
  result.orderNumber = orderNumber || null;
  result.ok = true;
  return result;
}

export interface ParsedBulkText { lines: ParsedBulkLine[]; hasError: boolean; hasAny: boolean }

export function parseBulkEntryText(ledgers: Ledger[], text: string): ParsedBulkText {
  const rawLines = String(text || '').split(/\r?\n/);
  const lines: ParsedBulkLine[] = [];
  let hasError = false;
  let hasAny = false;
  rawLines.forEach((raw, i) => {
    const parsed = parseBulkEntryLine(ledgers, raw, i + 1);
    if (parsed.blank) return;
    lines.push(parsed);
    hasAny = true;
    if (!parsed.ok) hasError = true;
  });
  return { lines, hasError, hasAny };
}

function formatBulkAmount(val: number): string {
  return formatAmount(val);
}

/** Renders the validation list HTML shown under the bulk-entry textarea. */
export function bulkEntryValidationHtml(ledgers: Ledger[], parsed: ParsedBulkText): string {
  return parsed.lines.map((p) => {
    const displayText = p.cleaned || p.raw;
    if (p.ok) {
      const summary = (p.entries || []).map((e) => {
        const from = e.from_account_id ? ledgerNameById(ledgers, e.from_account_id) : cashSideLabel(ledgers);
        const to = e.to_account_id ? ledgerNameById(ledgers, e.to_account_id) : cashSideLabel(ledgers);
        const tag = e.order_number ? ` [Order #${escapeHtml(e.order_number)}]` : '';
        return `${formatBulkAmount(e.amount)} ${escapeHtml(from)} <i class="fa-solid fa-arrow-right"></i> ${escapeHtml(to)}${tag}`;
      }).join(' , ');
      return `<div class="bulk-entry-line bulk-entry-line-ok">`
        + `<span class="bulk-entry-line-no">${p.lineNo}</span>`
        + `<span class="bulk-entry-line-text">${escapeHtml(displayText)}</span>`
        + `<span class="bulk-entry-line-detail">${summary}</span>`
        + `</div>`;
    }
    return `<div class="bulk-entry-line bulk-entry-line-error">`
      + `<span class="bulk-entry-line-no">${p.lineNo}</span>`
      + `<span class="bulk-entry-line-text">${escapeHtml(displayText)}</span>`
      + `<span class="bulk-entry-line-detail">${p.errors.map((e) => escapeHtml(e)).join(' ')}</span>`
      + `</div>`;
  }).join('');
}
