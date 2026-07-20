import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY: str = os.getenv("SUPABASE_SECRET_KEY")
    SUPABASE_PUBLISHABLE_KEY: str = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
    # Shopify configuration
    SHOPIFY_STORE_URL: str = os.getenv("SHOPIFY_STORE_URL", "staginglushwear.myshopify.com")
    SHOPIFY_ADMIN_API_TOKEN: str = os.getenv("SHOPIFY_ADMIN_API_TOKEN", "")
    SHOPIFY_API_KEY: str = os.getenv("SHOPIFY_API_KEY", "")
    SHOPIFY_API_SECRET_KEY: str = os.getenv("SHOPIFY_API_SECRET_KEY", "")
    SHOPIFY_API_VERSION: str = os.getenv("SHOPIFY_API_VERSION", "2024-07")
    
    @property
    def shopify_access_token(self) -> str:
        """Get Shopify access token, preferring ADMIN_API_TOKEN"""
        return self.SHOPIFY_ADMIN_API_TOKEN or os.getenv("SHOPIFY_ACCESS_TOKEN", "")
    
    @property
    def shopify_store_url(self) -> str:
        """Get Shopify store URL, can derive from API_KEY if it's a store name"""
        store_url = self.SHOPIFY_STORE_URL
        # If store URL is not set but API_KEY looks like a store name, use it
        if not store_url and self.SHOPIFY_API_KEY and not self.SHOPIFY_API_KEY.startswith('http'):
            # If API_KEY doesn't contain .myshopify.com, add it
            if '.myshopify.com' not in self.SHOPIFY_API_KEY:
                store_url = f"{self.SHOPIFY_API_KEY}.myshopify.com"
            else:
                store_url = self.SHOPIFY_API_KEY
        return store_url
    
# touch: backend-only change to verify Northflank's path ignore rules
settings = Settings()

