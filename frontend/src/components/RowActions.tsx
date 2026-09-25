// Kebab menu for a table row (or, given a `label`, a "More actions"-style disclosure
// button) - Polaris Popover + ActionList.
import { useState } from 'react';
import { ActionList, Button, Popover, type ActionListItemDescriptor } from '@shopify/polaris';
import { MenuHorizontalIcon } from '@shopify/polaris-icons';

export function RowActions({ items, accessibilityLabel = 'More actions', label }: { items: ActionListItemDescriptor[]; accessibilityLabel?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  // Keep the column width stable when a row has nothing to offer.
  if (items.length === 0) return <span className="row-actions-spacer" />;
  return (
    <span className="row-actions">
      <Popover
        active={open} onClose={() => setOpen(false)} preferredAlignment="right" zIndexOverride={10100}
        activator={label
          ? <Button disclosure={open ? 'up' : 'down'} accessibilityLabel={accessibilityLabel} onClick={() => setOpen((v) => !v)}>{label}</Button>
          : <Button icon={MenuHorizontalIcon} variant="tertiary" size="slim" accessibilityLabel={accessibilityLabel} onClick={() => setOpen((v) => !v)} />}
      >
        <ActionList actionRole="menuitem" items={items.map((i) => ({ ...i, onAction: () => { setOpen(false); i.onAction?.(); } }))} />
      </Popover>
    </span>
  );
}
