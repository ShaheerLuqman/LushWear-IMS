@echo off
REM ========================================
REM Terminal Visibility Control
REM Change the line below to set SHOW_TERMINALS=1 to show terminals
REM Default: 0 (hidden)
REM ========================================
set SHOW_TERMINALS=1
REM Uncomment the line above and change to 1 to show terminals
REM Or set it here: set SHOW_TERMINALS=1

if "%1"=="hidden" goto :hidden

REM If SHOW_TERMINALS is 1, run normally (visible)
if "%SHOW_TERMINALS%"=="1" (
    goto :visible
)

REM Otherwise, run hidden using VBScript if available, otherwise minimize
if exist "%~dp0start-app.vbs" (
    cscript //nologo "%~dp0start-app.vbs" >nul 2>&1
    exit
)
REM Fallback: minimize window
start /min "" "%~f0" hidden
exit

:visible
cd /d "%~dp0frontend"

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

echo.
echo Starting Electron app...
echo SHOW_TERMINALS=%SHOW_TERMINALS%
echo.

REM Pass the environment variable to npm/electron
set SHOW_TERMINALS=%SHOW_TERMINALS%
npm start
exit

:hidden
cd /d "%~dp0frontend"

REM Check if node_modules exists
if not exist "node_modules" (
    npm install >nul 2>&1
)

npm start

