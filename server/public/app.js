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
  reconnectEnabled: true,
};

// sessionId -> { term, fit, container, attached, observer, lastActivity }
const terminals = new Map();

// 会话活动计时器：用于定期刷新侧栏活动指示器
let activityTimer = null;
// 活动阈值：3 秒内有输出视为"忙碌"，3~10 秒无输出视为"刚完成"
const ACTIVITY_BUSY_MS = 3000;
const ACTIVITY_DONE_MS = 10000;
// Agent 离线后延迟清理会话的定时器（给 Agent 重连留时间）
let agentOfflineTimer = null;
const AGENT_OFFLINE_CLEANUP_MS = 30000;
// Agent 离线防抖：短暂断连不更新 UI，避免闪烁
let agentOfflineDebounce = null;
const AGENT_OFFLINE_DEBOUNCE_MS = 3000;

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
let connecting = false;

function connect() {
  if (connecting) return; // 防止重连风暴
  const token = getToken();
  if (!token) return showLogin();

  connecting = true;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  STATE.ws = ws;

  ws.onopen = () => {
    connecting = false;
    ws.send(JSON.stringify({ type: 'auth', token: getToken(), role: 'browser' }));
  };
  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleMessage(data);
  };
  ws.onclose = () => {
    connecting = false;
    if (STATE.ws === ws) STATE.ws = null;
    STATE.authenticated = false;
    updateAgentStatus();
    scheduleReconnect();
  };
  ws.onerror = () => { connecting = false; };
}

let reconnectScheduled = false;

function scheduleReconnect() {
  if (reconnectScheduled) return;
  if (!STATE.reconnectEnabled || !getToken()) return;
  reconnectScheduled = true;
  const baseDelay = Math.min(1000 * Math.pow(2, Math.min(STATE.reconnectAttempts, 5)), 30000);
  const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  STATE.reconnectAttempts++;
  setTimeout(() => {
    reconnectScheduled = false;
    connect();
  }, delay);
}

// ── 消息分发 ───────────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      STATE.authenticated = true;
      STATE.reconnectEnabled = true;
      STATE.reconnectAttempts = 0;
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
      if (!STATE.authenticated) {
        STATE.reconnectEnabled = false;
        sessionStorage.removeItem('claude-web-token');
        showLoginError(data.message || '认证失败');
      }
      break;

    case 'agent_status':
      if (!data.online) {
        // Agent 离线：先等 3 秒，确认不是短暂断连再更新 UI
        if (!agentOfflineDebounce) {
          agentOfflineDebounce = setTimeout(() => {
            agentOfflineDebounce = null;
            STATE.agentOnline = false;
            updateAgentStatus();
            for (const s of STATE.sessions) s.status = 'disconnected';
            renderSessionList();
            // 启动延迟清理
            if (!agentOfflineTimer) {
              agentOfflineTimer = setTimeout(() => {
                agentOfflineTimer = null;
                if (!STATE.agentOnline) cleanDisconnectedSessions();
              }, AGENT_OFFLINE_CLEANUP_MS);
            }
          }, AGENT_OFFLINE_DEBOUNCE_MS);
        }
      } else {
        // Agent 上线：取消离线防抖和清理定时器
        if (agentOfflineDebounce) {
          clearTimeout(agentOfflineDebounce);
          agentOfflineDebounce = null;
        }
        if (agentOfflineTimer) {
          clearTimeout(agentOfflineTimer);
          agentOfflineTimer = null;
        }
        STATE.agentOnline = true;
        if (data.agentName) STATE.agentName = data.agentName;
        updateAgentStatus();
      }
      break;

    case 'sessions':
      STATE.sessions = data.sessions || [];
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
  if (t) { disposeTerminal(id); }
  renderSessionList();
  if (STATE.activeId === id) {
    STATE.activeId = null;
    const next = STATE.sessions[0];
    if (next) selectSession(next.id);
    else updateActiveHeader();
  }
}

/** 销毁终端实例（含 ResizeObserver 清理） */
function disposeTerminal(sessionId) {
  const t = terminals.get(sessionId);
  if (!t) return;
  if (t.observer) { t.observer.disconnect(); t.observer = null; }
  try { t.term.dispose(); } catch {}
  try { t.container.remove(); } catch {}
  terminals.delete(sessionId);
}

/** 清理所有 disconnected / recovered 等异常状态的会话 */
const STALE_STATUSES = new Set(['disconnected', 'recovered']);

