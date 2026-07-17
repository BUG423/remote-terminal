/**
 * 端到端场景测试 — 模拟完整的 Agent/Server/Browser 交互流程
 */

// ─── 模拟服务器端 session 槽位 ────────────────────────────────────
class MockAgentSlot {
  constructor() {
    this.ws = null;
    this.sessions = [];
    this.cleanupTimer = null;
  }
}

// 服务器端过滤逻辑（从 index.js 提取）
const VALID_SERVER_STATUSES = ['running', 'exited', 'disconnected'];

function serverFilterSessions(raw) {
  const seenIds = new Set();
  return raw.filter(s => {
    if (!s || !s.id) return false;
    if (seenIds.has(s.id)) return false;
    if (!VALID_SERVER_STATUSES.includes(s.status)) return false;
    seenIds.add(s.id);
    return true;
  });
}

// 浏览器端清理逻辑（从 app.js 提取）
const STALE_STATUSES = new Set(['disconnected', 'recovered']);

function browserCleanSessions(sessions) {
  const staleIds = new Set(
    sessions.filter(s => STALE_STATUSES.has(s.status)).map(s => s.id)
  );
  return sessions.filter(s => !staleIds.has(s.id));
}

// Agent 端过滤逻辑（从 session-manager.js 提取）
const AGENT_VALID_STATUSES = new Set(['running', 'exited']);

function agentListSessions(sessions) {
  const seenIds = new Set();
  return sessions
    .filter(s => {
      if (!AGENT_VALID_STATUSES.has(s.status)) return false;
      if (seenIds.has(s.id)) return false;
      seenIds.add(s.id);
      return true;
    });
}

