// Checkbox multi-select toolbar filter (grid-filters.js's createCheckboxFilterControl,
// as a React component). null selection reads as "everything" (no filter applied).
import { useEffect, useState } from 'react';

export function MultiSelectFilterDropdown({
  allLabel, options, selected, onChange, displayLabel,
}: {
  allLabel: string;
  options: string[];
  selected: string[] | null;
  onChange: (v: string[] | null) => void;
  displayLabel?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ticked = selected ?? options;
  const label = displayLabel || ((v: string) => v);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const shown = options.length === 0 || ticked.length === options.length ? allLabel
    : ticked.length === 0 ? 'None'
    : ticked.length === 1 ? label(ticked[0])
    : `${ticked.length} selected`;

  function toggle(v: string) {
    const next = ticked.includes(v) ? ticked.filter((s) => s !== v) : [...ticked, v];
    onChange(next.length === options.length ? null : next);
  }

  return (
    <div className="pa-customize" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="form-input checkbox-filter-control__btn" onClick={() => setOpen((v) => !v)}>{shown}</button>
      {open && (
        <div className="pa-pop">
          <label><input type="checkbox" checked={ticked.length === options.length} onChange={() => onChange(ticked.length === options.length ? [] : null)} /> {allLabel}</label>
          {options.map((o) => <label key={o}><input type="checkbox" checked={ticked.includes(o)} onChange={() => toggle(o)} /> {label(o)}</label>)}
        </div>
      )}
    </div>
  );
}
