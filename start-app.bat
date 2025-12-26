@echo off
if "%1"=="hidden" goto :hidden
REM Run this batch file hidden using VBScript if available, otherwise minimize
if exist "%~dp0start-app.vbs" (
    cscript //nologo "%~dp0start-app.vbs" >nul 2>&1
    exit
)
REM Fallback: minimize window
start /min "" "%~f0" hidden
exit
:hidden

cd /d "%~dp0frontend"

REM Check if node_modules exists
if not exist "node_modules" (
    npm install >nul 2>&1
)

npm start

