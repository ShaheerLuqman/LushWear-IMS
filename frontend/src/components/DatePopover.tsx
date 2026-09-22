// The app's single-date picker: Button activator + Popover holding a Polaris
// DatePicker, so a date field looks like the rest of the UI instead of the
// browser's native <input type="date">. Same ISO YYYY-MM-DD contract as
// DateRangePopover, whose date helpers it reuses; '' = no date.
import { useState } from 'react';
import { Button, DatePicker, Popover } from '@shopify/polaris';
import { getPKTDate } from '../logic/shared';
import { dateToIso, isoToDate } from './DateRangePopover';

export function formatDate(iso: string): string {
  return iso.split('-').reverse().join('/');
}

interface Props {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  title?: string;
  /** Hides the "x" - for fields where an empty date makes no sense. */
  clearable?: boolean;
  disabled?: boolean;
}

export function DatePopover({ value, onChange, placeholder = 'Select date', title, clearable = true, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [{ month, year }, setMonth] = useState(() => {
    const d = value ? isoToDate(value) : getPKTDate();
    return { month: d.getMonth(), year: d.getFullYear() };
  });

  function toggle() {
    // The value often arrives from a fetch after mount, so the month is picked
    // on open rather than only at mount - otherwise the calendar lands on today
    // while showing a date from another month as selected.
    if (!open && value) {
      const d = isoToDate(value);
      setMonth({ month: d.getMonth(), year: d.getFullYear() });
    }
    setOpen((v) => !v);
  }

  return (
    <span className="header-inline">
      <Popover
        active={open}
        onClose={() => setOpen(false)}
        preferredAlignment="left"
        activator={(
          <span title={title}>
            <Button disclosure disabled={disabled} onClick={toggle}>{value ? formatDate(value) : placeholder}</Button>
          </span>
        )}
      >
        <Popover.Section>
          <div className="date-popover-calendar">
          <DatePicker
            month={month} year={year}
            selected={value ? isoToDate(value) : undefined}
            onChange={({ start }) => { onChange(dateToIso(start)); setOpen(false); }}
            onMonthChange={(m, y) => setMonth({ month: m, year: y })}
          />
          </div>
        </Popover.Section>
      </Popover>
      {clearable && value && (
        <button type="button" className="date-range-picker-clear" title="Clear date" onClick={() => onChange('')}>&times;</button>
      )}
    </span>
  );
}
