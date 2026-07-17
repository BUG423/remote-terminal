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

// 为所有 console 输出添加时间戳，方便排查时序问题
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
console.log = (...args) => origLog(`[${ts()}]`, ...args);
console.warn = (...args) => origWarn(`[${ts()}]`, ...args);
console.error = (...args) => origError(`[${ts()}]`, ...args);

// ─── 配置 ───────────────────────────────────────────────────────
const CONFIG_PATH = process.env.CW_CONFIG_PATH || path.join(__dirname, '..', 'config.json');
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

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const PORT = positiveInt(process.env.CW_PORT || config.port, 3002, 1, 65535);
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

const SCROLLBACK_LIMIT_BYTES = positiveInt(
  process.env.CW_SCROLLBACK_BYTES || config.scrollbackBytes,
  256 * 1024,
  16 * 1024,
  4 * 1024 * 1024
);
const MAX_SESSIONS_PER_AGENT = positiveInt(
  process.env.CW_MAX_SESSIONS || config.maxSessions,
  12,
  1,
  100
);
const MAX_BROWSERS_PER_TOKEN = positiveInt(
  process.env.CW_MAX_BROWSERS_PER_TOKEN || config.maxBrowsersPerToken,
  8,
  1,
  100
);
const MAX_TOTAL_CONNECTIONS = positiveInt(
  process.env.CW_MAX_TOTAL_CONNECTIONS || config.maxTotalConnections,
  200,
  10,
  5000
);
const MAX_WS_BUFFERED_BYTES = positiveInt(
  process.env.CW_MAX_WS_BUFFERED_BYTES || config.maxWsBufferedBytes,
  2 * 1024 * 1024,
  64 * 1024,
  32 * 1024 * 1024
);
const ENABLE_LEGACY_CHAT = config.enableLegacyChat === true;

// ─── Express ────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/vendor/xterm.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
});
app.get('/vendor/xterm.css', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
});
app.get('/vendor/addon-fit.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  if (config.healthDetails !== true) return res.json({ status: 'ok' });
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

const MAX_WS_PAYLOAD_BYTES = positiveInt(process.env.CW_MAX_WS_PAYLOAD_BYTES, 1024 * 1024, 64 * 1024, 8 * 1024 * 1024);
const MAX_SESSION_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 120;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_AGENT_OUTPUT_BYTES = 128 * 1024;
const MAX_CWD_LENGTH = 4096;
const MAX_COLS = 300;
const MAX_ROWS = 100;

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });

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
    if (b.token === token) safeSend(b.ws, payload);
  }
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    console.warn(`⚠  WebSocket 发送积压超过 ${MAX_WS_BUFFERED_BYTES} 字节，关闭慢连接`);
    try { ws.close(1013, 'Client is too slow'); } catch { /* ignore */ }
    return false;
  }
  try {
    ws.send(payload);
    return true;
  } catch (err) {
    console.warn('⚠  WebSocket 发送失败:', err.message);
    return false;
  }
}

/** 向指定 Token 的 Agent 发送消息 */
function sendToAgent(token, data) {
  const slot = agents.get(token);
  if (slot && slot.ws && slot.ws.readyState === 1) {
    return safeSend(slot.ws, JSON.stringify(data));
  }
  return false;
}

/** 追加滚动缓冲（按 Agent 隔离） */
function appendScrollback(token, sessionId, chunk) {
  const slot = agents.get(token);
  if (!slot || !validSessionId(sessionId) || typeof chunk !== 'string') return;
  let buf = (slot.scrollback.get(sessionId) || '') + chunk;
  const bytes = Buffer.from(buf, 'utf8');
  if (bytes.length > SCROLLBACK_LIMIT_BYTES) {
    let start = bytes.length - SCROLLBACK_LIMIT_BYTES;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    buf = bytes.subarray(start).toString('utf8');
  }
  slot.scrollback.set(sessionId, buf);
}

function isLoopbackAddress(addr) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
}

function getClientIp(req) {
  const remote = req.socket.remoteAddress || 'unknown';
  const realIp = (req.headers['x-real-ip'] || '').trim();
  return isLoopbackAddress(remote) && realIp ? realIp : remote;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    !/[\x00-\x1F\x7F]/.test(sessionId);
}

