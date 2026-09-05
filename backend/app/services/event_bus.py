"""In-memory pub/sub that fans backend-originated changes out to connected
frontend tabs over a WebSocket (routes/events.py). Every write path that
mutates the orders table publishes an "orders_changed" event here after a
successful write - see routes/events.py's module docstring for the full list
of call sites - and routes/shopify_webhooks.py separately publishes
"products_changed" once a product webhook has been reconciled. Either way,
open tabs refresh instead of waiting on the polling backstop
(frontend/js/ledgers.js's ORDERS_AUTO_SYNC_INTERVAL_MS).

Per-process and in-memory: correct only because the backend runs as a single
Uvicorn process (see Dockerfile, no --workers). Scaling to multiple replicas
would need a shared bus (e.g. Postgres LISTEN/NOTIFY or Redis) instead of this
module-global dict.
"""

import asyncio
from collections import defaultdict

_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)


def subscribe(org_id: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    _subscribers[org_id].add(queue)
    return queue


def unsubscribe(org_id: str, queue: asyncio.Queue) -> None:
    _subscribers[org_id].discard(queue)
    if not _subscribers[org_id]:
        _subscribers.pop(org_id, None)


def publish(org_id: str, event: dict) -> None:
    for queue in _subscribers.get(org_id, ()):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # A tab that's stopped reading (backgrounded/frozen) shouldn't block a
            # webhook request or grow unbounded - it'll catch up on the next
            # reload/backstop sync regardless.
            pass
