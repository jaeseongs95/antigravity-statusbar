import { DomainError, ERROR_CODES, normalizeLocale } from '../i18n/error-codes.mjs';
import {
  MAX_BUTTON_COMMAND_LEN,
  MAX_SESSION_OVERRIDES,
  PRESET_LIMITS,
  evaluateContextThreshold,
  resolveEffectiveLimit,
  validateCustomButtons,
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

  /** @type {Map<string, { attemptToken: string, startedAt: number, acceptedAt: number | null, method: string | null, baselineCompactedStep: number | null, status: 'pending' | 'accepted' }>} */
  const compactingSessions = new Map();
  let attemptSeq = 0;

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

    // Detect post-acceptance compaction completion (F1 & F5):
    // Require strict step progression past baselineCompactedStep so repeated /compact calls
    // cannot prematurely clear the mutex or return false 'completed' on the first poll.
    if (entry.status === 'accepted' && telemetry) {
      const currentCompactedStep =
        typeof telemetry.lastCompactedStep === 'number' ? telemetry.lastCompactedStep : null;
      const stepAdvanced =
        currentCompactedStep !== null &&
        (entry.baselineCompactedStep === null
          ? currentCompactedStep >= 0 && telemetry.compactionJustCompleted === true
          : currentCompactedStep > entry.baselineCompactedStep);

      if (stepAdvanced) {
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
        customButtons: Array.isArray(settings.customButtons) ? settings.customButtons : [],
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
        customButtons: Array.isArray(settings.customButtons) ? settings.customButtons : [],
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

      if (Object.prototype.hasOwnProperty.call(patch, 'customButtons')) {
        normalizedPatch.customButtons = validateCustomButtons(patch.customButtons);
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
        customButtons: Array.isArray(updated.customButtons) ? updated.customButtons : [],
        sessions: Array.from(updated.sessions.entries()).map(([id, entry]) => ({
          sessionId: id,
          limit: entry.limit,
          updatedAt: entry.updatedAt,
        })),
        presets: PRESET_LIMITS,
      };
    },

    async runCustomCommand(rawSessionId, rawCommand) {
      const sessionId = validateSessionId(rawSessionId);
      const command = typeof rawCommand === 'string' ? rawCommand.trim() : '';
      if (!command || command.length > MAX_BUTTON_COMMAND_LEN || command.includes('\0')) {
        throw new DomainError(
          ERROR_CODES.INVALID_SETTINGS_PATCH,
          400,
          `Command must be 1-${MAX_BUTTON_COMMAND_LEN} characters.`,
        );
      }
      if (command === '/compact') {
        return this.requestCompaction(sessionId);
      }
      if (typeof compactionPort.sendCommand !== 'function') {
        throw new DomainError(
          ERROR_CODES.COMPACTION_FAILED,
          501,
          'Custom command execution is not supported by the active adapter.',
        );
      }
      const result = await compactionPort.sendCommand(sessionId, command);
      if (!result || result.accepted !== true) {
        throw new DomainError(
          ERROR_CODES.COMPACTION_FAILED,
          502,
          result?.reason || 'Custom command was not accepted.',
        );
      }
      return {
        accepted: true,
        sessionId,
        command,
        method: result.method ?? 'unknown',
        acceptedAt: clock(),
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

      // F2: Synchronously register pending mutex with unique attemptToken BEFORE any await
      // to eliminate async TOCTOU race and cross-attempt deletion.
      const attemptToken = `${now}-${++attemptSeq}`;
      compactingSessions.set(sessionId, {
        attemptToken,
        startedAt: now,
        acceptedAt: null,
        method: null,
        baselineCompactedStep: null,
        status: 'pending',
      });

      const releaseOwnMutex = () => {
        if (compactingSessions.get(sessionId)?.attemptToken === attemptToken) {
          compactingSessions.delete(sessionId);
        }
      };

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

      try {
        const result = await compactionPort.compactSession(sessionId);
        if (!result || result.accepted !== true) {
          // F2 & F5: Release ONLY this attempt's mutex immediately on failure
          releaseOwnMutex();
          throw new DomainError(
            ERROR_CODES.COMPACTION_FAILED,
            502,
            result?.reason || 'Compaction request was not accepted.',
          );
        }

        const acceptedAt = clock();
        if (compactingSessions.get(sessionId)?.attemptToken === attemptToken) {
          compactingSessions.set(sessionId, {
            attemptToken,
            startedAt: now,
            acceptedAt,
            method: result.method ?? 'unknown',
            baselineCompactedStep,
            status: 'accepted',
          });
        }

        return {
          accepted: true,
          sessionId,
          method: result.method ?? 'unknown',
          acceptedAt,
        };
      } catch (err) {
        // F2 & F5: Always release ONLY this attempt's mutex if compaction failed/threw
        releaseOwnMutex();
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
