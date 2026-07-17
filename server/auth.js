'use strict';

const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sha256hex = (value) => sha256(value).toString('hex');
const isValidToken = (token) => typeof token === 'string' &&
  token.length >= 32 && token.length <= 512 &&
  !/change-me|deprecated|your-token|shared-secret/i.test(token);

/**
 * Recommended configuration:
 * {
 *   "devices": {
 *     "production-a": {
 *       "name": "Production A",
 *       "browserToken": "...",
 *       "agentToken": "...different secret..."
 *     }
 *   }
 * }
 *
 * Legacy `tokens` and `token` values remain accepted for migration. A legacy
 * token is intentionally valid for both roles and therefore offers weaker
 * Agent identity protection.
 */
function createAuthMiddleware(config) {
  /** @type {Map<string, {name:string, token:string, routingKey:string, roles:Set<string>}>} */
  const credentials = new Map();
  /** @type {Map<string, string>} */
  const routeNames = new Map();
  let deviceCredentials = 0;
  let legacyCredentials = 0;

  function addCredential(token, name, routingKey, role) {
    if (!isValidToken(token)) return false;
    const digest = sha256hex(token);
    const existing = credentials.get(digest);
    if (existing) {
      if (existing.token !== token || existing.routingKey !== routingKey) {
        console.error('❌ 检测到重复凭据被分配给不同设备，已拒绝该配置项');
        return false;
      }
      existing.roles.add(role);
      return true;
    }
    credentials.set(digest, {
      name: String(name || 'unknown').slice(0, 120),
      token,
      routingKey,
      roles: new Set([role]),
    });
    routeNames.set(routingKey, String(name || 'unknown').slice(0, 120));
    return true;
  }

  const devices = config.devices;
  if (devices && typeof devices === 'object' && !Array.isArray(devices)) {
    for (const [deviceId, device] of Object.entries(devices)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId) || !device || typeof device !== 'object') {
        console.warn(`⚠  忽略无效设备配置: ${String(deviceId).slice(0, 32)}`);
        continue;
      }
      const browserToken = device.browserToken;
      const agentToken = device.agentToken;
      if (!isValidToken(browserToken) || !isValidToken(agentToken) || browserToken === agentToken) {
        console.warn(`⚠  忽略设备 ${deviceId}：browserToken/agentToken 必须有效且彼此不同`);
        continue;
      }
      if (credentials.has(sha256hex(browserToken)) || credentials.has(sha256hex(agentToken))) {
        console.warn(`⚠  忽略设备 ${deviceId}：凭据已被其他设备使用`);
        continue;
      }

      const routingKey = sha256hex(`device:${deviceId}`);
      const name = device.name || deviceId;
      const browserAdded = addCredential(browserToken, name, routingKey, 'browser');
      const agentAdded = addCredential(agentToken, name, routingKey, 'agent');
      if (browserAdded && agentAdded) deviceCredentials++;
    }
  }

  const legacyTokens = config.tokens;
  if (legacyTokens && typeof legacyTokens === 'object' && !Array.isArray(legacyTokens)) {
    for (const [token, name] of Object.entries(legacyTokens)) {
      if (!isValidToken(token)) {
        console.warn(`⚠  旧 Token 被忽略（长度无效或仍为示例值）: "${String(token).slice(0, 8)}..."`);
        continue;
      }
      const routingKey = sha256hex(`legacy:${token}`);
      if (addCredential(token, name, routingKey, 'browser') &&
          addCredential(token, name, routingKey, 'agent')) {
        legacyCredentials++;
      }
    }
  }

  const legacyToken = config.token;
  if (legacyToken) {
    if (!isValidToken(legacyToken)) {
      console.error('❌ 旧单 Token 无效：必须为 32-512 个字符且不能使用示例值');
    } else {
      const routingKey = sha256hex(`legacy:${legacyToken}`);
      if (addCredential(legacyToken, 'default', routingKey, 'browser') &&
          addCredential(legacyToken, 'default', routingKey, 'agent')) {
        legacyCredentials++;
      }
    }
  }

  if (credentials.size === 0) {
    console.error('❌ 未配置任何有效凭据！推荐在 config.json 中设置 devices。');
    console.error('   生成强 Token: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
    process.exit(1);
  }

  const mode = deviceCredentials > 0
    ? (legacyCredentials > 0 ? 'mixed' : 'devices')
    : 'legacy';

  return {
    verify(providedToken, role) {
      if (!providedToken || typeof providedToken !== 'string' || !['browser', 'agent'].includes(role)) {
        return { valid: false };
      }
      const entry = credentials.get(sha256hex(providedToken));
      if (!entry) return { valid: false };

      const provided = Buffer.from(providedToken);
      const expected = Buffer.from(entry.token);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        return { valid: false };
      }
      if (!entry.roles.has(role)) return { valid: false };

      return {
        valid: true,
        name: entry.name,
        routingKey: entry.routingKey,
      };
    },

    getName(providedToken) {
      const entry = credentials.get(sha256hex(providedToken || ''));
      return entry ? entry.name : 'unknown';
    },

    listTokens() {
      return [...routeNames.values()];
    },

    get tokenCount() {
      return routeNames.size;
    },

    get mode() {
      return mode;
    },

    generateSessionId() {
      return crypto.randomUUID();
    },
  };
}

module.exports = { createAuthMiddleware };
