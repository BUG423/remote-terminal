#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Claude Web — 服务器部署脚本
#
# 用法：
#   方式一（推荐）：SSH 密钥免密登录
#     export SERVER_USER=root
#     export SERVER_HOST=your-server-ip
#     bash deploy.sh
#
#   方式二：密码登录（需要先 apt install sshpass）
#     export SERVER_USER=root
#     export SERVER_HOST=your-server-ip
#     export SSHPASS=your-password
#     bash deploy.sh
#
# 架构：
#   浏览器 ──WSS──→ Nginx (:443) ──WS──→ Node.js Server (:3002, 127.0.0.1)
#   本地 Agent ──WS──→ Nginx (:443) ──WS──→ Node.js Server (:3002, 127.0.0.1)
# ═══════════════════════════════════════════════════════════════════

set -e

# ── 环境变量 ────────────────────────────────────────────────────────
SERVER_USER="${SERVER_USER:-root}"
SERVER_HOST="${SERVER_HOST:-}"
SERVER_SSH_PORT="${SERVER_SSH_PORT:-22}"
DOMAIN="${DOMAIN:-}"                        # 你的域名（用于 Nginx + TLS）
USE_PASSWORD="${USE_PASSWORD:-}"            # 非空 = 用 sshpass 密码登录

if [ -z "$SERVER_HOST" ]; then
    echo "❌ 请设置环境变量 SERVER_HOST"
    echo "   export SERVER_HOST=你的服务器IP"
    exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$PROJECT_DIR/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 未找到 config.json，请先创建:"
    echo "   cp config.json.example config.json"
    echo "   然后编辑 config.json 填入你的信息"
    exit 1
fi

# 解析 JSON
parse_json() {
    node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));const v=c.$1;console.log(v===undefined?'':typeof v==='object'?Object.keys(v)[0]||'':v)}catch(e){}"
}
SERVER_PORT=$(parse_json "serverPort")
SERVER_PORT="${SERVER_PORT:-3002}"

echo "🚀 Claude Web — 部署到服务器"
echo "   目标: ${SERVER_USER}@${SERVER_HOST}:${SERVER_SSH_PORT}"
echo "   Node.js 端口: ${SERVER_PORT}"
echo ""

# ── SSH 连接方式 ───────────────────────────────────────────────────
if [ -n "$USE_PASSWORD" ]; then
    if ! command -v sshpass &> /dev/null; then
        echo "📦 安装 sshpass..."
        sudo apt-get install -y sshpass 2>/dev/null || {
            echo "❌ 无法安装 sshpass，请手动安装后重试"
            exit 1
        }
    fi
    if [ -z "$SSHPASS" ]; then
        echo "🔑 请输入服务器密码:"
        read -s SSHPASS
    fi
    export SSHPASS
    SSH="sshpass -e ssh -o StrictHostKeyChecking=no -p ${SERVER_SSH_PORT}"
    SCP="sshpass -e scp -o StrictHostKeyChecking=no -P ${SERVER_SSH_PORT}"
else
    SSH="ssh -o StrictHostKeyChecking=no -p ${SERVER_SSH_PORT}"
    SCP="scp -o StrictHostKeyChecking=no -P ${SERVER_SSH_PORT}"
fi

# ── 1. 检查远程环境 ──────────────────────────────────────────────
echo "📋 检查远程服务器环境..."
$SSH ${SERVER_USER}@${SERVER_HOST} "
echo '  OS: '$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"')
echo '  Node.js: '$(node --version 2>/dev/null || echo '❌ 未安装')
echo '  npm: '$(npm --version 2>/dev/null || echo '❌ 未安装')
echo '  PM2: '$(pm2 --version 2>/dev/null || echo '❌ 未安装')
echo '  Nginx: '$(nginx -v 2>&1 || echo '❌ 未安装')
echo '  certbot: '$(certbot --version 2>/dev/null | head -1 || echo '❌ 未安装')
"

# ── 2. 安装 Node.js ──────────────────────────────────────────────
NEED_NODE=$($SSH ${SERVER_USER}@${SERVER_HOST} 'command -v node &> /dev/null && echo no || echo yes')
if [ "$NEED_NODE" = "yes" ]; then
    echo ""
    echo "📦 安装 Node.js 24.x..."
    $SSH ${SERVER_USER}@${SERVER_HOST} '
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - 2>/dev/null
        apt-get install -y nodejs 2>/dev/null
        echo "  ✅ Node.js $(node --version) 安装完成"
    '
fi

# ── 3. 安装 PM2 ──────────────────────────────────────────────────
NEED_PM2=$($SSH ${SERVER_USER}@${SERVER_HOST} 'command -v pm2 &> /dev/null && echo no || echo yes')
if [ "$NEED_PM2" = "yes" ]; then
    echo ""
    echo "📦 安装 PM2..."
    $SSH ${SERVER_USER}@${SERVER_HOST} 'npm install -g pm2 2>/dev/null'
fi

# ── 4. 上传文件 ──────────────────────────────────────────────────
echo ""
echo "📤 上传文件到服务器..."

$SSH ${SERVER_USER}@${SERVER_HOST} 'mkdir -p /root/claude-web/server/public /root/claude-web/nginx'

# server 核心文件
$SCP ${CONFIG_FILE}                        ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/
$SCP ${PROJECT_DIR}/server/package.json    ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/
$SCP ${PROJECT_DIR}/server/index.js        ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/
$SCP ${PROJECT_DIR}/server/auth.js         ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/
$SCP ${PROJECT_DIR}/server/rate-limiter.js ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/

