"""Route smoke tests: request/response wiring, status codes, and response_model shaping.

Supabase is faked (see conftest), so these never touch the network or the real DB.
"""


class TestHealthAndAuth:
    def test_health_is_open(self, make_client):
        r = make_client().get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "healthy"}

    def test_protected_routes_require_a_token(self, make_client):
        import app.main as main
        from app.auth import require_auth

        client = make_client()
        main.app.dependency_overrides.pop(require_auth, None)  # restore the real gate
        assert client.get("/api/orders/?month=6&year=2026").status_code == 401


class TestOrders:
    def test_list_returns_rows(self, make_client, order_row):
        r = make_client({"orders": [order_row]}).get("/api/orders/?month=6&year=2026")
        assert r.status_code == 200
        assert [o["order_number"] for o in r.json()] == ["11308"]

    def test_empty_table_returns_empty_list(self, make_client):
        r = make_client({"orders": []}).get("/api/orders/?month=6&year=2026")
        assert r.status_code == 200
        assert r.json() == []

    def test_response_is_shaped_by_the_order_model(self, make_client, order_row):
        noisy = {**order_row, "internal_debug_column": "should not be exposed"}
        body = make_client({"orders": [noisy]}).get("/api/orders/?month=6&year=2026").json()[0]
        assert "internal_debug_column" not in body
        assert body["total_amount"] == 2598.0

    def test_period_is_required(self, make_client, order_row):
        client = make_client({"orders": [order_row]})
        assert client.get("/api/orders/").status_code == 422
        assert client.get("/api/orders/?month=6").status_code == 422
        assert client.get("/api/orders/?year=2026").status_code == 422

    def test_month_query_is_validated(self, make_client, order_row):
        client = make_client({"orders": [order_row]})
        assert client.get("/api/orders/?month=13&year=2026").status_code == 422
        assert client.get("/api/orders/?month=6&year=2026").status_code == 200


class TestLedgers:
    def test_list(self, make_client, ledger_row):
        r = make_client({"ledgers": [ledger_row]}).get("/api/ledgers/")
        assert r.status_code == 200
        assert r.json()[0]["name"] == "Lushwear MZB"

    def test_missing_ledger_is_404(self, make_client):
        r = make_client({"ledgers": []}).get("/api/ledgers/does-not-exist")
        assert r.status_code == 404

    def test_create_rejects_blank_name(self, make_client):
        r = make_client({"ledgers": []}).post("/api/ledgers/", json={"name": "  ", "type": "Bank"})
        assert r.status_code == 422

    def test_delete_blocked_while_cashbook_entries_reference_it(self, make_client, ledger_row):
        client = make_client({
            "ledgers": [ledger_row],
            "cashbook_entries": [{"id": "entry-1"}],
        })
        r = client.delete(f"/api/ledgers/{ledger_row['id']}")
        assert r.status_code == 400
        assert "cashbook entries" in r.json()["detail"]


class TestProducts:
    def test_list_groups_variants_via_the_embed_not_in_python(self, make_client):
        # Shaped like a real PostgREST `select=*, variants(*)` response: variants
        # already nested under their product, not two flat tables to zip together.
        def variant(vid, product_id, title, quantity):
            return {"id": vid, "product_id": product_id, "title": title, "quantity": quantity}

        products = [
            {"id": "p2", "name": "banana", "variants": [variant("v3", "p2", "M", 3)]},
            {"id": "p1", "name": "Apple", "variants": [
                variant("v1", "p1", "L", 2), variant("v2", "p1", "M", 5),
            ]},
        ]
        r = make_client({"products": products}).get("/api/products/")
        assert r.status_code == 200
        body = r.json()
        assert [p["name"] for p in body] == ["Apple", "banana"]
        assert [v["title"] for v in body[0]["variants"]] == ["L", "M"]
        assert body[0]["total_quantity"] == 7
        assert body[1]["total_quantity"] == 3

    def test_batch_update_cost_prices_is_a_single_batched_upsert(self, make_client):
        client = make_client({"products": [
            {"id": "p1", "cost_price": 100.0},
            {"id": "p2", "cost_price": 200.0},
        ]})
        r = client.put("/api/products/batch-update-cost-prices", json={
            "updates": [
                {"id": "p1", "cost_price": 150.0},
                {"id": "p2", "cost_price": 250.0},
            ]
        })
        assert r.status_code == 200
        assert r.json()["updated_count"] == 2

    def test_batch_update_with_no_updates_is_a_no_op(self, make_client):
        r = make_client({"products": []}).put(
            "/api/products/batch-update-cost-prices", json={"updates": []}
        )
        assert r.status_code == 200
        assert r.json()["updated_count"] == 0


class TestCashbook:
    def test_create_rejects_non_positive_amount(self, make_client):
        client = make_client({"cashbook_entries": []})
        payload = {"entry_date": "2026-07-18", "entry_type": "inflow", "amount": 0, "folio": "abc"}
        assert client.post("/api/cashbook/entries", json=payload).status_code == 422

    def test_create_rejects_unknown_entry_type(self, make_client):
        client = make_client({"cashbook_entries": []})
        payload = {"entry_date": "2026-07-18", "entry_type": "transfer", "amount": 10, "folio": "abc"}
        assert client.post("/api/cashbook/entries", json=payload).status_code == 422

    def test_entry_type_casing_is_normalised(self, make_client):
        # Clients that historically sent "INFLOW" must keep working.
        client = make_client({"cashbook_entries": []})
        payload = {"entry_date": "2026-07-18", "entry_type": "INFLOW", "amount": 10, "folio": "abc"}
        assert client.post("/api/cashbook/entries", json=payload).status_code != 422

    def test_update_of_missing_entry_is_404(self, make_client):
        client = make_client({"cashbook_entries": []})
        r = client.put("/api/cashbook/entries/nope", json={"description": "x"})
        assert r.status_code == 404


class TestErrorHandling:
    def test_unhandled_errors_return_a_generic_500(self, make_client, monkeypatch):
        """An unexpected failure must not leak the exception text to the client."""
        import app.main as main
        import app.routes.ledger as ledger
        from fastapi.testclient import TestClient

        make_client({"ledgers": []})  # installs the auth override

        def boom():
            raise RuntimeError("connection string with a secret in it")

        monkeypatch.setattr(ledger, "get_supabase", boom)
        # raise_server_exceptions=False lets the app's handler build the response
        # instead of TestClient re-raising, which is what a real client would see.
        client = TestClient(main.app, raise_server_exceptions=False)
        r = client.get("/api/ledgers/")
        assert r.status_code == 500
        assert r.json() == {"detail": "Internal server error"}
        assert "secret" not in r.text
