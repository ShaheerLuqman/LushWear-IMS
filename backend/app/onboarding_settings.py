"""Per-org onboarding date: the day the organization starts using the software,
before which no transaction entry, journal entry or bill may exist. The cutoff
itself is enforced by the enforce_onboarding_cutoff trigger (see
supabase/migrations/20260922000000_org_onboarding_date.sql) so that plpgsql
posting code is covered too; this module only reads and writes the setting.

Same read/write-a-column-on-system_organizations shape as app/fiscal_settings.py.
"""

from datetime import date
from typing import Iterable, Optional, Union

from app.database import get_supabase


def get_org_onboarding_date(org_id: str) -> Optional[str]:
    rows = (
        get_supabase()
        .table("system_organizations")
        .select("onboarding_date")
        .eq("id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0]["onboarding_date"] if rows else None


def get_earliest_financial_date(org_id: str) -> Optional[str]:
    """The org's oldest dated financial row across all three cutoff-guarded
    tables, or None when it has none yet."""
    supabase = get_supabase()
    earliest = [
        (
            supabase.table(table)
            .select(column)
            .eq("org_id", org_id)
            .order(column, desc=False)
            .limit(1)
            .execute()
            .data
            or [{}]
        )[0].get(column)
        for table, column in (
            ("finances_transaction_entries", "entry_date"),
            ("finances_journal_entries", "entry_date"),
            ("finances_bills", "bill_date"),
        )
    ]
    found = [d for d in earliest if d]
    return min(found) if found else None


def set_org_onboarding_date(org_id: str, onboarding_date: Optional[date]) -> Optional[str]:
    """Raises ValueError when the date would leave existing rows stranded before
    the cutoff - an org can only move its onboarding date back, never forward
    past data it already has. Clearing it (None) removes the cutoff."""
    if onboarding_date is not None:
        earliest = get_earliest_financial_date(org_id)
        if earliest and onboarding_date.isoformat() > earliest:
            raise ValueError(
                f"Onboarding date cannot be later than the earliest existing entry ({earliest})"
            )

    supabase = get_supabase()
    supabase.table("system_organizations").update({
        "onboarding_date": onboarding_date.isoformat() if onboarding_date else None,
    }).eq("id", org_id).execute()
    # The opening voucher's date is derived from onboarding_date, but only
    # ledgers_opening_balance_trigger rebuilds it - without this it would keep
    # the old date until someone happened to edit an opening balance.
    supabase.rpc("sync_opening_balance_journal", {"p_org_id": org_id}).execute()
    return onboarding_date.isoformat() if onboarding_date else None


def apply_onboarding_cutoff(org_id: str, onboarding_date: date) -> dict:
    """Moves the onboarding date forward onto existing history: deletes every
    transaction entry, journal entry and bill before it, folding their net
    position into each ledger's opening balance. Irreversible - the caller is
    responsible for having asked first. See
    supabase/migrations/20260922010000_onboarding_cutoff_purge.sql."""
    return get_supabase().rpc("apply_onboarding_cutoff", {
        "p_org_id": org_id,
        "p_date": onboarding_date.isoformat(),
    }).execute().data


def ensure_not_before_onboarding(supabase, org_id: str, dates: Iterable[Union[date, str]]) -> None:
    """Raises ValueError when any date falls before the org's onboarding date.
    The trigger would silently drop such a row; this exists so the routes can
    answer a person with a 400 that says why. Takes the caller's client rather
    than opening its own, the same way org_table/get_system_ledger_id do."""
    rows = (
        supabase.table("system_organizations")
        .select("onboarding_date")
        .eq("id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    onboarding = rows[0].get("onboarding_date") if rows else None
    if not onboarding:
        return
    earliest = min(d.isoformat() if isinstance(d, date) else str(d) for d in dates)
    if earliest < onboarding:
        raise ValueError(f"Date {earliest} is before the organization's onboarding date ({onboarding})")
