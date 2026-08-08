"""GET /ledgers/{id}/entries — the account statement.

It reads the journal, not transaction_entries. That distinction is the whole point:
a received bill credits its supplier, so before this the supplier's balance moved
with no row on the statement to account for it, and the running total stopped
agreeing with the balance shown everywhere else.
"""

SUPPLIER = "eeeeeeee-0000-0000-0000-000000000001"


def _statement_rows():
    """As get_ledger_statement returns them: opening balance, a bill, a payment."""
    return [
        {"id": "l1", "entry_date": "2026-07-31", "particulars": "Opening balance",
         "debit": 0, "credit": 20000.0, "voucher_type": "opening",
         "source_type": "opening_balance"},
        {"id": "l2", "entry_date": "2026-08-01", "particulars": "Bill BILL-0001",
         "debit": 0, "credit": 12000.0, "voucher_type": "bill", "source_type": "bill"},
        {"id": "l3", "entry_date": "2026-08-05", "particulars": "Payment for bill BILL-0001",
         "debit": 5000.0, "credit": 0, "voucher_type": "transaction",
         "source_type": "transaction_entry"},
    ]


class TestLedgerStatement:
    def test_a_received_bill_appears_on_the_supplier_statement(self, make_client):
        client = make_client(rpc_results={"get_ledger_statement": _statement_rows()})
        rows = client.get(f"/api/ledgers/{SUPPLIER}/entries").json()

        bill_rows = [r for r in rows if r["voucher_type"] == "bill"]
        assert len(bill_rows) == 1
        assert bill_rows[0]["particulars"] == "Bill BILL-0001"
        assert bill_rows[0]["credit"] == 12000.0

    def test_statement_carries_every_voucher_type(self, make_client):
        """Transaction entries alone would miss bills, opening balances and manual
        journals — all of which move the balance."""
        client = make_client(rpc_results={"get_ledger_statement": _statement_rows()})
        rows = client.get(f"/api/ledgers/{SUPPLIER}/entries").json()

        assert [r["voucher_type"] for r in rows] == ["opening", "bill", "transaction"]

    def test_running_total_matches_the_account_balance(self, make_client):
        """Debit - Credit over the statement must equal what recalc_ledger_balance
        stores, or the statement and the ledger card disagree."""
        client = make_client(rpc_results={"get_ledger_statement": _statement_rows()})
        rows = client.get(f"/api/ledgers/{SUPPLIER}/entries").json()

        running = sum(r["debit"] - r["credit"] for r in rows)
        # Debit-positive storage: -27,000 is a 27,000 Cr balance, i.e. still owed.
        assert running == -27000.0

    def test_statement_is_read_through_the_rpc(self, make_client):
        client = make_client(rpc_results={"get_ledger_statement": []})
        import app.routes.ledger as ledger

        client.get(f"/api/ledgers/{SUPPLIER}/entries")

        name, params = ledger.get_supabase().rpc_calls[-1]
        assert name == "get_ledger_statement"
        assert params == {"p_org_id": "test-org", "p_ledger_id": SUPPLIER}

    def test_account_with_no_postings_is_empty(self, make_client):
        client = make_client(rpc_results={"get_ledger_statement": []})
        assert client.get(f"/api/ledgers/{SUPPLIER}/entries").json() == []
