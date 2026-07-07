/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 本地 Agent
 *
 * 职责：
 *   - 连接云服务器（带自动重连）
 *   - 管理多个交互式终端会话（创建 / 输入 / resize / 删除）
 *   - 每个会话绑定一个独立工作目录
 *   - 兼容旧的 Claude Code 聊天协议（chat / stream-json）
 * ═══════════════════════════════════════════════════════════════
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const sessionManager = require('./session-manager');
const logger = require('../logger');

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

// 极简 .env 加载：把 ../.env 中的 KEY=VALUE 注入 process.env
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 无 .env 文件则忽略 */ }
})();

// token 优先级：环境变量 > config.tokens（取第一个） > config.token（兼容旧版）
if (process.env.CLAUDE_WEB_TOKEN) {
  config.token = process.env.CLAUDE_WEB_TOKEN;
} else if (!config.token && config.tokens) {
  config.token = Object.keys(config.tokens)[0];
}

const {
  token,
  serverHost,
  serverPort = 3000,
  useTLS = false,
  workspaceRoot,
  serverIp,
} = config;

// Nginx 反向代理模式：Node.js 不处理 TLS，但 Agent 仍需通过 WSS 连接
// 设置 CW_USE_WSS=true 环境变量，或在 config.json 中设 useTLS:true 均可
const useWSS = useTLS || process.env.CW_USE_WSS === 'true';
const SERVER_URL = `${useWSS ? 'wss' : 'ws'}://${serverHost}:${serverPort}`;
const ROOT = sessionManager.setWorkspaceRoot(workspaceRoot);

// 若配置了 serverIp，覆盖 dns.lookup，让域名直接解析到该 IP（DNS 不可用时的 fallback）
// 域名仍作为 TLS servername，证书校验照常进行。
if (serverIp) {
  const dns = require('dns');
  const _origLookup = dns.lookup.bind(dns);
  // Node.js v24 的 https 内部以 {all:true} 调用 lookup，需返回地址数组；
  // 普通调用时返回单地址。两种格式都处理，保持 TLS servername 为域名以通过证书校验。
  dns.lookup = function (hostname, options, callback) {
    if (hostname === serverHost) {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'object' ? options : {};
      if (opts.all) return cb(null, [{ address: serverIp, family: 4 }]);
      return cb(null, serverIp, 4);
    }
    return _origLookup(hostname, options, callback);
  };
}

// 初始化日志
logger.init('agent');
logger.info('Agent 启动', { serverHost, serverPort, workspaceRoot: ROOT });

// ─── 状态 ───────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastPongAt = 0;        // 最近一次收到服务器 pong 的时间戳
let heartbeatTimer = null; // 心跳定时器
let deadConnectionTimer = null; // 死连接检测定时器
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_MS = Number(process.env.CW_HEARTBEAT_MS) || 25000;       // 每 25s 发一次心跳
const PONG_TIMEOUT_MS = Number(process.env.CW_PONG_TIMEOUT_MS) || 70000; // 超过 70s 没收到任何 pong → 判定连接已死

// 旧聊天协议：每会话的 claude 进程
const chatProcesses = new Map(); // sessionId -> { proc, queue, history }

