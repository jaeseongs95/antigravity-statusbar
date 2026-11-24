import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
import { startSidecar } from '../../src/adapters/antigravity/sidecar-entry.mjs';
import {
  createAntigravityTelemetryAdapter,
  mapSessionTelemetry,
  mapTrajectorySummaries,
} from '../../src/adapters/antigravity/telemetry-mapper.mjs';
import { createJsonSettingsStore } from '../../src/adapters/storage/json-settings-store.mjs';
import { createStatusbarService } from '../../src/core/app/statusbar-service.mjs';
import { DomainError, ERROR_CODES } from '../../src/core/i18n/error-codes.mjs';
import { buildAutoResumePrompt } from '../../src/core/model/context-policy.mjs';
import { createStatusbarApp } from '../../src/ui/app.js';
import { installPlugin, resolveInstallWorkParent } from '../../scripts/install-plugin.mjs';
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
    options: [],
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
      if (child.tagName === 'OPTION') this.options.push(child);
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

test('TC-P0-00c (ISS-00): compaction-adapter sendCommand prefers agentapi send-message with SendUserCascadeMessage RPC fallback', async () => {
  const spawnCalls = [];
  const rpcCalls = [];
  const makeFakeSpawn = (exitCode = 0, stderrText = '') => (exe, args, opts) => {
    spawnCalls.push({ exe, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    queueMicrotask(() => {
      if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
      child.exitCode = exitCode;
      child.emit('close', exitCode);
    });
    return child;
  };

  // 1. Primary path when agentApiExePath is configured: official agentapi send-message (shell: false)
  const adapterPrimary = createAntigravityCompactionAdapter({
    lsTransport: {
      callUnaryRpc: async (method, payload) => {
        rpcCalls.push({ method, payload });
        return {};
      },
    },
    agentApiExePath: process.execPath,
    spawnFn: makeFakeSpawn(0),
  });

  const resPrimary = await adapterPrimary.sendCommand(
    'sess-cmd-1',
    '중단된 작업을 이어서 진행해 주세요.',
  );
  assert.equal(resPrimary.accepted, true);
  assert.equal(resPrimary.method, 'agentapi');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].opts?.shell, false);
  assert.deepEqual(spawnCalls[0].args, [
    'agentapi',
    'send-message',
    'sess-cmd-1',
    '중단된 작업을 이어서 진행해 주세요.',
  ]);
  assert.equal(rpcCalls.length, 0);

  // 2. Fallback path when agentapi exits non-zero: falls back cleanly to SendUserCascadeMessage RPC
  const adapterFallback = createAntigravityCompactionAdapter({
    lsTransport: {
      callUnaryRpc: async (method, payload) => {
        rpcCalls.push({ method, payload });
        return {};
      },
    },
    agentApiExePath: process.execPath,
    spawnFn: makeFakeSpawn(1, 'agentapi busy'),
  });

  const resFallback = await adapterFallback.sendCommand(
    'sess-cmd-2',
    '중단된 작업을 이어서 진행해 주세요.',
  );
  assert.equal(resFallback.accepted, true);
  assert.equal(resFallback.method, 'rpc');
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].method, 'SendUserCascadeMessage');
  assert.deepEqual(rpcCalls[0].payload, {
    cascadeId: 'sess-cmd-2',
    items: [{ text: '중단된 작업을 이어서 진행해 주세요.' }],
  });

  // 3. Fallback path when agentApiExePath is absent: direct SendUserCascadeMessage RPC
  const adapterRpcOnly = createAntigravityCompactionAdapter({
    lsTransport: {
      callUnaryRpc: async (method, payload) => {
        rpcCalls.push({ method, payload });
        return {};
      },
    },
    agentApiExePath: null,
  });

  const resRpcOnly = await adapterRpcOnly.sendCommand(
    'sess-cmd-3',
    'Please continue from where you left off.',
  );
  assert.equal(resRpcOnly.accepted, true);
  assert.equal(resRpcOnly.method, 'rpc');
  assert.equal(rpcCalls.length, 2);
});

