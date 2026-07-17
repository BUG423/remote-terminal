/**
 * ═══════════════════════════════════════════════════════════════
 * Web-Claude 端到端测试套件（模拟浏览器，覆盖核心需求与重点排查项）
 *
 * 用法：
 *   TARGET=ws://你的服务器:3000 CLAUDE_WEB_TOKEN=xxx node tests/e2e.js
 *   （默认 TARGET=ws://127.0.0.1:3000，token 从 ../config.json 读取）
 *
 * 需要：目标 Server 在线 + 本地 Agent 已连接该 Server。
 * 它模拟前端的 attach/detach 与 attached 去重逻辑，逐项断言并打分。
 * ═══════════════════════════════════════════════════════════════
 */
const os = require('os');
const path = require('path');
const WebSocket = require('./ws-client');

let token = process.env.CLAUDE_WEB_TOKEN;
let expectedWorkspaceRoot = process.env.WORKSPACE_ROOT;
try {
  const cfg = require('../config.json');
  if (!token) {
    // 优先从多 Token 配置取第一个，兼容旧单 token
    const firstDevice = cfg.devices && Object.values(cfg.devices)[0];
    token = firstDevice?.browserToken || (cfg.tokens && Object.keys(cfg.tokens)[0]) || cfg.token;
  }
  if (!expectedWorkspaceRoot && cfg.workspaceRoot) expectedWorkspaceRoot = cfg.workspaceRoot;
} catch {}
const TARGET = process.env.TARGET || 'ws://127.0.0.1:3002';
if (expectedWorkspaceRoot) {
  expectedWorkspaceRoot = path.resolve(expectedWorkspaceRoot.replace(/^~(?=$|\/)/, os.homedir()));
}

const uuid = () => require('crypto').randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 一个会话的本地状态（模拟前端单个 xterm + attached 去重）─────
class Term {
  constructor(id) { this.id = id; this.buf = ''; this.attached = false; }
  onOutput(data, replay) {
    if (replay) { this.buf = data; this.attached = true; }
    else if (this.attached) this.buf += data;
  }
  count(mark) { return (this.buf.match(new RegExp(mark, 'g')) || []).length; }
}

