"""WebSocket push for order-table changes. Every write path that mutates the orders
table (routes/orders.py, routes/products.py's cost-cascade, app/advance_status.py, and
app/services/shopify_sync.py for Shopify-webhook/sync-driven writes) publishes into
app/services/event_bus.py, which fans each event out to every subscribed tab for that
org - this is what lets the Orders grid refresh live instead of waiting for a manual
reload or the polling backstop (frontend/js/ledgers.js's ORDERS_AUTO_SYNC_INTERVAL_MS).
Only writes made through the app/API are covered - a row edited directly in the
database bypasses all of this, same as it bypasses everything else app-side (org
scoping, audit logging, etc).

The browser's WebSocket API can't send an Authorization header on the handshake, so
/ws can't go through the normal Depends(require_auth) header check every other route
uses. It takes a short-lived, single-purpose ticket (minted by /ticket, which *is*
behind require_auth) as a query param instead, reusing the signed state-token helpers
routes/shopify_oauth.py already uses for the same "prove this request came from a
session we issued" problem.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, Query, WebSocket

from app.auth import create_state_token, get_org_id, verify_state_token
from app.features import require_feature
from app.services import event_bus

router = APIRouter(prefix="/events", tags=["events"])
logger = logging.getLogger("app.events")

_TICKET_PURPOSE = "ws"
_TICKET_TTL_SECONDS = 30
_KEEPALIVE_SECONDS = 20


@router.post("/ticket", dependencies=[Depends(require_feature("orders"))])
async def issue_ticket(org_id: str = Depends(get_org_id)) -> dict:
    ticket = create_state_token({"org_id": org_id, "purpose": _TICKET_PURPOSE}, ttl_seconds=_TICKET_TTL_SECONDS)
    return {"ticket": ticket}


@router.websocket("/ws")
async def ws_stream(websocket: WebSocket, ticket: str = Query(...)):
    try:
        claims = verify_state_token(ticket)
    except Exception:
        claims = None
    if not claims or claims.get("purpose") != _TICKET_PURPOSE or not claims.get("org_id"):
        # Closing without accepting rejects the handshake outright (the client's
        # websocket_connect/WebSocket.onerror fires) rather than opening a socket
        # just to immediately drop it.
        await websocket.close(code=4401)
        return
    org_id = claims["org_id"]

    await websocket.accept()
    queue = event_bus.subscribe(org_id)
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=_KEEPALIVE_SECONDS)
            except asyncio.TimeoutError:
                event = {"type": "ping"}  # keeps intermediate proxies from idling the connection out
            try:
                await websocket.send_json(event)
            except Exception:
                # Any send failure means the client is gone (closed tab, dropped connection,
                # etc) - nothing left to do but stop and clean up. Broader than catching just
                # WebSocketDisconnect since the exact exception depends on the ASGI server.
                break
    finally:
        event_bus.unsubscribe(org_id, queue)
