'use strict';

/**
 * Strict CSP / TrustedTypes Companion Script Loader for Remote Control Web.
 *
 * Enforces:
 * - Scoped policy names (`agy-statusbar*` only; `createHTML === undefined`).
 * - HTTPS + path allowlist for external script URLs and one-shot token revocation for inline/Blob scripts.
 * - Cryptographic CSP nonce propagation across IDL `.nonce` and `nonce` attribute.
 * - Cross-plugin `<script data-agy-companion="...">` and loading-flag synchronization.
 */

const { resolveHostAdapterConfig } = require('./host-adapter-config');

const OFFICIAL_COMPANION_URLS = Object.freeze([
  'https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js',
  'https://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js',
  'https://raw.githubusercontent.com/jaeseongs95/antigravity-ko-translator/main/plugins/ko-thought-translator/scripts/ko_thought_autoinject.js',
]);

const companionPolicyControllers = typeof WeakMap === 'function' ? new WeakMap() : null;

function isAllowedStatusBarScriptUrl(rawUrl, resolvedHostConfig) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname.includes('..')) {
    return false;
  }
  const candidateUrls = [
    ...OFFICIAL_COMPANION_URLS,
    ...Object.values(resolvedHostConfig?.companionScripts || {}),
  ];
  for (const cand of candidateUrls) {
    if (!cand) continue;
    try {
      const cu = new URL(String(cand));
      if (cu.protocol === 'https:' && parsed.origin === cu.origin && parsed.pathname === cu.pathname) {
        return true;
      }
    } catch {}
  }
  if (/\/(?:prism_bundle|main)\.js$/.test(parsed.pathname)) {
    const cdnBase = String(resolvedHostConfig?.cdnOrigin || 'https://www.gstatic.com/antigravity').replace(/\/+$/, '');
    try {
      const cdnUrl = new URL(cdnBase);
      if (
        cdnUrl.protocol === 'https:' &&
        parsed.origin === cdnUrl.origin &&
        (cdnUrl.pathname === '/' || parsed.pathname.startsWith(`${cdnUrl.pathname}/`))
      ) {
        return true;
      }
    } catch {}
    for (const staticOrig of resolvedHostConfig?.staticCdnOrigins || []) {
      try {
        const su = new URL(String(staticOrig));
        if (su.protocol === 'https:' && parsed.origin === su.origin) {
          return true;
        }
      } catch {}
    }
    if (resolvedHostConfig?.isRemoteHost?.(parsed.hostname)) {
      return true;
    }
  }
  return false;
}

