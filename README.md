# Inventory Management System

A web-based inventory management application built with a FastAPI (Python) backend,
a React + Vite + TypeScript frontend, and a Supabase (Postgres) database. The backend
and frontend are deployed **separately** (Render + Vercel).

## Features

- 📦 **Product Management** - Add, edit, delete products
- 📊 **Dashboard** - Overview with key metrics
- 🔄 **Stock Movement** - Track inventory in/out
- 🔍 **Search** - Find products by name or SKU
- 🧾 **Invoices & Load Sheets** - Server-generated PDFs, downloaded in the browser
- 🎨 **Modern UI** - Dark theme with elegant design

## Prerequisites

- **Python 3.9+** - [Download](https://www.python.org/downloads/) (backend)
- **Supabase Account** - [Sign up](https://supabase.com/) (database)
- **Node.js 18+** (frontend)

## Quick Setup

### 1. Set Up Supabase

1. Create a new project at [Supabase](https://supabase.com/)
2. Go to **SQL Editor** and run the contents of `supabase_schema.sql`
3. Go to **Settings > API** and copy the Project URL and `anon` public key

### 2. Configure Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate           # Windows  (use: source venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
```

Create a `.env` file with your credentials:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
# Optional integrations:
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=your-admin-token
```

### 3. Run Locally

**Terminal 1 — Backend:**
```bash
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm install
npm run dev             # serves on http://127.0.0.1:5173
```

Then open **http://127.0.0.1:5173**. The frontend picks its backend URL automatically
based on hostname (see `API_BASE` in `frontend/src/api.ts`) - localhost talks to
`http://127.0.0.1:8000/api`, any other host uses the deployed backend URL.

## Project Structure

```
inventory-system/
├── backend/                 # FastAPI Backend
│   ├── app/
│   │   ├── main.py          # FastAPI app entry
│   │   ├── config.py        # Configuration
│   │   ├── database.py      # Supabase connection
│   │   ├── models.py        # Pydantic models
│   │   └── routes/          # API routes (products, orders, transactions, ledger, auth, users, org_settings)
│   ├── requirements.txt
│   └── .env                 # Your credentials (create this)
│
├── frontend/                 # React + Vite + TypeScript SPA
│   ├── src/
│   │   ├── api.ts            # API_BASE + auth token + apiJson/apiRequest
│   │   ├── App.tsx           # Router (main app + /admin superadmin portal)
│   │   ├── auth/             # AuthContext (session, superadmin impersonation)
│   │   ├── pages/            # One folder per feature area (orders, inventory,
│   │   │                     # finance, fulfillment, analytics, dashboard,
│   │   │                     # settings, admin)
│   │   └── logic/            # Pure business-logic modules, unit-testable
│   │                         # independent of any component
│   └── public/               # assets/, manifest.json, service-worker.js
│
├── supabase_schema.sql      # Database schema
├── start-backend.bat        # Backend launcher (Windows)
└── README.md
```

## Deployment (Render + Vercel)

- **Backend → Render:** connect the repo with root `backend/`, start command
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, and set the env vars from your
  `.env` (Supabase + Shopify). Note the resulting `https://...onrender.com` URL.
- **Frontend → Vercel:** connect the repo with root `frontend/`. `frontend/vercel.json`
  runs `npm install && npm run build` and serves `dist/` with an SPA-fallback rewrite.
  `API_BASE` in `src/api.ts` auto-detects a non-local
  hostname and points at the deployed backend - pin the backend's `ALLOWED_ORIGINS` /
  CSP `connect-src` to the Vercel domain.

See `plan.md` for the full migration/deployment plan.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products/` | Get all products |
| GET | `/api/products/{id}` | Get single product |
| POST | `/api/products/` | Create product |
| PUT | `/api/products/{id}` | Update product |
| DELETE | `/api/products/{id}` | Delete product |
| POST | `/api/products/stock-movement` | Record stock change |
| GET | `/api/products/search/{query}` | Search products |

## Troubleshooting

### Backend won't start
- Ensure Python 3.9+ is installed and in PATH
- Check that `.env` exists with valid credentials
- Verify the Supabase project is active

### Frontend shows "Disconnected"
- Make sure the backend is running (default port 8000)
- Confirm `API_BASE` in `frontend/src/api.ts` points at the backend
- Check the browser console (F12) for CORS or CSP errors

### Database errors
- Verify the Supabase schema was created correctly
- Check that API keys are correct

## License

MIT License - Feel free to use and modify!
