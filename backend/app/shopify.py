"""Shopify Admin API access.

Orders go over the REST Admin API; products, collections, locations, inventory and
webhook subscriptions go over GraphQL. That split is deliberate: GraphQL bills by
*requested* query cost with a hard 1000-point cap, and a fully nested order (line items,
fulfillments, fulfillment line items, money bags) costs ~105 points on its own - so
paging a sync window over GraphQL would move about five orders per request against
REST's 250.

The catalog read (fetch_products) sidesteps that cost model entirely by running as a
bulk operation: one mutation starts it, the data it returns is not billed, `first` is
ignored on every nested connection, and the whole catalog - products, variants and
collection membership - comes back as one JSONL file. No page sizes to tune, nothing
truncated, and no second round trip for collections.

The GraphQL reads normalize their records into the REST field shape (`inventory_item_id`,
`images`, numeric ids) before returning, because Shopify's webhooks deliver REST-shaped
payloads and services/shopify_products_sync.py reconciles both through one code path.
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.parse import unquote, urlparse, parse_qs

import httpx
from fastapi import HTTPException

from app.org_settings import OrgIntegrationSettings

logger = logging.getLogger("app.shopify")

PAGE_LIMIT = 250

# Marks a COD order whose courier payout has arrived - see mark_order_settled().
SETTLED_TAG = "Settled"
_TIMEOUT = 60.0
_MAX_RATE_LIMIT_RETRIES = 5
_MAX_GRAPHQL_RETRIES = 5

# The catalog read runs as a bulk operation, whose result is polled for rather than
# returned inline. Products land in seconds at this store's size; the ceiling only exists
# so a wedged operation can't hold a request open forever.
_BULK_POLL_INTERVAL = 1.0
_BULK_POLL_MAX_INTERVAL = 5.0
_BULK_TIMEOUT = 300.0

_COLLECTION_PAGE = 10
# nodes(ids:) is billed per id, and each product there carries a collections connection.
_COLLECTION_LOOKUP_CHUNK = 50

# Topics app/routes/shopify_webhooks.py handles - kept in sync with that module's
# _ORDER_TOPICS/_PRODUCT_TOPICS/app-uninstalled/inventory handling. GraphQL enum names,
# not REST's slash form.
WEBHOOK_TOPICS = [
    "ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "ORDERS_FULFILLED",
    "PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE", "INVENTORY_LEVELS_UPDATE",
    "APP_UNINSTALLED",
]

_WEBHOOK_SUBSCRIPTION_MUTATION = """
mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}
"""

# The only collection names the month-summary "products sold by collection" breakdown
# and the packaging list (routes/orders.py) recognize - anything else falls into
# "Others" there.
KNOWN_COLLECTIONS = ["Cami Sets", "Linen PJs", "Pajama T-Shirt", "Silk Collection", "Trousers"]


def build_collection_resolver(products: List[Dict[str, Any]]) -> Callable[[Optional[str], Optional[str]], str]:
    """Resolve an order line's (product_id, item name) to a display collection -
    one of KNOWN_COLLECTIONS, or "Others". Falls back to fuzzy name matching when
    product_id doesn't match a known product."""
    products_list: List[tuple] = []
    products_map: Dict[str, str] = {}
    products_by_id: Dict[Any, str] = {}
    for p in products:
        name = (p.get("name") or "").strip()
        if not name:
            continue
        name_lower = name.lower()
        coll_raw = (p.get("collection") or "").strip()
        collection = coll_raw if coll_raw in KNOWN_COLLECTIONS else "Others"
        products_list.append((name_lower, collection))
        products_map[name_lower] = collection
        if p.get("id"):
            products_by_id[p["id"]] = collection
        if " - " in name:
            base = name.rsplit(" - ", 1)[0].lower().strip()
            if base and base not in products_map:
                products_map[base] = collection

    def resolve(product_id: Optional[str], item_name: Optional[str]) -> str:
        if product_id and product_id in products_by_id:
            return products_by_id[product_id]
        item_lower = (item_name or "").lower().strip()
        if not item_lower:
            return "Others"
        if item_lower in products_map:
            return products_map[item_lower]
        if item_name and " - " in item_name:
            base = item_name.rsplit(" - ", 1)[0].lower().strip()
            if base in products_map:
                return products_map[base]
        for name_lower, coll in products_list:
            if name_lower in item_lower or item_lower in name_lower:
                return coll
        return "Others"

    return resolve


