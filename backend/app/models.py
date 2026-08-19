from pydantic import BaseModel, AfterValidator, BeforeValidator, ConfigDict, Field, model_validator
from typing import Annotated, Literal, Optional, List, Dict, Any
from datetime import datetime, date


def _lower(v):
    return v.strip().lower() if isinstance(v, str) else v


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
    is_active: Optional[bool] = None

class Product(ProductBase):
    id: str
    is_active: bool = True
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
    # 3=transaction only, 4=both match, 5=both mismatch
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

# ==================== TRANSACTION MODELS ====================

class TransactionEntryBase(BaseModel):
    """An entry names both of its sides; NULL on a side means cash.

    from_account_id is credited (money came from there), to_account_id is
    debited (money went there). An entry only moves the cash account when one side
    is None — which is how a bank-to-supplier transfer stays out of the cash
    balance."""
    entry_date: date
    amount: float = Field(gt=0)
    description: Optional[str] = None
    from_account_id: Optional[str] = None
    to_account_id: Optional[str] = None
    order_number: Optional[str] = None  # Set only for order-advance entries

    @model_validator(mode="after")
    def _two_distinct_sides(self):
        # Mirrors transaction_entries_two_sides_check: both None is cash-to-cash,
        # which moves nothing; equal sides is an account paying itself.
        if self.from_account_id is None and self.to_account_id is None:
            raise ValueError("an entry needs a From or a To account (the empty side is cash)")
        if self.from_account_id is not None and self.from_account_id == self.to_account_id:
            raise ValueError("From and To cannot be the same account")
        return self

class TransactionEntryCreate(TransactionEntryBase):
    # Client-generated per submission. Replaying a create with the same key
    # (double-click, retry after a dropped response) returns the original row
    # instead of inserting a duplicate.
    idempotency_key: Optional[str] = None

class TransactionEntryUpdate(BaseModel):
    entry_date: Optional[date] = None
    amount: Optional[float] = Field(default=None, gt=0)
    description: Optional[str] = None
    from_account_id: Optional[str] = None
    to_account_id: Optional[str] = None
    order_number: Optional[str] = None

class LedgerBalance(BaseModel):
    ledger_id: str
    balance: float = 0.0

class TransactionEntry(TransactionEntryBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Balance(s) of the ledger(s) this write affected, piggybacked on the
    # response so the frontend doesn't need a separate fetch to stay in sync
    # (see ledger_balances / recalc_ledger_balance in supabase_schema.sql).
    ledger_balances: Optional[List[LedgerBalance]] = None

    model_config = ConfigDict(from_attributes=True)

class TransactionDailyBalance(BaseModel):
    id: Optional[str] = None
    balance_date: date
    opening_balance: float = 0.0
    total_credit: float = 0.0
    total_debit: float = 0.0
    closing_balance: float = 0.0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class TransactionDay(BaseModel):
    """Bundles the two reads the Transactions view always needs together for one
    date, so the frontend fires one request instead of two in parallel."""
    daily_balance: TransactionDailyBalance
    entries: List[TransactionEntry]

class TransactionEntryAuditLog(BaseModel):
    """A deleted transaction_entries row, snapshotted by a DB trigger (see
    supabase_schema.sql). No "who" field — no per-user identity exists yet."""
    id: str
    entry_id: str
    entry_date: date
    amount: float
    description: Optional[str] = None
    from_account_id: Optional[str] = None
    to_account_id: Optional[str] = None
    order_number: Optional[str] = None
    deleted_at: datetime

    model_config = ConfigDict(from_attributes=True)

# ==================== LEDGER MODELS ====================
# Note: Ledger entries are no longer stored separately.
# Ledgers show a statement built from their journal lines (get_ledger_statement).

class LedgerBase(BaseModel):
    name: NonBlankStr
    type: LedgerType
    include_in_cash_in_hand: bool = False

    # Party fields (Phase 2). A supplier is a ledger rather than a separate
    # contact, so these live here; they stay empty on non-party accounts like
    # Rent or Sales.
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    tax_number: Optional[str] = None
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
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    tax_number: Optional[str] = None

class Ledger(LedgerBase):
    id: str
    # Current running balance: Debit - Credit over this account's journal lines
    # — see recalc_ledger_balance in supabase_schema.sql. Same formula for every
    # ledger regardless of Nature, so a Credit-normal account (Liability/Equity/
    # Revenue) reads negative here; the UI flips the sign and appends Dr/Cr.
    # From ledger_balances. 0 for an account with no postings.
    balance: float = 0.0
    # Chart-of-accounts fields (Phase 1). system_key is read-only: system
    # ledgers are created with the organization and never assigned by a client
    # (see app/ledger_roles.py), so it is absent from LedgerBase/LedgerUpdate.
    # Null means an ordinary account.
    code: Optional[str] = None
    system_key: Optional[str] = None
    is_cash_equivalent: bool = False
    # Only populated by GET /ledgers/{id} (folded in alongside the row fetch
    # for the edit-ledger delete-button guard); omitted (None) from list_ledgers,
    # which would otherwise pay for an extra existence query per row.
    has_entries: Optional[bool] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

# ==================== JOURNAL MODELS ====================
# The double-entry general ledger (FINANCE_ACCOUNTING_PLAN.md Phase 1). Amounts
# are unsigned and split across debit/credit rather than one signed column —
# the form every statement and trial balance expects.

class JournalLineInput(BaseModel):
    account_id: NonBlankStr
    debit: float = 0.0
    credit: float = 0.0
    description: Optional[str] = None

    @model_validator(mode="after")
    def _exactly_one_side(self):
        # Mirrors the journal_lines_one_side_only CHECK, so a bad line is a 422
        # from the API rather than a raw Postgres error surfaced from the RPC.
        if self.debit < 0 or self.credit < 0:
            raise ValueError("debit and credit cannot be negative")
        if (self.debit > 0) == (self.credit > 0):
            raise ValueError("each line must have exactly one of debit or credit greater than 0")
        return self

class JournalEntryCreate(BaseModel):
    entry_date: date
    lines: List[JournalLineInput]
    narration: Optional[str] = None

    @model_validator(mode="after")
    def _must_balance(self):
        # The database enforces this too (deferred constraint trigger); checking
        # here turns it into a readable 422 instead of a 500 from the RPC.
        if len(self.lines) < 2:
            raise ValueError("a journal entry needs at least two lines")
        total_debit = round(sum(line.debit for line in self.lines), 2)
        total_credit = round(sum(line.credit for line in self.lines), 2)
        if total_debit != total_credit:
            raise ValueError(f"entry does not balance: debits {total_debit}, credits {total_credit}")
        if total_debit == 0:
            raise ValueError("a journal entry must move a non-zero amount")
        return self

class JournalLine(BaseModel):
    id: str
    account_id: str
    debit: float = 0.0
    credit: float = 0.0
    description: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)

