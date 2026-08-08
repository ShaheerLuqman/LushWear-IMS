"""Journal (double-entry core) route tests — FINANCE_ACCOUNTING_PLAN.md Phase 1.

The balance rule is enforced in three places on purpose: JournalEntryCreate (so
a bad payload is a readable 422), post_journal_entry() (because other posting
code reaches the RPC without going through the API), and a deferred constraint
trigger (so nothing at all can write an unbalanced entry). These tests cover the
first; the other two are database-level and are exercised by the migration.
"""

CASH = "aaaaaaaa-0000-0000-0000-000000000001"
SALES = "aaaaaaaa-0000-0000-0000-000000000002"

JOURNAL_ID = "bbbbbbbb-0000-0000-0000-000000000001"


def _posted_entry_tables():
    """Rows the POST route reads back after the RPC returns the new id."""
    return {
        "finances_journal_entries": [{
            "id": JOURNAL_ID,
            "org_id": "test-org",
            "entry_date": "2026-08-01",
            "voucher_type": "manual",
            "narration": "Stock written off",
            "source_type": None,
            "source_id": None,
            "created_by": "test",
            "created_at": "2026-08-01T10:00:00+00:00",
        }],
        "finances_journal_lines": [
            {"id": "l1", "journal_id": JOURNAL_ID, "account_id": SALES,
             "debit": 500.0, "credit": 0.0, "description": None},
            {"id": "l2", "journal_id": JOURNAL_ID, "account_id": CASH,
             "debit": 0.0, "credit": 500.0, "description": None},
        ],
    }


class TestPostJournalEntry:
    def test_balanced_entry_is_posted_through_the_rpc(self, make_client):
        client = make_client(
            tables=_posted_entry_tables(),
            rpc_results={"post_journal_entry": JOURNAL_ID},
        )
        response = client.post("/api/journal/entries", json={
            "entry_date": "2026-08-01",
            "narration": "Stock written off",
            "lines": [
                {"account_id": SALES, "debit": 500, "credit": 0},
                {"account_id": CASH, "debit": 0, "credit": 500},
            ],
        })

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["id"] == JOURNAL_ID
        assert len(body["lines"]) == 2

    def test_created_by_is_taken_from_the_token_not_the_payload(self, make_client):
        client = make_client(
            tables=_posted_entry_tables(),
            rpc_results={"post_journal_entry": JOURNAL_ID},
        )
        import app.routes.journal as journal

        client.post("/api/journal/entries", json={
            "entry_date": "2026-08-01",
            "lines": [
                {"account_id": SALES, "debit": 500, "credit": 0},
                {"account_id": CASH, "debit": 0, "credit": 500},
            ],
        })

        name, params = journal.get_supabase().rpc_calls[-1]
        assert name == "post_journal_entry"
        # `sub` from the fixture's token, and the org the caller belongs to -
        # neither is client-supplied.
        assert params["p_created_by"] == "test"
        assert params["p_org_id"] == "test-org"
        assert params["p_voucher_type"] == "manual"

    def test_unbalanced_entry_is_rejected(self, make_client):
        client = make_client(rpc_results={"post_journal_entry": JOURNAL_ID})
        response = client.post("/api/journal/entries", json={
            "entry_date": "2026-08-01",
            "lines": [
                {"account_id": SALES, "debit": 500, "credit": 0},
                {"account_id": CASH, "debit": 0, "credit": 400},
            ],
        })
        assert response.status_code == 422
        assert "does not balance" in response.text

    def test_line_with_both_sides_is_rejected(self, make_client):
        client = make_client(rpc_results={"post_journal_entry": JOURNAL_ID})
        response = client.post("/api/journal/entries", json={
            "entry_date": "2026-08-01",
            "lines": [
                {"account_id": SALES, "debit": 500, "credit": 500},
                {"account_id": CASH, "debit": 0, "credit": 500},
            ],
        })
        assert response.status_code == 422
        assert "exactly one of debit or credit" in response.text

    def test_line_with_neither_side_is_rejected(self, make_client):
        client = make_client(rpc_results={"post_journal_entry": JOURNAL_ID})
        response = client.post("/api/journal/entries", json={
            "entry_date": "2026-08-01",
            "lines": [
                {"account_id": SALES, "debit": 0, "credit": 0},
                {"account_id": CASH, "debit": 0, "credit": 0},
            ],
        })
        assert response.status_code == 422

    def test_single_line_entry_is_rejected(self, make_client):
        client = make_client(rpc_results={"post_journal_entry": JOURNAL_ID})
        response = client.post("/api/journal/entries", json={
            "entry_date": "2026-08-01",
            "lines": [{"account_id": SALES, "debit": 500, "credit": 0}],
        })
        assert response.status_code == 422
        assert "at least two lines" in response.text

    def test_zero_amount_entry_is_rejected(self, make_client):
        """Balances trivially, but posts nothing - almost always a UI bug."""
        client = make_client(rpc_results={"post_journal_entry": JOURNAL_ID})
        response = client.post("/api/journal/entries", json={
            "entry_date": "2026-08-01",
            "lines": [
                {"account_id": SALES, "debit": 0, "credit": 0.0},
                {"account_id": CASH, "debit": 0.0, "credit": 0},
            ],
        })
        assert response.status_code == 422


