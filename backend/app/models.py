from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class ProductBase(BaseModel):
    name: str
    description: Optional[str] = None
    sku: Optional[str] = None
    quantity: int = 0
    price: float = 0.0
    compare_at_price: Optional[float] = None
    cost_price: Optional[float] = None
    category: Optional[str] = None
    # Shopify-specific fields
    shopify_product_id: Optional[int] = None
    shopify_variant_id: Optional[int] = None
    handle: Optional[str] = None
    vendor: Optional[str] = None
    status: Optional[str] = 'active'
    tags: Optional[str] = None
    image_url: Optional[str] = None
    barcode: Optional[str] = None
    weight: Optional[float] = None
    weight_unit: Optional[str] = 'kg'
    shopify_created_at: Optional[datetime] = None
    shopify_updated_at: Optional[datetime] = None

class ProductCreate(ProductBase):
    pass

class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    sku: Optional[str] = None
    quantity: Optional[int] = None
    price: Optional[float] = None
    compare_at_price: Optional[float] = None
    cost_price: Optional[float] = None
    category: Optional[str] = None
    shopify_product_id: Optional[int] = None
    shopify_variant_id: Optional[int] = None
    handle: Optional[str] = None
    vendor: Optional[str] = None
    status: Optional[str] = None
    tags: Optional[str] = None
    image_url: Optional[str] = None
    barcode: Optional[str] = None
    weight: Optional[float] = None
    weight_unit: Optional[str] = None
    shopify_created_at: Optional[datetime] = None
    shopify_updated_at: Optional[datetime] = None

class Product(ProductBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True



class OrderBase(BaseModel):
    order_number: int
    courier: str
    total_amount: float
    status: str
    delivery_charge: Optional[float] = None
    advance_amount: Optional[float] = None
    tax_amount: Optional[float] = None
    cost_price: Optional[float] = None
    folio: Optional[str] = None

class OrderCreate(OrderBase):
    pass

class OrderUpdate(BaseModel):
    order_number: Optional[int] = None
    courier: Optional[str] = None
    total_amount: Optional[float] = None
    status: Optional[str] = None
    delivery_charge: Optional[float] = None
    advance_amount: Optional[float] = None
    tax_amount: Optional[float] = None
    cost_price: Optional[float] = None
    folio: Optional[str] = None

class Order(OrderBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

