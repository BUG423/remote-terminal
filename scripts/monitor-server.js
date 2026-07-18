#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

function positiveNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function envFlag(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function run(command, args, timeout = 10000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? result.error.message : '',
  };
}

function systemctl(...args) {
  return run('systemctl', args);
}

function serviceState(unit) {
  const result = systemctl('is-active', unit);
  return result.stdout || 'unknown';
}

function serviceEnabledState(unit) {
  const result = systemctl('is-enabled', unit);
  return result.stdout || 'unknown';
}

function isForbiddenAgentProcess(cwd, cmdline) {
  const normalizedCwd = String(cwd || '').replace(/\/+$/, '');
  const normalizedCommand = String(cmdline || '').replace(/\0/g, ' ');
  const cwdIsAgent = /\/remote-terminal\/agent$/.test(normalizedCwd);
  const commandRunsAgent = /(?:^|\s)(?:\.\/)?agent\/index\.js(?:\s|$)/.test(normalizedCommand) ||
    /\/remote-terminal\/agent\/index\.js(?:\s|$)/.test(normalizedCommand);
  const runsNode = /(?:^|\/)node(?:\s|$)/.test(normalizedCommand);
  return runsNode && (cwdIsAgent || commandRunsAgent);
}

function findForbiddenAgentProcesses() {
  const matches = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (isForbiddenAgentProcess(cwd, cmdline)) matches.push({ pid, cwd });
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }
  return matches;
}

async function enforceNoRelayAgent(enabled, actions, errors) {
  const unit = 'remote-terminal-agent.service';
  if (enabled) {
    const active = serviceState(unit);
    const unitEnabled = serviceEnabledState(unit);
    if (active === 'active' || unitEnabled === 'enabled') {
      const stopped = systemctl('disable', '--now', unit);
      if (stopped.ok) actions.push(`disabled and stopped ${unit}`);
      else errors.push(`failed to stop ${unit}: ${stopped.stderr || stopped.error || stopped.status}`);
    }

    const processes = findForbiddenAgentProcesses();
    for (const processInfo of processes) {
      try {
        process.kill(processInfo.pid, 'SIGTERM');
        actions.push(`sent SIGTERM to forbidden Agent pid ${processInfo.pid}`);
      } catch (err) {
        if (err.code !== 'ESRCH') errors.push(`failed to stop Agent pid ${processInfo.pid}: ${err.message}`);
      }
    }
    if (processes.length > 0) await sleep(1500);

    for (const processInfo of findForbiddenAgentProcesses()) {
      try {
        process.kill(processInfo.pid, 'SIGKILL');
        actions.push(`sent SIGKILL to persistent forbidden Agent pid ${processInfo.pid}`);
      } catch (err) {
        if (err.code !== 'ESRCH') errors.push(`failed to kill Agent pid ${processInfo.pid}: ${err.message}`);
      }
    }
  }

  const remaining = findForbiddenAgentProcesses();
  const finalServiceState = serviceState(unit);
  const finalEnabledState = serviceEnabledState(unit);
  return {
    ok: !enabled || (remaining.length === 0 && finalServiceState !== 'active' && finalEnabledState !== 'enabled'),
    enforced: enabled,
    serviceState: finalServiceState,
    enabledState: finalEnabledState,
    processCount: remaining.length,
    processIds: remaining.map((item) => item.pid),
  };
}

