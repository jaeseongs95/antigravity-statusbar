'use strict';

/**
 * Pure Context Window Policy Domain Module.
 * Enforces [32K, 980K] clamping, 200-entry synchronized LRU eviction, cookie override preservation,
 * and remote annotation profile serialization without any DOM or vendor coupling.
 */

const { DEFAULT_LOCALE, createTranslator } = require('./i18n');

const CONTEXT_WINDOWS = Object.freeze(['256K', '512K', '900K']);
const PRESET_CONTEXT_WINDOWS = Object.freeze(['128K', '256K', '384K', '512K', '750K', '900K']);
const MAX_SESSION_ENTRIES = 200;

const CW_LIMITS = Object.freeze({
  '128K': 128000,
  '256K': 256000,
  '384K': 384000,
  '512K': 512000,
  '750K': 750000,
  '900K': 900000,
});

const STORAGE_MAP_KEY = 'agy-session-ctx-windows-v1';
const STORAGE_TS_MAP_KEY = 'agy-session-ctx-ts-v1';
const DEFAULT_CW_KEY = 'agy-default-ctx-window';

function normalizeContextWindow(raw, onNormalized) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase().replace(/,/g, '');
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2] || '';
  if (isNaN(num) || num <= 0) return null;
  let kVal;
  if (unit === 'M') {
    kVal = Math.round(num * 1000);
  } else if (unit === 'K') {
    kVal = Math.round(num);
  } else {
    kVal = num >= 10000 ? Math.round(num / 1000) : Math.round(num);
  }
  if (kVal < 32) kVal = 32;
  if (kVal > 980) kVal = 980;
  const cw = `${kVal}K`;
  if (typeof onNormalized === 'function') {
    onNormalized(cw);
  }
  return cw;
}

function getCwLimit(cw, onNormalized) {
  if (CW_LIMITS[cw]) return CW_LIMITS[cw];
  const norm = normalizeContextWindow(cw, onNormalized);
  if (!norm) return 256000;
  return parseInt(norm, 10) * 1000;
}

function getCwQuotaHint(cw, onNormalized, translatorOrLocale = DEFAULT_LOCALE) {
  const tr =
    translatorOrLocale && typeof translatorOrLocale.t === 'function'
      ? translatorOrLocale
      : createTranslator(typeof translatorOrLocale === 'string' ? translatorOrLocale : DEFAULT_LOCALE);
  const presetKey = `preset.${cw}`;
  const presetMsg = tr.t(presetKey);
  if (presetMsg !== presetKey) return presetMsg;
  const tok = getCwLimit(cw, onNormalized);
  if (tok < 256000) return tr.t('preset.customLow');
  if (tok === 256000) return tr.t('preset.256K');
  const mult = (1 + ((tok - 256000) / (900000 - 256000)) * 0.8).toFixed(1);
  return tr.t('preset.customMult', { mult });
}

