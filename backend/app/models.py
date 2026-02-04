from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime

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
    
    class Config:
        from_attributes = True

# ==================== PRODUCT MODELS ====================

class ProductBase(BaseModel):
    name: str
    price: float = 0.0  # Selling price (same across all variants)
    cost_price: Optional[float] = None  # Cost price (same across all variants)
    image_url: Optional[str] = None
    shopify_product_id: Optional[int] = None

class ProductCreate(ProductBase):
    variants: Optional[List[VariantCreate]] = None

class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    cost_price: Optional[float] = None
    image_url: Optional[str] = None
    shopify_product_id: Optional[int] = None

class Product(ProductBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

class ProductWithVariants(Product):
    variants: List[Variant] = []

class ProductCostPriceUpdate(BaseModel):
    id: str
    cost_price: Optional[float] = None

class ProductBatchCostPriceUpdate(BaseModel):
    updates: List[ProductCostPriceUpdate]

# ==================== ORDER MODELS ====================

class OrderBase(BaseModel):
    order_number: int
    courier: str
    tracking_number: Optional[str] = None
    order_status: str
    piece_received: str = "Pending"  # Pending | Done | Received
    delivery_status: Optional[Dict[str, Any]] = None
    total_amount: float
    advance_amount: float = 0.0
    delivery_charge: float = 0.0
    tax_amount: float = 0.0
    cost_price: float = 0.0
    order_receiving_date: Optional[datetime] = None
    items: Optional[List[str]] = None

class OrderCreate(OrderBase):
    pass

class OrderUpdate(BaseModel):
    order_number: Optional[int] = None
    courier: Optional[str] = None
    tracking_number: Optional[str] = None
    order_status: Optional[str] = None
    piece_received: Optional[str] = None
    delivery_status: Optional[Dict[str, Any]] = None
    total_amount: Optional[float] = None
    advance_amount: Optional[float] = None
    delivery_charge: Optional[float] = None
    tax_amount: Optional[float] = None
    cost_price: Optional[float] = None
    order_receiving_date: Optional[datetime] = None
    items: Optional[List[str]] = None

class Order(OrderBase):
    id: str
    order_receiving_date: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True
