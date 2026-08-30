"""E3: integration test for the Shopify orders sync.

Drives the real reconciliation logic in `services/shopify_sync.py` against the
recorded Shopify fixtures (`app/routes/sample_orders.json` /
`sample_products.json` - 250 real orders, 50 real products) with a faked
Supabase, asserting the resulting created/updated/skipped decisions. This is
the coverage gap D1 flagged: the diff/freeze rules have no other test.

`orders` and `sync_status` need real persistence (a second sync must see the first
sync's writes, both to prove reconciliation idempotency and to exercise the
incremental-window checkpoint); `products`/`variants` are static reads, so a plain
read-only fake covers them.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import app.services.shopify_sync as shopify_sync
import app.shopify as shopify_module
from app.org_settings import OrgIntegrationSettings

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "app" / "routes"
TEST_ORG_ID = "test-org"
_FAKE_ORG_CREDS = OrgIntegrationSettings(
    shopify_store_url="test-shop.myshopify.com",
    shopify_access_token="fake-token",
    shopify_api_version="2024-07",
    shopify_refresh_token=None,
    shopify_token_expires_at=None,
    couriers={},
)


def _load_fixture_orders():
    data = json.loads((FIXTURES_DIR / "sample_orders.json").read_text(encoding="utf-8"))
    return data["orders"]


def _load_fixture_products_and_variants():
    """Shopify's product API has no cost_price (that's ours, set manually in-app),
    so every product gets the same placeholder cost - fine here since this test
    asserts sync decisions (created/updated/skipped), not specific cost values."""
    data = json.loads((FIXTURES_DIR / "sample_products.json").read_text(encoding="utf-8"))
    products, variants = [], []
    for p in data["products"]:
        products.append({
            "id": f"prod-{p['id']}",
            "name": p["title"],
            "cost_price": 500.0,
            "shopify_product_id": p["id"],
        })
        for v in p.get("variants", []):
            variants.append({"id": f"var-{v['id']}", "shopify_variant_id": v["id"]})
    return products, variants


# Enforced by the fake orders table below, mirroring supabase_schema.sql - a null in one
# of these fails the entire batch's upsert in Postgres, not just the offending row.
_NOT_NULL_ORDER_COLUMNS = ("courier", "order_status")


class _FakeResp:
    def __init__(self, data):
        self.data = data


class _StaticTable:
    """Read-only stand-in for `products`/`variants`: no filters (beyond
    org_table()'s own org_id one, which is a no-op here - a single-org
    fixture) are ever applied to these in the sync, so returning the full
    seeded set is exact, not approximate."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def execute(self):
        return _FakeResp(list(self._rows))


class _FakeSyncStatusTable:
    """Stand-in for `sync_status`. Stateful (not just permissive) so the incremental
    sync can be tested reading back a previous run's checkpoint: filters are accepted
    but not applied (a single sequential test caller here, no lock contention to
    simulate) - every .update()/.upsert() call's payload is merged in, so a later
    _get_last_synced_at() sees what an earlier _set_last_synced_at() wrote."""

    def __init__(self, row):
        self.row = dict(row)

    def __getattr__(self, name):
        if name in ("update", "upsert"):
            def _write(payload, **_k):
                self.row.update(payload)
                return self
            return _write

        def _chain(*_a, **_k):
            return self
        return _chain

    def execute(self):
        return _FakeResp([dict(self.row)])


