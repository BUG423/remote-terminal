/* ═══════════════════════════════════════════════════════════════
   Claude Web Terminal — 前端
   连接服务器，管理多会话，把每个会话渲染成一个 xterm 终端。
   ═══════════════════════════════════════════════════════════════ */

// ── 状态 ───────────────────────────────────────────────────────
const STATE = {
  ws: null,
  clientId: null,
  authenticated: false,
  agentOnline: false,
  agentName: '',          // 当前连接的 Agent 名称
  sessions: [],           // [{ id, title, cwd, pid, status, createdAt }]
  activeId: null,
  splitMode: false,       // 分屏模式：同时显示多个终端
  reconnectAttempts: 0,
  maxReconnect: 10,
};

// sessionId -> { term, fit, container, attached }
const terminals = new Map();

// ── DOM ────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const loginScreen = $('login-screen');
const mainScreen = $('main-screen');
const loginForm = $('login-form');
const tokenInput = $('token-input');
const loginBtn = $('login-btn');
const loginError = $('login-error');
const sessionListEl = $('session-list');
const newSessionBtn = $('new-session-btn');
const agentStatus = $('agent-status');
const agentLabel = $('agent-label');
const terminalsEl = $('terminals');
const emptyHint = $('empty-hint');
const activeTitle = $('active-title');
const activeCwd = $('active-cwd');
const activeStatus = $('active-status');
const deleteBtn = $('delete-session-btn');
const deleteModal = $('delete-modal');
const deleteModalText = $('delete-modal-text');
const tileViewBtn = $('tile-view-btn');

// ── 工具 ───────────────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}
const getToken = () => sessionStorage.getItem('claude-web-token') || '';
const saveToken = (t) => sessionStorage.setItem('claude-web-token', t);

function sendWS(obj) {
  if (STATE.ws && STATE.ws.readyState === 1) {
    STATE.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// ── WebSocket ──────────────────────────────────────────────────
function connect() {
  const token = getToken();
  if (!token) return showLogin();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  STATE.ws = ws;

  ws.onopen = () => {
    STATE.reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'auth', token: getToken(), role: 'browser' }));
  };
  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleMessage(data);
  };
  ws.onclose = () => {
    STATE.authenticated = false;
    STATE.agentOnline = false;
    updateAgentStatus();
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  if (STATE.reconnectAttempts >= STATE.maxReconnect) return;
  const delay = Math.min(1000 * Math.pow(2, STATE.reconnectAttempts), 30000);
  STATE.reconnectAttempts++;
  setTimeout(connect, delay);
}

// ── 消息分发 ───────────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      STATE.authenticated = true;
      STATE.clientId = data.clientId;
      STATE.agentOnline = data.agentOnline;
      STATE.agentName = data.agentName || '';
      STATE.sessions = data.sessions || [];
      showMain();
      renderSessionList();
      updateAgentStatus();
      // 重连：对所有已存在的终端重新 attach
      resyncTerminals();
      restoreActive();
      break;

    case 'error':
      if (!STATE.authenticated) showLoginError(data.message || '认证失败');
      break;

    case 'agent_status':
      STATE.agentOnline = data.online;
      if (data.agentName) STATE.agentName = data.agentName;
      updateAgentStatus();
      if (!data.online) {
        // Agent 离线：立即把所有会话标记为 disconnected，然后清理
        for (const s of STATE.sessions) s.status = 'disconnected';
        cleanDisconnectedSessions();
      }
      break;

    case 'sessions':
      STATE.sessions = data.sessions || [];
      // Agent 离线时清理所有 disconnected 会话（不要求全部都是 disconnected）
      if (!STATE.agentOnline) {
        cleanDisconnectedSessions();
      }
      renderSessionList();
      reconcileTerminals();
      updateActiveHeader();
      if (STATE.splitMode) refreshTileView();
      break;

    case 'terminal_created':
      upsertSession({ id: data.sessionId, title: data.title, cwd: data.cwd, pid: data.pid, status: data.status });
      renderSessionList();
      selectSession(data.sessionId);
      if (STATE.splitMode) refreshTileView();
      break;

    case 'terminal_output':
      writeOutput(data.sessionId, data.data, data.replay);
      break;

    // attach 完成：标记可接收实时输出（无历史回放时也能正常渲染）
    case 'terminal_attached': {
      const t = terminals.get(data.sessionId);
      if (t) t.attached = true;
      break;
    }

    case 'terminal_exit':
      markStatus(data.sessionId, 'exited');
      writeOutput(data.sessionId, `\r\n\x1b[33m[进程退出 code=${data.exitCode}]\x1b[0m\r\n`);
      break;

    case 'terminal_closed':
      removeSession(data.sessionId);
      if (STATE.splitMode) refreshTileView();
      break;

    case 'terminal_error':
      if (data.sessionId && terminals.has(data.sessionId)) {
        writeOutput(data.sessionId, `\r\n\x1b[31m[错误] ${data.message}\x1b[0m\r\n`);
      } else {
        alert('❌ ' + (data.message || '操作失败'));
      }
      break;
  }
}