# 前端文件
$SCP ${PROJECT_DIR}/server/public/index.html ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/public/
$SCP ${PROJECT_DIR}/server/public/style.css  ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/public/
$SCP ${PROJECT_DIR}/server/public/app.js     ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/public/

# Nginx 配置
$SCP ${PROJECT_DIR}/nginx/web-claude.conf ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/nginx/

echo "  ✅ 文件上传完成"

# ── 5. 安装依赖 + 启动 ──────────────────────────────────────────
echo ""
echo "📦 安装依赖并启动服务..."

$SSH ${SERVER_USER}@${SERVER_HOST} "
cd /root/claude-web/server
npm install --production 2>&1 | tail -3

# 停止旧的
pm2 delete claude-web-server 2>/dev/null || true

# 启动（bindHost=127.0.0.1：只监听本机，Nginx 负责对外）
pm2 start index.js --name claude-web-server --cwd /root/claude-web/server
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ''
echo '📊 服务状态:'
pm2 status claude-web-server
"

# ── 6. 配置 Nginx + TLS ──────────────────────────────────────────
echo ""
echo "🔧 配置 Nginx..."

if [ -n "$DOMAIN" ]; then
    # 有域名：配置 Nginx + certbot
    $SSH ${SERVER_USER}@${SERVER_HOST} "
        # 安装 Nginx + certbot（如果未安装）
        if ! command -v nginx &> /dev/null; then
            echo '  安装 Nginx...'
            apt-get update -qq && apt-get install -y nginx 2>/dev/null
        fi
        if ! command -v certbot &> /dev/null; then
            echo '  安装 certbot...'
            apt-get install -y certbot python3-certbot-nginx 2>/dev/null
        fi

        # 替换配置中的域名占位符
        sed 's/your-domain.com/${DOMAIN}/g' /root/claude-web/nginx/web-claude.conf > /etc/nginx/sites-available/web-claude

        # 启用站点
        rm -f /etc/nginx/sites-enabled/default
        ln -sf /etc/nginx/sites-available/web-claude /etc/nginx/sites-enabled/web-claude

        # 先获取证书（HTTP 验证，此时 HTTPS 还未启用）
        echo '  获取 Let\\'s Encrypt 证书...'
        certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --email admin@${DOMAIN} 2>&1 | tail -3 || {
            echo '  ⚠  certbot 自动配置失败，请手动运行:'
            echo '     certbot --nginx -d ${DOMAIN}'
        }

        # 测试并重载
        nginx -t && systemctl reload nginx
        systemctl enable nginx
    "
    echo "  ✅ Nginx + TLS 配置完成"
    echo "  访问地址: https://${DOMAIN}"
else
    # 无域名：仅配置 Nginx HTTP 反向代理（无 TLS）
    echo "  ⚠  未设置 DOMAIN 变量，跳过 TLS 配置"
    echo "  如需配置域名：export DOMAIN=your-domain.com"
    echo ""
    $SSH ${SERVER_USER}@${SERVER_HOST} "
        if ! command -v nginx &> /dev/null; then
            apt-get update -qq && apt-get install -y nginx 2>/dev/null
        fi
        # 仅 HTTP 代理
        sed 's/your-domain.com/${SERVER_HOST}/g' /root/claude-web/nginx/web-claude.conf > /etc/nginx/sites-available/web-claude
        rm -f /etc/nginx/sites-enabled/default
        ln -sf /etc/nginx/sites-available/web-claude /etc/nginx/sites-enabled/web-claude
        nginx -t && systemctl reload nginx
    "
    echo "  访问地址: http://${SERVER_HOST}"
fi

# ── 7. 防火墙 ────────────────────────────────────────────────────
echo ""
echo "🔥 配置防火墙（ufw）..."

$SSH ${SERVER_USER}@${SERVER_HOST} "
    if command -v ufw &> /dev/null; then
        ufw allow 22/tcp 2>/dev/null || true
        ufw allow 80/tcp 2>/dev/null || true
        ufw allow 443/tcp 2>/dev/null || true
        ufw --force enable 2>/dev/null || true
        ufw status numbered 2>/dev/null
    fi
"

# ── 8. 验证 ──────────────────────────────────────────────────────
echo ""
echo "🔍 验证部署..."
sleep 3

# 本地 health check
HEALTH=$($SSH ${SERVER_USER}@${SERVER_HOST} "curl -s http://127.0.0.1:${SERVER_PORT}/health 2>/dev/null" || echo '{"error":"unreachable"}')
echo "  Health: ${HEALTH}"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         ✅ 部署完成！                                ║"
echo "║                                                    ║"
if [ -n "$DOMAIN" ]; then
echo "║  🌐 浏览器访问: https://${DOMAIN}                    ║"
echo "║  🔗 Agent 连接: wss://${DOMAIN}                      ║"
else
echo "║  🌐 浏览器访问: http://${SERVER_HOST}                 ║"
echo "║  🔗 Agent 连接: ws://${SERVER_HOST}:${SERVER_PORT}    ║"
fi
echo "║                                                    ║"
echo "║  ⚠  重要：去阿里云安全组开放 80、443 端口！          ║"
echo "║                                                    ║"
echo "║  📋 下一步 — 更新你本地 config.json:                  ║"
if [ -n "$DOMAIN" ]; then
echo "║     serverHost 改为: ${DOMAIN}                       ║"
echo "║     useTLS: true                                   ║"
else
echo "║     serverHost 改为: ${SERVER_HOST}                   ║"
fi
echo "║     然后启动本地 Agent: bash start-local.sh          ║"
echo "╚══════════════════════════════════════════════════════╝"
