"""Shopify webhook receiver - the near-real-time counterpart to the periodic poll in
app/services/shopify_sync.py. Mounted publicly (no require_auth), like
routes/shopify_oauth.py, since Shopify calls this directly; it authenticates itself via
the HMAC signature on the raw request body instead of a bearer token. Subscriptions are
registered per org via shopify.register_webhooks (see routes/shopify_oauth.py's callback
and scripts/register_shopify_webhooks.py).

One endpoint dispatching on X-Shopify-Topic rather than one route per topic - Shopify lets
a single callback URL subscribe to many topics, and every topic here needs the same
HMAC/org-resolution/idempotency preamble anyway.

Product topics here publish to app/services/event_bus.py directly (see that module's
docstring); order topics don't need to - they persist through
shopify_sync.reconcile_and_persist_single_order, which publishes "orders_changed"
itself alongside every other order-mutating code path.

Exempt from the app-wide per-IP rate limit (app/rate_limit.py): Shopify delivers every
topic for every org from its own small pool of IPs, so one bulk product/inventory edit
bursts past the default limit and gets 429s - which Shopify counts as failed deliveries
and eventually unsubscribes the topic over. The HMAC check is this route's gate.
"""

import base64
import hashlib
import hmac
import logging
import os
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Request, Response

from app.database import get_supabase
from app.org_scope import org_table
from app.org_settings import resolve_org_id_for_shopify_store, upsert_org_integration_settings
from app.rate_limit import limiter
from app.services import event_bus
from app.services.shopify_products_sync import (
    apply_inventory_level_update,
    deactivate_product_by_shopify_id,
    reconcile_and_persist_single_product,
)
from app.services.shopify_sync import reconcile_and_persist_single_order

router = APIRouter(prefix="/webhooks", tags=["shopify-webhooks"])
logger = logging.getLogger("app.shopify_webhooks")

# Topics whose payload is the order resource itself (same REST shape _reconcile_one_order
# already expects), reconciled the same way the periodic sync would. orders/updated alone
# also covers refunds - Shopify fires it for the affected order whenever a refund posts -
# so there's no separate refunds/create handler.
_ORDER_TOPICS = {"orders/create", "orders/updated", "orders/cancelled", "orders/fulfilled"}

# Same idea for products - payload is the product resource itself (same shape
# reconcile_one_product expects). products/delete's payload is too sparse (just an id) to
# go through reconciliation, so it's handled separately below.
_PRODUCT_TOPICS = {"products/create", "products/update"}

# An idempotency row only has to outlive Shopify's retry schedule (19 attempts over 48h),
# so anything older is dead weight - without this the table only ever grows.
_EVENT_RETENTION_DAYS = 7
_PRUNE_INTERVAL_SECONDS = 3600
_last_prune_at = 0.0


def _verify_hmac(body: bytes, received: str) -> bool:
    secret = os.getenv("SHOPIFY_APP_CLIENT_SECRET", "")
    if not secret or not received:
        return False
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    computed = base64.b64encode(digest).decode("ascii")
    return hmac.compare_digest(computed, received)


def _prune_old_events(supabase, org_id: str) -> None:
    """Drop expired idempotency rows, at most hourly per process - cheap enough to piggyback
    on a delivery, and there is no scheduler in this app to hang a real cron job off."""
    global _last_prune_at
    now = time.monotonic()
    if now - _last_prune_at < _PRUNE_INTERVAL_SECONDS:
        return
    _last_prune_at = now
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_EVENT_RETENTION_DAYS)).isoformat()
    try:
        org_table(supabase, org_id, "shopify_webhook_events").delete().lt("received_at", cutoff).execute()
    except Exception:
        logger.exception("Failed pruning shopify_webhook_events for org=%s", org_id)


@router.post("/shopify")
@limiter.exempt
async def shopify_webhook(request: Request):
    body = await request.body()
    if not _verify_hmac(body, request.headers.get("X-Shopify-Hmac-Sha256", "")):
        logger.warning(
            "Rejected Shopify webhook (bad HMAC) from shop=%s", request.headers.get("X-Shopify-Shop-Domain")
        )
        return Response(status_code=401)

    shop = (request.headers.get("X-Shopify-Shop-Domain") or "").strip().lower()
    topic = (request.headers.get("X-Shopify-Topic") or "").strip().lower()
    webhook_id = request.headers.get("X-Shopify-Webhook-Id", "")
    if not shop or not topic or not webhook_id:
        return Response(status_code=400)

    org_id = resolve_org_id_for_shopify_store(shop)
    if not org_id:
        # Not a store we have configured (stale subscription from a disconnected org, or a
        # misconfiguration) - 200 so Shopify doesn't keep retrying a delivery we can never route.
        logger.warning("Shopify webhook for unrecognized shop=%s topic=%s", shop, topic)
        return Response(status_code=200)

    supabase = get_supabase()
    # Idempotency: Shopify webhook delivery is at-least-once. ignore_duplicates mirrors
    # shopify_sync._try_acquire_sync_lock's upsert-then-check-resp.data idiom - resp.data is
    # empty exactly when a row for this (org_id, webhook_id) already existed.
    seen = org_table(supabase, org_id, "shopify_webhook_events").upsert(
        {"webhook_id": webhook_id, "topic": topic},
        on_conflict="org_id,webhook_id",
        ignore_duplicates=True,
    ).execute()
    if not seen.data:
        return Response(status_code=200)

    try:
        payload = await request.json()
        if topic in _ORDER_TOPICS:
            await reconcile_and_persist_single_order(org_id, payload)
        elif topic in _PRODUCT_TOPICS:
            await reconcile_and_persist_single_product(org_id, payload)
            event_bus.publish(org_id, {"type": "products_changed"})
        elif topic == "products/delete":
            if payload.get("id"):
                await deactivate_product_by_shopify_id(org_id, payload["id"])
                event_bus.publish(org_id, {"type": "products_changed"})
        elif topic == "inventory_levels/update":
            if payload.get("inventory_item_id") is not None:
                await apply_inventory_level_update(org_id, payload["inventory_item_id"], payload.get("available"))
                event_bus.publish(org_id, {"type": "products_changed"})
        elif topic == "app/uninstalled":
            # Empty string (not None) so upsert_org_integration_settings actually clears the
            # stored token/refresh_token/expiry instead of leaving them untouched - see its
            # docstring on why an omitted field vs. an explicit clear are different there.
            upsert_org_integration_settings(org_id, shopify_access_token="")
    except Exception:
        logger.exception("Failed processing Shopify webhook topic=%s org=%s", topic, org_id)
        # Release the idempotency row first: without this, the retry the 500 asks for would
        # dedupe against this failed attempt and be acknowledged without ever being
        # processed, silently dropping the event. (A process crash mid-handler still leaks a
        # row - only an exception can be caught here - but that loses the delivery either way.)
        try:
            org_table(supabase, org_id, "shopify_webhook_events").delete().eq(
                "webhook_id", webhook_id
            ).execute()
        except Exception:
            logger.exception("Failed releasing idempotency row for webhook_id=%s", webhook_id)
        return Response(status_code=500)  # non-2xx - Shopify retries

    _prune_old_events(supabase, org_id)
    return Response(status_code=200)
