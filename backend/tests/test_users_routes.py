"""Route tests for /api/users/* (org's own self-service user management),
rewritten against org_memberships (Multi-Org User Membership plan). The crux
of this rewrite is: (1) adding an email that already exists elsewhere grants
an instant membership instead of erroring, and (2) role/is_active changes and
the "don't remove the last active admin" guard now target a single
org_memberships row, not the whole identity."""
import app.main as main
from app.auth import require_auth


ADMIN_PAYLOAD = {"sub": "admin1", "org_id": "org1", "role": "admin", "is_superadmin": False}


def _as(payload):
    main.app.dependency_overrides[require_auth] = lambda: payload


class _InsertTrackingQuery:
    """select() returns whatever `select_rows` was seeded with; insert()/
    update() remember their payload so a later execute() reflects it back."""

    def __init__(self, select_rows, defaults=None):
        self._select_rows = select_rows
        self._defaults = defaults or {}
        self._write_payload = None

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self
        return _chain

    def insert(self, payload):
        self._write_payload = payload
        return self

    def update(self, payload):
        self._write_payload = {**(self._select_rows[0] if self._select_rows else {}), **payload}
        return self

    def execute(self):
        if self._write_payload is not None:
            return type("Response", (), {"data": [{**self._defaults, **self._write_payload}]})()
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


class TestListUsers:
    def test_lists_memberships_joined_with_email(self, make_client):
        client = make_client({
            "system_org_memberships": [
                {"user_id": "u1", "org_id": "org1", "role": "admin", "is_active": True, "created_at": "2026-01-01T00:00:00+00:00"},
            ],
            "system_users": [{"id": "u1", "email": "admin@example.com"}],
        })
        _as(ADMIN_PAYLOAD)
        r = client.get("/api/users/")
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 1
        assert body[0]["email"] == "admin@example.com"
        assert body[0]["role"] == "admin"

    def test_no_memberships_returns_empty_list(self, make_client):
        client = make_client({"system_org_memberships": []})
        _as(ADMIN_PAYLOAD)
        r = client.get("/api/users/")
        assert r.status_code == 200
        assert r.json() == []


