// "One order number per line" textarea with a live count - shared by the bulk order modals.
import { TextField } from '@shopify/polaris';
import { parseOrderNumbersFromText } from '../logic/loadSheets';

export function OrderNumbersField({ value, onChange, label = 'Order numbers', rows = 8, autoFocus }: {
  value: string; onChange: (v: string) => void; label?: string; rows?: number; autoFocus?: boolean;
}) {
  const count = parseOrderNumbersFromText(value).length;
  return (
    <TextField
      label={label} autoComplete="off" multiline={rows} autoFocus={autoFocus} monospaced
      placeholder={'e.g. 7848\n7871\n7887'} helpText={`${count} ${count === 1 ? 'order' : 'orders'} · one per line`}
      value={value} onChange={onChange}
    />
  );
}
