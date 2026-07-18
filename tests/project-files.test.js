'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
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
console.log('║   配置、部署脚本与静态资源检查           ║');
console.log('╚══════════════════════════════════════════╝');

test('config.json.example 是合法 JSON', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json.example'), 'utf8'));
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.enableLegacyChat, false);
  const device = config.devices['server-a'];
  assert.notEqual(device.browserToken, device.agentToken);
  assert.equal(config.agentToken, device.agentToken);
});

for (const file of ['deploy.sh', 'start-local.sh', 'scripts/run-server-tests.sh']) {
  test(`${file} 通过 bash 语法检查`, () => {
    const result = spawnSync('bash', ['-n', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
}

test('部署脚本不上传密钥、不改防火墙和默认 Nginx 站点', () => {
  const source = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
  assert(!/scp\s/i.test(source));
  assert(!/ufw\s/i.test(source));
  assert(!/sites-enabled\/default/.test(source));
});

test('浏览器入口只引用 Server 本地依赖', () => {
  const html = fs.readFileSync(path.join(root, 'server/public/index.html'), 'utf8');
  assert(html.includes('/vendor/xterm.js'));
  assert(!/https?:\/\//.test(html));
});

test('systemd 单元使用独立低权限账户和资源上限', () => {
  const serverUnit = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-server.service'), 'utf8');
  const agentUnit = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-agent.service'), 'utf8');
  assert(serverUnit.includes('User=remote-terminal-server'));
  assert(agentUnit.includes('User=remote-terminal-agent'));
  assert(serverUnit.includes('NoNewPrivileges=true'));
  assert(agentUnit.includes('NoNewPrivileges=true'));
  assert(serverUnit.includes('MemoryMax='));
  assert(agentUnit.includes('MemoryMax='));
  assert(agentUnit.includes('ReadWritePaths=/var/lib/remote-terminal-agent'));
});

test('定期监控单元默认只读且由环境文件显式启用恢复策略', () => {
  const monitorUnit = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-monitor.service'), 'utf8');
  const monitorTimer = fs.readFileSync(path.join(root, 'deploy/systemd/remote-terminal-monitor.timer'), 'utf8');
  assert(monitorUnit.includes('Type=oneshot'));
  assert(monitorUnit.includes('Environment=RT_MONITOR_AUTO_HEAL=0'));
  assert(monitorUnit.includes('Environment=RT_MONITOR_ENFORCE_NO_AGENT=0'));
  assert(monitorUnit.includes('EnvironmentFile=-/etc/remote-terminal/monitor.env'));
  assert(monitorUnit.includes('StateDirectory=remote-terminal-monitor'));
  assert(monitorUnit.includes('NoNewPrivileges=true'));
  assert(monitorUnit.includes('MemoryMax='));
  assert(monitorTimer.includes('OnUnitInactiveSec=5min'));
  assert(monitorTimer.includes('Persistent=true'));
  assert(!monitorUnit.includes('/agent/index.js'));
});

test('监控脚本通过 Node 语法检查', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/monitor-server.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 项目文件检查通过`);
if (passed !== results.length) process.exit(1);
