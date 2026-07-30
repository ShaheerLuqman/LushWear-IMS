from datetime import datetime, timedelta, timezone

from app.services.shopify_sync import SHOPIFY_SYNC_WINDOW_DAYS, _compute_sync_window_start

NOW = datetime(2026, 7, 30, 12, 0, 0, tzinfo=timezone.utc)
BACKFILL_START = NOW - timedelta(days=SHOPIFY_SYNC_WINDOW_DAYS)


class TestComputeSyncWindowStart:
    def test_uses_last_synced_at_when_present(self):
        checkpoint = "2026-07-30T11:55:00+00:00"
        assert _compute_sync_window_start(checkpoint, NOW) == datetime(2026, 7, 30, 11, 55, 0, tzinfo=timezone.utc)

    def test_parses_a_z_suffixed_timestamp(self):
        checkpoint = "2026-07-30T11:55:00Z"
        assert _compute_sync_window_start(checkpoint, NOW) == datetime(2026, 7, 30, 11, 55, 0, tzinfo=timezone.utc)

    def test_falls_back_to_the_backfill_window_when_missing(self):
        assert _compute_sync_window_start(None, NOW) == BACKFILL_START

    def test_falls_back_to_the_backfill_window_when_blank(self):
        assert _compute_sync_window_start("", NOW) == BACKFILL_START

    def test_falls_back_to_the_backfill_window_when_unparseable(self):
        assert _compute_sync_window_start("not-a-timestamp", NOW) == BACKFILL_START
