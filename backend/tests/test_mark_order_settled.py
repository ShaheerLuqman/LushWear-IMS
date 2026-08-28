import asyncio
import json

import httpx
import pytest

from app import shopify
from app.org_settings import OrgIntegrationSettings


def _creds():
    return OrgIntegrationSettings(
        shopify_store_url="example.myshopify.com",
        shopify_access_token="token",
        shopify_api_version="2024-07",
        shopify_refresh_token=None,
        shopify_token_expires_at=None,
        couriers={},
    )


class _StubShopify:
    """Minimal stand-in for the order/transactions endpoints mark_order_settled uses."""

    def __init__(self, tags="Confirmed", outstanding="2999.00", transactions=None):
        self.order = {"id": 1, "tags": tags, "total_outstanding": outstanding}
        self.transactions = transactions if transactions is not None else [
            {"id": 99, "kind": "sale", "status": "pending", "gateway": "Cash on Delivery (COD)"}
        ]
        self.puts = []
        self.posts = []

    def handler(self, request):
        path = request.url.path
        if request.method == "GET" and path.endswith("/orders/1.json"):
            return httpx.Response(200, json={"order": self.order})
        if request.method == "PUT" and path.endswith("/orders/1.json"):
            body = json.loads(request.content)["order"]
            self.puts.append(body)
            self.order["tags"] = body["tags"]
            return httpx.Response(200, json={"order": self.order})
        if request.method == "GET" and path.endswith("/transactions.json"):
            return httpx.Response(200, json={"transactions": self.transactions})
        if request.method == "POST" and path.endswith("/transactions.json"):
            body = json.loads(request.content)["transaction"]
            self.posts.append(body)
            return httpx.Response(201, json={"transaction": body})
        raise AssertionError(f"unexpected {request.method} {path}")

    def install(self, monkeypatch):
        transport = httpx.MockTransport(self.handler)
        original = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = transport
            return original(*args, **kwargs)

        monkeypatch.setattr(shopify.httpx, "AsyncClient", factory)
        return self


class TestMarkOrderSettled:
    def test_tags_and_records_the_outstanding_payout(self, monkeypatch):
        stub = _StubShopify().install(monkeypatch)

        assert asyncio.run(shopify.mark_order_settled(1, _creds())) is True

        assert stub.puts[0]["tags"] == "Confirmed, Settled"
        posted = stub.posts[0]
        # Shopify rejects kind "sale" here and stores this capture back as one.
        assert posted["kind"] == "capture"
        assert posted["status"] == "success"
        assert posted["amount"] == "2999.00"
        # Shopify rejects a sale that isn't parented to the checkout's pending one.
        assert posted["parent_id"] == 99
        assert posted["gateway"] == "Cash on Delivery (COD)"

    def test_keeps_existing_tags_and_skips_a_duplicate_settled_tag(self, monkeypatch):
        stub = _StubShopify(tags="Confirmed, Settled, PostEx").install(monkeypatch)

        asyncio.run(shopify.mark_order_settled(1, _creds()))

        assert stub.puts == []
        assert len(stub.posts) == 1

    def test_tags_but_records_nothing_when_there_is_no_balance(self, monkeypatch):
        stub = _StubShopify(outstanding="0.00").install(monkeypatch)

        assert asyncio.run(shopify.mark_order_settled(1, _creds())) is False

        assert stub.puts[0]["tags"] == "Confirmed, Settled"
        assert stub.posts == []

    def test_tags_but_records_nothing_without_a_pending_sale(self, monkeypatch):
        # Manually created orders never went through checkout, so there is no parent
        # transaction to settle against - Shopify rejects the sale outright.
        stub = _StubShopify(transactions=[]).install(monkeypatch)

        assert asyncio.run(shopify.mark_order_settled(1, _creds())) is False

        assert stub.puts[0]["tags"] == "Confirmed, Settled"
        assert stub.posts == []


class TestHasSettledTag:
    @pytest.mark.parametrize("tags,expected", [
        ("Confirmed, PostEx, Settled", True),
        ("Settled", True),
        ("confirmed, settled", True),          # Shopify preserves case, matching ignores it
        ("Confirmed,  Settled  , PostEx", True),
        ("Confirmed, PostEx", False),
        ("Advance Paid, Confirmed", False),
        ("Unsettled", False),                  # substring must not match
        ("", False),
        (None, False),
    ])
    def test_detects_the_settled_tag(self, tags, expected):
        from app.services.shopify_sync import has_settled_tag
        assert has_settled_tag(tags) is expected
