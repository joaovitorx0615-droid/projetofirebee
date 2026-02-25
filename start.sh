#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${1:-8000}"

echo "Iniciando servidor em http://localhost:${PORT}"

if command -v node >/dev/null 2>&1; then
  # Limite de heap para ambiente enxuto (Raspberry Pi 4 com 2 GB).
  if [[ -n "${NODE_OPTIONS:-}" ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=320"
  else
    export NODE_OPTIONS="--max-old-space-size=320"
  fi
  PORT="${PORT}" node server.js
elif [[ -x ".venv/bin/python" ]]; then
  echo "Node nao encontrado. Iniciando modo estatico com CSV local."
  ".venv/bin/python" -m http.server "${PORT}"
elif command -v python3 >/dev/null 2>&1; then
  echo "Node nao encontrado. Iniciando modo estatico com CSV local."
  python3 -m http.server "${PORT}"
elif command -v python >/dev/null 2>&1; then
  echo "Node nao encontrado. Iniciando modo estatico com CSV local."
  python -m http.server "${PORT}"
elif [[ -x ".venv/Scripts/python.exe" ]]; then
  echo "Node nao encontrado. Iniciando modo estatico com CSV local."
  ".venv/Scripts/python.exe" -m http.server "${PORT}"
else
  echo "Node e Python nao encontrados. Instale Node.js (recomendado) ou Python." >&2
  exit 1
fi
