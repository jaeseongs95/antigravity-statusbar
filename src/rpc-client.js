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
  let used = 0, max = 256000, cacheRead = 0, inputTok = 0;
  let foundCtx = false, foundUsage = false;
  for (let i = metas.length - 1; i >= 0; i--) {
    const cm = getChatModelFromMeta(metas[i]);
    if (!cm) continue;
    if (!foundCtx && cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata) {
      const cwm = cm.chatStartMetadata.contextWindowMetadata;
      if (cwm.estimatedTokensUsed) {
        used = Number(cwm.estimatedTokensUsed);
        max = Number(cwm.maxContextTokens || 256000);
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

function createRpcClient({ fetchFn, localStorage, getAgentStateProviderForInputBox, getRemoteRpcServiceForElement }) {
  const stateCache = new Map();
  const inFlightStats = new Map();
  const knownGenLenMap = new Map();
  let inFlightQuota = null;
  let quotaData = null;
  let lastQuotaFetch = 0;

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
        if (csrf && typeof fetchFn === 'function') {
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

    let cur = Math.ceil(sc * 0.52);
    while (cur > 0) {
      const metas = await callGenMeta(cur);
      if (metas.length > 0) {
        const nextLen = cur + metas.length;
        knownGenLenMap.set(cascadeId, nextLen);
        return { metas, knownGenLen: nextLen };
      }
      cur = Math.max(0, cur - 35);
    }

    const metas0 = await callGenMeta(0);
    if (metas0.length > 0) {
      knownGenLenMap.set(cascadeId, metas0.length);
    }
    return { metas: metas0, knownGenLen: metas0.length };
  }

  function fetchCascadeStats(cascadeId, csrf, inputBox) {
    if (!cascadeId || cascadeId === 'remote-session') {
      return Promise.resolve(null);
    }
    const asp = getAgentStateProviderForInputBox ? getAgentStateProviderForInputBox(inputBox) : null;
    const slice = asp?.getState?.()?.trajectorySlice;
    const totalGenLen = slice?.totalGeneratorMetadataLength ?? -1;
    const totalStepsLen = slice?.totalStepsLength ?? -1;
    const cached = stateCache.get(cascadeId);
    const knownGenLen = totalGenLen > 0 ? totalGenLen : (knownGenLenMap.get(cascadeId) || cached?.knownGenLen || -1);
    const versionKey = `${totalGenLen}:${totalStepsLen}`;

    if (cached && cached.versionKey === versionKey && (totalGenLen >= 0 || totalStepsLen >= 0) && (Date.now() - cached.ts < 30000)) {
      return Promise.resolve(cached);
    }

    if (inFlightStats.has(cascadeId)) {
      return inFlightStats.get(cascadeId);
    }

    const promise = (async () => {
      try {
        let parsed = null;
        let discoveredGenLen = knownGenLen;

        if (csrf && typeof fetchFn === 'function') {
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

        if (!parsed || (!parsed.foundCtx && !parsed.foundUsage && discoveredGenLen <= 0)) {
          return cached || null;
        }

        if (discoveredGenLen > 0 && typeof window !== 'undefined') {
          window.__agyRcGenLenByCascade = window.__agyRcGenLenByCascade || {};
          window.__agyRcGenLenByCascade[cascadeId] = discoveredGenLen;
        }

        const finalVersionKey = `${totalGenLen}:${totalStepsLen}`;
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
