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
 * Normalizes a string ISO timestamp or protobuf Timestamp `{ seconds, nanos }` into an ISO-8601 string (F4).
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeResetTime(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'seconds')) {
    const secs = Number(raw.seconds);
    const nanos = Number(raw.nanos ?? 0);
    if (Number.isFinite(secs) && secs >= 0) {
      const ms = secs * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) {
        return d.toISOString();
      }
    }
  }
  return null;
}

/**
 * Unwraps a generatorMetadata item's chatModel payload, supporting both direct `item.chatModel`
 * and protobuf-es oneof `{ metadata: { case: 'chatModel', value } }` (F4).
 *
 * @param {any} item
 */
function unwrapChatModel(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.chatModel && typeof item.chatModel === 'object') {
    return item.chatModel;
  }
  if (
    item.metadata &&
    typeof item.metadata === 'object' &&
    item.metadata.case === 'chatModel' &&
    item.metadata.value &&
    typeof item.metadata.value === 'object'
  ) {
    return item.metadata.value;
  }
  return null;
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
    const lastModifiedTime = normalizeResetTime(info.lastModifiedTime) || '';
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
 * Finds the most recent generatorMetadata item with chatModel info (usage, model, or tokenBreakdown).
 * Supports oneof `{ metadata: { case: 'chatModel', value } }`, `startStepIndex`, `modelDisplayName`,
 * and `chatStartMetadata.contextWindowMetadata.tokenBreakdown.groups` (F4).
 *
 * @param {unknown[]} metadataList
 */
export function extractLatestUsageMetadata(metadataList) {
  if (!Array.isArray(metadataList) || metadataList.length === 0) {
    return null;
  }

  let bestUsage = null;
  let bestModel = null;
  let bestBreakdown = null;
  let bestStepIndex = null;

  for (let i = metadataList.length - 1; i >= 0; i -= 1) {
    const item = metadataList[i];
    const chatModel = unwrapChatModel(item);
    if (!chatModel) continue;

    const stepIdx = toNonNegativeIntOrNull(
      item?.stepIndex ?? item?.startStepIndex ?? item?.stepIndices?.[0],
    );
    if (bestStepIndex === null && stepIdx !== null) {
      bestStepIndex = stepIdx;
    }

    if (bestModel === null) {
      const candidateModel =
        (typeof chatModel.modelDisplayName === 'string' && chatModel.modelDisplayName.trim()) ||
        (typeof chatModel.model === 'string' && chatModel.model.trim()) ||
        (typeof chatModel.modelName === 'string' && chatModel.modelName.trim()) ||
        null;
      if (candidateModel) {
        bestModel = candidateModel;
      }
    }

    if (bestBreakdown === null) {
      const groups = chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups;
      if (Array.isArray(groups) && groups.length > 0) {
        bestBreakdown = groups;
      }
    }

    if (bestUsage === null && chatModel.usage && typeof chatModel.usage === 'object') {
      bestUsage = {
        apiProvider: chatModel.usage.apiProvider ?? chatModel.apiProvider ?? null,
        inputTokens: toNonNegativeIntOrNull(chatModel.usage.inputTokens),
        cacheReadTokens: toNonNegativeIntOrNull(chatModel.usage.cacheReadTokens),
      };
    }

    if (bestUsage && bestModel && bestBreakdown) {
      break;
    }
  }

  if (!bestUsage && !bestModel && !bestBreakdown) {
    return null;
  }

  return {
    modelName: bestModel,
    apiProvider: bestUsage?.apiProvider ?? null,
    inputTokens: bestUsage?.inputTokens ?? null,
    cacheReadTokens: bestUsage?.cacheReadTokens ?? null,
    stepIndex: bestStepIndex,
    tokenBreakdownGroups: bestBreakdown,
  };
}

/**
 * Maps StreamAgentStateUpdates 1st frame + tail metadata + trajectory summary
 * into a vendor-neutral ContextTelemetry DTO.
 *
 * Enforces:
 * - F1 / D-0033 Fail-Closed: NEVER falls back to requestedSessionId when update.conversationId is missing.
 * - F1 repeated-compact guard: requires lastCompactedStep >= latestActivityStep in BOTH boolean and numeric branches.
 * - F4 real LS schema: compactedAtStepIndices[], oneof chatModel, startStepIndex, modelDisplayName,
 *   tokenBreakdown.groups[].source & numTokens.
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

  // F1: Require lastCompactedStep >= latestActivityStep in BOTH boolean and numeric branches
  const compactionIsCurrent =
    lastCompactedStep !== null &&
    lastCompactedStep >= 0 &&
    lastCompactedStep >= latestActivityStep;

  let usedTokens = null;
  let usedTokensSource = 'unavailable';
  let compactionJustCompleted = false;

  if (afterCompactBool === true && estimatedUsed !== null) {
    usedTokens = estimatedUsed;
    usedTokensSource = compactionIsCurrent ? 'after_compaction' : 'estimated';
    compactionJustCompleted = compactionIsCurrent;
  } else if (compactionIsCurrent && afterCompactTokens !== null && afterCompactTokens > 0) {
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

  const rawGroups =
    Array.isArray(latestUsage?.tokenBreakdownGroups) && latestUsage.tokenBreakdownGroups.length > 0
      ? latestUsage.tokenBreakdownGroups
      : Array.isArray(cwu.tokenGroups)
        ? cwu.tokenGroups
        : [];

  const tokenBreakdown = normalizeTokenGroups(
    rawGroups.map((g) => ({
      key: g?.source ?? g?.groupType ?? g?.type ?? g?.name ?? g?.category ?? 'other',
      label: formatTokenGroupLabel(
        g?.displayName ?? g?.source ?? g?.groupType ?? g?.type ?? g?.name ?? g?.category,
      ),
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
 * F4: Supports `data.response.groups`, `displayName`, `remaining.case === 'remainingFraction'`,
 * and protobuf Timestamp `{ seconds, nanos }` resetTime.
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
        resetTime: normalizeResetTime(b?.resetTime),
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

      // F4: Read trajectorySlice.totalGeneratorMetadataLength first; fall back to bounded tail probe if absent
      const totalMetaLen = toNonNegativeIntOrNull(
        streamFrame?.update?.trajectorySlice?.totalGeneratorMetadataLength ??
          streamFrame?.update?.contextWindowUsage?.generatorMetadataIndex ??
          trajectorySummary?.generatorMetadataLength,
      );

      const generatorMetadata = await lsTransport
        .getTailGeneratorMetadata(sessionId, totalMetaLen)
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