function requestStatus(client, options, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = client.request(options, (res) => {
      res.resume();
      finish({ ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.end();
  });
}

async function checkInternalHealth(host, port) {
  const first = await requestStatus(http, { hostname: host, port, path: '/health', method: 'GET' });
  if (first.ok) return first;
  await sleep(750);
  return requestStatus(http, { hostname: host, port, path: '/health', method: 'GET' });
}

function checkLocalTls(host, port) {
  if (!host) return Promise.resolve({ ok: true, skipped: true });
  return requestStatus(https, {
    hostname: '127.0.0.1',
    port,
    path: '/',
    method: 'GET',
    servername: host,
    headers: { Host: host },
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(host, cert),
  });
}

function selectDevice(config, requestedId) {
  const devices = config.devices && typeof config.devices === 'object' ? config.devices : {};
  if (requestedId) {
    if (!devices[requestedId]) throw new Error(`monitor device not found: ${requestedId}`);
    return { id: requestedId, ...devices[requestedId] };
  }
  const entries = Object.entries(devices);
  if (entries.length !== 1) {
    throw new Error('RT_MONITOR_DEVICE_ID is required when Server has zero or multiple devices');
  }
  return { id: entries[0][0], ...entries[0][1] };
}

function checkRemoteAgent(config, device, timeoutMs = 5000) {
  const WebSocket = require(path.join(PROJECT_ROOT, 'server', 'node_modules', 'ws'));
  const bindHost = ['0.0.0.0', '::'].includes(config.bindHost) ? '127.0.0.1' : (config.bindHost || '127.0.0.1');
  const port = Number(config.port) || 3002;
  const target = `ws://${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(target);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, 'monitor complete'); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, online: false, error: 'authentication timeout' }), timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', role: 'browser', token: device.browserToken }));
    });
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        finish({ ok: false, online: false, error: 'invalid Server response' });
        return;
      }
      if (message.type === 'auth_ok') {
        finish({
          ok: message.agentOnline === true,
          online: message.agentOnline === true,
          agentName: message.agentName || device.name || device.id,
          sessions: Array.isArray(message.sessions) ? message.sessions.length : 0,
        });
      } else if (message.type === 'error') {
        finish({ ok: false, online: false, error: message.message || 'authentication rejected' });
      }
    });
    ws.on('error', (err) => finish({ ok: false, online: false, error: err.message }));
    ws.on('close', (code) => {
      if (!settled) finish({ ok: false, online: false, error: `connection closed before authentication (${code})` });
    });
  });
}

function collectMetrics(rootPath = '/') {
  const memory = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  const stat = fs.statfsSync(rootPath);
  const totalBlocks = Number(stat.blocks);
  const availableBlocks = Number(stat.bavail);
  const diskUsedPercent = totalBlocks > 0 ? Number(((1 - availableBlocks / totalBlocks) * 100).toFixed(1)) : null;
  return {
    load1: Number(os.loadavg()[0].toFixed(2)),
    cpuCount: os.cpus().length,
    memoryAvailableMb: memory ? Math.round(Number(memory[1]) / 1024) : null,
    diskUsedPercent,
  };
}

function collectResourceWarnings(metrics, thresholds) {
  const warnings = [];
  if (metrics.load1 > metrics.cpuCount * thresholds.loadPerCpu) {
    warnings.push(`load1 ${metrics.load1} exceeds ${metrics.cpuCount * thresholds.loadPerCpu}`);
  }
  if (metrics.memoryAvailableMb != null && metrics.memoryAvailableMb < thresholds.memoryAvailableMb) {
    warnings.push(`available memory ${metrics.memoryAvailableMb}MB below ${thresholds.memoryAvailableMb}MB`);
  }
  if (metrics.diskUsedPercent != null && metrics.diskUsedPercent >= thresholds.diskUsedPercent) {
    warnings.push(`disk usage ${metrics.diskUsedPercent}% reached ${thresholds.diskUsedPercent}%`);
  }
  return warnings;
}

function writeStatus(filePath, status) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o640);
}

async function main() {
  const startedAt = Date.now();
  const configPath = process.env.RT_MONITOR_CONFIG || '/etc/remote-terminal/server.json';
  const statePath = process.env.RT_MONITOR_STATE || '/var/lib/remote-terminal-monitor/status.json';
  const config = readJson(configPath);
  if (!config) throw new Error(`cannot read monitor config: ${configPath}`);

  const device = selectDevice(config, process.env.RT_MONITOR_DEVICE_ID || '');
  if (typeof device.browserToken !== 'string' || device.browserToken.length < 32) {
    throw new Error(`device ${device.id} has no valid browserToken`);
  }

  const autoHeal = envFlag(process.env.RT_MONITOR_AUTO_HEAL, false);
  const enforceNoAgent = envFlag(process.env.RT_MONITOR_ENFORCE_NO_AGENT, false);
  const tlsHost = process.env.RT_MONITOR_TLS_HOST || '';
  const tlsPort = positiveNumber(process.env.RT_MONITOR_TLS_PORT, 443, 1, 65535);
  const bindHost = ['0.0.0.0', '::'].includes(config.bindHost) ? '127.0.0.1' : (config.bindHost || '127.0.0.1');
  const port = positiveNumber(config.port, 3002, 1, 65535);
  const actions = [];
  const errors = [];

  const agentPolicy = await enforceNoRelayAgent(enforceNoAgent, actions, errors);

  let serverState = serviceState('remote-terminal-server.service');
  if (serverState !== 'active' && autoHeal) {
    const restarted = systemctl('restart', 'remote-terminal-server.service');
    if (restarted.ok) actions.push('restarted remote-terminal-server.service');
    else errors.push(`failed to restart Server: ${restarted.stderr || restarted.error || restarted.status}`);
    await sleep(1500);
    serverState = serviceState('remote-terminal-server.service');
  }

  let nginxState = serviceState('nginx.service');
  if (nginxState !== 'active' && autoHeal) {
    const restarted = systemctl('restart', 'nginx.service');
    if (restarted.ok) actions.push('restarted nginx.service');
    else errors.push(`failed to restart Nginx: ${restarted.stderr || restarted.error || restarted.status}`);
    await sleep(1000);
    nginxState = serviceState('nginx.service');
  }

  let internalHealth = await checkInternalHealth(bindHost, port);
  if (!internalHealth.ok && serverState === 'active' && autoHeal) {
    const restarted = systemctl('restart', 'remote-terminal-server.service');
    if (restarted.ok) actions.push('restarted unhealthy remote-terminal-server.service');
    else errors.push(`failed to restart unhealthy Server: ${restarted.stderr || restarted.error || restarted.status}`);
    await sleep(1500);
    serverState = serviceState('remote-terminal-server.service');
    internalHealth = await checkInternalHealth(bindHost, port);
  }

  const localTls = await checkLocalTls(tlsHost, tlsPort);
  const remoteAgent = internalHealth.ok
    ? await checkRemoteAgent(config, device)
    : { ok: false, online: false, error: 'skipped because Server health check failed' };

  if (serverState !== 'active') errors.push(`Server service is ${serverState}`);
  if (nginxState !== 'active') errors.push(`Nginx service is ${nginxState}`);
  if (!internalHealth.ok) errors.push(`internal health check failed: ${internalHealth.error || internalHealth.statusCode || 'unknown'}`);
  if (!localTls.ok) errors.push(`local TLS check failed: ${localTls.error || localTls.statusCode || 'unknown'}`);
  if (!remoteAgent.online) errors.push(`remote Agent ${device.id} is offline: ${remoteAgent.error || 'not connected'}`);
  if (!agentPolicy.ok) errors.push('forbidden Agent process or service remains on relay host');

  const metrics = collectMetrics('/');
  const thresholds = {
    loadPerCpu: positiveNumber(process.env.RT_MONITOR_LOAD_PER_CPU, 2, 0.5, 20),
    memoryAvailableMb: positiveNumber(process.env.RT_MONITOR_MIN_MEMORY_MB, 256, 64, 1048576),
    diskUsedPercent: positiveNumber(process.env.RT_MONITOR_MAX_DISK_PERCENT, 85, 50, 99.9),
  };
  const warnings = collectResourceWarnings(metrics, thresholds);
  const status = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ok: errors.length === 0,
    level: errors.length > 0 ? 'critical' : (warnings.length > 0 ? 'warning' : 'ok'),
    device: { id: device.id, name: device.name || device.id },
    checks: {
      serverService: { ok: serverState === 'active', state: serverState },
      nginxService: { ok: nginxState === 'active', state: nginxState },
      internalHealth,
      localTls: { ...localTls, host: tlsHost || null, port: tlsHost ? tlsPort : null },
      remoteAgent,
      relayAgentPolicy: agentPolicy,
    },
    metrics,
    thresholds,
    warnings,
    errors,
    actions,
  };
  writeStatus(statePath, status);

  const summary = `level=${status.level} remoteAgent=${remoteAgent.online ? 'online' : 'offline'} sessions=${remoteAgent.sessions || 0} load1=${metrics.load1} memAvailableMB=${metrics.memoryAvailableMb} diskUsed=${metrics.diskUsedPercent}% actions=${actions.length}`;
  if (errors.length > 0) console.error(`[monitor] CRITICAL ${summary} errors=${errors.join('; ')}`);
  else if (warnings.length > 0) console.warn(`[monitor] WARNING ${summary} warnings=${warnings.join('; ')}`);
  else console.log(`[monitor] OK ${summary}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[monitor] FATAL ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectResourceWarnings,
  envFlag,
  isForbiddenAgentProcess,
  positiveNumber,
  selectDevice,
};
