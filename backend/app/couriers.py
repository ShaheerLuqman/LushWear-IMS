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

The `enabled` flag drives this screen and the ledger only; nothing in the
booking path checks it.
"""

from typing import Dict, List

from app.database import get_supabase
from app.ledger_roles import get_system_ledger_id
from app.models import CourierCredentialField, CourierStatus
from app.org_settings import (
    COURIER_CREDENTIAL_KEYS,
    get_org_integration_settings,
    upsert_org_integration_settings,
)

SYSTEM_KEY_PREFIX = "courier_"

# Ordered: the Settings screen renders couriers in this order. `credentials` is
# empty for a courier with no integration yet (TCS, Bykea) - it still gets the
# toggle and the ledger.
COURIER_CATALOG = {
    "postex": {"label": "PostEx", "ledger_code": "1150"},
    "couriers_next": {"label": "Couriers Next", "ledger_code": "1151"},
    "tcs": {"label": "TCS", "ledger_code": "1152"},
    "bykea": {"label": "Bykea", "ledger_code": "1153"},
}

CREDENTIAL_LABELS = {
    "merchant_token": "Merchant token",
    "auth_key": "Auth key",
}

COURIER_LEDGER_LABELS = {
    f"{SYSTEM_KEY_PREFIX}{cid}": spec["label"] for cid, spec in COURIER_CATALOG.items()
}


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
                "p_name": spec["label"],
                "p_code": spec["ledger_code"],
            },
        ).execute()

    return _status(courier_id, couriers, org_id, supabase)
