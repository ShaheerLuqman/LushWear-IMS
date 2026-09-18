// Loads/holds the ledgers list, shared by Transactions/Ledgers/Bills. Ported from
// ledgers.js's loadLedgersList/applyLedgerBalancePatches/updateCashInHand, including
// its localStorage cache-hydrate (folio pickers on Bills/Transactions painted stale
// ledgers instantly instead of empty while the real fetch was in flight).
import { useCallback, useMemo, useState } from 'react';
import { apiJson } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { getCashLedger, type Ledger, type LedgerBalancePatch } from '../../logic/ledgers';

const LEDGERS_CACHE_KEY_PREFIX = 'lushwear_ledgers_cache_';

export function useLedgersData() {
  const { account } = useAuth();
  const currentOrgId = account?.org_id || null;

  function cacheKey(): string | null {
    return currentOrgId ? `${LEDGERS_CACHE_KEY_PREFIX}${currentOrgId}` : null;
  }

  function readCache(): Ledger[] {
    const key = cacheKey();
    if (!key) return [];
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      return Array.isArray(cached) ? cached : [];
    } catch {
      return [];
    }
  }

  function saveCache(rows: Ledger[]) {
    const key = cacheKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(rows)); } catch { /* ignore */ }
  }

  const [ledgers, setLedgers] = useState<Ledger[]>(readCache);
  const [loading, setLoading] = useState(true);

  const loadLedgersList = useCallback(async () => {
    try {
      const rows = await apiJson<Ledger[]>('/ledgers/', { fallback: 'Failed to load ledgers' });
      setLedgers(rows);
      saveCache(rows);
    } catch (error) {
      console.error('Error loading ledgers:', error);
      setLedgers([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrgId]);

  // Applies balance(s) returned by a transaction entry write directly to state, so
  // Cash In Hand reflects the write with no extra fetch. Persisted so a cold-cache
  // view (Bills) doesn't serve pre-write balances on its next hydrate.
  const applyLedgerBalancePatches = useCallback((patches: LedgerBalancePatch | LedgerBalancePatch[] | null | undefined) => {
    if (!patches) return;
    const list = Array.isArray(patches) ? patches : [patches];
    setLedgers((prev) => {
      let patched = false;
      const next = prev.map((l) => {
        const patch = list.find((p) => p && p.ledger_id === l.id);
        if (!patch) return l;
        patched = true;
        return { ...l, balance: patch.balance };
      });
      if (patched) saveCache(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrgId]);

  // bankLedgerBalances + physicalCashInHand + total, for the Cash In Hand display/tooltip.
  const cashInHand = useMemo(() => {
    const bankLedgerBalances = ledgers.filter((l) => l.include_in_cash_in_hand).map((l) => ({ name: l.name, balance: parseFloat(String(l.balance)) || 0 }));
    const bankTotal = bankLedgerBalances.reduce((sum, b) => sum + b.balance, 0);
    const physicalCashInHand = parseFloat(String(getCashLedger(ledgers)?.balance)) || 0;
    return { bankLedgerBalances, bankTotal, physicalCashInHand, total: bankTotal + physicalCashInHand };
  }, [ledgers]);

  return { ledgers, setLedgers, loading, loadLedgersList, applyLedgerBalancePatches, cashInHand };
}
