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

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 项目文件检查通过`);
if (passed !== results.length) process.exit(1);
