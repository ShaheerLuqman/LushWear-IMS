"""Coverage for app/services/shopify_products_sync.py - the per-product/variant
reconciliation rules (reconcile_one_product) and the webhook-driven single-item paths
(reconcile_and_persist_single_product, deactivate_product_by_shopify_id,
apply_inventory_level_update) extracted from routes/products.py's "Sync Shopify Products"
handler. Follows test_sync_integration.py's plain asyncio.run() style (no pytest-asyncio
in this project)."""
import asyncio

import app.services.shopify_products_sync as products_sync

ORG_ID = "test-org"
NOW = "2026-01-01T00:00:00+00:00"


class _FakeTable:
    """Chainable stand-in for one supabase table, tailored to the select/upsert/update
    calls shopify_products_sync makes. Unlike conftest's generic FakeQuery, upsert()
    synthesizes an id for a row that doesn't have one yet (simulating a real INSERT),
    since reconcile_and_persist_single_product reads the upserted product's id back to
    link its variants."""

    def __init__(self, rows, sink=None):
        self._rows = rows
        self._sink = sink if sink is not None else {"upserted": [], "updated": []}

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def in_(self, *_a, **_k):
        return self

    def upsert(self, rows, **_k):
        payload = rows if isinstance(rows, list) else [rows]
        result_rows = []
        for i, row in enumerate(payload):
            row = dict(row)
            row.setdefault("id", f"generated-{i}")
            result_rows.append(row)
        self._sink["upserted"].extend(result_rows)
        self._rows = result_rows
        return self

    def update(self, data, **_k):
        self._sink["updated"].append(data)
        # Real PostgREST returns the updated rows in `.data`, empty if the filter matched
        # none - reflect that using whatever rows were seeded (this fake doesn't actually
        # filter, so "seeded non-empty" stands in for "a matching row exists").
        self._rows = [data] if self._rows else []
        return self

    def execute(self):
        return type("Resp", (), {"data": self._rows})()


class _FakeSupabase:
    def __init__(self, tables):
        self._tables = tables
        self.sinks = {name: {"upserted": [], "updated": []} for name in tables}

    def table(self, name):
        return _FakeTable(self._tables.get(name, []), self.sinks.setdefault(name, {"upserted": [], "updated": []}))


class TestReconcileOneProduct:
    def test_new_active_product_is_an_insert(self):
        sp = {"id": 111, "title": "Cami Set", "status": "active", "images": [], "variants": [{"price": "999"}]}
        result = products_sync.reconcile_one_product(sp, None, {}, NOW)
        assert result.action == "insert"
        assert result.product_data["shopify_product_id"] == 111
        assert result.product_data["price"] == 999.0

    def test_ignored_title_is_skipped(self):
        sp = {"id": 222, "title": "Free SHIPPING", "status": "active"}
        assert products_sync.reconcile_one_product(sp, None, {}, NOW) is None

    def test_missing_id_is_skipped(self):
        sp = {"title": "x", "status": "active"}
        assert products_sync.reconcile_one_product(sp, None, {}, NOW) is None

    def test_inactive_with_no_existing_row_is_a_noop(self):
        sp = {"id": 333, "title": "Archived", "status": "archived"}
        assert products_sync.reconcile_one_product(sp, None, {}, NOW) is None

    def test_inactive_with_an_existing_active_row_is_a_deactivate(self):
        sp = {"id": 444, "title": "Archived", "status": "archived"}
        existing = {"id": "local-1", "is_active": True}
        result = products_sync.reconcile_one_product(sp, existing, {}, NOW)
        assert result.action == "deactivate"
        assert result.product_data == {"id": "local-1", "is_active": False, "updated_at": NOW}

    def test_unchanged_existing_product_is_a_skip(self):
        existing = {
            "id": "local-2", "name": "Cami Set", "price": 999.0, "image_url": None,
            "collection": "Cami Sets", "is_active": True,
        }
        sp = {"id": 555, "title": "Cami Set", "status": "active", "variants": [{"price": "999"}], "images": []}
        result = products_sync.reconcile_one_product(sp, existing, {}, NOW)
        assert result.action == "skip"

    def test_price_change_is_an_update_that_preserves_cost_price(self):
        existing = {
            "id": "local-3", "name": "Cami Set", "price": 999.0, "image_url": None,
            "collection": "Cami Sets", "is_active": True, "cost_price": 400.0,
        }
        sp = {"id": 666, "title": "Cami Set", "status": "active", "variants": [{"price": "1099"}], "images": []}
        result = products_sync.reconcile_one_product(sp, existing, {}, NOW)
        assert result.action == "update"
        assert result.product_data["price"] == 1099.0
        assert result.product_data["cost_price"] == 400.0
        assert result.product_data["id"] == "local-3"

    def test_reactivating_a_deactivated_product_is_an_update_even_with_no_other_change(self):
        existing = {
            "id": "local-4", "name": "Cami Set", "price": 999.0, "image_url": None,
            "collection": "Cami Sets", "is_active": False,
        }
        sp = {"id": 777, "title": "Cami Set", "status": "active", "variants": [{"price": "999"}], "images": []}
        result = products_sync.reconcile_one_product(sp, existing, {}, NOW)
        assert result.action == "update"
        assert result.product_data["is_active"] is True

    def test_collection_is_sticky_once_set(self):
        existing = {
            "id": "local-5", "name": "Cami Set", "price": 999.0, "image_url": None,
            "collection": "Silk Collection", "is_active": True,
        }
        sp = {"id": 888, "title": "Cami Set", "status": "active", "variants": [{"price": "999"}], "images": []}
        # product_collections claims a different collection - existing stored value wins.
        result = products_sync.reconcile_one_product(sp, existing, {888: ["Trousers"]}, NOW)
        assert result.action == "skip"


