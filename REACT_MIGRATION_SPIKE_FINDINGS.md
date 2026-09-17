# React migration spike — findings

**Status:** exploratory spike, not adopted. Code lives on branch `spike/react-antd-evaluation`,
not `main`. This doc is the durable record of what was learned; the code itself is disposable.

## Why this happened

SoftLush IMS is moving from an internal-only tool to a product shipped to other customers,
which raised the bar on UI polish. The starting idea was to migrate the Orders page to React
and use Shopify's Polaris design system, since Polaris is what renders Shopify's own Orders
page — the look being chased.

## Finding 1: Shopify Polaris (React) is deprecated

Mid-spike, `npm install @shopify/polaris` printed Shopify's own deprecation notice. Follow-up
research confirmed:

- Shopify's replacement, **Polaris Web Components** (`<s-table>` etc., loaded from
  `cdn.shopify.com/shopifycloud/polaris.js`), is framework-agnostic but scoped in Shopify's own
  docs to apps embedded in Shopify Admin/POS/Checkout — not documented or proven for a
  standalone product with no relationship to Shopify.
- Per Shopify's own developer community (mid-2026 threads), the web components are missing
  basic things a real table needs — `s-table` has no `IndexTable`-equivalent row
  selection/bulk-action UI, plus missing popovers/autocomplete/option-lists — with an explicit
  "wait, don't start new projects on this yet" consensus.
- Nothing else in `shopify.dev/docs` fits either: App Bridge requires the app to be embedded
  in Shopify Admin; UI/App Extensions inject into Shopify's own surfaces; Hydrogen/Remix are
  for storefronts. All of Shopify's tooling assumes you're building *for* Shopify, not merely
  borrowing its look.

**Conclusion:** Polaris (either flavor) is not a good target for a standalone product wanting
Shopify-quality polish without Shopify's brand/platform lock-in.

## Finding 2: React + Ant Design (antd) closes AG Grid's gaps better than Polaris would have

Given Polaris was out, the framework decision was deliberately decoupled from the design-system
decision: **React** (bigger ecosystem/hiring pool than Vue for this team's situation) +
**Ant Design** (mature, actively maintained, no platform lock-in, strong for data-dense admin
UIs) were chosen instead.

This turned out to be a better technical fit than Polaris IndexTable anyway. The spike proved,
against the real local backend and real data (not mocks), that antd's `Table` closes every gap
that would have ruled Polaris out:

- **Column filters** — built into `Table`'s `columns[].filters`/`onFilter`, no custom work.
- **Inline cell editing** — not built into antd's `Table` either, but a small (~60-line)
  click-to-edit/save-on-blur component was enough, and it's reusable across pages/field types.
- **A pinned summary row** (AG Grid's `pinnedBottomRowData`, used for the Orders page's
  sum-of-selected-rows footer) — antd's `Table.Summary` does this natively. This was the one
  capability Polaris IndexTable had *no* answer for at all.
- **AG Grid's month-grouped collapsible rows** (Ledger Detail's `isFullWidthRow` /
  `fullWidthCellRenderer`) — replicated via antd's documented `onCell` colSpan-merge pattern.
  Works, verified against a 100+ row real ledger, but is the most awkward translation of
  anything ported — antd has no first-class "full-width grouped row" concept.

All 8 grids driven by `initGrids()` in `frontend/js/orders-grid.js` (Orders, Products,
Transactions, Bills, Trial Balance, Courier Performance, Ledger Detail, Courier Payment Report)
were rebuilt and verified this way, including a working login screen, real bulk actions
(status update, cost-price update) that round-tripped to the live database, and shared
components (`useApiList`, `EditableNumberCell`, `EditableTextCell`, `StatusTag`, `AppShell`)
proven to hold up consistently across pages.

## Decision: not adopted — a lift-and-shift is preferred instead

Despite the spike working, the redesigned antd pages didn't look as good side-by-side with the
polish already present in the current app, and the team does not want a redesign bundled with
a framework migration. **The plan going forward is a lift-and-shift**: port the existing app to
React while keeping the current visual design, current CSS, and (most likely) **AG Grid itself**
via its official `ag-grid-react` bindings, rather than replacing it with antd's `Table`. Framework
migration and redesign are being treated as two separate, independently reviewable changes, not
one.

## What's still true and worth reusing regardless of table-library choice

The spike's page components (antd-styled) are not the basis for the real migration and should
not be ported forward as-is. These pieces are infrastructure, not redesign, and remain valid:

- **Auth**: the app's session token lives in `localStorage['lushwear_auth_token']` (see
  `frontend/js/app-core.js`'s `installAuthFetch`). A React port needs an equivalent fetch
  wrapper attaching `Authorization: Bearer <token>` and handling 401 — **with an explicit
  exclusion for `/auth/login` and `/auth/bootstrap`** (mirroring `isAuthBootstrapUrl` in
  `app-core.js`). The spike hit this exact bug: without the exclusion, a wrong-password login
  attempt incorrectly fires the global "session expired" handler too.
- **CORS**: the local backend's `ALLOWED_ORIGINS` (`backend/.env`) is an explicit allow-list,
  not a wildcard, even in dev — a new dev server's origin/port must be added there.
- **Deployment**: `frontend/vercel.json` has no build step and no rewrite rules today. Landing
  a React build at a same-origin static path (e.g. `frontend/orders-v2/` or in-place) avoids
  CSP/CORS changes entirely and means localStorage (the auth token) is automatically shared
  with the rest of the app. A client-side router should use `HashRouter`, not `BrowserRouter`,
  unless/until a server rewrite rule is added — a path-based deep link would 404 on refresh
  otherwise.
- **Ported business logic**: pure functions like `computeFinalStatus`, `computeNetProfit`,
  `computeReceivable` (orders), `productStockStatus`, `productUnitCost`, `productStockValue`
  (products), and the ledger month-grouping/running-balance math were ported to plain
  TypeScript in the spike (`ordersLogic.ts`, `productsLogic.ts`, `ledgersLogic.ts`, etc.) and
  are framework-agnostic — worth reusing rather than re-porting from scratch.
- **Backend API surface**: the spike's exploration of every relevant endpoint (list/bulk/detail
  routes for orders, products, transactions, bills, ledgers, courier bills, trial balance) is
  accurate as of this writing and doesn't need re-discovery.

## Where the code is

`frontend/orders-react/` as it stood at the end of the spike is committed on branch
`spike/react-antd-evaluation`, not on `main`. It is a working reference (all 8 pages functional
against the real backend) but is not intended to be merged or built upon directly.
