"""Route tests for /api/auth/* (status/login/bootstrap/me) and the
require_role gate used by /api/users/*. See test_login_lockout.py for the
lockout mechanism itself (tested in isolation, same reasoning as
test_app_pin_lockout.py)."""
import asyncio

import pytest
from fastapi import HTTPException

from app.auth import hash_password, require_role


def _user_row(password, **overrides):
    row = {
        "id": "u1",
        "org_id": "test-org",
        "email": "admin@example.com",
        "password_hash": hash_password(password),
        "role": "admin",
        "is_active": True,
    }
    row.update(overrides)
    return row


class TestAuthStatus:
    def test_no_users_yet(self, make_client):
        r = make_client({"users": []}).get("/api/auth/status")
        assert r.status_code == 200
        assert r.json() == {"has_users": False}

    def test_users_exist(self, make_client):
        r = make_client({"users": [{"id": "u1"}]}).get("/api/auth/status")
        assert r.status_code == 200
        assert r.json() == {"has_users": True}


class TestAuthLogin:
    def test_correct_credentials_returns_token(self, make_client):
        client = make_client({"users": [_user_row("correct-horse")], "login_lockouts": []})
        r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "correct-horse"})
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["token"]
        assert body["user"]["email"] == "admin@example.com"
        assert "password_hash" not in body["user"]

    def test_wrong_password_is_401(self, make_client):
        client = make_client({"users": [_user_row("correct-horse")], "login_lockouts": []})
        r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "wrong-password"})
        assert r.status_code == 401

    def test_unknown_email_is_401(self, make_client):
        client = make_client({"users": [], "login_lockouts": []})
        r = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "whatever1"})
        assert r.status_code == 401

    def test_inactive_user_is_401(self, make_client):
        row = _user_row("correct-horse", is_active=False)
        client = make_client({"users": [row], "login_lockouts": []})
        r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "correct-horse"})
        assert r.status_code == 401


class TestAuthBootstrap:
    def test_first_bootstrap_creates_org_and_admin(self, make_client):
        client = make_client({
            # Non-empty response.data simulates the upsert actually inserting
            # the row (i.e. this is the first-ever bootstrap call).
            "system_bootstrap": [{"id": "default"}],
            "organizations": [{"id": "org1", "name": "Acme"}],
            "users": [{
                "id": "u1", "org_id": "org1", "email": "owner@example.com",
                "role": "admin", "is_active": True,
            }],
        })
        r = client.post("/api/auth/bootstrap", json={
            "org_name": "Acme", "email": "owner@example.com", "password": "supersecret1",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["token"]
        assert body["user"]["email"] == "owner@example.com"

    def test_second_bootstrap_is_rejected(self, make_client):
        # Empty response.data simulates ON CONFLICT DO NOTHING skipping the
        # insert - bootstrap has already run once.
        client = make_client({"system_bootstrap": []})
        r = client.post("/api/auth/bootstrap", json={
            "org_name": "Acme", "email": "owner@example.com", "password": "supersecret1",
        })
        assert r.status_code == 400

    def test_bootstrap_reuses_an_org_already_backfilled_by_migration(self, make_client, monkeypatch):
        # The org-scoping migration (20260730070000) creates a "LushWear" org
        # while backfilling pre-existing data, before this endpoint is ever
        # called. Bootstrap must attach the first admin to that org instead of
        # inserting a second one - otherwise the admin ends up in an empty org
        # while all the migrated data sits under the other one.
        import app.routes.auth as auth_routes

        inserted_orgs = []

        class _OrgAwareQuery:
            def __init__(self, rows):
                self._rows = rows
                self._insert_called = False

            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def insert(self, payload):
                self._insert_called = True
                inserted_orgs.append(payload)
                return self

            def execute(self):
                if self._insert_called:
                    return type("Response", (), {"data": [{"id": "new-org", **inserted_orgs[-1]}]})()
                return type("Response", (), {"data": list(self._rows)})()

        class _PassthroughQuery:
            def __init__(self, rows):
                self._rows = rows

            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def execute(self):
                return type("Response", (), {"data": list(self._rows)})()

        class _FakeSupabase:
            def __init__(self, tables):
                self.tables = tables

            def table(self, name):
                if name == "organizations":
                    return _OrgAwareQuery(self.tables.get(name, []))
                return _PassthroughQuery(self.tables.get(name, []))

        fake = _FakeSupabase({
            "system_bootstrap": [{"id": "default"}],
            "organizations": [{"id": "existing-lushwear-org", "name": "LushWear"}],
            "users": [{
                "id": "u1", "org_id": "existing-lushwear-org", "email": "owner@example.com",
                "role": "admin", "is_active": True,
            }],
        })
        client = make_client()
        monkeypatch.setattr(auth_routes, "get_supabase", lambda: fake)

        r = client.post("/api/auth/bootstrap", json={
            "org_name": "Acme", "email": "owner@example.com", "password": "supersecret1",
        })
        assert r.status_code == 200
        assert inserted_orgs == []
        assert r.json()["user"]["org_id"] == "existing-lushwear-org"


class TestAuthMe:
    def test_returns_the_caller_from_the_token_sub(self, make_client):
        import app.main as main
        from app.auth import require_auth

        client = make_client({"users": [_user_row("x", id="u1")]})
        main.app.dependency_overrides[require_auth] = lambda: {"sub": "u1", "org_id": "test-org", "role": "admin"}
        r = client.get("/api/auth/me")
        assert r.status_code == 200
        assert r.json()["id"] == "u1"


class TestRequireRole:
    """Direct unit test of the dependency (no pytest-asyncio in this repo -
    plain asyncio.run instead), same reasoning as the rest of this file's
    preference for testing mechanisms in isolation where the HTTP layer adds
    nothing."""

    def test_allows_matching_role(self):
        dep = require_role("admin")
        result = asyncio.run(dep(payload={"sub": "u1", "role": "admin"}))
        assert result["role"] == "admin"

    def test_rejects_non_matching_role(self):
        dep = require_role("admin")
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(dep(payload={"sub": "u1", "role": "staff"}))
        assert exc_info.value.status_code == 403


class TestUsersRouterRoleGate:
    def test_staff_cannot_list_users(self, make_client):
        import app.main as main
        from app.auth import require_auth

        client = make_client({"users": []})
        main.app.dependency_overrides[require_auth] = lambda: {"sub": "u2", "org_id": "test-org", "role": "staff"}
        r = client.get("/api/users/")
        assert r.status_code == 403

    def test_admin_can_list_users(self, make_client):
        client = make_client({"users": [_user_row("x")]})  # default override role is "admin"
        r = client.get("/api/users/")
        assert r.status_code == 200
        assert len(r.json()) == 1
