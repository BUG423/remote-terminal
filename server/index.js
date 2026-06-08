/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 云端中继服务器
 *
 * 三方消息流：  浏览器 ⇄ Server ⇄ 本地 Agent
 *
 * Server 负责：
 *   - Token 鉴权（浏览器 + Agent 共用密钥）
 *   - 转发浏览器 → Agent 的控制消息（创建/输入/resize/删除会话）
 *   - 广播 Agent → 浏览器 的输出与状态
 *   - 维护每会话的输出环形缓冲，供切换 / 重连 / 新浏览器重放
 *   - 缓存会话列表，新浏览器接入即可拿到当前会话
 * ═══════════════════════════════════════════════════════════════
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createAuthMiddleware } = require('./auth');

// ─── 配置 ───────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error('❌ 加载 config.json 失败，请复制 config.json.example 为 config.json 并编辑。');
  console.error(err.message);
  process.exit(1);
}

// 极简 .env 加载（无第三方依赖）：把 ../.env 中的 KEY=VALUE 注入 process.env
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 无 .env 文件则忽略 */ }
})();

// token 优先级：环境变量 > config.json（避免 token 进入代码仓库）
config.token = process.env.CLAUDE_WEB_TOKEN || config.token;

const PORT = config.port || 3000;
const { verify, generateSessionId } = createAuthMiddleware(config);

// 每会话输出缓冲上限（字节，约等于字符数）
const SCROLLBACK_LIMIT = 200 * 1024;

// ─── Express ────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agentConnected: !!agentSocket, sessions: sessionList.length });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── 连接状态 ───────────────────────────────────────────────────
const browserClients = new Map(); // clientId -> ws
let agentSocket = null;

// 会话快照（由 Agent 上报）
let sessionList = []; // [{ id, title, cwd, pid, status, createdAt }]
// 每会话输出滚动缓冲
const scrollback = new Map(); // sessionId -> string

// ─── 工具 ───────────────────────────────────────────────────────
function broadcastToBrowsers(data) {
  const payload = JSON.stringify(data);
  for (const [, ws] of browserClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function sendToAgent(data) {
  if (agentSocket && agentSocket.readyState === 1) {
    agentSocket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function appendScrollback(sessionId, chunk) {
  let buf = (scrollback.get(sessionId) || '') + chunk;
  if (buf.length > SCROLLBACK_LIMIT) buf = buf.slice(buf.length - SCROLLBACK_LIMIT);
  scrollback.set(sessionId, buf);
}

// ─── WebSocket 处理 ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = generateSessionId();
  console.log(`🔗 新连接: ${clientId} from ${req.socket.remoteAddress}`);

  let authenticated = false;
  let clientType = null; // 'browser' | 'agent'

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // ── 鉴权 ───────────────────────────────────────────────
    if (data.type === 'auth') {
      if (!verify(data.token)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
        ws.close(4001, 'Invalid token');
        return;
      }
      authenticated = true;
      clearTimeout(authTimeout);

      if (data.role === 'agent') {
        clientType = 'agent';
        if (agentSocket && agentSocket !== ws) agentSocket.close(4000, 'New agent connected');
        agentSocket = ws;
        console.log(`🤖 Agent 已连接: ${clientId}`);
        ws.send(JSON.stringify({ type: 'auth_ok', role: 'agent' }));
        broadcastToBrowsers({ type: 'agent_status', online: true });
        // 让 Agent 上报当前会话
        sendToAgent({ type: 'terminal_list' });
      } else {
        clientType = 'browser';
        browserClients.set(clientId, ws);
        console.log(`🌐 浏览器已连接: ${clientId} (共 ${browserClients.size})`);
        ws.send(JSON.stringify({
          type: 'auth_ok',
          role: 'browser',
          clientId,
          agentOnline: !!agentSocket && agentSocket.readyState === 1,
          sessions: sessionList,
        }));
      }
      return;
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    // ── 浏览器 → Agent ─────────────────────────────────────
    if (clientType === 'browser') {
      switch (data.type) {
        case 'terminal_create':
        case 'terminal_input':
        case 'terminal_resize':
        case 'terminal_delete':
        case 'terminal_list':
        case 'chat': {
          if (data.type === 'terminal_delete') scrollback.delete(data.sessionId);
          const ok = sendToAgent(data);
          if (!ok) {
            ws.send(JSON.stringify({
              type: 'terminal_error',
              sessionId: data.sessionId,
              message: 'Agent 离线，操作未送达',
            }));
          }
          break;
        }
        // 浏览器请求重放某会话的历史输出（切换 / 刚加载页面）
        case 'terminal_attach': {
          const buf = scrollback.get(data.sessionId);
          if (buf) {
            ws.send(JSON.stringify({ type: 'terminal_output', sessionId: data.sessionId, data: buf, replay: true }));
          }
          ws.send(JSON.stringify({ type: 'terminal_attached', sessionId: data.sessionId }));
          break;
        }
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
      return;
    }

    // ── Agent → 浏览器 ─────────────────────────────────────
    if (clientType === 'agent') {
      switch (data.type) {
        case 'terminal_output':
          appendScrollback(data.sessionId, data.data);
          broadcastToBrowsers(data);
          break;
        case 'terminal_created':
        case 'terminal_exit':
        case 'terminal_closed':
        case 'terminal_error':
        case 'stream':
        case 'status':
        case 'error':
          if (data.type === 'terminal_closed') scrollback.delete(data.sessionId);
          broadcastToBrowsers(data);
          break;
        case 'sessions':
          sessionList = Array.isArray(data.sessions) ? data.sessions : [];
          broadcastToBrowsers({ type: 'sessions', sessions: sessionList });
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    }
  });

  ws.on('close', (code) => {
    clearTimeout(authTimeout);
    console.log(`🔌 断开: ${clientId} (${clientType || 'unauth'}, code: ${code})`);
    if (clientType === 'agent' && agentSocket === ws) {
      agentSocket = null;
      // Agent 掉线：把已知会话标记为 disconnected（保留列表，便于前端展示）
      sessionList = sessionList.map((s) => ({ ...s, status: 'disconnected' }));
      broadcastToBrowsers({ type: 'agent_status', online: false });
      broadcastToBrowsers({ type: 'sessions', sessions: sessionList });
    } else if (clientType === 'browser') {
      browserClients.delete(clientId);
    }
  });

  ws.on('error', (err) => console.error(`⚠  WS 错误 ${clientId}:`, err.message));
});

// ─── 清理失活浏览器 ─────────────────────────────────────────────
setInterval(() => {
  for (const [id, ws] of browserClients) {
    if (ws.readyState !== 1) browserClients.delete(id);
  }
}, 30000);

// ─── 启动 ───────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         Claude Web Server 🚀             ║');
  console.log(`║  HTTP + WS 监听端口 ${String(PORT).padEnd(21)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n🛑 正在关闭...');
  for (const [, ws] of browserClients) ws.close(1001, 'Server shutting down');
  if (agentSocket) agentSocket.close(1001, 'Server shutting down');
  wss.close();
  server.close();
  process.exit(0);
});