// ── 会话数据 ───────────────────────────────────────────────────
function upsertSession(s) {
  const i = STATE.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) STATE.sessions[i] = { ...STATE.sessions[i], ...s };
  else STATE.sessions.push(s);
}
function markStatus(id, status) {
  const s = STATE.sessions.find((x) => x.id === id);
  if (s) s.status = status;
  renderSessionList();
  if (id === STATE.activeId) updateActiveHeader();
}
function removeSession(id) {
  STATE.sessions = STATE.sessions.filter((x) => x.id !== id);
  const t = terminals.get(id);
  if (t) { t.term.dispose(); t.container.remove(); terminals.delete(id); }
  renderSessionList();
  if (STATE.activeId === id) {
    STATE.activeId = null;
    const next = STATE.sessions[0];
    if (next) selectSession(next.id);
    else updateActiveHeader();
  }
}

/** 清理所有 disconnected / recovered 等异常状态的会话 */
const STALE_STATUSES = new Set(['disconnected', 'recovered']);

function cleanDisconnectedSessions() {
  const staleIds = new Set(
    STATE.sessions.filter(s => STALE_STATUSES.has(s.status)).map(s => s.id)
  );
  if (staleIds.size === 0) return;
  // 销毁对应的终端实例和 DOM
  for (const id of staleIds) {
    const t = terminals.get(id);
    if (t) { t.term.dispose(); t.container.remove(); terminals.delete(id); }
  }
  // 从会话列表中移除
  STATE.sessions = STATE.sessions.filter(s => !staleIds.has(s.id));
  // 如果当前选中的是被清理的会话，切换到下一个
  if (STATE.activeId && staleIds.has(STATE.activeId)) {
    STATE.activeId = null;
    localStorage.removeItem('claude-web-active');
    const next = STATE.sessions.find(s => s.status === 'running');
    if (next) selectSession(next.id);
    else updateActiveHeader();
  }
  renderSessionList();
}

// 服务器会话列表变化时，丢弃本地已不存在的终端
function reconcileTerminals() {
  const ids = new Set(STATE.sessions.map((s) => s.id));
  for (const [id, t] of terminals) {
    if (!ids.has(id)) { t.term.dispose(); t.container.remove(); terminals.delete(id); }
  }
}

// ── 终端实例 ───────────────────────────────────────────────────
function ensureTerminal(sessionId) {
  if (terminals.has(sessionId)) return terminals.get(sessionId);

  const container = document.createElement('div');
  container.className = 'term-container';
  container.style.display = 'none';
  terminalsEl.appendChild(container);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: { background: '#0d1117', foreground: '#e6edf3' },
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // 键入 → 发送到 Agent
  term.onData((d) => sendWS({ type: 'terminal_input', sessionId, data: d }));

  // Ctrl+V / Cmd+V: 拦截浏览器默认粘贴行为。
  // 浏览器默认 Ctrl+V 会尝试粘贴富文本/图片（剪贴板里有啥就塞啥），
  // 导致终端里出现乱码或图片路径。这里改为读取纯文本再发送。
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
      // 如果用户明确按了 Ctrl+Shift+V，走浏览器原生纯文本粘贴（更可靠）
      if (e.shiftKey) return true;
      navigator.clipboard.readText().then((text) => {
        if (text) sendWS({ type: 'terminal_input', sessionId, data: text });
      }).catch(() => {
        // clipboard API 不可用（如 HTTP 环境），静默回退
      });
      return false; // 阻止浏览器默认的富文本粘贴
    }
    return true;
  });

  const entry = { term, fit, container, attached: false };
  terminals.set(sessionId, entry);

  // 请求历史回放
  sendWS({ type: 'terminal_attach', sessionId });
  return entry;
}

function writeOutput(sessionId, data, replay) {
  const t = ensureTerminal(sessionId);
  if (replay) {
    t.term.reset();
    t.term.write(data);
    t.attached = true;
  } else if (t.attached) {
    t.term.write(data);
  }
  // 未 attached 的实时输出忽略——它会包含在 replay 快照中，避免重复
}

