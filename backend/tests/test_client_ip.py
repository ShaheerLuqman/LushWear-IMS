from app.client_ip import get_client_ip


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    def __init__(self, headers=None, client_host="1.2.3.4"):
        self.headers = headers or {}
        self.client = _FakeClient(client_host) if client_host else None


def test_uses_client_host_when_no_forwarded_header():
    assert get_client_ip(_FakeRequest(client_host="9.9.9.9")) == "9.9.9.9"


def test_single_forwarded_for_entry_is_used():
    req = _FakeRequest(headers={"X-Forwarded-For": "203.0.113.5"})
    assert get_client_ip(req) == "203.0.113.5"


def test_uses_the_rightmost_forwarded_for_entry_not_the_leftmost():
    # Rightmost is what the trusted proxy (Northflank) itself observed as the TCP
    # peer; anything to the left could be a value the original client forged.
    req = _FakeRequest(headers={"X-Forwarded-For": "203.0.113.5, 10.0.0.1"})
    assert get_client_ip(req) == "10.0.0.1"


def test_blank_forwarded_for_falls_back_to_client_host():
    req = _FakeRequest(headers={"X-Forwarded-For": ""}, client_host="9.9.9.9")
    assert get_client_ip(req) == "9.9.9.9"


def test_no_client_and_no_header_returns_unknown():
    assert get_client_ip(_FakeRequest(client_host=None)) == "unknown"
