"""Unit tests for the Supabase-backed login lockout (app.routes.auth._LoginLockout).

Supabase is faked at the module level, not via the make_client/TestClient
fixture, since the generic FakeQuery in conftest.py doesn't simulate state
changing across calls.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import app.routes.auth as auth_module
from app.routes.auth import _LoginLockout


class _FakeTable:
    def __init__(self, rows):
        self._rows = rows
        self.deleted_keys = []
        self._pending_delete = False

    def __getattr__(self, _name):
        def _chain(*_a, **_k):
            return self
        return _chain

    def delete(self):
        self._pending_delete = True
        return self

    def eq(self, col, val):
        if self._pending_delete and col == "email":
            self.deleted_keys.append(val)
        return self

    def execute(self):
        return type("Resp", (), {"data": list(self._rows)})()


class _FakeSupabase:
    def __init__(self, rows):
        self.table_ = _FakeTable(rows)
        self.rpc_calls = []

    def table(self, name):
        assert name == "system_login_lockouts"
        return self.table_

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return _FakeTable([])


def _install_fake(monkeypatch, rows):
    fake = _FakeSupabase(rows)
    monkeypatch.setattr(auth_module, "get_supabase", lambda: fake)
    return fake


class TestLockoutCheck:
    def test_no_row_means_not_locked(self, monkeypatch):
        _install_fake(monkeypatch, rows=[])
        _LoginLockout().check("a@example.com")  # must not raise

    def test_future_locked_until_raises_429(self, monkeypatch):
        future = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
        _install_fake(monkeypatch, rows=[{"locked_until": future}])
        with pytest.raises(HTTPException) as exc_info:
            _LoginLockout().check("a@example.com")
        assert exc_info.value.status_code == 429
        assert "Retry-After" in exc_info.value.headers

    def test_past_locked_until_does_not_raise(self, monkeypatch):
        past = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
        _install_fake(monkeypatch, rows=[{"locked_until": past}])
        _LoginLockout().check("a@example.com")  # must not raise

    def test_null_locked_until_does_not_raise(self, monkeypatch):
        _install_fake(monkeypatch, rows=[{"locked_until": None}])
        _LoginLockout().check("a@example.com")  # must not raise


class TestLockoutRecordFailure:
    def test_calls_the_atomic_rpc_with_configured_thresholds(self, monkeypatch):
        fake = _install_fake(monkeypatch, rows=[])
        lockout = _LoginLockout(max_attempts=3, window=120)
        lockout.record_failure("a@example.com")
        assert fake.rpc_calls == [
            ("record_login_lockout_failure", {
                "p_email": "a@example.com",
                "p_max_attempts": 3,
                "p_window_seconds": 120,
            }),
        ]


class TestLockoutClear:
    def test_deletes_the_row_for_the_key(self, monkeypatch):
        fake = _install_fake(monkeypatch, rows=[])
        _LoginLockout().clear("a@example.com")
        assert fake.table_.deleted_keys == ["a@example.com"]
