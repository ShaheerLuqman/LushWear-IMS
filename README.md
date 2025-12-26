# Inventory Management System

A desktop inventory management application built with FastAPI (Python) backend, Electron + JavaScript frontend, and Supabase database.

![Inventory Manager](https://via.placeholder.com/800x500/0a0a0f/4a7c59?text=Inventory+Manager)

## Features

- 📦 **Product Management** - Add, edit, delete products
- 📊 **Dashboard** - Overview with key metrics
- 🔄 **Stock Movement** - Track inventory in/out
- 🔍 **Search** - Find products by name or SKU
- 🎨 **Modern UI** - Dark theme with elegant design

## Prerequisites

- **Python 3.9+** - [Download](https://www.python.org/downloads/)
- **Node.js 18+** - [Download](https://nodejs.org/)
- **Supabase Account** - [Sign up](https://supabase.com/)

## Quick Setup

### 1. Set Up Supabase

1. Create a new project at [Supabase](https://supabase.com/)
2. Go to **SQL Editor** and run the contents of `supabase_schema.sql`
3. Go to **Settings > API** and copy:
   - Project URL
   - `anon` public key

### 2. Configure Backend

1. Navigate to the backend folder:
   ```bash
   cd backend
   ```

2. Create a `.env` file with your Supabase credentials:
   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_KEY=your-anon-key
   ```

### 3. Run the Application

**Option A: Using the startup script (Recommended for Windows)**

Double-click `start-app.bat` to launch both backend and frontend.

**Option B: Manual startup**

Terminal 1 - Backend:
```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Terminal 2 - Frontend:
```bash
cd frontend
npm install
npm start
```

## Project Structure

```
inventory-system/
├── backend/                 # FastAPI Backend
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py         # FastAPI app entry
│   │   ├── config.py       # Configuration
│   │   ├── database.py     # Supabase connection
│   │   ├── models.py       # Pydantic models
│   │   └── routes/
│   │       └── products.py # Product API routes
│   ├── requirements.txt
│   └── .env                # Your credentials (create this)
│
├── frontend/               # Electron + JavaScript Frontend
│   ├── main.js            # Electron main process
│   ├── preload.js         # Preload script
│   ├── index.html         # Main HTML
│   ├── styles.css         # Styling
│   ├── renderer.js        # Frontend logic
│   └── package.json
│
├── supabase_schema.sql    # Database schema
├── start-app.bat          # Launch script
├── start-backend.bat      # Backend only
├── start-frontend.bat     # Frontend only
└── README.md
```

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

## Building for Production

To create a distributable Windows installer:

```bash
cd frontend
npm run build
```

The installer will be in `frontend/dist/`.

## Troubleshooting

### Backend won't start
- Ensure Python 3.9+ is installed and in PATH
- Check that `.env` file exists with valid credentials
- Verify Supabase project is active

### Frontend shows "Disconnected"
- Make sure backend is running on port 8000
- Check console for errors (Ctrl+Shift+I in app)

### Database errors
- Verify Supabase schema was created correctly
- Check that API keys are correct
- Ensure Row Level Security is disabled (for development)

## License

MIT License - Feel free to use and modify!

