/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 会话管理器
 * 管理所有终端会话的生命周期。
 * 所有会话共享 WORKSPACE_ROOT 作为起始目录，用户可在终端中自行创建文件夹。
 *
 *   Map<sessionId, Session>
 *
 * 安全边界：所有会话起始目录被强制限制在 WORKSPACE_ROOT 之下。
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
 * 创建一个新的终端会话。
 * 所有会话共享同一个工作区根目录（不创建独立子目录），
 * 用户可在终端中自行 mkdir 创建文件夹。
 * @returns {Session}
 */
function createSession(sessionId, title, callbacks = {}) {
  const { onData, onExit } = callbacks;

  if (sessions.has(sessionId)) {
    destroySession(sessionId);
  }

  // 所有会话共用 WORKSPACE_ROOT 作为起始目录，不创建独立子目录
  const cwd = WORKSPACE_ROOT;

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
    title: title || '新会话',
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
 * 删除会话。会话不再拥有独立工作目录，因此 deleteFiles 参数
 * 仅作为保留字段（前端可能仍发送），实际不会删除任何目录。
 * @param {boolean} deleteFiles 已废弃——会话不再绑定独立目录，此参数无效果
 */
function deleteSession(sessionId, deleteFiles) {
  const session = sessions.get(sessionId);
  destroySession(sessionId);

  // 会话不再拥有独立工作目录，永远不删除 WORKSPACE_ROOT
  if (deleteFiles) {
    console.log(`📁 会话无独立目录，跳过删除 (cwd=${session?.cwd || 'unknown'})`);
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
