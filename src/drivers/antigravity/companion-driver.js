'use strict';

/**
 * Isolated Antigravity Companion Discovery & Strict Script Loader Driver.
 * Zero sibling-repo hardcoding, strict HTTPS/CSP/one-shot TrustedScript enforcement,
 * negative policy caching (BLOCKING-B), real host `.gemini/antigravity/statusbar_autoinject.js`
 * column-0 marker discovery (`//` and `/*` with `_V\d+`), and deterministic DisposableScope
 * retry timer cancellation (T-0001, D-0001, D-0004, D-0011, D-0015, D-0025, D-0032, D-0034, AUDIT-M6).
 */

const { resolveHostAdapterConfig, normalizeHttpsBaseUrl } = require('./host-config');

const TT_SCRIPT_GATE_SYMBOL = Symbol.for('agy.sb.tt.scriptGate.v2');
const COLUMN0_COMPANION_BEGIN_RE =
  /^(?:\/\/ === BEGIN_AGY_([A-Z0-9_]+?) ===|\/\* === BEGIN_AGY_([A-Z0-9_]+?) === \*\/)[ \t]*\r?$/gm;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1500;
const DEFAULT_RETRY_DELAY_MS = 1500;
const DEFAULT_MAX_ATTEMPTS = 5;

const windowScriptGateCache = typeof WeakMap === 'function' ? new WeakMap() : null;

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

function normalizeCompanionId(rawTag) {
  return String(rawTag || '')
    .trim()
    .replace(/_V\d+$/i, '')
    .toLowerCase();
}

function extractColumn0CompanionMarkers(sourceText) {
  if (!sourceText || typeof sourceText !== 'string') return [];
  const found = [];
  const normalized = sourceText.replace(/\r\n/g, '\n');
  COLUMN0_COMPANION_BEGIN_RE.lastIndex = 0;
  let m;
  while ((m = COLUMN0_COMPANION_BEGIN_RE.exec(normalized)) !== null) {
    const rawTag = m[1] || m[2] || '';
    if (!rawTag) continue;
    const baseTag = rawTag.replace(/_V\d+$/i, '');
    const endRe = new RegExp(
      `^(?:\\/\\/ === END_AGY_${baseTag}(?:_V\\d+)? ===|\\/\\* === END_AGY_${baseTag}(?:_V\\d+)? === \\*\\/)[ \\t]*$`,
      'gm'
    );
    endRe.lastIndex = m.index + m[0].length;
    const endMatch = endRe.exec(normalized);
    if (!endMatch) continue;

    let endIdx = endMatch.index + endMatch[0].length;
    while (true) {
      endRe.lastIndex = endIdx;
      const nextEnd = endRe.exec(normalized);
      if (!nextEnd) break;
      if (normalized.slice(endIdx, nextEnd.index).trim() !== '') break;
      endIdx = nextEnd.index + nextEnd[0].length;
    }

    const cleanId = normalizeCompanionId(rawTag);
    if (cleanId && !cleanId.includes('statusbar')) {
      found.push({
        id: cleanId,
        beginMarker: m[0].trim(),
        endMarker: endMatch[0].trim(),
        code: normalized.slice(m.index, endIdx),
      });
    }
    COLUMN0_COMPANION_BEGIN_RE.lastIndex = endIdx;
  }
  return found;
}

function normalizeHostPathString(rawPath) {
  if (typeof rawPath !== 'string') return '';
  let str = rawPath.trim();
  if (!str) return '';
  if (/^file:\/\//i.test(str)) {
    try {
      const u = new URL(str);
      let p = decodeURIComponent(u.pathname || '');
      if (/^\/[A-Za-z]:[\\/]/.test(p)) {
        p = p.slice(1);
      }
      str = p;
    } catch {
      str = str.replace(/^file:\/\/\/?/i, '');
      try {
        str = decodeURIComponent(str);
      } catch {}
    }
  }
  return str.replace(/\\/g, '/').replace(/\/+$/, '');
}

function extractGeminiDirFromRawPath(rawPath) {
  const clean = normalizeHostPathString(rawPath);
  if (!clean) return '';
  const match = clean.match(/^(.*?\/\.gemini)(?:\/|$)/i);
  if (match && match[1]) return match[1];
  return '';
}

