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

    def test_ready_checks_supabase_connectivity(self, make_client):
        r = make_client({"system_organizations": [{"id": "org1"}]}).get("/ready")
        assert r.status_code == 200
        assert r.json() == {"status": "ready"}

    def test_ready_is_503_when_supabase_is_unreachable(self, make_client, monkeypatch):
        import app.main as main

        class _BrokenSupabase:
            def table(self, name):
                raise RuntimeError("connection refused")

        client = make_client()
        monkeypatch.setattr(main, "get_supabase", lambda: _BrokenSupabase())
        r = client.get("/ready")
        assert r.status_code == 503

    def test_responses_carry_a_request_id_header(self, make_client):
        r = make_client().get("/health")
        assert r.headers.get("X-Request-Id")

    def test_client_supplied_request_id_is_echoed_back(self, make_client):
        r = make_client().get("/health", headers={"X-Request-Id": "abc-123"})
        assert r.headers.get("X-Request-Id") == "abc-123"


class TestRateLimiting:
    """The autouse _reset_rate_limiter fixture (conftest.py) clears the limiter's
    in-memory counters before/after every test, so this doesn't leak into or get
    tripped by unrelated tests hitting the same endpoints."""

    def test_expensive_pdf_endpoint_has_its_own_stricter_limit(self, make_client):
        client = make_client({})
        for _ in range(10):
            r = client.post("/api/orders/generate-invoice", json=[])
            assert r.status_code == 400  # "No orders selected" - still counts against the limit
        r = client.post("/api/orders/generate-invoice", json=[])
        assert r.status_code == 429

    def test_ordinary_endpoint_is_not_affected_by_the_pdf_endpoints_limit(self, make_client):
        client = make_client({})
        for _ in range(10):
            client.post("/api/orders/generate-invoice", json=[])
        # generate-invoice is now locked out, but an undecorated route (its own,
        # much more generous default limit) must be unaffected.
        r = client.get("/health")
        assert r.status_code == 200


