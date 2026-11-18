'use strict';

/**
 * Isolated Antigravity Companion Discovery & Strict Script Loader Driver.
 * Zero sibling-repo hardcoding, strict HTTPS/CSP/one-shot TrustedScript enforcement,
 * and deterministic DisposableScope timer cancellation (T-0001, D-0025, D-0032, D-0034, AUDIT-M6).
 */

const { resolveHostAdapterConfig, normalizeHttpsBaseUrl } = require('./host-config');

const COLUMN0_COMPANION_BEGIN_RE = /^\/\/ === BEGIN_AGY_([A-Z0-9_]+?) ===[ \t]*\r?$/gm;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1500;

function readDocNonceFallback(doc) {
  try {
    if (!doc) return '';
    const node = doc.querySelector?.('script[nonce], style[nonce], link[nonce]');
    const n = node && (node.nonce || node.getAttribute?.('nonce'));
    return n ? String(n) : '';
  } catch {
    return '';
  }
}

function extractColumn0CompanionMarkers(sourceText) {
  if (!sourceText || typeof sourceText !== 'string') return [];
  const found = [];
  const normalized = sourceText.replace(/\r\n/g, '\n');
  COLUMN0_COMPANION_BEGIN_RE.lastIndex = 0;
  let m;
  while ((m = COLUMN0_COMPANION_BEGIN_RE.exec(normalized)) !== null) {
    const tag = m[1];
    const endRe = new RegExp(`^// === END_AGY_${tag} ===[ \\t]*$`, 'm');
    endRe.lastIndex = m.index + m[0].length;
    const endMatch = endRe.exec(normalized);
    if (endMatch) {
      found.push({
        id: tag.toLowerCase(),
        beginMarker: m[0].trim(),
        endMarker: endMatch[0].trim(),
        code: normalized.slice(m.index, endMatch.index + endMatch[0].length),
      });
      COLUMN0_COMPANION_BEGIN_RE.lastIndex = endMatch.index + endMatch[0].length;
    }
  }
  return found;
}

