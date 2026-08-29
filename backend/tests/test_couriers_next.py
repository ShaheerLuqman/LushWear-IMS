"""Couriers Next booking (app/services/couriers_next.py).

Async functions are driven with plain asyncio.run since this repo has no
pytest-asyncio (same convention as test_postex.py's TestCreateOrder).
"""

import asyncio

import httpx
import pytest

from app.services import couriers_next


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)

    def json(self):
        if isinstance(self._payload, str):
            raise ValueError("not json")
        return self._payload


class TestCreateOrder:
    BOOKING = {
        "client_code": "1663",
        "profile_id": "20002",
        "order_ref_number": "4807",
        "customer_name": "Ayesha Khan",
        "customer_phone": "03001234567",
        "delivery_address": "12 Main Boulevard, Gulberg",
        "origin_city": "Karachi",
        "city_name": "Lahore",
        "collection_amount": 4500.0,
        "items": 2,
    }

    @staticmethod
    def _client(payload, captured=None, status_code=200):
        class _Client:
            async def post(self, url, json=None):
                if captured is not None:
                    captured.update({"url": url, "json": json})
                return _Response(payload, status_code)

        return _Client()

    def test_returns_the_tracking_number_and_sends_the_documented_shape(self):
        captured = {}
        client = self._client({
            "tracking_no": "28813251987",
            "id": 182042,
            "message": "Order 28813251987 created successfully",
        }, captured)

        tracking = asyncio.run(couriers_next.create_order(client, "auth-key", **self.BOOKING))

        assert tracking == "28813251987"
        assert captured["url"].endswith("/CreateOrder.php")
        sent = captured["json"]
        assert sent["auth_key"] == "auth-key"
        assert sent["client_code"] == "1663"
        assert sent["profile_id"] == "20002"
        assert sent["origin"] == "Karachi"
        assert sent["destination"] == "Lahore"
        assert sent["receiver_name"] == "Ayesha Khan"
        assert sent["pieces"] == 2
        assert sent["api_vendor"] == "auto"
        # Their order_id is the merchant reference, formatted as their docs show it.
        assert sent["order_id"] == "#4807"

    def test_does_not_send_a_tracking_number(self):
        """Supplying tracking_no makes their backend reuse it as the parcel number
        instead of issuing one, which would collide across orders."""
        captured = {}
        client = self._client({"tracking_no": "1"}, captured)

        asyncio.run(couriers_next.create_order(client, "auth-key", **self.BOOKING))

        assert "tracking_no" not in captured["json"]

    def test_collection_amount_is_sent_as_a_two_decimal_string(self):
        captured = {}
        client = self._client({"tracking_no": "1"}, captured)

        asyncio.run(couriers_next.create_order(
            client, "auth-key", **{**self.BOOKING, "collection_amount": 4499.5}))

        assert captured["json"]["collection_amount"] == "4499.50"

    def test_a_fully_prepaid_order_books_at_zero(self):
        captured = {}
        client = self._client({"tracking_no": "1"}, captured)

        asyncio.run(couriers_next.create_order(
            client, "auth-key", **{**self.BOOKING, "collection_amount": 0.0}))

        assert captured["json"]["collection_amount"] == "0.00"

    def test_a_response_without_a_tracking_number_raises_with_their_message(self):
        """They report validation failures as a plain message on an otherwise
        successful-looking HTTP status, so the body is what decides."""
        client = self._client({"message": "Invalid destination city"})

        with pytest.raises(couriers_next.CouriersNextBookingError, match="Invalid destination city"):
            asyncio.run(couriers_next.create_order(client, "auth-key", **self.BOOKING))

    def test_an_error_key_is_reported_when_present(self):
        client = self._client({"error": "auth_key not found"})

        with pytest.raises(couriers_next.CouriersNextBookingError, match="auth_key not found"):
            asyncio.run(couriers_next.create_order(client, "auth-key", **self.BOOKING))

    def test_a_non_json_response_raises_rather_than_crashing(self):
        client = self._client("<html>502 Bad Gateway</html>")

        with pytest.raises(couriers_next.CouriersNextBookingError, match="non-JSON"):
            asyncio.run(couriers_next.create_order(client, "auth-key", **self.BOOKING))

    def test_a_transport_failure_is_reported_as_unreachable(self):
        class _Client:
            async def post(self, url, json=None):
                raise httpx.ConnectError("connection refused")

        with pytest.raises(couriers_next.CouriersNextBookingError, match="Could not reach"):
            asyncio.run(couriers_next.create_order(_Client(), "auth-key", **self.BOOKING))


class TestFetchShippers:
    """fetch_shippers builds its own AsyncClient, so these stub the transport."""

    PROFILE_RESPONSE = {
        "default_profile": {
            "default_profile": {
                "client_code": "1663",
                "city": "Karachi",
            }
        },
        "shipper": [
            {
                "profile_id": "20001",
                "shipper_name": "Scensational",
                "shipper_address": "A151- 13 C Gulshan e Iqbal\n Karachi",
            },
            {
                "profile_id": "20002",
                "shipper_name": "Impression",
                "shipper_address": "A151 block 13c Gulshan Iqbal karachi",
            },
        ],
    }

    @staticmethod
    def _install(monkeypatch, payload, status_code=200):
        def handler(request):
            return httpx.Response(status_code, json=payload)

        transport = httpx.MockTransport(handler)
        original = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = transport
            return original(*args, **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", factory)

    def test_returns_the_client_code_and_shipper_profiles(self, monkeypatch):
        self._install(monkeypatch, self.PROFILE_RESPONSE)

        client_code, shippers = asyncio.run(couriers_next.fetch_shippers("auth-key"))

        assert client_code == "1663"
        assert [s["code"] for s in shippers] == ["20001", "20002"]
        assert shippers[0]["label"] == "Scensational"
        # The picker shows a city per row; theirs lives on the account, not the shipper.
        assert shippers[0]["city"] == "Karachi"

    def test_embedded_newlines_in_addresses_are_collapsed(self, monkeypatch):
        self._install(monkeypatch, self.PROFILE_RESPONSE)

        _, shippers = asyncio.run(couriers_next.fetch_shippers("auth-key"))

        assert shippers[0]["address"] == "A151- 13 C Gulshan e Iqbal Karachi"

    def test_a_flat_default_profile_is_also_accepted(self, monkeypatch):
        """Their docs nest default_profile inside a key of the same name; tolerate
        the flat shape too rather than reading client_code as missing."""
        self._install(monkeypatch, {
            "default_profile": {"client_code": "1663", "city": "Karachi"},
            "shipper": [{"profile_id": "20001", "shipper_name": "Scensational"}],
        })

        client_code, shippers = asyncio.run(couriers_next.fetch_shippers("auth-key"))

        assert client_code == "1663"
        assert shippers[0]["code"] == "20001"

    def test_a_failed_fetch_returns_nothing_rather_than_raising(self, monkeypatch):
        self._install(monkeypatch, {"error": "unauthorized"}, status_code=401)

        assert asyncio.run(couriers_next.fetch_shippers("bad-key")) == (None, [])

    def test_shippers_without_a_profile_id_are_skipped(self, monkeypatch):
        self._install(monkeypatch, {
            "default_profile": {"client_code": "1663"},
            "shipper": [{"shipper_name": "No profile"}, {"profile_id": "20002", "shipper_name": "Ok"}],
        })

        _, shippers = asyncio.run(couriers_next.fetch_shippers("auth-key"))

        assert [s["code"] for s in shippers] == ["20002"]
