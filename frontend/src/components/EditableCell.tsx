// Inline-editable table cells (borderless slim TextFields), Shopify's own pattern for
// editable table values. Each keeps its own draft so typing doesn't re-render the table;
// the value is committed on blur only when it actually changed.
import { useEffect, useState } from 'react';
import { Text, TextField } from '@shopify/polaris';

const money = (v: unknown) => (parseFloat(String(v)) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Plain (no thousands separator) decimal string - comma-formatted drafts don't parse back.
const plainDecimal = (v: unknown) => (parseFloat(String(v)) || 0).toFixed(2);

export function EditableAmount({ value, editable, onSave, placeholder, emptyLabel }: {
  value: unknown; editable: boolean; onSave: (v: number) => void; placeholder?: string;
  /** Shown greyed, read-only, for a null value. */
  emptyLabel?: string;
}) {
  const [text, setText] = useState(() => (value == null && placeholder ? '' : plainDecimal(value)));
  useEffect(() => { setText(value == null && placeholder ? '' : plainDecimal(value)); }, [value, placeholder]);

  if (!editable) {
    if (value == null && emptyLabel) return <Text as="span" alignment="end" tone="subdued">{emptyLabel}</Text>;
    return <Text as="span" alignment="end" numeric>{value == null ? '' : money(value)}</Text>;
  }
  return (
    <TextField
      /* text, not number: Polaris renders a spin-button control for type="number" that
         eats ~30px, too much in a narrow table cell - validation still happens on blur. */
      label="" labelHidden autoComplete="off" type="text" inputMode="decimal" variant="borderless" align="right" size="slim"
      placeholder={placeholder} value={text} onChange={setText}
      onBlur={() => {
        const n = parseFloat(text.replace(/,/g, ''));
        // A blank (null) value differs from 0, so typing 0 into it still saves.
        const current = value == null && placeholder ? null : (parseFloat(String(value)) || 0);
        if (!isNaN(n) && n >= 0 && n !== current) onSave(n);
        else setText(value == null && placeholder ? '' : plainDecimal(value));
      }}
    />
  );
}

export function EditableText({ value, editable, onSave, placeholder, emptyLabel = '-' }: {
  value: string | null | undefined; editable: boolean; onSave: (v: string) => void; placeholder?: string; emptyLabel?: string;
}) {
  const [text, setText] = useState(value || '');
  useEffect(() => { setText(value || ''); }, [value]);
  if (!editable) return <Text as="span">{value || emptyLabel}</Text>;
  return (
    <TextField
      label="" labelHidden autoComplete="off" variant="borderless" size="slim" placeholder={placeholder}
      value={text} onChange={setText}
      onBlur={() => { const next = text.trim(); if (next !== (value || '')) onSave(next); }}
    />
  );
}