class TestReconcileAndPersistSingleProduct:
    def _patch_no_collection_fetch(self, monkeypatch):
        async def _fake_ensure(org_id, creds):
            return creds
        monkeypatch.setattr(products_sync, "ensure_valid_shopify_token", _fake_ensure)
        monkeypatch.setattr(products_sync, "get_org_integration_settings", lambda org_id: object())

        async def _fake_fetch_collections(ids, creds):
            return {}
        monkeypatch.setattr(products_sync.shopify, "fetch_product_collections", _fake_fetch_collections)

    def test_new_product_is_inserted_with_its_variants(self, monkeypatch):
        self._patch_no_collection_fetch(monkeypatch)
        fake = _FakeSupabase({"shopify_products": [], "shopify_variants": []})
        monkeypatch.setattr(products_sync, "get_supabase", lambda: fake)

        sp_product = {
            "id": 999, "title": "New Product", "status": "active", "images": [],
            "variants": [{"id": 1, "price": "500", "title": "S", "inventory_quantity": 10, "inventory_item_id": 55}],
        }
        result = asyncio.run(products_sync.reconcile_and_persist_single_product(ORG_ID, sp_product))

        assert result.action == "insert"
        assert fake.sinks["shopify_products"]["upserted"][0]["shopify_product_id"] == 999
        variant_row = fake.sinks["shopify_variants"]["upserted"][0]
        assert variant_row["product_id"] == "generated-0"
        assert variant_row["title"] == "S"
        assert variant_row["quantity"] == 10
        assert variant_row["shopify_variant_id"] == 1
        assert variant_row["inventory_item_id"] == 55

    def test_deactivated_product_is_updated_directly_without_touching_variants(self, monkeypatch):
        self._patch_no_collection_fetch(monkeypatch)
        existing_product = {"id": "local-9", "shopify_product_id": 321, "is_active": True, "collection": "Trousers"}
        fake = _FakeSupabase({"shopify_products": [existing_product], "shopify_variants": []})
        monkeypatch.setattr(products_sync, "get_supabase", lambda: fake)

        sp_product = {"id": 321, "title": "Old Product", "status": "archived"}
        result = asyncio.run(products_sync.reconcile_and_persist_single_product(ORG_ID, sp_product))

        assert result.action == "deactivate"
        assert len(fake.sinks["shopify_products"]["updated"]) == 1
        assert fake.sinks["shopify_products"]["updated"][0]["is_active"] is False
        assert fake.sinks["shopify_variants"]["upserted"] == []

    def test_unknown_id_is_a_noop(self, monkeypatch):
        result = asyncio.run(products_sync.reconcile_and_persist_single_product(ORG_ID, {"title": "x"}))
        assert result is None


class TestDeactivateProductByShopifyId:
    def test_matching_product_is_deactivated(self, monkeypatch):
        fake = _FakeSupabase({"shopify_products": [{"id": "local-1"}]})
        monkeypatch.setattr(products_sync, "get_supabase", lambda: fake)
        found = asyncio.run(products_sync.deactivate_product_by_shopify_id(ORG_ID, 123))
        assert found is True
        assert len(fake.sinks["shopify_products"]["updated"]) == 1
        assert fake.sinks["shopify_products"]["updated"][0]["is_active"] is False

    def test_no_matching_product_returns_false(self, monkeypatch):
        fake = _FakeSupabase({"shopify_products": []})
        monkeypatch.setattr(products_sync, "get_supabase", lambda: fake)
        found = asyncio.run(products_sync.deactivate_product_by_shopify_id(ORG_ID, 999))
        assert found is False


class TestApplyInventoryLevelUpdate:
    def test_matching_variant_quantity_is_updated(self, monkeypatch):
        fake = _FakeSupabase({"shopify_variants": [{"id": "var-1"}]})
        monkeypatch.setattr(products_sync, "get_supabase", lambda: fake)
        found = asyncio.run(products_sync.apply_inventory_level_update(ORG_ID, 55, 7))
        assert found is True
        assert len(fake.sinks["shopify_variants"]["updated"]) == 1
        assert fake.sinks["shopify_variants"]["updated"][0]["quantity"] == 7

    def test_no_matching_variant_returns_false(self, monkeypatch):
        fake = _FakeSupabase({"shopify_variants": []})
        monkeypatch.setattr(products_sync, "get_supabase", lambda: fake)
        found = asyncio.run(products_sync.apply_inventory_level_update(ORG_ID, 55, 7))
        assert found is False
