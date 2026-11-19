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
 * Finds the most recent generatorMetadata item with chatModel.usage.
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
    if (usage && typeof usage === 'object') {
      return {
        modelName:
          typeof item?.chatModel?.model === 'string'
            ? item.chatModel.model
            : typeof item?.chatModel?.modelName === 'string'
              ? item.chatModel.modelName
              : null,
        apiProvider: usage.apiProvider ?? item?.chatModel?.apiProvider ?? null,
        inputTokens: toNonNegativeIntOrNull(usage.inputTokens),
        cacheReadTokens: toNonNegativeIntOrNull(usage.cacheReadTokens),
        stepIndex: toNonNegativeIntOrNull(item?.stepIndex ?? item?.stepIndices?.[0]),
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
 * - Strict conversationId === requested sessionId (D-0033)
 * - F4 post-compaction guard: lastCompactedStep >= 0 && afterCompact > 0 && lastCompactedStep >= max(lastMetaStepIndex, lastStepIndex)
 *
 * @param {{
 *   requestedSessionId: string,
 *   streamFrame: any,
 *   trajectorySummary?: any,
 *   generatorMetadata?: unknown[],
 * }} input
 */
export function mapSessionTelemetry({
  requestedSessionId,
  streamFrame,
  trajectorySummary = null,
  generatorMetadata = [],
}) {
  const update = streamFrame?.update ?? streamFrame ?? {};
  const reportedId =
    typeof update.conversationId === 'string' && update.conversationId.trim()
      ? update.conversationId.trim()
      : requestedSessionId;

  const cwu = update.contextWindowUsage && typeof update.contextWindowUsage === 'object'
    ? update.contextWindowUsage
    : {};

  const compactionInfo = update.compactionInfo && typeof update.compactionInfo === 'object'
    ? update.compactionInfo
    : {};

  const estimatedUsed = toNonNegativeIntOrNull(cwu.estimatedTokensUsed);
  const afterCompact = toNonNegativeIntOrNull(cwu.estimatedAfterCompaction);
  const maxContextTokens = toNonNegativeIntOrNull(cwu.maxContextTokens);
  const lastStepIndex = toNonNegativeIntOrNull(cwu.lastStepIndex);
  const lastCompactedStep = toNonNegativeIntOrNull(
    compactionInfo.lastCompactedStepIndex ?? compactionInfo.compactedStepIndex,
  );

  const latestUsage = extractLatestUsageMetadata(generatorMetadata);
  const lastMetaStepIndex = latestUsage ? latestUsage.stepIndex : null;

  // F4: Post-compaction token guard
  const latestActivityStep = Math.max(
    lastMetaStepIndex !== null ? lastMetaStepIndex : -1,
    lastStepIndex !== null ? lastStepIndex : -1,
  );
  const useAfterCompaction =
    lastCompactedStep !== null &&
    lastCompactedStep >= 0 &&
    afterCompact !== null &&
    afterCompact > 0 &&
    lastCompactedStep >= latestActivityStep;

  let usedTokens = null;
  let usedTokensSource = 'unavailable';
  if (useAfterCompaction) {
    usedTokens = afterCompact;
    usedTokensSource = 'after_compaction';
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

  const rawGroups = Array.isArray(cwu.tokenGroups) ? cwu.tokenGroups : [];
  const tokenBreakdown = normalizeTokenGroups(
    rawGroups.map((g) => ({
      key: g?.groupType ?? g?.type ?? g?.name ?? 'other',
      label: formatTokenGroupLabel(g?.groupType ?? g?.type ?? g?.name),
      tokens: g?.estimatedTokens ?? g?.tokens ?? g?.tokenCount,
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
    stepCount: toNonNegativeIntOrNull(trajectorySummary?.stepCount) ?? (lastStepIndex !== null ? lastStepIndex + 1 : null),
    usedTokens,
    usedTokensSource,
    maxContextTokens,
    cacheHitPercent,
    cacheReadTokens: latestUsage?.cacheReadTokens ?? null,
    inputTokens: latestUsage?.inputTokens ?? null,
    lastCompactedStep,
    estimatedAfterCompaction: afterCompact,
    compactionJustCompleted: useAfterCompaction,
    tokenBreakdown,
  };
}

/**
 * Maps RetrieveUserQuotaSummary response to vendor-neutral QuotaSummary.
 *
 * @param {{ data: any, stale: boolean, fetchedAt: number }} rawResult
 */
export function mapQuotaSummary(rawResult) {
  const groupsRaw = Array.isArray(rawResult?.data?.groups) ? rawResult.data.groups : [];
  if (!rawResult?.data || groupsRaw.length === 0) {
    return {
      available: false,
      groups: [],
      stale: Boolean(rawResult?.stale),
      fetchedAt: rawResult?.fetchedAt ?? Date.now(),
    };
  }

  const groups = groupsRaw.map((group) => {
    const bucketsRaw = Array.isArray(group?.buckets) ? group.buckets : [];
    const buckets = bucketsRaw.map((b) => ({
      window: typeof b?.window === 'string' ? b.window : 'unknown',
      remainingPercent: normalizeRemainingPercent(b?.remainingFraction),
      resetTime: typeof b?.resetTime === 'string' ? b.resetTime : null,
    }));
    return {
      label: typeof group?.label === 'string' && group.label.trim() ? group.label.trim() : 'Quota',
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
      const approxMetaIndex = toNonNegativeIntOrNull(
        streamFrame?.update?.contextWindowUsage?.generatorMetadataIndex,
      );

      const generatorMetadata = await lsTransport
        .getTailGeneratorMetadata(sessionId, approxMetaIndex)
        .catch(() => []);

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
