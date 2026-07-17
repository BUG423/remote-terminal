#!/usr/bin/env bash
set -euo pipefail

# Safely update an existing server checkout from GitHub and reload only the
# relay process. This script deliberately does not upload config.json, alter
# firewall rules, install system packages, or replace Nginx configuration.

SERVER_HOST="${SERVER_HOST:-}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_SSH_PORT="${SERVER_SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/remote-terminal}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ -n "${SERVER_HOST}" ]] || fail "set SERVER_HOST"
[[ "${SERVER_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "invalid SERVER_USER"
[[ "${SERVER_SSH_PORT}" =~ ^[0-9]+$ ]] || fail "invalid SERVER_SSH_PORT"
(( SERVER_SSH_PORT >= 1 && SERVER_SSH_PORT <= 65535 )) || fail "SERVER_SSH_PORT out of range"
[[ "${REMOTE_DIR}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "REMOTE_DIR must be a simple absolute path"
[[ ! "${REMOTE_DIR}" =~ ^/(|root|home|opt|usr|var)$ ]] || fail "REMOTE_DIR is too broad"
[[ "${DEPLOY_BRANCH}" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "invalid DEPLOY_BRANCH"

SSH=(ssh -o StrictHostKeyChecking=accept-new -p "${SERVER_SSH_PORT}")
TARGET="${SERVER_USER}@${SERVER_HOST}"

echo "Updating ${TARGET}:${REMOTE_DIR} from origin/${DEPLOY_BRANCH}"

"${SSH[@]}" "${TARGET}" bash -s -- "${REMOTE_DIR}" "${DEPLOY_BRANCH}" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_DIR="$1"
DEPLOY_BRANCH="$2"

[[ -d "${REMOTE_DIR}/.git" ]] || {
  echo "ERROR: ${REMOTE_DIR} is not an existing Git checkout" >&2
  exit 1
}
[[ -f "${REMOTE_DIR}/config.json" ]] || {
  echo "ERROR: ${REMOTE_DIR}/config.json is missing; create it on the server" >&2
  exit 1
}
command -v node >/dev/null || { echo "ERROR: node is not installed" >&2; exit 1; }
command -v npm >/dev/null || { echo "ERROR: npm is not installed" >&2; exit 1; }
command -v pm2 >/dev/null || { echo "ERROR: pm2 is not installed" >&2; exit 1; }

cd "${REMOTE_DIR}"
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "${CURRENT_BRANCH}" == "${DEPLOY_BRANCH}" ]] || {
  echo "ERROR: expected branch ${DEPLOY_BRANCH}, found ${CURRENT_BRANCH:-detached HEAD}" >&2
  exit 1
}

git diff --quiet && git diff --cached --quiet || {
  echo "ERROR: server checkout has uncommitted changes" >&2
  exit 1
}
git fetch --prune origin "${DEPLOY_BRANCH}"
git merge --ff-only "origin/${DEPLOY_BRANCH}"

cd server
npm ci --omit=dev --no-audit --no-fund

if pm2 describe remote-terminal-server >/dev/null 2>&1; then
  CW_CONFIG_PATH="${REMOTE_DIR}/config.json" pm2 reload remote-terminal-server --update-env
else
  CW_CONFIG_PATH="${REMOTE_DIR}/config.json" pm2 start index.js \
    --name remote-terminal-server --cwd "${REMOTE_DIR}/server"
fi
pm2 save

PORT="$(node -e "const c=require('${REMOTE_DIR}/config.json'); process.stdout.write(String(c.port || 3002))")"
BIND_HOST="$(node -e "const c=require('${REMOTE_DIR}/config.json'); process.stdout.write(String(c.bindHost || '127.0.0.1'))")"
curl --fail --silent --show-error "http://${BIND_HOST}:${PORT}/health"
echo
REMOTE_SCRIPT

echo "Server update completed"
