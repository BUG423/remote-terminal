'use strict';

const assert = require('assert');
const {
  collectResourceWarnings,
  envFlag,
  isForbiddenAgentProcess,
  positiveNumber,
  selectDevice,
} = require('../scripts/monitor-server');

const tests = [];

function test(name, fn) {
  try {
    fn();
    tests.push(true);
    console.log(`  ✅ ${name}`);
  } catch (err) {
    tests.push(false);
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

console.log('╔══════════════════════════════════════════╗');
console.log('║   Server 定期监控策略测试                ║');
console.log('╚══════════════════════════════════════════╝');

test('识别旧目录中以 node index.js 运行的 Agent', () => {
  assert.equal(isForbiddenAgentProcess('/root/workspace/remote-terminal/agent', 'node\0index.js\0'), true);
});

test('识别 systemd 和仓库根目录启动的 Agent', () => {
  assert.equal(
    isForbiddenAgentProcess('/var/lib/remote-terminal-agent/workspace', '/usr/bin/node\0/opt/remote-terminal/agent/index.js\0'),
    true
  );
  assert.equal(isForbiddenAgentProcess('/opt/remote-terminal', 'node\0agent/index.js\0'), true);
});

test('不会把 Server 或 stockagent 当作 Remote Terminal Agent', () => {
  assert.equal(isForbiddenAgentProcess('/opt/remote-terminal/server', 'node\0index.js\0'), false);
  assert.equal(isForbiddenAgentProcess('/root/workspace/stockagent', 'node\0index.js\0'), false);
});

test('不会误判正文中提到 Agent 路径的 Bash 运维命令', () => {
  const command = 'bash\0-c\0pgrep node /opt/remote-terminal/agent/index.js\0';
  assert.equal(isForbiddenAgentProcess('/root', command), false);
});

test('多设备配置必须显式选择被监控设备', () => {
  const config = { devices: { a: { browserToken: 'a'.repeat(32) }, b: { browserToken: 'b'.repeat(32) } } };
  assert.throws(() => selectDevice(config, ''), /RT_MONITOR_DEVICE_ID/);
  assert.equal(selectDevice(config, 'b').id, 'b');
});

test('资源阈值只报告实际越界指标', () => {
  const warnings = collectResourceWarnings(
    { load1: 5, cpuCount: 2, memoryAvailableMb: 200, diskUsedPercent: 70 },
    { loadPerCpu: 2, memoryAvailableMb: 256, diskUsedPercent: 85 }
  );
  assert.equal(warnings.length, 2);
  assert(warnings.some((item) => item.includes('load1')));
  assert(warnings.some((item) => item.includes('available memory')));
  assert(!warnings.some((item) => item.includes('disk usage')));
});

test('环境布尔值和数值限制使用安全默认值', () => {
  assert.equal(envFlag('yes'), true);
  assert.equal(envFlag('off', true), false);
  assert.equal(positiveNumber('300', 256, 64, 1024), 300);
  assert.equal(positiveNumber('9999', 256, 64, 1024), 256);
});

const passed = tests.filter(Boolean).length;
console.log(`\n${passed}/${tests.length} 监控策略测试通过`);
if (passed !== tests.length) process.exit(1);
