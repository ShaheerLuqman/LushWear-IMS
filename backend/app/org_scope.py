"""Chokepoint for every org-scoped business-table read/write (see
ORGANIZATIONS_USERS_PLAN.md Phase 2). RLS is enabled on these tables too, but
only as defense-in-depth hygiene - this backend always connects with the
Supabase secret key, which bypasses RLS entirely, so `org_table()` (not a
policy) is what actually keeps one organization's data from leaking into
another's. Every route/service file touching one of BUSINESS_TABLES must go
through `org_table()`/`with_org_id()`/`with_org_id_many()` instead of calling
`supabase.table(name)` directly - enforced by tests/test_org_scope_lint.py.
"""

BUSINESS_TABLES = {
    "shopify_products",
    "shopify_variants",
    "shopify_orders",
    "shopify_courier_bills",
    # A view, not a table (courier bills + their derived money figures), but it carries
    # org_id and is read exactly like one - same reasoning as finances_bills_with_paid.
    "shopify_courier_bills_with_totals",
    "shopify_load_sheet_logs",
    "finances_ledgers",
    "finances_transaction_entries",
    "finances_transaction_daily_balances",
    "finances_ledger_balances",
    "finances_transaction_entry_audit_log",
    "shopify_sync_status",
    "finances_journal_entries",
    "finances_journal_lines",
    "finances_bills",
    "finances_bill_items",
    # A view, not a table (bills + derived paid/outstanding/payment_status), but
    # it carries org_id and is read exactly like one, so it belongs behind the
    # same chokepoint.
    "finances_bills_with_paid",
}


class OrgScopedTable:
    """Wraps a `supabase.table(name)` reference so every operation is forced
    through one organization: select/update/delete get `.eq("org_id", org_id)`
    appended immediately (further chaining - `.eq("id", ...)`, `.order(...)`,
    `.execute()`, etc - is the normal, unwrapped postgrest builder from that
    point on), and insert/upsert get `org_id` stamped onto the row(s) instead.
    """

    def __init__(self, real_table, org_id: str):
        self._real = real_table
        self._org_id = org_id

    def select(self, *columns, **kwargs):
        return self._real.select(*columns, **kwargs).eq("org_id", self._org_id)

    def update(self, json, **kwargs):
        return self._real.update(json, **kwargs).eq("org_id", self._org_id)

    def delete(self, **kwargs):
        return self._real.delete(**kwargs).eq("org_id", self._org_id)

    def insert(self, json, **kwargs):
        return self._real.insert(with_org_id_many(json, self._org_id) if isinstance(json, list)
                                  else with_org_id(json, self._org_id), **kwargs)

    def upsert(self, json, **kwargs):
        return self._real.upsert(with_org_id_many(json, self._org_id) if isinstance(json, list)
                                  else with_org_id(json, self._org_id), **kwargs)


def org_table(supabase, org_id: str, name: str) -> OrgScopedTable:
    """Start a query against an org-scoped business table. `org_id` is always
    the caller's own (see `app.auth.get_org_id`) - never accept it as a
    client-supplied value."""
    if name not in BUSINESS_TABLES:
        raise ValueError(f"{name!r} is not a registered business table - add it to BUSINESS_TABLES first")
    return OrgScopedTable(supabase.table(name), org_id)


def with_org_id(row: dict, org_id: str) -> dict:
    """Stamp `org_id` onto a single row dict being inserted/upserted."""
    return {**row, "org_id": org_id}


def with_org_id_many(rows, org_id: str) -> list:
    """Stamp `org_id` onto a list of row dicts being inserted/upserted."""
    return [with_org_id(row, org_id) for row in rows]
