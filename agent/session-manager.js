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
const {
  createTerminal,
  killTmuxSession,
  listTmuxSessions,
  sessionIdFromTmuxName,
  getTmuxTitle,
} = require('./terminal');

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
    title,
    onData: (data) => onData && onData(sessionId, data),
    onExit: (evt) => {
      // sessionAlive=true：仅 tmux 客户端 detach（Agent 重启），会话未死，不做处理
      if (evt && evt.sessionAlive) return;
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
  saveSessionMetadata(session);  // 保存元数据供恢复使用
  console.log(`✅ 会话已创建: ${session.title} (${sessionId.slice(0, 8)})`);
  return session;
}

/**
 * 断开会话的 tmux 客户端（detach）——**不销毁 tmux 会话**。
 * 会话内的 shell + claude + 运行中的进程 + 滚屏都在 tmux 服务器里继续存活，
 * 供 Agent 重启后 recoverSessions() 重新发现并 re-attach。
 * 用于 Agent 优雅关闭 / 会话去重，绝不用于用户显式删除。
 */
function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  console.log(`🔌 detach 会话客户端（tmux 会话保留）: ${session.title} (${sessionId.slice(0, 8)})`);
  if (session.terminal) session.terminal.detach('SIGTERM');
  sessions.delete(sessionId);
  return true;
}

/**
 * 用户显式删除会话 → **真正销毁 tmux 会话**（连同内部 shell / claude / 进程）。
 * @param {boolean} deleteFiles 已废弃——会话不再绑定独立目录，此参数无效果
 */
function deleteSession(sessionId, deleteFiles) {
  const session = sessions.get(sessionId);

  killTmuxSession(sessionId);                       // 杀掉 tmux 会话本体
  if (session && session.terminal) session.terminal.detach('SIGTERM'); // 断开本地客户端
  sessions.delete(sessionId);
  console.log(`🗑  已删除会话: ${session?.title || sessionId.slice(0, 8)} (${sessionId.slice(0, 8)})`);

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

/**
 * Agent 关闭时调用：detach 所有会话的客户端。
 * **关键：tmux 会话全部存活**，下次 Agent 启动 recoverSessions() 即可恢复。
 * 这就是「重启 Agent 不再杀掉 claude / 运行中进程」的根源。
 */
function destroyAllSessions() {
  for (const id of [...sessions.keys()]) destroySession(id);
}

/**
 * 保存会话元数据到工作目录的 .session.json
 * （用于恢复：Agent 重启后可读取恢复 sessionId）
 */
function saveSessionMetadata(session) {
  try {
    const meta = {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.createdAt,
      savedAt: Date.now(),
    };
    const metaPath = path.join(session.cwd, '.session.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`⚠️  保存会话元数据失败 [${session.cwd}]: ${err.message}`);
  }
}

/**
 * 枚举独立 socket 上存活的 tmux 会话，恢复为内存记录（status='recovered'）。
 * 此时**不**创建本地 tmux 客户端——待浏览器 create/input/resize 触达时惰性 re-attach。
 * 返回已恢复的会话列表。
 */
function recoverSessions() {
  const recovered = [];
  try {
    for (const name of listTmuxSessions()) {
      const sessionId = sessionIdFromTmuxName(name);
      if (!sessionId || sessions.has(sessionId)) continue;

      const session = {
        id: sessionId,
        title: getTmuxTitle(sessionId) || '已恢复会话',
        cwd: WORKSPACE_ROOT,
        pid: null,
        status: 'recovered',
        terminal: null,
        createdAt: Date.now(),
      };

      sessions.set(sessionId, session);
      recovered.push(session);
      console.log(`♻️  发现存活 tmux 会话: ${session.title} (${sessionId.slice(0, 8)})`);
    }
  } catch (err) {
    console.error(`❌ 枚举 tmux 会话失败: ${err.message}`);
  }
  return recovered;
}

module.exports = {
  setWorkspaceRoot,
  createSession,
  destroySession,
  deleteSession,
  getSession,
  listSessions,
  destroyAllSessions,
  recoverSessions,
  saveSessionMetadata,
  get WORKSPACE_ROOT() {
    return WORKSPACE_ROOT;
  },
};
