import assert from 'node:assert/strict';
import test from 'node:test';

import { mapSessionTelemetry } from '../../src/adapters/antigravity/telemetry-mapper.mjs';
import { createStatusbarService } from '../../src/core/app/statusbar-service.mjs';

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness({
  initialSettings = {},
  initialTelemetryBySession = {},
  sessionsList = [],
  compactImpl = async () => ({ accepted: true, method: 'rpc' }),
  startNow = 10_000_000,
} = {}) {
  let now = startNow;
  const telemetryBySession = new Map(Object.entries(initialTelemetryBySession));
  const compactCalls = [];
  const listCalls = [];
  const telemetryCalls = [];

  const settingsState = {
    locale: 'ko',
    autoCompact: true,
    compactPrompt: '',
    defaultCustomLimit: null,
    modelLimits: new Map(),
    sessions: new Map(),
    customButtons: [],
    disabledRuntimeAddonIds: [],
    ...initialSettings,
  };

  const service = createStatusbarService({
    clock: () => now,
    telemetryPort: {
      listSessions: async () => {
        listCalls.push(now);
        return typeof sessionsList === 'function' ? sessionsList() : sessionsList;
      },
      getSessionTelemetry: async (sid) => {
        telemetryCalls.push(sid);
        return telemetryBySession.get(sid) ?? null;
      },
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false, fetchedAt: now }),
    },
    compactionPort: {
      compactSession: async (sid, opts) => {
        compactCalls.push({ sid, opts, at: now });
        return compactImpl(sid, opts);
      },
    },
    settingsPort: {
      read: async () => ({
        ...settingsState,
        modelLimits: new Map(settingsState.modelLimits),
        sessions: new Map(settingsState.sessions),
      }),
      update: async (patch) => {
        if ('defaultCustomLimit' in patch) settingsState.defaultCustomLimit = patch.defaultCustomLimit;
        if ('autoCompact' in patch) settingsState.autoCompact = patch.autoCompact;
        if (patch.modelLimit) {
          if (patch.modelLimit.limit === null) settingsState.modelLimits.delete(patch.modelLimit.model);
          else settingsState.modelLimits.set(patch.modelLimit.model, { limit: patch.modelLimit.limit, updatedAt: now });
        }
        if (patch.sessionLimit) {
          if (patch.sessionLimit.limit === null) settingsState.sessions.delete(patch.sessionLimit.sessionId);
          else settingsState.sessions.set(patch.sessionLimit.sessionId, { limit: patch.sessionLimit.limit, updatedAt: now });
        }
        return {
          ...settingsState,
          modelLimits: new Map(settingsState.modelLimits),
          sessions: new Map(settingsState.sessions),
        };
      },
    },
  });

  return {
    service,
    settingsState,
    telemetryBySession,
    compactCalls,
    listCalls,
    telemetryCalls,
    advance(ms) {
      now += ms;
    },
  };
}

