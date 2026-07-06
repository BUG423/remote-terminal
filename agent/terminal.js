/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 终端封装 (node-pty + tmux)
 *
 * 每个会话对应一个 tmux 会话（跑在独立 socket `claude-web` 的 tmux 服务器里）。
 * node-pty 拉起的只是一个 tmux 客户端：
 *   - Agent 重启 / 崩溃 → 只是客户端断开（detach），tmux 会话（shell+claude+
 *     运行中的进程+滚屏）在 tmux 服务器里继续存活；
 *   - 新 Agent re-attach（new-session -A）即恢复 live 会话，零丢失。
 *
 * 与旧实现的语义差异：
 *   - kill() / detach()：只杀 tmux 客户端 = detach，会话保留（供恢复）。
 *   - 真正销毁会话请用 killTmuxSession()（用户显式删除时）。
 *   - onExit：客户端退出时触发，可能是 detach（会话仍在）或真正退出（会话已没）。
 *     调用方需用 tmuxSessionExists() 区分。
 * ═══════════════════════════════════════════════════════════════
 */

const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// 独立 socket + 独立配置，与用户自己的 tmux 完全隔离
const TMUX_SOCKET = 'claude-web';
const TMUX_CONF = path.join(__dirname, 'tmux.conf');

/** tmux 会话名：cw_<sessionId>。tmux 名不能含 . 或 :；UUID 只含 [0-9a-f-]，
 *  故加前缀即可与 sessionId 一一互转。其余非法字符做保底替换。 */
function tmuxName(sessionId) {
  return 'cw_' + String(sessionId).replace(/[.:\s]/g, '_');
}
function sessionIdFromTmuxName(name) {
  return name && name.startsWith('cw_') ? name.slice(3) : null;
}

/** 固定 socket + 配置文件的 tmux 参数前缀 */
function tmuxArgs(...rest) {
  return ['-L', TMUX_SOCKET, '-f', TMUX_CONF, ...rest];
}

