#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${GIT_REMOTE:-origin}"
BRANCH="${GIT_BRANCH:-main}"

SSH_USER="${DEPLOY_SSH_USER:-}"
SSH_HOST="${DEPLOY_SSH_HOST:-}"
SSH_PORT="${DEPLOY_SSH_PORT:-22}"
REMOTE_APP_DIR="${DEPLOY_REMOTE_APP_DIR:-/opt/firebee}"
REMOTE_DEPLOY_SCRIPT="${DEPLOY_REMOTE_SCRIPT:-./scripts/deploy.sh}"

log() {
  printf '[push-deploy] %s\n' "$*"
}

cd "$APP_DIR"

if [[ -z "$SSH_USER" || -z "$SSH_HOST" ]]; then
  echo "Defina DEPLOY_SSH_USER e DEPLOY_SSH_HOST." >&2
  echo "Exemplo: DEPLOY_SSH_USER=ubuntu DEPLOY_SSH_HOST=10.0.0.15 ./scripts/push-and-deploy.sh" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  log "Ha alteracoes locais nao commitadas. Commit/stash antes de publicar."
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  log "Branch atual: $CURRENT_BRANCH | alvo de deploy: $BRANCH"
fi

log "Enviando codigo para ${REMOTE}/${BRANCH}"
git push "$REMOTE" "$BRANCH"

REMOTE_CMD="cd '${REMOTE_APP_DIR}' && '${REMOTE_DEPLOY_SCRIPT}'"
log "Executando deploy remoto em ${SSH_USER}@${SSH_HOST}:${SSH_PORT}"
ssh -p "$SSH_PORT" -o BatchMode=yes "${SSH_USER}@${SSH_HOST}" "$REMOTE_CMD"

log "Publicacao concluida"