// ─── WebSocket 连接 ─────────────────────────────────────────────
function connect() {
  logger.connection(`正在连接到 ${SERVER_URL}`);
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    logger.connection('已连接到服务器');
    reconnectAttempts = 0;
    lastPongAt = Date.now();

    // 开启 TCP keepalive，让操作系统也能较快发现死链
    try { ws._socket && ws._socket.setKeepAlive(true, 15000); } catch { /* ignore */ }

    ws.send(JSON.stringify({ type: 'auth', token, role: 'agent' }));

    // 启动心跳定时器
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

    // 启动死连接检测定时器
    if (deadConnectionTimer) clearInterval(deadConnectionTimer);
    deadConnectionTimer = setInterval(checkDeadConnection, PONG_TIMEOUT_MS / 2);
  });

  // 协议层 pong（服务器若用 ws.ping() 探测，这里自动回应并记录存活）
  ws.on('pong', () => {
    lastPongAt = Date.now();
    logger.heartbeat('收到 pong', { lastPongAtMs: lastPongAt });
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      logger.warn('收到无效 JSON');
      return;
    }
    handleMessage(data);
  });

  ws.on('close', (code) => {
    logger.connection(`与服务器断开 (code: ${code})`);
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (deadConnectionTimer) { clearInterval(deadConnectionTimer); deadConnectionTimer = null; }
    ws = null;
    // code 4000 = 服务器端 "New agent connected"：已有另一个 Agent 接管。
    // 若此时自动重连，会和对方互相踢下线形成每秒乒乓循环，导致会话错乱。
    // 因此被踢的 Agent 停止重连、进入空闲，确保全局只有一个活跃 Agent。
    if (code === 4000) {
      logger.warn('另一个 Agent 已接管服务器连接（code 4000）');
      logger.warn('本 Agent 停止自动重连并进入空闲，避免两个 Agent 互相抢占');
      logger.warn('请确认只运行一个 Agent；如需本机接管，请先停止另一个 Agent 再重启本进程');
      return;
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    logger.error('WebSocket 错误', { message: err.message, code: err.code });
    // 关键：ENETUNREACH / ECONNREFUSED 等网络错误常常只触发 error、不触发 close，
    // 若此处不排重连，事件循环无定时器 → Node 干净退出 → PM2 拉起 → 再次失败 →
    // 形成"每 30s 重启一次"的疯狂循环（曾一晚上崩溃 1631 次）。
    // scheduleReconnect 内部有 reconnectTimer 幂等保护，重复调用安全。
    scheduleReconnect();
  });
}

function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const now = Date.now();
    ws.ping(() => {
      logger.heartbeat('发送 heartbeat ping', { sentAt: now });
    });
  }
}