def _credentials(org_creds: OrgIntegrationSettings) -> tuple[str, str]:
    store_url = org_creds.shopify_store_url
    access_token = org_creds.shopify_access_token
    if not store_url or not access_token:
        raise HTTPException(
            status_code=400,
            detail="Shopify credentials are not configured for this organization. Set them in Settings > Integrations.",
        )
    store_url = store_url.strip().rstrip("/")
    if store_url.startswith("http://"):
        store_url = store_url[7:]
    elif store_url.startswith("https://"):
        store_url = store_url[8:]
    return store_url, access_token


def _graphql_endpoint(org_creds: OrgIntegrationSettings) -> tuple[str, Dict[str, str]]:
    store_url, access_token = _credentials(org_creds)
    return (
        f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/graphql.json",
        {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"},
    )


def _throttle_delay(payload: dict, attempt: int) -> float:
    """How long to wait before retrying a THROTTLED query: exactly the time the shop's
    leaky bucket needs to refill to this query's cost, since Shopify returns the bucket
    state alongside the error. Falls back to exponential backoff if it doesn't."""
    cost = (payload.get("extensions") or {}).get("cost") or {}
    throttle_status = cost.get("throttleStatus") or {}
    needed = cost.get("requestedQueryCost")
    available = throttle_status.get("currentlyAvailable")
    restore_rate = throttle_status.get("restoreRate")
    if needed is not None and available is not None and restore_rate:
        return max((needed - available) / restore_rate, 0.0) + 0.1
    return 0.5 * (2 ** attempt)


async def graphql(
    query: str, variables: dict, org_creds: OrgIntegrationSettings,
    client: Optional[httpx.AsyncClient] = None,
) -> dict:
    """Run one GraphQL operation and return its `data`, retrying through both kinds of
    Shopify rate limiting: an HTTP 429 (request-level) and a 200 carrying a THROTTLED
    error (cost-level, which is the one that actually bites on paged reads)."""
    if client is None:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as owned_client:
            return await graphql(query, variables, org_creds, owned_client)

    url, headers = _graphql_endpoint(org_creds)
    for attempt in range(_MAX_GRAPHQL_RETRIES):
        response = await client.post(url, headers=headers, json={"query": query, "variables": variables})
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = float(response.headers.get("Retry-After", 0) or 0)
            await asyncio.sleep(max(retry_after, 0.5 * (2 ** attempt)))
            continue
        response.raise_for_status()
        payload = response.json()
        errors = payload.get("errors") or []
        if not errors:
            return payload.get("data") or {}
        if not any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errors):
            raise HTTPException(status_code=502, detail=f"Shopify GraphQL error: {errors}")
        await asyncio.sleep(_throttle_delay(payload, attempt))
    raise HTTPException(
        status_code=429, detail=f"Shopify kept rate limiting the request after {_MAX_GRAPHQL_RETRIES} attempts")


def _check_user_errors(mutation: str, result: Optional[dict]) -> None:
    """userErrors are how a mutation reports a rejected input - the HTTP call and the
    GraphQL execution both succeed, so nothing else surfaces them."""
    errors = (result or {}).get("userErrors") or []
    if errors:
        raise HTTPException(status_code=502, detail=f"Shopify {mutation} failed: {errors}")


def _legacy_id(gid: Optional[str]) -> Optional[int]:
    """Shopify's numeric REST id, out of a GraphQL global id
    ("gid://shopify/Product/1234" -> 1234). That is the id everything downstream stores,
    so a GraphQL-synced record and a webhook payload still key against each other."""
    if not gid:
        return None
    return int(str(gid).split("?")[0].rsplit("/", 1)[-1])


