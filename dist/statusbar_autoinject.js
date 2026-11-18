// ==UserScript==
// @name         Antigravity Custom Statusbar (Local & Remote Control)
// @namespace    https://github.com/jaeseongs95/antigravity-statusbar
// @version      2.0.0
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
  "./ports/contracts": function(module, exports, __require) {
    const require = (spec) => __require("./ports", spec);
    'use strict';
    /**
     * Pure Port Contracts, Validators, and Isolated v2 Plugin Bus (`Symbol.for('agy.plugin.bus.v2')`).
     * Zero DOM, browser global, or vendor string dependencies.
     */
    const PLUGIN_BUS_SYMBOL = Symbol.for('agy.plugin.bus.v2');
    function assertPortMethods(port, portName, requiredMethods) {
      if (!port || typeof port !== 'object') {
        throw new TypeError(`${portName} must be an object`);
      }
      for (const method of requiredMethods) {
        if (typeof port[method] !== 'function') {
          throw new TypeError(`${portName} missing required method "${method}"`);
        }
      }
      return port;
    }
    const TRANSPORT_PORT_METHODS = Object.freeze([
      'getStats',
      'getCachedStats',
      'getImmediateStats',
      'getQuota',
      'getLatestQuota',
      'getAllTrajectories',
      'updateAnnotations',
      'getGeneratorMetadataRange',
      'dispose',
    ]);
    const STORAGE_PORT_METHODS = Object.freeze([
      'loadSnapshot',
      'loadPersistent',
      'readSessionOverride',
      'saveSessionOverride',
      'evictSessionOverride',
      'saveDefaultLimit',
    ]);
    const ENGINE_PORT_METHODS = Object.freeze([
      'observeSessions',
      'getActiveSessions',
      'applyContextLimit',
      'triggerCompact',
      'getSelectedModelKey',
      'getDebugSnapshot',
      'dispose',
    ]);
    const DOCUMENT_HOST_PORT_METHODS = Object.freeze([
      'getAccessibleDocs',
      'getIframeDocument',
      'buildWarningSuppressionCss',
      'resolveViewSessionId',
      'findFallbackSessionTarget',
    ]);
    const COMPANION_LOADER_PORT_METHODS = Object.freeze([
      'discoverCompanions',
      'loadCompanions',
    ]);
    function validateTransportPort(port) {
      return assertPortMethods(port, 'TransportPort', TRANSPORT_PORT_METHODS);
    }
    function validateStoragePort(port) {
      return assertPortMethods(port, 'StoragePort', STORAGE_PORT_METHODS);
    }
    function validateEnginePort(port) {
      return assertPortMethods(port, 'EnginePort', ENGINE_PORT_METHODS);
    }
    function validateDocumentHostPort(port) {
      return assertPortMethods(port, 'DocumentHostPort', DOCUMENT_HOST_PORT_METHODS);
    }
    function validateCompanionLoaderPort(port) {
      return assertPortMethods(port, 'CompanionLoaderPort', COMPANION_LOADER_PORT_METHODS);
    }
    function getOrCreatePluginBus(hostRoot) {
      const target = hostRoot && (typeof hostRoot === 'object' || typeof hostRoot === 'function') ? hostRoot : globalThis;
      const existing = target[PLUGIN_BUS_SYMBOL];
      if (
        existing &&
        typeof existing === 'object' &&
        existing.version === 2 &&
        typeof existing.registerPlugin === 'function' &&
        typeof existing.on === 'function'
      ) {
        return existing;
      }
      const plugins = new Map();
      const listeners = new Map();
      const bus = {
        version: 2,
        registerPlugin(id, metadata = {}) {
          const cleanId = typeof id === 'string' ? id.trim() : '';
          if (!cleanId) {
            throw new TypeError('Plugin id must be a non-empty string');
          }
          const entry = Object.freeze({
            id: cleanId,
            version: String(metadata.version || '0.0.0'),
            capabilities: Array.isArray(metadata.capabilities) ? Object.freeze([...metadata.capabilities]) : Object.freeze([]),
            registeredAt: Date.now(),
          });
          plugins.set(cleanId, entry);
          bus.emit('plugin:registered', entry);
          return () => bus.unregisterPlugin(cleanId);
        },
        unregisterPlugin(id) {
          const cleanId = typeof id === 'string' ? id.trim() : '';
          if (!cleanId || !plugins.has(cleanId)) return false;
          const prev = plugins.get(cleanId);
          plugins.delete(cleanId);
          bus.emit('plugin:unregistered', prev);
          return true;
        },
        getPlugin(id) {
          return plugins.get(id) || null;
        },
        listPlugins() {
          return Array.from(plugins.values());
        },
        on(event, handler) {
          if (typeof event !== 'string' || !event || typeof handler !== 'function') {
            return () => {};
          }
          let set = listeners.get(event);
          if (!set) {
            set = new Set();
            listeners.set(event, set);
          }
          set.add(handler);
          return () => {
            set.delete(handler);
            if (set.size === 0) listeners.delete(event);
          };
        },
        off(event, handler) {
          const set = listeners.get(event);
          if (!set) return false;
          const deleted = set.delete(handler);
          if (set.size === 0) listeners.delete(event);
          return deleted;
        },
        emit(event, payload) {
          const set = listeners.get(event);
          if (!set || set.size === 0) return 0;
          let count = 0;
          for (const fn of Array.from(set)) {
            try {
              fn(payload);
              count += 1;
            } catch {}
          }
          return count;
        },
      };
      try {
        Object.defineProperty(target, PLUGIN_BUS_SYMBOL, {
          value: bus,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      } catch {
        target[PLUGIN_BUS_SYMBOL] = bus;
      }
      return bus;
    }
    module.exports = {
      PLUGIN_BUS_SYMBOL,
      TRANSPORT_PORT_METHODS,
      STORAGE_PORT_METHODS,
      ENGINE_PORT_METHODS,
      DOCUMENT_HOST_PORT_METHODS,
      COMPANION_LOADER_PORT_METHODS,
      assertPortMethods,
      validateTransportPort,
      validateStoragePort,
      validateEnginePort,
      validateDocumentHostPort,
      validateCompanionLoaderPort,
      getOrCreatePluginBus,
    };
  },
  "./domain/i18n": function(module, exports, __require) {
    const require = (spec) => __require("./domain", spec);
    'use strict';
    /**
     * Pure Domain Internationalization (`en` default + built-in `ko` toggle).
     * Zero DOM or vendor globals.
     */
    const DEFAULT_LOCALE = 'en';
    const SUPPORTED_LOCALES = Object.freeze(['en', 'ko']);
    const DEFAULT_COMPACT_PROMPT =
      'Summarize the current state concisely in internal context only so work can resume seamlessly: preserve exact user goals, confirmed decisions and reasons, edited file paths and key changes, executed checks/results (including failures), remaining work, and constraints/feedback, while condensing finished exploration and long tool outputs to conclusions. Respond with a single confirmation line and end the turn immediately.';
    const MESSAGES = Object.freeze({
      en: Object.freeze({
        'compact.label': '[ compact ]',
        'compact.title': 'Run system /compact immediately with configured summary prompt',
        'context.label': '[ context ]',
        'context.title': 'Toggle detailed context & trajectory debug modal',
        'metrics.currentSession': 'current',
        'metrics.limitTitle': 'Session ({session}) context limit: {cw} ({hint})\nClick to open custom input / preset selector (per-session)\nShift+Click to cycle 256K -> 512K -> 900K',
        'metrics.cacheLabel': 'cache',
        'metrics.ctxLabel': 'ctx',
        'metrics.leftLabel': 'left',
        'menu.headerLeft': 'Session Context Limit',
        'menu.headerRight': 'Per-session · 32K~980K',
        'menu.customPlaceholder': 'e.g. 400 or 750K',
        'menu.apply': 'Apply',
        'menu.customHint': 'Supports 32K–980K · Enter to apply · Click outside or Esc to close',
        'menu.saveAsDefault': 'Save {cw} as new-session default ({defCw})',
        'preset.128K': 'Saver (~0.7x)',
        'preset.256K': 'Default quota (1.0x)',
        'preset.384K': 'Mid limit (~1.15x)',
        'preset.512K': 'High (~1.3x quota/turn)',
        'preset.750K': 'Large (~1.6x)',
        'preset.900K': 'Max (~1.8x quota/turn)',
        'preset.customLow': 'Saver (<1.0x)',
        'preset.customMult': 'Custom (~{mult}x est.)',
        'modal.title': 'Trajectory & Context Debug View',
        'modal.inlineStats': '[ inline stats ]',
        'modal.inlineStatsTitle': 'Toggle built-in top Trajectory Stats banner',
        'modal.close': '[ × ]',
        'modal.closeTitle': 'Close (ESC)',
        'modal.loading': 'Loading context telemetry…',
        'modal.noSession': 'Session metadata unavailable (missing cascadeId or RPC transport).',
        'modal.fetchFailed': 'Failed to load telemetry: {error}',
        'modal.cardCtx': 'Context Used / Session Limit ({cw})',
        'modal.cardCache': 'Prompt Cache Hit Rate',
        'modal.cardCacheSub': 'Cache: {cache} · Fresh Input: {input}',
        'modal.cardTraj': 'Trajectory Metadata',
        'modal.cardTrajVal': '{steps} steps · {turns} turns',
        'modal.cardTrajSub': 'Last Turn Max: {max} · Model: {model}',
        'modal.breakdownTitle': 'Context Window Token Breakdown',
        'modal.breakdownTotal': 'Total: {total}',
        'modal.colGroupSource': 'Group / Source',
        'modal.colTokens': 'Tokens',
        'modal.colShare': 'Share',
        'modal.sectionsTitle': 'Prompt Sections ({count})',
        'modal.colSectionTitle': 'Section Title',
        'modal.colSource': 'Source',
        'modal.colSize': 'Size',
        'modal.turnsTitle': 'Recent Generator Turns (Latest {shown} of {total})',
        'modal.trajectoryId': 'Trajectory ID: {id}',
        'modal.colStep': 'Step',
        'modal.colModel': 'Model',
        'modal.colEstCtx': 'Est. Ctx',
        'modal.colCacheRead': 'Cache Read',
        'modal.colFreshInput': 'Fresh Input',
        'modal.colOutputThink': 'Output (+Think)',
        'modal.noTurns': 'No generator turn metadata recorded yet.',
        'modal.charsUnit': '{count} chars',
        'modal.thkSuffix': '(+{count} thk)',
      }),
      ko: Object.freeze({
        'compact.label': '[ compact ]',
        'compact.title': '지정된 요약 프롬프트로 시스템 /compact 즉시 실행',
        'context.label': '[ context ]',
        'context.title': '상세 컨텍스트 디버그 창 열기/닫기',
        'metrics.currentSession': '현재',
        'metrics.limitTitle': '이 세션({session})의 컨텍스트 한도: {cw} ({hint})\n클릭 시 직접 입력 / 프리셋 선택 메뉴 열기 (세션별 독립 적용)\nShift+클릭 시 256K → 512K → 900K 빠른 순환',
        'metrics.cacheLabel': 'cache',
        'metrics.ctxLabel': 'ctx',
        'metrics.leftLabel': 'left',
        'menu.headerLeft': '컨텍스트 한도 설정',
        'menu.headerRight': '세션별 적용 · 32K~980K',
        'menu.customPlaceholder': '예: 400 또는 750K',
        'menu.apply': '적용',
        'menu.customHint': '32K~980K 직접 입력 · Enter 적용 · 바깥 클릭/Esc 닫기',
        'menu.saveAsDefault': '기본값으로 저장 ({cw} → 새 채팅 기본값: {defCw})',
        'preset.128K': '절약 모드 (~0.7x)',
        'preset.256K': '기본 쿼터 (1.0x)',
        'preset.384K': '중간 한도 (~1.15x)',
        'preset.512K': '턴당 약 1.3배 쿼터 소비',
        'preset.750K': '대용량 (~1.6x)',
        'preset.900K': '턴당 약 1.8배 쿼터 소비',
        'preset.customLow': '절약 모드 (<1.0x)',
        'preset.customMult': '직접 지정 (~{mult}x 추정)',
        'modal.title': 'Trajectory & Context Debug View',
        'modal.inlineStats': '[ inline stats ]',
        'modal.inlineStatsTitle': '채팅창 상단 내장 Trajectory Stats 표시 토글',
        'modal.close': '[ × ]',
        'modal.closeTitle': '닫기 (ESC)',
        'modal.loading': '컨텍스트 메타데이터를 불러오는 중…',
        'modal.noSession': '세션 정보(cascadeId 또는 RPC 연결)를 찾을 수 없습니다.',
        'modal.fetchFailed': '메타데이터 조회 실패: {error}',
        'modal.cardCtx': '사용 컨텍스트 / 세션 한도 ({cw})',
        'modal.cardCache': '프롬프트 캐시 적중률',
        'modal.cardCacheSub': '캐시: {cache} · 신규 입력: {input}',
        'modal.cardTraj': 'Trajectory 메타데이터',
        'modal.cardTrajVal': '{steps} steps · {turns} turns',
        'modal.cardTrajSub': '직전 턴 상한: {max} · 모델: {model}',
        'modal.breakdownTitle': '컨텍스트 윈도우 토큰 상세',
        'modal.breakdownTotal': '합계: {total}',
        'modal.colGroupSource': '그룹 / 소스',
        'modal.colTokens': '토큰',
        'modal.colShare': '비중',
        'modal.sectionsTitle': '프롬프트 섹션 ({count})',
        'modal.colSectionTitle': '섹션 제목',
        'modal.colSource': '소스',
        'modal.colSize': '크기',
        'modal.turnsTitle': '최근 생성 턴 ({shown} / {total})',
        'modal.trajectoryId': 'Trajectory ID: {id}',
        'modal.colStep': '스텝',
        'modal.colModel': '모델',
        'modal.colEstCtx': '추정 Ctx',
        'modal.colCacheRead': '캐시 읽기',
        'modal.colFreshInput': '신규 입력',
        'modal.colOutputThink': '출력 (+사고)',
        'modal.noTurns': '생성된 턴 메타데이터가 아직 없습니다.',
        'modal.charsUnit': '{count} chars',
        'modal.thkSuffix': '(+{count} thk)',
      }),
    });
    function resolveLocale(preferred, hostLanguage) {
      const pref = typeof preferred === 'string' ? preferred.trim().toLowerCase() : '';
      if (pref === 'en' || pref === 'ko') return pref;
      if (pref === 'auto') {
        const lang = typeof hostLanguage === 'string' ? hostLanguage.trim().toLowerCase() : '';
        return lang.startsWith('ko') ? 'ko' : 'en';
      }
      return DEFAULT_LOCALE;
    }
    function formatMessage(template, vars) {
      if (!vars || typeof vars !== 'object') return template;
      return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, k) =>
        vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
      );
    }
    function createTranslator(initialLocale = DEFAULT_LOCALE, hostLanguage = '') {
      let currentLocale = resolveLocale(initialLocale, hostLanguage);
      function setLocale(nextLocale, nextHostLanguage) {
        currentLocale = resolveLocale(nextLocale, nextHostLanguage !== undefined ? nextHostLanguage : hostLanguage);
        return currentLocale;
      }
      function getLocale() {
        return currentLocale;
      }
      function t(key, vars) {
        const dict = MESSAGES[currentLocale] || MESSAGES[DEFAULT_LOCALE];
        const template = dict[key] !== undefined ? dict[key] : (MESSAGES[DEFAULT_LOCALE][key] ?? key);
        return formatMessage(template, vars);
      }
      return {
        getLocale,
        setLocale,
        t,
      };
    }
    module.exports = {
      DEFAULT_LOCALE,
      SUPPORTED_LOCALES,
      DEFAULT_COMPACT_PROMPT,
      MESSAGES,
      resolveLocale,
      formatMessage,
      createTranslator,
    };
  },
  "./domain/context-window-policy": function(module, exports, __require) {
    const require = (spec) => __require("./domain", spec);
    'use strict';
    /**
     * Pure Context Window Policy Domain Module.
     * Enforces [32K, 980K] clamping, 200-entry synchronized LRU eviction, lazy session override preservation,
     * and remote annotation profile serialization without any DOM, browser storage, or vendor coupling.
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
            storage?.evictSessionOverride?.(oldestKey);
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
      function snapshotSessionMap() {
        trimSessionMaps(MAX_SESSION_ENTRIES);
        return Object.fromEntries(sessionCwMap.entries());
      }
      function snapshotSessionTsMap() {
        const out = {};
        for (const [k, ts] of sessionCwTsMap.entries()) {
          if (typeof ts === 'number' && ts > 0 && (k === '__default__' || sessionCwMap.has(k))) {
            out[k] = ts;
          }
        }
        return out;
      }
      function applyHydratedItems(items) {
        if (!items || typeof items !== 'object') return false;
        let applied = false;
        const savedDef = normalize(items.defaultCw ?? items[DEFAULT_CW_KEY]);
        if (savedDef) {
          defaultCwCache = savedDef;
          hasExplicitDefault = true;
          applied = true;
        }
        if (items.tsMap ?? items[STORAGE_TS_MAP_KEY]) {
          loadTsMapFromRaw(items.tsMap ?? items[STORAGE_TS_MAP_KEY]);
          applied = true;
        }
        if (items.sessionMap ?? items[STORAGE_MAP_KEY]) {
          loadMapFromRaw(items.sessionMap ?? items[STORAGE_MAP_KEY]);
          applied = true;
        }
        return applied;
      }
      try {
        applyHydratedItems(storage?.loadSnapshot?.());
      } catch {}
      async function loadPersistentContextSettings() {
        if (!storage || typeof storage.loadPersistent !== 'function') return;
        try {
          const items = await storage.loadPersistent();
          if (!items || typeof items !== 'object') return;
          const hadSessionMap = Boolean(items.sessionMap ?? items[STORAGE_MAP_KEY]);
          applyHydratedItems(items);
          if (hadSessionMap) {
            try {
              storage.saveSessionOverride?.(null, null, {
                sessionMap: snapshotSessionMap(),
                tsMap: snapshotSessionTsMap(),
                deferFlush: true,
              });
            } catch {}
          }
        } catch {}
      }
      function hasSessionOverride(cascadeId) {
        if (!isValidCascadeId(cascadeId)) return false;
        if (sessionCwMap.has(cascadeId)) return true;
        const extOverride = storage?.readSessionOverride?.(cascadeId);
        if (extOverride) {
          const norm = normalize(extOverride.cw);
          if (norm) {
            const prevTs = sessionCwTsMap.get(cascadeId) || 0;
            const ts = typeof extOverride.ts === 'number' && extOverride.ts > prevTs ? extOverride.ts : prevTs || 1;
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
        const deferFlush = Boolean(opts?.deferFlush ?? opts?.deferNativeFlush);
        if (cascadeId !== null && cascadeId !== undefined && cascadeId !== '') {
          if (!isValidCascadeId(cascadeId)) return null;
          touchSessionEntry(cascadeId, norm, ts);
          try {
            storage?.saveSessionOverride?.(cascadeId, norm, {
              ts,
              sessionMap: snapshotSessionMap(),
              tsMap: snapshotSessionTsMap(),
              deferFlush,
            });
          } catch {}
          if (!opts?.fromRemoteSync && typeof onSaveCw === 'function') {
            try { onSaveCw(cascadeId, norm, ts); } catch {}
          }
        } else {
          defaultCwCache = norm;
          hasExplicitDefault = true;
          sessionCwTsMap.set('__default__', ts);
          try {
            storage?.saveDefaultLimit?.(norm, {
              ts,
              tsMap: snapshotSessionTsMap(),
              deferFlush,
            });
          } catch {}
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
                deferFlush: true,
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
                deferFlush: true,
                updatedAtMs: parsed.ts,
              });
              defUpdated = true;
              changed = true;
            }
          }
        }
        if (mapUpdated || defUpdated) {
          const tsSnapshot = snapshotSessionTsMap();
          if (mapUpdated) {
            try {
              storage?.saveSessionOverride?.(null, null, {
                sessionMap: snapshotSessionMap(),
                tsMap: tsSnapshot,
                deferFlush: false,
              });
            } catch {}
          }
          if (defUpdated) {
            try {
              storage?.saveDefaultLimit?.(defaultCwCache, {
                ts: sessionCwTsMap.get('__default__') || 1,
                tsMap: tsSnapshot,
                deferFlush: false,
              });
            } catch {}
          }
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
  },
  "./domain/metrics-calculator": function(module, exports, __require) {
    const require = (spec) => __require("./domain", spec);
    'use strict';
    /**
     * Pure Domain Telemetry & Quota Metrics Calculator.
     * Zero DOM, window, fetch, or vendor dependencies.
     */
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
      const list = Array.isArray(metas) ? metas : [];
      let used = 0;
      let max = 256000;
      let cacheRead = 0;
      let inputTok = 0;
      let lastMetaStepIndex = -1;
      let foundCtx = false;
      let foundUsage = false;
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        const cm = getChatModelFromMeta(m);
        if (!cm) continue;
        if (!foundCtx && cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata) {
          const cwm = cm.chatStartMetadata.contextWindowMetadata;
          if (cwm.estimatedTokensUsed !== undefined && cwm.estimatedTokensUsed !== null) {
            used = Number(cwm.estimatedTokensUsed);
            max = Number(cwm.maxContextTokens || 256000);
            if (Array.isArray(m.stepIndices) && m.stepIndices.length > 0) {
              lastMetaStepIndex = Number(m.stepIndices[m.stepIndices.length - 1]);
            } else if (cm.chatStartMetadata.startStepIndex !== undefined && cm.chatStartMetadata.startStepIndex !== null) {
              lastMetaStepIndex = Number(cm.chatStartMetadata.startStepIndex);
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
    function parseQuotaResponse(j) {
      if (!j || typeof j !== 'object') return null;
      const groups = (j.response && j.response.groups) || j.groups || [];
      const geminiGroup = groups.find((g) => (g.displayName || g.groupName || '').includes('Gemini')) || groups[0];
      if (geminiGroup && Array.isArray(geminiGroup.buckets)) {
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
    /**
     * Fail-closed cascade state matching (`D-0033`):
     * Rejects snapshots missing an explicit conversation/cascade ID or belonging to another session.
     */
    function isStateForCascade(fullState, cascadeId) {
      if (!fullState || typeof fullState !== 'object' || !cascadeId) return false;
      const stateCid =
        fullState.conversationId ||
        fullState.cascadeId ||
        fullState.trajectorySlice?.conversationId ||
        fullState.trajectorySlice?.cascadeId ||
        null;
      if (!stateCid) return false;
      return stateCid === cascadeId;
    }
    function applyRealtimeCompactionAndUsage(parsed, fullState) {
      if (!fullState || typeof fullState !== 'object') return parsed;
      const cwUsage = fullState.contextWindowUsage;
      const compactedSteps = Array.isArray(fullState.compactedAtStepIndices)
        ? fullState.compactedAtStepIndices
        : fullState.compactionInfo?.compactedAtStepIndices;
      const latestCompactedStep =
        Array.isArray(compactedSteps) && compactedSteps.length > 0
          ? Number(compactedSteps[compactedSteps.length - 1])
          : -1;
      const base = parsed
        ? { ...parsed }
        : {
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
        const uStep = Number(cwUsage.lastStepIndex ?? -1);
        const uEst = Number(cwUsage.estimatedTokensUsed || 0);
        const rawAfterCompact = cwUsage.estimatedAfterCompaction;
        const afterCompact =
          typeof rawAfterCompact === 'boolean' ? (rawAfterCompact ? uEst : 0) : Number(rawAfterCompact || 0);
        if (
          afterCompact > 0 &&
          latestCompactedStep >= 0 &&
          (base.lastMetaStepIndex < 0 || latestCompactedStep >= base.lastMetaStepIndex)
        ) {
          base.used = afterCompact;
          base.foundCtx = true;
        } else if (
          uEst > 0 &&
          (!base.foundCtx || (uStep >= 0 && base.lastMetaStepIndex >= 0 && uStep > base.lastMetaStepIndex))
        ) {
          base.used = uEst;
          base.foundCtx = true;
        }
      }
      return base;
    }
    function extractVersionMetrics(fullState, rcStepCount = -1, fallbackGenLen = -1) {
      const slice = fullState?.trajectorySlice;
      const totalGenLen = slice?.totalGeneratorMetadataLength ?? -1;
      const totalStepsLen = slice?.totalStepsLength ?? -1;
      const compactedSteps = Array.isArray(fullState?.compactedAtStepIndices)
        ? fullState.compactedAtStepIndices
        : fullState?.compactionInfo?.compactedAtStepIndices;
      const latestCompactedStep =
        Array.isArray(compactedSteps) && compactedSteps.length > 0
          ? Number(compactedSteps[compactedSteps.length - 1])
          : -1;
      const rawCwAfter = fullState?.contextWindowUsage?.estimatedAfterCompaction;
      const cwAfterCompact =
        typeof rawCwAfter === 'boolean'
          ? (rawCwAfter ? Number(fullState?.contextWindowUsage?.estimatedTokensUsed || 0) : 0)
          : Number(rawCwAfter || 0);
      const hasLiveVersion = Boolean(fullState && (totalGenLen >= 0 || totalStepsLen >= 0));
      const rcSteps = typeof rcStepCount === 'number' && rcStepCount >= 0 ? rcStepCount : -1;
      const effGenLen = typeof fallbackGenLen === 'number' && fallbackGenLen > 0 ? fallbackGenLen : -1;
      return {
        totalGenLen,
        totalStepsLen,
        latestCompactedStep,
        cwAfterCompact,
        hasLiveVersion,
        rcSteps,
        versionKey: hasLiveVersion
          ? `${totalGenLen}:${totalStepsLen}:${latestCompactedStep}:${cwAfterCompact}`
          : `fallback:${rcSteps}:${effGenLen}`,
      };
    }
    module.exports = {
      fmtK,
      fmtNum,
      fmtResetTime,
      getChatModelFromMeta,
      getBucketRemainingFraction,
      extractStatsFromMetas,
      parseQuotaResponse,
      isStateForCascade,
      applyRealtimeCompactionAndUsage,
      extractVersionMetrics,
    };
  },
  "./drivers/antigravity/host-config": function(module, exports, __require) {
    const require = (spec) => __require("./drivers/antigravity", spec);
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
        typeof overrides.isRemoteHost === 'function' &&
        typeof overrides.resolveCsrfToken === 'function'
      ) {
        return overrides;
      }
      const rawLegacyCfg = win && win.__AGY_HOST_ADAPTER_CONFIG__;
      const rawStatusCfg = win && win.__AGY_STATUSBAR_HOST_CONFIG__;
      const legacyCfg = isPlainConfigObject(rawLegacyCfg) ? rawLegacyCfg : null;
      const statusCfg = isPlainConfigObject(rawStatusCfg) ? rawStatusCfg : null;
      const ovrCfg = isPlainConfigObject(overrides) ? overrides : null;
      const src = {
        ...(legacyCfg || {}),
        ...(statusCfg || {}),
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
        resolveCsrfToken(targetWin = win) {
          const appCfg = targetWin && targetWin.__APP_CONFIG__;
          const tok = isPlainConfigObject(appCfg) && typeof appCfg.csrfToken === 'string' ? appCfg.csrfToken.trim() : '';
          return tok;
        },
      };
    }
    module.exports = {
      DEFAULT_HOST_ADAPTER_CONFIG,
      isPlainConfigObject,
      normalizeHttpsBaseUrl,
      resolveHostAdapterConfig,
    };
  },
  "./drivers/antigravity/protobuf-wire-codec": function(module, exports, __require) {
    const require = (spec) => __require("./drivers/antigravity", spec);
    'use strict';
    /**
     * Pure Protobuf Wire & Connect-RPC 5-Byte Envelope Codec
     * for `SendUserCascadeMessage` checkpoint limit injection and cascade UUID extraction.
     * Zero DOM or window coupling.
     */
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const PROTO_UUID_RE = /\x0a\x24([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const CONVO_RPC_RE =
      /\/(StreamAgentStateUpdates|RequestAgentStatePageUpdate|StreamCascadeReactiveUpdates|GetCascadeTrajectory|GetCascadeTrajectorySteps|GetCascadeTrajectoryGeneratorMetadata|GetCascadeModelConfigData|SendUserCascadeMessage|UpdateConversationAnnotations|StartCascade)$/i;
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
    function createTextCodec(envWin) {
      let sharedDecoder = null;
      let sharedEncoder = null;
      function decodeBytesToText(body) {
        if (!body) return '';
        if (typeof body === 'string') return body;
        try {
          if (!sharedDecoder) {
            const TD = envWin?.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
            if (TD) sharedDecoder = new TD('utf-8');
          }
          if (sharedDecoder) {
            const u8 = toUint8Slice(body) || new Uint8Array(body);
            return sharedDecoder.decode(u8);
          }
        } catch {}
        return '';
      }
      function encodeTextToBytes(str) {
        if (!sharedEncoder) {
          const TE = envWin?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
          if (TE) sharedEncoder = new TE();
        }
        if (sharedEncoder) return sharedEncoder.encode(str);
        return Uint8Array.from(String(str).split('').map((c) => c.charCodeAt(0) & 0xff));
      }
      function decodeBase64ToUtf8(b64) {
        if (!b64 || typeof b64 !== 'string') return '';
        try {
          if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
            return Buffer.from(b64, 'base64').toString('utf8');
          }
          const atobFn = envWin?.atob || (typeof atob === 'function' ? atob : null);
          if (atobFn) {
            const bin = atobFn(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
            return decodeBytesToText(bytes);
          }
        } catch {}
        return '';
      }
      return {
        toUint8Slice,
        decodeBytesToText,
        encodeTextToBytes,
        decodeBase64ToUtf8,
      };
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
    function readProtobufVarint(buf, startOffset) {
      let val = 0;
      let shift = 0;
      let nonZero = false;
      for (let i = 0; i < 10; i++) {
        const idx = startOffset + i;
        if (idx >= buf.length) return null;
        const b = buf[idx];
        if ((b & 0x7f) !== 0) nonZero = true;
        if (shift < 53) {
          val += (b & 0x7f) * (2 ** shift);
        }
        if ((b & 0x80) === 0) {
          return { value: val, nonZero, nextOffset: idx + 1 };
        }
        shift += 7;
      }
      return null;
    }
    function scanProtobufFields(buf) {
      const fields = [];
      let pos = 0;
      while (pos < buf.length) {
        const fieldStart = pos;
        const tagVar = readProtobufVarint(buf, pos);
        if (!tagVar || tagVar.value <= 0) return null;
        const wireType = tagVar.value & 0x07;
        const fieldNumber = Math.floor(tagVar.value / 8);
        if (fieldNumber <= 0) return null;
        pos = tagVar.nextOffset;
        if (wireType === 0) {
          const v = readProtobufVarint(buf, pos);
          if (!v) return null;
          pos = v.nextOffset;
          fields.push({ fieldNumber, wireType, varintNonZero: v.nonZero, rawSlice: buf.subarray(fieldStart, pos) });
        } else if (wireType === 1) {
          if (pos + 8 > buf.length) return null;
          pos += 8;
          fields.push({ fieldNumber, wireType, rawSlice: buf.subarray(fieldStart, pos) });
        } else if (wireType === 2) {
          const lenVar = readProtobufVarint(buf, pos);
          if (!lenVar || lenVar.value < 0 || lenVar.nextOffset + lenVar.value > buf.length) return null;
          const dataStart = lenVar.nextOffset;
          pos = dataStart + lenVar.value;
          fields.push({
            fieldNumber,
            wireType,
            payloadSlice: buf.subarray(dataStart, pos),
            rawSlice: buf.subarray(fieldStart, pos),
          });
        } else if (wireType === 5) {
          if (pos + 4 > buf.length) return null;
          pos += 4;
          fields.push({ fieldNumber, wireType, rawSlice: buf.subarray(fieldStart, pos) });
        } else {
          return null;
        }
      }
      return fields;
    }
    function concatUint8Arrays(chunks) {
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    }
    function buildSendMessageCheckpointSuffix(maxTokenLimit, contextWindow, encodeTextFn) {
      const encodeFn =
        typeof encodeTextFn === 'function'
          ? encodeTextFn
          : (s) => Uint8Array.from(String(s).split('').map((c) => c.charCodeAt(0) & 0xff));
      const cpBytes = [0x28, ...encodeVarint(maxTokenLimit)];
      if (contextWindow && typeof contextWindow === 'string') {
        const cwBytes = Array.from(encodeFn(contextWindow));
        cpBytes.push(0xa2, 0x02, ...encodeVarint(cwBytes.length), ...cwBytes);
      }
      const ccBytes = [0x12, ...encodeVarint(cpBytes.length), ...cpBytes];
      return new Uint8Array([0x2a, ...encodeVarint(ccBytes.length), ...ccBytes]);
    }
    function isValidCheckpointSuffixAt(buf, pos) {
      if (pos < 0 || pos >= buf.length || buf[pos] !== 0x2a) return false;
      const ccLenVar = readProtobufVarint(buf, pos + 1);
      if (!ccLenVar || ccLenVar.nextOffset + ccLenVar.value !== buf.length) return false;
      const innerPos = ccLenVar.nextOffset;
      if (innerPos >= buf.length || buf[innerPos] !== 0x12) return false;
      const cpLenVar = readProtobufVarint(buf, innerPos + 1);
      if (!cpLenVar || cpLenVar.nextOffset + cpLenVar.value !== buf.length) return false;
      const fieldPos = cpLenVar.nextOffset;
      if (fieldPos >= buf.length || buf[fieldPos] !== 0x28) return false;
      const limitVar = readProtobufVarint(buf, fieldPos + 1);
      if (!limitVar || limitVar.value <= 0) return false;
      if (limitVar.nextOffset === buf.length) return true;
      const cwTagPos = limitVar.nextOffset;
      if (cwTagPos + 2 > buf.length || buf[cwTagPos] !== 0xa2 || buf[cwTagPos + 1] !== 0x02) return false;
      const cwLenVar = readProtobufVarint(buf, cwTagPos + 2);
      return Boolean(cwLenVar && cwLenVar.value >= 1 && cwLenVar.value <= 16 && cwLenVar.nextOffset + cwLenVar.value === buf.length);
    }
    function stripTrailingCheckpointSuffix(bytes) {
      if (!bytes || bytes.length < 6) return bytes;
      let cur = bytes;
      let stripped = true;
      while (stripped && cur.length >= 6) {
        stripped = false;
        for (let pos = Math.max(0, cur.length - 32); pos <= cur.length - 6; pos++) {
          if (isValidCheckpointSuffixAt(cur, pos)) {
            cur = cur.subarray(0, pos);
            stripped = true;
            break;
          }
        }
      }
      return cur;
    }
    function findFirstNonWsByte(u8) {
      if (!u8 || u8.length === 0) return -1;
      let i = 0;
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
    function mergeCheckpointIntoProtobufBytes(rawPayload, maxTokenLimit, contextWindow, encodeTextFn) {
      const suffix = buildSendMessageCheckpointSuffix(maxTokenLimit, contextWindow, encodeTextFn);
      const cleanBytes = stripTrailingCheckpointSuffix(rawPayload);
      const topFields = scanProtobufFields(cleanBytes);
      if (topFields) {
        if (topFields.some((f) => f.fieldNumber === 20 && f.wireType === 0 && f.varintNonZero)) {
          return null;
        }
        const existingCascadeFields = topFields.filter((f) => f.fieldNumber === 5 && f.wireType === 2);
        if (existingCascadeFields.length > 0) {
          const preservedCcSubSlices = [];
          const preservedCpSubSlices = [];
          let allSubParsed = true;
          for (const ccField of existingCascadeFields) {
            const ccSubs = scanProtobufFields(ccField.payloadSlice);
            if (!ccSubs) {
              allSubParsed = false;
              break;
            }
            for (const sub of ccSubs) {
              if (sub.fieldNumber === 2 && sub.wireType === 2) {
                const cpSubs = scanProtobufFields(sub.payloadSlice);
                if (!cpSubs) {
                  allSubParsed = false;
                  break;
                }
                for (const cpSub of cpSubs) {
                  if (cpSub.fieldNumber !== 5 && cpSub.fieldNumber !== 36) {
                    preservedCpSubSlices.push(cpSub.rawSlice);
                  }
                }
              } else {
                preservedCcSubSlices.push(sub.rawSlice);
              }
            }
            if (!allSubParsed) break;
          }
          if (allSubParsed) {
            const cpTail = [0x28, ...encodeVarint(maxTokenLimit)];
            if (contextWindow && typeof contextWindow === 'string') {
              const cwBytes = Array.from(encodeTextFn(contextWindow));
              cpTail.push(0xa2, 0x02, ...encodeVarint(cwBytes.length), ...cwBytes);
            }
            const mergedCpPayload = concatUint8Arrays([...preservedCpSubSlices, new Uint8Array(cpTail)]);
            const cpFieldBytes = concatUint8Arrays([
              new Uint8Array([0x12, ...encodeVarint(mergedCpPayload.length)]),
              mergedCpPayload,
            ]);
            const mergedCcPayload = concatUint8Arrays([...preservedCcSubSlices, cpFieldBytes]);
            const singleField5Bytes = concatUint8Arrays([
              new Uint8Array([0x2a, ...encodeVarint(mergedCcPayload.length)]),
              mergedCcPayload,
            ]);
            const nonCascadeSlices = topFields
              .filter((f) => !(f.fieldNumber === 5 && f.wireType === 2))
              .map((f) => f.rawSlice);
            return concatUint8Arrays([...nonCascadeSlices, singleField5Bytes]);
          }
        }
      }
      if (endsWithByteSequence(rawPayload, suffix)) {
        return null;
      }
      const merged = new Uint8Array(cleanBytes.length + suffix.length);
      merged.set(cleanBytes, 0);
      merged.set(suffix, cleanBytes.length);
      return merged;
    }
    function extractCascadeIdFromBody(body, ignoreUuid, codec) {
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
      const text = codec ? codec.decodeBytesToText(targetBody) : '';
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
    function injectCheckpointPayload({ path, body, contextWindow, maxTokenLimit, codec }) {
      if (typeof path !== 'string' || !/\/SendUserCascadeMessage$/i.test(path) || !body) {
        return body;
      }
      if (!contextWindow || !maxTokenLimit || maxTokenLimit <= 0) return body;
      const isContinueAfterInjectionObj = (obj) =>
        Boolean(obj && typeof obj === 'object' && (obj.continueAfterInjection === true || obj.continue_after_injection === true));
      const applyCheckpointToJsonObj = (j) => {
        if (!j || typeof j !== 'object') return j;
        if (isContinueAfterInjectionObj(j)) return j;
        j.cascadeConfig = j.cascadeConfig || {};
        j.cascadeConfig.checkpointConfig = {
          ...(j.cascadeConfig.checkpointConfig || {}),
          contextWindow,
          maxTokenLimit,
        };
        return j;
      };
      try {
        if (typeof body === 'string') {
          const trimmed = body.trim();
          if (trimmed.startsWith('{')) {
            const parsedObj = JSON.parse(trimmed);
            if (isContinueAfterInjectionObj(parsedObj)) return body;
            return JSON.stringify(applyCheckpointToJsonObj(parsedObj));
          }
          return body;
        }
        const u8 = toUint8Slice(body);
        if (!u8) {
          if (typeof body === 'object') {
            if (isContinueAfterInjectionObj(body)) return body;
            const cloned =
              typeof body.clone === 'function'
                ? body.clone()
                : Object.assign(Object.create(Object.getPrototypeOf(body)), body);
            const prevCc = body.cascadeConfig;
            const nextCc =
              prevCc && typeof prevCc === 'object'
                ? (typeof prevCc.clone === 'function'
                    ? prevCc.clone()
                    : Object.assign(Object.create(Object.getPrototypeOf(prevCc)), prevCc))
                : {};
            const prevCp = prevCc?.checkpointConfig;
            const nextCp =
              prevCp && typeof prevCp === 'object'
                ? (typeof prevCp.clone === 'function'
                    ? prevCp.clone()
                    : Object.assign(Object.create(Object.getPrototypeOf(prevCp)), prevCp))
                : {};
            nextCp.contextWindow = contextWindow;
            nextCp.maxTokenLimit = maxTokenLimit;
            nextCc.checkpointConfig = nextCp;
            cloned.cascadeConfig = nextCc;
            return cloned;
          }
          return body;
        }
        if (u8.length === 0) return body;
        if (findFirstNonWsByte(u8) === 0x7b) {
          const text = codec.decodeBytesToText(u8);
          const parsedObj = JSON.parse(text);
          if (isContinueAfterInjectionObj(parsedObj)) return body;
          return codec.encodeTextToBytes(JSON.stringify(applyCheckpointToJsonObj(parsedObj)));
        }
        const frameLen =
          u8.length >= 5
            ? (((u8[1] << 24) >>> 0) + (u8[2] << 16) + (u8[3] << 8) + u8[4])
            : -1;
        const isConnectFrame = u8.length >= 5 && (u8[0] < 8 || (u8[0] & 0x80) !== 0 || frameLen === u8.length - 5);
        if (isConnectFrame) {
          if (frameLen !== u8.length - 5 || u8[0] !== 0) {
            return body;
          }
          const payload = u8.subarray(5);
          if (findFirstNonWsByte(payload) === 0x7b) {
            const text = codec.decodeBytesToText(payload);
            const parsedObj = JSON.parse(text);
            if (isContinueAfterInjectionObj(parsedObj)) return body;
            const j = applyCheckpointToJsonObj(parsedObj);
            return buildConnectFramedBytes(0, codec.encodeTextToBytes(JSON.stringify(j)));
          }
          const nextPayload = mergeCheckpointIntoProtobufBytes(
            payload,
            maxTokenLimit,
            contextWindow,
            codec.encodeTextToBytes
          );
          if (!nextPayload) return body;
          return buildConnectFramedBytes(0, nextPayload);
        }
        const nextUnframed = mergeCheckpointIntoProtobufBytes(
          u8,
          maxTokenLimit,
          contextWindow,
          codec.encodeTextToBytes
        );
        return nextUnframed || body;
      } catch {
        return body;
      }
    }
    module.exports = {
      UUID_RE,
      PROTO_UUID_RE,
      CONVO_RPC_RE,
      toUint8Slice,
      createTextCodec,
      encodeVarint,
      readProtobufVarint,
      scanProtobufFields,
      buildSendMessageCheckpointSuffix,
      stripTrailingCheckpointSuffix,
      mergeCheckpointIntoProtobufBytes,
      buildConnectFramedBytes,
      extractCascadeIdFromBody,
      injectCheckpointPayload,
    };
  },
  "./drivers/antigravity/local-http-transport": function(module, exports, __require) {
    const require = (spec) => __require("./drivers/antigravity", spec);
    'use strict';
    /**
     * Antigravity Storage & Local HTTP / Remote RPC Transport Drivers.
     * Implements `StoragePort` and `TransportPort` with bounded LRU internal caches,
     * fail-closed session telemetry isolation (D-0033), and `.bind(win)` flush timers (NB2).
     */
    const {
      STORAGE_MAP_KEY,
      STORAGE_TS_MAP_KEY,
      DEFAULT_CW_KEY,
      normalizeContextWindow,
    } = require('../../domain/context-window-policy');
    const {
      extractStatsFromMetas,
      parseQuotaResponse,
      isStateForCascade,
      applyRealtimeCompactionAndUsage,
      extractVersionMetrics,
    } = require('../../domain/metrics-calculator');
    const { resolveHostAdapterConfig } = require('./host-config');
    const MAX_CACHE_ENTRIES = 60;
    const MAX_CASCADE_LEN_ENTRIES = 200;
    const STATS_CACHE_KEY = 'agy-stats-cache-v1';
    function setBoundedLruMap(map, key, val, limit) {
      if (!key) return;
      if (map.has(key)) map.delete(key);
      map.set(key, val);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
    function createStorageAdapter({ window, document, localStorage, nativeStorage }) {
      const effNative = nativeStorage || window?.nativeStorage || null;
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
      function getLocalItem(key) {
        try {
          return localStorage?.getItem?.(key) ?? null;
        } catch {
          return null;
        }
      }
      function setLocalItem(key, value) {
        try {
          localStorage?.setItem?.(key, String(value));
        } catch {}
      }
      function flushNative(patchObj) {
        if (effNative && typeof effNative.updateItems === 'function' && patchObj && typeof patchObj === 'object') {
          try {
            effNative.updateItems(patchObj);
          } catch {}
        }
      }
      return {
        loadSnapshot() {
          const lsDef = getLocalItem(DEFAULT_CW_KEY);
          const cDef = readCookie('agy_default_cw');
          return {
            defaultCw: cDef || lsDef || null,
            sessionMap: getLocalItem(STORAGE_MAP_KEY),
            tsMap: getLocalItem(STORAGE_TS_MAP_KEY),
          };
        },
        async loadPersistent() {
          if (!effNative || typeof effNative.getItems !== 'function') return null;
          try {
            const items = await effNative.getItems();
            if (!items || typeof items !== 'object') return null;
            return {
              defaultCw: items[DEFAULT_CW_KEY],
              sessionMap: items[STORAGE_MAP_KEY],
              tsMap: items[STORAGE_TS_MAP_KEY],
            };
          } catch {
            return null;
          }
        },
        readSessionOverride(cascadeId) {
          if (!cascadeId) return null;
          const raw = readCookie('agy_cw_' + cascadeId);
          if (!raw || typeof raw !== 'string') return null;
          const parts = raw.split('|');
          const cw = normalizeContextWindow(parts[0]);
          if (!cw) return null;
          const tsRaw = parts.length > 1 ? parseInt(parts[1], 10) : 1;
          const ts = !isNaN(tsRaw) && tsRaw > 0 ? tsRaw : 1;
          return { cw, ts };
        },
        saveSessionOverride(cascadeId, cw, meta = {}) {
          const ts = typeof meta?.ts === 'number' && meta.ts > 0 ? meta.ts : Date.now();
          if (cascadeId && /^[A-Za-z0-9._:-]{1,128}$/.test(cascadeId) && cw) {
            writeCookie('agy_cw_' + cascadeId, `${cw}|${ts}`);
          }
          const serializedMap =
            meta?.sessionMap !== undefined
              ? typeof meta.sessionMap === 'string'
                ? meta.sessionMap
                : JSON.stringify(meta.sessionMap)
              : null;
          const serializedTs =
            meta?.tsMap !== undefined
              ? typeof meta.tsMap === 'string'
                ? meta.tsMap
                : JSON.stringify(meta.tsMap)
              : null;
          if (serializedMap !== null) setLocalItem(STORAGE_MAP_KEY, serializedMap);
          if (serializedTs !== null) setLocalItem(STORAGE_TS_MAP_KEY, serializedTs);
          if (!meta?.deferFlush && (serializedMap !== null || serializedTs !== null)) {
            const patch = {};
            if (serializedMap !== null) patch[STORAGE_MAP_KEY] = serializedMap;
            if (serializedTs !== null) patch[STORAGE_TS_MAP_KEY] = serializedTs;
            flushNative(patch);
          }
        },
        evictSessionOverride(cascadeId) {
          if (!cascadeId || !/^[A-Za-z0-9._:-]{1,128}$/.test(cascadeId)) return;
          try {
            if (document) {
              document.cookie = `agy_cw_${cascadeId}=; path=/; max-age=0; SameSite=Lax`;
            }
          } catch {}
        },
        saveDefaultLimit(cw, meta = {}) {
          if (cw) {
            writeCookie('agy_default_cw', cw);
            setLocalItem(DEFAULT_CW_KEY, cw);
          }
          const serializedTs =
            meta?.tsMap !== undefined
              ? typeof meta.tsMap === 'string'
                ? meta.tsMap
                : JSON.stringify(meta.tsMap)
              : null;
          if (serializedTs !== null) setLocalItem(STORAGE_TS_MAP_KEY, serializedTs);
          if (!meta?.deferFlush && (cw || serializedTs !== null)) {
            const patch = {};
            if (cw) patch[DEFAULT_CW_KEY] = cw;
            if (serializedTs !== null) patch[STORAGE_TS_MAP_KEY] = serializedTs;
            flushNative(patch);
          }
        },
      };
    }
    function createLocalHttpTransport({
      window,
      fetchFn,
      localStorage,
      getRemoteRpcServiceForElement,
      hostConfig,
      scope,
      onQuotaUpdated,
    }) {
      const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, window);
      const stateCache = new Map();
      const inFlightStats = new Map();
      const knownGenLenMap = new Map();
      const rcStepCountMap = new Map();
      const statsBackoffMap = new Map();
      const activeAbortControllers = new Set();
      let inFlightQuota = null;
      let quotaData = null;
      let quotaBackoffUntil = 0;
      let quotaFailureCount = 0;
      let lastQuotaFetch = 0;
      let cacheFlushTimer = null;
      let disposed = false;
      const getTimerFn = (name, fallback) =>
        window && typeof window[name] === 'function' ? window[name].bind(window) : fallback;
      function registerFetchSignal(externalSignal) {
        if (typeof AbortController !== 'function') {
          return { signal: externalSignal, cleanup() {} };
        }
        const ctrl = new AbortController();
        activeAbortControllers.add(ctrl);
        const onExtAbort = () => {
          try { ctrl.abort(); } catch {}
        };
        if (externalSignal) {
          if (externalSignal.aborted) {
            try { ctrl.abort(); } catch {}
          } else if (typeof externalSignal.addEventListener === 'function') {
            externalSignal.addEventListener('abort', onExtAbort, { once: true });
          }
        }
        return {
          signal: ctrl.signal,
          cleanup() {
            activeAbortControllers.delete(ctrl);
            if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
              try { externalSignal.removeEventListener('abort', onExtAbort); } catch {}
            }
          },
        };
      }
      async function abortableFetch(url, init = {}, externalSignal) {
        if (disposed || scope?.isDisposed?.()) return null;
        const { signal, cleanup } = registerFetchSignal(externalSignal);
        try {
          return await fetchFn(url, { ...init, signal });
        } finally {
          cleanup();
        }
      }
      function setBoundedGenLen(cascadeId, len) {
        if (!cascadeId || !(len > 0)) return;
        setBoundedLruMap(knownGenLenMap, cascadeId, len, MAX_CASCADE_LEN_ENTRIES);
      }
      function recordStepEvent(cascadeId, explicitCount) {
        if (!cascadeId) return;
        if (typeof explicitCount === 'number' && explicitCount >= 0) {
          setBoundedLruMap(rcStepCountMap, cascadeId, explicitCount, MAX_CASCADE_LEN_ENTRIES);
          return;
        }
        const prev = rcStepCountMap.get(cascadeId) || 0;
        setBoundedLruMap(rcStepCountMap, cascadeId, prev + 1, MAX_CASCADE_LEN_ENTRIES);
      }
      function getStepCount(cascadeId) {
        return cascadeId && rcStepCountMap.has(cascadeId) ? rcStepCountMap.get(cascadeId) : -1;
      }
      function canUseLocalHttp(csrf) {
        const win = window || (typeof globalThis !== 'undefined' ? globalThis.window : null);
        if (win?.__APP_CONFIG__?.isRemoteControl) return false;
        const effCsrf = csrf || win?.__APP_CONFIG__?.csrfToken;
        return Boolean(effCsrf && typeof fetchFn === 'function');
      }
      function resolveCsrf(csrf) {
        return csrf || window?.__APP_CONFIG__?.csrfToken || '';
      }
      try {
        const rawCache = localStorage?.getItem?.(STATS_CACHE_KEY);
        if (rawCache) {
          const entries = JSON.parse(rawCache);
          if (Array.isArray(entries)) {
            for (const [k, v] of entries) {
              setBoundedLruMap(stateCache, k, v, MAX_CACHE_ENTRIES);
              if (v && typeof v.knownGenLen === 'number' && v.knownGenLen > 0) {
                setBoundedGenLen(k, v.knownGenLen);
              }
            }
          }
        }
      } catch {}
      function flushStatsCacheToStorage() {
        cacheFlushTimer = null;
        try {
          localStorage?.setItem?.(STATS_CACHE_KEY, JSON.stringify(Array.from(stateCache.entries())));
        } catch {}
      }
      function setBoundedCache(cascadeId, data) {
        setBoundedLruMap(stateCache, cascadeId, data, MAX_CACHE_ENTRIES);
        const setTimer = getTimerFn('setTimeout', typeof setTimeout === 'function' ? setTimeout : null);
        if (setTimer && stateCache.size > 1) {
          if (!cacheFlushTimer) {
            cacheFlushTimer = setTimer(flushStatsCacheToStorage, 250);
            if (cacheFlushTimer && typeof cacheFlushTimer.unref === 'function') cacheFlushTimer.unref();
          }
        } else {
          flushStatsCacheToStorage();
        }
      }
      async function callRpcJson(methodName, reqPayload, csrf, el) {
        if (disposed || scope?.isDisposed?.()) return null;
        const svc = typeof getRemoteRpcServiceForElement === 'function' ? getRemoteRpcServiceForElement(el) : null;
        const rpcPath = resolvedHostConfig.buildRpcPath(methodName);
        const rpcMethodKey = methodName.charAt(0).toLowerCase() + methodName.slice(1);
        if (svc && typeof svc[rpcMethodKey] === 'function') {
          try {
            let svcArg = reqPayload || {};
            if (!svc.isRemoteControlHost) {
              if (rpcMethodKey === 'getCustomizationStates' || rpcMethodKey === 'getAllSkills') {
                svcArg = Array.isArray(reqPayload?.workspaceUris) ? reqPayload.workspaceUris : [];
              } else if (rpcMethodKey === 'readFile' && reqPayload && typeof reqPayload.uri === 'string') {
                try {
                  const directRes = await svc[rpcMethodKey](reqPayload);
                  if (directRes !== undefined && directRes !== null) return directRes;
                } catch {}
                svcArg = reqPayload.uri;
              }
            }
            const res = await svc[rpcMethodKey](svcArg);
            if (res !== undefined && res !== null) return res;
          } catch {}
        }
        if (svc && typeof svc.callJson === 'function') {
          try {
            const res = await svc.callJson(rpcPath, reqPayload || {});
            if (res !== undefined && res !== null) return res;
          } catch {}
        }
        const effCsrf = resolveCsrf(csrf);
        if (canUseLocalHttp(effCsrf)) {
          try {
            const r = await abortableFetch(rpcPath, {
              method: 'POST',
              headers: resolvedHostConfig.buildRpcHeaders(effCsrf),
              body: JSON.stringify(reqPayload || {}),
            });
            if (r && r.ok !== false) return await r.json();
          } catch {}
        }
        return null;
      }
      function getQuota({ csrf, el } = {}) {
        if (disposed || scope?.isDisposed?.()) return Promise.resolve(quotaData);
        const now = Date.now();
        if (now < quotaBackoffUntil) return Promise.resolve(quotaData);
        if (now - lastQuotaFetch < 15000 && quotaData) return Promise.resolve(quotaData);
        if (inFlightQuota) return inFlightQuota;
        lastQuotaFetch = now;
        const effCsrf = resolveCsrf(csrf);
        inFlightQuota = (async () => {
          let hadErrorStatus = false;
          try {
            let j = null;
            if (canUseLocalHttp(effCsrf)) {
              try {
                const r = await abortableFetch(resolvedHostConfig.buildRpcPath('RetrieveUserQuotaSummary'), {
                  method: 'POST',
                  headers: resolvedHostConfig.buildRpcHeaders(effCsrf),
                  body: '{}',
                });
                if (r && r.ok !== false && (!r.status || r.status < 400)) {
                  j = await r.json();
                } else if (r && (r.status === 401 || r.status === 429 || r.status >= 500 || r.ok === false)) {
                  hadErrorStatus = true;
                }
              } catch {
                hadErrorStatus = true;
              }
            }
            if (!j && !disposed && typeof getRemoteRpcServiceForElement === 'function') {
              const svc = getRemoteRpcServiceForElement(el);
              if (svc && typeof svc.retrieveUserQuotaSummary === 'function') {
                j = await svc.retrieveUserQuotaSummary({});
              }
            }
            const parsedQuota = parseQuotaResponse(j);
            if (parsedQuota) {
              quotaData = parsedQuota;
              quotaFailureCount = 0;
              quotaBackoffUntil = 0;
              if (typeof onQuotaUpdated === 'function') {
                try { onQuotaUpdated(quotaData); } catch {}
              }
            } else if (hadErrorStatus || j === null) {
              quotaFailureCount += 1;
              const backoffMs = Math.min(60000, 15000 * (2 ** Math.min(3, quotaFailureCount - 1)));
              quotaBackoffUntil = Date.now() + backoffMs;
            }
          } catch {
            quotaFailureCount += 1;
            const backoffMs = Math.min(60000, 15000 * (2 ** Math.min(3, quotaFailureCount - 1)));
            quotaBackoffUntil = Date.now() + backoffMs;
          } finally {
            inFlightQuota = null;
          }
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
            setBoundedGenLen(cascadeId, nextLen);
            return { metas, knownGenLen: nextLen };
          }
        }
        const sc = totalStepsLen > 0 ? totalStepsLen : 40;
        if (sc <= 60) {
          const metas = await callGenMeta(0);
          if (metas.length > 0) setBoundedGenLen(cascadeId, metas.length);
          return { metas, knownGenLen: metas.length };
        }
        let cur = Math.ceil(sc * 0.42);
        while (cur > 0) {
          const metas = await callGenMeta(cur);
          if (metas.length > 0) {
            const nextLen = cur + metas.length;
            setBoundedGenLen(cascadeId, nextLen);
            return { metas, knownGenLen: nextLen };
          }
          const stepDown = Math.max(35, Math.floor(cur * 0.22));
          cur = Math.max(0, cur - stepDown);
        }
        const metas0 = await callGenMeta(0);
        if (metas0.length > 0) setBoundedGenLen(cascadeId, metas0.length);
        return { metas: metas0, knownGenLen: metas0.length };
      }
      function getStats({ cascadeId, rawState, getLatestState, totalGenLen: extGenLen, totalStepsLen: extStepsLen, csrf, el } = {}) {
        if (disposed || scope?.isDisposed?.() || !cascadeId || cascadeId === 'remote-session') {
          return Promise.resolve(null);
        }
        const fullState = isStateForCascade(rawState, cascadeId) ? rawState : null;
        const cached = stateCache.get(cascadeId);
        const backoffRec = statsBackoffMap.get(cascadeId);
        if (backoffRec && Date.now() < backoffRec.until) {
          return Promise.resolve(cached || null);
        }
        const baseKnownGenLen = knownGenLenMap.get(cascadeId) || cached?.knownGenLen || -1;
        const rcStepCount = getStepCount(cascadeId);
        const ver = extractVersionMetrics(fullState, rcStepCount, baseKnownGenLen);
        const totalGenLen = typeof extGenLen === 'number' && extGenLen > 0 ? extGenLen : ver.totalGenLen;
        const totalStepsLen = typeof extStepsLen === 'number' && extStepsLen > 0 ? extStepsLen : ver.totalStepsLen;
        const knownGenLen = totalGenLen > 0 ? totalGenLen : baseKnownGenLen;
        const cacheTtlMs = ver.hasLiveVersion ? 12000 : 3000;
        if (cached && Date.now() - cached.ts < cacheTtlMs) {
          if (ver.hasLiveVersion) {
            if (cached.versionKey === ver.versionKey) return Promise.resolve(cached);
          } else if (ver.rcSteps < 0 || cached.rcSteps === undefined || cached.rcSteps === ver.rcSteps) {
            return Promise.resolve(cached);
          }
        }
        if (inFlightStats.has(cascadeId)) {
          return inFlightStats.get(cascadeId);
        }
        const effCsrf = resolveCsrf(csrf);
        const promise = (async () => {
          try {
            let parsed = null;
            let discoveredGenLen = knownGenLen;
            let rpcError = false;
            if (canUseLocalHttp(effCsrf)) {
              try {
                const callLocal = async (offset) => {
                  const r = await abortableFetch(resolvedHostConfig.buildRpcPath('GetCascadeTrajectoryGeneratorMetadata'), {
                    method: 'POST',
                    headers: resolvedHostConfig.buildRpcHeaders(effCsrf),
                    body: JSON.stringify({ cascadeId, generatorMetadataOffset: offset }),
                  });
                  if (r && r.ok !== false && (!r.status || r.status < 400)) {
                    const j = await r.json();
                    return j?.generatorMetadata || [];
                  }
                  if (r && (r.status === 401 || r.status === 429 || r.status >= 500 || r.ok === false)) {
                    rpcError = true;
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
              } catch {
                rpcError = true;
              }
            }
            if ((!parsed || (!parsed.foundCtx && !parsed.foundUsage)) && !disposed && typeof getRemoteRpcServiceForElement === 'function') {
              const svc = getRemoteRpcServiceForElement(el);
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
            const latestRaw = typeof getLatestState === 'function' ? getLatestState() : null;
            const latestState = isStateForCascade(latestRaw, cascadeId) ? latestRaw : fullState;
            parsed = applyRealtimeCompactionAndUsage(parsed, latestState);
            if (!parsed || (!parsed.foundCtx && !parsed.foundUsage && discoveredGenLen <= 0)) {
              if (rpcError) {
                const failures = (backoffRec?.failures || 0) + 1;
                const waitMs = Math.min(30000, 3000 * (2 ** Math.min(3, failures - 1)));
                setBoundedLruMap(statsBackoffMap, cascadeId, { failures, until: Date.now() + waitMs }, MAX_CASCADE_LEN_ENTRIES);
              }
              return cached || null;
            }
            statsBackoffMap.delete(cascadeId);
            if (discoveredGenLen > 0) {
              setBoundedGenLen(cascadeId, discoveredGenLen);
            }
            const finalVer = extractVersionMetrics(latestState, getStepCount(cascadeId), discoveredGenLen);
            const data = {
              used: parsed.used,
              trajectoryMax: parsed.trajectoryMax,
              cacheRead: parsed.cacheRead,
              inputTok: parsed.inputTok,
              cachePct: parsed.cachePct,
              lastMetaStepIndex: parsed.lastMetaStepIndex,
              knownGenLen: discoveredGenLen > 0 ? discoveredGenLen : undefined,
              rcSteps: finalVer.rcSteps,
              versionKey: finalVer.versionKey,
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
      function getImmediateStats(cascadeId, snapshot) {
        const cached = cascadeId ? (stateCache.get(cascadeId) || null) : null;
        if (!isStateForCascade(snapshot, cascadeId)) {
          return cached;
        }
        const merged = applyRealtimeCompactionAndUsage(cached ? { ...cached, foundCtx: true } : null, snapshot);
        if (!merged || (!cached && !merged.foundCtx && !merged.foundUsage)) {
          return cached;
        }
        return cached ? { ...cached, used: merged.used, trajectoryMax: merged.trajectoryMax } : merged;
      }
      async function getAllTrajectories(el, csrf) {
        return await callRpcJson('GetAllCascadeTrajectories', {}, csrf, el);
      }
      async function updateAnnotations({ cascadeIds, annotations, mergeAnnotations = true, el, csrf }) {
        const res = await callRpcJson(
          'UpdateConversationAnnotations',
          { cascadeIds, annotations, mergeAnnotations },
          csrf,
          el
        );
        return Boolean(res !== null);
      }
      async function getGeneratorMetadataRange({ cascadeId, offset, el, csrf }) {
        const j = await callRpcJson(
          'GetCascadeTrajectoryGeneratorMetadata',
          { cascadeId, generatorMetadataOffset: offset || 0 },
          csrf,
          el
        );
        if (j && Array.isArray(j.generatorMetadata)) {
          if (j.generatorMetadata.length > 0) {
            setBoundedGenLen(cascadeId, (offset || 0) + j.generatorMetadata.length);
          }
          return j.generatorMetadata;
        }
        const svc = typeof getRemoteRpcServiceForElement === 'function' ? getRemoteRpcServiceForElement(el) : null;
        if (svc && typeof svc.getCascadeTrajectory === 'function' && !svc.isRemoteControlHost) {
          const t = await svc.getCascadeTrajectory({ cascadeId });
          const metas = t?.trajectory?.generatorMetadata || [];
          if (metas.length > 0) setBoundedGenLen(cascadeId, metas.length);
          return metas;
        }
        return [];
      }
      function dispose() {
        disposed = true;
        for (const ctrl of activeAbortControllers) {
          try { ctrl.abort(); } catch {}
        }
        activeAbortControllers.clear();
        if (cacheFlushTimer) {
          const clearTimer = getTimerFn('clearTimeout', typeof clearTimeout === 'function' ? clearTimeout : null);
          if (clearTimer) {
            try { clearTimer(cacheFlushTimer); } catch {}
          }
          cacheFlushTimer = null;
        }
        stateCache.clear();
        inFlightStats.clear();
        knownGenLenMap.clear();
        rcStepCountMap.clear();
        statsBackoffMap.clear();
      }
      return {
        callRpcJson,
        getStats,
        getCachedStats: (cascadeId) => stateCache.get(cascadeId) || null,
        getImmediateStats,
        getQuota,
        getLatestQuota: () => quotaData,
        getAllTrajectories,
        updateAnnotations,
        getGeneratorMetadataRange,
        recordStepEvent,
        getStepCount,
        getKnownGenLen: (cascadeId) => knownGenLenMap.get(cascadeId) || stateCache.get(cascadeId)?.knownGenLen || 0,
        setBoundedGenLen,
        dispose,
      };
    }
    module.exports = {
      MAX_CACHE_ENTRIES,
      MAX_CASCADE_LEN_ENTRIES,
      STATS_CACHE_KEY,
      setBoundedLruMap,
      createStorageAdapter,
      createLocalHttpTransport,
    };
  },
  "./drivers/antigravity/remote-port-driver": function(module, exports, __require) {
    const require = (spec) => __require("./drivers/antigravity", spec);
    'use strict';
    /**
     * Antigravity Remote Control Port Driver (`<ga-remote-control>`).
     *
     * Strict isolation guarantees:
     * 1. WeakMap/closure-isolated `RemoteControlComponent.prototype` lease chaining (never writes `__agyOrig_*`).
     * 2. Honors active reference-counted iframe auto-load suppression (`__agySuppressAutoIframeLoad` /
     *    `__agySuppressAutoIframeLoadCount > 0`) so co-loaded plugins' `-v2` MessagePort handshakes never tear down.
     * 3. NEVER hijacks, rewrites, or promotes cross-origin child iframes (zero `about:blank` / `cd.open()` races).
     * 4. Tracks inaccessible cross-origin child iframes privately without setting DOM expandos.
     */
    const { resolveHostAdapterConfig } = require('./host-config');
    const RC_PROTO_CHAIN_SYMBOL = Symbol.for('agy.rc.proto.chain.v2');
    const RC_TAP_METHODS = Object.freeze([
      'handleIframeMessage',
      'proxyCommand',
      'streamProxyCommand',
      'handlePortRequest',
      'handleUrlChanged',
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
    ]);
    function isAutoIframeLoadSuppressed(rcInst) {
      return Boolean(
        rcInst &&
          (rcInst.__agySuppressAutoIframeLoad ||
            (typeof rcInst.__agySuppressAutoIframeLoadCount === 'number' && rcInst.__agySuppressAutoIframeLoadCount > 0))
      );
    }
    function isRcComponentInstance(obj) {
      return Boolean(
        obj &&
          typeof obj === 'object' &&
          !obj.destroyed &&
          (typeof obj.proxyCommand === 'function' ||
            typeof obj.onIframeLoad === 'function' ||
            typeof obj.handleIframeMessage === 'function')
      );
    }
    function extractRcFromAngularLContext(lCtx) {
      if (!lCtx || typeof lCtx !== 'object') return null;
      if (isRcComponentInstance(lCtx)) return lCtx;
      if (isRcComponentInstance(lCtx.component)) return lCtx.component;
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
            if (isRcComponentInstance(comp)) return comp;
          }
        } catch {}
        for (let i = 0; i < Math.min(lView.length, 300); i++) {
          if (isRcComponentInstance(lView[i])) return lView[i];
        }
      }
      return null;
    }
    function searchAngularContextBfs(ctx) {
      if (!ctx || typeof ctx !== 'object') return null;
      const direct = extractRcFromAngularLContext(ctx);
      if (direct) return direct;
      const visited = new Set();
      const queue = [ctx];
      let steps = 0;
      while (queue.length > 0 && steps < 400) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
        visited.add(cur);
        steps += 1;
        const extracted = extractRcFromAngularLContext(cur);
        if (extracted) return extracted;
        if (Array.isArray(cur)) {
          const scanLen = Math.min(cur.length, 300);
          for (let i = 0; i < scanLen; i++) {
            if (isRcComponentInstance(cur[i])) return cur[i];
          }
          for (let i = 0; i < scanLen; i++) {
            const item = cur[i];
            if (item && typeof item === 'object' && (Array.isArray(item) || isRcComponentInstance(item.component))) {
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
    }
    function createRemotePortDriver({ window: win, document: doc, hostConfig, hooks = {} }) {
      const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, win);
      const hookedPrototypes = new Map();
      const inaccessibleIframes = typeof WeakSet === 'function' ? new WeakSet() : null;
      let discoveredRcInstance = null;
      let probingRcInstance = false;
      let disposed = false;
      let setOwnGlobalRcInstance = false;
      function captureInstance(inst) {
        if (isRcComponentInstance(inst)) {
          discoveredRcInstance = inst;
          if (win && typeof win === 'object') {
            try {
              if (!win.__agyRemoteControlInstance || win.__agyRemoteControlInstance.destroyed) {
                win.__agyRemoteControlInstance = inst;
                setOwnGlobalRcInstance = true;
              }
            } catch {}
          }
        }
      }
      function isTrustedMessageEvent(ev) {
        if (!ev || typeof ev !== 'object') return false;
        const iframeWin = getAccessibleIframeWindowNoCache();
        if (iframeWin && ev.source === iframeWin) return true;
        const evOrigin = typeof ev.origin === 'string' ? ev.origin.trim() : '';
        if (!evOrigin) return false;
        if (win?.location?.origin && evOrigin === win.location.origin) return true;
        for (const rawCdn of resolvedHostConfig.staticCdnOrigins || []) {
          try {
            if (evOrigin === new URL(rawCdn).origin) return true;
          } catch {}
        }
        try {
          const host = new URL(evOrigin).hostname;
          if (resolvedHostConfig.isRemoteHost(host)) return true;
        } catch {}
        return false;
      }
      function getAccessibleIframeWindowNoCache() {
        try {
          const iframe = doc?.querySelector?.('ga-remote-control iframe');
          return iframe?.contentWindow || null;
        } catch {
          return null;
        }
      }
      function tapPrototype(proto) {
        if (!proto || proto === Object.prototype || disposed) return;
        if (hookedPrototypes.has(proto)) return;
        let protoDisposed = false;
        const leaseTokens = [];
        let chainTable = proto[RC_PROTO_CHAIN_SYMBOL];
        if (!chainTable || typeof chainTable !== 'object') {
          chainTable = Object.create(null);
          try {
            Object.defineProperty(proto, RC_PROTO_CHAIN_SYMBOL, {
              value: chainTable,
              configurable: true,
              enumerable: false,
              writable: true,
            });
          } catch {
            proto[RC_PROTO_CHAIN_SYMBOL] = chainTable;
          }
        }
        const wrapMethod = (mName, buildHandler) => {
          if (typeof proto[mName] !== 'function') return;
          const createChain = (baseFn) => {
            const nodes = [];
            const dispatcher = function (...args) {
              let idx = nodes.length - 1;
              const callNext = (...nextArgs) => {
                const callArgs = nextArgs.length > 0 ? nextArgs : args;
                while (idx >= 0) {
                  const node = nodes[idx--];
                  if (node && !node.disposed) {
                    return node.handler.call(this, callNext, ...callArgs);
                  }
                }
                return baseFn.apply(this, callArgs);
              };
              return callNext(...args);
            };
            const chainObj = { baseFn, nodes, dispatcher };
            chainTable[mName] = chainObj;
            proto[mName] = dispatcher;
            return chainObj;
          };
          let methodChain = chainTable[mName];
          if (!methodChain || proto[mName] !== methodChain.dispatcher) {
            methodChain = createChain(proto[mName]);
          }
          const capturedChain = methodChain;
          const node = {
            disposed: false,
            handler: buildHandler(() => protoDisposed || disposed || node.disposed),
          };
          capturedChain.nodes.push(node);
          leaseTokens.push(() => {
            if (node.disposed) return;
            node.disposed = true;
            const pos = capturedChain.nodes.indexOf(node);
            if (pos >= 0) capturedChain.nodes.splice(pos, 1);
            if (capturedChain.nodes.length === 0) {
              if (proto[mName] === capturedChain.dispatcher) {
                proto[mName] = capturedChain.baseFn;
                if (chainTable[mName] === capturedChain) {
                  delete chainTable[mName];
                  if (Object.keys(chainTable).length === 0) {
                    try {
                      delete proto[RC_PROTO_CHAIN_SYMBOL];
                    } catch {}
                  }
                }
              }
            }
          });
        };
        wrapMethod('handleIframeMessage', (isOff) => function (next, ev) {
          if (isOff()) return next.call(this, ev);
          if (probingRcInstance && ev && ev.data === '__agy_probe__') {
            captureInstance(this);
            return;
          }
          if (!isTrustedMessageEvent(ev)) {
            return next.call(this, ev);
          }
          captureInstance(this);
          if (typeof hooks.onIframeMessage === 'function') {
            try {
              hooks.onIframeMessage(ev, this);
            } catch {}
          }
          return next.call(this, ev);
        });
        for (const mName of ['proxyCommand', 'streamProxyCommand']) {
          wrapMethod(mName, (isOff) => function (next, path, body, ...rest) {
            if (isOff()) return next.call(this, path, body, ...rest);
            captureInstance(this);
            let nextBody = body;
            if (typeof hooks.transformRpcRequest === 'function') {
              try {
                nextBody = hooks.transformRpcRequest(path, body, this);
              } catch {
                nextBody = body;
              }
            }
            return next.call(this, path, nextBody, ...rest);
          });
        }
        wrapMethod('handlePortRequest', (isOff) => function (next, msg) {
          if (isOff()) return next.call(this, msg);
          captureInstance(this);
          let nextMsg = msg;
          if (msg && typeof msg.path === 'string' && typeof hooks.transformPortRequest === 'function') {
            try {
              nextMsg = hooks.transformPortRequest(msg, this) || msg;
            } catch {
              nextMsg = msg;
            }
          }
          return next.call(this, nextMsg);
        });
        for (const mName of RC_TAP_METHODS) {
          if (
            mName === 'handleIframeMessage' ||
            mName === 'proxyCommand' ||
            mName === 'streamProxyCommand' ||
            mName === 'handlePortRequest'
          ) {
            continue;
          }
          wrapMethod(mName, (isOff) => function (next, ...args) {
            if (isOff()) return next.apply(this, args);
            captureInstance(this);
            if (mName === 'onIframeLoad' && isAutoIframeLoadSuppressed(this)) {
              return Promise.resolve();
            }
            if (
              probingRcInstance &&
              (mName === 'handleUrlChanged' || mName === 'onIframeLoad' || mName === 'onWindowOnline' || mName === 'loadInstances')
            ) {
              return;
            }
            if (mName === 'handleUrlChanged' && typeof hooks.onUrlChanged === 'function') {
              try {
                hooks.onUrlChanged(args[0], this);
              } catch {}
            }
            return next.apply(this, args);
          });
        }
        hookedPrototypes.set(proto, {
          release() {
            protoDisposed = true;
            for (let i = leaseTokens.length - 1; i >= 0; i--) {
              try {
                leaseTokens[i]();
              } catch {}
            }
            leaseTokens.length = 0;
          },
        });
      }
      function resolveInstance() {
        if (!win || disposed) return null;
        if (discoveredRcInstance && !discoveredRcInstance.destroyed) {
          tapPrototype(Object.getPrototypeOf(discoveredRcInstance));
          return discoveredRcInstance;
        }
        if (win.__agyRemoteControlInstance && !win.__agyRemoteControlInstance.destroyed) {
          captureInstance(win.__agyRemoteControlInstance);
          tapPrototype(Object.getPrototypeOf(win.__agyRemoteControlInstance));
          return win.__agyRemoteControlInstance;
        }
        const effDoc = doc || win.document;
        const rcEl = effDoc?.querySelector?.('ga-remote-control') || null;
        const gaRootEl = effDoc?.querySelector?.('ga-root') || null;
        if (rcEl) {
          const ngFn = win.ng && typeof win.ng.getComponent === 'function' ? win.ng.getComponent : null;
          if (ngFn) {
            try {
              const comp = ngFn(rcEl);
              if (isRcComponentInstance(comp)) {
                captureInstance(comp);
                tapPrototype(Object.getPrototypeOf(comp));
                return comp;
              }
            } catch {}
          }
          const ctxKey = Object.keys(rcEl).find((k) => k.startsWith('__ngContext'));
          const found = searchAngularContextBfs(rcEl.__ngContext__ || (ctxKey ? rcEl[ctxKey] : null));
          if (found) {
            captureInstance(found);
            tapPrototype(Object.getPrototypeOf(found));
            return found;
          }
        }
        if (gaRootEl) {
          const rootCtxKey = Object.keys(gaRootEl).find((k) => k.startsWith('__ngContext'));
          const foundFromRoot = searchAngularContextBfs(gaRootEl.__ngContext__ || (rootCtxKey ? gaRootEl[rootCtxKey] : null));
          if (foundFromRoot) {
            captureInstance(foundFromRoot);
            tapPrototype(Object.getPrototypeOf(foundFromRoot));
            return foundFromRoot;
          }
        }
        const nsRoot = win.default_GoogleAntigravity;
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
                  if (isRcComponentInstance(dbgComp)) {
                    captureInstance(dbgComp);
                    tapPrototype(Object.getPrototypeOf(dbgComp));
                    return dbgComp;
                  }
                  const foundFromDbg = searchAngularContextBfs(dbgComp || dbgNode);
                  if (foundFromDbg) {
                    captureInstance(foundFromDbg);
                    tapPrototype(Object.getPrototypeOf(foundFromDbg));
                    return foundFromDbg;
                  }
                }
                if (typeof mod.getComponent === 'function') {
                  const comp = mod.getComponent(targetEl);
                  if (isRcComponentInstance(comp)) {
                    captureInstance(comp);
                    tapPrototype(Object.getPrototypeOf(comp));
                    return comp;
                  }
                }
                const getLCtx = mod['\u0275getLContext'] || mod.getLContext;
                if (typeof getLCtx === 'function') {
                  const lCtx = getLCtx(targetEl);
                  const foundFromLCtx = extractRcFromAngularLContext(lCtx) || searchAngularContextBfs(lCtx?.lView || lCtx);
                  if (foundFromLCtx) {
                    captureInstance(foundFromLCtx);
                    tapPrototype(Object.getPrototypeOf(foundFromLCtx));
                    return foundFromLCtx;
                  }
                }
              } catch {}
            }
            const RC = mod.RemoteControlComponent || (typeof mod.prototype?.proxyCommand === 'function' ? mod : null);
            if (RC && RC.prototype && typeof RC.prototype.proxyCommand === 'function') {
              tapPrototype(RC.prototype);
            }
          }
        }
        probingRcInstance = true;
        try {
          const BaseEvt = win.Event || (typeof Event !== 'undefined' ? Event : null);
          if (!discoveredRcInstance && BaseEvt && typeof effDoc?.dispatchEvent === 'function') {
            effDoc.dispatchEvent(new BaseEvt('visibilitychange'));
          }
          if (!discoveredRcInstance && BaseEvt && typeof win.dispatchEvent === 'function') {
            win.dispatchEvent(new BaseEvt('online'));
          }
          if (!discoveredRcInstance && typeof win.dispatchEvent === 'function') {
            const Evt = win.MessageEvent || (typeof MessageEvent !== 'undefined' ? MessageEvent : null);
            if (Evt) {
              const iframeEl = rcEl?.querySelector?.('iframe') || effDoc?.querySelector?.('ga-remote-control iframe') || null;
              let iframeWin = null;
              try {
                iframeWin = iframeEl?.contentWindow || null;
              } catch {}
              const rawIframeSrc = iframeEl?.getAttribute?.('src') || iframeEl?.src || '';
              const candidateOrigins = [];
              const defaultRemoteOrigin = `https://${resolvedHostConfig.remoteHostDomains[0] || 'antigravity.google.com'}`;
              try {
                if (rawIframeSrc) {
                  candidateOrigins.push(new URL(rawIframeSrc, win.location?.href || defaultRemoteOrigin).origin);
                }
              } catch {}
              if (win.location?.origin && !candidateOrigins.includes(win.location.origin)) {
                candidateOrigins.push(win.location.origin);
              }
              for (const cdnOrig of resolvedHostConfig.staticCdnOrigins) {
                if (cdnOrig && !candidateOrigins.includes(cdnOrig)) {
                  candidateOrigins.push(cdnOrig);
                }
              }
              for (const orig of candidateOrigins) {
                if (discoveredRcInstance) break;
                win.dispatchEvent(
                  new Evt('message', {
                    data: { type: 'URL_CHANGED', path: '' },
                    origin: orig,
                    source: iframeWin,
                  })
                );
              }
              if (!discoveredRcInstance) {
                win.dispatchEvent(new Evt('message', { data: '__agy_probe__' }));
              }
            }
          }
        } catch {} finally {
          probingRcInstance = false;
        }
        const active = discoveredRcInstance || win.__agyRemoteControlInstance;
        return active && !active.destroyed ? active : null;
      }
      function getAccessibleIframeWindow() {
        try {
          const iframe = doc?.querySelector?.('ga-remote-control iframe');
          if (!iframe) return null;
          if (inaccessibleIframes && inaccessibleIframes.has(iframe)) {
            try {
              if (iframe.contentDocument) {
                inaccessibleIframes.delete(iframe);
              } else {
                return null;
              }
            } catch {
              return null;
            }
          }
          const cwin = iframe.contentWindow;
          if (!cwin) return null;
          void cwin.document;
          return cwin;
        } catch {
          try {
            const iframe = doc?.querySelector?.('ga-remote-control iframe');
            if (iframe && inaccessibleIframes) inaccessibleIframes.add(iframe);
          } catch {}
          return null;
        }
      }
      function getAccessibleIframeDocument() {
        try {
          const iframe = doc?.querySelector?.('ga-remote-control iframe');
          if (!iframe) return null;
          const cdoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (cdoc && inaccessibleIframes) inaccessibleIframes.delete(iframe);
          return cdoc || null;
        } catch {
          try {
            const iframe = doc?.querySelector?.('ga-remote-control iframe');
            if (iframe && inaccessibleIframes) inaccessibleIframes.add(iframe);
          } catch {}
          return null;
        }
      }
      function createRcServiceAdapter(rcInst, codec, injectCheckpointLimitFn) {
        async function callJson(rpcPath, reqObj) {
          if (!rcInst || typeof rcInst.proxyCommand !== 'function') return null;
          const payloadObj =
            /\/SendUserCascadeMessage$/i.test(rpcPath) && typeof injectCheckpointLimitFn === 'function'
              ? injectCheckpointLimitFn(rpcPath, reqObj || {}, rcInst)
              : (reqObj || {});
          const bytes = codec.encodeTextToBytes(JSON.stringify(payloadObj));
          const res = await rcInst.proxyCommand(rpcPath, bytes);
          if (!res || !res.payload) return null;
          const text = codec.decodeBytesToText(res.payload);
          return text ? JSON.parse(text) : null;
        }
        return {
          isRemoteControlHost: true,
          rcInst,
          callJson,
          async retrieveUserQuotaSummary(req) {
            return await callJson(resolvedHostConfig.buildRpcPath('RetrieveUserQuotaSummary'), req || {});
          },
          async getCascadeTrajectoryGeneratorMetadata(req) {
            return await callJson(resolvedHostConfig.buildRpcPath('GetCascadeTrajectoryGeneratorMetadata'), req || {});
          },
          async getCascadeTrajectory(req) {
            const metaRes = await callJson(resolvedHostConfig.buildRpcPath('GetCascadeTrajectoryGeneratorMetadata'), {
              cascadeId: req?.cascadeId,
              generatorMetadataOffset: req?.generatorMetadataOffset || 0,
            });
            if (metaRes && Array.isArray(metaRes.generatorMetadata)) {
              return { trajectory: { generatorMetadata: metaRes.generatorMetadata } };
            }
            return await callJson(resolvedHostConfig.buildRpcPath('GetCascadeTrajectory'), req || {});
          },
          async getAllCascadeTrajectories() {
            return await callJson(resolvedHostConfig.buildRpcPath('GetAllCascadeTrajectories'), {});
          },
          async updateConversationAnnotations(req) {
            return await callJson(resolvedHostConfig.buildRpcPath('UpdateConversationAnnotations'), req || {});
          },
          async sendUserCascadeMessage(req) {
            return await callJson(resolvedHostConfig.buildRpcPath('SendUserCascadeMessage'), req || {});
          },
        };
      }
      function dispose() {
        if (disposed) return;
        disposed = true;
        for (const [, rec] of hookedPrototypes.entries()) {
          try {
            rec.release();
          } catch {}
        }
        hookedPrototypes.clear();
        if (setOwnGlobalRcInstance && win && win.__agyRemoteControlInstance === discoveredRcInstance) {
          try {
            delete win.__agyRemoteControlInstance;
          } catch {}
        }
        setOwnGlobalRcInstance = false;
        discoveredRcInstance = null;
        probingRcInstance = false;
      }
      function getSelectedGeminiDir() {
        try {
          const rcInst = resolveInstance();
          if (!rcInst) return '';
          const selInst = typeof rcInst.getSelectedInstance === 'function' ? rcInst.getSelectedInstance() : null;
          const cand =
            selInst?.geminiDir ||
            selInst?.selectedGeminiDir ||
            (typeof rcInst.selectedGeminiDir === 'function' ? rcInst.selectedGeminiDir() : rcInst.selectedGeminiDir) ||
            '';
          return typeof cand === 'string' ? cand.trim() : '';
        } catch {
          return '';
        }
      }
      return {
        resolvedHostConfig,
        tapPrototype,
        resolveInstance,
        getSelectedGeminiDir,
        getAccessibleIframeWindow,
        getAccessibleIframeDocument,
        createRcServiceAdapter,
        dispose,
      };
    }
    const REMOTE_SHELL_LAYOUT_CSS = `
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
`;
    function createDocumentHostDriver({ document: defaultDoc, remotePortDriver }) {
      const SAFE_CW_CSS_RE = /^\d+(?:\.\d+)?[KkMm]$/;
      return {
        getAccessibleDocs(rootDoc = defaultDoc) {
          const docs = [];
          if (!rootDoc) return docs;
          docs.push(rootDoc);
          const iframeDoc = remotePortDriver?.getAccessibleIframeDocument?.();
          if (iframeDoc && iframeDoc !== rootDoc) {
            docs.push(iframeDoc);
          }
          return docs;
        },
        getIframeDocument() {
          return remotePortDriver?.getAccessibleIframeDocument?.() || null;
        },
        buildWarningSuppressionCss(underDefaultCwSet) {
          const selectors = ['[data-testid="model-selector-trigger"][data-agy-cw-warn="0"] div:has(> .text-warning)'];
          if (underDefaultCwSet) {
            for (const cw of underDefaultCwSet) {
              const clean = String(cw || '').trim();
              if (SAFE_CW_CSS_RE.test(clean)) {
                selectors.push(`[data-testid="model-selector-trigger"][data-context-window="${clean}"] div:has(> .text-warning)`);
              }
            }
          }
          return `${REMOTE_SHELL_LAYOUT_CSS}\n    ${selectors.join(',\n    ')} {\n      display: none !important;\n    }\n`;
        },
        resolveViewSessionId(view, fallbackSessionId = '') {
          const cid = view?.getAttribute?.('data-cascade-id') || fallbackSessionId || '';
          return cid === 'remote-session' ? '' : cid;
        },
        findFallbackSessionTarget(rootDoc = defaultDoc) {
          const view = rootDoc?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]') || null;
          const inputBox = view?.querySelector?.('[data-testid="agent-input-box"]') || null;
          return { view, inputBox };
        },
      };
    }
    module.exports = {
      RC_PROTO_CHAIN_SYMBOL,
      RC_TAP_METHODS,
      isAutoIframeLoadSuppressed,
      createRemotePortDriver,
      createDocumentHostDriver,
    };
  },
  "./drivers/antigravity/react-fiber-driver": function(module, exports, __require) {
    const require = (spec) => __require("./drivers/antigravity", spec);
    'use strict';
    /**
     * Antigravity Desktop Electron / React Fiber / Redux / Fetch Engine Driver.
     *
     * Implements `EnginePort` and isolates all React Fiber traversal, Redux `modelSelection`,
     * `fetch`/`lsClient` checkpoint injection, poisoned `trajectorySync` sanitization (`D-0013`),
     * `subscribeToPlugins` 600ms timeout guard (`D-0008`), and `<ga-remote-control>` shell view
     * management — without mutating `Object.prototype` or polluting `window.__agy*`.
     */
    const { PRESET_CONTEXT_WINDOWS } = require('../../domain/context-window-policy');
    const { isStateForCascade } = require('../../domain/metrics-calculator');
    const { resolveHostAdapterConfig } = require('./host-config');
    const {
      UUID_RE,
      CONVO_RPC_RE,
      createTextCodec,
      extractCascadeIdFromBody,
      injectCheckpointPayload,
    } = require('./protobuf-wire-codec');
    const { setBoundedLruMap } = require('./local-http-transport');
    const MAX_CASCADE_MAP_ENTRIES = 200;
    function cleanupLegacyObjectPrototypeCwGetters(extraWin) {
      const protos = [Object.prototype];
      try {
        if (extraWin?.Object?.prototype && extraWin.Object.prototype !== Object.prototype) {
          protos.push(extraWin.Object.prototype);
        }
      } catch {}
      for (const proto of protos) {
        try {
          for (const key of Object.getOwnPropertyNames(proto)) {
            if (!/^\d+K$/.test(key)) continue;
            const desc = Object.getOwnPropertyDescriptor(proto, key);
            if (desc && desc.configurable && typeof desc.get === 'function' && String(desc.get).includes('512000')) {
              delete proto[key];
            }
          }
        } catch {}
      }
    }
    function registerCustomCwForStyles(cw, underDefaultCwSet, onStyleUpdate, extraWin) {
      cleanupLegacyObjectPrototypeCwGetters(extraWin);
      if (!cw) return;
      const kNum = parseInt(cw, 10);
      if (!isNaN(kNum) && kNum > 0 && kNum <= 256 && underDefaultCwSet && !underDefaultCwSet.has(cw)) {
        underDefaultCwSet.add(cw);
        if (typeof onStyleUpdate === 'function') {
          try { onStyleUpdate(); } catch {}
        }
      }
    }
    function extractModelValFromModelOrAlias(moa) {
      if (!moa || typeof moa !== 'object') return undefined;
      if (moa.model !== undefined) return moa.model;
      if (moa.choice && (moa.choice.case === 'model' || moa.choice.case === 'alias') && moa.choice.value !== undefined) {
        return moa.choice.value;
      }
      return undefined;
    }
    function resolveModelValueFromLabel(state, label) {
      if (!label || typeof label !== 'string') return undefined;
      const trimmed = label.trim();
      if (!trimmed) return undefined;
      const configs = state?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
      if (!Array.isArray(configs)) return undefined;
      for (const cfg of configs) {
        if (cfg && cfg.label === trimmed) {
          const v = extractModelValFromModelOrAlias(cfg.modelOrAlias);
          if (v !== undefined) return v;
        }
      }
      return undefined;
    }
    function extractLabelFromSyncedKey(syncedKey) {
      if (typeof syncedKey !== 'string' || !syncedKey) return undefined;
      const parts = syncedKey.split(':');
      if (parts.length >= 4) {
        const label = parts.slice(2, parts.length - 1).join(':').trim();
        if (label) return label;
      }
      if (parts.length === 3) {
        const label = parts[1].trim();
        if (label) return label;
      }
      return undefined;
    }
    function createReactFiberDriver({
      window,
      document,
      localStorage,
      cwStore,
      transport,
      remotePortDriver,
      hostConfig,
      scope,
      onCascadeSniffed,
      onRemoteAnnotationsUpdated,
    }) {
      const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, window);
      const codec = createTextCodec(window);
      let activeSniffedCascadeId = '';
      let lastAppliedCwGlobal = '';
      const lastAppliedCwByCascade = new Map();
      let capturedLsClient = null;
      let lastRcTrajectoryPollTs = 0;
      let rcTrajectoryPollInFlight = false;
      let lastDesktopTrajectorySyncTs = 0;
      let desktopTrajectorySyncInFlight = false;
      const viewPatchCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      const viewMsCtxCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      const frozenModelCloneCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      const patchedStoreConfigsCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      const sanitizedStores = typeof WeakSet === 'function' ? new WeakSet() : null;
      const patchedCwsObjects = typeof WeakSet === 'function' ? new WeakSet() : null;
      const hookedFetchWindows = typeof WeakSet === 'function' ? new WeakSet() : null;
      const hookedLsClients = typeof WeakSet === 'function' ? new WeakSet() : null;
      const patchedStreamClients = typeof WeakSet === 'function' ? new WeakSet() : null;
      const cachedCustomizationsStores = typeof WeakMap === 'function' ? new WeakMap() : null;
      const lastCustomizationsDfsByDoc = typeof WeakMap === 'function' ? new WeakMap() : null;
      const triggeredStoreRefresh = typeof WeakSet === 'function' ? new WeakSet() : null;
      const hostViewState = typeof WeakMap === 'function' ? new WeakMap() : null;
      cleanupLegacyObjectPrototypeCwGetters(window);
      try {
        const raw = localStorage?.getItem?.('jetski.developer.customFlagOverrides');
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
          localStorage?.setItem?.('jetski.developer.customFlagOverrides', JSON.stringify(flags));
        }
      } catch {}
      function setTriggerCwAttribute(triggerEl, cwStr) {
        if (!triggerEl || typeof triggerEl.setAttribute !== 'function') return;
        const str = String(cwStr);
        if (triggerEl.getAttribute('data-context-window') !== str) {
          triggerEl.setAttribute('data-context-window', str);
        }
      }
      function resolveEffectiveView(view) {
        if (view && view.classList?.contains?.('agy-rc-host-view')) {
          const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
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
          const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
          if (cdoc) {
            const innerBox = cdoc.querySelector('[data-testid="agent-input-box"]');
            if (innerBox) return innerBox;
          }
        }
        return inputBox;
      }
      function resolveEffectiveCascadeId(body, rcInst) {
        const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
        const fromBody = extractCascadeIdFromBody(body, ignoreUuid, codec);
        if (fromBody) return fromBody;
        if (activeSniffedCascadeId && activeSniffedCascadeId !== 'remote-session') {
          return activeSniffedCascadeId;
        }
        const activeView = document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
        const domCid = activeView?.getAttribute?.('data-cascade-id');
        if (domCid && domCid !== 'remote-session') return domCid;
        return null;
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
          return injectCheckpointPayload({
            path,
            body,
            contextWindow: cw,
            maxTokenLimit: limit,
            codec,
          });
        } catch {
          return body;
        }
      }
      function notifyCascadeSniffed(cid) {
        if (typeof onCascadeSniffed === 'function') {
          try { onCascadeSniffed(cid); } catch {}
        }
      }
      function sniffCascadeIdFromRpc(path, body, rcInst) {
        if (typeof path !== 'string' || !CONVO_RPC_RE.test(path)) return;
        const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
        const cid = extractCascadeIdFromBody(body, ignoreUuid, codec);
        if (cid) {
          const changed = activeSniffedCascadeId !== cid;
          activeSniffedCascadeId = cid;
          if (/\/(SendUserCascadeMessage|StartCascade|StreamCascadeReactiveUpdates|StreamAgentStateUpdates)$/i.test(path)) {
            lastRcTrajectoryPollTs = 0;
            if (/\/(SendUserCascadeMessage|StartCascade)$/i.test(path)) {
              transport?.recordStepEvent?.(cid);
            }
            scope?.setTimeout?.(() => {
              lastRcTrajectoryPollTs = 0;
              notifyCascadeSniffed(cid);
            }, 1200);
          }
          if (changed) notifyCascadeSniffed(cid);
        }
      }
      function ensureFetchHook(targetWin) {
        try {
          const w = targetWin || window;
          if (!w || typeof w.fetch !== 'function') return;
          if (hookedFetchWindows && hookedFetchWindows.has(w)) return;
          if (w.fetch.__agyCwHookV2) return;
          const origFetch = w.fetch;
          const wrappedFetch = function (input, init) {
            let nextInput = input;
            let nextInit = init;
            try {
              const url =
                typeof input === 'string'
                  ? input
                  : input && typeof input.url === 'string'
                    ? input.url
                    : input && typeof input.href === 'string'
                      ? input.href
                      : '';
              if (url && CONVO_RPC_RE.test(url)) {
                if (nextInit && nextInit.body) {
                  sniffCascadeIdFromRpc(url, nextInit.body, null);
                  if (/\/SendUserCascadeMessage$/i.test(url)) {
                    nextInit = { ...nextInit, body: injectCheckpointLimitIntoSendRequest(url, nextInit.body, null) };
                  }
                } else if (
                  input &&
                  typeof input === 'object' &&
                  typeof input.arrayBuffer === 'function' &&
                  typeof input.clone === 'function' &&
                  /\/SendUserCascadeMessage$/i.test(url)
                ) {
                  return input
                    .clone()
                    .arrayBuffer()
                    .then((ab) => {
                      const rawBytes = new Uint8Array(ab);
                      sniffCascadeIdFromRpc(url, rawBytes, null);
                      const injectedBody = injectCheckpointLimitIntoSendRequest(url, rawBytes, null);
                      const ReqCtor = w.Request || (typeof Request === 'function' ? Request : null);
                      if (ReqCtor) {
                        return origFetch.call(this, new ReqCtor(input, { body: injectedBody }), nextInit);
                      }
                      return origFetch.call(this, nextInput, { ...(nextInit || {}), body: injectedBody });
                    })
                    .catch(() => origFetch.call(this, nextInput, nextInit));
                }
              }
            } catch {}
            return origFetch.call(this, nextInput, nextInit);
          };
          wrappedFetch.__agyCwHookV2 = true;
          w.fetch = wrappedFetch;
          if (hookedFetchWindows) hookedFetchWindows.add(w);
          scope?.add?.(() => {
            try {
              if (w.fetch === wrappedFetch) {
                w.fetch = origFetch;
              }
            } catch {}
          });
        } catch {}
      }
      function hookLsClient(lsClient) {
        if (!lsClient || typeof lsClient !== 'object') return lsClient;
        if (hookedLsClients && hookedLsClients.has(lsClient)) return lsClient;
        if (lsClient.__agyCwHookV2) return lsClient;
        try {
          let hooked = false;
          const origSend = lsClient.sendUserCascadeMessage;
          let wrappedSend = null;
          if (typeof origSend === 'function') {
            wrappedSend = function (req, ...rest) {
              const nextReq = injectCheckpointLimitIntoSendRequest(
                resolvedHostConfig.buildRpcPath('SendUserCascadeMessage'),
                req,
                null
              );
              return origSend.call(this, nextReq, ...rest);
            };
            wrappedSend.__agyCwHookV2 = true;
            lsClient.sendUserCascadeMessage = wrappedSend;
            hooked = true;
          }
          if (hookedLsClients) hookedLsClients.add(lsClient);
          if (hooked) {
            scope?.add?.(() => {
              try {
                if (wrappedSend && lsClient.sendUserCascadeMessage === wrappedSend) {
                  lsClient.sendUserCascadeMessage = origSend;
                }
              } catch {}
            });
          }
        } catch {}
        return lsClient;
      }
      let lsDecoratorInstalled = false;
      function installLsClientDecoratorHook() {
        if (lsDecoratorInstalled || !window) return;
        lsDecoratorInstalled = true;
        try {
          const hadOwnDec = Object.prototype.hasOwnProperty.call(window, '__JETSKI_LS_CLIENT_DECORATOR__');
          const prevDec = window.__JETSKI_LS_CLIENT_DECORATOR__;
          const wrappedDec = function (client) {
            const decorated = typeof prevDec === 'function' ? prevDec(client) || client : client;
            if (decorated && typeof decorated === 'object') {
              capturedLsClient = decorated;
              if (
                typeof decorated.subscribeToPlugins === 'function' &&
                typeof decorated.getAllPlugins === 'function' &&
                (!patchedStreamClients || !patchedStreamClients.has(decorated))
              ) {
                if (patchedStreamClients) patchedStreamClients.add(decorated);
                const origSubRaw = decorated.subscribeToPlugins;
                const origSub = origSubRaw.bind(decorated);
                const wrappedSub = function (req, opts) {
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
                            const setT =
                              window && typeof window.setTimeout === 'function'
                                ? window.setTimeout.bind(window)
                                : setTimeout;
                            const clearT =
                              window && typeof window.clearTimeout === 'function'
                                ? window.clearTimeout.bind(window)
                                : clearTimeout;
                            const raceRes = await Promise.race([
                              firstPromise.then((r) => ({ from: 'stream', r })),
                              new Promise((resolve) => {
                                timer = setT(() => resolve({ from: 'timeout' }), 600);
                              }),
                            ]);
                            clearT(timer);
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
                decorated.subscribeToPlugins = wrappedSub;
                scope?.add?.(() => {
                  try {
                    if (decorated.subscribeToPlugins === wrappedSub) {
                      decorated.subscribeToPlugins = origSubRaw;
                    }
                  } catch {}
                });
              }
            }
            return decorated;
          };
          window.__JETSKI_LS_CLIENT_DECORATOR__ = wrappedDec;
          scope?.add?.(() => {
            try {
              if (window.__JETSKI_LS_CLIENT_DECORATOR__ === wrappedDec) {
                if (hadOwnDec) window.__JETSKI_LS_CLIENT_DECORATOR__ = prevDec;
                else delete window.__JETSKI_LS_CLIENT_DECORATOR__;
              }
            } catch {}
          });
        } catch {}
      }
      function ensureModelContextWindowOptions(modelObj, extraCw, forceClone = false) {
        if (!modelObj || typeof modelObj !== 'object') return modelObj;
        const curArr = Array.isArray(modelObj.contextWindowOptions) ? modelObj.contextWindowOptions : [];
        const existingNames = new Set(curArr.map((o) => o && o.name).filter(Boolean));
        const wanted = [...PRESET_CONTEXT_WINDOWS];
        if (extraCw && !wanted.includes(extraCw)) {
          wanted.push(extraCw);
        }
        const toAdd = [];
        for (const cw of wanted) {
          if (!existingNames.has(cw)) {
            const limit = cwStore ? cwStore.getLimit(cw) : 256000;
            const hint = cwStore ? cwStore.getQuotaHint(cw) : cw;
            toAdd.push({ name: cw, description: hint, expensive: limit > 256000 });
            existingNames.add(cw);
          }
        }
        if (toAdd.length === 0 && Array.isArray(modelObj.contextWindowOptions)) {
          return modelObj;
        }
        const nextArr = [...curArr, ...toAdd];
        if (!forceClone) {
          try {
            if (Array.isArray(modelObj.contextWindowOptions) && Object.isExtensible(modelObj.contextWindowOptions)) {
              modelObj.contextWindowOptions.push(...toAdd);
              return modelObj;
            }
            if (Object.isExtensible(modelObj)) {
              modelObj.contextWindowOptions = nextArr;
              return modelObj;
            }
          } catch {}
        }
        const wantedKey = wanted.join('|');
        if (frozenModelCloneCache) {
          const byKey = frozenModelCloneCache.get(modelObj);
          if (byKey && byKey.has(wantedKey)) return byKey.get(wantedKey);
        }
        try {
          const proto = Object.getPrototypeOf(modelObj);
          const clone =
            proto && proto !== Object.prototype
              ? Object.assign(Object.create(proto), modelObj, { contextWindowOptions: nextArr })
              : { ...modelObj, contextWindowOptions: nextArr };
          if (frozenModelCloneCache) {
            let byKey = frozenModelCloneCache.get(modelObj);
            if (!byKey) {
              byKey = new Map();
              frozenModelCloneCache.set(modelObj, byKey);
            }
            byKey.set(wantedKey, clone);
          }
          return clone;
        } catch {
          return modelObj;
        }
      }
      function ensureContextWindowSelectorFlag(extraCw) {
        ensureFetchHook(window);
        const cwin = remotePortDriver?.getAccessibleIframeWindow?.();
        if (cwin) ensureFetchHook(cwin);
        if (!document) return;
        const now = Date.now();
        const effectiveExtraKey =
          extraCw && !PRESET_CONTEXT_WINDOWS.includes(extraCw) ? String(extraCw) : '__presets__';
        const docs = [document, remotePortDriver?.getAccessibleIframeDocument?.()].filter(Boolean);
        for (const d of docs) {
          const views = d.querySelectorAll?.('[data-testid="conversation-view"]') || [];
          for (const view of views) {
            const currentCid = view.getAttribute?.('data-cascade-id') || '';
            const prevRec = viewPatchCache ? viewPatchCache.get(view) : null;
            if (
              prevRec &&
              now - prevRec.ts < 3000 &&
              prevRec.extraCw === effectiveExtraKey &&
              prevRec.cid === currentCid
            ) {
              continue;
            }
            const triggerEl = view.querySelector?.('[data-testid="model-selector-trigger"]');
            const startNodes = [triggerEl, view].filter(Boolean);
            let patchedAny = false;
            for (const node of startNodes) {
              const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
              let fiber = fk ? node[fk] : null;
              while (fiber) {
                const val = fiber.memoizedProps?.value;
                if (val && typeof val === 'object') {
                  if (typeof val.get === 'function') {
                    patchedAny = true;
                    if (!patchedCwsObjects || !patchedCwsObjects.has(val)) {
                      try {
                        const origGet = val.get;
                        const wrappedGet = function (name) {
                          if (name === 'contextWindowSelector') {
                            return { enabled: true, feature: { enabled: true } };
                          }
                          return origGet.apply(this, arguments);
                        };
                        val.get = wrappedGet;
                        if (patchedCwsObjects) patchedCwsObjects.add(val);
                        scope?.add?.(() => {
                          try {
                            if (val.get === wrappedGet) val.get = origGet;
                          } catch {}
                        });
                      } catch {}
                    }
                  }
                  if ('corpHost' in val && 'cider' in val && 'contextWindow' in val && val.contextWindow === undefined) {
                    try { val.contextWindow = {}; } catch {}
                  }
                  if (val.selectedModel && typeof val.selectedModel === 'object') {
                    patchedAny = true;
                    const nextSm = ensureModelContextWindowOptions(val.selectedModel, extraCw);
                    if (nextSm !== val.selectedModel && Object.isExtensible(val)) {
                      try { val.selectedModel = nextSm; } catch {}
                    }
                  }
                  if (Array.isArray(val.modelOptions)) {
                    patchedAny = true;
                    if (Object.isExtensible(val.modelOptions)) {
                      for (let i = 0; i < val.modelOptions.length; i++) {
                        const nextOpt = ensureModelContextWindowOptions(val.modelOptions[i], extraCw);
                        if (nextOpt !== val.modelOptions[i]) {
                          try { val.modelOptions[i] = nextOpt; } catch {}
                        }
                      }
                    } else if (Object.isExtensible(val)) {
                      let changedOpt = false;
                      const mapped = val.modelOptions.map((opt) => {
                        const nextOpt = ensureModelContextWindowOptions(opt, extraCw);
                        if (nextOpt !== opt) changedOpt = true;
                        return nextOpt;
                      });
                      if (changedOpt) {
                        try { val.modelOptions = mapped; } catch {}
                      }
                    }
                  }
                  if (val.store && typeof val.store.getState === 'function') {
                    patchedAny = true;
                    const st = val.store.getState();
                    const clientConfigs = st?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
                    if (Array.isArray(clientConfigs)) {
                      let storeRec = patchedStoreConfigsCache ? patchedStoreConfigsCache.get(val.store) : null;
                      const alreadyHandledRef =
                        storeRec &&
                        storeRec.configsRefs.has(clientConfigs) &&
                        storeRec.extraCwKeys.has(effectiveExtraKey);
                      if (!alreadyHandledRef) {
                        let needsReduxUpdate = false;
                        const updatedConfigs = [];
                        for (const cfg of clientConfigs) {
                          const nextCfg = ensureModelContextWindowOptions(cfg, extraCw, true);
                          updatedConfigs.push(nextCfg);
                          if (nextCfg !== cfg) needsReduxUpdate = true;
                        }
                        if (!storeRec && patchedStoreConfigsCache) {
                          storeRec = { configsRefs: new WeakSet(), extraCwKeys: new Set() };
                          patchedStoreConfigsCache.set(val.store, storeRec);
                        }
                        if (storeRec) {
                          storeRec.configsRefs.add(clientConfigs);
                          storeRec.configsRefs.add(updatedConfigs);
                          storeRec.extraCwKeys.add(effectiveExtraKey);
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
                            const afterConfigs = val.store.getState()?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
                            if (storeRec && Array.isArray(afterConfigs)) {
                              storeRec.configsRefs.add(afterConfigs);
                            }
                          } catch {}
                        }
                      }
                    }
                  }
                }
                fiber = fiber.return;
              }
            }
            if (patchedAny && viewPatchCache) {
              viewPatchCache.set(view, { ts: now, extraCw: effectiveExtraKey, cid: currentCid });
            }
          }
        }
      }
      function ensureCustomizationsStoreLoaded() {
        if (!document) return;
        const now = Date.now();
        const docs = [document, remotePortDriver?.getAccessibleIframeDocument?.()].filter(Boolean);
        for (const d of docs) {
          const cachedStore = cachedCustomizationsStores?.get(d);
          if (cachedStore && cachedStore.hasReceivedStreamSnapshot && cachedStore.streamingDisabled) {
            continue;
          }
          const views = d.querySelectorAll?.('[data-testid="conversation-view"]') || [];
          const rootEl = d.querySelector?.('#root, #app') || d.body?.firstElementChild;
          const startNodes = [...views, rootEl, d].filter(Boolean);
          for (const node of startNodes) {
            const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
            const rawRoot = fk ? node[fk] : null;
            const startFiber = rawRoot?.stateNode?.current || rawRoot;
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
            if (!foundStore && (node === rootEl || node === d)) {
              const lastDfs = lastCustomizationsDfsByDoc?.get(d) || 0;
              if (lastDfs && now - lastDfs < 10000) continue;
              lastCustomizationsDfsByDoc?.set(d, now);
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
              cachedCustomizationsStores?.set(d, foundStore);
              try {
                if (typeof foundStore.disableStreaming === 'function' && !foundStore.streamingDisabled) {
                  foundStore.disableStreaming();
                }
                const st = typeof foundStore.state?.getState === 'function' ? foundStore.state.getState() : null;
                if ((!foundStore.hasReceivedStreamSnapshot || st?.isLoadingPlugins) && !triggeredStoreRefresh?.has(foundStore)) {
                  triggeredStoreRefresh?.add(foundStore);
                  Promise.resolve(foundStore.refresh()).catch(() => {
                    triggeredStoreRefresh?.delete(foundStore);
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
        const now = Date.now();
        const currentCid = effView.getAttribute?.('data-cascade-id') || view?.getAttribute?.('data-cascade-id') || '';
        const cachedRec = viewMsCtxCache?.get(effView);
        if (
          cachedRec &&
          cachedRec.cid === currentCid &&
          now - cachedRec.ts < 400 &&
          (!cachedRec.ctx.triggerEl || cachedRec.ctx.triggerEl.isConnected !== false) &&
          (cachedRec.ctx.msCtx || cachedRec.ctx.reduxStore || cachedRec.ctx.legacyCtx)
        ) {
          if (cachedRec.ctx.msCtx?.selectedModel) {
            ensureModelContextWindowOptions(cachedRec.ctx.msCtx.selectedModel, extraCw);
          }
          return cachedRec.ctx;
        }
        const triggerEl = effView.querySelector?.('[data-testid="model-selector-trigger"]') || null;
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
        const res = { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl };
        if ((msCtx || reduxStore || legacyCtx) && viewMsCtxCache) {
          viewMsCtxCache.set(effView, { ctx: res, ts: now, cid: currentCid });
        }
        return res;
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
      function getRemoteRpcServiceForElement(el) {
        if (
          capturedLsClient &&
          (typeof capturedLsClient.retrieveUserQuotaSummary === 'function' ||
            typeof capturedLsClient.getCascadeTrajectory === 'function')
        ) {
          return hookLsClient(capturedLsClient);
        }
        const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
        const effBox = resolveEffectiveInputBox(resolveEffectiveView(el));
        const candidates = [
          effBox,
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
              if (
                typeof val.retrieveUserQuotaSummary === 'function' ||
                typeof val.getCascadeTrajectory === 'function' ||
                typeof val.getAllCascadeTrajectories === 'function' ||
                typeof val.updateConversationAnnotations === 'function'
              ) {
                return hookLsClient(val);
              }
              const lsClient =
                val.core?.projectManagementService?.lsClient ||
                val.projectManagementService?.lsClient ||
                val.lsClient;
              if (
                lsClient &&
                (typeof lsClient.retrieveUserQuotaSummary === 'function' ||
                  typeof lsClient.getCascadeTrajectory === 'function' ||
                  typeof lsClient.getAllCascadeTrajectories === 'function' ||
                  typeof lsClient.updateConversationAnnotations === 'function')
              ) {
                return hookLsClient(lsClient);
              }
            }
            curr = curr.return;
          }
        }
        const rcInst = remotePortDriver?.resolveInstance?.();
        if (rcInst && typeof rcInst.proxyCommand === 'function') {
          return remotePortDriver.createRcServiceAdapter(rcInst, codec, injectCheckpointLimitIntoSendRequest);
        }
        return null;
      }
      function getSelectedModelKey(view, sessionId, infoOpt) {
        const info = infoOpt || getModelSelectorContextForView(view);
        const state = info?.reduxStore ? info.reduxStore.getState() : null;
        const byConvo = state?.modelSelection?.byConversation?.[sessionId];
        const sm = info?.msCtx?.selectedModel;
        const raw =
          byConvo?.model ??
          (sm && typeof sm === 'object' ? (sm.value ?? sm.label) : sm) ??
          state?.modelSelection?.default?.model ??
          info?.legacyCtx?.getModelConfigForConversation?.(sessionId)?.value ??
          '';
        return `${sessionId || ''}:${String(raw ?? '')}`;
      }
      function sanitizePoisonedModelSelection(reduxStore) {
        if (!reduxStore || typeof reduxStore.getState !== 'function' || typeof reduxStore.dispatch !== 'function') {
          return;
        }
        try {
          if (sanitizedStores && sanitizedStores.has(reduxStore)) return;
          const st = reduxStore.getState();
          const ms = st?.modelSelection;
          if (!ms || typeof ms !== 'object') return;
          const syncMap = ms.trajectorySync;
          const byConvoMap = ms.byConversation;
          if (!syncMap || typeof syncMap !== 'object') return;
          const overrideDefaultModel = extractModelValFromModelOrAlias(
            st?.userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias
          );
          let cleanConvoModel;
          for (const cid of Object.keys(syncMap)) {
            const entry = syncMap[cid];
            const step = entry?.pick?.atStep;
            if (step === undefined || step === -1) {
              const syncedLabel = extractLabelFromSyncedKey(entry?.syncedKey);
              const mVal = resolveModelValueFromLabel(st, syncedLabel);
              if (mVal !== undefined) {
                cleanConvoModel = mVal;
                if (syncedLabel && /\(medium\)/i.test(syncedLabel)) break;
              }
            }
          }
          const preferredModel = overrideDefaultModel ?? cleanConvoModel;
          if (preferredModel === undefined) return;
          const poisonedCids = [];
          let recoveredTargetModel;
          for (const cid of Object.keys(syncMap)) {
            const entry = syncMap[cid];
            const step = entry?.pick?.atStep;
            const hasSyncedKey = typeof entry?.syncedKey === 'string' && entry.syncedKey.length > 0;
            const syncedLabel = extractLabelFromSyncedKey(entry?.syncedKey);
            const isRelocked =
              hasSyncedKey &&
              (step === 0 || (typeof step === 'number' && step > 0 && entry?.pick?.checkedTurnKey !== undefined));
            if (step === 999999 || isRelocked) {
              poisonedCids.push(cid);
              const syncedModelVal = resolveModelValueFromLabel(st, syncedLabel);
              if (syncedModelVal !== undefined && recoveredTargetModel === undefined) {
                recoveredTargetModel = syncedModelVal;
              }
            }
          }
          if (poisonedCids.length === 0 && ms.default?.model === preferredModel) {
            sanitizedStores?.add(reduxStore);
            return;
          }
          sanitizedStores?.add(reduxStore);
          const currentDefaultModel = ms.default?.model;
          const currentDefaultCustomLabel = ms.default?.customLabel;
          const desiredDefaultCw = cwStore?.hasExplicitDefaultCw?.()
            ? cwStore.getDefaultCw()
            : (ms.default?.contextWindow || '256K');
          const safeDefaultModel = preferredModel ?? recoveredTargetModel ?? currentDefaultModel;
          for (const cid of poisonedCids) {
            const entry = syncMap[cid];
            const convo = byConvoMap?.[cid];
            const syncedLabel = extractLabelFromSyncedKey(entry?.syncedKey);
            const syncedModelVal = resolveModelValueFromLabel(st, syncedLabel);
            const targetModel =
              syncedLabel && !/\(low\)/i.test(syncedLabel) && syncedModelVal !== undefined
                ? syncedModelVal
                : (preferredModel ?? syncedModelVal ?? safeDefaultModel ?? convo?.model);
            const targetCw = cwStore?.getSavedContextWindow?.(cid) || convo?.contextWindow || desiredDefaultCw;
            if (targetModel !== undefined) {
              reduxStore.dispatch({
                type: 'modelSelection/modelPicked',
                payload: {
                  conversationId: cid,
                  model: targetModel,
                  customLabel: undefined,
                  contextWindow: targetCw,
                  pick: { atStep: -1, queuedMessageIds: [] },
                },
              });
            }
          }
          if (safeDefaultModel !== undefined) {
            reduxStore.dispatch({
              type: 'modelSelection/modelPicked',
              payload: {
                conversationId: undefined,
                model: safeDefaultModel,
                customLabel: safeDefaultModel === currentDefaultModel ? currentDefaultCustomLabel : undefined,
                contextWindow: desiredDefaultCw,
              },
            });
          }
        } catch {}
      }
      function applyContextLimit(arg1, sessionIdArg, cwArg, userTriggeredArg = false) {
        const isOptsObj = Boolean(
          arg1 &&
            typeof arg1 === 'object' &&
            arg1.nodeType === undefined &&
            ('contextWindow' in arg1 || 'viewEl' in arg1 || 'sessionId' in arg1)
        );
        const viewEl = isOptsObj ? arg1.viewEl : arg1;
        const sessionId = isOptsObj ? arg1.sessionId : sessionIdArg;
        const contextWindow = isOptsObj ? arg1.contextWindow : cwArg;
        const userTriggered = isOptsObj ? Boolean(arg1.userTriggered) : Boolean(userTriggeredArg);
        const targetCw = cwStore?.normalize?.(contextWindow);
        if (!viewEl || !sessionId || !targetCw) return false;
        const info = getModelSelectorContextForView(viewEl, targetCw);
        if (!info) return false;
        const { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl } = info;
        if (reduxStore) sanitizePoisonedModelSelection(reduxStore);
        if (triggerEl && typeof triggerEl.setAttribute === 'function') {
          const warnAttr = cwStore.getLimit(targetCw) > 256000 ? '1' : '0';
          if (triggerEl.getAttribute('data-agy-cw-warn') !== warnAttr) {
            triggerEl.setAttribute('data-agy-cw-warn', warnAttr);
          }
        }
        const currentInDom = triggerEl ? cwStore.normalize(triggerEl.getAttribute?.('data-context-window')) : null;
        const selectedModel = getSelectedModelKey(viewEl, sessionId, info);
        const applyKey = (selectedModel || '') + ':' + String(targetCw);
        const lastAppliedForCascade = lastAppliedCwByCascade.get(sessionId);
        const initialState = reduxStore ? reduxStore.getState() : null;
        const initialByConvo = initialState?.modelSelection?.byConversation?.[sessionId];
        const defaultReduxCw = cwStore.normalize(initialState?.modelSelection?.default?.contextWindow) || '256K';
        const effectiveInitialReduxCw = cwStore.normalize(initialByConvo?.contextWindow) || defaultReduxCw;
        const reduxAlreadyMatches = !reduxStore || effectiveInitialReduxCw === targetCw;
        if (
          (currentInDom === targetCw || lastAppliedForCascade === applyKey || lastAppliedCwGlobal === applyKey) &&
          reduxAlreadyMatches &&
          !userTriggered
        ) {
          lastAppliedCwGlobal = applyKey;
          setBoundedLruMap(lastAppliedCwByCascade, sessionId, applyKey, MAX_CASCADE_MAP_ENTRIES);
          setTriggerCwAttribute(triggerEl, targetCw);
          return true;
        }
        if (msCtx || reduxStore) {
          const state = initialState;
          const byConvo = initialByConvo;
          const currentInRedux = reduxStore
            ? effectiveInitialReduxCw
            : (cwStore.normalize(msCtx?.contextWindow?.selected) || currentInDom || '256K');
          const selectedModelObj = msCtx?.selectedModel;
          if (selectedModelObj) ensureModelContextWindowOptions(selectedModelObj, targetCw);
          let dispatched = false;
          if (currentInRedux !== targetCw || userTriggered) {
            const prevDefault = state?.modelSelection?.default;
            const prevDefaultModel = prevDefault?.model;
            const prevDefaultCustomLabel = prevDefault?.customLabel;
            const prevDefaultCw = prevDefault?.contextWindow;
            if (reduxStore) {
              const syncEntry = state?.modelSelection?.trajectorySync?.[sessionId];
              const syncedModelVal =
                syncEntry?.pick?.atStep === 999999
                  ? resolveModelValueFromLabel(state, extractLabelFromSyncedKey(syncEntry?.syncedKey))
                  : undefined;
              const modelVal = syncedModelVal ?? byConvo?.model ?? selectedModelObj?.value ?? prevDefaultModel;
              const isCustomModel = Boolean(selectedModelObj?.isCustom && selectedModelObj?.value === modelVal);
              const customLabel = isCustomModel ? selectedModelObj?.label : undefined;
              if (modelVal !== undefined) {
                reduxStore.dispatch({
                  type: 'modelSelection/modelPicked',
                  payload: {
                    conversationId: sessionId,
                    model: modelVal,
                    customLabel,
                    contextWindow: targetCw,
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
              const desiredDefaultCw =
                prevDefaultCw !== undefined
                  ? prevDefaultCw
                  : (cwStore.hasExplicitDefaultCw?.() ? cwStore.getDefaultCw() : '256K');
              const desiredDefaultModel = prevDefaultModel !== undefined ? prevDefaultModel : defObj?.model;
              const desiredDefaultCustomLabel =
                prevDefaultModel !== undefined ? prevDefaultCustomLabel : defObj?.customLabel;
              const defCwNormalized = cwStore.normalize(defObj?.contextWindow) || '256K';
              const desiredCwNormalized = cwStore.normalize(desiredDefaultCw) || '256K';
              if (
                defObj &&
                (defObj.model !== desiredDefaultModel ||
                  defObj.customLabel !== desiredDefaultCustomLabel ||
                  defCwNormalized !== desiredCwNormalized)
              ) {
                reduxStore.dispatch({
                  type: 'modelSelection/modelPicked',
                  payload: {
                    conversationId: undefined,
                    model: desiredDefaultModel,
                    customLabel: desiredDefaultCustomLabel,
                    contextWindow: desiredDefaultCw,
                  },
                });
              }
            }
          }
          if (dispatched || currentInRedux === targetCw) {
            lastAppliedCwGlobal = applyKey;
            setBoundedLruMap(lastAppliedCwByCascade, sessionId, applyKey, MAX_CASCADE_MAP_ENTRIES);
            setTriggerCwAttribute(triggerEl, targetCw);
            return true;
          }
          return false;
        }
        if (legacyCtx) {
          const modelCfg = legacyCtx.getModelConfigForConversation(sessionId);
          if (!modelCfg || modelCfg.value === undefined) return false;
          const currentInEngine = legacyCtx.getContextWindowForConversation(sessionId) || '256K';
          if (currentInEngine !== targetCw || userTriggered) {
            if (currentInEngine === targetCw && currentInDom !== targetCw) {
              const tempCw = targetCw === '256K' ? '512K' : '256K';
              legacyCtx.setModelForConversation(sessionId, modelCfg.value, true, modelCfg.label, tempCw);
            }
            legacyCtx.setModelForConversation(sessionId, modelCfg.value, true, modelCfg.label, targetCw);
          }
          lastAppliedCwGlobal = applyKey;
          setBoundedLruMap(lastAppliedCwByCascade, sessionId, applyKey, MAX_CASCADE_MAP_ENTRIES);
          setTriggerCwAttribute(triggerEl, targetCw);
          return true;
        }
        return false;
      }
      function pullAndBackfillTrajectorySummaries(summaries, csrf, viewOrEl) {
        if (!summaries || typeof summaries !== 'object' || typeof cwStore?.syncFromRemoteAnnotations !== 'function') {
          return false;
        }
        const { changed, unsyncedLocalIds } = cwStore.syncFromRemoteAnnotations(summaries);
        if (Array.isArray(unsyncedLocalIds) && unsyncedLocalIds.length > 0 && transport?.updateAnnotations) {
          for (const cid of unsyncedLocalIds) {
            const profileStr = cwStore.encodeRemoteAnnotationProfile(cid);
            if (profileStr) {
              transport
                .updateAnnotations({
                  cascadeIds: [cid],
                  annotations: { activeProfile: profileStr },
                  mergeAnnotations: true,
                  el: viewOrEl,
                  csrf,
                })
                .catch?.(() => {});
            }
          }
        }
        if (changed && typeof onRemoteAnnotationsUpdated === 'function') {
          try { onRemoteAnnotationsUpdated(); } catch {}
        }
        return changed;
      }
      function syncDesktopAnnotations(csrf, viewOrEl, force = false) {
        const nativeView = document?.querySelector?.('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
        if (!nativeView && document?.querySelector?.('ga-remote-control')) return Promise.resolve(false);
        const now = Date.now();
        if (desktopTrajectorySyncInFlight || (!force && now - lastDesktopTrajectorySyncTs < 4000)) {
          return Promise.resolve(false);
        }
        if (!transport?.getAllTrajectories) return Promise.resolve(false);
        lastDesktopTrajectorySyncTs = now;
        desktopTrajectorySyncInFlight = true;
        return Promise.resolve(transport.getAllTrajectories(viewOrEl, csrf))
          .then((all) => {
            const summaries = all?.trajectorySummaries;
            if (summaries) return pullAndBackfillTrajectorySummaries(summaries, csrf, viewOrEl);
            return false;
          })
          .catch(() => false)
          .finally(() => {
            desktopTrajectorySyncInFlight = false;
          });
      }
      function ensureRemoteHostView(onCascadeChange) {
        if (!document) return null;
        const nativeView = document.querySelector?.('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
        if (nativeView) return null;
        const rcEl = document.querySelector?.('ga-remote-control');
        if (!rcEl) return null;
        const rcInst = remotePortDriver?.resolveInstance?.();
        const appContainer = rcEl.querySelector?.('.app-container') || rcEl;
        let hostView = appContainer.querySelector?.('.agy-rc-host-view') || null;
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
        const stateRec = hostViewState?.get(hostView) || { lastChildPathCid: '', observedSteps: -1 };
        const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
        const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
        const innerView = cdoc?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
        const rawInnerCid = innerView?.getAttribute?.('data-cascade-id');
        const innerCid = rawInnerCid && UUID_RE.test(rawInnerCid) && rawInnerCid !== ignoreUuid ? rawInnerCid : '';
        const childPath = rcInst?.lastSyncedChildPath || window?.location?.search || '';
        const pathMatch = String(childPath).match(UUID_RE);
        const pathCid = pathMatch && pathMatch[0] && pathMatch[0] !== ignoreUuid ? pathMatch[0] : '';
        let activeCid = '';
        if (innerCid) {
          activeCid = innerCid;
          if (activeSniffedCascadeId !== innerCid) activeSniffedCascadeId = innerCid;
        } else if (pathCid && pathCid !== stateRec.lastChildPathCid) {
          stateRec.lastChildPathCid = pathCid;
          activeCid = pathCid;
          activeSniffedCascadeId = pathCid;
        } else {
          activeCid = activeSniffedCascadeId || pathCid || '';
        }
        hostViewState?.set(hostView, stateRec);
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
          const rcSvc = remotePortDriver.createRcServiceAdapter(rcInst, codec, injectCheckpointLimitIntoSendRequest);
          rcSvc
            .getAllCascadeTrajectories()
            .then((all) => {
              const summaries = all?.trajectorySummaries || {};
              const entries = Object.entries(summaries);
              if (!entries.length) return;
              const cwChanged = pullAndBackfillTrajectorySummaries(summaries, null, hostView);
              for (const [id, sum] of entries) {
                if (typeof sum?.stepCount === 'number') {
                  transport?.recordStepEvent?.(id, sum.stepCount);
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
                  activeSniffedCascadeId && activeSniffedCascadeId !== 'remote-session' && summaries[activeSniffedCascadeId]
                );
                if (!hasValidActive && (!prevId || prevId === 'remote-session' || !summaries[prevId])) {
                  activeSniffedCascadeId = latestId;
                }
                const resolvedId = activeSniffedCascadeId || (prevId && prevId !== 'remote-session' ? prevId : latestId);
                if (prevId === 'remote-session' && resolvedId && resolvedId !== 'remote-session') {
                  cwStore?.migrateSessionOverride?.('remote-session', resolvedId);
                }
                const nextSteps = transport?.getStepCount?.(resolvedId) ?? -1;
                const prevSteps = stateRec.observedSteps;
                stateRec.observedSteps = nextSteps;
                hostViewState?.set(hostView, stateRec);
                if (prevId !== resolvedId || prevSteps !== nextSteps || cwChanged) {
                  hostView.setAttribute('data-cascade-id', resolvedId);
                  if (typeof onCascadeChange === 'function') onCascadeChange(resolvedId);
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              rcTrajectoryPollInFlight = false;
            });
        }
        return hostView;
      }
      function getActiveSessions(onCascadeChange) {
        ensureCustomizationsStoreLoaded();
        ensureRemoteHostView(onCascadeChange);
        const sessions = [];
        const seenBoxes = new Set();
        const views = Array.from(document?.querySelectorAll?.('[data-testid="conversation-view"]') || []);
        const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
        if (cdoc) {
          views.push(...Array.from(cdoc.querySelectorAll?.('[data-testid="conversation-view"]') || []));
        }
        for (const viewEl of views) {
          const boxEl = viewEl.querySelector?.('[data-testid="agent-input-box"]') || null;
          if (!boxEl || seenBoxes.has(boxEl)) continue;
          seenBoxes.add(boxEl);
          const isRemoteShell = Boolean(viewEl.classList?.contains?.('agy-rc-host-view'));
          let sessionId = viewEl.getAttribute?.('data-cascade-id') || '';
          if (!sessionId || sessionId === 'remote-session') {
            const effView = resolveEffectiveView(viewEl);
            const effCid = effView?.getAttribute?.('data-cascade-id');
            if (effCid && effCid !== 'remote-session') {
              sessionId = effCid;
            } else if (activeSniffedCascadeId) {
              sessionId = activeSniffedCascadeId;
            }
          }
          const effView = resolveEffectiveView(viewEl);
          const triggerEl = effView?.querySelector?.('[data-testid="model-selector-trigger"]') || null;
          let observedEngineCw = triggerEl?.getAttribute?.('data-context-window') || '';
          if (!observedEngineCw && sessionId && sessionId !== 'remote-session') {
            const info = getModelSelectorContextForView(effView);
            const st = info?.reduxStore ? info.reduxStore.getState() : null;
            observedEngineCw =
              st?.modelSelection?.byConversation?.[sessionId]?.contextWindow ||
              info?.legacyCtx?.getContextWindowForConversation?.(sessionId) ||
              '';
          }
          sessions.push({
            sessionId: sessionId || 'remote-session',
            viewEl,
            inputEl: boxEl,
            triggerEl,
            isRemoteShell,
            observedEngineCw: observedEngineCw || undefined,
          });
        }
        return sessions;
      }
      function getAgentStateProviderForInputBox(inputBox, sessionIdOpt) {
        const cc = getCascadeContextForElement(inputBox);
        if (cc?.state?.agentStateProvider) return cc.state.agentStateProvider;
        const cid = sessionIdOpt || activeSniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id');
        const steps = cid && transport?.getStepCount ? transport.getStepCount(cid) : -1;
        const knownGenLen = cid && transport?.getKnownGenLen ? transport.getKnownGenLen(cid) : 0;
        if ((typeof steps === 'number' && steps >= 0) || (typeof knownGenLen === 'number' && knownGenLen > 0)) {
          return {
            getState: () => ({
              conversationId: cid,
              trajectorySlice: {
                totalGeneratorMetadataLength: -1,
                totalStepsLength: typeof steps === 'number' ? steps : -1,
              },
            }),
          };
        }
        return null;
      }
      function getDebugSnapshot(arg1, arg2, arg3) {
        let viewEl = null;
        let inputBox = null;
        let sessionId = '';
        if (typeof arg1 === 'string') {
          sessionId = arg1;
          viewEl = arg2 || null;
        } else {
          viewEl = arg1 || null;
          inputBox = arg2 || null;
          sessionId =
            (typeof arg3 === 'string' && arg3) ||
            viewEl?.getAttribute?.('data-cascade-id') ||
            activeSniffedCascadeId ||
            '';
        }
        const cc = getCascadeContextForElement(viewEl || inputBox);
        const asp = getAgentStateProviderForInputBox(inputBox || viewEl, sessionId);
        const rawState = asp?.getState?.();
        const stateMatches = isStateForCascade(rawState, sessionId);
        const slice = stateMatches ? rawState?.trajectorySlice : null;
        const rcGenLen = transport?.getKnownGenLen?.(sessionId) || 0;
        const rcStepLen = transport?.getStepCount?.(sessionId) ?? -1;
        const totalGenLen =
          typeof slice?.totalGeneratorMetadataLength === 'number' && slice.totalGeneratorMetadataLength > 0
            ? slice.totalGeneratorMetadataLength
            : (rcGenLen > 0 ? rcGenLen : 0);
        const totalStepsLen =
          typeof slice?.totalStepsLength === 'number' && slice.totalStepsLength > 0
            ? slice.totalStepsLength
            : (rcStepLen > 0 ? rcStepLen : 0);
        const msInfo = viewEl ? getModelSelectorContextForView(viewEl) : null;
        const msState = msInfo?.reduxStore ? msInfo.reduxStore.getState() : null;
        const rawReduxCw =
          (sessionId && msState?.modelSelection?.byConversation?.[sessionId]?.contextWindow) ||
          msState?.modelSelection?.default?.contextWindow ||
          msInfo?.legacyCtx?.getContextWindowForConversation?.(sessionId) ||
          null;
        const reduxSessionCw = rawReduxCw ? cwStore?.normalize?.(rawReduxCw) || null : null;
        const rpcSvc = getRemoteRpcServiceForElement(inputBox || viewEl);
        return {
          cascadeId: sessionId,
          reduxSessionCw,
          hasRemoteSvc: Boolean(rpcSvc && rpcSvc.isRemoteControlHost),
          totalGenLen,
          totalStepsLen,
          trajectoryId: slice?.trajectoryId || '',
          rawState: stateMatches ? rawState : null,
          canToggleInlineDebug: Boolean(cc?.debug && typeof cc.debug.setDebugMode === 'function'),
          toggleInlineDebug() {
            const curCc = getCascadeContextForElement(viewEl || inputBox);
            if (curCc?.debug && typeof curCc.debug.setDebugMode === 'function') {
              curCc.debug.setDebugMode(!curCc.debug.debugMode);
            }
          },
        };
      }
      function observeSessions(onRelevantChange) {
        const MoCtor = window?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
        const rootTarget = document?.body || document?.documentElement || null;
        if (!MoCtor || !rootTarget) return () => {};
        const isIgnoredNode = (node) => {
          let cur = node && node.nodeType === 3 ? node.parentElement : node;
          while (cur && cur.nodeType === 1) {
            if (
              cur.id === 'agy-ctx-statusbar-style' ||
              cur.id === 'agy-ctx-debug-modal' ||
              (cur.classList &&
                (cur.classList.contains('agy-ctx-statusbar') ||
                  cur.classList.contains('agy-ctx-menu') ||
                  cur.classList.contains('agy-ctx-modal-backdrop'))) ||
              (cur.getAttribute && cur.getAttribute('data-agy-no-translate') === 'true')
            ) {
              return true;
            }
            cur = cur.parentElement;
          }
          return false;
        };
        const obsOptions = {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-cascade-id', 'data-context-window'],
        };
        const observers = [];
        const observedDocs = typeof WeakSet === 'function' ? new WeakSet() : null;
        const handleMutations = (mutations) => {
          if (!mutations || mutations.length === 0) return;
          attachChildIframeObserver();
          let relevant = false;
          for (const m of mutations) {
            if (!isIgnoredNode(m.target)) {
              relevant = true;
              break;
            }
          }
          if (relevant && typeof onRelevantChange === 'function') {
            onRelevantChange();
          }
        };
        const observeDocTarget = (targetDoc) => {
          if (!targetDoc) return;
          if (observedDocs && observedDocs.has(targetDoc)) return;
          const targetNode = targetDoc.body || targetDoc.documentElement;
          if (!targetNode) return;
          try {
            const WinMo = targetDoc.defaultView?.MutationObserver || MoCtor;
            const o = new WinMo(handleMutations);
            o.observe(targetNode, obsOptions);
            observers.push(o);
            observedDocs?.add(targetDoc);
          } catch {}
        };
        const attachChildIframeObserver = () => {
          const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
          if (cdoc && cdoc !== document) {
            observeDocTarget(cdoc);
          }
        };
        observeDocTarget(document);
        attachChildIframeObserver();
        const iframePollId = scope?.setInterval?.(() => {
          if (!scope.isDisposed()) attachChildIframeObserver();
        }, 1500);
        const stop = () => {
          if (iframePollId !== null && iframePollId !== undefined) {
            scope?.clearInterval?.(iframePollId);
          }
          for (const o of observers) {
            try { o.disconnect(); } catch {}
          }
          observers.length = 0;
        };
        scope?.add?.(stop);
        return stop;
      }
      installLsClientDecoratorHook();
      ensureFetchHook(window);
      return {
        observeSessions,
        getActiveSessions,
        applyContextLimit,
        triggerCompact: () => false, // Composed in coordinator via CompactDriver
        getSelectedModelKey,
        getDebugSnapshot,
        getAgentStateProviderForInputBox,
        getRemoteRpcServiceForElement,
        getModelSelectorContextForView,
        ensureContextWindowSelectorFlag,
        ensureCustomizationsStoreLoaded,
        ensureRemoteHostView,
        syncDesktopAnnotations,
        injectCheckpointLimitIntoSendRequest,
        sniffCascadeIdFromRpc,
        resolveEffectiveInputBox,
        resolveEffectiveView,
        getActiveSniffedCascadeId: () => activeSniffedCascadeId,
        setActiveSniffedCascadeId: (cid) => {
          if (cid) activeSniffedCascadeId = cid;
        },
        dispose() {
          lastAppliedCwByCascade.clear();
          capturedLsClient = null;
          activeSniffedCascadeId = '';
        },
      };
    }
    module.exports = {
      MAX_CASCADE_MAP_ENTRIES,
      cleanupLegacyObjectPrototypeCwGetters,
      registerCustomCwForStyles,
      createReactFiberDriver,
    };
  },
  "./drivers/antigravity/compact-driver": function(module, exports, __require) {
    const require = (spec) => __require("./drivers/antigravity", spec);
    'use strict';
    /**
     * Antigravity Lexical Editor `/compact` Dispatch Driver.
     */
    const { DEFAULT_COMPACT_PROMPT } = require('../../domain/i18n');
    function createCompactDriver({ window, document, getRemoteRpcServiceForElement, getActiveCascadeId, resolveEffectiveInputBox, compactPrompt }) {
      const effPrompt = typeof compactPrompt === 'string' && compactPrompt.trim() ? compactPrompt.trim() : DEFAULT_COMPACT_PROMPT;
      const bindTimer = (name, fallback) =>
        window && typeof window[name] === 'function' ? window[name].bind(window) : fallback;
      async function runCompactForInputBox(inputBox, promptOverride) {
        const promptText =
          typeof promptOverride === 'string' && promptOverride.trim() ? promptOverride.trim() : effPrompt;
        const effBox = typeof resolveEffectiveInputBox === 'function' ? resolveEffectiveInputBox(inputBox) : inputBox;
        if (!effBox) return false;
        const editable = effBox.querySelector ? effBox.querySelector('[contenteditable="true"]') : null;
        if (!editable || !editable.__lexicalEditor) {
          const svc = typeof getRemoteRpcServiceForElement === 'function' ? getRemoteRpcServiceForElement(effBox) : null;
          const cid =
            (typeof getActiveCascadeId === 'function' ? getActiveCascadeId(effBox) : null) ||
            document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id') ||
            effBox.closest?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id');
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
                    text: ' ' + promptText,
                  },
                ],
              });
              return true;
            } catch {
              return false;
            }
          }
          return false;
        }
        const ed = editable.__lexicalEditor;
        const PClass = ed._nodes?.get?.('paragraph')?.klass;
        const MClass = ed._nodes?.get?.('contextScopeItemMention')?.klass;
        const TClass = ed._nodes?.get?.('text')?.klass;
        if (!PClass || !MClass || !TClass) return false;
        ed.update(() => {
          const root = ed.getEditorState()._nodeMap.get('root').getWritable();
          root.clear();
          const p = PClass.importJSON({
            direction: null,
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
            textFormat: 0,
            textStyle: '',
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
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: ' ' + promptText,
            type: 'text',
            version: 1,
          });
          p.append(mention, text);
          root.append(p);
        });
        const setT = bindTimer('setTimeout', typeof setTimeout === 'function' ? setTimeout : null);
        if (setT) {
          await new Promise((r) => setT(r, 60));
        }
        const fiberKey = Object.keys(editable).find((k) => k.startsWith('__reactFiber$'));
        let curr = fiberKey ? editable[fiberKey] : null;
        while (curr && (!curr.memoizedProps || typeof curr.memoizedProps.handleEnter !== 'function')) {
          curr = curr.return;
        }
        if (curr && curr.memoizedProps && typeof curr.memoizedProps.handleEnter === 'function') {
          const Evt =
            window?.KeyboardEvent ||
            (typeof KeyboardEvent === 'function' ? KeyboardEvent : function (t, o) { Object.assign(this, o, { type: t }); });
          await curr.memoizedProps.handleEnter(new Evt('keydown', { key: 'Enter' }), ed);
          return true;
        }
        const sendBtn = effBox.querySelector ? effBox.querySelector('[data-testid="send-button"]') : null;
        if (sendBtn && !sendBtn.disabled && typeof sendBtn.click === 'function') {
          sendBtn.click();
          return true;
        }
        return false;
      }
      return {
        compactPrompt: effPrompt,
        runCompactForInputBox,
      };
    }
    module.exports = {
      createCompactDriver,
    };
  },
  "./drivers/antigravity/companion-driver": function(module, exports, __require) {
    const require = (spec) => __require("./drivers/antigravity", spec);
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
  },
  "./ui/dom-builder": function(module, exports, __require) {
    const require = (spec) => __require("./ui", spec);
    'use strict';
    /**
     * Pure DOM Element Builder — zero HTML strings, zero HTML property writes, zero TrustedHTML sinks.
     * Compatible with browser DOM and lightweight Node unit-test DOM stubs.
     */
    function applyStyleProps(el, styleObj) {
      if (!el || !el.style || !styleObj || typeof styleObj !== 'object') return;
      for (const [prop, val] of Object.entries(styleObj)) {
        if (val === undefined || val === null) continue;
        try {
          el.style[prop] = String(val);
        } catch {}
      }
    }
    function appendChildValue(doc, parent, child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) {
        for (const nested of child) {
          appendChildValue(doc, parent, nested);
        }
        return;
      }
      if (typeof child === 'object' && typeof child.nodeType === 'number') {
        parent.appendChild(child);
        return;
      }
      if (typeof child === 'object' && typeof parent.appendChild === 'function' && child.tagName) {
        parent.appendChild(child);
        return;
      }
      const textStr = String(child);
      if (typeof doc.createTextNode === 'function') {
        parent.appendChild(doc.createTextNode(textStr));
      } else {
        const span = doc.createElement('span');
        span.textContent = textStr;
        parent.appendChild(span);
      }
    }
    const DANGEROUS_TAGS = new Set([
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'link',
      'meta',
      'base',
      'form',
      'svg',
      'math',
    ]);
    function isSafeAttribute(attrKey, attrVal) {
      const k = String(attrKey || '').trim().toLowerCase();
      if (!k || k.startsWith('on') || k === 'srcdoc' || k === 'formaction') return false;
      if (k === 'href' || k === 'src' || k === 'xlink:href' || k === 'action') {
        const normalized = String(attrVal ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
        if (/^(?:javascript|vbscript|data:text\/html)/i.test(normalized)) {
          return false;
        }
      }
      return true;
    }
    function h(doc, tag, props = null, ...children) {
      if (!doc || typeof doc.createElement !== 'function') {
        throw new TypeError('h() requires a Document with createElement()');
      }
      const cleanTag = String(tag || '').trim().toLowerCase();
      if (!cleanTag || DANGEROUS_TAGS.has(cleanTag)) {
        throw new TypeError(`Disallowed UI element tag "${String(tag)}"`);
      }
      const el = doc.createElement(cleanTag);
      if (props && typeof props === 'object') {
        for (const [key, val] of Object.entries(props)) {
          if (val === undefined || val === null) continue;
          if (key === 'className') {
            el.className = String(val);
          } else if (key === 'textContent') {
            el.textContent = String(val);
          } else if (key === 'style') {
            if (typeof val === 'object') {
              applyStyleProps(el, val);
            }
          } else if (key === 'attrs' && typeof val === 'object') {
            for (const [attrKey, attrVal] of Object.entries(val)) {
              if (attrVal === undefined || attrVal === null) continue;
              if (!isSafeAttribute(attrKey, attrVal)) {
                throw new TypeError(`Disallowed UI attribute "${attrKey}"`);
              }
              if (typeof el.setAttribute === 'function') {
                el.setAttribute(attrKey, String(attrVal));
              }
            }
          } else if (key === 'dataset' && typeof val === 'object') {
            for (const [dsKey, dsVal] of Object.entries(val)) {
              if (dsVal === undefined || dsVal === null) continue;
              const attrName = `data-${dsKey.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
              if (typeof el.setAttribute === 'function') {
                el.setAttribute(attrName, String(dsVal));
              }
              if (el.dataset) {
                el.dataset[dsKey] = String(dsVal);
              }
            }
          } else if (key === 'on' && typeof val === 'object') {
            for (const [evt, handler] of Object.entries(val)) {
              if (typeof handler === 'function' && typeof el.addEventListener === 'function') {
                el.addEventListener(evt, handler);
              }
            }
          } else if (key.startsWith('on') && typeof val === 'function') {
            el[key] = val;
          } else if (key === 'value' || key === 'type' || key === 'id' || key === 'title' || key === 'placeholder') {
            el[key] = String(val);
            if (typeof el.setAttribute === 'function' && (key === 'id' || key === 'title' || key === 'type' || key === 'placeholder')) {
              el.setAttribute(key, String(val));
            }
          } else if (key === 'role' || key.startsWith('aria-') || key.startsWith('data-') || key === 'translate' || key === 'colspan' || key === 'inputmode' || key === 'pattern') {
            if (typeof el.setAttribute === 'function') {
              el.setAttribute(key, String(val));
            }
          } else if (isSafeAttribute(key, val)) {
            el[key] = val;
          } else {
            throw new TypeError(`Disallowed UI prop "${key}"`);
          }
        }
      }
      for (const child of children) {
        appendChildValue(doc, el, child);
      }
      return el;
    }
    function setText(el, value) {
      if (!el) return;
      const next = String(value ?? '');
      if (el.textContent !== next) {
        el.textContent = next;
      }
    }
    function clearChildren(el) {
      if (!el) return;
      if (typeof el.replaceChildren === 'function') {
        try {
          el.replaceChildren();
          return;
        } catch {}
      }
      while (el.firstChild && typeof el.removeChild === 'function') {
        el.removeChild(el.firstChild);
      }
      if ('textContent' in el && (!el.childNodes || el.childNodes.length === 0)) {
        el.textContent = '';
      }
    }
    module.exports = {
      h,
      setText,
      clearChildren,
    };
  },
  "./ui/style-manager": function(module, exports, __require) {
    const require = (spec) => __require("./ui", spec);
    'use strict';
    /**
     * Pure CSP Nonce-Aware Style Sheet Injector & Scoped Cleanup.
     * Zero sibling dependencies, zero hardcoded host DOM selectors.
     */
    const STYLE_CSS = `
    .agy-ctx-statusbar {
      display: flex;
      align-items: center;
      justify-content: center;
      row-gap: 4px;
      column-gap: 10px;
      min-height: 22px;
      padding: 4px 10px 2px 10px;
      margin-top: 2px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      line-height: 1.4;
      color: rgba(160, 165, 175, 0.88);
      user-select: none;
      flex-wrap: wrap;
      position: relative;
      text-align: center;
      contain: layout style;
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
    [data-agy-session-switching="1"] .agy-ctx-bar-fill {
      transition: none !important;
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
      min-width: 225px;
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
      gap: 8px;
    }
    .agy-ctx-custom-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px 3px 10px;
      background: rgba(255, 255, 255, 0.02);
    }
    .agy-ctx-custom-hint {
      padding: 0 10px 6px 10px;
      font-size: 9.5px;
      color: rgba(148, 163, 184, 0.78);
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
    .agy-ctx-menu-default {
      margin-top: 2px;
      border-top: 1px solid rgba(128, 128, 128, 0.2);
      font-size: 10px;
      color: #93c5fd;
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
    .agy-tbl td.num, .agy-ctx-tbl td.num, .agy-ctx-tbl th.num {
      text-align: right;
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
      min-height: 24px;
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
        min-height: 40px;
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
`.replace(/\s+/g, ' ').trim();
    function buildDynamicCwWarnCss(underDefaultCwSet, documentHost) {
      if (documentHost && typeof documentHost.buildWarningSuppressionCss === 'function') {
        return documentHost.buildWarningSuppressionCss(underDefaultCwSet);
      }
      return '';
    }
    function getCspNonce(doc) {
      if (!doc) return '';
      try {
        const curNonce = doc.currentScript && (doc.currentScript.nonce || doc.currentScript.getAttribute?.('nonce'));
        if (curNonce) return String(curNonce);
      } catch {}
      const selectors = ['style[nonce]', 'script[nonce]', 'link[nonce]'];
      for (const sel of selectors) {
        try {
          const node = doc.querySelector?.(sel);
          const val = node && (node.nonce || node.getAttribute?.('nonce'));
          if (val) return String(val);
        } catch {}
      }
      try {
        const nodes = doc.querySelectorAll?.('style, script, link') || [];
        for (const node of nodes) {
          const val = node && (node.nonce || node.getAttribute?.('nonce'));
          if (val) return String(val);
        }
      } catch {}
      return '';
    }
    function resolveDocs(rootDoc, documentHost) {
      if (documentHost && typeof documentHost.getAccessibleDocs === 'function') {
        const list = documentHost.getAccessibleDocs(rootDoc);
        if (Array.isArray(list) && list.length > 0) return list;
      }
      return rootDoc ? [rootDoc] : [];
    }
    function ensureStyleElement(document, underDefaultCwSet, documentHost) {
      if (!document) return;
      const fullCss = STYLE_CSS + buildDynamicCwWarnCss(underDefaultCwSet, documentHost);
      const docs = resolveDocs(document, documentHost);
      const fallbackNonce = getCspNonce(document);
      for (const d of docs) {
        const parent = d.head || d.documentElement;
        if (!parent) continue;
        let docNonce = getCspNonce(d);
        if (!docNonce) {
          try {
            const pw = d.defaultView && d.defaultView.parent;
            if (pw && pw !== d.defaultView && pw.document) {
              docNonce = getCspNonce(pw.document);
            }
          } catch {}
        }
        const styleNonce = docNonce || fallbackNonce;
        let styleEl = d.getElementById('agy-ctx-statusbar-style');
        if (!styleEl) {
          styleEl = d.createElement('style');
          styleEl.id = 'agy-ctx-statusbar-style';
          if (styleNonce) {
            styleEl.nonce = styleNonce;
            styleEl.setAttribute?.('nonce', styleNonce);
          }
          parent.appendChild(styleEl);
        } else if (styleNonce && !styleEl.nonce && !styleEl.getAttribute?.('nonce')) {
          styleEl.nonce = styleNonce;
          styleEl.setAttribute?.('nonce', styleNonce);
        }
        if (styleEl.textContent !== fullCss) {
          styleEl.textContent = fullCss;
        }
      }
    }
    function removeStyleElements(document, documentHost) {
      for (const d of resolveDocs(document, documentHost)) {
        try {
          const styleEl = d.getElementById?.('agy-ctx-statusbar-style');
          styleEl?.remove?.();
        } catch {}
      }
    }
    module.exports = {
      STYLE_CSS,
      buildDynamicCwWarnCss,
      getCspNonce,
      ensureStyleElement,
      removeStyleElements,
    };
  },
  "./ui/adapter-registry": function(module, exports, __require) {
    const require = (spec) => __require("./ui", spec);
    'use strict';
    /**
     * Pure StatusBar Adapter Registry & DOM Slot Coordinator.
     * Uses WeakMap (zero DOM expandos) and pure dom-builder nodes (zero HTML strings).
     */
    const { h, setText } = require('./dom-builder');
    const nodeCleanupMap = new WeakMap();
    const adapterCtxMap = new WeakMap();
    function registerNodeCleanup(node, fn) {
      if (!node || typeof fn !== 'function') return;
      nodeCleanupMap.set(node, fn);
    }
    function runNodeCleanup(node) {
      if (!node) return;
      const fn = nodeCleanupMap.get(node);
      if (typeof fn === 'function') {
        nodeCleanupMap.delete(node);
        try {
          fn();
        } catch {}
      }
    }
    const VALID_ADAPTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const ALLOWED_ADAPTER_TAGS = new Set(['span', 'div', 'button']);
    function normalizeAdapter(adapter) {
      if (!adapter || typeof adapter !== 'object') {
        throw new TypeError('StatusBarAdapter must be an object');
      }
      const id = typeof adapter.id === 'string' ? adapter.id.trim() : '';
      if (!id || !VALID_ADAPTER_ID_RE.test(id)) {
        throw new TypeError('StatusBarAdapter requires a valid [A-Za-z0-9_-]{1,64} id');
      }
      const rawTag = adapter.tagName === undefined ? 'span' : String(adapter.tagName).trim().toLowerCase();
      if (!ALLOWED_ADAPTER_TAGS.has(rawTag)) {
        throw new TypeError(`StatusBarAdapter "${id}" has disallowed tagName "${rawTag}"`);
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
        tagName: rawTag,
        slot,
        order,
        builtin: Boolean(adapter.builtin),
      };
    }
    function createAdapterRegistry({ window, document, documentHost, onUpdate }) {
      const adapterRegistry = new Map();
      const hadPreexistingCustomStore = Boolean(window && window.__agyCustomStatusBarAdapters instanceof Map);
      if (window && !hadPreexistingCustomStore) {
        window.__agyCustomStatusBarAdapters = new Map();
      }
      const customStore = window?.__agyCustomStatusBarAdapters || new Map();
      function getTargetDocs() {
        if (documentHost && typeof documentHost.getAccessibleDocs === 'function') {
          const docs = documentHost.getAccessibleDocs(document);
          if (Array.isArray(docs) && docs.length > 0) return docs;
        }
        return document ? [document] : [];
      }
      function cleanupChildMenus(container) {
        if (!container || typeof container.querySelectorAll !== 'function') return;
        const menus = container.querySelectorAll('.agy-ctx-menu');
        for (const m of menus) {
          runNodeCleanup(m);
          try {
            m.remove();
          } catch {}
        }
      }
      function removeAdapterDomElements(id) {
        for (const targetDoc of getTargetDocs()) {
          if (!targetDoc || typeof targetDoc.querySelectorAll !== 'function') continue;
          const bars = targetDoc.querySelectorAll('.agy-ctx-statusbar');
          for (const bar of bars) {
            const nodes = bar.querySelectorAll(`[data-agy-adapter-id="${id}"]`);
            for (const node of nodes) {
              cleanupChildMenus(node);
              runNodeCleanup(node);
              try {
                node.remove();
              } catch {}
            }
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
          return a.order - b.order || a.id.localeCompare(b.id);
        });
        return list;
      }
      function registerAdapter(rawAdapter) {
        const adapter = normalizeAdapter(rawAdapter);
        if (adapterRegistry.has(adapter.id)) {
          const prev = adapterRegistry.get(adapter.id);
          if (prev && typeof prev.unmount === 'function') {
            try {
              prev.unmount();
            } catch {}
          }
          removeAdapterDomElements(adapter.id);
        }
        adapterRegistry.set(adapter.id, adapter);
        if (!adapter.builtin) {
          customStore.set(adapter.id, adapter);
        }
        if (typeof onUpdate === 'function') onUpdate();
        return () => unregisterAdapter(adapter.id);
      }
      function unregisterAdapter(id) {
        const key = typeof id === 'string' ? id.trim() : '';
        if (!key || !adapterRegistry.has(key)) return false;
        const adapter = adapterRegistry.get(key);
        adapterRegistry.delete(key);
        customStore.delete(key);
        if (adapter && typeof adapter.unmount === 'function') {
          try {
            adapter.unmount();
          } catch {}
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
        const ownerDoc = barEl?.ownerDocument || document;
        let leftEl = barEl.querySelector?.('.agy-ctx-left') || null;
        let rightEl = barEl.querySelector?.('.agy-ctx-right') || null;
        if (!leftEl || !rightEl) {
          cleanupChildMenus(barEl);
          leftEl = h(ownerDoc, 'div', { className: 'agy-ctx-left' });
          rightEl = h(ownerDoc, 'div', { className: 'agy-ctx-right' });
          if (typeof barEl.replaceChildren === 'function') {
            barEl.replaceChildren(leftEl, rightEl);
          } else {
            while (barEl.firstChild && typeof barEl.removeChild === 'function') {
              barEl.removeChild(barEl.firstChild);
            }
            barEl.appendChild(leftEl);
            barEl.appendChild(rightEl);
          }
        }
        return { leftEl, rightEl };
      }
      function renderSlotAdapters(slotEl, slotName, ctx) {
        if (!slotEl) return;
        const ownerDoc = slotEl.ownerDocument || document;
        const adapters = getSortedAdapters(slotName);
        const activeIds = new Set(adapters.map((a) => a.id));
        if (slotEl.querySelectorAll) {
          const existingNodes = slotEl.querySelectorAll('[data-agy-adapter-id]');
          for (const node of existingNodes) {
            const nodeId = node.getAttribute('data-agy-adapter-id');
            if (nodeId && !activeIds.has(nodeId)) {
              cleanupChildMenus(node);
              runNodeCleanup(node);
              try {
                node.remove();
              } catch {}
            }
          }
        }
        const orderedEls = [];
        for (const adapter of adapters) {
          let itemEl = slotEl.querySelector ? slotEl.querySelector(`[data-agy-adapter-id="${adapter.id}"]`) : null;
          if (typeof adapter.render === 'function') {
            if (!itemEl) {
              itemEl = h(ownerDoc, adapter.tagName || 'span', {
                className: adapter.className || undefined,
                'data-agy-adapter-id': adapter.id,
              });
              slotEl.appendChild(itemEl);
            }
            adapter.render(itemEl, ctx);
          } else {
            if (!itemEl) {
              itemEl = h(ownerDoc, 'button', {
                type: 'button',
                'data-agy-adapter-id': adapter.id,
                onclick(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  const latestCtx = adapterCtxMap.get(itemEl) || ctx;
                  if (typeof adapter.onClick === 'function') {
                    adapter.onClick(latestCtx, e);
                  }
                },
              });
              slotEl.appendChild(itemEl);
            }
            adapterCtxMap.set(itemEl, ctx);
            const resolvedClass =
              typeof adapter.className === 'function' ? adapter.className(ctx) : adapter.className || 'agy-ctx-btn';
            const finalClass = resolvedClass.includes('agy-ctx-btn')
              ? resolvedClass
              : `agy-ctx-btn ${resolvedClass}`.trim();
            if (itemEl.className !== finalClass) {
              itemEl.className = finalClass;
            }
            const resolvedLabel = typeof adapter.label === 'function' ? adapter.label(ctx) : String(adapter.label ?? '');
            setText(itemEl, resolvedLabel);
            const resolvedTitle = typeof adapter.title === 'function' ? adapter.title(ctx) : String(adapter.title ?? '');
            if (resolvedTitle) {
              if (itemEl.getAttribute?.('title') !== resolvedTitle) {
                itemEl.setAttribute?.('title', resolvedTitle);
                itemEl.title = resolvedTitle;
              }
            } else if (itemEl.getAttribute?.('title') !== null || itemEl.title) {
              itemEl.removeAttribute?.('title');
              itemEl.title = '';
            }
          }
          if (itemEl) orderedEls.push(itemEl);
        }
        if (orderedEls.length > 1 && slotEl.children) {
          let outOfOrder = false;
          for (let i = 0; i < orderedEls.length; i++) {
            if (slotEl.children[i] !== orderedEls[i]) {
              outOfOrder = true;
              break;
            }
          }
          if (outOfOrder) {
            if (typeof slotEl.insertBefore === 'function') {
              let anchor = slotEl.firstChild || null;
              for (const el of orderedEls) {
                if (el !== anchor) {
                  slotEl.insertBefore(el, anchor);
                } else {
                  anchor = el.nextSibling || null;
                }
              }
            } else {
              for (const el of orderedEls) {
                slotEl.appendChild(el);
              }
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
      function clearAllMenus(targetDoc = document) {
        cleanupChildMenus(targetDoc || document);
      }
      function dispose() {
        for (const adapter of adapterRegistry.values()) {
          if (adapter && typeof adapter.unmount === 'function') {
            try {
              adapter.unmount();
            } catch {}
          }
        }
        adapterRegistry.clear();
        if (window && window.__agyCustomStatusBarAdapters === customStore && customStore.size === 0 && !hadPreexistingCustomStore) {
          try {
            delete window.__agyCustomStatusBarAdapters;
          } catch {}
        }
      }
      return {
        registerAdapter,
        unregisterAdapter,
        registerBuiltinAdapters,
        getAdapters,
        getSortedAdapters,
        ensureBarStructure,
        renderSlotAdapters,
        clearAllMenus,
        dispose,
        registerNodeCleanup,
        runNodeCleanup,
      };
    }
    module.exports = {
      normalizeAdapter,
      createAdapterRegistry,
      registerNodeCleanup,
      runNodeCleanup,
    };
  },
  "./ui/views/compact-button": function(module, exports, __require) {
    const require = (spec) => __require("./ui/views", spec);
    'use strict';
    /**
     * Compact Action Button Builtin Adapter.
     * Uses pure UI localization (`i18n`) without direct driver imports.
     */
    const { DEFAULT_LOCALE, createTranslator } = require('../../domain/i18n');
    function createCompactButtonAdapter({ runCompactForInputBox, translator }) {
      const tr = translator || createTranslator(DEFAULT_LOCALE);
      return {
        id: 'compact',
        slot: 'right',
        order: 10,
        builtin: true,
        className: 'agy-ctx-btn agy-ctx-btn-compact',
        label: () => tr.t('compact.label'),
        title: () => tr.t('compact.title'),
        onClick({ inputBox }) {
          runCompactForInputBox(inputBox);
        },
      };
    }
    module.exports = {
      createCompactButtonAdapter,
    };
  },
  "./ui/views/metrics-view": function(module, exports, __require) {
    const require = (spec) => __require("./ui/views", spec);
    'use strict';
    /**
     * Core Metrics & Context Window Selector View (`core-metrics` builtin adapter).
     * Pure DOM node composition via `dom-builder` (zero HTML strings) + `WeakMap` state + `i18n` translator.
     */
    const { PRESET_CONTEXT_WINDOWS } = require('../../domain/context-window-policy');
    const { fmtK } = require('../../domain/metrics-calculator');
    const { DEFAULT_LOCALE, createTranslator } = require('../../domain/i18n');
    const { h, setText, clearChildren } = require('../dom-builder');
    const { registerNodeCleanup, runNodeCleanup } = require('../adapter-registry');
    const containerStateMap = new WeakMap();
    function getContainerState(containerEl) {
      let state = containerStateMap.get(containerEl);
      if (!state) {
        state = {
          lastCascadeId: '',
          pendingCrossSessionNoTransition: false,
          lastSignature: '',
          lastQuotaKey: '',
          refs: null,
        };
        containerStateMap.set(containerEl, state);
      }
      return state;
    }
    function createCoreMetricsAdapter({
      document,
      documentHost,
      cwStore,
      translator,
      getConversationContextWindow,
      setConversationContextWindow,
      cycleConversationContextWindow,
      saveDefaultContextWindow,
      updateAll,
    }) {
      const tr = translator || createTranslator(DEFAULT_LOCALE);
      function closeExistingMenu(menu) {
        if (!menu) return;
        runNodeCleanup(menu);
        try {
          menu.remove();
        } catch {}
      }
      function showContextMenu(barEl, view, cascadeId, limitBtn) {
        const ownerDoc = barEl?.ownerDocument || document;
        const existing = barEl.querySelector?.('.agy-ctx-menu');
        if (existing) {
          closeExistingMenu(existing);
          return;
        }
        const allDocs =
          documentHost && typeof documentHost.getAccessibleDocs === 'function'
            ? documentHost.getAccessibleDocs(document)
            : [ownerDoc, document].filter(Boolean);
        for (const d of allDocs) {
          if (d && typeof d.querySelectorAll === 'function') {
            const openMenus = d.querySelectorAll('.agy-ctx-menu');
            for (const m of openMenus) {
              if (m.parentNode === barEl) continue;
              closeExistingMenu(m);
            }
          }
        }
        const resolveCurrentCascadeId = () =>
          documentHost && typeof documentHost.resolveViewSessionId === 'function'
            ? documentHost.resolveViewSessionId(view, cascadeId)
            : (cascadeId || '');
        const currentCw = getConversationContextWindow(view, resolveCurrentCascadeId());
        const currentKNum = parseInt(currentCw, 10) || 512;
        const activeHdrCid = resolveCurrentCascadeId();
        const sessionLabel = activeHdrCid ? activeHdrCid.slice(0, 8) : tr.t('metrics.currentSession');
        const winObj = ownerDoc?.defaultView || document?.defaultView || null;
        const nativeSetTimeout = winObj && typeof winObj.setTimeout === 'function' ? winObj.setTimeout.bind(winObj) : setTimeout;
        const nativeClearTimeout =
          winObj && typeof winObj.clearTimeout === 'function' ? winObj.clearTimeout.bind(winObj) : clearTimeout;
        let iframeDoc = null;
        try {
          iframeDoc = documentHost?.getIframeDocument?.() || null;
        } catch {}
        let attachTimer = null;
        let menu = null;
        const outsideHandler = (e) => {
          if (!menu) return;
          if (!menu.contains || (!menu.contains(e.target) && e.target !== limitBtn)) {
            closeMenu();
          }
        };
        const closeMenu = () => {
          if (attachTimer !== null) {
            nativeClearTimeout(attachTimer);
            attachTimer = null;
          }
          if (menu) {
            menu.remove();
          }
          for (const evt of ['mousedown', 'pointerdown', 'touchstart']) {
            ownerDoc?.removeEventListener?.(evt, outsideHandler, true);
            if (document && document !== ownerDoc) {
              document.removeEventListener?.(evt, outsideHandler, true);
            }
            try {
              iframeDoc?.removeEventListener?.(evt, outsideHandler, true);
            } catch {}
          }
          try {
            winObj?.removeEventListener?.('blur', closeMenu);
          } catch {}
        };
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
        const inputEl = h(ownerDoc, 'input', {
          type: 'text',
          inputmode: 'numeric',
          pattern: '[0-9kKmM.]*',
          className: 'agy-ctx-custom-input',
          value: String(currentKNum),
          placeholder: tr.t('menu.customPlaceholder'),
          title: tr.t('menu.customHint'),
          onkeydown(e) {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              applyCustomInput();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeMenu();
            }
          },
        });
        const applyBtn = h(
          ownerDoc,
          'button',
          {
            type: 'button',
            className: 'agy-ctx-custom-apply',
            onclick(e) {
              e.preventDefault();
              e.stopPropagation();
              applyCustomInput();
            },
          },
          tr.t('menu.apply')
        );
        const optionsList = [...PRESET_CONTEXT_WINDOWS];
        if (currentCw && !optionsList.includes(currentCw)) {
          optionsList.unshift(currentCw);
        }
        const optionNodes = optionsList.map((cw) =>
          h(
            ownerDoc,
            'div',
            {
              className: `agy-ctx-menu-item${cw === currentCw ? ' active' : ''}`,
              'data-cw-option': cw,
              onclick(e) {
                e.preventDefault();
                e.stopPropagation();
                setConversationContextWindow(view, resolveCurrentCascadeId(), cw);
                closeMenu();
                updateAll();
              },
            },
            h(ownerDoc, 'span', null, `${cw === currentCw ? '✓ ' : '  '}${cw}`),
            h(ownerDoc, 'span', { className: 'agy-ctx-menu-hint' }, cwStore.getQuotaHint(cw))
          )
        );
        const defaultCw = typeof cwStore.getDefaultCw === 'function' ? cwStore.getDefaultCw() : '512K';
        const saveDefaultNode =
          typeof saveDefaultContextWindow === 'function' && currentCw !== defaultCw
            ? h(
                ownerDoc,
                'div',
                {
                  className: 'agy-ctx-menu-item agy-ctx-menu-default',
                  'data-cw-save-default': currentCw,
                  onclick(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    saveDefaultContextWindow(currentCw);
                    closeMenu();
                    updateAll();
                  },
                },
                h(ownerDoc, 'span', null, tr.t('menu.saveAsDefault', { cw: currentCw, defCw: defaultCw }))
              )
            : null;
        menu = h(
          ownerDoc,
          'div',
          {
            className: 'agy-ctx-menu',
            'data-agy-no-translate': 'true',
            translate: 'no',
          },
          h(
            ownerDoc,
            'div',
            { className: 'agy-ctx-menu-hdr' },
            h(ownerDoc, 'span', null, tr.t('menu.headerLeft')),
            h(ownerDoc, 'span', { style: { opacity: '0.75' } }, sessionLabel)
          ),
          h(
            ownerDoc,
            'div',
            { className: 'agy-ctx-custom-row' },
            inputEl,
            h(ownerDoc, 'span', { className: 'agy-ctx-custom-unit' }, 'K'),
            applyBtn
          ),
          h(ownerDoc, 'div', { className: 'agy-ctx-custom-hint' }, tr.t('menu.customHint')),
          ...optionNodes,
          saveDefaultNode
        );
        if (typeof menu.addEventListener === 'function') {
          for (const evtName of [
            'mousedown',
            'mouseup',
            'pointerdown',
            'pointerup',
            'touchstart',
            'touchend',
            'click',
            'dblclick',
            'keydown',
            'keyup',
            'keypress',
            'contextmenu',
          ]) {
            menu.addEventListener(evtName, (ev) => ev.stopPropagation());
          }
        }
        registerNodeCleanup(menu, closeMenu);
        attachTimer = nativeSetTimeout(() => {
          attachTimer = null;
          if (!menu.isConnected && menu.parentNode !== barEl) return;
          for (const evt of ['mousedown', 'pointerdown', 'touchstart']) {
            ownerDoc?.addEventListener?.(evt, outsideHandler, true);
            if (document && document !== ownerDoc) {
              document.addEventListener?.(evt, outsideHandler, true);
            }
            try {
              iframeDoc?.addEventListener?.(evt, outsideHandler, true);
            } catch {}
          }
          try {
            winObj?.addEventListener?.('blur', closeMenu);
          } catch {}
          const isCoarseOrNarrow =
            typeof winObj?.matchMedia === 'function' && winObj.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
          if (!isCoarseOrNarrow && inputEl.isConnected && typeof inputEl.focus === 'function') {
            inputEl.focus();
            if (typeof inputEl.select === 'function') inputEl.select();
          }
        }, 10);
        barEl.appendChild(menu);
      }
      function renderQuotaSlot(quotaSlotEl, quota, localeKey) {
        const ownerDoc = quotaSlotEl?.ownerDocument || document;
        clearChildren(quotaSlotEl);
        if (!quota) return;
        const parts = [];
        if (quota.pct5h !== null && quota.pct5h !== undefined) {
          parts.push(
            h(
              ownerDoc,
              'span',
              null,
              '5h ',
              h(ownerDoc, 'strong', { className: 'agy-ctx-quota' }, `${quota.pct5h}%`),
              h(ownerDoc, 'span', { className: 'agy-ctx-quota-left' }, ` ${tr.t('metrics.leftLabel')}`),
              quota.rst5h ? ` ${quota.rst5h}` : null
            )
          );
        }
        if (quota.pct7d !== null && quota.pct7d !== undefined) {
          parts.push(
            h(
              ownerDoc,
              'span',
              null,
              '7d ',
              h(ownerDoc, 'strong', { className: 'agy-ctx-quota' }, `${quota.pct7d}%`),
              h(ownerDoc, 'span', { className: 'agy-ctx-quota-left' }, ` ${tr.t('metrics.leftLabel')}`)
            )
          );
        }
        if (!parts.length) return;
        const groupChildren = [];
        parts.forEach((part, idx) => {
          if (idx > 0) {
            groupChildren.push(h(ownerDoc, 'span', { className: 'agy-ctx-sep' }, ' · '));
          }
          groupChildren.push(part);
        });
        quotaSlotEl.appendChild(h(ownerDoc, 'span', { className: 'agy-ctx-sep agy-ctx-sep-pipe' }, '|'));
        quotaSlotEl.appendChild(
          h(ownerDoc, 'span', { className: 'agy-ctx-group agy-ctx-group-quota', 'data-locale': localeKey }, ...groupChildren)
        );
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
          containerEl.setAttribute?.('data-agy-no-translate', 'true');
          containerEl.setAttribute?.('translate', 'no');
          const state = getContainerState(containerEl);
          const localeKey = tr.getLocale();
          const currentCw = ctx.currentCw || getConversationContextWindow(view, cascadeId);
          const maxLimit = cwStore.getLimit(currentCw);
          const used = stats ? stats.used : 0;
          const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
          const usedStr = stats ? fmtK(used) : '…';
          const cachePct = stats ? stats.cachePct : 0;
          const colorClass = pct >= 85 ? 'agy-ctx-crit' : pct >= 65 ? 'agy-ctx-warn' : 'agy-ctx-ok';
          const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';
          const limitModClass =
            maxLimit >= 750000 ? 'agy-ctx-btn-limit-900' : maxLimit > 256000 ? 'agy-ctx-btn-limit-512' : '';
          const resolvedViewCid =
            documentHost && typeof documentHost.resolveViewSessionId === 'function'
              ? documentHost.resolveViewSessionId(view, cascadeId)
              : (cascadeId || '');
          const titleSessionLabel = resolvedViewCid ? resolvedViewCid.slice(0, 8) : tr.t('metrics.currentSession');
          const limitTitle = tr.t('metrics.limitTitle', {
            session: titleSessionLabel,
            cw: currentCw,
            hint: cwStore.getQuotaHint(currentCw),
          });
          const sessionChanged = Boolean(state.lastCascadeId && state.lastCascadeId !== resolvedViewCid);
          state.lastCascadeId = resolvedViewCid;
          if (ctx.deferUncachedMetrics) {
            const existingLimitBtn = state.refs?.limitBtn || containerEl.querySelector?.('.agy-ctx-btn-limit');
            if (existingLimitBtn) {
              const nextLimitClass = `agy-ctx-btn agy-ctx-btn-limit ${limitModClass}`.trim();
              if (existingLimitBtn.className !== nextLimitClass) existingLimitBtn.className = nextLimitClass;
              if (existingLimitBtn.getAttribute?.('title') !== limitTitle) {
                existingLimitBtn.setAttribute?.('title', limitTitle);
                existingLimitBtn.title = limitTitle;
              }
              setText(existingLimitBtn, `[ ${currentCw.toLowerCase()} ▾ ]`);
              state.pendingCrossSessionNoTransition = true;
              state.lastSignature = '';
              return;
            }
            if (state.lastSignature) {
              state.pendingCrossSessionNoTransition = true;
              state.lastSignature = '';
              return;
            }
          }
          const suppressBarTransition = sessionChanged || state.pendingCrossSessionNoTransition;
          state.pendingCrossSessionNoTransition = false;
          const quotaKey = quota ? `${localeKey}|${quota.pct5h ?? ''}|${quota.rst5h ?? ''}|${quota.pct7d ?? ''}` : '';
          const signature = `${localeKey}|${pct}|${usedStr}|${currentCw}|${cachePct}|${limitTitle}|${quotaKey}`;
          if (state.lastSignature === signature && !suppressBarTransition && state.refs) {
            return;
          }
          state.lastSignature = signature;
          if (!state.refs) {
            const ownerDoc = containerEl?.ownerDocument || document;
            const barFill = h(ownerDoc, 'span', {
              className: 'agy-ctx-bar-fill',
              style: {
                width: `${pct}%`,
                background: barColor,
                ...(suppressBarTransition ? { transition: 'none' } : {}),
              },
            });
            const pctValEl = h(ownerDoc, 'strong', { className: `agy-ctx-pct-val ${colorClass}` }, `${pct}%`);
            const usedValEl = h(ownerDoc, 'span', { className: 'agy-ctx-used-val' }, usedStr);
            const limitBtn = h(
              ownerDoc,
              'button',
              {
                type: 'button',
                className: `agy-ctx-btn agy-ctx-btn-limit ${limitModClass}`.trim(),
                title: limitTitle,
                onclick(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  const activeCid =
                    documentHost && typeof documentHost.resolveViewSessionId === 'function'
                      ? documentHost.resolveViewSessionId(view, state.lastCascadeId)
                      : state.lastCascadeId;
                  if (e.shiftKey) {
                    cycleConversationContextWindow(view, activeCid);
                    updateAll();
                  } else {
                    showContextMenu(barEl, view, activeCid, limitBtn);
                  }
                },
                oncontextmenu(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  const activeCid =
                    documentHost && typeof documentHost.resolveViewSessionId === 'function'
                      ? documentHost.resolveViewSessionId(view, state.lastCascadeId)
                      : state.lastCascadeId;
                  showContextMenu(barEl, view, activeCid, limitBtn);
                },
              },
              `[ ${currentCw.toLowerCase()} ▾ ]`
            );
            const ctxLabelEl = h(ownerDoc, 'span', null, `${tr.t('metrics.ctxLabel')} `);
            const cacheLabelEl = h(ownerDoc, 'span', null, `${tr.t('metrics.cacheLabel')} `);
            const cacheEl = h(ownerDoc, 'strong', { className: 'agy-ctx-cache' }, `${cachePct}%`);
            const quotaSlotEl = h(ownerDoc, 'span', {
              className: 'agy-ctx-quota-slot',
              'data-agy-no-translate': 'true',
              translate: 'no',
            });
            const groupCtx = h(
              ownerDoc,
              'span',
              {
                className: 'agy-ctx-group agy-ctx-group-ctx',
                'data-agy-no-translate': 'true',
                translate: 'no',
              },
              h(ownerDoc, 'span', { className: 'agy-ctx-bar-wrap' }, barFill),
              h(ownerDoc, 'span', null, ctxLabelEl, pctValEl, ' ', usedValEl, '/', limitBtn),
              h(ownerDoc, 'span', { className: 'agy-ctx-sep' }, '·'),
              h(ownerDoc, 'span', null, cacheLabelEl, cacheEl)
            );
            clearChildren(containerEl);
            containerEl.appendChild(groupCtx);
            containerEl.appendChild(quotaSlotEl);
            state.refs = {
              barFill,
              pctValEl,
              usedValEl,
              limitBtn,
              ctxLabelEl,
              cacheLabelEl,
              cacheEl,
              quotaSlotEl,
            };
            state.lastQuotaKey = quotaKey;
            renderQuotaSlot(quotaSlotEl, quota, localeKey);
            return;
          }
          const { barFill, pctValEl, usedValEl, limitBtn, ctxLabelEl, cacheLabelEl, cacheEl, quotaSlotEl } = state.refs;
          if (barFill.style) {
            barFill.style.transition = suppressBarTransition ? 'none' : '';
            barFill.style.width = `${pct}%`;
            barFill.style.background = barColor;
          }
          const nextPctClass = `agy-ctx-pct-val ${colorClass}`;
          if (pctValEl.className !== nextPctClass) pctValEl.className = nextPctClass;
          setText(pctValEl, `${pct}%`);
          setText(usedValEl, usedStr);
          const nextLimitClass = `agy-ctx-btn agy-ctx-btn-limit ${limitModClass}`.trim();
          if (limitBtn.className !== nextLimitClass) limitBtn.className = nextLimitClass;
          if (limitBtn.getAttribute?.('title') !== limitTitle) {
            limitBtn.setAttribute?.('title', limitTitle);
            limitBtn.title = limitTitle;
          }
          setText(limitBtn, `[ ${currentCw.toLowerCase()} ▾ ]`);
          setText(ctxLabelEl, `${tr.t('metrics.ctxLabel')} `);
          setText(cacheLabelEl, `${tr.t('metrics.cacheLabel')} `);
          setText(cacheEl, `${cachePct}%`);
          if (state.lastQuotaKey !== quotaKey) {
            state.lastQuotaKey = quotaKey;
            renderQuotaSlot(quotaSlotEl, quota, localeKey);
          }
        },
      };
    }
    module.exports = {
      createCoreMetricsAdapter,
    };
  },
  "./ui/views/context-modal": function(module, exports, __require) {
    const require = (spec) => __require("./ui/views", spec);
    'use strict';
    /**
     * Context & Trajectory Debug Modal View (`context` builtin adapter).
     * Pure DOM composition via `dom-builder` (zero HTML strings) + `WeakMap` cleanup + `i18n` translator.
     */
    const { fmtNum, getChatModelFromMeta } = require('../../domain/metrics-calculator');
    const { DEFAULT_LOCALE, createTranslator } = require('../../domain/i18n');
    const { h, clearChildren } = require('../dom-builder');
    const { registerNodeCleanup, runNodeCleanup } = require('../adapter-registry');
    function createContextModalAdapter({ document, documentHost, window, translator, loadDebugTelemetry, toggleInlineStats }) {
      const tr = translator || createTranslator(DEFAULT_LOCALE);
      function closeExistingModal() {
        const existing = document?.getElementById?.('agy-ctx-debug-modal');
        if (!existing) return false;
        runNodeCleanup(existing);
        try {
          existing.remove();
        } catch {}
        return true;
      }
      function renderTelemetryBody(bodyEl, payload) {
        const {
          currentCw,
          maxLimit,
          parsed,
          metas,
          totalGenLen,
          totalStepsLen,
          trajectoryId,
          cascadeId,
          latestCwm,
          latestSections,
          latestModel,
        } = payload;
        const used = parsed.used || 0;
        const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
        const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';
        const cardGrid = h(
          document,
          'div',
          { className: 'agy-ctx-card-grid' },
          h(
            document,
            'div',
            { className: 'agy-ctx-card' },
            h(document, 'div', { className: 'agy-ctx-card-lbl' }, tr.t('modal.cardCtx', { cw: currentCw })),
            h(
              document,
              'div',
              { className: 'agy-ctx-card-val', style: { color: barColor } },
              `${pct}% (${fmtNum(used)} / ${fmtNum(maxLimit)})`
            ),
            h(
              document,
              'div',
              {
                style: {
                  marginTop: '5px',
                  height: '5px',
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: '3px',
                  overflow: 'hidden',
                },
              },
              h(document, 'div', { style: { width: `${pct}%`, height: '100%', background: barColor } })
            )
          ),
          h(
            document,
            'div',
            { className: 'agy-ctx-card' },
            h(document, 'div', { className: 'agy-ctx-card-lbl' }, tr.t('modal.cardCache')),
            h(document, 'div', { className: 'agy-ctx-card-val agy-ctx-cache' }, `${parsed.cachePct}%`),
            h(
              document,
              'div',
              { style: { fontSize: '10px', color: '#94a3b8', marginTop: '2px' } },
              tr.t('modal.cardCacheSub', { cache: fmtNum(parsed.cacheRead), input: fmtNum(parsed.inputTok) })
            )
          ),
          h(
            document,
            'div',
            { className: 'agy-ctx-card' },
            h(document, 'div', { className: 'agy-ctx-card-lbl' }, tr.t('modal.cardTraj')),
            h(
              document,
              'div',
              { className: 'agy-ctx-card-val' },
              tr.t('modal.cardTrajVal', { steps: fmtNum(totalStepsLen), turns: fmtNum(totalGenLen) })
            ),
            h(
              document,
              'div',
              { style: { fontSize: '10px', color: '#94a3b8', marginTop: '2px' } },
              tr.t('modal.cardTrajSub', { max: fmtNum(parsed.trajectoryMax), model: latestModel || '-' })
            )
          )
        );
        const groups = latestCwm?.tokenBreakdown?.groups || [];
        let breakdownBlock = null;
        if (groups.length > 0) {
          const groupRows = groups.map((g) => {
            const gTok = Number(g.numTokens || 0);
            const gPct = used > 0 ? ((gTok / used) * 100).toFixed(1) : '0.0';
            return h(
              document,
              'tr',
              null,
              h(document, 'td', null, String(g.name || g.type || g.source || 'Section')),
              h(document, 'td', { className: 'num' }, fmtNum(gTok)),
              h(document, 'td', { className: 'num' }, `${gPct}%`)
            );
          });
          breakdownBlock = h(
            document,
            'div',
            null,
            h(
              document,
              'div',
              { className: 'agy-ctx-sec-title' },
              h(document, 'span', null, tr.t('modal.breakdownTitle')),
              h(
                document,
                'span',
                null,
                tr.t('modal.breakdownTotal', { total: fmtNum(latestCwm?.tokenBreakdown?.totalTokens || used) })
              )
            ),
            h(
              document,
              'table',
              { className: 'agy-ctx-tbl' },
              h(
                document,
                'thead',
                null,
                h(
                  document,
                  'tr',
                  null,
                  h(document, 'th', null, tr.t('modal.colGroupSource')),
                  h(document, 'th', { className: 'num' }, tr.t('modal.colTokens')),
                  h(document, 'th', { className: 'num' }, tr.t('modal.colShare'))
                )
              ),
              h(document, 'tbody', null, ...groupRows)
            )
          );
        } else if (latestSections.length > 0) {
          const sectionRows = latestSections.map((s, idx) => {
            const textLen = (s.content || s.templatedContent || '').length;
            return h(
              document,
              'tr',
              null,
              h(document, 'td', null, `#${idx + 1} ${String(s.title || s.tokenType || 'PromptSection')}`),
              h(document, 'td', null, String(s.tokenSource || s.metadata?.sourceType || '-')),
              h(document, 'td', { className: 'num' }, tr.t('modal.charsUnit', { count: fmtNum(textLen) }))
            );
          });
          breakdownBlock = h(
            document,
            'div',
            null,
            h(
              document,
              'div',
              { className: 'agy-ctx-sec-title' },
              h(document, 'span', null, tr.t('modal.sectionsTitle', { count: latestSections.length }))
            ),
            h(
              document,
              'table',
              { className: 'agy-ctx-tbl' },
              h(
                document,
                'thead',
                null,
                h(
                  document,
                  'tr',
                  null,
                  h(document, 'th', null, tr.t('modal.colSectionTitle')),
                  h(document, 'th', null, tr.t('modal.colSource')),
                  h(document, 'th', { className: 'num' }, tr.t('modal.colSize'))
                )
              ),
              h(document, 'tbody', null, ...sectionRows)
            )
          );
        }
        const turnRows = [];
        const fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
        for (let i = metas.length - 1; i >= 0 && turnRows.length < 12; i--) {
          const m = metas[i];
          const cm = getChatModelFromMeta(m);
          if (!cm) continue;
          const u = cm.usage || {};
          const cwm = cm.chatStartMetadata?.contextWindowMetadata;
          const stepIdx = cm.chatStartMetadata?.startStepIndex ?? m.stepIndices?.[0] ?? fetchOffset + i;
          const inTok = Number(u.inputTokens || 0);
          const crTok = Number(u.cacheReadTokens || 0);
          const outTok = Number(u.outputTokens || u.responseOutputTokens || 0);
          const thkTok = Number(u.thinkingOutputTokens || 0);
          const totP = inTok + crTok;
          const cPct = totP > 0 ? `${Math.round((crTok / totP) * 100)}%` : '-';
          turnRows.push(
            h(
              document,
              'tr',
              null,
              h(document, 'td', null, `#${String(stepIdx)}`),
              h(document, 'td', null, String(cm.modelDisplayName || cm.responseModel || cm.model || '-')),
              h(document, 'td', { className: 'num' }, cwm?.estimatedTokensUsed ? fmtNum(cwm.estimatedTokensUsed) : '-'),
              h(document, 'td', { className: 'num' }, `${fmtNum(crTok)} (${cPct})`),
              h(document, 'td', { className: 'num' }, fmtNum(inTok)),
              h(
                document,
                'td',
                { className: 'num' },
                fmtNum(outTok),
                thkTok ? h(document, 'span', { style: { opacity: '0.65' } }, ` ${tr.t('modal.thkSuffix', { count: fmtNum(thkTok) })}`) : null
              )
            )
          );
        }
        const turnsBlock = h(
          document,
          'div',
          null,
          h(
            document,
            'div',
            { className: 'agy-ctx-sec-title' },
            h(document, 'span', null, tr.t('modal.turnsTitle', { shown: turnRows.length, total: totalGenLen || metas.length })),
            h(
              document,
              'span',
              { style: { fontWeight: '400', opacity: '0.7' } },
              tr.t('modal.trajectoryId', { id: trajectoryId || cascadeId || 'unknown' })
            )
          ),
          h(
            document,
            'table',
            { className: 'agy-ctx-tbl' },
            h(
              document,
              'thead',
              null,
              h(
                document,
                'tr',
                null,
                h(document, 'th', null, tr.t('modal.colStep')),
                h(document, 'th', null, tr.t('modal.colModel')),
                h(document, 'th', { className: 'num' }, tr.t('modal.colEstCtx')),
                h(document, 'th', { className: 'num' }, tr.t('modal.colCacheRead')),
                h(document, 'th', { className: 'num' }, tr.t('modal.colFreshInput')),
                h(document, 'th', { className: 'num' }, tr.t('modal.colOutputThink'))
              )
            ),
            h(
              document,
              'tbody',
              null,
              ...(turnRows.length
                ? turnRows
                : [
                    h(
                      document,
                      'tr',
                      null,
                      h(document, 'td', { colspan: '6', style: { opacity: '0.6' } }, tr.t('modal.noTurns'))
                    ),
                  ])
            )
          )
        );
        clearChildren(bodyEl);
        bodyEl.appendChild(cardGrid);
        if (breakdownBlock) bodyEl.appendChild(breakdownBlock);
        bodyEl.appendChild(turnsBlock);
      }
      async function openOrToggleDebugModal(view, inputBox, explicitSessionId = '') {
        if (closeExistingModal()) {
          return;
        }
        if ((!view || !inputBox) && documentHost && typeof documentHost.findFallbackSessionTarget === 'function') {
          const fb = documentHost.findFallbackSessionTarget();
          if (!view) view = fb?.view || null;
          if (!inputBox) inputBox = fb?.inputBox || null;
        }
        const rawCid =
          documentHost && typeof documentHost.resolveViewSessionId === 'function'
            ? documentHost.resolveViewSessionId(view, explicitSessionId)
            : explicitSessionId || '';
        const bodyEl = h(
          document,
          'div',
          { id: 'agy-ctx-modal-body', className: 'agy-ctx-modal-body' },
          h(document, 'div', { style: { opacity: '0.75' } }, tr.t('modal.loading'))
        );
        let backdrop = null;
        const onKeyDown = (e) => {
          if (e.key === 'Escape') closeModal();
        };
        const closeModal = () => {
          try {
            backdrop?.remove?.();
          } catch {}
          try {
            window?.removeEventListener?.('keydown', onKeyDown);
          } catch {}
        };
        const inlineBtn = h(
          document,
          'button',
          {
            type: 'button',
            id: 'agy-ctx-toggle-inline-debug',
            className: 'agy-ctx-btn',
            title: tr.t('modal.inlineStatsTitle'),
            onclick() {
              if (typeof toggleInlineStats === 'function') {
                toggleInlineStats(view, inputBox);
              }
            },
          },
          tr.t('modal.inlineStats')
        );
        const closeBtn = h(
          document,
          'button',
          {
            type: 'button',
            id: 'agy-ctx-modal-close',
            className: 'agy-ctx-btn',
            title: tr.t('modal.closeTitle'),
            onclick: closeModal,
          },
          tr.t('modal.close')
        );
        const titleCid = rawCid || 'unknown';
        const modalEl = h(
          document,
          'div',
          {
            className: 'agy-ctx-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr.t('modal.title'),
          },
          h(
            document,
            'div',
            { className: 'agy-ctx-modal-hdr' },
            h(
              document,
              'span',
              null,
              `${tr.t('modal.title')} `,
              h(document, 'span', { style: { opacity: '0.6', fontWeight: '400', fontSize: '11px' } }, `(${titleCid})`)
            ),
            h(document, 'div', { className: 'agy-ctx-modal-hdr-actions' }, inlineBtn, closeBtn)
          ),
          bodyEl
        );
        backdrop = h(
          document,
          'div',
          {
            id: 'agy-ctx-debug-modal',
            className: 'agy-ctx-modal-backdrop',
            'data-agy-no-translate': 'true',
            translate: 'no',
            onclick(e) {
              if (e.target === backdrop) closeModal();
            },
          },
          modalEl
        );
        registerNodeCleanup(backdrop, closeModal);
        window?.addEventListener?.('keydown', onKeyDown);
        document.body?.appendChild?.(backdrop);
        try {
          const payload = await loadDebugTelemetry(view, inputBox, rawCid);
          if (!backdrop.isConnected && document.getElementById?.('agy-ctx-debug-modal') !== backdrop) {
            return;
          }
          if (!payload || payload.unavailable) {
            clearChildren(bodyEl);
            bodyEl.appendChild(h(document, 'div', { className: 'agy-ctx-crit' }, tr.t('modal.noSession')));
            return;
          }
          renderTelemetryBody(bodyEl, payload);
        } catch (err) {
          clearChildren(bodyEl);
          bodyEl.appendChild(
            h(document, 'div', { className: 'agy-ctx-crit' }, tr.t('modal.fetchFailed', { error: err?.message || String(err) }))
          );
        }
      }
      return {
        id: 'context',
        slot: 'right',
        order: 20,
        builtin: true,
        className: 'agy-ctx-btn agy-ctx-btn-context',
        label: () => tr.t('context.label'),
        title: () => tr.t('context.title'),
        onClick({ view, inputBox, cascadeId }) {
          openOrToggleDebugModal(view, inputBox, cascadeId || '');
        },
        openOrToggleDebugModal,
        closeExistingModal,
      };
    }
    module.exports = {
      createContextModalAdapter,
    };
  },
  "./app/disposable": function(module, exports, __require) {
    const require = (spec) => __require("./app", spec);
    'use strict';
    /**
     * Deterministic Resource & Timer Lifecycle Scope.
     * Always binds native timer functions to `win` to avoid `Illegal invocation` on headless/DOM windows.
     */
    function createDisposableScope(win) {
      let disposed = false;
      const cleanups = [];
      const intervals = new Set();
      const timeouts = new Set();
      const bindTimer = (name, fallback) => {
        try {
          if (win && typeof win[name] === 'function') {
            return win[name].bind(win);
          }
        } catch {}
        return fallback;
      };
      const nativeSetTimeout = bindTimer('setTimeout', typeof setTimeout === 'function' ? setTimeout : null);
      const nativeClearTimeout = bindTimer('clearTimeout', typeof clearTimeout === 'function' ? clearTimeout : null);
      const nativeSetInterval = bindTimer('setInterval', typeof setInterval === 'function' ? setInterval : null);
      const nativeClearInterval = bindTimer('clearInterval', typeof clearInterval === 'function' ? clearInterval : null);
      function add(fn) {
        if (typeof fn !== 'function') return () => {};
        if (disposed) {
          try {
            fn();
          } catch {}
          return () => {};
        }
        cleanups.push(fn);
        return () => {
          const idx = cleanups.indexOf(fn);
          if (idx >= 0) cleanups.splice(idx, 1);
        };
      }
      function trackTimeout(fn, ms) {
        if (disposed || !nativeSetTimeout) return null;
        let id = null;
        id = nativeSetTimeout(() => {
          if (id !== null) timeouts.delete(id);
          if (!disposed && typeof fn === 'function') fn();
        }, ms);
        timeouts.add(id);
        return id;
      }
      function clearTrackedTimeout(id) {
        if (id === null || id === undefined) return;
        timeouts.delete(id);
        try {
          nativeClearTimeout?.(id);
        } catch {}
      }
      function trackInterval(fn, ms) {
        if (disposed || !nativeSetInterval) return null;
        const id = nativeSetInterval(() => {
          if (!disposed && typeof fn === 'function') fn();
        }, ms);
        intervals.add(id);
        return id;
      }
      function clearTrackedInterval(id) {
        if (id === null || id === undefined) return;
        intervals.delete(id);
        try {
          nativeClearInterval?.(id);
        } catch {}
      }
      function listen(target, eventName, handler, options) {
        if (disposed || !target || typeof target.addEventListener !== 'function' || typeof handler !== 'function') {
          return () => {};
        }
        target.addEventListener(eventName, handler, options);
        return add(() => {
          try {
            target.removeEventListener?.(eventName, handler, options);
          } catch {}
        });
      }
      function dispose() {
        if (disposed) return;
        disposed = true;
        for (const id of timeouts) {
          try {
            nativeClearTimeout?.(id);
          } catch {}
        }
        timeouts.clear();
        for (const id of intervals) {
          try {
            nativeClearInterval?.(id);
          } catch {}
        }
        intervals.clear();
        for (let i = cleanups.length - 1; i >= 0; i--) {
          try {
            cleanups[i]();
          } catch {}
        }
        cleanups.length = 0;
      }
      return {
        isDisposed: () => disposed,
        add,
        setTimeout: trackTimeout,
        clearTimeout: clearTrackedTimeout,
        setInterval: trackInterval,
        clearInterval: clearTrackedInterval,
        listen,
        dispose,
      };
    }
    module.exports = {
      createDisposableScope,
    };
  },
  "./app/state-coordinator": function(module, exports, __require) {
    const require = (spec) => __require("./app", spec);
    'use strict';
    /**
     * Pure Application State Coordinator.
     * Connects Domain + Ports + UI without touching any Driver implementation directly.
     */
    const {
      validateTransportPort,
      validateStoragePort,
      validateEnginePort,
    } = require('../ports/contracts');
    const { CONTEXT_WINDOWS } = require('../domain/context-window-policy');
    const { extractStatsFromMetas, applyRealtimeCompactionAndUsage, getChatModelFromMeta } = require('../domain/metrics-calculator');
    function createStateCoordinator({
      document,
      documentHost,
      transport,
      storage,
      engine,
      cwStore,
      translator,
      adapterRegistry,
      underDefaultCwSet,
      ensureStyles,
      removeStyles,
      scope,
      csrfProvider,
      getRcGenLen,
      getRcStepLen,
    }) {
      validateTransportPort(transport);
      validateStoragePort(storage);
      validateEnginePort(engine);
      let updateScheduled = false;
      let scheduledTimer = null;
      let lastViewCount = 0;
      let quotaRefreshing = false;
      const statsPendingRefresh = new Set();
      const statsAttemptedSessions = new Set();
      function getCsrf() {
        return typeof csrfProvider === 'function' ? csrfProvider() : '';
      }
      function getConversationContextWindow(view, cascadeId) {
        return cwStore.getSavedContextWindow(cascadeId);
      }
      function setConversationContextWindow(view, cascadeId, cw, opts = {}) {
        const norm = cwStore.normalize(cw);
        if (!norm) return null;
        if (cascadeId && cascadeId !== 'remote-session') {
          cwStore.saveContextWindowSetting(cascadeId, norm);
        } else {
          cwStore.saveContextWindowSetting(null, norm);
        }
        const maxLimit = cwStore.getLimit(norm);
        const shouldWarn = maxLimit <= 256000;
        if (shouldWarn && underDefaultCwSet) {
          underDefaultCwSet.add(norm);
          ensureStyles?.();
        }
        if (opts.applyEngine !== false) {
          try {
            engine.applyContextLimit(view, cascadeId, norm, opts.userTriggered !== false);
          } catch {}
        }
        return norm;
      }
      function cycleConversationContextWindow(view, cascadeId) {
        const current = getConversationContextWindow(view, cascadeId);
        const idx = CONTEXT_WINDOWS.indexOf(current);
        const next = idx >= 0 ? CONTEXT_WINDOWS[(idx + 1) % CONTEXT_WINDOWS.length] : CONTEXT_WINDOWS[0];
        return setConversationContextWindow(view, cascadeId, next);
      }
      function saveDefaultContextWindow(cw) {
        const norm = cwStore.saveContextWindowSetting(null, cw);
        if (norm && underDefaultCwSet && cwStore.getLimit(norm) <= 256000) {
          underDefaultCwSet.add(norm);
          ensureStyles?.();
        }
        return norm;
      }
      function getTargetDocs() {
        if (documentHost && typeof documentHost.getAccessibleDocs === 'function') {
          const docs = documentHost.getAccessibleDocs(document);
          if (Array.isArray(docs) && docs.length > 0) return docs;
        }
        return document ? [document] : [];
      }
      function removeOrphanHostViews(activeHostViews) {
        for (const targetDoc of getTargetDocs()) {
          if (!targetDoc || typeof targetDoc.querySelectorAll !== 'function') continue;
          const hostViews = targetDoc.querySelectorAll('.agy-rc-host-view');
          for (const hv of hostViews) {
            if (!activeHostViews.has(hv)) {
              try {
                hv.remove();
              } catch {}
            }
          }
        }
      }
      function renderSessionBar(session) {
        const cascadeId = session?.sessionId || session?.cascadeId || '';
        const view = session?.viewEl || session?.view || null;
        const inputBox = session?.inputEl || session?.inputBox || null;
        const isRemoteHost = Boolean(session?.isRemoteShell || session?.isRemoteHost);
        const hostBox = session?.hostBox || (isRemoteHost ? inputBox : null);
        const isRemotePlaceholder = !cascadeId || cascadeId === 'remote-session';
        const asp = !isRemotePlaceholder && typeof engine.getAgentStateProviderForInputBox === 'function'
          ? engine.getAgentStateProviderForInputBox(inputBox || view, cascadeId)
          : null;
        const rawState = session?.rawState || asp?.getState?.() || null;
        const cachedStats = isRemotePlaceholder ? null : transport.getCachedStats(cascadeId);
        const immediateStats = isRemotePlaceholder ? null : transport.getImmediateStats(cascadeId, rawState);
        if (!isRemotePlaceholder && session?.observedEngineCw && !cwStore.hasSessionOverride(cascadeId)) {
          cwStore.seedSessionIfEmpty(cascadeId, session.observedEngineCw);
        }
        const currentCw = getConversationContextWindow(view, isRemotePlaceholder ? '' : cascadeId);
        try {
          engine.applyContextLimit(view, isRemotePlaceholder ? '' : cascadeId, currentCw, false);
        } catch {}
        const activeStats = immediateStats || cachedStats || null;
        const deferUncachedMetrics = Boolean(
          !isRemotePlaceholder && !activeStats && lastViewCount > 0 && !statsAttemptedSessions.has(cascadeId)
        );
        if (!isRemotePlaceholder && !statsPendingRefresh.has(cascadeId)) {
          const csrf = getCsrf();
          statsPendingRefresh.add(cascadeId);
          transport
            .getStats({
              cascadeId,
              rawState,
              getLatestState: () => {
                const curAsp =
                  typeof engine.getAgentStateProviderForInputBox === 'function'
                    ? engine.getAgentStateProviderForInputBox(inputBox || view, cascadeId)
                    : asp;
                return curAsp?.getState?.() || null;
              },
              el: inputBox || view,
              csrf,
              totalGenLen: typeof getRcGenLen === 'function' ? getRcGenLen(cascadeId) : 0,
              totalStepsLen: typeof getRcStepLen === 'function' ? getRcStepLen(cascadeId) : -1,
            })
            .then((nextStats) => {
              const firstCompletion = !statsAttemptedSessions.has(cascadeId);
              statsAttemptedSessions.add(cascadeId);
              statsPendingRefresh.delete(cascadeId);
              if ((nextStats && nextStats !== activeStats) || firstCompletion) {
                scheduleUpdate();
              }
            })
            .catch(() => {
              const firstCompletion = !statsAttemptedSessions.has(cascadeId);
              statsAttemptedSessions.add(cascadeId);
              statsPendingRefresh.delete(cascadeId);
              if (firstCompletion) {
                scheduleUpdate();
              }
            });
        }
        const barTarget = isRemoteHost && hostBox ? hostBox : inputBox;
        if (!barTarget) return;
        const barDoc = barTarget.ownerDocument || document;
        let barEl = barTarget.querySelector?.('.agy-ctx-statusbar') || null;
        if (!barEl) {
          barEl = barDoc.createElement('div');
          barEl.className = 'agy-ctx-statusbar';
          barEl.setAttribute?.('data-agy-no-translate', 'true');
          barEl.setAttribute?.('translate', 'no');
          barTarget.appendChild(barEl);
        }
        const { leftEl, rightEl } = adapterRegistry.ensureBarStructure(barEl);
        const renderCtx = {
          barEl,
          view,
          inputBox: inputBox || view,
          cascadeId: isRemotePlaceholder ? '' : cascadeId,
          currentCw,
          stats: activeStats,
          quota: transport.getLatestQuota(),
          deferUncachedMetrics,
        };
        adapterRegistry.renderSlotAdapters(leftEl, 'left', renderCtx);
        adapterRegistry.renderSlotAdapters(rightEl, 'right', renderCtx);
      }
      function updateAll() {
        if (scope?.isDisposed?.()) return;
        ensureStyles?.();
        const sessions = engine.getActiveSessions(() => scheduleUpdate(40)) || [];
        const activeHostViews = new Set();
        for (const s of sessions) {
          const isRemoteHost = Boolean(s?.isRemoteShell || s?.isRemoteHost);
          const view = s?.viewEl || s?.view || null;
          if (isRemoteHost && view) {
            activeHostViews.add(view);
          }
          renderSessionBar(s);
        }
        removeOrphanHostViews(activeHostViews);
        lastViewCount = sessions.length;
        const csrf = getCsrf();
        if (!quotaRefreshing && (csrf || sessions.some((s) => s.isRemoteShell || s.isRemoteHost || s.isRemoteIframe))) {
          quotaRefreshing = true;
          const sampleEl = sessions[0]?.inputEl || sessions[0]?.inputBox || sessions[0]?.viewEl || sessions[0]?.view || null;
          transport
            .getQuota({ el: sampleEl, csrf })
            .then(() => {
              quotaRefreshing = false;
            })
            .catch(() => {
              quotaRefreshing = false;
            });
        }
      }
      function scheduleUpdate(delayMs = 50) {
        if (scope?.isDisposed?.()) return;
        if (updateScheduled) return;
        updateScheduled = true;
        scheduledTimer = scope.setTimeout(() => {
          updateScheduled = false;
          scheduledTimer = null;
          updateAll();
        }, delayMs);
      }
      async function loadDebugTelemetry(view, inputBox, rawCid) {
        const snap = engine.getDebugSnapshot(view, inputBox, rawCid);
        const csrf = getCsrf();
        const cascadeId = snap?.cascadeId || rawCid || '';
        if (!cascadeId || (!csrf && !snap?.hasRemoteSvc)) {
          return { unavailable: true };
        }
        const currentCw = cwStore.getSavedContextWindow(cascadeId);
        const maxLimit = cwStore.getLimit(currentCw);
        let totalGenLen = snap?.totalGenLen || (typeof getRcGenLen === 'function' ? getRcGenLen(cascadeId) : 0) || 0;
        const totalStepsLen = snap?.totalStepsLen || (typeof getRcStepLen === 'function' ? getRcStepLen(cascadeId) : 0) || 0;
        let fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
        let metas = [];
        if (typeof transport.getGeneratorMetadataRange === 'function') {
          metas = await transport.getGeneratorMetadataRange({
            cascadeId,
            offset: fetchOffset,
            el: inputBox || view,
            csrf,
          });
        }
        if (metas.length > 0) {
          const possibleEnd = fetchOffset + metas.length;
          if (possibleEnd > totalGenLen) totalGenLen = possibleEnd;
        }
        let parsed = extractStatsFromMetas(metas);
        if (snap?.rawState) {
          parsed = applyRealtimeCompactionAndUsage(parsed, snap.rawState);
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
          const cwm = cm.chatStartMetadata?.contextWindowMetadata;
          if (!latestCwm && cwm && cwm.estimatedTokensUsed !== undefined && cwm.estimatedTokensUsed !== null) {
            latestCwm = cwm;
          }
          if (!latestSections.length && Array.isArray(cm.promptSections) && cm.promptSections.length > 0) {
            latestSections = cm.promptSections;
          }
        }
        return {
          unavailable: false,
          cascadeId,
          trajectoryId: snap?.trajectoryId || '',
          currentCw: snap?.reduxSessionCw || currentCw,
          maxLimit,
          parsed,
          metas: metas.length > 20 ? metas.slice(-20) : metas,
          totalGenLen,
          totalStepsLen,
          latestCwm,
          latestSections,
          latestModel,
        };
      }
      function start() {
        updateAll();
        const stopObs = engine.observeSessions(() => scheduleUpdate(40));
        scope.add(stopObs);
        scope.setInterval(() => {
          if (!scope.isDisposed()) updateAll();
        }, 3000);
      }
      function dispose() {
        if (scheduledTimer !== null) {
          scope.clearTimeout(scheduledTimer);
          scheduledTimer = null;
        }
        for (const targetDoc of getTargetDocs()) {
          adapterRegistry.clearAllMenus?.(targetDoc);
          try {
            const bars = targetDoc?.querySelectorAll?.('.agy-ctx-statusbar') || [];
            for (const b of bars) {
              adapterRegistry.runNodeCleanup?.(b);
              b.remove?.();
            }
            const hostViews = targetDoc?.querySelectorAll?.('.agy-rc-host-view') || [];
            for (const hv of hostViews) hv.remove?.();
            const modal = targetDoc?.getElementById?.('agy-ctx-debug-modal');
            if (modal) {
              adapterRegistry.runNodeCleanup?.(modal);
              modal.remove?.();
            }
          } catch {}
        }
        removeStyles?.();
        statsPendingRefresh.clear();
        statsAttemptedSessions.clear();
      }
      return {
        getConversationContextWindow,
        setConversationContextWindow,
        cycleConversationContextWindow,
        saveDefaultContextWindow,
        loadDebugTelemetry,
        updateAll,
        scheduleUpdate,
        start,
        dispose,
      };
    }
    module.exports = {
      createStateCoordinator,
    };
  },
  "./app/index": function(module, exports, __require) {
    const require = (spec) => __require("./app", spec);
    'use strict';
    /**
     * Antigravity Status Bar v2.0.0 — Hexagonal Composition Root.
     * Sole module allowed to wire Domain + Ports + UI + Antigravity Drivers together.
     */
    const { PLUGIN_BUS_SYMBOL, getOrCreatePluginBus } = require('../ports/contracts');
    const { createTranslator } = require('../domain/i18n');
    const { createContextWindowStore } = require('../domain/context-window-policy');
    const { resolveHostAdapterConfig } = require('../drivers/antigravity/host-config');
    const { createStorageAdapter, createLocalHttpTransport } = require('../drivers/antigravity/local-http-transport');
    const { createRemotePortDriver, createDocumentHostDriver } = require('../drivers/antigravity/remote-port-driver');
    const {
      createReactFiberDriver,
      registerCustomCwForStyles,
      cleanupLegacyObjectPrototypeCwGetters,
    } = require('../drivers/antigravity/react-fiber-driver');
    const { createCompactDriver } = require('../drivers/antigravity/compact-driver');
    const { createCompanionDriver } = require('../drivers/antigravity/companion-driver');
    const { ensureStyleElement, removeStyleElements, getCspNonce } = require('../ui/style-manager');
    const { createAdapterRegistry } = require('../ui/adapter-registry');
    const { createCoreMetricsAdapter } = require('../ui/views/metrics-view');
    const { createCompactButtonAdapter } = require('../ui/views/compact-button');
    const { createContextModalAdapter } = require('../ui/views/context-modal');
    const { createDisposableScope } = require('./disposable');
    const { createStateCoordinator } = require('./state-coordinator');
    function mountStatusBar(targetWindow = typeof window !== 'undefined' ? window : globalThis, overrides = {}) {
      const win = targetWindow || globalThis;
      const doc = overrides.document || win.document;
      if (typeof win.__agyStatusBarCleanup === 'function') {
        try {
          win.__agyStatusBarCleanup();
        } catch {}
      }
      const scope = createDisposableScope(win);
      const resolvedHostConfig = resolveHostAdapterConfig(overrides.hostConfig, win);
      const resolveCsrfToken = () => resolvedHostConfig.resolveCsrfToken(win);
      const translator = createTranslator(
        resolvedHostConfig.locale,
        win.navigator?.language || win.navigator?.userLanguage || ''
      );
      const remotePortDriver = createRemotePortDriver({
        window: win,
        document: doc,
        hostConfig: resolvedHostConfig,
        scope,
      });
      const documentHost = createDocumentHostDriver({
        document: doc,
        remotePortDriver,
      });
      const underDefaultCwSet = new Set(['128K', '256K']);
      const ensureStyles = () => ensureStyleElement(doc, underDefaultCwSet, documentHost);
      const removeStyles = () => removeStyleElements(doc, documentHost);
      let localStorageObj = overrides.localStorage || null;
      if (!localStorageObj) {
        try {
          localStorageObj = win.localStorage;
        } catch {
          localStorageObj = null;
        }
      }
      const storage = createStorageAdapter({
        window: win,
        document: doc,
        localStorage: localStorageObj,
      });
      let engineRef = null;
      let coordinatorRef = null;
      let flushSaveTimer = null;
      const cwStore = createContextWindowStore({
        storage,
        translator,
        onCustomCw(cw) {
          registerCustomCwForStyles(cw, underDefaultCwSet, ensureStyles, win);
        },
        onSaveCw() {
          if (flushSaveTimer) scope.clearTimeout(flushSaveTimer);
          flushSaveTimer = scope.setTimeout(() => {
            flushSaveTimer = null;
            if (!scope.isDisposed() && engineRef) {
              Promise.resolve(
                engineRef.syncDesktopAnnotations(resolveCsrfToken(), null)
              ).catch(() => {});
            }
          }, 250);
        },
      });
      cwStore.loadPersistentContextSettings().then(() => coordinatorRef?.updateAll?.()).catch(() => {});
      const fetchImpl =
        overrides.fetch ||
        (typeof win.fetch === 'function' ? win.fetch.bind(win) : typeof fetch === 'function' ? fetch : null);
      const transport = createLocalHttpTransport({
        fetchFn: fetchImpl,
        window: win,
        localStorage: localStorageObj,
        hostConfig: resolvedHostConfig,
        scope,
        getRemoteRpcServiceForElement: (el) => engineRef?.getRemoteRpcServiceForElement?.(el) || null,
        onQuotaUpdated() {
          coordinatorRef?.scheduleUpdate?.(20);
        },
      });
      const engine = createReactFiberDriver({
        window: win,
        document: doc,
        localStorage: localStorageObj,
        cwStore,
        transport,
        remotePortDriver,
        hostConfig: resolvedHostConfig,
        scope,
        onCascadeSniffed() {
          coordinatorRef?.scheduleUpdate?.(20);
        },
        onRemoteAnnotationsUpdated(updated) {
          if (updated) {
            coordinatorRef?.scheduleUpdate?.(30);
          }
        },
      });
      engineRef = engine;
      const compactDriver = createCompactDriver({
        window: win,
        document: doc,
        getRemoteRpcServiceForElement: (el) => engine.getRemoteRpcServiceForElement(el),
        getActiveCascadeId: (el) =>
          el?.closest?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id') || engine.getActiveSniffedCascadeId(),
        resolveEffectiveInputBox: (el) => engine.resolveEffectiveInputBox(el),
        compactPrompt: resolvedHostConfig.compactPrompt,
      });
      engine.triggerCompact = (inputBox, promptOverride) => compactDriver.runCompactForInputBox(inputBox, promptOverride);
      const adapterRegistry = createAdapterRegistry({
        window: win,
        document: doc,
        documentHost,
        onUpdate() {
          coordinatorRef?.updateAll?.();
        },
      });
      const coordinator = createStateCoordinator({
        document: doc,
        documentHost,
        transport,
        storage,
        engine,
        cwStore,
        translator,
        adapterRegistry,
        underDefaultCwSet,
        ensureStyles,
        removeStyles,
        scope,
        csrfProvider: resolveCsrfToken,
        getRcGenLen: (cid) => transport.getKnownGenLen?.(cid) || 0,
        getRcStepLen: (cid) => transport.getStepCount?.(cid) || 0,
      });
      coordinatorRef = coordinator;
      const coreMetricsAdapter = createCoreMetricsAdapter({
        document: doc,
        documentHost,
        cwStore,
        translator,
        getConversationContextWindow: coordinator.getConversationContextWindow,
        setConversationContextWindow: coordinator.setConversationContextWindow,
        cycleConversationContextWindow: coordinator.cycleConversationContextWindow,
        saveDefaultContextWindow: coordinator.saveDefaultContextWindow,
        updateAll: coordinator.updateAll,
      });
      const compactAdapter = createCompactButtonAdapter({
        runCompactForInputBox: (inputBox) => compactDriver.runCompactForInputBox(inputBox),
        translator,
      });
      const contextModalAdapter = createContextModalAdapter({
        document: doc,
        documentHost,
        window: win,
        translator,
        loadDebugTelemetry: coordinator.loadDebugTelemetry,
        toggleInlineStats(view, inputBox) {
          const snap = engine.getDebugSnapshot(view, inputBox);
          snap?.toggleInlineDebug?.();
        },
      });
      adapterRegistry.registerBuiltinAdapters([coreMetricsAdapter, compactAdapter, contextModalAdapter]);
      const companionDriver = createCompanionDriver({
        window: win,
        document: doc,
        hostConfig: resolvedHostConfig,
        transport,
        remotePortDriver,
        scope,
        getNonce: () => getCspNonce(doc),
      });
      const isRemoteHostActive = resolvedHostConfig.isRemoteHost(win.location?.hostname);
      if (
        isRemoteHostActive ||
        (Array.isArray(resolvedHostConfig.companionScripts) && resolvedHostConfig.companionScripts.length > 0)
      ) {
        Promise.resolve(companionDriver.loadCompanions({ fetch: fetchImpl })).catch(() => {});
      }
      const pluginBus = getOrCreatePluginBus(win);
      const unregisterBus = pluginBus.registerPlugin('antigravity-statusbar', {
        version: '2.0.0',
        capabilities: ['context-window', 'metrics', 'compact', 'debug-modal', 'i18n'],
      });
      scope.add(() => unregisterBus());
      scope.add(() => adapterRegistry.dispose?.());
      scope.add(() => coordinator.dispose());
      scope.add(() => engine.dispose());
      scope.add(() => transport.dispose());
      scope.add(() => remotePortDriver.dispose());
      scope.add(() => cleanupLegacyObjectPrototypeCwGetters(win));
      if (!isRemoteHostActive) {
        Promise.resolve(engine.syncDesktopAnnotations(resolveCsrfToken(), null)).catch(() => {});
      }
      coordinator.start();
      const destroy = () => {
        scope.dispose();
        if (win.__agyStatusBarCleanup === destroy) {
          delete win.__agyStatusBarCleanup;
        }
      };
      scope.listen(win, 'pagehide', destroy);
      win.__agyStatusBarCleanup = destroy;
      const api = {
        version: '2.0.0',
        pluginBus,
        registerAdapter: adapterRegistry.registerAdapter,
        unregisterAdapter: adapterRegistry.unregisterAdapter,
        getAdapters: adapterRegistry.getAdapters,
        getContextWindow: (cascadeId) => cwStore.getSavedContextWindow(cascadeId),
        setContextWindow: (cascadeId, cw) => {
          const res = coordinator.setConversationContextWindow(null, cascadeId, cw);
          coordinator.updateAll();
          return res;
        },
        getConversationContextWindow: (viewOrId, cascadeIdOpt) => {
          if (typeof viewOrId === 'string') {
            return coordinator.getConversationContextWindow(null, viewOrId);
          }
          return coordinator.getConversationContextWindow(viewOrId || null, cascadeIdOpt || '');
        },
        setConversationContextWindow: (viewOrId, cascadeIdOrCw, cwOpt, opts) => {
          const res =
            typeof viewOrId === 'string' && cwOpt === undefined
              ? coordinator.setConversationContextWindow(null, viewOrId, cascadeIdOrCw)
              : coordinator.setConversationContextWindow(viewOrId || null, cascadeIdOrCw || '', cwOpt, opts);
          coordinator.updateAll();
          return res;
        },
        getLocale: () => translator.getLocale(),
        setLocale: (locale) => {
          const next = translator.setLocale(locale);
          coordinator.updateAll();
          return next;
        },
        updateAll: coordinator.updateAll,
        runCompact: (inputBox, promptOverride) => compactDriver.runCompactForInputBox(inputBox, promptOverride),
        openDebugModal: (view, inputBox) => contextModalAdapter.openOrToggleDebugModal(view, inputBox),
        destroy,
      };
      win.agyStatusBar = api;
      return api;
    }
    function shouldAutoMount() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return false;
      if (globalThis.__AGY_STATUSBAR_DISABLE_AUTOMOUNT__ || window.__AGY_STATUSBAR_DISABLE_AUTOMOUNT__) return false;
      if (typeof process !== 'undefined' && process.env && process.env.AGY_STATUSBAR_DISABLE_AUTOMOUNT === '1') {
        return false;
      }
      return true;
    }
    if (shouldAutoMount()) {
      try {
        mountStatusBar(window);
      } catch (err) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[agy-statusbar] mount failed:', err);
        }
      }
    }
    module.exports = {
      PLUGIN_BUS_SYMBOL,
      mountStatusBar,
    };
  },
  "./index": function(module, exports, __require) {
    const require = (spec) => __require(".", spec);
    'use strict';
    /**
     * Compatibility entry facade delegating directly to the Hexagonal Composition Root.
     */
    module.exports = require('./app/index');
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