function collectGeminiDirCandidates(payload, outSet) {
  if (!payload || outSet.size >= 8) return;
  if (typeof payload === 'string') {
    const dir = extractGeminiDirFromRawPath(payload);
    if (dir) outSet.add(dir);
    return;
  }
  if (Array.isArray(payload)) {
    for (let i = 0; i < Math.min(payload.length, 200); i++) {
      collectGeminiDirCandidates(payload[i], outSet);
      if (outSet.size >= 8) break;
    }
    return;
  }
  if (typeof payload === 'object') {
    for (const val of Object.values(payload)) {
      if (typeof val === 'string' || Array.isArray(val) || (val && typeof val === 'object')) {
        collectGeminiDirCandidates(val, outSet);
        if (outSet.size >= 8) break;
      }
    }
  }
}

function buildAutoinjectReadTargets(geminiDir) {
  const base = normalizeHostPathString(geminiDir);
  if (!base) return [];
  const posixTarget = `${base}/antigravity/statusbar_autoinject.js`;
  const candidates = [posixTarget];
  if (/^[A-Za-z]:\//.test(posixTarget)) {
    candidates.push(`file:///${posixTarget}`);
    candidates.push(posixTarget.replace(/\//g, '\\'));
  } else if (posixTarget.startsWith('/')) {
    candidates.push(`file://${posixTarget}`);
  }
  return Array.from(new Set(candidates));
}

function decodeReadFileResponseText(res) {
  if (!res) return null;
  if (typeof res === 'string') return res;

  const decodeBytes = (u8) => {
    try {
      if (typeof TextDecoder === 'function') {
        return new TextDecoder('utf-8').decode(u8);
      }
    } catch {}
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(u8).toString('utf8');
    }
    let out = '';
    for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i]);
    return out;
  };

  if (res instanceof Uint8Array) return decodeBytes(res);
  if (typeof ArrayBuffer !== 'undefined' && res instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(res));
  }
  if (ArrayBuffer.isView?.(res)) {
    return decodeBytes(new Uint8Array(res.buffer, res.byteOffset, res.byteLength));
  }

  const raw = res.content ?? res.contents ?? res.data ?? res.bytes ?? res.text ?? null;
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Uint8Array) return decodeBytes(raw);
  if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(raw));
  }
  if (ArrayBuffer.isView?.(raw)) {
    return decodeBytes(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  }
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    return decodeBytes(Uint8Array.from(raw));
  }
  if (typeof raw === 'object' && raw.type === 'Buffer' && Array.isArray(raw.data)) {
    return decodeBytes(Uint8Array.from(raw.data));
  }
  if (typeof raw === 'string') {
    if (
      raw.includes('mountStatusBar') ||
      raw.includes('BEGIN_AGY_') ||
      raw.includes('use strict') ||
      raw.includes('==UserScript==')
    ) {
      return raw;
    }
    const trimmed = raw.trim();
    if (trimmed && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length % 4 === 0) {
      try {
        if (typeof Buffer !== 'undefined') {
          return Buffer.from(trimmed, 'base64').toString('utf8');
        }
        if (typeof atob === 'function') {
          const bin = atob(trimmed.replace(/\s+/g, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return decodeBytes(bytes);
        }
      } catch {}
    }
    return raw;
  }
  return null;
}

function buildTokenizedGateFromPolicy(policy) {
  const allowedSources = new Set();
  return Object.freeze({
    run(code, fn) {
      const src = String(code ?? '');
      allowedSources.add(src);
      try {
        return fn(policy.createScript(src));
      } finally {
        allowedSources.delete(src);
      }
    },
  });
}

function resolveOrCreateWindowScriptGate(win) {
  const tt = win?.trustedTypes;
  if (!tt) {
    return { mode: 'plain', gate: null };
  }

  const sharedGate = win && win[TT_SCRIPT_GATE_SYMBOL];
  if (sharedGate && typeof sharedGate.run === 'function') {
    return { mode: 'gate', gate: sharedGate };
  }

  if (win && typeof win === 'object' && windowScriptGateCache && windowScriptGateCache.has(win)) {
    const cached = windowScriptGateCache.get(win);
    if (cached.blocked) return { mode: 'blocked', gate: null };
    if (cached.gate) return { mode: 'gate', gate: cached.gate };
  }

  if (typeof tt.createPolicy === 'function') {
    const candidateNames = ['agy-sb-bm', 'agy-sb-companion-v2'];
    for (const policyName of candidateNames) {
      try {
        const allowedSources = new Set();
        const rawPolicy = tt.createPolicy(policyName, {
          createScript(src) {
            const str = String(src ?? '');
            if (!allowedSources.has(str)) {
              throw new TypeError('Unauthorized TrustedScript creation');
            }
            allowedSources.delete(str);
            return str;
          },
        });
        if (rawPolicy && typeof rawPolicy.createScript === 'function') {
          const gate = Object.freeze({
            run(code, fn) {
              const str = String(code ?? '');
              allowedSources.add(str);
              try {
                return fn(rawPolicy.createScript(str));
              } finally {
                allowedSources.delete(str);
              }
            },
          });
          if (win && typeof win === 'object') {
            if (windowScriptGateCache) windowScriptGateCache.set(win, { blocked: false, gate });
            try {
              Object.defineProperty(win, TT_SCRIPT_GATE_SYMBOL, {
                value: gate,
                configurable: true,
                enumerable: false,
                writable: false,
              });
            } catch {}
          }
          return { mode: 'gate', gate };
        }
      } catch {}
    }
  }

  if (tt.defaultPolicy && typeof tt.defaultPolicy.createScript === 'function') {
    if (win && typeof win === 'object' && windowScriptGateCache) {
      windowScriptGateCache.set(win, { blocked: true, gate: null });
    }
    return { mode: 'blocked', gate: null };
  }

  if (win && typeof win === 'object' && windowScriptGateCache) {
    windowScriptGateCache.set(win, { blocked: true, gate: null });
  }
  return { mode: 'blocked', gate: null };
}

function createOneShotTrustedScriptValue(win, codeText) {
  const res = resolveOrCreateWindowScriptGate(win);
  if (res.mode === 'plain') {
    return { allowed: true, value: String(codeText || ''), usedPolicy: false };
  }
  if (res.mode === 'gate' && res.gate) {
    try {
      let tokenVal = null;
      res.gate.run(String(codeText || ''), (trustedVal) => {
        tokenVal = trustedVal;
      });
      return { allowed: tokenVal !== null, value: tokenVal, usedPolicy: true };
    } catch {
      return { allowed: false, value: null, usedPolicy: false };
    }
  }
  return { allowed: false, value: null, usedPolicy: false };
}

function createCompanionDriver({
  window: win,
  document: doc,
  hostConfig,
  transport,
  remotePortDriver,
  scope,
  getNonce,
}) {
  const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, win);
  const loadedUrls = new Set();
  const loadedMarkerIds = new Set();
  const injectedNodes = new Set();
  let activeRetryTimer = null;

  function getAllowedExactScriptUrls() {
    const exactUrls = new Set();
    for (const raw of resolvedHostConfig.companionScripts || []) {
      const clean = normalizeHttpsBaseUrl(raw, '');
      if (clean && /\.js$/i.test(clean)) {
        exactUrls.add(clean);
      }
    }
    return exactUrls;
  }

  function isAllowedScriptUrl(rawUrl) {
    const clean = normalizeHttpsBaseUrl(rawUrl, '');
    if (!clean || !/\.js$/i.test(clean)) return false;
    const exactUrls = getAllowedExactScriptUrls();
    return exactUrls.has(clean);
  }

  async function callWithTimeout(promiseFactory, timeoutMs) {
    if (scope?.isDisposed?.()) return { timedOut: true, value: null };
    let timerId = null;
    try {
      const res = await Promise.race([
        Promise.resolve().then(promiseFactory).then((value) => ({ timedOut: false, value })),
        new Promise((resolve) => {
          const onExpire = () => resolve({ timedOut: true, value: null });
          timerId = scope ? scope.setTimeout(onExpire, timeoutMs) : setTimeout(onExpire, timeoutMs);
        }),
      ]);
      return res;
    } catch {
      return { timedOut: false, value: null };
    } finally {
      if (timerId !== null) {
        if (scope) scope.clearTimeout(timerId);
        else clearTimeout(timerId);
      }
    }
  }

  async function probeHostCompanionSource(timeoutMs) {
    if (typeof transport?.callRpcJson !== 'function' || scope?.isDisposed?.()) {
      return { resolved: true, blocks: [] };
    }

    const geminiDirs = new Set();
    const rcGeminiDir = remotePortDriver?.getSelectedGeminiDir?.();
    if (rcGeminiDir) {
      const extracted = extractGeminiDirFromRawPath(rcGeminiDir) || normalizeHostPathString(rcGeminiDir);
      if (extracted) geminiDirs.add(extracted);
    }

    let anyRpcResponded = Boolean(geminiDirs.size > 0);
    const discoveryMethods = [
      ['GetCustomizationStates', { workspaceUris: [] }],
      ['GetAllPlugins', { workspaceUris: [] }],
      ['GetAllSkills', { workspaceUris: [] }],
    ];

    for (const [methodName, reqPayload] of discoveryMethods) {
      if (scope?.isDisposed?.()) return { resolved: false, blocks: [] };
      const r = await callWithTimeout(() => transport.callRpcJson(methodName, reqPayload), timeoutMs);
      if (!r.timedOut && r.value !== null && r.value !== undefined) {
        anyRpcResponded = true;
        const inlineManifest = typeof r.value?.companionManifestText === 'string' ? r.value.companionManifestText : '';
        if (inlineManifest) {
          return {
            resolved: true,
            blocks: extractColumn0CompanionMarkers(inlineManifest),
          };
        }
        collectGeminiDirCandidates(r.value, geminiDirs);
        if (geminiDirs.size > 0) break;
      }
    }

    if (geminiDirs.size === 0) {
      return { resolved: false, blocks: [] };
    }

    for (const dir of geminiDirs) {
      for (const uriCandidate of buildAutoinjectReadTargets(dir)) {
        if (scope?.isDisposed?.()) return { resolved: false, blocks: [] };
        const rf = await callWithTimeout(() => transport.callRpcJson('ReadFile', { uri: uriCandidate }), timeoutMs);
        if (rf.timedOut || rf.value === null || rf.value === undefined) continue;
        const decoded = decodeReadFileResponseText(rf.value);
        if (typeof decoded === 'string' && decoded.length > 0) {
          return {
            resolved: true,
            blocks: extractColumn0CompanionMarkers(decoded),
          };
        }
      }
    }

    return { resolved: false, blocks: [], hadRpcContact: anyRpcResponded };
  }

  async function discoverCompanions({ timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {}) {
    const out = await discoverCompanionsDetailed({ timeoutMs });
    return out.entries;
  }

  async function discoverCompanionsDetailed({ timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {}) {
    if (scope?.isDisposed?.()) return { entries: [], hostResolved: true };
    const entries = [];
    for (const scriptUrl of resolvedHostConfig.companionScripts || []) {
      if (isAllowedScriptUrl(scriptUrl)) {
        entries.push({ id: scriptUrl, kind: 'https-url', url: scriptUrl });
      }
    }

    let hostResolved = true;
    if (typeof transport?.callRpcJson === 'function') {
      const hostRes = await probeHostCompanionSource(timeoutMs);
      hostResolved = Boolean(hostRes.resolved);
      for (const block of hostRes.blocks || []) {
        entries.push({ id: block.id, kind: 'marker-block', code: block.code });
      }
    }

    return { entries, hostResolved };
  }

  function hasExistingCompanionScriptNode(companionId) {
    if (!companionId || !doc || typeof doc.querySelector !== 'function') return false;
    try {
      return Boolean(doc.querySelector(`script[data-agy-companion="${companionId}"]`));
    } catch {
      return false;
    }
  }

  function evaluateInlineCompanion(codeText, companionId = '') {
    if (!doc || scope?.isDisposed?.()) return false;
    const cleanId = companionId ? String(companionId).replace(/[^a-z0-9_.-]/gi, '') : '';
    if (cleanId && (loadedMarkerIds.has(cleanId) || hasExistingCompanionScriptNode(cleanId))) {
      return false;
    }

    const parent = doc.head || doc.documentElement;
    if (!parent || typeof doc.createElement !== 'function') return false;

    const gateRes = resolveOrCreateWindowScriptGate(win);
    if (gateRes.mode === 'blocked') return false;

    const createAndAppend = (scriptPayload) => {
      const scriptEl = doc.createElement('script');
      const nonce = typeof getNonce === 'function' ? getNonce() : readDocNonceFallback(doc);
      if (nonce) {
        scriptEl.nonce = nonce;
        scriptEl.setAttribute?.('nonce', nonce);
      }
      if (cleanId) {
        scriptEl.setAttribute?.('data-agy-companion', cleanId);
      }
      scriptEl.text = scriptPayload;
      parent.appendChild(scriptEl);
      injectedNodes.add(scriptEl);
      if (cleanId) loadedMarkerIds.add(cleanId);
      return true;
    };

    if (gateRes.mode === 'plain') {
      return createAndAppend(String(codeText || ''));
    }
    try {
      return Boolean(gateRes.gate.run(String(codeText || ''), (trustedScript) => createAndAppend(trustedScript)));
    } catch {
      return false;
    }
  }

  async function runSingleLoadPass(opts = {}) {
    if (scope?.isDisposed?.()) return { loaded: 0, skipped: 0, hostResolved: true };
    const { entries, hostResolved } = await discoverCompanionsDetailed(opts);
    let loaded = 0;
    let skipped = 0;
    const fetchFn = opts.fetch || (typeof win?.fetch === 'function' ? win.fetch.bind(win) : null);

    for (const item of entries) {
      if (scope?.isDisposed?.()) break;
      if (item.kind === 'marker-block' && item.code) {
        if (loadedMarkerIds.has(item.id) || hasExistingCompanionScriptNode(item.id)) {
          continue;
        }
        if (evaluateInlineCompanion(item.code, item.id)) loaded += 1;
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
              if (!scope?.isDisposed?.() && evaluateInlineCompanion(txt, '')) {
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
    return { loaded, skipped, hostResolved };
  }

  async function loadCompanions(opts = {}) {
    if (scope?.isDisposed?.()) return { loaded: 0, skipped: 0 };
    const maxAttempts =
      typeof opts.maxAttempts === 'number' && opts.maxAttempts >= 1 ? Math.floor(opts.maxAttempts) : DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs =
      typeof opts.retryDelayMs === 'number' && opts.retryDelayMs >= 0 ? opts.retryDelayMs : DEFAULT_RETRY_DELAY_MS;

    let totalLoaded = 0;
    let totalSkipped = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (scope?.isDisposed?.()) break;
      const pass = await runSingleLoadPass(opts);
      totalLoaded += pass.loaded;
      totalSkipped += pass.skipped;
      if (pass.hostResolved || typeof transport?.callRpcJson !== 'function' || attempt >= maxAttempts) {
        break;
      }
      if (scope?.isDisposed?.()) break;
      const shouldContinue = await new Promise((resolve) => {
        if (!scope) {
          resolve(false);
          return;
        }
        const cancelOnDispose = scope.add(() => {
          resolve(false);
        });
        activeRetryTimer = scope.setTimeout(() => {
          activeRetryTimer = null;
          cancelOnDispose();
          resolve(!scope.isDisposed());
        }, retryDelayMs);
        if (activeRetryTimer === null) {
          cancelOnDispose();
          resolve(false);
        }
      });
      if (!shouldContinue) break;
    }

    return { loaded: totalLoaded, skipped: totalSkipped };
  }

  function dispose() {
    if (activeRetryTimer !== null && scope) {
      scope.clearTimeout(activeRetryTimer);
      activeRetryTimer = null;
    }
    for (const node of injectedNodes) {
      try { node.remove?.(); } catch {}
    }
    injectedNodes.clear();
    loadedUrls.clear();
    loadedMarkerIds.clear();
  }

  scope?.add?.(dispose);

  return {
    discoverCompanions,
    loadCompanions,
    dispose,
  };
}

module.exports = {
  TT_SCRIPT_GATE_SYMBOL,
  extractColumn0CompanionMarkers,
  decodeReadFileResponseText,
  extractGeminiDirFromRawPath,
  createOneShotTrustedScriptValue,
  createCompanionDriver,
};