// 重连后：对所有已存在的终端重新请求历史回放，重置 attached 状态以重新同步
function resyncTerminals() {
  for (const [id, t] of terminals) {
    t.attached = false;
    sendWS({ type: 'terminal_attach', sessionId: id });
  }
}

// ── 选择 / 切换会话 ────────────────────────────────────────────
function selectSession(sessionId) {
  if (!STATE.sessions.find((s) => s.id === sessionId)) return;
  STATE.activeId = sessionId;
  localStorage.setItem('claude-web-active', sessionId);

  if (STATE.splitMode) {
    // 分屏模式：所有终端保持可见，仅高亮选中
    refreshTileView();
    const entry = terminals.get(sessionId);
    if (entry) entry.term.focus();
  } else {
    // 单屏模式：只显示当前终端
    emptyHint.style.display = 'none';
    for (const [id, t] of terminals) {
      t.container.style.display = id === sessionId ? 'block' : 'none';
    }
    const entry = ensureTerminal(sessionId);
    entry.container.style.display = 'block';
    requestAnimationFrame(() => {
      try {
        entry.fit.fit();
        sendWS({ type: 'terminal_resize', sessionId, cols: entry.term.cols, rows: entry.term.rows });
        entry.term.focus();
      } catch {}
    });
  }

  renderSessionList();
  updateActiveHeader();
}

// ── 分屏模式 ────────────────────────────────────────────────────
function toggleSplitView() {
  STATE.splitMode = !STATE.splitMode;

  if (STATE.splitMode) {
    // 进入分屏：为所有非退出会话创建终端
    tileViewBtn.classList.add('active');
    tileViewBtn.textContent = '📐 单屏';
    for (const s of STATE.sessions) {
      if (s.status !== 'exited') {
        ensureTerminal(s.id);
      }
    }
    refreshTileView();
  } else {
    // 退出分屏：恢复单屏
    tileViewBtn.classList.remove('active');
    tileViewBtn.textContent = '📐 分屏';
    terminalsEl.classList.remove('tiled');
    // 隐藏所有终端，重新显示当前选中的
    for (const [id, t] of terminals) {
      t.container.style.display = 'none';
      t.container.style.border = '';
    }
    emptyHint.style.display = 'none';
    if (STATE.activeId) {
      selectSession(STATE.activeId);
    }
  }
}

function refreshTileView() {
  if (!STATE.splitMode) return;

  // 显示所有会话（排除已退出的）
  const visibleSessions = STATE.sessions.filter(
    (s) => s.status !== 'exited'
  );

  if (visibleSessions.length === 0) {
    terminalsEl.classList.remove('tiled');
    emptyHint.style.display = '';
    return;
  }

  terminalsEl.classList.add('tiled');
  emptyHint.style.display = 'none';

  // 动态列数：1个/2个=1列，3-4个=2列，5+个=3列
  let cols = 1;
  if (visibleSessions.length >= 5) cols = 3;
  else if (visibleSessions.length >= 3) cols = 2;
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  // 先为所有可见会话创建终端（如尚未创建）
  for (const s of visibleSessions) {
    ensureTerminal(s.id);
  }

  // 显示/隐藏对应的终端容器
  for (const [id, t] of terminals) {
    if (visibleSessions.some((s) => s.id === id)) {
      t.container.style.display = 'block';
      t.container.style.border = id === STATE.activeId
        ? '1px solid var(--accent)'
        : '1px solid var(--border)';
    } else {
      t.container.style.display = 'none';
      t.container.style.border = '';
    }
  }

  // 所有终端适配新尺寸
  requestAnimationFrame(() => {
    for (const s of visibleSessions) {
      const entry = terminals.get(s.id);
      if (entry && entry.container.style.display !== 'none') {
        try {
          entry.fit.fit();
          sendWS({ type: 'terminal_resize', sessionId: s.id, cols: entry.term.cols, rows: entry.term.rows });
        } catch {}
      }
    }
  });
}

// 分屏模式下列表点击：选中 + 聚焦
function onSessionClick(sessionId) {
  selectSession(sessionId);
}

function restoreActive() {
  const saved = localStorage.getItem('claude-web-active');
  const target = STATE.sessions.find((s) => s.id === saved) || STATE.sessions[0];
  if (target) selectSession(target.id);
  else updateActiveHeader();
}

