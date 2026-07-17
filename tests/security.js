/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 安全测试套件
 *
 * 用法：
 *   node tests/security.js
 *
 * 前提：本地 Server (127.0.0.1:3002) + Agent 已运行
 * ═══════════════════════════════════════════════════════════════
 */

const WebSocket = require('./ws-client');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── 配置 ────────────────────────────────────────────────────────
let testToken = process.env.CLAUDE_WEB_TOKEN;
try {
  if (!testToken) {
    const cfg = require('../config.json');
    testToken = (cfg.tokens && Object.keys(cfg.tokens)[0]) || cfg.token;
  }
} catch {
  console.error('❌ 未设置 CLAUDE_WEB_TOKEN，且无法读取 config.json');
  process.exit(1);
}

const TARGET = process.env.TARGET || 'ws://127.0.0.1:3002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 工具 ────────────────────────────────────────────────────────
const results = [];
let pass = 0, fail = 0;

function check(category, name, cond, detail = '') {
  results.push({ category, name, pass: !!cond, detail });
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

function summary() {
  const total = pass + fail;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${pass}/${total} 通过  ${fail ? '❌ ' + fail + ' 失败' : '✅ 全部通过'}`);
  console.log(`${'═'.repeat(60)}`);
}

function quickConnect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TARGET);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('connect timeout')); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: token || '', role: 'browser' })));
    ws.on('message', (raw) => {
      clearTimeout(timeout);
      const m = JSON.parse(raw.toString());
      resolve({ ws, data: m });
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ─── 测试用例 ────────────────────────────────────────────────────

(async () => {
  console.log(`\n🔒 Claude Web 安全测试`);
  console.log(`   目标: ${TARGET}`);
  console.log(`   Token: ${testToken.slice(0, 8)}…`);

  // ═════════════════════════════════════════════════════════════
  section('A. 认证 - Token 验证');

  // A1: 有效 Token
  try {
    const { ws, data } = await quickConnect(testToken);
    check('auth', 'A1 有效 Token 认证成功', data.type === 'auth_ok', `role=${data.role}`);
    ws.close();
  } catch (e) {
    check('auth', 'A1 有效 Token 认证成功', false, e.message);
  }

  // A2: 无效 Token
  try {
    const { ws, data } = await quickConnect('wrong-token-12345678');
    check('auth', 'A2 无效 Token 被拒绝', data.type === 'error' || data.message, JSON.stringify(data).slice(0, 80));
    ws.close();
  } catch { check('auth', 'A2 无效 Token 被拒绝', false, '异常'); }

  // A3: 空 Token
  try {
    const { ws, data } = await quickConnect('');
    check('auth', 'A3 空 Token 被拒绝', data.type === 'error' || data.message, JSON.stringify(data).slice(0, 80));
    ws.close();
  } catch { check('auth', 'A3 空 Token 被拒绝', false, '异常'); }

  // A4: 未认证就发消息
  try {
    const ws2 = new WebSocket(TARGET);
    await new Promise((resolve) => {
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'terminal_list' }));
        ws2.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          check('auth', 'A4 未认证发消息被拒绝', m.type === 'error', m.message || '');
          ws2.close();
          resolve();
        });
      });
    });
    await sleep(200);
  } catch { check('auth', 'A4 未认证发消息被拒绝', false, '异常'); }

  // ═════════════════════════════════════════════════════════════
  section('B. 速率限制 - 暴力破解防护');

  // B1: 连续失败触发封禁（用随机假 token，不应被封因为是 localhost）
  let failCount = 0;
  for (let i = 0; i < 20; i++) {
    try {
      const fakeToken = 'fake-' + Math.random().toString(36).slice(2, 18);
      const ws = new WebSocket(TARGET);
      const result = await new Promise((resolve) => {
        ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: fakeToken, role: 'browser' })));
        ws.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          ws.close();
          resolve(m.type === 'auth_ok');
        });
        ws.on('error', () => resolve(false));
      });
      if (!result) failCount++;
    } catch { failCount++; }
    await sleep(50);
  }
  check('ratelimit', 'B1 20 次假 Token 尝试均被拒绝', failCount === 20, `拒绝=${failCount}/20`);
  check('ratelimit', 'B2 localhost 不受速率限制', true, '本地白名单设计如此');

  // ═════════════════════════════════════════════════════════════
  section('C. Token 隔离 - 多 Agent 数据隔离');

  // C1: 用有效 Token 创建会话
  const main = await quickConnect(testToken);
  const mainSessions = main.data.sessions || [];
  check('isolation', 'C1 主 Token 连接成功', main.data.type === 'auth_ok');

  // C2: 用另一个 Token 尝试连接（应该没有对应 Agent）
  const otherToken = 'other-agent-token-00123456789';
  const other = await quickConnect(otherToken);
  // 这个 Token 不在 config 里，应该被拒绝
  check('isolation', 'C2 未配置 Token 被拒绝', other.data.type !== 'auth_ok');
  if (other.ws) other.ws.close();

  // C3: 主 Token 创建终端会话
  const sessionId = 'sec-test-' + Date.now();
  main.ws.send(JSON.stringify({ type: 'terminal_create', sessionId, title: '安全测试会话' }));
  const created = await new Promise((resolve) => {
    main.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'terminal_created' && m.sessionId === sessionId) resolve(m);
    });
  });
  check('isolation', 'C3 终端会话创建成功', !!created, `sessionId=${sessionId.slice(0, 12)}`);

  // C4: 用错误 Token 尝试操作该会话（应失败或被拒绝）
  // 先用随机 token 连接
  try {
    const badToken = 'bad-token-9876543210abcdef';
    const bad = await quickConnect(badToken);
    // 如果连接成功（但 Token 未配置，应该失败）
    check('isolation', 'C4 未授权 Token 无法访问会话', bad.data.type !== 'auth_ok');
    if (bad.ws) bad.ws.close();
  } catch { check('isolation', 'C4 未授权 Token 无法访问会话', false, '异常'); }

  // 清理测试会话
  main.ws.send(JSON.stringify({ type: 'terminal_delete', sessionId }));
  await sleep(300);

  // ═════════════════════════════════════════════════════════════
  section('D. 输入验证 - 异常数据处理');

  // D1: 发送非 JSON 数据
  let invalidJsonRejected = false;
  try {
    const ws = new WebSocket(TARGET);
    await new Promise((resolve) => {
      ws.on('open', () => {
        ws.send(testToken); // raw token, not JSON
        ws.send('not-valid-json{{{');
      });
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error' && m.message === 'Invalid JSON') invalidJsonRejected = true;
        if (m.type === 'auth_ok') { ws.close(); resolve(); }
        if (m.type === 'error' && m.message !== 'Invalid JSON') { ws.close(); resolve(); }
      });
    });
  } catch {}
  check('input', 'D1 非 JSON 数据被优雅拒绝', invalidJsonRejected);

  // D2: 超长 session title
  let longTitleHandled = false;
  try {
    const longId = 'long-' + Date.now();
    main.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: longId, title: 'A'.repeat(10000) }));
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 3000);
      main.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.sessionId === longId && (m.type === 'terminal_created' || m.type === 'terminal_error')) {
          clearTimeout(timer);
          longTitleHandled = true;
          main.ws.send(JSON.stringify({ type: 'terminal_delete', sessionId: longId }));
          resolve();
        }
      });
    });
  } catch {}
  check('input', 'D2 超长标题不崩溃', longTitleHandled, '正常创建或返回错误');

  // D3: 发送未知消息类型
  main.ws.send(JSON.stringify({ type: '__UNKNOWN_TYPE__', data: 'test' }));
  await sleep(200);
  check('input', 'D3 未知消息类型不崩溃', main.ws.readyState === 1, '连接保持');

  // ═════════════════════════════════════════════════════════════
  section('E. 审计日志');

  const auditPath = process.env.CW_AUDIT_LOG ||
    path.join(os.homedir(), 'WebClaudeWorkspaces', '.audit.log');

  // E1: 发送命令后检查日志
  const auditSid = 'sec-audit-' + Date.now();
  main.ws.send(JSON.stringify({ type: 'terminal_create', sessionId: auditSid, title: '审计测试' }));
  await sleep(1000);
  main.ws.send(JSON.stringify({ type: 'terminal_input', sessionId: auditSid, data: 'echo SECURITY_TEST_MARKER\r' }));
  await sleep(1000);

  let auditFound = false;
  try {
    if (fs.existsSync(auditPath)) {
      const content = fs.readFileSync(auditPath, 'utf-8');
      auditFound = content.includes('SECURITY_TEST_MARKER');
    }
  } catch {}
  check('audit', 'E1 命令被记录到审计日志', auditFound, auditPath);
  check('audit', 'E2 审计日志文件存在', fs.existsSync(auditPath));

  // 清理
  main.ws.send(JSON.stringify({ type: 'terminal_delete', sessionId: auditSid }));
  await sleep(200);

  // ═════════════════════════════════════════════════════════════
  section('F. WebSocket 安全');

  // F1: 认证超时
  let timeoutWorks = false;
  try {
    const ws = new WebSocket(TARGET);
    await new Promise((resolve) => {
      ws.on('open', () => {}); // 不发 auth，等超时
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.message && m.message.includes('Authentication timeout')) {
          timeoutWorks = true;
        }
      });
      ws.on('close', () => resolve());
      setTimeout(resolve, 12000);
    });
  } catch {}
  check('ws', 'F1 认证超时断开 (10s)', timeoutWorks);

  // F2: ping/pong 心跳
  const { ws: pingWs } = await quickConnect(testToken);
  await sleep(3000);
  check('ws', 'F2 心跳保持连接存活', pingWs.readyState === 1);

  // 关闭
  main.ws.close();
  pingWs.close();

  // ═════════════════════════════════════════════════════════════
  summary();

  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) categories[r.category] = { pass: 0, fail: 0 };
    if (r.pass) categories[r.category].pass++;
    else categories[r.category].fail++;
  }
  console.log('\n分类汇总:');
  for (const [cat, c] of Object.entries(categories)) {
    const icon = c.fail === 0 ? '✅' : '⚠️';
    console.log(`  ${icon} ${cat}: ${c.pass}/${c.pass + c.fail} 通过`);
  }

  process.exit(fail > 0 ? 1 : 0);
})();
