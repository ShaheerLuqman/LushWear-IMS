// Product Analytics: per-product volume & revenue, size (variant) breakdown, a
// Hero / Zero (top-20% / bottom-20%) classification, period-over-period deltas,
// and trend / mix / size / insight widgets.
//
// Data comes from GET /products/analytics (the get_product_analytics RPC), which
// aggregates line_items for the picked range and the equal-length window before
// it in one call. This file only shapes filters, classifies, and renders.

let _paInited = false;
let _paReqId = 0;
let _paData = null;   // { rows, ordersByColl:{current,previous}, trend, hasPrev }

let paTimeRange = 'thisMonth';        // preset key or 'custom'
let paCustomStart = '';
let paCustomEnd = '';
let paCollection = '';                // '' = all collections
let paSegment = 'all';                // 'all' | 'hero' | 'zero'
let paTrendMetric = 'units';          // 'units' | 'revenue'
let paPage = 1;
let paPageSize = 10;
let _paTimeMenuOpen = false;
let _paCustomizeOpen = false;
let _paHeroDefOpen = false;
let paCols = paLoadCols();

const PA_BASE_SIZES = ['S', 'M', 'L', 'XL'];
const PA_PAGE_SIZES = [10, 25, 50, 100];
const PA_OLDEST = { year: 2024, month: 10, day: 22 };
const PA_TIME_PRESETS = [
    { key: 'max', label: 'Maximum' },
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'last7', label: 'Last 7 days' },
    { key: 'last30', label: 'Last 30 days' },
    { key: 'thisWeek', label: 'This week' },
    { key: 'thisMonth', label: 'This month' },
];

