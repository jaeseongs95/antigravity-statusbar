import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSidecarApiClient } from '../../src/adapters/antigravity/addon/api-client.mjs';
import { createBarView } from '../../src/adapters/antigravity/addon/bar-view.mjs';
import { createInlineI18n } from '../../src/adapters/antigravity/addon/i18n.mjs';
import { createAddonRuntimePublisher } from '../../src/adapters/antigravity/addon/runtime-publisher.mjs';
import { createAntigravityCompactionAdapter } from '../../src/adapters/antigravity/compaction-adapter.mjs';
import { createLsTransport } from '../../src/adapters/antigravity/ls-transport.mjs';
import {
  createAntigravityTelemetryAdapter,
  mapTrajectorySummaries,
} from '../../src/adapters/antigravity/telemetry-mapper.mjs';
import { createJsonSettingsStore } from '../../src/adapters/storage/json-settings-store.mjs';
import { createStatusbarService } from '../../src/core/app/statusbar-service.mjs';
import { createStatusbarApp } from '../../src/ui/app.js';
import { installPlugin } from '../../scripts/install-plugin.mjs';
import { runAddonCli } from '../../scripts/statusbar-addon.mjs';

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createServiceHarness({
  initialSettings = {},
  initialTelemetryBySession = {},
  sessionsList = [],
  compactImpl = async () => ({ accepted: true, method: 'rpc' }),
  sendCommandImpl = async () => ({ accepted: true, method: 'rpc' }),
  startNow = 20_000_000,
} = {}) {
  let now = startNow;
  const telemetryBySession = new Map(Object.entries(initialTelemetryBySession));
  const compactCalls = [];
  const commandCalls = [];
  const telemetryCalls = [];

  const settingsState = {
    locale: 'ko',
    autoCompact: true,
    autoCompactWhileRunning: 'resume',
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
      listSessions: async () => (typeof sessionsList === 'function' ? sessionsList() : sessionsList),
      getSessionTelemetry: async (sid, opts) => {
        telemetryCalls.push({ sid, opts });
        return telemetryBySession.get(sid) ?? null;
      },
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false, fetchedAt: now }),
    },
    compactionPort: {
      compactSession: async (sid, opts) => {
        compactCalls.push({ sid, opts, at: now });
        return compactImpl(sid, opts);
      },
      sendCommand: async (sid, text) => {
        commandCalls.push({ sid, text, at: now });
        return sendCommandImpl(sid, text);
      },
    },
    settingsPort: {
      read: async () => ({
        ...settingsState,
        modelLimits: new Map(settingsState.modelLimits),
        sessions: new Map(settingsState.sessions),
        customButtons: settingsState.customButtons.map((b) => ({ ...b })),
      }),
      update: async (patch) => {
        if ('defaultCustomLimit' in patch) settingsState.defaultCustomLimit = patch.defaultCustomLimit;
        if ('autoCompact' in patch) settingsState.autoCompact = patch.autoCompact;
        if ('autoCompactWhileRunning' in patch) {
          settingsState.autoCompactWhileRunning = patch.autoCompactWhileRunning;
        }
        if ('customButtons' in patch) settingsState.customButtons = patch.customButtons;
        return {
          ...settingsState,
          modelLimits: new Map(settingsState.modelLimits),
          sessions: new Map(settingsState.sessions),
          customButtons: settingsState.customButtons.map((b) => ({ ...b })),
        };
      },
    },
  });

  return {
    service,
    settingsState,
    telemetryBySession,
    compactCalls,
    commandCalls,
    telemetryCalls,
    advance(ms) {
      now += ms;
    },
  };
}

function createFakeDomElement(tag = 'div') {
  const attrs = new Map();
  const listeners = new Map();
  const classSet = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    title: '',
    disabled: false,
    style: {},
    children: [],
    parentNode: null,
    get firstChild() {
      return this.children[0] || null;
    },
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classSet.has(c)) classSet.delete(c);
          else classSet.add(c);
        } else if (force) classSet.add(c);
        else classSet.delete(c);
      },
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  return el;
}

