// City Analytics: per-city volume & revenue, city-wise sales ranking, and a
// product-by-city breakdown table, with period-over-period deltas on the KPIs.
//
// Data comes from GET /products/analytics-by-city (the get_city_analytics RPC),
// which aggregates line_items by customer_city for the picked range and the
// equal-length window before it in one call. This file only shapes filters and
// renders - same basis and product resolution as product-analytics.js so the
// two screens never disagree on a line's product.

let _caInited = false;
let _caReqId = 0;
let _caData = null;   // { cities, cityProducts, hasPrev }

let caTimeRange = 'thisMonth';
let caCustomStart = '';
let caCustomEnd = '';
let caCollection = '';
let caSearch = '';
let _caSearchTimer = null;
let caMetric = 'revenue';   // 'revenue' | 'orders' - toggles the city list + matrix table

const CA_OLDEST = { year: 2024, month: 10, day: 22 };
const CA_TIME_PRESETS = [
    { key: 'max', label: 'All Time' },
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'last7', label: 'Last 7 days' },
    { key: 'last30', label: 'Last 30 days' },
    { key: 'thisWeek', label: 'This week' },
    { key: 'thisMonth', label: 'This month' },
];
const CA_MAX_CITIES = 8; // matrix table columns; rest fold into "+N more"

// ---------------------------------------------------------------- date helpers

function caToday() {
    const d = getPKTDate();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function caAddDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}
function caIsoDate(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
function caShortDate(date, withYear) {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
}
function caOldestDate() {
    return new Date(CA_OLDEST.year, CA_OLDEST.month - 1, CA_OLDEST.day);
}

function caRangeDates(key) {
    const today = caToday();
    switch (key) {
        case 'max': return [caOldestDate(), today];
        case 'today': return [today, today];
        case 'yesterday': { const y = caAddDays(today, -1); return [y, y]; }
        case 'last7': return [caAddDays(today, -7), caAddDays(today, -1)];
        case 'last30': return [caAddDays(today, -30), caAddDays(today, -1)];
        case 'thisWeek': { const dow = (today.getDay() + 6) % 7; return [caAddDays(today, -dow), today]; }
        case 'thisMonth': return [new Date(today.getFullYear(), today.getMonth(), 1), today];
        case 'custom': {
            const s = caCustomStart ? new Date(`${caCustomStart}T00:00:00`) : caAddDays(today, -30);
            const e = caCustomEnd ? new Date(`${caCustomEnd}T00:00:00`) : today;
            return s <= e ? [s, e] : [e, s];
        }
        default: return [new Date(today.getFullYear(), today.getMonth(), 1), today];
    }
}

function caRangeLabel() {
    if (caTimeRange === 'custom' && (!caCustomStart || !caCustomEnd)) return 'Custom date range';
    const [start, end] = caRangeDates(caTimeRange);
    const preset = CA_TIME_PRESETS.find((p) => p.key === caTimeRange);
    const sameDay = caIsoDate(start) === caIsoDate(end);
    const withYear = caTimeRange === 'max' || start.getFullYear() !== end.getFullYear();
    const range = sameDay ? caShortDate(start, withYear) : `${caShortDate(start, withYear)} – ${caShortDate(end, withYear)}`;
    return preset ? `${preset.label} (${range})` : range;
}

function caComparisonWord() {
    return { thisMonth: 'vs last month', today: 'vs yesterday', yesterday: 'vs day before', thisWeek: 'vs last week' }[caTimeRange]
        || 'vs previous period';
}

// ------------------------------------------------------------ view derivation

function caCollectionOptions() {
    const set = new Set();
    for (const r of ((_caData && _caData.cityProducts) || [])) set.add(r.collection || 'Uncategorized');
    return [...set].sort((a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)));
}