def _next_page_info(link_header: str) -> str | None:
    """Extract the `page_info` cursor from Shopify's Link header, if there's a next page."""
    match = re.search(r'<([^>]+)>;\s*rel=["\']next["\']', link_header, re.IGNORECASE)
    if not match:
        return None
    url = match.group(1)
    query = urlparse(url).query
    if query:
        params = parse_qs(query, keep_blank_values=True)
        if "page_info" in params:
            return params["page_info"][0]
        found = re.search(r"[?&]page_info=([^&]+)", url)
    else:
        found = re.search(r"page_info=([^&>]+)", url)
    return unquote(found.group(1)) if found else None


async def fetch_all(
    resource: str, first_page_query: str, org_creds: OrgIntegrationSettings, max_records: Optional[int] = None
) -> tuple[List[Dict[str, Any]], int]:
    """Page through a Shopify Admin REST collection.

    `resource` is the JSON key and endpoint name (e.g. "orders" -> orders.json) - only
    orders now, since products and collections moved to GraphQL (see fetch_products).
    `org_creds` is the calling org's own store URL/token/API version - see
    app.org_settings.get_org_integration_settings().
    `max_records`, if given, stops paging once at least that many records are collected
    (e.g. "most recent N orders" with a `order=created_at+desc` query - there's no date
    boundary to filter on ahead of time, so this is the only way to bound the fetch).
    Returns (records, pages_fetched).
    """
    store_url, access_token = _credentials(org_creds)
    base_url = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/{resource}.json"
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}

    records: List[Dict[str, Any]] = []
    page_info = None
    page_count = 0

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        while True:
            api_url = f"{base_url}?page_info={page_info}" if page_info else f"{base_url}?{first_page_query}"

            # Retry on 429 with backoff - concurrent partitioned fetches (see orders.py's
            # sync-shopify) make hitting the shop's rate-limit bucket more likely than a
            # single sequential fetch ever did.
            for attempt in range(_MAX_RATE_LIMIT_RETRIES):
                response = await client.get(api_url, headers=headers)
                if response.status_code != 429:
                    break
                retry_after = float(response.headers.get("Retry-After", 0) or 0)
                await asyncio.sleep(max(retry_after, 0.5 * (2 ** attempt)))

            if response.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        "Shopify API endpoint not found. Please verify:\n"
                        f"1. Store URL is correct: {store_url}\n"
                        f"2. API version is valid: {org_creds.shopify_api_version}\n"
                        "3. Access token has correct permissions\n"
                        f"4. Full URL attempted: {api_url}\n"
                        f"Response: {response.text}"
                    ),
                )
            response.raise_for_status()
            payload = response.json()
            if resource not in payload:
                raise HTTPException(status_code=500, detail="Invalid response from Shopify API")

            page = payload[resource]
            if not page:
                break
            records.extend(page)
            page_count += 1

            if max_records is not None and len(records) >= max_records:
                break

            page_info = _next_page_info(response.headers.get("Link", ""))
            if not page_info:
                break

    return records, page_count


_PRIMARY_LOCATION_QUERY = """
query PrimaryLocation { locations(first: 1) { nodes { id } } }
"""


async def get_primary_location_id(org_creds: OrgIntegrationSettings) -> int:
    """The location adjust_inventory_levels moves stock at. Bills assume a
    single location - the shop's first one - since there's no location picker
    in Settings; a store with more than one would need one added here."""
    data = await graphql(_PRIMARY_LOCATION_QUERY, {}, org_creds)
    locations = data["locations"]["nodes"]
    if not locations:
        raise HTTPException(status_code=502, detail="Shopify returned no inventory locations")
    return _legacy_id(locations[0]["id"])


_INVENTORY_ADJUST_MUTATION = """
mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
  inventoryAdjustQuantities(input: $input) { userErrors { field message } }
}
"""


