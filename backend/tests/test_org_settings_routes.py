"""Route tests for /api/org-settings (admin-only per-org Shopify/PostEx
credentials). See app/org_settings.py for the encrypt/decrypt chokepoint
these routes are a thin wrapper around."""
import pytest
from cryptography.fernet import Fernet

import app.org_settings as org_settings


@pytest.fixture(autouse=True)
def _settings_encryption_key(monkeypatch):
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    org_settings._runtime_key = None
    yield
    org_settings._runtime_key = None


class TestReadOrgSettings:
    def test_no_row_yet_reports_nothing_configured(self, make_client):
        client = make_client({"org_integration_settings": []})
        r = client.get("/api/org-settings/")
        assert r.status_code == 200
        body = r.json()
        assert body["shopify_store_url"] is None
        assert body["shopify_access_token_configured"] is False
        assert body["postex_merchant_token_configured"] is False

    def test_configured_secrets_are_reported_as_booleans_not_values(self, make_client):
        token = org_settings._encrypt("shpat_supersecret")
        client = make_client({"org_integration_settings": [{
            "org_id": "test-org",
            "shopify_store_url": "acme.myshopify.com",
            "shopify_access_token": token,
            "shopify_api_version": "2024-07",
            "postex_merchant_token": None,
        }]})
        r = client.get("/api/org-settings/")
        assert r.status_code == 200
        body = r.json()
        assert body["shopify_store_url"] == "acme.myshopify.com"
        assert body["shopify_access_token_configured"] is True
        assert body["postex_merchant_token_configured"] is False
        assert "shpat_supersecret" not in r.text


class TestUpdateOrgSettings:
    def test_update_stores_encrypted_and_is_reflected_on_read(self, make_client, monkeypatch):
        # FakeQuery (conftest.py) is stateless - it always replays the rows a
        # test registered, regardless of what upsert() was called with. The
        # route reads its own write back (upsert then GET), so this needs a
        # fake that actually remembers the last upsert to catch a regression
        # where the write silently doesn't stick.
        store = {}

        class _StatefulOrgSettingsQuery:
            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def upsert(self, payload, on_conflict=None):
                store.update(payload)
                return self

            def execute(self):
                return type("Response", (), {"data": [dict(store)] if store else []})()

        class _FakeSupabase:
            def table(self, name):
                assert name == "org_integration_settings"
                return _StatefulOrgSettingsQuery()

        fake = _FakeSupabase()
        client = make_client()
        monkeypatch.setattr(org_settings, "get_supabase", lambda: fake)

        r = client.put("/api/org-settings/", json={
            "shopify_store_url": "acme.myshopify.com",
            "shopify_access_token": "shpat_newtoken",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["shopify_store_url"] == "acme.myshopify.com"
        assert body["shopify_access_token_configured"] is True
        assert "shpat_newtoken" not in r.text
        assert store["shopify_access_token"] != "shpat_newtoken"  # stored encrypted, not plaintext
