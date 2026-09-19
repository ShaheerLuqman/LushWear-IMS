// Search box - the header's centered slot (PageHeader.search) and toolbar searches share it.
// Typing is buffered locally and only reaches `onChange` after a 1s pause, so every keystroke
// doesn't re-filter the whole table; the clear button applies at once.
import { useEffect, useRef, useState } from 'react';
import { Icon, TextField } from '@shopify/polaris';
import { SearchIcon } from '@shopify/polaris-icons';

export function SearchField({ value, onChange, placeholder = 'Search any column...', autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { clearTimeout(timer.current); setDraft(value); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function handleChange(v: string) {
    setDraft(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), 1000);
  }

  return (
    <TextField
      label="Search" labelHidden autoComplete="off" clearButton autoFocus={autoFocus} size="slim" loading={draft !== value}
      prefix={<Icon source={SearchIcon} />} placeholder={placeholder}
      value={draft} onChange={handleChange} onClearButtonClick={() => { clearTimeout(timer.current); setDraft(''); onChange(''); }}
    />
  );
}
