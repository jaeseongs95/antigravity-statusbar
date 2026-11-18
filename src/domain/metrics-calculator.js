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
