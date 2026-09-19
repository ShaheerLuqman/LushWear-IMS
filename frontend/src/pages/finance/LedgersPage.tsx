// Ledgers list: cards grouped by type, search, create/edit. Ported from ledgers.js's
// renderLedgerCards + the createLedgerBtn/ledgerSearchFilter header controls.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { BlockStack, Button, Card, InlineGrid, InlineStack, Text } from '@shopify/polaris';
import { EditIcon, PlusIcon } from '@shopify/polaris-icons';
import { HeaderButton } from '../../components/HeaderButton';
import { SECTIONED_SYSTEM_KEYS, type Ledger } from '../../logic/ledgers';
import { useLedgersData } from './useLedgersData';
import { CreateLedgerModal, EditLedgerModal } from './LedgerModals';

function groupByType(ledgers: Ledger[]): Array<[string, Ledger[]]> {
  const groups: Record<string, Ledger[]> = {};
  for (const l of ledgers) {
    const type = l.type || 'Uncategorized';
    (groups[type] ||= []).push(l);
  }
  const types = Object.keys(groups).sort((a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)));
  return types.map((t) => [t, groups[t]]);
}

export function LedgersPage() {
  const navigate = useNavigate();
  const { ledgers, loading, loadLedgersList } = useLedgersData();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => { loadLedgersList(); }, [loadLedgersList]);

  usePageHeader({
    title: 'Ledgers',
    search: { value: search, onChange: setSearch },
    actions: <HeaderButton variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New Ledger</HeaderButton>,
  });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? ledgers.filter((l) => l.name.toLowerCase().includes(q)) : ledgers;
  }, [ledgers, search]);

  const systemLedgers = visible.filter((l) => l.system_key && SECTIONED_SYSTEM_KEYS.includes(l.system_key));
  const regularLedgers = visible.filter((l) => !(l.system_key && SECTIONED_SYSTEM_KEYS.includes(l.system_key)));
  const groups = groupByType(regularLedgers);
  if (systemLedgers.length) groups.push(['System', systemLedgers]);

  return (
    <BlockStack gap="500">
      {loading ? null : ledgers.length === 0 ? (
        <Text as="p" tone="subdued">No ledgers yet. Click "New Ledger" to add one.</Text>
      ) : visible.length === 0 ? (
        <Text as="p" tone="subdued">No ledgers match "{search.trim()}".</Text>
      ) : groups.map(([type, group]) => (
        <BlockStack gap="300" key={type}>
          <Text as="h3" variant="headingSm" tone="subdued">{type.toUpperCase()}</Text>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 4, xl: 6 }} gap="300">
            {group.map((l) => (
              <div className="card-link" key={l.id} role="link" tabIndex={0} onClick={() => navigate(`/ledgers/${l.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/ledgers/${l.id}`); }}>
                <Card padding="300">
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <Text as="span" fontWeight="semibold" truncate>{l.name}</Text>
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button icon={EditIcon} variant="tertiary" size="slim" accessibilityLabel="Edit ledger" onClick={() => setEditId(l.id)} />
                    </span>
                  </InlineStack>
                </Card>
              </div>
            ))}
          </InlineGrid>
        </BlockStack>
      ))}

      {createOpen && (
        <CreateLedgerModal
          ledgers={ledgers}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); loadLedgersList(); }}
        />
      )}
      {editId && (
        <EditLedgerModal
          ledgers={ledgers}
          ledgerId={editId}
          onClose={() => setEditId(null)}
          onSaved={() => { setEditId(null); loadLedgersList(); }}
          onDeleted={() => { setEditId(null); loadLedgersList(); }}
        />
      )}
    </BlockStack>
  );
}
