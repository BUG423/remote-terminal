'use strict';

const fs = require('fs');

function buildServerUrl(config, env = process.env) {
  const configured = env.CW_SERVER_URL || config.serverUrl;
  let value;

  if (configured) {
    value = configured;
  } else {
    const useWSS = config.useTLS === true || env.CW_USE_WSS === 'true';
    const port = Number(config.serverPort || (useWSS ? 443 : 3002));
    if (!config.serverHost || typeof config.serverHost !== 'string') {
      throw new Error('serverHost must be configured when serverUrl is not set');
    }
    if (/your-server|example\.com/i.test(config.serverHost)) {
      throw new Error('serverHost must not use an example value');
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('serverPort must be between 1 and 65535');
    }
    value = `${useWSS ? 'wss' : 'ws'}://${config.serverHost}:${port}`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('serverUrl is not a valid URL');
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('serverUrl must use ws:// or wss://');
  }
  if (/example\.com$/i.test(url.hostname)) {
    throw new Error('serverUrl must not use an example hostname');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('serverUrl must not contain credentials or a fragment');
  }
  return url;
}

function noProxyMatch(url, noProxyValue) {
  if (!noProxyValue) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'wss:' ? '443' : '80');

  return noProxyValue.split(',').some((raw) => {
    let rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;

    let rulePort = '';
    if (rule.startsWith('[')) {
      const end = rule.indexOf(']');
      if (end >= 0) {
        rulePort = rule.slice(end + 1).replace(/^:/, '');
        rule = rule.slice(1, end);
      }
    } else {
      const colonCount = (rule.match(/:/g) || []).length;
      if (colonCount === 1) {
        const splitAt = rule.lastIndexOf(':');
        rulePort = rule.slice(splitAt + 1);
        rule = rule.slice(0, splitAt);
      }
    }
    if (rulePort && rulePort !== port) return false;

    rule = rule.replace(/^\*\./, '.');
    if (rule.startsWith('.')) {
      const suffix = rule.slice(1);
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return hostname === rule;
  });
}

function getProxyUrl(serverUrl, config, env = process.env) {
  if (['localhost', '127.0.0.1', '::1'].includes(serverUrl.hostname.replace(/^\[|\]$/g, ''))) return null;
  const noProxy = env.NO_PROXY || env.no_proxy || config.noProxy;
  if (noProxyMatch(serverUrl, noProxy)) return null;

  const proxy = config.proxyUrl || env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return null;

  let proxyUrl;
  try {
    proxyUrl = new URL(proxy);
  } catch {
    throw new Error('proxyUrl is not a valid URL');
  }
  if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
    throw new Error('proxyUrl must use http:// or https://');
  }
  return proxyUrl;
}

function loadProxyAgentClass() {
  const exported = require('https-proxy-agent');
  return exported.HttpsProxyAgent || exported.default || exported;
}

function createConnectionOptions(serverUrl, config, env = process.env) {
  const connectTimeout = Number(env.CW_CONNECT_TIMEOUT_MS);
  const maxPayload = Number(env.CW_AGENT_MAX_PAYLOAD_BYTES);
  const options = {
    handshakeTimeout: Number.isInteger(connectTimeout) && connectTimeout >= 1000 && connectTimeout <= 120000
      ? connectTimeout
      : 15000,
    maxPayload: Number.isInteger(maxPayload) && maxPayload >= 64 * 1024 && maxPayload <= 8 * 1024 * 1024
      ? maxPayload
      : 1024 * 1024,
  };

  if (config.tlsCaPath) {
    if (serverUrl.protocol !== 'wss:') {
      throw new Error('tlsCaPath can only be used with wss://');
    }
    options.ca = fs.readFileSync(config.tlsCaPath);
  }

  const proxyUrl = getProxyUrl(serverUrl, config, env);
  if (proxyUrl) {
    const HttpsProxyAgent = loadProxyAgentClass();
    options.agent = new HttpsProxyAgent(proxyUrl);
  }

  return { options, proxyUrl };
}

function displayUrl(url) {
  const copy = new URL(url.toString());
  copy.username = '';
  copy.password = '';
  return copy.toString();
}

module.exports = {
  buildServerUrl,
  createConnectionOptions,
  displayUrl,
  getProxyUrl,
  noProxyMatch,
};
