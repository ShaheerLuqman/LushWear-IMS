@echo off
set SHOW_TERMINALS=0

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-dev-ports.ps1"

start "" "%~dp0start-backend.bat"
start /min "" cmd /c "cd /d "%~dp0frontend" && npm run dev"
