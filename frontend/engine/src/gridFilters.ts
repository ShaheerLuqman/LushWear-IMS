// Shared multi-select checkbox filter for AG Grid columns - ported near-verbatim
// from grid-filters.js. AG Grid Community's own Set Filter (agSetColumnFilter) is
// an Enterprise-only feature, which is why this hand-rolled one exists; it's a
// plain object implementing AG Grid's IFilterComp/IFloatingFilterComp interfaces
// (init/getGui/doesFilterPass/getModel/setModel), so it works unchanged whether
// the grid around it is vanilla JS or ag-grid-react - AG Grid itself doesn't care.
//
// Three layers:
//   createCheckboxFilterPopup - the bare UI (button + checkbox menu).
//   makeCheckboxSetFilter / makeCheckboxFloatingFilter - the AG Grid column filter
//     (model: { values: [...] }) and its floating-filter button.
//   createCheckboxFilterControl - standalone toolbar filter for screens that filter
//     in JS rather than through a grid's filter model.

interface CheckboxFilterPopupOptions {
  getValues: () => string[];
  displayLabel?: (v: string) => string;
  allLabel?: string;
  getSelected: (values: string[]) => string[];
  onApply: (selected: string[]) => void;
}

interface CheckboxFilterPopup {
  eGui: HTMLElement;
  btn: HTMLButtonElement;
  values: string[];
  buildOptions: (values: string[]) => void;
  syncSelection: (selected: string[]) => void;
  updateButtonLabel: (selected: string[]) => void;
  destroy: () => void;
}

function createCheckboxFilterPopup(opts: CheckboxFilterPopupOptions): CheckboxFilterPopup {
  const label = opts.displayLabel || ((v: string) => v);
  const popup: any = { values: [], checkboxes: {} };

  const eGui = document.createElement('div');
  eGui.className = 'grid-floating-filter-wrap';
  eGui.style.width = '100%';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'grid-floating-filter-select';
  btn.style.width = '100%';
  btn.style.textAlign = 'left';
  btn.textContent = 'All';
  eGui.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'date-range-menu order-status-filter-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);

  popup.eGui = eGui;
  popup.btn = btn;
  popup.menu = menu;

  popup.updateButtonLabel = function (selected: string[]) {
    btn.textContent = selected.length === popup.values.length ? (opts.allLabel || 'All')
      : selected.length === 0 ? 'None'
      : selected.length === 1 ? label(selected[0])
      : `${selected.length} selected`;
    btn.title = selected.length && selected.length < popup.values.length ? selected.map(label).join(', ') : '';
  };

  const applySelection = () => {
    opts.onApply(popup.values.filter((v: string) => popup.checkboxes[v].checked));
  };

  popup.buildOptions = function (values: string[]) {
    const selected = opts.getSelected(values);
    popup.values = values;
    popup.checkboxes = {};
    menu.innerHTML = '';

    const allRow = document.createElement('label');
    allRow.className = 'order-status-filter-option order-status-filter-option--all';
    const allCb = document.createElement('input');
    allCb.type = 'checkbox';
    const allText = document.createElement('span');
    allText.textContent = 'All';
    allRow.appendChild(allCb);
    allRow.appendChild(allText);
    menu.appendChild(allRow);
    allCb.addEventListener('change', () => {
      popup.values.forEach((v: string) => { popup.checkboxes[v].checked = allCb.checked; });
      applySelection();
    });
    popup.allCb = allCb;

    values.forEach((v) => {
      const row = document.createElement('label');
      row.className = 'order-status-filter-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.indexOf(v) !== -1;
      const text = document.createElement('span');
      text.textContent = label(v);
      row.appendChild(cb);
      row.appendChild(text);
      menu.appendChild(row);
      popup.checkboxes[v] = cb;
      cb.addEventListener('change', () => {
        allCb.checked = popup.values.every((sv: string) => popup.checkboxes[sv].checked);
        applySelection();
      });
    });

    const ticked = values.filter((v) => popup.checkboxes[v].checked);
    allCb.checked = ticked.length === values.length;
    popup.updateButtonLabel(ticked);
  };

  popup.syncSelection = function (selected: string[]) {
    popup.values.forEach((v: string) => { popup.checkboxes[v].checked = selected.indexOf(v) !== -1; });
    const ticked = popup.values.filter((v: string) => popup.checkboxes[v].checked);
    if (popup.allCb) popup.allCb.checked = ticked.length === popup.values.length;
    popup.updateButtonLabel(ticked);
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.style.display === 'none') {
      popup.buildOptions(opts.getValues());
      const rect = btn.getBoundingClientRect();
      menu.style.display = 'block';
      const left = rect.left + window.scrollX;
      const maxLeft = window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8;
      menu.style.top = `${rect.bottom + window.scrollY}px`;
      menu.style.left = `${Math.max(window.scrollX + 8, Math.min(left, maxLeft))}px`;
    } else {
      menu.style.display = 'none';
    }
  });

  popup._outsideClickHandler = (e: MouseEvent) => {
    if (menu.style.display !== 'none' && !menu.contains(e.target as Node) && e.target !== btn) {
      menu.style.display = 'none';
    }
  };
  document.addEventListener('click', popup._outsideClickHandler);

  popup.destroy = function () {
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    document.removeEventListener('click', popup._outsideClickHandler);
  };

  popup.buildOptions(opts.getValues());
  return popup;
}

export function makeCheckboxSetFilter(getRowValue: (row: any) => string) {
  function CheckboxSetFilter(this: any) {}
  CheckboxSetFilter.prototype.init = function (params: any) { this.params = params; this.model = null; };
  CheckboxSetFilter.prototype.getGui = function () {
    if (!this.eGui) this.eGui = document.createElement('div');
    return this.eGui;
  };
  CheckboxSetFilter.prototype.doesFilterPass = function (params: any) {
    if (!this.model) return true;
    return this.model.values.indexOf(getRowValue(params.data || {})) !== -1;
  };
  CheckboxSetFilter.prototype.isFilterActive = function () { return !!this.model; };
  CheckboxSetFilter.prototype.getModel = function () { return this.model; };
  CheckboxSetFilter.prototype.setModel = function (model: any) { this.model = model || null; };
  return CheckboxSetFilter;
}

export function makeCheckboxFloatingFilter(getValues: () => string[], displayLabel?: (v: string) => string) {
  function CheckboxFloatingFilter(this: any) {}
  CheckboxFloatingFilter.prototype.init = function (params: any) {
    this.params = params;
    const api = params.api;
    const columnId = params.column.getColId();

    this.popup = createCheckboxFilterPopup({
      getValues,
      displayLabel,
      getSelected: (values) => {
        const model = (api.getFilterModel() || {})[columnId];
        return model && Array.isArray(model.values) ? model.values : values;
      },
      onApply: (selected) => {
        const newModel = Object.assign({}, api.getFilterModel() || {});
        if (selected.length === this.popup.values.length) {
          delete newModel[columnId];
        } else {
          newModel[columnId] = { values: selected };
        }
        api.setFilterModel(newModel);
      },
    });
    this.eGui = this.popup.eGui;
  };
  CheckboxFloatingFilter.prototype.getGui = function () { return this.eGui; };
  CheckboxFloatingFilter.prototype.onParentModelChanged = function (parentModel: any) {
    const selected = parentModel && Array.isArray(parentModel.values) ? parentModel.values : this.popup.values;
    this.popup.syncSelection(selected);
  };
  CheckboxFloatingFilter.prototype.destroy = function () { this.popup.destroy(); };
  return CheckboxFloatingFilter;
}