class _FakeOrdersQuery:
    """Chainable query for the stateful `orders` table below: real `eq`/`in_`
    filtering and real `upsert`/`update` persistence, so a second sync call
    actually sees the first call's writes."""

    def __init__(self, store):
        self._store = store
        self._filters = []
        self._pending = None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        return self

    def in_(self, col, vals):
        self._filters.append(("in", col, set(vals)))
        return self

    def upsert(self, batch, on_conflict=None, **_k):
        # on_conflict may be a composite string ("org_id,order_number") - this
        # fixture only ever holds one org, so the last component (order_number)
        # alone is still a unique key here. The raw value is still recorded
        # (see last_on_conflict below) so a test can assert on it directly -
        # this fixture accepting any string wouldn't otherwise catch a wrong
        # or missing on_conflict target.
        self._store.last_on_conflict = on_conflict
        key_col = (on_conflict or "").split(",")[-1].strip()
        for row in batch:
            for col in _NOT_NULL_ORDER_COLUMNS:
                if col in row and row[col] is None:
                    raise AssertionError(
                        f"null {col!r} would violate the NOT NULL constraint in "
                        f"supabase_schema.sql and fail the whole batch's upsert"
                    )
            key = row.get(key_col)
            merged = {**self._store.rows_by_number.get(key, {}), **row}
            merged.setdefault("id", f"gen-{key}")
            self._store.rows_by_number[key] = merged
        self._pending = ("upsert", batch)
        return self

    def update(self, payload):
        self._pending = ("update", payload)
        return self

    def _matched(self):
        rows = list(self._store.rows_by_number.values())
        for kind, col, val in self._filters:
            if kind == "eq":
                rows = [r for r in rows if r.get(col) == val]
            else:
                rows = [r for r in rows if r.get(col) in val]
        return rows

    def execute(self):
        if self._pending and self._pending[0] == "update":
            matched = self._matched()
            for row in matched:
                row.update(self._pending[1])
            return _FakeResp(matched)
        if self._pending and self._pending[0] == "upsert":
            return _FakeResp(self._pending[1])
        return _FakeResp(self._matched())


class _FakeOrdersTable:
    def __init__(self, rows):
        self.rows_by_number = {r["order_number"]: {"org_id": TEST_ORG_ID, **r} for r in rows}
        self.last_on_conflict = None

    def query(self):
        return _FakeOrdersQuery(self)


class _FakeDB:
    def __init__(self, orders, products, variants, sync_status=None):
        self.orders = _FakeOrdersTable(orders)
        self._products = products
        self._variants = variants
        self.sync_status = _FakeSyncStatusTable(sync_status or {"org_id": TEST_ORG_ID, "id": "shopify_orders", "in_progress": False})

    def table(self, name):
        if name == "shopify_orders":
            return self.orders.query()
        if name == "shopify_products":
            return _StaticTable(self._products)
        if name == "shopify_variants":
            return _StaticTable(self._variants)
        if name == "shopify_sync_status":
            return self.sync_status
        raise AssertionError(f"unexpected table: {name}")


@pytest.fixture
def synced_once(monkeypatch):
    """Runs one sync against the fixtures into an empty `orders` table, with the
    Shopify fetch, Supabase client, and advance-status recompute (a separate
    subsystem, out of scope here) all patched out. Yields (fake_db, result) so
    a test can inspect persisted rows or run a second sync on the same db."""
    orders_fixture = _load_fixture_orders()
    products, variants = _load_fixture_products_and_variants()
    fake_db = _FakeDB([], products, variants)

    async def fake_fetch_range(*_a, **_k):
        return orders_fixture, 1

    def fake_recompute(*_a, **_k):
        return 0

    monkeypatch.setattr(shopify_sync, "get_supabase", lambda: fake_db)
    monkeypatch.setattr(shopify_sync, "create_client", lambda *_a, **_k: fake_db)
    monkeypatch.setattr(shopify_sync, "get_org_integration_settings", lambda _org_id: _FAKE_ORG_CREDS)
    monkeypatch.setattr(shopify_sync, "_fetch_shopify_orders_in_range", fake_fetch_range)
    monkeypatch.setattr(shopify_sync, "recompute_advance_statuses", fake_recompute)

    result = asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))
    return fake_db, result, orders_fixture


def test_new_order_upsert_uses_the_org_scoped_on_conflict_target(synced_once):
    """Regression guard for the org-scoping cutover (ORGANIZATIONS_USERS_PLAN.md
    Phase 2): a wrong or missing on_conflict target here would let two
    different orgs' colliding order_numbers silently clobber each other on
    upsert instead of being kept independent. The generic fakes elsewhere in
    this file accept any on_conflict string, so this asserts the actual value
    directly rather than only inferring it worked from row counts."""
    fake_db, _result, _orders_fixture = synced_once
    assert fake_db.orders.last_on_conflict == "org_id,order_number"


