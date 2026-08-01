"""System ledgers — `ledgers.system_key`.

These are created with the organization (a trigger on `organizations`) and are
entirely server-managed: the API never accepts `system_key` from a client, so
there is nothing to assign or mis-assign, and a ledger holding one cannot be
deleted.

The seeding itself is a database trigger and is exercised by the migration;
these tests cover what the API layer owns.
"""
from app.ledger_roles import SYSTEM_LEDGER_LABELS

CASH = "ffffffff-0000-0000-0000-000000000001"
ORDERS = "ffffffff-0000-0000-0000-000000000002"
PLAIN = "ffffffff-0000-0000-0000-000000000003"


def _ledger(ledger_id, name, system_key=None):
    return {
        "id": ledger_id, "org_id": "test-org", "name": name, "type": "Asset",
        "system_key": system_key, "include_in_cash_in_hand": False,
        "opening_balance": 0, "report_category": None, "is_party": False,
    }


class TestSystemLedgerCatalogue:
    def test_every_role_the_app_posts_to_has_a_label(self):
        """These names appear in API errors, so a missing one would surface a
        raw key to the user."""
        for role in ("cash", "opening_balance_equity", "orders", "inventory", "tax_on_purchases"):
            assert SYSTEM_LEDGER_LABELS.get(role)


class TestSystemKeyIsServerManaged:
    def test_it_cannot_be_set_when_creating(self, make_client):
        """System ledgers come from the org-creation trigger. A client-supplied
        system_key is ignored rather than honoured — Pydantic drops the unknown
        field, so the created ledger is ordinary."""
        client = make_client(tables={"ledgers": [_ledger(PLAIN, "Customer Advances")]})
        response = client.post("/api/ledgers/", json={
            "name": "Something New", "type": "Asset", "system_key": "orders",
        })

        assert response.status_code == 200, response.text
        assert response.json()["system_key"] is None

    def test_it_cannot_be_changed_by_an_update(self, make_client):
        client = make_client(tables={"ledgers": [_ledger(ORDERS, "Orders", "orders")]})
        response = client.put(f"/api/ledgers/{ORDERS}", json={"system_key": None})

        # Nothing else in the payload, so the request carries no updatable field.
        assert response.status_code == 400
        assert "No fields to update" in response.json()["detail"]

    def test_an_ordinary_field_still_updates_on_a_system_ledger(self, make_client):
        """Renaming or recategorising a system account is fine — only its role
        is fixed."""
        client = make_client(tables={"ledgers": [_ledger(CASH, "Cash in Hand", "cash")]})
        response = client.put(f"/api/ledgers/{CASH}", json={"name": "Cash Box"})

        assert response.status_code == 200, response.text

    def test_the_roles_endpoint_is_gone(self, make_client):
        """There is nothing for a user to choose, so the picker it fed was
        removed with it."""
        client = make_client()
        assert client.get("/api/ledgers/roles").status_code == 404


class TestSystemLedgersCannotBeDeleted:
    def test_deleting_a_system_ledger_is_refused(self, make_client):
        client = make_client(tables={"ledgers": [_ledger(CASH, "Cash in Hand", "cash")]})
        response = client.delete(f"/api/ledgers/{CASH}")

        assert response.status_code == 400
        assert "system account" in response.json()["detail"]

    def test_the_message_names_the_account(self, make_client):
        client = make_client(tables={"ledgers": [_ledger(ORDERS, "Orders", "orders")]})
        detail = client.delete(f"/api/ledgers/{ORDERS}").json()["detail"]

        assert "Orders" in detail

    def test_an_unused_ordinary_ledger_can_be_deleted(self, make_client):
        client = make_client(tables={"ledgers": [_ledger(PLAIN, "Advances")], "journal_lines": []})
        response = client.delete(f"/api/ledgers/{PLAIN}")

        assert response.status_code == 200, response.text
        assert response.json() == {"status": "deleted", "id": PLAIN}

    def test_a_ledger_with_postings_is_refused(self, make_client):
        """Checked against journal_lines, not cashbook_entries: since Phase 1 an
        account can also be posted to by a bill or a manual entry, which would
        otherwise only be caught by the foreign key as a raw database error."""
        client = make_client(tables={
            "ledgers": [_ledger(PLAIN, "Advances")],
            "journal_lines": [{"id": "jl1", "account_id": PLAIN}],
        })
        response = client.delete(f"/api/ledgers/{PLAIN}")

        assert response.status_code == 400
        assert "entries posted against it" in response.json()["detail"]
