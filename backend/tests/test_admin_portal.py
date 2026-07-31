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


SUPERADMIN_PAYLOAD = {"sub": "sa1", "org_id": None, "role": None, "is_superadmin": True}
IMPERSONATING_PAYLOAD = {"sub": "sa1", "org_id": "org1", "role": "admin", "is_superadmin": False, "impersonating": True}
PLAIN_ADMIN_PAYLOAD = {"sub": "u1", "org_id": "org1", "role": "admin", "is_superadmin": False}


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
        assert client.get("/api/admin/organizations/org1/users").status_code == 403
        assert client.get("/api/admin/organizations/org1/features").status_code == 403
        assert client.put("/api/admin/organizations/org1/features", json={"enabled_features": []}).status_code == 403

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
        # Viewing an org's user list requires a real superadmin session too -
        # an impersonating token can act within one org, not audit any org.
        assert client.get("/api/admin/organizations/org1/users").status_code == 403
        assert client.get("/api/admin/organizations/org1/features").status_code == 403
        assert client.put("/api/admin/organizations/org1/features", json={"enabled_features": []}).status_code == 403


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


class TestOrganizationUsers:
    """Read-only per-org membership view (routes/admin_portal.py's
    read_organization_users) - lets a superadmin check who has access to an
    org and what role, without impersonating in."""

    def test_missing_org_is_404(self, make_client):
        client = make_client({"organizations": []})
        _as(SUPERADMIN_PAYLOAD)
        r = client.get("/api/admin/organizations/does-not-exist/users")
        assert r.status_code == 404

    def test_lists_members_with_roles(self, make_client, monkeypatch):
        import app.routes.admin_portal as admin_portal
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "organizations":
                    return _PassthroughQuery([{"id": "org1", "name": "Acme"}])
                if name == "org_memberships":
                    return _PassthroughQuery([
                        {"user_id": "u1", "org_id": "org1", "role": "admin", "is_active": True, "created_at": "2026-01-01T00:00:00+00:00"},
                        {"user_id": "u2", "org_id": "org1", "role": "staff", "is_active": False, "created_at": "2026-01-02T00:00:00+00:00"},
                    ])
                if name == "users":
                    return _PassthroughQuery([
                        {"id": "u1", "email": "admin@acme.com"},
                        {"id": "u2", "email": "staff@acme.com"},
                    ])
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(SUPERADMIN_PAYLOAD)
        monkeypatch.setattr(admin_portal, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        r = client.get("/api/admin/organizations/org1/users")
        assert r.status_code == 200
        body = r.json()
        assert {(u["email"], u["role"], u["is_active"]) for u in body} == {
            ("admin@acme.com", "admin", True),
            ("staff@acme.com", "staff", False),
        }


class TestOrganizationFeatures:
    """Per-org feature toggles (Feature Access plan) - which top-level app
    sections (Shopify order management, Finance) this org's users can see/use.
    Strict tier only (require_superadmin) - see TestAuthorizationTiers above."""

    def test_missing_org_is_404(self, make_client):
        client = make_client({"organizations": []})
        _as(SUPERADMIN_PAYLOAD)
        r = client.get("/api/admin/organizations/does-not-exist/features")
        assert r.status_code == 404

    def test_read_returns_stored_features(self, make_client):
        client = make_client({
            "organizations": [{"id": "org1", "name": "Acme", "enabled_features": ["orders"]}],
        })
        _as(SUPERADMIN_PAYLOAD)
        r = client.get("/api/admin/organizations/org1/features")
        assert r.status_code == 200
        assert r.json()["enabled_features"] == ["orders"]

    def test_update_is_reflected_on_read(self, make_client, monkeypatch):
        # Same "fake must remember the write" reasoning as
        # TestIntegrationSettings.test_update_is_reflected_on_read - the route
        # updates then reads its own write back.
        import app.features as features
        import app.routes.admin_portal as admin_portal

        store = {"id": "org1", "name": "Acme", "enabled_features": ["orders", "finance"]}

        class _StatefulQuery:
            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def update(self, payload):
                store.update(payload)
                return self

            def execute(self):
                return type("Response", (), {"data": [dict(store)]})()

        class _FakeSupabase:
            def table(self, name):
                if name == "organizations":
                    return _StatefulQuery()
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(SUPERADMIN_PAYLOAD)
        monkeypatch.setattr(admin_portal, "get_supabase", lambda: fake)
        monkeypatch.setattr(features, "get_supabase", lambda: fake)

        r = client.put("/api/admin/organizations/org1/features", json={"enabled_features": ["finance"]})
        assert r.status_code == 200
        assert r.json()["enabled_features"] == ["finance"]


class _InsertTrackingQuery:
    """select() returns whatever `select_rows` was seeded with; insert()
    remembers its payload so a later execute() reflects it back - lets a test
    distinguish the pre-insert existence check from the insert's own result,
    which a stateless FakeQuery (conftest.py) can't do."""

    def __init__(self, select_rows, insert_defaults=None):
        self._select_rows = select_rows
        self._insert_defaults = insert_defaults or {}
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
            return type("Response", (), {"data": [{**self._insert_defaults, **self._insert_payload}]})()
        return type("Response", (), {"data": list(self._select_rows)})()


class _PassthroughQuery:
    def __init__(self, rows):
        self._rows = rows

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self
        return _chain

    def execute(self):
        return type("Response", (), {"data": list(self._rows)})()


class TestCreateOrganization:
    def test_creates_org_and_first_admin(self, make_client, monkeypatch):
        import app.routes.admin_portal as admin_portal
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "users":
                    return _InsertTrackingQuery(select_rows=[], insert_defaults={"id": "u1"})
                if name == "org_memberships":
                    return _InsertTrackingQuery(select_rows=[], insert_defaults={
                        "is_active": True, "created_at": "2026-01-01T00:00:00+00:00",
                    })
                return _PassthroughQuery([{"id": "org1", "name": "Acme", "created_at": "2026-01-01T00:00:00+00:00"}])

        fake = _FakeSupabase()
        client = make_client()
        _as(SUPERADMIN_PAYLOAD)
        monkeypatch.setattr(admin_portal, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        r = client.post("/api/admin/organizations", json={
            "org_name": "Acme", "admin_email": "owner@acme.com", "admin_password": "supersecret1",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["organization"]["name"] == "Acme"
        assert body["admin_user"]["email"] == "owner@acme.com"
        assert "password_hash" not in body["admin_user"]

    def test_existing_admin_email_reuses_identity_instead_of_erroring(self, make_client, monkeypatch):
        # Multi-Org User Membership plan: an admin_email that already belongs
        # to someone else's account grants them an instant membership in the
        # new org, rather than a rejected duplicate.
        import app.routes.admin_portal as admin_portal
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "users":
                    return _PassthroughQuery([{
                        "id": "existing-user-id", "email": "owner@acme.com", "password_hash": "hash",
                    }])
                if name == "org_memberships":
                    return _InsertTrackingQuery(select_rows=[], insert_defaults={
                        "is_active": True, "created_at": "2026-01-01T00:00:00+00:00",
                    })
                return _PassthroughQuery([{"id": "org2", "name": "Beta", "created_at": "2026-02-01T00:00:00+00:00"}])

        fake = _FakeSupabase()
        client = make_client()
        _as(SUPERADMIN_PAYLOAD)
        monkeypatch.setattr(admin_portal, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        r = client.post("/api/admin/organizations", json={
            "org_name": "Beta", "admin_email": "owner@acme.com", "admin_password": "supersecret1",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["admin_user"]["id"] == "existing-user-id"
        assert body["admin_user"]["email"] == "owner@acme.com"


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
