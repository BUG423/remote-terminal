'use strict';

function trimUtf8Tail(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;

  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

function splitUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  const chunks = [];
  let start = 0;
  while (start < buffer.length) {
    let end = Math.min(start + maxBytes, buffer.length);
    while (end < buffer.length && end > start && (buffer[end] & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + maxBytes, buffer.length);
    chunks.push(buffer.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

class OutputBacklog {
  constructor(maxBytesPerSession = 256 * 1024) {
    if (!Number.isInteger(maxBytesPerSession) || maxBytesPerSession <= 0) {
      throw new TypeError('maxBytesPerSession must be a positive integer');
    }
    this.maxBytesPerSession = maxBytesPerSession;
    this.buffers = new Map();
  }

  append(sessionId, chunk) {
    if (typeof sessionId !== 'string' || typeof chunk !== 'string' || !chunk) return;
    const current = this.buffers.get(sessionId) || '';
    this.buffers.set(sessionId, trimUtf8Tail(current + chunk, this.maxBytesPerSession));
  }

  drain() {
    const entries = [...this.buffers.entries()];
    this.buffers.clear();
    return entries;
  }

  drop(sessionId) {
    this.buffers.delete(sessionId);
  }

  get(sessionId) {
    return this.buffers.get(sessionId) || '';
  }
}

module.exports = { OutputBacklog, splitUtf8, trimUtf8Tail };
