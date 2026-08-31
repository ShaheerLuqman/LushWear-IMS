"""Couriers Next order booking - the write side of the Order Fulfillment view.

Couriers Next is an aggregator: it books through a downstream carrier chosen by
`api_vendor`, which this sends as "auto" so their side picks one. That is also why
the city list in services/courier_cities.py is their unscoped master list rather
than any single carrier's coverage.

Their API is a PHP backend that does not follow REST conventions - a successful
call can answer 201, and failures come back as HTTP 200 with an `error`/`message`
body - so every response here is judged on its body, not its status code.
"""

import logging
import time
from datetime import datetime
from typing import List, Optional, Tuple

import httpx

logger = logging.getLogger("app.couriers_next")

_BASE_URL = "https://portal.couriersnext.com/API"
_TIMEOUT = 60.0

# Their booking payload wants both a product and a service_type. "Overnight" is the
# only pair their ProductAndService.php returns for a domestic COD account.
_PRODUCT = "overnight"
_SERVICE_TYPE = "Overnight"


class CouriersNextBookingError(Exception):
    """Couriers Next refused to book one order. Carries their own message so the
    fulfillment endpoint can report per-order why it failed rather than a generic 502."""


class CouriersNextInvoiceError(Exception):
    """The airway bill's order_id could not be resolved for one or more tracking numbers."""


def _parse_body(response: httpx.Response, what: str) -> dict:
    try:
        body = response.json()
    except ValueError:
        raise CouriersNextBookingError(
            f"Couriers Next returned a non-JSON {what} response (HTTP {response.status_code})")
    if not isinstance(body, dict):
        raise CouriersNextBookingError(f"Couriers Next returned an unexpected {what} response")
    return body