class TestTrialBalance:
    def test_totals_and_balanced_flag(self, make_client):
        client = make_client(rpc_results={"get_trial_balance": [
            {"account_id": CASH, "code": "1000", "name": "Cash",
             "type": "Asset", "debit": 1500.0, "credit": 0.0},
            {"account_id": SALES, "code": "4000", "name": "Sales",
             "type": "Revenue", "debit": 0.0, "credit": 1500.0},
        ]})
        response = client.get("/api/journal/trial-balance?as_of=2026-08-01")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["total_debit"] == 1500.0
        assert body["total_credit"] == 1500.0
        assert body["balanced"] is True
        assert body["as_of"] == "2026-08-01"

    def test_reports_unbalanced_rather_than_hiding_it(self, make_client):
        """If the two totals ever disagree, something wrote around the deferred
        constraint - the report must say so, not quietly round it away."""
        client = make_client(rpc_results={"get_trial_balance": [
            {"account_id": CASH, "code": "1000", "name": "Cash",
             "type": "Asset", "debit": 1500.0, "credit": 0.0},
            {"account_id": SALES, "code": "4000", "name": "Sales",
             "type": "Revenue", "debit": 0.0, "credit": 1400.0},
        ]})
        body = client.get("/api/journal/trial-balance").json()

        assert body["balanced"] is False
        assert body["total_debit"] == 1500.0
        assert body["total_credit"] == 1400.0

    def test_empty_books_balance(self, make_client):
        client = make_client(rpc_results={"get_trial_balance": []})
        body = client.get("/api/journal/trial-balance").json()

        assert body["rows"] == []
        assert body["balanced"] is True


class TestSystemCashAccountGuard:
    """Cash In Hand already counts the cash account once, through that account's
    own balance. Flagging it again would silently double the headline figure —
    and the account is named "Cash", so it invites exactly that."""

    def test_cannot_include_the_system_cash_account_in_cash_in_hand(self, make_client):
        client = make_client(tables={"finances_ledgers": [
            {"id": CASH, "name": "Cash", "type": "Asset", "system_key": "cash"},
        ]})
        response = client.put(f"/api/ledgers/{CASH}", json={"include_in_cash_in_hand": True})

        assert response.status_code == 400
        assert "already counted" in response.json()["detail"]

    def test_ordinary_account_can_still_be_included(self, make_client):
        client = make_client(tables={"finances_ledgers": [
            {"id": SALES, "name": "Meezan Bank", "type": "Asset", "system_key": None,
             "include_in_cash_in_hand": True},
        ]})
        response = client.put(f"/api/ledgers/{SALES}", json={"include_in_cash_in_hand": True})

        assert response.status_code == 200, response.text


class TestListJournalEntries:
    def test_lines_are_attached_to_their_entry(self, make_client):
        client = make_client(tables=_posted_entry_tables())
        body = client.get("/api/journal/entries").json()

        assert len(body) == 1
        assert {line["account_id"] for line in body[0]["lines"]} == {CASH, SALES}

    def test_account_filter_with_no_matching_lines_returns_empty(self, make_client):
        """Short-circuits before querying journal_entries - without it, the
        empty id list would be dropped by the fake and every entry returned."""
        client = make_client(tables={"finances_journal_entries": [], "finances_journal_lines": []})
        response = client.get(f"/api/journal/entries?account_id={CASH}")

        assert response.status_code == 200
        assert response.json() == []
