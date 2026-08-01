// Trial Balance: every account with a non-zero balance, split into its Debit or
// Credit column, as at a date. The two totals matching is the proof the books
// balance — the control that did not exist before the journal (Phase 1).

let trialBalanceGridApi = null;
let trialBalanceAsOf = null;

function trialBalanceRowsWithTotal(data) {
    const rows = (data.rows || []).map(r => ({
        ...r,
        debit: parseFloat(r.debit) || 0,
        credit: parseFloat(r.credit) || 0,
    }));
    const totalRow = {
        account_id: '__total__',
        code: '',
        name: 'Total',
        type: '',
        debit: parseFloat(data.total_debit) || 0,
        credit: parseFloat(data.total_credit) || 0,
        _isFooter: true,
    };
    return { rows, totalRow };
}

// An out-of-balance trial balance means something wrote around the deferred
// debits=credits constraint. Say so loudly rather than showing two numbers and
// leaving the reader to spot the difference.
function renderTrialBalanceStatus(data) {
    const el = document.getElementById('trialBalanceStatus');
    if (!el) return;
    const difference = (parseFloat(data.total_debit) || 0) - (parseFloat(data.total_credit) || 0);
    if (data.balanced) {
        el.className = 'trial-balance-status trial-balance-status-ok';
        el.textContent = 'Balanced';
    } else {
        el.className = 'trial-balance-status trial-balance-status-bad';
        el.textContent = `Out of balance by Rs ${formatMoney(Math.abs(difference))}`;
    }
}

async function loadTrialBalance() {
    if (!trialBalanceAsOf) trialBalanceAsOf = getTodayDateString();
    const input = document.getElementById('trialBalanceAsOf');
    if (input) input.value = trialBalanceAsOf;

    if (trialBalanceGridApi) trialBalanceGridApi.showLoadingOverlay();
    let data;
    try {
        data = await apiJson(`/journal/trial-balance?as_of=${trialBalanceAsOf}`, {
            fallback: 'Failed to load trial balance'
        });
    } catch (error) {
        console.error('Error loading trial balance:', error);
        showToast('Failed to load trial balance', 'error');
        if (trialBalanceGridApi) trialBalanceGridApi.hideOverlay();
        return;
    }

    const { rows, totalRow } = trialBalanceRowsWithTotal(data);
    renderTrialBalanceStatus(data);
    if (trialBalanceGridApi) {
        trialBalanceGridApi.setGridOption('rowData', rows);
        trialBalanceGridApi.setGridOption('pinnedBottomRowData', [totalRow]);
        trialBalanceGridApi.hideOverlay();
    }
}

function initTrialBalanceGrid() {
    const gridDiv = document.getElementById('trialBalanceGrid');
    if (!gridDiv) return;

    const columnDefs = [
        { headerName: 'Code', field: 'code', width: 110 },
        { headerName: 'Account', field: 'name', flex: 2, minWidth: 180 },
        { headerName: 'Type', field: 'type', width: 140 },
        {
            headerName: 'Debit (Rs)',
            field: 'debit',
            width: 160,
            type: 'rightAligned',
            // Zero on a trial balance means "this account is on the other side",
            // not "zero rupees" — a blank cell reads that way, 0.00 doesn't.
            valueFormatter: (params) => (params.value ? formatMoney(params.value) : ''),
        },
        {
            headerName: 'Credit (Rs)',
            field: 'credit',
            width: 160,
            type: 'rightAligned',
            valueFormatter: (params) => (params.value ? formatMoney(params.value) : ''),
        },
    ];

    const gridOptions = {
        columnDefs,
        rowData: [],
        defaultColDef: { sortable: true, resizable: true, filter: true, minWidth: 90 },
        animateRows: true,
        pagination: false,
        domLayout: 'normal',
        getRowId: (params) => params.data.account_id,
        onGridReady: (params) => {
            trialBalanceGridApi = params.api;
        },
    };

    agGrid.createGrid(gridDiv, gridOptions);
}

function initTrialBalance() {
    initTrialBalanceGrid();
    document.getElementById('trialBalanceAsOf')?.addEventListener('change', (e) => {
        trialBalanceAsOf = e.target.value || getTodayDateString();
        loadTrialBalance();
    });
}