class TestFirstSyncFromEmptyDB:
    def test_creates_every_fixture_order(self, synced_once):
        _fake_db, result, orders_fixture = synced_once
        assert result["created"] == len(orders_fixture)
        assert result["updated"] == 0
        assert result["skipped"] == 0
        assert result["synced"] == len(orders_fixture)
        assert result["total_orders_from_shopify"] == len(orders_fixture)

    def test_every_order_number_is_persisted(self, synced_once):
        fake_db, _result, orders_fixture = synced_once
        expected_numbers = {int(o["order_number"]) for o in orders_fixture}
        assert set(fake_db.orders.rows_by_number.keys()) == expected_numbers

    def test_order_status_distribution_matches_fixture(self, synced_once):
        """Cross-check against the fixture's own fulfillment/cancellation data
        (188 fulfilled, 33 cancelled, 29 unfulfilled, 0 returned) rather than a
        hardcoded number, so this fails loudly if the fixture ever changes."""
        fake_db, _result, orders_fixture = synced_once
        expected = {"fulfilled": 0, "cancelled": 0, "unfulfilled": 0}
        for o in orders_fixture:
            if o.get("cancelled_at"):
                expected["cancelled"] += 1
            elif o.get("fulfillment_status") == "fulfilled":
                expected["fulfilled"] += 1
            else:
                expected["unfulfilled"] += 1

        actual = {"fulfilled": 0, "cancelled": 0, "unfulfilled": 0, "other": 0}
        for row in fake_db.orders.rows_by_number.values():
            actual[row["order_status"] if row["order_status"] in actual else "other"] += 1

        assert actual["other"] == 0
        assert actual == {**expected, "other": 0}


def test_second_sync_on_unchanged_data_is_a_no_op(synced_once):
    """The real regression this guards: re-running a sync against Shopify data
    that hasn't changed must not keep flagging every order as updated (the bug
    E3 exists to catch - see D1's freeze-after-fulfilled rules)."""
    _fake_db, first_result, orders_fixture = synced_once

    second_result = asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

    assert second_result["created"] == 0
    assert second_result["updated"] == 0
    assert second_result["skipped"] == len(orders_fixture)
    assert second_result["synced"] == 0


def _find_order_number(orders_fixture, *, fulfilled: bool) -> int:
    for o in orders_fixture:
        if o.get("cancelled_at"):
            continue
        is_fulfilled = o.get("fulfillment_status") == "fulfilled"
        if is_fulfilled == fulfilled:
            return int(o["order_number"])
    raise AssertionError("fixture has no matching order")


def test_fulfilled_order_freezes_total_amount_against_a_manual_edit(synced_once):
    """Once an order leaves 'unfulfilled', a manual DB edit (e.g. delivery_charge
    dispute correction) to total_amount must survive a resync - this is the
    freeze-after-fulfilled rule the idempotency test above can't see, because
    replaying identical Shopify data can't tell 'frozen' apart from 'recomputed
    to the same value'. Breaking `freeze_amounts_items_cost` in shopify_sync.py
    makes this test fail (confirmed manually); the plain idempotency test does not."""
    fake_db, _result, orders_fixture = synced_once
    order_number = _find_order_number(orders_fixture, fulfilled=True)
    row = fake_db.orders.rows_by_number[order_number]
    assert row["order_status"] == "fulfilled"

    manually_edited_total = row["total_amount"] + 12345.0
    row["total_amount"] = manually_edited_total

    asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

    assert fake_db.orders.rows_by_number[order_number]["total_amount"] == manually_edited_total


def test_unfulfilled_order_total_amount_keeps_resyncing_from_shopify(synced_once):
    """The mirror case: while still unfulfilled, total_amount is NOT frozen, so a
    manual/stale edit gets overwritten back to the Shopify-derived value on the
    next sync."""
    fake_db, _result, orders_fixture = synced_once
    order_number = _find_order_number(orders_fixture, fulfilled=False)
    row = fake_db.orders.rows_by_number[order_number]
    assert row["order_status"] == "unfulfilled"

    original_total = row["total_amount"]
    row["total_amount"] = original_total + 12345.0

    asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

    assert fake_db.orders.rows_by_number[order_number]["total_amount"] == original_total