/** 同步执行一条 tmux 命令，出错抛异常；stdout 以字符串返回 */
function tmuxExec(...args) {
  return execFileSync('tmux', tmuxArgs(...args), {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** 列出所有 cw_* tmux 会话名（无 server 运行时返回 []） */
function listTmuxSessions() {
  try {
    return tmuxExec('list-sessions', '-F', '#{session_name}')
      .split('\n').map((s) => s.trim())
      .filter((s) => s.startsWith('cw_'));
  } catch {
    return []; // "no server running on ..." 等
  }
}

/** 指定会话的 tmux 会话是否存在 */
function tmuxSessionExists(sessionId) {
  try {
    execFileSync('tmux', tmuxArgs('has-session', '-t', tmuxName(sessionId)), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 读取存活会话的当前窗口尺寸（用于恢复时按原尺寸 attach，避免 claude TUI 重排） */
function tmuxSessionSize(sessionId) {
  try {
    const out = tmuxExec('display-message', '-p', '-t', tmuxName(sessionId), '#{window_width}x#{window_height}').trim();
    const m = out.match(/^(\d+)x(\d+)$/);
    if (m) return { cols: Number(m[1]), rows: Number(m[2]) };
  } catch { /* ignore */ }
  return null;
}

/** 真正销毁 tmux 会话（用户显式删除时用；Agent 重启绝不调用） */
function killTmuxSession(sessionId) {
  try {
    execFileSync('tmux', tmuxArgs('kill-session', '-t', tmuxName(sessionId)), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 会话标题持久化（tmux 用户选项 @cw_title，随会话存活跨 Agent 重启） */
function setTmuxTitle(sessionId, title) {
  try {
    execFileSync('tmux', tmuxArgs('set-option', '-t', tmuxName(sessionId), '@cw_title', String(title || '')), { stdio: 'ignore' });
  } catch { /* ignore */ }
}
function getTmuxTitle(sessionId) {
  try {
    return tmuxExec('show-options', '-v', '-t', tmuxName(sessionId), '@cw_title').trim();
  } catch {
    return '';
  }
}

/**
 * 创建（或 attach 到）一个 tmux 会话，并返回终端控制对象。
 *
 * @param {object}   options
 * @param {string}   options.sessionId
 * @param {string}   options.cwd        新建会话的起始目录（attach 已有会话时忽略）
 * @param {number}   [options.cols=120]
 * @param {number}   [options.rows=30]
 * @param {string}   [options.title]    新建会话时写入 @cw_title
 * @param {function} options.onData     输出回调 (data:string)=>void
 * @param {function} options.onExit     客户端退出回调 ({exitCode,signal})=>void
 * @returns {object} 终端控制对象 { write, resize, detach, kill, pid, tmuxName }
 */
function createTerminal({ sessionId, cwd, cols = 120, rows = 30, title, onData, onExit }) {
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

  const name = tmuxName(sessionId);
  const preexisting = tmuxSessionExists(sessionId);

  // 恢复已有会话时按其当前尺寸 attach，避免触发 SIGWINCH 重排
  if (preexisting) {
    const sz = tmuxSessionSize(sessionId);
    if (sz) { cols = sz.cols; rows = sz.rows; }
  }

  // 新建会话时用交互式 shell（bash -i），与旧实现完全一致，
  // 保证加载用户 .bashrc（alias / PATH / 环境）。attach 已有会话时 tmux 会忽略此命令。
  const shell = process.env.SHELL ||
    (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
  const isPosixShell = /(?:bash|zsh|sh)$/.test(shell);
  const shellArgv = isPosixShell ? [shell, '-i'] : [shell];

  // new-session -A：存在则 attach，不存在则以 -c cwd 新建并运行 shellArgv。幂等，正是恢复所需。
  const args = tmuxArgs('new-session', '-A', '-s', name, '-c', cwd, ...shellArgv);

  const ptyProcess = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      WEB_CLAUDE_SESSION: sessionId,
    },
  });

  if (!preexisting && title) setTmuxTitle(sessionId, title);

  console.log(
    `🖥  终端${preexisting ? '已附着(恢复)' : '已创建'}: ${sessionId.slice(0, 8)} ` +
    `(client pid=${ptyProcess.pid}, tmux=${name}, ${cols}x${rows}, cwd=${cwd})`
  );

  ptyProcess.onData((data) => {
    if (onData) onData(data);
  });

  ptyProcess.onExit((evt) => {
    const alive = tmuxSessionExists(sessionId);
    console.log(
      `🛑 tmux 客户端退出: ${sessionId.slice(0, 8)} ` +
      `(code=${evt.exitCode}, signal=${evt.signal}, 会话仍存活=${alive})`
    );
    // alive=true → 只是 detach（Agent 重启），会话未死；调用方应据此不发 terminal_exit
    if (onExit) onExit({ ...evt, sessionAlive: alive });
  });

  return {
    write(data) {
      try {
        ptyProcess.write(data);
      } catch (err) {
        console.error(`❌ 终端写入失败 [${sessionId.slice(0, 8)}]: ${err.message}`);
      }
    },
    resize(c, r) {
      try {
        if (c > 0 && r > 0) ptyProcess.resize(c, r);
      } catch (err) {
        console.error(`❌ 终端 resize 失败 [${sessionId.slice(0, 8)}]: ${err.message}`);
      }
    },
    // detach()：只杀 tmux 客户端，会话保留（供 Agent 重启后恢复）
    detach(signal = 'SIGTERM') {
      try { ptyProcess.kill(signal); } catch { /* 客户端可能已退出 */ }
    },
    // kill()：兼容旧接口，语义 = detach（不销毁 tmux 会话）
    kill(signal = 'SIGTERM') {
      try { ptyProcess.kill(signal); } catch { /* 客户端可能已退出 */ }
    },
    get pid() {
      return ptyProcess.pid;
    },
    get tmuxName() {
      return name;
    },
  };
}

module.exports = {
  createTerminal,
  killTmuxSession,
  listTmuxSessions,
  tmuxSessionExists,
  tmuxSessionSize,
  sessionIdFromTmuxName,
  getTmuxTitle,
  setTmuxTitle,
  tmuxName,
};
