'use strict';

const DEFAULT_HOST_ADAPTER_CONFIG = Object.freeze({
  rpcServicePrefix: '/exa.language_server_pb.LanguageServerService',
  csrfHeaderName: 'x-codeium-csrf-token',
  remoteHostDomains: Object.freeze(['antigravity.google.com']),
  staticCdnOrigins: Object.freeze(['https://antigravity.static.usercontent.goog']),
  cdnOrigin: 'https://www.gstatic.com/antigravity',
  companionScripts: Object.freeze({
    mcpManagerUrl:
      'https://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js',
    koTranslatorUrl:
      'https://raw.githubusercontent.com/jaeseongs95/antigravity-ko-translator/main/plugins/ko-thought-translator/scripts/ko_thought_autoinject.js',
  }),
});

function normalizeHttpsBaseUrl(raw, fallback) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol === 'https:' && !u.username && !u.password) {
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    }
  } catch {}
  return fallback;
}

function resolveHostAdapterConfig(overrides, win) {
  if (overrides && typeof overrides.buildRpcPath === 'function' && typeof overrides.isRemoteHost === 'function') {
    return overrides;
  }
  const winCfg = win && typeof win.__AGY_HOST_ADAPTER_CONFIG__ === 'object' ? win.__AGY_HOST_ADAPTER_CONFIG__ : null;
  const src = {
    ...(winCfg || {}),
    ...(overrides && typeof overrides === 'object' ? overrides : {}),
  };

  const rpcServicePrefix = String(src.rpcServicePrefix || DEFAULT_HOST_ADAPTER_CONFIG.rpcServicePrefix).replace(
    /\/+$/,
    ''
  );
  const csrfHeaderName = String(src.csrfHeaderName || DEFAULT_HOST_ADAPTER_CONFIG.csrfHeaderName).trim();
  const normalizedCustomDomains = Array.isArray(src.remoteHostDomains)
    ? src.remoteHostDomains
        .map((d) => String(d).trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
        .filter(Boolean)
    : [];
  const remoteHostDomains =
    normalizedCustomDomains.length > 0
      ? normalizedCustomDomains
      : [...DEFAULT_HOST_ADAPTER_CONFIG.remoteHostDomains];
  const staticCdnOrigins = Array.isArray(src.staticCdnOrigins) && src.staticCdnOrigins.length > 0
    ? src.staticCdnOrigins.map((o) => String(o).trim()).filter(Boolean)
    : [...DEFAULT_HOST_ADAPTER_CONFIG.staticCdnOrigins];
  const cdnOrigin = normalizeHttpsBaseUrl(src.cdnOrigin, DEFAULT_HOST_ADAPTER_CONFIG.cdnOrigin);
  const companionScripts = {
    ...DEFAULT_HOST_ADAPTER_CONFIG.companionScripts,
    ...(winCfg?.companionScripts || {}),
    ...(src.companionScripts && typeof src.companionScripts === 'object' ? src.companionScripts : {}),
  };

  return {
    rpcServicePrefix,
    csrfHeaderName,
    remoteHostDomains,
    staticCdnOrigins,
    cdnOrigin,
    companionScripts,
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
  resolveHostAdapterConfig,
};