async def fetch_shippers(auth_key: str) -> Tuple[Optional[str], List[dict]]:
    """The account's client_code and its configured shipper profiles, as
    (client_code, [{code, label, city, address, is_default}]).

    `code` is the shipper's profile_id: CreateOrder needs one to know which of the
    merchant's pickup identities a parcel ships under, so this is the Couriers Next
    equivalent of PostEx's pickup addresses and feeds the same picker. client_code
    comes back on the same call, so both are fetched together rather than twice.

    Reads `profiles`, not the response's `shipper` key - `shipper` is an unscoped,
    company-wide table (670+ rows across 300+ other merchants' customer_ids in
    testing), while `profiles` is already filtered to this auth_key's own
    default_profile.id. Confirmed live: using `shipper` here would hand every merchant
    every other merchant's pickup identities, and let a booking go out under one.

    Sent as POST despite their docs saying GET-with-a-body: a real GET-with-JSON-body
    request (which is what httpx.request("GET", ..., json=...) sends) gets a 403 HTML
    page from their edge/WAF, confirmed live: POST with the same body returns 200 with
    the real payload.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(f"{_BASE_URL}/ProductAndService.php", json={"auth_key": auth_key})
    if r.status_code >= 400:
        logger.warning("Couriers Next profile fetch failed: status=%s body=%s", r.status_code, r.text[:300])
        return None, []
    try:
        body = r.json()
    except ValueError:
        logger.warning("Couriers Next profile fetch returned non-JSON: %s", r.text[:300])
        return None, []

    # Their response nests default_profile inside a key of the same name.
    profile = body.get("default_profile") or {}
    profile = profile.get("default_profile") or profile
    client_code = profile.get("client_code")

    shippers = [
        {
            "code": str(row.get("profile_id")),
            "label": row.get("shipper_name") or "Shipper",
            "city": row.get("origin") or profile.get("city"),
            "address": " ".join((row.get("shipper_address") or "").split()),
            "is_default": str(row.get("is_default")).strip() == "1",
        }
        for row in (body.get("profiles") or [])
        if row.get("profile_id")
    ]
    return (str(client_code) if client_code else None), shippers


async def create_order(
    client: httpx.AsyncClient,
    auth_key: str,
    *,
    client_code: str,
    profile_id: str,
    order_ref_number: str,
    customer_name: str,
    customer_phone: str,
    delivery_address: str,
    origin_city: str,
    city_name: str,
    collection_amount: float,
    items: int,
    order_detail: Optional[str] = None,
    instructions: Optional[str] = None,
    customer_email: Optional[str] = None,
) -> str:
    """Book one shipment and return its Couriers Next tracking number.

    collection_amount is what the rider collects on delivery, so it must already be
    net of any advance the customer paid - a fully-prepaid order books at 0, not at
    its order value.

    instructions and customer_email are the merchant's per-order overrides, sent as
    special_instruction and receiver_email.

    `tracking_no` is deliberately not sent: it is the merchant's own optional
    reference, and supplying one makes their backend reuse it as the parcel's number
    instead of issuing one, which would collide across orders.

    Raises CouriersNextBookingError when they decline; the caller books the rest.
    """
    payload = {
        "client_code": client_code,
        "auth_key": auth_key,
        "service_type": _SERVICE_TYPE,
        "product": _PRODUCT,
        "profile_id": profile_id,
        "origin": origin_city,
        "destination": city_name,
        "receiver_name": customer_name,
        "receiver_phone": customer_phone,
        "receiver_email": customer_email or "",
        "receiver_address": delivery_address,
        "pieces": items,
        # Their API requires a weight and rates per_kg. The real weight is not tracked
        # per order here, so this books at their minimum billable 0.5kg and lets them
        # reweigh at intake, which is what the portal's own manual booking does.
        "weight": 0.5,
        "order_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "collection_amount": f"{collection_amount:.2f}",
        "product_description": order_detail or "",
        "special_instruction": instructions or "",
        "order_id": f"#{order_ref_number}",
        # Let Couriers Next route to whichever downstream carrier it prefers.
        "api_vendor": "auto",
    }

    try:
        response = await client.post(f"{_BASE_URL}/CreateOrder.php", json=payload)
    except httpx.HTTPError as exc:
        raise CouriersNextBookingError(f"Could not reach Couriers Next: {exc}") from exc

    body = _parse_body(response, "booking")

    tracking_number = body.get("tracking_no")
    if not tracking_number:
        # They report validation failures as a plain message with no tracking_no,
        # on an otherwise successful-looking HTTP status.
        raise CouriersNextBookingError(
            body.get("error") or body.get("message") or f"Couriers Next rejected the order (HTTP {response.status_code})")
    return str(tracking_number)


# ==================== AIRWAY BILL LOOKUP ====================
#
# CreateOrder's response does carry the order's internal `id` (what invoicehtml.php needs),
# but only once, at booking time - there is no endpoint to fetch it back by tracking_no
# (confirmed live: TrackOrder.php and CurrentStatus.php return neither `id` nor `order_id`).
# GetOrderList.php does return it, but as a full, unfiltered dump of the account's entire
# order history (1400+ rows, ~1.2MB, no date/tracking_no filter) - so rather than storing
# `id` at booking time and hoping it never needs recovering, every lookup goes through this
# same endpoint and result, held in a short-lived cache so a batch print of several orders
# costs one fetch, not one per order.

INVOICE_BASE_URL = "https://portal.couriersnext.com/invoicehtml.php"
_ORDER_LIST_CACHE_TTL = 120.0  # seconds
_order_list_cache: dict = {}  # auth_key -> (fetched_at, {tracking_no: id})


async def _fetch_order_ids_by_tracking(auth_key: str) -> dict:
    cached = _order_list_cache.get(auth_key)
    if cached and (time.monotonic() - cached[0]) < _ORDER_LIST_CACHE_TTL:
        return cached[1]

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            r = await client.post(f"{_BASE_URL}/GetOrderList.php", json={"auth_key": auth_key})
        except httpx.HTTPError as exc:
            raise CouriersNextInvoiceError(f"Could not reach Couriers Next: {exc}") from exc
    if r.status_code >= 400:
        raise CouriersNextInvoiceError(f"Couriers Next rejected the order list request (HTTP {r.status_code})")
    try:
        rows = r.json()
    except ValueError:
        raise CouriersNextInvoiceError("Couriers Next returned a non-JSON order list response")
    if not isinstance(rows, list):
        raise CouriersNextInvoiceError("Couriers Next returned an unexpected order list response")

    by_tracking = {
        str(row["tracking_no"]): row["id"]
        for row in rows
        if isinstance(row, dict) and row.get("tracking_no") and row.get("id") is not None
    }
    _order_list_cache[auth_key] = (time.monotonic(), by_tracking)
    return by_tracking


async def get_airway_bill_link(auth_key: str, tracking_numbers: List[str]) -> str:
    """One printable airway bill URL covering every given tracking number, resolved live.

    invoicehtml.php accepts a comma-separated order_id list and renders every one on the
    same page - confirmed live against a real account, same combined-document behaviour
    as PostEx's get-invoice. Raises CouriersNextInvoiceError if none of the tracking
    numbers are found in the account's order list; tracking numbers that ARE found still
    produce a URL even if others in the batch are missing, since a partial bill is still
    useful and the caller already knows which orders it asked for.
    """
    if not tracking_numbers:
        raise CouriersNextInvoiceError("No tracking number given")
    by_tracking = await _fetch_order_ids_by_tracking(auth_key)
    order_ids = [str(by_tracking[t]) for t in (str(tn) for tn in tracking_numbers) if t in by_tracking]
    if not order_ids:
        raise CouriersNextInvoiceError("No Couriers Next order found for the given tracking number(s)")
    return f"{INVOICE_BASE_URL}?order_id={','.join(order_ids)}&print=1"
