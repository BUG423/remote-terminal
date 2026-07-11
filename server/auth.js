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
 *
 * 时序安全说明：
 *   校验时统一先把输入 token 做 SHA-256（固定 32 字节），再在“摘要 → 条目”表里查找。
 *   查表始终发生在等长的摘要上，不随真实 token 的内容/长度产生可测量的时序差异，
 *   命中后再对原始值做定长 timingSafeEqual 二次确认，杜绝时序侧信道与摘要碰撞的理论风险。
 */

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sha256hex = (s) => sha256(s).toString('hex');

function createAuthMiddleware(config) {
  const tokens = config.tokens;
  const legacyToken = config.token;

  // 先收集「原始 token → 显示名」，并做长度 / 默认值校验
  /** @type {Map<string, string>} */
  const raw = new Map();

  if (tokens && typeof tokens === 'object') {
    for (const [tok, name] of Object.entries(tokens)) {
      if (tok && tok.length >= 32) raw.set(tok, String(name || ''));
      else console.warn(`⚠  Token 被忽略（长度不足32字符）: "${String(tok).slice(0, 8)}..."`);
    }
  }

  // 兼容旧版单 token
  if (legacyToken && !raw.has(legacyToken)) {
    if (legacyToken.length < 32) {
      console.error('❌ Token 长度不足！必须至少32个字符。请使用以下命令生成强 Token:');
      console.error('   node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"');
      process.exit(1);
    }
    raw.set(legacyToken, 'default');
  }

  const mode = tokens ? 'multi' : 'single';

  if (raw.size === 0) {
    console.error('❌ 未配置任何有效 Token！请在 config.json 中设置 tokens 或 token。');
    console.error('   生成强 Token: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"');
    process.exit(1);
  } else if (mode === 'single' && legacyToken === 'your-shared-secret-token-change-me') {
    console.error('❌ 使用默认 Token！这存在严重安全风险。请生成强 Token并更新 config.json:');
    console.error('   node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"');
    process.exit(1);
  }

  // 以 SHA-256 摘要（64 hex）为键建索引，查表时序与真实 token 无关
  /** @type {Map<string, {name: string, token: string}>} */
  const digestMap = new Map();
  for (const [tok, name] of raw) {
    digestMap.set(sha256hex(tok), { name, token: tok });
  }

  return {
    /**
     * 验证 Token（单/多模式统一走定长摘要查表 + timing-safe 二次确认）。
     * @returns {{ valid: true, name: string, token: string } | { valid: false }}
     */
    verify(providedToken) {
      if (!providedToken || typeof providedToken !== 'string') return { valid: false };

      const entry = digestMap.get(sha256hex(providedToken));
      if (!entry) return { valid: false };

      // 命中后对原始值做定长恒定时间比较（防御摘要碰撞的理论情形）
      const a = Buffer.from(providedToken);
      const b = Buffer.from(entry.token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };

      return { valid: true, name: entry.name || 'unknown', token: entry.token };
    },

    /**
     * 获取 Token 对应的 Agent 名称（用于显示）。
     */
    getName(providedToken) {
      const entry = digestMap.get(sha256hex(providedToken || ''));
      return entry ? (entry.name || 'unknown') : 'unknown';
    },

    /**
     * 返回所有 Token 列表（不含密钥，仅名称）。
     */
    listTokens() {
      return [...digestMap.values()].map((v) => v.name);
    },

    /**
     * Token 数量。
     */
    get tokenCount() {
      return digestMap.size;
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