test('TC-P0-00a (ISS-00): auto-compact while RUNNING dispatches single guarded auto-resume once compaction completes into IDLE, and respects all negative guards', async () => {
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume', locale: 'ko' },
    initialTelemetryBySession: {
      'sess-active': {
        sessionId: 'sess-active',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 50,
        usedTokens: 262_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 10,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  // 1. Auto-compact triggers while RUNNING
  const snap1 = await h.service.getSessionSnapshot('sess-active');
  assert.equal(snap1.autoCompactTriggered, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);
  assert.equal(h.commandCalls.length, 0);

  // 2. Host finishes SYSTEM CHECKPOINT and drops session into IDLE (exact Antigravity behavior)
  h.advance(12_000);
  h.telemetryBySession.set('sess-active', {
    ...h.telemetryBySession.get('sess-active'),
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 53,
    usedTokens: 48_000,
    lastCompactedStep: 52,
    compactionJustCompleted: true,
    hostCompactionInProgress: false,
  });

  const snapAfter = await h.service.getSessionSnapshot('sess-active');
  assert.equal(snapAfter.autoResumeTriggered, true, 'Must auto-resume interrupted RUNNING task once compacted to IDLE');
  await flush();
  assert.equal(h.commandCalls.length, 1);
  assert.equal(h.commandCalls[0].sid, 'sess-active');
  assert.ok(h.commandCalls[0].text.length > 10);

  // 3. Subsequent poll while IDLE must NOT double-send resume
  h.advance(2_000);
  const snapSecond = await h.service.getSessionSnapshot('sess-active');
  assert.equal(snapSecond.autoResumeTriggered, false);
  await flush();
  assert.equal(h.commandCalls.length, 1);

  // 4. Negative guard: manual /compact while RUNNING must NEVER auto-resume
  const hManual = createServiceHarness({
    initialSettings: { autoCompact: false },
    initialTelemetryBySession: {
      'sess-manual': {
        sessionId: 'sess-manual',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 40,
        usedTokens: 280_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 5,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });
  await hManual.service.requestCompaction('sess-manual');
  hManual.advance(8_000);
  hManual.telemetryBySession.set('sess-manual', {
    ...hManual.telemetryBySession.get('sess-manual'),
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 43,
    usedTokens: 42_000,
    lastCompactedStep: 42,
    compactionJustCompleted: true,
  });
  const snapManualDone = await hManual.service.getSessionSnapshot('sess-manual');
  assert.equal(snapManualDone.autoResumeTriggered, false);
  await flush();
  assert.equal(hManual.commandCalls.length, 0);

  // 5. Negative guard: auto-compact on an already IDLE session must NEVER auto-resume
  const hIdle = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume' },
    initialTelemetryBySession: {
      'sess-idle': {
        sessionId: 'sess-idle',
        status: 'CASCADE_RUN_STATUS_IDLE',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 40,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 5,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });
  await hIdle.service.getSessionSnapshot('sess-idle');
  await flush();
  assert.equal(hIdle.compactCalls.length, 1);
  hIdle.advance(8_000);
  hIdle.telemetryBySession.set('sess-idle', {
    ...hIdle.telemetryBySession.get('sess-idle'),
    stepCount: 43,
    usedTokens: 40_000,
    lastCompactedStep: 42,
    compactionJustCompleted: true,
  });
  await hIdle.service.getSessionSnapshot('sess-idle');
  await flush();
  assert.equal(hIdle.commandCalls.length, 0);

  // 6. Negative guard: CANCELLED status after compaction must NEVER auto-resume
  const hCancelled = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume' },
    initialTelemetryBySession: {
      'sess-cancel': {
        sessionId: 'sess-cancel',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 60,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 5,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });
  await hCancelled.service.getSessionSnapshot('sess-cancel');
  await flush();
  hCancelled.advance(6_000);
  hCancelled.telemetryBySession.set('sess-cancel', {
    ...hCancelled.telemetryBySession.get('sess-cancel'),
    status: 'CASCADE_RUN_STATUS_CANCELLED',
    stepCount: 63,
    usedTokens: 42_000,
    lastCompactedStep: 62,
    compactionJustCompleted: true,
  });
  await hCancelled.service.getSessionSnapshot('sess-cancel');
  await flush();
  assert.equal(hCancelled.commandCalls.length, 0);
});

test('TC-P0-00b (ISS-00): autoCompactWhileRunning="defer" defers compaction while RUNNING and fires immediately upon IDLE without auto-resume', async () => {
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'defer' },
    initialTelemetryBySession: {
      'sess-defer': {
        sessionId: 'sess-defer',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 30,
        usedTokens: 275_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  const snapRun = await h.service.getSessionSnapshot('sess-defer');
  assert.equal(snapRun.autoCompactTriggered, false);
  assert.equal(snapRun.autoCompactDeferred, true);
  await flush();
  assert.equal(h.compactCalls.length, 0);

  // Transition to IDLE -> fires immediately
  h.advance(3_000);
  h.telemetryBySession.set('sess-defer', {
    ...h.telemetryBySession.get('sess-defer'),
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 35,
  });
  const snapIdle = await h.service.getSessionSnapshot('sess-defer');
  assert.equal(snapIdle.autoCompactTriggered, true);
  assert.equal(snapIdle.autoCompactDeferred, false);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // After completion, stays IDLE without resume prompt
  h.advance(8_000);
  h.telemetryBySession.set('sess-defer', {
    ...h.telemetryBySession.get('sess-defer'),
    stepCount: 38,
    usedTokens: 45_000,
    lastCompactedStep: 37,
    compactionJustCompleted: true,
  });
  await h.service.getSessionSnapshot('sess-defer');
  await flush();
  assert.equal(h.commandCalls.length, 0);
});

test('TC-P0-00c (ISS-00): compaction-adapter sendCommand uses SendUserCascadeMessage RPC first for plain text continuation prompts (no spawn)', async () => {
  const rpcCalls = [];
  let spawnCount = 0;
  const adapter = createAntigravityCompactionAdapter({
    lsTransport: {
      callUnaryRpc: async (method, payload) => {
        rpcCalls.push({ method, payload });
        return {};
      },
    },
    agentApiExePath: process.execPath,
    spawnFn: () => {
      spawnCount += 1;
      throw new Error('spawn must not be called when RPC succeeds for plain text');
    },
  });

  const res = await adapter.sendCommand('sess-rpc-1', '중단된 작업을 이어서 진행해 주세요.');
  assert.equal(res.accepted, true);
  assert.equal(res.method, 'rpc');
  assert.equal(spawnCount, 0);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].method, 'SendUserCascadeMessage');
  assert.deepEqual(rpcCalls[0].payload, {
    cascadeId: 'sess-rpc-1',
    items: [{ text: '중단된 작업을 이어서 진행해 주세요.' }],
  });
});

test('TC-P0-03 (ISS-03): polling Session B must not prematurely expire Session A 300s host compaction lock, and <4MB sessions probe tail steps when requested', async () => {
  const h = createServiceHarness({
    initialSettings: { autoCompact: false },
    initialTelemetryBySession: {
      'sess-A': {
        sessionId: 'sess-A',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 80,
        usedTokens: 290_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 20,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
      'sess-B': {
        sessionId: 'sess-B',
        status: 'CASCADE_RUN_STATUS_IDLE',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 10,
        usedTokens: 30_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  await h.service.requestCompaction('sess-A');
  h.advance(10_000);
  h.telemetryBySession.set('sess-A', {
    ...h.telemetryBySession.get('sess-A'),
    hostCompactionInProgress: true,
  });
  const snapA10 = await h.service.getSessionSnapshot('sess-A');
  assert.equal(snapA10.compaction.inProgress, true);

  // Advance past 15s (to 20s) and poll Session B (which is NOT compacting)
  h.advance(10_000);
  await h.service.getSessionSnapshot('sess-B');

  // Session A lock must STILL be active (not pruned at 15s by Session B poll!)
  await assert.rejects(
    () => h.service.requestCompaction('sess-A'),
    (err) => err?.code === 'COMPACTION_IN_PROGRESS' && err?.httpStatus === 409,
    'Session B poll must not evict Session A host compaction lock before 300s',
  );

  // <4MB stream session with includeTailSteps: true must still query getTailTrajectorySteps
  let tailStepsCalled = 0;
  const telemetryAdapter = createAntigravityTelemetryAdapter({
    callUnaryRpc: async () => ({
      trajectorySummaries: {
        'sess-small': {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          stepCount: 12,
        },
      },
    }),
    readFirstStreamFrame: async () => ({
      update: {
        conversationId: 'sess-small',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        trajectorySlice: { totalGeneratorMetadataLength: 1 },
      },
    }),
    getTailGeneratorMetadata: async () => [],
    getTailTrajectorySteps: async () => {
      tailStepsCalled += 1;
      return {
        stepOffset: 10,
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CHECKPOINT',
            status: 'CORTEX_STEP_STATUS_RUNNING',
          },
        ],
      };
    },
    getQuotaSummaryRaw: async () => ({ data: null, stale: false, fetchedAt: Date.now() }),
  });

  const mapped = await telemetryAdapter.getSessionTelemetry('sess-small', { includeTailSteps: true });
  assert.equal(tailStepsCalled, 1, 'Expected getTailTrajectorySteps to be called when includeTailSteps is true');
  assert.equal(mapped.hostCompactionInProgress, true);
});

test('TC-P0-04 (ISS-04): ls-transport must not amplify 504 timeouts or 502 errors into 12 sequential probes', async () => {
  let metaCalls = 0;
  let stepCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
      metaCalls += 1;
      res.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ message: 'upstream unavailable' }));
      return;
    }
    if (req.url?.includes('GetCascadeTrajectorySteps')) {
      stepCalls += 1;
      res.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ message: 'upstream unavailable' }));
      return;
    }
    res.writeHead(404, { connection: 'close' });
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const transport = createLsTransport({
      lsAddress: `http://127.0.0.1:${port}`,
      csrfToken: 'test-csrf-token-1234',
      timeoutMs: 500,
    });

    await assert.rejects(() => transport.getTailGeneratorMetadata('sess-err', 60));
    assert.equal(metaCalls, 1, `Expected 1 RPC call on non-oversize error, got ${metaCalls}`);

    await assert.rejects(() => transport.getTailTrajectorySteps('sess-err', 60));
    assert.equal(stepCalls, 1, `Expected 1 RPC call on non-oversize error, got ${stepCalls}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('TC-P0-05 (ISS-05): transient usedTokens=null must not wipe cooldown, and low custom limit (32K) must not infinite-loop after compaction', async () => {
  // Part A: transient null must not reset waitingForDrop/cooldown
  const hNull = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000 },
    initialTelemetryBySession: {
      'sess-null': {
        sessionId: 'sess-null',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 50,
        usedTokens: 265_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 10,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  const s1 = await hNull.service.getSessionSnapshot('sess-null');
  assert.equal(s1.autoCompactTriggered, true);
  await flush();
  assert.equal(hNull.compactCalls.length, 1);

  // Advance past 15s lock, inject transient null telemetry
  hNull.advance(16_000);
  hNull.telemetryBySession.set('sess-null', {
    ...hNull.telemetryBySession.get('sess-null'),
    usedTokens: null,
  });
  await hNull.service.getSessionSnapshot('sess-null');

  // Next poll returns 265_000 again (still within 90s cooldown) -> MUST NOT re-fire!
  hNull.advance(2_000);
  hNull.telemetryBySession.set('sess-null', {
    ...hNull.telemetryBySession.get('sess-null'),
    usedTokens: 265_000,
  });
  const s3 = await hNull.service.getSessionSnapshot('sess-null');
  assert.equal(s3.autoCompactTriggered, false, 'Transient null must not wipe auto-compact cooldown');
  await flush();
  assert.equal(hNull.compactCalls.length, 1);

  // Part B: Low custom limit (32K) where post-compaction summary itself is 35K -> must retain cooldown
  const hLow = createServiceHarness({
    initialSettings: { defaultCustomLimit: 32_000 },
    initialTelemetryBySession: {
      'sess-low': {
        sessionId: 'sess-low',
        status: 'CASCADE_RUN_STATUS_IDLE',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 30,
        usedTokens: 40_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 10,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  const l1 = await hLow.service.getSessionSnapshot('sess-low');
  assert.equal(l1.autoCompactTriggered, true);
  await flush();
  assert.equal(hLow.compactCalls.length, 1);

  // Compaction completes, lastCompactedStep advances, but usedTokens is still 35_000 >= 32_000
  hLow.advance(8_000);
  hLow.telemetryBySession.set('sess-low', {
    ...hLow.telemetryBySession.get('sess-low'),
    stepCount: 33,
    usedTokens: 35_000,
    lastCompactedStep: 32,
    compactionJustCompleted: true,
  });
  await hLow.service.getSessionSnapshot('sess-low');

  // Next step flips compactionJustCompleted=false, usedTokens=35_500 (+500 tokens, +5s) -> must NOT loop!
  hLow.advance(5_000);
  hLow.telemetryBySession.set('sess-low', {
    ...hLow.telemetryBySession.get('sess-low'),
    stepCount: 34,
    usedTokens: 35_500,
    lastCompactedStep: 32,
    compactionJustCompleted: false,
  });
  const l3 = await hLow.service.getSessionSnapshot('sess-low');
  assert.equal(l3.autoCompactTriggered, false, 'Low limit post-compact >= limit must retain cooldown and not loop');
  await flush();
  assert.equal(hLow.compactCalls.length, 1);
});

test('TC-P0-06 (ISS-06): install-plugin refuses symlinked data directory instead of following or silently ignoring it', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-inst-p0-'));
  const destDir = path.join(tmpRoot, 'dest');
  const outsideDir = path.join(tmpRoot, 'outside-secret');
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
  try {
    await fs.mkdir(destDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'settings.json'), '{"locale":"ko"}', 'utf8');
    try {
      await fs.symlink(outsideDir, path.join(destDir, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (process.platform === 'win32' && err?.code === 'EPERM') {
        t.skip('Symlink/junction creation not permitted in this Windows environment');
        return;
      }
      throw err;
    }

    await assert.rejects(
      () => installPlugin({ repoRoot, destDir, dryRun: false }),
      /symlink/i,
      'installPlugin must fail-fast when destDir/data is a symlink/junction',
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('TC-P0-07 (ISS-07): concurrent addon upserts preserve all buttons (no RMW lost update) and CLI rejects missing --data-dir value & invalid --enabled', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-rmw-p0-'));
  try {
    const store = createJsonSettingsStore({ dataDir: tmpDir });
    const service = createStatusbarService({
      telemetryPort: {
        listSessions: async () => [],
        getSessionTelemetry: async () => null,
        getQuotaSummary: async () => ({ available: false, groups: [], stale: false, fetchedAt: Date.now() }),
      },
      compactionPort: { compactSession: async () => ({ accepted: true, method: 'rpc' }) },
      settingsPort: store,
    });

    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        service.upsertAddon({
          id: `btn-${i}`,
          label: `Btn ${i}`,
          command: `/cmd-${i}`,
        }),
      ),
    );

    const saved = await store.read();
    assert.equal(saved.customButtons.length, 5, `Expected all 5 concurrent addons preserved, got ${saved.customButtons.length}`);

    // CLI strict flag validation
    await assert.rejects(
      () => runAddonCli(['list', '--data-dir']),
      /data-dir/i,
      'Missing --data-dir value must throw instead of silently targeting production data dir',
    );
    await assert.rejects(
      () => runAddonCli(['toggle', '--id', 'btn-1', '--enabled', 'maybe', '--data-dir', tmpDir]),
      /enabled/i,
      'Invalid --enabled value must throw',
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('TC-P0-08 (ISS-08): runtime-publisher teardownSync atomically revokes token synchronously', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-pub-p0-'));
  try {
    const pub = createAddonRuntimePublisher({ pluginRootDir: tmpDir });
    const token = 'secret-sidecar-token-for-sync-teardown';
    const target = await pub.publish({ baseUrl: 'http://127.0.0.1:43210', token });
    const activeText = await fs.readFile(target, 'utf8');
    assert.ok(activeText.includes(token));

    assert.equal(typeof pub.teardownSync, 'function', 'runtime-publisher must expose teardownSync()');
    pub.teardownSync();
    const afterText = await fs.readFile(target, 'utf8');
    assert.equal(afterText.includes(token), false, 'teardownSync must purge token from disk');
    assert.ok(afterText.includes('standby'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('TC-P0-09 (ISS-09 & ISS-01): AUX_PANE syncLimitInputs does not leak model limit into session input, and index.html avoids type=number', async () => {
  const indexHtmlPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '../../src/ui/index.html',
  );
  const html = await fs.readFile(indexHtmlPath, 'utf8');
  assert.equal(
    /id="limit-custom-input"[^>]*type="number"/.test(html),
    false,
    'src/ui/index.html limit-custom-input must not use type="number"',
  );

  const ids = [
    'app', 'panel-title', 'conn-badge', 'btn-locale', 'lbl-session', 'session-mode-badge',
    'session-select', 'lbl-context', 'context-pct', 'context-progress', 'context-progress-fill',
    'context-tokens', 'context-limit-tag', 'soft-limit-banner', 'soft-limit-banner-text',
    'btn-compact', 'btn-context-detail', 'compact-status', 'context-detail-panel',
    'lbl-detail-title', 'detail-steps', 'detail-model', 'breakdown-list', 'lbl-custom-limit',
    'limit-scope-select', 'limit-preset-select', 'limit-custom-input', 'btn-apply-limit',
    'limit-feedback', 'lbl-cache', 'cache-pct', 'cache-detail', 'lbl-quota',
    'quota-stale-badge', 'quota-groups',
  ];
  const byId = new Map(ids.map((id) => [id, createFakeDomElement('div')]));
  byId.get('limit-scope-select').value = 'session';
  const doc = {
    hidden: false,
    documentElement: { lang: 'en' },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => createFakeDomElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const app = createStatusbarApp({
    doc,
    win: { setInterval: () => 1, clearInterval: () => {} },
    bridge: {
      listSessions: async () => ({ sessions: [{ sessionId: 'sess-m1', title: 'M1' }] }),
      getSessionSnapshot: async () => ({
        sessionId: 'sess-m1',
        usedTokens: 50_000,
        effectiveLimit: 128_000,
        customLimit: 128_000,
        limitSource: 'model',
        usagePercent: 39.1,
        thresholdLevel: 'normal',
        exceededSoftLimit: false,
        cacheHitPercent: 80,
        cacheReadTokens: 40_000,
        inputTokens: 10_000,
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 5,
        tokenBreakdown: [],
        compaction: { inProgress: false, status: 'idle' },
        locale: 'en',
      }),
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false }),
      getSettings: async () => ({ locale: 'en', defaultCustomLimit: null, sessions: [] }),
      updateSettings: async () => ({ locale: 'en', defaultCustomLimit: null, sessions: [] }),
      requestCompaction: async () => ({ accepted: true }),
    },
  });

  await app.start();
  try {
    assert.equal(
      byId.get('limit-custom-input').value,
      '',
      'Model global limit must NOT be populated into session custom limit input',
    );
  } finally {
    app.dispose();
  }
});

test('TC-P0-10 (ISS-10 & ISS-14 & ISS-13): 24h bucket label accuracy, 99.7% rounding, api-client disconnect reset, subagent sweep exclusion, and addon command tooltip', async () => {
  // 1. 24h bucket must NOT be mislabeled as Weekly/주간한도; 99.7% non-exceeded must display 99%
  const doc = { createElement: (tag) => createFakeDomElement(tag) };
  const i18n = createInlineI18n('ko');
  const view = createBarView({ doc, i18n });

  view.renderSnapshot({
    snap: {
      usedTokens: 255_232,
      effectiveLimit: 256_000,
      usagePercent: 99.7,
      exceededSoftLimit: false,
      cacheHitPercent: 90,
      compaction: { inProgress: false, status: 'idle' },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
  });
  assert.ok(
    view.ctxTextEl.textContent.includes('99%'),
    `Expected 99% for non-exceeded 99.7%, got "${view.ctxTextEl.textContent}"`,
  );

  view.renderQuota(
    {
      available: true,
      stale: false,
      groups: [
        {
          label: 'Gemini Models',
          buckets: [{ window: '24h', remainingPercent: 72, resetTime: '2026-11-24T00:00:00Z' }],
        },
      ],
    },
    'Gemini 4 Neon (High)',
  );
  assert.equal(
    view.quotaEl.textContent.includes('주간한도'),
    false,
    `24h bucket must not be labeled 주간한도, got "${view.quotaEl.textContent}"`,
  );
  assert.ok(view.quotaEl.title.includes('2026-11-24'), 'Quota tooltip should include resetTime');

  // P1 ISS-13: Persisted custom button tooltip includes executed command
  view.renderAddonButtons({
    persistedButtons: [
      { id: 'plan', label: 'Plan', command: '/plan', description: 'Run plan', enabled: true },
    ],
    runtimeButtons: [],
    onPersistedClick: () => {},
    onRuntimeClick: () => {},
  });
  const btn = view.customBtnsContainer.children[0];
  assert.ok(btn.title.includes('/plan'), `Addon button tooltip must include command, got "${btn.title}"`);

  // 2. api-client resets connected=false on network error
  let failNext = false;
  const client = createSidecarApiClient({
    baseUrl: 'http://127.0.0.1:43210',
    token: 'test-token-1234567890',
    fetchImpl: async () => {
      if (failNext) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await client.post('/api/health', {});
  assert.equal(client.isConnected(), true);
  failNext = true;
  await assert.rejects(() => client.post('/api/snapshot', {}));
  assert.equal(client.isConnected(), false, 'api-client must flip isConnected() to false on network failure');

  // 3. ISS-14: mapTrajectorySummaries detects subagent & sweepActiveSessions excludes subagents
  const mappedSessions = mapTrajectorySummaries({
    trajectorySummaries: {
      'sess-main': {
        summary: 'Main task',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 20,
        lastModifiedTime: new Date().toISOString(),
      },
      'sess-sub': {
        summary: 'Subagent task',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 15,
        parentCascadeId: 'sess-main',
        lastModifiedTime: new Date().toISOString(),
      },
    },
  });
  const sub = mappedSessions.find((s) => s.sessionId === 'sess-sub');
  assert.equal(sub?.isSubagent, true, 'Trajectory with parentCascadeId must map isSubagent=true');

  const hSweep = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000 },
    sessionsList: [
      { sessionId: 'sess-main', status: 'CASCADE_RUN_STATUS_RUNNING', isSubagent: false, lastModifiedMs: 20_000_000 },
      { sessionId: 'sess-sub', status: 'CASCADE_RUN_STATUS_RUNNING', isSubagent: true, lastModifiedMs: 20_000_000 },
    ],
    initialTelemetryBySession: {
      'sess-main': {
        sessionId: 'sess-main',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 20,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
      'sess-sub': {
        sessionId: 'sess-sub',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 15,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: null,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });
  await hSweep.service.sweepActiveSessions();
  await flush();
  assert.equal(hSweep.compactCalls.length, 1);
  assert.equal(hSweep.compactCalls[0].sid, 'sess-main', 'sweepActiveSessions must exclude subagents by default');
});
