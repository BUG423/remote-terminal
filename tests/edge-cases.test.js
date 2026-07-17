/**
 * 边界条件 & 竞态测试
 */

const VALID_SERVER_STATUSES = ['running', 'exited', 'disconnected'];
const STALE_STATUSES = new Set(['disconnected', 'recovered']);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}`); failed++; }
  } catch (e) {
    console.log(`  ❌ ${name} (异常: ${e.message})`);
    failed++;
  }
}

console.log('╔══════════════════════════════════════════╗');
console.log('║   边界条件 & 竞态测试                    ║');
console.log('╚══════════════════════════════════════════╝');

// ── 服务器过滤边界 ───────────────────────────────────────────────
console.log('\n📋 服务器端过滤边界');

test('status 为 null → 被过滤', () => {
  const raw = [{ id: 's1', title: 'x', cwd: '/x', status: null }];
  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    if (!VALID_SERVER_STATUSES.includes(s.status)) return false;
    return true;
  });
  return filtered.length === 0;
});

test('status 为 undefined → 被过滤', () => {
  const raw = [{ id: 's1', title: 'x', cwd: '/x' }];
  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    if (!VALID_SERVER_STATUSES.includes(s.status)) return false;
    return true;
  });
  return filtered.length === 0;
});

test('status 为空字符串 → 被过滤', () => {
  const raw = [{ id: 's1', title: 'x', cwd: '/x', status: '' }];
  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    if (!VALID_SERVER_STATUSES.includes(s.status)) return false;
    return true;
  });
  return filtered.length === 0;
});

test('session 对象为 null → 被过滤', () => {
  const raw = [null, { id: 's1', title: 'x', cwd: '/x', status: 'running' }];
  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    if (!VALID_SERVER_STATUSES.includes(s.status)) return false;
    return true;
  });
  return filtered.length === 1;
});

test('id 为空字符串 → 被过滤', () => {
  const raw = [{ id: '', title: 'x', cwd: '/x', status: 'running' }];
  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    return true;
  });
  return filtered.length === 0; // 空字符串是 falsy
});

test('大量会话（100个）按 ID 去重 → 性能正常', () => {
  const raw = [];
  // 创建 100 个合法会话；即使 title/cwd 相同，只要 id 不同就应保留。
  for (let i = 0; i < 50; i++) {
    raw.push({ id: `unique-${i}`, title: `Session ${i}`, cwd: `/ws/${i}`, status: 'running' });
    raw.push({ id: `same-title-${i}`, title: `Session ${i}`, cwd: `/ws/${i}`, status: 'running' });
  }
  const start = Date.now();
  const seenIds = new Set();
  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    if (seenIds.has(s.id)) return false;
    if (!VALID_SERVER_STATUSES.includes(s.status)) return false;
    seenIds.add(s.id);
    return true;
  });
  const elapsed = Date.now() - start;
  const valid = filtered.length === 100 && elapsed < 100;
  console.log(`    → ${filtered.length} 个会话, 耗时 ${elapsed}ms`);
  return valid;
});

// ── 浏览器清理边界 ────────────────────────────────────────────────
console.log('\n📋 浏览器端清理边界');

test('空 sessions 数组 → 清理返回空', () => {
  const cleaned = [].filter(s => !STALE_STATUSES.has(s.status));
  return cleaned.length === 0;
});

test('全部 running → 一个不清理', () => {
  const state = [
    { id: 's1', status: 'running' },
    { id: 's2', status: 'running' },
  ];
  const cleaned = state.filter(s => !STALE_STATUSES.has(s.status));
  return cleaned.length === 2;
});

test('全部 exited → 一个不清理（exited 不是 stale）', () => {
  const state = [
    { id: 's1', status: 'exited' },
    { id: 's2', status: 'exited' },
  ];
  const cleaned = state.filter(s => !STALE_STATUSES.has(s.status));
  return cleaned.length === 2;
});

test('未知状态（如 "unknown"）→ 浏览器不清理（只清理 disconnected/recovered）', () => {
  const state = [
    { id: 's1', status: 'running' },
    { id: 's2', status: 'unknown' },  // 不在 STALE_STATUSES 中
  ];
  const cleaned = state.filter(s => !STALE_STATUSES.has(s.status));
  return cleaned.length === 2; // unknown 不被清理（保守策略，只清理明确的异常状态）
});

// ── 竞态条件模拟 ────────────────────────────────────────────────
console.log('\n📋 竞态条件');

test('服务器清理定时器 + Agent 重连竞态', () => {
  // 模拟：定时器准备清理，但 Agent 已重连
  let slot = { ws: null, sessions: [{ id: 's1', status: 'disconnected' }], cleanupTimer: null };

  // 定时器逻辑：检查 slot.ws 是否为 null
  const shouldClean = !slot.ws && slot.sessions.every(s => s.status === 'disconnected');

  // Agent 先重连了
  slot.ws = { readyState: 1 };
  slot.sessions = [{ id: 's1', status: 'running' }];

  // 此时 shouldClean 已是 false（因为之前 check 的 !slot.ws 在 slot.ws 设置前就求值了）
  // 但实际清理逻辑中，会在 setTimeout 回调里重新检查：
  const willActuallyClean = !slot.ws;
  return !willActuallyClean; // Agent 已重连，不应该清理
});

test('浏览器收到 agent_status(offline) 在 sessions(disconnected) 之前', () => {
  // 模拟：agent_status 先标记所有为 disconnected，然后 cleanup
  const state = [
    { id: 's1', title: 'Stock', status: 'running' },
  ];

  // agent_status 到达：先标记
  state.forEach(s => { s.status = 'disconnected'; });

  // 然后清理
  const stale = state.filter(s => STALE_STATUSES.has(s.status));
  // 此时所有都是 disconnected
  const allCaught = stale.length === 1;
  return allCaught;
});

test('浏览器收到 agent_status(offline) 在 sessions(disconnected) 之后（逆序）', () => {
  const state = [
    { id: 's1', title: 'Stock', status: 'running' },
  ];

  // sessions 消息先到达（虽然不太可能，但做防御）
  state[0].status = 'disconnected';  // sessions 更新

  // 然后 agent_status 到达：标记所有
  state.forEach(s => { s.status = 'disconnected'; });

  // 清理
  const stale = state.filter(s => STALE_STATUSES.has(s.status));
  return stale.length === 1;
});

// ── 结果 ────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
if (failed === 0) {
  console.log(`🎉 全部 ${passed}/${passed + failed} 边界测试通过!`);
} else {
  console.log(`⚠️  ${passed}/${passed + failed} 通过, ${failed} 失败`);
}
process.exit(failed > 0 ? 1 : 0);
