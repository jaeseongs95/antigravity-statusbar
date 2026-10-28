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

function createContextWindowStore({ document, localStorage, nativeStorage, onCustomCw }) {
  const sessionCwMap = new Map();
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
          }
        }
      }
    } catch {}
  }

  function serializeSessionMap() {
    if (sessionCwMap.size > 200) {
      const firstKey = sessionCwMap.keys().next().value;
      if (firstKey !== undefined) sessionCwMap.delete(firstKey);
    }
    return JSON.stringify(Object.fromEntries(sessionCwMap.entries()));
  }

  // Synchronous initial load from localStorage + cookie
  try {
    const lsDef = normalize(localStorage?.getItem(DEFAULT_CW_KEY));
    if (lsDef) defaultCwCache = lsDef;
    const cDef = normalize(readCookie('agy_default_cw'));
    if (cDef) defaultCwCache = cDef;
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
          if (items[STORAGE_MAP_KEY]) {
            loadMapFromRaw(items[STORAGE_MAP_KEY]);
            try { localStorage?.setItem(STORAGE_MAP_KEY, serializeSessionMap()); } catch {}
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

  function saveContextWindowSetting(cascadeId, targetCw) {
    const norm = normalize(targetCw);
    if (!norm) return null;
    if (cascadeId) {
      if (sessionCwMap.has(cascadeId)) sessionCwMap.delete(cascadeId);
      sessionCwMap.set(cascadeId, norm);
      writeCookie('agy_cw_' + cascadeId, norm);
      const serialized = serializeSessionMap();
      try { localStorage?.setItem(STORAGE_MAP_KEY, serialized); } catch {}
      if (nativeStorage && typeof nativeStorage.updateItems === 'function') {
        try { nativeStorage.updateItems({ [STORAGE_MAP_KEY]: serialized }); } catch {}
      }
    } else {
      defaultCwCache = norm;
      writeCookie('agy_default_cw', norm);
      try { localStorage?.setItem(DEFAULT_CW_KEY, norm); } catch {}
      if (nativeStorage && typeof nativeStorage.updateItems === 'function') {
        try { nativeStorage.updateItems({ [DEFAULT_CW_KEY]: norm }); } catch {}
      }
    }
    return norm;
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
    hasSessionOverride,
    seedSessionIfEmpty,
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
