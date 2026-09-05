"""app/services/event_bus.py (in-memory pub/sub) and app/routes/events.py (the
WebSocket built on it). See test_shopify_webhooks.py, test_shopify_sync.py, and
test_advance_status.py for the actual publish() call sites."""
import asyncio

import pytest

import app.routes.events as events
import app.services.event_bus as event_bus
from app.auth import create_state_token, verify_state_token


@pytest.fixture(autouse=True)
def _clean_subscribers():
    event_bus._subscribers.clear()
    yield
    event_bus._subscribers.clear()


class TestEventBus:
    def test_publish_reaches_every_subscriber_for_that_org(self):
        q1 = event_bus.subscribe("org-1")
        q2 = event_bus.subscribe("org-1")
        event_bus.publish("org-1", {"type": "orders_changed"})
        assert q1.get_nowait() == {"type": "orders_changed"}
        assert q2.get_nowait() == {"type": "orders_changed"}

    def test_publish_does_not_reach_a_different_org(self):
        q = event_bus.subscribe("org-2")
        event_bus.publish("org-1", {"type": "orders_changed"})
        assert q.empty()

    def test_unsubscribe_stops_delivery_and_drops_the_empty_org_entry(self):
        q = event_bus.subscribe("org-1")
        event_bus.unsubscribe("org-1", q)
        event_bus.publish("org-1", {"type": "orders_changed"})
        assert q.empty()
        assert "org-1" not in event_bus._subscribers

    def test_publish_to_nobody_subscribed_is_a_no_op(self):
        event_bus.publish("org-nobody-home", {"type": "orders_changed"})  # does not raise

    def test_a_full_queue_drops_the_event_instead_of_blocking(self):
        q = event_bus.subscribe("org-1")
        for _ in range(q.maxsize):
            event_bus.publish("org-1", {"type": "orders_changed"})
        event_bus.publish("org-1", {"type": "one_too_many"})  # does not raise
        assert q.qsize() == q.maxsize


class TestIssueTicket:
    def test_ticket_carries_the_caller_s_org_and_a_short_ttl(self):
        result = asyncio.run(events.issue_ticket(org_id="org-1"))
        decoded = verify_state_token(result["ticket"])
        assert decoded["org_id"] == "org-1"
        assert decoded["purpose"] == "ws"
        assert decoded["exp"] - decoded["iat"] == events._TICKET_TTL_SECONDS


class TestIssueTicketRoute:
    """End-to-end through the mounted app, so require_auth/require_feature's router
    wiring (main.py) is covered too, not just issue_ticket() in isolation."""

    def test_returns_a_ticket_scoped_to_the_caller_s_org(self, make_client):
        client = make_client()
        r = client.post("/api/events/ticket")
        assert r.status_code == 200
        assert verify_state_token(r.json()["ticket"])["org_id"] == "test-org"

    def test_blocked_when_the_orders_feature_is_disabled(self, make_client):
        client = make_client({"system_organizations": [{"id": "test-org", "name": "Test Org", "enabled_features": ["finance"]}]})
        r = client.post("/api/events/ticket")
        assert r.status_code == 403


class _FakeWebSocket:
    """Stands in for FastAPI's WebSocket - ws_stream() is called directly (not through
    a real ASGI connection), which also keeps everything on one event loop so
    event_bus.publish() reliably wakes the route's queue.get() with no thread-safety
    concerns to work around (unlike driving this through TestClient.websocket_connect,
    which runs the app on a separate thread)."""

    def __init__(self, fail_after=None):
        self.accepted = False
        self.closed_code = None
        self.sent = []
        # send_json raises starting from the call at this index - simulates the client
        # disconnecting after `fail_after` messages. None means it never fails.
        self._fail_after = fail_after

    async def accept(self):
        self.accepted = True

    async def close(self, code=None):
        self.closed_code = code

    async def send_json(self, data):
        if self._fail_after is not None and len(self.sent) >= self._fail_after:
            raise RuntimeError("connection closed")
        self.sent.append(data)


class TestWsStream:
    def test_bad_ticket_is_rejected_without_accepting(self):
        async def _run():
            ws = _FakeWebSocket()
            await events.ws_stream(ws, ticket="not-a-real-token")
            assert ws.closed_code == 4401
            assert ws.accepted is False

        asyncio.run(_run())

    def test_expired_ticket_is_rejected(self):
        async def _run():
            expired = create_state_token({"org_id": "org-1", "purpose": "ws"}, ttl_seconds=-1)
            ws = _FakeWebSocket()
            await events.ws_stream(ws, ticket=expired)
            assert ws.closed_code == 4401

        asyncio.run(_run())

    def test_ticket_minted_for_a_different_purpose_is_rejected(self):
        async def _run():
            state_token = create_state_token({"org_id": "org-1"})  # e.g. the Shopify OAuth state token
            ws = _FakeWebSocket()
            await events.ws_stream(ws, ticket=state_token)
            assert ws.closed_code == 4401

        asyncio.run(_run())

    def test_receives_a_published_event(self):
        # Ends the loop via a 2nd publish whose send() is made to fail, rather than
        # task.cancel() - cancelling a task suspended inside asyncio.wait_for() races
        # with its internal cleanup on this Python/event-loop combination and can hang,
        # which a real disconnect (the thing this is actually simulating) never does.
        async def _run():
            org_id = "org-1"
            ticket = create_state_token({"org_id": org_id, "purpose": "ws"}, ttl_seconds=30)
            ws = _FakeWebSocket(fail_after=1)
            task = asyncio.create_task(events.ws_stream(ws, ticket=ticket))
            await asyncio.sleep(0)  # let it accept()+subscribe() before we publish
            event_bus.publish(org_id, {"type": "orders_changed"})
            event_bus.publish(org_id, {"type": "orders_changed"})  # 2nd send raises, ending the loop
            await asyncio.wait_for(task, timeout=2)
            assert ws.accepted is True
            assert ws.sent == [{"type": "orders_changed"}]
            assert org_id not in event_bus._subscribers

        asyncio.run(_run())

    def test_does_not_receive_another_org_s_event(self):
        async def _run():
            ticket = create_state_token({"org_id": "org-1", "purpose": "ws"}, ttl_seconds=30)
            ws = _FakeWebSocket(fail_after=1)
            task = asyncio.create_task(events.ws_stream(ws, ticket=ticket))
            await asyncio.sleep(0)
            event_bus.publish("org-2", {"type": "orders_changed"})
            event_bus.publish("org-1", {"type": "products_changed"})
            event_bus.publish("org-1", {"type": "products_changed"})  # 2nd send raises, ending the loop
            await asyncio.wait_for(task, timeout=2)
            assert ws.sent == [{"type": "products_changed"}]

        asyncio.run(_run())

    def test_a_send_failure_ends_the_loop_and_unsubscribes(self):
        async def _run():
            org_id = "org-1"
            ticket = create_state_token({"org_id": org_id, "purpose": "ws"}, ttl_seconds=30)
            ws = _FakeWebSocket(fail_after=0)  # the very first send raises
            task = asyncio.create_task(events.ws_stream(ws, ticket=ticket))
            await asyncio.sleep(0)
            event_bus.publish(org_id, {"type": "orders_changed"})
            await asyncio.wait_for(task, timeout=1)  # ends on its own, no cancel needed
            assert org_id not in event_bus._subscribers

        asyncio.run(_run())
