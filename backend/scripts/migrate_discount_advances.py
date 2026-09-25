"""One-off: converts in-flight discount-as-advance orders to "Partial Advance: <amount>"
tags (see ADVANCE_PAYMENT_PLAN.md). Run once, straight after the sync that reads the tag
(shopify_sync.derive_total_and_advance) is deployed. Before that deploy, the old sync
would still read the discount as the advance.

Candidates are orders on or after the org's onboarding date whose advance can still
re-sync (unfulfilled or fulfilled) and came from a discount: 0 < advance < total. Orders
already carrying the tag are skipped, so the script is safe to re-run. Dry run by default.

Usage (from backend/): venv/Scripts/python.exe -m scripts.migrate_discount_advances <org_id> [--apply]
"""
import asyncio
import sys

import httpx

from app import shopify
from app.database import get_supabase
from app.db_utils import fetch_all
from app.money import money
from app.onboarding_settings import get_org_onboarding_date
from app.org_scope import org_table
from app.org_settings import ensure_valid_shopify_token, get_org_integration_settings
from app.services.shopify_orders import _fetch_shopify_order_by_order_number


async def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--apply"]
    if len(args) != 1:
        raise SystemExit("Usage: python -m scripts.migrate_discount_advances <org_id> [--apply]")
    org_id, apply = args[0], "--apply" in sys.argv

    supabase = get_supabase()
    query = (
        lambda: org_table(supabase, org_id, "shopify_orders")
        .select("order_number, order_status, total_amount, advance_amount, tags")
        .in_("order_status", ["unfulfilled", "fulfilled"])
        .gt("advance_amount", 0)
    )
    onboarding_date = get_org_onboarding_date(org_id)
    rows = fetch_all(lambda: query().gte("order_receiving_date", onboarding_date) if onboarding_date else query())
    candidates = [
        r for r in rows
        if money(r["advance_amount"]) < money(r["total_amount"] or 0)
        and not any(shopify.is_advance_tag(t) for t in (r.get("tags") or "").split(","))
    ]
    if not candidates:
        print("Nothing to migrate.")
        return

    org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
    async with httpx.AsyncClient(timeout=shopify._TIMEOUT) as client:
        for r in sorted(candidates, key=lambda r: r["order_number"]):
            advance = money(r["advance_amount"])
            line = f"#{r['order_number']} ({r['order_status']}): {shopify.partial_advance_tag(advance)}"
            # ponytail: the discount on an unfulfilled order is removed by hand - none existed when
            # this was written, and the order-editing API path was never tested. Automate it with
            # orderEditBegin -> orderEditRemoveDiscount -> orderEditCommit if these become common.
            if r["order_status"] == "unfulfilled":
                line += "  <- also remove its discount in Shopify admin, or the advance is subtracted twice"
            if not apply:
                print(f"[dry run] {line}")
                continue
            sp_order = await _fetch_shopify_order_by_order_number(str(r["order_number"]), org_creds)
            if not sp_order:
                print(f"SKIPPED #{r['order_number']}: not found on Shopify")
                continue
            await shopify.set_advance_tag(int(sp_order["id"]), shopify.partial_advance_tag(advance), org_creds, client)
            print(line)
    if not apply:
        print("Dry run - pass --apply to write the tags.")


if __name__ == "__main__":
    asyncio.run(main())
