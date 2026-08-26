"""One-off: backfills customer_id/name/phone/address/city (see migration
20260826080000_shopify_orders_customer_info.sql) onto orders synced before those
columns existed. Every sync from here on captures this at sync time (see
shopify_sync._apply_customer_fields); this script is the one-time catch-up for orders
already in the table, and is safe to re-run - it only looks up rows where
customer_name is still NULL.

Fetches every order Shopify has for the store in one paginated sweep (the same
technique shopify_sync uses for a periodic sync) rather than looking each backfill
row up individually - for a table with years of history that's the difference between
dozens of requests and tens of thousands.

Usage (from backend/): venv/Scripts/python.exe -m scripts.backfill_order_customer_info <org_id>
"""
import asyncio
import sys
from datetime import datetime, timezone

from app import shopify
from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table
from app.org_settings import ensure_valid_shopify_token, get_org_integration_settings
from app.services.shopify_orders import _customer_info_from_shopify_order
from app.services.shopify_sync import _apply_customer_fields


async def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.backfill_order_customer_info <org_id>")
    org_id = sys.argv[1]

    supabase = get_supabase()
    # Full rows (not just id/order_number) so a batched upsert below can round-trip every
    # other column back unchanged - PostgREST's upsert validates the INSERT side of "INSERT
    # ... ON CONFLICT DO UPDATE" against NOT NULL constraints even when the row already
    # exists, so a payload with only the customer_* columns fails outright on conflict.
    rows = fetch_all(
        lambda: org_table(supabase, org_id, "shopify_orders")
        .select("*")
        .is_("customer_name", "null")
    )
    if not rows:
        print("Nothing to backfill.")
        return
    rows_by_number = {row["order_number"]: row for row in rows}
    print(f"{len(rows)} order(s) need backfilling. Fetching every order from Shopify...")

    org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
    sp_orders, pages = await shopify.fetch_all("orders", f"status=any&limit={shopify.PAGE_LIMIT}", org_creds)
    print(f"Fetched {len(sp_orders)} orders from Shopify across {pages} page(s).")

    updated_at = datetime.now(timezone.utc).isoformat()
    payloads = []
    for sp_order in sp_orders:
        raw_number = sp_order.get("order_number")
        if raw_number is None:
            continue
        try:
            order_number = int(raw_number)
        except (TypeError, ValueError):
            continue
        row = rows_by_number.pop(order_number, None)
        if row is None:
            continue
        customer_info = _customer_info_from_shopify_order(sp_order)
        payload = dict(row)
        _apply_customer_fields(payload, customer_info, row)
        payload["updated_at"] = updated_at
        payloads.append(payload)

    # Batched (like _sync_shopify_orders's own upserts) - one request per 1000 rows
    # instead of one per row, which matters at this row count.
    batch_size = 1000
    for i in range(0, len(payloads), batch_size):
        batch = payloads[i:i + batch_size]
        org_table(supabase, org_id, "shopify_orders").upsert(batch, on_conflict="id").execute()
        print(f"...{min(i + batch_size, len(payloads))}/{len(payloads)} written")

    if rows_by_number:
        print(f"{len(rows_by_number)} order(s) in our DB were not returned by Shopify (deleted/very old?), skipped:")
        for order_number in sorted(rows_by_number):
            print(f"  order_number={order_number}")

    print(f"Updated {len(payloads)} of {len(rows)} orders.")


if __name__ == "__main__":
    asyncio.run(main())