def _run_sync_with_fixture(monkeypatch, orders_fixture):
    """Same wiring as the `synced_once` fixture, but against a caller-supplied (possibly
    mutated) copy of the fixture orders instead of the file's own, so a test can plant a
    courier == "Other" fulfillment before the first sync."""
    products, variants = _load_fixture_products_and_variants()
    fake_db = _FakeDB([], products, variants)

    async def fake_fetch_range(*_a, **_k):
        return orders_fixture, 1

    monkeypatch.setattr(shopify_sync, "get_supabase", lambda: fake_db)
    monkeypatch.setattr(shopify_sync, "create_client", lambda *_a, **_k: fake_db)
    monkeypatch.setattr(shopify_sync, "get_org_integration_settings", lambda _org_id: _FAKE_ORG_CREDS)
    monkeypatch.setattr(shopify_sync, "_fetch_shopify_orders_in_range", fake_fetch_range)
    monkeypatch.setattr(shopify_sync, "recompute_advance_statuses", lambda *_a, **_k: 0)
    return fake_db


class TestOtherCourierDeliveryCharge:
    """Courier "Other" has no tracking API - the merchant tags the order with the courier
    name and delivery charge together (e.g. tag "Bykea 300"), parsed by
    _delivery_charge_from_other_tags. Shopify's free-text tracking-number field was tried
    first but turned out to get inconsistently formatted by the fulfillment flow, so the
    tag is now the authoritative source; tracking_number itself still syncs normally."""

    def _set_other_courier(self, orders_fixture, order_number, *, tag=None, tracking_number="111111"):
        target = next(o for o in orders_fixture if int(o["order_number"]) == order_number)
        for f in target["fulfillments"]:
            f["tracking_company"] = "Other"
            f["tracking_number"] = tracking_number
        target["tags"] = tag if tag is not None else ""
        return target

    def test_new_order_gets_delivery_charge_from_a_courier_tag(self, monkeypatch):
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)
        self._set_other_courier(orders_fixture, order_number, tag="✅ Order Confirmed, Bykea 300")

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        row = fake_db.orders.rows_by_number[order_number]
        assert row["courier"] == "Other"
        assert row["delivery_charge"] == 300.0

    def test_resyncs_past_the_delivered_freeze_when_the_tag_changes(self, monkeypatch):
        """Every other field freezes once an order is delivered/returned (see
        test_fulfilled_order_freezes_total_amount_against_a_manual_edit above) - "Other"
        courier/delivery_charge must not, since correcting the tag in Shopify is the only
        way to ever fix them post-delivery."""
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)
        self._set_other_courier(orders_fixture, order_number, tag="Bykea 300")

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        row = fake_db.orders.rows_by_number[order_number]
        # order_status "delivered" is only ever set by a delivery-status refresh, never by
        # extract_order_status itself - simulate that having already happened.
        row["order_status"] = "delivered"

        self._set_other_courier(orders_fixture, order_number, tag="Bykea 350")
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        row = fake_db.orders.rows_by_number[order_number]
        assert row["order_status"] == "delivered"  # the frozen status itself is untouched
        assert row["delivery_charge"] == 350.0

    def test_backfills_delivery_charge_when_a_tag_is_added_after_the_fact(self, monkeypatch):
        """The tag is re-derived from live Shopify data every sync (nothing about it is
        stored to diff against), so adding the tag later - or a stale 0 left over from
        before this feature existed - both get picked up on the very next sync."""
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)
        self._set_other_courier(orders_fixture, order_number)  # no tag yet

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))
        assert fake_db.orders.rows_by_number[order_number]["delivery_charge"] == 0.0

        self._set_other_courier(orders_fixture, order_number, tag="Bykea 300")
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        assert fake_db.orders.rows_by_number[order_number]["delivery_charge"] == 300.0

    def test_backfills_delivery_charge_for_a_delivered_order_when_a_tag_is_added_after_the_fact(self, monkeypatch):
        """Same as above, but for an order that's already delivered/returned - covered by
        the freeze-bypass branch instead of the ordinary has_changed path."""
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)
        self._set_other_courier(orders_fixture, order_number)  # no tag yet

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))
        row = fake_db.orders.rows_by_number[order_number]
        row["order_status"] = "delivered"
        assert row["delivery_charge"] == 0.0

        self._set_other_courier(orders_fixture, order_number, tag="Bykea 300")
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        row = fake_db.orders.rows_by_number[order_number]
        assert row["order_status"] == "delivered"
        assert row["delivery_charge"] == 300.0

    def test_manual_delivery_charge_is_preserved_when_no_courier_tag_is_present(self, monkeypatch):
        """A delivery_charge set by hand in-app (no matching tag on the order) must survive
        a resync rather than getting zeroed out just because there's nothing to derive."""
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)
        self._set_other_courier(orders_fixture, order_number)  # no tag

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))
        fake_db.orders.rows_by_number[order_number]["delivery_charge"] = 220.0  # manual, no tag backing it

        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        assert fake_db.orders.rows_by_number[order_number]["delivery_charge"] == 220.0

    def test_zero_charge_orders_stay_a_no_op_when_no_tag_matches(self, monkeypatch):
        """A courier "Other" order with no courier tag must not be flagged as changed on
        every sync just because delivery_charge is (legitimately) 0 - only the
        delivered-freeze bypass branch skips has_changed(), so this guards that branch
        specifically against a perpetual no-op-that-isn't."""
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)
        self._set_other_courier(orders_fixture, order_number, tag="Bykea")  # no trailing number

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        first_result = asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))
        assert first_result["created"] == len(orders_fixture)
        fake_db.orders.rows_by_number[order_number]["order_status"] = "delivered"

        second_result = asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        assert fake_db.orders.rows_by_number[order_number]["delivery_charge"] == 0.0
        assert second_result["updated"] == 0
        assert second_result["skipped"] == len(orders_fixture)

    def test_delivered_freeze_still_holds_for_a_non_other_courier(self, monkeypatch):
        """Control case: an ordinary courier's tracking_number must stay frozen once
        delivered, same as before this feature."""
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)
        target = next(o for o in orders_fixture if int(o["order_number"]) == order_number)
        for f in target["fulfillments"]:
            f["tracking_company"] = "PostEx"
            f["tracking_number"] = "111111"

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        row = fake_db.orders.rows_by_number[order_number]
        row["order_status"] = "delivered"

        for f in target["fulfillments"]:
            f["tracking_number"] = "222222"
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        assert fake_db.orders.rows_by_number[order_number]["tracking_number"] == "111111"