class TestOrders:
    def test_list_returns_rows(self, make_client, order_row):
        r = make_client({"shopify_orders": [order_row]}).get("/api/orders/?month=6&year=2026")
        assert r.status_code == 200
        assert [o["order_number"] for o in r.json()] == [11308]

    def test_empty_table_returns_empty_list(self, make_client):
        r = make_client({"shopify_orders": []}).get("/api/orders/?month=6&year=2026")
        assert r.status_code == 200
        assert r.json() == []

    def test_response_is_shaped_by_the_order_model(self, make_client, order_row):
        noisy = {**order_row, "internal_debug_column": "should not be exposed"}
        body = make_client({"shopify_orders": [noisy]}).get("/api/orders/?month=6&year=2026").json()[0]
        assert "internal_debug_column" not in body
        assert body["total_amount"] == 2598.0

    def test_period_is_optional_and_falls_back_to_recent_orders(self, make_client, order_row):
        client = make_client({"shopify_orders": [order_row]})
        for r in (client.get("/api/orders/"), client.get("/api/orders/?month=6"), client.get("/api/orders/?year=2026")):
            assert r.status_code == 200
            assert [o["order_number"] for o in r.json()] == [11308]

    def test_month_query_is_validated(self, make_client, order_row):
        client = make_client({"shopify_orders": [order_row]})
        assert client.get("/api/orders/?month=13&year=2026").status_code == 422
        assert client.get("/api/orders/?month=6&year=2026").status_code == 200

    def test_create_order_returns_the_typed_order(self, make_client, order_row):
        # FakeQuery.insert().execute() just echoes the seeded row for the table,
        # not the request payload - order_row (conftest.py) is a full Order shape.
        client = make_client({"shopify_orders": [order_row]})
        payload = {
            "order_number": 123,
            "courier": "PostEx",
            "order_status": "unfulfilled",
            "total_amount": 100.0,
            "order_receiving_date": "2026-07-30T00:00:00+00:00",
        }
        r = client.post("/api/orders/", json=payload)
        assert r.status_code == 200
        assert r.json()["id"] == order_row["id"]

    def test_sync_shopify_orders_returns_the_typed_result(self, make_client, monkeypatch):
        import app.routes.orders as orders_module

        async def fake_sync(org_id):
            return {
                "message": "Orders synced successfully",
                "last_synced_at": "2026-07-30T12:00:00+00:00",
                "synced": 2, "created": 1, "updated": 1, "skipped": 5,
                "pages_fetched": 1, "total_orders_from_shopify": 8, "orders_per_page": 250,
            }

        monkeypatch.setattr(orders_module, "_sync_shopify_orders", fake_sync)
        r = make_client({}).post("/api/orders/sync-shopify")
        assert r.status_code == 200
        assert r.json()["synced"] == 2

    def test_sync_shopify_orders_already_syncing_shape(self, make_client, monkeypatch):
        """The "already syncing" short-circuit is a different shape (no stats
        fields at all) - the response_model must accept both."""
        import app.routes.orders as orders_module

        async def fake_sync(org_id):
            return {"message": "Sync already in progress", "already_syncing": True}

        monkeypatch.setattr(orders_module, "_sync_shopify_orders", fake_sync)
        r = make_client({}).post("/api/orders/sync-shopify")
        assert r.status_code == 200
        assert r.json()["already_syncing"] is True

    def test_sync_shopify_orders_force_returns_the_typed_shape(self, make_client, monkeypatch):
        import app.routes.orders as orders_module

        async def fake_fetch(order_number, org_creds):
            return None  # simulates "not found in Shopify" - simplest path through the endpoint

        monkeypatch.setattr(orders_module, "_fetch_shopify_order_by_order_number", fake_fetch)
        client = make_client({"shopify_products": [], "shopify_variants": [], "shopify_orders": []})
        r = client.post("/api/orders/sync-shopify-force", json={"order_numbers": [100]})
        assert r.status_code == 200
        body = r.json()
        assert body["shopify_fetch_failed_count"] == 1
        assert body["shopify_fetch_failed_order_numbers"] == [100]

    def test_create_load_sheet_log_returns_the_typed_shape(self, make_client):
        seeded_log = {
            "id": "log-1",
            "assignment_number": "A100",
            "rider_name": "Rider A",
            "order_numbers": ["100", "101"],
            "delivery_charge": 180.0,
            "created_at": "2026-07-30T12:00:00+00:00",
        }
        client = make_client({
            "shopify_orders": [
                {"order_number": "100", "order_status": "unfulfilled"},
                {"order_number": "101", "order_status": "unfulfilled"},
            ],
            "shopify_load_sheet_logs": [seeded_log],
        })
        payload = {
            "assignment_number": "A100",
            "rider_name": "Rider A",
            "order_numbers": ["100", "101"],
            "delivery_charge": 180.0,
        }
        r = client.post("/api/orders/load-sheet-logs", json=payload)
        assert r.status_code == 200
        assert r.json()["id"] == "log-1"


class TestMonthSummaryList:
    def test_returns_periods_from_the_rpc_as_is(self, make_client):
        client = make_client({}, rpc_results={
            "get_month_summary_periods": [
                {"month": 7, "year": 2026, "warning_orders_count": 3},
                {"month": 6, "year": 2026, "warning_orders_count": 0},
            ],
        })
        r = client.get("/api/orders/month-summary/list")
        assert r.status_code == 200
        assert r.json() == [
            {"month": 7, "year": 2026, "warning_orders_count": 3},
            {"month": 6, "year": 2026, "warning_orders_count": 0},
        ]

    def test_no_orders_returns_empty_list(self, make_client):
        client = make_client({}, rpc_results={"get_month_summary_periods": []})
        r = client.get("/api/orders/month-summary/list")
        assert r.status_code == 200
        assert r.json() == []