function getOrCreateCompanionPolicyController(win, resolvedHostConfig) {
  if (!win || typeof win !== 'object') return null;
  if (companionPolicyControllers && companionPolicyControllers.has(win)) {
    const existing = companionPolicyControllers.get(win);
    existing.updateHostConfig(resolvedHostConfig);
    return existing;
  }
  let latestHostConfig = resolvedHostConfig;
  const allowedInlineScripts = new Set();
  const allowedBlobUrls = new Set();
  const ttSupported = Boolean(win.trustedTypes && typeof win.trustedTypes.createPolicy === 'function');
  let policy = null;
  if (ttSupported) {
    const names = ['agy-statusbar', 'agy-statusbar-companion', 'agy-rc-statusbar'];
    for (const name of names) {
      try {
        const created = win.trustedTypes.createPolicy(name, {
          createScript: (s) => {
            const code = String(s ?? '');
            if (allowedInlineScripts.has(code)) return code;
            throw new TypeError('Untrusted inline script rejected by TrustedTypes policy');
          },
          createScriptURL: (u) => {
            const raw = String(u ?? '');
            if (raw.startsWith('blob:')) {
              if (allowedBlobUrls.has(raw)) return raw;
              throw new TypeError('Untrusted blob script URL rejected by TrustedTypes policy');
            }
            if (isAllowedStatusBarScriptUrl(raw, latestHostConfig)) {
              return raw;
            }
            throw new TypeError('Untrusted script URL rejected by TrustedTypes policy');
          },
        });
        if (created) {
          policy = created;
          break;
        }
      } catch {}
    }
  }
  const ctrl = {
    hasNativePolicy: Boolean(policy),
    updateHostConfig(nextCfg) {
      if (nextCfg) latestHostConfig = nextCfg;
    },
    allowInline(code) {
      allowedInlineScripts.add(String(code ?? ''));
    },
    revokeInline(code) {
      allowedInlineScripts.delete(String(code ?? ''));
    },
    allowBlob(blobUrl) {
      allowedBlobUrls.add(String(blobUrl ?? ''));
    },
    revokeBlob(blobUrl) {
      allowedBlobUrls.delete(String(blobUrl ?? ''));
    },
    toScript(code) {
      if (policy && typeof policy.createScript === 'function') {
        return policy.createScript(code);
      }
      if (ttSupported) {
        throw new TypeError('TrustedTypes policy creation blocked by CSP');
      }
      if (!allowedInlineScripts.has(String(code ?? ''))) {
        throw new TypeError('Untrusted inline script rejected');
      }
      return code;
    },
    toScriptURL(rawUrl) {
      if (policy && typeof policy.createScriptURL === 'function') {
        return policy.createScriptURL(rawUrl);
      }
      if (ttSupported) {
        throw new TypeError('TrustedTypes policy creation blocked by CSP');
      }
      const raw = String(rawUrl ?? '');
      if (raw.startsWith('blob:')) {
        if (allowedBlobUrls.has(raw)) return raw;
        throw new TypeError('Untrusted blob script URL rejected');
      }
      if (isAllowedStatusBarScriptUrl(raw, latestHostConfig)) {
        return raw;
      }
      throw new TypeError('Untrusted script URL rejected');
    },
  };
  if (companionPolicyControllers) {
    companionPolicyControllers.set(win, ctrl);
  }
  return ctrl;
}

function disposeCompanionPolicyController(win) {
  if (win && companionPolicyControllers) {
    companionPolicyControllers.delete(win);
  }
}

function getScriptNonce(doc) {
  if (!doc) return '';
  const nonceEl = doc.querySelector?.('script[nonce]') || doc.querySelector?.('style[nonce]');
  if (nonceEl) {
    const n = nonceEl.nonce || nonceEl.getAttribute?.('nonce') || '';
    if (n) return n;
  }
  const scripts = doc.querySelectorAll?.('script') || [];
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    const n = s && (s.nonce || s.getAttribute?.('nonce') || '');
    if (n) return n;
  }
  const styles = doc.querySelectorAll?.('style') || [];
  for (let i = 0; i < styles.length; i++) {
    const st = styles[i];
    const n = st && (st.nonce || st.getAttribute?.('nonce') || '');
    if (n) return n;
  }
  return '';
}

function appendScriptSrcAsync(win, doc, rawUrl, policyCtrl, companionId, onDoneCleanup) {
  return new Promise((resolve) => {
    let s = null;
    try {
      s = doc.createElement('script');
      if (companionId) s.setAttribute?.('data-agy-companion', companionId);
      const nonce = getScriptNonce(doc);
      if (nonce) {
        s.nonce = nonce;
        s.setAttribute?.('nonce', nonce);
      }
      s.src = policyCtrl ? policyCtrl.toScriptURL(rawUrl) : rawUrl;
      if (typeof s.addEventListener !== 'function') {
        doc.head.appendChild(s);
        if (typeof onDoneCleanup === 'function') onDoneCleanup();
        resolve(true);
        return;
      }
      let settled = false;
      const setTimeoutFn = win?.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
      const clearTimeoutFn = win?.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : null);
      let timer = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (!ok && s) {
          try {
            if (typeof s.remove === 'function') s.remove();
            else if (s.parentNode) s.parentNode.removeChild(s);
          } catch {}
        }
        if (timer && clearTimeoutFn) {
          try { clearTimeoutFn(timer); } catch {}
        }
        if (typeof onDoneCleanup === 'function') {
          try { onDoneCleanup(); } catch {}
        }
        resolve(ok);
      };
      s.addEventListener('load', () => finish(true), { once: true });
      s.addEventListener('error', () => finish(false), { once: true });
      if (setTimeoutFn) {
        timer = setTimeoutFn(() => finish(false), 4000);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
      doc.head.appendChild(s);
    } catch {
      if (s) {
        try {
          if (typeof s.remove === 'function') s.remove();
          else if (s.parentNode) s.parentNode.removeChild(s);
        } catch {}
      }
      if (typeof onDoneCleanup === 'function') {
        try { onDoneCleanup(); } catch {}
      }
      resolve(false);
    }
  });
}

