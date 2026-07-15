#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Run the desktop app from the electron-desktop branch
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "electron-desktop" ]; then
  echo "Switching to electron-desktop branch..."
  git checkout electron-desktop
  echo
fi

if [ -d .git ]; then
  echo "Pulling latest repository changes..."
  git pull
  echo
fi

echo "Setting up backend..."
cd backend

if [ ! -d "venv" ]; then
  echo "Creating Python virtual environment..."
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv venv
  else
    python -m venv venv
  fi
  echo
fi

source "venv/bin/activate"

echo "Installing backend dependencies..."
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo

echo "Setting up frontend..."
cd "$SCRIPT_DIR/frontend"

if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install
  echo
else
  echo "Frontend dependencies already installed."
  echo
fi

echo "Starting Electron app..."
echo "SHOW_TERMINALS=${SHOW_TERMINALS:-0}"
echo

export SHOW_TERMINALS="${SHOW_TERMINALS:-0}"
npm start
