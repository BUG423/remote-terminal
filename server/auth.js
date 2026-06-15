const crypto = require('crypto');

/**
 * Token-based authentication — 支持单 Token 和多 Token 两种模式。
 *
 * 多 Token 模式（推荐）：
 *   每个 Agent 分配独立 Token，浏览器输入哪个 Token 就连到哪个 Agent。
 *   config.json: { "tokens": { "tok-abc": "办公室", "tok-xyz": "家里" } }
 *
 * 单 Token 模式（兼容旧版）：
 *   所有 Agent 和浏览器共用同一个 Token。
 *   config.json: { "token": "shared-secret" }
 */

function createAuthMiddleware(config) {
  const tokens = config.tokens;
  const legacyToken = config.token;

  // 构建 token → displayName 映射
  /** @type {Map<string, string>} */
  const tokenMap = new Map();

  if (tokens && typeof tokens === 'object') {
    for (const [tok, name] of Object.entries(tokens)) {
      if (tok && tok.length >= 8) tokenMap.set(tok, String(name || ''));
    }
  }

  // 兼容旧版单 token
  if (legacyToken && !tokenMap.has(legacyToken)) {
    tokenMap.set(legacyToken, 'default');
  }

  const mode = tokens ? 'multi' : 'single';

  if (tokenMap.size === 0) {
    console.warn('⚠  WARNING: 未配置任何有效 Token！请在 config.json 中设置 tokens 或 token。');
  } else if (mode === 'single') {
    if (legacyToken === 'your-shared-secret-token-change-me') {
      console.warn('⚠  WARNING: 使用默认 Token，请立即更换！');
    }
  }

  return {
    /**
     * 验证 Token。支持 multi 和 single 两种模式。
     * @returns {{ valid: true, name: string, token: string } | { valid: false }}
     */
    verify(providedToken) {
      if (!providedToken) return { valid: false };

      // 多 Token 模式：O(1) Map 查找
      if (mode === 'multi' || tokenMap.size > 1) {
        const name = tokenMap.get(providedToken);
        return name !== undefined
          ? { valid: true, name: name || 'unknown', token: providedToken }
          : { valid: false };
      }

      // 单 Token 模式：timing-safe 比较（防时序攻击）
      const expected = tokenMap.keys().next().value;
      if (!expected) return { valid: false };
      try {
        const ok = crypto.timingSafeEqual(
          Buffer.from(providedToken),
          Buffer.from(expected)
        );
        return ok
          ? { valid: true, name: tokenMap.get(expected) || 'default', token: expected }
          : { valid: false };
      } catch {
        return { valid: false };
      }
    },

    /**
     * 获取 Token 对应的 Agent 名称（用于显示）。
     */
    getName(providedToken) {
      return tokenMap.get(providedToken) || 'unknown';
    },

    /**
     * 返回所有 Token 列表（不含密钥，仅名称）。
     */
    listTokens() {
      return [...tokenMap.entries()].map(([, name]) => name);
    },

    /**
     * Token 数量。
     */
    get tokenCount() {
      return tokenMap.size;
    },

    /**
     * 当前模式。
     */
    get mode() {
      return mode;
    },

    /** 生成连接 ID */
    generateSessionId() {
      return crypto.randomUUID();
    }
  };
}

module.exports = { createAuthMiddleware };
