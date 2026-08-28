// Shared multi-select checkbox filter: a popup of checkboxes (several values at once) used
// instead of a single-select dropdown, both as an AG Grid column filter and as a standalone
// toolbar control.
//
// Three exports, layered:
//   createCheckboxFilterPopup  - the bare UI (button + checkbox menu). Owns no selection state;
//                                it renders what it's given and reports back what was ticked.
//   makeCheckboxSetFilter      - AG Grid column filter (model: { values: [...] } - the row's
//   makeCheckboxFloatingFilter   value must be one of `values`; no model = no filtering) and the
//                                floating filter that drives it via api.setFilterModel().
//   createCheckboxFilterControl - standalone toolbar filter: owns its selection and calls
//                                onChange(selected) - for screens that filter in JS, not a grid.
//
// `getValues` is re-read on every popup open, so a filter whose options come from the data
// picks up newly loaded rows without any refresh plumbing.

/** Button + checkbox popup. `opts.getSelected()` returns the values that should be ticked when
 * the menu is (re)built; `opts.onApply(selected)` fires whenever the user ticks something. The
 * caller decides what selection means - a grid filter model, or its own state. */
function createCheckboxFilterPopup(opts) {
    const label = opts.displayLabel || ((v) => v);
    const popup = { values: [], checkboxes: {} };

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

    popup.updateButtonLabel = function (selected) {
        btn.textContent = selected.length === popup.values.length ? (opts.allLabel || 'All')
            : selected.length === 0 ? 'None'
            : selected.length === 1 ? label(selected[0])
            : `${selected.length} selected`;
        btn.title = selected.length && selected.length < popup.values.length
            ? selected.map(label).join(', ')
            : '';
    };

    const applySelection = () => {
        opts.onApply(popup.values.filter((v) => popup.checkboxes[v].checked));
    };

    // Rebuilt on each open so a data-driven option list stays current; what stays ticked comes
    // from getSelected(), not the old checkbox state, so values that disappeared from the data
    // don't resurrect a stale selection.
    popup.buildOptions = function (values) {
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
            popup.values.forEach((v) => { popup.checkboxes[v].checked = allCb.checked; });
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
                allCb.checked = popup.values.every((sv) => popup.checkboxes[sv].checked);
                applySelection();
            });
        });

        const ticked = values.filter((v) => popup.checkboxes[v].checked);
        allCb.checked = ticked.length === values.length;
        popup.updateButtonLabel(ticked);
    };

    /** Re-tick from the authoritative selection without firing onApply - for external changes
     * (a grid filter model update, a "clear filters" button). */
    popup.syncSelection = function (selected) {
        popup.values.forEach((v) => { popup.checkboxes[v].checked = selected.indexOf(v) !== -1; });
        const ticked = popup.values.filter((v) => popup.checkboxes[v].checked);
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

    popup._outsideClickHandler = (e) => {
        if (menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== btn) {
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

function makeCheckboxSetFilter(getRowValue) {
    function CheckboxSetFilter() {}
    CheckboxSetFilter.prototype.init = function (params) { this.params = params; this.model = null; };
    CheckboxSetFilter.prototype.getGui = function () {
        if (!this.eGui) this.eGui = document.createElement('div'); // no popup UI - the floating filter is the only UI
        return this.eGui;
    };
    CheckboxSetFilter.prototype.doesFilterPass = function (params) {
        if (!this.model) return true;
        return this.model.values.indexOf(getRowValue(params.data || {})) !== -1;
    };
    CheckboxSetFilter.prototype.isFilterActive = function () { return !!this.model; };
    CheckboxSetFilter.prototype.getModel = function () { return this.model; };
    CheckboxSetFilter.prototype.setModel = function (model) { this.model = model || null; };
    return CheckboxSetFilter;
}

function makeCheckboxFloatingFilter(getValues, displayLabel) {
    function CheckboxFloatingFilter() {}
    CheckboxFloatingFilter.prototype.init = function (params) {
        this.params = params;
        const api = params.api;
        const columnId = params.column.getColId();

        this.popup = createCheckboxFilterPopup({
            getValues,
            displayLabel,
            getSelected: (values) => {
                const model = (api.getFilterModel() || {})[columnId];
                return (model && Array.isArray(model.values)) ? model.values : values;
            },
            onApply: (selected) => {
                const newModel = Object.assign({}, api.getFilterModel() || {});
                if (selected.length === this.popup.values.length) {
                    delete newModel[columnId];
                } else {
                    newModel[columnId] = { values: selected };
                }
                api.setFilterModel(newModel);
            }
        });
        this.eGui = this.popup.eGui;
    };
    CheckboxFloatingFilter.prototype.getGui = function () { return this.eGui; };
    CheckboxFloatingFilter.prototype.onParentModelChanged = function (parentModel) {
        const selected = (parentModel && Array.isArray(parentModel.values)) ? parentModel.values : this.popup.values;
        this.popup.syncSelection(selected);
    };
    CheckboxFloatingFilter.prototype.destroy = function () { this.popup.destroy(); };
    return CheckboxFloatingFilter;
}

/** Standalone toolbar filter, for screens that filter in JS rather than through a grid's filter
 * model. Replaces the <select id=...> in place, keeps its own selection, and calls
 * onChange(selected) after every change. `selected` is every value when nothing is narrowed,
 * so callers can treat "all ticked" as "no filter". */
function createCheckboxFilterControl(selectId, opts) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return null;

    const control = { selected: null };
    const popup = createCheckboxFilterPopup({
        getValues: opts.getValues,
        displayLabel: opts.displayLabel,
        allLabel: opts.allLabel,
        getSelected: (values) => (control.selected === null ? (opts.defaultSelected ? opts.defaultSelected(values) : values) : control.selected),
        onApply: (selected) => {
            control.selected = selected;
            // No grid to echo the change back through (the way onParentModelChanged does for a
            // column filter), so the button label is ours to refresh.
            popup.updateButtonLabel(selected);
            opts.onChange(selected);
        }
    });

    // The button takes the <select>'s own classes so it keeps that element's look and its place
    // in the toolbar/filter-bar layout; the wrapper is just a positioning box around it.
    popup.eGui.className = 'checkbox-filter-control';
    popup.eGui.style.width = '';
    popup.btn.style.width = ''; // the grid variant stretches to its cell; here the class sizes it
    popup.btn.className = `${selectEl.className} checkbox-filter-control__btn`;
    if (selectEl.title) popup.btn.title = selectEl.title;
    selectEl.replaceWith(popup.eGui);

    control.popup = popup;
    /** Current selection, or null while nothing narrows the list (so callers skip filtering). */
    control.getSelected = () => control.selected;
    /** Re-read the option list after new data loads. An untouched control adopts its default
     * here rather than at construction, since the default is usually data-derived and there is
     * no data yet when the control is built. */
    control.refresh = () => {
        popup.buildOptions(opts.getValues());
        if (control.selected === null && opts.defaultSelected) {
            const ticked = popup.values.filter((v) => popup.checkboxes[v].checked);
            if (ticked.length !== popup.values.length) control.selected = ticked;
        }
    };
    control.reset = () => {
        control.selected = null;
        control.refresh();
    };
    return control;
}