function createOneShotTrustedScriptValue(win, codeText) {
  const tt = win?.trustedTypes;
  if (!tt) {
    return { allowed: true, value: String(codeText || ''), usedPolicy: false };
  }
  if (typeof tt.createPolicy === 'function') {
    const policyName = `agy-sb-companion-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let policy = null;
    try {
      let consumed = false;
      policy = tt.createPolicy(policyName, {
        createScript(src) {
          if (consumed) {
            throw new TypeError('One-shot TrustedScript token revoked');
          }
          consumed = true;
          return src;
        },
      });
    } catch {
      policy = null;
    }
    if (policy) {
      try {
        return { allowed: true, value: policy.createScript(String(codeText || '')), usedPolicy: true };
      } catch {
        return { allowed: false, value: null, usedPolicy: false };
      }
    }
  }
  if (tt.defaultPolicy && typeof tt.defaultPolicy.createScript === 'function') {
    try {
      return { allowed: true, value: tt.defaultPolicy.createScript(String(codeText || '')), usedPolicy: true };
    } catch {
      return { allowed: false, value: null, usedPolicy: false };
    }
  }
  return { allowed: false, value: null, usedPolicy: false };
}

function createCompanionDriver({ window: win, document: doc, hostConfig, transport, scope, getNonce }) {
  const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, win);
  const loadedUrls = new Set();
  const injectedNodes = new Set();

  function getAllowedOrigins() {
    const origins = new Set();
    for (const raw of [...resolvedHostConfig.staticCdnOrigins, ...resolvedHostConfig.companionScripts]) {
      const clean = normalizeHttpsBaseUrl(raw, '');
      if (!clean) continue;
      try {
        origins.add(new URL(clean).origin);
      } catch {}
    }
    return origins;
  }

  function isAllowedScriptUrl(rawUrl) {
    const clean = normalizeHttpsBaseUrl(rawUrl, '');
    if (!clean) return false;
    try {
      const u = new URL(clean);
      const allowedOrigins = getAllowedOrigins();
      return allowedOrigins.has(u.origin);
    } catch {
      return false;
    }
  }

  async function discoverCompanions({ timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {}) {
    if (scope?.isDisposed?.()) return [];
    const results = [];
    for (const scriptUrl of resolvedHostConfig.companionScripts || []) {
      if (isAllowedScriptUrl(scriptUrl)) {
        results.push({ id: scriptUrl, kind: 'https-url', url: scriptUrl });
      }
    }

    if (typeof transport?.callRpcJson === 'function') {
      let timerId = null;
      try {
        const states = await Promise.race([
          transport.callRpcJson('GetCustomizationStates', {}),
          new Promise((resolve) => {
            timerId = scope
              ? scope.setTimeout(() => resolve(null), timeoutMs)
              : setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
        const inlineManifest = typeof states?.companionManifestText === 'string' ? states.companionManifestText : '';
        if (inlineManifest) {
          for (const block of extractColumn0CompanionMarkers(inlineManifest)) {
            results.push({ id: block.id, kind: 'marker-block', code: block.code });
          }
        }
      } catch {} finally {
        if (timerId !== null) {
          if (scope) scope.clearTimeout(timerId);
          else clearTimeout(timerId);
        }
      }
    }

    return results;
  }

  function evaluateInlineCompanion(codeText) {
    if (!doc || scope?.isDisposed?.()) return false;
    const ttRes = createOneShotTrustedScriptValue(win, codeText);
    if (!ttRes.allowed) return false;
    const parent = doc.head || doc.documentElement;
    if (!parent || typeof doc.createElement !== 'function') return false;
    const scriptEl = doc.createElement('script');
    const nonce = typeof getNonce === 'function' ? getNonce() : readDocNonceFallback(doc);
    if (nonce) {
      scriptEl.nonce = nonce;
      scriptEl.setAttribute?.('nonce', nonce);
    }
    scriptEl.text = ttRes.value;
    parent.appendChild(scriptEl);
    injectedNodes.add(scriptEl);
    return true;
  }

  async function loadCompanions(opts = {}) {
    if (scope?.isDisposed?.()) return { loaded: 0, skipped: 0 };
    const entries = await discoverCompanions(opts);
    let loaded = 0;
    let skipped = 0;
    const fetchFn = opts.fetch || (typeof win?.fetch === 'function' ? win.fetch.bind(win) : null);

    for (const item of entries) {
      if (scope?.isDisposed?.()) break;
      if (item.kind === 'marker-block' && item.code) {
        if (evaluateInlineCompanion(item.code)) loaded += 1;
        else skipped += 1;
        continue;
      }
      if (item.kind === 'https-url' && item.url && isAllowedScriptUrl(item.url) && !loadedUrls.has(item.url) && fetchFn) {
        try {
          const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
          const stopTimer =
            ctrl && scope
              ? scope.setTimeout(() => {
                  try { ctrl.abort(); } catch {}
                }, opts.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS)
              : null;
          try {
            const resp = await fetchFn(item.url, ctrl ? { signal: ctrl.signal } : undefined);
            const finalUrl = resp?.url || item.url;
            if (resp && resp.ok !== false && isAllowedScriptUrl(finalUrl)) {
              const txt = await resp.text();
              if (!scope?.isDisposed?.() && evaluateInlineCompanion(txt)) {
                loadedUrls.add(item.url);
                loaded += 1;
              } else {
                skipped += 1;
              }
            } else {
              skipped += 1;
            }
          } finally {
            if (stopTimer !== null && scope) scope.clearTimeout(stopTimer);
          }
        } catch {
          skipped += 1;
        }
      }
    }
    return { loaded, skipped };
  }

  function dispose() {
    for (const node of injectedNodes) {
      try { node.remove?.(); } catch {}
    }
    injectedNodes.clear();
    loadedUrls.clear();
  }

  scope?.add?.(dispose);

  return {
    discoverCompanions,
    loadCompanions,
    dispose,
  };
}

module.exports = {
  extractColumn0CompanionMarkers,
  createOneShotTrustedScriptValue,
  createCompanionDriver,
};