function checkDeadConnection() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const now = Date.now();
  const timeSincePong = now - lastPongAt;

  if (timeSincePong > PONG_TIMEOUT_MS) {
    logger.error('检测到死连接（half-open），强制 terminate', {
      timeSincePongMs: timeSincePong,
      thresholdMs: PONG_TIMEOUT_MS,
    });
    // 用 terminate() 而非 close()：half-open 时 TCP 层假装存活，
    // close() 握手永远等不到对端 ACK，terminate() 直接销毁 socket 才能触发 close 事件
    try { ws.terminate(); } catch { /* ignore */ }
  } else if (timeSincePong > PONG_TIMEOUT_MS / 2) {
    logger.warn('连接可能不稳定', { timeSincePongMs: timeSincePong });
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  logger.connection(`${delay / 1000}s 后重连 (第 ${reconnectAttempts} 次)...`, { delayMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

/** 向服务器上报完整会话列表 */
function reportSessions() {
  send({ type: 'sessions', sessions: sessionManager.listSessions() });
}

// ─── 终端输出批处理 ─────────────────────────────────────────────
// PTY 常在极短时间内产生大量小数据块（如 shell 启动横幅 fortune|cowsay|lolcat
// 会逐字符发送上百条彩色转义序列）。逐块走 WS 会放大延迟与卡顿。
// 这里按 ~12ms 窗口合并成一条消息发送，保持流畅手感的同时大幅减少消息数。
const outBuffers = new Map(); // sessionId -> { data, timer }
const OUT_FLUSH_MS = 12;
const OUT_MAX_BYTES = 64 * 1024;

function queueOutput(sessionId, chunk) {
  let b = outBuffers.get(sessionId);
  if (!b) { b = { data: '', timer: null }; outBuffers.set(sessionId, b); }
  b.data += chunk;
  if (Buffer.byteLength(b.data) >= OUT_MAX_BYTES) { flushOutput(sessionId); return; }
  if (!b.timer) b.timer = setTimeout(() => flushOutput(sessionId), OUT_FLUSH_MS);
}

function flushOutput(sessionId) {
  const b = outBuffers.get(sessionId);
  if (!b) return;
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  if (b.data) { send({ type: 'terminal_output', sessionId, data: b.data }); b.data = ''; }
}

function dropOutputBuffer(sessionId) {
  const b = outBuffers.get(sessionId);
  if (b && b.timer) clearTimeout(b.timer);
  outBuffers.delete(sessionId);
}

// ─── 消息处理 ───────────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      logger.info('Agent 认证成功');
      // 恢复已有的会话目录
      const recovered = sessionManager.recoverSessions();
      if (recovered.length > 0) {
        logger.info(`已恢复 ${recovered.length} 个会话目录`, { count: recovered.length });
      }
      reportSessions();
      break;

    // ── 终端：创建 ────────────────────────────────────────────
    case 'terminal_create':
      onTerminalCreate(data);
      break;

    // ── 终端：输入 ────────────────────────────────────────────
    case 'terminal_input': {
      const session = sessionManager.getSession(data.sessionId);
      if (!session) {
        send({ type: 'terminal_error', sessionId: data.sessionId, message: '终端不存在，请重新创建会话' });
        break;
      }
      // 惰性恢复：Agent 重启后会话为 recovered，首次输入即自动 re-attach
      if (session.status === 'recovered' || !session.terminal) attachSession(session);
      if (session.terminal && session.status === 'running') {
        session.terminal.write(data.data);
      } else {
        send({ type: 'terminal_error', sessionId: data.sessionId, message: '终端不存在或已退出，请重新创建会话或点击该会话激活它' });
      }
      break;
    }

    // ── 终端：resize ─────────────────────────────────────────
    case 'terminal_resize': {
      const session = sessionManager.getSession(data.sessionId);
      if (!session) break;
      // 惰性恢复：selectSession 切到会话时会发 resize，借此自动 re-attach
      if (session.status === 'recovered' || !session.terminal) attachSession(session);
      if (session.terminal) session.terminal.resize(data.cols, data.rows);
      break;
    }

    // ── 终端：删除 ────────────────────────────────────────────
    case 'terminal_delete': {
      dropOutputBuffer(data.sessionId);
      sessionManager.deleteSession(data.sessionId, !!data.deleteFiles);
      send({ type: 'terminal_closed', sessionId: data.sessionId });
      reportSessions();
      break;
    }

    // ── 请求会话列表 ──────────────────────────────────────────
    case 'terminal_list':
      reportSessions();
      break;

    // ── 旧聊天协议 ────────────────────────────────────────────
    case 'chat':
      handleChatMessage(data);
      break;

    case 'pong':
      lastPongAt = Date.now();
      break;

    case 'error':
      logger.error('收到服务器错误消息', { message: data.message });
      break;

    default:
      logger.warn('未知消息类型', { type: data.type });
  }
}

/**
 * 为一个 recovered 会话创建 tmux 客户端并接回 live 会话（re-attach）。
 * 幂等：createTerminal 内部用 `tmux new-session -A`，会话已存在则 attach。
 * @returns {boolean} 是否成功
 */
function attachSession(session) {
  const sessionId = session.id;
  try {
    const { createTerminal } = require('./terminal');
    const terminal = createTerminal({
      sessionId,
      cwd: session.cwd,
      onData: (chunk) => queueOutput(sessionId, chunk),
      onExit: (evt) => {
        flushOutput(sessionId);
        if (evt && evt.sessionAlive) return; // 仅 detach，tmux 会话仍存活，不算退出
        session.status = 'exited';
        send({ type: 'terminal_exit', sessionId, exitCode: evt.exitCode, signal: evt.signal });
        reportSessions();
      },
    });
    session.terminal = terminal;
    session.pid = terminal.pid;
    session.status = 'running';
    logger.info('已 re-attach 恢复会话', { sessionId: sessionId.slice(0, 8), pid: terminal.pid });
    return true;
  } catch (err) {
    logger.error('re-attach 会话失败', { sessionId: sessionId.slice(0, 8), message: err.message });
    return false;
  }
}

function onTerminalCreate(data) {
  const { sessionId, title } = data;
  if (!sessionId) return;

  // 已存在的会话：可能是正在运行、已退出、或已恢复
  const existing = sessionManager.getSession(sessionId);
  if (existing) {
    // 已恢复的会话（status='recovered'）：re-attach 到存活的 tmux 会话
    if (existing.status === 'recovered' || !existing.terminal) {
      if (!attachSession(existing)) {
        send({ type: 'terminal_error', sessionId, message: `恢复会话失败，请重新创建` });
        return;
      }
    }

    // 返回已有会话的信息
    send({ type: 'terminal_created', sessionId, title: existing.title, cwd: existing.cwd, pid: existing.pid, status: existing.status });
    reportSessions();
    return;
  }

  // 创建全新会话
  try {
    const session = sessionManager.createSession(sessionId, title || '新会话', {
      onData: (sid, chunk) => queueOutput(sid, chunk),
      onExit: (sid, evt) => {
        flushOutput(sid);
        send({ type: 'terminal_exit', sessionId: sid, exitCode: evt.exitCode, signal: evt.signal });
        reportSessions();
      },
    });
    send({
      type: 'terminal_created',
      sessionId,
      title: session.title,
      cwd: session.cwd,
      pid: session.pid,
      status: session.status,
    });
    reportSessions();
  } catch (err) {
    logger.error('创建终端失败', { message: err.message });
    send({ type: 'terminal_error', sessionId, message: `创建终端失败: ${err.message}` });
  }
}

// ─── 旧聊天协议（claude -p, stream-json）─────────────────────────
function handleChatMessage(data) {
  const { sessionId, message } = data;
  if (!sessionId || !message) return;

  if (message.trim() === '/clear') {
    if (chatProcesses.has(sessionId)) {
      chatProcesses.get(sessionId).history = [];
      chatProcesses.get(sessionId).queue = [];
    }
    send({ type: 'status', sessionId, status: 'done', message: 'Conversation cleared' });
    return;
  }

  if (chatProcesses.has(sessionId) && chatProcesses.get(sessionId).proc) {
    chatProcesses.get(sessionId).queue.push({ message });
    return;
  }
  runClaudeProcess(sessionId, message);
}

function runClaudeProcess(sessionId, message) {
  if (!chatProcesses.has(sessionId)) {
    chatProcesses.set(sessionId, { proc: null, queue: [], history: [] });
  }
  const session = chatProcesses.get(sessionId);
  send({ type: 'status', sessionId, status: 'thinking' });

  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions'];

  let prompt = message;
  if (session.history.length > 0) {
    const parts = ['Previous conversation:\n'];
    for (const turn of session.history) {
      parts.push(`User: ${turn.user}`);
      if (turn.assistant) parts.push(`Assistant: ${turn.assistant}`);
    }
    parts.push('\n---\n', `User's latest message: ${message}`);
    prompt = parts.join('\n');
  }

  const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  session.proc = proc;

  let buffer = '';
  let closed = false;
  let lastResult = null;

  function finalize(exitCode, isError, errorMsg) {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);

    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        send({ type: 'stream', sessionId, event });
        if (event.type === 'result' && event.result) lastResult = event.result;
      } catch { /* ignore */ }
    }

    if (lastResult && !isError) {
      session.history.push({ user: message, assistant: lastResult });
      if (session.history.length > 50) session.history = session.history.slice(-50);
    }

    send({ type: 'status', sessionId, status: isError ? 'error' : 'done', exitCode, message: isError ? errorMsg : undefined });

    session.proc = null;
    if (session.queue.length > 0) {
      const next = session.queue.shift();
      setImmediate(() => runClaudeProcess(sessionId, next.message));
    }
  }

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        send({ type: 'stream', sessionId, event });
        if (event.type === 'result' && event.result) lastResult = event.result;
      } catch { /* non-JSON */ }
    }
  });
  proc.stderr.on('data', (chunk) => console.error(`   📝 stderr: ${chunk.toString().trim()}`));
  proc.on('close', (code) => finalize(code, false, null));
  proc.on('error', (err) => finalize(-1, true, `Failed to start Claude: ${err.message}`));
  proc.stdin.on('error', () => {});
  proc.stdin.write(prompt + '\n');
  proc.stdin.end();

  const timeout = setTimeout(() => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000);
    }
  }, 5 * 60 * 1000);
}

// ─── 启动 ───────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║         Claude Web Agent 🤖              ║');
console.log(`║  Server : ${SERVER_URL.padEnd(32)}║`);
console.log('║  Mode   : 交互式终端 (node-pty)           ║');
console.log(`║  Root   : ${ROOT.slice(0, 32).padEnd(32)}║`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

connect();

// ─── 进程级兜底：绝不因意外错误静默退出 ─────────────────────────
// Agent 是长驻服务，宁可日志爆炸也别让 PM2 陷入 "崩溃-重启" 循环。
// 只要事件循环里还有 reconnectTimer / heartbeatTimer / WS，就继续存活。
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException（已吞下、进程保持存活）', {
    message: err && err.message, code: err && err.code, stack: err && err.stack,
  });
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection（已吞下、进程保持存活）', {
    message: reason && reason.message ? reason.message : String(reason),
  });
});

// ─── 优雅关闭 ───────────────────────────────────────────────────
function shutdown() {
  console.log('\n🛑 正在关闭 Agent...');
  sessionManager.destroyAllSessions();
  for (const [, s] of chatProcesses) if (s.proc) s.proc.kill('SIGTERM');
  if (ws) ws.close(1000, 'Agent shutting down');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