function sanitizeBrowserMessage(data) {
  if (!data || typeof data !== 'object') return { ok: false, message: 'Invalid message' };
  const type = data.type;

  if (type === 'ping' || type === 'terminal_list') return { ok: true, data: { type } };
  if (type === 'chat') {
    if (!ENABLE_LEGACY_CHAT) return { ok: false, sessionId: data.sessionId, message: 'Legacy chat is disabled' };
    if (!validSessionId(data.sessionId)) return { ok: false, message: 'Invalid sessionId' };
    if (typeof data.message !== 'string' || byteLength(data.message) > MAX_INPUT_BYTES) {
      return { ok: false, sessionId: data.sessionId, message: 'Invalid chat message' };
    }
    return { ok: true, data: { type, sessionId: data.sessionId, message: data.message } };
  }

  if (!validSessionId(data.sessionId)) return { ok: false, message: 'Invalid sessionId' };

  switch (type) {
    case 'terminal_create': {
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      return {
        ok: true,
        data: {
          type,
          sessionId: data.sessionId,
          title: (title || '新会话').slice(0, MAX_TITLE_LENGTH),
        },
      };
    }
    case 'terminal_input':
      if (typeof data.data !== 'string' || byteLength(data.data) > MAX_INPUT_BYTES) {
        return { ok: false, sessionId: data.sessionId, message: 'Invalid terminal input' };
      }
      return { ok: true, data: { type, sessionId: data.sessionId, data: data.data } };
    case 'terminal_resize': {
      const cols = Math.max(2, Math.min(MAX_COLS, Number.parseInt(data.cols, 10) || 120));
      const rows = Math.max(2, Math.min(MAX_ROWS, Number.parseInt(data.rows, 10) || 30));
      return { ok: true, data: { type, sessionId: data.sessionId, cols, rows } };
    }
    case 'terminal_delete':
      return { ok: true, data: { type, sessionId: data.sessionId, deleteFiles: data.deleteFiles === true } };
    case 'terminal_attach':
      return { ok: true, data: { type, sessionId: data.sessionId } };
    default:
      return { ok: false, sessionId: data.sessionId, message: 'Unknown message type' };
  }
}

function sanitizeSession(session) {
  if (!session || !validSessionId(session.id)) return null;
  if (!['running', 'exited', 'disconnected'].includes(session.status)) return null;
  return {
    id: session.id,
    title: (typeof session.title === 'string' ? session.title : '新会话').slice(0, MAX_TITLE_LENGTH),
    cwd: (typeof session.cwd === 'string' ? session.cwd : '').slice(0, MAX_CWD_LENGTH),
    pid: Number.isInteger(session.pid) && session.pid >= 0 ? session.pid : null,
    status: session.status,
    createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
  };
}

function sanitizeSessionList(value) {
  const raw = Array.isArray(value) ? value.slice(0, MAX_SESSIONS_PER_AGENT) : [];
  const seenIds = new Set();
  const sessions = [];
  for (const item of raw) {
    const session = sanitizeSession(item);
    if (!session || seenIds.has(session.id)) continue;
    seenIds.add(session.id);
    sessions.push(session);
  }
  return sessions;
}

