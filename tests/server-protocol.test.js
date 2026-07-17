/**
 * Server WebSocket protocol tests.
 *
 * These use the real server process and a fake Agent, so they cover routing,
 * auth, validation, and session list behavior without requiring node-pty.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('./ws-client');

const token = 'test-token-1234567890abcdefghijklmnop';
const port = 32000 + Math.floor(Math.random() * 1000);
const configPath = path.join(os.tmpdir(), `remote-terminal-test-${process.pid}.json`);
const target = `ws://127.0.0.1:${port}`;

fs.writeFileSync(configPath, JSON.stringify({
  port,
  bindHost: '127.0.0.1',
  tokens: { [token]: 'test-agent' },
  serverHost: '127.0.0.1',
  serverPort: port,
  useTLS: false,
  workspaceRoot: path.join(os.tmpdir(), `remote-terminal-ws-${process.pid}`),
}, null, 2));

let serverProc;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForHealth(timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    function once() {
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
      if (Date.now() - started > timeoutMs) reject(new Error('server did not start'));
      else setTimeout(once, 100);
    }
    once();
  });
}

function connect(role, authToken = token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const timer = setTimeout(() => reject(new Error(`${role} auth timeout`)), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: authToken, role })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth_ok' || msg.type === 'error') {
        clearTimeout(timer);
        resolve({ ws, msg });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function nextMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('message timeout'));
    }, timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

(async () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Server WebSocket 协议集成测试          ║');
  console.log('╚══════════════════════════════════════════╝');

  serverProc = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, CW_CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.env.DEBUG_TESTS && process.stdout.write(d));
  serverProc.stderr.on('data', (d) => process.env.DEBUG_TESTS && process.stderr.write(d));

  await waitForHealth();

  const invalidRole = await connect('__bad_role__');
  check('无效 role 被拒绝', invalidRole.msg.type === 'error' && invalidRole.msg.message === 'Invalid role');
  invalidRole.ws.close();

  const agent = await connect('agent');
  check('假 Agent 鉴权成功', agent.msg.type === 'auth_ok' && agent.msg.role === 'agent');

  const browser = await connect('browser');
  check('浏览器鉴权成功', browser.msg.type === 'auth_ok' && browser.msg.role === 'browser');

  const sessions = [
    { id: 'same-1', title: 'Same', cwd: '/tmp/ws', status: 'running', pid: 1 },
    { id: 'same-2', title: 'Same', cwd: '/tmp/ws', status: 'running', pid: 2 },
    { id: 'bad-1', title: 'Recovered', cwd: '/tmp/ws', status: 'recovered', pid: 0 },
  ];
  agent.ws.send(JSON.stringify({ type: 'sessions', sessions }));
  const updated = await nextMessage(browser.ws, (m) => m.type === 'sessions');
  check('同 title+cwd 的不同 running 会话全部保留',
    updated.sessions.length === 2 &&
    updated.sessions.some((s) => s.id === 'same-1') &&
    updated.sessions.some((s) => s.id === 'same-2'));
  check('recovered 会话仍被过滤', !updated.sessions.some((s) => s.id === 'bad-1'));

  browser.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: 'bad\u0000id', title: 'x' }));
  const invalidSession = await nextMessage(browser.ws, (m) => m.type === 'terminal_error');
  check('非法 sessionId 被拒绝', invalidSession.message === 'Invalid sessionId');

  const longTitle = 'A'.repeat(1000);
  const forwarded = nextMessage(agent.ws, (m) => m.type === 'terminal_create');
  browser.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: 'valid-id', title: longTitle }));
  const createMsg = await forwarded;
  check('超长标题被截断后转发', createMsg.title.length === 120);

  agent.ws.close();
  browser.ws.close();
  await wait(100);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${'='.repeat(50)}`);
  if (passed === results.length) {
    console.log(`🎉 全部 ${passed}/${results.length} 协议测试通过!`);
    process.exitCode = 0;
    return;
  }
  console.log(`❌ ${passed}/${results.length} 通过`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  process.exitCode = 1;
})().catch((err) => {
  console.error('测试异常:', err.message);
  process.exitCode = 1;
}).finally(() => {
  try { fs.unlinkSync(configPath); } catch {}
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
});