class Client {
  constructor() {
    this.ws = null; this.terms = new Map(); this.sessions = [];
    this.agentOnline = false; this._waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      if (!token) {
        reject(new Error('CLAUDE_WEB_TOKEN is required'));
        return;
      }

      let authSettled = false;
      let authTimeout;

      const finishAuth = (fn, value) => {
        if (authSettled) return;
        authSettled = true;
        clearTimeout(authTimeout);
        fn(value);
      };

      authTimeout = setTimeout(() => {
        finishAuth(reject, new Error('Authentication timeout'));
        try { this.ws.close(); } catch {}
      }, 8000);

      this.ws = new WebSocket(TARGET);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'auth', token, role: 'browser' })));
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'auth_ok') {
          this.agentOnline = m.agentOnline;
          this.sessions = m.sessions || [];
          finishAuth(resolve, m);
        } else {
          if (m.type === 'error' && !authSettled) {
            finishAuth(reject, new Error(m.message || 'Authentication rejected'));
          }
          this._handle(m);
        }
        for (const w of this._waiters.slice()) if (w.pred(m)) { this._waiters.splice(this._waiters.indexOf(w), 1); w.resolve(m); }
      });
      this.ws.on('error', (err) => finishAuth(reject, err));
      this.ws.on('close', (code, reason) => {
        const suffix = reason?.length ? `: ${reason.toString()}` : '';
        finishAuth(reject, new Error(`WebSocket closed before authentication (${code})${suffix}`));
      });
    });
  }
  _handle(m) {
    if (m.type === 'sessions') this.sessions = m.sessions;
    else if (m.type === 'agent_status') this.agentOnline = m.online;
    else if (m.type === 'terminal_output') { const t = this.terms.get(m.sessionId); if (t) t.onOutput(m.data, m.replay); }
    else if (m.type === 'terminal_attached') { const t = this.terms.get(m.sessionId); if (t) t.attached = true; }
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, ms = 8000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this._waiters.push(w);
      setTimeout(() => { const i = this._waiters.indexOf(w); if (i >= 0) { this._waiters.splice(i, 1); reject(new Error('waitFor timeout')); } }, ms);
    });
  }
  // 创建会话并 attach（模拟前端 ensureTerminal）
  async create(title) {
    const id = uuid();
    const t = new Term(id); this.terms.set(id, t);
    this.send({ type: 'terminal_create', sessionId: id, title });
    await this.waitFor((m) => m.type === 'terminal_created' && m.sessionId === id);
    this.send({ type: 'terminal_attach', sessionId: id });
    await this.waitFor((m) => m.type === 'terminal_attached' && m.sessionId === id);
    return id;
  }
  // 模拟切换：重新 attach（重置 + 回放）
  async attach(id) {
    const t = this.terms.get(id) || new Term(id);
    t.attached = false; this.terms.set(id, t);
    this.send({ type: 'terminal_attach', sessionId: id });
    await this.waitFor((m) => (m.type === 'terminal_attached' || (m.type === 'terminal_output' && m.replay)) && m.sessionId === id);
  }
  // 模拟真实逐字符输入（等 shell 静默后），返回命令
  async type(id, cmd) {
    for (const ch of cmd) { this.send({ type: 'terminal_input', sessionId: id, data: ch }); await sleep(15); }
    this.send({ type: 'terminal_input', sessionId: id, data: '\r' });
  }
  async waitIdle(id, idleMs = 700, maxMs = 5000) {
    const t = this.terms.get(id); let last = t.buf.length; const start = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(idleMs);
      if (t.buf.length === last) return; last = t.buf.length;
    }
  }
  del(id, deleteFiles) { this.send({ type: 'terminal_delete', sessionId: id, deleteFiles }); }
  close() { try { this.ws.close(); } catch {} }
}

