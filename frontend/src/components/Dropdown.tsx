// The app's one dropdown, built from Polaris primitives so it reads as Shopify UI:
// Button (disclosure) activator + Popover + OptionList. Covers plain selects,
// checkbox multi-selects (null = "all", the toolbar-filter convention) and
// searchable pickers.
import { useState } from 'react';
import { ActionList, Button, Icon, Labelled, OptionList, Popover, Text, TextField, type ButtonProps } from '@shopify/polaris';
import { SearchIcon } from '@shopify/polaris-icons';

export interface DropdownOption { value: string; label: string; disabled?: boolean }

interface Common {
  options: (string | DropdownOption)[];
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  tone?: ButtonProps['tone'];
  id?: string;
  /** Renders a Polaris field label above, like TextField's. */
  label?: string;
  helpText?: string;
  icon?: ButtonProps['icon'];
  /** Row pinned under the options, e.g. "+ Create new ledger...". */
  action?: { content: string; onAction: () => void };
}
type Single = Common & { multiple?: false; value: string; onChange: (v: string) => void };
type Multi = Common & { multiple: true; value: string[] | null; onChange: (v: string[] | null) => void; allLabel?: string };
export type DropdownProps = Single | Multi;

const ALL = '__all__';
// ponytail: flat cap on rendered rows (city lists run 1000+); paginate if a picker ever needs to browse past it.
const MAX_RENDERED = 100;

export function Dropdown(props: DropdownProps) {
  const { options, placeholder = 'Select...', searchable, disabled, fullWidth, variant, size, tone, id, label: fieldLabel, helpText, icon, action } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const all = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const q = query.trim().toLowerCase();
  const matched = q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;
  const shown = matched.slice(0, MAX_RENDERED);

  const ticked = props.multiple ? (props.value ?? all.map((o) => o.value)) : [props.value];
  const isAll = props.multiple && ticked.length === all.length;

  let label: string;
  if (props.multiple) {
    label = isAll ? (props.allLabel ?? 'All') : ticked.length === 0 ? 'None' : `${ticked.length} selected`;
  } else {
    label = all.find((o) => o.value === props.value)?.label ?? placeholder;
  }

  function close() { setOpen(false); setQuery(''); }

  function handleChange(next: string[]) {
    if (!props.multiple) {
      if (next[0] !== undefined) props.onChange(next[0]);
      close();
      return;
    }
    const hasAll = next.includes(ALL);
    if (hasAll !== isAll) { props.onChange(hasAll ? null : []); return; }
    const picked = next.filter((v) => v !== ALL);
    props.onChange(picked.length === all.length ? null : picked);
  }

  const listOptions = props.multiple && props.allLabel !== undefined && !q
    ? [{ value: ALL, label: props.allLabel }, ...shown]
    : shown;
  const selected = isAll ? [ALL, ...ticked] : ticked;

  const popover = (
    <Popover
      active={open}
      onClose={close}
      zIndexOverride={10100}
      preferredAlignment="left"
      autofocusTarget={searchable ? 'none' : 'first-node'}
      activator={(
        <Button
          id={id} disclosure={fullWidth && !variant ? 'select' : true} disabled={disabled} fullWidth={fullWidth} textAlign="left"
          variant={variant} size={size} tone={tone} icon={icon}
          onClick={() => setOpen((v) => !v)}
        >
          {label}
        </Button>
      )}
    >
      {searchable && (
        <Popover.Pane fixed>
          <Popover.Section>
            <TextField
              label="Search" labelHidden autoComplete="off" autoFocus clearButton
              prefix={<Icon source={SearchIcon} />} placeholder="Search..."
              value={query} onChange={setQuery} onClearButtonClick={() => setQuery('')}
            />
          </Popover.Section>
        </Popover.Pane>
      )}
      <Popover.Pane>
        <div className="dropdown-options">
          <OptionList options={listOptions} selected={selected} onChange={handleChange} allowMultiple={props.multiple} />
        </div>
        {shown.length === 0 && (
          <Popover.Section><Text as="p" tone="subdued">No matches</Text></Popover.Section>
        )}
        {matched.length > shown.length && (
          <Popover.Section><Text as="p" tone="subdued">{matched.length - shown.length} more - keep typing to narrow down</Text></Popover.Section>
        )}
      </Popover.Pane>
      {action && (
        <Popover.Pane fixed>
          <ActionList items={[{ content: action.content, onAction: () => { close(); action.onAction(); } }]} />
        </Popover.Pane>
      )}
    </Popover>
  );
  // Multi-selects get a floor wide enough for "NN selected" so the button doesn't resize
  // (and truncate) as the count changes.
  const sized = props.multiple ? <div className="dropdown--multi">{popover}</div> : popover;
  return fieldLabel ? <Labelled id={id ?? fieldLabel} label={fieldLabel} helpText={helpText}>{sized}</Labelled> : sized;
}
