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
        let parsed = null;
        if (csrf && typeof fetchFn === 'function') {
          try {
            const tailOffset = totalGenLen > 3 ? totalGenLen - 3 : 0;
            const r = await fetchFn('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
              body: JSON.stringify({ cascadeId, generatorMetadataOffset: tailOffset }),
            });
            if (r && r.ok !== false) {
              const j = await r.json();
              const metas = j.generatorMetadata || [];
              parsed = extractStatsFromMetas(metas);

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
            }
          } catch {}
        }

        if ((!parsed || (!parsed.foundCtx && !parsed.foundUsage)) && typeof getRemoteRpcServiceForElement === 'function') {
          const svc = getRemoteRpcServiceForElement(inputBox);
          if (svc && typeof svc.getCascadeTrajectory === 'function') {
            const t = await svc.getCascadeTrajectory({ cascadeId });
            const metas = t?.trajectory?.generatorMetadata || [];
            parsed = extractStatsFromMetas(metas);
          }
        }

        if (!parsed) {
          return cached || null;
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
  getChatModelFromMeta,
  extractStatsFromMetas,
  createRpcClient,
};
