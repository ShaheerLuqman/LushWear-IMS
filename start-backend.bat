@echo off
echo ========================================
echo Starting Inventory Management Backend
echo ========================================
echo.

cd /d "%~dp0backend"

REM Check if virtual environment exists
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
call venv\Scripts\activate

REM Install dependencies
echo Installing dependencies...
pip install -r requirements.txt

REM Check for .env file
if not exist ".env" (
    echo.
    echo WARNING: .env file not found!
    echo Please create a .env file with your Supabase credentials:
    echo   SUPABASE_URL=your_supabase_project_url
    echo   SUPABASE_KEY=your_supabase_anon_key
    echo.
    pause
    exit /b 1
)

echo.
echo Starting FastAPI server on http://127.0.0.1:8000
echo Press Ctrl+C to stop the server
echo.

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

