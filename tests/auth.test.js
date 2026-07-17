'use strict';

const assert = require('assert');
const { createAuthMiddleware } = require('../server/auth');

const browserToken = `browser-${'b'.repeat(40)}`;
const agentToken = `agent-${'a'.repeat(40)}`;
const legacyToken = `legacy-${'l'.repeat(40)}`;

const separated = createAuthMiddleware({
  devices: {
    production: {
      name: 'Production',
      browserToken,
      agentToken,
    },
  },
});

const browser = separated.verify(browserToken, 'browser');
const agent = separated.verify(agentToken, 'agent');

assert(browser.valid);
assert(agent.valid);
assert.equal(browser.routingKey, agent.routingKey);
assert.notEqual(browser.routingKey, browserToken);
assert.equal(separated.verify(browserToken, 'agent').valid, false);
assert.equal(separated.verify(agentToken, 'browser').valid, false);
assert.equal(separated.verify('invalid', 'browser').valid, false);
assert.equal(separated.mode, 'devices');
assert.equal(separated.tokenCount, 1);

const legacy = createAuthMiddleware({ tokens: { [legacyToken]: 'Legacy' } });
assert(legacy.verify(legacyToken, 'browser').valid);
assert(legacy.verify(legacyToken, 'agent').valid);
assert.equal(legacy.mode, 'legacy');

console.log('✅ 角色分离凭据、内部路由和旧 Token 兼容测试通过');
