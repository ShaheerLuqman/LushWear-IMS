// Single import point for header-row action buttons (see OrdersPage.tsx for the
// reference look) - every page imports from here instead of '@shopify/polaris'
// directly, so their appearance can be changed everywhere at once.
import { forwardRef } from 'react';

export { Button as HeaderButton } from '@shopify/polaris';

/** For header controls that need a raw DOM node - date/time-range triggers mount a
 * third-party picker (easepick) directly onto the button element (see
 * dateRangePicker.ts), which Polaris's own <Button> can't expose since it doesn't
 * forward a ref. Markup/classes match <HeaderButton> exactly so it looks identical. */
export const HeaderRefButton = forwardRef<HTMLButtonElement, { label: string; title?: string }>(
  ({ label, title }, ref) => (
    <button
      ref={ref}
      type="button"
      className="Polaris-Button Polaris-Button--pressable Polaris-Button--variantSecondary Polaris-Button--sizeMedium Polaris-Button--textAlignCenter"
      title={title}
    >
      <span className="Polaris-Text--root Polaris-Text--bodySm Polaris-Text--medium">{label}</span>
    </button>
  ),
);
HeaderRefButton.displayName = 'HeaderRefButton';
