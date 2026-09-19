// Header-row date input (YYYY-MM-DD value), sized to sit beside header buttons.
import { TextField } from '@shopify/polaris';

export function DateField({ value, onChange, label, prefix }: { value: string; onChange: (v: string) => void; label: string; prefix?: string }) {
  return (
    <div className="header-date">
      <TextField label={label} labelHidden type="date" autoComplete="off" size="slim" prefix={prefix} value={value} onChange={onChange} />
    </div>
  );
}
