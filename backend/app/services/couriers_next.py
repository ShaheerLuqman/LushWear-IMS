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
    (client_code, [{code, label, city, address}]).

    `code` is the shipper's profile_id: CreateOrder needs one to know which of the
    merchant's pickup identities a parcel ships under, so this is the Couriers Next
    equivalent of PostEx's pickup addresses and feeds the same picker. client_code
    comes back on the same call, so both are fetched together rather than twice.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        # Their docs specify GET with a JSON body, which httpx only allows via request().
        r = await client.request(
            "GET", f"{_BASE_URL}/ProductAndService.php", json={"auth_key": auth_key})
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
            "city": profile.get("city"),
            "address": " ".join((row.get("shipper_address") or "").split()),
        }
        for row in (body.get("shipper") or [])
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
) -> str:
    """Book one shipment and return its Couriers Next tracking number.

    collection_amount is what the rider collects on delivery, so it must already be
    net of any advance the customer paid - a fully-prepaid order books at 0, not at
    its order value.

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
        "receiver_email": "",
        "receiver_address": delivery_address,
        "pieces": items,
        # Their API requires a weight and rates per_kg. The real weight is not tracked
        # per order here, so this books at their minimum billable 0.5kg and lets them
        # reweigh at intake, which is what the portal's own manual booking does.
        "weight": 0.5,
        "order_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "collection_amount": f"{collection_amount:.2f}",
        "product_description": order_detail or "",
        "special_instruction": "",
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