function createContextWindowStore({ storage, onCustomCw, onSaveCw, translator }) {
  const sessionCwMap = new Map();
  const sessionCwTsMap = new Map();
  const VALID_CASCADE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  const FORBIDDEN_ID_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  let defaultCwCache = '512K';
  let hasExplicitDefault = false;

  const normalize = (raw) => normalizeContextWindow(raw, onCustomCw);
  const isValidCascadeId = (cascadeId) =>
    typeof cascadeId === 'string' && VALID_CASCADE_ID_RE.test(cascadeId) && !FORBIDDEN_ID_KEYS.has(cascadeId);

  function trimSessionMaps(maxEntries = MAX_SESSION_ENTRIES) {
    while (sessionCwMap.size > maxEntries) {
      const oldestKey = sessionCwMap.keys().next().value;
      if (oldestKey === undefined) break;
      sessionCwMap.delete(oldestKey);
      sessionCwTsMap.delete(oldestKey);
      try {
        storage?.deleteSessionCookie?.(oldestKey);
      } catch {}
    }
  }

  function touchSessionEntry(cascadeId, cw, ts) {
    if (!isValidCascadeId(cascadeId)) return false;
    if (sessionCwMap.has(cascadeId)) sessionCwMap.delete(cascadeId);
    sessionCwMap.set(cascadeId, cw);
    if (typeof ts === 'number' && ts > 0) {
      sessionCwTsMap.set(cascadeId, ts);
    } else if (!sessionCwTsMap.has(cascadeId)) {
      sessionCwTsMap.set(cascadeId, 1);
    }
    trimSessionMaps(MAX_SESSION_ENTRIES);
    return true;
  }

  function loadMapFromRaw(raw) {
    if (!raw) return;
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (!isValidCascadeId(k)) continue;
          const norm = normalize(v);
          if (norm) {
            touchSessionEntry(k, norm, sessionCwTsMap.get(k));
          }
        }
      }
    } catch {}
  }

  function loadTsMapFromRaw(raw) {
    if (!raw) return;
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (k !== '__default__' && !isValidCascadeId(k)) continue;
          const tsNum = Number(v);
          if (!isNaN(tsNum) && tsNum > 0) {
            const prev = sessionCwTsMap.get(k) || 0;
            if (tsNum > prev) sessionCwTsMap.set(k, tsNum);
          }
        }
      }
    } catch {}
  }

  function serializeSessionMap() {
    trimSessionMaps(MAX_SESSION_ENTRIES);
    return JSON.stringify(Object.fromEntries(sessionCwMap.entries()));
  }

  function serializeSessionTsMap() {
    const out = {};
    for (const [k, ts] of sessionCwTsMap.entries()) {
      if (typeof ts === 'number' && ts > 0 && (k === '__default__' || sessionCwMap.has(k))) {
        out[k] = ts;
      }
    }
    return JSON.stringify(out);
  }

  // Initial synchronous hydration from StoragePort
  try {
    const lsDef = normalize(storage?.getLocalItem?.(DEFAULT_CW_KEY));
    if (lsDef) {
      defaultCwCache = lsDef;
      hasExplicitDefault = true;
    }
    const cDef = normalize(storage?.readDefaultCookie?.());
    if (cDef) {
      defaultCwCache = cDef;
      hasExplicitDefault = true;
    }
    loadTsMapFromRaw(storage?.getLocalItem?.(STORAGE_TS_MAP_KEY));
    loadMapFromRaw(storage?.getLocalItem?.(STORAGE_MAP_KEY));
  } catch {}

  async function loadPersistentContextSettings() {
    if (!storage || typeof storage.loadPersistent !== 'function') return;
    try {
      const items = await storage.loadPersistent();
      if (!items || typeof items !== 'object') return;
      const savedDef = normalize(items.defaultCw ?? items[DEFAULT_CW_KEY]);
      if (savedDef) {
        defaultCwCache = savedDef;
        hasExplicitDefault = true;
      }
      if (items.tsMap ?? items[STORAGE_TS_MAP_KEY]) {
        loadTsMapFromRaw(items.tsMap ?? items[STORAGE_TS_MAP_KEY]);
      }
      if (items.sessionMap ?? items[STORAGE_MAP_KEY]) {
        loadMapFromRaw(items.sessionMap ?? items[STORAGE_MAP_KEY]);
        try {
          storage.setLocalItem?.(STORAGE_MAP_KEY, serializeSessionMap());
          storage.setLocalItem?.(STORAGE_TS_MAP_KEY, serializeSessionTsMap());
        } catch {}
      }
    } catch {}
  }

  function hasSessionOverride(cascadeId) {
    if (!isValidCascadeId(cascadeId)) return false;
    if (sessionCwMap.has(cascadeId)) return true;
    const cSession = storage?.readSessionCookie?.(cascadeId);
    if (cSession) {
      const norm = normalize(cSession.cw);
      if (norm) {
        const prevTs = sessionCwTsMap.get(cascadeId) || 0;
        const ts = typeof cSession.ts === 'number' && cSession.ts > prevTs ? cSession.ts : prevTs || 1;
        touchSessionEntry(cascadeId, norm, ts);
        return true;
      }
    }
    return false;
  }

  function getSavedContextWindow(cascadeId) {
    if (isValidCascadeId(cascadeId) && sessionCwMap.has(cascadeId)) {
      const v = normalize(sessionCwMap.get(cascadeId));
      if (v) return v;
    }
    if (isValidCascadeId(cascadeId) && hasSessionOverride(cascadeId)) {
      return sessionCwMap.get(cascadeId);
    }
    return normalize(defaultCwCache) || '512K';
  }

  function saveContextWindowSetting(cascadeId, targetCw, opts = {}) {
    const norm = normalize(targetCw);
    if (!norm) return null;
    const ts = typeof opts?.updatedAtMs === 'number' && opts.updatedAtMs > 0 ? opts.updatedAtMs : Date.now();
    if (cascadeId !== null && cascadeId !== undefined && cascadeId !== '') {
      if (!isValidCascadeId(cascadeId)) return null;
      touchSessionEntry(cascadeId, norm, ts);
      storage?.writeSessionCookie?.(cascadeId, norm, ts);
      const serialized = serializeSessionMap();
      const serializedTs = serializeSessionTsMap();
      try {
        storage?.setLocalItem?.(STORAGE_MAP_KEY, serialized);
        storage?.setLocalItem?.(STORAGE_TS_MAP_KEY, serializedTs);
      } catch {}
      if (!opts?.deferNativeFlush) {
        storage?.flushNative?.({
          [STORAGE_MAP_KEY]: serialized,
          [STORAGE_TS_MAP_KEY]: serializedTs,
        });
      }
      if (!opts?.fromRemoteSync && typeof onSaveCw === 'function') {
        try { onSaveCw(cascadeId, norm, ts); } catch {}
      }
    } else {
      defaultCwCache = norm;
      hasExplicitDefault = true;
      sessionCwTsMap.set('__default__', ts);
      const serializedTs = serializeSessionTsMap();
      storage?.writeDefaultCookie?.(norm);
      try {
        storage?.setLocalItem?.(DEFAULT_CW_KEY, norm);
        storage?.setLocalItem?.(STORAGE_TS_MAP_KEY, serializedTs);
      } catch {}
      if (!opts?.deferNativeFlush) {
        storage?.flushNative?.({
          [DEFAULT_CW_KEY]: norm,
          [STORAGE_TS_MAP_KEY]: serializedTs,
        });
      }
      if (!opts?.fromRemoteSync && typeof onSaveCw === 'function') {
        try { onSaveCw(null, norm, ts); } catch {}
      }
    }
    return norm;
  }

  function encodeRemoteAnnotationProfile(cascadeId) {
    if (!cascadeId || !hasSessionOverride(cascadeId)) return null;
    const sessionCw = normalize(sessionCwMap.get(cascadeId));
    if (!sessionCw) return null;
    const defCw = normalize(defaultCwCache) || '512K';
    const ts = sessionCwTsMap.get(cascadeId) || 1;
    return `${sessionCw}|${defCw}|${ts}`;
  }

  function parseRemoteAnnotationProfile(rawProfile) {
    if (!rawProfile || typeof rawProfile !== 'string') return null;
    const trimmed = rawProfile.trim();
    if (!trimmed) return null;
    if (!trimmed.includes('|')) {
      const single = normalize(trimmed);
      return single ? { sessionCw: single, defaultCw: null, ts: 1 } : null;
    }
    const parts = trimmed.split('|');
    const sessionCw = normalize(parts[0]);
    const defaultCw = normalize(parts[1]);
    const tsRaw = parseInt(parts[2], 10);
    const ts = !isNaN(tsRaw) && tsRaw > 0 ? tsRaw : 1;
    if (!sessionCw && !defaultCw) return null;
    return { sessionCw, defaultCw, ts };
  }

  function syncFromRemoteAnnotations(summariesMap) {
    if (!summariesMap || typeof summariesMap !== 'object') {
      return { changed: false, unsyncedLocalIds: [] };
    }
    let changed = false;
    let mapUpdated = false;
    let defUpdated = false;
    for (const [cid, sum] of Object.entries(summariesMap)) {
      hasSessionOverride(cid);
      const parsed = parseRemoteAnnotationProfile(sum?.annotations?.activeProfile);
      if (!parsed) continue;
      if (parsed.sessionCw) {
        const localCw = sessionCwMap.get(cid);
        const localTs = sessionCwTsMap.get(cid) || 0;
        if (!localCw || parsed.ts > localTs) {
          saveContextWindowSetting(cid, parsed.sessionCw, {
            fromRemoteSync: true,
            deferNativeFlush: true,
            updatedAtMs: parsed.ts,
          });
          mapUpdated = true;
          if (localCw !== parsed.sessionCw) changed = true;
        }
      }
      if (parsed.defaultCw) {
        const localDefTs = sessionCwTsMap.get('__default__') || 0;
        if (parsed.ts > localDefTs && parsed.defaultCw !== defaultCwCache) {
          saveContextWindowSetting(null, parsed.defaultCw, {
            fromRemoteSync: true,
            deferNativeFlush: true,
            updatedAtMs: parsed.ts,
          });
          defUpdated = true;
          changed = true;
        }
      }
    }
    if (mapUpdated || defUpdated) {
      const payload = { [STORAGE_TS_MAP_KEY]: serializeSessionTsMap() };
      if (mapUpdated) payload[STORAGE_MAP_KEY] = serializeSessionMap();
      if (defUpdated) payload[DEFAULT_CW_KEY] = defaultCwCache;
      storage?.flushNative?.(payload);
    }

    const unsyncedLocalIds = [];
    for (const [cid, localCw] of sessionCwMap.entries()) {
      if (!cid || cid === 'remote-session') continue;
      if ((sessionCwTsMap.get(cid) || 0) < 1) continue;
      const sum = summariesMap[cid];
      if (!sum) continue;
      const parsed = parseRemoteAnnotationProfile(sum?.annotations?.activeProfile);
      if (!parsed || parsed.sessionCw !== localCw) {
        unsyncedLocalIds.push(cid);
      }
    }
    return { changed, unsyncedLocalIds };
  }

  function seedSessionIfEmpty(cascadeId, rawCw) {
    if (!cascadeId || hasSessionOverride(cascadeId)) return;
    const norm = normalize(rawCw);
    if (norm) {
      touchSessionEntry(cascadeId, norm, Date.now());
    }
  }

  function migrateSessionOverride(fromCascadeId, toCascadeId) {
    if (!fromCascadeId || !toCascadeId || fromCascadeId === toCascadeId) return null;
    hasSessionOverride(fromCascadeId);
    hasSessionOverride(toCascadeId);
    const ts = sessionCwTsMap.get(fromCascadeId) || 1;
    const cw = sessionCwMap.get(fromCascadeId);
    if (!cw || ts < 1) return null;
    sessionCwMap.delete(fromCascadeId);
    sessionCwTsMap.delete(fromCascadeId);
    const existingTs = sessionCwTsMap.get(toCascadeId) || 0;
    if (ts >= existingTs) {
      return saveContextWindowSetting(toCascadeId, cw, { updatedAtMs: ts });
    }
    return sessionCwMap.get(toCascadeId) || null;
  }

  return {
    normalize,
    getLimit: (cw) => getCwLimit(cw, onCustomCw),
    getQuotaHint: (cw) => getCwQuotaHint(cw, onCustomCw, translator || DEFAULT_LOCALE),
    loadPersistentContextSettings,
    getSavedContextWindow,
    saveContextWindowSetting,
    encodeRemoteAnnotationProfile,
    parseRemoteAnnotationProfile,
    syncFromRemoteAnnotations,
    hasSessionOverride,
    seedSessionIfEmpty,
    migrateSessionOverride,
    getDefaultCw: () => normalize(defaultCwCache) || '512K',
    hasExplicitDefaultCw: () => hasExplicitDefault,
    _debugSizes: () => ({ cwSize: sessionCwMap.size, tsSize: sessionCwTsMap.size }),
  };
}

module.exports = {
  CONTEXT_WINDOWS,
  PRESET_CONTEXT_WINDOWS,
  MAX_SESSION_ENTRIES,
  CW_LIMITS,
  STORAGE_MAP_KEY,
  STORAGE_TS_MAP_KEY,
  DEFAULT_CW_KEY,
  normalizeContextWindow,
  getCwLimit,
  getCwQuotaHint,
  createContextWindowStore,
};
