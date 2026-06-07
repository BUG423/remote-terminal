/* ═══════════════════════════════════════════════════════════════
   Claude Web — Frontend App
   Handles WebSocket connection, chat UI, streaming messages
   ═══════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────
const STATE = {
  ws: null,
  clientId: null,
  sessionId: generateUUID(),
  authenticated: false,
  agentOnline: false,
  streaming: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
};

// ── DOM Elements ───────────────────────────────────────────────
const loginScreen = document.getElementById('login-screen');
const chatScreen = document.getElementById('chat-screen');
const loginForm = document.getElementById('login-form');
const tokenInput = document.getElementById('token-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const messagesContainer = document.getElementById('messages-container');
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const agentStatus = document.getElementById('agent-status');
const agentLabel = document.getElementById('agent-label');
const newSessionBtn = document.getElementById('new-session-btn');

// ── UUID Generator ────────────────────────────────────────────
function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ── Token Management ──────────────────────────────────────────
function getToken() {
  return sessionStorage.getItem('claude-web-token') || '';
}

function saveToken(token) {
  sessionStorage.setItem('claude-web-token', token);
}

// ── WebSocket Connection ──────────────────────────────────────
function connect() {
  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }

  // Build WebSocket URL
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;

  console.log(`🔗 Connecting to ${wsUrl}...`);

  const ws = new WebSocket(wsUrl);
  STATE.ws = ws;

  ws.onopen = () => {
    console.log('✅ WebSocket connected');
    STATE.reconnectAttempts = 0;

    // Send auth message
    ws.send(JSON.stringify({
      type: 'auth',
      token: getToken(),
      role: 'browser'
    }));
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      console.warn('Invalid message received');
      return;
    }
    handleMessage(data);
  };

  ws.onclose = (event) => {
    console.log(`🔌 WebSocket closed (code: ${event.code})`);
    STATE.authenticated = false;
    STATE.agentOnline = false;
    updateAgentStatus();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('⚠ WebSocket error:', err);
  };
}

function scheduleReconnect() {
  if (STATE.reconnectAttempts >= STATE.maxReconnectAttempts) {
    console.log('❌ Max reconnect attempts reached');
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, STATE.reconnectAttempts), 30000);
  STATE.reconnectAttempts++;
  console.log(`🔄 Reconnecting in ${delay}ms (attempt ${STATE.reconnectAttempts})`);

  STATE.reconnectTimer = setTimeout(connect, delay);
}

// ── Message Handler ───────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      STATE.authenticated = true;
      STATE.clientId = data.clientId;
      STATE.agentOnline = data.agentOnline;

      // Restore session from URL hash or generate new
      const hash = location.hash.slice(1);
      if (hash) STATE.sessionId = hash;

      showChat();
      updateAgentStatus();
      break;

    case 'error':
      if (!STATE.authenticated) {
        showLoginError(data.message || '认证失败');
      }
      handleError(data);
      break;

    case 'agent_status':
      STATE.agentOnline = data.online;
      updateAgentStatus();
      break;

    case 'stream':
      handleStreamEvent(data);
      break;

    case 'status':
      handleStatusEvent(data);
      break;

    case 'pong':
      // Heartbeat response, nothing to do
      break;

    default:
      console.log('Unknown message type:', data.type);
  }
}

// ── Stream Event Handling ─────────────────────────────────────
const streamBuffers = new Map(); // messageId -> { el, text, toolUseBlocks, seq }

function getOrCreateStreamBuffer(messageId) {
  if (!streamBuffers.has(messageId)) {
    streamBuffers.set(messageId, {
      el: null,
      text: '',
      toolUseBlocks: [],
      seq: 0
    });
  }
  return streamBuffers.get(messageId);
}

function handleStreamEvent(data) {
  const event = data.event;
  if (!event) return;

  const eventType = event.type;

  // ── Assistant message chunk ──────────────────────────────
  if (eventType === 'assistant') {
    const message = event.message;
    if (!message || !message.content) return;

    // Use the message id as the key for buffering
    const msgId = message.id || data.sessionId || 'current';
    const buf = getOrCreateStreamBuffer(msgId);

    // Create message element if not yet created
    if (!buf.el) {
      // Stop any previous streaming cursors
      document.querySelectorAll('.streaming-cursor').forEach(el => {
        el.classList.remove('streaming-cursor');
      });
      buf.el = createAssistantBubble();
    }

    // Process each content block
    for (const block of message.content) {
      if (block.type === 'text') {
        buf.text += block.text;
        // Update the bubble content (streaming render)
        renderStreamingText(buf.el, buf.text);
      } else if (block.type === 'tool_use') {
        // Tool use — create a collapsible block
        const toolBlock = createToolUseBlock(block);
        buf.el.querySelector('.message-content').appendChild(toolBlock);
      }
    }
  }

  // ── User message echo ────────────────────────────────────
  if (eventType === 'user') {
    // Claude echoes the user message, we already show it, so ignore
  }

  // ── System / init ────────────────────────────────────────
  if (eventType === 'system') {
    if (event.subtype === 'init') {
      // Session initialized
      console.log('Session initialized:', event.session_id);
    }
  }

  // ── Result (stream complete) ─────────────────────────────
  if (eventType === 'result') {
    const msgId = data.sessionId || 'current';
    const buf = streamBuffers.get(msgId);
    if (buf && buf.el) {
      // Remove streaming cursor
      buf.el.classList.remove('streaming-cursor');
      // Final render with full markdown
      renderFinalText(buf.el, buf.text);
    }
    // Clean up buffer after a delay (allow late events)
    setTimeout(() => streamBuffers.delete(msgId), 1000);

    STATE.streaming = false;
    updateSendButton();
  }
}

// ── Status Event Handling ─────────────────────────────────────
function handleStatusEvent(data) {
  if (data.status === 'done') {
    STATE.streaming = false;
    updateSendButton();
  } else if (data.status === 'error') {
    STATE.streaming = false;
    updateSendButton();
    addSystemMessage('❌ ' + (data.message || '发生错误'));
  } else if (data.status === 'queued') {
    addSystemMessage('⏳ Agent 离线，消息已排队等待...');
  }
}

function handleError(data) {
  STATE.streaming = false;
  updateSendButton();
  addSystemMessage('❌ ' + (data.message || '连接错误'));
}

// ── UI: Login ─────────────────────────────────────────────────
function showLogin() {
  loginScreen.classList.remove('hidden');
  chatScreen.classList.add('hidden');
  STATE.authenticated = false;
}

function showChat() {
  loginScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  updateEmptyState();
  messageInput.focus();

  // Update URL hash with session ID
  location.hash = STATE.sessionId;
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
  loginBtn.disabled = false;
}

// ── UI: Messages ───────────────────────────────────────────────
function createAssistantBubble() {
  const div = document.createElement('div');
  div.className = 'message assistant streaming-cursor';
  div.innerHTML = `
    <span class="message-role">Claude</span>
    <div class="message-content"></div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function createUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `
    <span class="message-role">你</span>
    <div class="message-content">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.innerHTML = `<div class="message-content">${text}</div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function renderStreamingText(el, text) {
  // During streaming, render as plain text with basic formatting
  // We use marked.parse on the accumulated text but keep it simple
  const contentEl = el.querySelector('.message-content');
  if (contentEl) {
    contentEl.innerHTML = marked.parse(text);
  }
  scrollToBottom();
}

function renderFinalText(el, text) {
  const contentEl = el.querySelector('.message-content');
  if (contentEl) {
    contentEl.innerHTML = marked.parse(text);
  }
  scrollToBottom();
}

function createToolUseBlock(block) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tool-use-block';

  const toolName = block.name || 'tool';
  const toolId = block.id || '';

  wrapper.innerHTML = `
    <div class="tool-use-header" onclick="this.nextElementSibling.classList.toggle('open')">
      <span class="tool-use-icon">🔧</span>
      <span>${escapeHtml(toolName)}</span>
      <span style="flex:1"></span>
      <span>▶</span>
    </div>
    <div class="tool-use-body">
      <pre>${escapeHtml(JSON.stringify(block.input || {}, null, 2))}</pre>
    </div>
  `;
  return wrapper;
}

// ── UI: Agent Status ──────────────────────────────────────────
function updateAgentStatus() {
  if (STATE.agentOnline) {
    agentStatus.className = 'status-dot online';
    agentLabel.textContent = '在线';
    agentLabel.style.color = 'var(--success)';
  } else {
    agentStatus.className = 'status-dot offline';
    agentLabel.textContent = '离线';
    agentLabel.style.color = 'var(--text-muted)';
  }
}

function updateSendButton() {
  if (STATE.streaming) {
    sendBtn.disabled = true;
    messageInput.placeholder = 'Claude 正在思考...';
  } else {
    sendBtn.disabled = false;
    messageInput.placeholder = '输入消息... (Enter 发送, Shift+Enter 换行)';
  }
}

function updateEmptyState() {
  if (messagesEl.children.length === 0) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🤖</div>
        <h2>Claude Web</h2>
        <p>开始对话，随时随地使用 Claude Code</p>
      </div>
    `;
  }
}

// ── Scroll ─────────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// ── Send Message ───────────────────────────────────────────────
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  if (!STATE.authenticated) return;
  if (STATE.streaming) return;

  // Clear empty state
  const emptyState = messagesEl.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // Show user message immediately
  createUserBubble(text);
  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Mark as streaming
  STATE.streaming = true;
  updateSendButton();

  // Send via WebSocket
  if (STATE.ws && STATE.ws.readyState === 1) {
    STATE.ws.send(JSON.stringify({
      type: 'chat',
      sessionId: STATE.sessionId,
      message: text
    }));
  } else {
    addSystemMessage('⚠ 未连接到服务器，正在尝试重连...');
    connect();
  }
}

// ── New Session ────────────────────────────────────────────────
function newSession() {
  STATE.sessionId = generateUUID();
  location.hash = STATE.sessionId;
  messagesEl.innerHTML = '';
  streamBuffers.clear();
  STATE.streaming = false;
  updateSendButton();
  updateEmptyState();

  // Notify agent of new session
  if (STATE.ws && STATE.ws.readyState === 1) {
    STATE.ws.send(JSON.stringify({
      type: 'chat',
      sessionId: STATE.sessionId,
      message: '/clear'
    }));
  }

  addSystemMessage('✨ 新会话已创建');
  messageInput.focus();
}

// ── Event Listeners ────────────────────────────────────────────
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;

  loginBtn.disabled = true;
  loginError.classList.add('hidden');

  saveToken(token);
  connect();
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
});

sendBtn.addEventListener('click', sendMessage);

newSessionBtn.addEventListener('click', newSession);

// ── Heartbeat ──────────────────────────────────────────────────
setInterval(() => {
  if (STATE.ws && STATE.ws.readyState === 1 && STATE.authenticated) {
    STATE.ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);

// ── Utils ──────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Init ───────────────────────────────────────────────────────
// Check for saved token
if (getToken()) {
  connect();
} else {
  showLogin();
}

// After a short delay, if still not authenticated, show login
setTimeout(() => {
  if (!STATE.authenticated) {
    showLogin();
  }
}, 2000);
