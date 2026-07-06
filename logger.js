/**
 * 简单日志模块 — 记录到文件（追加模式）
 * 支持 Server 和 Agent 端的日志记录
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.claude-web-logs');
let logFile = null;
let initialized = false;

function init(role = 'agent') {
  if (initialized) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString().slice(0, 10);
    logFile = path.join(LOG_DIR, `${role}-${timestamp}.log`);
    initialized = true;
  } catch (err) {
    console.error('❌ 日志初始化失败:', err.message);
  }
}

function log(level, message, data = null) {
  if (!initialized) init();
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${level}] ${message}`;
  if (data) {
    line += ` | ${JSON.stringify(data)}`;
  }
  line += '\n';

  if (logFile) {
    try {
      fs.appendFileSync(logFile, line, 'utf-8');
    } catch (err) {
      console.error('⚠️  日志写入失败:', err.message);
    }
  }
  console.log(line.trim());
}

module.exports = {
  init,
  debug: (msg, data) => log('DEBUG', msg, data),
  info: (msg, data) => log('INFO', msg, data),
  warn: (msg, data) => log('WARN', msg, data),
  error: (msg, data) => log('ERROR', msg, data),
  heartbeat: (msg, data) => log('HEARTBEAT', msg, data),
  connection: (msg, data) => log('CONNECTION', msg, data),
};
