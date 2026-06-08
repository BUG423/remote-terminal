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

// token 优先级：环境变量 > config.json
config.token = process.env.CLAUDE_WEB_TOKEN || config.token;

const {
  token,
  serverHost,
  serverPort = 3000,
  useTLS = false,
  workspaceRoot,
} = config;

const SERVER_URL = `${useTLS ? 'wss' : 'ws'}://${serverHost}:${serverPort}`;
const ROOT = sessionManager.setWorkspaceRoot(workspaceRoot);

// ─── 状态 ───────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// 旧聊天协议：每会话的 claude 进程
const chatProcesses = new Map(); // sessionId -> { proc, queue, history }

// ─── WebSocket 连接 ─────────────────────────────────────────────
function connect() {
  console.log(`🔗 正在连接服务器: ${SERVER_URL}`);
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('✅ 已连接到服务器');
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'auth', token, role: 'agent' }));
  });

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
    // 终端进程保持存活（用户重连后可继续），仅标记聊天进程清理
    ws = null;
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
      onData: (sid, chunk) => send({ type: 'terminal_output', sessionId: sid, data: chunk }),
      onExit: (sid, evt) => {
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

// ─── 心跳 ───────────────────────────────────────────────────────
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
}, 30000);

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
