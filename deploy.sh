#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Claude Web — 阿里云服务器部署脚本
# 在你的本地机器上运行此脚本，自动部署到云服务器
# ═══════════════════════════════════════════════════════════════════

set -e

# ── 配置 ──────────────────────────────────────────────────────────
SERVER_HOST="8.138.246.166"
SERVER_USER="root"
SERVER_PORT="22"
PROJECT_DIR="/home/zss/workspace/claude-web"

echo "🚀 Claude Web — 部署到阿里云服务器"
echo "   目标: ${SERVER_USER}@${SERVER_HOST}"
echo ""

# ── 1. 检查 sshpass ──────────────────────────────────────────────
if ! command -v sshpass &> /dev/null; then
    echo "⚠  sshpass 未安装，正在尝试安装..."
    sudo apt-get install -y sshpass 2>/dev/null || {
        echo "❌ 无法安装 sshpass，请手动安装后重试："
        echo "   sudo apt-get install -y sshpass"
        exit 1
    }
fi

echo "🔑 请输入服务器密码:"
read -s SSHPASS
export SSHPASS

SSH="sshpass -e ssh -o StrictHostKeyChecking=no -p ${SERVER_PORT}"
SCP="sshpass -e scp -o StrictHostKeyChecking=no -P ${SERVER_PORT}"

# ── 2. 检查远程服务器环境 ────────────────────────────────────────
echo ""
echo "📋 检查远程服务器环境..."

$SSH ${SERVER_USER}@${SERVER_HOST} '
echo "  OS: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \" || echo Unknown)"
echo "  Node.js: $(node --version 2>/dev/null || echo "❌ 未安装")"
echo "  npm: $(npm --version 2>/dev/null || echo "❌ 未安装")"
echo "  PM2: $(pm2 --version 2>/dev/null || echo "❌ 未安装")"
'

# ── 3. 安装 Node.js（如果需要）───────────────────────────────────
NEED_NODE=$($SSH ${SERVER_USER}@${SERVER_HOST} 'command -v node &> /dev/null && echo "no" || echo "yes"')
if [ "$NEED_NODE" = "yes" ]; then
    echo ""
    echo "📦 安装 Node.js 24.x..."
    $SSH ${SERVER_USER}@${SERVER_HOST} '
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - 2>/dev/null
        apt-get install -y nodejs 2>/dev/null
        echo "  Node.js $(node --version) 安装完成"
    '
fi

# ── 4. 安装 PM2（如果需要）───────────────────────────────────────
NEED_PM2=$($SSH ${SERVER_USER}@${SERVER_HOST} 'command -v pm2 &> /dev/null && echo "no" || echo "yes"')
if [ "$NEED_PM2" = "yes" ]; then
    echo ""
    echo "📦 安装 PM2..."
    $SSH ${SERVER_USER}@${SERVER_HOST} 'npm install -g pm2 2>/dev/null'
fi

# ── 5. 上传文件 ──────────────────────────────────────────────────
echo ""
echo "📤 上传 server/ 文件到服务器..."

# 创建远程目录
$SSH ${SERVER_USER}@${SERVER_HOST} 'mkdir -p /root/claude-web/server/public'

# 上传文件
$SCP ${PROJECT_DIR}/config.json ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/
$SCP ${PROJECT_DIR}/server/package.json ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/
$SCP ${PROJECT_DIR}/server/index.js ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/
$SCP ${PROJECT_DIR}/server/auth.js ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/
$SCP ${PROJECT_DIR}/server/public/index.html ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/public/
$SCP ${PROJECT_DIR}/server/public/style.css ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/public/
$SCP ${PROJECT_DIR}/server/public/app.js ${SERVER_USER}@${SERVER_HOST}:/root/claude-web/server/public/

echo "  文件上传完成"

# ── 6. 安装依赖并启动 ────────────────────────────────────────────
echo ""
echo "📦 安装依赖并启动服务..."

$SSH ${SERVER_USER}@${SERVER_HOST} '
cd /root/claude-web/server

# 安装依赖
npm install --production 2>&1 | tail -1

# 停止旧的服务（如果存在）
pm2 delete claude-web-server 2>/dev/null || true

# 启动服务
pm2 start index.js --name claude-web-server --cwd /root/claude-web/server

# 保存 PM2 配置（开机自启）
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "  服务状态:"
pm2 status claude-web-server
'

# ── 7. 开放防火墙端口 ────────────────────────────────────────────
echo ""
echo "🔥 配置防火墙..."

$SSH ${SERVER_USER}@${SERVER_HOST} '
# 尝试多种防火墙
if command -v ufw &> /dev/null; then
    ufw allow 3000/tcp 2>/dev/null || true
    ufw status 2>/dev/null | grep 3000 || true
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --add-port=3000/tcp --permanent 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
fi
'

# ── 8. 验证部署 ──────────────────────────────────────────────────
echo ""
echo "🔍 验证部署..."
sleep 2

HEALTH=$($SSH ${SERVER_USER}@${SERVER_HOST} 'curl -s http://localhost:3000/health 2>/dev/null')
echo "  Health check: ${HEALTH}"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅ 部署完成！                                      ║"
echo "║                                                    ║"
echo "║  访问地址: http://${SERVER_HOST}:3000                 ║"
echo "║  Token: NNvEOIh2xapSnHr6Hi5mK0AN-PkCpr5t            ║"
echo "║                                                    ║"
echo "║  下一步: 在你的本地机器上启动 Agent                    ║"
echo "║  cd agent && npm install && npm start              ║"
echo "╚══════════════════════════════════════════════════════╝"