function caDeriveView() {
    const d = _caData || { cities: [], cityProducts: [], hasPrev: false };
    let cityProducts = d.cityProducts;
    if (caCollection) cityProducts = cityProducts.filter((r) => r.collection === caCollection);
    if (caSearch) {
        const q = caSearch.toLowerCase();
        cityProducts = cityProducts.filter((r) => r.name.toLowerCase().includes(q));
    }

    // Cities restricted to the filtered product set: recompute units/revenue from
    // cityProducts so the KPI/list numbers stay consistent with an active filter.
    const cityAgg = new Map();
    for (const r of cityProducts) {
        const b = cityAgg.get(r.city) || { city: r.city, units: 0, revenue: 0 };
        b.units += r.units;
        b.revenue += r.revenue;
        cityAgg.set(r.city, b);
    }
    const cityMeta = new Map(d.cities.map((c) => [c.city, c]));
    const cities = [...cityAgg.values()]
        .map((c) => ({ ...c, orders: (cityMeta.get(c.city) || {}).orders || 0 }))
        .sort((a, b) => b.revenue - a.revenue || b.units - a.units);

    const totals = {
        revenue: cities.reduce((s, c) => s + c.revenue, 0),
        units: cities.reduce((s, c) => s + c.units, 0),
        orders: (caCollection || caSearch) ? cities.reduce((s, c) => s + c.orders, 0) : d.cities.reduce((s, c) => s + (c.orders || 0), 0),
        cityCount: cities.length,
        productCount: new Set(cityProducts.map((r) => r.productId || r.name)).size,
    };

    const topCities = cities.slice(0, CA_MAX_CITIES);
    const moreCities = cities.length - topCities.length;

    const productAgg = new Map();
    for (const r of cityProducts) {
        const key = r.productId || `name:${r.name.toLowerCase()}`;
        const b = productAgg.get(key) || { key, name: r.name, collection: r.collection, total: 0, byCity: {} };
        b.total += (caMetric === 'orders' ? 0 : r.revenue);
        b.byCity[r.city] = { units: (b.byCity[r.city]?.units || 0) + r.units, revenue: (b.byCity[r.city]?.revenue || 0) + r.revenue };
        productAgg.set(key, b);
    }
    const products = [...productAgg.values()]
        .map((p) => ({ ...p, total: Object.values(p.byCity).reduce((s, v) => s + v.revenue, 0) }))
        .sort((a, b) => b.total - a.total);

    return { cities, topCities, moreCities, totals, products, hasPrev: d.hasPrev };
}

// ---------------------------------------------------------------- formatting

const caN = (n) => Math.round(n || 0).toLocaleString('en-US');
const caPKR = (n) => `Rs ${caN(n)}`;
const caPct = (part, whole) => (whole ? (part / whole) * 100 : 0);

function caDeltaHtml(cur, prev, hasPrev) {
    if (!hasPrev || (prev === 0 && cur === 0)) return '<span class="pa-delta pa-delta--flat">—</span>';
    if (prev === 0) return '<span class="pa-delta pa-delta--up"><i class="fa-solid fa-arrow-up"></i>new</span>';
    const pct = ((cur - prev) / prev) * 100;
    const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
    const icon = dir === 'up' ? 'fa-arrow-up' : dir === 'down' ? 'fa-arrow-down' : 'fa-minus';
    return `<span class="pa-delta pa-delta--${dir}"><i class="fa-solid ${icon}"></i>${Math.abs(pct).toFixed(1)}%</span>`;
}

// ------------------------------------------------------------------ render

function caCityBarList(view) {
    const max = Math.max(1, ...view.topCities.map((c) => c.revenue));
    const rows = view.topCities.map((c, i) => `
        <li class="ca-city-row">
            <span class="ca-city-rank">${i + 1}.</span>
            <span class="ca-city-name">${escapeHtml(c.city)}</span>
            <span class="ca-city-bar-track"><span class="ca-city-bar-fill" style="width:${((c.revenue / max) * 100).toFixed(1)}%"></span></span>
            <span class="ca-city-pct">${caPct(c.revenue, view.totals.revenue).toFixed(1)}%</span>
            <span class="ca-city-val">${caPKR(c.revenue)}</span>
        </li>`).join('');
    return `<ul class="ca-city-list">${rows || '<li class="pa-muted">No sales in this range.</li>'}</ul>
        ${view.moreCities > 0 ? `<p class="ca-city-more">+${view.moreCities} more cit${view.moreCities === 1 ? 'y' : 'ies'}</p>` : ''}`;
}

function caKpisHtml(view) {
    const t = view.totals;
    const card = (label, value) => `
        <div class="stat-card">
            <div class="stat-info">
                <span class="stat-label">${escapeHtml(label)}</span>
                <span class="stat-value">${escapeHtml(value)}</span>
            </div>
        </div>`;
    return `<div class="stats-grid">
        ${card('Total Sales', caPKR(t.revenue))}
        ${card('Total Orders', caN(t.orders))}
        ${card('Total Products Sold', caN(t.units))}
        ${card('Cities Covered', caN(t.cityCount))}
        ${card('Total Products', caN(t.productCount))}
    </div>`;
}

