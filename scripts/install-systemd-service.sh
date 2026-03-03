#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${1:-firebee}"
TARGET_DIR="${2:-/opt/firebee}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo nao encontrado. Execute como root ou instale sudo." >&2
  exit 1
fi

echo "[install] criando diretorio ${TARGET_DIR}"
sudo mkdir -p "$TARGET_DIR"

echo "[install] sincronizando codigo para ${TARGET_DIR}"
sudo rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  "$APP_DIR/" "$TARGET_DIR/"

echo "[install] instalando dependencias"
sudo npm --prefix "$TARGET_DIR" ci --omit=dev

echo "[install] instalando unidade systemd"
sudo sed \
  -e "s|^WorkingDirectory=.*$|WorkingDirectory=${TARGET_DIR}|" \
  -e "s|^EnvironmentFile=.*$|EnvironmentFile=${TARGET_DIR}/.env|" \
  -e "s|^ExecStart=.*$|ExecStart=/usr/bin/node ${TARGET_DIR}/server.js|" \
  "$APP_DIR/infra/systemd/firebee.service" | sudo tee "$SERVICE_FILE" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager -n 30

echo "[install] concluido"
