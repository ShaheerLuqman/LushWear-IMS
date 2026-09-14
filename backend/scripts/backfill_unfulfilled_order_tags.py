"""One-off: backfills the tags column (see migration 20260914120000_shopify_orders_tags.sql)
onto currently-unfulfilled orders synced before it existed. Every sync from here on captures
this at sync time (see shopify_sync._reconcile_one_order); this script is the one-time
catch-up so get_unfulfilled_orders (orders.py) doesn't show blank tags until each order's
next sync, and is safe to re-run - it only looks up rows where tags is still NULL.

Scoped to unfulfilled orders only, not the whole store's history (contrast
backfill_order_customer_info.py) - that's the only set get_unfulfilled_orders reads tags
for, and _fetch_shopify_unfulfilled_orders's one-request sweep (+ per-row fallback for
whatever it misses) is exactly sized for that, unlike a full paginated store sweep.

Usage (from backend/): venv/Scripts/python.exe -m scripts.backfill_unfulfilled_order_tags <org_id>
"""
import asyncio
import sys
from datetime import datetime, timezone

from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table
from app.org_settings import ensure_valid_shopify_token, get_org_integration_settings
from app.services.shopify_orders import _fetch_shopify_order_by_order_number, _fetch_shopify_unfulfilled_orders


async def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.backfill_unfulfilled_order_tags <org_id>")
    org_id = sys.argv[1]

    supabase = get_supabase()
    rows = fetch_all(
        lambda: org_table(supabase, org_id, "shopify_orders")
        .select("id, order_number")
        .eq("order_status", "unfulfilled")
        .is_("tags", "null")
    )
    if not rows:
        print("Nothing to backfill.")
        return
    print(f"{len(rows)} unfulfilled order(s) need backfilling.")

    org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
    sp_orders = await _fetch_shopify_unfulfilled_orders(org_creds)
    tags_by_number = {}
    for o in sp_orders:
        try:
            tags_by_number[int(o.get("order_number"))] = o.get("tags") or ""
        except (TypeError, ValueError):
            continue
    print(f"Sweep matched {sum(1 for r in rows if r['order_number'] in tags_by_number)}/{len(rows)}; "
          f"fetching the rest individually...")

    missing = [row for row in rows if row["order_number"] not in tags_by_number]
    for row in missing:
        sp_order = await _fetch_shopify_order_by_order_number(str(row["order_number"]), org_creds)
        tags_by_number[row["order_number"]] = (sp_order.get("tags") or "") if sp_order else ""

    updated_at = datetime.now(timezone.utc).isoformat()
    for row in rows:
        org_table(supabase, org_id, "shopify_orders").update({
            "tags": tags_by_number.get(row["order_number"], ""),
            "updated_at": updated_at,
        }).eq("id", row["id"]).execute()

    print(f"Updated {len(rows)} order(s).")


if __name__ == "__main__":
    asyncio.run(main())
