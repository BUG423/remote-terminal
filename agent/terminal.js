/**
 * ═══════════════════════════════════════════════════════════════
 * Claude Web — 终端封装 (node-pty)
 * 创建一个绑定到指定工作目录的伪终端，提供交互式 shell。
 * ═══════════════════════════════════════════════════════════════
 */

const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * 创建一个伪终端。
 *
 * @param {object}   options
 * @param {string}   options.sessionId  会话 ID
 * @param {string}   options.cwd        工作目录（须已存在）
 * @param {number}   [options.cols=120]
 * @param {number}   [options.rows=30]
 * @param {function} options.onData     输出回调 (data:string)=>void
 * @param {function} options.onExit     退出回调 ({exitCode,signal})=>void
 * @returns {object} 终端控制对象
 */
function createTerminal({ sessionId, cwd, cols = 120, rows = 30, onData, onExit }) {
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }

  const shell =
    process.env.SHELL ||
    (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
  const isPosixShell = shell.endsWith('bash') || shell.endsWith('zsh') || shell.endsWith('sh');
  const shellArgs = isPosixShell ? ['-i'] : [];

  const ptyProcess = pty.spawn(shell, shellArgs, {
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

  console.log(
    `🖥  终端已创建: ${sessionId.slice(0, 8)} (pid=${ptyProcess.pid}, shell=${path.basename(shell)}, cwd=${cwd})`
  );

  ptyProcess.onData((data) => {
    if (onData) onData(data);
  });

  ptyProcess.onExit((evt) => {
    console.log(`🛑 终端退出: ${sessionId.slice(0, 8)} (code=${evt.exitCode}, signal=${evt.signal})`);
    if (onExit) onExit(evt);
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
    kill(signal = 'SIGTERM') {
      try {
        ptyProcess.kill(signal);
      } catch { /* 进程可能已退出 */ }
    },
    get pid() {
      return ptyProcess.pid;
    },
  };
}

module.exports = { createTerminal };
