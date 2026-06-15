/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — IP 速率限制器（防暴力破解）
 *
 * 纯内存实现，无外部依赖。
 * - 按 IP 追踪认证失败次数
 * - 超过阈值后临时封禁该 IP
 * - 定期清理过期条目（防内存泄漏）
 * ═══════════════════════════════════════════════════════════════
 */

const MAX_ATTEMPTS = parseInt(process.env.CW_RATE_LIMIT_MAX) || 8;       // 最大失败次数
const WINDOW_MS = parseInt(process.env.CW_RATE_LIMIT_WINDOW) || 60000;   // 计数窗口（默认 60s）
const BLOCK_MS = parseInt(process.env.CW_RATE_LIMIT_BLOCK) || 300000;    // 封禁时长（默认 5min）
const CLEANUP_MS = 300000;                                                // 清理间隔（5min）

/** @type {Map<string, {count: number, firstAttempt: number, blockedUntil?: number}>} */
const attempts = new Map();

/**
 * 记录一次认证失败。
 */
function recordFailed(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || (now - entry.firstAttempt) > WINDOW_MS) {
    // 新窗口：重置计数
    attempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
    // 达到阈值：标记封禁
    if (entry.count >= MAX_ATTEMPTS && !entry.blockedUntil) {
      entry.blockedUntil = now + BLOCK_MS;
      console.warn(`🚫 速率限制: IP ${ip} 已被封禁 ${BLOCK_MS / 1000}s（${entry.count} 次失败）`);
    }
  }
}

/**
 * 检查 IP 是否被临时封禁。
 * @returns {{ blocked: boolean, reason?: string }}
 */
// 本地/内网 IP 白名单，不限制（开发时不会被自己封禁）
const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function checkBlocked(ip) {
  // 本地回环地址永远不封
  if (LOCAL_IPS.has(ip) || ip === '127.0.0.1') return { blocked: false };

  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry) return { blocked: false };

  // 封禁期已过：重置
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    attempts.delete(ip);
    return { blocked: false };
  }

  if (entry.blockedUntil && now < entry.blockedUntil) {
    const remaining = Math.ceil((entry.blockedUntil - now) / 1000);
    return {
      blocked: true,
      reason: `请求过于频繁，请 ${remaining} 秒后重试`,
    };
  }

  return { blocked: false };
}

/**
 * 认证成功后清除该 IP 的记录。
 */
function clearFor(ip) {
  attempts.delete(ip);
}

/**
 * 返回当前状态（供调试/监控）。
 */
function stats() {
  return {
    trackedIPs: attempts.size,
    threshold: MAX_ATTEMPTS,
    windowMs: WINDOW_MS,
    blockMs: BLOCK_MS,
  };
}

// 定期清理过期条目
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      attempts.delete(ip);
    } else if (!entry.blockedUntil && (now - entry.firstAttempt) > WINDOW_MS * 2) {
      attempts.delete(ip);
    }
  }
}, CLEANUP_MS);

module.exports = { recordFailed, checkBlocked, clearFor, stats };
