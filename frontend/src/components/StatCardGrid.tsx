// Responsive grid of Polaris Cards, one stat each (dashboard collections, bill detail...).
import type { ReactNode } from 'react';
import { BlockStack, Card, InlineGrid, Text, type InlineGridProps } from '@shopify/polaris';

export interface StatCardTile { label: string; value: string; detail?: ReactNode; tone?: 'critical' | 'success' | 'subdued' }

export function StatCardGrid({ tiles, columns = { xs: 1, sm: 2, md: 3, lg: 4 } }: { tiles: StatCardTile[]; columns?: InlineGridProps['columns'] }) {
  return (
    <InlineGrid columns={columns} gap="300">
      {tiles.map((t) => (
        <Card key={t.label} padding="400">
          <BlockStack gap="100">
            <Text as="span" tone="subdued" variant="bodySm">{t.label}</Text>
            <Text as="span" variant="headingLg" tone={t.tone}>{t.value}</Text>
            {t.detail && (typeof t.detail === 'string' ? <Text as="span" tone="subdued" variant="bodySm">{t.detail}</Text> : t.detail)}
          </BlockStack>
        </Card>
      ))}
    </InlineGrid>
  );
}
