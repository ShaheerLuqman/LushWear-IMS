"""app/shopify.py's GraphQL surface - products, collections, locations and inventory.

Orders stay on REST (see test_mark_order_settled.py). What matters here is that the
GraphQL reads come back in the REST field shape, since services/shopify_products_sync.py
reconciles a synced product and a products/update webhook payload through one code path.
"""

import asyncio
import json

import httpx
import pytest

from app import shopify
from app.org_settings import OrgIntegrationSettings

_RESULT_URL = "https://storage.googleapis.com/shopify-bulk/result.jsonl"


def _creds():
    return OrgIntegrationSettings(
        shopify_store_url="example.myshopify.com",
        shopify_access_token="token",
        shopify_api_version="2024-07",
        shopify_refresh_token=None,
        shopify_token_expires_at=None,
        couriers={},
    )


@pytest.fixture(autouse=True)
def _no_polling_delay(monkeypatch):
    """The bulk poll backs off in whole seconds - real ones would make this file crawl."""
    real_sleep = asyncio.sleep
    monkeypatch.setattr(shopify.asyncio, "sleep", lambda _: real_sleep(0))


class _Endpoint:
    """Records every GraphQL request and replies with a queued response."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def handler(self, request):
        self.requests.append(json.loads(request.content))
        return httpx.Response(200, json=self.responses.pop(0))

    def install(self, monkeypatch):
        transport = httpx.MockTransport(self.handler)
        original = httpx.AsyncClient
        monkeypatch.setattr(
            shopify.httpx, "AsyncClient",
            lambda *a, **kw: original(*a, **{**kw, "transport": transport}))
        return self


class _BulkEndpoint(_Endpoint):
    """Stands in for the whole bulk round trip: start the operation, poll it to a
    terminal status, then serve the JSONL from its signed result URL."""

    def __init__(self, jsonl="", statuses=("COMPLETED",), operation_id="gid://shopify/BulkOperation/1",
                 result_url=_RESULT_URL):
        super().__init__([])
        self.jsonl = jsonl
        self.statuses = list(statuses)
        self.operation_id = operation_id
        self.result_url = result_url
        self.polls = 0
        self.result_requests = []

    def handler(self, request):
        if request.url.host != "example.myshopify.com":
            self.result_requests.append(request)
            return httpx.Response(200, text=self.jsonl)

        body = json.loads(request.content)
        self.requests.append(body)
        if "bulkOperationRunQuery" in body["query"]:
            return httpx.Response(200, json={"data": {"bulkOperationRunQuery": {
                "bulkOperation": {"id": self.operation_id, "status": "CREATED"},
                "userErrors": [],
            }}})
        self.polls += 1
        status = self.statuses.pop(0)
        return httpx.Response(200, json={"data": {"currentBulkOperation": {
            "id": self.operation_id,
            "status": status,
            "errorCode": None,
            "url": self.result_url if status == "COMPLETED" else None,
        }}})


def _jsonl(*objects):
    return "\n".join(json.dumps(o) for o in objects)


_PRODUCT_LINE = {
    "id": "gid://shopify/Product/632910392",
    "title": "Silk Cami Set",
    "status": "ACTIVE",
    "featuredImage": {"url": "https://cdn/silk.jpg"},
}
_VARIANT_LINE = {
    "id": "gid://shopify/ProductVariant/808950810",
    "title": "M",
    "price": "1500.00",
    "inventoryQuantity": 7,
    "inventoryItem": {"id": "gid://shopify/InventoryItem/808950811"},
    "__parentId": "gid://shopify/Product/632910392",
}
_COLLECTION_LINE = {
    "id": "gid://shopify/Collection/99",
    "title": "Silk Collection",
    "__parentId": "gid://shopify/Product/632910392",
}


class TestBulkProductFetch:
    def test_it_regroups_the_flattened_jsonl_back_onto_each_product(self, monkeypatch):
        """Bulk output puts every nested connection on its own line with a __parentId, so
        variants and collections arrive detached from the product they belong to."""
        _BulkEndpoint(_jsonl(_PRODUCT_LINE, _VARIANT_LINE, _COLLECTION_LINE)).install(monkeypatch)

        products, collections = asyncio.run(shopify.fetch_products(_creds()))

        assert len(products) == 1
        assert products[0]["variants"][0]["id"] == 808950810
        assert collections == {632910392: ["Silk Collection"]}

    def test_a_child_line_is_routed_by_its_own_id_not_its_position(self, monkeypatch):
        """A variant line and a collection line are otherwise indistinguishable - both are
        just an object carrying a __parentId."""
        second_product = {**_PRODUCT_LINE, "id": "gid://shopify/Product/2", "title": "Linen PJs"}
        second_variant = {**_VARIANT_LINE, "id": "gid://shopify/ProductVariant/22",
                          "__parentId": "gid://shopify/Product/2"}
        _BulkEndpoint(_jsonl(
            _PRODUCT_LINE, _COLLECTION_LINE, _VARIANT_LINE, second_product, second_variant,
        )).install(monkeypatch)

        products, collections = asyncio.run(shopify.fetch_products(_creds()))

        assert [p["title"] for p in products] == ["Silk Cami Set", "Linen PJs"]
        assert [len(p["variants"]) for p in products] == [1, 1]
        # The second product is in no collection, so it is absent rather than mapped to
        # [] - _resolve_collection reads a missing entry as "fall back to name matching".
        assert collections == {632910392: ["Silk Collection"]}

    def test_a_product_takes_the_rest_shape_the_reconciler_reads(self, monkeypatch):
        from app.services.shopify_products_sync import reconcile_one_product

        _BulkEndpoint(_jsonl(_PRODUCT_LINE, _VARIANT_LINE, _COLLECTION_LINE)).install(monkeypatch)

        products, collections = asyncio.run(shopify.fetch_products(_creds()))
        product = products[0]

        # Numeric, not GIDs: the same ids a products/update webhook delivers, which is
        # what lets a synced row and a webhook payload key against each other.
        assert product["id"] == 632910392
        assert product["variants"][0]["inventory_item_id"] == 808950811
        assert product["variants"][0]["inventory_quantity"] == 7

        result = reconcile_one_product(product, None, collections, "now")
        assert result.action == "insert"
        assert result.product_data["name"] == "Silk Cami Set"
        assert result.product_data["price"] == 1500.0
        assert result.product_data["image_url"] == "https://cdn/silk.jpg"
        assert result.product_data["collection"] == "Silk Collection"

    def test_an_archived_product_reads_as_inactive(self, monkeypatch):
        """reconcile_one_product compares status to REST's lowercase "active", so the
        enum name leaking through would deactivate every product on the next sync."""
        _BulkEndpoint(_jsonl({**_PRODUCT_LINE, "status": "ARCHIVED", "featuredImage": None})).install(monkeypatch)

        products, _ = asyncio.run(shopify.fetch_products(_creds()))

        assert products[0]["status"] == "archived"
        assert products[0]["images"] == []

    def test_it_polls_until_the_operation_completes(self, monkeypatch):
        endpoint = _BulkEndpoint(
            _jsonl(_PRODUCT_LINE), statuses=("CREATED", "RUNNING", "COMPLETED")).install(monkeypatch)

        products, _ = asyncio.run(shopify.fetch_products(_creds()))

        assert len(products) == 1
        assert endpoint.polls == 3

    def test_the_result_is_downloaded_without_the_shopify_token(self, monkeypatch):
        """The result URL is signed and points at a storage host - the store's access
        token has no business being sent there."""
        endpoint = _BulkEndpoint(_jsonl(_PRODUCT_LINE)).install(monkeypatch)

        asyncio.run(shopify.fetch_products(_creds()))

        assert "X-Shopify-Access-Token" not in endpoint.result_requests[0].headers

    def test_an_empty_catalog_returns_nothing_rather_than_fetching_a_null_url(self, monkeypatch):
        """Shopify leaves `url` null when the operation matched no objects."""
        endpoint = _BulkEndpoint(result_url=None).install(monkeypatch)

        assert asyncio.run(shopify.fetch_products(_creds())) == ([], {})
        assert endpoint.result_requests == []

    def test_a_failed_operation_is_raised_not_read_as_an_empty_catalog(self, monkeypatch):
        """Returning nothing here would deactivate every product in the DB."""
        _BulkEndpoint(statuses=("FAILED",)).install(monkeypatch)

        with pytest.raises(Exception, match="FAILED"):
            asyncio.run(shopify.fetch_products(_creds()))

    def test_another_apps_operation_replacing_ours_is_not_read_as_our_result(self, monkeypatch):
        """currentBulkOperation returns the latest operation, not necessarily the one we
        started - syncing off someone else's result would sync the wrong data."""
        class _Replaced(_BulkEndpoint):
            def handler(self, request):
                response = super().handler(request)
                if request.url.host == "example.myshopify.com" and self.polls:
                    body = json.loads(response.content)
                    if body["data"].get("currentBulkOperation"):
                        body["data"]["currentBulkOperation"]["id"] = "gid://shopify/BulkOperation/999"
                        return httpx.Response(200, json=body)
                return response

        _Replaced(_jsonl(_PRODUCT_LINE)).install(monkeypatch)

        with pytest.raises(Exception, match="replaced"):
            asyncio.run(shopify.fetch_products(_creds()))

    def test_a_concurrent_sync_is_rejected_with_shopifys_own_message(self, monkeypatch):
        """Shopify runs one bulk query per app per shop, and reports the clash as a
        userError on a 200 - nothing else would surface it."""
        _Endpoint([{"data": {"bulkOperationRunQuery": {
            "bulkOperation": None,
            "userErrors": [{"field": None, "message": "A bulk query operation for this app and shop is already in progress"}],
        }}}]).install(monkeypatch)

        with pytest.raises(Exception, match="already in progress"):
            asyncio.run(shopify.fetch_products(_creds()))


