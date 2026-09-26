"""Per-org courier enablement (Settings > Couriers).

An org turns on the couriers it ships with. Its ledger
(`finances_ledgers.system_key = 'courier_<id>'`, an Asset account for COD the
courier is holding on our behalf) already exists from org creation
(trg_organizations_seed_system_ledgers) for every id in COURIER_CATALOG, so
enabling a courier only flips its `enabled` flag in the encrypted `couriers`
blob (app/org_settings.py), alongside any integration credentials it needs.
The `enable_courier_system_ledger` RPC call below is create-or-return and
mostly a no-op now; it stays so an org whose ledger predates this seeding (or
that already renamed/adopted a same-named ledger by hand) is left alone.

The `enabled` flag drives this screen, the ledger, and courier-bill grouping
(an order of a disabled courier goes on the shared 'Other' bill); nothing in
the booking path checks it.
"""

import asyncio
import logging
from typing import Dict, List, Optional

from app.database import get_supabase
from app.ledger_roles import get_system_ledger_id
from app.models import CourierCredentialField, CourierStatus
from app.org_settings import (
    COURIER_CREDENTIAL_KEYS,
    get_org_integration_settings,
    upsert_org_integration_settings,
)

logger = logging.getLogger("app.couriers")

SYSTEM_KEY_PREFIX = "courier_"

# Ordered: the Settings screen renders couriers in this order. `credentials` is
# empty for a courier with no integration yet (TCS, Local Delivery, SCS) - it still gets the
# toggle and the ledger. The ledger names are seeded by hand in SQL too
# (trg_organizations_seed_system_ledgers) - adding a courier here needs a line there.
COURIER_CATALOG = {
    "postex": {"label": "PostEx", "ledger_code": "1150"},
    "couriers_next": {"label": "Couriers Next", "ledger_code": "1151"},
    # `aliases`: names Shopify reports for this courier - see canonical_courier.
    "tcs": {"label": "TCS", "ledger_code": "1152", "aliases": ["FedEx"]},
    # `local_delivery`: a rider booked on demand rather than a courier company - no
    # booking API, no COD, a delivery charge paid on the spot. See LOCAL_DELIVERY_PLAN.md.
    "local_delivery": {"label": "Local Delivery", "ledger_code": "1153", "kind": "local_delivery"},
    "scs": {"label": "SCS", "ledger_code": "1154"},
}

LOCAL_DELIVERY_IDS = {cid for cid, spec in COURIER_CATALOG.items() if spec.get("kind") == "local_delivery"}
# As stored on orders' `courier`.
LOCAL_DELIVERY_LABELS = [COURIER_CATALOG[cid]["label"] for cid in LOCAL_DELIVERY_IDS]

CREDENTIAL_LABELS = {
    "merchant_token": "Merchant token",
    "auth_key": "Auth key",
}

COURIER_LEDGER_LABELS = {
    f"{SYSTEM_KEY_PREFIX}{cid}": f"Courier {spec['label']}" for cid, spec in COURIER_CATALOG.items()
}

_LABEL_BY_ALIAS = {
    alias.lower(): spec["label"]
    for spec in COURIER_CATALOG.values()
    for alias in spec.get("aliases", ())
}


def canonical_courier(name: str) -> str:
    """Our courier name for a Shopify fulfillment's tracking_company. Shopify only knows
    its own carrier list and auto-assigns a scanned tracking number to one of them - a
    TCS number comes back as "FedEx" - so its name is mapped onto ours on the way in."""
    return _LABEL_BY_ALIAS.get(name.lower(), name)


def _credential_keys(courier_id: str) -> List[str]:
    key = COURIER_CREDENTIAL_KEYS.get(courier_id)
    return [key] if key else []


def _is_enabled(entry: dict, courier_id: str) -> bool:
    """A courier is on when it says so explicitly, or - for a row that predates
    this flag - when it already has a credential configured."""
    if "enabled" in entry:
        return bool(entry["enabled"])
    return any(entry.get(k) for k in _credential_keys(courier_id))


def _status(courier_id: str, couriers: dict, org_id: str, supabase) -> CourierStatus:
    entry = couriers.get(courier_id) or {}
    return CourierStatus(
        id=courier_id,
        label=COURIER_CATALOG[courier_id]["label"],
        enabled=_is_enabled(entry, courier_id),
        credentials=[
            CourierCredentialField(
                key=k, label=CREDENTIAL_LABELS[k], configured=bool(entry.get(k))
            )
            for k in _credential_keys(courier_id)
        ],
        ledger_id=get_system_ledger_id(
            supabase, org_id, f"{SYSTEM_KEY_PREFIX}{courier_id}"
        ),
        fixed_delivery_charge=entry.get("fixed_delivery_charge"),
    )


