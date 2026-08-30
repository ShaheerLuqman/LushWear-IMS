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


class _StubFulfillment:
    """Stand-in for the order/fulfillment_orders/fulfillments endpoints create_fulfillment uses."""

    def __init__(self, tags="Confirmed", fulfillment_orders=None):
        self.order = {"id": 1, "tags": tags}
        self.fulfillment_orders = (
            fulfillment_orders if fulfillment_orders is not None else [{"id": 55, "status": "open"}]
        )
        self.puts = []
        self.fulfillments = []

    def handler(self, request):
        path = request.url.path
        if request.method == "GET" and path.endswith("/orders/1.json"):
            return httpx.Response(200, json={"order": self.order})
        if request.method == "PUT" and path.endswith("/orders/1.json"):
            body = json.loads(request.content)["order"]
            self.puts.append(body)
            self.order["tags"] = body["tags"]
            return httpx.Response(200, json={"order": self.order})
        if request.method == "GET" and path.endswith("/fulfillment_orders.json"):
            return httpx.Response(200, json={"fulfillment_orders": self.fulfillment_orders})
        if request.method == "POST" and path.endswith("/fulfillments.json"):
            body = json.loads(request.content)["fulfillment"]
            self.fulfillments.append(body)
            return httpx.Response(201, json={"fulfillment": body})
        raise AssertionError(f"unexpected {request.method} {path}")

    install = _StubShopify.install


_POSTEX_URL = "https://postex.pk/tracking?cn=CX123"


class TestCreateFulfillment:
    def test_tags_the_order_with_the_courier_and_sends_the_tracking_number(self, monkeypatch):
        stub = _StubFulfillment().install(monkeypatch)

        asyncio.run(shopify.create_fulfillment(1, "CX123", "PostEx", _POSTEX_URL, _creds()))

        assert stub.puts[0]["tags"] == "Confirmed, PostEx"
        tracking = stub.fulfillments[0]["tracking_info"]
        assert tracking["number"] == "CX123"
        assert tracking["company"] == "PostEx"

    def test_the_tracking_url_is_sent_so_the_number_is_a_working_link(self, monkeypatch):
        stub = _StubFulfillment().install(monkeypatch)

        asyncio.run(shopify.create_fulfillment(1, "CX123", "PostEx", _POSTEX_URL, _creds()))

        assert stub.fulfillments[0]["tracking_info"]["url"] == _POSTEX_URL

    def test_url_is_omitted_rather_than_sent_null_when_there_is_none(self, monkeypatch):
        """Shopify rejects a null tracking url, so an unknown courier sends no key."""
        stub = _StubFulfillment().install(monkeypatch)

        asyncio.run(shopify.create_fulfillment(1, "CX123", "PostEx", None, _creds()))

        assert "url" not in stub.fulfillments[0]["tracking_info"]

    def test_courier_tag_uses_the_courier_name_it_was_booked_with(self, monkeypatch):
        stub = _StubFulfillment().install(monkeypatch)

        asyncio.run(shopify.create_fulfillment(1, "CN9", "Couriers Next", None, _creds()))

        assert stub.puts[0]["tags"] == "Confirmed, Couriers Next"

    def test_an_existing_courier_tag_is_not_duplicated(self, monkeypatch):
        # Case-insensitive, so a re-run cannot produce "PostEx, postex".
        stub = _StubFulfillment(tags="Confirmed, postex").install(monkeypatch)

        asyncio.run(shopify.create_fulfillment(1, "CX123", "PostEx", _POSTEX_URL, _creds()))

        assert stub.puts == []

    def test_other_tags_survive(self, monkeypatch):
        stub = _StubFulfillment(tags="Confirmed, Settled, VIP").install(monkeypatch)

        asyncio.run(shopify.create_fulfillment(1, "CX123", "PostEx", _POSTEX_URL, _creds()))

        assert stub.puts[0]["tags"] == "Confirmed, Settled, VIP, PostEx"

    def test_an_order_with_nothing_left_to_fulfill_is_still_tagged(self, monkeypatch):
        # The tag says who carries the parcel, which is true whether or not this call
        # was the one that created the fulfillment.
        stub = _StubFulfillment(fulfillment_orders=[{"id": 55, "status": "closed"}]).install(monkeypatch)

        asyncio.run(shopify.create_fulfillment(1, "CX123", "PostEx", _POSTEX_URL, _creds()))

        assert stub.puts[0]["tags"] == "Confirmed, PostEx"
        assert stub.fulfillments == []
