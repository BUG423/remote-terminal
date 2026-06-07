#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Claude Web — 本地 Agent 启动脚本
# 在你的本地机器（运行 Claude Code 的机器）上执行此脚本
# ═══════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🖥  Claude Web — 启动本地 Agent"
echo ""

# ── 1. 检查 Node.js ─────────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo "❌ 未安装 Node.js，请先安装: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js $(node --version)"

# ── 2. 检查 Claude CLI ──────────────────────────────────────────
if ! command -v claude &> /dev/null; then
    echo "❌ 未找到 claude 命令，请先安装 Claude Code"
    exit 1
fi
echo "✅ Claude Code $(claude --version 2>/dev/null | head -1)"

# ── 3. 检查配置 ─────────────────────────────────────────────────
if [ ! -f config.json ]; then
    echo "❌ 未找到 config.json，请先配置:"
    echo "   cp config.json.example config.json"
    echo "   编辑 config.json 填入你的 Token 和服务器地址"
    exit 1
fi
echo "✅ config.json 存在"

# ── 4. 安装依赖 ─────────────────────────────────────────────────
echo ""
echo "📦 安装依赖..."
cd agent && npm install --quiet 2>&1 | tail -1

# ── 5. 启动 Agent ───────────────────────────────────────────────
echo ""
echo "🚀 启动 Agent，连接服务器..."
echo "   服务器: $(grep serverHost ../config.json | cut -d'"' -f4)"
echo ""

# 使用 PM2（如果已安装）或直接运行
if command -v pm2 &> /dev/null; then
    echo "使用 PM2 守护进程模式..."
    pm2 delete claude-web-agent 2>/dev/null || true
    pm2 start index.js --name claude-web-agent
    pm2 save
    echo ""
    echo "✅ Agent 已启动（PM2 守护）"
    echo ""
    echo "查看状态: pm2 status"
    echo "查看日志: pm2 logs claude-web-agent"
else
    echo "直接运行（前台模式）..."
    echo "提示: 安装 PM2 可以后台运行: npm install -g pm2"
    echo ""
    node index.js
fi
