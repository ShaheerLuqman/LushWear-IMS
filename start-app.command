#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -d .git ]; then
  echo "Pulling latest repository changes..."
  git pull
  echo
fi

cd frontend

if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install
  echo
fi

echo "Starting Electron app..."
echo "SHOW_TERMINALS=${SHOW_TERMINALS:-0}"
echo

export SHOW_TERMINALS="${SHOW_TERMINALS:-0}"
npm start
