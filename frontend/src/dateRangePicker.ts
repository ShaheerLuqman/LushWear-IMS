// Shared date-range popup (easepick), ported near-verbatim from utils.js's
// createDateRangePicker/buildDateRangePresets - imperative DOM code, wrapped
// by a small useEffect-based hook in each page that needs it.
import { create as createEasepick, DateTime, RangePlugin, PresetPlugin } from '@easepick/bundle';
import { getPKTDate } from './logic/shared';

export interface DateRangePreset {
  [label: string]: [DateTime, DateTime];
}

export function buildDateRangePresets({ includeAllTime = true, oldestStart }: { includeAllTime?: boolean; oldestStart?: Date } = {}): DateRangePreset {
  const pkt = getPKTDate();
  const y = pkt.getFullYear();
  const m = pkt.getMonth();
  const today = new Date(y, m, pkt.getDate());
  const addDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  const presets: DateRangePreset = {};
  if (includeAllTime && oldestStart) {
    presets['All Time'] = [new DateTime(oldestStart), new DateTime(today)];
  }
  return Object.assign(presets, {
    Today: [new DateTime(today), new DateTime(today)],
    Yesterday: [new DateTime(addDays(-1)), new DateTime(addDays(-1))],
    'Last 7 Days': [new DateTime(addDays(-6)), new DateTime(today)],
    'Last 30 Days': [new DateTime(addDays(-29)), new DateTime(today)],
    'This Month': [new DateTime(new Date(y, m, 1)), new DateTime(new Date(y, m + 1, 0))],
    'Last Month': [new DateTime(new Date(y, m - 1, 1)), new DateTime(new Date(y, m, 0))],
  });
}

export interface DateRangePickerHandle {
  picker: any;
  setLabel: (text: string, title?: string) => void;
  setClearable: (clearable: boolean) => void;
  destroy: () => void;
}

/** Wires an easepick RangePlugin+PresetPlugin popup onto `triggerBtn` - single-month
 * calendar, viewport-clamped, themed to the app's own colors via CSS vars, plus a small
 * "x" button after `triggerBtn` to clear it. */
export function createDateRangePicker(
  triggerBtn: HTMLElement,
  { onSelect, onClear, presets }: { onSelect: (from: string, to: string) => void; onClear?: () => void; presets?: DateRangePreset },
): DateRangePickerHandle | null {
  if (!triggerBtn) return null;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'date-range-picker-clear';
  clearBtn.style.display = 'none';
  clearBtn.title = 'Clear date range';
  clearBtn.innerHTML = '&times;';
  triggerBtn.insertAdjacentElement('afterend', clearBtn);
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClear?.();
  });

  const picker = new (createEasepick as any)({
    element: triggerBtn as any,
    css: ['https://cdn.jsdelivr.net/npm/@easepick/bundle@1.2.1/dist/index.css'],
    zIndex: 9999,
    format: 'DD/MM/YYYY',
    grid: 1,
    calendars: 1,
    autoApply: true,
    plugins: [RangePlugin, PresetPlugin],
    PresetPlugin: { position: 'left', customPreset: presets || buildDateRangePresets() },
  } as any);

  const themeStyle = document.createElement('style');
  themeStyle.textContent = `
        :host {
            --color-bg-default: var(--bg-card);
            --color-bg-secondary: var(--bg-secondary);
            --color-fg-default: var(--text-primary);
            --color-fg-secondary: var(--text-secondary);
            --color-fg-muted: var(--text-muted);
            --color-fg-primary: var(--accent-primary);
            --color-border-default: var(--border-color);
            --color-bg-inrange: color-mix(in srgb, var(--accent-primary) 18%, transparent);
            --color-btn-primary-bg: var(--accent-primary);
            --color-btn-primary-fg: #fff;
            --color-btn-primary-border: var(--accent-primary);
            --color-btn-secondary-bg: var(--bg-secondary);
            --color-btn-secondary-fg: var(--text-secondary);
            --color-btn-secondary-border: var(--border-color);
            --border-radius: 8px;
            font-family: var(--font-primary);
        }
        .container {
            max-width: calc(100vw - 16px);
            overflow: hidden;
            border-radius: var(--radius-lg);
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-lg);
        }
    `;
  (picker as any).ui.shadowRoot.appendChild(themeStyle);

  picker.on('select', (e: any) => {
    const { start, end } = e.detail;
    if (start && end) onSelect(start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'));
  });

  picker.on('show', () => {
    const container = (picker as any).ui.container as HTMLElement;
    const rect = container.getBoundingClientRect();
    const left = parseFloat(container.style.left) || 0;
    const top = parseFloat(container.style.top) || 0;
    const overflowRight = rect.right - (window.innerWidth - 8);
    const overflowLeft = 8 - rect.left;
    if (overflowRight > 0) container.style.left = `${left - overflowRight}px`;
    else if (overflowLeft > 0) container.style.left = `${left + overflowLeft}px`;
    const overflowBottom = rect.bottom - (window.innerHeight - 8);
    if (overflowBottom > 0) container.style.top = `${top - overflowBottom}px`;
  });

  return {
    picker,
    setLabel(text: string, title?: string) {
      const textEl = triggerBtn.querySelector<HTMLElement>('.Polaris-Text--root') ?? triggerBtn;
      textEl.textContent = text;
      if (title !== undefined) triggerBtn.title = title;
    },
    setClearable(clearable: boolean) {
      clearBtn.style.display = clearable ? '' : 'none';
    },
    destroy() {
      picker.destroy();
      clearBtn.remove();
    },
  };
}