// ── 新建 / 删除 ────────────────────────────────────────────────
function newSession() {
  if (!STATE.agentOnline) return alert('⚠ Agent 离线，无法创建会话');
  const now = new Date();
  const title = '会话-' + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
  const id = uuid();
  sendWS({ type: 'terminal_create', sessionId: id, title });
}

function openDeleteModal() {
  if (!STATE.activeId) return;
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  deleteModalText.textContent = `确认删除会话「${s ? s.title : ''}」？终端进程将被终止。`;
  deleteModal.classList.remove('hidden');
}
function confirmDelete() {
  const id = STATE.activeId;
  if (!id) return;
  sendWS({ type: 'terminal_delete', sessionId: id });
  deleteModal.classList.add('hidden');
}

// ── 渲染 ───────────────────────────────────────────────────────
function renderSessionList() {
  sessionListEl.innerHTML = '';
  for (const s of STATE.sessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.id === STATE.activeId ? ' active' : '');
    const dot = s.status === 'running' ? 'ok' : (s.status === 'exited' ? 'warn' : 'off');
    li.innerHTML = `
      <span class="s-dot ${dot}"></span>
      <div class="s-meta">
        <span class="s-title">${escapeHtml(s.title)}</span>
        <span class="s-cwd">${escapeHtml(shortPath(s.cwd))}</span>
      </div>`;
    li.onclick = () => selectSession(s.id);
    sessionListEl.appendChild(li);
  }
}

function updateActiveHeader() {
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  const hasSessions = STATE.sessions.length > 0;
  tileViewBtn.disabled = !hasSessions;
  if (!s) {
    activeTitle.textContent = '未选择会话';
    activeCwd.textContent = '';
    activeStatus.textContent = '';
    activeStatus.className = 'badge';
    deleteBtn.disabled = true;
    if (terminals.size === 0) emptyHint.style.display = '';
    return;
  }
  activeTitle.textContent = s.title;
  activeCwd.textContent = s.cwd || '';
  activeStatus.textContent = statusText(s.status);
  activeStatus.className = 'badge ' + (s.status === 'running' ? 'ok' : 'warn');
  deleteBtn.disabled = false;
}

function updateAgentStatus() {
  const name = STATE.agentName || 'Agent';
  if (STATE.agentOnline) {
    agentStatus.className = 'status-dot online';
    agentLabel.textContent = name + ' 在线';
  } else {
    agentStatus.className = 'status-dot offline';
    agentLabel.textContent = name + ' 离线';
  }
  newSessionBtn.disabled = !STATE.agentOnline;
}

function statusText(s) {
  return { running: '运行中', exited: '已退出', disconnected: '断开', recovered: '残留' }[s] || s || '';
}
function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}
function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : t;
  return d.innerHTML;
}

// ── 屏幕切换 ───────────────────────────────────────────────────
function showLogin() {
  loginScreen.classList.remove('hidden');
  mainScreen.classList.add('hidden');
}
function showMain() {
  loginScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
}
function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
  loginBtn.disabled = false;
}

// ── 事件 ───────────────────────────────────────────────────────
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = tokenInput.value.trim();
  if (!t) return;
  loginBtn.disabled = true;
  loginError.classList.add('hidden');
  saveToken(t);
  connect();
});
newSessionBtn.addEventListener('click', newSession);
tileViewBtn.addEventListener('click', toggleSplitView);
deleteBtn.addEventListener('click', openDeleteModal);
$('delete-cancel').addEventListener('click', () => deleteModal.classList.add('hidden'));
$('delete-confirm').addEventListener('click', confirmDelete);

// 窗口缩放时重新 fit 可见终端
window.addEventListener('resize', () => {
  if (STATE.splitMode) {
    // 分屏模式：所有可见终端都 resize
    for (const [id, t] of terminals) {
      if (t.container.style.display !== 'none') {
        try {
          t.fit.fit();
          sendWS({ type: 'terminal_resize', sessionId: id, cols: t.term.cols, rows: t.term.rows });
        } catch {}
      }
    }
  } else {
    const t = terminals.get(STATE.activeId);
    if (t && t.container.style.display !== 'none') {
      try {
        t.fit.fit();
        sendWS({ type: 'terminal_resize', sessionId: STATE.activeId, cols: t.term.cols, rows: t.term.rows });
      } catch {}
    }
  }
});

// 心跳
setInterval(() => {
  if (STATE.ws && STATE.ws.readyState === 1 && STATE.authenticated) {
    STATE.ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);

// ── 启动 ───────────────────────────────────────────────────────
if (getToken()) connect();
else showLogin();
