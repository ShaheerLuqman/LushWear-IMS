# Inventory Management System

A web-based inventory management application built with a FastAPI (Python) backend,
a static HTML/CSS/JS frontend, and a Supabase (Postgres) database. The backend and
frontend are deployed **separately** (Render + Vercel).

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
- **Node.js 18+** (optional) - only for the `npm run dev` static server helper

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

**Terminal 2 — Frontend (static site):** serve the `frontend/` folder with any static
server, then open it in your browser. For example:

```bash
cd frontend
npm run dev            # serves on http://127.0.0.1:8080
# or, without Node:
python -m http.server 8080
```

Then open **http://127.0.0.1:8080**. The frontend reads its backend URL from
`frontend/config.js` (`window.API_BASE`), which defaults to `http://127.0.0.1:8000/api`.

## Project Structure

```
inventory-system/
├── backend/                 # FastAPI Backend
│   ├── app/
│   │   ├── main.py          # FastAPI app entry
│   │   ├── config.py        # Configuration
│   │   ├── database.py      # Supabase connection
│   │   ├── models.py        # Pydantic models
│   │   └── routes/          # API routes (products, orders, cashbook, ledger, auth, users, org_settings)
│   ├── requirements.txt
│   └── .env                 # Your credentials (create this)
│
├── frontend/                # Static web frontend (no build step)
│   ├── index.html
│   ├── config.js            # Sets window.API_BASE (swap per environment)
│   ├── utils.js             # Shared helpers (apiJson/apiRequest, escapeHtml, ...)
│   ├── js/                  # App logic, loaded in order as plain scripts
│   │   ├── app-core.js      # Auth fetch wrapper, shared state, PIN gate
│   │   ├── orders-grid.js   # Orders/products grid column defs & renderers
│   │   ├── orders-actions.js
│   │   ├── navigation.js
│   │   ├── data-api.js
│   │   ├── cashbook.js
│   │   ├── ledgers.js
│   │   ├── sync-summary.js
│   │   ├── modals-forms.js
│   │   └── delivery-status.js
│   ├── styles.css
│   └── assets/
│
├── supabase_schema.sql      # Database schema
├── start-backend.bat        # Backend launcher (Windows)
└── README.md
```

## Deployment (Render + Vercel)

- **Backend → Render:** connect the repo with root `backend/`, start command
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, and set the env vars from your
  `.env` (Supabase + Shopify). Note the resulting `https://...onrender.com` URL.
- **Frontend → Vercel:** connect the repo with root `frontend/` (no build step). Set
  `window.API_BASE` in `config.js` to `https://<your-render-url>/api`, and pin the
  backend's `ALLOWED_ORIGINS` / CSP `connect-src` to the Vercel domain.

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
- Confirm `window.API_BASE` in `config.js` points at the backend
- Check the browser console (F12) for CORS or CSP errors

### Database errors
- Verify the Supabase schema was created correctly
- Check that API keys are correct

## License

MIT License - Feel free to use and modify!
