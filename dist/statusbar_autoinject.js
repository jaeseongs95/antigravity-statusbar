// ==UserScript==
// @name         Antigravity Custom Statusbar (Local & Remote Control)
// @namespace    https://github.com/jaeseongs95/antigravity-statusbar
// @version      1.3.13
// @description  Custom context window statusbar (32K-980K), quota/cache metrics, compact & context debug modal for Antigravity Desktop and Remote Control web.
// @match        https://antigravity.google.com/*
// @match        https://*.antigravity.google.com/*
// @match        https://127.0.0.1/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  const __modules = {
  "./context-window-policy": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
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
          if (!sessionCwTsMap.has(cascadeId)) {
            sessionCwTsMap.set(cascadeId, Date.now());
          }
        }
      }

      function migrateSessionOverride(fromCascadeId, toCascadeId) {
        if (!fromCascadeId || !toCascadeId || fromCascadeId === toCascadeId) return null;
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

      function getDefaultCw() {
        return normalize(defaultCwCache) || '512K';
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

  },
  "./dom-styles": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';

    const STYLE_CSS = `
        .agy-ctx-statusbar {
          display: flex;
          align-items: center;
          justify-content: center;
          row-gap: 4px;
          column-gap: 10px;
          padding: 4px 10px 2px 10px;
          margin-top: 2px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          line-height: 1.4;
          color: rgba(160, 165, 175, 0.88);
          user-select: none;
          flex-wrap: wrap;
          position: relative;
          text-align: center;
        }
        .agy-ctx-left, .agy-ctx-core {
          display: contents;
        }
        .agy-ctx-group {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          white-space: nowrap;
        }
        .agy-ctx-right {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          white-space: nowrap;
        }
        .agy-ctx-sep {
          color: rgba(160, 165, 175, 0.35);
        }
        .agy-ctx-bar-wrap {
          display: inline-flex;
          align-items: center;
          width: 44px;
          height: 5px;
          background: rgba(128, 128, 128, 0.22);
          border-radius: 3px;
          overflow: hidden;
          vertical-align: middle;
        }
        .agy-ctx-bar-fill {
          height: 100%;
          border-radius: 3px;
          transition: width 0.2s ease;
        }
        .agy-ctx-ok { color: #58d68d; }
        .agy-ctx-warn { color: #f5b041; }
        .agy-ctx-crit { color: #ec7063; }
        .agy-ctx-cache { color: #5dade2; }
        .agy-ctx-quota { color: #bb8fce; }
        .agy-ctx-btn {
          cursor: pointer;
          padding: 0px 5px;
          border-radius: 3px;
          color: rgba(160, 165, 175, 0.85);
          background: rgba(128, 128, 128, 0.12);
          border: 1px solid rgba(128, 128, 128, 0.2);
          font-family: inherit;
          font-size: 10.5px;
          line-height: 1.3;
          transition: all 0.15s ease;
        }
        .agy-ctx-btn:hover {
          color: #fff;
          background: rgba(128, 128, 128, 0.28);
        }
        .agy-ctx-btn-compact:hover {
          color: #5dade2;
          border-color: rgba(93, 173, 226, 0.45);
          background: rgba(93, 173, 226, 0.14);
        }
        .agy-ctx-btn-limit {
          font-weight: 600;
          color: #5dade2;
          background: rgba(93, 173, 226, 0.1);
          border-color: rgba(93, 173, 226, 0.35);
          padding: 0px 4px;
          margin: 0 1px;
        }
        .agy-ctx-btn-limit:hover {
          color: #ffffff;
          background: rgba(93, 173, 226, 0.25);
          border-color: rgba(93, 173, 226, 0.6);
        }
        .agy-ctx-btn-limit-512 {
          color: #a569bd;
          background: rgba(165, 105, 189, 0.12);
          border-color: rgba(165, 105, 189, 0.4);
        }
        .agy-ctx-btn-limit-512:hover {
          color: #ffffff;
          background: rgba(165, 105, 189, 0.28);
          border-color: rgba(165, 105, 189, 0.7);
        }
        .agy-ctx-btn-limit-900 {
          color: #f39c12;
          background: rgba(243, 156, 18, 0.14);
          border-color: rgba(243, 156, 18, 0.45);
        }
        .agy-ctx-btn-limit-900:hover {
          color: #ffffff;
          background: rgba(243, 156, 18, 0.3);
          border-color: rgba(243, 156, 18, 0.75);
        }
        .agy-ctx-menu {
          position: absolute;
          bottom: calc(100% + 4px);
          left: 50%;
          transform: translateX(-50%);
          background: #1e1e24;
          border: 1px solid rgba(128, 128, 128, 0.35);
          border-radius: 6px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65);
          z-index: 10000;
          padding: 6px 0;
          display: flex;
          flex-direction: column;
          min-width: 215px;
          text-align: left;
        }
        .agy-ctx-menu-hdr {
          padding: 2px 10px 5px 10px;
          font-size: 10px;
          color: #94a3b8;
          border-bottom: 1px solid rgba(128, 128, 128, 0.2);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .agy-ctx-custom-row {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 10px;
          border-bottom: 1px solid rgba(128, 128, 128, 0.2);
          background: rgba(255, 255, 255, 0.02);
        }
        .agy-ctx-custom-input {
          flex: 1;
          min-width: 0;
          width: 90px;
          background: #121216;
          border: 1px solid rgba(93, 173, 226, 0.45);
          border-radius: 3px;
          color: #f8fafc;
          font-family: inherit;
          font-size: 11px;
          padding: 3px 6px;
          outline: none;
          user-select: text;
        }
        .agy-ctx-custom-input:focus {
          border-color: #5dade2;
          box-shadow: 0 0 0 1px rgba(93, 173, 226, 0.35);
        }
        .agy-ctx-custom-unit {
          font-size: 10.5px;
          color: #94a3b8;
          font-weight: 600;
        }
        .agy-ctx-custom-apply {
          padding: 3px 7px;
          font-size: 10.5px;
          font-weight: 600;
          color: #fff;
          background: rgba(93, 173, 226, 0.28);
          border: 1px solid rgba(93, 173, 226, 0.55);
          border-radius: 3px;
          cursor: pointer;
        }
        .agy-ctx-custom-apply:hover {
          background: rgba(93, 173, 226, 0.48);
        }
        .agy-ctx-menu-item {
          padding: 5px 10px;
          font-size: 11px;
          color: #cbd5e1;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .agy-ctx-menu-item:hover {
          background: rgba(93, 173, 226, 0.2);
          color: #ffffff;
        }
        .agy-ctx-menu-item.active {
          font-weight: bold;
          color: #5dade2;
        }
        .agy-ctx-menu-hint {
          font-size: 9.5px;
          color: rgba(160, 165, 175, 0.7);
        }
        .agy-ctx-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.62);
          backdrop-filter: blur(2px);
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          color: #e2e8f0;
        }
        .agy-ctx-modal {
          background: #18181d;
          border: 1px solid rgba(148, 163, 184, 0.25);
          border-radius: 8px;
          width: 100%;
          max-width: 820px;
          max-height: 84vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 20px 45px rgba(0, 0, 0, 0.7);
          overflow: hidden;
        }
        .agy-ctx-modal-hdr {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px;
          background: #202027;
          border-bottom: 1px solid rgba(148, 163, 184, 0.18);
          font-size: 12.5px;
          font-weight: 600;
        }
        .agy-ctx-modal-hdr-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .agy-ctx-modal-body {
          padding: 14px;
          overflow-y: auto;
          font-size: 11.5px;
          line-height: 1.5;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .agy-ctx-card-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
          gap: 8px;
        }
        .agy-ctx-card {
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(148, 163, 184, 0.14);
          border-radius: 6px;
          padding: 8px 10px;
        }
        .agy-ctx-card-lbl {
          font-size: 10px;
          color: #94a3b8;
          margin-bottom: 2px;
        }
        .agy-ctx-card-val {
          font-size: 13.5px;
          font-weight: 700;
        }
        .agy-ctx-sec-title {
          font-size: 11.5px;
          font-weight: 600;
          color: #cbd5e1;
          margin-bottom: 6px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .agy-ctx-tbl {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
        }
        .agy-ctx-tbl th, .agy-ctx-tbl td {
          padding: 4px 8px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.12);
          text-align: left;
        }
        .agy-ctx-tbl th {
          color: #94a3b8;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.02);
        }
        .agy-ctx-tbl td.num, .agy-ctx-tbl th.num {
          text-align: right;
        }
        ga-remote-control {
          display: block;
          width: 100%;
          height: 100%;
        }
        ga-remote-control .app-container {
          display: flex !important;
          flex-direction: column !important;
          height: 100vh !important;
          height: 100dvh !important;
          max-height: 100dvh !important;
          overflow: hidden !important;
          box-sizing: border-box !important;
        }
        ga-remote-control .iframe-panel {
          min-height: 0 !important;
          flex: 1 1 0% !important;
          overflow: hidden !important;
        }
        .agy-rc-host-view {
          flex-shrink: 0;
          width: 100%;
          background: #18181d;
          border-top: 1px solid rgba(128, 128, 128, 0.25);
          box-sizing: border-box;
          padding-bottom: env(safe-area-inset-bottom, 0px);
          z-index: 1000;
        }
        .agy-rc-host-box .agy-ctx-statusbar {
          margin-top: 0;
          padding: 5px 10px;
          justify-content: center;
          row-gap: 4px;
          column-gap: 12px;
        }
        .agy-rc-host-box .agy-ctx-menu {
          left: 50%;
          transform: translateX(-50%);
          bottom: calc(100% + 4px);
        }
        @media (max-width: 640px) {
          .agy-ctx-statusbar,
          .agy-rc-host-box .agy-ctx-statusbar {
            padding: 4px 8px;
            row-gap: 3px;
            column-gap: 8px;
            font-size: 10.5px;
          }
          .agy-ctx-bar-wrap {
            width: 34px;
          }
          .agy-ctx-sep-pipe,
          .agy-ctx-quota-left {
            display: none;
          }
          .agy-ctx-group-ctx {
            flex-basis: 100%;
          }
          .agy-ctx-menu,
          .agy-rc-host-box .agy-ctx-menu {
            min-width: min(250px, calc(100vw - 24px));
            max-width: calc(100vw - 16px);
          }
          .agy-ctx-menu-item {
            padding: 7px 12px;
            font-size: 12px;
          }
          .agy-ctx-custom-input {
            font-size: 16px;
            padding: 4px 8px;
          }
          .agy-ctx-custom-apply {
            padding: 5px 10px;
            font-size: 11.5px;
          }
          .agy-ctx-modal-backdrop {
            padding: 8px;
          }
          .agy-ctx-modal {
            max-height: 90vh;
            max-height: 90dvh;
          }
          .agy-ctx-modal-hdr {
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px 10px;
            font-size: 11.5px;
          }
          .agy-ctx-modal-body {
            padding: 10px;
            gap: 10px;
          }
          .agy-ctx-card-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 6px;
          }
          .agy-ctx-tbl {
            display: block;
            overflow-x: auto;
          }
        }
    `;

    function buildDynamicCwWarnCss(underDefaultCwSet) {
      const selectors = ['[data-testid="model-selector-trigger"][data-agy-cw-warn="0"] div:has(> .text-warning)'];
      for (const cw of underDefaultCwSet) {
        selectors.push(`[data-testid="model-selector-trigger"][data-context-window="${cw}"] div:has(> .text-warning)`);
      }
      return `\n    ${selectors.join(',\n    ')} {\n      display: none !important;\n    }\n`;
    }

    function ensureStyleElement(document, underDefaultCwSet) {
      if (!document) return;
      const fullCss = STYLE_CSS + buildDynamicCwWarnCss(underDefaultCwSet);
      const docs = [document];
      try {
        const iframe = document.querySelector?.('ga-remote-control iframe');
        if (iframe && !iframe.__agyCrossOriginInaccessible) {
          const iframeDoc = iframe.contentDocument;
          if (iframeDoc && iframeDoc !== document) docs.push(iframeDoc);
        }
      } catch {
        try {
          const iframe = document.querySelector?.('ga-remote-control iframe');
          if (iframe) iframe.__agyCrossOriginInaccessible = true;
        } catch {}
      }
      for (const d of docs) {
        const parent = d.head || d.documentElement;
        if (!parent) continue;
        let styleEl = d.getElementById('agy-ctx-statusbar-style');
        if (!styleEl) {
          styleEl = d.createElement('style');
          styleEl.id = 'agy-ctx-statusbar-style';
          parent.appendChild(styleEl);
        }
        if (styleEl.textContent !== fullCss) {
          styleEl.textContent = fullCss;
        }
      }
    }

    function createTrustedHtmlSetter(window, document) {
      if (window?.__agyTrustedHtmlPolicy) {
        return (el, html) => { el.innerHTML = window.__agyTrustedHtmlPolicy.createHTML(html); };
      }
      if (window?.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
        const names = [
          'agy-statusbar',
          'angular#unsafe-bypass',
          'angular',
          'default',
          'dompurify',
          'nextjs#bundler',
          'agy-statusbar-' + Date.now(),
        ];
        for (const name of names) {
          try {
            const p = window.trustedTypes.createPolicy(name, { createHTML: (s) => s, createScript: (s) => s });
            try { window.__agyTrustedHtmlPolicy = p; } catch {}
            return (el, html) => { el.innerHTML = p.createHTML(html); };
          } catch {}
        }
      }
      return (el, html) => {
        try {
          el.innerHTML = html;
        } catch {
          if (document && typeof document.createRange === 'function') {
            const range = document.createRange();
            range.selectNodeContents(el);
            range.deleteContents();
            el.appendChild(range.createContextualFragment(html));
          }
        }
      };
    }

    function fmtK(n) {
      const num = Number(n);
      if (!num || isNaN(num)) return '0';
      if (num >= 1000000) return (num / 1000000).toFixed(num % 1000000 === 0 ? 0 : 1) + 'M';
      if (num >= 1000) return Math.round(num / 1000) + 'k';
      return String(num);
    }

    function fmtNum(n) {
      if (n === null || n === undefined) return '0';
      const num = Number(n);
      if (isNaN(num)) return '0';
      return num.toLocaleString('en-US');
    }

    function escHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function fmtResetTime(iso) {
      if (!iso) return '';
      try {
        let d;
        if (typeof iso === 'object' && iso.seconds !== undefined) {
          d = new Date(Number(iso.seconds) * 1000);
        } else {
          d = new Date(iso);
        }
        if (isNaN(d.getTime())) return '';
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `→${hh}:${mm}`;
      } catch {
        return '';
      }
    }

    module.exports = {
      STYLE_CSS,
      buildDynamicCwWarnCss,
      ensureStyleElement,
      createTrustedHtmlSetter,
      fmtK,
      fmtNum,
      escHtml,
      fmtResetTime,
    };

  },
  "./rpc-client": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';

    const { fmtResetTime } = require('./dom-styles');

    const MAX_CACHE_ENTRIES = 60;
    const STATS_CACHE_KEY = 'agy-stats-cache-v1';

    function getChatModelFromMeta(m) {
      if (!m) return null;
      if (m.chatModel) return m.chatModel;
      if (m.metadata && m.metadata.case === 'chatModel' && m.metadata.value) return m.metadata.value;
      if (m.metadata && m.metadata.value && (m.metadata.value.chatStartMetadata || m.metadata.value.usage)) return m.metadata.value;
      return null;
    }

    function getBucketRemainingFraction(b) {
      if (!b) return null;
      if (typeof b.remainingFraction === 'number') return b.remainingFraction;
      if (b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number') {
        return b.remaining.value;
      }
      return null;
    }

    function extractStatsFromMetas(metas) {
      let used = 0, max = 256000, cacheRead = 0, inputTok = 0, lastMetaStepIndex = -1;
      let foundCtx = false, foundUsage = false;
      for (let i = metas.length - 1; i >= 0; i--) {
        const m = metas[i];
        const cm = getChatModelFromMeta(m);
        if (!cm) continue;
        if (!foundCtx && cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata) {
          const cwm = cm.chatStartMetadata.contextWindowMetadata;
          if (cwm.estimatedTokensUsed !== undefined && cwm.estimatedTokensUsed !== null) {
            used = Number(cwm.estimatedTokensUsed);
            max = Number(cwm.maxContextTokens || 256000);
            if (Array.isArray(m.stepIndices) && m.stepIndices.length > 0) {
              lastMetaStepIndex = Number(m.stepIndices[m.stepIndices.length - 1]);
            }
            foundCtx = true;
          }
        }
        if (!foundUsage && cm.usage && (cm.usage.inputTokens || cm.usage.cacheReadTokens)) {
          cacheRead = Number(cm.usage.cacheReadTokens || 0);
          inputTok = Number(cm.usage.inputTokens || 0);
          foundUsage = true;
        }
        if (foundCtx && foundUsage) break;
      }
      const totalPrompt = cacheRead + inputTok;
      const cachePct = totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;
      return { used, trajectoryMax: max, cacheRead, inputTok, cachePct, lastMetaStepIndex, foundCtx, foundUsage };
    }

    function createRpcClient({ window, fetchFn, localStorage, getAgentStateProviderForInputBox, getRemoteRpcServiceForElement }) {
      const stateCache = new Map();
      const inFlightStats = new Map();
      const knownGenLenMap = new Map();
      let inFlightQuota = null;
      let quotaData = null;
      let lastQuotaFetch = 0;

      function canUseLocalHttp(csrf) {
        const win = window || (typeof globalThis !== 'undefined' ? globalThis.window : null);
        if (win?.__APP_CONFIG__?.isRemoteControl) return false;
        return Boolean(csrf && typeof fetchFn === 'function');
      }

      try {
        const rawCache = localStorage?.getItem(STATS_CACHE_KEY);
        if (rawCache) {
          const entries = JSON.parse(rawCache);
          if (Array.isArray(entries)) {
            for (const [k, v] of entries) {
              stateCache.set(k, v);
              if (v && typeof v.knownGenLen === 'number' && v.knownGenLen > 0) {
                knownGenLenMap.set(k, v.knownGenLen);
              }
            }
          }
        }
      } catch {}

      function setBoundedCache(cascadeId, data) {
        if (stateCache.has(cascadeId)) stateCache.delete(cascadeId);
        stateCache.set(cascadeId, data);
        if (stateCache.size > MAX_CACHE_ENTRIES) {
          const oldestKey = stateCache.keys().next().value;
          if (oldestKey !== undefined) stateCache.delete(oldestKey);
        }
        try {
          localStorage?.setItem(STATS_CACHE_KEY, JSON.stringify(Array.from(stateCache.entries())));
        } catch {}
      }

      function parseQuotaResponse(j) {
        if (!j) return null;
        const groups = (j.response && j.response.groups) || j.groups || [];
        const geminiGroup = groups.find((g) => (g.displayName || g.groupName || '').includes('Gemini')) || groups[0];
        if (geminiGroup && geminiGroup.buckets) {
          const b5h = geminiGroup.buckets.find((b) => b.window === '5h');
          const b7d = geminiGroup.buckets.find((b) => b.window === 'weekly');
          const frac5h = getBucketRemainingFraction(b5h);
          const frac7d = getBucketRemainingFraction(b7d);
          return {
            pct5h: frac5h !== null ? Math.round(frac5h * 100) : null,
            rst5h: b5h ? fmtResetTime(b5h.resetTime) : '',
            pct7d: frac7d !== null ? Math.round(frac7d * 100) : null,
          };
        }
        return null;
      }

      function fetchQuota(csrf, el) {
        const now = Date.now();
        if (now - lastQuotaFetch < 15000 && quotaData) return Promise.resolve(quotaData);
        if (inFlightQuota) return inFlightQuota;
        lastQuotaFetch = now;
        inFlightQuota = (async () => {
          try {
            let j = null;
            if (canUseLocalHttp(csrf)) {
              try {
                const r = await fetchFn('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
                  body: '{}',
                });
                if (r && r.ok !== false) {
                  j = await r.json();
                }
              } catch {}
            }
            if (!j && typeof getRemoteRpcServiceForElement === 'function') {
              const svc = getRemoteRpcServiceForElement(el);
              if (svc && typeof svc.retrieveUserQuotaSummary === 'function') {
                j = await svc.retrieveUserQuotaSummary({});
              }
            }
            const parsedQuota = parseQuotaResponse(j);
            if (parsedQuota) quotaData = parsedQuota;
          } catch {}
          inFlightQuota = null;
          return quotaData;
        })();
        return inFlightQuota;
      }

      async function fetchTailMetasBounded({ cascadeId, totalGenLen, totalStepsLen, cachedGenLen, tailSize = 3, callGenMeta }) {
        let knownLen = totalGenLen > 0 ? totalGenLen : (knownGenLenMap.get(cascadeId) || cachedGenLen || -1);
        if (knownLen > 0) {
          const off = Math.max(0, knownLen - tailSize);
          const metas = await callGenMeta(off);
          if (metas.length > 0) {
            const nextLen = off + metas.length;
            knownGenLenMap.set(cascadeId, nextLen);
            return { metas, knownGenLen: nextLen };
          }
        }

        const sc = totalStepsLen > 0 ? totalStepsLen : 40;
        if (sc <= 60) {
          const metas = await callGenMeta(0);
          if (metas.length > 0) {
            knownGenLenMap.set(cascadeId, metas.length);
          }
          return { metas, knownGenLen: metas.length };
        }

        let cur = Math.ceil(sc * 0.42);
        while (cur > 0) {
          const metas = await callGenMeta(cur);
          if (metas.length > 0) {
            const nextLen = cur + metas.length;
            knownGenLenMap.set(cascadeId, nextLen);
            return { metas, knownGenLen: nextLen };
          }
          const stepDown = Math.max(35, Math.floor(cur * 0.22));
          cur = Math.max(0, cur - stepDown);
        }

        const metas0 = await callGenMeta(0);
        if (metas0.length > 0) {
          knownGenLenMap.set(cascadeId, metas0.length);
        }
        return { metas: metas0, knownGenLen: metas0.length };
      }

      function applyRealtimeCompactionAndUsage(parsed, fullState) {
        if (!fullState || typeof fullState !== 'object') return parsed;
        const cwUsage = fullState.contextWindowUsage;
        const compactedSteps = fullState.compactionInfo?.compactedAtStepIndices;
        const latestCompactedStep = Array.isArray(compactedSteps) && compactedSteps.length > 0
          ? Number(compactedSteps[compactedSteps.length - 1])
          : -1;

        const base = parsed || {
          used: 0,
          trajectoryMax: 256000,
          cacheRead: 0,
          inputTok: 0,
          cachePct: 0,
          lastMetaStepIndex: -1,
          foundCtx: false,
          foundUsage: false,
        };

        if (cwUsage && typeof cwUsage === 'object') {
          const uMax = Number(cwUsage.maxContextTokens || 0);
          if (uMax > 0) {
            base.trajectoryMax = uMax;
          }
          const afterCompact = Number(cwUsage.estimatedAfterCompaction || 0);
          const uStep = Number(cwUsage.lastStepIndex ?? -1);
          const uEst = Number(cwUsage.estimatedTokensUsed || 0);

          if (afterCompact > 0 && latestCompactedStep >= 0 && (base.lastMetaStepIndex < 0 || latestCompactedStep >= base.lastMetaStepIndex)) {
            base.used = afterCompact;
            base.foundCtx = true;
          } else if (uEst > 0 && (!base.foundCtx || (uStep >= 0 && base.lastMetaStepIndex >= 0 && uStep > base.lastMetaStepIndex))) {
            base.used = uEst;
            base.foundCtx = true;
          }
        }
        return base;
      }

      function fetchCascadeStats(cascadeId, csrf, inputBox) {
        if (!cascadeId || cascadeId === 'remote-session') {
          return Promise.resolve(null);
        }
        const asp = getAgentStateProviderForInputBox ? getAgentStateProviderForInputBox(inputBox) : null;
        const fullState = asp?.getState?.();
        const slice = fullState?.trajectorySlice;
        const totalGenLen = slice?.totalGeneratorMetadataLength ?? -1;
        const totalStepsLen = slice?.totalStepsLength ?? -1;
        const compactedSteps = fullState?.compactionInfo?.compactedAtStepIndices;
        const latestCompactedStep = Array.isArray(compactedSteps) && compactedSteps.length > 0
          ? Number(compactedSteps[compactedSteps.length - 1])
          : -1;
        const cwAfterCompact = Number(fullState?.contextWindowUsage?.estimatedAfterCompaction || 0);
        const cached = stateCache.get(cascadeId);
        const knownGenLen = totalGenLen > 0 ? totalGenLen : (knownGenLenMap.get(cascadeId) || cached?.knownGenLen || -1);
        const versionKey = `${totalGenLen}:${totalStepsLen}:${latestCompactedStep}:${cwAfterCompact}`;
        const cacheTtlMs = totalGenLen >= 0 ? 12000 : 3000;

        if (cached && cached.versionKey === versionKey && (totalGenLen >= 0 || totalStepsLen >= 0) && (Date.now() - cached.ts < cacheTtlMs)) {
          return Promise.resolve(cached);
        }

        if (inFlightStats.has(cascadeId)) {
          return inFlightStats.get(cascadeId);
        }

        const promise = (async () => {
          try {
            let parsed = null;
            let discoveredGenLen = knownGenLen;

            if (canUseLocalHttp(csrf)) {
              try {
                const callLocal = async (offset) => {
                  const r = await fetchFn('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
                    body: JSON.stringify({ cascadeId, generatorMetadataOffset: offset }),
                  });
                  if (r && r.ok !== false) {
                    const j = await r.json();
                    return j?.generatorMetadata || [];
                  }
                  return [];
                };
                const res = await fetchTailMetasBounded({
                  cascadeId,
                  totalGenLen,
                  totalStepsLen,
                  cachedGenLen: cached?.knownGenLen,
                  tailSize: 2,
                  callGenMeta: callLocal,
                });
                if (res.knownGenLen > 0) discoveredGenLen = res.knownGenLen;
                parsed = extractStatsFromMetas(res.metas);

                if (!parsed.foundCtx && discoveredGenLen > 2) {
                  const widerMetas = await callLocal(Math.max(0, discoveredGenLen - 15));
                  parsed = extractStatsFromMetas(widerMetas);
                }
              } catch {}
            }

            if ((!parsed || (!parsed.foundCtx && !parsed.foundUsage)) && typeof getRemoteRpcServiceForElement === 'function') {
              const svc = getRemoteRpcServiceForElement(inputBox);
              if (svc && typeof svc.getCascadeTrajectoryGeneratorMetadata === 'function') {
                const callRemote = async (offset) => {
                  const j = await svc.getCascadeTrajectoryGeneratorMetadata({ cascadeId, generatorMetadataOffset: offset });
                  return j?.generatorMetadata || [];
                };
                const res = await fetchTailMetasBounded({
                  cascadeId,
                  totalGenLen,
                  totalStepsLen,
                  cachedGenLen: cached?.knownGenLen,
                  tailSize: 2,
                  callGenMeta: callRemote,
                });
                if (res.knownGenLen > 0) discoveredGenLen = res.knownGenLen;
                parsed = extractStatsFromMetas(res.metas);
                if (!parsed.foundCtx && discoveredGenLen > 2) {
                  const widerMetas = await callRemote(Math.max(0, discoveredGenLen - 15));
                  parsed = extractStatsFromMetas(widerMetas);
                }
              }
              if ((!parsed || (!parsed.foundCtx && !parsed.foundUsage)) && svc && typeof svc.getCascadeTrajectory === 'function' && !svc.isRemoteControlHost) {
                const t = await svc.getCascadeTrajectory({ cascadeId });
                const metas = t?.trajectory?.generatorMetadata || [];
                if (metas.length > 0) discoveredGenLen = metas.length;
                parsed = extractStatsFromMetas(metas);
              }
            }

            parsed = applyRealtimeCompactionAndUsage(parsed, fullState);

            if (!parsed || (!parsed.foundCtx && !parsed.foundUsage && discoveredGenLen <= 0)) {
              return cached || null;
            }

            if (discoveredGenLen > 0 && typeof window !== 'undefined') {
              window.__agyRcGenLenByCascade = window.__agyRcGenLenByCascade || {};
              window.__agyRcGenLenByCascade[cascadeId] = discoveredGenLen;
            }

            const finalVersionKey = `${totalGenLen}:${totalStepsLen}:${latestCompactedStep}:${cwAfterCompact}`;
            const data = {
              used: parsed.used,
              trajectoryMax: parsed.trajectoryMax,
              cacheRead: parsed.cacheRead,
              inputTok: parsed.inputTok,
              cachePct: parsed.cachePct,
              knownGenLen: discoveredGenLen > 0 ? discoveredGenLen : undefined,
              versionKey: finalVersionKey,
              ts: Date.now(),
            };
            setBoundedCache(cascadeId, data);
            return data;
          } catch {
            return cached || null;
          } finally {
            inFlightStats.delete(cascadeId);
          }
        })();

        inFlightStats.set(cascadeId, promise);
        return promise;
      }

      return {
        fetchQuota,
        fetchCascadeStats,
        fetchTailMetasBounded,
        applyRealtimeCompactionAndUsage,
        getKnownGenLen: (cascadeId) => knownGenLenMap.get(cascadeId) || stateCache.get(cascadeId)?.knownGenLen || 0,
        getCachedStats: (cascadeId) => stateCache.get(cascadeId) || null,
        getLatestQuota: () => quotaData,
      };
    }

    module.exports = {
      getChatModelFromMeta,
      extractStatsFromMetas,
      createRpcClient,
    };

  },
  "./host-bridge": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';

    const { PRESET_CONTEXT_WINDOWS } = require('./context-window-policy');

    const COMPACT_ARGS = '현재 상황을 유지하고 이어서 작업할 수 있게 내부 컨텍스트(<CONTEXT_SUMMARY>)로만 요약해. 사용자의 요청 원문과 목표, 확정된 결정과 그 이유, 수정한 파일 경로와 핵심 변경, 실행한 검증과 결과(실패 메시지 포함), 진행 중인 작업과 남은 할 일, 사용자가 준 제약과 피드백은 빠짐없이 남기고, 끝난 탐색 과정과 긴 도구 출력은 결론만 남겨. 단, 채팅창 응답으로는 요약 내용을 다시 출력하거나 반복하지 말고 "컨텍스트 압축 완료." 한 줄만 출력하고 즉시 턴을 종료해.';

    function registerCustomCwInPrototype(cw, underDefaultCwSet, onStyleUpdate, extraWin) {
      if (!cw) return;
      const kNum = parseInt(cw, 10);
      if (!isNaN(kNum) && kNum > 0 && kNum <= 256 && underDefaultCwSet && !underDefaultCwSet.has(cw)) {
        underDefaultCwSet.add(cw);
        if (typeof onStyleUpdate === 'function') {
          try { onStyleUpdate(); } catch {}
        }
      }
      if (cw === '256K' || cw === '512K' || cw === '900K') return;
      if (isNaN(kNum) || kNum <= 0) return;
      const tokens = kNum * 1000;
      const protos = [Object.prototype];
      try {
        if (extraWin?.Object?.prototype && extraWin.Object.prototype !== Object.prototype) {
          protos.push(extraWin.Object.prototype);
        }
      } catch {}
      for (const proto of protos) {
        if (Object.prototype.hasOwnProperty.call(proto, cw)) continue;
        try {
          Object.defineProperty(proto, cw, {
            configurable: true,
            enumerable: false,
            get() {
              if (this && this['512K'] === 512000 && this['900K'] === 900000) {
                return tokens;
              }
              if (this && typeof this['512K'] === 'string' && this['512K'].indexOf('512K') !== -1) {
                return `${cw} custom context limit (${tokens.toLocaleString('en-US')} tokens)`;
              }
              return undefined;
            },
          });
        } catch {}
      }
    }

    function createHostBridge({ window, document, localStorage, fetchFn, cwStore }) {
      // Ensure context-window-selector flag is enabled in customFlagOverrides
      try {
        const raw = localStorage?.getItem('jetski.developer.customFlagOverrides');
        const flags = raw ? JSON.parse(raw) : {};
        let changed = false;
        if (flags['context-window-selector'] !== true) {
          flags['context-window-selector'] = true;
          changed = true;
        }
        if (!flags['contextWindowSelector'] || flags['contextWindowSelector'].enabled !== true) {
          flags['contextWindowSelector'] = { enabled: true };
          changed = true;
        }
        if (changed) {
          localStorage?.setItem('jetski.developer.customFlagOverrides', JSON.stringify(flags));
        }
      } catch {}

      try {
        if (window && !window.__agyLsClientDecoratorHooked) {
          window.__agyLsClientDecoratorHooked = true;
          const prevDec = window.__JETSKI_LS_CLIENT_DECORATOR__;
          window.__JETSKI_LS_CLIENT_DECORATOR__ = function (client) {
            const decorated = typeof prevDec === 'function' ? (prevDec(client) || client) : client;
            if (decorated && typeof decorated === 'object') {
              window.__agyCapturedLsClient = decorated;
              if (typeof decorated.subscribeToPlugins === 'function' && typeof decorated.getAllPlugins === 'function' && !decorated.__agyPluginsStreamPatched) {
                decorated.__agyPluginsStreamPatched = true;
                const origSub = decorated.subscribeToPlugins.bind(decorated);
                decorated.subscribeToPlugins = function (req, opts) {
                  const stream = origSub(req, opts);
                  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream;
                  return {
                    [Symbol.asyncIterator]() {
                      const it = stream[Symbol.asyncIterator]();
                      let yieldedFirst = false;
                      let pendingFirstNext = null;
                      return {
                        async next() {
                          if (!yieldedFirst) {
                            yieldedFirst = true;
                            let timer;
                            const firstPromise = it.next();
                            firstPromise.catch(() => {});
                            const raceRes = await Promise.race([
                              firstPromise.then((r) => ({ from: 'stream', r })),
                              new Promise((resolve) => {
                                timer = setTimeout(() => resolve({ from: 'timeout' }), 600);
                              }),
                            ]);
                            clearTimeout(timer);
                            if (raceRes.from === 'stream') return raceRes.r;
                            pendingFirstNext = firstPromise;
                            try {
                              const res = await decorated.getAllPlugins({ workspaceUris: [] });
                              return { done: false, value: { plugins: res?.plugins || [] } };
                            } catch {
                              const p = pendingFirstNext;
                              pendingFirstNext = null;
                              return p;
                            }
                          }
                          if (pendingFirstNext) {
                            const p = pendingFirstNext;
                            pendingFirstNext = null;
                            return p;
                          }
                          return it.next();
                        },
                        return(v) {
                          return typeof it.return === 'function' ? it.return(v) : Promise.resolve({ done: true, value: v });
                        },
                        throw(e) {
                          return typeof it.throw === 'function' ? it.throw(e) : Promise.reject(e);
                        },
                      };
                    },
                  };
                };
              }
            }
            return decorated;
          };
        }
      } catch {}

      function getAccessibleRemoteIframeWin() {
        try {
          const iframe = document?.querySelector?.('ga-remote-control iframe');
          if (!iframe || iframe.__agyCrossOriginInaccessible) return null;
          const cwin = iframe.contentWindow;
          if (!cwin) return null;
          // Probe cross-origin restriction once; if accessible, clear any stale flag
          void cwin.document;
          return cwin;
        } catch {
          try {
            const iframe = document?.querySelector?.('ga-remote-control iframe');
            if (iframe) iframe.__agyCrossOriginInaccessible = true;
          } catch {}
          return null;
        }
      }

      function getAccessibleRemoteIframeDoc() {
        try {
          const iframe = document?.querySelector?.('ga-remote-control iframe');
          if (!iframe || iframe.__agyCrossOriginInaccessible) return null;
          const cdoc = iframe.contentDocument || iframe.contentWindow?.document;
          return cdoc || null;
        } catch {
          try {
            const iframe = document?.querySelector?.('ga-remote-control iframe');
            if (iframe) iframe.__agyCrossOriginInaccessible = true;
          } catch {}
          return null;
        }
      }

      function resolveEffectiveView(view) {
        if (view && view.classList?.contains?.('agy-rc-host-view')) {
          const cdoc = getAccessibleRemoteIframeDoc();
          if (cdoc) {
            const cid = view.getAttribute('data-cascade-id');
            if (cid && cid !== 'remote-session') {
              const exact = cdoc.querySelector(`[data-testid="conversation-view"][data-cascade-id="${cid}"]`);
              if (exact) return exact;
            }
            const anyView = cdoc.querySelector('[data-testid="conversation-view"]');
            if (anyView) return anyView;
          }
        }
        return view;
      }

      function resolveEffectiveInputBox(inputBox) {
        if (inputBox && inputBox.classList?.contains?.('agy-rc-host-box')) {
          const cdoc = getAccessibleRemoteIframeDoc();
          if (cdoc) {
            const innerBox = cdoc.querySelector('[data-testid="agent-input-box"]');
            if (innerBox) return innerBox;
          }
        }
        return inputBox;
      }

      function ensureModelContextWindowOptions(modelObj, extraCw) {
        if (!modelObj || typeof modelObj !== 'object') return modelObj;
        const curArr = Array.isArray(modelObj.contextWindowOptions) ? modelObj.contextWindowOptions : [];
        const existingNames = new Set(
          curArr.map((o) => o && o.name).filter(Boolean)
        );
        const wanted = [...PRESET_CONTEXT_WINDOWS];
        if (extraCw && !wanted.includes(extraCw)) {
          wanted.push(extraCw);
        }
        const toAdd = [];
        for (const cw of wanted) {
          if (!existingNames.has(cw)) {
            const limit = cwStore ? cwStore.getLimit(cw) : 256000;
            const hint = cwStore ? cwStore.getQuotaHint(cw) : cw;
            toAdd.push({
              name: cw,
              description: hint,
              expensive: limit > 256000,
            });
            existingNames.add(cw);
          }
        }
        if (toAdd.length === 0 && Array.isArray(modelObj.contextWindowOptions)) {
          return modelObj;
        }
        const nextArr = [...curArr, ...toAdd];
        try {
          if (Array.isArray(modelObj.contextWindowOptions) && Object.isExtensible(modelObj.contextWindowOptions)) {
            modelObj.contextWindowOptions.push(...toAdd);
          } else {
            modelObj.contextWindowOptions = nextArr;
          }
        } catch {}
        try {
          const proto = Object.getPrototypeOf(modelObj);
          if (proto && proto !== Object.prototype) {
            const clone = Object.assign(Object.create(proto), modelObj, { contextWindowOptions: nextArr });
            return clone;
          }
          return { ...modelObj, contextWindowOptions: nextArr };
        } catch {
          return modelObj;
        }
      }

      function ensureContextWindowSelectorFlag(extraCw) {
        ensureFetchHook(window);
        const cwin = getAccessibleRemoteIframeWin();
        if (cwin) ensureFetchHook(cwin);
        if (!document) return;
        const docs = [document, getAccessibleRemoteIframeDoc()].filter(Boolean);
        for (const d of docs) {
          const views = d.querySelectorAll('[data-testid="conversation-view"]');
          for (const view of views) {
            const triggerEl = view.querySelector?.('[data-testid="model-selector-trigger"]');
            const startNodes = [triggerEl, view].filter(Boolean);
            for (const node of startNodes) {
              const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
              let fiber = fk ? node[fk] : null;
              while (fiber) {
                const val = fiber.memoizedProps?.value;
                if (val && typeof val === 'object') {
                  if (typeof val.get === 'function' && !val.__cwsPatched) {
                    try {
                      const origGet = val.get;
                      val.get = function (name) {
                        if (name === 'contextWindowSelector') {
                          return { enabled: true, feature: { enabled: true } };
                        }
                        return origGet.apply(this, arguments);
                      };
                      val.__cwsPatched = true;
                    } catch {}
                  }
                  if ('corpHost' in val && 'cider' in val && 'contextWindow' in val && val.contextWindow === undefined) {
                    try { val.contextWindow = {}; } catch {}
                  }
                  if (val.selectedModel && typeof val.selectedModel === 'object') {
                    const nextSm = ensureModelContextWindowOptions(val.selectedModel, extraCw);
                    if (nextSm !== val.selectedModel) {
                      try { val.selectedModel = nextSm; } catch {}
                    }
                  }
                  if (Array.isArray(val.modelOptions)) {
                    if (Object.isExtensible(val.modelOptions)) {
                      for (let i = 0; i < val.modelOptions.length; i++) {
                        const nextOpt = ensureModelContextWindowOptions(val.modelOptions[i], extraCw);
                        if (nextOpt !== val.modelOptions[i]) {
                          try { val.modelOptions[i] = nextOpt; } catch {}
                        }
                      }
                    } else {
                      try {
                        val.modelOptions = val.modelOptions.map((opt) => ensureModelContextWindowOptions(opt, extraCw));
                      } catch {}
                    }
                  }
                  if (val.store && typeof val.store.getState === 'function') {
                    const st = val.store.getState();
                    const clientConfigs = st?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
                    if (Array.isArray(clientConfigs)) {
                      let needsReduxUpdate = false;
                      const updatedConfigs = [];
                      for (const cfg of clientConfigs) {
                        const nextCfg = ensureModelContextWindowOptions(cfg, extraCw);
                        updatedConfigs.push(nextCfg);
                        if (nextCfg !== cfg) {
                          needsReduxUpdate = true;
                        }
                      }
                      if (needsReduxUpdate && typeof val.store.dispatch === 'function') {
                        try {
                          val.store.dispatch({
                            type: 'userStatus/setUserStatus',
                            payload: {
                              ...st.userStatus,
                              cascadeModelConfigData: {
                                ...st.userStatus.cascadeModelConfigData,
                                clientModelConfigs: updatedConfigs,
                              },
                            },
                          });
                        } catch {}
                      }
                    }
                  }
                }
                fiber = fiber.return;
              }
            }
          }
        }
      }

      function ensureCustomizationsStoreLoaded() {
        if (!document) return;
        const docs = [document, getAccessibleRemoteIframeDoc()].filter(Boolean);
        for (const d of docs) {
          const views = d.querySelectorAll?.('[data-testid="conversation-view"]') || [];
          const rootEl = d.querySelector?.('#root, #app') || d.body?.firstElementChild;
          const startNodes = [...views, rootEl].filter(Boolean);
          for (const node of startNodes) {
            const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
            const startFiber = fk ? node[fk] : null;
            if (!startFiber) continue;
            let up = startFiber;
            let foundStore = null;
            while (up) {
              const val = up.memoizedProps?.value;
              if (val && typeof val === 'object' && val.state && typeof val.receiveStreamedPlugins === 'function' && typeof val.refresh === 'function') {
                foundStore = val;
                break;
              }
              up = up.return;
            }
            if (!foundStore && node === rootEl) {
              const stack = [startFiber];
              const visited = new Set();
              while (stack.length > 0 && visited.size < 2500) {
                const f = stack.pop();
                if (!f || visited.has(f)) continue;
                visited.add(f);
                const val = f.memoizedProps?.value;
                if (val && typeof val === 'object' && val.state && typeof val.receiveStreamedPlugins === 'function' && typeof val.refresh === 'function') {
                  foundStore = val;
                  break;
                }
                if (f.sibling) stack.push(f.sibling);
                if (f.child) stack.push(f.child);
              }
            }
            if (foundStore) {
              try {
                if (typeof foundStore.disableStreaming === 'function' && !foundStore.streamingDisabled) {
                  foundStore.disableStreaming();
                }
                const st = typeof foundStore.state?.getState === 'function' ? foundStore.state.getState() : null;
                if ((!foundStore.hasReceivedStreamSnapshot || st?.isLoadingPlugins) && !foundStore.__agyInitialRefreshTriggered) {
                  foundStore.__agyInitialRefreshTriggered = true;
                  Promise.resolve(foundStore.refresh()).catch(() => {
                    foundStore.__agyInitialRefreshTriggered = false;
                  });
                }
              } catch {}
              break;
            }
          }
        }
      }

      function getModelSelectorContextForView(view, extraCw) {
        ensureContextWindowSelectorFlag(extraCw);
        const effView = resolveEffectiveView(view);
        if (!effView) return null;
        const triggerEl = effView.querySelector('[data-testid="model-selector-trigger"]');
        const startEl = triggerEl || effView;
        const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
        let fiber = fk ? startEl[fk] : null;
        let msCtx = null;
        let setSelectedModelWithCw = null;
        let reduxStore = null;
        let legacyCtx = null;
        while (fiber) {
          const props = fiber.memoizedProps;
          if (!setSelectedModelWithCw && typeof props?.setSelectedModel === 'function' && props.setSelectedModel.length >= 2) {
            setSelectedModelWithCw = props.setSelectedModel;
          }
          const val = props?.value;
          if (val && typeof val === 'object') {
            if (!msCtx && typeof val.setSelectedModel === 'function' && ('selectedModel' in val)) {
              msCtx = val;
            }
            if (!setSelectedModelWithCw && typeof val.setSelectedModel === 'function' && val.setSelectedModel.length >= 2) {
              setSelectedModelWithCw = val.setSelectedModel;
            }
            if (!reduxStore && val.store && typeof val.store.dispatch === 'function' && typeof val.store.getState === 'function') {
              reduxStore = val.store;
            }
            if (!legacyCtx && typeof val.setModelForConversation === 'function') {
              legacyCtx = val;
            }
          }
          fiber = fiber.return;
        }
        if (msCtx?.selectedModel) {
          ensureModelContextWindowOptions(msCtx.selectedModel, extraCw);
        }
        return { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl };
      }

      function getCascadeContextForElement(el) {
        const effEl = resolveEffectiveInputBox(resolveEffectiveView(el));
        const candidates = [
          effEl,
          effEl?.closest?.('[data-testid="conversation-view"]'),
          document?.querySelector?.('[data-testid="conversation-view"]'),
        ].filter(Boolean);
        for (const node of candidates) {
          const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
          let curr = fk ? node[fk] : null;
          while (curr) {
            const val = curr.memoizedProps?.value;
            if (val?.cascadeContext?.state?.agentStateProvider) {
              return val.cascadeContext;
            }
            if (val?.state?.agentStateProvider && (val?.debug || val?.cascadeContext !== undefined || val?.state)) {
              return val;
            }
            curr = curr.return;
          }
        }
        return null;
      }

      const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const PROTO_UUID_RE = /\x0a\x24([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
      const CONVO_RPC_RE = /\/(StreamAgentStateUpdates|RequestAgentStatePageUpdate|StreamCascadeReactiveUpdates|GetCascadeTrajectory|GetCascadeTrajectorySteps|GetCascadeTrajectoryGeneratorMetadata|GetCascadeModelConfigData|SendUserCascadeMessage|UpdateConversationAnnotations|StartCascade)$/i;
      let lastRcTrajectoryPollTs = 0;
      let rcTrajectoryPollInFlight = false;

      function toUint8Slice(body) {
        if (!body) return null;
        if (body instanceof Uint8Array) return body;
        if (body instanceof ArrayBuffer) return new Uint8Array(body);
        if (ArrayBuffer.isView(body)) {
          return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength ?? body.buffer.byteLength);
        }
        if (body.buffer instanceof ArrayBuffer) {
          return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength ?? body.buffer.byteLength);
        }
        return null;
      }

      function decodeBytesToText(body) {
        if (!body) return '';
        if (typeof body === 'string') return body;
        try {
          const TD = window?.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
          if (TD) {
            const u8 = toUint8Slice(body) || new Uint8Array(body);
            return new TD('utf-8').decode(u8);
          }
        } catch {}
        return '';
      }

      function encodeTextToBytes(str) {
        const TE = window?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
        if (TE) return new TE().encode(str);
        return Uint8Array.from(String(str).split('').map((c) => c.charCodeAt(0) & 0xff));
      }

      function decodeBase64ToUtf8(b64) {
        if (!b64 || typeof b64 !== 'string') return '';
        try {
          if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
            return Buffer.from(b64, 'base64').toString('utf8');
          }
          const atobFn = window?.atob || (typeof atob === 'function' ? atob : null);
          if (atobFn) {
            const bin = atobFn(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
            return decodeBytesToText(bytes);
          }
        } catch {}
        return '';
      }

      function encodeVarint(val) {
        const out = [];
        let v = Math.max(0, Math.floor(Number(val) || 0)) >>> 0;
        while (v >= 0x80) {
          out.push((v & 0x7f) | 0x80);
          v >>>= 7;
        }
        out.push(v & 0x7f);
        return out;
      }

      function buildSendMessageCheckpointSuffix(maxTokenLimit, contextWindow) {
        // CheckpointConfig: field 5 (max_token_limit, uint32 varint) -> wire tag 0x28
        const cpBytes = [0x28, ...encodeVarint(maxTokenLimit)];
        if (contextWindow && typeof contextWindow === 'string') {
          // CheckpointConfig: field 36 (context_window, string) -> wire tag (36 << 3) | 2 = 0x122 -> varint [0xa2, 0x02]
          const cwBytes = Array.from(encodeTextToBytes(contextWindow));
          cpBytes.push(0xa2, 0x02, ...encodeVarint(cwBytes.length), ...cwBytes);
        }
        // CascadeConfig: field 2 (checkpoint_config, bytes) -> wire tag 0x12
        const ccBytes = [0x12, ...encodeVarint(cpBytes.length), ...cpBytes];
        // SendUserCascadeMessageRequest: field 5 (cascade_config, bytes) -> wire tag 0x2a
        return new Uint8Array([0x2a, ...encodeVarint(ccBytes.length), ...ccBytes]);
      }

      function resolveEffectiveCascadeId(body, rcInst) {
        const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
        const fromBody = extractCascadeIdFromBody(body, ignoreUuid);
        if (fromBody) return fromBody;
        if (window?.__agySniffedCascadeId && window.__agySniffedCascadeId !== 'remote-session') {
          return window.__agySniffedCascadeId;
        }
        const activeView = document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
        const domCid = activeView?.getAttribute?.('data-cascade-id');
        if (domCid && domCid !== 'remote-session') return domCid;
        return null;
      }

      function findFirstNonWsByte(u8) {
        if (!u8 || u8.length === 0) return -1;
        let i = 0;
        // Skip UTF-8 BOM (EF BB BF) if present
        if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
          i = 3;
        }
        while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x09 || u8[i] === 0x0a || u8[i] === 0x0d)) {
          i++;
        }
        return i < u8.length ? u8[i] : -1;
      }

      function endsWithByteSequence(u8, seq) {
        if (!u8 || !seq || u8.length < seq.length) return false;
        const offset = u8.length - seq.length;
        for (let i = 0; i < seq.length; i++) {
          if (u8[offset + i] !== seq[i]) return false;
        }
        return true;
      }

      function buildConnectFramedBytes(flagByte, payloadBytes) {
        const len = payloadBytes.length;
        const framed = new Uint8Array(5 + len);
        framed[0] = flagByte & 0xff;
        framed[1] = (len >>> 24) & 0xff;
        framed[2] = (len >>> 16) & 0xff;
        framed[3] = (len >>> 8) & 0xff;
        framed[4] = len & 0xff;
        framed.set(payloadBytes, 5);
        return framed;
      }

      function injectCheckpointLimitIntoSendRequest(path, body, rcInst) {
        if (typeof path !== 'string' || !/\/SendUserCascadeMessage$/i.test(path) || !body || !cwStore) {
          return body;
        }
        try {
          const cid = resolveEffectiveCascadeId(body, rcInst);
          const cw = cwStore.getSavedContextWindow(cid);
          const limit = cwStore.getLimit(cw);
          if (!cw || !limit || limit <= 0) return body;

          const applyCheckpointToJsonObj = (j) => {
            if (!j || typeof j !== 'object') return j;
            j.cascadeConfig = j.cascadeConfig || {};
            j.cascadeConfig.checkpointConfig = {
              ...(j.cascadeConfig.checkpointConfig || {}),
              contextWindow: cw,
              maxTokenLimit: limit,
            };
            return j;
          };

          if (typeof body === 'string') {
            const trimmed = body.trim();
            if (trimmed.startsWith('{')) {
              const j = applyCheckpointToJsonObj(JSON.parse(trimmed));
              return JSON.stringify(j);
            }
            return body;
          }

          const u8 = toUint8Slice(body);
          if (!u8) {
            if (typeof body === 'object') {
              const cloned = typeof body.clone === 'function'
                ? body.clone()
                : Object.assign(Object.create(Object.getPrototypeOf(body)), body);
              const prevCc = body.cascadeConfig;
              const nextCc = prevCc && typeof prevCc === 'object'
                ? (typeof prevCc.clone === 'function' ? prevCc.clone() : Object.assign(Object.create(Object.getPrototypeOf(prevCc)), prevCc))
                : {};
              const prevCp = prevCc?.checkpointConfig;
              const nextCp = prevCp && typeof prevCp === 'object'
                ? (typeof prevCp.clone === 'function' ? prevCp.clone() : Object.assign(Object.create(Object.getPrototypeOf(prevCp)), prevCp))
                : {};
              nextCp.contextWindow = cw;
              nextCp.maxTokenLimit = limit;
              nextCc.checkpointConfig = nextCp;
              cloned.cascadeConfig = nextCc;
              return cloned;
            }
            return body;
          }
          if (u8.length === 0) return body;

          // 1. Unframed UTF-8 JSON bytes (`{...}`)
          if (findFirstNonWsByte(u8) === 0x7b) {
            const text = decodeBytesToText(u8);
            const j = applyCheckpointToJsonObj(JSON.parse(text));
            return encodeTextToBytes(JSON.stringify(j));
          }

          const suffix = buildSendMessageCheckpointSuffix(limit, cw);

          // Strip any previously injected trailing 0x2a cascade_config suffix (`[0x2a, ccLen, 0x12, cpLen, 0x28, ...]`)
          const stripTrailingCheckpointSuffix = (bytes) => {
            if (!bytes || bytes.length < 7) return bytes;
            for (let pos = Math.max(0, bytes.length - 32); pos <= bytes.length - 7; pos++) {
              if (bytes[pos] === 0x2a && bytes[pos + 2] === 0x12 && bytes[pos + 4] === 0x28) {
                const ccLen = bytes[pos + 1];
                const cpLen = bytes[pos + 3];
                if (pos + 2 + ccLen === bytes.length && ccLen === cpLen + 2) {
                  return bytes.subarray(0, pos);
                }
              }
            }
            return bytes;
          };

          // 2. Connect-RPC / gRPC-Web 5-byte framed envelope (`[flags(1B), length(4B), payload]`)
          // In Protobuf wire format, field number 0 (`(u8[0] >>> 3) === 0`, i.e., `u8[0] < 8`) is never a valid unframed message start!
          // Also flag bit 0x80 (e.g. `0x80` trailer frame) or any frame matching `frameLen === u8.length - 5` is a Connect/gRPC-Web frame.
          const frameLen = u8.length >= 5
            ? (((u8[1] << 24) >>> 0) + (u8[2] << 16) + (u8[3] << 8) + u8[4])
            : -1;
          const isConnectFrame = u8.length >= 5 && (u8[0] < 8 || (u8[0] & 0x80) !== 0 || frameLen === u8.length - 5);
          if (isConnectFrame) {
            if (frameLen !== u8.length - 5 || u8[0] !== 0) {
              // Compressed, trailer, end-stream (`u8[0] > 0`), or incomplete/multi-frame Connect envelope: never append raw bytes
              return body;
            }
            const payload = u8.subarray(5);
            if (findFirstNonWsByte(payload) === 0x7b) {
              // Connect-Framed JSON (`0x00` + 4B len + `{"cascadeId":...}`)!
              // Parse JSON, inject checkpointConfig, re-encode JSON, and update 5-byte frame header length!
              const text = decodeBytesToText(payload);
              const j = applyCheckpointToJsonObj(JSON.parse(text));
              const newPayload = encodeTextToBytes(JSON.stringify(j));
              return buildConnectFramedBytes(0, newPayload);
            }
            if (endsWithByteSequence(payload, suffix)) {
              return body;
            }
            const cleanPayload = stripTrailingCheckpointSuffix(payload);
            const newPayload = new Uint8Array(cleanPayload.length + suffix.length);
            newPayload.set(cleanPayload, 0);
            newPayload.set(suffix, cleanPayload.length);
            return buildConnectFramedBytes(0, newPayload);
          }

          // 3. Unframed Protobuf binary (idempotent guard against double injection or limit change)
          if (endsWithByteSequence(u8, suffix)) {
            return body;
          }
          const cleanU8 = stripTrailingCheckpointSuffix(u8);
          const merged = new Uint8Array(cleanU8.length + suffix.length);
          merged.set(cleanU8, 0);
          merged.set(suffix, cleanU8.length);
          return merged;
        } catch {
          return body;
        }
      }

      window.__agyInjectCheckpointLimit = injectCheckpointLimitIntoSendRequest;
      window.__agySniffCascadeFromRpc = sniffCascadeIdFromRpc;

      function ensureFetchHook(targetWin) {
        try {
          const w = targetWin || window;
          if (!w || typeof w.fetch !== 'function') return;
          w.__agyInjectCheckpointLimit = injectCheckpointLimitIntoSendRequest;
          w.__agySniffCascadeFromRpc = sniffCascadeIdFromRpc;
          if (w.fetch.__agyCwHookV2) return;
          const prevFetch = w.__agyOrigFetch || w.fetch;
          const isLegacyV1Hook = Boolean(prevFetch.__agyCwHooked && !prevFetch.__agyCwHookV2);
          if (!isLegacyV1Hook && !w.__agyOrigFetch) {
            w.__agyOrigFetch = prevFetch;
          }
          const wrappedFetch = function (input, init) {
            let nextInput = input;
            let nextInit = init;
            try {
              const url = typeof input === 'string'
                ? input
                : (input && typeof input.url === 'string'
                  ? input.url
                  : (input && typeof input.href === 'string' ? input.href : ''));
              const sniffFn = w.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
              const injectFn = w.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
              if (url && CONVO_RPC_RE.test(url)) {
                if (nextInit && nextInit.body) {
                  sniffFn(url, nextInit.body, null);
                  if (/\/SendUserCascadeMessage$/i.test(url)) {
                    nextInit = { ...nextInit, body: injectFn(url, nextInit.body, null) };
                    // If wrapping over a legacy v1.3.8 hook in an un-reloaded window, pass a URL object
                    // so v1.3.8's `typeof input === 'string' || typeof input.url === 'string'` check is bypassed!
                    if (isLegacyV1Hook && typeof URL === 'function') {
                      try {
                        nextInput = new URL(url, w.location?.href || 'http://127.0.0.1');
                      } catch {}
                    }
                  }
                } else if (input && typeof input === 'object' && typeof input.arrayBuffer === 'function' && typeof input.clone === 'function' && /\/SendUserCascadeMessage$/i.test(url)) {
                  return input.clone().arrayBuffer().then((ab) => {
                    const rawBytes = new Uint8Array(ab);
                    sniffFn(url, rawBytes, null);
                    const injectedBody = injectFn(url, rawBytes, null);
                    const ReqCtor = w.Request || (typeof Request === 'function' ? Request : null);
                    if (ReqCtor) {
                      return prevFetch.call(this, new ReqCtor(input, { body: injectedBody }), nextInit);
                    }
                    return prevFetch.call(this, nextInput, { ...(nextInit || {}), body: injectedBody });
                  }).catch(() => prevFetch.call(this, nextInput, nextInit));
                }
              }
            } catch {}
            return prevFetch.call(this, nextInput, nextInit);
          };
          wrappedFetch.__agyCwHooked = true;
          wrappedFetch.__agyCwHookV2 = true;
          w.fetch = wrappedFetch;
        } catch {}
      }

      function hookLsClient(lsClient) {
        if (!lsClient || typeof lsClient !== 'object') return lsClient;
        if (lsClient.__agyCwHookV2) return lsClient;
        try {
          lsClient.__agyCwHooked = true;
          lsClient.__agyCwHookV2 = true;
          if (typeof lsClient.sendUserCascadeMessage === 'function') {
            const origSend = lsClient.__agyOrigSendUserCascadeMessage || lsClient.sendUserCascadeMessage;
            lsClient.__agyOrigSendUserCascadeMessage = origSend;
            lsClient.sendUserCascadeMessage = function (req, ...rest) {
              const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
              const nextReq = injectFn(
                '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
                req,
                null
              );
              return origSend.call(this, nextReq, ...rest);
            };
          }
        } catch {}
        return lsClient;
      }

      function extractCascadeIdFromBody(body, ignoreUuid) {
        const u8 = toUint8Slice(body);
        if (!u8 && body && typeof body === 'object') {
          const cid = body.cascadeId || body.conversationId;
          if (typeof cid === 'string' && UUID_RE.test(cid) && cid !== ignoreUuid) return cid;
        }
        let targetBody = u8 || body;
        if (u8 && u8.length >= 5 && u8[0] === 0) {
          const frameLen = ((u8[1] << 24) >>> 0) + (u8[2] << 16) + (u8[3] << 8) + u8[4];
          if (frameLen === u8.length - 5) {
            targetBody = u8.subarray(5);
          }
        }
        const text = decodeBytesToText(targetBody);
        if (!text) return null;
        const trimmed = text.trim();
        if (trimmed.startsWith('{')) {
          try {
            const j = JSON.parse(trimmed);
            const cid = j.cascadeId || j.conversationId;
            if (typeof cid === 'string' && UUID_RE.test(cid) && cid !== ignoreUuid) return cid;
          } catch {}
        }
        const pm = text.match(PROTO_UUID_RE);
        if (pm && pm[1] && pm[1] !== ignoreUuid) return pm[1];
        const um = text.match(UUID_RE);
        if (um && um[0] && um[0] !== ignoreUuid) return um[0];
        return null;
      }

      function sniffCascadeIdFromRpc(path, body, rcInst) {
        if (typeof path !== 'string' || !CONVO_RPC_RE.test(path)) return;
        const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
        const cid = extractCascadeIdFromBody(body, ignoreUuid);
        if (cid) {
          const changed = window.__agySniffedCascadeId !== cid;
          window.__agySniffedCascadeId = cid;
          window.__agySniffedCascadeTs = Date.now();
          if (/\/(SendUserCascadeMessage|StartCascade|StreamCascadeReactiveUpdates|StreamAgentStateUpdates)$/i.test(path)) {
            lastRcTrajectoryPollTs = 0;
            if (/\/(SendUserCascadeMessage|StartCascade)$/i.test(path)) {
              window.__agyRcStepCountByCascade = window.__agyRcStepCountByCascade || {};
              window.__agyRcStepCountByCascade[cid] = (window.__agyRcStepCountByCascade[cid] || 0) + 1;
            }
            setTimeout(() => {
              lastRcTrajectoryPollTs = 0;
              if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(cid);
            }, 1200);
          }
          if (changed && typeof window.__agyOnCascadeSniffed === 'function') {
            window.__agyOnCascadeSniffed(cid);
          }
        }
      }

      function hookRemoteControlPrototype(proto) {
        if (!proto || proto.__agyHookV2) return;
        proto.__agyHooked = true;
        proto.__agyHookV2 = true;

        if (typeof proto.handleIframeMessage === 'function') {
          const origMsg = proto.__agyOrigHandleIframeMessage || proto.handleIframeMessage;
          proto.__agyOrigHandleIframeMessage = origMsg;
          proto.handleIframeMessage = function (ev) {
            window.__agyRemoteControlInstance = this;
            if (ev && ev.data === '__agy_probe__') return;
            if (ev && ev.data && typeof ev.data.path === 'string') {
              const ignoreUuid = typeof this.selectedInstanceUuid === 'function' ? this.selectedInstanceUuid() : '';
              const m = ev.data.path.match(UUID_RE);
              if (m && m[0] && m[0] !== ignoreUuid && window.__agySniffedCascadeId !== m[0]) {
                window.__agySniffedCascadeId = m[0];
                window.__agySniffedCascadeTs = Date.now();
                if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(m[0]);
              }
            }
            return origMsg.apply(this, arguments);
          };
        }

        for (const mName of ['proxyCommand', 'streamProxyCommand']) {
          if (typeof proto[mName] === 'function') {
            const origKey = `__agyOrig_${mName}`;
            const origFn = proto[origKey] || proto[mName];
            proto[origKey] = origFn;
            proto[mName] = function (path, body, ...rest) {
              window.__agyRemoteControlInstance = this;
              const sniffFn = window?.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
              const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
              sniffFn(path, body, this);
              const nextBody = injectFn(path, body, this);
              return origFn.call(this, path, nextBody, ...rest);
            };
          }
        }

        if (typeof proto.handlePortRequest === 'function') {
          const origPort = proto.__agyOrigHandlePortRequest || proto.handlePortRequest;
          proto.__agyOrigHandlePortRequest = origPort;
          proto.handlePortRequest = function (msg) {
            window.__agyRemoteControlInstance = this;
            if (msg && typeof msg.path === 'string') {
              const sniffFn = window?.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
              const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
              sniffFn(msg.path, msg.body, this);
              if (/\/SendUserCascadeMessage$/i.test(msg.path) && msg.body) {
                msg = { ...msg, body: injectFn(msg.path, msg.body, this) };
              }
            }
            return origPort.call(this, msg);
          };
        }
        for (const mName of [
          'managePolling',
          'shouldPoll',
          'loadInstances',
          'isDisconnected',
          'onIframeLoad',
          'onWindowOnline',
          'onWindowOffline',
          'isOffline',
          'isDirectIngressMode',
          'isTabHidden',
          'getSelectedInstance',
          'instanceInfos',
          'remoteConversationsInfos',
        ]) {
          if (typeof proto[mName] === 'function') {
            const origKey = `__agyOrig_${mName}`;
            const origFn = proto[origKey] || proto[mName];
            proto[origKey] = origFn;
            proto[mName] = function () {
              if (this && !this.destroyed) {
                window.__agyRemoteControlInstance = this;
              }
              return origFn.apply(this, arguments);
            };
          }
        }
      }

      function getRemoteControlInstance(onCascadeChange) {
        if (typeof onCascadeChange === 'function') {
          window.__agyOnCascadeSniffed = onCascadeChange;
        }
        if (window?.__agyRemoteControlInstance && !window.__agyRemoteControlInstance.destroyed) {
          hookRemoteControlPrototype(Object.getPrototypeOf(window.__agyRemoteControlInstance));
          return window.__agyRemoteControlInstance;
        }

        const isRcInstance = (obj) =>
          Boolean(
            obj &&
              typeof obj === 'object' &&
              !obj.destroyed &&
              (typeof obj.proxyCommand === 'function' ||
                typeof obj.onIframeLoad === 'function' ||
                typeof obj.handleIframeMessage === 'function')
          );

        const extractFromLContext = (lCtx) => {
          if (!lCtx || typeof lCtx !== 'object') return null;
          if (isRcInstance(lCtx)) return lCtx;
          if (isRcInstance(lCtx.component)) return lCtx.component;
          const lView = lCtx.lView;
          if (Array.isArray(lView)) {
            try {
              const tView = lView[1];
              const nodeIndex = typeof lCtx.nodeIndex === 'number' ? lCtx.nodeIndex : -1;
              const tNode = nodeIndex >= 0 && Array.isArray(tView?.data) ? tView.data[nodeIndex] : null;
              if (
                tNode &&
                typeof tNode.directiveStart === 'number' &&
                typeof tNode.componentOffset === 'number' &&
                tNode.componentOffset > -1
              ) {
                const comp = lView[tNode.directiveStart + tNode.componentOffset];
                if (isRcInstance(comp)) return comp;
              }
            } catch {}
            for (let i = 0; i < Math.min(lView.length, 300); i++) {
              if (isRcInstance(lView[i])) return lView[i];
            }
          }
          return null;
        };

        const searchNgContext = (ctx) => {
          if (!ctx || typeof ctx !== 'object') return null;
          const direct = extractFromLContext(ctx);
          if (direct) return direct;
          const visited = new Set();
          const queue = [ctx];
          let steps = 0;
          while (queue.length > 0 && steps < 400) {
            const cur = queue.shift();
            if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
            visited.add(cur);
            steps++;
            const extracted = extractFromLContext(cur);
            if (extracted) return extracted;
            if (Array.isArray(cur)) {
              const scanLen = Math.min(cur.length, 300);
              for (let i = 0; i < scanLen; i++) {
                if (isRcInstance(cur[i])) return cur[i];
              }
              for (let i = 0; i < scanLen; i++) {
                const item = cur[i];
                if (item && typeof item === 'object' && (Array.isArray(item) || isRcInstance(item.component))) {
                  queue.push(item);
                }
              }
            } else {
              for (const k of ['component', 'lView', 'data', 'context', '_lView']) {
                if (cur[k] && typeof cur[k] === 'object') queue.push(cur[k]);
              }
            }
          }
          return null;
        };

        const rcEl = document?.querySelector?.('ga-remote-control') || null;
        const gaRootEl = document?.querySelector?.('ga-root') || null;

        if (rcEl) {
          const ngFn = window?.ng && typeof window.ng.getComponent === 'function' ? window.ng.getComponent : null;
          if (ngFn) {
            try {
              const comp = ngFn(rcEl);
              if (isRcInstance(comp)) {
                window.__agyRemoteControlInstance = comp;
                hookRemoteControlPrototype(Object.getPrototypeOf(comp));
                return comp;
              }
            } catch {}
          }
          const ctxKey = Object.keys(rcEl).find((k) => k.startsWith('__ngContext'));
          const found = searchNgContext(rcEl.__ngContext__ || (ctxKey ? rcEl[ctxKey] : null));
          if (found) {
            window.__agyRemoteControlInstance = found;
            hookRemoteControlPrototype(Object.getPrototypeOf(found));
            return found;
          }
        }

        if (gaRootEl) {
          const rootCtxKey = Object.keys(gaRootEl).find((k) => k.startsWith('__ngContext'));
          const foundFromRoot = searchNgContext(gaRootEl.__ngContext__ || (rootCtxKey ? gaRootEl[rootCtxKey] : null));
          if (foundFromRoot) {
            window.__agyRemoteControlInstance = foundFromRoot;
            hookRemoteControlPrototype(Object.getPrototypeOf(foundFromRoot));
            return foundFromRoot;
          }
        }

        const nsRoot = window?.default_GoogleAntigravity;
        if (nsRoot && typeof nsRoot === 'object') {
          const targetCandidates = [];
          if (rcEl) {
            targetCandidates.push(rcEl);
            if (rcEl.firstElementChild) targetCandidates.push(rcEl.firstElementChild);
            if (typeof rcEl.querySelector === 'function') {
              const innerContainer = rcEl.querySelector('.app-container, .iframe-panel, iframe');
              if (innerContainer && !targetCandidates.includes(innerContainer)) {
                targetCandidates.push(innerContainer);
              }
            }
          }
          if (gaRootEl) {
            targetCandidates.push(gaRootEl);
            if (gaRootEl.firstElementChild) targetCandidates.push(gaRootEl.firstElementChild);
          }

          for (const k of Object.keys(nsRoot)) {
            const mod = nsRoot[k];
            if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
            for (const targetEl of targetCandidates) {
              if (!targetEl) continue;
              try {
                if (typeof mod.getDebugNode === 'function') {
                  const dbgNode = mod.getDebugNode(targetEl);
                  const dbgComp = dbgNode?.componentInstance || dbgNode?.context;
                  if (isRcInstance(dbgComp)) {
                    window.__agyRemoteControlInstance = dbgComp;
                    hookRemoteControlPrototype(Object.getPrototypeOf(dbgComp));
                    return dbgComp;
                  }
                  const foundFromDbg = searchNgContext(dbgComp || dbgNode);
                  if (foundFromDbg) {
                    window.__agyRemoteControlInstance = foundFromDbg;
                    hookRemoteControlPrototype(Object.getPrototypeOf(foundFromDbg));
                    return foundFromDbg;
                  }
                }
                if (typeof mod.getComponent === 'function') {
                  const comp = mod.getComponent(targetEl);
                  if (isRcInstance(comp)) {
                    window.__agyRemoteControlInstance = comp;
                    hookRemoteControlPrototype(Object.getPrototypeOf(comp));
                    return comp;
                  }
                }
                const getLCtx = mod['\u0275getLContext'] || mod.getLContext;
                if (typeof getLCtx === 'function') {
                  const lCtx = getLCtx(targetEl);
                  const foundFromLCtx = extractFromLContext(lCtx) || searchNgContext(lCtx?.lView || lCtx);
                  if (foundFromLCtx) {
                    window.__agyRemoteControlInstance = foundFromLCtx;
                    hookRemoteControlPrototype(Object.getPrototypeOf(foundFromLCtx));
                    return foundFromLCtx;
                  }
                }
              } catch {}
            }
            const RC = mod.RemoteControlComponent || (typeof mod.prototype?.proxyCommand === 'function' ? mod : null);
            if (RC && RC.prototype && typeof RC.prototype.proxyCommand === 'function') {
              hookRemoteControlPrototype(RC.prototype);
            }
          }
        }

        try {
          if (!window?.__agyRemoteControlInstance && typeof document?.dispatchEvent === 'function') {
            const BaseEvt = window?.Event || (typeof Event !== 'undefined' ? Event : null);
            if (BaseEvt) {
              document.dispatchEvent(new BaseEvt('visibilitychange'));
            }
          }
          if (!window?.__agyRemoteControlInstance && typeof window?.dispatchEvent === 'function') {
            const Evt = window.MessageEvent || (typeof MessageEvent !== 'undefined' ? MessageEvent : null);
            if (Evt) {
              window.dispatchEvent(new Evt('message', { data: '__agy_probe__' }));
            }
          }
        } catch {}

        return (window?.__agyRemoteControlInstance && !window.__agyRemoteControlInstance.destroyed)
          ? window.__agyRemoteControlInstance
          : null;
      }

      function createRcServiceAdapter(rcInst) {
        async function callJson(rpcPath, reqObj) {
          if (!rcInst || typeof rcInst.proxyCommand !== 'function') return null;
          const payloadObj = /\/SendUserCascadeMessage$/i.test(rpcPath)
            ? injectCheckpointLimitIntoSendRequest(rpcPath, reqObj || {}, rcInst)
            : (reqObj || {});
          const bytes = encodeTextToBytes(JSON.stringify(payloadObj));
          const res = await rcInst.proxyCommand(rpcPath, bytes);
          if (!res || !res.payload) return null;
          const text = decodeBytesToText(res.payload);
          return text ? JSON.parse(text) : null;
        }
        return {
          isRemoteControlHost: true,
          rcInst,
          callJson,
          async retrieveUserQuotaSummary(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', req || {});
          },
          async getCascadeTrajectoryGeneratorMetadata(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', req || {});
          },
          async getCascadeTrajectory(req) {
            const metaRes = await callJson('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
              cascadeId: req?.cascadeId,
              generatorMetadataOffset: req?.generatorMetadataOffset || 0,
            });
            if (metaRes && Array.isArray(metaRes.generatorMetadata)) {
              return { trajectory: { generatorMetadata: metaRes.generatorMetadata } };
            }
            return await callJson('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', req || {});
          },
          async getAllCascadeTrajectories() {
            return await callJson('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {});
          },
          async updateConversationAnnotations(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', req || {});
          },
          async sendUserCascadeMessage(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', req || {});
          },
          async getCustomizationStates(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/GetCustomizationStates', req || {});
          },
          async getAllSkills(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/GetAllSkills', req || {});
          },
          async getAllPlugins(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/GetAllPlugins', req || {});
          },
          async readFile(req) {
            return await callJson('/exa.language_server_pb.LanguageServerService/ReadFile', req || {});
          },
        };
      }

      function extractAnchoredMarkerBlock(bundleText, beginRe, endRe) {
        if (!bundleText || typeof bundleText !== 'string') return '';
        const bMatch = beginRe.exec(bundleText);
        if (!bMatch) return '';
        const startIdx = bMatch.index;
        const afterStart = bundleText.slice(startIdx);
        const eMatch = endRe.exec(afterStart);
        if (!eMatch) return afterStart;
        return afterStart.slice(0, eMatch.index + eMatch[0].length);
      }

      async function fetchHostInstalledPluginInfo(csrf, viewOrEl) {
        const svc = getRemoteRpcServiceForElement(viewOrEl);
        const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
        const canCallHttp = Boolean(effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function');

        async function callRpc(methodName, rpcPath, reqObj) {
          if (svc && typeof svc[methodName] === 'function') {
            try {
              let arg = reqObj || {};
              if (!svc.isRemoteControlHost) {
                if (methodName === 'getCustomizationStates') arg = [];
                else if (methodName === 'getAllSkills') arg = [];
                else if (methodName === 'readFile' && arg && typeof arg === 'object' && typeof arg.uri === 'string') arg = arg.uri;
              }
              const r = await svc[methodName](arg);
              if (r !== undefined && r !== null) return r;
            } catch {}
          }
          if (svc && typeof svc.callJson === 'function') {
            try {
              const r = await svc.callJson(rpcPath, reqObj || {});
              if (r) return r;
            } catch {}
          }
          if (canCallHttp) {
            try {
              const res = await fetchFn(rpcPath, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': effCsrf },
                body: JSON.stringify(reqObj || {}),
              });
              if (res && res.ok !== false) return await res.json();
            } catch {}
          }
          return null;
        }

        const [statesRes, pluginsRes] = await Promise.all([
          callRpc('getCustomizationStates', '/exa.language_server_pb.LanguageServerService/GetCustomizationStates', {}),
          callRpc('getAllPlugins', '/exa.language_server_pb.LanguageServerService/GetAllPlugins', {}),
        ]);

        const candidatePaths = [];
        const pluginNames = new Set();
        const statesList = Array.isArray(statesRes) ? statesRes : (Array.isArray(statesRes?.states) ? statesRes.states : []);
        for (const s of statesList) {
          const p = s?.path || s?.uri || '';
          if (p) {
            candidatePaths.push(p);
            if (String(p).includes('ko-thought-translator')) pluginNames.add('ko-thought-translator');
            if (String(p).includes('antigravity-mcp-manager')) pluginNames.add('antigravity-mcp-manager');
            if (String(p).includes('antigravity-statusbar')) pluginNames.add('antigravity-statusbar');
          }
        }
        const pluginsList = Array.isArray(pluginsRes) ? pluginsRes : (Array.isArray(pluginsRes?.plugins) ? pluginsRes.plugins : []);
        for (const p of pluginsList) {
          if (p?.name) pluginNames.add(String(p.name));
          if (p?.path) candidatePaths.push(p.path);
        }
        if (!candidatePaths.length) {
          const skillsRes = await callRpc('getAllSkills', '/exa.language_server_pb.LanguageServerService/GetAllSkills', {});
          const skillsList = Array.isArray(skillsRes) ? skillsRes : (Array.isArray(skillsRes?.skills) ? skillsRes.skills : []);
          for (const sk of skillsList) {
            const p = sk?.path || sk?.uri || '';
            if (p) {
              candidatePaths.push(p);
              if (String(p).includes('ko-thought-translator')) pluginNames.add('ko-thought-translator');
            }
          }
        }

        let geminiDir = null;
        for (const rawPath of candidatePaths) {
          let decoded = String(rawPath).trim();
          try {
            decoded = decodeURIComponent(decoded);
          } catch {}
          const isFileUri = /^file:\/\//i.test(decoded);
          let norm = decoded.replace(/^file:\/\//i, '').replace(/\\/g, '/');
          if (isFileUri && /^\/[A-Za-z]:\//.test(norm)) {
            norm = norm.slice(1);
          } else if (isFileUri && !norm.startsWith('/') && !/^[A-Za-z]:\//.test(norm)) {
            norm = '/' + norm;
          }
          const idx = norm.indexOf('/.gemini/');
          if (idx !== -1) {
            geminiDir = norm.slice(0, idx + '/.gemini'.length);
            break;
          }
        }

        let hostBundleText = '';
        let readAttemptedAndFailed = false;
        if (geminiDir) {
          const uriPrefix = geminiDir.startsWith('/') ? 'file://' : 'file:///';
          const uri = `${uriPrefix}${geminiDir}/antigravity/statusbar_autoinject.js`;
          const rf = await callRpc('readFile', '/exa.language_server_pb.LanguageServerService/ReadFile', { uri });
          if (rf instanceof Uint8Array || ArrayBuffer.isView(rf) || rf instanceof ArrayBuffer) {
            hostBundleText = decodeBytesToText(rf);
          } else if (typeof rf === 'string' && rf.length > 0) {
            hostBundleText = rf;
          } else if (rf && (rf.content instanceof Uint8Array || ArrayBuffer.isView(rf.content) || rf.content instanceof ArrayBuffer)) {
            hostBundleText = decodeBytesToText(rf.content);
          } else if (rf && typeof rf.content === 'string' && rf.content.length > 0) {
            hostBundleText = decodeBase64ToUtf8(rf.content);
          }
          if (!hostBundleText) {
            readAttemptedAndFailed = true;
          }
        }

        const mcpBeginStr = ['BEGIN_AGY_MCP', 'MANAGER'].join('_');
        const mcpEndStr = ['END_AGY_MCP', 'MANAGER'].join('_');
        const koBeginStr = ['BEGIN_AGY_KO', 'THOUGHT_LOCALIZER_V2'].join('_');
        const koEndStr = ['END_AGY_KO', 'THOUGHT_LOCALIZER_V2'].join('_');

        const mcpBeginRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${mcpBeginStr}(?:_V1)? ===|\\/\\* === ${mcpBeginStr}(?:_V1)? === \\*\\/)[ \\t]*$`, 'm');
        const mcpEndRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${mcpEndStr}(?:_V1)? ===|\\/\\* === ${mcpEndStr}(?:_V1)? === \\*\\/)[ \\t]*$`, 'm');
        const koBeginRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${koBeginStr} ===|\\/\\* === ${koBeginStr} === \\*\\/)[ \\t]*$`, 'm');
        const koEndRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${koEndStr} ===|\\/\\* === ${koEndStr} === \\*\\/)[ \\t]*$`, 'm');

        const mcpManagerCode = extractAnchoredMarkerBlock(hostBundleText, mcpBeginRe, mcpEndRe);
        const koTranslatorCode = extractAnchoredMarkerBlock(hostBundleText, koBeginRe, koEndRe);

        const hasMcpMarker = Boolean(mcpManagerCode) || hostBundleText.includes('function mountMcpManager(');
        const hasKoMarker = Boolean(koTranslatorCode) || hostBundleText.includes('__agyKoThoughtCleanup');
        const hasStatusbarMarker = hostBundleText.includes('function mountStatusBar(') || hostBundleText.includes('agy-ctx-statusbar');

        const hasStatusbar = hasStatusbarMarker || pluginNames.has('antigravity-statusbar');
        const hasMcpManager = hasMcpMarker || pluginNames.has('antigravity-mcp-manager');
        const hasKoTranslator = hasKoMarker || pluginNames.has('ko-thought-translator');

        const resolved = Boolean(hostBundleText) || (!readAttemptedAndFailed && pluginNames.size > 0);

        return {
          resolved,
          geminiDir,
          hasStatusbar,
          hasMcpManager,
          hasKoTranslator,
          mcpManagerCode,
          koTranslatorCode,
          hostBundleText,
        };
      }

      let lastDesktopTrajectorySyncTs = 0;
      let desktopTrajectorySyncInFlight = false;

      async function pushSessionCwToServer(cascadeId, csrf, viewOrEl) {
        if (!cwStore || typeof cwStore.encodeRemoteAnnotationProfile !== 'function') return false;
        let targetIds = [];
        if (cascadeId && cascadeId !== 'remote-session') {
          targetIds = [cascadeId];
        } else if (!cascadeId) {
          const activeView = viewOrEl || document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
          const activeCid = activeView?.getAttribute?.('data-cascade-id') || window?.__agySniffedCascadeId;
          if (activeCid && activeCid !== 'remote-session') {
            targetIds = [activeCid];
          }
        }
        if (!targetIds.length) return false;

        for (const cid of targetIds) {
          const profileStr = cwStore.encodeRemoteAnnotationProfile(cid);
          if (!profileStr) continue;
          const reqPayload = {
            cascadeIds: [cid],
            annotations: { activeProfile: profileStr },
            mergeAnnotations: true,
          };
          const svc = getRemoteRpcServiceForElement(viewOrEl);
          if (svc && typeof svc.updateConversationAnnotations === 'function') {
            try {
              await svc.updateConversationAnnotations(reqPayload);
              continue;
            } catch {}
          }
          const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
          if (effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function') {
            try {
              await fetchFn('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': effCsrf },
                body: JSON.stringify(reqPayload),
              });
            } catch {}
          }
        }
        return true;
      }

      function pullAndBackfillTrajectorySummaries(summaries, csrf, viewOrEl, onRemoteUpdated) {
        if (!summaries || typeof summaries !== 'object' || typeof cwStore?.syncFromRemoteAnnotations !== 'function') {
          return false;
        }
        const { changed, unsyncedLocalIds } = cwStore.syncFromRemoteAnnotations(summaries);
        if (Array.isArray(unsyncedLocalIds) && unsyncedLocalIds.length > 0) {
          for (const cid of unsyncedLocalIds) {
            pushSessionCwToServer(cid, csrf, viewOrEl).catch?.(() => {});
          }
        }
        if (changed && typeof onRemoteUpdated === 'function') {
          try { onRemoteUpdated(); } catch {}
        }
        return changed;
      }

      function syncDesktopAnnotations(csrf, viewOrEl, onRemoteUpdated, force = false) {
        const nativeView = document?.querySelector?.('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
        if (!nativeView && document?.querySelector?.('ga-remote-control')) return;
        const now = Date.now();
        if (desktopTrajectorySyncInFlight || (!force && now - lastDesktopTrajectorySyncTs < 4000)) return;
        const svc = getRemoteRpcServiceForElement(viewOrEl);
        const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
        const canCallSvc = svc && typeof svc.getAllCascadeTrajectories === 'function';
        const canCallHttp = effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function';
        if (!canCallSvc && !canCallHttp) return;

        lastDesktopTrajectorySyncTs = now;
        desktopTrajectorySyncInFlight = true;
        const p = canCallSvc
          ? svc.getAllCascadeTrajectories({})
          : fetchFn('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': effCsrf },
              body: '{}',
            }).then((r) => (r && r.ok !== false ? r.json() : null));

        Promise.resolve(p)
          .then((all) => {
            const summaries = all?.trajectorySummaries;
            if (summaries) {
              pullAndBackfillTrajectorySummaries(summaries, effCsrf, viewOrEl, onRemoteUpdated);
            }
          })
          .catch(() => {})
          .finally(() => {
            desktopTrajectorySyncInFlight = false;
          });
      }

      function ensureRemoteHostView(onCascadeChange) {
        if (!document) return null;
        const nativeView = document.querySelector('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
        if (nativeView) return null;
        const rcEl = document.querySelector('ga-remote-control');
        if (!rcEl) return null;

        const rcInst = getRemoteControlInstance(onCascadeChange);
        const appContainer = rcEl.querySelector('.app-container') || rcEl;
        let hostView = appContainer.querySelector('.agy-rc-host-view');
        if (!hostView) {
          hostView = document.createElement('div');
          hostView.className = 'agy-rc-host-view';
          hostView.setAttribute('data-testid', 'conversation-view');
          const hostBox = document.createElement('div');
          hostBox.className = 'agy-rc-host-box';
          hostBox.setAttribute('data-testid', 'agent-input-box');
          hostView.appendChild(hostBox);
          appContainer.appendChild(hostView);
        }

        const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
        const cdoc = getAccessibleRemoteIframeDoc();
        const innerView = cdoc?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
        const rawInnerCid = innerView?.getAttribute?.('data-cascade-id');
        const innerCid = (rawInnerCid && UUID_RE.test(rawInnerCid) && rawInnerCid !== ignoreUuid) ? rawInnerCid : '';

        const childPath = rcInst?.lastSyncedChildPath || window?.location?.search || '';
        const pathMatch = String(childPath).match(UUID_RE);
        const pathCid = (pathMatch && pathMatch[0] && pathMatch[0] !== ignoreUuid) ? pathMatch[0] : '';

        let activeCid = '';
        if (innerCid) {
          activeCid = innerCid;
          if (window.__agySniffedCascadeId !== innerCid) {
            window.__agySniffedCascadeId = innerCid;
            window.__agySniffedCascadeTs = Date.now();
          }
        } else if (pathCid && pathCid !== hostView.__agyLastChildPathCid) {
          hostView.__agyLastChildPathCid = pathCid;
          activeCid = pathCid;
          window.__agySniffedCascadeId = pathCid;
          window.__agySniffedCascadeTs = Date.now();
        } else {
          activeCid = window.__agySniffedCascadeId || pathCid || '';
        }

        const currentAttr = hostView.getAttribute('data-cascade-id');
        const nextAttr = activeCid || currentAttr || 'remote-session';
        if (currentAttr !== nextAttr) {
          if (currentAttr === 'remote-session' && nextAttr !== 'remote-session') {
            cwStore?.migrateSessionOverride?.('remote-session', nextAttr);
          }
          hostView.setAttribute('data-cascade-id', nextAttr);
        }

        const now = Date.now();
        if (rcInst && !rcTrajectoryPollInFlight && (now - lastRcTrajectoryPollTs >= 2500 || nextAttr === 'remote-session')) {
          lastRcTrajectoryPollTs = now;
          rcTrajectoryPollInFlight = true;
          createRcServiceAdapter(rcInst).getAllCascadeTrajectories().then((all) => {
            const summaries = all?.trajectorySummaries || {};
            const entries = Object.entries(summaries);
            if (!entries.length) return;
            const cwChanged = pullAndBackfillTrajectorySummaries(summaries, null, hostView);
            window.__agyRcStepCountByCascade = window.__agyRcStepCountByCascade || {};
            for (const [id, sum] of entries) {
              if (typeof sum?.stepCount === 'number') {
                window.__agyRcStepCountByCascade[id] = sum.stepCount;
              }
            }
            entries.sort((a, b) => {
              const vA = Date.parse(a[1]?.annotations?.lastUserViewTime || 0) || 0;
              const vB = Date.parse(b[1]?.annotations?.lastUserViewTime || 0) || 0;
              if (vA !== vB) return vB - vA;
              const mA = Date.parse(a[1]?.lastModifiedTime || 0) || 0;
              const mB = Date.parse(b[1]?.lastModifiedTime || 0) || 0;
              return mB - mA;
            });
            const [latestId] = entries[0];
            if (latestId) {
              const prevId = hostView.getAttribute('data-cascade-id');
              const hasValidActive = Boolean(
                window.__agySniffedCascadeId &&
                window.__agySniffedCascadeId !== 'remote-session' &&
                summaries[window.__agySniffedCascadeId]
              );
              if (!hasValidActive && (!prevId || prevId === 'remote-session' || !summaries[prevId])) {
                window.__agySniffedCascadeId = latestId;
              }
              const resolvedId = window.__agySniffedCascadeId || (prevId && prevId !== 'remote-session' ? prevId : latestId);
              if (prevId === 'remote-session' && resolvedId && resolvedId !== 'remote-session') {
                cwStore?.migrateSessionOverride?.('remote-session', resolvedId);
              }
              const nextSteps = window.__agyRcStepCountByCascade[resolvedId] ?? -1;
              const prevObservedSteps = hostView.__agyObservedStepCount;
              hostView.__agyObservedStepCount = nextSteps;
              if (prevId !== resolvedId || prevObservedSteps !== nextSteps || cwChanged) {
                hostView.setAttribute('data-cascade-id', resolvedId);
                if (typeof onCascadeChange === 'function') onCascadeChange(resolvedId);
              }
            }
          }).catch(() => {}).finally(() => {
            rcTrajectoryPollInFlight = false;
          });
        }

        return hostView;
      }

      function getAgentStateProviderForInputBox(inputBox) {
        const cc = getCascadeContextForElement(inputBox);
        if (cc?.state?.agentStateProvider) return cc.state.agentStateProvider;
        const cid = window?.__agySniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id');
        const steps = cid && window?.__agyRcStepCountByCascade ? window.__agyRcStepCountByCascade[cid] : undefined;
        const knownGenLen = cid && window?.__agyRcGenLenByCascade ? window.__agyRcGenLenByCascade[cid] : undefined;
        if ((typeof steps === 'number' && steps >= 0) || (typeof knownGenLen === 'number' && knownGenLen >= 0)) {
          return {
            getState: () => ({
              trajectorySlice: {
                totalGeneratorMetadataLength: -1,
                totalStepsLength: typeof steps === 'number' ? steps : -1,
              },
            }),
          };
        }
        return null;
      }

      function getRemoteRpcServiceForElement(el) {
        if (window?.__agyCapturedLsClient && (typeof window.__agyCapturedLsClient.retrieveUserQuotaSummary === 'function' || typeof window.__agyCapturedLsClient.getCascadeTrajectory === 'function')) {
          return hookLsClient(window.__agyCapturedLsClient);
        }
        const cwin = getAccessibleRemoteIframeWin();
        if (cwin?.__agyCapturedLsClient && (typeof cwin.__agyCapturedLsClient.retrieveUserQuotaSummary === 'function' || typeof cwin.__agyCapturedLsClient.getCascadeTrajectory === 'function')) {
          return hookLsClient(cwin.__agyCapturedLsClient);
        }
        const cdoc = getAccessibleRemoteIframeDoc();
        const candidates = [
          resolveEffectiveInputBox(resolveEffectiveView(el)),
          el,
          document?.querySelector?.('[data-testid="conversation-view"]'),
          cdoc?.querySelector?.('[data-testid="conversation-view"]'),
        ].filter(Boolean);
        for (const startEl of candidates) {
          const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
          let curr = fk ? startEl[fk] : null;
          while (curr) {
            const val = curr.memoizedProps?.value;
            if (val && typeof val === 'object') {
              if (typeof val.retrieveUserQuotaSummary === 'function' || typeof val.getCascadeTrajectory === 'function' || typeof val.getAllCascadeTrajectories === 'function' || typeof val.updateConversationAnnotations === 'function' || typeof val.getCustomizationStates === 'function' || typeof val.readFile === 'function') {
                return hookLsClient(val);
              }
              const lsClient = val.core?.projectManagementService?.lsClient || val.projectManagementService?.lsClient || val.lsClient;
              if (lsClient && (typeof lsClient.retrieveUserQuotaSummary === 'function' || typeof lsClient.getCascadeTrajectory === 'function' || typeof lsClient.getAllCascadeTrajectories === 'function' || typeof lsClient.updateConversationAnnotations === 'function' || typeof lsClient.getCustomizationStates === 'function' || typeof lsClient.readFile === 'function')) {
                return hookLsClient(lsClient);
              }
            }
            curr = curr.return;
          }
        }
        const rcInst = getRemoteControlInstance();
        if (rcInst && typeof rcInst.proxyCommand === 'function') {
          return createRcServiceAdapter(rcInst);
        }
        try {
          const parentWin = window?.parent !== window ? window?.parent : null;
          const pRc = parentWin?.__agyRemoteControlInstance;
          if (pRc && !pRc.destroyed && typeof pRc.proxyCommand === 'function') {
            return createRcServiceAdapter(pRc);
          }
        } catch {}
        return null;
      }

      function getSelectedModelKey(view, cascadeId, infoOpt) {
        const info = infoOpt || getModelSelectorContextForView(view);
        const state = info?.reduxStore ? info.reduxStore.getState() : null;
        const byConvo = state?.modelSelection?.byConversation?.[cascadeId];
        const sm = info?.msCtx?.selectedModel;
        const raw =
          byConvo?.model ??
          (sm && typeof sm === 'object' ? (sm.value ?? sm.label) : sm) ??
          state?.modelSelection?.default?.model ??
          info?.legacyCtx?.getModelConfigForConversation?.(cascadeId)?.value ??
          '';
        return `${cascadeId || ''}:${String(raw ?? '')}`;
      }

      function applyContextWindowToEngine(view, cascadeId, rawTargetCw, force = false) {
        const targetCw = cwStore.normalize(rawTargetCw);
        if (!view || !cascadeId || !targetCw) return false;
        const info = getModelSelectorContextForView(view, targetCw);
        if (!info) return false;

        const { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl } = info;
        if (triggerEl) {
          const warnAttr = cwStore.getLimit(targetCw) > 256000 ? '1' : '0';
          if (triggerEl.getAttribute('data-agy-cw-warn') !== warnAttr) {
            triggerEl.setAttribute('data-agy-cw-warn', warnAttr);
          }
        }
        const currentInDom = triggerEl ? cwStore.normalize(triggerEl.getAttribute('data-context-window')) : null;
        const selectedModel = getSelectedModelKey(view, cascadeId, info);
        const applyKey = (selectedModel || '') + ':' + String(targetCw);
        window.__agyLastAppliedContextWindowByCascade = window.__agyLastAppliedContextWindowByCascade || {};
        const lastAppliedForCascade = window.__agyLastAppliedContextWindowByCascade[cascadeId];
        const initialState = reduxStore ? reduxStore.getState() : null;
        const initialReduxCw = initialState?.modelSelection?.byConversation?.[cascadeId]?.contextWindow;
        const reduxAlreadyMatches = !reduxStore || initialReduxCw === targetCw;

        if ((currentInDom === targetCw || lastAppliedForCascade === applyKey || window.__agyLastAppliedContextWindow === applyKey) && reduxAlreadyMatches && !force) {
          if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
            triggerEl.setAttribute('data-context-window', String(targetCw));
          }
          return true;
        }

        if (msCtx || reduxStore) {
          const state = initialState;
          const byConvo = state?.modelSelection?.byConversation?.[cascadeId];
          const currentInRedux = byConvo?.contextWindow || msCtx?.contextWindow?.selected || currentInDom || '256K';
          const selectedModelObj = msCtx?.selectedModel;
          if (selectedModelObj) {
            ensureModelContextWindowOptions(selectedModelObj, targetCw);
          }
          let dispatched = false;

          if (currentInRedux !== targetCw || (reduxStore && byConvo?.contextWindow !== targetCw) || force) {
            const prevDefaultCw = state?.modelSelection?.default?.contextWindow;
            if (reduxStore) {
              const modelVal = byConvo?.model ?? selectedModelObj?.value ?? state?.modelSelection?.default?.model;
              const customLabel = byConvo?.customLabel ?? (selectedModelObj?.isCustom ? selectedModelObj?.label : undefined);
              if (modelVal !== undefined) {
                reduxStore.dispatch({
                  type: 'modelSelection/modelPicked',
                  payload: {
                    conversationId: cascadeId,
                    model: modelVal,
                    customLabel,
                    contextWindow: targetCw,
                    pick: { atStep: 999999, queuedMessageIds: [] },
                  },
                });
                dispatched = true;
              }
            } else if (msCtx?.contextWindow && typeof msCtx.contextWindow.select === 'function' && selectedModelObj) {
              msCtx.contextWindow.select(selectedModelObj, targetCw);
              dispatched = true;
            } else if (typeof setSelectedModelWithCw === 'function' && selectedModelObj) {
              setSelectedModelWithCw(selectedModelObj, targetCw);
              dispatched = true;
            } else if (typeof msCtx?.setSelectedModel === 'function' && selectedModelObj) {
              msCtx.setSelectedModel(selectedModelObj, targetCw);
              dispatched = true;
            }

            if (dispatched && reduxStore) {
              const nextState = reduxStore.getState();
              const defObj = nextState?.modelSelection?.default;
              const desiredDefaultCw = cwStore.getDefaultCw() || prevDefaultCw || '256K';
              if (defObj && defObj.contextWindow !== desiredDefaultCw) {
                reduxStore.dispatch({
                  type: 'modelSelection/modelPicked',
                  payload: {
                    conversationId: undefined,
                    model: defObj.model,
                    customLabel: defObj.customLabel,
                    contextWindow: desiredDefaultCw,
                  },
                });
              }
            }
          }

          if (dispatched || currentInRedux === targetCw) {
            window.__agyLastAppliedContextWindow = applyKey;
            window.__agyLastAppliedContextWindowByCascade[cascadeId] = applyKey;
            if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
              triggerEl.setAttribute('data-context-window', String(targetCw));
            }
            return true;
          }
          return false;
        }

        if (legacyCtx) {
          const modelCfg = legacyCtx.getModelConfigForConversation(cascadeId);
          if (!modelCfg || modelCfg.value === undefined) return false;
          const currentInEngine = legacyCtx.getContextWindowForConversation(cascadeId) || '256K';
          if (currentInEngine !== targetCw || force) {
            if (currentInEngine === targetCw && currentInDom !== targetCw) {
              const tempCw = targetCw === '256K' ? '512K' : '256K';
              legacyCtx.setModelForConversation(cascadeId, modelCfg.value, true, modelCfg.label, tempCw);
            }
            legacyCtx.setModelForConversation(cascadeId, modelCfg.value, true, modelCfg.label, targetCw);
          }
          window.__agyLastAppliedContextWindow = applyKey;
          window.__agyLastAppliedContextWindowByCascade[cascadeId] = applyKey;
          if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
            triggerEl.setAttribute('data-context-window', String(targetCw));
          }
          return true;
        }
        return false;
      }

      async function runCompactForInputBox(inputBox) {
        const effBox = resolveEffectiveInputBox(inputBox);
        if (!effBox) return;
        const editable = effBox.querySelector('[contenteditable="true"]');
        if (!editable || !editable.__lexicalEditor) {
          const svc = getRemoteRpcServiceForElement(effBox);
          const cid = window?.__agySniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id') || effBox.closest?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id');
          if (svc && typeof svc.sendUserCascadeMessage === 'function' && cid && cid !== 'remote-session') {
            try {
              await svc.sendUserCascadeMessage({
                cascadeId: cid,
                items: [
                  {
                    item: {
                      slashCommand: {
                        info: { name: 'compact', type: 'SLASH_COMMAND_TYPE_SYSTEM', icon: 'collapse_all' },
                      },
                    },
                  },
                  {
                    text: ' ' + COMPACT_ARGS,
                  },
                ],
              });
            } catch {}
          }
          return;
        }
        const ed = editable.__lexicalEditor;
        const PClass = ed._nodes.get('paragraph')?.klass;
        const MClass = ed._nodes.get('contextScopeItemMention')?.klass;
        const TClass = ed._nodes.get('text')?.klass;
        if (!PClass || !MClass || !TClass) return;

        ed.update(() => {
          const root = ed.getEditorState()._nodeMap.get('root').getWritable();
          root.clear();
          const p = PClass.importJSON({
            direction: null, format: '', indent: 0, type: 'paragraph', version: 1, textFormat: 0, textStyle: '',
          });
          const mention = MClass.importJSON({
            trigger: '@',
            value: 'contextScopeItemMention',
            data: {
              mentionText: 'compact',
              data: JSON.stringify({
                slashCommand: {
                  info: { name: 'compact', type: 'SLASH_COMMAND_TYPE_SYSTEM', icon: 'collapse_all' },
                },
              }),
            },
            type: 'contextScopeItemMention',
            version: 1,
          });
          const text = TClass.importJSON({
            detail: 0, format: 0, mode: 'normal', style: '', text: ' ' + COMPACT_ARGS, type: 'text', version: 1,
          });
          p.append(mention, text);
          root.append(p);
        });

        await new Promise((r) => setTimeout(r, 60));

        const fiberKey = Object.keys(editable).find((k) => k.startsWith('__reactFiber$'));
        let curr = fiberKey ? editable[fiberKey] : null;
        while (curr && (!curr.memoizedProps || typeof curr.memoizedProps.handleEnter !== 'function')) {
          curr = curr.return;
        }
        if (curr && curr.memoizedProps && typeof curr.memoizedProps.handleEnter === 'function') {
          const Evt = typeof KeyboardEvent === 'function' ? KeyboardEvent : function (t, o) { Object.assign(this, o, { type: t }); };
          await curr.memoizedProps.handleEnter(new Evt('keydown', { key: 'Enter' }), ed);
        } else {
          const sendBtn = effBox.querySelector('[data-testid="send-button"]');
          if (sendBtn && !sendBtn.disabled) sendBtn.click();
        }
      }

      return {
        ensureContextWindowSelectorFlag,
        ensureCustomizationsStoreLoaded,
        ensureRemoteHostView,
        getRemoteControlInstance,
        getModelSelectorContextForView,
        getCascadeContextForElement,
        getAgentStateProviderForInputBox,
        getRemoteRpcServiceForElement,
        getSelectedModelKey,
        applyContextWindowToEngine,
        runCompactForInputBox,
        pushSessionCwToServer,
        pullAndBackfillTrajectorySummaries,
        syncDesktopAnnotations,
        fetchHostInstalledPluginInfo,
        injectCheckpointLimitIntoSendRequest,
        buildSendMessageCheckpointSuffix,
      };
    }

    module.exports = {
      COMPACT_ARGS,
      registerCustomCwInPrototype,
      createHostBridge,
    };

  },
  "./adapter-registry": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';

    function normalizeAdapter(adapter) {
      if (!adapter || typeof adapter !== 'object') {
        throw new TypeError('StatusBarAdapter must be an object');
      }
      const id = typeof adapter.id === 'string' ? adapter.id.trim() : '';
      if (!id) {
        throw new TypeError('StatusBarAdapter requires a non-empty string id');
      }
      const slot = adapter.slot === 'left' ? 'left' : 'right';
      const order = typeof adapter.order === 'number' && !isNaN(adapter.order) ? adapter.order : 100;
      const hasRender = typeof adapter.render === 'function';
      const hasButton = typeof adapter.onClick === 'function' || adapter.label !== undefined;
      if (!hasRender && !hasButton) {
        throw new TypeError(`StatusBarAdapter "${id}" must provide either render(el, ctx) or label/onClick`);
      }
      return {
        ...adapter,
        id,
        slot,
        order,
        builtin: Boolean(adapter.builtin),
      };
    }

    function createAdapterRegistry({ window, document, setHtml, onUpdate }) {
      const adapterRegistry = new Map();
      if (window) {
        if (!window.__agyCustomStatusBarAdapters || !(window.__agyCustomStatusBarAdapters instanceof Map)) {
          window.__agyCustomStatusBarAdapters = new Map();
        }
      }
      const customStore = window?.__agyCustomStatusBarAdapters || new Map();

      function cleanupChildMenus(container) {
        if (!container || typeof container.querySelectorAll !== 'function') return;
        const menus = container.querySelectorAll('.agy-ctx-menu');
        for (const m of menus) {
          if (typeof m.__agyCleanup === 'function') {
            try { m.__agyCleanup(); } catch {}
          } else {
            try { m.remove(); } catch {}
          }
        }
      }

      function removeAdapterDomElements(id) {
        if (!document || typeof document.querySelectorAll !== 'function') return;
        const bars = document.querySelectorAll('.agy-ctx-statusbar');
        for (const bar of bars) {
          const nodes = bar.querySelectorAll(`[data-agy-adapter-id="${id}"]`);
          for (const node of nodes) {
            cleanupChildMenus(node);
            try { node.remove(); } catch {}
          }
        }
      }

      function getSortedAdapters(slotName) {
        const list = [];
        for (const adapter of adapterRegistry.values()) {
          if (!slotName || adapter.slot === slotName) {
            list.push(adapter);
          }
        }
        list.sort((a, b) => {
          if (a.slot !== b.slot) return a.slot === 'left' ? -1 : 1;
          return (a.order - b.order) || a.id.localeCompare(b.id);
        });
        return list;
      }

      function registerStatusBarAdapter(rawAdapter) {
        const adapter = normalizeAdapter(rawAdapter);
        if (adapterRegistry.has(adapter.id)) {
          const prev = adapterRegistry.get(adapter.id);
          if (prev && typeof prev.unmount === 'function') {
            try { prev.unmount(); } catch {}
          }
          removeAdapterDomElements(adapter.id);
        }
        adapterRegistry.set(adapter.id, adapter);
        if (!adapter.builtin) {
          customStore.set(adapter.id, adapter);
        }
        if (typeof onUpdate === 'function') onUpdate();
        return () => unregisterStatusBarAdapter(adapter.id);
      }

      function unregisterStatusBarAdapter(id) {
        const key = typeof id === 'string' ? id.trim() : '';
        if (!key || !adapterRegistry.has(key)) return false;
        const adapter = adapterRegistry.get(key);
        adapterRegistry.delete(key);
        customStore.delete(key);
        if (adapter && typeof adapter.unmount === 'function') {
          try { adapter.unmount(); } catch {}
        }
        removeAdapterDomElements(key);
        if (typeof onUpdate === 'function') onUpdate();
        return true;
      }

      function registerBuiltinAdapters(builtins) {
        for (const b of builtins) {
          const normalized = normalizeAdapter({ ...b, builtin: true });
          adapterRegistry.set(normalized.id, normalized);
        }
        for (const [, extAdapter] of customStore.entries()) {
          try {
            const normalized = normalizeAdapter(extAdapter);
            adapterRegistry.set(normalized.id, normalized);
          } catch {}
        }
      }

      function ensureBarStructure(barEl) {
        let leftEl = barEl.querySelector('.agy-ctx-left');
        let rightEl = barEl.querySelector('.agy-ctx-right');
        if (!leftEl || !rightEl) {
          cleanupChildMenus(barEl);
          setHtml(barEl, `
            <div class="agy-ctx-left"></div>
            <div class="agy-ctx-right"></div>
          `);
          leftEl = barEl.querySelector('.agy-ctx-left');
          rightEl = barEl.querySelector('.agy-ctx-right');
        }
        return { leftEl, rightEl };
      }

      function renderSlotAdapters(slotEl, slotName, ctx) {
        if (!slotEl) return;
        const adapters = getSortedAdapters(slotName);
        const activeIds = new Set(adapters.map((a) => a.id));

        if (slotEl.querySelectorAll) {
          const existingNodes = slotEl.querySelectorAll('[data-agy-adapter-id]');
          for (const node of existingNodes) {
            const nodeId = node.getAttribute('data-agy-adapter-id');
            if (nodeId && !activeIds.has(nodeId)) {
              cleanupChildMenus(node);
              try { node.remove(); } catch {}
            }
          }
        }

        const orderedEls = [];
        for (const adapter of adapters) {
          let itemEl = slotEl.querySelector ? slotEl.querySelector(`[data-agy-adapter-id="${adapter.id}"]`) : null;
          if (typeof adapter.render === 'function') {
            if (!itemEl) {
              itemEl = document.createElement(adapter.tagName || 'span');
              itemEl.setAttribute('data-agy-adapter-id', adapter.id);
              if (adapter.className) itemEl.className = adapter.className;
              slotEl.appendChild(itemEl);
            }
            adapter.render(itemEl, ctx);
          } else {
            if (!itemEl) {
              itemEl = document.createElement('button');
              itemEl.type = 'button';
              itemEl.setAttribute('data-agy-adapter-id', adapter.id);
              itemEl.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const latestCtx = itemEl.__agyAdapterCtx || ctx;
                if (typeof adapter.onClick === 'function') {
                  adapter.onClick(latestCtx, e);
                }
              };
              slotEl.appendChild(itemEl);
            }
            itemEl.__agyAdapterCtx = ctx;
            const resolvedClass = typeof adapter.className === 'function'
              ? adapter.className(ctx)
              : (adapter.className || 'agy-ctx-btn');
            const finalClass = resolvedClass.includes('agy-ctx-btn') ? resolvedClass : `agy-ctx-btn ${resolvedClass}`.trim();
            if (itemEl.className !== finalClass) {
              itemEl.className = finalClass;
            }
            const resolvedLabel = typeof adapter.label === 'function' ? adapter.label(ctx) : String(adapter.label ?? '');
            if (itemEl.textContent !== resolvedLabel) {
              itemEl.textContent = resolvedLabel;
            }
            const resolvedTitle = typeof adapter.title === 'function' ? adapter.title(ctx) : String(adapter.title ?? '');
            if (resolvedTitle && itemEl.getAttribute('title') !== resolvedTitle) {
              itemEl.setAttribute('title', resolvedTitle);
              itemEl.title = resolvedTitle;
            }
          }
          if (itemEl) orderedEls.push(itemEl);
        }

        if (orderedEls.length > 1 && Array.isArray(slotEl.children)) {
          let outOfOrder = false;
          for (let i = 0; i < orderedEls.length; i++) {
            if (slotEl.children[i] !== orderedEls[i]) {
              outOfOrder = true;
              break;
            }
          }
          if (outOfOrder) {
            for (const el of orderedEls) {
              slotEl.appendChild(el);
            }
          }
        } else if (orderedEls.length > 1 && typeof slotEl.insertBefore === 'function' && slotEl.children) {
          let outOfOrder = false;
          for (let i = 0; i < orderedEls.length; i++) {
            if (slotEl.children[i] !== orderedEls[i]) {
              outOfOrder = true;
              break;
            }
          }
          if (outOfOrder) {
            for (const el of orderedEls) {
              slotEl.appendChild(el);
            }
          }
        }
      }

      function getAdapters() {
        return getSortedAdapters().map((a) => ({
          id: a.id,
          slot: a.slot,
          order: a.order,
          builtin: Boolean(a.builtin),
        }));
      }

      return {
        registerAdapter: registerStatusBarAdapter,
        unregisterAdapter: unregisterStatusBarAdapter,
        registerBuiltinAdapters,
        getAdapters,
        getSortedAdapters,
        ensureBarStructure,
        renderSlotAdapters,
      };
    }

    module.exports = {
      normalizeAdapter,
      createAdapterRegistry,
    };

  },
  "./adapters/core-metrics": function(module, exports, __require) {
    const require = (spec) => __require("./adapters", spec);
    'use strict';

    const { PRESET_CONTEXT_WINDOWS } = require('../context-window-policy');
    const { fmtK, escHtml } = require('../dom-styles');

    function createCoreMetricsAdapter({
      document,
      setHtml,
      cwStore,
      getConversationContextWindow,
      setConversationContextWindow,
      cycleConversationContextWindow,
      updateAll,
    }) {
      function showContextMenu(barEl, view, cascadeId, limitBtn) {
        const existing = barEl.querySelector('.agy-ctx-menu');
        if (existing) {
          if (typeof existing.__agyCleanup === 'function') {
            existing.__agyCleanup();
          } else {
            existing.remove();
          }
          return;
        }

        if (document && typeof document.querySelectorAll === 'function') {
          const openMenus = document.querySelectorAll('.agy-ctx-menu');
          for (const m of openMenus) {
            if (m.parentNode === barEl) continue;
            if (typeof m.__agyCleanup === 'function') {
              try { m.__agyCleanup(); } catch {}
            } else {
              try { m.remove(); } catch {}
            }
          }
        }

        const resolveCurrentCascadeId = () => view?.getAttribute?.('data-cascade-id') || cascadeId;
        const currentCw = getConversationContextWindow(view, resolveCurrentCascadeId());
        const currentKNum = parseInt(currentCw, 10) || 512;
        const menu = document.createElement('div');
        menu.className = 'agy-ctx-menu';

        if (typeof menu.addEventListener === 'function') {
          for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'contextmenu']) {
            menu.addEventListener(evtName, (ev) => ev.stopPropagation());
          }
        }

        const activeHdrCid = resolveCurrentCascadeId();
        const sessionLabel = activeHdrCid && activeHdrCid !== 'remote-session' ? activeHdrCid.slice(0, 8) : '현재 세션';
        const hdr = document.createElement('div');
        hdr.className = 'agy-ctx-menu-hdr';
        setHtml(hdr, `
          <span>세션 컨텍스트 한도</span>
          <span style="opacity:0.75">${escHtml(sessionLabel)}</span>
        `);
        menu.appendChild(hdr);

        const customRow = document.createElement('div');
        customRow.className = 'agy-ctx-custom-row';
        setHtml(customRow, `
          <input type="text" inputmode="numeric" pattern="[0-9]*" class="agy-ctx-custom-input" value="${escHtml(currentKNum)}" placeholder="32~980" title="32 ~ 980 사이 숫자 입력 (예: 400 입력 시 400K 적용)" />
          <span class="agy-ctx-custom-unit">K</span>
          <button type="button" class="agy-ctx-custom-apply">적용</button>
        `);
        menu.appendChild(customRow);

        let iframeDoc = null;
        try {
          iframeDoc = document?.querySelector?.('ga-remote-control iframe')?.contentDocument || null;
        } catch {}
        const winObj = document?.defaultView || null;

        let attachTimer = null;
        const closeMenu = () => {
          if (attachTimer !== null) {
            clearTimeout(attachTimer);
            attachTimer = null;
          }
          menu.remove();
          for (const evt of ['mousedown', 'pointerdown', 'touchstart']) {
            document?.removeEventListener?.(evt, outsideHandler, true);
            try { iframeDoc?.removeEventListener?.(evt, outsideHandler, true); } catch {}
          }
          try { winObj?.removeEventListener?.('blur', closeMenu); } catch {}
        };
        menu.__agyCleanup = closeMenu;

        const inputEl = customRow.querySelector('.agy-ctx-custom-input');
        const applyBtn = customRow.querySelector('.agy-ctx-custom-apply');
        const applyCustomInput = () => {
          if (!inputEl) return;
          const norm = cwStore.normalize(inputEl.value);
          if (!norm) {
            if (inputEl.style) inputEl.style.borderColor = '#ec7063';
            return;
          }
          setConversationContextWindow(view, resolveCurrentCascadeId(), norm);
          closeMenu();
          updateAll();
        };

        if (applyBtn) {
          applyBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyCustomInput();
          };
        }
        if (inputEl) {
          inputEl.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              applyCustomInput();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeMenu();
            }
          };
        }

        const optionsList = [...PRESET_CONTEXT_WINDOWS];
        if (currentCw && !optionsList.includes(currentCw)) {
          optionsList.unshift(currentCw);
        }

        for (const cw of optionsList) {
          const item = document.createElement('div');
          item.className = 'agy-ctx-menu-item' + (cw === currentCw ? ' active' : '');
          item.setAttribute('data-cw-option', cw);
          setHtml(item, `
            <span>${cw === currentCw ? '✓ ' : '  '}${escHtml(cw)}</span>
            <span class="agy-ctx-menu-hint">${escHtml(cwStore.getQuotaHint(cw))}</span>
          `);
          item.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            setConversationContextWindow(view, resolveCurrentCascadeId(), cw);
            closeMenu();
            updateAll();
          };
          menu.appendChild(item);
        }

        const outsideHandler = (e) => {
          if (!menu.contains || (!menu.contains(e.target) && e.target !== limitBtn)) {
            closeMenu();
          }
        };
        attachTimer = setTimeout(() => {
          attachTimer = null;
          if (!menu.isConnected && menu.parentNode !== barEl) return;
          for (const evt of ['mousedown', 'pointerdown', 'touchstart']) {
            document?.addEventListener?.(evt, outsideHandler, true);
            try { iframeDoc?.addEventListener?.(evt, outsideHandler, true); } catch {}
          }
          try { winObj?.addEventListener?.('blur', closeMenu); } catch {}
          const isCoarseOrNarrow = typeof document?.defaultView?.matchMedia === 'function'
            && document.defaultView.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
          if (!isCoarseOrNarrow && inputEl && inputEl.isConnected && typeof inputEl.focus === 'function') {
            inputEl.focus();
            if (typeof inputEl.select === 'function') inputEl.select();
          }
        }, 10);
        barEl.appendChild(menu);
      }

      return {
        id: 'core-metrics',
        slot: 'left',
        order: 10,
        builtin: true,
        tagName: 'span',
        className: 'agy-ctx-core',
        render(containerEl, ctx) {
          const { barEl, view, cascadeId, stats, quota } = ctx;
          const currentCw = getConversationContextWindow(view, cascadeId);
          const maxLimit = cwStore.getLimit(currentCw);
          const used = stats ? stats.used : 0;
          const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
          const usedStr = stats ? fmtK(used) : '…';
          const cachePct = stats ? stats.cachePct : 0;

          const colorClass = pct >= 85 ? 'agy-ctx-crit' : pct >= 65 ? 'agy-ctx-warn' : 'agy-ctx-ok';
          const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';

          const limitModClass = maxLimit >= 750000 ? 'agy-ctx-btn-limit-900' : (maxLimit > 256000 ? 'agy-ctx-btn-limit-512' : '');
          const titleSessionLabel = cascadeId && cascadeId !== 'remote-session' ? cascadeId.slice(0, 8) : '현재';
          const limitTitle = `이 세션(${titleSessionLabel})의 컨텍스트 한도: ${currentCw} (${cwStore.getQuotaHint(currentCw)})\n클릭 시 직접 입력 / 프리셋 선택 메뉴 열기 (세션별 독립 적용)\nShift+클릭 시 256K → 512K → 900K 빠른 순환`;

          let quotaHtml = '';
          if (quota) {
            const qParts = [];
            if (quota.pct5h !== null) {
              qParts.push(`5h <strong class="agy-ctx-quota">${quota.pct5h}%</strong><span class="agy-ctx-quota-left"> left</span>${quota.rst5h ? ' ' + quota.rst5h : ''}`);
            }
            if (quota.pct7d !== null) {
              qParts.push(`7d <strong class="agy-ctx-quota">${quota.pct7d}%</strong><span class="agy-ctx-quota-left"> left</span>`);
            }
            if (qParts.length) {
              quotaHtml = `<span class="agy-ctx-sep agy-ctx-sep-pipe">|</span><span class="agy-ctx-group agy-ctx-group-quota">${qParts.join(' <span class="agy-ctx-sep">·</span> ')}</span>`;
            }
          }

          const html = `
            <span class="agy-ctx-group agy-ctx-group-ctx">
              <span class="agy-ctx-bar-wrap"><span class="agy-ctx-bar-fill" style="width:${pct}%;background:${barColor}"></span></span>
              <span>ctx <strong class="${colorClass}">${pct}%</strong> ${usedStr}/<button type="button" class="agy-ctx-btn agy-ctx-btn-limit ${limitModClass}" title="${escHtml(limitTitle)}">[ ${escHtml(currentCw.toLowerCase())} ▾ ]</button></span>
              <span class="agy-ctx-sep">·</span>
              <span>cache <strong class="agy-ctx-cache">${cachePct}%</strong></span>
            </span>
            ${quotaHtml}
          `;

          if (containerEl.__lastHtml !== html) {
            containerEl.__lastHtml = html;
            setHtml(containerEl, html);

            const limitBtn = containerEl.querySelector ? containerEl.querySelector('.agy-ctx-btn-limit') : null;
            if (limitBtn) {
              limitBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const activeCid = view?.getAttribute?.('data-cascade-id') || cascadeId;
                if (e.shiftKey) {
                  cycleConversationContextWindow(view, activeCid);
                  updateAll();
                } else {
                  showContextMenu(barEl, view, activeCid, limitBtn);
                }
              };
              limitBtn.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const activeCid = view?.getAttribute?.('data-cascade-id') || cascadeId;
                showContextMenu(barEl, view, activeCid, limitBtn);
              };
            }
          }
        },
      };
    }

    module.exports = {
      createCoreMetricsAdapter,
    };

  },
  "./adapters/compact-button": function(module, exports, __require) {
    const require = (spec) => __require("./adapters", spec);
    'use strict';

    function createCompactButtonAdapter({ runCompactForInputBox }) {
      return {
        id: 'compact',
        slot: 'right',
        order: 10,
        builtin: true,
        className: 'agy-ctx-btn agy-ctx-btn-compact',
        label: '[ compact ]',
        title: '지정된 요약 프롬프트로 시스템 /compact 즉시 실행',
        onClick({ inputBox }) {
          runCompactForInputBox(inputBox);
        },
      };
    }

    module.exports = {
      createCompactButtonAdapter,
    };

  },
  "./adapters/context-button": function(module, exports, __require) {
    const require = (spec) => __require("./adapters", spec);
    'use strict';

    const { fmtNum, escHtml } = require('../dom-styles');
    const { getChatModelFromMeta, extractStatsFromMetas } = require('../rpc-client');

    function createContextButtonAdapter({
      window,
      document,
      fetchFn,
      setHtml,
      cwStore,
      hostBridge,
    }) {
      async function openOrToggleDebugModal(view, inputBox) {
        const existingModal = document.getElementById('agy-ctx-debug-modal');
        if (existingModal) {
          if (typeof existingModal.__agyCleanup === 'function') {
            existingModal.__agyCleanup();
          } else {
            existingModal.remove();
          }
          return;
        }

        if (!view) {
          view = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
        }
        if (!inputBox && view) {
          inputBox = view.querySelector('[data-testid="agent-input-box"]');
        }
        let cascadeId = view ? view.getAttribute('data-cascade-id') : '';
        if (!cascadeId || cascadeId === 'remote-session') {
          try {
            const innerCid = document?.querySelector?.('ga-remote-control iframe')?.contentDocument?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]')?.getAttribute?.('data-cascade-id');
            if (innerCid && innerCid !== 'remote-session') cascadeId = innerCid;
          } catch {}
          if ((!cascadeId || cascadeId === 'remote-session') && window?.__agySniffedCascadeId) {
            cascadeId = window.__agySniffedCascadeId;
          }
        }
        const csrf = window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken;
        const currentCw = cwStore.getSavedContextWindow(cascadeId);
        const maxLimit = cwStore.getLimit(currentCw);
        const cc = hostBridge.getCascadeContextForElement(inputBox || view);
        const asp = cc?.state?.agentStateProvider || (hostBridge.getAgentStateProviderForInputBox ? hostBridge.getAgentStateProviderForInputBox(inputBox || view) : null);
        const slice = asp?.getState?.()?.trajectorySlice;
        const rcGenLen = cascadeId && window?.__agyRcGenLenByCascade ? window.__agyRcGenLenByCascade[cascadeId] : undefined;
        const rcStepLen = cascadeId && window?.__agyRcStepCountByCascade ? window.__agyRcStepCountByCascade[cascadeId] : undefined;
        let totalGenLen = (typeof slice?.totalGeneratorMetadataLength === 'number' && slice.totalGeneratorMetadataLength > 0)
          ? slice.totalGeneratorMetadataLength
          : (typeof rcGenLen === 'number' && rcGenLen > 0 ? rcGenLen : 0);
        const totalStepsLen = (typeof slice?.totalStepsLength === 'number' && slice.totalStepsLength > 0)
          ? slice.totalStepsLength
          : (typeof rcStepLen === 'number' && rcStepLen > 0 ? rcStepLen : 0);
        const trajectoryId = slice?.trajectoryId || '';

        const backdrop = document.createElement('div');
        backdrop.id = 'agy-ctx-debug-modal';
        backdrop.className = 'agy-ctx-modal-backdrop';
        setHtml(backdrop, `
          <div class="agy-ctx-modal" role="dialog" aria-label="Trajectory & Context Debug View">
            <div class="agy-ctx-modal-hdr">
              <span>Trajectory &amp; Context Debug View <span style="opacity:0.6;font-weight:400;font-size:11px">(${escHtml(cascadeId || 'unknown')})</span></span>
              <div class="agy-ctx-modal-hdr-actions">
                <button type="button" class="agy-ctx-btn" id="agy-ctx-toggle-inline-debug" title="채팅창 상단 내장 Trajectory Stats 표시 토글">[ inline stats ]</button>
                <button type="button" class="agy-ctx-btn" id="agy-ctx-modal-close" title="닫기 (ESC)">[ × ]</button>
              </div>
            </div>
            <div class="agy-ctx-modal-body" id="agy-ctx-modal-body">
              <div style="opacity:0.75">컨텍스트 메타데이터를 불러오는 중…</div>
            </div>
          </div>
        `);

        const closeModal = () => {
          backdrop.remove();
          window?.removeEventListener?.('keydown', onKeyDown);
        };
        backdrop.__agyCleanup = closeModal;
        const onKeyDown = (e) => {
          if (e.key === 'Escape') closeModal();
        };
        window.addEventListener('keydown', onKeyDown);
        backdrop.onclick = (e) => {
          if (e.target === backdrop) closeModal();
        };
        document.body.appendChild(backdrop);

        const closeBtn = backdrop.querySelector('#agy-ctx-modal-close');
        if (closeBtn) closeBtn.onclick = closeModal;

        const inlineBtn = backdrop.querySelector('#agy-ctx-toggle-inline-debug');
        if (inlineBtn) {
          inlineBtn.onclick = () => {
            const curCc = hostBridge.getCascadeContextForElement(inputBox || view);
            if (curCc?.debug && typeof curCc.debug.setDebugMode === 'function') {
              curCc.debug.setDebugMode(!curCc.debug.debugMode);
            }
          };
        }

        const bodyEl = backdrop.querySelector('#agy-ctx-modal-body');
        const remoteSvc = hostBridge.getRemoteRpcServiceForElement ? hostBridge.getRemoteRpcServiceForElement(inputBox || view) : null;
        if (!cascadeId || (!csrf && !remoteSvc)) {
          if (bodyEl) {
            setHtml(bodyEl, `<div class="agy-ctx-crit">세션 정보(cascadeId 또는 RPC 연결)를 찾을 수 없습니다.</div>`);
          }
          return;
        }

        try {
          let fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
          let metas = [];
          if (csrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function') {
            try {
              const r = await fetchFn('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
                body: JSON.stringify({ cascadeId, generatorMetadataOffset: fetchOffset }),
              });
              if (r && r.ok !== false) {
                const j = await r.json();
                metas = j.generatorMetadata || [];
              }
            } catch {}
          }
          if (!metas.length && remoteSvc && typeof remoteSvc.getCascadeTrajectoryGeneratorMetadata === 'function') {
            if (totalGenLen <= 0 && totalStepsLen > 60) {
              let cur = Math.ceil(totalStepsLen * 0.52);
              while (cur > 0) {
                const probe = await remoteSvc.getCascadeTrajectoryGeneratorMetadata({ cascadeId, generatorMetadataOffset: cur });
                const pm = probe?.generatorMetadata || [];
                if (pm.length > 0) {
                  totalGenLen = cur + pm.length;
                  break;
                }
                cur = Math.max(0, cur - 35);
              }
            }
            fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
            const j = await remoteSvc.getCascadeTrajectoryGeneratorMetadata({ cascadeId, generatorMetadataOffset: fetchOffset });
            const allMetas = j?.generatorMetadata || [];
            if (allMetas.length > 0) {
              totalGenLen = fetchOffset + allMetas.length;
              if (window && cascadeId) {
                window.__agyRcGenLenByCascade = window.__agyRcGenLenByCascade || {};
                window.__agyRcGenLenByCascade[cascadeId] = totalGenLen;
              }
            }
            metas = allMetas.length > 20 ? allMetas.slice(-20) : allMetas;
          }
          if (!metas.length && remoteSvc && typeof remoteSvc.getCascadeTrajectory === 'function' && !remoteSvc.isRemoteControlHost) {
            const t = await remoteSvc.getCascadeTrajectory({ cascadeId });
            const allMetas = t?.trajectory?.generatorMetadata || [];
            metas = allMetas.length > 20 ? allMetas.slice(-20) : allMetas;
          }
          let parsed = extractStatsFromMetas(metas);
          const fullState = asp?.getState?.();
          if (fullState && typeof fullState === 'object') {
            const cwUsage = fullState.contextWindowUsage;
            const compactedSteps = fullState.compactionInfo?.compactedAtStepIndices;
            const latestCompactedStep = Array.isArray(compactedSteps) && compactedSteps.length > 0
              ? Number(compactedSteps[compactedSteps.length - 1])
              : -1;
            if (cwUsage && typeof cwUsage === 'object') {
              const uMax = Number(cwUsage.maxContextTokens || 0);
              if (uMax > 0) {
                parsed.trajectoryMax = uMax;
              }
              const afterCompact = Number(cwUsage.estimatedAfterCompaction || 0);
              const uStep = Number(cwUsage.lastStepIndex ?? -1);
              const uEst = Number(cwUsage.estimatedTokensUsed || 0);
              if (afterCompact > 0 && latestCompactedStep >= 0 && (parsed.lastMetaStepIndex < 0 || latestCompactedStep >= parsed.lastMetaStepIndex)) {
                parsed.used = afterCompact;
                parsed.foundCtx = true;
              } else if (uEst > 0 && (!parsed.foundCtx || (uStep >= 0 && parsed.lastMetaStepIndex >= 0 && uStep > parsed.lastMetaStepIndex))) {
                parsed.used = uEst;
                parsed.foundCtx = true;
              }
            }
          }

          let latestCwm = null;
          let latestSections = [];
          let latestModel = '';
          for (let i = metas.length - 1; i >= 0; i--) {
            const cm = getChatModelFromMeta(metas[i]);
            if (!cm) continue;
            if (!latestModel && (cm.modelDisplayName || cm.responseModel || cm.model)) {
              latestModel = cm.modelDisplayName || cm.responseModel || cm.model;
            }
            if (!latestCwm && cm.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed !== undefined && cm.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed !== null) {
              latestCwm = cm.chatStartMetadata.contextWindowMetadata;
            }
            if (!latestSections.length && Array.isArray(cm.promptSections) && cm.promptSections.length > 0) {
              latestSections = cm.promptSections;
            }
          }

          const used = parsed.used || 0;
          const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
          const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';

          const groups = latestCwm?.tokenBreakdown?.groups || [];
          let breakdownHtml = '';
          if (groups.length > 0) {
            const rows = groups.map((g) => {
              const gTok = Number(g.numTokens || 0);
              const gPct = used > 0 ? ((gTok / used) * 100).toFixed(1) : '0.0';
              return `<tr>
                <td>${escHtml(g.name || g.type || g.source || 'Section')}</td>
                <td class="num">${fmtNum(gTok)}</td>
                <td class="num">${gPct}%</td>
              </tr>`;
            }).join('');
            breakdownHtml = `
              <div>
                <div class="agy-ctx-sec-title"><span>Context Window Token Breakdown</span><span>Total: ${fmtNum(latestCwm?.tokenBreakdown?.totalTokens || used)}</span></div>
                <table class="agy-ctx-tbl">
                  <thead><tr><th>Group / Source</th><th class="num">Tokens</th><th class="num">Share</th></tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            `;
          } else if (latestSections.length > 0) {
            const rows = latestSections.map((s, idx) => {
              const textLen = (s.content || s.templatedContent || '').length;
              return `<tr>
                <td>#${idx + 1} ${escHtml(s.title || s.tokenType || 'PromptSection')}</td>
                <td>${escHtml(s.tokenSource || s.metadata?.sourceType || '-')}</td>
                <td class="num">${fmtNum(textLen)} chars</td>
              </tr>`;
            }).join('');
            breakdownHtml = `
              <div>
                <div class="agy-ctx-sec-title"><span>Prompt Sections (${latestSections.length})</span></div>
                <table class="agy-ctx-tbl">
                  <thead><tr><th>Section Title</th><th>Source</th><th class="num">Size</th></tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            `;
          }

          const recentTurns = [];
          for (let i = metas.length - 1; i >= 0 && recentTurns.length < 12; i--) {
            const m = metas[i];
            const cm = getChatModelFromMeta(m);
            if (!cm) continue;
            const u = cm.usage || {};
            const cwm = cm.chatStartMetadata?.contextWindowMetadata;
            const stepIdx = cm.chatStartMetadata?.startStepIndex ?? m.stepIndices?.[0] ?? (fetchOffset + i);
            const inTok = Number(u.inputTokens || 0);
            const crTok = Number(u.cacheReadTokens || 0);
            const outTok = Number(u.outputTokens || u.responseOutputTokens || 0);
            const thkTok = Number(u.thinkingOutputTokens || 0);
            const totP = inTok + crTok;
            const cPct = totP > 0 ? Math.round((crTok / totP) * 100) + '%' : '-';
            recentTurns.push(`
              <tr>
                <td>#${escHtml(stepIdx)}</td>
                <td>${escHtml(cm.modelDisplayName || cm.responseModel || cm.model || '-')}</td>
                <td class="num">${cwm?.estimatedTokensUsed ? fmtNum(cwm.estimatedTokensUsed) : '-'}</td>
                <td class="num">${fmtNum(crTok)} (${cPct})</td>
                <td class="num">${fmtNum(inTok)}</td>
                <td class="num">${fmtNum(outTok)}${thkTok ? ` <span style="opacity:0.65">(+${fmtNum(thkTok)} thk)</span>` : ''}</td>
              </tr>
            `);
          }

          const info = hostBridge.getModelSelectorContextForView(view);
          const reduxSessionCw = info?.reduxStore?.getState?.()?.modelSelection?.byConversation?.[cascadeId]?.contextWindow || currentCw;

          if (bodyEl) {
            setHtml(bodyEl, `
              <div class="agy-ctx-card-grid">
                <div class="agy-ctx-card">
                  <div class="agy-ctx-card-lbl">Context Used / Session Limit (${escHtml(reduxSessionCw)})</div>
                  <div class="agy-ctx-card-val" style="color:${barColor}">${pct}% (${fmtNum(used)} / ${fmtNum(maxLimit)})</div>
                  <div style="margin-top:5px;height:5px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden">
                    <div style="width:${pct}%;height:100%;background:${barColor}"></div>
                  </div>
                </div>
                <div class="agy-ctx-card">
                  <div class="agy-ctx-card-lbl">Prompt Cache Hit Rate</div>
                  <div class="agy-ctx-card-val agy-ctx-cache">${parsed.cachePct}%</div>
                  <div style="font-size:10px;color:#94a3b8;margin-top:2px">Cache: ${fmtNum(parsed.cacheRead)} · Fresh Input: ${fmtNum(parsed.inputTok)}</div>
                </div>
                <div class="agy-ctx-card">
                  <div class="agy-ctx-card-lbl">Trajectory Metadata</div>
                  <div class="agy-ctx-card-val">${fmtNum(totalStepsLen)} steps · ${fmtNum(totalGenLen)} turns</div>
                  <div style="font-size:10px;color:#94a3b8;margin-top:2px">Last Turn Max: ${fmtNum(parsed.trajectoryMax)} · Model: ${escHtml(latestModel || '-')}</div>
                </div>
              </div>
              ${breakdownHtml}
              <div>
                <div class="agy-ctx-sec-title">
                  <span>Recent Generator Turns (Latest ${recentTurns.length} of ${totalGenLen || metas.length})</span>
                  <span style="font-weight:400;opacity:0.7">Trajectory ID: ${escHtml(trajectoryId || cascadeId)}</span>
                </div>
                <table class="agy-ctx-tbl">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Model</th>
                      <th class="num">Est. Ctx</th>
                      <th class="num">Cache Read</th>
                      <th class="num">Fresh Input</th>
                      <th class="num">Output (+Think)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${recentTurns.length ? recentTurns.join('') : '<tr><td colspan="6" style="opacity:0.6">생성된 턴 메타데이터가 아직 없습니다.</td></tr>'}
                  </tbody>
                </table>
              </div>
            `);
          }
        } catch (err) {
          if (bodyEl) {
            setHtml(bodyEl, `<div class="agy-ctx-crit">메타데이터 조회 실패: ${escHtml(err?.message || err)}</div>`);
          }
        }
      }

      return {
        id: 'context',
        slot: 'right',
        order: 20,
        builtin: true,
        className: 'agy-ctx-btn agy-ctx-btn-context',
        label: '[ context ]',
        title: '상세 컨텍스트 디버그 창 열기/닫기',
        onClick({ view, inputBox }) {
          openOrToggleDebugModal(view, inputBox);
        },
        openOrToggleDebugModal,
      };
    }

    module.exports = {
      createContextButtonAdapter,
    };

  },
  "./index": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';

    const { CONTEXT_WINDOWS, PRESET_CONTEXT_WINDOWS, createContextWindowStore } = require('./context-window-policy');
    const { ensureStyleElement, createTrustedHtmlSetter } = require('./dom-styles');
    const { registerCustomCwInPrototype, createHostBridge } = require('./host-bridge');
    const { createRpcClient } = require('./rpc-client');
    const { createAdapterRegistry } = require('./adapter-registry');
    const { createCoreMetricsAdapter } = require('./adapters/core-metrics');
    const { createCompactButtonAdapter } = require('./adapters/compact-button');
    const { createContextButtonAdapter } = require('./adapters/context-button');

    const STATUSBAR_VERSION = 'v19';

    function injectScriptText(win, doc, code) {
      if (!code || !doc?.head) return false;
      const s = doc.createElement('script');
      const nonceEl = doc.querySelector?.('script[nonce]');
      const nonce = nonceEl ? nonceEl.nonce || nonceEl.getAttribute?.('nonce') : '';
      if (nonce) s.nonce = nonce;
      let policy = win.__agyTrustedTypesPolicy || null;
      if (!policy && win.trustedTypes && typeof win.trustedTypes.createPolicy === 'function') {
        try {
          policy = win.trustedTypes.createPolicy('agy-rc-' + Date.now(), {
            createScript: (x) => x,
          });
          win.__agyTrustedTypesPolicy = policy;
        } catch {}
      }
      s.text = policy ? policy.createScript(code) : code;
      doc.head.appendChild(s);
      return true;
    }

    function ensureRemoteCompanionScripts(win, doc, fetchFn, hostBridge) {
      try {
        const isRemoteWeb = Boolean(
          win?.location?.hostname && String(win.location.hostname).includes('antigravity.google.com')
        );
        if (!isRemoteWeb || !doc?.head) return Promise.resolve(null);
        const effFetch = fetchFn || win?.fetch;

        const loadScript = (flagKey, url, fallbackCode) => {
          if (win[flagKey]) return Promise.resolve(false);
          win[flagKey] = true;
          if (fallbackCode && injectScriptText(win, doc, fallbackCode)) {
            return Promise.resolve(true);
          }
          if (typeof effFetch !== 'function') {
            win[flagKey] = false;
            return Promise.resolve(false);
          }
          return Promise.resolve(
            effFetch(`${url}?t=${Date.now()}`)
          )
            .then((r) => (r && r.ok !== false && typeof r.text === 'function' ? r.text() : ''))
            .then((code) => {
              if (!code) {
                win[flagKey] = false;
                return false;
              }
              return injectScriptText(win, doc, code);
            })
            .catch(() => {
              win[flagKey] = false;
              return false;
            });
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
            return info;
          }

          const tasks = [];
          if (info.hasMcpManager && !win.agyMcpManager) {
            tasks.push(
              loadScript(
                '__agyLoadingMcpManagerCompanion',
                'https://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js',
                info.mcpManagerCode
              )
            );
          }
          if (info.hasKoTranslator && !win.__agyKoLocalizerActive && !win.__agyKoThoughtCleanup) {
            tasks.push(
              loadScript(
                '__agyLoadingKoTranslatorCompanion',
                'https://raw.githubusercontent.com/jaeseongs95/antigravity-ko-translator/main/plugins/ko-thought-translator/scripts/ko_thought_autoinject.js',
                info.koTranslatorCode
              )
            );
          }
          await Promise.all(tasks);
          return info;
        };

        return tryLoadInstalledCompanions();
      } catch {
        return Promise.resolve(null);
      }
    }

    function mountStatusBar(env = {}) {
      const win = env.window || (typeof window !== 'undefined' ? window : null);
      const doc = env.document || win?.document || (typeof document !== 'undefined' ? document : null);
      const ls = env.localStorage || win?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
      const fetchFn = env.fetch || win?.fetch || (typeof fetch !== 'undefined' ? fetch : null);

      if (!win || !doc) return null;

      if (win.__agyStatusBarActiveVersion === STATUSBAR_VERSION && win.__agyStatusBarCleanup) {
        return win.agyStatusBar;
      }
      if (win.__agyStatusBarCleanup) {
        try { win.__agyStatusBarCleanup(); } catch {}
      }

      const underDefaultCwSet = new Set(['128K', '256K']);
      const refreshStyles = () => ensureStyleElement(doc, underDefaultCwSet);
      let hostBridge = null;

      const cwStore = createContextWindowStore({
        document: doc,
        localStorage: ls,
        nativeStorage: win.nativeStorage,
        onCustomCw: (cw) => {
          let extraWin = null;
          try {
            extraWin = doc.querySelector?.('ga-remote-control iframe')?.contentWindow || null;
          } catch {}
          registerCustomCwInPrototype(cw, underDefaultCwSet, refreshStyles, extraWin);
        },
        onSaveCw: (cid) => {
          if (hostBridge && typeof hostBridge.pushSessionCwToServer === 'function') {
            const targetView = (cid && doc.querySelector?.(`[data-testid="conversation-view"][data-cascade-id="${cid}"]`))
              || doc.querySelector?.('[data-testid="conversation-view"]');
            hostBridge.pushSessionCwToServer(
              cid,
              win.__APP_CONFIG__?.csrfToken,
              targetView
            );
          }
        },
      });

      refreshStyles();

      const setHtml = createTrustedHtmlSetter(win, doc);
      hostBridge = createHostBridge({
        window: win,
        document: doc,
        localStorage: ls,
        fetchFn,
        cwStore,
      });
      ensureRemoteCompanionScripts(win, doc, fetchFn, hostBridge);

      const rpcClient = createRpcClient({
        window: win,
        fetchFn,
        localStorage: ls,
        getAgentStateProviderForInputBox: hostBridge.getAgentStateProviderForInputBox,
        getRemoteRpcServiceForElement: hostBridge.getRemoteRpcServiceForElement,
      });

      function getConversationContextWindow(view, cascadeId) {
        if (cascadeId && !cwStore.hasSessionOverride(cascadeId)) {
          const info = hostBridge.getModelSelectorContextForView(view);
          const reduxCw = info?.reduxStore?.getState?.()?.modelSelection?.byConversation?.[cascadeId]?.contextWindow;
          cwStore.seedSessionIfEmpty(cascadeId, reduxCw);
        }
        const saved = cwStore.getSavedContextWindow(cascadeId);
        hostBridge.applyContextWindowToEngine(view, cascadeId, saved);
        return saved;
      }

      function setConversationContextWindow(view, cascadeId, rawTargetCw) {
        const norm = cwStore.saveContextWindowSetting(cascadeId, rawTargetCw);
        if (!norm) return null;
        if (view) {
          view.__lastAppliedTargetCw = norm;
          view.__lastObservedDomCw = norm;
          view.__ignoreDomCwUntil = Date.now() + 500;
        }
        hostBridge.applyContextWindowToEngine(view, cascadeId, norm, true);
        return norm;
      }

      function cycleConversationContextWindow(view, cascadeId) {
        const current = cwStore.getSavedContextWindow(cascadeId);
        const idx = CONTEXT_WINDOWS.indexOf(current);
        const next = CONTEXT_WINDOWS[(idx + 1) % CONTEXT_WINDOWS.length];
        setConversationContextWindow(view, cascadeId, next);
        return next;
      }

      const registry = createAdapterRegistry({
        window: win,
        document: doc,
        setHtml,
        onUpdate: () => updateAll(),
      });

      const coreMetricsAdapter = createCoreMetricsAdapter({
        document: doc,
        setHtml,
        cwStore,
        getConversationContextWindow,
        setConversationContextWindow,
        cycleConversationContextWindow,
        updateAll: () => updateAll(),
      });

      const compactButtonAdapter = createCompactButtonAdapter({
        runCompactForInputBox: hostBridge.runCompactForInputBox,
      });

      const contextButtonAdapter = createContextButtonAdapter({
        window: win,
        document: doc,
        fetchFn,
        setHtml,
        cwStore,
        hostBridge,
      });

      registry.registerBuiltinAdapters([
        coreMetricsAdapter,
        compactButtonAdapter,
        contextButtonAdapter,
      ]);

      function renderBar(barEl, view, inputBox, stats, quota) {
        const cascadeId = view.getAttribute('data-cascade-id');
        const { leftEl, rightEl } = registry.ensureBarStructure(barEl);
        const ctx = {
          barEl,
          view,
          inputBox,
          cascadeId,
          stats,
          quota,
          updateAll,
          getConversationContextWindow: () => getConversationContextWindow(view, cascadeId),
          setConversationContextWindow: (cw) => setConversationContextWindow(view, cascadeId, cw),
        };
        registry.renderSlotAdapters(leftEl, 'left', ctx);
        registry.renderSlotAdapters(rightEl, 'right', ctx);
      }

      function updateAll() {
        refreshStyles();
        hostBridge.ensureContextWindowSelectorFlag();
        hostBridge.ensureCustomizationsStoreLoaded();
        hostBridge.ensureRemoteHostView(() => updateAll());
        const csrf = win.__APP_CONFIG__ && win.__APP_CONFIG__.csrfToken;
        const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
        if (!views.length) return;
        if (!csrf && !hostBridge.getRemoteRpcServiceForElement(views[0])) return;

        const quotaPromise = rpcClient.fetchQuota(csrf, views[0]);
        hostBridge.syncDesktopAnnotations(csrf, views[0], () => updateAll());

        for (const view of views) {
          const cascadeId = view.getAttribute('data-cascade-id');
          const inputBox = view.querySelector('[data-testid="agent-input-box"]');
          if (!cascadeId || !inputBox) continue;

          if (view.__lastTrackedCascadeId !== cascadeId) {
            view.__lastTrackedCascadeId = cascadeId;
            view.__lastObservedDomCw = null;
            view.__lastAppliedTargetCw = null;
            view.__ignoreDomCwUntil = Date.now() + 500;
          }

          const triggerEl = hostBridge.getModelSelectorContextForView(view)?.triggerEl || view.querySelector('[data-testid="model-selector-trigger"]');
          const domCw = cwStore.normalize(triggerEl ? triggerEl.getAttribute('data-context-window') : null);
          const canAdoptFromDom = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
          if (canAdoptFromDom && domCw && PRESET_CONTEXT_WINDOWS.includes(domCw) && view.__lastObservedDomCw && view.__lastObservedDomCw !== domCw) {
            const savedCw = cwStore.getSavedContextWindow(cascadeId);
            if (domCw !== savedCw && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
              cwStore.saveContextWindowSetting(cascadeId, domCw);
            }
          }

          const targetCw = getConversationContextWindow(view, cascadeId);
          view.__lastAppliedTargetCw = targetCw;
          if (triggerEl && canAdoptFromDom) {
            view.__lastObservedDomCw = triggerEl.getAttribute('data-context-window') || targetCw;
          }

          let barEl = inputBox.querySelector('.agy-ctx-statusbar');
          if (!barEl) {
            barEl = doc.createElement('div');
            barEl.className = 'agy-ctx-statusbar';
            inputBox.appendChild(barEl);
          }

          const cachedData = rpcClient.getCachedStats(cascadeId);

          Promise.all([
            rpcClient.fetchCascadeStats(cascadeId, csrf, inputBox),
            quotaPromise,
          ]).then(([data, freshQuota]) => {
            if (!barEl.isConnected || view.getAttribute('data-cascade-id') !== cascadeId) return;
            const finalData = data || cachedData;
            renderBar(barEl, view, inputBox, finalData, freshQuota || rpcClient.getLatestQuota());
          });
        }
      }

      win.agyStatusBar = {
        version: STATUSBAR_VERSION,
        registerAdapter: registry.registerAdapter,
        unregisterAdapter: registry.unregisterAdapter,
        getAdapters: registry.getAdapters,
        updateAll,
        getConversationContextWindow,
        setConversationContextWindow,
      };

      cwStore.loadPersistentContextSettings().then(() => {
        hostBridge.syncDesktopAnnotations(
          win.__APP_CONFIG__?.csrfToken,
          doc.querySelector?.('[data-testid="conversation-view"]'),
          () => updateAll(),
          true
        );
        updateAll();
      });
      updateAll();

      const setIntervalFn = env.setInterval || win.setInterval || setInterval;
      const clearIntervalFn = env.clearInterval || win.clearInterval || clearInterval;
      const timer = setIntervalFn(updateAll, 3000);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      const ObsClass = env.MutationObserver || win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      const obs = ObsClass ? new ObsClass(() => {
        const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
        for (const view of views) {
          const cid = view.getAttribute('data-cascade-id');
          const box = view.querySelector('[data-testid="agent-input-box"]');
          if (box && (!box.querySelector('.agy-ctx-statusbar') || box.__lastCascadeId !== cid || view.__lastTrackedCascadeId !== cid)) {
            box.__lastCascadeId = cid;
            view.__lastTrackedCascadeId = cid;
            view.__lastObservedDomCw = null;
            view.__lastAppliedTargetCw = null;
            view.__ignoreDomCwUntil = Date.now() + 500;
            updateAll();
            return;
          }
          const trigger = hostBridge.getModelSelectorContextForView(view)?.triggerEl || view.querySelector('[data-testid="model-selector-trigger"]');
          if (cid && trigger) {
            const actual = cwStore.normalize(trigger.getAttribute('data-context-window')) || '256K';
            const expected = cwStore.getSavedContextWindow(cid);
            const model = hostBridge.getSelectedModelKey(view, cid);
            const expectedKey = (model || '') + ':' + String(expected);
            const lastByCid = win.__agyLastAppliedContextWindowByCascade?.[cid];
            if (actual !== expected && lastByCid !== expectedKey && win.__agyLastAppliedContextWindow !== expectedKey) {
              const canAdopt = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
              if (canAdopt && PRESET_CONTEXT_WINDOWS.includes(actual) && view.__lastObservedDomCw && view.__lastObservedDomCw !== actual && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
                cwStore.saveContextWindowSetting(cid, actual);
                view.__lastAppliedTargetCw = actual;
                view.__lastObservedDomCw = actual;
                updateAll();
              } else {
                hostBridge.applyContextWindowToEngine(view, cid, expected);
                view.__lastObservedDomCw = trigger.getAttribute('data-context-window') || expected;
              }
            }
          }
        }
      }) : null;

      function attachBodyObserver() {
        if (!obs) return;
        const rootTarget = doc.body || doc.documentElement;
        if (!rootTarget) {
          win.addEventListener?.('DOMContentLoaded', attachBodyObserver, { once: true });
          return;
        }
        obs.observe(rootTarget, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-cascade-id', 'data-context-window'],
        });
      }
      attachBodyObserver();

      win.__agyStatusBarCleanup = () => {
        delete win.__agyStatusBarActiveVersion;
        clearIntervalFn(timer);
        if (obs) obs.disconnect();
        const m = doc.getElementById('agy-ctx-debug-modal');
        if (m) {
          if (typeof m.__agyCleanup === 'function') m.__agyCleanup();
          else m.remove();
        }
        const menus = doc.querySelectorAll('.agy-ctx-menu');
        for (const menu of menus) {
          if (typeof menu.__agyCleanup === 'function') menu.__agyCleanup();
          else menu.remove();
        }
        const bars = doc.querySelectorAll('.agy-ctx-statusbar');
        for (const b of bars) b.remove();
        const hostViews = doc.querySelectorAll('.agy-rc-host-view');
        for (const hv of hostViews) hv.remove();
      };
      win.__agyStatusBarActiveVersion = STATUSBAR_VERSION;

      return win.agyStatusBar;
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      mountStatusBar();
    }

    module.exports = {
      STATUSBAR_VERSION,
      ensureRemoteCompanionScripts,
      mountStatusBar,
    };

  }
  };
  const __cache = {};
  function __resolve(baseDir, spec) {
    const cleanSpec = spec.replace(/\.js$/, '');
    const parts = (baseDir + '/' + cleanSpec).split('/');
    const out = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return './' + out.join('/');
  }
  function __require(baseDir, spec) {
    const id = __resolve(baseDir, spec);
    if (__cache[id]) return __cache[id].exports;
    const fn = __modules[id];
    if (!fn) throw new Error('Module not found: ' + id);
    const module = { exports: {} };
    __cache[id] = module;
    fn(module, module.exports, __require);
    return module.exports;
  }
  __require('.', './index');
})();
