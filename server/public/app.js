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
  sessions: [],          // [{ id, title, cwd, pid, status, createdAt }]
  activeId: null,
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
const deleteFilesCheckbox = $('delete-files-checkbox');

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
      STATE.sessions = data.sessions || [];
      showMain();
      renderSessionList();
      updateAgentStatus();
      // 重连：对所有已存在的终端重新 attach（重置 + 回放，避免漏输出/重复）
      resyncTerminals();
      // 自动选中上次会话或第一个
      restoreActive();
      break;

    case 'error':
      if (!STATE.authenticated) showLoginError(data.message || '认证失败');
      break;

    case 'agent_status':
      STATE.agentOnline = data.online;
      updateAgentStatus();
      break;

    case 'sessions':
      STATE.sessions = data.sessions || [];
      renderSessionList();
      reconcileTerminals();
      updateActiveHeader();
      break;

    case 'terminal_created':
      upsertSession({ id: data.sessionId, title: data.title, cwd: data.cwd, pid: data.pid, status: data.status });
      renderSessionList();
      selectSession(data.sessionId);
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

  emptyHint.style.display = 'none';
  for (const [id, t] of terminals) {
    t.container.style.display = id === sessionId ? 'block' : 'none';
  }
  const entry = ensureTerminal(sessionId);
  entry.container.style.display = 'block';

  // 让 xterm 适配容器并上报尺寸
  requestAnimationFrame(() => {
    try {
      entry.fit.fit();
      sendWS({ type: 'terminal_resize', sessionId, cols: entry.term.cols, rows: entry.term.rows });
      entry.term.focus();
    } catch {}
  });

  renderSessionList();
  updateActiveHeader();
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
  const title = (prompt('会话名称（将作为工作目录名）：', '会话-' + new Date().toLocaleTimeString().replace(/:/g, ''))) || '新会话';
  const id = uuid();
  sendWS({ type: 'terminal_create', sessionId: id, title });
}

function openDeleteModal() {
  if (!STATE.activeId) return;
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  deleteModalText.textContent = `确认删除会话「${s ? s.title : ''}」？`;
  deleteFilesCheckbox.checked = false;
  deleteModal.classList.remove('hidden');
}
function confirmDelete() {
  const id = STATE.activeId;
  if (!id) return;
  sendWS({ type: 'terminal_delete', sessionId: id, deleteFiles: deleteFilesCheckbox.checked });
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
  if (STATE.agentOnline) {
    agentStatus.className = 'status-dot online';
    agentLabel.textContent = 'Agent 在线';
  } else {
    agentStatus.className = 'status-dot offline';
    agentLabel.textContent = 'Agent 离线';
  }
  newSessionBtn.disabled = !STATE.agentOnline;
}

function statusText(s) {
  return { running: '运行中', exited: '已退出', disconnected: '断开' }[s] || s || '';
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
deleteBtn.addEventListener('click', openDeleteModal);
$('delete-cancel').addEventListener('click', () => deleteModal.classList.add('hidden'));
$('delete-confirm').addEventListener('click', confirmDelete);

// 窗口缩放时重新 fit 当前终端
window.addEventListener('resize', () => {
  const t = terminals.get(STATE.activeId);
  if (t && t.container.style.display !== 'none') {
    try {
      t.fit.fit();
      sendWS({ type: 'terminal_resize', sessionId: STATE.activeId, cols: t.term.cols, rows: t.term.rows });
    } catch {}
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
