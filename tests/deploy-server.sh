#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Web-Claude — 云端 Server 一键部署（在你“本地的普通终端”里运行）
#
#   bash tests/deploy-server.sh
#
# 作用：把新版 server/ 上传到 8.138.246.166:/root/claude-web，安装依赖，
#       用 PM2 重启；token 从本地 config.json 读取后以 .env 写到服务器，
#       不写入仓库 / 不进提交 / 不打印明文。
# 依赖：ssh / scp / tar / node（本机）；过程中会提示输入服务器 SSH 密码。
# ═══════════════════════════════════════════════════════════════════
set -e
HOST="${HOST:-8.138.246.166}"
USER="${SSH_USER:-root}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

TOKEN="$(node -e "console.log(require('$REPO/config.json').token)")"
[ -z "$TOKEN" ] && { echo "❌ 未在 config.json 找到 token"; exit 1; }

echo "==> 打包 server（不含 node_modules）"
tar -czf /tmp/web-claude-server.tgz -C "$REPO" \
  server/index.js server/auth.js server/package.json server/public

echo "==> 上传到 $USER@$HOST （提示时输入服务器密码）"
scp /tmp/web-claude-server.tgz "$USER@$HOST:/tmp/"

echo "==> 远端部署 + 重启（可能再次提示密码）"
ssh "$USER@$HOST" "CW_TOKEN='$TOKEN' bash -s" <<'REMOTE'
set -e
mkdir -p /root/claude-web
tar -xzf /tmp/web-claude-server.tgz -C /root/claude-web
# 最小 config.json（token 留空，走 .env）
cat > /root/claude-web/config.json <<JSON
{ "port": 3000, "token": "", "serverHost": "8.138.246.166", "serverPort": 3000, "useTLS": false }
JSON
# token 写入 .env（仅 root 可读）
printf 'CLAUDE_WEB_TOKEN=%s\n' "$CW_TOKEN" > /root/claude-web/.env
chmod 600 /root/claude-web/.env
# Node.js
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; }
cd /root/claude-web/server
npm install --production --no-audit --no-fund >/dev/null 2>&1
# PM2
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null 2>&1
pm2 delete claude-web-server >/dev/null 2>&1 || true
pm2 start index.js --name claude-web-server --cwd /root/claude-web/server
pm2 save >/dev/null 2>&1
# 放行端口（若用 ufw/firewalld）
command -v ufw >/dev/null && ufw allow 3000/tcp >/dev/null 2>&1 || true
sleep 2
echo "----- 健康检查 -----"
curl -s http://127.0.0.1:3000/health && echo
echo "✅ 部署完成（注意：阿里云安全组需放行 3000/TCP 入站）"
REMOTE
echo "==> 完成。请确认阿里云控制台安全组已放行 3000/TCP 入站。"
