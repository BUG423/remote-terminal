/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 云端中继服务器（多 Agent 架构）
 *
 * 三方消息流：  浏览器 ⇄ Server ⇄ 本地 Agent
 *
 * Server 负责：
 *   - 多 Token 鉴权：每个 Agent 配独立 Token，浏览器按 Token 路由
 *   - 转发浏览器 → Agent 的控制消息（创建/输入/resize/删除会话）
 *   - 广播 Agent → 浏览器 的输出与状态（仅限同 Token 的浏览器）
 *   - 维护每 Agent 的会话列表缓存 + 每会话输出滚动缓冲
 * ═══════════════════════════════════════════════════════════════
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createAuthMiddleware } = require('./auth');
const rateLimiter = require('./rate-limiter');

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

// 极简 .env 加载
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

// token 可从环境变量覆盖（仅兼容旧单 token 模式）
config.token = process.env.CLAUDE_WEB_TOKEN || config.token;

const PORT = config.port || 3002;
const BIND_HOST = config.bindHost || '127.0.0.1';
const USE_TLS = config.useTLS === true;
const TLS_OPTIONS = USE_TLS ? (() => {
  try {
    const cert = fs.readFileSync(config.tlsCertPath, 'utf-8');
    const key = fs.readFileSync(config.tlsKeyPath, 'utf-8');
    console.log('🔒 TLS 证书加载成功');
    return { cert, key };
  } catch (err) {
    console.error('❌ TLS 证书加载失败:', err.message);
    process.exit(1);
  }
})() : null;

const { verify, tokenCount, mode: tokenMode, generateSessionId } = createAuthMiddleware(config);

// 每会话输出缓冲上限
const SCROLLBACK_LIMIT = 200 * 1024;

// ─── Express ────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  let agentCount = 0;
  for (const [, a] of agents) { if (a.ws && a.ws.readyState === 1) agentCount++; }
  res.json({ status: 'ok', tokenMode, tokenCount, agentCount, agentsOnline: agentCount });
});

// ─── HTTP / HTTPS 服务器 ──────────────────────────────────────────
let server;
let redirectServer = null;

if (USE_TLS) {
  server = https.createServer(TLS_OPTIONS, app);
  redirectServer = http.createServer((req, res) => {
    const host = req.headers.host || '';
    const target = `https://${host.replace(/:\d+$/, '')}:${PORT}${req.url}`;
    res.writeHead(301, { Location: target });
    res.end();
  });
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server });

// ─── 连接状态（多 Agent 架构）──────────────────────────────────────
// token → { ws, name, sessions: [], scrollback: Map<sessionId, string>, cleanupTimer }
/** @type {Map<string, {ws: WebSocket|null, name: string, sessions: any[], scrollback: Map<string,string>, cleanupTimer: any}>} */
const agents = new Map();

// 浏览器客户端：clientId → { ws, token }
/** @type {Map<string, {ws: WebSocket, token: string}>} */
const browserClients = new Map();

/** Agent 离线后残留 disconnected 会话的自动清理延迟 */
const DISCONNECTED_CLEANUP_MS = 30000;

/**
 * 获取或创建 Agent 槽位。
 */
function ensureAgentSlot(token, name) {
  let slot = agents.get(token);
  if (!slot) {
    slot = { ws: null, name: name || 'unknown', sessions: [], scrollback: new Map(), cleanupTimer: null };
    agents.set(token, slot);
  } else if (name && name !== 'unknown') {
    slot.name = name;
  }
  return slot;
}

/** Agent 离线后启动清理定时器：超时后自动清除残留的 disconnected 会话 */
function scheduleDisconnectedCleanup(token) {
  const slot = agents.get(token);
  if (!slot) return;
  if (slot.cleanupTimer) { clearTimeout(slot.cleanupTimer); slot.cleanupTimer = null; }
  slot.cleanupTimer = setTimeout(() => {
    const s = agents.get(token);
    if (s && !s.ws) {
      const removed = s.sessions.filter(x => x.status === 'disconnected').length;
      if (removed > 0) {
        s.sessions = [];
        s.scrollback.clear();
        broadcastToBrowsers(token, { type: 'sessions', sessions: [] });
        console.log(`🧹 已清理 Agent「${s.name}」的 ${removed} 个残留会话（离线超时）`);
      }
    }
    if (s) s.cleanupTimer = null;
  }, DISCONNECTED_CLEANUP_MS);
}

/** Agent 重连后取消清理定时器 */
function cancelDisconnectedCleanup(token) {
  const slot = agents.get(token);
  if (slot && slot.cleanupTimer) {
    clearTimeout(slot.cleanupTimer);
    slot.cleanupTimer = null;
  }
}

