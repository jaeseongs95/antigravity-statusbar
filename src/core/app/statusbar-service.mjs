import { DomainError, ERROR_CODES, normalizeLocale } from '../i18n/error-codes.mjs';
import {
  MAX_SESSION_OVERRIDES,
  PRESET_LIMITS,
  evaluateContextThreshold,
  resolveEffectiveLimit,
  validateCustomLimit,
  validateSessionId,
} from '../model/context-policy.mjs';
import {
  assertCompactionPort,
  assertSettingsPort,
  assertTelemetryPort,
} from '../ports/contracts.mjs';

const DEFAULT_COMPACT_COOLDOWN_MS = 15_000;

/**
 * Core application service orchestrating session telemetry, quota, settings,
 * per-session soft limits, and compaction mutexes.
 *
 * Strictly vendor-neutral: communicates only through injected ports.
 */
export function createStatusbarService({
  telemetryPort,
  compactionPort,
  settingsPort,
  clock = () => Date.now(),
  compactCooldownMs = DEFAULT_COMPACT_COOLDOWN_MS,
}) {
  assertTelemetryPort(telemetryPort);
  assertCompactionPort(compactionPort);
  assertSettingsPort(settingsPort);

  /** @type {Map<string, { startedAt: number, acceptedAt: number | null, method: string | null, baselineCompactedStep: number | null, status: 'pending' | 'accepted' }>} */
  const compactingSessions = new Map();

  function pruneCompactingSessions(now) {
    for (const [sid, entry] of compactingSessions.entries()) {
      if (entry.status === 'accepted' && now - entry.startedAt >= compactCooldownMs) {
        compactingSessions.delete(sid);
      }
    }
    while (compactingSessions.size > MAX_SESSION_OVERRIDES) {
      const oldestKey = compactingSessions.keys().next().value;
      if (oldestKey === undefined) break;
      compactingSessions.delete(oldestKey);
    }
  }

  function getCompactionState(sessionId, telemetry, now) {
    pruneCompactingSessions(now);
    const entry = compactingSessions.get(sessionId);
    if (!entry) {
      return {
        inProgress: false,
        status: 'idle',
        startedAt: null,
        method: null,
      };
    }

    // Detect post-acceptance compaction completion (F5):
    // If telemetry reports compaction finished or lastCompactedStep advanced past baseline,
    // clear the session mutex immediately so subsequent compacts are not blocked.
    if (entry.status === 'accepted' && telemetry) {
      const currentCompactedStep =
        typeof telemetry.lastCompactedStep === 'number' ? telemetry.lastCompactedStep : null;
      const stepAdvanced =
        currentCompactedStep !== null &&
        (entry.baselineCompactedStep === null
          ? currentCompactedStep >= 0
          : currentCompactedStep > entry.baselineCompactedStep);

      if (telemetry.compactionJustCompleted === true || stepAdvanced) {
        compactingSessions.delete(sessionId);
        return {
          inProgress: false,
          status: 'completed',
          startedAt: entry.startedAt,
          method: entry.method,
        };
      }
    }

    return {
      inProgress: true,
      status: entry.status,
      startedAt: entry.startedAt,
      method: entry.method,
    };
  }

  return {
    async listSessions() {
      const sessions = await telemetryPort.listSessions();
      return {
        sessions: Array.isArray(sessions) ? sessions : [],
        fetchedAt: clock(),
      };
    },

    async getSessionSnapshot(rawSessionId) {
      const sessionId = validateSessionId(rawSessionId);
      const [telemetry, settings] = await Promise.all([
        telemetryPort.getSessionTelemetry(sessionId),
        settingsPort.read(),
      ]);

      if (!telemetry) {
        throw new DomainError(ERROR_CODES.SESSION_NOT_FOUND, 404, `Session not found: ${sessionId}`);
      }

      // Strict cross-session isolation guard (D-0033)
      if (telemetry.sessionId !== sessionId) {
        throw new DomainError(
          ERROR_CODES.SESSION_MISMATCH,
          409,
          'Telemetry response sessionId does not match requested session.',
          { requested: sessionId, received: telemetry.sessionId },
        );
      }

      const sessionOverrideEntry = settings.sessions.get(sessionId) ?? null;
      const limitInfo = resolveEffectiveLimit({
        hostMaxTokens: telemetry.maxContextTokens,
        sessionCustomLimit: sessionOverrideEntry ? sessionOverrideEntry.limit : null,
        defaultCustomLimit: settings.defaultCustomLimit,
      });

      const threshold = evaluateContextThreshold({
        usedTokens: telemetry.usedTokens,
        effectiveLimit: limitInfo.effectiveLimit,
      });

      const now = clock();
      const compaction = getCompactionState(sessionId, telemetry, now);

      return {
        sessionId,
        title: telemetry.title ?? '',
        status: telemetry.status ?? 'unknown',
        modelName: telemetry.modelName ?? null,
        stepCount: telemetry.stepCount ?? null,
        usedTokens: telemetry.usedTokens ?? null,
        usedTokensSource: telemetry.usedTokensSource ?? 'unavailable',
        maxContextTokens: limitInfo.hostMaxTokens,
        effectiveLimit: limitInfo.effectiveLimit,
        customLimit: limitInfo.customLimit,
        limitSource: limitInfo.source,
        isCustomLimitActive: limitInfo.isCustomActive,
        isClampedByHost: limitInfo.isClampedByHost,
        usagePercent: threshold.usagePercent,
        thresholdLevel: threshold.thresholdLevel,
        exceededSoftLimit: threshold.exceededSoftLimit,
        cacheHitPercent: telemetry.cacheHitPercent ?? null,
        cacheReadTokens: telemetry.cacheReadTokens ?? null,
        inputTokens: telemetry.inputTokens ?? null,
        lastCompactedStep: telemetry.lastCompactedStep ?? null,
        estimatedAfterCompaction: telemetry.estimatedAfterCompaction ?? null,
        tokenBreakdown: Array.isArray(telemetry.tokenBreakdown) ? telemetry.tokenBreakdown : [],
        compaction,
        locale: settings.locale,
        presets: PRESET_LIMITS,
        fetchedAt: now,
      };
    },

    async getQuotaSummary() {
      const quota = await telemetryPort.getQuotaSummary();
      return {
        available: Boolean(quota && quota.available),
        groups: Array.isArray(quota?.groups) ? quota.groups : [],
        stale: Boolean(quota?.stale),
        fetchedAt: quota?.fetchedAt ?? clock(),
      };
    },

    async getSettings() {
      const settings = await settingsPort.read();
      return {
        locale: settings.locale,
        defaultCustomLimit: settings.defaultCustomLimit,
        sessions: Array.from(settings.sessions.entries()).map(([id, entry]) => ({
          sessionId: id,
          limit: entry.limit,
          updatedAt: entry.updatedAt,
        })),
        presets: PRESET_LIMITS,
      };
    },

    async updateSettings(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new DomainError(
          ERROR_CODES.INVALID_SETTINGS_PATCH,
          400,
          'Settings update payload must be an object.',
        );
      }

      const normalizedPatch = {};
      let hasChange = false;

      if (Object.prototype.hasOwnProperty.call(patch, 'locale')) {
        normalizedPatch.locale = normalizeLocale(patch.locale);
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'defaultCustomLimit')) {
        normalizedPatch.defaultCustomLimit = validateCustomLimit(patch.defaultCustomLimit);
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'sessionLimit')) {
        const sl = patch.sessionLimit;
        if (!sl || typeof sl !== 'object' || Array.isArray(sl)) {
          throw new DomainError(
            ERROR_CODES.INVALID_SETTINGS_PATCH,
            400,
            'sessionLimit must be an object with sessionId and limit.',
          );
        }
        normalizedPatch.sessionLimit = {
          sessionId: validateSessionId(sl.sessionId),
          limit: validateCustomLimit(sl.limit),
        };
        hasChange = true;
      }

      if (!hasChange) {
        throw new DomainError(
          ERROR_CODES.INVALID_SETTINGS_PATCH,
          400,
          'No recognized settings fields provided.',
        );
      }

      const updated = await settingsPort.update(normalizedPatch);
      return {
        locale: updated.locale,
        defaultCustomLimit: updated.defaultCustomLimit,
        sessions: Array.from(updated.sessions.entries()).map(([id, entry]) => ({
          sessionId: id,
          limit: entry.limit,
          updatedAt: entry.updatedAt,
        })),
        presets: PRESET_LIMITS,
      };
    },

    async requestCompaction(rawSessionId) {
      const sessionId = validateSessionId(rawSessionId);
      const now = clock();
      pruneCompactingSessions(now);

      const existing = compactingSessions.get(sessionId);
      if (existing) {
        throw new DomainError(
          ERROR_CODES.COMPACTION_IN_PROGRESS,
          409,
          'Compaction is already in progress for this session.',
          { sessionId, status: existing.status },
        );
      }

      let baselineCompactedStep = null;
      try {
        const currentTelemetry = await telemetryPort.getSessionTelemetry(sessionId);
        if (currentTelemetry && currentTelemetry.sessionId === sessionId) {
          baselineCompactedStep =
            typeof currentTelemetry.lastCompactedStep === 'number'
              ? currentTelemetry.lastCompactedStep
              : null;
        }
      } catch {
        // Non-fatal: proceed without baseline step
      }

      compactingSessions.set(sessionId, {
        startedAt: now,
        acceptedAt: null,
        method: null,
        baselineCompactedStep,
        status: 'pending',
      });

      try {
        const result = await compactionPort.compactSession(sessionId);
        if (!result || result.accepted !== true) {
          // F5: Release mutex immediately on failure so user is not locked out with 409
          compactingSessions.delete(sessionId);
          throw new DomainError(
            ERROR_CODES.COMPACTION_FAILED,
            502,
            result?.reason || 'Compaction request was not accepted.',
          );
        }

        const acceptedAt = clock();
        compactingSessions.set(sessionId, {
          startedAt: now,
          acceptedAt,
          method: result.method ?? 'unknown',
          baselineCompactedStep,
          status: 'accepted',
        });

        return {
          accepted: true,
          sessionId,
          method: result.method ?? 'unknown',
          acceptedAt,
        };
      } catch (err) {
        // F5: Always release mutex if compaction failed/threw
        compactingSessions.delete(sessionId);
        if (err instanceof DomainError) {
          throw err;
        }
        throw new DomainError(
          ERROR_CODES.COMPACTION_FAILED,
          502,
          err?.message || 'Compaction request failed.',
        );
      }
    },
  };
}
