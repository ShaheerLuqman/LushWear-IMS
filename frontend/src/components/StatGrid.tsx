// Compact label/value tiles (product stock summary, analytics detail, ...).
import { BlockStack, Box, InlineGrid, Text } from '@shopify/polaris';

export function StatGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <InlineGrid columns={{ xs: 3, md: Math.min(rows.length, 6) }} gap="200">
      {rows.map(([label, value]) => (
        <Box key={label} background="bg-surface-secondary" padding="300" borderRadius="200">
          <BlockStack gap="050">
            <Text as="span" tone="subdued" variant="bodySm">{label}</Text>
            <Text as="span" fontWeight="semibold">{value}</Text>
          </BlockStack>
        </Box>
      ))}
    </InlineGrid>
  );
}
