import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """TestClient requests all share one synthetic peer address, so the global
    default rate limit (app/rate_limit.py) would otherwise accumulate across
    the whole suite instead of resetting per test."""
    from app.rate_limit import limiter
    limiter.reset()
    yield
    limiter.reset()


class FakeQuery:
    """Chainable stand-in for a supabase-py query builder.

    Every filter/order method returns self so any chain is accepted; `execute()`
    hands back whatever rows the test registered for the table.
    """

    def __init__(self, rows):
        self._rows = rows

    def __getattr__(self, _name):
        # select/eq/gte/lt/order/limit/range/is_/in_/not_ … all just continue the chain.
        def _chain(*_args, **_kwargs):
            return self
        return _chain

    def execute(self):
        return type("Response", (), {"data": list(self._rows), "count": len(self._rows)})()


class FakeSupabase:
    def __init__(self, tables, rpc_results=None):
        self.tables = tables
        self.rpc_results = rpc_results or {}

    def table(self, name):
        return FakeQuery(self.tables.get(name, []))

    def rpc(self, name, params=None):
        return FakeQuery(self.rpc_results.get(name, []))


@pytest.fixture
def make_client():
    """Build a TestClient with auth bypassed and Supabase replaced by fixture rows."""
    import app.main as main
    from app.auth import require_auth

    created = []

    def _factory(tables=None, rpc_results=None):
        fake = FakeSupabase(tables or {}, rpc_results)
        # role="admin" so users.router's require_role("admin") gate (which wraps
        # require_auth) passes by default too; tests exercising the 403 case
        # override this further with their own dependency_overrides[require_auth].
        main.app.dependency_overrides[require_auth] = lambda: {
            "sub": "test", "org_id": "test-org", "role": "admin", "is_superadmin": False,
        }

        import app.routes.orders as orders
        import app.routes.products as products
        import app.routes.cashbook as cashbook
        import app.routes.ledger as ledger
        import app.routes.auth as auth_routes
        import app.routes.users as users
        import app.routes.admin_portal as admin_portal
        import app.services.shopify_sync as shopify_sync
        import app.org_settings as org_settings
        import app.memberships as memberships

        patched = [
            orders, products, cashbook, ledger, auth_routes, users, admin_portal,
            shopify_sync, org_settings, memberships, main,
        ]
        originals = [m.get_supabase for m in patched]
        for m in patched:
            m.get_supabase = lambda _f=fake: _f
        created.append((patched, originals))
        return TestClient(main.app)

    yield _factory

    for patched, originals in created:
        for m, original in zip(patched, originals):
            m.get_supabase = original
    main.app.dependency_overrides.clear()


@pytest.fixture
def order_row():
    return {
        "id": "11111111-1111-1111-1111-111111111111",
        "order_number": 11308,
        "courier": "PostEx",
        "tracking_number": "12345678901234",
        "folio": None,
        "order_status": "delivered",
        "piece_received": "Pending",
        "delivery_status": None,
        "total_amount": 2598.0,
        "advance_amount": 0.0,
        "delivery_charge": 180.0,
        "tax_amount": 0.0,
        "cost_price": 650.0,
        "order_receiving_date": "2026-07-18T13:23:08+00:00",
        "items": None,
        "line_items": None,
        "advance_status": 1,
        "replacement_of_order_no": None,
        "created_at": "2026-07-18T13:23:08+00:00",
        "updated_at": "2026-07-18T13:23:08+00:00",
    }


@pytest.fixture
def ledger_row():
    return {
        "id": "22222222-2222-2222-2222-222222222222",
        "name": "Lushwear MZB",
        "type": "Asset",
        "created_at": "2026-02-13T13:05:03+00:00",
        "updated_at": "2026-02-13T13:05:03+00:00",
    }
