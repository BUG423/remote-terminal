/**
 * session-manager 去重和过滤逻辑测试
 * 不依赖 node-pty，单独测试数据处理逻辑
 */

const path = require('path');
const os = require('os');

// ─── 模拟 createSession 的去重逻辑 ──────────────────────────────
const VALID_STATUSES = new Set(['running', 'exited']);

function testCreateSessionDedup() {
  console.log('\n📋 测试 1: createSession 去重');

  const sessions = new Map();

  // 模拟现有的 running 会话
  sessions.set('session-1', {
    id: 'session-1', title: 'Stock',
    cwd: '/home/mz/WebClaudeWorkspaces', status: 'running'
  });

  // 尝试创建同 title + cwd 的会话
  const newTitle = 'Stock';
  const newCwd = '/home/mz/WebClaudeWorkspaces';

  let duplicateFound = false;
  for (const [existingId, existing] of sessions) {
    if (existing.status === 'running' && existing.title === newTitle && existing.cwd === newCwd) {
      duplicateFound = true;
      console.log(`  ✅ 检测到重复: ${newTitle} @ ${newCwd}, 复用已有会话 ${existingId}`);
      break;
    }
  }

  if (!duplicateFound) {
    console.log(`  ❌ 未检测到重复会话!`);
    return false;
  }

  // 不同 cwd 的相同标题应该允许创建
  duplicateFound = false;
  for (const [existingId, existing] of sessions) {
    if (existing.status === 'running' && existing.title === 'Stock' && existing.cwd === '/other/path') {
      duplicateFound = true;
      break;
    }
  }
  if (!duplicateFound) {
    console.log(`  ✅ 不同 cwd 的同名会话允许创建`);
  }

  // 不同标题的相同 cwd 应该允许创建
  duplicateFound = false;
  for (const [existingId, existing] of sessions) {
    if (existing.status === 'running' && existing.title === 'hq' && existing.cwd === '/home/mz/WebClaudeWorkspaces') {
      duplicateFound = true;
      break;
    }
  }
  if (!duplicateFound) {
    console.log(`  ✅ 不同标题的同 cwd 会话允许创建`);
  }

  return true;
}

