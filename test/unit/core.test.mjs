import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusbarService } from '../../src/core/app/statusbar-service.mjs';
import { DomainError, ERROR_CODES } from '../../src/core/i18n/error-codes.mjs';
import {
  MAX_CUSTOM_LIMIT,
  MAX_SESSION_OVERRIDES,
  MIN_CUSTOM_LIMIT,
  evaluateContextThreshold,
  pruneSessionOverrides,
  resolveEffectiveLimit,
  validateCustomLimit,
  validateSessionId,
} from '../../src/core/model/context-policy.mjs';
import { computeCacheHitPercent } from '../../src/core/model/telemetry.mjs';

test('validateSessionId rejects prototype pollution and invalid chars', () => {
  assert.equal(validateSessionId('abc-123_456:789'), 'abc-123_456:789');
  for (const bad of ['', '   ', '__proto__', 'constructor', 'prototype', '../etc/passwd', 'a b']) {
    assert.throws(() => validateSessionId(bad), (err) => err instanceof DomainError && err.code === ERROR_CODES.INVALID_SESSION_ID);
  }
});

test('validateCustomLimit enforces 32000..980000 integer bounds and allows null', () => {
  assert.equal(validateCustomLimit(null), null);
  assert.equal(validateCustomLimit(MIN_CUSTOM_LIMIT), 32_000);
  assert.equal(validateCustomLimit(MAX_CUSTOM_LIMIT), 980_000);
  for (const bad of [31_999, 980_001, 128_000.5, NaN, '128000', Infinity]) {
    assert.throws(() => validateCustomLimit(bad), (err) => err instanceof DomainError && err.code === ERROR_CODES.INVALID_CUSTOM_LIMIT);
  }
});

test('resolveEffectiveLimit handles hostMax === 0 without division by zero (F4)', () => {
  const customOnly = resolveEffectiveLimit({
    hostMaxTokens: 0,
    sessionCustomLimit: 256_000,
    defaultCustomLimit: null,
  });
  assert.equal(customOnly.effectiveLimit, 256_000);
  assert.equal(customOnly.isClampedByHost, false);

  const clamped = resolveEffectiveLimit({
    hostMaxTokens: 200_000,
    sessionCustomLimit: 384_000,
    defaultCustomLimit: null,
  });
  assert.equal(clamped.effectiveLimit, 200_000);
  assert.equal(clamped.isClampedByHost, true);

  const zeroBoth = evaluateContextThreshold({ usedTokens: 10_000, effectiveLimit: 0 });
  assert.equal(zeroBoth.usagePercent, null);
  assert.equal(zeroBoth.thresholdLevel, 'unknown');
});

test('pruneSessionOverrides enforces 200-entry LRU cap (D-0026)', () => {
  const entries = [];
  for (let i = 0; i < 250; i += 1) {
    entries.push([`sess-${i}`, { limit: 128_000, updatedAt: i + 1 }]);
  }
  const pruned = pruneSessionOverrides(entries, MAX_SESSION_OVERRIDES);
  assert.equal(pruned.size, 200);
  assert.equal(pruned.has('sess-0'), false);
  assert.equal(pruned.has('sess-49'), false);
  assert.equal(pruned.has('sess-50'), true);
  assert.equal(pruned.has('sess-249'), true);
});

test('computeCacheHitPercent handles separated vs inclusive provider formulas', () => {
  // Gemini/Anthropic: inputTokens is uncached, cacheReadTokens is cached
  const gemini = computeCacheHitPercent({
    cacheReadTokens: 452_934,
    inputTokens: 7_049,
    inputIncludesCache: false,
  });
  assert.equal(gemini, 98.5);

  // OpenAI: inputTokens includes cacheReadTokens
  const openai = computeCacheHitPercent({
    cacheReadTokens: 80_000,
    inputTokens: 100_000,
    inputIncludesCache: true,
  });
  assert.equal(openai, 80);

  // Honest unavailable
  assert.equal(
    computeCacheHitPercent({ cacheReadTokens: null, inputTokens: 100, inputIncludesCache: false }),
    null,
  );
});

test('statusbar-service enforces cross-session isolation (D-0033) and releases mutex immediately on dual failure (F5)', async () => {
  let now = 1_000_000;
  let compactResponse = { accepted: false, reason: 'both primary and fallback failed' };
  let telemetryResponse = {
    sessionId: 'sess-A',
    usedTokens: 150_000,
    maxContextTokens: 200_000,
    lastCompactedStep: 5,
    compactionJustCompleted: false,
    tokenBreakdown: [],
  };

  const settingsState = {
    locale: 'en',
    defaultCustomLimit: null,
    sessions: new Map([['sess-A', { limit: 128_000, updatedAt: 100 }]]),
  };

  const service = createStatusbarService({
    clock: () => now,
    telemetryPort: {
      listSessions: async () => [{ sessionId: 'sess-A', title: 'A' }],
      getSessionTelemetry: async () => telemetryResponse,
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false, fetchedAt: now }),
    },
    compactionPort: {
      compactSession: async () => compactResponse,
    },
    settingsPort: {
      read: async () => settingsState,
      update: async (patch) => {
        if (patch.locale) settingsState.locale = patch.locale;
        return settingsState;
      },
    },
  });

  // 1. Cross-session mismatch -> 409 SESSION_MISMATCH (D-0033)
  await assert.rejects(
    () => service.getSessionSnapshot('sess-B'),
    (err) => err instanceof DomainError && err.code === ERROR_CODES.SESSION_MISMATCH && err.httpStatus === 409,
  );

  // 2. Soft limit exceeded warning (Option A, D-0013)
  const snap = await service.getSessionSnapshot('sess-A');
  assert.equal(snap.effectiveLimit, 128_000);
  assert.equal(snap.exceededSoftLimit, true);
  assert.equal(snap.thresholdLevel, 'exceeded');

  // 3. F5: Compaction dual failure releases mutex immediately (no false 15s 409!)
  await assert.rejects(
    () => service.requestCompaction('sess-A'),
    (err) => err instanceof DomainError && err.code === ERROR_CODES.COMPACTION_FAILED,
  );

  // Immediately retry with accepted response -> MUST NOT throw 409 COMPACTION_IN_PROGRESS
  compactResponse = { accepted: true, method: 'rpc' };
  const accepted = await service.requestCompaction('sess-A');
  assert.equal(accepted.accepted, true);

  // While in-flight -> second request throws 409
  await assert.rejects(
    () => service.requestCompaction('sess-A'),
    (err) => err instanceof DomainError && err.code === ERROR_CODES.COMPACTION_IN_PROGRESS && err.httpStatus === 409,
  );

  // F5: Post-acceptance completion clears mutex immediately when lastCompactedStep advances
  telemetryResponse = { ...telemetryResponse, lastCompactedStep: 8, compactionJustCompleted: true };
  const afterSnap = await service.getSessionSnapshot('sess-A');
  assert.equal(afterSnap.compaction.inProgress, false);
  assert.equal(afterSnap.compaction.status, 'completed');

  // Now compaction can be requested again without waiting 15s
  const secondAccepted = await service.requestCompaction('sess-A');
  assert.equal(secondAccepted.accepted, true);
});