// ─── 场景测试 ───────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}`);
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ ${name} (异常: ${e.message})`);
    failed++;
  }
}

console.log('╔══════════════════════════════════════════╗');
console.log('║   端到端场景测试                         ║');
console.log('╚══════════════════════════════════════════╝');

// ── 场景 1: 正常流程 ─────────────────────────────────────────────
console.log('\n📋 场景 1: 正常创建 → 退出流程');

test('Agent 创建会话，服务器接收', () => {
  const agentSessions = [
    { id: 's1', title: 'Stock', cwd: '/ws/Stock', status: 'running', pid: 100 },
    { id: 's2', title: 'hq', cwd: '/ws/hq', status: 'running', pid: 200 },
  ];
  const serverFiltered = serverFilterSessions(agentSessions);
  return serverFiltered.length === 2 &&
    serverFiltered[0].id === 's1' &&
    serverFiltered[1].id === 's2';
});

test('会话退出，状态更新', () => {
  const agentSessions = [
    { id: 's1', title: 'Stock', cwd: '/ws/Stock', status: 'exited', pid: 100 },
    { id: 's2', title: 'hq', cwd: '/ws/hq', status: 'running', pid: 200 },
  ];
  const serverFiltered = serverFilterSessions(agentSessions);
  return serverFiltered.length === 2 &&
    serverFiltered[0].status === 'exited';
});

test('浏览器收到 exited 会话，不清理（保留在列表）', () => {
  const browserState = [
    { id: 's1', title: 'Stock', status: 'exited' },
    { id: 's2', title: 'hq', status: 'running' },
  ];
  const cleaned = browserCleanSessions(browserState);
  return cleaned.length === 2; // exited 不是 stale，保留
});

// ── 场景 2: Agent 断开重连 ────────────────────────────────────────
console.log('\n📋 场景 2: Agent 断开 → 重连流程');

test('Agent 断开：服务器标记 disconnected', () => {
  const slot = new MockAgentSlot();
  // Agent 在线时上报
  slot.sessions = [
    { id: 's1', title: 'Stock', cwd: '/ws/Stock', status: 'running', pid: 100 },
    { id: 's2', title: 'hq', cwd: '/ws/hq', status: 'running', pid: 200 },
  ];
  // Agent 断开 → 服务器标记
  slot.sessions = slot.sessions.map(s => ({ ...s, status: 'disconnected' }));
  return slot.sessions.every(s => s.status === 'disconnected');
});

test('Agent 断开：浏览器清理 disconnected', () => {
  const browserState = [
    { id: 's1', title: 'Stock', status: 'disconnected' },
    { id: 's2', title: 'hq', status: 'disconnected' },
  ];
  const cleaned = browserCleanSessions(browserState);
  return cleaned.length === 0; // 全部 disconnected，全部清理
});

test('Agent 重连：服务器过滤旧 disconnected，Agent 重新上报', () => {
  const slot = new MockAgentSlot();
  // 旧残留（disconnected）
  slot.sessions = [
    { id: 's1', title: 'Stock', cwd: '/ws/Stock', status: 'disconnected', pid: 0 },
  ];
  // Agent 重连后上报
  const agentReported = [
    { id: 's1', title: 'Stock', cwd: '/ws/Stock', status: 'running', pid: 100 },
    { id: 's2', title: 'hq', cwd: '/ws/hq', status: 'running', pid: 200 },
  ];
  // 服务器过滤
  const filtered = serverFilterSessions(agentReported);
  return filtered.length === 2 && filtered.every(s => s.status === 'running');
});

// ── 场景 3: recovered 攻击 ────────────────────────────────────────
console.log('\n📋 场景 3: Agent recovery bug 产生的 recovered 洪水');

test('28 个 recovered + 1 个 running → 仅保留 1 个', () => {
  const sessions = [];
  // 模拟 10 轮恢复（每轮 3 个 recovered）
  for (let round = 0; round < 10; round++) {
    sessions.push({ id: `rec-stock-${round}`, title: 'Stock', cwd: '/ws/Stock', status: 'recovered' });
    sessions.push({ id: `rec-hq-${round}`, title: 'hq', cwd: '/ws/hq', status: 'recovered' });
    if (round % 3 === 0) sessions.push({ id: `rec-web-${round}`, title: 'web', cwd: '/ws/web', status: 'recovered' });
  }
  // 1 个真实 running 会话
  sessions.push({ id: 'real-001', title: '会话-172952', cwd: '/ws', status: 'running' });

  const filtered = serverFilterSessions(sessions);
  return filtered.length === 1 && filtered[0].id === 'real-001';
});

test('Agent 端 listSessions 自动过滤 recovered', () => {
  const agentInternal = new Map();
  agentInternal.set('real', { id: 'real', title: 'Stock', cwd: '/ws/Stock', status: 'running' });
  agentInternal.set('rec1', { id: 'rec1', title: 'Stock', cwd: '/ws/Stock', status: 'recovered' });
  agentInternal.set('rec2', { id: 'rec2', title: 'hq', cwd: '/ws/hq', status: 'recovered' });

  const sessionsArr = [...agentInternal.values()];
  const filtered = agentListSessions(sessionsArr);
  return filtered.length === 1 && filtered[0].id === 'real';
});

// ── 场景 4: 混合状态 ──────────────────────────────────────────────
console.log('\n📋 场景 4: 混合状态处理（running + exited + disconnected + recovered）');

test('浏览器：只清理 disconnected 和 recovered，保留 running 和 exited', () => {
  const browserState = [
    { id: 's1', title: 'running', status: 'running' },
    { id: 's2', title: 'exited', status: 'exited' },
    { id: 's3', title: 'disconnected', status: 'disconnected' },
    { id: 's4', title: 'recovered', status: 'recovered' },
  ];
  const cleaned = browserCleanSessions(browserState);
  return cleaned.length === 2 &&
    cleaned.some(s => s.id === 's1') &&
    cleaned.some(s => s.id === 's2');
});

test('服务器：接受 running + exited + disconnected，过滤 recovered', () => {
  const raw = [
    { id: 's1', title: 'r', cwd: '/x', status: 'running' },
    { id: 's2', title: 'e', cwd: '/y', status: 'exited' },
    { id: 's3', title: 'd', cwd: '/z', status: 'disconnected' },
    { id: 's4', title: 'bad', cwd: '/w', status: 'recovered' },
  ];
  const filtered = serverFilterSessions(raw);
  return filtered.length === 3 &&
    filtered.every(s => s.status !== 'recovered');
});

// ── 场景 5: 同名同目录多会话 ─────────────────────────────────────
console.log('\n📋 场景 5: 同 title+cwd 不同 ID 是合法多会话');

test('服务器：3 个同 title+cwd 会话 → 全部保留', () => {
  const raw = [
    { id: 'id-001', title: 'Stock', cwd: '/ws/Stock', status: 'running' },
    { id: 'id-002', title: 'Stock', cwd: '/ws/Stock', status: 'running' },
    { id: 'id-003', title: 'Stock', cwd: '/ws/Stock', status: 'running' },
    { id: 'id-004', title: 'hq', cwd: '/ws/hq', status: 'running' },
  ];
  const filtered = serverFilterSessions(raw);
  return filtered.length === 4;
});

test('Agent 端：3 个同 title+cwd → 全部保留', () => {
  const sessions = [
    { id: 'id-001', title: 'Stock', cwd: '/ws/Stock', status: 'running' },
    { id: 'id-002', title: 'Stock', cwd: '/ws/Stock', status: 'running' },
    { id: 'id-003', title: 'Stock', cwd: '/ws/Stock', status: 'running' },
  ];
  const filtered = agentListSessions(sessions);
  return filtered.length === 3;
});

// ── 结果汇总 ─────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
if (failed === 0) {
  console.log(`🎉 全部 ${passed}/${passed + failed} 场景测试通过!`);
} else {
  console.log(`⚠️  ${passed}/${passed + failed} 通过, ${failed} 失败`);
}
process.exit(failed > 0 ? 1 : 0);