class TestIncrementalSyncWindow:
    """Covers the fix for TODO.md's "Sync performance" item: the sync used to always
    re-fetch a fixed SHOPIFY_SYNC_WINDOW_DAYS-day window, even when almost nothing in
    it had changed. It now resumes from sync_status.last_synced_at instead."""

    def _run_with_captured_windows(self, monkeypatch):
        products, variants = _load_fixture_products_and_variants()
        fake_db = _FakeDB([], products, variants)
        captured_windows = []

        async def fake_fetch_range(start, end, *_a, **_k):
            captured_windows.append((start, end))
            return [], 0

        monkeypatch.setattr(shopify_sync, "get_supabase", lambda: fake_db)
        monkeypatch.setattr(shopify_sync, "create_client", lambda *_a, **_k: fake_db)
        monkeypatch.setattr(shopify_sync, "get_org_integration_settings", lambda _org_id: _FAKE_ORG_CREDS)
        monkeypatch.setattr(shopify_sync, "_fetch_shopify_orders_in_range", fake_fetch_range)
        monkeypatch.setattr(shopify_sync, "recompute_advance_statuses", lambda *_a, **_k: 0)
        return fake_db, captured_windows

    def test_first_sync_uses_the_backfill_window(self, monkeypatch):
        _fake_db, captured_windows = self._run_with_captured_windows(monkeypatch)

        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        assert len(captured_windows) == 1
        start, end = captured_windows[0]
        assert (end - start) == timedelta(days=shopify_sync.SHOPIFY_SYNC_WINDOW_DAYS)

    def test_second_sync_resumes_from_the_first_syncs_checkpoint(self, monkeypatch):
        """The real regression this guards: without the fix, every sync re-fetches the
        full SHOPIFY_SYNC_WINDOW_DAYS-day window regardless of when it last ran."""
        _fake_db, captured_windows = self._run_with_captured_windows(monkeypatch)

        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        assert len(captured_windows) == 2
        first_start, first_end = captured_windows[0]
        second_start, second_end = captured_windows[1]

        # The second sync's window starts exactly where the first one's ended (its
        # checkpoint is the first sync's *start* time - see the race-condition note in
        # shopify_sync.py), not another SHOPIFY_SYNC_WINDOW_DAYS-day window.
        assert second_start == first_end
        assert (second_start - first_start) == timedelta(days=shopify_sync.SHOPIFY_SYNC_WINDOW_DAYS)
        assert (second_end - second_start) < timedelta(days=shopify_sync.SHOPIFY_SYNC_WINDOW_DAYS)

    def test_corrupt_checkpoint_falls_back_to_the_backfill_window(self, monkeypatch):
        fake_db, captured_windows = self._run_with_captured_windows(monkeypatch)
        fake_db.sync_status.row["last_synced_at"] = "not-a-timestamp"

        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        start, end = captured_windows[0]
        assert (end - start) == timedelta(days=shopify_sync.SHOPIFY_SYNC_WINDOW_DAYS)


