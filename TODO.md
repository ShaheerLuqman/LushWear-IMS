# TODO

Open, non-urgent work items for LushWear IMS. Backend/database design and
settled decisions live in [`backend/BACKEND.md`](backend/BACKEND.md)
(descriptive, not a task list). Transactions/ledger work items live in
[`CASHBOOK_IMPROVEMENTS.md`](CASHBOOK_IMPROVEMENTS.md).

---

## Backlog

> One line per item: `**Title** — action, ≤15 words.` No rationale, no file
> paths, no history — see [`backend/BACKEND.md`](backend/BACKEND.md) for the
> "why" if it needs to live somewhere.

### Frontend / UX

- [ ] **Better column filtering** — replace the current filter mechanism.
- [ ] **Per-user view persistence** — remember each user's column widths/layout.
- [ ] **Keyboard shortcuts** — add shortcuts for common actions.
- [ ] **Reduce base font size** — tighten the type scale app-wide.
- [ ] **Refresh color theme** — update the UI's color palette.

#### Full-stack

- [ ] **Notifications** — UI panel + API/storage for notifications.

### Backend

#### Auth & multi-tenancy
- [ ] **Full audit trail** — extend delete-only audit log to creates/updates with attribution.
- [ ] **Role-based column access** — enforce per-role column visibility/edit server-side.
- [ ] **Default ledgers on org creation** — decide which ledgers are always created with a new org.

#### Performance
- [ ] **Caching** — cache hot reads (products, ledgers) to cut Supabase round-trips.

#### Data & reporting
- [ ] **Generalize `KNOWN_COLLECTIONS`** — replace the hardcoded collection list with a data-driven one.
- [ ] **Resolve "Best Sellers"-tagged products' real collection** — 6 products stuck on `Best Sellers` instead of their real category.
- [ ] **Unresolved sold line items in month summary** — ~1,061 units show as "Others"; no matching product row (renamed/deleted products).
- [ ] **Shopify webhooks** — trigger order reconciliation on webhook events, not just polling.

#### Couriers
- [ ] **Couriers Next status lag** — `TrackOrder.php` shows stale status vs `CurrentStatus.php`; ask their team before fixing.

#### Finance / Bills
- [ ] **Unit type on bill lines?** — decide if bill line items need an explicit unit column.

#### New capabilities
- [ ] **AI chatbot** — natural-language querying of the data.

#### Observability
- [ ] **Activity logging** — track user activity with attribution now that Users exist.

### Misc

- [ ] **Pick an app name** — decide on a suitable product name.

---

## Completed

> Same one-line format, `[x]`, newest first.

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
