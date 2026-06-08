/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 会话管理器
 * 管理所有终端会话的生命周期，并把每个会话绑定到一个独立的工作目录。
 *
 *   Map<sessionId, Session>
 *
 * 安全边界：所有会话工作目录都被强制限制在 WORKSPACE_ROOT 之下，
 * 会话标题经过清洗以防止路径穿越（`../`、绝对路径等）。
 * ═══════════════════════════════════════════════════════════════
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createTerminal } = require('./terminal');

const sessions = new Map(); // sessionId -> Session

let WORKSPACE_ROOT = path.join(os.homedir(), 'WebClaudeWorkspaces');

/** 设置工作区根目录（由 config 决定，启动时调用一次） */
function setWorkspaceRoot(root) {
  if (root && typeof root === 'string') {
    WORKSPACE_ROOT = path.resolve(root.replace(/^~(?=$|\/)/, os.homedir()));
  }
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  return WORKSPACE_ROOT;
}

/**
 * 把任意标题清洗成安全的目录名（防止路径穿越）。
 * 仅保留字母、数字、中文、`-`、`_`、`.`、空格，并去掉首尾的点/空格。
 */
function safeDirName(title) {
  const cleaned = String(title || '')
    .replace(/[\\/]+/g, '-')          // 斜杠 → 连字符
    .replace(/\.{2,}/g, '.')          // 折叠多个点，杀掉 ..
    .replace(/[^\w一-龥.\- ]/g, '') // 仅允许安全字符
    .replace(/^[.\s]+|[.\s]+$/g, '')  // 去掉首尾点/空格
    .trim();
  return cleaned || 'session';
}

/**
 * 为会话解析工作目录，并确保它严格位于 WORKSPACE_ROOT 之内。
 * 若发生冲突则追加短 id 后缀。
 */
function resolveWorkspaceDir(sessionId, title) {
  const base = safeDirName(title);
  let dir = path.join(WORKSPACE_ROOT, base);

  // 二次校验：解析后必须仍在根目录内
  const rel = path.relative(WORKSPACE_ROOT, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    dir = path.join(WORKSPACE_ROOT, sessionId.slice(0, 8));
  }

  // 目录名冲突 → 追加 sessionId 短前缀
  if (fs.existsSync(dir)) {
    const owner = [...sessions.values()].find((s) => s.cwd === dir);
    if (!owner || owner.id !== sessionId) {
      dir = `${dir}-${sessionId.slice(0, 6)}`;
    }
  }
  return dir;
}

/**
 * 创建一个新的终端会话（含独立工作目录）。
 * @returns {Session}
 */
function createSession(sessionId, title, callbacks = {}) {
  const { onData, onExit } = callbacks;

  if (sessions.has(sessionId)) {
    destroySession(sessionId);
  }

  const cwd = resolveWorkspaceDir(sessionId, title);
  fs.mkdirSync(cwd, { recursive: true });

  const terminal = createTerminal({
    sessionId,
    cwd,
    onData: (data) => onData && onData(sessionId, data),
    onExit: (evt) => {
      const s = sessions.get(sessionId);
      if (s) s.status = 'exited';
      onExit && onExit(sessionId, evt);
    },
  });

  const session = {
    id: sessionId,
    title: title || safeDirName(title),
    cwd,
    pid: terminal.pid,
    status: 'running',
    terminal,
    createdAt: Date.now(),
  };

  sessions.set(sessionId, session);
  console.log(`✅ 会话已创建: ${session.title} (${sessionId.slice(0, 8)})`);
  return session;
}

/** 销毁会话进程（不删目录） */
function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  console.log(`🗑  销毁会话: ${session.title} (${sessionId.slice(0, 8)})`);
  if (session.terminal) {
    session.terminal.kill('SIGTERM');
    const term = session.terminal;
    setTimeout(() => term.kill('SIGKILL'), 3000);
  }
  sessions.delete(sessionId);
  return true;
}

/**
 * 删除会话，并按策略处理工作目录。
 * @param {boolean} deleteFiles 是否连同工作目录一起删除
 */
function deleteSession(sessionId, deleteFiles) {
  const session = sessions.get(sessionId);
  const cwd = session ? session.cwd : null;
  destroySession(sessionId);

  if (deleteFiles && cwd) {
    // 安全护栏：只允许删除 WORKSPACE_ROOT 之内的目录
    const rel = path.relative(WORKSPACE_ROOT, cwd);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
        console.log(`🧹 工作目录已删除: ${cwd}`);
      } catch (err) {
        console.error(`❌ 删除目录失败 [${cwd}]: ${err.message}`);
      }
    } else {
      console.warn(`⚠  拒绝删除越界目录: ${cwd}`);
    }
  } else if (cwd) {
    console.log(`📁 工作目录已保留: ${cwd}`);
  }
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

/** 返回可序列化的会话列表（不含 terminal 对象） */
function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    pid: s.pid,
    status: s.status,
    createdAt: s.createdAt,
  }));
}

function destroyAllSessions() {
  for (const id of [...sessions.keys()]) destroySession(id);
}

module.exports = {
  setWorkspaceRoot,
  createSession,
  destroySession,
  deleteSession,
  getSession,
  listSessions,
  destroyAllSessions,
  get WORKSPACE_ROOT() {
    return WORKSPACE_ROOT;
  },
};
