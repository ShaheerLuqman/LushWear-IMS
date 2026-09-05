import asyncio
import logging
import os
import re
from typing import Any, Callable, Dict, List, Optional
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

    `resource` is the JSON key and endpoint name (e.g. "orders" -> orders.json).
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


async def get_primary_location_id(org_creds: OrgIntegrationSettings) -> int:
    """The location inventory_levels/adjust.json posts to. Bills assume a
    single location - the shop's first one - since there's no location picker
    in Settings; a store with more than one would need one added here."""
    store_url, access_token = _credentials(org_creds)
    url = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/locations.json"
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(url, headers=headers)
    response.raise_for_status()
    locations = response.json().get("locations", [])
    if not locations:
        raise HTTPException(status_code=502, detail="Shopify returned no inventory locations")
    return locations[0]["id"]


async def adjust_inventory_levels(
    adjustments: List[tuple[int, int]], location_id: int, org_creds: OrgIntegrationSettings
) -> None:
    """Apply each (inventory_item_id, delta) adjustment at location_id, e.g. so
    a received purchase bill's stock lands in Shopify too - otherwise the next
    products sync (which pulls quantity from Shopify) would silently wipe out
    the local-only addition. Raises on the first failure; callers roll back
    whatever local state they already committed."""
    if not adjustments:
        return
    store_url, access_token = _credentials(org_creds)
    url = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/inventory_levels/adjust.json"
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for inventory_item_id, delta in adjustments:
            if delta == 0:
                continue
            for attempt in range(_MAX_RATE_LIMIT_RETRIES):
                response = await client.post(url, headers=headers, json={
                    "location_id": location_id,
                    "inventory_item_id": inventory_item_id,
                    "available_adjustment": delta,
                })
                if response.status_code != 429:
                    break
                retry_after = float(response.headers.get("Retry-After", 0) or 0)
                await asyncio.sleep(max(retry_after, 0.5 * (2 ** attempt)))
            response.raise_for_status()


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


async def fetch_product_collections(
    product_ids: List[int], org_creds: OrgIntegrationSettings
) -> Dict[int, List[str]]:
    """Map shopify_product_id -> collection names, for just the given products.

    products.json never includes collection membership (Shopify models it as a separate
    many-to-many resource). Collections rarely change once set, so callers pass only the
    ids of products still missing one - each becomes a single collects.json?product_id=
    call instead of paging the whole store's collects table on every sync.
    """
    if not product_ids:
        return {}

    (custom_collections, _), (smart_collections, _), collects_by_product = await asyncio.gather(
        fetch_all("custom_collections", f"limit={PAGE_LIMIT}", org_creds),
        fetch_all("smart_collections", f"limit={PAGE_LIMIT}", org_creds),
        asyncio.gather(*(
            fetch_all("collects", f"product_id={pid}&limit={PAGE_LIMIT}", org_creds)
            for pid in product_ids
        )),
    )
    titles_by_id = {c["id"]: c["title"] for c in custom_collections + smart_collections}

    product_collections: Dict[int, List[str]] = {}
    for product_id, (collects, _) in zip(product_ids, collects_by_product):
        names = [titles_by_id[c["collection_id"]] for c in collects if c.get("collection_id") in titles_by_id]
        if names:
            product_collections[product_id] = names
    return product_collections


async def register_webhooks(org_creds: OrgIntegrationSettings) -> None:
    """Subscribe this org's store to WEBHOOK_TOPICS, via the GraphQL Admin API (the modern
    way to manage webhook subscriptions regardless of whether the rest of the app has moved
    off REST yet). Called right after OAuth connects (routes/shopify_oauth.py's callback) and
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

    store_url, access_token = _credentials(org_creds)
    url = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/graphql.json"
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for topic in WEBHOOK_TOPICS:
            response = await client.post(url, headers=headers, json={
                "query": _WEBHOOK_SUBSCRIPTION_MUTATION,
                "variables": {
                    "topic": topic,
                    "webhookSubscription": {"callbackUrl": callback_url, "format": "JSON"},
                },
            })
            response.raise_for_status()
            payload = response.json()
            if payload.get("errors"):
                logger.warning("webhookSubscriptionCreate(%s) GraphQL errors: %s", topic, payload["errors"])
                continue
            user_errors = (payload.get("data", {}).get("webhookSubscriptionCreate") or {}).get("userErrors") or []
            if user_errors:
                logger.warning("webhookSubscriptionCreate(%s) userErrors: %s", topic, user_errors)