async def adjust_inventory_levels(
    adjustments: List[tuple[int, int]], location_id: int, org_creds: OrgIntegrationSettings
) -> None:
    """Apply each (inventory_item_id, delta) adjustment at location_id, e.g. so
    a received purchase bill's stock lands in Shopify too - otherwise the next
    products sync (which pulls quantity from Shopify) would silently wipe out
    the local-only addition. All the changes go in one mutation, so unlike the
    per-item REST calls this replaces it cannot half-apply; callers still roll
    back whatever local state they already committed if it fails."""
    changes = [
        {
            "delta": delta,
            "inventoryItemId": f"gid://shopify/InventoryItem/{inventory_item_id}",
            "locationId": f"gid://shopify/Location/{location_id}",
        }
        for inventory_item_id, delta in adjustments if delta != 0
    ]
    if not changes:
        return
    data = await graphql(_INVENTORY_ADJUST_MUTATION, {
        "input": {"name": "available", "reason": "correction", "changes": changes},
    }, org_creds)
    _check_user_errors("inventoryAdjustQuantities", data.get("inventoryAdjustQuantities"))


async def create_fulfillment(
    shopify_order_id: int, tracking_number: str, tracking_company: str,
    tracking_url: Optional[str], org_creds: OrgIntegrationSettings
) -> None:
    """Mark a Shopify order fulfilled with the courier's tracking number and tag it with
    the courier's name, so the store (and the customer's shipping notification) reflect a
    parcel that has actually been booked - called after the courier API hands back a
    tracking number.

    tracking_url makes the number a working link in the customer's shipping email and in
    the order status page; without it Shopify falls back to guessing a carrier URL from
    the company name, which it cannot do for Pakistani couriers it does not know.

    Since API 2024-07 a fulfillment is created against the order's *fulfillment orders*,
    not the order itself, so this looks those up first. Only the ones still open are
    fulfillable; an order with none (already fulfilled, or cancelled) is left alone
    rather than treated as an error, since the booking it belongs to did succeed - but
    it is still tagged, since the courier tag describes who carries the parcel, not
    whether this particular call created the fulfillment.
    """
    store_url, access_token = _credentials(org_creds)
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}
    base = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}"

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        await add_order_tag(shopify_order_id, tracking_company, org_creds, client)

        response = await client.get(f"{base}/orders/{shopify_order_id}/fulfillment_orders.json", headers=headers)
        response.raise_for_status()
        fulfillment_orders = [
            fo for fo in response.json().get("fulfillment_orders", [])
            if fo.get("status") in ("open", "in_progress", "scheduled")
        ]
        if not fulfillment_orders:
            return

        response = await client.post(f"{base}/fulfillments.json", headers=headers, json={
            "fulfillment": {
                "line_items_by_fulfillment_order": [{"fulfillment_order_id": fo["id"]} for fo in fulfillment_orders],
                "tracking_info": {
                    "number": tracking_number,
                    "company": tracking_company,
                    **({"url": tracking_url} if tracking_url else {}),
                },
                "notify_customer": True,
            }
        })
        response.raise_for_status()


# Deeper than _MAX_RATE_LIMIT_RETRIES: the bucket is shop-wide, so concurrent settle
# workers refill it together and a loser can need several seconds of backoff. At 5
# attempts from 0.5s the budget ran out at ~8s and dropped orders.
_SETTLE_RATE_LIMIT_RETRIES = 8


async def _request_with_retry(client, method: str, url: str, **kwargs):
    """Shopify request that backs off on 429 instead of raising - concurrent callers
    (scripts.backfill_settled_orders) share one shop-wide bucket, so a burst can hit
    the limit even well under its capacity."""
    for attempt in range(_SETTLE_RATE_LIMIT_RETRIES):
        response = await client.request(method, url, **kwargs)
        if response.status_code != 429:
            response.raise_for_status()
            return response
        retry_after = float(response.headers.get("Retry-After", 0) or 0)
        await asyncio.sleep(max(retry_after, 0.5 * (2 ** attempt)))
    raise RuntimeError(f"rate limited by Shopify after {_SETTLE_RATE_LIMIT_RETRIES} retries: {url}")


