'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OutputBacklog, splitUtf8 } = require('../agent/output-backlog');
const auditLog = require('../agent/audit-log');
const {
  buildServerUrl,
  getProxyUrl,
  noProxyMatch,
} = require('../agent/connection-options');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push(false);
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

console.log('╔══════════════════════════════════════════╗');
console.log('║   Agent 连接与持久性加固测试             ║');
console.log('╚══════════════════════════════════════════╝');

test('serverUrl 支持 WSS、端口和路径', () => {
  const url = buildServerUrl({ serverUrl: 'wss://relay.test:443/terminal' }, {});
  assert.equal(url.toString(), 'wss://relay.test/terminal');
});

test('旧 serverHost 配置仍可兼容', () => {
  const url = buildServerUrl({ serverHost: '127.0.0.1', serverPort: 3002 }, {});
  assert.equal(url.toString(), 'ws://127.0.0.1:3002/');
});

test('拒绝非 WebSocket 协议和 URL 内凭据', () => {
  assert.throws(() => buildServerUrl({ serverUrl: 'https://relay.example.com' }, {}), /ws:\/\/ or wss:\/\//);
  assert.throws(() => buildServerUrl({ serverUrl: 'wss://user:pass@relay.test' }, {}), /credentials/);
});

test('NO_PROXY 支持域名后缀、端口和通配符', () => {
  const url = new URL('wss://agent.internal.example:443/ws');
  assert(noProxyMatch(url, '.internal.example'));
  assert(noProxyMatch(url, 'agent.internal.example:443'));
  assert(!noProxyMatch(url, 'agent.internal.example:8443'));
  assert(noProxyMatch(url, '*'));
});

test('显式 proxyUrl 优先，NO_PROXY 可绕过代理', () => {
  const url = new URL('wss://relay.example.com/ws');
  assert.equal(getProxyUrl(url, { proxyUrl: 'http://proxy.local:8080' }, {}).host, 'proxy.local:8080');
  assert.equal(getProxyUrl(url, { proxyUrl: 'http://proxy.local:8080' }, { NO_PROXY: 'relay.example.com' }), null);
});

test('断线输出按会话保留并限制 UTF-8 字节数', () => {
  const backlog = new OutputBacklog(12);
  backlog.append('a', '前缀-');
  backlog.append('a', '中文-TAIL');
  backlog.append('b', 'other');
  assert(Buffer.byteLength(backlog.get('a'), 'utf8') <= 12);
  assert(backlog.get('a').endsWith('TAIL'));
  assert.deepEqual(backlog.drain().map(([id]) => id), ['a', 'b']);
  assert.equal(backlog.get('a'), '');
});

test('恢复输出按 UTF-8 边界拆成受控消息', () => {
  const chunks = splitUtf8('中'.repeat(100) + 'TAIL', 64);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 64));
  assert.equal(chunks.join(''), '中'.repeat(100) + 'TAIL');
});

test('审计日志权限为 0600 且达到上限后轮转', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-terminal-audit-'));
  const logPath = path.join(dir, 'audit.log');
  auditLog.configure({ path: logPath, maxBytes: 1024, maxBackups: 2, enabled: true });
  for (let i = 0; i < 40; i++) {
    auditLog.feed('session-a', 'test', `echo ${String(i).padStart(2, '0')} ${'x'.repeat(40)}\r`);
  }
  assert(fs.existsSync(logPath));
  assert(fs.existsSync(`${logPath}.1`));
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} Agent 加固测试通过`);
if (passed !== results.length) process.exit(1);
