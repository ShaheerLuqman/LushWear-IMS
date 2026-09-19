// Product thumbnail + name + subtitle header used at the top of product modals.
import { BlockStack, InlineStack, Text, Thumbnail, type BadgeProps, Badge } from '@shopify/polaris';
import { ImageIcon } from '@shopify/polaris-icons';

export function ProductIdentity({ name, imageUrl, subtitle, badge }: {
  name: string; imageUrl?: string | null; subtitle: string; badge?: { label: string; tone: BadgeProps['tone'] };
}) {
  return (
    <InlineStack gap="300" blockAlign="center" wrap={false}>
      <Thumbnail source={imageUrl || ImageIcon} alt="" />
      <BlockStack gap="050">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingMd">{name}</Text>
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        </InlineStack>
        <Text as="p" tone="subdued">{subtitle}</Text>
      </BlockStack>
    </InlineStack>
  );
}
