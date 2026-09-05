"""app/routes/shopify_webhooks.py - HMAC verification, org resolution, idempotency, and
dispatch. Exercised directly against the mounted app (the route is public - no auth
dependency to bypass) with its collaborators monkeypatched, rather than through conftest's
FakeSupabase (which doesn't model Postgres's upsert-on-conflict "empty data means the row
already existed" contract that idempotency here relies on)."""
import base64
import hashlib
import hmac
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.main as main
import app.routes.shopify_webhooks as shopify_webhooks

_SECRET = "test-shopify-app-secret"


def _sign(body: bytes) -> str:
    digest = hmac.new(_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SHOPIFY_APP_CLIENT_SECRET", _SECRET)
    yield TestClient(main.app)


def _fake_org_table(seen_ids: set):
    """Stands in for org_table() against shopify_webhook_events, modelling the two bits of
    Postgres the route depends on: upsert-with-ignore_duplicates returning no data when the
    row already existed, and delete removing it again."""
    class _FakeTable:
        def upsert(self, row, **_kwargs):
            is_new = row["webhook_id"] not in seen_ids
            seen_ids.add(row["webhook_id"])
            return SimpleNamespace(execute=lambda: SimpleNamespace(data=[row] if is_new else []))

        def delete(self, **_kwargs):
            return self

        def eq(self, column, value):
            if column == "webhook_id":
                seen_ids.discard(value)
            return self

        def lt(self, *_args):
            return self

        def execute(self):
            return SimpleNamespace(data=[])

    return lambda supabase, org_id, table: _FakeTable()


def _post(client, body: dict, *, shop="test-shop.myshopify.com", topic="orders/create",
          webhook_id="wh-1", bad_hmac=False, missing_header=None):
    raw = json.dumps(body).encode("utf-8")
    headers = {
        "X-Shopify-Hmac-Sha256": "not-the-real-signature" if bad_hmac else _sign(raw),
        "X-Shopify-Shop-Domain": shop,
        "X-Shopify-Topic": topic,
        "X-Shopify-Webhook-Id": webhook_id,
    }
    if missing_header:
        headers.pop(missing_header)
    return client.post("/api/webhooks/shopify", content=raw, headers=headers)


class TestHmacVerification:
    def test_bad_signature_is_rejected(self, client):
        resp = _post(client, {"order_number": 123}, bad_hmac=True)
        assert resp.status_code == 401

    def test_missing_signature_header_is_rejected(self, client):
        resp = _post(client, {"order_number": 123}, missing_header="X-Shopify-Hmac-Sha256")
        assert resp.status_code == 401

    def test_missing_shop_or_topic_or_id_is_a_bad_request(self, client, monkeypatch):
        monkeypatch.setattr(shopify_webhooks, "resolve_org_id_for_shopify_store", lambda shop: "org-1")
        for header in ("X-Shopify-Shop-Domain", "X-Shopify-Topic", "X-Shopify-Webhook-Id"):
            resp = _post(client, {"order_number": 123}, missing_header=header)
            assert resp.status_code == 400


class TestOrgResolutionAndIdempotency:
    def test_unrecognized_shop_is_acknowledged_without_processing(self, client, monkeypatch):
        monkeypatch.setattr(shopify_webhooks, "resolve_org_id_for_shopify_store", lambda shop: None)
        called = []
        monkeypatch.setattr(
            shopify_webhooks, "reconcile_and_persist_single_order",
            lambda org_id, payload: called.append((org_id, payload)),
        )
        resp = _post(client, {"order_number": 123})
        assert resp.status_code == 200
        assert called == []

    def test_a_repeated_webhook_id_is_not_reprocessed(self, client, monkeypatch):
        monkeypatch.setattr(shopify_webhooks, "resolve_org_id_for_shopify_store", lambda shop: "org-1")
        monkeypatch.setattr(shopify_webhooks, "get_supabase", lambda: object())

        monkeypatch.setattr(shopify_webhooks, "org_table", _fake_org_table(set()))

        calls = []

        async def _fake_reconcile(org_id, payload):
            calls.append((org_id, payload))

        monkeypatch.setattr(shopify_webhooks, "reconcile_and_persist_single_order", _fake_reconcile)

        first = _post(client, {"order_number": 123}, webhook_id="wh-dup")
        second = _post(client, {"order_number": 123}, webhook_id="wh-dup")

        assert first.status_code == 200
        assert second.status_code == 200
        assert len(calls) == 1

    def test_a_retry_after_a_failed_delivery_is_reprocessed(self, client, monkeypatch):
        """The 500 below asks Shopify to retry, so the failed attempt must not leave an
        idempotency row behind for that retry to be deduped against and dropped."""
        monkeypatch.setattr(shopify_webhooks, "resolve_org_id_for_shopify_store", lambda shop: "org-1")
        monkeypatch.setattr(shopify_webhooks, "get_supabase", lambda: object())
        monkeypatch.setattr(shopify_webhooks, "org_table", _fake_org_table(set()))

        attempts = []

        async def _fail_once(org_id, payload):
            attempts.append(payload)
            if len(attempts) == 1:
                raise RuntimeError("db is down")

        monkeypatch.setattr(shopify_webhooks, "reconcile_and_persist_single_order", _fail_once)

        first = _post(client, {"order_number": 123}, webhook_id="wh-retry")
        second = _post(client, {"order_number": 123}, webhook_id="wh-retry")

        assert first.status_code == 500
        assert second.status_code == 200
        assert len(attempts) == 2


class TestDispatch:
    @pytest.fixture(autouse=True)
    def _stub_idempotency(self, monkeypatch):
        monkeypatch.setattr(shopify_webhooks, "resolve_org_id_for_shopify_store", lambda shop: "org-1")
        monkeypatch.setattr(shopify_webhooks, "get_supabase", lambda: object())

        monkeypatch.setattr(shopify_webhooks, "org_table", _fake_org_table(set()))

    def test_order_topic_reconciles_the_payload(self, client, monkeypatch):
        # Doesn't publish "orders_changed" itself - reconcile_and_persist_single_order
        # does (see test_shopify_sync.py), same as every other order-mutating path.
        calls = []

        async def _fake_reconcile(org_id, payload):
            calls.append((org_id, payload))

        monkeypatch.setattr(shopify_webhooks, "reconcile_and_persist_single_order", _fake_reconcile)

        resp = _post(client, {"order_number": 6563}, topic="orders/updated")

        assert resp.status_code == 200
        assert calls == [("org-1", {"order_number": 6563})]

    def test_a_failed_reconciliation_is_a_500(self, client, monkeypatch):
        async def _boom(org_id, payload):
            raise RuntimeError("db is down")

        monkeypatch.setattr(shopify_webhooks, "reconcile_and_persist_single_order", _boom)

        resp = _post(client, {"order_number": 1}, topic="orders/create")

        assert resp.status_code == 500

    def test_app_uninstalled_clears_stored_credentials(self, client, monkeypatch):
        calls = []
        monkeypatch.setattr(shopify_webhooks, "upsert_org_integration_settings", lambda org_id, **kw: calls.append((org_id, kw)))

        resp = _post(client, {}, topic="app/uninstalled")

        assert resp.status_code == 200
        assert calls == [("org-1", {"shopify_access_token": ""})]

    def test_product_topic_reconciles_the_payload(self, client, monkeypatch):
        calls = []

        async def _fake_reconcile(org_id, payload):
            calls.append((org_id, payload))

        monkeypatch.setattr(shopify_webhooks, "reconcile_and_persist_single_product", _fake_reconcile)
        published = []
        monkeypatch.setattr(shopify_webhooks.event_bus, "publish", lambda org_id, event: published.append((org_id, event)))

        resp = _post(client, {"id": 42, "title": "Test Product"}, topic="products/update")

        assert resp.status_code == 200
        assert calls == [("org-1", {"id": 42, "title": "Test Product"})]
        assert published == [("org-1", {"type": "products_changed"})]

    def test_product_delete_deactivates_by_shopify_id(self, client, monkeypatch):
        calls = []

        async def _fake_deactivate(org_id, shopify_product_id):
            calls.append((org_id, shopify_product_id))

        monkeypatch.setattr(shopify_webhooks, "deactivate_product_by_shopify_id", _fake_deactivate)
        published = []
        monkeypatch.setattr(shopify_webhooks.event_bus, "publish", lambda org_id, event: published.append((org_id, event)))

        resp = _post(client, {"id": 42}, topic="products/delete")

        assert resp.status_code == 200
        assert calls == [("org-1", 42)]
        assert published == [("org-1", {"type": "products_changed"})]

    def test_inventory_level_update_applies_the_new_quantity(self, client, monkeypatch):
        calls = []

        async def _fake_apply(org_id, inventory_item_id, available):
            calls.append((org_id, inventory_item_id, available))

        monkeypatch.setattr(shopify_webhooks, "apply_inventory_level_update", _fake_apply)
        published = []
        monkeypatch.setattr(shopify_webhooks.event_bus, "publish", lambda org_id, event: published.append((org_id, event)))

        resp = _post(client, {"inventory_item_id": 55, "location_id": 1, "available": 3}, topic="inventory_levels/update")

        assert resp.status_code == 200
        assert calls == [("org-1", 55, 3)]
        assert published == [("org-1", {"type": "products_changed"})]
