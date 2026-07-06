#!/bin/bash
# Web-Claude 改进验证脚本
# 用于验证三个问题的修复是否正常工作

set -e

echo "╔════════════════════════════════════════════════════════╗"
echo "║    Web-Claude 改进验证脚本                             ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

check_count=0
pass_count=0

function check() {
  check_count=$((check_count + 1))
  local name="$1"
  local cmd="$2"
  echo -n "[检查 $check_count] $name ... "
  if eval "$cmd" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 通过${NC}"
    pass_count=$((pass_count + 1))
  else
    echo -e "${RED}✗ 失败${NC}"
  fi
}

# ─────────────────────────────────────────────────────────
echo -e "${BLUE}1️⃣  代码语法检查${NC}"
echo "───────────────────────────────────────────────────────"

check "logger.js 语法" "node -c logger.js"
check "agent/session-manager.js 语法" "node -c agent/session-manager.js"
check "agent/index.js 语法" "node -c agent/index.js"
check "server/index.js 语法" "node -c server/index.js"

# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}2️⃣  新增文件检查${NC}"
echo "───────────────────────────────────────────────────────"

check "logger.js 存在" "test -f logger.js"
check "CHANGELOG_IMPROVEMENTS.md 存在" "test -f CHANGELOG_IMPROVEMENTS.md"

# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}3️⃣  关键函数检查${NC}"
echo "───────────────────────────────────────────────────────"

check "session-manager.js 有 recoverSessions" "grep -q 'function recoverSessions' agent/session-manager.js"
check "session-manager.js 有 saveSessionMetadata" "grep -q 'function saveSessionMetadata' agent/session-manager.js"
check "agent/index.js 有 sendHeartbeat" "grep -q 'function sendHeartbeat' agent/index.js"
check "agent/index.js 有 checkDeadConnection" "grep -q 'function checkDeadConnection' agent/index.js"
check "app.js 有粘贴事件处理" "grep -q \"addEventListener.*paste\" server/public/app.js"
check "server/index.js 有日志初始化" "grep -q \"logger.init.*server\" server/index.js"

# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}4️⃣  日志模块检查${NC}"
echo "───────────────────────────────────────────────────────"

check "logger 导出 init 函数" "grep -q 'module.exports' logger.js && grep -q 'init' logger.js"
check "logger 导出 info 函数" "grep -q 'info:' logger.js"
check "logger 导出 error 函数" "grep -q 'error:' logger.js"
check "logger 导出 heartbeat 函数" "grep -q 'heartbeat:' logger.js"
check "logger 导出 connection 函数" "grep -q 'connection:' logger.js"

# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}5️⃣  改进功能检查${NC}"
echo "───────────────────────────────────────────────────────"

check "Agent启动时恢复会话" "grep -q 'recoverSessions()' agent/index.js"
check "已恢复会话状态处理" "grep -q 'status.*recovered' agent/index.js"
check "新增.session.json保存" "grep -q '.session.json' agent/session-manager.js"
check "粘贴事件preventDefault" "grep -q 'preventDefault' server/public/app.js"
check "从剪贴板提取纯文本" "grep -q 'text/plain' server/public/app.js"
check "心跳检测日志" "grep -q 'logger.heartbeat' agent/index.js"
check "连接状态日志" "grep -q 'logger.connection' agent/index.js"

# ─────────────────────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║                   检查总结                             ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  总检查数: $check_count"
echo "║  通过数:   $pass_count"
if [ $pass_count -eq $check_count ]; then
  echo -e "║  状态:     ${GREEN}✓ 所有检查通过${NC}"
else
  echo -e "║  状态:     ${RED}✗ 部分检查失败${NC}"
fi
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────────
echo -e "${BLUE}📋 快速开始${NC}"
echo "───────────────────────────────────────────────────────"
echo ""
echo "1️⃣  重启Agent："
echo "   cd agent && npm install"
echo "   node index.js"
echo ""
echo "2️⃣  重启Server："
echo "   cd server && npm install"
echo "   node index.js"
echo ""
echo "3️⃣  查看日志："
echo "   tail -f ~/.claude-web-logs/agent-\$(date +%Y-%m-%d).log"
echo "   tail -f ~/.claude-web-logs/server-\$(date +%Y-%m-%d).log"
echo ""
echo "4️⃣  测试改进："
echo "   • 粘贴功能：用语音或剪贴板粘贴任何内容，应该显示纯文本"
echo "   • 会话恢复：关闭Agent后重启，前端应显示之前的会话(recovered)"
echo "   • 日志记录：查看~/.claude-web-logs中的日志，应有详细的心跳记录"
echo ""

if [ $pass_count -eq $check_count ]; then
  echo -e "${GREEN}✅ 所有改进验证通过！${NC}"
  exit 0
else
  echo -e "${RED}❌ 部分检查失败，请检查代码${NC}"
  exit 1
fi
