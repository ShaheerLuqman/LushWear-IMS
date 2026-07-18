from datetime import timedelta, timezone

# Pakistan Time (PKT) is UTC+5. Order periods and report timestamps are expressed
# in PKT, so this is shared rather than redefined per module.
PKT_TIMEZONE = timezone(timedelta(hours=5))