class TestCreateUser:
    def test_new_email_creates_identity_and_membership(self, make_client, monkeypatch):
        import app.routes.users as users_routes
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "system_users":
                    return _InsertTrackingQuery(select_rows=[], defaults={"id": "new-user-id"})
                if name == "system_org_memberships":
                    return _InsertTrackingQuery(select_rows=[], defaults={
                        "is_active": True, "created_at": "2026-01-01T00:00:00+00:00",
                    })
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(ADMIN_PAYLOAD)
        monkeypatch.setattr(users_routes, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        r = client.post("/api/users/", json={
            "email": "new@example.com", "name": "New User", "password": "supersecret1", "role": "staff",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == "new-user-id"
        assert body["email"] == "new@example.com"
        assert body["role"] == "staff"

    def test_existing_email_grants_instant_membership_no_password_needed(self, make_client, monkeypatch):
        import app.routes.users as users_routes
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "system_users":
                    # Email already exists as an identity elsewhere.
                    return _PassthroughQuery([{"id": "existing-user-id", "email": "existing@example.com"}])
                if name == "system_org_memberships":
                    return _InsertTrackingQuery(select_rows=[], defaults={
                        "is_active": True, "created_at": "2026-01-01T00:00:00+00:00",
                    })
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(ADMIN_PAYLOAD)
        monkeypatch.setattr(users_routes, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        # No password sent at all - the existing identity already has one.
        r = client.post("/api/users/", json={"email": "existing@example.com", "role": "staff"})
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == "existing-user-id"
        assert body["email"] == "existing@example.com"

    def test_already_a_member_of_this_org_is_400(self, make_client, monkeypatch):
        import app.routes.users as users_routes
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "system_users":
                    return _PassthroughQuery([{"id": "existing-user-id", "email": "existing@example.com"}])
                if name == "system_org_memberships":
                    # Already has a membership row for this (user, org) pair.
                    return _PassthroughQuery([{"user_id": "existing-user-id", "org_id": "org1"}])
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(ADMIN_PAYLOAD)
        monkeypatch.setattr(users_routes, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        r = client.post("/api/users/", json={"email": "existing@example.com", "role": "staff"})
        assert r.status_code == 400

    def test_new_email_without_password_is_400(self, make_client, monkeypatch):
        import app.routes.users as users_routes
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "system_users":
                    return _PassthroughQuery([])  # no existing identity
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(ADMIN_PAYLOAD)
        monkeypatch.setattr(users_routes, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        r = client.post("/api/users/", json={"email": "brandnew@example.com", "role": "staff"})
        assert r.status_code == 400

    def test_new_email_without_name_is_400(self, make_client, monkeypatch):
        import app.routes.users as users_routes
        import app.memberships as memberships

        class _FakeSupabase:
            def table(self, name):
                if name == "system_users":
                    return _PassthroughQuery([])  # no existing identity
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(ADMIN_PAYLOAD)
        monkeypatch.setattr(users_routes, "get_supabase", lambda: fake)
        monkeypatch.setattr(memberships, "get_supabase", lambda: fake)

        r = client.post("/api/users/", json={
            "email": "brandnew@example.com", "password": "supersecret1", "role": "staff",
        })
        assert r.status_code == 400


class TestUpdateUser:
    def test_missing_membership_is_404(self, make_client):
        client = make_client({"system_org_memberships": []})
        _as(ADMIN_PAYLOAD)
        r = client.put("/api/users/some-user", json={"role": "staff"})
        assert r.status_code == 404

    def test_demoting_the_last_active_admin_is_400(self, make_client, monkeypatch):
        import app.routes.users as users_routes

        class _FakeSupabase:
            def table(self, name):
                if name == "system_org_memberships":
                    return _PassthroughQuery([
                        {"user_id": "u1", "org_id": "org1", "role": "admin", "is_active": True, "created_at": "2026-01-01T00:00:00+00:00"},
                    ])
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(ADMIN_PAYLOAD)
        monkeypatch.setattr(users_routes, "get_supabase", lambda: fake)

        r = client.put("/api/users/u1", json={"role": "staff"})
        assert r.status_code == 400

    def test_demoting_an_admin_when_another_admin_remains_succeeds(self, make_client, monkeypatch):
        import app.routes.users as users_routes

        class _MembershipsQuery:
            """First select (existing membership for u1) and the last-admin-count
            select both hit `.select(...)` - the count check must still see
            *both* admins (u1 and u2) despite u1 being the one being updated,
            so the route's own exclude_user_id filtering (not the DB query) is
            what's actually under test here."""

            def __init__(self):
                self._write_payload = None

            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def update(self, payload):
                self._write_payload = payload
                return self

            def execute(self):
                if self._write_payload is not None:
                    return type("Response", (), {"data": [{
                        "user_id": "u1", "org_id": "org1", "is_active": True, "created_at": "2026-01-01T00:00:00+00:00",
                        **self._write_payload,
                    }]})()
                return type("Response", (), {"data": [
                    {"user_id": "u1", "org_id": "org1", "role": "admin", "is_active": True, "created_at": "2026-01-01T00:00:00+00:00"},
                    {"user_id": "u2", "org_id": "org1", "role": "admin", "is_active": True, "created_at": "2026-01-01T00:00:00+00:00"},
                ]})()

        class _FakeSupabase:
            def __init__(self):
                self._memberships = _MembershipsQuery()

            def table(self, name):
                if name == "system_org_memberships":
                    return self._memberships
                if name == "system_users":
                    return _PassthroughQuery([{"id": "u1", "email": "u1@example.com"}])
                return _PassthroughQuery([])

        fake = _FakeSupabase()
        client = make_client()
        _as(ADMIN_PAYLOAD)
        monkeypatch.setattr(users_routes, "get_supabase", lambda: fake)

        r = client.put("/api/users/u1", json={"role": "staff"})
        assert r.status_code == 200
        assert r.json()["role"] == "staff"
