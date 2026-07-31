"""Unit tests for app/features.py (Feature Access plan) plus one integration
test proving the router-level gate (main.py) actually blocks a disabled
feature's routes end to end - not just the dependency in isolation."""
import asyncio

import pytest
from fastapi import HTTPException

from app.features import get_org_enabled_features, require_feature, set_org_enabled_features


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows
        self._update_payload = None

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self
        return _chain

    def update(self, payload):
        self._update_payload = payload
        return self

    def execute(self):
        if self._update_payload is not None:
            return type("Response", (), {"data": [{**self._rows[0], **self._update_payload}]})()
        return type("Response", (), {"data": list(self._rows)})()


class _FakeSupabase:
    def __init__(self, rows):
        self._rows = rows

    def table(self, name):
        assert name == "organizations"
        return _FakeQuery(self._rows)


class TestGetOrgEnabledFeatures:
    def test_returns_stored_features(self, monkeypatch):
        import app.features as features
        monkeypatch.setattr(features, "get_supabase", lambda: _FakeSupabase(
            [{"id": "org1", "enabled_features": ["orders"]}]
        ))
        assert get_org_enabled_features("org1") == ["orders"]

    def test_missing_org_returns_empty_list(self, monkeypatch):
        import app.features as features
        monkeypatch.setattr(features, "get_supabase", lambda: _FakeSupabase([]))
        assert get_org_enabled_features("does-not-exist") == []


class TestSetOrgEnabledFeatures:
    def test_returns_the_updated_row_s_features(self, monkeypatch):
        import app.features as features
        monkeypatch.setattr(features, "get_supabase", lambda: _FakeSupabase(
            [{"id": "org1", "enabled_features": ["orders", "finance"]}]
        ))
        assert set_org_enabled_features("org1", ["finance"]) == ["finance"]


class TestRequireFeature:
    """Direct unit test of the dependency (no pytest-asyncio in this repo -
    plain asyncio.run, same convention as test_auth.py's TestRequireRole)."""

    def test_allows_when_enabled(self, monkeypatch):
        import app.features as features
        monkeypatch.setattr(features, "get_supabase", lambda: _FakeSupabase(
            [{"id": "org1", "enabled_features": ["orders", "finance"]}]
        ))
        dep = require_feature("finance")
        asyncio.run(dep(org_id="org1"))  # does not raise

    def test_blocks_when_disabled(self, monkeypatch):
        import app.features as features
        monkeypatch.setattr(features, "get_supabase", lambda: _FakeSupabase(
            [{"id": "org1", "enabled_features": ["orders"]}]
        ))
        dep = require_feature("finance")
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(dep(org_id="org1"))
        assert exc_info.value.status_code == 403


class TestRouterGateIntegration:
    """Proves the gate is actually wired up at router level (main.py), not
    just correct in isolation - a disabled feature 403s before the route's
    own logic (and its own Supabase fixtures) ever runs."""

    def test_disabled_finance_blocks_cashbook_router(self, make_client):
        client = make_client({
            "organizations": [{"id": "test-org", "name": "Test Org", "enabled_features": ["orders"]}],
        })
        r = client.get("/api/ledgers/")
        assert r.status_code == 403

    def test_disabled_orders_blocks_products_router(self, make_client):
        client = make_client({
            "organizations": [{"id": "test-org", "name": "Test Org", "enabled_features": ["finance"]}],
        })
        r = client.get("/api/products/")
        assert r.status_code == 403

    def test_enabled_feature_is_not_blocked(self, make_client):
        client = make_client({
            "organizations": [{"id": "test-org", "name": "Test Org", "enabled_features": ["orders", "finance"]}],
            "ledgers": [],
        })
        r = client.get("/api/ledgers/")
        assert r.status_code == 200
