from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class ProductBase(BaseModel):
    name: str
    price: float = 0.0
    cost_price: Optional[float] = None
    quantity: int = 0
    image_url: Optional[str] = None
    # Shopify-specific fields (for syncing)
    shopify_product_id: Optional[int] = None
    shopify_variant_id: Optional[int] = None

class ProductCreate(ProductBase):
    pass

class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    cost_price: Optional[float] = None
    quantity: Optional[int] = None
    image_url: Optional[str] = None
    shopify_product_id: Optional[int] = None
    shopify_variant_id: Optional[int] = None

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