class JournalEntry(BaseModel):
    id: str
    entry_date: date
    voucher_type: str
    narration: Optional[str] = None
    # What produced this entry: 'transaction_entry', 'opening_balance', 'manual',
    # and the document types later phases add.
    source_type: Optional[str] = None
    source_id: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    lines: List[JournalLine] = []

    model_config = ConfigDict(from_attributes=True)

class TrialBalanceRow(BaseModel):
    account_id: str
    code: Optional[str] = None
    name: str
    type: str
    debit: float = 0.0
    credit: float = 0.0

class TrialBalance(BaseModel):
    """Accounts with a non-zero balance as of a date, plus the two totals whose
    equality is the whole point of the report. `balanced` is precomputed so the
    UI doesn't re-derive the comparison (and disagree about rounding)."""
    as_of: date
    rows: List[TrialBalanceRow]
    total_debit: float
    total_credit: float
    balanced: bool

# ==================== PURCHASE BILL MODELS ====================
# Accounts payable (FINANCE_ACCOUNTING_PLAN.md Phase 2). A supplier is a ledger,
# not a separate contact — so `supplier_id` is a ledgers.id and the supplier's
# own account is what a bill credits. There is no Accounts Payable control
# account.

# Stored status only. Paid / partially paid is derived from the allocations by
# the bills_with_paid view, so the two can never disagree.
BillStatus = Literal["draft", "received", "cancelled"]

class BillItemInput(BaseModel):
    # No per-line account: every line is stock and posts to the org's Inventory
    # account. Anything paid on the spot (ads, rent, packaging) belongs in a
    # transaction against its expense ledger, not on a bill.
    quantity: float = Field(gt=0)
    unit_cost: float = Field(ge=0)
    description: Optional[str] = None
    product_id: Optional[str] = None
    variant_id: Optional[str] = None

    @property
    def amount(self) -> float:
        return round(self.quantity * self.unit_cost, 2)

class BillItem(BaseModel):
    id: str
    quantity: float
    unit_cost: float
    amount: float
    description: Optional[str] = None
    product_id: Optional[str] = None
    variant_id: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)

class BillBase(BaseModel):
    supplier_id: NonBlankStr
    bill_date: date
    supplier_ref: Optional[str] = None
    discount_amount: float = Field(default=0.0, ge=0)
    tax_amount: float = Field(default=0.0, ge=0)
    other_expense_amount: float = Field(default=0.0, ge=0)
    notes: Optional[str] = None

class BillCreate(BillBase):
    items: List[BillItemInput]

    @model_validator(mode="after")
    def _needs_lines(self):
        if not self.items:
            raise ValueError("a bill needs at least one line")
        return self

class BillUpdate(BaseModel):
    supplier_id: Optional[str] = None
    bill_date: Optional[date] = None
    supplier_ref: Optional[str] = None
    discount_amount: Optional[float] = Field(default=None, ge=0)
    tax_amount: Optional[float] = Field(default=None, ge=0)
    other_expense_amount: Optional[float] = Field(default=None, ge=0)
    notes: Optional[str] = None
    # Replaces the whole line set when present — a bill's lines are edited as a
    # unit, and diffing them per row would buy nothing on a draft.
    items: Optional[List[BillItemInput]] = None

class Bill(BillBase):
    id: str
    bill_number: str
    status: BillStatus
    subtotal: float = 0.0
    total: float = 0.0
    # From bills_with_paid, which derives settlement from the supplier's ledger
    # balance applied oldest-bill-first — payments are plain transaction entries and
    # are never allocated to a bill. payment_status is the stored status while a
    # bill is draft/cancelled, and unpaid/partially_paid/paid once received.
    paid_amount: float = 0.0
    outstanding: float = 0.0
    payment_status: Optional[str] = None
    stock_applied: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    items: List[BillItem] = []

    model_config = ConfigDict(from_attributes=True)

class ApAgeingRow(BaseModel):
    supplier_id: str
    supplier_name: str
    outstanding: float = 0.0
    current: float = 0.0
    d1_30: float = 0.0
    d31_60: float = 0.0
    d61_90: float = 0.0
    d90_plus: float = 0.0

# ==================== ORGANIZATION / USER / AUTH MODELS ====================

def _normalize_email(v):
    return v.strip().lower() if isinstance(v, str) else v

def _validate_email(v: str) -> str:
    # Deliberately simple (no email-validator dependency), matching this file's
    # existing hand-rolled-validator convention (NonBlankStr, NewPassword) over
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
