from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class ProductBase(BaseModel):
    name: str
    description: Optional[str] = None
    sku: str
    quantity: int = 0
    price: float = 0.0
    category: Optional[str] = None

class ProductCreate(ProductBase):
    pass

class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    sku: Optional[str] = None
    quantity: Optional[int] = None
    price: Optional[float] = None
    category: Optional[str] = None

class Product(ProductBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

class StockMovement(BaseModel):
    product_id: str
    quantity_change: int
    movement_type: str  # "in" or "out"
    notes: Optional[str] = None

class OrderBase(BaseModel):
    order_number: int
    courier: str
    total_amount: float
    status: str
    delivery_charge: str  # Can be like "211 + 170", "247", "-211"
    receivable: Optional[str] = None  # Can be number or "—"
    folio: Optional[str] = None
    net: Optional[str] = None  # Can be number or "DEC RECD", "PIECE RCVD"

class OrderCreate(OrderBase):
    pass

class OrderUpdate(BaseModel):
    order_number: Optional[int] = None
    courier: Optional[str] = None
    total_amount: Optional[float] = None
    status: Optional[str] = None
    delivery_charge: Optional[str] = None
    receivable: Optional[str] = None
    folio: Optional[str] = None
    net: Optional[str] = None

class Order(OrderBase):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

