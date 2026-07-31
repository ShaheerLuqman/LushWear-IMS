from pydantic import BaseModel, AfterValidator, BeforeValidator, ConfigDict, Field
from typing import Annotated, Literal, Optional, List, Dict, Any
from datetime import datetime, date


def _lower(v):
    return v.strip().lower() if isinstance(v, str) else v


# entry_type is case-normalised before matching so existing clients sending
# "CREDIT"/"Credit" keep working (the route used to lower() it after parsing).
# credit = money received from the ledger (folio); debit = money paid to it.
EntryType = Annotated[Literal["credit", "debit"], BeforeValidator(_lower)]
PieceReceived = Literal["Pending", "Done", "Received"]
# Standard accounting Nature — closed set, not free text, since a typo here
# silently creates an untracked bucket. Drives display grouping only;
# recalc_ledger_balance's formula is the same for every ledger regardless of it.
LedgerType = Literal["Asset", "Liability", "Equity", "Revenue", "Expense"]
# Rejects "" and whitespace-only, which the routes strip and 400 on anyway.
NonBlankStr = Annotated[str, Field(min_length=1), BeforeValidator(lambda v: v.strip() if isinstance(v, str) else v)]

# ==================== VARIANT MODELS ====================

class VariantBase(BaseModel):
    title: str
    quantity: int = 0
    shopify_variant_id: Optional[int] = None

class VariantCreate(VariantBase):
    product_id: Optional[str] = None  # Will be set when creating with product

class VariantUpdate(BaseModel):
    title: Optional[str] = None
    quantity: Optional[int] = None
    shopify_variant_id: Optional[int] = None

class Variant(VariantBase):
    id: str
    product_id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

# ==================== PRODUCT MODELS ====================

class ProductBase(BaseModel):
    name: str
    price: float = 0.0  # Selling price (same across all variants)
    cost_price: Optional[float] = None  # Cost price (same across all variants)
    collection: Optional[str] = None  # Collection name
    image_url: Optional[str] = None
    shopify_product_id: Optional[int] = None

class ProductCreate(ProductBase):
    variants: Optional[List[VariantCreate]] = None

class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    cost_price: Optional[float] = None
    collection: Optional[str] = None
    image_url: Optional[str] = None
    shopify_product_id: Optional[int] = None

