#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${DEPLOY_REMOTE:-origin}"
BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE_NAME="${DEPLOY_SERVICE:-firebee}"
HEALTHCHECK_URL="${DEPLOY_HEALTHCHECK_URL:-http://127.0.0.1:3000/api/producao-status}"

log() {
  printf '[deploy] %s\n' "$*"
}

cd "$APP_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  log "Repositorio com alteracoes locais. Commit/stash antes do deploy."
  exit 1
fi

log "Buscando atualizacoes de ${REMOTE}/${BRANCH}"
git fetch "$REMOTE" "$BRANCH"

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "${REMOTE}/${BRANCH}")"

if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  log "Atualizando codigo local (fast-forward)"
  git pull --ff-only "$REMOTE" "$BRANCH"
else
  log "Codigo ja atualizado em ${REMOTE_SHA}"
fi

if [[ -f package-lock.json ]]; then
  log "Instalando dependencias com npm ci"
  npm ci --omit=dev
else
  log "Instalando dependencias com npm install"
  npm install --omit=dev
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^${SERVICE_NAME}\\.service"; then
  log "Reiniciando servico systemd: ${SERVICE_NAME}"
  sudo systemctl restart "${SERVICE_NAME}"
  sudo systemctl status "${SERVICE_NAME}" --no-pager -n 30
else
  log "Servico systemd ${SERVICE_NAME}.service nao encontrado. Reinicie manualmente o processo Node."
fi

if command -v curl >/dev/null 2>&1; then
  log "Validando healthcheck: ${HEALTHCHECK_URL}"
  curl --fail --silent --show-error "$HEALTHCHECK_URL" >/dev/null
  log "Healthcheck OK"
else
  log "curl nao encontrado; pulando healthcheck"
fi

log "Deploy concluido"
