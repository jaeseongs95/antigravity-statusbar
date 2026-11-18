'use strict';

/**
 * Antigravity Host Adapter Configuration Driver.
 * Enforces exact/dot-boundary subdomain checks (D-0031), HTTPS-only CDN origins,
 * and clean standalone overrides without sibling repository knowledge.
 */

const { DEFAULT_COMPACT_PROMPT } = require('../../domain/i18n');

const DEFAULT_HOST_ADAPTER_CONFIG = Object.freeze({
  rpcServicePrefix: '/exa.language_server_pb.LanguageServerService',
  csrfHeaderName: 'x-codeium-csrf-token',
  remoteCsrfToken: ['csrf', 'token'].join('_'),
  remoteHostDomains: Object.freeze(['antigravity.google.com']),
  staticCdnOrigins: Object.freeze(['https://antigravity.static.usercontent.goog']),
  cdnOrigin: 'https://www.gstatic.com/antigravity',
  companionScripts: Object.freeze([]),
  locale: 'en',
  compactPrompt: DEFAULT_COMPACT_PROMPT,
});

const SAFE_RPC_PREFIX_RE = /^\/(?!\/)[^\s?#]+$/;
const VALID_DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isPlainConfigObject(val) {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val) && val.nodeType === undefined);
}

function normalizeHttpsBaseUrl(raw, fallback) {
  try {
    const str = String(raw || '').trim();
    if (!str || /[\u0000-\u0020]/.test(str)) return fallback;
    const u = new URL(str);
    if (u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash) {
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    }
  } catch {}
  return fallback;
}

function resolveHostAdapterConfig(overrides, win) {
  if (
    isPlainConfigObject(overrides) &&
    typeof overrides.buildRpcPath === 'function' &&
    typeof overrides.isRemoteHost === 'function'
  ) {
    return overrides;
  }
  const rawWinCfg = win && win.__AGY_HOST_ADAPTER_CONFIG__;
  const winCfg = isPlainConfigObject(rawWinCfg) ? rawWinCfg : null;
  const ovrCfg = isPlainConfigObject(overrides) ? overrides : null;
  const src = {
    ...(winCfg || {}),
    ...(ovrCfg || {}),
  };

  const rawPrefix = typeof src.rpcServicePrefix === 'string' ? src.rpcServicePrefix.trim().replace(/\/+$/, '') : '';
  const rpcServicePrefix =
    rawPrefix && SAFE_RPC_PREFIX_RE.test(rawPrefix) && !rawPrefix.includes('..') && !rawPrefix.includes('://')
      ? rawPrefix
      : DEFAULT_HOST_ADAPTER_CONFIG.rpcServicePrefix;

  const csrfHeaderName = String(src.csrfHeaderName || DEFAULT_HOST_ADAPTER_CONFIG.csrfHeaderName).trim();
  const normalizedCustomDomains = Array.isArray(src.remoteHostDomains)
    ? src.remoteHostDomains
        .map((d) => String(d || '').trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
        .filter((d) => VALID_DOMAIN_LABEL_RE.test(d))
    : [];
  const remoteHostDomains =
    normalizedCustomDomains.length > 0
      ? normalizedCustomDomains
      : [...DEFAULT_HOST_ADAPTER_CONFIG.remoteHostDomains];
  const staticCdnOrigins =
    Array.isArray(src.staticCdnOrigins) && src.staticCdnOrigins.length > 0
      ? src.staticCdnOrigins.map((o) => normalizeHttpsBaseUrl(o, '')).filter(Boolean)
      : [...DEFAULT_HOST_ADAPTER_CONFIG.staticCdnOrigins];
  const normalizedCdnOrigins =
    staticCdnOrigins.length > 0 ? staticCdnOrigins : [...DEFAULT_HOST_ADAPTER_CONFIG.staticCdnOrigins];
  const cdnOrigin = normalizeHttpsBaseUrl(src.cdnOrigin, DEFAULT_HOST_ADAPTER_CONFIG.cdnOrigin);
  const companionScripts = Array.isArray(src.companionScripts)
    ? src.companionScripts.map((u) => normalizeHttpsBaseUrl(u, '')).filter(Boolean)
    : [];
  const remoteCsrfToken = String(src.remoteCsrfToken || DEFAULT_HOST_ADAPTER_CONFIG.remoteCsrfToken);
  const locale = typeof src.locale === 'string' && src.locale.trim() ? src.locale.trim() : DEFAULT_HOST_ADAPTER_CONFIG.locale;
  const compactPrompt =
    typeof src.compactPrompt === 'string' && src.compactPrompt.trim()
      ? src.compactPrompt.trim()
      : DEFAULT_HOST_ADAPTER_CONFIG.compactPrompt;

  return {
    rpcServicePrefix,
    csrfHeaderName,
    remoteCsrfToken,
    remoteHostDomains,
    staticCdnOrigins: normalizedCdnOrigins,
    cdnOrigin,
    companionScripts,
    locale,
    compactPrompt,
    buildRpcPath(methodName) {
      const clean = String(methodName || '').replace(/^\/+/, '');
      return `${rpcServicePrefix}/${clean}`;
    },
    buildRpcHeaders(csrfToken, extraHeaders) {
      const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
      if (csrfToken && csrfHeaderName) {
        headers[csrfHeaderName] = csrfToken;
      }
      return headers;
    },
    isRemoteHost(hostname) {
      const host = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
      if (!host) return false;
      return remoteHostDomains.some((d) => host === d || host.endsWith(`.${d}`));
    },
  };
}

module.exports = {
  DEFAULT_HOST_ADAPTER_CONFIG,
  isPlainConfigObject,
  normalizeHttpsBaseUrl,
  resolveHostAdapterConfig,
};
