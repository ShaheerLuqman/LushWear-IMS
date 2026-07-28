"""E3: integration test for the Shopify orders sync.

Drives the real reconciliation logic in `services/shopify_sync.py` against the
recorded Shopify fixtures (`app/routes/sample_orders.json` /
`sample_products.json` - 250 real orders, 50 real products) with a faked
Supabase, asserting the resulting created/updated/skipped decisions. This is
the coverage gap D1 flagged: the diff/freeze rules have no other test.

Only `orders` needs real persistence (a second sync must see the first sync's
writes to prove idempotency); `products`/`variants`/`sync_status` are static
reads, so a plain read-only fake covers them.
"""
import asyncio
import json
from pathlib import Path

import pytest

import app.services.shopify_sync as shopify_sync

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "app" / "routes"


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


class _FakeResp:
    def __init__(self, data):
        self.data = data


class _StaticTable:
    """Read-only stand-in for `products`/`variants`: no filters are ever applied
    to these in the sync, so returning the full seeded set is exact, not approximate."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def execute(self):
        return _FakeResp(list(self._rows))


class _PermissiveTable:
    """Stand-in for `sync_status`: the sync only checks `bool(resp.data)` on it, so
    filters can be no-ops as long as the seeded row is always returned."""

    def __init__(self, rows):
        self._rows = rows

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self
        return _chain

    def execute(self):
        return _FakeResp(list(self._rows))


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
        for row in batch:
            key = row.get(on_conflict)
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
        self.rows_by_number = {r["order_number"]: dict(r) for r in rows}

    def query(self):
        return _FakeOrdersQuery(self)


class _FakeDB:
    def __init__(self, orders, products, variants):
        self.orders = _FakeOrdersTable(orders)
        self._products = products
        self._variants = variants
        self._sync_status = [{"id": "shopify_orders", "in_progress": False}]

    def table(self, name):
        if name == "orders":
            return self.orders.query()
        if name == "products":
            return _StaticTable(self._products)
        if name == "variants":
            return _StaticTable(self._variants)
        if name == "sync_status":
            return _PermissiveTable(self._sync_status)
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
    monkeypatch.setattr(shopify_sync, "_fetch_shopify_orders_in_range", fake_fetch_range)
    monkeypatch.setattr(shopify_sync, "recompute_advance_statuses", fake_recompute)

    result = asyncio.run(shopify_sync._sync_shopify_orders())
    return fake_db, result, orders_fixture


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
        expected_numbers = {str(int(o["order_number"])) for o in orders_fixture}
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

    second_result = asyncio.run(shopify_sync._sync_shopify_orders())

    assert second_result["created"] == 0
    assert second_result["updated"] == 0
    assert second_result["skipped"] == len(orders_fixture)
    assert second_result["synced"] == 0


def _find_order_number(orders_fixture, *, fulfilled: bool) -> str:
    for o in orders_fixture:
        if o.get("cancelled_at"):
            continue
        is_fulfilled = o.get("fulfillment_status") == "fulfilled"
        if is_fulfilled == fulfilled:
            return str(int(o["order_number"]))
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

    asyncio.run(shopify_sync._sync_shopify_orders())

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

    asyncio.run(shopify_sync._sync_shopify_orders())

    assert fake_db.orders.rows_by_number[order_number]["total_amount"] == original_total
