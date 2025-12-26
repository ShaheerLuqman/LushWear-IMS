@echo off
echo ========================================
echo Starting Inventory Management Frontend
echo ========================================
echo.

cd /d "%~dp0frontend"

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

echo.
echo Starting Electron app...
echo.

npm start