class TestFetchRangeFiltersByUpdatedAt:
    def test_query_uses_updated_at_not_created_at(self, monkeypatch):
        """Filtering on updated_at (not created_at) is what makes an order that
        changes long after it was created - e.g. a very late return - still get
        picked up by a narrow incremental window."""
        captured = []

        async def fake_fetch_all(resource, query, org_creds, max_records=None):
            captured.append(query)
            return [], 0

        monkeypatch.setattr(shopify_module, "fetch_all", fake_fetch_all)

        start = datetime(2026, 7, 1, tzinfo=timezone.utc)
        end = datetime(2026, 7, 2, tzinfo=timezone.utc)
        asyncio.run(shopify_sync._fetch_shopify_orders_in_range(start, end, _FAKE_ORG_CREDS, n_partitions=1))

        assert len(captured) == 1
        assert "updated_at_min=" in captured[0]
        assert "updated_at_max=" in captured[0]
        assert "created_at_min" not in captured[0]
        assert "created_at_max" not in captured[0]


def _tracking_payload(latest_status):
    """The real shape of shopify_orders.delivery_status: JSONB holding the courier's
    tracking payload, never a bare status string."""
    return {"latest_status": latest_status, "tracking_number": "TRK900001",
            "status_history": [{"status": latest_status}]}


