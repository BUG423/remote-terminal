/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 命令审计日志
 *
 * 记录每个终端会话中用户输入的命令行（Enter 结束时刷新一行），
 * 写入审计日志文件供事后追溯。
 *
 * 日志格式（每行一条 JSON）：
 *   {"ts":"2026-06-14T12:00:00.000Z","session":"abc123","title":"会话名","cmd":"ls -la"}
 *
 * 仅记录以 Enter（\r）结尾的完整命令行，忽略单独的按键和控制字符。
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let auditLogPath = process.env.CW_AUDIT_LOG ||
  path.join(os.homedir(), 'WebClaudeWorkspaces', '.audit.log');
let maxLogBytes = 10 * 1024 * 1024;
let maxBackups = 3;
let enabled = process.env.CW_AUDIT_ENABLED !== 'false';

// 每个会话的输入缓冲区：sessionId -> string
const buffers = new Map();

function configure(options = {}) {
  if (options.path) auditLogPath = path.resolve(options.path);
  if (Number.isInteger(options.maxBytes) && options.maxBytes >= 1024) maxLogBytes = options.maxBytes;
  if (Number.isInteger(options.maxBackups) && options.maxBackups >= 1 && options.maxBackups <= 20) {
    maxBackups = options.maxBackups;
  }
  if (typeof options.enabled === 'boolean') enabled = options.enabled;
}

/**
 * 喂入一块终端输入数据。当检测到 Enter（\r）时，
 * 把当前行清洗后写入审计日志。
 */
function feed(sessionId, sessionTitle, chunk) {
  if (!enabled || !chunk) return;

  let buf = buffers.get(sessionId) || '';
  buf += chunk;

  // 查找 \r（Enter）或 \n
  let flushed = false;
  while (true) {
    const cr = buf.indexOf('\r');
    const lf = buf.indexOf('\n');
    let idx = -1;
    if (cr >= 0 && lf >= 0) idx = Math.min(cr, lf);
    else if (cr >= 0) idx = cr;
    else if (lf >= 0) idx = lf;
    else break;

    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    flushLine(sessionId, sessionTitle, line);
    flushed = true;
  }

  // 缓冲区过大时截断（防止异常情况内存泄漏）
  if (buf.length > 8192) buf = buf.slice(-4096);

  if (flushed || !buffers.has(sessionId)) {
    buffers.set(sessionId, buf);
  } else {
    buffers.set(sessionId, buf);
  }
}

/**
 * 把一行命令写入审计日志。
 */
function flushLine(sessionId, sessionTitle, rawLine) {
  // 清洗：去掉 ANSI 转义序列和控制字符
  const cleaned = rawLine
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI 序列
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // 控制字符（保留 \t）
    .replace(/[\x7F]/g, '')                   // DEL
    .trim();

  if (!cleaned) return; // 空行不记录

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    session: sessionId.slice(0, 8),
    title: sessionTitle || '',
    cmd: cleaned,
  }) + '\n';

  try {
    const dir = path.dirname(auditLogPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rotateIfNeeded(Buffer.byteLength(entry));
    fs.appendFileSync(auditLogPath, entry, { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(auditLogPath, 0o600); } catch { /* 某些文件系统不支持 chmod */ }
  } catch (err) {
    console.error(`❌ 审计日志写入失败: ${err.message}`);
  }
}

function rotateIfNeeded(incomingBytes) {
  let currentBytes = 0;
  try { currentBytes = fs.statSync(auditLogPath).size; } catch { /* 文件尚不存在 */ }
  if (currentBytes + incomingBytes <= maxLogBytes) return;

  const oldest = `${auditLogPath}.${maxBackups}`;
  try { fs.unlinkSync(oldest); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (let i = maxBackups - 1; i >= 1; i--) {
    const from = `${auditLogPath}.${i}`;
    const to = `${auditLogPath}.${i + 1}`;
    try { fs.renameSync(from, to); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  try { fs.renameSync(auditLogPath, `${auditLogPath}.1`); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

/**
 * 清理会话缓冲区。
 */
function clearSession(sessionId) {
  buffers.delete(sessionId);
}

/**
 * 返回审计日志文件路径。
 */
function logPath() {
  return auditLogPath;
}

module.exports = { configure, feed, clearSession, logPath };