// ─── 模拟 listSessions 的过滤和去重 ─────────────────────────────
function testListSessionsFiltering() {
  console.log('\n📋 测试 2: listSessions 过滤异常状态');

  // 模拟 sessions Map（包含异常状态）
  const sessions = new Map();
  sessions.set('s1', { id: 's1', title: 'Stock', cwd: '/ws/Stock', pid: 100, status: 'running', createdAt: 1 });
  sessions.set('s2', { id: 's2', title: 'hq', cwd: '/ws/hq', pid: 101, status: 'exited', createdAt: 2 });
  sessions.set('s3', { id: 'recovered-1', title: 'Stock', cwd: '/ws/Stock', pid: 0, status: 'recovered', createdAt: 3 });
  sessions.set('s4', { id: 'recovered-2', title: 'hq', cwd: '/ws/hq', pid: 0, status: 'recovered', createdAt: 4 });
  sessions.set('s5', { id: 'recovered-3', title: 'web', cwd: '/ws/web', pid: 0, status: 'recovered', createdAt: 5 });
  sessions.set('s6', { id: 's6', title: 'disconnected', cwd: '/ws/dc', pid: 0, status: 'disconnected', createdAt: 6 });

  const seen = new Set();
  const filtered = [...sessions.values()]
    .filter((s) => {
      if (!VALID_STATUSES.has(s.status)) return false;
      const key = `${s.title}||${s.cwd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const ids = filtered.map(s => s.id);
  const expectedIds = ['s1', 's2'];

  if (ids.length === expectedIds.length && ids.every((id, i) => id === expectedIds[i])) {
    console.log(`  ✅ 过滤正确: ${ids} (过滤掉了 recovered + disconnected)`);
  } else {
    console.log(`  ❌ 过滤错误: 期望 ${expectedIds}, 实际 ${ids}`);
    return false;
  }

  return true;
}

// ─── 测试去重（相同 title+cwd、不同 ID） ──────────────────────────
function testListSessionsDedup() {
  console.log('\n📋 测试 3: listSessions 按 title+cwd 去重');

  const sessions = new Map();
  // 两个 running 会话，同 title+cwd 但不同 ID（模拟 Agent recovery bug）
  sessions.set('s1', { id: 's1', title: 'Stock', cwd: '/ws/Stock', pid: 100, status: 'running', createdAt: 1 });
  sessions.set('s2', { id: 's2', title: 'Stock', cwd: '/ws/Stock', pid: 200, status: 'running', createdAt: 2 }); // 重复!
  sessions.set('s3', { id: 's3', title: 'hq', cwd: '/ws/hq', pid: 300, status: 'running', createdAt: 3 });

  const seen = new Set();
  const filtered = [...sessions.values()]
    .filter((s) => {
      if (!VALID_STATUSES.has(s.status)) return false;
      const key = `${s.title}||${s.cwd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const ids = filtered.map(s => s.id);
  // 应该保留第一个 (s1) 和 s3，过滤掉 s2
  const expectedIds = ['s1', 's3'];

  if (ids.length === expectedIds.length && ids.every((id, i) => id === expectedIds[i])) {
    console.log(`  ✅ 去重正确: ${ids} (s2 被去重)`);
  } else {
    console.log(`  ❌ 去重错误: 期望 ${expectedIds}, 实际 ${ids}`);
    return false;
  }

  return true;
}

// ─── 测试 cleanStaleSessions ───────────────────────────────────
function testCleanStaleSessions() {
  console.log('\n📋 测试 4: cleanStaleSessions 清理残留');

  const sessions = new Map();
  sessions.set('s1', { id: 's1', title: 'Stock', cwd: '/ws/Stock', pid: 100, status: 'running' });
  sessions.set('s2', { id: 'rec-1', title: 'Stock', cwd: '/ws/Stock', pid: 0, status: 'recovered' });
  sessions.set('s3', { id: 'rec-2', title: 'hq', cwd: '/ws/hq', pid: 0, status: 'recovered' });
  sessions.set('s4', { id: 's4', title: 'old', cwd: '/ws/old', pid: 101, status: 'exited' });
  sessions.set('s5', { id: 'dc-1', title: 'dc', cwd: '/ws/dc', pid: 0, status: 'disconnected' });

  let cleaned = 0;
  for (const [id, s] of sessions) {
    if (!VALID_STATUSES.has(s.status)) {
      sessions.delete(id);
      cleaned++;
    }
  }

  const remaining = [...sessions.keys()];

  if (cleaned === 3 && remaining.length === 2 && remaining.includes('s1') && remaining.includes('s4')) {
    console.log(`  ✅ 清理正确: 删除了 ${cleaned} 个残留 (2 recovered + 1 disconnected), 保留了 ${remaining.length} 个有效会话`);
  } else {
    console.log(`  ❌ 清理错误: cleaned=${cleaned}, remaining=${remaining}`);
    return false;
  }

  return true;
}

// ─── 模拟服务器端 sessions 过滤 ──────────────────────────────────
function testServerSessionsFilter() {
  console.log('\n📋 测试 5: 服务器端 sessions 接收过滤');

  // 模拟 Agent 上报的数据（跟之前 debug 看到的一样）
  const raw = [
    { id: 'recovered-001', title: 'Stock', cwd: '/home/mz/WebClaudeWorkspaces/Stock', status: 'recovered', pid: 0 },
    { id: 'recovered-002', title: 'hq', cwd: '/home/mz/WebClaudeWorkspaces/hq', status: 'recovered', pid: 0 },
    { id: 'recovered-003', title: 'Stock', cwd: '/home/mz/WebClaudeWorkspaces/Stock', status: 'recovered', pid: 0 },
    { id: '0bc077bd-6222-46d1-bc0a-330e0854159a', title: '会话-172952', cwd: '/home/mz/WebClaudeWorkspaces', status: 'running', pid: 1234 },
    { id: 'recovered-004', title: 'hq', cwd: '/home/mz/WebClaudeWorkspaces/hq', status: 'recovered', pid: 0 },
    { id: 'recovered-005', title: 'web', cwd: '/home/mz/WebClaudeWorkspaces/web', status: 'recovered', pid: 0 },
    { id: 'recovered-006', title: 'Stock', cwd: '/home/mz/WebClaudeWorkspaces/Stock', status: 'recovered', pid: 0 },
    { id: 'recovered-007', title: 'hq', cwd: '/home/mz/WebClaudeWorkspaces/hq', status: 'recovered', pid: 0 },
    { id: 'recovered-008', title: 'web', cwd: '/home/mz/WebClaudeWorkspaces/web', status: 'recovered', pid: 0 },
  ];

  const VALID_SERVER_STATUSES = ['running', 'exited', 'disconnected'];
  const seenIds = new Set();
  const seenKeys = new Set();

  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    if (seenIds.has(s.id)) return false;
    const key = `${s.title || ''}||${s.cwd || ''}`;
    if (seenKeys.has(key)) return false;
    if (!VALID_SERVER_STATUSES.includes(s.status)) return false;
    seenIds.add(s.id);
    seenKeys.add(key);
    return true;
  });

  if (filtered.length === 1 && filtered[0].id === '0bc077bd-6222-46d1-bc0a-330e0854159a') {
    console.log(`  ✅ 服务器过滤正确: 从 ${raw.length} 个 → ${filtered.length} 个 (仅保留 running 会话)`);
  } else {
    console.log(`  ❌ 服务器过滤错误: 从 ${raw.length} → ${filtered.length}, 结果: ${JSON.stringify(filtered.map(f => f.title))}`);
    return false;
  }

  return true;
}

// ─── 边界测试 ──────────────────────────────────────────────────
function testEdgeCases() {
  console.log('\n📋 测试 6: 边界情况');

  let allPassed = true;

  // 空数组
  const emptyFiltered = [].filter(s => {
    if (!VALID_STATUSES.has(s.status)) return false;
    return true;
  });
  if (emptyFiltered.length === 0) {
    console.log(`  ✅ 空数组: 正常处理`);
  } else {
    console.log(`  ❌ 空数组: 异常`);
    allPassed = false;
  }

  // null/undefined session
  const raw = [null, undefined, { id: 's1', title: 'ok', cwd: '/x', status: 'running' }];
  const seenIds = new Set();
  const filtered = raw.filter(s => {
    if (!s || !s.id) return false;
    if (seenIds.has(s.id)) return false;
    seenIds.add(s.id);
    return true;
  });
  if (filtered.length === 1 && filtered[0].id === 's1') {
    console.log(`  ✅ null/undefined: 正常过滤`);
  } else {
    console.log(`  ❌ null/undefined: 异常 (${filtered.length} 个)`);
    allPassed = false;
  }

  // 全异常状态
  const allBad = [
    { id: 'a', title: 'x', cwd: '/x', status: 'recovered' },
    { id: 'b', title: 'y', cwd: '/y', status: 'recovered' },
  ];
  const seenKeys = new Set();
  const badFiltered = allBad.filter(s => {
    if (!['running', 'exited', 'disconnected'].includes(s.status)) return false;
    return true;
  });
  if (badFiltered.length === 0) {
    console.log(`  ✅ 全异常状态: 全部过滤掉`);
  } else {
    console.log(`  ❌ 全异常状态: 遗留了 ${badFiltered.length} 个`);
    allPassed = false;
  }

  // 空 title 或 cwd
  const emptyFields2 = [
    { id: 'a', title: '', cwd: '/x', status: 'running' },
    { id: 'b', title: 'y', cwd: '', status: 'running' },
    { id: 'c', title: '', cwd: '', status: 'running' },
  ];
  const seen3 = new Set();
  const emptyFiltered2 = emptyFields2.filter(s => {
    if (!['running', 'exited', 'disconnected'].includes(s.status)) return false;
    const key = `${s.title || ''}||${s.cwd || ''}`;
    if (seen3.has(key)) return false;
    seen3.add(key);
    return true;
  });
  if (emptyFiltered2.length === 3) {
    console.log(`  ✅ 空 title/cwd: 去重键唯一，正常保留`);
  } else {
    console.log(`  ❌ 空 title/cwd: 遗留 ${emptyFiltered2.length} 个 (期望 3)`);
    allPassed = false;
  }

  return allPassed;
}

// ─── 运行所有测试 ─────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════╗');
console.log('║   Session 去重 & 过滤 单元测试           ║');
console.log('╚══════════════════════════════════════════╝');

const results = [
  testCreateSessionDedup(),
  testListSessionsFiltering(),
  testListSessionsDedup(),
  testCleanStaleSessions(),
  testServerSessionsFilter(),
  testEdgeCases(),
];

const passed = results.filter(r => r).length;
const total = results.length;

console.log(`\n${'='.repeat(40)}`);
if (passed === total) {
  console.log(`✅ 全部 ${total}/${total} 测试通过!`);
  process.exit(0);
} else {
  console.log(`❌ ${passed}/${total} 测试通过, ${total - passed} 失败`);
  process.exit(1);
}