class TestCancelledAfterBookingResetsToUnfulfilled:
    """An order we booked with a courier, then cancelled on Shopify before the parcel
    ever moved, has to become bookable again so a different fulfillment can be created.
    extract_order_status reports these as "returned" (cancelled_at is later than the
    fulfillment's created_at), which is right only once the parcel has actually shipped -
    the two are told apart by delivery_status, the only record of a real courier scan."""

    @staticmethod
    def _cancel_after_fulfillment(orders_fixture, order_number):
        for o in orders_fixture:
            if int(o["order_number"]) != order_number:
                continue
            latest = max(
                f["created_at"] for f in o["fulfillments"] if f.get("status") != "cancelled"
            )
            cancelled_at = datetime.fromisoformat(latest.replace("Z", "+00:00")) + timedelta(days=1)
            o["cancelled_at"] = cancelled_at.isoformat()
            return
        raise AssertionError(f"order {order_number} not in fixture")

    def _sync_then_cancel(self, monkeypatch, *, delivery_status):
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        row = fake_db.orders.rows_by_number[order_number]
        assert row["order_status"] == "fulfilled"
        # What /fulfill writes on a successful booking.
        row["courier"] = "PostEx"
        row["tracking_number"] = "TRK123456"
        row["delivery_status"] = _tracking_payload(delivery_status) if delivery_status else None

        self._cancel_after_fulfillment(orders_fixture, order_number)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        return fake_db.orders.rows_by_number[order_number]

    def test_untracked_booking_is_reset_and_its_courier_fields_cleared(self, monkeypatch):
        row = self._sync_then_cancel(monkeypatch, delivery_status=None)

        assert row["order_status"] == "unfulfilled"
        # /fulfill rejects any order still carrying a tracking_number, so leaving these
        # behind would block the re-booking this reset exists to allow.
        # Not None: `courier` is NOT NULL in the schema, so a null here fails the upsert
        # for the whole batch, not just this order.
        assert row["courier"] == "Unassigned"
        assert not row["tracking_number"]

    def test_not_delivered_placeholder_counts_as_never_moved(self, monkeypatch):
        """"not_delivered" is what extract_delivery_status writes for any order Shopify
        hasn't fulfilled - it records the absence of a scan, not a failed delivery."""
        row = self._sync_then_cancel(monkeypatch, delivery_status="not_delivered")

        assert row["order_status"] == "unfulfilled"
        assert not row["tracking_number"]

    def test_a_parcel_that_moved_is_not_reset_to_bookable(self, monkeypatch):
        """The parcel physically shipped, so the cancellation really is a return - it must
        keep counting against the courier bill rather than being reset to bookable."""
        row = self._sync_then_cancel(monkeypatch, delivery_status="Returned at Merchant Warehouse")

        assert row["order_status"] != "unfulfilled"
        assert row["delivery_status"]["latest_status"] == "Returned at Merchant Warehouse"


class TestCancelledFulfillmentReturnsOrderToUnfulfilled:
    """Cancelling the *fulfillment* in Shopify (the order itself stays live) leaves every
    fulfillment at status "cancelled", which Shopify reports as fulfillment_status null -
    extract_order_status reads that as "unfulfilled". That has to survive the write-back
    so the order can be booked again, and it outranks whatever the courier last told us."""

    @staticmethod
    def _cancel_every_fulfillment(orders_fixture, order_number):
        for o in orders_fixture:
            if int(o["order_number"]) != order_number:
                continue
            for f in o["fulfillments"]:
                f["status"] = "cancelled"
            # Shopify drops the order-level status to null once nothing is fulfilled.
            o["fulfillment_status"] = None
            return
        raise AssertionError(f"order {order_number} not in fixture")

    def _sync_then_cancel_fulfillment(self, monkeypatch, *, order_status, delivery_status=None):
        orders_fixture = _load_fixture_orders()
        order_number = _find_order_number(orders_fixture, fulfilled=True)

        fake_db = _run_sync_with_fixture(monkeypatch, orders_fixture)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        row = fake_db.orders.rows_by_number[order_number]
        assert row["order_status"] == "fulfilled"
        row["courier"] = "PostEx"
        row["tracking_number"] = "TRK900001"
        row["order_status"] = order_status
        row["delivery_status"] = _tracking_payload(delivery_status) if delivery_status else None

        self._cancel_every_fulfillment(orders_fixture, order_number)
        asyncio.run(shopify_sync._sync_shopify_orders(TEST_ORG_ID))

        return fake_db.orders.rows_by_number[order_number]

    def test_fulfilled_order_returns_to_unfulfilled_and_clears_the_booking(self, monkeypatch):
        row = self._sync_then_cancel_fulfillment(monkeypatch, order_status="fulfilled")

        assert row["order_status"] == "unfulfilled"
        # extract_tracking_number falls back to a cancelled fulfillment when every
        # fulfillment is cancelled, so without the void this stale number would survive
        # and /fulfill would refuse to re-book the order.
        assert not row["tracking_number"]
        # Not None: `courier` is NOT NULL in the schema, so a null here fails the upsert
        # for the whole batch, not just this order.
        assert row["courier"] == "Unassigned"

    def test_a_courier_scanned_order_is_still_pulled_back(self, monkeypatch):
        """Cancelling the fulfillment in Shopify is a deliberate act and outranks courier
        tracking, so even an order the courier had already scanned resets."""
        row = self._sync_then_cancel_fulfillment(
            monkeypatch, order_status="RFD", delivery_status="Attempt Made: CNA(CUSTOMER NOT AVAILABLE)")

        assert row["order_status"] == "unfulfilled"
        assert not row["tracking_number"]

    @pytest.mark.parametrize("terminal_status", ["delivered", "returned", "cancelled"])
    def test_terminal_statuses_are_left_alone(self, monkeypatch, terminal_status):
        """delivered/returned have already resolved into money on the courier bill and
        cancelled is a deliberate end state - none of them are waiting on a booking."""
        row = self._sync_then_cancel_fulfillment(
            monkeypatch, order_status=terminal_status, delivery_status="Delivered to Customer")

        assert row["order_status"] == terminal_status


