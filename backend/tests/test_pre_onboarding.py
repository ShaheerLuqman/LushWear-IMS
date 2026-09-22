"""Unit tests for app/services/pre_onboarding.py - the CSV side of the
pre-onboarding courier reconciliation. The bill itself is built by
build_pre_onboarding_bill in plpgsql, which these fakes cannot exercise.
"""
import pytest

import app.services.pre_onboarding as pre_onboarding


CSV_HEADER = "ORDER_REF_NUMBER,SHIPPING_CHARGES,GST,WH_INCOME_TAX,WH_SALES_TAX,STATUS\n"


def _csv(*rows: str) -> bytes:
    return (CSV_HEADER + "".join(rows)).encode()


class TestSupported:
    def test_postex_is_supported(self):
        assert pre_onboarding.supported("postex")
        assert pre_onboarding.supported("PostEx")

    def test_other_couriers_are_not_yet(self):
        assert not pre_onboarding.supported("leopards")


class TestParse:
    def test_merges_several_files_into_one_map(self):
        by_order, numbers = pre_onboarding.parse("postex", [
            _csv("1001,150,0,10,10,Delivered\n"),
            _csv("1002,200,0,0,0,Returned\n"),
        ])
        assert sorted(by_order) == ["1001", "1002"]
        assert sorted(numbers) == ["1001", "1002"]

    def test_a_later_file_wins_on_a_duplicate_order(self):
        """Re-uploading a corrected CPR should override the earlier figures."""
        by_order, _ = pre_onboarding.parse("postex", [
            _csv("1001,150,0,0,0,Delivered\n"),
            _csv("1001,999,0,0,0,Delivered\n"),
        ])
        assert by_order["1001"]["delivery_charge"] == 999


class _FakeTable:
    def __init__(self, rows, sink):
        self._rows = rows
        self._sink = sink

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self
        return _chain

    def upsert(self, payload, **_kwargs):
        self._sink.extend(payload)
        return self

    def execute(self):
        return type("Response", (), {"data": list(self._rows)})()


class TestMarkSettled:
    def _patch(self, monkeypatch, rows, sink):
        monkeypatch.setattr(pre_onboarding, "get_supabase", lambda: object())
        monkeypatch.setattr(pre_onboarding, "org_table", lambda *_a, **_k: _FakeTable(rows, sink))
        monkeypatch.setattr(pre_onboarding, "fetch_all", lambda build: build().execute().data)

    def test_writes_charges_and_the_settled_flag(self, monkeypatch):
        sink = []
        self._patch(monkeypatch, [{
            "id": "o1", "order_number": 1001, "order_status": "fulfilled", "total_amount": 5000,
            "order_receiving_date": "2026-01-01", "delivery_charge": 0, "tax_amount": 0,
            "courier": None, "is_order_settled": False, "tracking_number": None,
        }], sink)

        result = pre_onboarding.mark_settled("org1", "postex", {
            "1001": {"delivery_charge": 150, "tax_amount": 20, "csv_order_status": "delivered",
                     "tracking_number": "12345678901234"},
        })

        assert result["matched"] == 1
        written = sink[0]
        assert written["is_order_settled"] is True
        assert written["delivery_charge"] == 150
        assert written["tax_amount"] == 20
        assert written["order_status"] == "delivered"
        assert written["courier"] == "PostEx"

    def test_never_writes_a_folio(self, monkeypatch):
        """A folio would put these orders in front of assign_courier_payouts,
        which groups settled orders into payout rows org-wide."""
        sink = []
        self._patch(monkeypatch, [{
            "id": "o1", "order_number": 1001, "order_status": "fulfilled", "total_amount": 5000,
            "order_receiving_date": "2026-01-01", "delivery_charge": 0, "tax_amount": 0,
            "courier": None, "is_order_settled": False, "tracking_number": None,
        }], sink)

        pre_onboarding.mark_settled("org1", "postex", {
            "1001": {"delivery_charge": 150, "tax_amount": 20, "csv_order_status": "delivered"},
        })
        assert "folio" not in sink[0]

    def test_reports_csv_rows_that_match_no_order(self, monkeypatch):
        sink = []
        self._patch(monkeypatch, [], sink)
        result = pre_onboarding.mark_settled("org1", "postex", {
            "9999": {"delivery_charge": 10, "tax_amount": 0, "csv_order_status": "delivered"},
        })
        assert result["matched"] == 0
        assert result["unmatched"] == ["9999"]
        assert sink == []
