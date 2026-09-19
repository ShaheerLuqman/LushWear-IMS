# TODO

Open, non-urgent work items for QuikMerchant. Backend/database design and
settled decisions live in [`backend/BACKEND.md`](backend/BACKEND.md)
(descriptive, not a task list). Transactions/ledger work items live in
[`CASHBOOK_IMPROVEMENTS.md`](CASHBOOK_IMPROVEMENTS.md).

---

## Backlog

> One line per item: `**Title** — action, ≤15 words.` No rationale, no file
> paths, no history — see [`backend/BACKEND.md`](backend/BACKEND.md) for the
> "why" if it needs to live somewhere.

### Frontend / UX

- [ ] **Keyboard shortcuts** — add shortcuts for common actions.
- [ ] **Reduce base font size** — tighten the type scale app-wide.
- [ ] **Refresh color theme** — update the UI's color palette.

### Backend

#### Auth & multi-tenancy
- [ ] **Full audit trail** — extend delete-only audit log to creates/updates with attribution.
- [ ] **Role-based column access** — enforce per-role column visibility/edit server-side.
- [ ] **Default ledgers on org creation** — decide which ledgers are always created with a new org.

#### Performance
- [ ] **Caching** — cache hot reads (products, ledgers) to cut Supabase round-trips.

#### Data & reporting
- [ ] **Unresolved sold line items in month summary** — ~1,061 units show as "Others"; no matching product row (renamed/deleted products).
- [ ] **Shopify orders still on REST** — kept on REST deliberately (GraphQL bills ~105 cost points per nested order); revisit before REST is retired.

#### Couriers
- [ ] **Couriers Next status lag** — `TrackOrder.php` shows stale status vs `CurrentStatus.php`; ask their team before fixing.

#### New capabilities
- [ ] **AI chatbot** — natural-language querying of the data.

#### Observability
- [ ] **Activity logging** — track user activity with attribution now that Users exist.

### Misc

- [ ] **Pick an app name** — decide on a suitable product name.

---

## Completed

> Same one-line format, `[x]`, newest first.