class TestStaleSyncLockReclaim:
    """A held lock must always be reclaimable, or every later sync is refused with
    "Sync already in progress" forever. The filters are the whole point here, so these
    run against a fake that actually applies them - unlike _FakeSyncStatusTable, which
    accepts filters without evaluating them."""

    class _FilteringSyncStatusTable:
        def __init__(self, row):
            self.row = dict(row)
            self._eq = {}
            self._lt = {}
            self._is_null = []
            self._payload = None

        def table(self, _name):
            return self

        def update(self, payload):
            self._eq, self._lt, self._is_null, self._payload = {}, {}, [], payload
            return self

        def eq(self, col, val):
            self._eq[col] = val
            return self

        def lt(self, col, val):
            self._lt[col] = val
            return self

        def is_(self, col, val):
            assert val == "null"
            self._is_null.append(col)
            return self

        def execute(self):
            for col, val in self._eq.items():
                if self.row.get(col) != val:
                    return _FakeResp([])
            for col, val in self._lt.items():
                cur = self.row.get(col)
                # NULL < x is NULL in SQL, i.e. the row does not match.
                if cur is None or not (cur < val):
                    return _FakeResp([])
            for col in self._is_null:
                if self.row.get(col) is not None:
                    return _FakeResp([])
            self.row.update(self._payload)
            return _FakeResp([dict(self.row)])

    def _reclaim(self, monkeypatch, row):
        fake = self._FilteringSyncStatusTable(row)
        monkeypatch.setattr(shopify_sync, "org_table", lambda _db, _org, _name: fake)
        shopify_sync._release_stale_sync_lock(object(), TEST_ORG_ID)
        return fake.row

    def test_reclaims_a_lock_held_since_before_the_stale_cutoff(self, monkeypatch):
        acquired = datetime.now(timezone.utc) - shopify_sync._SYNC_LOCK_STALE_AFTER * 2
        row = self._reclaim(monkeypatch, {
            "id": shopify_sync._SYNC_STATUS_ORDERS_ID,
            "in_progress": True,
            "lock_acquired_at": acquired.isoformat(),
        })
        assert row["in_progress"] is False

    def test_reclaims_a_held_lock_that_carries_no_timestamp(self, monkeypatch):
        """The age filter can never match this row (NULL < cutoff is NULL), so without a
        second is-null pass the sync stays wedged forever instead of for four minutes."""
        row = self._reclaim(monkeypatch, {
            "id": shopify_sync._SYNC_STATUS_ORDERS_ID,
            "in_progress": True,
            "lock_acquired_at": None,
        })
        assert row["in_progress"] is False

    def test_leaves_a_freshly_acquired_lock_alone(self, monkeypatch):
        """A live sync's lock must survive, or two syncs run concurrently."""
        acquired = datetime.now(timezone.utc)
        row = self._reclaim(monkeypatch, {
            "id": shopify_sync._SYNC_STATUS_ORDERS_ID,
            "in_progress": True,
            "lock_acquired_at": acquired.isoformat(),
        })
        assert row["in_progress"] is True