// ── 断言框架 ────────────────────────────────────────────────────
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  console.log(`\n── Web-Claude E2E ── TARGET=${TARGET}\n`);
  const c = new Client();
  const hello = await c.connect();
  check('1. 浏览器鉴权成功 (auth_ok)', !!hello);
  check('2. Agent 在线', c.agentOnline === true, `agentOnline=${c.agentOnline}`);
  if (!c.agentOnline) { console.log('\n⚠ Agent 不在线，终止。请先启动本地 Agent。'); finish(); return; }

  // ── 创建会话 + pwd + echo ──
  const A = await c.create('e2e-A');
  await c.waitIdle(A);
  await c.type(A, 'pwd'); await c.waitIdle(A);
  await c.type(A, 'echo hello'); await c.waitIdle(A);
  const ta = c.terms.get(A);
  check('3. 创建会话成功且列表含该会话', c.sessions.some((s) => s.id === A));
  const expectedPwd = expectedWorkspaceRoot
    ? ta.buf.includes(expectedWorkspaceRoot)
    : /WebClaudeWorkspaces/.test(ta.buf);
  check('4. pwd 输出包含配置的 workspaceRoot', expectedPwd, expectedWorkspaceRoot || 'WebClaudeWorkspaces');
  check('5. echo hello 输出含 hello', /hello/.test(ta.buf));
  check('6. 双倍回显检查: "hello" 计数=2 (命令行回显1+输出1)', ta.count('hello') === 2, `实际=${ta.count('hello')}`);

  // ── 多会话共享目录 ──
  const B = await c.create('e2e-B'); await c.waitIdle(B);
  await c.type(B, 'echo SESSION_B_ONLY > bfile.txt'); await c.waitIdle(B);
  await c.attach(A); await c.waitIdle(A);
  await c.type(A, 'echo SESSION_A_ONLY > afile.txt'); await c.waitIdle(A);
  await c.type(A, 'ls'); await c.waitIdle(A);
  const a2 = c.terms.get(A);
  check('7. 共享目录: A 可以看到 B 创建的 bfile.txt', /bfile\.txt/.test(a2.buf), '共享 WORKSPACE_ROOT');
  // 切回 B 再 ls，验证 B 也能看到 A 创建的文件
  await c.attach(B); await c.waitIdle(B);
  await c.type(B, 'ls'); await c.waitIdle(B);
  const b2 = c.terms.get(B);
  check('8. 共享目录: B 可以看到 A 创建的 afile.txt', /afile\.txt/.test(b2.buf), '共享 WORKSPACE_ROOT');

  // ── 反复切换 A/B 10 次，每次执行命令 ──
  let switchOk = true;
  for (let i = 0; i < 10; i++) {
    const id = i % 2 === 0 ? A : B; const tag = `SW${i}`;
    await c.attach(id); await c.waitIdle(id, 400, 2500);
    await c.type(id, `echo ${tag}`); await c.waitIdle(id, 400, 2500);
    if (c.terms.get(id).count(tag) < 1) switchOk = false;
  }
  check('9. 反复切换 A/B 共10次，每次都能在当前会话执行命令', switchOk);
  check('10. 切回 A 后历史仍在 (含早先 SESSION_A_ONLY 写入痕迹)', /SESSION_A_ONLY/.test(c.terms.get(A).buf));

  // ── 刷新页面（断开重连，重新 attach）──
  c.close(); await sleep(500);
  const c2 = new Client(); await c2.connect();
  check('11. 刷新后会话列表恢复 (A、B 仍在)', c2.sessions.some((s) => s.id === A) && c2.sessions.some((s) => s.id === B));
  await c2.attach(A); await c2.waitIdle(A, 500, 3000);
  check('12. 刷新后重新 attach A，历史输出回放成功', /hello|SESSION_A_ONLY/.test(c2.terms.get(A).buf));
  await c2.type(A, 'echo AFTER_REFRESH'); await c2.waitIdle(A);
  check('13. 刷新后仍可向 A 发送命令并收到输出', c2.terms.get(A).count('AFTER_REFRESH') >= 1);
  check('14. 刷新后无双倍回显: AFTER_REFRESH 计数=2', c2.terms.get(A).count('AFTER_REFRESH') === 2, `实际=${c2.terms.get(A).count('AFTER_REFRESH')}`);

  // ── 删除会话 ──
  c2.del(B, false);
  await c2.waitFor((m) => m.type === 'terminal_closed' && m.sessionId === B, 8000).catch(() => {});
  await sleep(500);
  check('15. 删除会话 B 后，列表中不再包含 B', !c2.sessions.some((s) => s.id === B));
  check('16. 删除 B 不影响 A（A 仍在列表）', c2.sessions.some((s) => s.id === A));

  // ── 长任务期间切换 ──
  await c2.attach(A);
  await c2.type(A, 'for i in 1 2 3 4 5; do echo TICK$i; sleep 1; done');
  const C = await c2.create('e2e-C'); await c2.waitIdle(C);
  await c2.type(C, 'echo C_RUNS'); await c2.waitIdle(C);
  check('17. 长任务运行时可创建并使用其他会话 C', c2.terms.get(C).count('C_RUNS') >= 1);
  await sleep(6000); // 等 A 的长任务跑完
  await c2.attach(A); await c2.waitIdle(A, 500, 3000);
  const tA = c2.terms.get(A);
  check('18. 长任务未因切换中断（TICK1..TICK5 都在）', [1,2,3,4,5].every((i) => tA.buf.includes('TICK' + i)), '后台终端持续运行');

  // ── 清理 ──
  c2.del(A, true); c2.del(C, true);
  await sleep(800);
  c2.close();
  finish();
})().catch((e) => { console.error('测试异常:', e.message); finish(1); });

function finish(code) {
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n── 结果: ${pass}/${results.length} 通过 ──`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) { console.log('失败项:'); failed.forEach((r) => console.log('  ❌ ' + r.name + (r.detail ? ' — ' + r.detail : ''))); }
  process.exit(code != null ? code : (failed.length ? 1 : 0));
}
