// Kebab menu for a table row - Polaris Popover + ActionList.
import { useState } from 'react';
import { ActionList, Button, Popover, type ActionListItemDescriptor } from '@shopify/polaris';
import { MenuHorizontalIcon } from '@shopify/polaris-icons';

export function RowActions({ items, accessibilityLabel = 'More actions' }: { items: ActionListItemDescriptor[]; accessibilityLabel?: string }) {
  const [open, setOpen] = useState(false);
  // Keep the column width stable when a row has nothing to offer.
  if (items.length === 0) return <span className="row-actions-spacer" />;
  return (
    <span className="row-actions">
      <Popover
        active={open} onClose={() => setOpen(false)} preferredAlignment="right" zIndexOverride={10100}
        activator={<Button icon={MenuHorizontalIcon} variant="tertiary" size="slim" accessibilityLabel={accessibilityLabel} onClick={() => setOpen((v) => !v)} />}
      >
        <ActionList actionRole="menuitem" items={items.map((i) => ({ ...i, onAction: () => { setOpen(false); i.onAction?.(); } }))} />
      </Popover>
    </span>
  );
}