class TestMonthSummaryDetail:
    def test_combines_rpc_totals_with_python_side_collection_breakdown(self, make_client):
        totals_row = {
            "total_orders": 3,
            "total_gross_sale": 1500.5,
            "total_return_amount": 100.0,
            "return_orders_count": 1,
            "delivered_orders_count": 1,
            "enroute_orders_count": 1,
            "unfulfilled_orders_count": 0,
            "cancelled_orders_count": 1,
            "net_sales": 1400.5,
            "cost_of_goods_sold": 300.0,
            "tax_total": 20.0,
            "gross_profit": 900.25,
            "dc_charges_delivered": 180.0,
            "dc_charges_returned": 180.0,
            "dc_charges_total": 360.0,
        }
        client = make_client(
            {
                "shopify_orders": [
                    {"order_status": "delivered", "line_items": [{"name": "Silk Robe", "qty": 2, "product_id": None}]},
                    {"order_status": "cancelled", "line_items": [{"name": "Silk Robe", "qty": 5, "product_id": None}]},
                ],
                "shopify_products": [{"id": "p1", "name": "Silk Robe", "collection": "Silk Collection", "price": 100.0}],
            },
            rpc_results={
                "get_month_summary_totals": [totals_row],
                "get_month_summary_expense_lines": [{"ledger_name": "Rent", "amount": 10.0}],
            },
        )
        r = client.get("/api/orders/month-summary/6/2026")
        assert r.status_code == 200
        body = r.json()

        # Totals come straight from the RPC row, not recomputed in Python.
        assert body["total_orders"] == 3
        assert body["gross_profit"] == 900.25
        assert body["cancelled_orders_count"] == 1
        assert body["expense_lines"] == [{"name": "Rent", "amount": 10.0}]

        # Net Profit is Gross Profit minus the summed expense lines - not an
        # RPC column of its own.
        assert body["total_expenses"] == 10.0
        assert body["net_profit"] == 890.25

        # Collection breakdown is still computed in Python from the fetched
        # line_items - the cancelled order's 5 qty must not count.
        silk = next(c for c in body["products_sold_by_collection"] if c["collection"] == "Silk Collection")
        assert silk["count"] == 2
        assert silk["sum"] == 200.0
        assert silk["products"] == [{"name": "Silk Robe", "count": 2, "sum": 200.0}]

    def test_invalid_month_is_rejected(self, make_client):
        client = make_client({"shopify_orders": [], "shopify_products": []})
        r = client.get("/api/orders/month-summary/13/2026")
        assert r.status_code == 400


class TestGenerateInvoice:
    def test_fetches_shopify_data_concurrently_and_pairs_orders_correctly(self, make_client, monkeypatch):
        """Regression guard for the sequential-to-concurrent fetch rewrite: each
        DB order must still end up paired with its own Shopify order, not a
        neighbor's (an easy mistake to introduce when zipping gathered results)."""
        import io
        import app.routes.orders as orders_module

        seen_numbers = []

        async def fake_fetch(num, org_creds):
            seen_numbers.append(num)
            return {"shopify_number": num}

        captured = {}

        def fake_build_context(order, sp_order):
            return {"db_id": order["id"], "shopify_number": sp_order["shopify_number"] if sp_order else None}

        def fake_generate_pdf(merged):
            captured["merged"] = merged
            return io.BytesIO(b"%PDF-fake")

        monkeypatch.setattr(orders_module, "_fetch_shopify_order_by_order_number", fake_fetch)
        monkeypatch.setattr(orders_module, "_build_invoice_order_context", fake_build_context)
        monkeypatch.setattr(orders_module, "_generate_pdf_invoice", fake_generate_pdf)

        client = make_client({"shopify_orders": [
            {"id": "o1", "order_number": 100},
            {"id": "o2", "order_number": 200},
        ]})
        r = client.post("/api/orders/generate-invoice", json=["o1", "o2"])

        assert r.status_code == 200
        assert set(seen_numbers) == {"100", "200"}
        assert captured["merged"] == [
            {"db_id": "o1", "shopify_number": "100"},
            {"db_id": "o2", "shopify_number": "200"},
        ]


class TestPdfBatchCaps:
    """MAX_PDF_BATCH_ORDERS is checked before any DB/PDF work, so an
    over-the-cap request 400s even against an empty fake Supabase."""

    def test_generate_invoice_rejects_a_batch_over_the_cap(self, make_client):
        from app.routes.orders import MAX_PDF_BATCH_ORDERS
        client = make_client({})
        order_ids = [f"id-{i}" for i in range(MAX_PDF_BATCH_ORDERS + 1)]
        r = client.post("/api/orders/generate-invoice", json=order_ids)
        assert r.status_code == 400

    def test_generate_packaging_list_rejects_a_batch_over_the_cap(self, make_client):
        from app.routes.orders import MAX_PDF_BATCH_ORDERS
        client = make_client({})
        order_ids = [f"id-{i}" for i in range(MAX_PDF_BATCH_ORDERS + 1)]
        r = client.post("/api/orders/generate-packaging-list", json=order_ids)
        assert r.status_code == 400

    def test_generate_packaging_list_by_numbers_rejects_a_batch_over_the_cap(self, make_client):
        from app.routes.orders import MAX_PDF_BATCH_ORDERS
        client = make_client({})
        order_numbers = list(range(MAX_PDF_BATCH_ORDERS + 1))
        r = client.post("/api/orders/generate-packaging-list-by-numbers", json={"order_numbers": order_numbers})
        assert r.status_code == 400

    def test_generate_load_sheet_rejects_a_batch_over_the_cap(self, make_client):
        from app.routes.orders import MAX_PDF_BATCH_ORDERS
        client = make_client({})
        order_ids = [f"id-{i}" for i in range(MAX_PDF_BATCH_ORDERS + 1)]
        r = client.post("/api/orders/generate-load-sheet", json=order_ids)
        assert r.status_code == 400