function paLoadCols() {
    try {
        const saved = JSON.parse(localStorage.getItem('lushwear_pa_cols') || '{}');
        return { revenue: true, delta: true, sizes: true, ...saved };
    } catch (e) { return { revenue: true, delta: true, sizes: true }; }
}
function paSaveCols() {
    try { localStorage.setItem('lushwear_pa_cols', JSON.stringify(paCols)); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- date helpers

function paToday() {
    const d = getPKTDate();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function paAddDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}
function paIsoDate(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
function paShortDate(date, withYear) {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
}
function paOldestDate() {
    return new Date(PA_OLDEST.year, PA_OLDEST.month - 1, PA_OLDEST.day);
}

/** [start, end] Date objects (inclusive) for a preset / custom range. */
function paRangeDates(key) {
    const today = paToday();
    switch (key) {
        case 'max': return [paOldestDate(), today];
        case 'today': return [today, today];
        case 'yesterday': { const y = paAddDays(today, -1); return [y, y]; }
        case 'last7': return [paAddDays(today, -7), paAddDays(today, -1)];
        case 'last30': return [paAddDays(today, -30), paAddDays(today, -1)];
        case 'thisWeek': { const dow = (today.getDay() + 6) % 7; return [paAddDays(today, -dow), today]; }
        case 'thisMonth': return [new Date(today.getFullYear(), today.getMonth(), 1), today];
        case 'custom': {
            const s = paCustomStart ? new Date(`${paCustomStart}T00:00:00`) : paAddDays(today, -30);
            const e = paCustomEnd ? new Date(`${paCustomEnd}T00:00:00`) : today;
            return s <= e ? [s, e] : [e, s];
        }
        default: return [new Date(today.getFullYear(), today.getMonth(), 1), today];
    }
}

function paRangeLabel() {
    if (paTimeRange === 'custom' && (!paCustomStart || !paCustomEnd)) return 'Custom date range';
    const [start, end] = paRangeDates(paTimeRange);
    const preset = PA_TIME_PRESETS.find((p) => p.key === paTimeRange);
    const sameDay = paIsoDate(start) === paIsoDate(end);
    const withYear = paTimeRange === 'max' || start.getFullYear() !== end.getFullYear();
    const range = sameDay ? paShortDate(start, withYear) : `${paShortDate(start, withYear)} – ${paShortDate(end, withYear)}`;
    return preset ? `${preset.label} (${range})` : range;
}

function paComparisonWord() {
    return { thisMonth: 'vs last month', today: 'vs yesterday', yesterday: 'vs day before', thisWeek: 'vs last week' }[paTimeRange]
        || 'vs previous period';
}

// ------------------------------------------------------------ view derivation

function paCollectionOptions() {
    const set = new Set();
    for (const r of ((_paData && _paData.rows) || [])) set.add(r.collection || 'Uncategorized');
    return [...set].sort((a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)));
}

function paClassify(sortedRows) {
    const sold = sortedRows.filter((r) => r.units > 0);
    const n = sold.length;
    const cls = new Map();
    if (!n) return cls;
    const u = sold.map((r) => r.units);
    const heroCut = u[Math.floor((n - 1) * 0.2)];
    const zeroCut = u[Math.ceil((n - 1) * 0.8)];
    const allEqual = u[0] === u[n - 1];
    for (const r of sortedRows) {
        if (r.units === 0) { cls.set(r.key, 'zero'); continue; }
        if (allEqual) { cls.set(r.key, 'average'); continue; }
        const isHero = r.units >= heroCut;
        const isZero = r.units <= zeroCut;
        cls.set(r.key, isHero && !isZero ? 'hero' : isZero && !isHero ? 'zero' : 'average');
    }
    return cls;
}

/** Trend series for one phase ('current' | 'previous'), collated by bucket and
 *  restricted to the collection filter. Returns aligned values + edge labels. */
function paTrendSeries(phase, metric) {
    const m = new Map();
    for (const t of ((_paData && _paData.trend) || [])) {
        if (t.phase !== phase) continue;
        if (paCollection && t.collection !== paCollection) continue;
        m.set(t.bucket, (m.get(t.bucket) || 0) + (metric === 'revenue' ? Number(t.revenue) || 0 : Number(t.units) || 0));
    }
    const buckets = [...m.keys()].sort();
    return {
        values: buckets.map((b) => m.get(b)),
        first: buckets.length ? paShortDate(new Date(`${buckets[0]}T00:00:00`)) : '',
        last: buckets.length ? paShortDate(new Date(`${buckets[buckets.length - 1]}T00:00:00`)) : '',
    };
}

function paDeriveView() {
    const d = _paData || { rows: [], ordersByColl: { current: {}, previous: {} }, trend: [], hasPrev: false };
    let rows = d.rows;
    if (paCollection) rows = rows.filter((r) => r.collection === paCollection);
    rows = [...rows].sort((a, b) => b.units - a.units || b.revenue - a.revenue || a.name.localeCompare(b.name));

    const cls = paClassify(rows);
    rows = rows.map((r, i) => ({ ...r, rank: i + 1, perf: cls.get(r.key) || 'average' }));

    const present = new Set();
    for (const r of rows) for (const s of Object.keys(r.sizes)) if (r.sizes[s] > 0) present.add(s);
    const sizes = [...PA_BASE_SIZES, ...[...present].filter((s) => !PA_BASE_SIZES.includes(s)).sort()];

    const collKey = paCollection || '__all__';
    const totals = {
        units: rows.reduce((s, r) => s + r.units, 0),
        revenue: rows.reduce((s, r) => s + r.revenue, 0),
        orders: (d.ordersByColl.current || {})[collKey] || 0,
    };
    totals.aov = totals.orders ? totals.revenue / totals.orders : 0;
    const prevTotals = {
        units: rows.reduce((s, r) => s + r.prevUnits, 0),
        revenue: rows.reduce((s, r) => s + r.prevRevenue, 0),
        orders: (d.ordersByColl.previous || {})[collKey] || 0,
    };
    prevTotals.aov = prevTotals.orders ? prevTotals.revenue / prevTotals.orders : 0;

    const segmentRows = paSegment === 'all' ? rows : rows.filter((r) => r.perf === paSegment);
    const heroRows = rows.filter((r) => r.perf === 'hero');
    const zeroRows = rows.filter((r) => r.perf === 'zero');

    return {
        rows, segmentRows, sizes, totals, prevTotals,
        hasPrev: d.hasPrev,
        hero: { count: heroRows.length, share: paPct(heroRows.reduce((s, r) => s + r.revenue, 0), totals.revenue) },
        zero: { count: zeroRows.length, share: paPct(zeroRows.reduce((s, r) => s + r.revenue, 0), totals.revenue) },
    };
}

// ---------------------------------------------------------------- formatting

const paN = (n) => Math.round(n || 0).toLocaleString('en-US');
const paPKR = (n) => `PKR ${paN(n)}`;
const paPct = (part, whole) => (whole ? (part / whole) * 100 : 0);

function paDeltaHtml(cur, prev, hasPrev) {
    if (!hasPrev || (prev === 0 && cur === 0)) return '<span class="pa-delta pa-delta--flat">—</span>';
    if (prev === 0) return '<span class="pa-delta pa-delta--up"><i class="fa-solid fa-arrow-up"></i>new</span>';
    const pct = ((cur - prev) / prev) * 100;
    const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
    const icon = dir === 'up' ? 'fa-arrow-up' : dir === 'down' ? 'fa-arrow-down' : 'fa-minus';
    return `<span class="pa-delta pa-delta--${dir}"><i class="fa-solid ${icon}"></i>${Math.abs(pct).toFixed(1)}%</span>`;
}

const PA_PERF_META = {
    hero: { label: 'Hero', icon: 'fa-trophy' },
    average: { label: 'Average', icon: 'fa-equals' },
    zero: { label: 'Zero', icon: 'fa-arrow-trend-down' },
};
const paPerfBadge = (perf) => {
    const m = PA_PERF_META[perf] || PA_PERF_META.average;
    return `<span class="pa-badge pa-badge--${perf}"><i class="fa-solid ${m.icon}"></i>${m.label}</span>`;
};
const paRankCell = (rank) => (rank <= 3
    ? `<span class="pa-medal pa-medal--${rank}">${rank}</span>`
    : `<span class="pa-rank">${rank}</span>`);

function paThumb(row) {
    const initial = escapeHtml((row.name || '?').replace(/[^a-z0-9]/i, '').slice(0, 1).toUpperCase() || '?');
    if (row.imageUrl) {
        return `<img class="pa-thumb" src="${escapeHtml(row.imageUrl)}" alt="" loading="lazy"
            onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'pa-thumb pa-thumb--fallback',textContent:'${initial}'}))">`;
    }
    return `<span class="pa-thumb pa-thumb--fallback">${initial}</span>`;
}

// ------------------------------------------------------------------ SVG charts

function paLineChart(cur, prev, metric) {
    const w = 560, h = 190, padX = 8, padTop = 12, padBot = 22;
    const max = Math.max(1, ...cur, ...prev);
    const n = Math.max(cur.length, 1);
    const x = (i) => padX + (n === 1 ? 0 : (i / (n - 1)) * (w - padX * 2));
    const y = (v) => h - padBot - (v / max) * (h - padTop - padBot);
    const line = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = cur.length ? `${line(cur)} L${x(cur.length - 1).toFixed(1)},${(h - padBot).toFixed(1)} L${x(0).toFixed(1)},${(h - padBot).toFixed(1)} Z` : '';
    const grid = [0.25, 0.5, 0.75, 1].map((f) => {
        const gy = (h - padBot - f * (h - padTop - padBot)).toFixed(1);
        return `<line x1="${padX}" x2="${w - padX}" y1="${gy}" y2="${gy}" class="pa-chart-grid"/>`;
    }).join('');
    const last = cur.length ? `<circle cx="${x(cur.length - 1).toFixed(1)}" cy="${y(cur[cur.length - 1]).toFixed(1)}" r="3.5" class="pa-chart-dot"/>` : '';
    const fmtMax = metric === 'revenue' ? paPKR(max) : paN(max);
    return `<svg class="pa-linechart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Sales trend">
        ${grid}
        ${prev.length ? `<path d="${line(prev)}" class="pa-chart-prev"/>` : ''}
        ${area ? `<path d="${area}" class="pa-chart-area"/>` : ''}
        ${cur.length ? `<path d="${line(cur)}" class="pa-chart-cur"/>` : ''}
        ${last}
        <text x="${padX}" y="10" class="pa-chart-axis">${escapeHtml(fmtMax)}</text>
    </svg>`;
}

function paDonut(slices, total, metric) {
    const r = 52, c = 2 * Math.PI * r, cx = 64, cy = 64;
    let offset = 0;
    const palette = ['var(--accent-primary)', 'var(--accent-secondary)', '#a78bfa', '#c4b5fd', 'var(--text-muted)'];
    const segs = slices.map((s, i) => {
        const frac = total ? s.value / total : 0;
        const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${palette[i] || 'var(--text-muted)'}"
            stroke-width="16" stroke-dasharray="${(frac * c).toFixed(2)} ${c.toFixed(2)}"
            stroke-dashoffset="${(-offset * c).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
        offset += frac;
        return seg;
    }).join('');
    return `<svg class="pa-donut" viewBox="0 0 128 128" role="img" aria-label="Top products by ${metric}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border-color)" stroke-width="16"/>
        ${segs}
        <text x="64" y="60" class="pa-donut-total">${escapeHtml(metric === 'revenue' ? paN(total) : paN(total))}</text>
        <text x="64" y="76" class="pa-donut-label">Total ${metric === 'revenue' ? 'PKR' : 'units'}</text>
    </svg>`;
}

// ---------------------------------------------------------------- render: results

function paRenderResults() {
    const view = paDeriveView();
    const el = document.getElementById('paResults');
    if (!el) return;

    document.querySelectorAll('.pa-seg-btn[data-seg="hero"] .pa-seg-count').forEach((n) => { n.textContent = view.hero.count; });
    document.querySelectorAll('.pa-seg-btn[data-seg="zero"] .pa-seg-count').forEach((n) => { n.textContent = view.zero.count; });

    const pageCount = Math.max(1, Math.ceil(view.segmentRows.length / paPageSize));
    if (paPage > pageCount) paPage = pageCount;
    const startIdx = (paPage - 1) * paPageSize;
    const pageRows = view.segmentRows.slice(startIdx, startIdx + paPageSize);

    const showSizes = paCols.sizes && view.sizes.length;
    const sizeHead = showSizes ? view.sizes.map((s) => `<th class="pa-col-size">${escapeHtml(s)}</th>`).join('') : '';
    const colCount = 3 + (paCols.revenue ? 1 : 0) + (paCols.delta ? 1 : 0) + (showSizes ? view.sizes.length : 0) + 2;

    const rowsHtml = pageRows.map((r) => {
        const sizeCells = showSizes ? view.sizes.map((s) => {
            const q = r.sizes[s] || 0;
            if (!q) return '<td class="pa-col-size pa-size-empty">–</td>';
            return `<td class="pa-col-size"><span class="pa-size-q">${paN(q)}</span><span class="pa-size-pct">${((q / r.units) * 100).toFixed(1)}%</span></td>`;
        }).join('') : '';
        return `<tr>
            <td class="pa-col-rank">${paRankCell(r.rank)}</td>
            <td class="pa-col-product">
                <div class="pa-product">${paThumb(r)}
                    <div class="pa-product-text">
                        <span class="pa-product-name">${escapeHtml(r.name)}</span>
                        <span class="pa-product-sub">${escapeHtml(r.collection)} · ${paN(r.variantCount)} variants · ${paN(r.stock)} in stock</span>
                    </div>
                </div>
            </td>
            <td class="pa-col-total"><span class="pa-total-q">${paN(r.units)}</span><span class="pa-total-sub">${Math.round(paPct(r.units, view.totals.units))}% of shown</span></td>
            ${paCols.revenue ? `<td class="pa-col-rev">${paPKR(r.revenue)}</td>` : ''}
            ${paCols.delta ? `<td class="pa-col-delta"><span class="pa-delta-prev">${paN(r.prevUnits)}</span>${paDeltaHtml(r.units, r.prevUnits, view.hasPrev)}</td>` : ''}
            ${sizeCells}
            <td class="pa-col-perf">${paPerfBadge(r.perf)}</td>
            <td class="pa-col-kebab"><button type="button" class="pa-kebab" data-key="${escapeHtml(r.key)}" aria-label="Product actions"><i class="fa-solid fa-ellipsis-vertical"></i></button></td>
        </tr>`;
    }).join('');

    // pager: 1 … n
    const pages = [];
    for (let p = 1; p <= pageCount; p++) {
        if (p === 1 || p === pageCount || Math.abs(p - paPage) <= 1) pages.push(p);
        else if (pages[pages.length - 1] !== '…') pages.push('…');
    }
    const pagerBtns = pages.map((p) => p === '…'
        ? '<span class="pa-pager-gap">…</span>'
        : `<button type="button" class="pa-pager-btn${p === paPage ? ' is-active' : ''}" data-goto="${p}">${p}</button>`).join('');

    const shownFrom = view.segmentRows.length ? startIdx + 1 : 0;
    const shownTo = Math.min(startIdx + paPageSize, view.segmentRows.length);

    el.innerHTML = `
        ${paKpisHtml(view)}
        ${paHeroBandHtml(view)}
        <div class="pa-card">
            <div class="pa-table-wrap">
                <table class="pa-table">
                    <thead>
                        ${showSizes ? `<tr class="pa-thead-group">
                            <th></th><th></th><th></th>
                            ${paCols.revenue ? '<th></th>' : ''}${paCols.delta ? '<th></th>' : ''}
                            <th class="pa-group-variants" colspan="${view.sizes.length}">Variants Sold (Units)</th>
                            <th></th><th></th>
                        </tr>` : ''}
                        <tr class="pa-thead-cols">
                            <th class="pa-col-rank">#</th>
                            <th class="pa-col-product">Product</th>
                            <th class="pa-col-total">Total Sold<span>Units</span></th>
                            ${paCols.revenue ? '<th class="pa-col-rev">Revenue<span>PKR</span></th>' : ''}
                            ${paCols.delta ? '<th class="pa-col-delta">vs Previous<span>Units</span></th>' : ''}
                            ${sizeHead}
                            <th class="pa-col-perf">Performance</th>
                            <th class="pa-col-kebab"></th>
                        </tr>
                    </thead>
                    <tbody>${pageRows.length ? rowsHtml : `<tr><td colspan="${colCount}" class="pa-empty">No products match these filters.</td></tr>`}</tbody>
                </table>
            </div>
            <div class="pa-pagination">
                <label class="pa-page-size">Rows per page
                    <select id="paPageSizeSelect">${PA_PAGE_SIZES.map((n) => `<option value="${n}"${n === paPageSize ? ' selected' : ''}>${n}</option>`).join('')}</select>
                </label>
                <span class="pa-page-info">Showing ${shownFrom} to ${shownTo} of ${view.segmentRows.length} products</span>
                <div class="pa-pager">
                    <button type="button" class="pa-pager-btn" data-goto="${Math.max(1, paPage - 1)}" ${paPage <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
                    ${pagerBtns}
                    <button type="button" class="pa-pager-btn" data-goto="${Math.min(pageCount, paPage + 1)}" ${paPage >= pageCount ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
                </div>
            </div>
        </div>
        ${paWidgetsHtml(view)}`;
}

function paKpisHtml(view) {
    const t = view.totals, p = view.prevTotals;
    const card = (mod, icon, label, value, cur, prev) => `
        <div class="pa-kpi pa-kpi--${mod}">
            <div class="pa-kpi-top">
                <span class="pa-kpi-label">${escapeHtml(label)}</span>
                <span class="pa-kpi-icon"><i class="fa-solid ${icon}"></i></span>
            </div>
            <span class="pa-kpi-value">${escapeHtml(value)}</span>
            <div class="pa-kpi-foot">
                <span class="pa-kpi-prev">${escapeHtml(paComparisonWord())}: ${escapeHtml(view.hasPrev ? (mod === 'revenue' || mod === 'aov' ? paPKR(prev) : paN(prev)) : '—')}</span>
                ${paDeltaHtml(cur, prev, view.hasPrev)}
            </div>
        </div>`;
    return `<div class="pa-kpis">
        ${card('units', 'fa-box', 'Total Units Sold', paN(t.units), t.units, p.units)}
        ${card('revenue', 'fa-sack-dollar', 'Total Revenue', paPKR(t.revenue), t.revenue, p.revenue)}
        ${card('orders', 'fa-receipt', 'Orders', paN(t.orders), t.orders, p.orders)}
        ${card('aov', 'fa-tags', 'Avg. Order Value', paPKR(t.aov), t.aov, p.aov)}
    </div>`;
}

function paHeroBandHtml(view) {
    return `<div class="pa-hero-band">
        <div class="pa-hero-stat">
            <span class="pa-hero-ic pa-hero-ic--hero"><i class="fa-solid fa-star"></i></span>
            <div><strong>Hero: top 20% of products (${view.hero.count})</strong>
                <span>Contribute ${view.hero.share.toFixed(1)}% of total revenue.</span></div>
        </div>
        <div class="pa-hero-stat">
            <span class="pa-hero-ic pa-hero-ic--zero"><i class="fa-solid fa-arrow-trend-down"></i></span>
            <div><strong>Zero: bottom 20% of products (${view.zero.count})</strong>
                <span>Contribute only ${view.zero.share.toFixed(1)}% of total revenue.</span></div>
        </div>
        <button type="button" id="paHeroDefBtn" class="pa-hero-def-btn">View definition <i class="fa-solid fa-circle-info"></i></button>
        <div class="pa-hero-def" ${_paHeroDefOpen ? '' : 'hidden'}>
            Products are ranked by units sold within the current collection and range.
            <strong>Hero</strong> = the top ~20% (ties included); <strong>Zero</strong> = the bottom ~20%, including products with no sales; everything between is <strong>Average</strong>.
        </div>
    </div>`;
}

function paWidgetsHtml(view) {
    const curTrend = paTrendSeries('current', paTrendMetric);
    const prevTrend = view.hasPrev ? paTrendSeries('previous', paTrendMetric) : { values: [], first: '', last: '' };
    const cur = curTrend.values;
    const prev = prevTrend.values;

    // donut: top 5 products by units + Others
    const ranked = [...view.rows].filter((r) => r.units > 0).sort((a, b) => b.units - a.units);
    const top = ranked.slice(0, 5);
    const othersUnits = ranked.slice(5).reduce((s, r) => s + r.units, 0);
    const slices = top.map((r) => ({ name: r.name, value: r.units }));
    if (othersUnits) slices.push({ name: 'Others', value: othersUnits });
    const donutTotal = view.totals.units;
    const legend = slices.map((s, i) => `
        <li><span class="pa-legend-dot pa-legend-dot--${i}"></span>
            <span class="pa-legend-name">${escapeHtml(s.name)}</span>
            <span class="pa-legend-val">${Math.round(paPct(s.value, donutTotal))}% (${paN(s.value)})</span></li>`).join('');

    // size breakdown
    const bySize = {};
    for (const r of view.rows) for (const [s, q] of Object.entries(r.sizes)) bySize[s] = (bySize[s] || 0) + q;
    const sizeRows = view.sizes.filter((s) => bySize[s]).map((s) => `
        <tr><td>${escapeHtml(s)}</td><td>${paN(bySize[s])}</td><td>${paPct(bySize[s], view.totals.units).toFixed(1)}%</td></tr>`).join('');
    const topSizeEntry = Object.entries(bySize).sort((a, b) => b[1] - a[1])[0];

    // key insights
    const sold = ranked;
    const drop = [...view.rows].filter((r) => r.prevUnits > 0 && r.units < r.prevUnits)
        .sort((a, b) => (a.units / a.prevUnits) - (b.units / b.prevUnits))[0];
    const insights = [];
    if (sold[0]) insights.push({ ic: 'fa-arrow-trend-up', tint: 'hero', t: sold[0].name, d: `Your top seller — ${paN(sold[0].units)} units this period.` });
    if (drop && view.hasPrev) {
        const pct = ((drop.prevUnits - drop.units) / drop.prevUnits) * 100;
        insights.push({ ic: 'fa-arrow-trend-down', tint: 'zero', t: drop.name, d: `Sales dropped ${pct.toFixed(1)}% ${paComparisonWord()}.` });
    }
    if (topSizeEntry) insights.push({ ic: 'fa-shirt', tint: 'info', t: `Size ${topSizeEntry[0]}`, d: `Most preferred size (${paPct(topSizeEntry[1], view.totals.units).toFixed(1)}%).` });

    return `<div class="pa-widgets">
        <section class="pa-widget pa-widget--trend">
            <div class="pa-widget-head">
                <h3>Sales Trend</h3>
                <select id="paTrendMetric" class="pa-mini-select">
                    <option value="units"${paTrendMetric === 'units' ? ' selected' : ''}>Units</option>
                    <option value="revenue"${paTrendMetric === 'revenue' ? ' selected' : ''}>Revenue</option>
                </select>
            </div>
            <div class="pa-trend-legend">
                <span><i class="pa-swatch pa-swatch--cur"></i>This period</span>
                ${prev.length ? '<span><i class="pa-swatch pa-swatch--prev"></i>Previous period</span>' : ''}
            </div>
            ${paLineChart(cur, prev, paTrendMetric)}
            <div class="pa-trend-axis"><span>${escapeHtml(curTrend.first)}</span><span>${escapeHtml(curTrend.last)}</span></div>
        </section>

        <section class="pa-widget">
            <div class="pa-widget-head"><h3>Top Products by Units</h3></div>
            <div class="pa-donut-wrap">${paDonut(slices, donutTotal, 'units')}<ul class="pa-legend-list">${legend || '<li class="pa-muted">No sales</li>'}</ul></div>
        </section>

        <section class="pa-widget">
            <div class="pa-widget-head"><h3>Size Breakdown</h3></div>
            <table class="pa-size-table">
                <thead><tr><th>Size</th><th>Units</th><th>% of total</th></tr></thead>
                <tbody>${sizeRows || '<tr><td colspan="3" class="pa-muted">No sales</td></tr>'}</tbody>
            </table>
        </section>

        <section class="pa-widget">
            <div class="pa-widget-head"><h3>Key Insights</h3></div>
            <ul class="pa-insight-list">
                ${insights.map((i) => `<li><span class="pa-insight-ic pa-insight-ic--${i.tint}"><i class="fa-solid ${i.ic}"></i></span>
                    <div><strong>${escapeHtml(i.t)}</strong><span>${escapeHtml(i.d)}</span></div></li>`).join('') || '<li class="pa-muted">Not enough data yet.</li>'}
            </ul>
        </section>
    </div>`;
}

// ---------------------------------------------------------------- render: shell

function paRenderTimeMenu() {
    const menu = document.getElementById('paTimeMenu');
    if (!menu) return;
    const rows = PA_TIME_PRESETS.map((p) => {
        const [start, end] = paRangeDates(p.key);
        const withYear = p.key === 'max' || start.getFullYear() !== end.getFullYear();
        const sub = paIsoDate(start) === paIsoDate(end) ? paShortDate(start, withYear)
            : `${paShortDate(start, withYear)} – ${paShortDate(end, withYear)}`;
        return `<button type="button" class="pa-time-opt${paTimeRange === p.key ? ' is-active' : ''}" data-range="${p.key}">
            <span class="pa-time-radio"></span>
            <span class="pa-time-opt-text"><span class="pa-time-opt-label">${p.label}</span><span class="pa-time-opt-sub">${escapeHtml(sub)}</span></span>
        </button>`;
    }).join('');
    menu.innerHTML = `${rows}
        <div class="pa-time-custom${paTimeRange === 'custom' ? ' is-open' : ''}">
            <button type="button" class="pa-time-opt" data-range="custom">
                <span class="pa-time-radio"></span>
                <span class="pa-time-opt-text"><span class="pa-time-opt-label">Custom date range</span></span>
                <i class="fa-solid fa-chevron-right pa-time-custom-caret"></i>
            </button>
            <div class="pa-time-custom-fields">
                <label>From <input type="date" id="paCustomStart" value="${paCustomStart}" max="${paIsoDate(paToday())}"></label>
                <label>To <input type="date" id="paCustomEnd" value="${paCustomEnd}" max="${paIsoDate(paToday())}"></label>
            </div>
        </div>`;
}

function paSyncToolbar() {
    const label = document.getElementById('paTimeLabel');
    if (label) label.textContent = paRangeLabel();
    const menu = document.getElementById('paTimeMenu');
    if (menu) menu.hidden = !_paTimeMenuOpen;
    document.getElementById('paTimeBtn')?.classList.toggle('is-open', _paTimeMenuOpen);
    document.getElementById('paCustomizeMenu')?.toggleAttribute('hidden', !_paCustomizeOpen);
    document.querySelectorAll('.pa-seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.seg === paSegment));
    if (_paTimeMenuOpen) paRenderTimeMenu();
}

function paRenderShell() {
    const root = document.getElementById('productAnalyticsRoot');
    if (!root) return;
    const collOpts = ['<option value="">All collections</option>']
        .concat(paCollectionOptions().map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)).join('');

    root.innerHTML = `
        <div class="pa-head">
            <div class="pa-head-titles">
                <h2 class="pa-title">Product Analytics</h2>
                <p class="pa-subtitle">Deep insight into how every product and size is performing.</p>
            </div>
            <div class="pa-head-actions">
                <button type="button" id="paExportBtn" class="btn btn-secondary"><i class="fa-solid fa-arrow-up-from-bracket"></i> Export</button>
                <div class="pa-customize">
                    <button type="button" id="paCustomizeBtn" class="btn btn-secondary"><i class="fa-solid fa-sliders"></i> Customize</button>
                    <div id="paCustomizeMenu" class="pa-pop" hidden>
                        <span class="pa-pop-title">Columns</span>
                        <label><input type="checkbox" data-col="revenue"${paCols.revenue ? ' checked' : ''}> Revenue</label>
                        <label><input type="checkbox" data-col="delta"${paCols.delta ? ' checked' : ''}> ${escapeHtml(paComparisonWord())}</label>
                        <label><input type="checkbox" data-col="sizes"${paCols.sizes ? ' checked' : ''}> Variant sizes</label>
                    </div>
                </div>
            </div>
        </div>

        <div class="pa-toolbar">
            <div class="pa-field pa-field--time">
                <label>Time Range</label>
                <div class="pa-time">
                    <button type="button" id="paTimeBtn" class="pa-time-btn">
                        <i class="fa-regular fa-calendar"></i>
                        <span id="paTimeLabel">${escapeHtml(paRangeLabel())}</span>
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <div id="paTimeMenu" class="pa-time-menu" hidden></div>
                </div>
            </div>
            <div class="pa-field">
                <label for="paCollectionSelect">Collection</label>
                <select id="paCollectionSelect" class="pa-select">${collOpts}</select>
            </div>
            <div class="pa-toolbar-spacer"></div>
            <div class="pa-segments" role="tablist">
                <button type="button" class="pa-seg-btn is-active" data-seg="all" role="tab">All Products</button>
                <button type="button" class="pa-seg-btn" data-seg="hero" role="tab">Hero <span class="pa-seg-count">0</span></button>
                <button type="button" class="pa-seg-btn" data-seg="zero" role="tab">Zero <span class="pa-seg-count">0</span></button>
            </div>
        </div>

        <div id="paResults"></div>`;

    document.getElementById('paCollectionSelect').value = paCollection;
    paBindShellEvents();
}

function paBindShellEvents() {
    document.getElementById('paTimeBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        _paTimeMenuOpen = !_paTimeMenuOpen;
        _paCustomizeOpen = false;
        paSyncToolbar();
    });
    document.getElementById('paTimeMenu').addEventListener('click', (e) => {
        e.stopPropagation();
        const opt = e.target.closest('[data-range]');
        if (!opt) return;
        const key = opt.dataset.range;
        if (key === 'custom') {
            paTimeRange = 'custom';
            paRenderTimeMenu();
            if (paCustomStart && paCustomEnd) { paPage = 1; paSyncToolbar(); paRefreshData(); }
            return;
        }
        paTimeRange = key;
        _paTimeMenuOpen = false;
        paPage = 1;
        paSyncToolbar();
        paRefreshData();
    });
    document.getElementById('paTimeMenu').addEventListener('change', (e) => {
        if (e.target.id === 'paCustomStart') paCustomStart = e.target.value;
        if (e.target.id === 'paCustomEnd') paCustomEnd = e.target.value;
        if (paCustomStart && paCustomEnd) { paTimeRange = 'custom'; paPage = 1; paSyncToolbar(); paRefreshData(); }
    });

    document.getElementById('paCollectionSelect').addEventListener('change', (e) => {
        paCollection = e.target.value;
        paPage = 1;
        paRenderResults();
    });
    document.querySelector('.pa-segments').addEventListener('click', (e) => {
        const btn = e.target.closest('.pa-seg-btn');
        if (!btn) return;
        paSegment = btn.dataset.seg;
        paPage = 1;
        paSyncToolbar();
        paRenderResults();
    });
    document.getElementById('paExportBtn').addEventListener('click', paExport);

    document.getElementById('paCustomizeBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        _paCustomizeOpen = !_paCustomizeOpen;
        _paTimeMenuOpen = false;
        paSyncToolbar();
    });
    document.getElementById('paCustomizeMenu').addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('paCustomizeMenu').addEventListener('change', (e) => {
        const col = e.target.dataset.col;
        if (!col) return;
        paCols[col] = e.target.checked;
        paSaveCols();
        paRenderResults();
    });

    const results = document.getElementById('paResults');
    results.addEventListener('click', (e) => {
        const pager = e.target.closest('[data-goto]');
        if (pager && !pager.disabled) { paPage = Number(pager.dataset.goto); paRenderResults(); return; }
        if (e.target.closest('#paHeroDefBtn')) { _paHeroDefOpen = !_paHeroDefOpen; paRenderResults(); return; }
        const kebab = e.target.closest('.pa-kebab');
        if (kebab) { paKebabMenu(kebab); return; }
    });
    results.addEventListener('change', (e) => {
        if (e.target.id === 'paPageSizeSelect') { paPageSize = Number(e.target.value); paPage = 1; paRenderResults(); }
        if (e.target.id === 'paTrendMetric') { paTrendMetric = e.target.value; paRenderResults(); }
    });
}