async def mark_order_settled(
    shopify_order_id: int, org_creds: OrgIntegrationSettings, record_payment: bool = True,
    client: Optional[httpx.AsyncClient] = None,
) -> bool:
    """Tag a Shopify order "Settled" and record the courier's payout against it, so the
    store stops showing a COD order as unpaid once the money has actually arrived.

    The tag is what keeps this distinguishable from a customer advance: both land as
    financial_status "paid", so without it the sync would read a courier settlement as
    money the customer paid up front (see shopify_sync's advance derivation).

    Payment is recorded as a `capture` against the pending `sale` the checkout created -
    that parent_id is what Shopify's own "Mark as paid" does, and without it the
    transaction is rejected ("sale is not a valid transaction"). Shopify stores the
    result back as a successful `sale`, so the kind here does not match what you read
    off the order afterwards. Orders with no pending sale (nothing left owing, or
    manually created outside checkout) are tagged only.

    `record_payment=False` tags only. A returned order is settled once the courier has
    reconciled it, but the customer never paid - recording its outstanding balance would
    invent money that never arrived. The tag still matters there: it stops the sync
    reading a later "paid" as a customer advance.

    `client` lets a caller settling many orders share one connection pool rather than
    paying a TLS handshake per order.

    Returns True if the order was marked paid, False if it was only tagged.
    """
    if client is None:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as owned_client:
            return await mark_order_settled(shopify_order_id, org_creds, record_payment, owned_client)

    store_url, access_token = _credentials(org_creds)
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}
    base = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}"

    response = await _request_with_retry(
        client, "GET", f"{base}/orders/{shopify_order_id}.json", headers=headers,
        params={"fields": "id,tags,total_outstanding"})
    order = response.json()["order"]

    # The tags came back with the fetch above, so tag inline rather than calling
    # add_order_tag - it would re-GET the same order, doubling this call in a bulk push.
    tags = [t.strip() for t in (order.get("tags") or "").split(",") if t.strip()]
    if not any(t.lower() == SETTLED_TAG.lower() for t in tags):
        await _request_with_retry(
            client, "PUT", f"{base}/orders/{shopify_order_id}.json", headers=headers,
            json={"order": {"id": shopify_order_id, "tags": ", ".join(tags + [SETTLED_TAG])}})

    outstanding = float(order.get("total_outstanding") or 0)
    if not record_payment or outstanding <= 0:
        return False

    response = await _request_with_retry(
        client, "GET", f"{base}/orders/{shopify_order_id}/transactions.json", headers=headers)
    pending = next((t for t in response.json().get("transactions", [])
                    if t.get("kind") == "sale" and t.get("status") == "pending"), None)
    if not pending:
        return False

    await _request_with_retry(
        client, "POST", f"{base}/orders/{shopify_order_id}/transactions.json", headers=headers, json={
            "transaction": {
                "kind": "capture",
                "status": "success",
                "amount": f"{outstanding:.2f}",
                "gateway": pending.get("gateway"),
                "parent_id": pending["id"],
            }
        })
    return True


async def add_order_tag(
    shopify_order_id: int, tag: str, org_creds: OrgIntegrationSettings, client: httpx.AsyncClient
) -> None:
    """Append `tag` to a Shopify order, leaving its existing tags intact.

    Shopify has no "add one tag" call - `tags` is a single comma-separated string that
    is replaced wholesale - so the current set has to be read first, or the PUT silently
    wipes every other tag the order carries. Matching is case-insensitive so re-running
    a fulfillment cannot produce "PostEx, postex".
    """
    store_url, access_token = _credentials(org_creds)
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}
    base = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}"

    response = await _request_with_retry(
        client, "GET", f"{base}/orders/{shopify_order_id}.json", headers=headers,
        params={"fields": "id,tags"})
    tags = [t.strip() for t in (response.json()["order"].get("tags") or "").split(",") if t.strip()]
    if any(t.lower() == tag.lower() for t in tags):
        return

    await _request_with_retry(
        client, "PUT", f"{base}/orders/{shopify_order_id}.json", headers=headers,
        json={"order": {"id": shopify_order_id, "tags": ", ".join(tags + [tag])}})


# Run as a bulk operation, not a paged query: `first` is ignored on every connection
# inside one, so this reads the whole catalog - products, their variants and their
# collection membership - without page-size tuning, truncation repair, or any of it
# counting against the shop's cost budget. Only the mutation that starts it is billed.
_BULK_PRODUCTS_QUERY = """
{
  products {
    edges {
      node {
        id
        title
        status
        featuredImage { url }
        variants { edges { node { id title price inventoryQuantity inventoryItem { id } } } }
        collections { edges { node { id title } } }
      }
    }
  }
}
"""