class Product(ProductBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class ProductWithVariants(Product):
    variants: List[Variant] = []
    # Computed server-side (sum of variant quantities); the grid and stock totals rely on it.
    total_quantity: int = 0

class ProductCostPriceUpdate(BaseModel):
    id: str
    cost_price: Optional[float] = None

class ProductBatchCostPriceUpdate(BaseModel):
    updates: List[ProductCostPriceUpdate]


class RecalculateOrderCostsByProductBody(BaseModel):
    product_id: str
    created_after: datetime

# ==================== ORDER MODELS ====================

class OrderLineItem(BaseModel):
    # Nullable links to the live product/variant (null if unmatched or later deleted).
    variant_id: Optional[str] = None
    product_id: Optional[str] = None
    # Snapshots captured at write time (survive product rename/delete/later cost changes).
    name: str
    variant_title: Optional[str] = None
    qty: int = 1
    unit_price: Optional[float] = None
    cost_price: Optional[float] = None

class OrderBase(BaseModel):
    order_number: int
    courier: NonBlankStr
    tracking_number: Optional[str] = None
    folio: Optional[str] = None
    # order_status stays open text: live data carries courier codes (CNA/ICA/RFD)
    # beyond the core lifecycle set. See DATABASE.md.
    order_status: NonBlankStr
    piece_received: PieceReceived = "Pending"
    delivery_status: Optional[Dict[str, Any]] = None
    total_amount: float
    advance_amount: float = 0.0
    delivery_charge: float = 0.0
    tax_amount: float = 0.0
    cost_price: float = 0.0
    order_receiving_date: datetime
    line_items: Optional[List[OrderLineItem]] = None
    # Advance reconciliation status (computed): 1=no advance, 2=shopify only,
    # 3=cashbook only, 4=both match, 5=both mismatch
    advance_status: int = 1

class OrderCreate(OrderBase):
    # Narrower than OrderBase: new orders should never be inserted with a null
    # line_items (see 20260728030000_line_items_default_empty_array.sql) - only
    # existing legacy rows may still be null until backfilled.
    line_items: List[OrderLineItem] = Field(default_factory=list)

class OrderUpdate(BaseModel):
    order_number: Optional[int] = None
    courier: Optional[str] = None
    tracking_number: Optional[str] = None
    folio: Optional[str] = None
    order_status: Optional[NonBlankStr] = None
    piece_received: Optional[PieceReceived] = None
    delivery_status: Optional[Dict[str, Any]] = None
    total_amount: Optional[float] = None
    advance_amount: Optional[float] = None
    delivery_charge: Optional[float] = None
    tax_amount: Optional[float] = None
    cost_price: Optional[float] = None
    order_receiving_date: Optional[datetime] = None
    line_items: Optional[List[OrderLineItem]] = None

class Order(OrderBase):
    id: str
    replacement_of_order_no: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

# ==================== CASHBOOK MODELS ====================

class CashbookEntryBase(BaseModel):
    entry_date: date
    entry_type: EntryType
    amount: float = Field(gt=0)
    description: Optional[str] = None
    folio: NonBlankStr  # UUID of the linked ledger
    order_number: Optional[str] = None  # Set only for order-advance entries

class CashbookEntryCreate(CashbookEntryBase):
    # Client-generated per submission. Replaying a create with the same key
    # (double-click, retry after a dropped response) returns the original row
    # instead of inserting a duplicate.
    idempotency_key: Optional[str] = None

class CashbookEntryUpdate(BaseModel):
    entry_date: Optional[date] = None
    entry_type: Optional[EntryType] = None
    amount: Optional[float] = Field(default=None, gt=0)
    description: Optional[str] = None
    folio: Optional[str] = None  # Can update folio, but not set to null
    order_number: Optional[str] = None

class LedgerBalance(BaseModel):
    ledger_id: str
    balance: float = 0.0

class CashbookEntry(CashbookEntryBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Balance(s) of the ledger(s) this write affected, piggybacked on the
    # response so the frontend doesn't need a separate fetch to stay in sync
    # (see ledger_balances / recalc_ledger_balance in supabase_schema.sql).
    ledger_balances: Optional[List[LedgerBalance]] = None

    model_config = ConfigDict(from_attributes=True)

class CashbookDailyBalance(BaseModel):
    id: Optional[str] = None
    balance_date: date
    opening_balance: float = 0.0
    total_credit: float = 0.0
    total_debit: float = 0.0
    closing_balance: float = 0.0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class CashbookDay(BaseModel):
    """Bundles the two reads the Cashbook view always needs together for one
    date, so the frontend fires one request instead of two in parallel."""
    daily_balance: CashbookDailyBalance
    entries: List[CashbookEntry]

class CashbookEntryAuditLog(BaseModel):
    """A deleted cashbook_entries row, snapshotted by a DB trigger (see
    supabase_schema.sql). No "who" field — no per-user identity exists yet."""
    id: str
    entry_id: str
    entry_date: date
    entry_type: EntryType
    amount: float
    description: Optional[str] = None
    folio: str
    order_number: Optional[str] = None
    deleted_at: datetime

    model_config = ConfigDict(from_attributes=True)

# ==================== LEDGER MODELS ====================
# Note: Ledger entries are no longer stored separately.
# Ledgers now show summaries derived from cashbook_entries where folio = ledger.id

class LedgerBase(BaseModel):
    name: NonBlankStr
    type: LedgerType
    include_in_cash_in_hand: bool = False
    # Seeded once at ledger creation; folded into ledger_balances by the
    # recalc_ledger_balance DB trigger so `balance` starts from this instead
    # of 0. Rare to change after creation, but editable (see LedgerUpdate).
    opening_balance: float = 0.0

class LedgerCreate(LedgerBase):
    pass

class LedgerUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[LedgerType] = None
    include_in_cash_in_hand: Optional[bool] = None
    opening_balance: Optional[float] = None

class Ledger(LedgerBase):
    id: str
    # Current running balance: opening_balance + Debit - Credit — see
    # recalc_ledger_balance in supabase_schema.sql. Same formula for every
    # ledger regardless of Nature. From ledger_balances. 0 for a ledger with
    # no opening balance and no entries.
    balance: float = 0.0
    # Only populated by GET /ledgers/{id} (folded in alongside the row fetch
    # for the edit-ledger delete-button guard); omitted (None) from list_ledgers,
    # which would otherwise pay for an extra existence query per row.
    has_entries: Optional[bool] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

# ==================== ORGANIZATION / USER / AUTH MODELS ====================

def _normalize_email(v):
    return v.strip().lower() if isinstance(v, str) else v

def _validate_email(v: str) -> str:
    # Deliberately simple (no email-validator dependency), matching this file's
    # existing hand-rolled-validator convention (NonBlankStr, EntryType) over
    # reaching for pydantic[email] for one field.
    local, _, domain = v.partition("@")
    if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise ValueError("Invalid email address")
    return v

def _validate_new_password(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters")
    return v

# Normalized (lowercased/stripped) so the same address always matches one
# `users.email` row regardless of how a client capitalizes it.
Email = Annotated[str, BeforeValidator(_normalize_email), AfterValidator(_validate_email)]
# Only for *setting* a password (create/bootstrap) - deliberately not reused on
# login, so tightening this minimum later can't retroactively lock out a user
# whose existing (shorter, still-valid) password predates the change.
NewPassword = Annotated[str, AfterValidator(_validate_new_password)]
# The only two org-scoped roles there are (Multi-Org User Membership plan:
# `role` lives on an org_memberships row, one per (person, org) pair - a
# person can have a different role in each org). "superadmin" is deliberately
# not a value here - it's a separate, org-independent identity flag
# (users.is_superadmin), not an org role, so it's not a value this type's
# callers (routes/users.py's org-scoped user management, JWT `role` claims)
# ever need to guard against.
OrgRole = Literal["admin", "staff"]

# The only two feature keys that exist today (Feature Access plan) - controls
# which top-level app sections (Shopify order management, Finance) an org's
# users can see/use. Keep in sync with app/features.py's ALL_FEATURES.
FeatureKey = Literal["orders", "finance"]

class OrganizationBase(BaseModel):
    name: NonBlankStr

class OrganizationCreate(OrganizationBase):
    pass

class Organization(OrganizationBase):
    id: str
    created_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class UserBase(BaseModel):
    email: Email
    role: OrgRole

class UserCreate(UserBase):
    # Both optional: required only when `email` doesn't already exist as an
    # identity (see app/memberships.py's get_or_create_identity). Adding an
    # email that already belongs to someone else's account just grants them a
    # membership in this org - they keep their existing name and password.
    name: Optional[NonBlankStr] = None
    password: Optional[NewPassword] = None

class UserUpdate(BaseModel):
    role: Optional[OrgRole] = None
    is_active: Optional[bool] = None

class UserPublic(UserBase):
    """User shape returned to clients - never includes password_hash. Reflects
    one org_memberships row (Multi-Org User Membership plan) - the same
    identity can appear once per org it belongs to, each with its own role."""
    id: str
    org_id: str
    # Blank for identities created before users.name existed (see
    # supabase/migrations/20260801020000_add_name_to_users.sql).
    name: str = ""
    is_active: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class AccountPublic(BaseModel):
    """GET /auth/me's response shape - the caller's identity plus the
    *current session's* org/role context (from the token, not a DB row):
    since a person can belong to multiple orgs with a different role in each
    (Multi-Org User Membership plan), "current role" only makes sense per
    session, not as a fixed property of the account."""
    id: str
    email: Email
    name: str = ""
    role: Optional[OrgRole] = None
    org_id: Optional[str] = None
    is_superadmin: bool = False
    # Empty when org_id is None (a pure superadmin's own session has no org
    # context) - see app/features.py's get_org_enabled_features.
    enabled_features: List[str] = []
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class MyOrganization(BaseModel):
    """One entry in GET /auth/my-organizations - the orgs the caller has an
    active membership in, with their role in each."""
    id: str
    name: str
    role: OrgRole

class SwitchOrgBody(BaseModel):
    org_id: NonBlankStr

class LoginBody(BaseModel):
    email: Email
    password: NonBlankStr

class BootstrapBody(BaseModel):
    org_name: NonBlankStr
    name: NonBlankStr
    email: Email
    password: NewPassword

class ChangePasswordBody(BaseModel):
    current_password: NonBlankStr
    new_password: NewPassword

class OrgIntegrationSettingsUpdate(BaseModel):
    """All fields optional - an omitted field keeps whatever is already stored
    (see app/org_settings.py's upsert_org_integration_settings)."""
    shopify_store_url: Optional[NonBlankStr] = None
    shopify_access_token: Optional[NonBlankStr] = None
    shopify_api_version: Optional[NonBlankStr] = None
    postex_merchant_token: Optional[NonBlankStr] = None

class OrgIntegrationSettingsPublic(BaseModel):
    """Secrets are never echoed back - only whether each is configured."""
    shopify_store_url: Optional[str] = None
    shopify_api_version: str
    shopify_access_token_configured: bool
    postex_merchant_token_configured: bool

class SuperadminOrgCreate(BaseModel):
    """POST /admin/organizations body - creates an org and its first admin
    user in one step (Superadmin Portal)."""
    org_name: NonBlankStr
    admin_name: NonBlankStr
    admin_email: Email
    admin_password: NewPassword

class OrganizationWithAdmin(BaseModel):
    organization: Organization
    admin_user: UserPublic

class OrgFeaturesUpdate(BaseModel):
    """PUT /admin/organizations/{id}/features body (Superadmin Portal) -
    replaces the org's whole enabled-features set with this list."""
    enabled_features: List[FeatureKey]

class OrgFeaturesPublic(BaseModel):
    enabled_features: List[str]
