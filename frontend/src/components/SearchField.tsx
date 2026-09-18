// Search box - the header's centered slot (PageHeader.search) and toolbar searches share it.
import { Icon, TextField } from '@shopify/polaris';
import { SearchIcon } from '@shopify/polaris-icons';

export function SearchField({ value, onChange, placeholder = 'Search...', autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean;
}) {
  return (
    <TextField
      label="Search" labelHidden autoComplete="off" clearButton autoFocus={autoFocus} size="slim"
      prefix={<Icon source={SearchIcon} />} placeholder={placeholder}
      value={value} onChange={onChange} onClearButtonClick={() => onChange('')}
    />
  );
}
