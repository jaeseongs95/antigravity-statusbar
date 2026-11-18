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