class TestFetchProductCollections:
    """Still a separate call for the webhook path - a products/update payload carries no
    collection membership, and one product isn't worth a bulk operation."""

    def test_it_batches_ids_and_maps_them_back_to_numeric_product_ids(self, monkeypatch):
        endpoint = _Endpoint([
            {"data": {"nodes": [
                {"id": "gid://shopify/Product/1",
                 "collections": {"nodes": [{"title": "Silk Collection"}, {"title": "Sale"}]}},
                {"id": "gid://shopify/Product/2", "collections": {"nodes": []}},
            ]}},
        ]).install(monkeypatch)

        collections = asyncio.run(shopify.fetch_product_collections([1, 2], _creds()))

        assert collections == {1: ["Silk Collection", "Sale"]}
        assert endpoint.requests[0]["variables"]["ids"] == [
            "gid://shopify/Product/1", "gid://shopify/Product/2"]

    def test_no_ids_asks_shopify_nothing(self, monkeypatch):
        endpoint = _Endpoint([]).install(monkeypatch)

        assert asyncio.run(shopify.fetch_product_collections([], _creds())) == {}
        assert endpoint.requests == []

    def test_it_splits_a_long_id_list_into_chunks(self, monkeypatch):
        ids = list(range(shopify._COLLECTION_LOOKUP_CHUNK + 1))
        endpoint = _Endpoint([{"data": {"nodes": []}}, {"data": {"nodes": []}}]).install(monkeypatch)

        asyncio.run(shopify.fetch_product_collections(ids, _creds()))

        assert [len(r["variables"]["ids"]) for r in endpoint.requests] == \
            [shopify._COLLECTION_LOOKUP_CHUNK, 1]