// ─── WebSocket 处理 ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = generateSessionId();
  if (wss.clients.size > MAX_TOTAL_CONNECTIONS) {
    safeSend(ws, JSON.stringify({ type: 'error', message: 'Server connection limit reached' }));
    ws.close(1013, 'Server connection limit reached');
    return;
  }
  // 只在连接来自本机反向代理时信任 X-Real-IP；直连 Node 端口时使用真实 socket 地址。
  // 这样即使误把 Node 端口暴露到公网，客户端也不能伪造 X-Real-IP 绕过速率限制。
  const clientIp = getClientIp(req);
  console.log(`🔗 新连接: ${clientId} from ${clientIp} (agent=${req.headers['user-agent']?.slice(0,40)||'?'})`);

  // 死连接检测：任何来自对端的字节（pong / ping / message）都算存活信号。
  // 只监听 pong 会误杀活着但 pong 偶尔延迟的连接（曾出现每 60s 断一次、
  // 浏览器 UI 不停闪烁的问题）。Agent 每 25s 主动 ping 一次，仅凭这个
  // 就足以证明存活；无需再等 pong 才认账。
  ws.isAlive = true;
  const markAlive = () => { ws.isAlive = true; };
  ws.on('pong', markAlive);
  ws.on('ping', markAlive);
  ws.on('message', markAlive);
  try { req.socket.setKeepAlive(true, 15000); } catch { /* ignore */ }

  let authenticated = false;
  let clientType = null;   // 'browser' | 'agent'
  let boundToken = null;   // 鉴权通过后绑定的 Token
  let malformedMessages = 0;
  let rateWindowStarted = Date.now();
  let rateMessageCount = 0;
  let rateMessageBytes = 0;

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      safeSend(ws, JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (raw) => {
    ws.isAlive = true;
    const now = Date.now();
    if (now - rateWindowStarted >= 1000) {
      rateWindowStarted = now;
      rateMessageCount = 0;
      rateMessageBytes = 0;
    }
    rateMessageCount++;
    rateMessageBytes += raw.length;
    const messageLimit = clientType === 'agent' ? 4000 : 1000;
    const byteLimit = clientType === 'agent' ? 32 * 1024 * 1024 : 4 * 1024 * 1024;
    if (rateMessageCount > messageLimit || rateMessageBytes > byteLimit) {
      safeSend(ws, JSON.stringify({ type: 'error', message: 'Message rate limit exceeded' }));
      ws.close(1008, 'Message rate limit exceeded');
      return;
    }
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      malformedMessages++;
      safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      if (malformedMessages >= 3) ws.close(1008, 'Too many malformed messages');
      return;
    }

    // ── 鉴权 ───────────────────────────────────────────────
    if (data.type === 'auth') {
      if (authenticated) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Already authenticated' }));
        ws.close(4002, 'Already authenticated');
        return;
      }
      if (!['browser', 'agent'].includes(data.role)) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid role' }));
        ws.close(4001, 'Invalid role');
        return;
      }

      const blocked = rateLimiter.checkBlocked(clientIp);
      if (blocked.blocked) {
        console.warn(`🚫 拒绝认证: ${clientId} (${clientIp}): ${blocked.reason}`);
        safeSend(ws, JSON.stringify({ type: 'error', message: blocked.reason }));
        ws.close(4001, 'Rate limited');
        return;
      }

      const result = verify(data.token);
      if (!result.valid) {
        rateLimiter.recordFailed(clientIp);
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid token' }));
        ws.close(4001, 'Invalid token');
        return;
      }

      if (data.role === 'browser' && countBrowsersFor(result.token) >= MAX_BROWSERS_PER_TOKEN) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Too many browser connections' }));
        ws.close(4003, 'Too many browser connections');
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
        safeSend(ws, JSON.stringify({ type: 'auth_ok', role: 'agent' }));
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
        // 始终过滤掉 disconnected 状态会话（这些是 Agent 断开后残留的）
        const browserSessions = (agentOnline && slot)
          ? slot.sessions.filter(s => s.status !== 'disconnected')
          : [];
        safeSend(ws, JSON.stringify({
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
      safeSend(ws, JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    // ── 浏览器 → Agent ─────────────────────────────────────
    if (clientType === 'browser') {
      const checked = sanitizeBrowserMessage(data);
      if (!checked.ok) {
        safeSend(ws, JSON.stringify({ type: 'terminal_error', sessionId: checked.sessionId, message: checked.message }));
        return;
      }
      const msg = checked.data;

      switch (msg.type) {
        case 'terminal_create':
        case 'terminal_input':
        case 'terminal_resize':
        case 'terminal_delete':
        case 'terminal_list':
        case 'chat': {
          if (msg.type === 'terminal_create') {
            const slot = agents.get(boundToken);
            const alreadyExists = slot && slot.sessions.some((session) => session.id === msg.sessionId);
            if (!alreadyExists && slot && slot.sessions.length >= MAX_SESSIONS_PER_AGENT) {
              safeSend(ws, JSON.stringify({
                type: 'terminal_error',
                sessionId: msg.sessionId,
                message: `会话数量已达上限 (${MAX_SESSIONS_PER_AGENT})`,
              }));
              break;
            }
          }
          if (msg.type === 'terminal_delete') {
            const slot = agents.get(boundToken);
            if (slot) slot.scrollback.delete(msg.sessionId);
          }
          const ok = sendToAgent(boundToken, msg);
          if (!ok) {
            safeSend(ws, JSON.stringify({
              type: 'terminal_error',
              sessionId: msg.sessionId,
              message: 'Agent 离线，操作未送达',
            }));
          }
          break;
        }
        case 'terminal_attach': {
          const slot = agents.get(boundToken);
          if (slot) {
            const buf = slot.scrollback.get(msg.sessionId);
            if (buf) {
              safeSend(ws, JSON.stringify({ type: 'terminal_output', sessionId: msg.sessionId, data: buf, replay: true }));
            }
          }
          safeSend(ws, JSON.stringify({ type: 'terminal_attached', sessionId: msg.sessionId }));
          break;
        }
        case 'ping':
          safeSend(ws, JSON.stringify({ type: 'pong' }));
          break;
      }
      return;
    }

    // ── Agent → 浏览器（仅限同 Token）────────────────────────
    if (clientType === 'agent') {
      switch (data.type) {
        case 'terminal_output': {
          if (!validSessionId(data.sessionId) || typeof data.data !== 'string' ||
              byteLength(data.data) > MAX_AGENT_OUTPUT_BYTES) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid terminal output' }));
            break;
          }
          const output = {
            type: 'terminal_output',
            sessionId: data.sessionId,
            data: data.data,
            ...(data.recovered === true ? { recovered: true } : {}),
          };
          appendScrollback(boundToken, output.sessionId, output.data);
          broadcastToBrowsers(boundToken, output);
          break;
        }
        case 'terminal_created':
        case 'terminal_exit':
        case 'terminal_closed':
        case 'terminal_error':
        case 'stream':
        case 'status':
        case 'error':
          if (data.sessionId !== undefined && !validSessionId(data.sessionId)) break;
          if (data.type === 'terminal_closed') {
            const slot = agents.get(boundToken);
            if (slot) slot.scrollback.delete(data.sessionId);
          }
          broadcastToBrowsers(boundToken, data);
          break;
        case 'sessions': {
          const slot = agents.get(boundToken);
          if (slot) {
            slot.sessions = sanitizeSessionList(data.sessions);
            broadcastToBrowsers(boundToken, { type: 'sessions', sessions: slot.sessions });
          }
          break;
        }
        case 'ping':
          safeSend(ws, JSON.stringify({ type: 'pong' }));
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
const heartbeatTimer = setInterval(() => {
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
      // 心跳发现 Agent 死连接：补充标记 + 通知 + 清理（兜底 close 事件的竞态）
      if (slot.sessions.length > 0) {
        slot.sessions = slot.sessions.map((s) => ({ ...s, status: 'disconnected' }));
        broadcastToBrowsers(token, { type: 'agent_status', online: false, agentName: slot.name });
        broadcastToBrowsers(token, { type: 'sessions', sessions: slot.sessions });
        scheduleDisconnectedCleanup(token);
      }
      slot.ws = null;
    }
  }
}, 30000);

// ─── 启动 ───────────────────────────────────────────────────────
server.on('error', (err) => {
  console.error(`❌ Server 启动失败 (${BIND_HOST}:${PORT}): ${err.message}`);
  process.exit(1);
});

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

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n🛑 收到 ${signal}，正在关闭...`);
  clearInterval(heartbeatTimer);
  for (const [, slot] of agents) {
    if (slot.cleanupTimer) clearTimeout(slot.cleanupTimer);
  }
  for (const [, b] of browserClients) b.ws.close(1001, 'Server shutting down');
  for (const [, slot] of agents) { if (slot.ws) slot.ws.close(1001, 'Server shutting down'); }
  wss.close();
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  server.close(() => {
    process.exit(0);
  });
  if (redirectServer) redirectServer.close();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