function cleanDisconnectedSessions() {
  const staleIds = new Set(
    STATE.sessions.filter(s => STALE_STATUSES.has(s.status)).map(s => s.id)
  );
  if (staleIds.size === 0) return;
  for (const id of staleIds) {
    disposeTerminal(id);
  }
  STATE.sessions = STATE.sessions.filter(s => !staleIds.has(s.id));
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
  for (const [id] of terminals) {
    if (!ids.has(id)) disposeTerminal(id);
  }
}

// ── 终端实例 ───────────────────────────────────────────────────
function ensureTerminal(sessionId) {
  if (terminals.has(sessionId)) return terminals.get(sessionId);

  const container = document.createElement('div');
  container.className = 'term-container';
  // 先不隐藏，让 xterm 在可见容器中初始化以获得正确尺寸
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

  // Ctrl+V / Cmd+V: 拦截浏览器默认粘贴，改为读取纯文本
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
      if (e.shiftKey) return true;
      navigator.clipboard.readText().then((text) => {
        if (text) sendWS({ type: 'terminal_input', sessionId, data: text });
      }).catch(() => {});
      return false;
    }
    return true;
  });

  // ResizeObserver：容器尺寸变化时自动 fit，解决终端不铺满问题
  const observer = new ResizeObserver(() => {
    const t = terminals.get(sessionId);
    if (!t || t.container.style.display === 'none') return;
    try {
      // 延迟一帧确保布局完成
      requestAnimationFrame(() => {
        try {
          t.fit.fit();
          sendWS({ type: 'terminal_resize', sessionId, cols: t.term.cols, rows: t.term.rows });
        } catch {}
      });
    } catch {}
  });
  observer.observe(container);

  const entry = { term, fit, container, attached: false, observer, lastActivity: 0 };
  terminals.set(sessionId, entry);

  // 请求历史回放
  sendWS({ type: 'terminal_attach', sessionId });
  return entry;
}

function writeOutput(sessionId, data, replay) {
  const t = ensureTerminal(sessionId);
  // 记录活动时间戳
  t.lastActivity = Date.now();

  if (replay) {
    t.term.reset();
    t.term.write(data);
    t.attached = true;
  } else if (t.attached) {
    t.term.write(data);
  }
  // 未 attached 的实时输出忽略——它会包含在 replay 快照中，避免重复
}

// 重连后：对所有已存在的终端重新请求历史回放
function resyncTerminals() {
  for (const [id, t] of terminals) {
    t.attached = false;
    sendWS({ type: 'terminal_attach', sessionId: id });
  }
}

/** 执行终端 fit + resize 通知 */
function fitTerminal(sessionId) {
  const t = terminals.get(sessionId);
  if (!t || t.container.style.display === 'none') return;
  try {
    t.fit.fit();
    sendWS({ type: 'terminal_resize', sessionId, cols: t.term.cols, rows: t.term.rows });
  } catch {}
}

// ── 选择 / 切换会话 ────────────────────────────────────────────
function selectSession(sessionId) {
  if (!STATE.sessions.find((s) => s.id === sessionId)) return;
  STATE.activeId = sessionId;
  localStorage.setItem('claude-web-active', sessionId);

  if (STATE.splitMode) {
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
    // 双重 rAF 确保 DOM 布局完成后再 fit
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitTerminal(sessionId);
        entry.term.focus();
      });
    });
  }

  renderSessionList();
  updateActiveHeader();
}

// ── 分屏模式 ────────────────────────────────────────────────────
function toggleSplitView() {
  STATE.splitMode = !STATE.splitMode;

  if (STATE.splitMode) {
    tileViewBtn.classList.add('active');
    tileViewBtn.textContent = '📐 单屏';
    for (const s of STATE.sessions) {
      if (s.status !== 'exited') {
        ensureTerminal(s.id);
      }
    }
    refreshTileView();
  } else {
    tileViewBtn.classList.remove('active');
    tileViewBtn.textContent = '📐 分屏';
    terminalsEl.classList.remove('tiled');
    for (const [, t] of terminals) {
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

  let cols = 1;
  if (visibleSessions.length >= 5) cols = 3;
  else if (visibleSessions.length >= 3) cols = 2;
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  for (const s of visibleSessions) {
    ensureTerminal(s.id);
  }

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

  // 延迟 fit 确保 grid 布局完成
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const s of visibleSessions) {
        fitTerminal(s.id);
      }
    });
  });
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

