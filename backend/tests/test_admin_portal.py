"""Route tests for /api/admin/* (Superadmin Portal: create/list organizations,
impersonate, and configure any org's integration settings). The crux of this
router is its two-tier authorization - some routes accept a real superadmin
token OR an already-impersonating one, others require a real superadmin token
only - so that split gets its own explicit coverage, not just incidental use."""
import jwt
import pytest

import app.main as main
from app.auth import require_auth


def _decode(token):
    return jwt.decode(token, options={"verify_signature": False})


SUPERADMIN_PAYLOAD = {"sub": "sa1", "org_id": None, "role": "superadmin"}
IMPERSONATING_PAYLOAD = {"sub": "sa1", "org_id": "org1", "role": "admin", "impersonating": True}
PLAIN_ADMIN_PAYLOAD = {"sub": "u1", "org_id": "org1", "role": "admin"}


def _as(payload):
    main.app.dependency_overrides[require_auth] = lambda: payload


class TestAuthorizationTiers:
    """The asymmetry between the two route groups is the actual design - a
    plain org-admin token gets 403 everywhere; an impersonating token gets 200
    on list/impersonate but 403 on create-org and integration-settings."""

    def test_plain_admin_is_rejected_everywhere(self, make_client):
        client = make_client({"organizations": [{"id": "org1", "name": "Acme"}]})
        _as(PLAIN_ADMIN_PAYLOAD)
        assert client.get("/api/admin/organizations").status_code == 403
        assert client.post("/api/admin/organizations/org1/impersonate").status_code == 403
        assert client.post("/api/admin/organizations", json={
            "org_name": "Acme", "admin_email": "a@example.com", "admin_password": "supersecret1",
        }).status_code == 403
        assert client.get("/api/admin/organizations/org1/integration-settings").status_code == 403

    def test_impersonating_token_can_list_and_switch_but_not_administer(self, make_client):
        client = make_client({
            "organizations": [{"id": "org1", "name": "Acme"}, {"id": "org2", "name": "Beta"}],
        })
        _as(IMPERSONATING_PAYLOAD)
        assert client.get("/api/admin/organizations").status_code == 200
        assert client.post("/api/admin/organizations/org2/impersonate").status_code == 200
        assert client.post("/api/admin/organizations", json={
            "org_name": "Gamma", "admin_email": "a@example.com", "admin_password": "supersecret1",
        }).status_code == 403
        assert client.get("/api/admin/organizations/org1/integration-settings").status_code == 403
        assert client.put("/api/admin/organizations/org1/integration-settings", json={}).status_code == 403


class TestListOrganizations:
    def test_lists_all_orgs(self, make_client):
        client = make_client({"organizations": [
            {"id": "org1", "name": "Acme", "created_at": "2026-01-01T00:00:00+00:00"},
            {"id": "org2", "name": "Beta", "created_at": "2026-02-01T00:00:00+00:00"},
        ]})
        _as(SUPERADMIN_PAYLOAD)
        r = client.get("/api/admin/organizations")
        assert r.status_code == 200
        assert [o["name"] for o in r.json()] == ["Acme", "Beta"]


