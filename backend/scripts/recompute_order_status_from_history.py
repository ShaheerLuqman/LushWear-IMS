"""One-off: recomputes order_status for orders received before 2025-12-31, from their
already-stored delivery_status.status_history - no courier API calls. Reuses the same
derivation a live delivery-status fetch applies afterward, so orders whose stored
history already contains a delivered/returned/RFD/ICA/CNA event get credited for it
even if order_status was never updated at the time. The latest relevant status in
history wins, including reverting a stale "returned"/"delivered" order_status - see
_derive_order_status_from_latest/_classify_status in app.routes.orders.

Cancelled is excluded: it's a Shopify-native state with no delivery-status
counterpart, not something courier history can confirm or contradict.

Usage (from backend/): venv/Scripts/python.exe -m scripts.recompute_order_status_from_history <org_id>
"""
import sys
from datetime import datetime, timezone

from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table
from app.routes.orders import _derive_order_status_from_latest

CUTOFF = "2025-12-31T00:00:00+00:00"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.recompute_order_status_from_history <org_id>")
    org_id = sys.argv[1]

    supabase = get_supabase()
    orders = fetch_all(
        lambda: org_table(supabase, org_id, "shopify_orders")
        .select("id, order_number, order_status, delivery_status, piece_received")
        .lt("order_receiving_date", CUTOFF)
        .not_.is_("delivery_status", "null")
    )

    updated_at = datetime.now(timezone.utc).isoformat()
    updated = 0
    for order in orders:
        if (order.get("order_status") or "").strip().lower() == "cancelled":
            continue
        derived = _derive_order_status_from_latest(order.get("delivery_status"))
        if not derived or derived == order.get("order_status"):
            continue
        update_payload = {"order_status": derived, "updated_at": updated_at}
        if derived == "delivered" and (order.get("piece_received") or "").strip().lower() == "pending":
            update_payload["piece_received"] = "Done"
        org_table(supabase, org_id, "shopify_orders").update(update_payload).eq("id", order["id"]).execute()
        updated += 1
        print(f"order_number={order.get('order_number')}: {order.get('order_status')!r} -> {derived!r}")

    print(f"Updated {updated} of {len(orders)} orders.")


if __name__ == "__main__":
    main()
