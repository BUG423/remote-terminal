const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// ─── Configuration ───────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let config;

try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error('❌ Failed to load config.json. Copy config.json.example to config.json and edit it.');
  console.error(err.message);
  process.exit(1);
}

const {
  token,
  serverHost,
  serverPort = 3000,
  useTLS = false
} = config;

const SERVER_URL = `${useTLS ? 'wss' : 'ws'}://${serverHost}:${serverPort}`;

// ─── State ───────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Track running Claude processes per session
const activeProcesses = new Map();  // sessionId -> { proc, queue: [], history: [] }

// ─── WebSocket Connection ────────────────────────────────────────
function connect() {
  console.log(`🔗 Connecting to server: ${SERVER_URL}`);

  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('✅ Connected to server');
    reconnectAttempts = 0;

    // Authenticate as agent
    ws.send(JSON.stringify({
      type: 'auth',
      token,
      role: 'agent'
    }));
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      console.warn('⚠  Received invalid JSON from server');
      return;
    }
    handleMessage(data);
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Disconnected from server (code: ${code})`);

    // Kill all running Claude processes — they're orphaned without the relay
    for (const [sessionId, session] of activeProcesses) {
      if (session.proc) {
        console.log(`   🛑 Killing orphaned process for session ${sessionId.slice(0, 8)}`);
        session.proc.kill('SIGTERM');
        session.proc = null;
      }
    }

    ws = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('⚠  WebSocket error:', err.message);
    // The 'close' event will fire next, triggering reconnect
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts++;

  console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  console.warn('⚠  Cannot send: not connected');
  return false;
}

// ─── Message Handler ────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      console.log('🤖 Authenticated as agent');
      break;

    case 'chat':
      handleChatMessage(data);
      break;

    case 'pong':
      // Heartbeat response
      break;

    default:
      console.log('📩 Unknown message type:', data.type);
  }
}

function handleChatMessage(data) {
  const { sessionId, message, clientId } = data;

  if (!sessionId || !message) {
    console.warn('⚠  Invalid chat message (missing sessionId or message)');
    return;
  }

  console.log(`💬 [${sessionId.slice(0, 8)}] New message: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`);

  // Handle /clear command — reset conversation history
  if (message.trim() === '/clear') {
    if (activeProcesses.has(sessionId)) {
      activeProcesses.get(sessionId).history = [];
      activeProcesses.get(sessionId).queue = [];
    }
    console.log(`   🧹 Cleared history for session ${sessionId.slice(0, 8)}`);
    send({
      type: 'status',
      sessionId,
      status: 'done',
      message: 'Conversation cleared'
    });
    return;
  }

  // Check if there's already a process for this session
  if (activeProcesses.has(sessionId)) {
    const session = activeProcesses.get(sessionId);
    if (session.proc) {
      // Process is running, queue the message
      session.queue.push({ message, clientId });
      console.log(`   ⏳ Queued (process running for this session)`);
      return;
    }
  }

  // Start processing
  runClaudeProcess(sessionId, message);
}

// ─── Claude Process Management ───────────────────────────────────
function runClaudeProcess(sessionId, message) {
  // Initialize session tracking
  if (!activeProcesses.has(sessionId)) {
    activeProcesses.set(sessionId, { proc: null, queue: [], history: [] });
  }

  const session = activeProcesses.get(sessionId);

  // Send "thinking" status
  send({
    type: 'status',
    sessionId,
    status: 'thinking'
  });

  const args = [
    '-p',                             // --print mode
    '--verbose',                       // required for stream-json output
    '--output-format', 'stream-json', // streaming JSON output
  ];

  // Build conversation context from history
  let prompt = message;
  if (session.history.length > 0) {
    const parts = ['Previous conversation:\n'];
    for (const turn of session.history) {
      parts.push(`User: ${turn.user}`);
      if (turn.assistant) {
        parts.push(`Assistant: ${turn.assistant}`);
      }
    }
    parts.push('\n---\n');
    parts.push(`User's latest message: ${message}`);
    prompt = parts.join('\n');
  }

  console.log(`   🚀 [${new Date().toLocaleTimeString()}] Starting: claude ${args.join(' ')} (history: ${session.history.length} turns)`);

  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  activeProcesses.get(sessionId).proc = proc;

  let buffer = '';
  let closed = false;  // Guard against double-close (error + close both fire)
  let lastResult = null;  // Track the final result text for conversation history

  function finalize(exitCode, isError, errorMsg) {
    // Prevent double-processing: error + close both fire for the same process
    if (closed) return;
    closed = true;

    clearTimeout(timeout);

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        send({ type: 'stream', sessionId, event });
        if (event.type === 'result' && event.result) {
          lastResult = event.result;
        }
      } catch { /* ignore */ }
    }

    // Append to conversation history
    if (lastResult && !isError) {
      const session = activeProcesses.get(sessionId);
      if (session) {
        session.history.push({
          user: message,
          assistant: lastResult
        });
        // Keep history bounded (last 50 turns)
        if (session.history.length > 50) {
          session.history = session.history.slice(-50);
        }
      }
    }

    if (isError) {
      console.error(`   ❌ [${new Date().toLocaleTimeString()}] Process error: ${errorMsg}`);
    } else {
      console.log(`   ✅ [${new Date().toLocaleTimeString()}] Process exited (code: ${exitCode}) for session ${sessionId.slice(0, 8)}`);
    }

    // Notify browsers that streaming is done
    send({
      type: 'status',
      sessionId,
      status: isError ? 'error' : 'done',
      exitCode: exitCode,
      message: isError ? errorMsg : undefined
    });

    // Clean up process reference and process next queued message
    const session = activeProcesses.get(sessionId);
    if (session) {
      session.proc = null;
      if (session.queue.length > 0) {
        const next = session.queue.shift();
        console.log(`   ▶ [${new Date().toLocaleTimeString()}] Processing queued message for session ${sessionId.slice(0, 8)}`);
        // Use setImmediate to avoid deep recursion if many queued messages
        setImmediate(() => runClaudeProcess(sessionId, next.message));
        return;
      }
    }
  }

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        send({ type: 'stream', sessionId, event });
        // Capture the final result text for conversation history
        if (event.type === 'result' && event.result) {
          lastResult = event.result;
        }
      } catch {
        console.warn(`   ⚠  Non-JSON output: ${line.slice(0, 100)}`);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.error(`   📝 stderr: ${chunk.toString().trim()}`);
  });

  proc.on('close', (code) => {
    finalize(code, false, null);
  });

  proc.on('error', (err) => {
    finalize(-1, true, `Failed to start Claude: ${err.message}`);
  });

  // Write the message to stdin with error handling
  proc.stdin.on('error', (err) => {
    console.error(`   ❌ stdin error: ${err.message}`);
    // If stdin fails, the process will exit on its own → close handler fires
  });

  const written = proc.stdin.write(prompt + '\n');
  proc.stdin.end();

  if (!written) {
    console.warn(`   ⚠  stdin buffer full, waiting for drain...`);
  }

  // Set a timeout (5 minutes)
  const timeout = setTimeout(() => {
    if (proc.exitCode === null) {
      console.warn(`   ⏰ Timeout for session ${sessionId.slice(0, 8)}, killing process`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 5000);
    }
  }, 5 * 60 * 1000);
}

// ─── Heartbeat ───────────────────────────────────────────────────
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);

// ─── Periodic Status Report ──────────────────────────────────────
setInterval(() => {
  const activeCount = [...activeProcesses.values()].filter(s => s.proc !== null).length;
  const queuedCount = [...activeProcesses.values()]
    .reduce((sum, s) => sum + s.queue.length, 0);
  if (activeCount > 0 || queuedCount > 0) {
    console.log(`📊 Active processes: ${activeCount}, Queued messages: ${queuedCount}`);
  }
}, 60000);

// ─── Start ───────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║      Claude Web Agent 🤖                 ║');
console.log(`║  Server: ${SERVER_URL.padEnd(34)}║`);
console.log('║  Mode: Claude Code (stream-json)         ║');
console.log('╚══════════════════════════════════════════╝');
console.log('');

connect();

// ─── Graceful Shutdown ───────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down agent...');

  // Kill all running Claude processes
  for (const [sessionId, session] of activeProcesses) {
    if (session.proc) {
      console.log(`   Killing process for session ${sessionId.slice(0, 8)}`);
      session.proc.kill('SIGTERM');
    }
  }

  if (ws) {
    ws.close(1000, 'Agent shutting down');
  }

  process.exit(0);
});
