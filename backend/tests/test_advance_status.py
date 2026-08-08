import pytest

from app.advance_status import (
    ADV_TRANSACTION_ONLY,
    ADV_MATCH,
    ADV_MISMATCH,
    ADV_NONE,
    ADV_SHOPIFY_ONLY,
    compute_advance_status,
    recompute_advance_statuses,
)


@pytest.mark.parametrize("shopify,transaction,expected", [
    (0, 0, ADV_NONE),
    (None, None, ADV_NONE),
    (500, 0, ADV_SHOPIFY_ONLY),
    (0, 500, ADV_TRANSACTION_ONLY),
    (500, 500, ADV_MATCH),
    (500, 250, ADV_MISMATCH),
])
def test_status_codes(shopify, transaction, expected):
    assert compute_advance_status(shopify, transaction) == expected


def test_sub_cent_float_noise_still_matches():
    # Values that differ only by float representation must not read as a mismatch.
    assert compute_advance_status(1522.20, 1522.1999999999998) == ADV_MATCH


def test_one_cent_difference_is_within_tolerance():
    assert compute_advance_status(500.00, 500.01) == ADV_MATCH


def test_difference_at_tolerance_boundary_is_a_mismatch():
    assert compute_advance_status(500.00, 505.00) == ADV_MISMATCH


def test_difference_just_under_tolerance_matches():
    assert compute_advance_status(500.00, 504.99) == ADV_MATCH


def test_amounts_are_rounded_before_comparing():
    # 500.004 and 500.001 both round to 500.00.
    assert compute_advance_status(500.004, 500.001) == ADV_MATCH


def test_sub_cent_amount_counts_as_no_advance():
    # 0.004 rounds to 0.00, so neither side has an advance.
    assert compute_advance_status(0.004, 0) == ADV_NONE


def test_negative_advance_is_treated_as_present():
    assert compute_advance_status(-100, 0) == ADV_SHOPIFY_ONLY


class _FakeTable:
    """Chainable stand-in for one supabase-py table, recording `upsert` calls so
    the write-path tests can assert it was a single batched call, not one
    per changed order."""

    def __init__(self, rows):
        self._rows = rows
        self.upsert_calls = []

    def __getattr__(self, name):
        if name == "not_":
            return self
        def _chain(*_a, **_k):
            return self
        return _chain

    def upsert(self, payload, on_conflict=None, **_k):
        self.upsert_calls.append(payload)
        return self

    def execute(self):
        return type("Resp", (), {"data": list(self._rows)})()


class _FakeSupabase:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return self._tables[name]


def _orders_ledger_table():
    """The org's Orders ledger, which advance lookups resolve before reading
    transaction entries (system_key = 'orders' replaced a hardcoded UUID)."""
    return _FakeTable([{"id": "orders-ledger-id"}])


class TestRecomputeAdvanceStatuses:
    def test_persists_changed_orders_as_a_single_batched_upsert(self):
        orders_table = _FakeTable([
            {"id": "o1", "order_number": 100, "advance_amount": 500.0, "advance_status": ADV_NONE,
             "courier": "PostEx", "order_status": "delivered", "total_amount": 2598.0,
             "order_receiving_date": "2026-07-18T13:23:08+00:00"},
            {"id": "o2", "order_number": 101, "advance_amount": 0.0, "advance_status": ADV_NONE,
             "courier": "PostEx", "order_status": "delivered", "total_amount": 500.0,
             "order_receiving_date": "2026-07-18T13:23:08+00:00"},
        ])
        transaction_table = _FakeTable([
            {"order_number": "100", "amount": 500.0},
        ])
        supabase = _FakeSupabase({
            "shopify_orders": orders_table,
            "finances_transaction_entries": transaction_table,
            "finances_ledgers": _orders_ledger_table(),
        })

        updated = recompute_advance_statuses(supabase, "test-org", order_numbers=["100", "101"])

        # Order 100 now matches (Shopify 500 vs transaction 500) - status changes from
        # ADV_NONE to ADV_MATCH. Order 101 has no advance either side - unchanged.
        assert updated == 1
        assert orders_table.upsert_calls == [[{
            "id": "o1", "order_number": 100, "advance_amount": 500.0, "advance_status": ADV_MATCH,
            # NOT NULL columns without a default, carried unchanged: an upsert is
            # INSERT ... ON CONFLICT, so Postgres rejects a payload missing them.
            "courier": "PostEx", "order_status": "delivered", "total_amount": 2598.0,
            "order_receiving_date": "2026-07-18T13:23:08+00:00",
            "org_id": "test-org",
        }]]

    def test_no_changed_orders_means_no_write(self):
        orders_table = _FakeTable([
            {"id": "o1", "order_number": 100, "advance_amount": 0.0, "advance_status": ADV_NONE},
        ])
        transaction_table = _FakeTable([])
        supabase = _FakeSupabase({
            "shopify_orders": orders_table,
            "finances_transaction_entries": transaction_table,
            "finances_ledgers": _orders_ledger_table(),
        })

        updated = recompute_advance_statuses(supabase, "test-org", order_numbers=["100"])

        assert updated == 0
        assert orders_table.upsert_calls == []