_BULK_RUN_MUTATION = """
mutation BulkRun($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
"""

_BULK_STATUS_QUERY = """
query BulkStatus {
  currentBulkOperation(type: QUERY) { id status errorCode url }
}
"""


async def _run_bulk_query(
    query: str, org_creds: OrgIntegrationSettings, client: httpx.AsyncClient
) -> Optional[str]:
    """Run `query` as a bulk operation and return the URL of its JSONL result, or None if
    it matched nothing (Shopify leaves `url` null rather than serving an empty file).

    Shopify runs one bulk query per app per shop at a time, so a second sync started while
    one is still running is rejected outright by bulkOperationRunQuery - surfaced here as
    that userError rather than silently returning a stale operation's data.
    """
    data = await graphql(_BULK_RUN_MUTATION, {"query": query}, org_creds, client)
    result = data["bulkOperationRunQuery"]
    _check_user_errors("bulkOperationRunQuery", result)
    operation_id = result["bulkOperation"]["id"]

    deadline = time.monotonic() + _BULK_TIMEOUT
    delay = _BULK_POLL_INTERVAL
    while True:
        await asyncio.sleep(delay)
        operation = (await graphql(_BULK_STATUS_QUERY, {}, org_creds, client))["currentBulkOperation"]
        # currentBulkOperation is the app's latest, not necessarily the one just started -
        # reading another operation's result as this sync's would sync the wrong data.
        if not operation or operation["id"] != operation_id:
            raise HTTPException(
                status_code=502, detail="Another Shopify bulk operation replaced this one")
        if operation["status"] == "COMPLETED":
            return operation["url"]
        if operation["status"] not in ("CREATED", "RUNNING"):
            raise HTTPException(
                status_code=502,
                detail=f"Shopify bulk operation {operation['status']}: {operation.get('errorCode')}")
        if time.monotonic() > deadline:
            raise HTTPException(
                status_code=504, detail="Shopify bulk operation did not finish in time")
        delay = min(delay * 2, _BULK_POLL_MAX_INTERVAL)


def _normalize_product(node: dict, variants: List[dict]) -> dict:
    """One product in the REST field shape - the same object a products/create or
    products/update webhook delivers, which is what lets reconcile_one_product handle
    a synced product and a webhook payload identically."""
    return {
        "id": _legacy_id(node["id"]),
        "title": node.get("title"),
        # REST's product status was lowercase; reconcile_one_product compares to "active".
        "status": (node.get("status") or "").lower() or None,
        "images": [{"src": node["featuredImage"]["url"]}] if node.get("featuredImage") else [],
        "variants": [
            {
                "id": _legacy_id(v["id"]),
                "title": v.get("title"),
                "price": v.get("price"),
                "inventory_quantity": v.get("inventoryQuantity"),
                "inventory_item_id": _legacy_id((v.get("inventoryItem") or {}).get("id")),
            }
            for v in variants
        ],
    }


def _parse_bulk_products(jsonl: str) -> tuple[List[Dict[str, Any]], Dict[int, List[str]]]:
    """Reassemble a bulk result into (products, collection names by product id).

    Bulk output is one JSON object per line with every nested connection flattened out to
    its own line carrying a `__parentId`, so children are grouped back onto their parent
    here. A child's own id is what says which connection it came from - variants and
    collections are otherwise indistinguishable.
    """
    nodes: List[dict] = []
    variants: Dict[str, List[dict]] = {}
    collections: Dict[str, List[str]] = {}
    for line in jsonl.splitlines():
        if not line.strip():
            continue
        obj = json.loads(line)
        parent = obj.get("__parentId")
        if parent is None:
            nodes.append(obj)
        elif "/ProductVariant/" in obj["id"]:
            variants.setdefault(parent, []).append(obj)
        elif "/Collection/" in obj["id"]:
            collections.setdefault(parent, []).append(obj["title"])

    products = [_normalize_product(node, variants.get(node["id"], [])) for node in nodes]
    collections_by_product = {
        _legacy_id(gid): names for gid, names in collections.items() if names
    }
    return products, collections_by_product


