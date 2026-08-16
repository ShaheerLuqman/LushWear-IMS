"""System ledgers — `ledgers.system_key`.

These accounts are created with the organization (a trigger on `organizations`,
see supabase_schema.sql) — bar `tax_on_purchases` and `other_expenses`, which
only appear when a bill first carries tax or another expense. All are entirely
server-managed: the API never accepts `system_key` from a client, so there is
nothing to assign, mis-assign, or leave unset. A ledger holding one cannot be
deleted.

They were previously seeded piecemeal by whichever migration first needed one -
so a newly created org had none of them - and the Orders account had to be
picked by hand from a role dropdown.

Names and Natures live in the SQL trigger, which is what actually creates them.
The labels here are only for API error messages.
"""
from app.org_scope import org_table

SYSTEM_LEDGER_LABELS = {
    "cash": "Cash",
    "opening_balance_equity": "Opening Balance Equity",
    "orders": "Orders",
    "inventory": "Inventory",
    # Not seeded with the org - receive_bill creates it the first time a bill
    # carries tax. Still a role, so it still needs a label when one exists.
    "tax_on_purchases": "Tax on Purchases",
    # Same lazy creation, for a bill's other (non-tax, non-stock) expense.
    "other_expenses": "Other Expenses",
}


def get_system_ledger_id(supabase, org_id: str, role: str):
    """The ledger holding `role` for this org, or None if it is somehow missing.

    One lookup for every role, replacing the function each dedicated boolean
    column used to need."""
    resp = (
        org_table(supabase, org_id, "finances_ledgers")
        .select("id")
        .eq("system_key", role)
        .limit(1)
        .execute()
    )
    return resp.data[0]["id"] if resp.data else None