test('TC-TDD-AC-01: auto-compact triggers immediately while RUNNING across all custom limit scopes and sizes (64K/128K/256K/384K) without looping', async () => {
  const cases = [
    {
      label: 'default 256K',
      settings: { defaultCustomLimit: 256_000 },
      limit: 256_000,
      source: 'default',
    },
    {
      label: 'model 128K',
      settings: { modelLimits: new Map([['Gemini 4 Neon (High)', { limit: 128_000, updatedAt: 1 }]]) },
      limit: 128_000,
      source: 'model',
    },
    {
      label: 'session 64K',
      settings: { sessions: new Map([['sess-run', { limit: 64_000, updatedAt: 1 }]]) },
      limit: 64_000,
      source: 'session',
    },
    {
      label: 'default 384K',
      settings: { defaultCustomLimit: 384_000 },
      limit: 384_000,
      source: 'default',
    },
  ];

  for (const tc of cases) {
    const h = createHarness({
      initialSettings: tc.settings,
      initialTelemetryBySession: {
        'sess-run': {
          sessionId: 'sess-run',
          status: 'CASCADE_RUN_STATUS_RUNNING',
          modelName: 'Gemini 4 Neon (High)',
          stepCount: 50,
          usedTokens: tc.limit,
          maxContextTokens: 512_000,
          lastCompactedStep: 10,
          compactionJustCompleted: false,
          hostCompactionInProgress: false,
          tokenBreakdown: [],
        },
      },
    });

    // 1. Immediately triggers while RUNNING at exact 100% boundary
    const snap1 = await h.service.getSessionSnapshot('sess-run');
    assert.equal(snap1.limitSource, tc.source, tc.label);
    assert.equal(snap1.exceededSoftLimit, true, tc.label);
    assert.equal(snap1.autoCompactTriggered, true, `${tc.label}: must trigger immediately while RUNNING`);
    await flush();
    assert.equal(h.compactCalls.length, 1, `${tc.label}: compactSession must be invoked once`);

    // 2. Subsequent poll while still RUNNING must NOT double-fire
    const snap2 = await h.service.getSessionSnapshot('sess-run');
    assert.equal(snap2.autoCompactTriggered, false, `${tc.label}: must not loop while waiting for drop`);
    await flush();
    assert.equal(h.compactCalls.length, 1, `${tc.label}: call count must remain 1`);
  }
});

test('TC-TDD-AC-02: auto-compact never fires while hostCompactionInProgress or compactionJustCompleted is true', async () => {
  const h = createHarness({
    initialSettings: { defaultCustomLimit: 256_000 },
    initialTelemetryBySession: {
      'sess-guard': {
        sessionId: 'sess-guard',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 100,
        usedTokens: 300_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 50,
        compactionJustCompleted: false,
        hostCompactionInProgress: true,
        tokenBreakdown: [],
      },
    },
  });

  const snapRunningCp = await h.service.getSessionSnapshot('sess-guard');
  assert.equal(snapRunningCp.compaction.inProgress, true);
  assert.equal(snapRunningCp.autoCompactTriggered, false);
  await flush();
  assert.equal(h.compactCalls.length, 0);

  // Also must not fire on the exact snapshot where compactionJustCompleted === true
  h.telemetryBySession.set('sess-guard', {
    ...h.telemetryBySession.get('sess-guard'),
    hostCompactionInProgress: false,
    lastCompactedStep: 100,
    compactionJustCompleted: true,
  });
  const snapJustDone = await h.service.getSessionSnapshot('sess-guard');
  assert.equal(snapJustDone.autoCompactTriggered, false);
  await flush();
  assert.equal(h.compactCalls.length, 0);
});