class TestCreateOrganization:
    def test_creates_org_and_first_admin(self, make_client, monkeypatch):
        # A plain registered-rows fixture can't tell the pre-insert "does this
        # email already exist" SELECT apart from the INSERT's own return value
        # (FakeQuery replays the same rows for both) - a non-empty "users" list
        # would make the duplicate-email check fire before the insert is ever
        # reached. Needs a fake that distinguishes select from insert.
        import app.routes.admin_portal as admin_portal

        class _UsersQuery:
            def __init__(self):
                self._insert_payload = None

            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def insert(self, payload):
                self._insert_payload = payload
                return self

            def execute(self):
                if self._insert_payload is not None:
                    return type("Response", (), {"data": [{
                        "id": "u1", "is_active": True, **self._insert_payload,
                    }]})()
                return type("Response", (), {"data": []})()

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
            def table(self, name):
                if name == "users":
                    return _UsersQuery()
                return _PassthroughQuery([{"id": "org1", "name": "Acme", "created_at": "2026-01-01T00:00:00+00:00"}])

        client = make_client()
        _as(SUPERADMIN_PAYLOAD)
        monkeypatch.setattr(admin_portal, "get_supabase", lambda: _FakeSupabase())

        r = client.post("/api/admin/organizations", json={
            "org_name": "Acme", "admin_email": "owner@acme.com", "admin_password": "supersecret1",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["organization"]["name"] == "Acme"
        assert body["admin_user"]["email"] == "owner@acme.com"
        assert "password_hash" not in body["admin_user"]

    def test_duplicate_admin_email_is_400(self, make_client):
        client = make_client({"users": [{"id": "existing"}]})
        _as(SUPERADMIN_PAYLOAD)
        r = client.post("/api/admin/organizations", json={
            "org_name": "Acme", "admin_email": "owner@acme.com", "admin_password": "supersecret1",
        })
        assert r.status_code == 400


class TestImpersonate:
    def test_missing_org_is_404(self, make_client):
        client = make_client({"organizations": []})
        _as(SUPERADMIN_PAYLOAD)
        r = client.post("/api/admin/organizations/does-not-exist/impersonate")
        assert r.status_code == 404

    def test_token_shape_from_real_superadmin(self, make_client):
        client = make_client({"organizations": [{"id": "org1", "name": "Acme"}]})
        _as(SUPERADMIN_PAYLOAD)
        r = client.post("/api/admin/organizations/org1/impersonate")
        assert r.status_code == 200
        payload = _decode(r.json()["token"])
        assert payload["sub"] == "sa1"
        assert payload["org_id"] == "org1"
        assert payload["role"] == "admin"
        assert payload["impersonating"] is True
        assert payload["exp"] - payload["iat"] == pytest.approx(3600, abs=5)

    def test_switching_preserves_original_superadmin_sub(self, make_client):
        client = make_client({"organizations": [{"id": "org2", "name": "Beta"}]})
        _as(IMPERSONATING_PAYLOAD)  # already impersonating org1, as superadmin sa1
        r = client.post("/api/admin/organizations/org2/impersonate")
        assert r.status_code == 200
        payload = _decode(r.json()["token"])
        assert payload["sub"] == "sa1"
        assert payload["org_id"] == "org2"
        assert payload["impersonating"] is True


class TestIntegrationSettings:
    def test_missing_org_is_404(self, make_client):
        client = make_client({"organizations": []})
        _as(SUPERADMIN_PAYLOAD)
        r = client.get("/api/admin/organizations/does-not-exist/integration-settings")
        assert r.status_code == 404

    def test_update_is_reflected_on_read(self, make_client, monkeypatch):
        # FakeQuery (conftest.py) is stateless - it always replays the rows a
        # test registered, regardless of what upsert() was called with. The
        # route reads its own write back (upsert then GET), so this needs a
        # fake that remembers the last upsert, same reasoning as
        # test_org_settings_routes.py's equivalent test.
        import app.org_settings as org_settings

        store = {}

        class _StatefulQuery:
            def __init__(self, rows):
                self._rows = rows

            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def upsert(self, payload, on_conflict=None):
                store.update(payload)
                return self

            def execute(self):
                if store:
                    return type("Response", (), {"data": [dict(store)]})()
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
                if name == "org_integration_settings":
                    return _StatefulQuery(self.tables.get(name, []))
                return _PassthroughQuery(self.tables.get(name, []))

        fake = _FakeSupabase({"organizations": [{"id": "org1", "name": "Acme"}]})
        client = make_client()
        _as(SUPERADMIN_PAYLOAD)
        monkeypatch.setattr(org_settings, "get_supabase", lambda: fake)
        import app.routes.admin_portal as admin_portal
        monkeypatch.setattr(admin_portal, "get_supabase", lambda: fake)

        r = client.put("/api/admin/organizations/org1/integration-settings", json={
            "shopify_store_url": "acme.myshopify.com",
        })
        assert r.status_code == 200
        assert r.json()["shopify_store_url"] == "acme.myshopify.com"
