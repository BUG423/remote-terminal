#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3002}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/tmp/remote-terminal-e2e-workspaces}"
CONFIG_PATH="${CONFIG_PATH:-/tmp/remote-terminal-e2e-config.json}"
TOKEN="${CLAUDE_WEB_TOKEN:-$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")}"

SERVER_PID=""
AGENT_PID=""

cleanup() {
  if [[ -n "${AGENT_PID}" ]]; then kill "${AGENT_PID}" 2>/dev/null || true; fi
  if [[ -n "${SERVER_PID}" ]]; then kill "${SERVER_PID}" 2>/dev/null || true; fi
  wait "${AGENT_PID:-0}" 2>/dev/null || true
  wait "${SERVER_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "${ROOT}"

rm -rf "${WORKSPACE_ROOT}"
mkdir -p "${WORKSPACE_ROOT}"

cat > "${CONFIG_PATH}" <<JSON
{
  "port": ${PORT},
  "bindHost": "127.0.0.1",
  "tokens": { "${TOKEN}": "server-e2e-agent" },
  "serverHost": "127.0.0.1",
  "serverPort": ${PORT},
  "useTLS": false,
  "workspaceRoot": "${WORKSPACE_ROOT}"
}
JSON

echo "== npm test =="
npm test

echo "== start real server + agent =="
CW_CONFIG_PATH="${CONFIG_PATH}" node server/index.js > /tmp/remote-terminal-server.log 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:${PORT}/health"

CW_CONFIG_PATH="${CONFIG_PATH}" node agent/index.js > /tmp/remote-terminal-agent.log 2>&1 &
AGENT_PID="$!"
sleep 3

echo "== real e2e =="
TARGET="ws://127.0.0.1:${PORT}" CLAUDE_WEB_TOKEN="${TOKEN}" WORKSPACE_ROOT="${WORKSPACE_ROOT}" node tests/e2e.js

echo "== security =="
TARGET="ws://127.0.0.1:${PORT}" CLAUDE_WEB_TOKEN="${TOKEN}" node tests/security.js

echo "== port cleanup check =="
cleanup
SERVER_PID=""
AGENT_PID=""
sleep 1
if ss -ltnp | grep -E ":${PORT}\\b"; then
  echo "❌ port ${PORT} still listening after cleanup"
  exit 1
fi
echo "✅ server test processes cleaned"
