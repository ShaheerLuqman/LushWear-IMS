// Label/value rows for report cards (P&L lines, summaries). `kind` picks the emphasis.
import { Box, InlineStack, Text, type TextProps } from '@shopify/polaris';
import type { ReactNode } from 'react';

export type KeyValueKind = 'head' | 'deduction' | 'subtotal' | 'final' | 'negative';
export interface KeyValueRow { label: ReactNode; value: ReactNode; kind?: KeyValueKind; key?: string }

const STYLE: Record<KeyValueKind, { weight: TextProps['fontWeight']; tone?: TextProps['tone']; border: boolean }> = {
  head: { weight: 'medium', tone: 'subdued', border: true },
  deduction: { weight: 'regular', tone: 'critical', border: false },
  subtotal: { weight: 'semibold', border: true },
  final: { weight: 'bold', tone: 'success', border: true },
  negative: { weight: 'bold', tone: 'critical', border: true },
};

export function KeyValueList({ rows }: { rows: KeyValueRow[] }) {
  return (
    <div className="kv-list">
      {rows.map((r, i) => {
        const style = r.kind ? STYLE[r.kind] : undefined;
        return (
          <Box key={r.key ?? (typeof r.label === 'string' ? r.label : i)} paddingBlock="150" borderBlockEndWidth={style?.border ? '025' : undefined} borderColor="border">
            <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
              <Text as="span" fontWeight={style?.weight} tone={r.kind === 'head' ? 'subdued' : undefined}>{r.label}</Text>
              <Text as="span" fontWeight={style?.weight} tone={style?.tone} alignment="end" numeric>{r.value}</Text>
            </InlineStack>
          </Box>
        );
      })}
    </div>
  );
}