function paKebabMenu(btn) {
    document.querySelector('.pa-kebab-pop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'pa-pop pa-kebab-pop';
    pop.innerHTML = '<button type="button" data-act="products">Open in Products</button>';
    pop.querySelector('[data-act="products"]').addEventListener('click', () => { pop.remove(); switchView('products'); });
    const rect = btn.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.left = `${Math.max(8, rect.right - 170)}px`;
    pop.style.right = 'auto';
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener('click', function h() { pop.remove(); document.removeEventListener('click', h); }), 0);
}

function paOnDocClick() {
    if (_paTimeMenuOpen || _paCustomizeOpen) { _paTimeMenuOpen = false; _paCustomizeOpen = false; paSyncToolbar(); }
}

// ------------------------------------------------------------------- lifecycle

function paSyncCollectionSelect() {
    const sel = document.getElementById('paCollectionSelect');
    if (!sel) return;
    const want = paCollection;
    sel.innerHTML = ['<option value="">All collections</option>']
        .concat(paCollectionOptions().map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`))
        .join('');
    sel.value = want;
}

async function paRefreshData() {
    const results = document.getElementById('paResults');
    const reqId = ++_paReqId;
    if (results) results.innerHTML = `<div class="content-loading">
        <div class="content-loading-spinner"></div><p class="content-loading-text">Crunching sales…</p></div>`;
    try {
        const [start, end] = paRangeDates(paTimeRange);
        const data = await apiJson(
            `/products/analytics?start=${paIsoDate(start)}&end=${paIsoDate(end)}`,
            { fallback: 'Failed to load analytics' },
        );
        if (reqId !== _paReqId) return;
        _paData = {
            rows: (data.rows || []).map((r) => ({
                key: r.product_id || `name:${(r.name || '').toLowerCase()}`,
                name: r.name || '(unknown product)',
                collection: r.collection || 'Uncategorized',
                imageUrl: r.image_url || '',
                variantCount: r.variant_count || 0,
                stock: r.stock || 0,
                units: r.units || 0,
                revenue: Number(r.revenue) || 0,
                sizes: r.sizes || {},
                prevUnits: r.prev_units || 0,
                prevRevenue: Number(r.prev_revenue) || 0,
            })),
            ordersByColl: data.orders || { current: {}, previous: {} },
            trend: data.trend || [],
            hasPrev: !!data.has_prev,
        };
        if (paCollection && !paCollectionOptions().includes(paCollection)) paCollection = '';
        paSyncCollectionSelect();
        paRenderResults();
    } catch (error) {
        if (reqId !== _paReqId) return;
        console.error('Error loading product analytics:', error);
        if (results) results.innerHTML = '<div class="no-data-message">Failed to load analytics. Please try again.</div>';
        showToast('Failed to load product analytics', 'error');
    }
}

function paExport() {
    if (typeof XLSX === 'undefined') { showToast('Excel export library is not loaded', 'error', { silent: true }); return; }
    const view = paDeriveView();
    if (!view.segmentRows.length) { showToast('Nothing to export', 'warning', { silent: true }); return; }
    const rows = view.segmentRows.map((r) => {
        const out = {
            Rank: r.rank, Product: r.name, Collection: r.collection,
            Performance: (PA_PERF_META[r.perf] || {}).label || r.perf,
            'Units Sold': r.units, 'Revenue (PKR)': Math.round(r.revenue),
            'Units (prev)': r.prevUnits, 'In Stock': r.stock,
        };
        for (const s of view.sizes) out[s] = r.sizes[s] || 0;
        return out;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Product Analytics');
    XLSX.writeFile(wb, `product-analytics-${paIsoDate(paToday())}.xlsx`);
}

function initProductAnalyticsView() {
    if (!_paInited) {
        _paInited = true;
        document.addEventListener('click', paOnDocClick);
    }
    _paTimeMenuOpen = false;
    _paCustomizeOpen = false;
    paRenderShell();
    paRefreshData();
}
