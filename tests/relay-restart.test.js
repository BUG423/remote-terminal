'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('./ws-client');

const root = path.join(__dirname, '..');
const port = 34000 + Math.floor(Math.random() * 1000);
const browserToken = crypto.randomBytes(32).toString('base64url');
const agentToken = crypto.randomBytes(32).toString('base64url');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-restart-'));
const workspaceRoot = path.join(tempRoot, 'workspace');
const configPath = path.join(tempRoot, 'config.json');
const target = `ws://127.0.0.1:${port}`;

fs.writeFileSync(configPath, JSON.stringify({
  port,
  bindHost: '127.0.0.1',
  devices: {
    'restart-agent': { name: 'restart-agent', browserToken, agentToken },
  },
  serverUrl: target,
  agentToken,
  workspaceRoot,
  maxSessions: 2,
  offlineOutputBytes: 128 * 1024,
  auditLogPath: path.join(workspaceRoot, '.audit.log'),
}, null, 2));

let serverProc = null;
let agentProc = null;
const clients = new Set();
const results = [];

function check(name, condition, detail = '') {
  results.push(!!condition);
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(proc, timeoutMs = 7000) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process exit timeout')), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForHealth(timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(500, () => {
        req.destroy();
        retry();
      });
    }
    function retry() {
      if (Date.now() - started >= timeoutMs) reject(new Error('server health timeout'));
      else setTimeout(poll, 100);
    }
    poll();
  });
}

function spawnProcess(entry) {
  const proc = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      CW_CONFIG_PATH: configPath,
      CW_HEARTBEAT_MS: '500',
      CW_PONG_TIMEOUT_MS: '2500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (data) => process.env.DEBUG_TESTS && process.stdout.write(data));
  proc.stderr.on('data', (data) => process.env.DEBUG_TESTS && process.stderr.write(data));
  return proc;
}

async function startServer() {
  serverProc = spawnProcess('server/index.js');
  await waitForHealth();
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate, timeoutMs = 8000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('message timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function connectBrowser() {
  const ws = new WebSocket(target);
  clients.add(ws);
  const client = new Client(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser open timeout')), 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', reject);
  });
  client.send({ type: 'auth', token: browserToken, role: 'browser' });
  const auth = await client.waitFor((message) => message.type === 'auth_ok');
  return { client, auth };
}

async function createSession(client, sessionId, title) {
  client.send({ type: 'terminal_create', sessionId, title });
  return client.waitFor((message) => message.sessionId === sessionId &&
    ['terminal_created', 'terminal_error'].includes(message.type));
}

async function cleanup() {
  for (const ws of clients) {
    try { ws.close(); } catch {}
  }
  if (agentProc && agentProc.exitCode === null) agentProc.kill('SIGTERM');
  if (serverProc && serverProc.exitCode === null) serverProc.kill('SIGTERM');
  await Promise.allSettled([waitForExit(agentProc), waitForExit(serverProc)]);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

(async () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   真实中继重启与 Agent 恢复测试           ║');
  console.log('╚══════════════════════════════════════════╝');

  await startServer();
  agentProc = spawnProcess('agent/index.js');

  const first = await connectBrowser();
  if (!first.auth.agentOnline) {
    await first.client.waitFor((message) => message.type === 'agent_status' && message.online === true);
  }
  check('真实 Agent 连接成功', true);

  const sessionId = 'restart-main';
  const created = await createSession(first.client, sessionId, 'Restart main');
  check('故障前创建 PTY 会话成功', created.type === 'terminal_created');
  first.client.send({ type: 'terminal_attach', sessionId });
  await first.client.waitFor((message) => message.type === 'terminal_attached' && message.sessionId === sessionId);

  first.client.send({
    type: 'terminal_input',
    sessionId,
    data: "echo BEFORE_RESTART; sleep 1; echo OFFLINE_ONE; sleep 1; echo OFFLINE_TWO; sleep 2; echo AFTER_RESTART\r",
  });
  await first.client.waitFor((message) => message.type === 'terminal_output' &&
    message.sessionId === sessionId && message.data.includes('BEFORE_RESTART'));

  serverProc.kill('SIGTERM');
  await waitForExit(serverProc);
  await wait(3000);
  check('中继停止期间 Agent 进程和 PTY 仍存活', agentProc.exitCode === null);

  await startServer();
  const second = await connectBrowser();
  if (!second.auth.agentOnline) {
    await second.client.waitFor((message) => message.type === 'agent_status' && message.online === true, 10000);
  }
  const sessions = second.auth.sessions && second.auth.sessions.some((session) => session.id === sessionId)
    ? second.auth.sessions
    : (await second.client.waitFor((message) => message.type === 'sessions' &&
      message.sessions.some((session) => session.id === sessionId), 10000)).sessions;
  check('Server 重启后原会话自动恢复', sessions.some((session) => session.id === sessionId));

  second.client.send({ type: 'terminal_attach', sessionId });
  await second.client.waitFor((message) => message.type === 'terminal_attached' && message.sessionId === sessionId);
  await wait(1000);
  const recoveredOutput = second.client.messages
    .filter((message) => message.type === 'terminal_output' && message.sessionId === sessionId)
    .map((message) => message.data)
    .join('');
  check('断线期间输出在重连后补回',
    recoveredOutput.includes('OFFLINE_ONE') && recoveredOutput.includes('OFFLINE_TWO'));

  second.client.send({ type: 'terminal_input', sessionId, data: 'echo RECONNECTED_OK\r' });
  const liveOutput = await second.client.waitFor((message) => message.type === 'terminal_output' &&
    message.sessionId === sessionId && message.data.includes('RECONNECTED_OK'));
  check('恢复后终端仍可继续交互', !!liveOutput);

  const secondSession = await createSession(second.client, 'restart-second', 'Second');
  check('会话上限内仍可创建第二个会话', secondSession.type === 'terminal_created');
  const rejected = await createSession(second.client, 'restart-third', 'Third');
  check('真实 Agent 拒绝超过上限的会话', rejected.type === 'terminal_error' && /上限/.test(rejected.message));

  second.client.send({ type: 'terminal_delete', sessionId });
  second.client.send({ type: 'terminal_delete', sessionId: 'restart-second' });
  first.client.close();
  second.client.close();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 中继重启测试通过`);
  if (passed !== results.length) process.exitCode = 1;
})().catch((err) => {
  console.error(`  ❌ 测试异常: ${err.stack || err.message}`);
  process.exitCode = 1;
}).finally(cleanup);
