"""Per-org fiscal calendar (Financial Settings): which day of the month a
"financial month" starts (default 22nd, LushWear's original hardcoded 22-to-21
cycle) and which calendar month the organization's financial year starts in
(default January). Read by routes/orders.py's period-boundary helpers instead
of a hardcoded 22; writable by an org's own admins (routes/org_settings.py).
Same read/write-a-column-on-system_organizations shape as app/features.py's
enabled-features flags.
"""

from app.database import get_supabase

DEFAULT_FISCAL_MONTH_START_DAY = 22
DEFAULT_FISCAL_YEAR_START_MONTH = 1


def get_org_fiscal_settings(org_id: str) -> dict:
    rows = (
        get_supabase()
        .table("system_organizations")
        .select("fiscal_month_start_day, fiscal_year_start_month")
        .eq("id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return {
            "fiscal_month_start_day": DEFAULT_FISCAL_MONTH_START_DAY,
            "fiscal_year_start_month": DEFAULT_FISCAL_YEAR_START_MONTH,
        }
    row = rows[0]
    return {
        "fiscal_month_start_day": row.get("fiscal_month_start_day") or DEFAULT_FISCAL_MONTH_START_DAY,
        "fiscal_year_start_month": row.get("fiscal_year_start_month") or DEFAULT_FISCAL_YEAR_START_MONTH,
    }


def set_org_fiscal_settings(org_id: str, fiscal_month_start_day: int, fiscal_year_start_month: int) -> dict:
    rows = (
        get_supabase()
        .table("system_organizations")
        .update({
            "fiscal_month_start_day": fiscal_month_start_day,
            "fiscal_year_start_month": fiscal_year_start_month,
        })
        .eq("id", org_id)
        .execute()
        .data
        or []
    )
    row = rows[0] if rows else {
        "fiscal_month_start_day": fiscal_month_start_day,
        "fiscal_year_start_month": fiscal_year_start_month,
    }
    return {
        "fiscal_month_start_day": row["fiscal_month_start_day"],
        "fiscal_year_start_month": row["fiscal_year_start_month"],
    }