async function injectCompanionCodeOrUrl(win, doc, code, url, policyCtrl, companionId, checkLoaded) {
  const isLoaded = typeof checkLoaded === 'function' ? checkLoaded : () => false;
  if (code && doc?.head) {
    let inlineEl = null;
    try {
      inlineEl = doc.createElement('script');
      if (companionId) inlineEl.setAttribute?.('data-agy-companion', companionId);
      const nonce = getScriptNonce(doc);
      if (nonce) {
        inlineEl.nonce = nonce;
        inlineEl.setAttribute?.('nonce', nonce);
      }
      policyCtrl?.allowInline(code);
      try {
        inlineEl.text = policyCtrl ? policyCtrl.toScript(code) : code;
        doc.head.appendChild(inlineEl);
      } finally {
        policyCtrl?.revokeInline(code);
      }
      if (isLoaded() || typeof inlineEl.addEventListener !== 'function') {
        return true;
      }
      try {
        if (typeof inlineEl.remove === 'function') inlineEl.remove();
        else if (inlineEl.parentNode) inlineEl.parentNode.removeChild(inlineEl);
      } catch {}
    } catch {
      if (inlineEl) {
        try {
          if (typeof inlineEl.remove === 'function') inlineEl.remove();
          else if (inlineEl.parentNode) inlineEl.parentNode.removeChild(inlineEl);
        } catch {}
      }
    }

    try {
      const BlobCtor = win?.Blob || (typeof Blob === 'function' ? Blob : null);
      const UrlApi = win?.URL || (typeof URL !== 'undefined' ? URL : null);
      if (BlobCtor && UrlApi && typeof UrlApi.createObjectURL === 'function') {
        const blobUrl = UrlApi.createObjectURL(new BlobCtor([code], { type: 'text/javascript' }));
        policyCtrl?.allowBlob(blobUrl);
        const revoke = () => {
          policyCtrl?.revokeBlob(blobUrl);
          try { UrlApi.revokeObjectURL(blobUrl); } catch {}
        };
        const blobOk = await appendScriptSrcAsync(win, doc, blobUrl, policyCtrl, companionId, revoke);
        if (blobOk && (isLoaded() || typeof doc.createElement('script')?.addEventListener !== 'function')) {
          return true;
        }
      }
    } catch {}
  }

  if (url && doc?.head) {
    const sep = url.includes('?') ? '&' : '?';
    const remoteUrl = `${url}${sep}t=${Date.now()}`;
    const remoteOk = await appendScriptSrcAsync(win, doc, remoteUrl, policyCtrl, companionId, null);
    if (remoteOk) {
      return true;
    }
  }
  return false;
}

