import { DomainError, ERROR_CODES, normalizeLocale } from '../i18n/error-codes.mjs';
import {
  MAX_BUTTON_COMMAND_LEN,
  MAX_SESSION_OVERRIDES,
  PRESET_LIMITS,
  evaluateContextThreshold,
  resolveEffectiveLimit,
  resolveModelCustomLimit,
  validateAddonDescriptor,
  validateAddonId,
  validateCompactPrompt,
  validateCustomButtons,
  validateCustomLimit,
  validateDisabledAddonIds,
  validateModelName,
  validateSessionId,
} from '../model/context-policy.mjs';
import {
  assertCompactionPort,
  assertSettingsPort,
  assertTelemetryPort,
} from '../ports/contracts.mjs';

const DEFAULT_COMPACT_COOLDOWN_MS = 15_000;
const HOST_COMPACT_MAX_LOCK_MS = 300_000;
const AUTO_COMPACT_COOLDOWN_MS = 90_000;
const AUTO_COMPACT_RUNNING_RETRY_MS = 10_000;
const AUTO_COMPACT_RETRIGGER_TOKEN_DELTA = 20_000;
const MAX_BACKGROUND_SWEEP_SESSIONS = 5;
const BACKGROUND_RECENT_WINDOW_MS = 60_000;

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

  /** @type {Map<string, { attemptToken: string, startedAt: number, acceptedAt: number | null, method: string | null, trigger: 'manual' | 'auto', baselineCompactedStep: number | null, baselineUsedTokens: number | null, status: 'pending' | 'accepted' }>} */
  const compactingSessions = new Map();
  /** @type {Map<string, { cooldownUntil: number, waitingForDrop: boolean, lastTriggeredTokens: number | null, lastTriggeredStep: number | null, lastTriggeredCompactedStep: number | null, failedWhileRunning: boolean }>} */
  const autoCompactState = new Map();
  /** @type {Map<string, { code: string, message: string, at: number }>} */
  const lastAutoCompactErrors = new Map();
  let attemptSeq = 0;

  function formatModelLimits(modelLimitsMap) {
    if (!(modelLimitsMap instanceof Map)) return [];
    return Array.from(modelLimitsMap.entries()).map(([model, entry]) => ({
      model,
      limit: entry.limit,
      updatedAt: entry.updatedAt,
    }));
  }

  function pruneCompactingSessions(now, activeHostCompactingSessionId = null) {
    for (const [sid, entry] of compactingSessions.entries()) {
      const ttl =
        sid === activeHostCompactingSessionId ? HOST_COMPACT_MAX_LOCK_MS : compactCooldownMs;
      if (entry.status === 'accepted' && now - entry.startedAt >= ttl) {
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
    const hostRunning = telemetry?.hostCompactionInProgress === true;
    const preEntry = compactingSessions.get(sessionId);

    // Detect post-acceptance compaction completion (F1 & F5) BEFORE TTL pruning so
    // long compactions (>15s) that just completed still report `status: 'completed'`.
    if (preEntry && preEntry.status === 'accepted' && telemetry && !hostRunning) {
      const currentCompactedStep =
        typeof telemetry.lastCompactedStep === 'number' ? telemetry.lastCompactedStep : null;
      const stepAdvanced =
        currentCompactedStep !== null &&
        (preEntry.baselineCompactedStep === null
          ? currentCompactedStep >= 0 && telemetry.compactionJustCompleted === true
          : currentCompactedStep > preEntry.baselineCompactedStep);

      const tokenDroppedSignificantly =
        currentCompactedStep === null &&
        preEntry.baselineCompactedStep === null &&
        typeof preEntry.baselineUsedTokens === 'number' &&
        preEntry.baselineUsedTokens >= 20_000 &&
        typeof telemetry.usedTokens === 'number' &&
        telemetry.usedTokens < preEntry.baselineUsedTokens * 0.75 &&
        preEntry.baselineUsedTokens - telemetry.usedTokens >= 10_000;

      if (stepAdvanced || tokenDroppedSignificantly) {
        compactingSessions.delete(sessionId);
        lastAutoCompactErrors.delete(sessionId);
        pruneCompactingSessions(now, null);
        return {
          inProgress: false,
          status: 'completed',
          startedAt: preEntry.startedAt,
          method: preEntry.method,
          trigger: preEntry.trigger,
          lastError: null,
        };
      }
    }

    pruneCompactingSessions(now, hostRunning ? sessionId : null);
    const entry = compactingSessions.get(sessionId);
    const lastError = lastAutoCompactErrors.get(sessionId) ?? null;
    if (!entry) {
      if (hostRunning) {
        return {
          inProgress: true,
          status: 'running',
          startedAt: null,
          method: 'host',
          trigger: 'manual',
          lastError,
        };
      }
      return {
        inProgress: false,
        status: 'idle',
        startedAt: null,
        method: null,
        trigger: null,
        lastError,
      };
    }

    return {
      inProgress: true,
      status: hostRunning ? 'running' : entry.status,
      startedAt: entry.startedAt,
      method: entry.method,
      trigger: entry.trigger,
      lastError,
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
      const modelCustomLimit = resolveModelCustomLimit(settings.modelLimits, telemetry.modelName);
      const limitInfo = resolveEffectiveLimit({
        hostMaxTokens: telemetry.maxContextTokens,
        sessionCustomLimit: sessionOverrideEntry ? sessionOverrideEntry.limit : null,
        modelCustomLimit,
        defaultCustomLimit: settings.defaultCustomLimit,
      });

      const threshold = evaluateContextThreshold({
        usedTokens: telemetry.usedTokens,
        effectiveLimit: limitInfo.effectiveLimit,
      });

      const now = clock();
      const compaction = getCompactionState(sessionId, telemetry, now);
      // A-4: Keep autoCompact default consistent with getSettings() (enabled unless explicitly false)
      const autoCompactEnabled = settings.autoCompact !== false;
      let autoCompactTriggered = false;

      const prevAuto = autoCompactState.get(sessionId) || {
        cooldownUntil: 0,
        waitingForDrop: false,
        lastTriggeredTokens: null,
        lastTriggeredStep: null,
        lastTriggeredCompactedStep: null,
        failedWhileRunning: false,
      };

      const currentCompactedStep =
        typeof telemetry.lastCompactedStep === 'number' ? telemetry.lastCompactedStep : null;
      const compactionAdvanced =
        currentCompactedStep !== null &&
        (prevAuto.lastTriggeredCompactedStep === null
          ? telemetry.compactionJustCompleted === true
          : currentCompactedStep > prevAuto.lastTriggeredCompactedStep);

      if (
        compactionAdvanced &&
        (prevAuto.waitingForDrop || prevAuto.cooldownUntil > 0 || prevAuto.failedWhileRunning)
      ) {
        prevAuto.waitingForDrop = false;
        prevAuto.cooldownUntil = 0;
        prevAuto.failedWhileRunning = false;
        prevAuto.lastTriggeredTokens = null;
        prevAuto.lastTriggeredStep = null;
        prevAuto.lastTriggeredCompactedStep = currentCompactedStep;
        autoCompactState.set(sessionId, prevAuto);
      }

      if (!threshold.exceededSoftLimit) {
        if (prevAuto.waitingForDrop || prevAuto.failedWhileRunning || prevAuto.cooldownUntil > 0) {
          prevAuto.waitingForDrop = false;
          prevAuto.failedWhileRunning = false;
          prevAuto.cooldownUntil = 0;
          autoCompactState.set(sessionId, prevAuto);
        }
        if (lastAutoCompactErrors.has(sessionId)) {
          lastAutoCompactErrors.delete(sessionId);
          compaction.lastError = null;
        }
      } else {
        const isRunning =
          typeof telemetry.status === 'string' &&
          telemetry.status.toUpperCase().includes('RUNNING');
        if (!isRunning && prevAuto.failedWhileRunning) {
          prevAuto.failedWhileRunning = false;
          prevAuto.cooldownUntil = 0;
          autoCompactState.set(sessionId, prevAuto);
        }

        const cooldownExpired = prevAuto.cooldownUntil <= now;
        const stepAdvancedSinceLast =
          typeof telemetry.stepCount === 'number' &&
          (prevAuto.lastTriggeredStep === null || telemetry.stepCount > prevAuto.lastTriggeredStep);
        const tokensGrewSinceLast =
          typeof telemetry.usedTokens === 'number' &&
          typeof prevAuto.lastTriggeredTokens === 'number' &&
          telemetry.usedTokens >= prevAuto.lastTriggeredTokens + AUTO_COMPACT_RETRIGGER_TOKEN_DELTA;
        const canTriggerAgain =
          !prevAuto.waitingForDrop || (stepAdvancedSinceLast && tokensGrewSinceLast);

        if (
          autoCompactEnabled &&
          limitInfo.isCustomActive &&
          !compaction.inProgress &&
          telemetry.hostCompactionInProgress !== true &&
          telemetry.compactionJustCompleted !== true &&
          cooldownExpired &&
          canTriggerAgain
        ) {
          const triggerRecord = {
            cooldownUntil: now + AUTO_COMPACT_COOLDOWN_MS,
            waitingForDrop: true,
            lastTriggeredTokens:
              typeof telemetry.usedTokens === 'number' ? telemetry.usedTokens : null,
            lastTriggeredStep:
              typeof telemetry.stepCount === 'number' ? telemetry.stepCount : null,
            lastTriggeredCompactedStep: currentCompactedStep,
            failedWhileRunning: false,
          };
          autoCompactState.set(sessionId, triggerRecord);
          while (autoCompactState.size > MAX_SESSION_OVERRIDES) {
            const oldest = autoCompactState.keys().next().value;
            if (oldest === undefined) break;
            autoCompactState.delete(oldest);
          }
          lastAutoCompactErrors.delete(sessionId);
          compaction.lastError = null;
          autoCompactTriggered = true;
          // Fire-and-forget guarded auto-compaction for this session (queues even while RUNNING)
          this.requestCompaction(sessionId, { trigger: 'auto' }).catch((err) => {
            // A-1 & A-3: Release waitingForDrop so retry is possible; if rejected while RUNNING,
            // use short backoff and retry immediately once the session transitions to IDLE.
            const cur = autoCompactState.get(sessionId);
            if (cur === triggerRecord) {
              cur.waitingForDrop = false;
              if (isRunning) {
                cur.failedWhileRunning = true;
                cur.cooldownUntil = clock() + AUTO_COMPACT_RUNNING_RETRY_MS;
              }
            }
            lastAutoCompactErrors.set(sessionId, {
              code: err?.code || ERROR_CODES.COMPACTION_FAILED,
              message: err?.message || 'Auto-compaction failed.',
              at: clock(),
            });
            while (lastAutoCompactErrors.size > MAX_SESSION_OVERRIDES) {
              const oldestErr = lastAutoCompactErrors.keys().next().value;
              if (oldestErr === undefined) break;
              lastAutoCompactErrors.delete(oldestErr);
            }
          });
        }
      }

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
        autoCompact: autoCompactEnabled,
        autoCompactTriggered,
        compactPrompt: typeof settings.compactPrompt === 'string' ? settings.compactPrompt : '',
        cacheHitPercent: telemetry.cacheHitPercent ?? null,
        cacheReadTokens: telemetry.cacheReadTokens ?? null,
        inputTokens: telemetry.inputTokens ?? null,
        lastCompactedStep: telemetry.lastCompactedStep ?? null,
        estimatedAfterCompaction: telemetry.estimatedAfterCompaction ?? null,
        tokenBreakdown: Array.isArray(telemetry.tokenBreakdown) ? telemetry.tokenBreakdown : [],
        compaction,
        locale: settings.locale,
        customButtons: Array.isArray(settings.customButtons) ? settings.customButtons : [],
        disabledRuntimeAddonIds: Array.isArray(settings.disabledRuntimeAddonIds)
          ? settings.disabledRuntimeAddonIds
          : [],
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
        autoCompact: settings.autoCompact !== false,
        compactPrompt: typeof settings.compactPrompt === 'string' ? settings.compactPrompt : '',
        customButtons: Array.isArray(settings.customButtons) ? settings.customButtons : [],
        disabledRuntimeAddonIds: Array.isArray(settings.disabledRuntimeAddonIds)
          ? settings.disabledRuntimeAddonIds
          : [],
        modelLimits: formatModelLimits(settings.modelLimits),
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

      if (Object.prototype.hasOwnProperty.call(patch, 'autoCompact')) {
        normalizedPatch.autoCompact = Boolean(patch.autoCompact);
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'compactPrompt')) {
        normalizedPatch.compactPrompt = validateCompactPrompt(patch.compactPrompt);
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'customButtons')) {
        normalizedPatch.customButtons = validateCustomButtons(patch.customButtons);
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'disabledRuntimeAddonIds')) {
        normalizedPatch.disabledRuntimeAddonIds = validateDisabledAddonIds(
          patch.disabledRuntimeAddonIds,
        );
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'modelLimit')) {
        const ml = patch.modelLimit;
        if (!ml || typeof ml !== 'object' || Array.isArray(ml)) {
          throw new DomainError(
            ERROR_CODES.INVALID_SETTINGS_PATCH,
            400,
            'modelLimit must be an object with model and limit.',
          );
        }
        normalizedPatch.modelLimit = {
          model: validateModelName(ml.model),
          limit: validateCustomLimit(ml.limit),
        };
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

      // A-2: Reset auto-compact cooldown/wait state when limits change or autoCompact is re-enabled
      if (
        Object.prototype.hasOwnProperty.call(normalizedPatch, 'defaultCustomLimit') ||
        Object.prototype.hasOwnProperty.call(normalizedPatch, 'modelLimit') ||
        normalizedPatch.autoCompact === true
      ) {
        autoCompactState.clear();
        lastAutoCompactErrors.clear();
      } else if (normalizedPatch.sessionLimit) {
        autoCompactState.delete(normalizedPatch.sessionLimit.sessionId);
        lastAutoCompactErrors.delete(normalizedPatch.sessionLimit.sessionId);
      }

      return {
        locale: updated.locale,
        defaultCustomLimit: updated.defaultCustomLimit,
        autoCompact: updated.autoCompact !== false,
        compactPrompt: typeof updated.compactPrompt === 'string' ? updated.compactPrompt : '',
        customButtons: Array.isArray(updated.customButtons) ? updated.customButtons : [],
        disabledRuntimeAddonIds: Array.isArray(updated.disabledRuntimeAddonIds)
          ? updated.disabledRuntimeAddonIds
          : [],
        modelLimits: formatModelLimits(updated.modelLimits),
        sessions: Array.from(updated.sessions.entries()).map(([id, entry]) => ({
          sessionId: id,
          limit: entry.limit,
          updatedAt: entry.updatedAt,
        })),
        presets: PRESET_LIMITS,
      };
    },

    async upsertAddon(rawAddon) {
      const addon = validateAddonDescriptor(rawAddon);
      const current = await settingsPort.read();
      const list = Array.isArray(current.customButtons) ? [...current.customButtons] : [];
      const idx = list.findIndex((b) => b.id === addon.id);
      if (idx >= 0) list[idx] = addon;
      else list.push(addon);
      return this.updateSettings({ customButtons: list });
    },

    async setAddonEnabled(rawId, enabled, isRuntime = false) {
      const id = validateAddonId(rawId);
      const current = await settingsPort.read();
      if (isRuntime) {
        const disabled = new Set(
          Array.isArray(current.disabledRuntimeAddonIds) ? current.disabledRuntimeAddonIds : [],
        );
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return this.updateSettings({ disabledRuntimeAddonIds: Array.from(disabled) });
      }
      const list = Array.isArray(current.customButtons) ? current.customButtons : [];
      const nextList = list.map((b) => (b.id === id ? { ...b, enabled: Boolean(enabled) } : b));
      return this.updateSettings({ customButtons: nextList });
    },

    async removeAddon(rawId) {
      const id = validateAddonId(rawId);
      const current = await settingsPort.read();
      const list = Array.isArray(current.customButtons) ? current.customButtons : [];
      const nextList = list.filter((b) => b.id !== id);
      return this.updateSettings({ customButtons: nextList });
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
      if (command.startsWith('/compact ')) {
        return this.requestCompaction(sessionId, { prompt: command.slice(9).trim() });
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

    async requestCompaction(rawSessionId, options = {}) {
      const sessionId = validateSessionId(rawSessionId);
      const trigger = options?.trigger === 'auto' ? 'auto' : 'manual';
      const explicitPrompt =
        options?.prompt !== undefined ? validateCompactPrompt(options.prompt) : null;
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
        trigger,
        baselineCompactedStep: null,
        baselineUsedTokens: null,
        status: 'pending',
      });

      const releaseOwnMutex = () => {
        if (compactingSessions.get(sessionId)?.attemptToken === attemptToken) {
          compactingSessions.delete(sessionId);
        }
      };

      let baselineCompactedStep = null;
      let baselineUsedTokens = null;
      let effectivePrompt = explicitPrompt ?? '';
      if (explicitPrompt === null) {
        try {
          const currentSettings = await settingsPort.read();
          if (typeof currentSettings?.compactPrompt === 'string') {
            effectivePrompt = currentSettings.compactPrompt.trim();
          }
        } catch {
          // Non-fatal: fall back to default /compact without custom prompt
        }
      }

      try {
        const currentTelemetry = await telemetryPort.getSessionTelemetry(sessionId);
        if (currentTelemetry && currentTelemetry.sessionId === sessionId) {
          baselineCompactedStep =
            typeof currentTelemetry.lastCompactedStep === 'number'
              ? currentTelemetry.lastCompactedStep
              : null;
          baselineUsedTokens =
            typeof currentTelemetry.usedTokens === 'number'
              ? currentTelemetry.usedTokens
              : null;
        }
      } catch {
        // Non-fatal: proceed without baseline step
      }

      try {
        const result = await compactionPort.compactSession(
          sessionId,
          effectivePrompt ? { prompt: effectivePrompt } : undefined,
        );
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
        lastAutoCompactErrors.delete(sessionId);
        if (compactingSessions.get(sessionId)?.attemptToken === attemptToken) {
          compactingSessions.set(sessionId, {
            attemptToken,
            startedAt: now,
            acceptedAt,
            method: result.method ?? 'unknown',
            trigger,
            baselineCompactedStep,
            baselineUsedTokens,
            status: 'accepted',
          });
        }

        return {
          accepted: true,
          sessionId,
          method: result.method ?? 'unknown',
          trigger,
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

    async sweepActiveSessions({
      maxSessions = MAX_BACKGROUND_SWEEP_SESSIONS,
      recentWindowMs = BACKGROUND_RECENT_WINDOW_MS,
    } = {}) {
      const settings = await settingsPort.read();
      const autoCompactEnabled = settings.autoCompact !== false;
      const hasAnyCustomLimit =
        typeof settings.defaultCustomLimit === 'number' ||
        (settings.modelLimits instanceof Map && settings.modelLimits.size > 0) ||
        (settings.sessions instanceof Map && settings.sessions.size > 0);
      if (!autoCompactEnabled || !hasAnyCustomLimit) {
        return { checked: 0, triggered: 0 };
      }

      const sessions = await telemetryPort.listSessions();
      const now = clock();
      const candidates = (Array.isArray(sessions) ? sessions : [])
        .filter((s) => {
          if (!s || typeof s.sessionId !== 'string' || !s.sessionId) return false;
          const running =
            typeof s.status === 'string' && s.status.toUpperCase().includes('RUNNING');
          const recent =
            typeof s.lastModifiedMs === 'number' &&
            s.lastModifiedMs > 0 &&
            now - s.lastModifiedMs <= recentWindowMs;
          return running || recent;
        })
        .slice(0, maxSessions);

      let checked = 0;
      let triggered = 0;
      for (const s of candidates) {
        try {
          const snap = await this.getSessionSnapshot(s.sessionId);
          checked += 1;
          if (snap.autoCompactTriggered) {
            triggered += 1;
          }
        } catch {
          // Best-effort sweep: isolate per-session telemetry failures
        }
      }
      return { checked, triggered };
    },
  };
}