test('TC-TDD-AC-03: advancing lastCompactedStep updates stale pre-compaction baseline without immediate double-compact when post-compaction stays above limit', async () => {
  const h = createHarness({
    initialSettings: { defaultCustomLimit: 256_000 },
    initialTelemetryBySession: {
      'sess-rearm': {
        sessionId: 'sess-rearm',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 100,
        usedTokens: 324_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 50,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  // First auto-compact fires at 324K (step 100, lastCompactedStep 50)
  const snap1 = await h.service.getSessionSnapshot('sess-rearm');
  assert.equal(snap1.autoCompactTriggered, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // Compaction completes at step 105, dropping to 260K (still >= 256K limit)
  h.advance(10_000);
  h.telemetryBySession.set('sess-rearm', {
    ...h.telemetryBySession.get('sess-rearm'),
    stepCount: 105,
    usedTokens: 260_000,
    lastCompactedStep: 105,
    compactionJustCompleted: true,
  });
  const snapCompacted = await h.service.getSessionSnapshot('sess-rearm');
  assert.equal(snapCompacted.compaction.inProgress, false);
  assert.equal(snapCompacted.autoCompactTriggered, false);

  // 5s later at 262K (+2K only, within 90s cooldown): MUST NOT immediately double-compact!
  h.advance(5_000);
  h.telemetryBySession.set('sess-rearm', {
    ...h.telemetryBySession.get('sess-rearm'),
    stepCount: 112,
    usedTokens: 262_000,
    lastCompactedStep: 105,
    compactionJustCompleted: false,
  });
  const snapImmediate = await h.service.getSessionSnapshot('sess-rearm');
  assert.equal(
    snapImmediate.autoCompactTriggered,
    false,
    'Post-compaction tokens still >= limit must honor cooldown + growth guard instead of double-compacting',
  );
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // After 90s cooldown expires and real new work adds +20K from refreshed 260K baseline (282K < old 324K!):
  // MUST re-trigger cleanly, proving the stale 324K baseline was updated to 260K.
  h.advance(95_000);
  h.telemetryBySession.set('sess-rearm', {
    ...h.telemetryBySession.get('sess-rearm'),
    stepCount: 120,
    usedTokens: 282_000,
    lastCompactedStep: 105,
    compactionJustCompleted: false,
  });
  const snapNextCross = await h.service.getSessionSnapshot('sess-rearm');
  assert.equal(
    snapNextCross.autoCompactTriggered,
    true,
    'Advancing lastCompactedStep must refresh baseline from 324K to 260K so +20K growth after cooldown triggers',
  );
  await flush();
  assert.equal(h.compactCalls.length, 2);
});

test('TC-TDD-AC-04: auto-compact failure while RUNNING backs off briefly while RUNNING and retries immediately upon IDLE transition', async () => {
  let shouldFail = true;
  const h = createHarness({
    initialSettings: { defaultCustomLimit: 256_000 },
    initialTelemetryBySession: {
      'sess-retry': {
        sessionId: 'sess-retry',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 80,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
    compactImpl: async () => {
      if (shouldFail) return { accepted: false, method: 'rpc', reason: 'Host busy while running' };
      return { accepted: true, method: 'rpc' };
    },
  });

  // 1. Triggers while RUNNING -> fails
  const snap1 = await h.service.getSessionSnapshot('sess-retry');
  assert.equal(snap1.autoCompactTriggered, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // 2. 2s later while STILL RUNNING -> backoff prevents retry storm
  h.advance(2_000);
  const snap2 = await h.service.getSessionSnapshot('sess-retry');
  assert.equal(snap2.autoCompactTriggered, false);
  assert.ok(snap2.compaction.lastError);

  // 3. 1s later session becomes IDLE -> retries IMMEDIATELY without waiting 90s!
  shouldFail = false;
  h.advance(1_000);
  h.telemetryBySession.set('sess-retry', {
    ...h.telemetryBySession.get('sess-retry'),
    status: 'CASCADE_RUN_STATUS_IDLE',
  });
  const snapIdle = await h.service.getSessionSnapshot('sess-retry');
  assert.equal(snapIdle.autoCompactTriggered, true, 'Must retry immediately on RUNNING -> IDLE after RUNNING failure');
  await flush();
  assert.equal(h.compactCalls.length, 2);
});

test('TC-TDD-AC-05: compaction mutex stays active beyond 15s while hostCompactionInProgress is true and clears immediately when checkpoint finishes', async () => {
  const h = createHarness({
    initialSettings: { autoCompact: false },
    initialTelemetryBySession: {
      'sess-long-cp': {
        sessionId: 'sess-long-cp',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 500,
        usedTokens: 320_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 100,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  const req = await h.service.requestCompaction('sess-long-cp');
  assert.equal(req.accepted, true);

  // 25s later (> default 15s cooldown), host CHECKPOINT is still running -> MUST stay inProgress!
  h.advance(25_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    hostCompactionInProgress: true,
  });
  const snapMid = await h.service.getSessionSnapshot('sess-long-cp');
  assert.equal(snapMid.compaction.inProgress, true, 'Must stay inProgress while host CHECKPOINT is still running past 15s');

  // 47s later, CHECKPOINT completes -> clears immediately!
  h.advance(22_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    usedTokens: 32_000,
    lastCompactedStep: 501,
    compactionJustCompleted: true,
    hostCompactionInProgress: false,
  });
  const snapDone = await h.service.getSessionSnapshot('sess-long-cp');
  assert.equal(snapDone.compaction.inProgress, false);
  assert.equal(snapDone.compaction.status, 'completed');
});

test('TC-TDD-AC-06: sweepActiveSessions protects background RUNNING sessions under global/model limits and skips idle/unconfigured sessions', async () => {
  const startNow = 20_000_000;
  const h = createHarness({
    startNow,
    initialSettings: { defaultCustomLimit: 256_000, autoCompact: true },
    sessionsList: [
      { sessionId: 'sess-bg-over', status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedMs: startNow - 1_000 },
      { sessionId: 'sess-bg-ok', status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedMs: startNow - 2_000 },
      { sessionId: 'sess-old-idle', status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedMs: startNow - 600_000 },
    ],
    initialTelemetryBySession: {
      'sess-bg-over': {
        sessionId: 'sess-bg-over',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 40,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
      'sess-bg-ok': {
        sessionId: 'sess-bg-ok',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 20,
        usedTokens: 100_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
      'sess-old-idle': {
        sessionId: 'sess-old-idle',
        status: 'CASCADE_RUN_STATUS_IDLE',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 10,
        usedTokens: 300_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  assert.equal(typeof h.service.sweepActiveSessions, 'function', 'Service must expose sweepActiveSessions()');
  const res = await h.service.sweepActiveSessions();
  await flush();

  assert.equal(res.checked, 2, 'Must check only active RUNNING / recently modified sessions');
  assert.equal(res.triggered, 1, 'Must trigger auto-compact on sess-bg-over');
  assert.deepEqual(h.compactCalls.map((c) => c.sid), ['sess-bg-over']);
  assert.equal(h.telemetryCalls.includes('sess-old-idle'), false, 'Must not waste RPCs on old idle sessions');

  // When autoCompact is OFF or no custom limits exist -> zero RPCs!
  h.settingsState.autoCompact = false;
  const listBefore = h.listCalls.length;
  const resOff = await h.service.sweepActiveSessions();
  assert.equal(resOff.checked, 0);
  assert.equal(h.listCalls.length, listBefore, 'Must skip listSessions RPC when autoCompact is disabled');

  h.settingsState.autoCompact = true;
  h.settingsState.defaultCustomLimit = null;
  const resNoLimit = await h.service.sweepActiveSessions();
  assert.equal(resNoLimit.checked, 0);
  assert.equal(h.listCalls.length, listBefore, 'Must skip listSessions RPC when no custom limits are configured');
});

test('TC-TDD-AC-07: mapSessionTelemetry falls back to chatModel.usage total tokens when both cwu and cwm estimatedTokensUsed are absent', () => {
  // Gemini/Anthropic: uncached inputTokens + cacheReadTokens
  const geminiFallback = mapSessionTelemetry({
    requestedSessionId: 'sess-usage-fallback',
    streamFrame: { update: { conversationId: 'sess-usage-fallback', status: 'CASCADE_RUN_STATUS_RUNNING' } },
    generatorMetadata: [
      {
        stepIndices: [42],
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (High)',
          usage: {
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            inputTokens: '12000',
            cacheReadTokens: '248000',
          },
          chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512_000 } },
        },
      },
    ],
  });
  assert.equal(geminiFallback.usedTokens, 260_000);
  assert.equal(geminiFallback.usedTokensSource, 'usage_fallback');

  // OpenAI: inputTokens already includes cacheReadTokens
  const openaiFallback = mapSessionTelemetry({
    requestedSessionId: 'sess-openai-fallback',
    streamFrame: { update: { conversationId: 'sess-openai-fallback', status: 'CASCADE_RUN_STATUS_RUNNING' } },
    generatorMetadata: [
      {
        stepIndices: [10],
        chatModel: {
          modelDisplayName: 'GPT-OSS 120B',
          usage: {
            apiProvider: 'API_PROVIDER_OPENAI',
            inputTokens: '180000',
            cacheReadTokens: '120000',
          },
          chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256_000 } },
        },
      },
    ],
  });
  assert.equal(openaiFallback.usedTokens, 180_000);
  assert.equal(openaiFallback.usedTokensSource, 'usage_fallback');
});