function caMatrixTable(view) {
    const cities = view.topCities;
    const rows = view.products.slice(0, 20).map((p) => {
        const cells = cities.map((c) => {
            const v = p.byCity[c.city];
            if (!v || (caMetric === 'revenue' ? !v.revenue : !v.units)) return '<td class="ca-matrix-empty">–</td>';
            return `<td>${caMetric === 'revenue' ? caPKR(v.revenue) : caN(v.units)}</td>`;
        }).join('');
        return `<tr>
            <td class="ca-matrix-product">
                <span class="ca-matrix-name">${escapeHtml(p.name)}</span>
                <span class="ca-matrix-sub">${escapeHtml(p.collection)}</span>
            </td>
            ${cells}
            <td class="ca-matrix-total">${caPKR(p.total)}</td>
        </tr>`;
    }).join('');
    const head = cities.map((c) => `<th>${escapeHtml(c.city)}</th>`).join('');
    return `<div class="pa-card">
        <div class="pa-table-wrap">
            <table class="pa-table ca-matrix-table">
                <thead><tr><th>Product</th>${head}<th>Total Sales</th></tr></thead>
                <tbody>${rows || `<tr><td colspan="${cities.length + 2}" class="pa-empty">No products match these filters.</td></tr>`}</tbody>
            </table>
        </div>
    </div>`;
}

function caRenderResults() {
    const view = caDeriveView();
    const el = document.getElementById('caResults');
    if (!el) return;
    el.innerHTML = `
        ${caKpisHtml(view)}
        <div class="ca-main-grid">
            <div class="pa-card ca-city-card">
                <div class="pa-widget-head">
                    <h3>City Wise Sales</h3>
                    <select id="caMetricSelect" class="pa-mini-select">
                        <option value="revenue"${caMetric === 'revenue' ? ' selected' : ''}>Amount</option>
                        <option value="orders"${caMetric === 'orders' ? ' selected' : ''}>Units</option>
                    </select>
                </div>
                ${caCityBarList(view)}
            </div>
            <div class="pa-card ca-donut-card">
                <div class="pa-widget-head"><h3>Top Products Overall</h3></div>
                ${caDonutHtml(view)}
            </div>
        </div>
        <div class="pa-widget-head ca-matrix-head"><h3>Product Performance by City</h3></div>
        ${caMatrixTable(view)}`;
}

function caDonutHtml(view) {
    const ranked = [...view.products].sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, 5);
    const othersTotal = ranked.slice(5).reduce((s, p) => s + p.total, 0);
    const slices = top.map((p) => ({ name: p.name, value: p.total }));
    if (othersTotal) slices.push({ name: 'Others', value: othersTotal });
    const total = view.totals.revenue;
    const legend = slices.map((s, i) => `
        <li><span class="pa-legend-dot pa-legend-dot--${i}"></span>
            <span class="pa-legend-name">${escapeHtml(s.name)}</span>
            <span class="pa-legend-val">${Math.round(caPct(s.value, total))}% (${caPKR(s.value)})</span></li>`).join('');
    return `<div class="pa-donut-wrap">${paDonut(slices, total, 'revenue')}<ul class="pa-legend-list">${legend || '<li class="pa-muted">No sales</li>'}</ul></div>`;
}

// ---------------------------------------------------------------- render: shell

/** #caTimeBtn's calendar/chevron icons flanking #caTimeLabel get wiped out by easepick's
 * own auto-set innerText on every select/clear (see createDateRangePicker, utils.js) -
 * rebuilt here (cheap, idempotent) before every label update rather than fighting that. */
function caSyncToolbar() {
    const btn = document.getElementById('caTimeBtn');
    if (!btn) return;
    if (!btn.querySelector('#caTimeLabel')) {
        btn.innerHTML = '<i class="fa-regular fa-calendar"></i><span id="caTimeLabel"></span><i class="fa-solid fa-chevron-down"></i>';
    }
    document.getElementById('caTimeLabel').textContent = caRangeLabel();
}

function caRenderShell() {
    const root = document.getElementById('cityAnalyticsRoot');
    if (!root) return;
    root.innerHTML = '<div id="caResults"></div>';
    caBindShellEvents();
}

