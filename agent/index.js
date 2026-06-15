/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 本地 Agent
 *
 * 职责：
 *   - 连接云服务器（带自动重连）
 *   - 管理多个交互式终端会话（创建 / 输入 / resize / 删除）
 *   - 每个会话在共享的工作区根目录下启动
 *   - 兼容旧的 Claude Code 聊天协议（chat / stream-json）
 * ═══════════════════════════════════════════════════════════════
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const sessionManager = require('./session-manager');
const auditLog = require('./audit-log');

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
  serverPort = 3002,
  useTLS = false,
  workspaceRoot,
} = config;

const SERVER_URL = `${useTLS ? 'wss' : 'ws'}://${serverHost}:${serverPort}`;
const ROOT = sessionManager.setWorkspaceRoot(workspaceRoot);

// ─── 状态 ───────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastPongAt = 0;        // 最近一次收到服务器 pong 的时间戳
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_MS = Number(process.env.CW_HEARTBEAT_MS) || 25000;       // 每 25s 发一次心跳
const PONG_TIMEOUT_MS = Number(process.env.CW_PONG_TIMEOUT_MS) || 70000; // 超过 70s 没收到任何 pong → 判定连接已死

// 旧聊天协议：每会话的 claude 进程
const chatProcesses = new Map(); // sessionId -> { proc, queue, history }

// ─── WebSocket 连接 ─────────────────────────────────────────────
function connect() {
  console.log(`🔗 正在连接服务器: ${SERVER_URL}`);
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('✅ 已连接到服务器');
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    // 开启 TCP keepalive，让操作系统也能较快发现死链
    try { ws._socket && ws._socket.setKeepAlive(true, 15000); } catch { /* ignore */ }
    ws.send(JSON.stringify({ type: 'auth', token, role: 'agent' }));
  });

  // 协议层 pong（服务器若用 ws.ping() 探测，这里自动回应并记录存活）
  ws.on('pong', () => { lastPongAt = Date.now(); });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      console.warn('⚠  收到无效 JSON');
      return;
    }
    handleMessage(data);
  });

  ws.on('close', (code) => {
    console.log(`🔌 与服务器断开 (code: ${code})`);
    ws = null;
    // code 4000 = 服务器端 "New agent connected"：已有另一个 Agent 接管。
    // 若此时自动重连，会和对方互相踢下线形成每秒乒乓循环，导致会话错乱。
    // 因此被踢的 Agent 停止重连、进入空闲，确保全局只有一个活跃 Agent。
    if (code === 4000) {
      console.warn('⚠  另一个 Agent 已接管服务器连接（code 4000）。');
      console.warn('⚠  本 Agent 停止自动重连并进入空闲，避免两个 Agent 互相抢占。');
      console.warn('⚠  请确认只运行一个 Agent；如需本机接管，请先停止另一个 Agent 再重启本进程。');
      return;
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('⚠  WebSocket 错误:', err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`🔄 ${delay / 1000}s 后重连 (第 ${reconnectAttempts} 次)...`);
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
      console.log('🤖 Agent 认证成功');
      reportSessions();
      break;

    // ── 终端：创建 ────────────────────────────────────────────
    case 'terminal_create':
      onTerminalCreate(data);
      break;

    // ── 终端：输入 ────────────────────────────────────────────
    case 'terminal_input': {
      const session = sessionManager.getSession(data.sessionId);
      if (session && session.status === 'running') {
        session.terminal.write(data.data);
        // 审计日志：记录用户输入（仅 Enter 结束时写入完整命令行）
        auditLog.feed(data.sessionId, session.title, data.data);
      } else {
        send({ type: 'terminal_error', sessionId: data.sessionId, message: '终端不存在或已退出，请重新创建会话' });
      }
      break;
    }

    // ── 终端：resize ─────────────────────────────────────────
    case 'terminal_resize': {
      const session = sessionManager.getSession(data.sessionId);
      if (session) session.terminal.resize(data.cols, data.rows);
      break;
    }

    // ── 终端：删除 ────────────────────────────────────────────
    case 'terminal_delete': {
      dropOutputBuffer(data.sessionId);
      auditLog.clearSession(data.sessionId);
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

    default:
      console.log('📩 未知消息类型:', data.type);
  }
}

function onTerminalCreate(data) {
  const { sessionId, title } = data;
  if (!sessionId) return;

  // 已存在则直接回报，不重复创建
  if (sessionManager.getSession(sessionId)) {
    const s = sessionManager.getSession(sessionId);
    send({ type: 'terminal_created', sessionId, title: s.title, cwd: s.cwd, pid: s.pid, status: s.status });
    reportSessions();
    return;
  }

  try {
    const session = sessionManager.createSession(sessionId, title || '新会话', {
      onData: (sid, chunk) => queueOutput(sid, chunk),
      onExit: (sid, evt) => {
        flushOutput(sid); // 先把残留输出发完
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
    console.error('❌ 创建终端失败:', err.message);
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

// ─── 心跳 + 死连接检测 ──────────────────────────────────────────
// half-open（半开）连接：TCP 一侧已死但本端 ws 不触发 close，导致永不重连。
// 这里主动发心跳并校验 pong：若超过 PONG_TIMEOUT_MS 没收到任何 pong，
// 判定连接已死，主动 terminate() 触发 close → 走正常重连流程（PTY 会话因进程
// 存活而保留，重连后自动重新上报，无需重建）。
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // 死连接判定：长时间没有任何 pong
  if (lastPongAt && Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
    console.warn(`⚠  超过 ${PONG_TIMEOUT_MS / 1000}s 未收到服务器响应，判定连接已死，强制重连`);
    try { ws.terminate(); } catch { /* ignore */ }  // 立即触发 close → scheduleReconnect
    return;
  }

  // 同时发应用层 ping 和协议层 ping（任一条回应都会刷新 lastPongAt）
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
    ws.ping();
  } catch { /* 发送失败说明链路有问题，下个周期会被超时逻辑兜底 */ }
}, HEARTBEAT_MS);

// ─── 启动 ───────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║         Claude Web Agent 🤖              ║');
console.log(`║  Server : ${SERVER_URL.padEnd(32)}║`);
console.log('║  Mode   : 交互式终端 (node-pty)           ║');
console.log(`║  Root   : ${ROOT.slice(0, 32).padEnd(32)}║`);
console.log(`║  📝 审计 : ${auditLog.logPath().slice(0, 30).padEnd(30)}║`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

connect();

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