// ── 会话活动状态 ───────────────────────────────────────────────
/** 计算会话的 activity 状态 */
function getActivityState(sessionId) {
  const t = terminals.get(sessionId);
  if (!t || !t.lastActivity) return 'idle';
  const elapsed = Date.now() - t.lastActivity;
  if (elapsed < ACTIVITY_BUSY_MS) return 'busy';
  if (elapsed < ACTIVITY_DONE_MS) return 'done';
  return 'idle';
}

/** 启动 activity 定时刷新（仅更新指示器，不重建 DOM） */
function ensureActivityTimer() {
  if (activityTimer) return;
  activityTimer = setInterval(() => {
    // 只更新活动指示器，不重建整个列表
    for (const s of STATE.sessions) {
      const li = sessionListEl.querySelector(`[data-sid="${CSS.escape(s.id)}"]`);
      if (li) updateSessionItemState(li, s);
    }
  }, 2000);
}

// ── 渲染 ───────────────────────────────────────────────────────
function renderSessionList() {
  sessionListEl.innerHTML = '';
  for (const s of STATE.sessions) {
    sessionListEl.appendChild(buildSessionItem(s));
  }
}

/** 构建单个会话列表项 DOM */
function buildSessionItem(s) {
  const li = document.createElement('li');
  li.className = 'session-item' + (s.id === STATE.activeId ? ' active' : '');
  li.setAttribute('data-sid', s.id);

  const dot = document.createElement('span');
  dot.className = 's-dot off';
  li.appendChild(dot);

  const meta = document.createElement('div');
  meta.className = 's-meta';
  const titleEl = document.createElement('span');
  titleEl.className = 's-title';
  titleEl.textContent = s.title || '';
  meta.appendChild(titleEl);
  const cwdEl = document.createElement('span');
  cwdEl.className = 's-cwd';
  cwdEl.textContent = shortPath(s.cwd);
  meta.appendChild(cwdEl);
  li.appendChild(meta);

  const indicator = document.createElement('span');
  indicator.className = 's-indicator';
  indicator.style.display = 'none';
  li.appendChild(indicator);

  // 设置初始状态
  updateSessionItemState(li, s);

  li.onclick = () => selectSession(s.id);
  return li;
}

/** 更新单个会话项的圆点和指示器状态（不重建 DOM） */
function updateSessionItemState(li, s) {
  const dot = li.querySelector('.s-dot');
  const indicator = li.querySelector('.s-indicator');
  if (!dot || !indicator) return;

  if (s.status === 'running') {
    const act = getActivityState(s.id);
    if (act === 'busy') {
      dot.className = 's-dot busy';
      indicator.style.display = '';
      indicator.className = 's-indicator busy-icon';
      indicator.textContent = '●';
    } else if (act === 'done') {
      dot.className = 's-dot ok';
      indicator.style.display = '';
      indicator.className = 's-indicator done';
      indicator.textContent = '⏺';
    } else {
      dot.className = 's-dot ok';
      indicator.style.display = 'none';
    }
  } else if (s.status === 'exited') {
    dot.className = 's-dot warn';
    indicator.style.display = 'none';
  } else {
    dot.className = 's-dot off';
    indicator.style.display = 'none';
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
  // 启动 activity 刷新定时器
  ensureActivityTimer();
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
  STATE.reconnectEnabled = true;
  STATE.reconnectAttempts = 0;
  saveToken(t);
  connect();
});
newSessionBtn.addEventListener('click', newSession);
tileViewBtn.addEventListener('click', toggleSplitView);
deleteBtn.addEventListener('click', openDeleteModal);
$('delete-cancel').addEventListener('click', () => deleteModal.classList.add('hidden'));
$('delete-confirm').addEventListener('click', confirmDelete);

// 窗口缩放时重新 fit 可见终端（ResizeObserver 已覆盖此场景，此作为兜底）
window.addEventListener('resize', () => {
  if (STATE.splitMode) {
    for (const [id, t] of terminals) {
      if (t.container.style.display !== 'none') fitTerminal(id);
    }
  } else {
    if (STATE.activeId) fitTerminal(STATE.activeId);
  }
});

window.addEventListener('online', () => {
  STATE.reconnectAttempts = 0;
  if (!STATE.ws || STATE.ws.readyState > 1) connect();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && getToken() &&
      (!STATE.ws || STATE.ws.readyState > 1)) {
    connect();
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
