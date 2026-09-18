// Ledgers list: cards grouped by type, search, create/edit. Ported from ledgers.js's
// renderLedgerCards + the createLedgerBtn/ledgerSearchFilter header controls.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageHeader } from '../../layout/PageHeaderContext';
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
    actions: (
      <>
        <div className="transaction-search-wrap">
          <i className="fa-solid fa-magnifying-glass transaction-search-icon" />
          <input className="transaction-search-filter" placeholder="Search ledgers..." autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}><i className="fa-solid fa-plus" /> New Ledger</button>
      </>
    ),
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
    <div className="ledger-list-container">
      <div className="ledger-cards">
        {loading ? null : ledgers.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', padding: 20 }}>No ledgers yet. Click "New Ledger" to add one.</p>
        ) : visible.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', padding: 20 }}>No ledgers match "{search.trim()}".</p>
        ) : groups.map(([type, group]) => (
          <div className="ledger-section" key={type}>
            <h3 className="ledger-section-header">{type}</h3>
            <div className="ledger-section-cards">
              {group.map((l) => (
                <div className="ledger-card" key={l.id} onClick={() => navigate(`/ledgers/${l.id}`)}>
                  <div className="ledger-card-info"><span className="ledger-card-name">{l.name}</span></div>
                  <div className="ledger-card-actions">
                    <button
                      type="button" className="ledger-edit-btn" title="Edit ledger" aria-label="Edit ledger"
                      onClick={(e) => { e.stopPropagation(); setEditId(l.id); }}
                    >
                      <img src="/assets/edit.png" alt="Edit" className="ledger-edit-icon" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

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
    </div>
  );
}
