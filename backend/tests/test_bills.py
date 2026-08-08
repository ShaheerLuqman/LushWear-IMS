"""Purchase bill route tests — FINANCE_ACCOUNTING_PLAN.md Phase 2.

The posting itself (Dr Inventory, Cr supplier; stock movement) lives in
receive_bill() in Postgres, because it needs several writes in one transaction.
These tests cover what the API layer owns: status guards, the derived payment
status, and that the RPC is called with the right arguments.
"""

SUPPLIER = "cccccccc-0000-0000-0000-000000000001"
BILL_ID = "dddddddd-0000-0000-0000-000000000001"


def _bill(status="draft", total=5000.0, paid=0.0, payment_status=None):
    """A row as bills_with_paid returns it."""
    if payment_status is None:
        payment_status = status if status != "received" else (
            "paid" if paid >= total else "partially_paid" if paid else "unpaid"
        )
    return {
        "id": BILL_ID,
        "org_id": "test-org",
        "bill_number": "BILL-0001",
        "supplier_ref": "INV-77",
        "supplier_id": SUPPLIER,
        "bill_date": "2026-08-01",
        "due_date": "2026-08-31",
        "status": status,
        "subtotal": total,
        "tax_amount": 0.0,
        "total": total,
        "notes": None,
        "stock_applied": status == "received",
        "paid_amount": paid,
        "outstanding": total - paid,
        "payment_status": payment_status,
        "created_at": "2026-08-01T10:00:00+00:00",
        "updated_at": "2026-08-01T10:00:00+00:00",
    }


def _tables(bill, items=None):
    return {
        "finances_bills_with_paid": [bill],
        "finances_bills": [bill],
        "finances_bill_items": items if items is not None else [{
            "id": "i1", "bill_id": BILL_ID,
            "product_id": None, "variant_id": None, "description": "Fabric",
            "quantity": 10.0, "unit_cost": 500.0, "amount": 5000.0,
        }],
    }


class TestCreateBill:
    def test_creates_a_draft_with_an_allocated_number(self, make_client):
        client = make_client(
            tables=_tables(_bill()),
            rpc_results={"next_bill_number": "BILL-0001"},
        )
        response = client.post("/api/bills/", json={
            "supplier_id": SUPPLIER,
            "bill_date": "2026-08-01",
            "items": [{"quantity": 10, "unit_cost": 500}],
        })

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["bill_number"] == "BILL-0001"
        assert body["status"] == "draft"

    def test_header_is_removed_if_the_lines_fail_to_insert(self, make_client):
        """The header and its lines are separate PostgREST calls with no
        transaction around them, so a line failure has to clean up after itself
        or it strands a draft that can never be received."""
        client = make_client(
            tables=_tables(_bill()),
            rpc_results={"next_bill_number": "BILL-0001"},
        )
        import app.routes.bills as bills

        fake = bills.get_supabase()
        original_table = fake.table
        deleted = []

        class _Boom(Exception):
            pass

        def _table(name):
            handle = original_table(name)
            if name == "finances_bill_items":
                def _explode(*_a, **_k):
                    raise _Boom("null value in column ... violates not-null constraint")
                handle.insert = _explode
            elif name == "finances_bills":
                real_delete = handle.delete
                def _delete(*a, **k):
                    deleted.append(name)
                    return real_delete(*a, **k)
                handle.delete = _delete
            return handle

        fake.table = _table
        try:
            with __import__("pytest").raises(_Boom):
                client.post("/api/bills/", json={
                    "supplier_id": SUPPLIER,
                    "bill_date": "2026-08-01",
                    "items": [{"quantity": 10, "unit_cost": 500}],
                })
        finally:
            fake.table = original_table

        assert deleted == ["finances_bills"], "the orphaned header was not deleted"

    def test_bill_with_no_lines_is_rejected(self, make_client):
        client = make_client(rpc_results={"next_bill_number": "BILL-0001"})
        response = client.post("/api/bills/", json={
            "supplier_id": SUPPLIER,
            "bill_date": "2026-08-01",
            "items": [],
        })
        assert response.status_code == 422
        assert "at least one line" in response.text

    def test_line_amount_is_computed_not_taken_from_the_client(self, make_client):
        """quantity * unit_cost is the amount — a client-supplied total would let
        the journal disagree with the lines it was built from."""
        from app.models import BillItemInput

        item = BillItemInput(quantity=3, unit_cost=250.5)
        assert item.amount == 751.5


class TestStatusGuards:
    def test_received_bill_cannot_be_edited(self, make_client):
        client = make_client(tables=_tables(_bill(status="received")))
        response = client.put(f"/api/bills/{BILL_ID}", json={"supplier_ref": "changed"})

        assert response.status_code == 400
        assert "Only a draft bill can be edited" in response.json()["detail"]

    def test_received_bill_cannot_be_deleted(self, make_client):
        client = make_client(tables=_tables(_bill(status="received")))
        response = client.delete(f"/api/bills/{BILL_ID}")

        assert response.status_code == 400
        assert "draft" in response.json()["detail"]

    def test_draft_can_be_deleted(self, make_client):
        client = make_client(tables=_tables(_bill(status="draft")))
        response = client.delete(f"/api/bills/{BILL_ID}")

        assert response.status_code == 200
        assert response.json() == {"status": "deleted", "id": BILL_ID}


class TestReceive:
    def test_receive_calls_the_posting_function(self, make_client):
        client = make_client(tables=_tables(_bill(status="received")))
        import app.routes.bills as bills

        response = client.post(f"/api/bills/{BILL_ID}/receive")

        assert response.status_code == 200, response.text
        assert ("receive_bill", {"p_bill_id": BILL_ID}) in bills.get_supabase().rpc_calls


class TestDerivedPaymentStatus:
    """Settlement is derived by the bills_with_paid view from the supplier's
    ledger balance applied oldest-bill-first — payments are plain cashbook
    entries and are never allocated to a bill. The API just surfaces it."""

    def test_partially_paid_is_surfaced(self, make_client):
        client = make_client(tables=_tables(_bill(status="received", total=5000.0, paid=2000.0)))
        body = client.get(f"/api/bills/{BILL_ID}").json()

        assert body["payment_status"] == "partially_paid"
        assert body["outstanding"] == 3000.0

    def test_fully_paid_is_surfaced(self, make_client):
        client = make_client(tables=_tables(_bill(status="received", total=5000.0, paid=5000.0)))
        body = client.get(f"/api/bills/{BILL_ID}").json()

        assert body["payment_status"] == "paid"
        assert body["outstanding"] == 0.0


class TestApAgeing:
    def test_buckets_are_returned(self, make_client):
        client = make_client(rpc_results={"get_ap_ageing": [{
            "supplier_id": SUPPLIER, "supplier_name": "Fabric Supplier",
            "outstanding": 5000.0, "not_due": 1000.0, "d1_30": 4000.0,
            "d31_60": 0.0, "d61_90": 0.0, "d90_plus": 0.0,
        }]})
        response = client.get("/api/bills/ap-ageing?as_of=2026-09-15")

        assert response.status_code == 200, response.text
        row = response.json()[0]
        assert row["supplier_name"] == "Fabric Supplier"
        assert row["outstanding"] == 5000.0
        assert row["d1_30"] == 4000.0

    def test_no_payables_returns_empty(self, make_client):
        client = make_client(rpc_results={"get_ap_ageing": []})
        assert client.get("/api/bills/ap-ageing").json() == []
