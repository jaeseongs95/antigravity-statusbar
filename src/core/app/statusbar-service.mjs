import { DomainError, ERROR_CODES, normalizeLocale } from '../i18n/error-codes.mjs';
import {
  MAX_BUTTON_COMMAND_LEN,
  MAX_SESSION_OVERRIDES,
  PRESET_LIMITS,
  buildAutoResumePrompt,
  evaluateContextThreshold,
  normalizeAutoCompactWhileRunning,
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
const AUTO_RESUME_WINDOW_MS = 300_000;
const AUTO_RESUME_RUNNING_GRACE_MS = 12_000;
const AUTO_RESUME_RUNNING_STEP_DELTA = 2;
const AUTO_RESUME_ERROR_CODE = 'AUTO_RESUME_FAILED';
const AUTO_RESUME_CIRCUIT_WINDOW_MS = 600_000;
const MAX_CONSECUTIVE_AUTO_RESUMES = 3;
const MAX_BACKGROUND_SWEEP_SESSIONS = 5;
const BACKGROUND_RECENT_WINDOW_MS = 60_000;

function isRunningStatus(status) {
  return typeof status === 'string' && status.toUpperCase().includes('RUNNING');
}

function isIdleStatus(status) {
  if (typeof status !== 'string') return false;
  const upper = status.toUpperCase();
  return upper.includes('IDLE') || upper.includes('WAITING') || upper.includes('COMPLETED');
}

function isCancelledOrErrorStatus(status) {
  if (typeof status !== 'string') return false;
  const upper = status.toUpperCase();
  return (
    upper.includes('CANCEL') ||
    upper.includes('ABORT') ||
    upper.includes('ERROR') ||
    upper.includes('FAIL')
  );
}

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

  /** @type {Map<string, { attemptToken: string, startedAt: number, acceptedAt: number | null, lastHostCompactingAt: number | null, method: string | null, trigger: 'manual' | 'auto', baselineCompactedStep: number | null, baselineUsedTokens: number | null, baselineStepCount: number | null, status: 'pending' | 'accepted' }>} */
  const compactingSessions = new Map();
  /** @type {Map<string, { cooldownUntil: number, waitingForDrop: boolean, lastTriggeredTokens: number | null, lastTriggeredStep: number | null, lastTriggeredCompactedStep: number | null, failedWhileRunning: boolean }>} */
  const autoCompactState = new Map();
  /** @type {Map<string, { attemptToken: string, triggeredAt: number, baselineCompactedStep: number | null, baselineUsedTokens: number | null, baselineStepCount: number | null, compactionDoneAt: number | null, compactionDoneStepCount: number | null, locale: string, dispatched: boolean }>} */
  const pendingAutoResume = new Map();
  /** @type {Map<string, { count: number, windowStartedAt: number }>} */
  const autoResumeCircuit = new Map();
  /** @type {Set<string>} */
  const deferredAutoCompactSessions = new Set();
  /** @type {Map<string, { code: string, message: string, at: number }>} */
  const lastAutoCompactErrors = new Map();
  /** @type {Map<string, { maxCompactedStep: number | null, maxStepCount: number | null }>} */
  const observedProgress = new Map();
  let attemptSeq = 0;

  function recordAutoCompactError(sessionId, code, message) {
    lastAutoCompactErrors.set(sessionId, {
      code: code || ERROR_CODES.COMPACTION_FAILED,
      message: message || 'Auto-compaction failed.',
      at: clock(),
    });
    while (lastAutoCompactErrors.size > MAX_SESSION_OVERRIDES) {
      const oldestErr = lastAutoCompactErrors.keys().next().value;
      if (oldestErr === undefined) break;
      lastAutoCompactErrors.delete(oldestErr);
    }
  }

  function formatModelLimits(modelLimitsMap) {
    if (!(modelLimitsMap instanceof Map)) return [];
    return Array.from(modelLimitsMap.entries()).map(([model, entry]) => ({
      model,
      limit: entry.limit,
      updatedAt: entry.updatedAt,
    }));
  }

  function pruneCompactingSessions(now, observedSessionId = null, observedHostRunning = false) {
    for (const [sid, entry] of compactingSessions.entries()) {
      if (sid === observedSessionId) {
        if (observedHostRunning) {
          entry.lastHostCompactingAt = now;
        } else if (
          entry.status === 'accepted' &&
          now - (entry.acceptedAt ?? entry.startedAt) >= compactCooldownMs
        ) {
          entry.lastHostCompactingAt = null;
        }
      }
      const hasActiveHostLease =
        (sid === observedSessionId && observedHostRunning) ||
        (entry.lastHostCompactingAt !== null &&
          now - entry.lastHostCompactingAt < HOST_COMPACT_MAX_LOCK_MS);
      const ttl = hasActiveHostLease ? HOST_COMPACT_MAX_LOCK_MS : compactCooldownMs;
      const baseTs = entry.acceptedAt ?? entry.startedAt;
      if (entry.status === 'accepted' && now - baseTs >= ttl) {
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
          ? currentCompactedStep >= 0 &&
            (telemetry.compactionJustCompleted === true ||
              (typeof preEntry.baselineStepCount === 'number' &&
                currentCompactedStep >= preEntry.baselineStepCount))
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
        pruneCompactingSessions(now, sessionId, false);
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

    pruneCompactingSessions(now, sessionId, hostRunning);
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
      const needsTailCheck =
        compactingSessions.has(sessionId) || pendingAutoResume.has(sessionId);
      const [telemetry, settings] = await Promise.all([
        needsTailCheck
          ? telemetryPort.getSessionTelemetry(sessionId, { includeTailSteps: true })
          : telemetryPort.getSessionTelemetry(sessionId),
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
      const autoCompactWhileRunning =
        settings.autoCompactWhileRunning === 'defer' ? 'defer' : 'resume';
      let autoCompactTriggered = false;
      let autoCompactDeferred = false;
      let autoResumeTriggered = false;

      const isRunning = isRunningStatus(telemetry.status);
      const currentCompactedStep =
        typeof telemetry.lastCompactedStep === 'number' ? telemetry.lastCompactedStep : null;
      const incomingStepCount =
        typeof telemetry.stepCount === 'number' ? telemetry.stepCount : null;

      // Monotonic progress guard: out-of-order stale polls (regressed stepCount or regressed/dropped
      // lastCompactedStep) must never re-trigger auto-compaction.
      const prevObs = observedProgress.get(sessionId) ?? null;
      const compactedStepRegressed =
        prevObs !== null &&
        prevObs.maxCompactedStep !== null &&
        (currentCompactedStep === null || currentCompactedStep < prevObs.maxCompactedStep);
      const stepCountRegressed =
        prevObs !== null &&
        prevObs.maxStepCount !== null &&
        incomingStepCount !== null &&
        incomingStepCount < prevObs.maxStepCount;
      const telemetryRegressed = compactedStepRegressed || stepCountRegressed;
      if (!telemetryRegressed && (currentCompactedStep !== null || incomingStepCount !== null)) {
        const nextMaxCompacted =
          prevObs?.maxCompactedStep !== null && prevObs?.maxCompactedStep !== undefined
            ? currentCompactedStep !== null
              ? Math.max(prevObs.maxCompactedStep, currentCompactedStep)
              : prevObs.maxCompactedStep
            : currentCompactedStep;
        const nextMaxStep =
          prevObs?.maxStepCount !== null && prevObs?.maxStepCount !== undefined
            ? incomingStepCount !== null
              ? Math.max(prevObs.maxStepCount, incomingStepCount)
              : prevObs.maxStepCount
            : incomingStepCount;
        observedProgress.delete(sessionId);
        observedProgress.set(sessionId, {
          maxCompactedStep: nextMaxCompacted,
          maxStepCount: nextMaxStep,
        });
        while (observedProgress.size > MAX_SESSION_OVERRIDES) {
          const oldestObs = observedProgress.keys().next().value;
          if (oldestObs === undefined) break;
          observedProgress.delete(oldestObs);
        }
      }

      // ISS-00 / v3.1.1: Guarded single-shot Auto-Resume for RUNNING sessions interrupted by auto-compact
      const resumeEntry = pendingAutoResume.get(sessionId);
      if (resumeEntry) {
        const resumeExpired = now - resumeEntry.triggeredAt > AUTO_RESUME_WINDOW_MS;
        const cancelledOrError = isCancelledOrErrorStatus(telemetry.status);
        const resumeStepAdvanced =
          currentCompactedStep !== null &&
          (resumeEntry.baselineCompactedStep === null
            ? currentCompactedStep >= 0 &&
              (telemetry.compactionJustCompleted === true ||
                (typeof resumeEntry.baselineStepCount === 'number' &&
                  currentCompactedStep >= resumeEntry.baselineStepCount))
            : currentCompactedStep > resumeEntry.baselineCompactedStep);
        const resumeTokenDropped =
          currentCompactedStep === null &&
          resumeEntry.baselineCompactedStep === null &&
          typeof resumeEntry.baselineUsedTokens === 'number' &&
          resumeEntry.baselineUsedTokens >= 20_000 &&
          typeof telemetry.usedTokens === 'number' &&
          telemetry.usedTokens < resumeEntry.baselineUsedTokens * 0.75 &&
          resumeEntry.baselineUsedTokens - telemetry.usedTokens >= 10_000;
        const compactionDoneNow =
          compaction.status === 'completed' || resumeStepAdvanced || resumeTokenDropped;

        if (resumeExpired || cancelledOrError || resumeEntry.dispatched) {
          pendingAutoResume.delete(sessionId);
        } else {
          if (
            compactionDoneNow &&
            telemetry.hostCompactionInProgress !== true &&
            resumeEntry.compactionDoneAt === null
          ) {
            // Latch completion once observed because getCompactionState() reports 'completed' single-shot
            resumeEntry.compactionDoneAt = now;
            resumeEntry.compactionDoneStepCount =
              typeof telemetry.stepCount === 'number' ? telemetry.stepCount : null;
          }
          const compactionDoneForResume = resumeEntry.compactionDoneAt !== null || compactionDoneNow;

          if (compactionDoneForResume && telemetry.hostCompactionInProgress !== true) {
            const manualUserIntervened =
              telemetry.compactionJustCompleted !== true &&
              telemetry.usedTokensSource !== 'after_compaction' &&
              currentCompactedStep !== null &&
              typeof telemetry.stepCount === 'number' &&
              telemetry.stepCount >= currentCompactedStep + 3;

            // The host can remain in status=RUNNING for >12s after checkpoint completion with
            // 0 new steps before dropping to IDLE. When stepCount telemetry is available, require
            // actual step progress (>=2 steps) before cancelling pendingAutoResume; only fall back
            // to the elapsed-time grace window when stepCount telemetry is unavailable.
            const hasKnownStepProgress =
              typeof telemetry.stepCount === 'number' &&
              typeof resumeEntry.compactionDoneStepCount === 'number';
            const runningStepDelta = hasKnownStepProgress
              ? telemetry.stepCount - resumeEntry.compactionDoneStepCount
              : 0;
            const runningElapsedMs =
              resumeEntry.compactionDoneAt !== null ? now - resumeEntry.compactionDoneAt : 0;
            const hostResumedOnItsOwn =
              isRunning &&
              (hasKnownStepProgress
                ? runningStepDelta >= AUTO_RESUME_RUNNING_STEP_DELTA
                : runningElapsedMs >= AUTO_RESUME_RUNNING_GRACE_MS);

            if (manualUserIntervened || hostResumedOnItsOwn) {
              // Host genuinely resumed on its own or user manually sent a follow-up message
              pendingAutoResume.delete(sessionId);
            } else if (!isRunning && isIdleStatus(telemetry.status)) {
              const circuit = autoResumeCircuit.get(sessionId);
              const circuitCount =
                circuit && now - circuit.windowStartedAt < AUTO_RESUME_CIRCUIT_WINDOW_MS
                  ? circuit.count
                  : 0;
              const circuitWindowStart =
                circuit && now - circuit.windowStartedAt < AUTO_RESUME_CIRCUIT_WINDOW_MS
                  ? circuit.windowStartedAt
                  : now;

              // Synchronously mark dispatched and remove BEFORE any await to prevent double-send
              resumeEntry.dispatched = true;
              pendingAutoResume.delete(sessionId);

              if (
                circuitCount < MAX_CONSECUTIVE_AUTO_RESUMES &&
                typeof compactionPort.sendCommand === 'function'
              ) {
                autoResumeCircuit.set(sessionId, {
                  count: circuitCount + 1,
                  windowStartedAt: circuitWindowStart,
                });
                while (autoResumeCircuit.size > MAX_SESSION_OVERRIDES) {
                  const oldestKey = autoResumeCircuit.keys().next().value;
                  if (oldestKey === undefined) break;
                  autoResumeCircuit.delete(oldestKey);
                }
                autoResumeTriggered = true;
                const resumePrompt = buildAutoResumePrompt(resumeEntry.locale);
                Promise.resolve(compactionPort.sendCommand(sessionId, resumePrompt))
                  .then((res) => {
                    if (!res || res.accepted !== true) {
                      recordAutoCompactError(
                        sessionId,
                        AUTO_RESUME_ERROR_CODE,
                        res?.reason || 'Auto-resume continuation message was not accepted.',
                      );
                    }
                  })
                  .catch((err) => {
                    // Best-effort single-shot resume: surface failure in lastError without looping
                    recordAutoCompactError(
                      sessionId,
                      err?.code || AUTO_RESUME_ERROR_CODE,
                      err?.message || 'Auto-resume continuation failed.',
                    );
                  });
              }
            }
          }
        }
      }

      const prevAuto = autoCompactState.get(sessionId) || {
        cooldownUntil: 0,
        waitingForDrop: false,
        lastTriggeredTokens: null,
        lastTriggeredStep: null,
        lastTriggeredCompactedStep: null,
        failedWhileRunning: false,
      };

      const isSyntheticAfterCompaction = telemetry.usedTokensSource === 'after_compaction';
      const compactionAdvanced =
        currentCompactedStep !== null &&
        (prevAuto.lastTriggeredCompactedStep === null
          ? telemetry.compactionJustCompleted === true ||
            (typeof prevAuto.lastTriggeredStep === 'number' &&
              currentCompactedStep >= prevAuto.lastTriggeredStep)
          : currentCompactedStep > prevAuto.lastTriggeredCompactedStep);

      if (
        compactionAdvanced &&
        (prevAuto.waitingForDrop ||
          prevAuto.cooldownUntil > 0 ||
          prevAuto.failedWhileRunning ||
          isSyntheticAfterCompaction)
      ) {
        const hasNumericTokens = typeof telemetry.usedTokens === 'number';
        const droppedBelowLimit = hasNumericTokens && !threshold.exceededSoftLimit;
        const reducedMeaningfully =
          hasNumericTokens &&
          typeof prevAuto.lastTriggeredTokens === 'number' &&
          prevAuto.lastTriggeredTokens - telemetry.usedTokens >= 10_000 &&
          telemetry.usedTokens <= prevAuto.lastTriggeredTokens * 0.85;

        if (droppedBelowLimit || reducedMeaningfully) {
          prevAuto.waitingForDrop = false;
          // Preserve/refresh settlement cooldown while readings are synthetic ('after_compaction'),
          // even if compaction took longer than 90s; cleared once a real below-limit reading arrives.
          prevAuto.cooldownUntil = isSyntheticAfterCompaction
            ? Math.max(prevAuto.cooldownUntil, now + AUTO_COMPACT_COOLDOWN_MS)
            : 0;
          prevAuto.failedWhileRunning = false;
          prevAuto.lastTriggeredTokens = null;
          prevAuto.lastTriggeredStep = null;
          prevAuto.lastTriggeredCompactedStep = currentCompactedStep;
        } else {
          // ISS-05: Low custom limit (e.g. 32K) where post-compaction context still exceeds limit:
          // retain cooldown + token-growth guard so it never enters an infinite compaction loop.
          prevAuto.waitingForDrop = true;
          prevAuto.cooldownUntil = now + AUTO_COMPACT_COOLDOWN_MS;
          prevAuto.failedWhileRunning = false;
          prevAuto.lastTriggeredTokens = hasNumericTokens
            ? telemetry.usedTokens
            : prevAuto.lastTriggeredTokens;
          prevAuto.lastTriggeredStep =
            typeof telemetry.stepCount === 'number'
              ? telemetry.stepCount
              : prevAuto.lastTriggeredStep;
          prevAuto.lastTriggeredCompactedStep = currentCompactedStep;
        }
        autoCompactState.set(sessionId, prevAuto);
      }

      if (typeof telemetry.usedTokens === 'number' && !threshold.exceededSoftLimit) {
        deferredAutoCompactSessions.delete(sessionId);
        autoResumeCircuit.delete(sessionId);
        const shouldClearCooldown = !isSyntheticAfterCompaction && prevAuto.cooldownUntil > 0;
        if (prevAuto.waitingForDrop || prevAuto.failedWhileRunning || shouldClearCooldown) {
          prevAuto.waitingForDrop = false;
          prevAuto.failedWhileRunning = false;
          if (!isSyntheticAfterCompaction) {
            prevAuto.cooldownUntil = 0;
          }
          autoCompactState.set(sessionId, prevAuto);
        }
        const existingErr = lastAutoCompactErrors.get(sessionId);
        if (existingErr && (existingErr.code !== AUTO_RESUME_ERROR_CODE || isRunning)) {
          lastAutoCompactErrors.delete(sessionId);
          compaction.lastError = null;
        }
      } else if (threshold.exceededSoftLimit) {
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
          !telemetryRegressed &&
          cooldownExpired &&
          canTriggerAgain
        ) {
          if (isRunning && autoCompactWhileRunning === 'defer') {
            // ISS-00 Option B/C: Defer compaction cleanly until RUNNING turn completes into IDLE
            deferredAutoCompactSessions.add(sessionId);
            autoCompactDeferred = true;
          } else {
            deferredAutoCompactSessions.delete(sessionId);
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

            let resumeAttemptToken = null;
            if (isRunning && autoCompactWhileRunning === 'resume') {
              resumeAttemptToken = `resume-${now}-${++attemptSeq}`;
              pendingAutoResume.set(sessionId, {
                attemptToken: resumeAttemptToken,
                triggeredAt: now,
                baselineCompactedStep: currentCompactedStep,
                baselineUsedTokens:
                  typeof telemetry.usedTokens === 'number' ? telemetry.usedTokens : null,
                baselineStepCount:
                  typeof telemetry.stepCount === 'number' ? telemetry.stepCount : null,
                compactionDoneAt: null,
                compactionDoneStepCount: null,
                locale: settings.locale || 'ko',
                dispatched: false,
              });
              while (pendingAutoResume.size > MAX_SESSION_OVERRIDES) {
                const oldestKey = pendingAutoResume.keys().next().value;
                if (oldestKey === undefined) break;
                pendingAutoResume.delete(oldestKey);
              }
            }

            lastAutoCompactErrors.delete(sessionId);
            compaction.lastError = null;
            autoCompactTriggered = true;
            // Fire-and-forget guarded auto-compaction for this session
            this.requestCompaction(sessionId, { trigger: 'auto' }).catch((err) => {
              if (
                resumeAttemptToken &&
                pendingAutoResume.get(sessionId)?.attemptToken === resumeAttemptToken
              ) {
                pendingAutoResume.delete(sessionId);
              }
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
              recordAutoCompactError(
                sessionId,
                err?.code || ERROR_CODES.COMPACTION_FAILED,
                err?.message || 'Auto-compaction failed.',
              );
            });
          }
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
        autoCompactWhileRunning,
        autoCompactTriggered,
        autoCompactDeferred,
        autoResumePending: pendingAutoResume.has(sessionId),
        autoResumeTriggered,
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
        autoCompactWhileRunning:
          settings.autoCompactWhileRunning === 'defer' ? 'defer' : 'resume',
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

      if (Object.prototype.hasOwnProperty.call(patch, 'autoCompactWhileRunning')) {
        normalizedPatch.autoCompactWhileRunning = normalizeAutoCompactWhileRunning(
          patch.autoCompactWhileRunning,
        );
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

      if (Object.prototype.hasOwnProperty.call(patch, 'addonUpsert')) {
        normalizedPatch.addonUpsert = validateAddonDescriptor(patch.addonUpsert);
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'addonToggle')) {
        const tg = patch.addonToggle;
        if (!tg || typeof tg !== 'object' || Array.isArray(tg)) {
          throw new DomainError(
            ERROR_CODES.INVALID_SETTINGS_PATCH,
            400,
            'addonToggle must be an object with id and enabled.',
          );
        }
        normalizedPatch.addonToggle = {
          id: validateAddonId(tg.id),
          enabled: Boolean(tg.enabled),
          runtime: Boolean(tg.runtime),
        };
        hasChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'addonRemove')) {
        const rawId =
          typeof patch.addonRemove === 'string' ? patch.addonRemove : patch.addonRemove?.id;
        normalizedPatch.addonRemove = { id: validateAddonId(rawId) };
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
        autoCompactWhileRunning:
          updated.autoCompactWhileRunning === 'defer' ? 'defer' : 'resume',
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
      return this.updateSettings({ addonUpsert: addon });
    },

    async setAddonEnabled(rawId, enabled, isRuntime = false) {
      const id = validateAddonId(rawId);
      return this.updateSettings({
        addonToggle: { id, enabled: Boolean(enabled), runtime: Boolean(isRuntime) },
      });
    },

    async removeAddon(rawId) {
      const id = validateAddonId(rawId);
      return this.updateSettings({ addonRemove: { id } });
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
        lastHostCompactingAt: null,
        method: null,
        trigger,
        baselineCompactedStep: null,
        baselineUsedTokens: null,
        baselineStepCount: null,
        status: 'pending',
      });

      const releaseOwnMutex = () => {
        if (compactingSessions.get(sessionId)?.attemptToken === attemptToken) {
          compactingSessions.delete(sessionId);
        }
      };

      let baselineCompactedStep = null;
      let baselineUsedTokens = null;
      let baselineStepCount = null;
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
        const currentTelemetry = await telemetryPort.getSessionTelemetry(sessionId, {
          includeTailSteps: true,
        });
        if (currentTelemetry && currentTelemetry.sessionId === sessionId) {
          if (currentTelemetry.hostCompactionInProgress === true) {
            releaseOwnMutex();
            throw new DomainError(
              ERROR_CODES.COMPACTION_IN_PROGRESS,
              409,
              'Compaction is already running on the host for this session.',
              { sessionId, status: 'running' },
            );
          }
          baselineCompactedStep =
            typeof currentTelemetry.lastCompactedStep === 'number'
              ? currentTelemetry.lastCompactedStep
              : null;
          baselineUsedTokens =
            typeof currentTelemetry.usedTokens === 'number'
              ? currentTelemetry.usedTokens
              : null;
          baselineStepCount =
            typeof currentTelemetry.stepCount === 'number'
              ? currentTelemetry.stepCount
              : null;
        }
      } catch (err) {
        if (err instanceof DomainError && err.code === ERROR_CODES.COMPACTION_IN_PROGRESS) {
          throw err;
        }
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
            lastHostCompactingAt: null,
            method: result.method ?? 'unknown',
            trigger,
            baselineCompactedStep,
            baselineUsedTokens,
            baselineStepCount,
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
        pendingAutoResume.clear();
        deferredAutoCompactSessions.clear();
        return { checked: 0, triggered: 0, resumed: 0 };
      }

      const sessions = await telemetryPort.listSessions();
      const now = clock();
      const hasGlobalOrModelLimit =
        typeof settings.defaultCustomLimit === 'number' ||
        (settings.modelLimits instanceof Map && settings.modelLimits.size > 0);

      const candidateIds = [];
      const seen = new Set();

      // Always prioritize sessions awaiting auto-resume or deferred IDLE compaction
      for (const sid of pendingAutoResume.keys()) {
        if (!seen.has(sid)) {
          seen.add(sid);
          candidateIds.push(sid);
        }
      }
      for (const sid of deferredAutoCompactSessions) {
        if (!seen.has(sid)) {
          seen.add(sid);
          candidateIds.push(sid);
        }
      }

      if (autoCompactEnabled && hasAnyCustomLimit) {
        for (const s of Array.isArray(sessions) ? sessions : []) {
          if (candidateIds.length >= maxSessions) break;
          if (!s || typeof s.sessionId !== 'string' || !s.sessionId) continue;
          if (seen.has(s.sessionId)) continue;
          // ISS-14: Exclude identifiable subagent cascades from background auto-compaction by default
          if (s.isSubagent === true) continue;
          if (!hasGlobalOrModelLimit && !settings.sessions.has(s.sessionId)) continue;
          const running = isRunningStatus(s.status);
          const recent =
            typeof s.lastModifiedMs === 'number' &&
            s.lastModifiedMs > 0 &&
            now - s.lastModifiedMs <= recentWindowMs;
          if (running || recent) {
            seen.add(s.sessionId);
            candidateIds.push(s.sessionId);
          }
        }
      }

      let checked = 0;
      let triggered = 0;
      let resumed = 0;
      for (const sid of candidateIds) {
        try {
          const snap = await this.getSessionSnapshot(sid);
          checked += 1;
          if (snap.autoCompactTriggered) triggered += 1;
          if (snap.autoResumeTriggered) resumed += 1;
        } catch {
          // Best-effort sweep: isolate per-session telemetry failures
        }
      }
      return { checked, triggered, resumed };
    },
  };
}
