// Free-text field with suggestions (a datalist, in Polaris clothes): Combobox + Listbox.
import { Combobox, Listbox } from '@shopify/polaris';

export function SuggestField({ label, value, onChange, suggestions, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; suggestions: string[]; placeholder?: string;
}) {
  const q = value.trim().toLowerCase();
  const matches = suggestions.filter((s) => s.toLowerCase().includes(q) && s !== value);
  return (
    <Combobox activator={<Combobox.TextField label={label} autoComplete="off" placeholder={placeholder} value={value} onChange={onChange} />}>
      {matches.length > 0 ? (
        <Listbox onSelect={onChange}>
          {matches.map((s) => <Listbox.Option key={s} value={s}>{s}</Listbox.Option>)}
        </Listbox>
      ) : null}
    </Combobox>
  );
}