function ensureRemoteCompanionScripts(win, doc, fetchFn, hostBridge, hostConfig) {
  try {
    const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, win);
    const isRemoteWeb = resolvedHostConfig.isRemoteHost(win?.location?.hostname);
    if (!isRemoteWeb || !doc?.head) return Promise.resolve(null);
    const effFetch = fetchFn || win?.fetch;

    const setFlagGroup = (keys, val) => {
      for (const k of keys) {
        win[k] = val;
      }
    };

    const hasExistingCompanionTag = (companionId) => {
      try {
        if (!companionId || typeof doc.querySelector !== 'function') return false;
        const el = doc.querySelector(`script[data-agy-companion="${companionId}"]`);
        return Boolean(
          el &&
            String(el.tagName || '').toUpperCase() === 'SCRIPT' &&
            typeof el.getAttribute === 'function' &&
            el.getAttribute('data-agy-companion') === companionId
        );
      } catch {
        return false;
      }
    };

    const loadScript = async (companionId, flagKeys, url, fallbackCode, checkLoaded) => {
      const keys = Array.isArray(flagKeys) ? flagKeys : [flagKeys];
      if (keys.some((k) => Boolean(win[k])) || hasExistingCompanionTag(companionId)) return false;
      setFlagGroup(keys, true);
      const policyCtrl = getOrCreateCompanionPolicyController(win, resolvedHostConfig);
      try {
        if (fallbackCode) {
          const ok = await injectCompanionCodeOrUrl(win, doc, fallbackCode, url, policyCtrl, companionId, checkLoaded);
          if (!ok) setFlagGroup(keys, false);
          return ok;
        }
        if (typeof effFetch === 'function' && url) {
          const sep = url.includes('?') ? '&' : '?';
          const r = await Promise.resolve(effFetch(`${url}${sep}t=${Date.now()}`)).catch(() => null);
          const code = r && r.ok !== false && typeof r.text === 'function' ? await r.text() : '';
          if (code) {
            const ok = await injectCompanionCodeOrUrl(win, doc, code, url, policyCtrl, companionId, checkLoaded);
            if (!ok) setFlagGroup(keys, false);
            return ok;
          }
        }
        if (url) {
          const ok = await injectCompanionCodeOrUrl(win, doc, '', url, policyCtrl, companionId, checkLoaded);
          if (!ok) setFlagGroup(keys, false);
          return ok;
        }
        setFlagGroup(keys, false);
        return false;
      } catch {
        setFlagGroup(keys, false);
        return false;
      }
    };

    const resolveHostInfo = async () => {
      if (win.__agyHostInstalledPlugins && typeof win.__agyHostInstalledPlugins === 'object') {
        return { resolved: true, ...win.__agyHostInstalledPlugins };
      }
      if (hostBridge && typeof hostBridge.fetchHostInstalledPluginInfo === 'function') {
        const info = await hostBridge.fetchHostInstalledPluginInfo(
          win.__APP_CONFIG__?.csrfToken,
          doc.querySelector?.('[data-testid="conversation-view"]')
        );
        if (info && info.resolved) {
          win.__agyHostInstalledPlugins = info;
          return info;
        }
        if (info) {
          return info;
        }
      }
      return { resolved: false, hasStatusbar: true, hasMcpManager: false, hasKoTranslator: false };
    };

    let attempts = 0;
    const tryLoadInstalledCompanions = async () => {
      attempts += 1;
      const info = await resolveHostInfo();
      if (!info.resolved) {
        if (attempts < 5) {
          const setTimeoutFn = win.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
          if (setTimeoutFn) {
            const t = setTimeoutFn(tryLoadInstalledCompanions, 1500);
            if (t && typeof t.unref === 'function') t.unref();
          }
        }
        if (!info.hasMcpManager && !info.hasKoTranslator) {
          return info;
        }
      }

      if (info.hasMcpManager && !win.agyMcpManager && !win.__agyKoFetchingMcpManager) {
        await loadScript(
          'mcp-manager',
          ['__agyLoadingMcpManagerCompanion'],
          resolvedHostConfig.companionScripts.mcpManagerUrl,
          info.mcpBlock || info.mcpManagerCode || '',
          () => Boolean(win.agyMcpManager)
        );
      }
      if (info.hasKoTranslator && !win.__agyKoLocalizerActive && !win.__agyKoThoughtCleanup) {
        await loadScript(
          'ko-thought-translator',
          ['__agyLoadingKoTranslatorCompanion', '__agyLoadingKoThoughtCompanion'],
          resolvedHostConfig.companionScripts.koTranslatorUrl,
          info.koBlock || info.koTranslatorCode || '',
          () => Boolean(win.__agyKoLocalizerActive || win.__agyKoThoughtCleanup)
        );
      }
      return info;
    };

    return tryLoadInstalledCompanions();
  } catch {
    return Promise.resolve(null);
  }
}

module.exports = {
  OFFICIAL_COMPANION_URLS,
  isAllowedStatusBarScriptUrl,
  getOrCreateCompanionPolicyController,
  disposeCompanionPolicyController,
  getScriptNonce,
  ensureRemoteCompanionScripts,
};
