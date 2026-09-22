"""Unit tests for app/onboarding_settings.py - the route-facing half of the
onboarding cutoff. The cutoff itself lives in the enforce_onboarding_cutoff
trigger (supabase/migrations/20260922000000_org_onboarding_date.sql), which
these fakes can't exercise.
"""
from datetime import date

import pytest

import app.onboarding_settings as onboarding
from app.onboarding_settings import (
    apply_onboarding_cutoff,
    ensure_not_before_onboarding,
    set_org_onboarding_date,
)


def _client(onboarding_date):
    """Stands in for the caller's supabase client - the guard reads the org row
    through it rather than opening its own connection."""
    rows = [{"onboarding_date": onboarding_date}]

    class _Query:
        def __getattr__(self, _name):
            def _chain(*_args, **_kwargs):
                return self
            return _chain

        def execute(self):
            return type("Response", (), {"data": rows})()

    return type("S", (), {"table": lambda _s, _n: _Query()})()


class TestEnsureNotBeforeOnboarding:
    def test_no_onboarding_date_allows_anything(self):
        ensure_not_before_onboarding(_client(None), "org1", [date(2020, 1, 1)])

    def test_rejects_a_date_before_the_cutoff(self):
        with pytest.raises(ValueError, match="2026-09-22"):
            ensure_not_before_onboarding(_client("2026-09-22"), "org1", [date(2026, 9, 21)])

    def test_allows_the_cutoff_day_itself(self):
        ensure_not_before_onboarding(_client("2026-09-22"), "org1", [date(2026, 9, 22), "2026-09-23"])

    def test_rejects_when_any_date_in_a_bulk_insert_is_early(self):
        with pytest.raises(ValueError):
            ensure_not_before_onboarding(_client("2026-09-22"), "org1", ["2026-09-25", "2026-09-01"])


class _FakeQuery:
    def __init__(self, sink):
        self._sink = sink

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self
        return _chain

    def update(self, payload):
        self._sink.append(payload)
        return self

    def execute(self):
        return type("Response", (), {"data": []})()


class _FakeWriteClient:
    """Records the org-row update and any rpc the setter fires."""

    def __init__(self):
        self.written = []
        self.rpcs = []

    def table(self, _name):
        return _FakeQuery(self.written)

    def rpc(self, name, params):
        self.rpcs.append((name, params))
        return type("Q", (), {"execute": lambda _s: type("R", (), {"data": None})()})()


class TestSetOrgOnboardingDate:
    def test_rejects_a_date_later_than_existing_data(self, monkeypatch):
        monkeypatch.setattr(onboarding, "get_earliest_financial_date", lambda _org: "2026-01-15")
        with pytest.raises(ValueError, match="2026-01-15"):
            set_org_onboarding_date("org1", date(2026, 3, 1))

    def test_allows_a_date_on_or_before_existing_data(self, monkeypatch):
        client = _FakeWriteClient()
        monkeypatch.setattr(onboarding, "get_earliest_financial_date", lambda _org: "2026-01-15")
        monkeypatch.setattr(onboarding, "get_supabase", lambda: client)
        assert set_org_onboarding_date("org1", date(2026, 1, 15)) == "2026-01-15"
        assert client.written == [{"onboarding_date": "2026-01-15"}]

    def test_rebuilds_the_opening_voucher_onto_the_new_date(self, monkeypatch):
        """The voucher's date is derived from onboarding_date, and only the
        ledger trigger rebuilds it - the setter has to ask for it."""
        client = _FakeWriteClient()
        monkeypatch.setattr(onboarding, "get_earliest_financial_date", lambda _org: None)
        monkeypatch.setattr(onboarding, "get_supabase", lambda: client)
        set_org_onboarding_date("org1", date(2026, 1, 15))
        assert client.rpcs == [("sync_opening_balance_journal", {"p_org_id": "org1"})]

    def test_an_org_with_no_data_yet_takes_any_date(self, monkeypatch):
        """A brand-new org has nothing to strand, so the earliest-entry check
        cannot reject anything."""
        client = _FakeWriteClient()
        monkeypatch.setattr(onboarding, "get_earliest_financial_date", lambda _org: None)
        monkeypatch.setattr(onboarding, "get_supabase", lambda: client)
        assert set_org_onboarding_date("org1", date(2026, 9, 23)) == "2026-09-23"
        assert client.written == [{"onboarding_date": "2026-09-23"}]


class _FakeRpcSupabase:
    def __init__(self, result):
        self._result = result
        self.called = None

    def rpc(self, name, params):
        self.called = (name, params)
        return type("Q", (), {"execute": lambda _s: type("R", (), {"data": self._result})()})()


class TestApplyOnboardingCutoff:
    def test_passes_the_date_through_to_the_purge_rpc(self, monkeypatch):
        fake = _FakeRpcSupabase({
            "onboarding_date": "2026-06-01",
            "transaction_entries_deleted": 12,
            "journal_entries_deleted": 30,
            "bills_deleted": 2,
        })
        monkeypatch.setattr(onboarding, "get_supabase", lambda: fake)
        result = apply_onboarding_cutoff("org1", date(2026, 6, 1))
        assert fake.called == ("apply_onboarding_cutoff", {"p_org_id": "org1", "p_date": "2026-06-01"})
        assert result["transaction_entries_deleted"] == 12

    def test_does_not_go_through_the_guarded_setter(self, monkeypatch):
        """The purge is the only way past set_org_onboarding_date's "not later
        than existing data" rule, so it must not call it."""
        monkeypatch.setattr(onboarding, "get_supabase", lambda: _FakeRpcSupabase({}))
        monkeypatch.setattr(onboarding, "get_earliest_financial_date", lambda _org: pytest.fail("should not be called"))
        apply_onboarding_cutoff("org1", date(2026, 6, 1))