class TestPostexAirwayBillsRoute:
    """Request-validation branches only - the org_creds -> PostEx round trip is covered
    at the service layer (test_postex.py::TestGetAirwayBill), same precedent as
    fulfill_orders's own PostEx/Couriers Next calls, which aren't exercised at the route
    level either."""

    def test_no_orders_selected_is_rejected(self, make_client):
        client = make_client({})
        r = client.post("/api/orders/postex-airway-bills", json=[])
        assert r.status_code == 400

    def test_a_batch_over_postexs_own_cap_is_rejected(self, make_client):
        from app.services.postex import MAX_AIRWAY_BILL_TRACKING_NUMBERS
        client = make_client({})
        order_ids = [f"id-{i}" for i in range(MAX_AIRWAY_BILL_TRACKING_NUMBERS + 1)]
        r = client.post("/api/orders/postex-airway-bills", json=order_ids)
        assert r.status_code == 400

    def test_a_selection_with_no_booked_postex_orders_is_rejected(self, make_client):
        client = make_client({"shopify_orders": [
            {"id": "o1", "order_number": 100, "courier": "Couriers Next", "tracking_number": "CN1"},
            {"id": "o2", "order_number": 200, "courier": "PostEx", "tracking_number": None},
        ]})
        r = client.post("/api/orders/postex-airway-bills", json=["o1", "o2"])
        assert r.status_code == 400


class TestCouriersNextAirwayBillsRoute:
    """Same precedent as TestPostexAirwayBillsRoute - request-validation branches only;
    the org_creds -> GetOrderList.php round trip is covered at the service layer
    (test_couriers_next.py::TestGetAirwayBillLink)."""

    def test_no_orders_selected_is_rejected(self, make_client):
        client = make_client({})
        r = client.post("/api/orders/couriers-next-airway-bills", json=[])
        assert r.status_code == 400

    def test_a_selection_with_no_booked_couriers_next_orders_is_rejected(self, make_client):
        client = make_client({"shopify_orders": [
            {"id": "o1", "order_number": 100, "courier": "PostEx", "tracking_number": "PX1"},
            {"id": "o2", "order_number": 200, "courier": "Couriers Next", "tracking_number": None},
        ]})
        r = client.post("/api/orders/couriers-next-airway-bills", json=["o1", "o2"])
        assert r.status_code == 400


class TestOrderDetailString:
    """The airway-bill contents line built for courier bookings (fulfill_orders)."""

    def _fn(self):
        from app.routes.orders import _order_detail_string
        return _order_detail_string

    def test_formats_qty_name_and_size_in_brackets(self):
        assert self._fn()([
            {"name": "Ruby Camisole Set", "variant_title": "L", "qty": 1},
        ]) == "[ 1 x Ruby Camisole Set L ]"

    def test_drops_the_size_when_the_product_has_no_variants(self):
        assert self._fn()([
            {"name": "Cotton Eye Mask", "variant_title": "-", "qty": 2},
        ]) == "[ 2 x Cotton Eye Mask ]"

    def test_joins_multiple_lines_with_a_space(self):
        assert self._fn()([
            {"name": "Ruby Camisole Set", "variant_title": "L", "qty": 1},
            {"name": "Silk Robe", "variant_title": "M", "qty": 2},
        ]) == "[ 1 x Ruby Camisole Set L ] [ 2 x Silk Robe M ]"

    def test_empty_line_items_is_none(self):
        assert self._fn()([]) is None


