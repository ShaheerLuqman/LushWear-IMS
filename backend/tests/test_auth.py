"""Route tests for /api/auth/* (status/login/bootstrap/me/my-organizations/
switch-org) and the require_role gate used by /api/users/*. See
test_login_lockout.py for the lockout mechanism itself, tested in isolation."""
import asyncio

import pytest
from fastapi import HTTPException

from app.auth import hash_password, require_role


def _user_row(password, **overrides):
    """A `users` row - pure identity (Multi-Org User Membership plan): no
    org_id/role/is_active here, those live on org_memberships rows instead."""
    row = {
        "id": "u1",
        "email": "admin@example.com",
        "password_hash": hash_password(password),
        "is_superadmin": False,
    }
    row.update(overrides)
    return row


def _membership_row(**overrides):
    row = {
        "user_id": "u1",
        "org_id": "test-org",
        "role": "admin",
        "is_active": True,
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    row.update(overrides)
    return row


class TestAuthStatus:
    def test_no_users_yet(self, make_client):
        r = make_client({"system_users": []}).get("/api/auth/status")
        assert r.status_code == 200
        assert r.json() == {"has_users": False}

    def test_users_exist(self, make_client):
        r = make_client({"system_users": [{"id": "u1"}]}).get("/api/auth/status")
        assert r.status_code == 200
        assert r.json() == {"has_users": True}


class TestAuthLogin:
    def test_correct_credentials_returns_token(self, make_client):
        client = make_client({
            "system_users": [_user_row("correct-horse")],
            "system_org_memberships": [_membership_row()],
            "system_login_lockouts": [],
        })
        r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "correct-horse"})
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["token"]
        assert body["user"]["email"] == "admin@example.com"
        assert body["user"]["org_id"] == "test-org"
        assert body["user"]["role"] == "admin"
        assert "password_hash" not in body["user"]

    def test_wrong_password_is_401(self, make_client):
        client = make_client({
            "system_users": [_user_row("correct-horse")],
            "system_org_memberships": [_membership_row()],
            "system_login_lockouts": [],
        })
        r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "wrong-password"})
        assert r.status_code == 401

    def test_unknown_email_is_401(self, make_client):
        client = make_client({"system_users": [], "system_login_lockouts": []})
        r = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "whatever1"})
        assert r.status_code == 401

    def test_no_active_membership_anywhere_is_401(self, make_client):
        # Correct password, but no active membership anywhere (simulates the
        # is_active=True filter excluding everything) and not a superadmin -
        # nothing to log into.
        client = make_client({
            "system_users": [_user_row("correct-horse")],
            "system_org_memberships": [],
            "system_login_lockouts": [],
        })
        r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "correct-horse"})
        assert r.status_code == 401

    def test_superadmin_with_no_memberships_can_still_log_in(self, make_client):
        # A pure superadmin (Superadmin Portal) has no org_memberships row at
        # all - login must still succeed, with a null org context.
        client = make_client({
            "system_users": [_user_row("correct-horse", is_superadmin=True)],
            "system_org_memberships": [],
            "system_login_lockouts": [],
        })
        r = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "correct-horse"})
        assert r.status_code == 200
        body = r.json()
        assert body["user"]["is_superadmin"] is True
        assert body["user"]["org_id"] is None
        assert body["user"]["role"] is None