class TestInventory:
    def test_every_adjustment_goes_in_one_mutation(self, monkeypatch):
        """A bill's stock has to land whole or not at all - the per-item REST calls this
        replaced could leave half a bill applied in Shopify."""
        endpoint = _Endpoint([
            {"data": {"locations": {"nodes": [{"id": "gid://shopify/Location/74534"}]}}},
            {"data": {"inventoryAdjustQuantities": {"userErrors": []}}},
        ]).install(monkeypatch)

        location_id = asyncio.run(shopify.get_primary_location_id(_creds()))
        asyncio.run(shopify.adjust_inventory_levels([(111, 5), (222, -3)], location_id, _creds()))

        assert location_id == 74534
        assert endpoint.requests[1]["variables"]["input"]["changes"] == [
            {"delta": 5, "inventoryItemId": "gid://shopify/InventoryItem/111",
             "locationId": "gid://shopify/Location/74534"},
            {"delta": -3, "inventoryItemId": "gid://shopify/InventoryItem/222",
             "locationId": "gid://shopify/Location/74534"},
        ]

    def test_a_zero_delta_is_dropped_and_an_empty_batch_sends_nothing(self, monkeypatch):
        endpoint = _Endpoint([]).install(monkeypatch)

        asyncio.run(shopify.adjust_inventory_levels([(111, 0)], 1, _creds()))

        assert endpoint.requests == []

    def test_a_rejected_adjustment_is_raised_not_swallowed(self, monkeypatch):
        """userErrors come back on a 200 carrying no GraphQL errors, so nothing else
        would surface them - and bills.py rolls its local state back on the exception."""
        _Endpoint([
            {"data": {"inventoryAdjustQuantities": {
                "userErrors": [{"field": None, "message": "Inventory item not stocked"}]}}},
        ]).install(monkeypatch)

        with pytest.raises(Exception, match="inventoryAdjustQuantities"):
            asyncio.run(shopify.adjust_inventory_levels([(111, 5)], 1, _creds()))


class TestThrottling:
    def test_a_throttled_query_is_retried_once_the_bucket_has_refilled(self, monkeypatch):
        throttled = {
            "errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}],
            "extensions": {"cost": {"requestedQueryCost": 900, "throttleStatus": {
                "currentlyAvailable": 100, "restoreRate": 100.0}}},
        }
        endpoint = _Endpoint([throttled, {"data": {"nodes": []}}]).install(monkeypatch)
        slept = []
        real_sleep = asyncio.sleep
        monkeypatch.setattr(shopify.asyncio, "sleep", lambda s: slept.append(s) or real_sleep(0))

        asyncio.run(shopify.fetch_product_collections([1], _creds()))

        assert len(endpoint.requests) == 2
        # (900 - 100) / 100 points per second, plus a small margin.
        assert 8.0 <= slept[0] <= 8.5

    def test_a_query_error_is_raised_rather_than_retried(self, monkeypatch):
        endpoint = _Endpoint([{"errors": [{"message": "Field 'nope' doesn't exist"}]}]).install(monkeypatch)

        with pytest.raises(Exception, match="Shopify GraphQL error"):
            asyncio.run(shopify.fetch_product_collections([1], _creds()))

        assert len(endpoint.requests) == 1