test('TC-P0-00d (v3.1.1): transient RUNNING after CHECKPOINT DONE preserves pendingAutoResume until IDLE, cancels on real host self-resume, and surfaces sendCommand non-acceptance', async () => {
  // 1. Reproduce live b9bf40a9 race: CHECKPOINT DONE observed while status is still transiently RUNNING
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume', locale: 'ko' },
    initialTelemetryBySession: {
      'sess-b9bf40a9': {
        sessionId: 'sess-b9bf40a9',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 2415,
        usedTokens: 270_700,
        usedTokensSource: 'estimated',
        maxContextTokens: 512_000,
        lastCompactedStep: 1900,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  const snap1 = await h.service.getSessionSnapshot('sess-b9bf40a9');
  assert.equal(snap1.autoCompactTriggered, true);
  assert.equal(snap1.autoResumePending, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // Poll 2 (t+3s): CHECKPOINT DONE arrives while host status is still transiently RUNNING
  h.advance(3_000);
  h.telemetryBySession.set('sess-b9bf40a9', {
    ...h.telemetryBySession.get('sess-b9bf40a9'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 2417,
    usedTokens: 48_000,
    usedTokensSource: 'after_compaction',
    lastCompactedStep: 2416,
    compactionJustCompleted: true,
    hostCompactionInProgress: false,
  });
  const snap2 = await h.service.getSessionSnapshot('sess-b9bf40a9');
  assert.equal(snap2.compaction.status, 'completed');
  assert.equal(snap2.autoResumeTriggered, false);
  assert.equal(
    snap2.autoResumePending,
    true,
    'Transient RUNNING right after CHECKPOINT DONE must NOT discard pendingAutoResume',
  );

  // Poll 3 (t+4s): Second transient RUNNING poll (compaction.status is now idle, compactionJustCompleted=false)
  h.advance(1_000);
  h.telemetryBySession.set('sess-b9bf40a9', {
    ...h.telemetryBySession.get('sess-b9bf40a9'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 2417,
    usedTokens: 48_000,
    usedTokensSource: 'estimated',
    lastCompactedStep: 2416,
    compactionJustCompleted: false,
    hostCompactionInProgress: false,
  });
  const snap3 = await h.service.getSessionSnapshot('sess-b9bf40a9');
  assert.equal(snap3.autoResumePending, true, 'Latched compactionDone state must survive subsequent polls');
  assert.equal(snap3.autoResumeTriggered, false);

  // Poll 4 (t+5s): Host drops session to IDLE -> MUST dispatch single-shot auto-resume
  h.advance(1_000);
  h.telemetryBySession.set('sess-b9bf40a9', {
    ...h.telemetryBySession.get('sess-b9bf40a9'),
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 2417,
  });
  const snap4 = await h.service.getSessionSnapshot('sess-b9bf40a9');
  assert.equal(snap4.autoResumeTriggered, true, 'Must fire single-shot auto-resume when transient RUNNING settles to IDLE');
  assert.equal(snap4.autoResumePending, false);
  await flush();
  assert.equal(h.commandCalls.length, 1);
  assert.equal(h.commandCalls[0].sid, 'sess-b9bf40a9');

  // 2. Negative guard: genuine host self-resume cancels pendingAutoResume:
  //    - sess-self-steps: known stepCount advancing >=2 steps while RUNNING cancels immediately
  //    - sess-self-time: unavailable stepCount (null) falls back to the 12s grace window
  //    (When stepCount is known with 0 step delta, TC-P0-12d verifies pendingAutoResume survives >12s.)
  const hSelfResume = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume' },
    initialTelemetryBySession: {
      'sess-self-time': {
        sessionId: 'sess-self-time',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: null,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 10,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
      'sess-self-steps': {
        sessionId: 'sess-self-steps',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 100,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 10,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  await hSelfResume.service.getSessionSnapshot('sess-self-time');
  await hSelfResume.service.getSessionSnapshot('sess-self-steps');
  await flush();

  hSelfResume.advance(3_000);
  for (const sid of ['sess-self-time', 'sess-self-steps']) {
    hSelfResume.telemetryBySession.set(sid, {
      ...hSelfResume.telemetryBySession.get(sid),
      status: 'CASCADE_RUN_STATUS_RUNNING',
      stepCount: sid === 'sess-self-time' ? null : 102,
      usedTokens: 45_000,
      lastCompactedStep: 101,
      compactionJustCompleted: true,
    });
    const s = await hSelfResume.service.getSessionSnapshot(sid);
    assert.equal(s.autoResumePending, true);
  }

  // sess-self-steps advances +2 steps while RUNNING -> cancel immediately
  hSelfResume.advance(2_000);
  hSelfResume.telemetryBySession.set('sess-self-steps', {
    ...hSelfResume.telemetryBySession.get('sess-self-steps'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 104,
    compactionJustCompleted: false,
  });
  const sSteps = await hSelfResume.service.getSessionSnapshot('sess-self-steps');
  assert.equal(sSteps.autoResumePending, false, 'Host advancing >=2 steps while RUNNING cancels auto-resume');

  // sess-self-time (stepCount unavailable) stays RUNNING past 12s grace window -> cancel via fallback
  hSelfResume.advance(11_000);
  const sTime = await hSelfResume.service.getSessionSnapshot('sess-self-time');
  assert.equal(sTime.autoResumePending, false, 'Sustained RUNNING past 12s grace window cancels auto-resume when stepCount is unavailable');

  // Even when both later drop to IDLE, 0 auto-resume commands are dispatched
  hSelfResume.advance(1_000);
  for (const sid of ['sess-self-time', 'sess-self-steps']) {
    hSelfResume.telemetryBySession.set(sid, {
      ...hSelfResume.telemetryBySession.get(sid),
      status: 'CASCADE_RUN_STATUS_IDLE',
    });
    await hSelfResume.service.getSessionSnapshot(sid);
  }
  await flush();
  assert.equal(hSelfResume.commandCalls.length, 0);

  // 3. Error surfacing: sendCommand resolving { accepted: false, reason } records visible lastError without looping
  const hFail = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume' },
    sendCommandImpl: async () => ({
      accepted: false,
      method: 'rpc',
      reason: 'cascadeConfig missing',
    }),
    initialTelemetryBySession: {
      'sess-resume-fail': {
        sessionId: 'sess-resume-fail',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 50,
        usedTokens: 270_000,
        maxContextTokens: 512_000,
        lastCompactedStep: 5,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });
  await hFail.service.getSessionSnapshot('sess-resume-fail');
  await flush();
  hFail.advance(4_000);
  hFail.telemetryBySession.set('sess-resume-fail', {
    ...hFail.telemetryBySession.get('sess-resume-fail'),
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 52,
    usedTokens: 42_000,
    lastCompactedStep: 51,
    compactionJustCompleted: true,
  });
  const snapFire = await hFail.service.getSessionSnapshot('sess-resume-fail');
  assert.equal(snapFire.autoResumeTriggered, true);
  await flush();
  assert.equal(hFail.commandCalls.length, 1);

  hFail.advance(1_000);
  const snapErr = await hFail.service.getSessionSnapshot('sess-resume-fail');
  assert.equal(snapErr.compaction.lastError?.code, 'AUTO_RESUME_FAILED');
  assert.match(snapErr.compaction.lastError?.message || '', /cascadeConfig missing/);
  assert.equal(hFail.commandCalls.length, 1, 'Failed auto-resume must remain single-shot (no retry loop)');
});

test('TC-P0-00e (v3.1.1): extractTailCheckpoint uses positional step index over smaller includedStepIndexEnd and empty stream status falls back to trajectorySummary.status', () => {
  const mapped = mapSessionTelemetry({
    requestedSessionId: 'sess-b9bf40a9',
    streamFrame: {
      update: {
        conversationId: 'sess-b9bf40a9',
        status: '',
      },
    },
    trajectorySummary: {
      summary: 'Active work',
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 2417,
    },
    tailStepsOffset: 2414,
    tailSteps: [
      { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE' },
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        checkpoint: {
          includedStepIndexEnd: 2414,
          sessionSummary: 'Compacted summary content',
        },
      },
    ],
  });

  assert.equal(
    mapped.lastCompactedStep,
    2416,
    'Checkpoint step index must resolve to positional baseOffset+i (2416), not underestimated includedStepIndexEnd (2414)',
  );
  assert.equal(
    mapped.status,
    'CASCADE_RUN_STATUS_IDLE',
    'Empty update.status must fall back to trajectorySummary.status',
  );
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
  const scopeSelect = byId.get('limit-scope-select');
  scopeSelect.appendChild(createFakeDomElement('option'));
  scopeSelect.appendChild(createFakeDomElement('option'));
  scopeSelect.value = 'session';
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

test('TC-P0-11 (v3.1.1): startSidecar supports headless mode (unset ANTIGRAVITY_SIDECAR_UI_TOKEN) with ephemeral 64-char hex token while remaining Fail-Closed on explicit short token', async () => {
  // 1. Explicit short token (<16 chars) MUST still fail closed
  await assert.rejects(
    () =>
      startSidecar({
        ANTIGRAVITY_SIDECAR_UI_TOKEN: 'short-15-chars!',
        STATUSBAR_DISABLE_ADDON_PUBLISH: '1',
      }),
    /shorter than 16/i,
  );

  // 2. Omitted token (headless has_web_ui: false) mints a 64-char hex cryptographic token and publishes to inline addon bridge
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-sb-headless-'));
  let published = null;
  const fakePublisher = {
    publish: async ({ baseUrl, token }) => {
      published = { baseUrl, token };
      return { bundlePath: path.join(tmpDir, 'statusbar-renderer.js') };
    },
    teardown: async () => {},
    teardownSync: () => {},
  };

  let started = null;
  try {
    started = await startSidecar(
      {
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
        ANTIGRAVITY_CSRF_TOKEN: 'test-csrf-token',
        ANTIGRAVITY_PLUGIN_DATA_DIR: tmpDir,
        STATUSBAR_SWEEP_INTERVAL_MS: '600000',
      },
      { rendererPublisher: fakePublisher },
    );

    assert.ok(published, 'startSidecar must publish ephemeral token to rendererPublisher');
    assert.match(published.token, /^[a-f0-9]{64}$/, 'Headless ephemeral token must be 64-char hex (256-bit)');

    const postSettings = (tokenHeader) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: started.port,
            method: 'POST',
            path: '/api/settings/get',
            headers: {
              host: `127.0.0.1:${started.port}`,
              origin: `http://127.0.0.1:${started.port}`,
              'content-type': 'application/json',
              connection: 'close',
              ...(tokenHeader ? { 'x-statusbar-token': tokenHeader } : {}),
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          },
        );
        req.on('error', reject);
        req.end('{}');
      });

    const unauth = await postSettings(null);
    assert.equal(unauth.status, 401);

    const auth = await postSettings(published.token);
    assert.equal(auth.status, 200);
    assert.equal(typeof JSON.parse(auth.body).locale, 'string');
  } finally {
    if (started) {
      if (typeof started.stop === 'function') {
        await started.stop();
      } else {
        await started.sidecar.close();
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('TC-P0-12a (v3.1.2): oversized >4MB tail probe widens to 40 steps and telemetry adapter retains monotonic lastCompactedStep after CHECKPOINT leaves tail window', async () => {
  // 1. ls-transport getTailTrajectorySteps probes total - 40 first (capturing CHECKPOINT at 5036 when stepCount=5051)
  const observedOffsets = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.url?.includes('GetCascadeTrajectorySteps')) {
        observedOffsets.push(body.stepOffset);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(
          JSON.stringify({
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_CHECKPOINT',
                status: 'CORTEX_STEP_STATUS_DONE',
                checkpoint: { includedStepIndexEnd: 5036, sessionSummary: 'x'.repeat(15_000) },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404, { connection: 'close' });
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const transport = createLsTransport({
      lsAddress: `http://127.0.0.1:${port}`,
      csrfToken: 'test-csrf-token-1234',
      timeoutMs: 2_000,
    });
    const tail = await transport.getTailTrajectorySteps('sess-2b0577cb', 5051);
    assert.equal(observedOffsets[0], 5011, 'Expected initial tail probe at total - 40 (5011), not total - 12 (5039)');
    assert.equal(tail.stepOffset, 5011);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  // 2. Even when stepCount advances far past the tail window (>40 steps) and CHECKPOINT is no longer
  //    in tailSteps, createAntigravityTelemetryAdapter must retain monotonic lastCompactedStep (5036)
  //    and NOT snap usedTokens back to stale pre-compaction >256K metadata.
  let currentStepCount = 5037;
  let currentTailSteps = {
    stepOffset: 5035,
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        checkpoint: { includedStepIndexEnd: 5036, sessionSummary: 'x'.repeat(15_000) },
      },
    ],
  };
  let currentGeneratorMetadata = [
    {
      stepIndices: [5034],
      chatModel: {
        modelDisplayName: 'Gemini 4 Neon (High)',
        usage: { apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '260000', cacheReadTokens: '0' },
        chatStartMetadata: {
          startStepIndex: 4900,
          contextWindowMetadata: {
            estimatedTokensUsed: 262_000,
            maxContextTokens: 512_000,
            tokenBreakdown: {
              groups: [
                { source: 'TOKEN_SOURCE_SYSTEM', numTokens: '20000' },
                { source: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: '242000' },
              ],
            },
          },
        },
      },
    },
  ];

  const adapter = createAntigravityTelemetryAdapter({
    callUnaryRpc: async () => ({
      trajectorySummaries: {
        'sess-2b0577cb': {
          summary: 'Oversized session',
          status: 'CASCADE_RUN_STATUS_RUNNING',
          stepCount: currentStepCount,
        },
      },
    }),
    readFirstStreamFrame: async () => {
      throw new Error('StreamAgentStateUpdates response exceeds 4MB cap');
    },
    getTailGeneratorMetadata: async () => currentGeneratorMetadata,
    getTailTrajectorySteps: async () => currentTailSteps,
    getQuotaSummaryRaw: async () => ({ data: null, stale: false, fetchedAt: Date.now() }),
  });

  // Poll 1: observes CHECKPOINT at step 5036
  const t1 = await adapter.getSessionTelemetry('sess-2b0577cb');
  assert.equal(t1.lastCompactedStep, 5036);
  assert.equal(t1.usedTokensSource, 'after_compaction');
  assert.equal(t1.usedTokens, 25_000);

  // Poll 2: 60+ tool calls push CHECKPOINT out of tailSteps while generatorMetadata is still pre-compaction (5034)
  currentStepCount = 5100;
  currentTailSteps = {
    stepOffset: 5060,
    steps: [{ type: 'CORTEX_STEP_TYPE_TOOL_CALL', status: 'CORTEX_STEP_STATUS_DONE' }],
  };
  const t2 = await adapter.getSessionTelemetry('sess-2b0577cb');
  assert.equal(t2.lastCompactedStep, 5036, 'lastCompactedStep must remain monotonically >= 5036 after leaving tail window');
  assert.equal(t2.usedTokensSource, 'after_compaction', 'Must keep after_compaction instead of reverting to stale pre-compaction metadata');
  assert.ok(t2.usedTokens !== null && t2.usedTokens < 256_000, `Expected low post-compaction tokens, got ${t2.usedTokens}`);

  // Poll 3: real post-compaction LLM turn completes (stepIndices [5102] > 5036) -> switches cleanly to live tokens
  currentStepCount = 5103;
  currentGeneratorMetadata = [
    ...currentGeneratorMetadata,
    {
      stepIndices: [5102],
      chatModel: {
        modelDisplayName: 'Gemini 4 Neon (High)',
        usage: { apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '45000', cacheReadTokens: '0' },
        chatStartMetadata: {
          startStepIndex: 5036,
          contextWindowMetadata: {
            estimatedTokensUsed: 48_000,
            maxContextTokens: 512_000,
          },
        },
      },
    },
  ];
  const t3 = await adapter.getSessionTelemetry('sess-2b0577cb');
  assert.equal(t3.lastCompactedStep, 5036);
  assert.equal(t3.usedTokensSource, 'estimated');
  assert.equal(t3.usedTokens, 48_000);
});

test('TC-P0-12b (v3.1.2): partial post-compaction generatorMetadata without token fields and checkpoint-step summarization metadata must not leak pre-compaction tokens', () => {
  const preCompactMeta = {
    stepIndices: [5034],
    chatModel: {
      modelDisplayName: 'Gemini 4 Neon (High)',
      usage: { apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '260000', cacheReadTokens: '0' },
      chatStartMetadata: {
        startStepIndex: 4900,
        contextWindowMetadata: {
          estimatedTokensUsed: 262_000,
          maxContextTokens: 512_000,
          tokenBreakdown: {
            groups: [
              { source: 'TOKEN_SOURCE_SYSTEM', numTokens: '20000' },
              { source: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: '242000' },
            ],
          },
        },
      },
    },
  };

  // Case 1: New post-compaction streaming chatModel item (step 5042) has empty usage: {} and no estimatedTokensUsed
  const partialPostCompact = mapSessionTelemetry({
    requestedSessionId: 'sess-cross-cp',
    streamFrame: { update: { conversationId: 'sess-cross-cp', status: 'CASCADE_RUN_STATUS_RUNNING' } },
    trajectorySummary: { summary: 'Active', status: 'CASCADE_RUN_STATUS_RUNNING', stepCount: 5043 },
    generatorMetadata: [
      preCompactMeta,
      {
        stepIndices: [5042],
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (High)',
          usage: {},
          chatStartMetadata: {
            startStepIndex: 5036,
            contextWindowMetadata: { maxContextTokens: 512_000 },
          },
        },
      },
    ],
    tailStepsOffset: 5036,
    tailSteps: [
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        checkpoint: { includedStepIndexEnd: 5036, sessionSummary: 'x'.repeat(15_000) },
      },
    ],
  });

  assert.equal(partialPostCompact.usedTokensSource, 'after_compaction', 'Partial step 5042 metadata must not leak step 5034 pre-compaction tokens');
  assert.equal(partialPostCompact.usedTokens, 25_000);
  assert.equal(partialPostCompact.compactionJustCompleted, true);

  // Case 2: Summarization chatModel call at CHECKPOINT step itself (stepIndices: [5036]) reports pre-compaction 262K input
  const checkpointStepMeta = mapSessionTelemetry({
    requestedSessionId: 'sess-cross-cp',
    streamFrame: { update: { conversationId: 'sess-cross-cp', status: 'CASCADE_RUN_STATUS_RUNNING' } },
    trajectorySummary: { summary: 'Active', status: 'CASCADE_RUN_STATUS_RUNNING', stepCount: 5038 },
    generatorMetadata: [
      {
        ...preCompactMeta,
        stepIndices: [5036],
      },
    ],
    tailStepsOffset: 5036,
    tailSteps: [
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        checkpoint: { includedStepIndexEnd: 5036, sessionSummary: 'x'.repeat(15_000) },
      },
    ],
  });

  assert.equal(checkpointStepMeta.usedTokensSource, 'after_compaction', 'Metadata at CHECKPOINT step itself (5036) must not leak pre-compaction summarization input');
  assert.equal(checkpointStepMeta.usedTokens, 25_000);
});

test('TC-P0-12c (v3.1.2): synthetic after_compaction preserves settlement cooldown across long compactions (>90s) and out-of-order stale polls cannot double-trigger /compact', async () => {
  // Part 1: Long compaction (99s, matching real 2b0577cb 21:46:36->21:48:15) followed by synthetic after_compaction
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume' },
    initialTelemetryBySession: {
      'sess-long-cp': {
        sessionId: 'sess-long-cp',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 5035,
        usedTokens: 265_000,
        usedTokensSource: 'estimated',
        maxContextTokens: 512_000,
        lastCompactedStep: 4900,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  const snap1 = await h.service.getSessionSnapshot('sess-long-cp');
  assert.equal(snap1.autoCompactTriggered, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // 99 seconds later: compaction completes with synthetic after_compaction reading
  h.advance(99_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 5037,
    usedTokens: 25_000,
    usedTokensSource: 'after_compaction',
    lastCompactedStep: 5036,
    compactionJustCompleted: true,
  });
  const snapDone = await h.service.getSessionSnapshot('sess-long-cp');
  assert.equal(snapDone.autoCompactTriggered, false);
  await flush();

  // 15 seconds after completion (114s after 1st trigger): stale >256K spike arrives before any real <256K turn
  h.advance(15_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 5051,
    usedTokens: 262_000,
    usedTokensSource: 'estimated',
    lastCompactedStep: 5036,
    compactionJustCompleted: false,
  });
  const snapSpike = await h.service.getSessionSnapshot('sess-long-cp');
  assert.equal(snapSpike.autoCompactTriggered, false, 'Settlement cooldown after synthetic after_compaction must block immediate double /compact');
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // Real post-compaction below-limit turn arrives -> clears settlement cooldown cleanly
  h.advance(5_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 5055,
    usedTokens: 45_000,
    usedTokensSource: 'estimated',
    lastCompactedStep: 5036,
    compactionJustCompleted: false,
  });
  await h.service.getSessionSnapshot('sess-long-cp');

  // Later real context growth past 256K triggers cleanly (re-armed by the real 45K reading)
  h.advance(10_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 5120,
    usedTokens: 268_000,
    usedTokensSource: 'estimated',
    lastCompactedStep: 5036,
    compactionJustCompleted: false,
  });
  const snapRealCross = await h.service.getSessionSnapshot('sess-long-cp');
  assert.equal(snapRealCross.autoCompactTriggered, true, 'Real below-limit reading must re-arm auto-compact for genuine future crossings');
  await flush();
  assert.equal(h.compactCalls.length, 2);

  // Part 2: Out-of-order stale poll (regressed stepCount / lastCompactedStep) must NEVER trigger /compact
  h.advance(120_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 5130,
    usedTokens: 40_000,
    usedTokensSource: 'estimated',
    lastCompactedStep: 5125,
    compactionJustCompleted: false,
  });
  await h.service.getSessionSnapshot('sess-long-cp');

  // Stale out-of-order response arrives with older stepCount (5120 < 5130) & older lastCompactedStep (5036 < 5125)
  h.advance(1_000);
  h.telemetryBySession.set('sess-long-cp', {
    ...h.telemetryBySession.get('sess-long-cp'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 5120,
    usedTokens: 270_000,
    usedTokensSource: 'estimated',
    lastCompactedStep: 5036,
    compactionJustCompleted: false,
  });
  const snapStale = await h.service.getSessionSnapshot('sess-long-cp');
  assert.equal(snapStale.autoCompactTriggered, false, 'Regressed out-of-order telemetry must never trigger /compact');
  await flush();
  assert.equal(h.compactCalls.length, 2);
});

test('TC-P0-12d (v3.1.2): post-checkpoint RUNNING lasting >12s with 0 new steps preserves pendingAutoResume and resumes once IDLE', async () => {
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume' },
    initialTelemetryBySession: {
      'sess-working-stall': {
        sessionId: 'sess-working-stall',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 5052,
        usedTokens: 270_000,
        usedTokensSource: 'estimated',
        maxContextTokens: 512_000,
        lastCompactedStep: 5036,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  // Trigger auto-compact while RUNNING
  const s1 = await h.service.getSessionSnapshot('sess-working-stall');
  assert.equal(s1.autoCompactTriggered, true);
  assert.equal(s1.autoResumePending, true);
  await flush();

  // t+5s: CHECKPOINT finishes at step 5053 while UI still displays "Working" (status=RUNNING, stepCount=5054)
  h.advance(5_000);
  h.telemetryBySession.set('sess-working-stall', {
    ...h.telemetryBySession.get('sess-working-stall'),
    status: 'CASCADE_RUN_STATUS_RUNNING',
    stepCount: 5054,
    usedTokens: 25_000,
    usedTokensSource: 'after_compaction',
    lastCompactedStep: 5053,
    compactionJustCompleted: true,
  });
  const sDone = await h.service.getSessionSnapshot('sess-working-stall');
  assert.equal(sDone.autoResumePending, true);
  assert.equal(sDone.autoResumeTriggered, false);

  // t+25s (20s after checkpoint done — past old 12s grace window!): still RUNNING with 0 new steps (5054)
  h.advance(20_000);
  const sStillWorking = await h.service.getSessionSnapshot('sess-working-stall');
  assert.equal(
    sStillWorking.autoResumePending,
    true,
    'RUNNING with 0 new steps past 12s must NOT cancel pendingAutoResume (prevents dead agent after compaction)',
  );
  assert.equal(sStillWorking.autoResumeTriggered, false);

  // t+30s: Host finally settles to IDLE -> MUST dispatch single-shot auto-resume
  h.advance(5_000);
  h.telemetryBySession.set('sess-working-stall', {
    ...h.telemetryBySession.get('sess-working-stall'),
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 5054,
  });
  const sIdle = await h.service.getSessionSnapshot('sess-working-stall');
  assert.equal(sIdle.autoResumeTriggered, true, 'Must fire single-shot auto-resume once delayed RUNNING settles to IDLE');
  assert.equal(sIdle.autoResumePending, false);
  await flush();
  assert.equal(h.commandCalls.length, 1);
  assert.equal(h.commandCalls[0].sid, 'sess-working-stall');
});

test('TC-P0-13a (v3.1.3): lowering global limit on >100% session must NOT fire immediate 2nd /compact when post-compaction tokens drop >=15% yet remain >= lowered limit', async () => {
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 512_000, autoCompact: true },
    initialTelemetryBySession: {
      'sess-lower-global': {
        sessionId: 'sess-lower-global',
        status: 'CASCADE_RUN_STATUS_IDLE',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 200,
        usedTokens: 360_000,
        usedTokensSource: 'estimated',
        maxContextTokens: 512_000,
        lastCompactedStep: 100,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  // User lowers global defaultCustomLimit from 512K -> 128K; session immediately exceeds 100%
  await h.service.updateSettings({ defaultCustomLimit: 128_000 });
  const s1 = await h.service.getSessionSnapshot('sess-lower-global');
  assert.equal(s1.autoCompactTriggered, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // 18s later: 1st /compact finishes; tokens drop 60% (360K -> 145K) but are STILL >= 128K lowered limit
  h.advance(18_000);
  h.telemetryBySession.set('sess-lower-global', {
    ...h.telemetryBySession.get('sess-lower-global'),
    stepCount: 203,
    usedTokens: 145_000,
    usedTokensSource: 'estimated',
    lastCompactedStep: 202,
    compactionJustCompleted: false,
    hostCompactionInProgress: false,
  });
  const s2 = await h.service.getSessionSnapshot('sess-lower-global');
  assert.equal(
    s2.autoCompactTriggered,
    false,
    'Post-compaction tokens still >= lowered limit must NOT clear waitingForDrop/cooldown via reducedMeaningfully',
  );
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // 2s later: still 146K -> must remain blocked during cooldown/growth guard
  h.advance(2_000);
  h.telemetryBySession.set('sess-lower-global', {
    ...h.telemetryBySession.get('sess-lower-global'),
    stepCount: 204,
    usedTokens: 146_000,
  });
  const s3 = await h.service.getSessionSnapshot('sess-lower-global');
  assert.equal(s3.autoCompactTriggered, false);
  await flush();
  assert.equal(h.compactCalls.length, 1);
});

test('TC-P0-13b (v3.1.3): ambiguous 504 timeout must NOT duplicate /compact via agentapi fallback or reset waitingForDrop/pendingAutoResume', async () => {
  // Part 1: compaction-adapter must NOT fall back to agentapi on 504 RPC timeout
  let spawnCalls = 0;
  let observedRpcOpts = null;
  const adapter = createAntigravityCompactionAdapter({
    lsTransport: {
      callUnaryRpc: async (_method, _payload, opts) => {
        observedRpcOpts = opts;
        throw new DomainError(
          ERROR_CODES.TELEMETRY_UNAVAILABLE,
          504,
          'LS RPC SendUserCascadeMessage timed out after 20000ms.',
        );
      },
    },
    agentApiExePath: process.execPath,
    spawnFn: () => {
      spawnCalls += 1;
      throw new Error('spawnFn must not be called on ambiguous 504 timeout');
    },
  });

  const compactRes = await adapter.compactSession('sess-timeout');
  assert.equal(compactRes.accepted, false);
  assert.equal(compactRes.ambiguous, true, 'Ambiguous 504 timeout must be flagged ambiguous: true');
  assert.equal(spawnCalls, 0, 'Must NOT duplicate /compact via agentapi fallback after 504 RPC timeout');
  assert.ok(
    (observedRpcOpts?.timeoutMs ?? 0) >= 20_000,
    `SendUserCascadeMessage compact timeout should be >= 20000ms, got ${observedRpcOpts?.timeoutMs}`,
  );

  // Sibling path: sendCommand must NOT fall back to RPC when agentapi itself timed out
  let rpcFallbackCalls = 0;
  const cmdAdapter = createAntigravityCompactionAdapter({
    lsTransport: {
      callUnaryRpc: async () => {
        rpcFallbackCalls += 1;
        return {};
      },
    },
    agentApiExePath: process.execPath,
    fallbackTimeoutMs: 50,
    spawnFn: (_exe, _args, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {};
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        child.emit('error', err);
      });
      return child;
    },
  });
  const cmdRes = await cmdAdapter.sendCommand('sess-timeout', 'continue work');
  assert.equal(cmdRes.accepted, false);
  assert.equal(cmdRes.ambiguous, true);
  assert.equal(rpcFallbackCalls, 0, 'Must NOT duplicate sendCommand via RPC fallback after agentapi timeout');
  await adapter.dispose();
  await cmdAdapter.dispose();

  // Part 2: statusbar-service must preserve waitingForDrop & pendingAutoResume on ambiguous timeout
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompactWhileRunning: 'resume' },
    initialTelemetryBySession: {
      'sess-ambig': {
        sessionId: 'sess-ambig',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 80,
        usedTokens: 280_000,
        usedTokensSource: 'estimated',
        maxContextTokens: 512_000,
        lastCompactedStep: 10,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
    compactImpl: async () => ({
      accepted: false,
      method: 'rpc',
      ambiguous: true,
      reason: 'LS RPC SendUserCascadeMessage timed out after 20000ms.',
    }),
  });

  const s1 = await h.service.getSessionSnapshot('sess-ambig');
  assert.equal(s1.autoCompactTriggered, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // 18s later: session transitions to IDLE while tokens still 280K -> MUST NOT immediately re-fire 2nd /compact
  h.advance(18_000);
  h.telemetryBySession.set('sess-ambig', {
    ...h.telemetryBySession.get('sess-ambig'),
    status: 'CASCADE_RUN_STATUS_IDLE',
  });
  const sIdle = await h.service.getSessionSnapshot('sess-ambig');
  assert.equal(
    sIdle.autoCompactTriggered,
    false,
    'Ambiguous timeout must NOT arm failedWhileRunning immediate IDLE retry',
  );
  assert.equal(
    sIdle.autoResumePending,
    true,
    'Ambiguous timeout must preserve pendingAutoResume in case host accepted 1st /compact',
  );
  await flush();
  assert.equal(h.compactCalls.length, 1);
});

test('TC-P0-13c (v3.1.3): updateSettings must preserve autoCompactState for sessions currently compacting and ignore no-op same-value global limit saves', async () => {
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 512_000, autoCompact: true },
    initialTelemetryBySession: {
      'sess-inflight': {
        sessionId: 'sess-inflight',
        status: 'CASCADE_RUN_STATUS_IDLE',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 100,
        usedTokens: 300_000,
        usedTokensSource: 'estimated',
        maxContextTokens: 512_000,
        lastCompactedStep: 20,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  // 1. Lower global limit -> 1st /compact starts
  await h.service.updateSettings({ defaultCustomLimit: 256_000 });
  const s1 = await h.service.getSessionSnapshot('sess-inflight');
  assert.equal(s1.autoCompactTriggered, true);
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // 2. 5s later (while 1st /compact is still in-flight): user lowers global limit again (256K -> 200K)
  h.advance(5_000);
  await h.service.updateSettings({ defaultCustomLimit: 200_000 });

  // 3. 11s later (t=16s > 15s compactCooldownMs fallback TTL while 18s compaction is still running):
  //    MUST NOT fire a 2nd /compact because autoCompactState was preserved for in-flight compaction!
  h.advance(11_000);
  const s16 = await h.service.getSessionSnapshot('sess-inflight');
  assert.equal(
    s16.autoCompactTriggered,
    false,
    'updateSettings while compaction is in-flight must NOT wipe cooldown and double-fire after 15s',
  );
  await flush();
  assert.equal(h.compactCalls.length, 1);

  // 4. Re-saving the exact same global limit (200K -> 200K no-op) after mutex cleared must NOT wipe cooldown
  h.advance(10_000);
  await h.service.updateSettings({ defaultCustomLimit: 200_000 });
  const sNoop = await h.service.getSessionSnapshot('sess-inflight');
  assert.equal(sNoop.autoCompactTriggered, false, 'No-op same-value global limit save must NOT reset autoCompactState');
  await flush();
  assert.equal(h.compactCalls.length, 1);
});

test('TC-P0-13d (v3.1.3): manual /compact arms autoCompactState so auto-compact never fires a 2nd /compact during an 18s compaction, and keeps tail check active', async () => {
  const h = createServiceHarness({
    initialSettings: { defaultCustomLimit: 256_000, autoCompact: true },
    initialTelemetryBySession: {
      'sess-manual-18s': {
        sessionId: 'sess-manual-18s',
        status: 'CASCADE_RUN_STATUS_IDLE',
        modelName: 'Gemini 4 Neon (High)',
        stepCount: 150,
        usedTokens: 300_000,
        usedTokensSource: 'estimated',
        maxContextTokens: 512_000,
        lastCompactedStep: 50,
        compactionJustCompleted: false,
        hostCompactionInProgress: false,
        tokenBreakdown: [],
      },
    },
  });

  // User triggers manual /compact on an over-limit session
  const req = await h.service.requestCompaction('sess-manual-18s');
  assert.equal(req.accepted, true);
  assert.equal(h.compactCalls.length, 1);

  // 16s later (past 15s mutex TTL, before 18s compaction finishes, hostCompactionInProgress not reported)
  h.advance(16_000);
  h.telemetryCalls.length = 0;
  const s16 = await h.service.getSessionSnapshot('sess-manual-18s');
  assert.equal(
    s16.autoCompactTriggered,
    false,
    'Auto-compact must NOT fire a 2nd /compact while manual compaction is still finishing past 15s',
  );
  assert.equal(
    h.telemetryCalls[0]?.opts?.includeTailSteps,
    true,
    'Tail checkpoint probe must remain enabled while awaiting post-compaction drop within cooldown',
  );
  await flush();
  assert.equal(h.compactCalls.length, 1);
});

test('TC-P0-13e (v3.1.3): out-of-order concurrent getSessionSnapshot response must NOT fire duplicate /compact even when stepCount and lastCompactedStep are null', async () => {
  let now = 30_000_000;
  const compactCalls = [];
  let mode = 'over';
  let releaseSlowPoll = null;

  const service = createStatusbarService({
    clock: () => now,
    telemetryPort: {
      listSessions: async () => [],
      getSessionTelemetry: async (sid) => {
        if (mode === 'slow_over') {
          mode = 'dropped';
          await new Promise((resolve) => {
            releaseSlowPoll = resolve;
          });
          return {
            sessionId: sid,
            status: 'CASCADE_RUN_STATUS_IDLE',
            modelName: 'Gemini 4 Neon (High)',
            stepCount: null,
            usedTokens: 300_000,
            usedTokensSource: 'estimated',
            maxContextTokens: 512_000,
            lastCompactedStep: null,
            compactionJustCompleted: false,
            hostCompactionInProgress: false,
            tokenBreakdown: [],
          };
        }
        return {
          sessionId: sid,
          status: 'CASCADE_RUN_STATUS_IDLE',
          modelName: 'Gemini 4 Neon (High)',
          stepCount: null,
          usedTokens: mode === 'dropped' ? 45_000 : 300_000,
          usedTokensSource: 'estimated',
          maxContextTokens: 512_000,
          lastCompactedStep: null,
          compactionJustCompleted: false,
          hostCompactionInProgress: false,
          tokenBreakdown: [],
        };
      },
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false, fetchedAt: now }),
    },
    compactionPort: {
      compactSession: async (sid) => {
        compactCalls.push({ sid, at: now });
        return { accepted: true, method: 'rpc' };
      },
    },
    settingsPort: {
      read: async () => ({
        locale: 'ko',
        autoCompact: true,
        autoCompactWhileRunning: 'resume',
        compactPrompt: '',
        defaultCustomLimit: 256_000,
        modelLimits: new Map(),
        sessions: new Map(),
        customButtons: [],
        disabledRuntimeAddonIds: [],
      }),
      update: async () => ({}),
    },
  });

  // 1. Triggers 1st /compact
  const s1 = await service.getSessionSnapshot('sess-ooo');
  assert.equal(s1.autoCompactTriggered, true);
  await flush();
  assert.equal(compactCalls.length, 1);

  // 2. Advance past 15s mutex; start slow Poll 2 (captures pre-compact 300K), then complete fast Poll 3 (45K)
  now += 17_000;
  mode = 'slow_over';
  const slowPollPromise = service.getSessionSnapshot('sess-ooo');
  await flush();
  now += 1_000;
  const fastSnap = await service.getSessionSnapshot('sess-ooo');
  assert.equal(fastSnap.usedTokens, 45_000);
  assert.equal(fastSnap.autoCompactTriggered, false);

  // 3. Slow Poll 2 finally resolves with stale pre-compact 300K -> MUST NOT trigger 2nd /compact!
  releaseSlowPoll();
  const slowSnap = await slowPollPromise;
  assert.equal(
    slowSnap.autoCompactTriggered,
    false,
    'Out-of-order older getSessionSnapshot response must never trigger duplicate /compact',
  );
  await flush();
  assert.equal(compactCalls.length, 1);
});

test('TC-P0-00f (v3.1.4): buildAutoResumePrompt avoids assuming external summary-context artifacts in both ko and en locales', () => {
  const koPrompt = buildAutoResumePrompt('ko');
  const defaultPrompt = buildAutoResumePrompt();
  const enPrompt = buildAutoResumePrompt('en');

  assert.equal(defaultPrompt, koPrompt);
  assert.equal(koPrompt.includes('요약 컨텍스트'), false, 'ko prompt must not assume external summary-context exists');
  assert.equal(/compaction summary/i.test(enPrompt), false, 'en prompt must not assume external summary-context exists');
  assert.ok(koPrompt.includes('현재 대화 내용과 실제 작업 상태'));
  assert.ok(koPrompt.includes('완료 여부만'));
  assert.ok(enPrompt.includes('current conversation and actual workspace state'));
  assert.ok(enPrompt.includes('briefly confirm completion'));
});

test('TC-P0-06b (v3.1.5): install-plugin isolates staging/backup outside plugins/, cleans up on EBUSY/EXDEV fallback, and preserves backup on restore failure', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-inst-staging-'));
  const fakeConfigDir = path.join(tmpRoot, 'config');
  const fakePluginsDir = path.join(fakeConfigDir, 'plugins');
  const fakeTmpDir = path.join(tmpRoot, 'tmp');
  const destDir = path.join(fakePluginsDir, 'antigravity-statusbar');
  const dataDir = path.join(destDir, 'data');
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(fakeTmpDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'settings.json'), '{"locale":"ko","defaultCustomLimit":256000}', 'utf8');

    // 1. resolveInstallWorkParent unit checks (same-fs tmp, cross-fs grandparent, unwritable grandparent)
    const sameFsParent = await resolveInstallWorkParent(fakePluginsDir, {
      tmpDir: fakeTmpDir,
      statFn: async () => ({ dev: 100 }),
      accessFn: async () => {},
    });
    assert.equal(sameFsParent, path.resolve(fakeTmpDir));

    const crossFsGrandParent = await resolveInstallWorkParent(fakePluginsDir, {
      tmpDir: fakeTmpDir,
      statFn: async (p) => ({ dev: path.resolve(p) === path.resolve(fakeTmpDir) ? 999 : 100 }),
      accessFn: async () => {},
    });
    assert.equal(crossFsGrandParent, path.resolve(fakeConfigDir));

    const crossFsUnwritableGrandParent = await resolveInstallWorkParent(fakePluginsDir, {
      tmpDir: fakeTmpDir,
      statFn: async (p) => ({ dev: path.resolve(p) === path.resolve(fakeTmpDir) ? 999 : 100 }),
      accessFn: async (p) => {
        if (path.resolve(p) === path.resolve(fakeConfigDir)) {
          const err = new Error('EACCES');
          err.code = 'EACCES';
          throw err;
        }
      },
    });
    assert.equal(crossFsUnwritableGrandParent, path.resolve(fakeTmpDir));

    // 2. Simulated Windows EBUSY and Linux EXDEV: zero staging/backup entries ever appear inside plugins/
    for (const errCode of ['EBUSY', 'EXDEV']) {
      let entriesSeenDuringRename = null;
      const seenTargets = [];
      const res = await installPlugin({
        repoRoot,
        destDir,
        dryRun: false,
        tmpDir: fakeTmpDir,
        renameMaxTotalMs: 40,
        renameFn: async (src, dst) => {
          seenTargets.push({ src, dst });
          entriesSeenDuringRename = await fs.readdir(fakePluginsDir);
          const err = new Error(`Simulated ${errCode}`);
          err.code = errCode;
          throw err;
        },
      });

      assert.equal(res.installed, true);
      assert.equal(res.mode, 'in-place-fallback');
      assert.deepEqual(
        entriesSeenDuringRename,
        ['antigravity-statusbar'],
        `During ${errCode} fallback, plugins/ must never contain any staging or backup directory`,
      );
      assert.ok(seenTargets.length >= 1);
      for (const { src, dst } of seenTargets) {
        const other = path.resolve(src) === path.resolve(destDir) ? dst : src;
        const rel = path.relative(fakePluginsDir, other);
        assert.ok(
          rel.startsWith('..') || path.isAbsolute(rel),
          `Staging/backup path (${other}) must reside outside plugins/ (${fakePluginsDir})`,
        );
      }
      assert.deepEqual(await fs.readdir(fakePluginsDir), ['antigravity-statusbar']);
      assert.deepEqual(await fs.readdir(fakeTmpDir), [], `Temporary workRoot must be cleaned up after ${errCode} fallback`);
      assert.equal(
        await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'),
        '{"locale":"ko","defaultCustomLimit":256000}',
      );
    }

    // 3. Catastrophic double-failure (swap fails + restore fails) must preserve backup inside workRoot
    let callCount = 0;
    let preservedBackupPath = null;
    await assert.rejects(
      () =>
        installPlugin({
          repoRoot,
          destDir,
          dryRun: false,
          tmpDir: fakeTmpDir,
          renameMaxTotalMs: 40,
          renameFn: async (src, dst) => {
            callCount += 1;
            if (callCount === 1) {
              // destDir -> backupDir succeeds
              preservedBackupPath = dst;
              await fs.rename(src, dst);
              return;
            }
            const err = new Error('Simulated catastrophic EIO');
            err.code = 'EIO';
            throw err;
          },
        }),
      /Your preserved plugin data remains at:/,
    );
    assert.ok(preservedBackupPath, 'Backup path must be recorded when destDir was moved');
    assert.equal(
      await fs.readFile(path.join(preservedBackupPath, 'data', 'settings.json'), 'utf8'),
      '{"locale":"ko","defaultCustomLimit":256000}',
      'Preserved plugin data in backupDir must remain intact when restore fails',
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});
