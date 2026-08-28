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
        client = make_client({"system_integration_settings": []})
        r = client.get("/api/org-settings/")
        assert r.status_code == 200
        body = r.json()
        assert body["shopify_store_url"] is None
        assert body["shopify_access_token_configured"] is False
        assert body["postex_merchant_token_configured"] is False

    def test_configured_secrets_are_reported_as_booleans_not_values(self, make_client):
        token = org_settings._encrypt("shpat_supersecret")
        client = make_client({"system_integration_settings": [{
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
                assert name == "system_integration_settings"
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


class TestCourierCredentialsBlob:
    """Courier credentials are stored in the single encrypted `couriers` blob
    (see app/org_settings.py) rather than a column per courier."""

    def test_legacy_columns_are_ignored_entirely(self):
        """The blob is the only source - a row still holding a pre-blob column
        reads as nothing configured rather than falling back to it."""
        row = {"postex_merchant_token": org_settings._encrypt("pk_legacy")}
        assert org_settings._decode_couriers(row) == {}

    def test_blob_is_used_even_when_a_legacy_column_still_holds_a_value(self):
        row = {
            "couriers": org_settings._encrypt('{"postex": {"merchant_token": "pk_blob"}}'),
            "postex_merchant_token": org_settings._encrypt("pk_legacy"),
        }
        assert org_settings._decode_couriers(row)["postex"]["merchant_token"] == "pk_blob"

    def test_corrupt_blob_reads_as_not_configured(self):
        row = {"couriers": org_settings._encrypt("not json")}
        assert org_settings._decode_couriers(row) == {}

    def test_blob_is_stored_encrypted_and_round_trips_both_couriers(self, make_client, monkeypatch):
        store = {}

        class _StatefulQuery:
            def __getattr__(self, _name):
                def _chain(*_args, **_kwargs):
                    return self
                return _chain

            def upsert(self, payload, on_conflict=None):
                store.update(payload)
                return self

            def execute(self):
                return type("Response", (), {"data": [dict(store)] if store else []})()

        # make_client() patches org_settings.get_supabase itself, so this must
        # override it afterwards to keep the stateful fake.
        client = make_client()
        monkeypatch.setattr(org_settings, "get_supabase", lambda: type("F", (), {"table": lambda _s, _n: _StatefulQuery()})())

        client.put("/api/org-settings/", json={"postex_merchant_token": "pk_secret"})
        # Writing one courier must not drop the other's credential from the blob.
        r = client.put("/api/org-settings/", json={"couriers_next_auth_key": "cn_secret"})

        assert r.status_code == 200
        body = r.json()
        assert body["postex_merchant_token_configured"] is True
        assert body["couriers_next_auth_key_configured"] is True
        assert "pk_secret" not in r.text and "cn_secret" not in r.text
        assert "pk_secret" not in store["couriers"]
        assert "postex_merchant_token" not in store  # written to the blob, not the old column

        settings = org_settings.get_org_integration_settings("test-org")
        assert settings.postex_merchant_token == "pk_secret"
        assert settings.couriers_next_auth_key == "cn_secret"