class TestAuthBootstrap:
    def test_first_bootstrap_creates_org_and_admin(self, make_client):
        client = make_client({
            # Non-empty response.data simulates the upsert actually inserting
            # the row (i.e. this is the first-ever bootstrap call).
            "system_bootstrap": [{"id": "default"}],
            "system_organizations": [{"id": "org1", "name": "Acme"}],
            "system_users": [{"id": "u1", "email": "owner@example.com"}],
            "system_org_memberships": [_membership_row(user_id="u1", org_id="org1")],
        })
        r = client.post("/api/auth/bootstrap", json={
            "org_name": "Acme", "name": "Owner", "email": "owner@example.com", "password": "supersecret1",
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
            "org_name": "Acme", "name": "Owner", "email": "owner@example.com", "password": "supersecret1",
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
                if name == "system_organizations":
                    return _OrgAwareQuery(self.tables.get(name, []))
                return _PassthroughQuery(self.tables.get(name, []))

        fake = _FakeSupabase({
            "system_bootstrap": [{"id": "default"}],
            "system_organizations": [{"id": "existing-lushwear-org", "name": "LushWear"}],
            "system_users": [{"id": "u1", "email": "owner@example.com"}],
            "system_org_memberships": [_membership_row(user_id="u1", org_id="existing-lushwear-org")],
        })
        client = make_client()
        monkeypatch.setattr(auth_routes, "get_supabase", lambda: fake)

        r = client.post("/api/auth/bootstrap", json={
            "org_name": "Acme", "name": "Owner", "email": "owner@example.com", "password": "supersecret1",
        })
        assert r.status_code == 200
        assert inserted_orgs == []
        assert r.json()["user"]["org_id"] == "existing-lushwear-org"


class TestAuthMe:
    def test_returns_the_caller_from_the_token_sub(self, make_client):
        import app.main as main
        from app.auth import require_auth

        client = make_client({"system_users": [_user_row("x", id="u1")]})
        main.app.dependency_overrides[require_auth] = lambda: {
            "sub": "u1", "org_id": "test-org", "role": "admin", "is_superadmin": False,
        }
        r = client.get("/api/auth/me")
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == "u1"
        assert body["org_id"] == "test-org"
        assert body["role"] == "admin"


class TestMyOrganizations:
    def test_lists_active_memberships_with_org_names(self, make_client):
        client = make_client({
            "system_org_memberships": [
                _membership_row(org_id="org1", role="admin"),
                _membership_row(org_id="org2", role="staff"),
            ],
            "system_organizations": [
                {"id": "org1", "name": "Acme"},
                {"id": "org2", "name": "Beta"},
            ],
        })
        r = client.get("/api/auth/my-organizations")
        assert r.status_code == 200
        body = r.json()
        assert {(o["id"], o["name"], o["role"]) for o in body} == {
            ("org1", "Acme", "admin"), ("org2", "Beta", "staff"),
        }

    def test_no_memberships_returns_empty_list(self, make_client):
        client = make_client({"system_org_memberships": []})
        r = client.get("/api/auth/my-organizations")
        assert r.status_code == 200
        assert r.json() == []


class TestSwitchOrg:
    def test_switches_to_an_org_with_an_active_membership(self, make_client):
        client = make_client({
            "system_org_memberships": [_membership_row(org_id="org2", role="staff")],
        })
        r = client.post("/api/auth/switch-org", json={"org_id": "org2"})
        assert r.status_code == 200
        import jwt
        payload = jwt.decode(r.json()["token"], options={"verify_signature": False})
        assert payload["org_id"] == "org2"
        assert payload["role"] == "staff"
        assert payload["impersonating"] is False

    def test_no_membership_in_target_org_is_403(self, make_client):
        client = make_client({"system_org_memberships": []})
        r = client.post("/api/auth/switch-org", json={"org_id": "org-not-a-member-of"})
        assert r.status_code == 403


class TestChangePassword:
    def test_correct_current_password_updates_it(self, make_client):
        import app.main as main
        from app.auth import require_auth

        client = make_client({"system_users": [_user_row("old-password1", id="u1")]})
        main.app.dependency_overrides[require_auth] = lambda: {"sub": "u1", "org_id": "test-org", "role": "admin"}
        r = client.post("/api/auth/change-password", json={
            "current_password": "old-password1", "new_password": "new-password1",
        })
        assert r.status_code == 200
        assert r.json() == {"ok": True}

    def test_wrong_current_password_is_401(self, make_client):
        import app.main as main
        from app.auth import require_auth

        client = make_client({"system_users": [_user_row("old-password1", id="u1")]})
        main.app.dependency_overrides[require_auth] = lambda: {"sub": "u1", "org_id": "test-org", "role": "admin"}
        r = client.post("/api/auth/change-password", json={
            "current_password": "wrong-password1", "new_password": "new-password1",
        })
        assert r.status_code == 401


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

        client = make_client({"system_org_memberships": []})
        main.app.dependency_overrides[require_auth] = lambda: {
            "sub": "u2", "org_id": "test-org", "role": "staff", "is_superadmin": False,
        }
        r = client.get("/api/users/")
        assert r.status_code == 403

    def test_admin_can_list_users(self, make_client):
        client = make_client({
            "system_org_memberships": [_membership_row()],  # default override role is "admin"
            "system_users": [_user_row("x")],
        })
        r = client.get("/api/users/")
        assert r.status_code == 200
        assert len(r.json()) == 1
