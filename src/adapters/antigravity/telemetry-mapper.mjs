import {
  computeCacheHitPercent,
  normalizeRemainingPercent,
  normalizeTokenGroups,
  toNonNegativeIntOrNull,
} from '../../core/model/telemetry.mjs';

const TOKEN_GROUP_LABELS = Object.freeze({
  TOKEN_GROUP_SYSTEM_PROMPT: 'System Prompt',
  TOKEN_GROUP_TOOLS: 'Tools',
  TOKEN_GROUP_USER_MESSAGES: 'User Messages',
  TOKEN_GROUP_ASSISTANT_MESSAGES: 'Assistant Messages',
  TOKEN_GROUP_TOOL_RESULTS: 'Tool Results',
  TOKEN_GROUP_THOUGHTS: 'Thoughts',
  TOKEN_GROUP_FILES: 'Files / Context',
  TOKEN_GROUP_OTHER: 'Other',
});

function formatTokenGroupLabel(rawType) {
  if (typeof rawType !== 'string' || !rawType.trim()) return 'Other';
  if (TOKEN_GROUP_LABELS[rawType]) return TOKEN_GROUP_LABELS[rawType];
  return rawType
    .replace(/^TOKEN_GROUP_/, '')
    .toLowerCase()
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/**
 * Determines whether a provider's inputTokens already includes cacheReadTokens.
 * Empirically verified on Antigravity 2.33.0:
 * - API_PROVIDER_GOOGLE_GEMINI / API_PROVIDER_ANTHROPIC: uncached inputTokens separated -> false
 * - API_PROVIDER_OPENAI: prompt/inputTokens includes cached tokens -> true
 *
 * @param {unknown} apiProvider
 * @returns {boolean}
 */
export function providerInputIncludesCache(apiProvider) {
  const provider = String(apiProvider || '').toUpperCase();
  if (provider.includes('OPENAI')) {
    return true;
  }
  return false;
}

/**
 * Maps GetAllCascadeTrajectories response to sorted SessionSummary[].
 *
 * @param {unknown} resp
 */
export function mapTrajectorySummaries(resp) {
  const summariesObj =
    resp && typeof resp === 'object' && resp.trajectorySummaries && typeof resp.trajectorySummaries === 'object'
      ? resp.trajectorySummaries
      : {};

  const items = [];
  for (const [sessionId, info] of Object.entries(summariesObj)) {
    if (!info || typeof info !== 'object') continue;
    const lastModifiedTime = typeof info.lastModifiedTime === 'string' ? info.lastModifiedTime : '';
    const lastModifiedMs = lastModifiedTime ? Date.parse(lastModifiedTime) : 0;
    items.push({
      sessionId,
      title: typeof info.summary === 'string' ? info.summary : '',
      stepCount: toNonNegativeIntOrNull(info.stepCount),
      status: typeof info.status === 'string' ? info.status : 'unknown',
      lastModifiedTime,
      lastModifiedMs: Number.isFinite(lastModifiedMs) ? lastModifiedMs : 0,
    });
  }

  items.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  return items;
}

/**
 * Extracts the latest compacted step index from real Antigravity LS fields:
 * `compactedAtStepIndices` array (primary), or `lastCompactedStepIndex`/`compactedStepIndex` (fallback).
 *
 * @param {any} update
 * @returns {number | null}
 */
export function extractLastCompactedStep(update) {
  const compactionInfo = update?.compactionInfo && typeof update.compactionInfo === 'object'
    ? update.compactionInfo
    : {};

  const indices = Array.isArray(compactionInfo.compactedAtStepIndices)
    ? compactionInfo.compactedAtStepIndices
    : Array.isArray(update?.compactedAtStepIndices)
      ? update.compactedAtStepIndices
      : null;

  if (indices && indices.length > 0) {
    let maxStep = -1;
    for (const raw of indices) {
      const val = toNonNegativeIntOrNull(raw);
      if (val !== null && val > maxStep) {
        maxStep = val;
      }
    }
    if (maxStep >= 0) {
      return maxStep;
    }
  }

  return toNonNegativeIntOrNull(
    compactionInfo.lastCompactedStepIndex ?? compactionInfo.compactedStepIndex,
  );
}

/**
 * Finds the most recent generatorMetadata item with chatModel.usage and optional tokenBreakdown.
 *
 * @param {unknown[]} metadataList
 */
export function extractLatestUsageMetadata(metadataList) {
  if (!Array.isArray(metadataList) || metadataList.length === 0) {
    return null;
  }
  for (let i = metadataList.length - 1; i >= 0; i -= 1) {
    const item = metadataList[i];
    const usage = item?.chatModel?.usage;
    const chatStartBreakdown =
      item?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups;

    if ((usage && typeof usage === 'object') || Array.isArray(chatStartBreakdown)) {
      return {
        modelName:
          typeof item?.chatModel?.model === 'string'
            ? item.chatModel.model
            : typeof item?.chatModel?.modelName === 'string'
              ? item.chatModel.modelName
              : null,
        apiProvider: usage?.apiProvider ?? item?.chatModel?.apiProvider ?? null,
        inputTokens: toNonNegativeIntOrNull(usage?.inputTokens),
        cacheReadTokens: toNonNegativeIntOrNull(usage?.cacheReadTokens),
        stepIndex: toNonNegativeIntOrNull(item?.stepIndex ?? item?.stepIndices?.[0]),
        tokenBreakdownGroups: Array.isArray(chatStartBreakdown) ? chatStartBreakdown : null,
      };
    }
  }
  return null;
}

/**
 * Maps StreamAgentStateUpdates 1st frame + tail metadata + trajectory summary
 * into a vendor-neutral ContextTelemetry DTO.
 *
 * Enforces:
 * - F1 / D-0033 Fail-Closed: NEVER falls back to requestedSessionId when update.conversationId is missing.
 * - F1 real LS schema: compactedAtStepIndices[], boolean|number estimatedAfterCompaction,
 *   chatStartMetadata.contextWindowMetadata.tokenBreakdown.groups[].numTokens.
 * - F4 post-compaction guard.
 *
 * @param {{
 *   requestedSessionId: string,
 *   streamFrame: any,
 *   trajectorySummary?: any,
 *   generatorMetadata?: unknown[],
 * }} input
 */
export function mapSessionTelemetry({
  requestedSessionId: _requestedSessionId,
  streamFrame,
  trajectorySummary = null,
  generatorMetadata = [],
}) {
  const update = streamFrame?.update ?? streamFrame ?? {};

  // F1 / D-0033 Fail-Closed: Missing conversationId must NOT fall back to requestedSessionId.
  const reportedId =
    typeof update.conversationId === 'string' && update.conversationId.trim()
      ? update.conversationId.trim()
      : '';

  const cwu = update.contextWindowUsage && typeof update.contextWindowUsage === 'object'
    ? update.contextWindowUsage
    : {};

  const estimatedUsed = toNonNegativeIntOrNull(cwu.estimatedTokensUsed);
  const rawAfterCompact = cwu.estimatedAfterCompaction;
  const afterCompactBool = typeof rawAfterCompact === 'boolean' ? rawAfterCompact : null;
  const afterCompactTokens =
    afterCompactBool === null ? toNonNegativeIntOrNull(rawAfterCompact) : null;

  const maxContextTokens = toNonNegativeIntOrNull(cwu.maxContextTokens);
  const lastStepIndex = toNonNegativeIntOrNull(cwu.lastStepIndex);
  const lastCompactedStep = extractLastCompactedStep(update);

  const latestUsage = extractLatestUsageMetadata(generatorMetadata);
  const lastMetaStepIndex = latestUsage ? latestUsage.stepIndex : null;

  const latestActivityStep = Math.max(
    lastMetaStepIndex !== null ? lastMetaStepIndex : -1,
    lastStepIndex !== null ? lastStepIndex : -1,
  );

  // F1 & F4: Support both real boolean estimatedAfterCompaction and numeric estimatedAfterCompaction
  let usedTokens = null;
  let usedTokensSource = 'unavailable';
  let compactionJustCompleted = false;

  if (afterCompactBool === true && estimatedUsed !== null) {
    usedTokens = estimatedUsed;
    usedTokensSource = 'after_compaction';
    compactionJustCompleted = lastCompactedStep !== null && lastCompactedStep >= 0;
  } else if (
    lastCompactedStep !== null &&
    lastCompactedStep >= 0 &&
    afterCompactTokens !== null &&
    afterCompactTokens > 0 &&
    lastCompactedStep >= latestActivityStep
  ) {
    usedTokens = afterCompactTokens;
    usedTokensSource = 'after_compaction';
    compactionJustCompleted = true;
  } else if (estimatedUsed !== null) {
    usedTokens = estimatedUsed;
    usedTokensSource = 'estimated';
  }

  const cacheHitPercent = latestUsage
    ? computeCacheHitPercent({
        cacheReadTokens: latestUsage.cacheReadTokens,
        inputTokens: latestUsage.inputTokens,
        inputIncludesCache: providerInputIncludesCache(latestUsage.apiProvider),
      })
    : null;

  // F1: Prefer real chatStartMetadata.contextWindowMetadata.tokenBreakdown.groups[].numTokens,
  // with fallback to contextWindowUsage.tokenGroups
  const rawGroups =
    Array.isArray(latestUsage?.tokenBreakdownGroups) && latestUsage.tokenBreakdownGroups.length > 0
      ? latestUsage.tokenBreakdownGroups
      : Array.isArray(cwu.tokenGroups)
        ? cwu.tokenGroups
        : [];

  const tokenBreakdown = normalizeTokenGroups(
    rawGroups.map((g) => ({
      key: g?.groupType ?? g?.type ?? g?.name ?? g?.category ?? 'other',
      label: formatTokenGroupLabel(g?.displayName ?? g?.groupType ?? g?.type ?? g?.name ?? g?.category),
      tokens: g?.numTokens ?? g?.estimatedTokens ?? g?.tokens ?? g?.tokenCount,
    })),
  );

  const status = typeof update.status === 'string'
    ? update.status
    : typeof trajectorySummary?.status === 'string'
      ? trajectorySummary.status
      : 'unknown';

  return {
    sessionId: reportedId,
    title: typeof trajectorySummary?.summary === 'string' ? trajectorySummary.summary : '',
    status,
    modelName: latestUsage?.modelName ?? null,
    stepCount:
      toNonNegativeIntOrNull(trajectorySummary?.stepCount) ??
      (lastStepIndex !== null ? lastStepIndex + 1 : null),
    usedTokens,
    usedTokensSource,
    maxContextTokens,
    cacheHitPercent,
    cacheReadTokens: latestUsage?.cacheReadTokens ?? null,
    inputTokens: latestUsage?.inputTokens ?? null,
    lastCompactedStep,
    estimatedAfterCompaction: afterCompactBool !== null ? afterCompactBool : afterCompactTokens,
    compactionJustCompleted,
    tokenBreakdown,
  };
}

/**
 * Maps RetrieveUserQuotaSummary response to vendor-neutral QuotaSummary.
 * F1: Supports real `data.response.groups`, `displayName`, and `remaining.case === 'remainingFraction'`.
 *
 * @param {{ data: any, stale: boolean, fetchedAt: number }} rawResult
 */
export function mapQuotaSummary(rawResult) {
  const container = rawResult?.data?.response ?? rawResult?.data ?? null;
  const groupsRaw = Array.isArray(container?.groups) ? container.groups : [];
  if (!container || groupsRaw.length === 0) {
    return {
      available: false,
      groups: [],
      stale: Boolean(rawResult?.stale),
      fetchedAt: rawResult?.fetchedAt ?? Date.now(),
    };
  }

  const groups = groupsRaw.map((group) => {
    const bucketsRaw = Array.isArray(group?.buckets) ? group.buckets : [];
    const buckets = bucketsRaw.map((b) => {
      const remainingFraction =
        b?.remaining && b.remaining.case === 'remainingFraction'
          ? b.remaining.value
          : b?.remainingFraction;
      return {
        window:
          typeof b?.window === 'string' && b.window.trim()
            ? b.window.trim()
            : typeof b?.windowLabel === 'string' && b.windowLabel.trim()
              ? b.windowLabel.trim()
              : 'unknown',
        remainingPercent: normalizeRemainingPercent(remainingFraction),
        resetTime: typeof b?.resetTime === 'string' ? b.resetTime : null,
      };
    });
    const label =
      (typeof group?.displayName === 'string' && group.displayName.trim()) ||
      (typeof group?.label === 'string' && group.label.trim()) ||
      (typeof group?.name === 'string' && group.name.trim()) ||
      'Quota';
    return {
      label,
      buckets,
    };
  });

  return {
    available: true,
    groups,
    stale: Boolean(rawResult.stale),
    fetchedAt: rawResult.fetchedAt,
  };
}

/**
 * Creates the Antigravity TelemetryPort implementation backed by lsTransport.
 *
 * @param {ReturnType<import('./ls-transport.mjs').createLsTransport>} lsTransport
 */
export function createAntigravityTelemetryAdapter(lsTransport) {
  return {
    async listSessions() {
      const resp = await lsTransport.callUnaryRpc('GetAllCascadeTrajectories', {});
      return mapTrajectorySummaries(resp);
    },

    async getSessionTelemetry(sessionId) {
      const [streamFrame, trajectoriesResp] = await Promise.all([
        lsTransport.readFirstStreamFrame('StreamAgentStateUpdates', {
          conversationId: sessionId,
        }),
        lsTransport.callUnaryRpc('GetAllCascadeTrajectories', {}).catch(() => null),
      ]);

      const trajectorySummary = trajectoriesResp?.trajectorySummaries?.[sessionId] ?? null;

      // F1: Read real trajectorySlice.totalGeneratorMetadataLength first to avoid offset=0 4MB overflow
      const totalMetaLen = toNonNegativeIntOrNull(
        streamFrame?.update?.trajectorySlice?.totalGeneratorMetadataLength ??
          streamFrame?.update?.contextWindowUsage?.generatorMetadataIndex ??
          trajectorySummary?.generatorMetadataLength,
      );

      let generatorMetadata = [];
      if (totalMetaLen !== null && totalMetaLen > 0) {
        generatorMetadata = await lsTransport
          .getTailGeneratorMetadata(sessionId, totalMetaLen)
          .catch(() => []);
      }

      return mapSessionTelemetry({
        requestedSessionId: sessionId,
        streamFrame,
        trajectorySummary,
        generatorMetadata,
      });
    },

    async getQuotaSummary() {
      const raw = await lsTransport.getQuotaSummaryRaw();
      return mapQuotaSummary(raw);
    },
  };
}