class TestGeneratePackagingList:
    """The PDF groups items by each product's shopify_products.collection - see
    test_packaging_list.py for the aggregation/grouping unit tests."""

    def test_looks_up_collections_from_shopify_products(self, make_client):
        client = make_client({
            "shopify_orders": [
                {"id": "o1", "order_number": 1, "order_status": "unfulfilled", "line_items": [
                    {"name": "Cami Robe", "variant_title": "M", "qty": 1, "product_id": "p1"},
                ]},
            ],
            "shopify_products": [{"id": "p1", "name": "Cami Robe", "collection": "Cami Sets"}],
        })
        r = client.post("/api/orders/generate-packaging-list", json=["o1"])
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/pdf"
        assert r.content.startswith(b"%PDF")


class TestPostexCsvUpload:
    def _csv(self, *rows):
        header = b"ORDER_REF_NUMBER,SHIPPING_CHARGES\n"
        body = b"".join(f"{num},{charge}\n".encode() for num, charge in rows)
        return header + body

    def test_matches_updates_and_skips_cancelled_and_unmatched_orders(self, make_client):
        client = make_client({"shopify_orders": [
            {"id": "o1", "order_number": 100, "total_amount": 1000.0, "advance_amount": 0.0,
             "order_status": "unfulfilled", "order_receiving_date": "2026-07-18T13:23:08+00:00"},
            {"id": "o2", "order_number": 101, "total_amount": 500.0, "advance_amount": 0.0,
             "order_status": "cancelled", "order_receiving_date": "2026-07-18T13:23:08+00:00"},
        ]})
        csv_bytes = self._csv((100, 200), (101, 150), (999, 50))
        r = client.post(
            "/api/orders/upload-postex-csv",
            files={"file": ("postex.csv", csv_bytes, "text/csv")},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["updated"] == 1
        assert body["matched_order_numbers"] == ["100"]
        assert body["updated_order_ids"] == ["o1"]
        assert body["cancelled_order_numbers"] == ["101"]
        assert body["unmatched_count"] == 1
        assert "999" in body["message"]

    def test_upsert_carries_the_columns_postgres_null_checks(self, make_client):
        """The write is an upsert (INSERT ... ON CONFLICT), and Postgres checks NOT NULL
        on the proposed row before resolving the conflict - so a payload of just the
        changed columns is rejected outright, even though the row always exists."""
        import app.routes.orders as orders_module

        client = make_client({"shopify_orders": [
            {"id": "o1", "order_number": 100, "total_amount": 1000.0, "advance_amount": 0.0,
             "order_status": "unfulfilled", "order_receiving_date": "2026-07-18T13:23:08+00:00"},
        ]})
        client.post(
            "/api/orders/upload-postex-csv",
            files={"file": ("postex.csv", self._csv((100, 200)), "text/csv")},
        )

        written = orders_module.get_supabase().upserted["shopify_orders"]
        assert len(written) == 1
        assert written[0]["order_number"] == 100
        assert written[0]["order_status"] == "unfulfilled"
        assert written[0]["total_amount"] == 1000.0
        assert written[0]["order_receiving_date"] == "2026-07-18T13:23:08+00:00"
        assert written[0]["courier"] == "PostEx"
        assert written[0]["is_order_settled"] is True

    def test_non_csv_file_is_rejected(self, make_client):
        client = make_client({"shopify_orders": []})
        r = client.post(
            "/api/orders/upload-postex-csv",
            files={"file": ("postex.txt", b"not a csv", "text/plain")},
        )
        assert r.status_code == 400

    def test_replacement_order_refs_stay_out_of_the_integer_filter(self, make_client):
        """order_number is an INTEGER column, so the "4446-R" forms
        normalize_order_number emits cannot go into the .in_() filter - Postgres would
        reject the whole query. They are dropped from it and reported unmatched."""
        import app.routes.orders as orders_module

        client = make_client({"shopify_orders": [
            {"id": "o1", "order_number": 100, "total_amount": 1000.0, "advance_amount": 0.0,
             "order_status": "unfulfilled", "order_receiving_date": "2026-07-18T13:23:08+00:00"},
        ]})
        # The fake query builder accepts any filter, so pin the argument on the real
        # class the fixture built rather than trusting the chain to reject bad types.
        fake_query_cls = type(orders_module.get_supabase().table("shopify_orders"))
        captured = []
        fake_query_cls.in_ = lambda self, column, values: (
            captured.append((column, values)), self)[1]
        try:
            csv_bytes = b"ORDER_REF_NUMBER,SHIPPING_CHARGES\n100,200\n4446-R,150\n"
            r = client.post(
                "/api/orders/upload-postex-csv",
                files={"file": ("postex.csv", csv_bytes, "text/csv")},
            )
        finally:
            del fake_query_cls.in_

        assert r.status_code == 200
        assert ("order_number", [100]) in captured
        body = r.json()
        assert body["matched_order_numbers"] == ["100"]
        assert "4446-R" in body["message"]

    def test_settlement_push_is_queued_as_a_background_task(self, make_client):
        """Mirroring settlements into Shopify is hundreds of round trips, so it must be
        handed to BackgroundTasks rather than awaited inline - otherwise the upload
        response waits on the whole push. Both run before TestClient returns, so this
        asserts the registration itself, which is what actually frees the response."""
        from starlette.background import BackgroundTasks
        import app.routes.orders as orders_module

        queued = []
        real_add_task = BackgroundTasks.add_task

        def _spy_add_task(self, func, *args, **kwargs):
            queued.append((getattr(func, "__name__", None), args))
            return real_add_task(self, func, *args, **kwargs)

        pushed = []
        real_push = orders_module._push_settlements_to_shopify

        async def _fake_push(order_numbers, org_id):
            pushed.append(list(order_numbers))

        BackgroundTasks.add_task = _spy_add_task
        orders_module._push_settlements_to_shopify = _fake_push
        client = make_client({"shopify_orders": [
            {"id": "o1", "order_number": 100, "total_amount": 1000.0, "advance_amount": 0.0,
             "order_status": "unfulfilled", "order_receiving_date": "2026-07-18T13:23:08+00:00"},
        ]})
        try:
            r = client.post(
                "/api/orders/upload-postex-csv",
                files={"file": ("postex.csv", self._csv((100, 200)), "text/csv")},
            )
        finally:
            BackgroundTasks.add_task = real_add_task
            orders_module._push_settlements_to_shopify = real_push

        assert r.status_code == 200
        assert queued == [("_fake_push", (["100"], "test-org"))]
        assert pushed == [["100"]]

    def test_all_non_numeric_refs_short_circuit(self, make_client):
        client = make_client({"shopify_orders": []})
        r = client.post(
            "/api/orders/upload-postex-csv",
            files={"file": ("postex.csv", b"ORDER_REF_NUMBER,SHIPPING_CHARGES\n4446-R,150\n", "text/csv")},
        )
        assert r.status_code == 200
        assert r.json()["updated"] == 0


class TestLedgers:
    def test_list(self, make_client, ledger_row):
        r = make_client({"finances_ledgers": [ledger_row]}).get("/api/ledgers/")
        assert r.status_code == 200
        assert r.json()[0]["name"] == "Lushwear MZB"

    def test_missing_ledger_is_404(self, make_client):
        r = make_client({"finances_ledgers": []}).get("/api/ledgers/does-not-exist")
        assert r.status_code == 404

    def test_create_rejects_blank_name(self, make_client):
        r = make_client({"finances_ledgers": []}).post("/api/ledgers/", json={"name": "  ", "type": "Asset"})
        assert r.status_code == 422

    def test_delete_blocked_while_entries_are_posted_against_it(self, make_client, ledger_row):
        """Checked against journal_lines rather than transaction_entries: since
        Phase 1 an account can also be posted to by a bill or a manual journal
        entry, and those would otherwise only be caught by the ON DELETE RESTRICT
        foreign key, surfacing as a raw database error."""
        client = make_client({
            "finances_ledgers": [ledger_row],
            "finances_journal_lines": [{"id": "jl-1", "account_id": ledger_row["id"]}],
        })
        r = client.delete(f"/api/ledgers/{ledger_row['id']}")
        assert r.status_code == 400
        assert "entries posted against it" in r.json()["detail"]

    def test_delete_returns_the_typed_result(self, make_client, ledger_row):
        client = make_client({"finances_ledgers": [ledger_row], "finances_journal_lines": []})
        r = client.delete(f"/api/ledgers/{ledger_row['id']}")
        assert r.status_code == 200
        assert r.json() == {"status": "deleted", "id": ledger_row["id"]}


class TestProducts:
    def test_create_returns_the_typed_shape(self, make_client):
        # FakeQuery.insert().execute() just echoes the seeded row for the table,
        # not the request payload.
        client = make_client({"shopify_products": [{"id": "p1", "name": "Test Product", "price": 10.0}]})
        r = client.post("/api/products/", json={"name": "Test Product", "price": 10.0})
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == "p1"
        assert body["variants"] == []
        assert body["total_quantity"] == 0

    def test_list_groups_variants_via_the_embed_not_in_python(self, make_client):
        # Shaped like a real PostgREST `select=*, shopify_variants(*)` response:
        # variants already nested under their product, not two flat tables to
        # zip together.
        def variant(vid, product_id, title, quantity):
            return {"id": vid, "product_id": product_id, "title": title, "quantity": quantity}

        products = [
            {"id": "p2", "name": "banana", "shopify_variants": [variant("v3", "p2", "M", 3)]},
            {"id": "p1", "name": "Apple", "shopify_variants": [
                variant("v1", "p1", "L", 2), variant("v2", "p1", "M", 5),
            ]},
        ]
        r = make_client({"shopify_products": products}).get("/api/products/")
        assert r.status_code == 200
        body = r.json()
        assert [p["name"] for p in body] == ["Apple", "banana"]
        assert [v["title"] for v in body[0]["variants"]] == ["L", "M"]
        assert body[0]["total_quantity"] == 7
        assert body[1]["total_quantity"] == 3

    def test_batch_update_cost_prices_is_a_single_batched_upsert(self, make_client):
        import app.routes.products as products_module

        client = make_client({"shopify_products": [
            {"id": "p1", "name": "Apple", "cost_price": 100.0},
            {"id": "p2", "name": "banana", "cost_price": 200.0},
        ]})
        r = client.put("/api/products/batch-update-cost-prices", json={
            "updates": [
                {"id": "p1", "cost_price": 150.0},
                {"id": "p2", "cost_price": 250.0},
            ]
        })
        assert r.status_code == 200
        assert r.json()["updated_count"] == 2
        # name is NOT NULL without a default, and an upsert is INSERT ... ON CONFLICT -
        # Postgres null-checks the proposed row before it resolves the conflict.
        written = products_module.get_supabase().upserted["shopify_products"]
        assert [(p["id"], p["name"], p["cost_price"]) for p in written] == [
            ("p1", "Apple", 150.0), ("p2", "banana", 250.0),
        ]

    def test_batch_update_with_no_updates_is_a_no_op(self, make_client):
        r = make_client({"shopify_products": []}).put(
            "/api/products/batch-update-cost-prices", json={"updates": []}
        )
        assert r.status_code == 200
        assert r.json()["updated_count"] == 0


class TestTransactions:
    """An entry names both of its sides; a None side means cash. Only entries
    with a cash side move the cash balance, which is what keeps a bank-pays-
    supplier transfer out of Cash in Hand."""

    def test_create_rejects_non_positive_amount(self, make_client):
        client = make_client({"finances_transaction_entries": []})
        payload = {"entry_date": "2026-07-18", "amount": 0, "from_account_id": "abc"}
        assert client.post("/api/transactions/entries", json=payload).status_code == 422

    def test_create_rejects_an_entry_with_neither_side(self, make_client):
        """Both sides cash moves nothing."""
        client = make_client({"finances_transaction_entries": []})
        payload = {"entry_date": "2026-07-18", "amount": 10}
        r = client.post("/api/transactions/entries", json=payload)
        assert r.status_code == 422
        assert "From or a To account" in r.text

    def test_create_rejects_the_same_account_on_both_sides(self, make_client):
        client = make_client({"finances_transaction_entries": []})
        payload = {
            "entry_date": "2026-07-18", "amount": 10,
            "from_account_id": "abc", "to_account_id": "abc",
        }
        r = client.post("/api/transactions/entries", json=payload)
        assert r.status_code == 422
        assert "cannot be the same account" in r.text

    def test_one_sided_entry_is_accepted(self, make_client):
        """The omitted side is cash — this is the ordinary transaction line."""
        client = make_client({"finances_transaction_entries": []})
        payload = {"entry_date": "2026-07-18", "amount": 10, "from_account_id": "abc"}
        assert client.post("/api/transactions/entries", json=payload).status_code != 422

    def test_two_sided_entry_is_accepted(self, make_client):
        """Bank pays supplier: both sides named, so cash is untouched."""
        client = make_client({"finances_transaction_entries": []})
        payload = {
            "entry_date": "2026-07-18", "amount": 10,
            "from_account_id": "bank", "to_account_id": "supplier",
        }
        assert client.post("/api/transactions/entries", json=payload).status_code != 422

    def test_update_setting_a_side_to_match_the_other_is_a_400(self, make_client):
        """A partial update only carries the side being changed, so the rule has
        to be checked against the merged result — otherwise it reaches the
        database and comes back as a constraint violation, i.e. a 500."""
        client = make_client({
            "finances_transaction_entries": [{
                "order_number": None,
                "from_account_id": None,
                "to_account_id": "ledger-1",
            }],
        })
        r = client.put("/api/transactions/entries/entry-1", json={"from_account_id": "ledger-1"})

        assert r.status_code == 400
        assert "cannot be the same account" in r.json()["detail"]

    def test_update_clearing_the_only_side_is_a_400(self, make_client):
        client = make_client({
            "finances_transaction_entries": [{
                "order_number": None,
                "from_account_id": None,
                "to_account_id": "ledger-1",
            }],
        })
        r = client.put("/api/transactions/entries/entry-1", json={"to_account_id": None})

        assert r.status_code == 400
        assert "From or a To account" in r.json()["detail"]

    def test_update_moving_a_side_to_another_account_is_allowed(self, make_client):
        # A full row: the update echoes it back through the TransactionEntry model.
        client = make_client({
            "finances_transaction_entries": [{
                "id": "entry-1",
                "entry_date": "2026-08-01",
                "amount": 20000.0,
                "description": "Transfer",
                "order_number": None,
                "from_account_id": None,
                "to_account_id": "ledger-1",
            }],
        })
        r = client.put("/api/transactions/entries/entry-1", json={"to_account_id": "ledger-2"})

        assert r.status_code == 200, r.text

    def test_update_of_missing_entry_is_404(self, make_client):
        client = make_client({"finances_transaction_entries": []})
        r = client.put("/api/transactions/entries/nope", json={"description": "x"})
        assert r.status_code == 404

    def test_delete_refreshes_both_sides_balances(self, make_client):
        """Both named accounts need refreshing, not just one — deleting an entry
        moves whichever ledgers it touched."""
        client = make_client({
            "finances_transaction_entries": [{
                "order_number": None,
                "from_account_id": "ledger-1",
                "to_account_id": None,
            }],
            "finances_ledger_balances": [{"ledger_id": "ledger-1", "balance": 42.5}],
        })
        r = client.delete("/api/transactions/entries/entry-1")
        assert r.status_code == 200
        assert r.json() == {
            "status": "deleted",
            "id": "entry-1",
            "ledger_balances": [{"ledger_id": "ledger-1", "balance": 42.5}],
        }

    def test_a_cash_side_refreshes_the_cash_ledger(self, make_client):
        """The unnamed side is the cash account, and Cash In Hand is read off that
        ledger's balance — so it needs refreshing too, even though the entry
        stores the side as NULL and names no ledger."""
        client = make_client({
            "finances_transaction_entries": [{
                "order_number": None,
                "from_account_id": "ledger-1",
                "to_account_id": None,
            }],
            "finances_ledgers": [{"id": "cash-ledger", "system_key": "cash"}],
            "finances_ledger_balances": [
                {"ledger_id": "ledger-1", "balance": 42.5},
                {"ledger_id": "cash-ledger", "balance": 900.0},
            ],
        })
        r = client.delete("/api/transactions/entries/entry-1")
        assert r.status_code == 200
        assert sorted(r.json()["ledger_balances"], key=lambda b: b["ledger_id"]) == [
            {"ledger_id": "cash-ledger", "balance": 900.0},
            {"ledger_id": "ledger-1", "balance": 42.5},
        ]


class TestErrorHandling:
    def test_unhandled_errors_return_a_generic_500(self, make_client, monkeypatch):
        """An unexpected failure must not leak the exception text to the client."""
        import app.main as main
        import app.routes.ledger as ledger
        from fastapi.testclient import TestClient

        make_client({"finances_ledgers": []})  # installs the auth override

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
