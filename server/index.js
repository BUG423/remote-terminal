const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createAuthMiddleware } = require('./auth');

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

const PORT = config.port || 3000;
const { verify, generateSessionId } = createAuthMiddleware(config);

// ─── Express App ─────────────────────────────────────────────────
const app = express();

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agentConnected: !!agentSocket });
});

// ─── HTTP Server ─────────────────────────────────────────────────
const server = http.createServer(app);

// ─── WebSocket Server ────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// Track connections
const browserClients = new Map();  // id -> { ws, sessionId }
let agentSocket = null;            // The local agent (only one)

// Track per-session message queues (when agent is not connected)
const pendingMessages = new Map(); // sessionId -> [{ message, timestamp }]

/**
 * Broadcast a message to all authenticated browser clients.
 */
function broadcastToBrowsers(data) {
  const payload = JSON.stringify(data);
  for (const [id, client] of browserClients) {
    if (client.ws.readyState === 1) { // WebSocket.OPEN
      client.ws.send(payload);
    }
  }
}

/**
 * Send a message to the agent.
 * If the agent is not connected, queue the message.
 */
function sendToAgent(data) {
  if (agentSocket && agentSocket.readyState === 1) {
    agentSocket.send(JSON.stringify(data));
    return true;
  }
  // Queue message for when agent reconnects
  const sessionId = data.sessionId;
  if (sessionId) {
    if (!pendingMessages.has(sessionId)) {
      pendingMessages.set(sessionId, []);
    }
    pendingMessages.get(sessionId).push({
      message: data.message,
      timestamp: Date.now()
    });
  }
  return false;
}

/**
 * Flush pending messages for all sessions to the agent.
 */
function flushPendingMessages() {
  if (!agentSocket || agentSocket.readyState !== 1) return;
  for (const [sessionId, messages] of pendingMessages) {
    for (const msg of messages) {
      agentSocket.send(JSON.stringify({
        type: 'chat',
        sessionId,
        message: msg.message,
        timestamp: msg.timestamp
      }));
    }
  }
  pendingMessages.clear();
}

// ─── WebSocket Connection Handler ────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = generateSessionId();
  const clientIp = req.socket.remoteAddress;
  console.log(`🔗 New connection: ${clientId} from ${clientIp}`);

  let authenticated = false;
  let clientType = null; // 'browser' | 'agent'

  // Set a 10-second timeout for authentication
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log(`⏰ Auth timeout for ${clientId}, closing connection`);
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // ── Authentication ───────────────────────────────────────
    if (data.type === 'auth') {
      if (!verify(data.token)) {
        console.log(`❌ Auth failed for ${clientId}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
        ws.close(4001, 'Invalid token');
        return;
      }

      authenticated = true;
      clearTimeout(authTimeout);

      if (data.role === 'agent') {
        clientType = 'agent';
        // If there's an existing agent, disconnect it
        if (agentSocket && agentSocket !== ws) {
          console.log('⚠  Existing agent disconnected (new agent connected)');
          agentSocket.close(4000, 'New agent connected');
        }
        agentSocket = ws;
        console.log(`🤖 Agent connected: ${clientId}`);
        ws.send(JSON.stringify({ type: 'auth_ok', role: 'agent' }));

        // Flush any pending messages
        flushPendingMessages();

        // Notify browsers
        broadcastToBrowsers({ type: 'agent_status', online: true });
      } else {
        clientType = 'browser';
        browserClients.set(clientId, { ws, sessionId: null });
        console.log(`🌐 Browser connected: ${clientId} (total: ${browserClients.size})`);
        ws.send(JSON.stringify({
          type: 'auth_ok',
          role: 'browser',
          clientId,
          agentOnline: agentSocket !== null && agentSocket.readyState === 1
        }));
      }
      return;
    }

    // Block unauthenticated messages
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    // ── Route Messages ───────────────────────────────────────
    if (clientType === 'browser') {
      // Browser → Agent
      if (data.type === 'chat') {
        const browserClient = browserClients.get(clientId);
        if (browserClient) {
          browserClient.sessionId = data.sessionId;
        }

        const delivered = sendToAgent({
          type: 'chat',
          sessionId: data.sessionId,
          message: data.message,
          clientId
        });

        if (!delivered) {
          ws.send(JSON.stringify({
            type: 'status',
            sessionId: data.sessionId,
            status: 'queued',
            message: 'Agent offline, message queued'
          }));
        }
      }
    } else if (clientType === 'agent') {
      // Agent → Browser (stream, status, error)
      if (data.type === 'stream' || data.type === 'status' || data.type === 'error') {
        broadcastToBrowsers(data);
      }
      // Agent heartbeat
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(authTimeout);
    console.log(`🔌 Disconnected: ${clientId} (${clientType || 'unauthenticated'}, code: ${code})`);

    if (clientType === 'agent') {
      agentSocket = null;
      broadcastToBrowsers({ type: 'agent_status', online: false });
    } else if (clientType === 'browser') {
      browserClients.delete(clientId);
    }
  });

  ws.on('error', (err) => {
    console.error(`⚠  WebSocket error for ${clientId}:`, err.message);
  });
});

// ─── Periodic Cleanup ────────────────────────────────────────────
// Remove stale browser clients
setInterval(() => {
  for (const [id, client] of browserClients) {
    if (client.ws.readyState !== 1) {
      browserClients.delete(id);
    }
  }
}, 30000);

// ─── Start Server ────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        Claude Web Server 🚀              ║');
  console.log(`║  HTTP + WS listening on port ${PORT}       ║`);
  console.log(`║  Agent connected: ${agentSocket ? '✅' : '⏳ waiting...'}                     ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

// ─── Graceful Shutdown ───────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  for (const [id, client] of browserClients) {
    client.ws.close(1001, 'Server shutting down');
  }
  if (agentSocket) {
    agentSocket.close(1001, 'Server shutting down');
  }
  wss.close();
  server.close();
  process.exit(0);
});
