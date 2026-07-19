@echo off
REM ========================================
REM Terminal Visibility Control
REM Set SHOW_TERMINALS=1 to show terminals, or 0 to hide them
REM Default: 1 (visible) for backend
REM ========================================
if "%SHOW_TERMINALS%"=="" set SHOW_TERMINALS=1

REM If SHOW_TERMINALS is 0, run hidden
if "%SHOW_TERMINALS%"=="0" (
    if "%1"=="hidden" goto :hidden
    start /min "" "%~f0" hidden
    exit
)

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

REM -y: run with stdin from nul so terminal closes smoothly when process is killed
if "%1"=="-y" (
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload < nul
) else (
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
)
exit

:hidden
cd /d "%~dp0backend"

REM Check if virtual environment exists
if not exist "venv" (
    python -m venv venv >nul 2>&1
)

REM Activate virtual environment
call venv\Scripts\activate

REM Install dependencies silently
pip install -r requirements.txt >nul 2>&1

REM Check for .env file
if not exist ".env" (
    echo WARNING: .env file not found! >nul 2>&1
    exit /b 1
)

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

