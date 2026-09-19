// Single import point for header-row action buttons (see OrdersPage.tsx for the
// reference look) - every page imports from here instead of '@shopify/polaris'
// directly, so their appearance can be changed everywhere at once.
export { Button as HeaderButton } from '@shopify/polaris';