def enabled_courier_ids(org_id: str) -> List[str]:
    couriers = get_org_integration_settings(org_id).couriers
    return [cid for cid in COURIER_CATALOG if _is_enabled(couriers.get(cid) or {}, cid)]


def fixed_delivery_charges(couriers: dict) -> Dict[str, float]:
    """Settings > Couriers' fixed delivery charge per courier, keyed by the lowercased
    name orders store in `courier`. `couriers` is OrgIntegrationSettings.couriers."""
    return {
        spec["label"].lower(): couriers[cid]["fixed_delivery_charge"]
        for cid, spec in COURIER_CATALOG.items()
        if (couriers.get(cid) or {}).get("fixed_delivery_charge")
    }


async def assign_courier_bills(org_id: str, order_ids: Optional[List[str]]) -> None:
    """Put orders on their (courier, dispatch date) bill - the order's own courier's if
    enabled, else the shared 'Other' one (see assign_courier_bills in SQL). None regroups
    the whole org. Call after any write that can change an order's courier, status or
    dispatch date; it is idempotent.

    Orders whose courier/date moved them off a settled or pre-onboarding bill are kept
    there by the function and only logged - silently rewriting a bill you have closed out
    with the courier would be worse than leaving it stale. Best-effort: a failure leaves
    the orders saved but unassigned until the next call picks them up.

    Also re-derives the status of the Local Delivery bills these orders sit on (settled
    once all delivered), since every write that can change that already calls this."""
    if order_ids is not None and not order_ids:
        return

    def run():
        supabase = get_supabase()
        names = [COURIER_CATALOG[cid]["label"].lower() for cid in enabled_courier_ids(org_id)]
        result = supabase.rpc(
            "assign_courier_bills", {"p_org_id": org_id, "p_order_ids": order_ids, "p_couriers": names}
        ).execute()
        supabase.rpc("sync_local_delivery_bill_status", {
            "p_org_id": org_id, "p_order_ids": order_ids,
            "p_couriers": [label.lower() for label in LOCAL_DELIVERY_LABELS],
        }).execute()
        return result

    try:
        result = await asyncio.to_thread(run)
        blocked = (result.data or [{}])[0].get("blocked") or []
        if blocked:
            logger.warning(
                "[courier-bills] %d order(s) kept on a settled/pre-onboarding bill despite a "
                "changed courier/date: %s", len(blocked), blocked,
            )
    except Exception:
        logger.exception("[courier-bills] assignment failed for org %s", org_id)


def get_org_couriers(org_id: str) -> List[CourierStatus]:
    supabase = get_supabase()
    couriers = get_org_integration_settings(org_id).couriers
    return [_status(cid, couriers, org_id, supabase) for cid in COURIER_CATALOG]


_UNCHANGED = object()


def update_org_courier(
    org_id: str, courier_id: str, enabled: bool, credentials: Dict[str, str],
    fixed_delivery_charge=_UNCHANGED,
) -> CourierStatus:
    if courier_id not in COURIER_CATALOG:
        raise KeyError(courier_id)
    allowed = set(_credential_keys(courier_id))
    unknown = set(credentials) - allowed
    if unknown:
        raise ValueError(f"Unknown credential(s) for {courier_id}: {', '.join(sorted(unknown))}")

    supabase = get_supabase()
    couriers = get_org_integration_settings(org_id).couriers
    entry = couriers.setdefault(courier_id, {})
    entry["enabled"] = enabled
    for key, value in credentials.items():
        if value:
            entry[key] = value
    if fixed_delivery_charge is not _UNCHANGED:
        entry["fixed_delivery_charge"] = fixed_delivery_charge
    upsert_org_integration_settings(org_id, couriers_blob=couriers)

    if enabled:
        spec = COURIER_CATALOG[courier_id]
        supabase.rpc(
            "enable_courier_system_ledger",
            {
                "p_org_id": org_id,
                "p_system_key": f"{SYSTEM_KEY_PREFIX}{courier_id}",
                "p_name": COURIER_LEDGER_LABELS[f"{SYSTEM_KEY_PREFIX}{courier_id}"],
                "p_code": spec["ledger_code"],
            },
        ).execute()

    return _status(courier_id, couriers, org_id, supabase)
