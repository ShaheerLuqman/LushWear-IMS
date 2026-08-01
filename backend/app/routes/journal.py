"""Double-entry general ledger (FINANCE_ACCOUNTING_PLAN.md Phase 1).

Reads come straight from journal_entries/journal_lines through org_table.
Writes go through the post_journal_entry() Postgres function rather than two
PostgREST inserts: the header and its lines have to land in one transaction for
the deferred debits=credits constraint to be checkable at all, and two
PostgREST calls are two transactions (the first would fail on its own).
"""
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_org_id, require_auth
from app.database import get_supabase
from app.models import JournalEntry, JournalEntryCreate, TrialBalance
from app.org_scope import org_table

router = APIRouter(prefix="/journal", tags=["journal"])

# A day's postings for one busy org, not "everything ever" - the journal grows
# without bound and nothing in the UI pages it yet.
MAX_ENTRIES = 500


def _attach_lines(supabase, org_id: str, entries: List[dict]) -> List[dict]:
    """One extra query for every entry's lines, rather than one per entry."""
    if not entries:
        return []
    resp = (
        org_table(supabase, org_id, "journal_lines")
        .select("id, journal_id, account_id, debit, credit, description")
        .in_("journal_id", [e["id"] for e in entries])
        .execute()
    )
    by_journal = {}
    for line in resp.data or []:
        by_journal.setdefault(line["journal_id"], []).append(line)
    for entry in entries:
        entry["lines"] = by_journal.get(entry["id"], [])
    return entries


@router.get("/entries", response_model=List[JournalEntry])
async def list_journal_entries(
    start_date: Optional[date] = Query(None, description="Filter from entry_date (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Filter to entry_date (YYYY-MM-DD)"),
    account_id: Optional[str] = Query(None, description="Only entries touching this account"),
    org_id: str = Depends(get_org_id),
):
    supabase = get_supabase()

    journal_ids = None
    if account_id:
        lines_resp = (
            org_table(supabase, org_id, "journal_lines")
            .select("journal_id")
            .eq("account_id", account_id)
            .execute()
        )
        journal_ids = list({row["journal_id"] for row in lines_resp.data or []})
        if not journal_ids:
            return []

    query = (
        org_table(supabase, org_id, "journal_entries")
        .select("*")
        .order("entry_date", desc=True)
        .order("created_at", desc=True)
        .limit(MAX_ENTRIES)
    )
    if start_date:
        query = query.gte("entry_date", start_date.isoformat())
    if end_date:
        query = query.lte("entry_date", end_date.isoformat())
    if journal_ids is not None:
        query = query.in_("id", journal_ids)

    return _attach_lines(supabase, org_id, query.execute().data or [])


@router.post("/entries", response_model=JournalEntry)
async def create_journal_entry(
    entry: JournalEntryCreate,
    org_id: str = Depends(get_org_id),
    auth: dict = Depends(require_auth),
):
    """Post a manual journal entry — the one thing the cashbook could never do,
    since every cashbook entry is forced to touch cash. Balance and one-side-per-
    line are validated by JournalEntryCreate before we get here; the RPC
    re-checks them (plus that every account belongs to this org) because it is
    also reachable from other posting code."""
    supabase = get_supabase()
    try:
        resp = supabase.rpc("post_journal_entry", {
            "p_org_id": org_id,
            "p_entry_date": entry.entry_date.isoformat(),
            "p_lines": [line.model_dump() for line in entry.lines],
            "p_narration": entry.narration,
            "p_voucher_type": "manual",
            # `sub` is the users.id this token was minted for (app/auth.py).
            "p_created_by": auth.get("sub"),
        }).execute()
    except Exception as e:
        # The RPC raises for an unbalanced entry, a zero amount, or an account
        # belonging to another org — all caller errors, not server faults.
        raise HTTPException(status_code=400, detail=str(e))

    journal_id = resp.data
    if not journal_id:
        raise HTTPException(status_code=500, detail="Failed to post journal entry")

    created = (
        org_table(supabase, org_id, "journal_entries")
        .select("*")
        .eq("id", journal_id)
        .limit(1)
        .execute()
    )
    if not created.data:
        raise HTTPException(status_code=500, detail="Journal entry was posted but could not be read back")
    return _attach_lines(supabase, org_id, created.data)[0]


@router.get("/trial-balance", response_model=TrialBalance)
async def get_trial_balance(
    as_of: Optional[date] = Query(None, description="Balances as at this date (default today)"),
    org_id: str = Depends(get_org_id),
):
    """Every account with a non-zero balance, split into its Debit or Credit
    column. `balanced` is the control that did not exist before Phase 1: if the
    two totals ever disagree, something has written to the tables around the
    constraint."""
    target = as_of or date.today()
    resp = get_supabase().rpc("get_trial_balance", {
        "p_org_id": org_id,
        "p_as_of": target.isoformat(),
    }).execute()

    rows = resp.data or []
    total_debit = round(sum(float(r["debit"] or 0) for r in rows), 2)
    total_credit = round(sum(float(r["credit"] or 0) for r in rows), 2)
    return {
        "as_of": target,
        "rows": rows,
        "total_debit": total_debit,
        "total_credit": total_credit,
        "balanced": total_debit == total_credit,
    }
