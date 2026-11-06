'use strict';

const CONTEXT_WINDOWS = ['256K', '512K', '900K'];
const PRESET_CONTEXT_WINDOWS = ['128K', '256K', '384K', '512K', '750K', '900K'];

const CW_LIMITS = {
  '128K': 128000,
  '256K': 256000,
  '384K': 384000,
  '512K': 512000,
  '750K': 750000,
  '900K': 900000,
};

const CW_QUOTA_HINTS = {
  '128K': '절약 모드 (~0.7x)',
  '256K': '기본 쿼터 (1.0x)',
  '384K': '중간 한도 (~1.15x)',
  '512K': '턴당 약 1.3배 쿼터 소비',
  '750K': '대용량 (~1.6x)',
  '900K': '턴당 약 1.8배 쿼터 소비',
};

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

function getCwQuotaHint(cw, onNormalized) {
  if (CW_QUOTA_HINTS[cw]) return CW_QUOTA_HINTS[cw];
  const tok = getCwLimit(cw, onNormalized);
  if (tok < 256000) return '절약 모드 (<1.0x)';
  if (tok === 256000) return '기본 쿼터 (1.0x)';
  const mult = (1 + ((tok - 256000) / (900000 - 256000)) * 0.8).toFixed(1);
  return `직접 지정 (~${mult}x 추정)`;
}

