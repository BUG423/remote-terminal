const path = require('path');

const candidates = [
  'ws',
  path.join(__dirname, '..', 'server', 'node_modules', 'ws'),
  path.join(__dirname, '..', 'agent', 'node_modules', 'ws'),
];

let lastError;
let WebSocket;
for (const candidate of candidates) {
  try {
    WebSocket = require(candidate);
    break;
  } catch (err) {
    lastError = err;
  }
}

if (!WebSocket) throw lastError;

module.exports = WebSocket;