function caBindHeaderEvents() {
    // Own preset set, not the shared default (buildDateRangePresets in utils.js) - this one's
    // last7/last30 end yesterday rather than today, since today's figures are still
    // accumulating, and it keeps "Maximum"/"This week" rather than "Last Month"/"All Time".
    const caTimePresets = () => {
        const DateTime = window.easepick.DateTime;
        const presets = {};
        CA_TIME_PRESETS.forEach((p) => {
            const [start, end] = caRangeDates(p.key);
            presets[p.label] = [new DateTime(start), new DateTime(end)];
        });
        return presets;
    };
    createDateRangePicker(document.getElementById('caTimeBtn'), {
        presets: caTimePresets(),
        // Map the picked dates back onto whichever preset (if any) produces that same
        // range, so caRangeLabel/caComparisonWord keep their preset-specific wording
        // ("This month (...)" / "vs last month") instead of always reading as a custom pick.
        onSelect: (from, to) => {
            const matched = CA_TIME_PRESETS.find((p) => {
                const [s, e] = caRangeDates(p.key);
                return caIsoDate(s) === from && caIsoDate(e) === to;
            });
            if (matched) {
                caTimeRange = matched.key;
            } else {
                caTimeRange = 'custom';
                caCustomStart = from;
                caCustomEnd = to;
            }
            caSyncToolbar();
            caRefreshData();
        },
    });

    document.getElementById('caCollectionSelect').addEventListener('change', (e) => {
        caCollection = e.target.value;
        caRenderResults();
    });
    document.getElementById('caSearchInput').addEventListener('input', (e) => {
        const value = e.target.value;
        clearTimeout(_caSearchTimer);
        _caSearchTimer = setTimeout(() => { caSearch = value.trim(); caRenderResults(); }, 200);
    });
    document.getElementById('caExportBtn').addEventListener('click', caExport);
}

function caBindShellEvents() {
    const results = document.getElementById('caResults');
    results.addEventListener('change', (e) => {
        if (e.target.id === 'caMetricSelect') { caMetric = e.target.value; caRenderResults(); }
    });
}


// ------------------------------------------------------------------- lifecycle

function caSyncCollectionSelect() {
    const sel = document.getElementById('caCollectionSelect');
    if (!sel) return;
    const want = caCollection;
    sel.innerHTML = ['<option value="">All collections</option>']
        .concat(caCollectionOptions().map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`))
        .join('');
    sel.value = want;
}

async function caRefreshData() {
    const results = document.getElementById('caResults');
    const reqId = ++_caReqId;
    if (results) results.innerHTML = `<div class="content-loading">
        <div class="content-loading-spinner"></div><p class="content-loading-text">Crunching sales by city…</p></div>`;
    try {
        const [start, end] = caRangeDates(caTimeRange);
        const data = await apiJson(
            `/products/analytics-by-city?start=${caIsoDate(start)}&end=${caIsoDate(end)}`,
            { fallback: 'Failed to load city analytics' },
        );
        if (reqId !== _caReqId) return;
        _caData = {
            cities: (data.cities || []).map((c) => ({
                city: c.city || 'Unknown',
                units: c.units || 0,
                revenue: Number(c.revenue) || 0,
                orders: c.orders || 0,
                products: c.products || 0,
                prevUnits: c.prev_units || 0,
                prevRevenue: Number(c.prev_revenue) || 0,
            })),
            cityProducts: (data.city_products || []).map((r) => ({
                city: r.city || 'Unknown',
                productId: r.product_id || null,
                name: r.name || '(unknown product)',
                collection: r.collection || 'Uncategorized',
                units: r.units || 0,
                revenue: Number(r.revenue) || 0,
            })),
            hasPrev: !!data.has_prev,
        };
        if (caCollection && !caCollectionOptions().includes(caCollection)) caCollection = '';
        caSyncCollectionSelect();
        caRenderResults();
    } catch (error) {
        if (reqId !== _caReqId) return;
        console.error('Error loading city analytics:', error);
        if (results) results.innerHTML = '<div class="no-data-message">Failed to load analytics. Please try again.</div>';
        showToast('Failed to load city analytics', 'error');
    }
}

function caExport() {
    if (typeof XLSX === 'undefined') { showToast('Excel export library is not loaded', 'error', { silent: true }); return; }
    const view = caDeriveView();
    if (!view.products.length) { showToast('Nothing to export', 'warning', { silent: true }); return; }
    const rows = view.products.map((p) => {
        const out = { Product: p.name, Collection: p.collection, 'Total Sales (PKR)': Math.round(p.total) };
        for (const c of view.cities) out[c.city] = Math.round((p.byCity[c.city] || {}).revenue || 0);
        return out;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'City Analytics');
    XLSX.writeFile(wb, `city-analytics-${caIsoDate(caToday())}.xlsx`);
}

function initCityAnalyticsView() {
    if (!_caInited) {
        _caInited = true;
        caBindHeaderEvents();
    }
    caRenderShell();
    caSyncToolbar();
    caRefreshData();
}