- [x] **Whole app on the Polaris theme** — every page, modal and table now uses Polaris; AG Grid removed; shared `DataTable`, `RowActions`, `FormModal`/`InfoModal`, `MetricsStrip`, `StatCardGrid`, `KeyValueList`, `ReportTable` components.
- [x] **Shopify-style dropdowns everywhere** — one Polaris-based `Dropdown` (single, checkbox multi, searchable) replaced every native select and custom picker.
- [x] **Reusable Polaris components** — added `SearchField`, `MetricsStrip`, `FormModal`; Shipping Details modal ported as the reference.
- [x] **Shopify webhooks trigger order reconciliation** — `orders/create`, `orders/updated`, `orders/cancelled`, `orders/fulfilled` webhooks reconcile the order immediately (`reconcile_and_persist_single_order`) instead of waiting on the periodic poll.
- [x] **Shipper advice from the delivery status report** — new "Under review" bucket groups parcels PostEx has parked awaiting a decision (history code 0008, checked as the newest event so already-returning parcels are excluded); a per-row Advise button opens a modal to reattempt delivery or return the parcel, with remarks for the rider, sending PostEx's save-shipper-advice via `POST /orders/postex-shipper-advice`, which re-checks eligibility server-side before writing.
- [x] **Orders page restyled Shopify-style** — added a period summary strip (orders, items, COD to collect, delivered, returned, net profit) and status view-tabs wired to the grid's `order_status` filter, wrapped the grid in a framed table card with Polaris-style pills and quieter headers; AG Grid and all its behaviour kept, light theme only.
- [x] **Print Airway Bill screen** — dedicated page listing fulfilled PostEx/Couriers Next orders for a fulfillment-date range (today by default) with a single-select courier (PostEx default); per-row Print and a header button print the whole selection via the existing airway-bill endpoints. Backed by a new `shopify_orders.fulfilled_at` column stamped at booking time and a `GET /orders/airway-bill-list` endpoint.
- [x] **Products page redesigned as Inventory** — stat cards (products, stock, low/out of stock, value with month-over-month deltas from a new daily snapshot), toolbar search + collection/status filters + collapsible column filters, per-size stock columns, status/cost-per-unit/value columns and paginated grid; product details, Adjust Stock (pushes the delta to Shopify) and cost-history modals, with every manual cost change now recorded with reason, effective date and who made it.
- [x] **Shopify products/inventory on GraphQL** — the catalog now loads in a single bulk operation (cost-exempt, no paging, collections included), so the sync is one call instead of ten paged queries plus a collections round trip; locations, inventory adjustments (one atomic mutation) and webhook registration also on GraphQL, all normalized back to the REST field shape so webhook payloads and synced records stay one code path.
- [x] **Live WebSocket push on order changes** — new `/events/ws` (ticket-authenticated since a WS handshake can't send a bearer header) pushes `orders_changed` from every order-mutating write path (create/edit/delete, bulk updates, fulfillment, PostEx CSV/settlements, delivery-status refresh, load sheets, cost recalculation, Shopify webhook/sync) and `products_changed` from Shopify product webhooks, so open tabs refresh instantly instead of waiting on the 30-min poll backstop.
- [x] **Consistent modal sizing** — transaction-entry and delivery-status-report modals now scale as 80vw/80vh (were fixed px) matching bill/PostEx-upload-report; widened the cramped 8-column PostEx settlements table modal; left short forms and confirm dialogs compact (80vw/80vh would've been mostly dead space).
- [x] **Notifications** — header bell + panel logs every toast that's a real action outcome (saves/syncs/exports/generations/fetches, success or failure); in-memory only, resets each session; validation-guard toasts and routine auto-sync stay out of history.
- [x] **Pin modal action buttons** — all modals with footer buttons now use shared `.modal-pinned-footer` (deduped `.bill-modal-footer`/`.transaction-entry-footer`); removed the dead, unwired `editModal`.
- [x] **Bulk cost price update on products** — header button on the Products view opens a modal that sets one cost price on every checkbox-selected product via a new `PUT /products/bulk-update-cost-price` endpoint, cascading it to each product's variants; the modal also has a "Save and recalculate orders" option (date-gated) that refreshes order cost totals for orders including any selected product (`recalculate-order-costs` now takes `product_ids`).
- [x] **PostEx airway bills in one PDF** — backend chunks get-invoice at 100/call and merges; selection cap raised from 10 to 500, one tab instead of many.
- [x] **Courier Payment Report defaults to last month** — first-load pickup-date range is now all of the previous calendar month instead of this-month-to-date.
- [x] **Courier Payment Report courier default actually applies** — the PostEx-only default filter now refetches once the courier list is known, so the grid matches the filter chip instead of showing every courier.
- [x] **Per-order shipping details on fulfillment** — row kebab opens a PostEx-style modal (email, handling, pieces, invoice division, remarks, read-only pickup/products); PostEx-only fields hidden for Couriers Next; Fragile handling prefixes the courier remarks note; separate inline CoD column defaults to total minus advance; values flow to the booking.
- [x] **Live order-fulfillment progress screen** — Fulfill Order now opens a dedicated screen that fills in row-by-row as bookings stream back, with per-order tracking numbers and airway-bill downloads; fulfill button stays disabled until courier, pickup, and every courier city are set.
- [x] **Per-ledger expenses in Month Summary** — removed `is_party`/`report_category`; every Expense-type ledger now shows its own Month Summary line by name, no manual tagging.
- [x] **Faster bill view** — skip the redundant ledger re-fetch in the bill modal when ledgers are already loaded.
- [x] **View Bill button on bills table** — dedicated row button opens the bill; row click/dblclick no longer opens it.
- [x] **Ledger entry source navigation** — arrow on statement lines jumps to and flashes the originating transaction/bill.
- [x] **Supplier "Go to Ledger" button** — jump from a bill's supplier straight to its ledger, like transactions.
- [x] **Expandable product list in month-summary collection breakdown** — click a collection to see its actual sold products; collection/section totals now use the purple accent color, per-product lines stay neutral and smaller.
- [x] **Packaging list grouped by collection** — items in the packaging list PDF are now sectioned by product collection instead of one flat table.
- [x] **Fix "Pajama Tshirt" collection typo** — backfilled 26 products from stale `Pajama Tshirt` to `Pajama T-Shirt`, un-stranding ~2,115 units from "Others" in the month-summary collection breakdown.
- [x] **Rename Payables Ageing** — relabeled the view "Outstanding Payables" in the nav and UI copy.
- [x] **Remove bill due dates** — dropped `due_date` from bills and `payment_terms_days` from suppliers; AP ageing now buckets by days-since-bill-date.
- [x] **Ledgers toolbar** — moved "Create Ledger" to the header top row, renamed it "New Ledger", and added a live search box that hides non-matching ledgers.
- [x] **Ledger card fade-in** — cards/sections ease in on render (debounced search re-render) instead of popping in abruptly.
- [x] **Backfill order status from delivery history** — recomputed order_status for pre-2026 orders from stored delivery history; fixed a courier-status classifier bug along the way.
- [x] **Fix stale `finances_bills_with_paid` view** — `20260801120000_bills_remove_payment_allocation.sql` had never landed on the live DB; bills paid via ordinary ledger transactions still showed unpaid.
- [x] **Warning count on month cards** — Month Summary front page shows each month's count of orders in Warning status.
- [x] **Dynamic collection filter** — Products grid's Collection filter dropdown now lists collections found in the data, not a hardcoded set.
- [x] **Product `is_active` flag** — added to `shopify_products`; sync-shopify deactivates products no longer active on Shopify instead of orphaning them.
- [x] **Remove table padding** — dropped the padding around the grid on all table pages (Orders, Transactions, Products, Ledgers, Ledger detail, Bills).
- [x] **Numeric column exact-match filtering** — Orders grid numeric fields (Total, Advance, CoD, D. Charge, Tax, Receivable, Cost Price, Net Profit, Profit %) now filter by exact value instead of substring; Order # stays a text search.
- [x] **Discount on bills** — flat `discount_amount` netted out of the Inventory debit on receive.
