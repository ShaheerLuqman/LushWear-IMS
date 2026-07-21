from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from typing import Annotated, Literal, Optional, List, Dict, Any
from datetime import datetime, date


def _lower(v):
    return v.strip().lower() if isinstance(v, str) else v


# entry_type is case-normalised before matching so existing clients sending
# "INFLOW"/"Inflow" keep working (the route used to lower() it after parsing).
EntryType = Annotated[Literal["inflow", "outflow"], BeforeValidator(_lower)]
PieceReceived = Literal["Pending", "Done", "Received"]
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
    # Snapshots captured at write time (survive product rename/delete).
    name: str
    variant_title: Optional[str] = None
    qty: int = 1
    unit_price: Optional[float] = None

class OrderBase(BaseModel):
    order_number: NonBlankStr
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
    items: Optional[List[str]] = None
    # Structured order lines (replaces the legacy "Name - Variant" strings in items).
    line_items: Optional[List[OrderLineItem]] = None
    # Advance reconciliation status (computed): 1=no advance, 2=shopify only,
    # 3=cashbook only, 4=both match, 5=both mismatch
    advance_status: int = 1

class OrderCreate(OrderBase):
    pass

class OrderUpdate(BaseModel):
    order_number: Optional[str] = None
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
    items: Optional[List[str]] = None
    line_items: Optional[List[OrderLineItem]] = None

class Order(OrderBase):
    id: str
    replacement_of_order_no: Optional[str] = None
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
    pass

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
    total_inflow: float = 0.0
    total_outflow: float = 0.0
    closing_balance: float = 0.0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class CashbookDay(BaseModel):
    """Bundles the two reads the Cashbook view always needs together for one
    date, so the frontend fires one request instead of two in parallel."""
    daily_balance: CashbookDailyBalance
    entries: List[CashbookEntry]

# ==================== LEDGER MODELS ====================
# Note: Ledger entries are no longer stored separately.
# Ledgers now show summaries derived from cashbook_entries where folio = ledger.id

class LedgerBase(BaseModel):
    name: NonBlankStr
    section: NonBlankStr  # free text, e.g. Cash/Bank, Expense, Vendors, Sales

class LedgerCreate(LedgerBase):
    pass

class LedgerUpdate(BaseModel):
    name: Optional[str] = None
    section: Optional[str] = None

class Ledger(LedgerBase):
    id: str
    # Current running balance (incoming - outgoing), from ledger_balances.
    # 0 for a ledger with no cashbook entries yet.
    balance: float = 0.0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)