async def fetch_products(
    org_creds: OrgIntegrationSettings
) -> tuple[List[Dict[str, Any]], Dict[int, List[str]]]:
    """The whole catalog in one bulk operation: every product in the REST field shape
    with its variants, plus each product's collection names.

    Collection membership rides along because a bulk operation is not billed per field -
    which is what makes it free here, where the paged query it replaced had to leave it
    to a second round trip (fetch_product_collections, still used by the webhook path).

    `org_creds` is the calling org's own store URL/token/API version - see
    app.org_settings.get_org_integration_settings().
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        url = await _run_bulk_query(_BULK_PRODUCTS_QUERY, org_creds, client)
        if not url:
            return [], {}
        # A signed, already-authenticated URL - deliberately fetched without the Shopify
        # access token, which has no business being sent to the storage host.
        response = await client.get(url)
        response.raise_for_status()
    return _parse_bulk_products(response.text)


_PRODUCT_COLLECTIONS_QUERY = """
query ProductCollections($ids: [ID!]!, $collectionLimit: Int!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      collections(first: $collectionLimit) { nodes { title } }
    }
  }
}
"""


def _chunks(items: List[Any], size: int) -> Iterable[List[Any]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


async def fetch_product_collections(
    product_ids: List[int], org_creds: OrgIntegrationSettings
) -> Dict[int, List[str]]:
    """Map shopify_product_id -> collection names, for just the given products.

    Deliberately not folded into fetch_products: collection membership would then cost a
    nested connection on every product on every sync, while it changes almost never.
    Callers pass only the ids of products still missing one (see
    services/shopify_products_sync.py), looked up _COLLECTION_LOOKUP_CHUNK at a time.
    """
    if not product_ids:
        return {}

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        results = await asyncio.gather(*(
            graphql(_PRODUCT_COLLECTIONS_QUERY, {
                "ids": [f"gid://shopify/Product/{product_id}" for product_id in chunk],
                "collectionLimit": _COLLECTION_PAGE,
            }, org_creds, client)
            for chunk in _chunks(product_ids, _COLLECTION_LOOKUP_CHUNK)
        ))

    product_collections: Dict[int, List[str]] = {}
    for data in results:
        for node in data["nodes"]:
            if not node:
                continue
            names = [collection["title"] for collection in node["collections"]["nodes"]]
            if names:
                product_collections[_legacy_id(node["id"])] = names
    return product_collections


async def register_webhooks(org_creds: OrgIntegrationSettings) -> None:
    """Subscribe this org's store to WEBHOOK_TOPICS. Called right after OAuth connects (routes/shopify_oauth.py's callback) and
    by scripts/register_shopify_webhooks.py for orgs that connected before webhooks existed.

    Safe to re-run: Shopify returns a userError ("Address for this topic has already been
    taken") for a subscription that already exists at this callback URL rather than erroring
    the request, so this only logs it.

    No-ops (logging why) if SHOPIFY_WEBHOOK_CALLBACK_URL isn't configured - webhooks are an
    enhancement over the periodic poll, not a requirement for the app to function, so a
    missing callback URL shouldn't block the OAuth connect flow that calls this.
    """
    callback_url = os.getenv("SHOPIFY_WEBHOOK_CALLBACK_URL")
    if not callback_url:
        logger.warning("SHOPIFY_WEBHOOK_CALLBACK_URL not set - skipping Shopify webhook registration")
        return

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for topic in WEBHOOK_TOPICS:
            try:
                data = await graphql(_WEBHOOK_SUBSCRIPTION_MUTATION, {
                    "topic": topic,
                    "webhookSubscription": {"callbackUrl": callback_url, "format": "JSON"},
                }, org_creds, client)
            except HTTPException as e:
                # One unsupported topic must not cost the store its other subscriptions.
                logger.warning("webhookSubscriptionCreate(%s) failed: %s", topic, e.detail)
                continue
            user_errors = (data.get("webhookSubscriptionCreate") or {}).get("userErrors") or []
            if user_errors:
                logger.warning("webhookSubscriptionCreate(%s) userErrors: %s", topic, user_errors)
