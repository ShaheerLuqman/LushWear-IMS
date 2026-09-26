// The app's one date-range filter, replacing the easepick popup: Button activator +
// Popover holding a preset list beside a Polaris range DatePicker. Ranges cross the
// boundary as ISO YYYY-MM-DD strings (what every API filter takes); null = no filter.
// Presets apply on click; calendar picks wait for Apply so a single-day range is
// possible (Polaris fires onChange with start === end on the first click).
import { useState } from 'react';
import { Button, DatePicker, InlineStack, OptionList, Popover, Text } from '@shopify/polaris';
import { getPKTDate } from '../logic/shared';

export interface DateRange { from: string; to: string }
export type DateRangePresets = Record<string, [Date, Date]>;

export function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function dateToIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDateRange({ from, to }: DateRange): string {
  const f = (iso: string) => iso.split('-').reverse().join('/');
  return from === to ? f(from) : `${f(from)} – ${f(to)}`;
}

export function buildDateRangePresets({ oldestStart }: { oldestStart?: Date } = {}): DateRangePresets {
  const pkt = getPKTDate();
  const y = pkt.getFullYear();
  const m = pkt.getMonth();
  const today = new Date(y, m, pkt.getDate());
  const addDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  return {
    ...(oldestStart ? { 'All Time': [oldestStart, today] as [Date, Date] } : {}),
    Today: [today, today],
    Yesterday: [addDays(-1), addDays(-1)],
    'Last 7 Days': [addDays(-6), today],
    'Last 30 Days': [addDays(-29), today],
    'This Month': [new Date(y, m, 1), new Date(y, m + 1, 0)],
    'Last Month': [new Date(y, m - 1, 1), new Date(y, m, 0)],
    'This Year': [new Date(y, 0, 1), new Date(y, 11, 31)],
    'Last Year': [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)],
  };
}

interface Props {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  presets?: DateRangePresets;
  /** Button text; defaults to the formatted range or the placeholder. */
  label?: string;
  placeholder?: string;
  title?: string;
  /** Hides the "x" - for pages where an empty range makes no sense. */
  clearable?: boolean;
}

export function DateRangePopover({ value, onChange, presets = buildDateRangePresets(), label, placeholder = 'Date range', title, clearable = true }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ start: Date; end: Date } | null>(null);
  const [{ month, year }, setMonth] = useState(() => {
    const d = value ? isoToDate(value.to) : getPKTDate();
    return { month: d.getMonth(), year: d.getFullYear() };
  });

  const selected = pending ?? (value ? { start: isoToDate(value.from), end: isoToDate(value.to) } : undefined);
  const activePreset = value ? Object.entries(presets).find(([, [s, e]]) => dateToIso(s) === value.from && dateToIso(e) === value.to)?.[0] : undefined;

  function commit(range: { start: Date; end: Date }) {
    onChange({ from: dateToIso(range.start), to: dateToIso(range.end) });
    setPending(null);
    setOpen(false);
  }

  return (
    <span className="header-inline">
      <Popover
        active={open}
        onClose={() => { setOpen(false); setPending(null); }}
        preferredAlignment="left"
        activator={<span title={title}><Button disclosure onClick={() => setOpen((v) => !v)}>{label ?? (value ? formatDateRange(value) : placeholder)}</Button></span>}
      >
        <InlineStack wrap={false}>
          <div className="date-range-presets">
            <OptionList
              options={Object.keys(presets).map((k) => ({ value: k, label: k }))}
              selected={activePreset ? [activePreset] : []}
              onChange={([k]) => { if (k) { const [start, end] = presets[k]; commit({ start, end }); } }}
            />
          </div>
          <Popover.Section>
            <DatePicker
              month={month} year={year} allowRange
              selected={selected}
              onChange={setPending}
              onMonthChange={(m, y) => setMonth({ month: m, year: y })}
            />
            <InlineStack align="end" gap="200" blockAlign="center">
              {pending && <Text as="span" tone="subdued" variant="bodySm">{formatDateRange({ from: dateToIso(pending.start), to: dateToIso(pending.end) })}</Text>}
              <Button variant="primary" size="slim" disabled={!pending} onClick={() => pending && commit(pending)}>Apply</Button>
            </InlineStack>
          </Popover.Section>
        </InlineStack>
      </Popover>
      {clearable && value && (
        <button type="button" className="date-range-picker-clear" title="Clear date range" onClick={() => onChange(null)}>&times;</button>
      )}
    </span>
  );
}