// ─── 工具 ───────────────────────────────────────────────────────
/** 向指定 Token 下的所有浏览器广播消息 */
function broadcastToBrowsers(token, data) {
  const payload = JSON.stringify(data);
  for (const [, b] of browserClients) {
    if (b.token === token && b.ws.readyState === 1) b.ws.send(payload);
  }
}

/** 向指定 Token 的 Agent 发送消息 */
function sendToAgent(token, data) {
  const slot = agents.get(token);
  if (slot && slot.ws && slot.ws.readyState === 1) {
    slot.ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

/** 追加滚动缓冲（按 Agent 隔离） */
function appendScrollback(token, sessionId, chunk) {
  const slot = agents.get(token);
  if (!slot) return;
  let buf = (slot.scrollback.get(sessionId) || '') + chunk;
  if (buf.length > SCROLLBACK_LIMIT) buf = buf.slice(buf.length - SCROLLBACK_LIMIT);
  slot.scrollback.set(sessionId, buf);
}

// ─── WebSocket 处理 ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = generateSessionId();
  const clientIp = req.socket.remoteAddress || 'unknown';
  console.log(`🔗 新连接: ${clientId} from ${clientIp}`);

  // 死连接检测
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  try { req.socket.setKeepAlive(true, 15000); } catch { /* ignore */ }

  let authenticated = false;
  let clientType = null;   // 'browser' | 'agent'
  let boundToken = null;   // 鉴权通过后绑定的 Token

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (raw) => {
    ws.isAlive = true;
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // ── 鉴权 ───────────────────────────────────────────────
    if (data.type === 'auth') {
      const blocked = rateLimiter.checkBlocked(clientIp);
      if (blocked.blocked) {
        console.warn(`🚫 拒绝认证: ${clientId} (${clientIp}): ${blocked.reason}`);
        ws.send(JSON.stringify({ type: 'error', message: blocked.reason }));
        ws.close(4001, 'Rate limited');
        return;
      }

      const result = verify(data.token);
      if (!result.valid) {
        rateLimiter.recordFailed(clientIp);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
        ws.close(4001, 'Invalid token');
        return;
      }

      rateLimiter.clearFor(clientIp);
      authenticated = true;
      boundToken = result.token;
      clearTimeout(authTimeout);

      if (data.role === 'agent') {
        clientType = 'agent';
        const slot = ensureAgentSlot(boundToken, result.name);
        // 同一 Token 的新 Agent 踢掉旧连接
        if (slot.ws && slot.ws !== ws && slot.ws.readyState === 1) {
          slot.ws.close(4000, 'New agent connected for this token');
        }
        slot.ws = ws;
        // Agent 重连，取消残留会话清理定时器
        cancelDisconnectedCleanup(boundToken);
        console.log(`🤖 Agent 已连接: ${result.name || boundToken.slice(0,8)} (token: ${boundToken.slice(0,8)}…)`);
        ws.send(JSON.stringify({ type: 'auth_ok', role: 'agent' }));
        // 通知该 Token 的浏览器：Agent 上线
        broadcastToBrowsers(boundToken, { type: 'agent_status', online: true, agentName: slot.name });
        // 请求 Agent 上报会话（Agent 重新上报后会覆盖服务器缓存的旧列表）
        sendToAgent(boundToken, { type: 'terminal_list' });
      } else {
        clientType = 'browser';
        browserClients.set(clientId, { ws, token: boundToken });
        const slot = agents.get(boundToken);
        const agentOnline = !!(slot && slot.ws && slot.ws.readyState === 1);
        console.log(`🌐 浏览器已连接: ${clientId} → ${result.name || boundToken.slice(0,8)} (共 ${countBrowsersFor(boundToken)} 个)`);
        // Agent 在线时发送实际会话列表；离线时不发送残留的 disconnected 会话
        const browserSessions = agentOnline && slot ? slot.sessions : [];
        ws.send(JSON.stringify({
          type: 'auth_ok',
          role: 'browser',
          clientId,
          agentName: slot ? slot.name : result.name,
          agentOnline,
          sessions: browserSessions,
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
          if (data.type === 'terminal_delete') {
            const slot = agents.get(boundToken);
            if (slot) slot.scrollback.delete(data.sessionId);
          }
          const ok = sendToAgent(boundToken, data);
          if (!ok) {
            ws.send(JSON.stringify({
              type: 'terminal_error',
              sessionId: data.sessionId,
              message: 'Agent 离线，操作未送达',
            }));
          }
          break;
        }
        case 'terminal_attach': {
          const slot = agents.get(boundToken);
          if (slot) {
            const buf = slot.scrollback.get(data.sessionId);
            if (buf) {
              ws.send(JSON.stringify({ type: 'terminal_output', sessionId: data.sessionId, data: buf, replay: true }));
            }
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

    // ── Agent → 浏览器（仅限同 Token）────────────────────────
    if (clientType === 'agent') {
      switch (data.type) {
        case 'terminal_output':
          appendScrollback(boundToken, data.sessionId, data.data);
          broadcastToBrowsers(boundToken, data);
          break;
        case 'terminal_created':
        case 'terminal_exit':
        case 'terminal_closed':
        case 'terminal_error':
        case 'stream':
        case 'status':
        case 'error':
          if (data.type === 'terminal_closed') {
            const slot = agents.get(boundToken);
            if (slot) slot.scrollback.delete(data.sessionId);
          }
          broadcastToBrowsers(boundToken, data);
          break;
        case 'sessions': {
          const slot = agents.get(boundToken);
          if (slot) {
            slot.sessions = Array.isArray(data.sessions) ? data.sessions : [];
            broadcastToBrowsers(boundToken, { type: 'sessions', sessions: slot.sessions });
          }
          break;
        }
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    }
  });

  ws.on('close', (code) => {
    clearTimeout(authTimeout);
    console.log(`🔌 断开: ${clientId} (${clientType || 'unauth'}, code: ${code})`);
    if (clientType === 'agent' && boundToken) {
      const slot = agents.get(boundToken);
      if (slot && slot.ws === ws) {
        slot.ws = null;
        // 标记会话为 disconnected（已连接的浏览器实时看到状态变化）
        slot.sessions = slot.sessions.map((s) => ({ ...s, status: 'disconnected' }));
        broadcastToBrowsers(boundToken, { type: 'agent_status', online: false, agentName: slot.name });
        broadcastToBrowsers(boundToken, { type: 'sessions', sessions: slot.sessions });
        // 启动清理定时器：Agent 若 30 秒内未重连，自动清除残留会话
        scheduleDisconnectedCleanup(boundToken);
      }
    } else if (clientType === 'browser') {
      browserClients.delete(clientId);
    }
  });

  ws.on('error', (err) => console.error(`⚠  WS 错误 ${clientId}:`, err.message));
});

/** 统计某 Token 下有多少浏览器连接 */
function countBrowsersFor(token) {
  let n = 0;
  for (const [, b] of browserClients) { if (b.token === token) n++; }
  return n;
}

// ─── 心跳 + 死连接清理 ──────────────────────────────────────────
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
  // 清理已关闭的引用
  for (const [id, b] of browserClients) {
    if (b.ws.readyState !== 1) browserClients.delete(id);
  }
  for (const [token, slot] of agents) {
    if (slot.ws && slot.ws.readyState !== 1) {
      slot.ws = null;
    }
  }
}, 30000);

// ─── 启动 ───────────────────────────────────────────────────────
server.listen(PORT, BIND_HOST, () => {
  const proto = USE_TLS ? 'HTTPS + WSS' : 'HTTP + WS';
  const rl = rateLimiter.stats();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         Claude Web Server 🚀             ║');
  console.log(`║  ${proto} 监听 ${String(BIND_HOST + ':' + PORT).padEnd(24)}║`);
  console.log(`║  🔑 模式: ${(tokenMode === 'multi' ? '多 Token (' + tokenCount + '个)' : '单 Token').padEnd(30)}║`);
  if (USE_TLS) console.log('║  🔒 TLS 加密已启用                       ║');
  console.log(`║  🛡  速率限制: ${String(rl.threshold + '次/' + (rl.windowMs/1000) + 's → 封' + (rl.blockMs/1000) + 's').padEnd(25)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

if (redirectServer) {
  const REDIRECT_PORT = config.redirectPort || 80;
  redirectServer.listen(REDIRECT_PORT, BIND_HOST, () => {
    console.log(`🔀 HTTP→HTTPS 重定向: ${BIND_HOST}:${REDIRECT_PORT} → ${PORT}`);
  });
  redirectServer.on('error', (err) => {
    if (err.code === 'EACCES') {
      console.warn(`⚠  无权限监听端口 ${REDIRECT_PORT}（需要 root），跳过 HTTP 重定向`);
    } else {
      console.warn(`⚠  HTTP 重定向服务器启动失败 (端口 ${REDIRECT_PORT}): ${err.message}`);
    }
  });
}

process.on('SIGINT', () => {
  console.log('\n🛑 正在关闭...');
  for (const [, b] of browserClients) b.ws.close(1001, 'Server shutting down');
  for (const [, slot] of agents) { if (slot.ws) slot.ws.close(1001, 'Server shutting down'); }
  wss.close();
  server.close();
  if (redirectServer) redirectServer.close();
  process.exit(0);
});
