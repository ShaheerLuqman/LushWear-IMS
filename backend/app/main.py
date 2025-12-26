from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import products, orders

app = FastAPI(
    title="Inventory Management System",
    description="API for managing inventory",
    version="1.0.0"
)

# Configure CORS for Electron app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(products.router, prefix="/api")
app.include_router(orders.router, prefix="/api")

@app.get("/")
async def root():
    return {"message": "Inventory Management System API", "status": "running"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