function createContextWindowStore({ document, localStorage, nativeStorage, onCustomCw, onSaveCw }) {
  const sessionCwMap = new Map();
  const sessionCwTsMap = new Map();
  let defaultCwCache = '512K';

  const normalize = (raw) => normalizeContextWindow(raw, onCustomCw);

  function readCookie(name) {
    try {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = (document?.cookie || '').match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch {
      return null;
    }
  }

  function writeCookie(name, val) {
    try {
      if (document) {
        document.cookie = `${name}=${encodeURIComponent(val)}; path=/; max-age=31536000; SameSite=Lax`;
      }
    } catch {}
  }

  function loadMapFromRaw(raw) {
    if (!raw) return;
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          const norm = normalize(v);
          if (norm) {
            sessionCwMap.set(k, norm);
            if (!sessionCwTsMap.has(k)) {
              sessionCwTsMap.set(k, 1);
            }
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
    if (sessionCwMap.size > 200) {
      const firstKey = sessionCwMap.keys().next().value;
      if (firstKey !== undefined) {
        sessionCwMap.delete(firstKey);
        sessionCwTsMap.delete(firstKey);
      }
    }
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

  // Synchronous initial load from localStorage + cookie
  try {
    const lsDef = normalize(localStorage?.getItem(DEFAULT_CW_KEY));
    if (lsDef) defaultCwCache = lsDef;
    const cDef = normalize(readCookie('agy_default_cw'));
    if (cDef) defaultCwCache = cDef;
    loadTsMapFromRaw(localStorage?.getItem(STORAGE_TS_MAP_KEY));
    loadMapFromRaw(localStorage?.getItem(STORAGE_MAP_KEY));
  } catch {}

  async function loadPersistentContextSettings() {
    if (nativeStorage && typeof nativeStorage.getItems === 'function') {
      try {
        const items = await nativeStorage.getItems();
        if (items) {
          const savedDef = normalize(items[DEFAULT_CW_KEY]);
          if (savedDef) {
            defaultCwCache = savedDef;
          }
          if (items[STORAGE_TS_MAP_KEY]) {
            loadTsMapFromRaw(items[STORAGE_TS_MAP_KEY]);
          }
          if (items[STORAGE_MAP_KEY]) {
            loadMapFromRaw(items[STORAGE_MAP_KEY]);
            try {
              localStorage?.setItem(STORAGE_MAP_KEY, serializeSessionMap());
              localStorage?.setItem(STORAGE_TS_MAP_KEY, serializeSessionTsMap());
            } catch {}
          }
        }
      } catch {}
    }
  }

  function getSavedContextWindow(cascadeId) {
    if (cascadeId && sessionCwMap.has(cascadeId)) {
      const v = normalize(sessionCwMap.get(cascadeId));
      if (v) return v;
    }
    if (cascadeId) {
      const cSession = normalize(readCookie('agy_cw_' + cascadeId));
      if (cSession) {
        sessionCwMap.set(cascadeId, cSession);
        return cSession;
      }
    }
    return normalize(defaultCwCache) || '512K';
  }

  function saveContextWindowSetting(cascadeId, targetCw, opts = {}) {
    const norm = normalize(targetCw);
    if (!norm) return null;
    const ts = typeof opts?.updatedAtMs === 'number' && opts.updatedAtMs > 0 ? opts.updatedAtMs : Date.now();
    if (cascadeId) {
      if (sessionCwMap.has(cascadeId)) sessionCwMap.delete(cascadeId);
      sessionCwMap.set(cascadeId, norm);
      sessionCwTsMap.set(cascadeId, ts);
      writeCookie('agy_cw_' + cascadeId, norm);
      const serialized = serializeSessionMap();
      const serializedTs = serializeSessionTsMap();
      try {
        localStorage?.setItem(STORAGE_MAP_KEY, serialized);
        localStorage?.setItem(STORAGE_TS_MAP_KEY, serializedTs);
      } catch {}
      if (!opts?.deferNativeFlush && nativeStorage && typeof nativeStorage.updateItems === 'function') {
        try {
          nativeStorage.updateItems({
            [STORAGE_MAP_KEY]: serialized,
            [STORAGE_TS_MAP_KEY]: serializedTs,
          });
        } catch {}
      }
      if (!opts?.fromRemoteSync && typeof onSaveCw === 'function') {
        try { onSaveCw(cascadeId, norm, ts); } catch {}
      }
    } else {
      defaultCwCache = norm;
      sessionCwTsMap.set('__default__', ts);
      const serializedTs = serializeSessionTsMap();
      writeCookie('agy_default_cw', norm);
      try {
        localStorage?.setItem(DEFAULT_CW_KEY, norm);
        localStorage?.setItem(STORAGE_TS_MAP_KEY, serializedTs);
      } catch {}
      if (!opts?.deferNativeFlush && nativeStorage && typeof nativeStorage.updateItems === 'function') {
        try {
          nativeStorage.updateItems({
            [DEFAULT_CW_KEY]: norm,
            [STORAGE_TS_MAP_KEY]: serializedTs,
          });
        } catch {}
      }
      if (!opts?.fromRemoteSync && typeof onSaveCw === 'function') {
        try { onSaveCw(null, norm, ts); } catch {}
      }
    }
    return norm;
  }

  function encodeRemoteAnnotationProfile(cascadeId) {
    if (!cascadeId) return null;
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
      const parsed = parseRemoteAnnotationProfile(sum?.annotations?.activeProfile);
      if (!parsed) continue;
      if (parsed.sessionCw) {
        const localCw = sessionCwMap.get(cid);
        const localTs = sessionCwTsMap.get(cid) || 0;
        if (!localCw || parsed.ts > localTs || (localTs <= 1 && parsed.sessionCw !== localCw)) {
          saveContextWindowSetting(cid, parsed.sessionCw, {
            fromRemoteSync: true,
            deferNativeFlush: true,
            updatedAtMs: parsed.ts,
          });
          mapUpdated = true;
          if (localCw !== parsed.sessionCw) {
            changed = true;
          }
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
    if ((mapUpdated || defUpdated) && nativeStorage && typeof nativeStorage.updateItems === 'function') {
      try {
        const payload = {
          [STORAGE_TS_MAP_KEY]: serializeSessionTsMap(),
        };
        if (mapUpdated) payload[STORAGE_MAP_KEY] = serializeSessionMap();
        if (defUpdated) payload[DEFAULT_CW_KEY] = defaultCwCache;
        nativeStorage.updateItems(payload);
      } catch {}
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

  function hasSessionOverride(cascadeId) {
    return Boolean(cascadeId && sessionCwMap.has(cascadeId));
  }

  function seedSessionIfEmpty(cascadeId, rawCw) {
    if (!cascadeId || sessionCwMap.has(cascadeId)) return;
    const norm = normalize(rawCw);
    if (norm) {
      sessionCwMap.set(cascadeId, norm);
    }
  }

  function migrateSessionOverride(fromCascadeId, toCascadeId) {
    if (!fromCascadeId || !toCascadeId || fromCascadeId === toCascadeId) return null;
    const ts = sessionCwTsMap.get(fromCascadeId) || 0;
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

  function getDefaultCw() {
    return normalize(defaultCwCache) || '256K';
  }

  return {
    normalize,
    getLimit: (cw) => getCwLimit(cw, onCustomCw),
    getQuotaHint: (cw) => getCwQuotaHint(cw, onCustomCw),
    loadPersistentContextSettings,
    getSavedContextWindow,
    saveContextWindowSetting,
    encodeRemoteAnnotationProfile,
    parseRemoteAnnotationProfile,
    syncFromRemoteAnnotations,
    hasSessionOverride,
    seedSessionIfEmpty,
    migrateSessionOverride,
    getDefaultCw,
  };
}

module.exports = {
  CONTEXT_WINDOWS,
  PRESET_CONTEXT_WINDOWS,
  CW_LIMITS,
  CW_QUOTA_HINTS,
  normalizeContextWindow,
  getCwLimit,
  getCwQuotaHint,
  createContextWindowStore,
};
