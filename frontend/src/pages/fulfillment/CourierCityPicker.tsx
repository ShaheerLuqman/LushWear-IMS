// Floating searchable dropdown for one row's courier-city field - same
// folio-dropdown-panel pattern as the Transactions ledger picker, reused here
// instead of a native <select>/<datalist> since either would mean building a
// 1000+-city option list once per visible row.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Cap on rendered options at once - the list can run to 1000+ cities, and building
// that many DOM nodes on every keystroke is real, felt latency. Narrows as you type.
const MAX_OPTIONS = 100;

export function CourierCityPicker({
  value, cities, loading, onChange,
}: {
  value: string | null;
  cities: string[];
  loading: boolean;
  onChange: (city: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number }>({ left: 0, minWidth: 200 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasCities = cities.length > 0;
  const placeholder = loading ? 'Loading…' : hasCities ? 'Select city' : '—';

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.folio-dropdown-panel') && target !== btnRef.current) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const filtered = (query.trim() ? cities.filter((c) => c.toLowerCase().includes(query.trim().toLowerCase())) : cities).slice(0, MAX_OPTIONS);
  const overflowCount = (query.trim() ? cities.filter((c) => c.toLowerCase().includes(query.trim().toLowerCase())) : cities).length - filtered.length;

  function openMenu() {
    if (!hasCities || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    // Flip above the button when a row near the bottom of the viewport wouldn't leave room.
    if (spaceBelow < 260 && rect.top > spaceBelow) setPos({ bottom: window.innerHeight - rect.top + 2, left: rect.left, minWidth: Math.max(rect.width, 200) });
    else setPos({ top: rect.bottom + 2, left: rect.left, minWidth: Math.max(rect.width, 200) });
    setQuery('');
    setOpen(true);
  }

  return (
    <>
      <button
        ref={btnRef} type="button" className={'folio-dropdown-btn fulfillment-courier-city-btn' + (open ? ' open' : '')} disabled={!hasCities}
        onClick={(e) => { e.stopPropagation(); openMenu(); }}
      >
        <span className="folio-dropdown-text">{value || placeholder}</span><span className="folio-dropdown-arrow">▼</span>
      </button>
      {open && createPortal(
        <div className="folio-dropdown-panel" style={pos}>
          <input ref={inputRef} type="text" className="folio-dropdown-search" placeholder="Search cities..." value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} />
          <div className="folio-dropdown-options">
            {filtered.map((c) => (
              <div key={c} className={'folio-dropdown-option' + (c === value ? ' selected' : '')} onClick={() => { onChange(c); setOpen(false); }}>{c}</div>
            ))}
            {filtered.length === 0 && <div className="folio-dropdown-empty">No cities found</div>}
            {overflowCount > 0 && <div className="folio-dropdown-empty">{overflowCount} more - keep typing to narrow down</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
