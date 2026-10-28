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

  },
  "./dom-styles": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';

    const STYLE_CSS = `
        .agy-ctx-statusbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 4px 10px 2px 10px;
          margin-top: 2px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          line-height: 1.4;
          color: rgba(160, 165, 175, 0.88);
          user-select: none;
          flex-wrap: wrap;
          position: relative;
        }
        .agy-ctx-left, .agy-ctx-right {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
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
          bottom: 24px;
          left: 50px;
          background: #1e1e24;
          border: 1px solid rgba(128, 128, 128, 0.35);
          border-radius: 6px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65);
          z-index: 10000;
          padding: 6px 0;
          display: flex;
          flex-direction: column;
          min-width: 215px;
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
      const parent = document.head || document.documentElement;
      if (!parent) return;
      let styleEl = document.getElementById('agy-ctx-statusbar-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'agy-ctx-statusbar-style';
        parent.appendChild(styleEl);
      }
      const fullCss = STYLE_CSS + buildDynamicCwWarnCss(underDefaultCwSet);
      if (styleEl.textContent !== fullCss) {
        styleEl.textContent = fullCss;
      }
    }

    function createTrustedHtmlSetter(window, document) {
      if (window?.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
        const names = ['agy-statusbar', 'default', 'dompurify', 'nextjs#bundler'];
        for (const name of names) {
          try {
            const p = window.trustedTypes.createPolicy(name, { createHTML: (s) => s });
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
      if (!n || isNaN(n)) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
      if (n >= 1000) return Math.round(n / 1000) + 'k';
      return String(n);
    }

    function fmtNum(n) {
      if (n === null || n === undefined || isNaN(n)) return '0';
      return Number(n).toLocaleString('en-US');
    }

    function escHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function fmtResetTime(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
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

    function extractStatsFromMetas(metas) {
      let used = 0, max = 256000, cacheRead = 0, inputTok = 0;
      let foundCtx = false, foundUsage = false;
      for (let i = metas.length - 1; i >= 0; i--) {
        const cm = metas[i] && metas[i].chatModel;
        if (!cm) continue;
        if (!foundCtx && cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata) {
          const cwm = cm.chatStartMetadata.contextWindowMetadata;
          if (cwm.estimatedTokensUsed) {
            used = cwm.estimatedTokensUsed;
            max = cwm.maxContextTokens || 256000;
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
      return { used, trajectoryMax: max, cacheRead, inputTok, cachePct, foundCtx, foundUsage };
    }

    function createRpcClient({ fetchFn, localStorage, getAgentStateProviderForInputBox }) {
      const stateCache = new Map();
      const inFlightStats = new Map();
      let inFlightQuota = null;
      let quotaData = null;
      let lastQuotaFetch = 0;

      try {
        const rawCache = localStorage?.getItem(STATS_CACHE_KEY);
        if (rawCache) {
          const entries = JSON.parse(rawCache);
          if (Array.isArray(entries)) {
            for (const [k, v] of entries) stateCache.set(k, v);
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

      function fetchQuota(csrf) {
        const now = Date.now();
        if (now - lastQuotaFetch < 15000 && quotaData) return Promise.resolve(quotaData);
        if (inFlightQuota) return inFlightQuota;
        lastQuotaFetch = now;
        inFlightQuota = (async () => {
          try {
            const r = await fetchFn('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
              body: '{}',
            });
            const j = await r.json();
            const groups = (j.response && j.response.groups) || j.groups || [];
            const geminiGroup = groups.find((g) => (g.displayName || g.groupName || '').includes('Gemini')) || groups[0];
            if (geminiGroup && geminiGroup.buckets) {
              const b5h = geminiGroup.buckets.find((b) => b.window === '5h');
              const b7d = geminiGroup.buckets.find((b) => b.window === 'weekly');
              quotaData = {
                pct5h: b5h && typeof b5h.remainingFraction === 'number' ? Math.round(b5h.remainingFraction * 100) : null,
                rst5h: b5h ? fmtResetTime(b5h.resetTime) : '',
                pct7d: b7d && typeof b7d.remainingFraction === 'number' ? Math.round(b7d.remainingFraction * 100) : null,
              };
            }
          } catch {}
          inFlightQuota = null;
          return quotaData;
        })();
        return inFlightQuota;
      }

      function fetchCascadeStats(cascadeId, csrf, inputBox) {
        const asp = getAgentStateProviderForInputBox ? getAgentStateProviderForInputBox(inputBox) : null;
        const slice = asp?.getState?.()?.trajectorySlice;
        const totalGenLen = slice?.totalGeneratorMetadataLength ?? -1;
        const totalStepsLen = slice?.totalStepsLength ?? -1;
        const versionKey = `${totalGenLen}:${totalStepsLen}`;

        const cached = stateCache.get(cascadeId);
        if (cached && cached.versionKey === versionKey && totalGenLen >= 0 && (Date.now() - cached.ts < 30000)) {
          return Promise.resolve(cached);
        }

        if (inFlightStats.has(cascadeId)) {
          return inFlightStats.get(cascadeId);
        }

        const promise = (async () => {
          try {
            const tailOffset = totalGenLen > 3 ? totalGenLen - 3 : 0;
            const r = await fetchFn('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
              body: JSON.stringify({ cascadeId, generatorMetadataOffset: tailOffset }),
            });
            const j = await r.json();
            const metas = j.generatorMetadata || [];
            let parsed = extractStatsFromMetas(metas);

            if (!parsed.foundCtx && tailOffset > 0) {
              const widerOffset = Math.max(0, totalGenLen - 15);
              const r2 = await fetchFn('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
                body: JSON.stringify({ cascadeId, generatorMetadataOffset: widerOffset }),
              });
              const j2 = await r2.json();
              parsed = extractStatsFromMetas(j2.generatorMetadata || []);
            }

            const data = {
              used: parsed.used,
              trajectoryMax: parsed.trajectoryMax,
              cacheRead: parsed.cacheRead,
              inputTok: parsed.inputTok,
              cachePct: parsed.cachePct,
              versionKey,
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
        getCachedStats: (cascadeId) => stateCache.get(cascadeId) || null,
        getLatestQuota: () => quotaData,
      };
    }

    module.exports = {
      extractStatsFromMetas,
      createRpcClient,
    };

  },
  "./host-bridge": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';

    const COMPACT_ARGS = '현재 상황을 유지하고 이어서 작업할 수 있게 내부 컨텍스트(<CONTEXT_SUMMARY>)로만 요약해. 사용자의 요청 원문과 목표, 확정된 결정과 그 이유, 수정한 파일 경로와 핵심 변경, 실행한 검증과 결과(실패 메시지 포함), 진행 중인 작업과 남은 할 일, 사용자가 준 제약과 피드백은 빠짐없이 남기고, 끝난 탐색 과정과 긴 도구 출력은 결론만 남겨. 단, 채팅창 응답으로는 요약 내용을 다시 출력하거나 반복하지 말고 "컨텍스트 압축 완료." 한 줄만 출력하고 즉시 턴을 종료해.';

    function registerCustomCwInPrototype(cw, underDefaultCwSet, onStyleUpdate) {
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
      if (Object.prototype.hasOwnProperty.call(Object.prototype, cw)) return;
      try {
        Object.defineProperty(Object.prototype, cw, {
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

    function createHostBridge({ window, document, localStorage, cwStore }) {
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

      function ensureContextWindowSelectorFlag() {
        if (!document) return;
        const views = document.querySelectorAll('[data-testid="conversation-view"]');
        for (const view of views) {
          const fk = Object.keys(view).find((k) => k.startsWith('__reactFiber$'));
          let fiber = fk ? view[fk] : null;
          while (fiber) {
            const val = fiber.memoizedProps?.value;
            if (val && typeof val === 'object' && typeof val.get === 'function') {
              if (!val.__cwsPatched) {
                const origGet = val.get;
                val.get = function (name) {
                  if (name === 'contextWindowSelector') {
                    return { enabled: true, feature: { enabled: true } };
                  }
                  return origGet.apply(this, arguments);
                };
                val.__cwsPatched = true;
              }
            }
            fiber = fiber.return;
          }
        }
      }

      function getModelSelectorContextForView(view) {
        ensureContextWindowSelectorFlag();
        if (!view) return null;
        const triggerEl = view.querySelector('[data-testid="model-selector-trigger"]');
        const startEl = triggerEl || view;
        const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
        let fiber = fk ? startEl[fk] : null;
        let msCtx = null;
        let reduxStore = null;
        let legacyCtx = null;
        while (fiber) {
          const val = fiber.memoizedProps?.value;
          if (val && typeof val === 'object') {
            if (!msCtx && typeof val.setSelectedModel === 'function' && ('selectedModel' in val)) {
              msCtx = val;
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
        return { msCtx, reduxStore, legacyCtx, triggerEl };
      }

      function getCascadeContextForElement(el) {
        if (!el) return null;
        const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        let curr = fk ? el[fk] : null;
        while (curr) {
          const val = curr.memoizedProps?.value;
          if (val?.cascadeContext?.state?.agentStateProvider) {
            return val.cascadeContext;
          }
          if (val?.state?.agentStateProvider && val?.debug) {
            return val;
          }
          curr = curr.return;
        }
        return null;
      }

      function getAgentStateProviderForInputBox(inputBox) {
        const cc = getCascadeContextForElement(inputBox);
        return cc?.state?.agentStateProvider || null;
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
        const info = getModelSelectorContextForView(view);
        if (!info) return false;

        const { msCtx, reduxStore, legacyCtx, triggerEl } = info;
        if (triggerEl) {
          const warnAttr = cwStore.getLimit(targetCw) > 256000 ? '1' : '0';
          if (triggerEl.getAttribute('data-agy-cw-warn') !== warnAttr) {
            triggerEl.setAttribute('data-agy-cw-warn', warnAttr);
          }
        }
        const currentInDom = triggerEl ? cwStore.normalize(triggerEl.getAttribute('data-context-window')) : null;
        const selectedModel = getSelectedModelKey(view, cascadeId, info);
        const applyKey = (selectedModel || '') + ':' + String(targetCw);
        if ((currentInDom === targetCw || window.__agyLastAppliedContextWindow === applyKey) && !force) return true;

        if (msCtx || reduxStore) {
          const state = reduxStore ? reduxStore.getState() : null;
          const byConvo = state?.modelSelection?.byConversation?.[cascadeId];
          const currentInRedux = byConvo?.contextWindow || msCtx?.contextWindow?.selected || currentInDom || '256K';
          const selectedModelObj = msCtx?.selectedModel;
          let dispatched = false;

          if (currentInRedux !== targetCw || force) {
            const prevDefaultCw = state?.modelSelection?.default?.contextWindow;
            if (msCtx?.contextWindow && typeof msCtx.contextWindow.select === 'function' && selectedModelObj) {
              msCtx.contextWindow.select(selectedModelObj, targetCw);
              dispatched = true;
            } else if (typeof msCtx?.setSelectedModel === 'function' && selectedModelObj) {
              msCtx.setSelectedModel(selectedModelObj, targetCw);
              dispatched = true;
            } else if (reduxStore) {
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
          if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
            triggerEl.setAttribute('data-context-window', String(targetCw));
          }
          return true;
        }
        return false;
      }

      async function runCompactForInputBox(inputBox) {
        if (!inputBox) return;
        const editable = inputBox.querySelector('[contenteditable="true"]');
        if (!editable || !editable.__lexicalEditor) return;
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
        while (curr && (!curr.memoizedProps || typeof curr.memoizedProps.handleEnter === 'function' === false)) {
          curr = curr.return;
        }
        if (curr && curr.memoizedProps && typeof curr.memoizedProps.handleEnter === 'function') {
          const Evt = typeof KeyboardEvent === 'function' ? KeyboardEvent : function (t, o) { Object.assign(this, o, { type: t }); };
          await curr.memoizedProps.handleEnter(new Evt('keydown', { key: 'Enter' }), ed);
        } else {
          const sendBtn = inputBox.querySelector('[data-testid="send-button"]');
          if (sendBtn && !sendBtn.disabled) sendBtn.click();
        }
      }

      return {
        ensureContextWindowSelectorFlag,
        getModelSelectorContextForView,
        getCascadeContextForElement,
        getAgentStateProviderForInputBox,
        getSelectedModelKey,
        applyContextWindowToEngine,
        runCompactForInputBox,
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

      function removeAdapterDomElements(id) {
        if (!document || typeof document.querySelectorAll !== 'function') return;
        const bars = document.querySelectorAll('.agy-ctx-statusbar');
        for (const bar of bars) {
          const nodes = bar.querySelectorAll(`[data-agy-adapter-id="${id}"]`);
          for (const node of nodes) {
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
              try { node.remove(); } catch {}
            }
          }
        }

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
          existing.remove();
          return;
        }

        const currentCw = getConversationContextWindow(view, cascadeId);
        const currentKNum = parseInt(currentCw, 10) || 512;
        const menu = document.createElement('div');
        menu.className = 'agy-ctx-menu';

        if (typeof menu.addEventListener === 'function') {
          for (const evtName of ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'contextmenu']) {
            menu.addEventListener(evtName, (ev) => ev.stopPropagation());
          }
        }

        const hdr = document.createElement('div');
        hdr.className = 'agy-ctx-menu-hdr';
        setHtml(hdr, `
          <span>세션 컨텍스트 한도</span>
          <span style="opacity:0.75">${escHtml(cascadeId ? cascadeId.slice(0, 8) : '현재 세션')}</span>
        `);
        menu.appendChild(hdr);

        const customRow = document.createElement('div');
        customRow.className = 'agy-ctx-custom-row';
        setHtml(customRow, `
          <input type="text" class="agy-ctx-custom-input" value="${escHtml(currentKNum)}" placeholder="32~980" title="32 ~ 980 사이 숫자 입력 (예: 400 입력 시 400K 적용)" />
          <span class="agy-ctx-custom-unit">K</span>
          <button type="button" class="agy-ctx-custom-apply">적용</button>
        `);
        menu.appendChild(customRow);

        const closeMenu = () => {
          menu.remove();
          document?.removeEventListener('mousedown', outsideHandler, true);
        };

        const inputEl = customRow.querySelector('.agy-ctx-custom-input');
        const applyBtn = customRow.querySelector('.agy-ctx-custom-apply');
        const applyCustomInput = () => {
          if (!inputEl) return;
          const norm = cwStore.normalize(inputEl.value);
          if (!norm) {
            if (inputEl.style) inputEl.style.borderColor = '#ec7063';
            return;
          }
          setConversationContextWindow(view, cascadeId, norm);
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
            setConversationContextWindow(view, cascadeId, cw);
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
        setTimeout(() => {
          document?.addEventListener('mousedown', outsideHandler, true);
          if (inputEl && inputEl.isConnected && typeof inputEl.focus === 'function') {
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
        className: 'agy-ctx-left',
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
          const limitTitle = `이 세션(${cascadeId ? cascadeId.slice(0, 8) : '현재'})의 컨텍스트 한도: ${currentCw} (${cwStore.getQuotaHint(currentCw)})\n클릭 시 직접 입력 / 프리셋 선택 메뉴 열기 (세션별 독립 적용)\nShift+클릭 시 256K → 512K → 900K 빠른 순환`;

          let quotaHtml = '';
          if (quota) {
            const qParts = [];
            if (quota.pct5h !== null) {
              qParts.push(`5h <strong class="agy-ctx-quota">${quota.pct5h}%</strong> left${quota.rst5h ? ' ' + quota.rst5h : ''}`);
            }
            if (quota.pct7d !== null) {
              qParts.push(`7d <strong class="agy-ctx-quota">${quota.pct7d}%</strong> left`);
            }
            if (qParts.length) {
              quotaHtml = `<span class="agy-ctx-sep">|</span><span>${qParts.join(' <span class="agy-ctx-sep">·</span> ')}</span>`;
            }
          }

          const html = `
            <span class="agy-ctx-bar-wrap"><span class="agy-ctx-bar-fill" style="width:${pct}%;background:${barColor}"></span></span>
            <span>ctx <strong class="${colorClass}">${pct}%</strong> ${usedStr}/<button type="button" class="agy-ctx-btn agy-ctx-btn-limit ${limitModClass}" title="${limitTitle}">[ ${currentCw.toLowerCase()} ▾ ]</button></span>
            <span class="agy-ctx-sep">·</span>
            <span>cache <strong class="agy-ctx-cache">${cachePct}%</strong></span>
            ${quotaHtml}
          `;

          if (containerEl.__lastHtml !== html) {
            containerEl.__lastHtml = html;
            try {
              containerEl.innerHTML = html;
            } catch {
              setHtml(containerEl, html);
            }

            const limitBtn = containerEl.querySelector ? containerEl.querySelector('.agy-ctx-btn-limit') : null;
            if (limitBtn) {
              limitBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) {
                  cycleConversationContextWindow(view, cascadeId);
                  updateAll();
                } else {
                  showContextMenu(barEl, view, cascadeId, limitBtn);
                }
              };
              limitBtn.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showContextMenu(barEl, view, cascadeId, limitBtn);
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
    const { extractStatsFromMetas } = require('../rpc-client');

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
          existingModal.remove();
          return;
        }

        if (!view) {
          view = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
        }
        if (!inputBox && view) {
          inputBox = view.querySelector('[data-testid="agent-input-box"]');
        }
        const cascadeId = view ? view.getAttribute('data-cascade-id') : '';
        const csrf = window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken;
        const currentCw = cwStore.getSavedContextWindow(cascadeId);
        const maxLimit = cwStore.getLimit(currentCw);
        const cc = hostBridge.getCascadeContextForElement(inputBox || view);
        const asp = cc?.state?.agentStateProvider;
        const slice = asp?.getState?.()?.trajectorySlice;
        const totalGenLen = slice?.totalGeneratorMetadataLength ?? 0;
        const totalStepsLen = slice?.totalStepsLength ?? 0;
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
          window.removeEventListener('keydown', onKeyDown);
        };
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
        if (!csrf || !cascadeId) {
          if (bodyEl) {
            setHtml(bodyEl, `<div class="agy-ctx-crit">세션 정보(cascadeId 또는 CSRF 토큰)를 찾을 수 없습니다.</div>`);
          }
          return;
        }

        try {
          const fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
          const r = await fetchFn('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
            body: JSON.stringify({ cascadeId, generatorMetadataOffset: fetchOffset }),
          });
          const j = await r.json();
          const metas = j.generatorMetadata || [];
          const parsed = extractStatsFromMetas(metas);

          let latestCwm = null;
          let latestSections = [];
          let latestModel = '';
          for (let i = metas.length - 1; i >= 0; i--) {
            const cm = metas[i]?.chatModel;
            if (!cm) continue;
            if (!latestModel && (cm.modelDisplayName || cm.responseModel || cm.model)) {
              latestModel = cm.modelDisplayName || cm.responseModel || cm.model;
            }
            if (!latestCwm && cm.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed) {
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
            const cm = m?.chatModel;
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

    const { CONTEXT_WINDOWS, createContextWindowStore } = require('./context-window-policy');
    const { ensureStyleElement, createTrustedHtmlSetter } = require('./dom-styles');
    const { registerCustomCwInPrototype, createHostBridge } = require('./host-bridge');
    const { createRpcClient } = require('./rpc-client');
    const { createAdapterRegistry } = require('./adapter-registry');
    const { createCoreMetricsAdapter } = require('./adapters/core-metrics');
    const { createCompactButtonAdapter } = require('./adapters/compact-button');
    const { createContextButtonAdapter } = require('./adapters/context-button');

    const STATUSBAR_VERSION = 'v7';

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
      win.__agyStatusBarActiveVersion = STATUSBAR_VERSION;

      const underDefaultCwSet = new Set(['128K', '256K']);
      const refreshStyles = () => ensureStyleElement(doc, underDefaultCwSet);

      const cwStore = createContextWindowStore({
        document: doc,
        localStorage: ls,
        nativeStorage: win.nativeStorage,
        onCustomCw: (cw) => registerCustomCwInPrototype(cw, underDefaultCwSet, refreshStyles),
      });

      refreshStyles();

      const setHtml = createTrustedHtmlSetter(win, doc);
      const hostBridge = createHostBridge({
        window: win,
        document: doc,
        localStorage: ls,
        cwStore,
      });

      const rpcClient = createRpcClient({
        fetchFn,
        localStorage: ls,
        getAgentStateProviderForInputBox: hostBridge.getAgentStateProviderForInputBox,
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
        const csrf = win.__APP_CONFIG__ && win.__APP_CONFIG__.csrfToken;
        if (!csrf) return;
        const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
        if (!views.length) return;

        const quotaPromise = rpcClient.fetchQuota(csrf);

        for (const view of views) {
          const cascadeId = view.getAttribute('data-cascade-id');
          const inputBox = view.querySelector('[data-testid="agent-input-box"]');
          if (!cascadeId || !inputBox) continue;

          const triggerEl = view.querySelector('[data-testid="model-selector-trigger"]');
          const domCw = cwStore.normalize(triggerEl ? triggerEl.getAttribute('data-context-window') : null);
          const canAdoptFromDom = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
          if (canAdoptFromDom && domCw && CONTEXT_WINDOWS.includes(domCw) && view.__lastObservedDomCw && view.__lastObservedDomCw !== domCw) {
            const savedCw = cwStore.getSavedContextWindow(cascadeId);
            if (domCw !== savedCw && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
              cwStore.saveContextWindowSetting(cascadeId, domCw);
            }
          }

          const targetCw = cwStore.getSavedContextWindow(cascadeId);
          hostBridge.applyContextWindowToEngine(view, cascadeId, targetCw);
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
        updateAll();
      });
      updateAll();

      const timer = setInterval(updateAll, 3000);
      const ObsClass = env.MutationObserver || win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      const obs = ObsClass ? new ObsClass(() => {
        const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
        for (const view of views) {
          const cid = view.getAttribute('data-cascade-id');
          const box = view.querySelector('[data-testid="agent-input-box"]');
          if (box && (!box.querySelector('.agy-ctx-statusbar') || box.__lastCascadeId !== cid)) {
            box.__lastCascadeId = cid;
            updateAll();
            return;
          }
          const trigger = view.querySelector('[data-testid="model-selector-trigger"]');
          if (cid && trigger) {
            const actual = cwStore.normalize(trigger.getAttribute('data-context-window')) || '256K';
            const expected = cwStore.getSavedContextWindow(cid);
            const model = hostBridge.getSelectedModelKey(view, cid);
            const expectedKey = (model || '') + ':' + String(expected);
            if (actual !== expected && win.__agyLastAppliedContextWindow !== expectedKey) {
              const canAdopt = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
              if (canAdopt && CONTEXT_WINDOWS.includes(actual) && view.__lastObservedDomCw && view.__lastObservedDomCw !== actual && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
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
        clearInterval(timer);
        if (obs) obs.disconnect();
        const m = doc.getElementById('agy-ctx-debug-modal');
        if (m) m.remove();
        const bars = doc.querySelectorAll('.agy-ctx-statusbar');
        for (const b of bars) b.remove();
      };

      return win.agyStatusBar;
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      mountStatusBar();
    }

    module.exports = {
      STATUSBAR_VERSION,
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
