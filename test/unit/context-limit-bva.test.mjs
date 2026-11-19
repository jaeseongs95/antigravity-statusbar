import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAddonRegistry } from '../../src/adapters/antigravity/addon/addon-bridge.mjs';
import { createBarController } from '../../src/adapters/antigravity/addon/bar-controller.mjs';
import { createBarView } from '../../src/adapters/antigravity/addon/bar-view.mjs';
import { createInlineI18n } from '../../src/adapters/antigravity/addon/i18n.mjs';
import { createPopoverView } from '../../src/adapters/antigravity/addon/popover-view.mjs';
import { createSidecarServer } from '../../src/adapters/antigravity/sidecar-entry.mjs';
import { createJsonSettingsStore } from '../../src/adapters/storage/json-settings-store.mjs';
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
} from '../../src/core/model/context-policy.mjs';

const TEST_TOKEN = 'context-limit-bva-token-32-ok-12';

function createBvaMockDom() {
  class ClassList {
    constructor() { this._s = new Set(); }
    _set(v) { this._s = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
    _str() { return Array.from(this._s).join(' '); }
    contains(n) { return this._s.has(n); }
    toggle(n, f) {
      if (f === undefined) {
        if (this._s.has(n)) { this._s.delete(n); return false; }
        this._s.add(n); return true;
      }
      if (f) { this._s.add(n); return true; }
      this._s.delete(n); return false;
    }
  }
  class El {
    constructor(tag, doc) {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.ownerDocument = doc;
      this.parentNode = null;
      this.childNodes = [];
      this.attributes = new Map();
      this.style = {};
      this.classList = new ClassList();
      this._text = '';
      this.value = '';
      this.disabled = false;
      this.title = '';
      this.type = '';
      this.placeholder = '';
      this.listeners = new Map();
    }
    get firstChild() { return this.childNodes[0] || null; }
    get className() { return this.classList._str(); }
    set className(v) { this.classList._set(v); }
    get textContent() {
      return this.childNodes.length === 0 ? this._text : this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) { this.childNodes = []; this._text = String(v ?? ''); }
    setAttribute(k, v) { this.attributes.set(String(k), String(v)); }
    getAttribute(k) { return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null; }
    appendChild(ch) {
      if (ch.parentNode) ch.parentNode.removeChild(ch);
      ch.parentNode = this;
      this.childNodes.push(ch);
      return ch;
    }
    removeChild(ch) {
      const i = this.childNodes.indexOf(ch);
      if (i >= 0) { this.childNodes.splice(i, 1); ch.parentNode = null; }
      return ch;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(o) { let c = o; while (c) { if (c === this) return true; c = c.parentNode; } return false; }
    matches(sel) {
      if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
      return this.tagName === sel.toUpperCase();
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const ch of n.childNodes) {
          if (ch.nodeType === 1) {
            if (ch.matches(sel)) out.push(ch);
            walk(ch);
          }
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(evt) {
      const s = this.listeners.get(evt.type);
      if (s) for (const fn of Array.from(s)) fn(evt);
    }
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); }
    focus() { this.ownerDocument.activeElement = this; }
  }
  const docListeners = new Map();
  const doc = {
    activeElement: null,
    createElement(tag) { return new El(tag, doc); },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  };
  return { doc, El };
}

function rawPost({ port, path: reqPath, token = TEST_TOKEN, body }) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: reqPath,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-statusbar-token': token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

test('TC-BVA-01: validateCustomLimit exact lower/upper bounds, non-integers, and non-number types', () => {
  assert.equal(MIN_CUSTOM_LIMIT, 32_000);
  assert.equal(MAX_CUSTOM_LIMIT, 980_000);

  // Valid exact boundaries
  assert.equal(validateCustomLimit(null), null);
  assert.equal(validateCustomLimit(32_000), 32_000);
  assert.equal(validateCustomLimit(32_001), 32_001);
  assert.equal(validateCustomLimit(979_999), 979_999);
  assert.equal(validateCustomLimit(980_000), 980_000);

  // Invalid boundaries: below min, above max, decimals, specials, non-numbers
  const invalidValues = [
    -1,
    0,
    1,
    31_999,
    980_001,
    1_000_000,
    32_000.1,
    32_000.5,
    979_999.9,
    NaN,
    Infinity,
    -Infinity,
    '32000',
    '',
    undefined,
    true,
    false,
    {},
    [],
  ];
  for (const val of invalidValues) {
    assert.throws(
      () => validateCustomLimit(val),
      (err) => err instanceof DomainError && err.code === ERROR_CODES.INVALID_CUSTOM_LIMIT && err.httpStatus === 400,
      `Expected INVALID_CUSTOM_LIMIT for value: ${String(val)}`,
    );
  }
});

test('TC-BVA-02: resolveEffectiveLimit host clamping boundaries (hostMax-1, hostMax, hostMax+1, <=0) and scope precedence', () => {
  // Missing / zero / negative / NaN hostMax -> never clamps, never divides by zero
  for (const badHostMax of [null, undefined, 0, -1, -512_000, NaN, Infinity]) {
    const r = resolveEffectiveLimit({
      hostMaxTokens: badHostMax,
      sessionCustomLimit: 256_000,
      defaultCustomLimit: 128_000,
    });
    assert.equal(r.effectiveLimit, 256_000);
    assert.equal(r.hostMaxTokens, null);
    assert.equal(r.source, 'session');
    assert.equal(r.isCustomActive, true);
    assert.equal(r.isClampedByHost, false);
  }

  // Exact clamping transitions around hostMax = 512_000
  const below = resolveEffectiveLimit({ hostMaxTokens: 512_000, sessionCustomLimit: 511_999, defaultCustomLimit: null });
  assert.equal(below.effectiveLimit, 511_999);
  assert.equal(below.isClampedByHost, false);

  const exact = resolveEffectiveLimit({ hostMaxTokens: 512_000, sessionCustomLimit: 512_000, defaultCustomLimit: null });
  assert.equal(exact.effectiveLimit, 512_000);
  assert.equal(exact.isClampedByHost, false);

  const above = resolveEffectiveLimit({ hostMaxTokens: 512_000, sessionCustomLimit: 512_001, defaultCustomLimit: null });
  assert.equal(above.effectiveLimit, 512_000);
  assert.equal(above.customLimit, 512_001);
  assert.equal(above.isClampedByHost, true);

  // Host max smaller than MIN_CUSTOM_LIMIT (e.g. 31,999): custom 32,000 clamps cleanly to 31,999
  const tinyHost = resolveEffectiveLimit({ hostMaxTokens: 31_999, sessionCustomLimit: 32_000, defaultCustomLimit: null });
  assert.equal(tinyHost.effectiveLimit, 31_999);
  assert.equal(tinyHost.isClampedByHost, true);

  // Precedence: session > default > host
  const sessionWins = resolveEffectiveLimit({ hostMaxTokens: 512_000, sessionCustomLimit: 64_000, defaultCustomLimit: 128_000 });
  assert.equal(sessionWins.source, 'session');
  assert.equal(sessionWins.effectiveLimit, 64_000);

  const defaultWins = resolveEffectiveLimit({ hostMaxTokens: 512_000, sessionCustomLimit: null, defaultCustomLimit: 128_000 });
  assert.equal(defaultWins.source, 'default');
  assert.equal(defaultWins.effectiveLimit, 128_000);

  const hostWins = resolveEffectiveLimit({ hostMaxTokens: 512_000, sessionCustomLimit: null, defaultCustomLimit: null });
  assert.equal(hostWins.source, 'host');
  assert.equal(hostWins.effectiveLimit, 512_000);
  assert.equal(hostWins.isCustomActive, false);
});

test('TC-BVA-03: evaluateContextThreshold exact 80%/90%/100% boundaries and zero rounding contradiction at 99.96%-99.999%', () => {
  const L = 100_000;

  // Invalid/unknown boundaries
  assert.deepEqual(evaluateContextThreshold({ usedTokens: -1, effectiveLimit: L }), {
    usagePercent: null,
    thresholdLevel: 'unknown',
    exceededSoftLimit: false,
  });
  assert.deepEqual(evaluateContextThreshold({ usedTokens: 50_000, effectiveLimit: 0 }), {
    usagePercent: null,
    thresholdLevel: 'unknown',
    exceededSoftLimit: false,
  });
  assert.deepEqual(evaluateContextThreshold({ usedTokens: 50_000, effectiveLimit: -100 }), {
    usagePercent: null,
    thresholdLevel: 'unknown',
    exceededSoftLimit: false,
  });

  // 0% -> normal
  assert.deepEqual(evaluateContextThreshold({ usedTokens: 0, effectiveLimit: L }), {
    usagePercent: 0,
    thresholdLevel: 'normal',
    exceededSoftLimit: false,
  });

  // 79.999% -> normal (not warning yet)
  const below80 = evaluateContextThreshold({ usedTokens: 79_999, effectiveLimit: L });
  assert.equal(below80.thresholdLevel, 'normal');
  assert.equal(below80.exceededSoftLimit, false);

  // 80.0% -> warning
  const at80 = evaluateContextThreshold({ usedTokens: 80_000, effectiveLimit: L });
  assert.equal(at80.usagePercent, 80);
  assert.equal(at80.thresholdLevel, 'warning');
  assert.equal(at80.exceededSoftLimit, false);

  // 89.999% -> warning (not critical yet)
  const below90 = evaluateContextThreshold({ usedTokens: 89_999, effectiveLimit: L });
  assert.equal(below90.thresholdLevel, 'warning');

  // 90.0% -> critical
  const at90 = evaluateContextThreshold({ usedTokens: 90_000, effectiveLimit: L });
  assert.equal(at90.usagePercent, 90);
  assert.equal(at90.thresholdLevel, 'critical');
  assert.equal(at90.exceededSoftLimit, false);

  // Crucial BVA: 99.96% and 99.999% round to display 100%, yet usedTokens < effectiveLimit MUST NOT be 'exceeded'
  for (const nearLimit of [99_950, 99_960, 99_999]) {
    const res = evaluateContextThreshold({ usedTokens: nearLimit, effectiveLimit: L });
    assert.equal(res.exceededSoftLimit, false, `usedTokens=${nearLimit} must not exceed ${L}`);
    assert.equal(res.thresholdLevel, 'critical', `usedTokens=${nearLimit} must remain critical, not exceeded`);
  }

  // Exact 100% -> exceeded
  const at100 = evaluateContextThreshold({ usedTokens: 100_000, effectiveLimit: L });
  assert.equal(at100.usagePercent, 100);
  assert.equal(at100.thresholdLevel, 'exceeded');
  assert.equal(at100.exceededSoftLimit, true);

  // Over 100% -> unclamped usagePercent, exceeded
  const over = evaluateContextThreshold({ usedTokens: 150_000, effectiveLimit: L });
  assert.equal(over.usagePercent, 150);
  assert.equal(over.thresholdLevel, 'exceeded');
  assert.equal(over.exceededSoftLimit, true);
});

test('TC-BVA-04: pruneSessionOverrides & json-settings-store 199/200/201 LRU eviction, null reset, and corrupt out-of-range sanitization', async () => {
  assert.equal(MAX_SESSION_OVERRIDES, 200);

  // Exact 199, 200, 201 boundary on pruneSessionOverrides
  const entries200 = Array.from({ length: 200 }, (_, i) => [
    `sess-${String(i).padStart(3, '0')}`,
    { limit: 64_000, updatedAt: i + 1 },
  ]);
  assert.equal(pruneSessionOverrides(entries200.slice(0, 199)).size, 199);
  assert.equal(pruneSessionOverrides(entries200).size, 200);

  const entries201 = [...entries200, ['sess-200', { limit: 128_000, updatedAt: 201 }]];
  const pruned = pruneSessionOverrides(entries201);
  assert.equal(pruned.size, 200);
  assert.equal(pruned.has('sess-000'), false, 'Oldest entry must be evicted at 201');
  assert.equal(pruned.has('sess-001'), true);
  assert.equal(pruned.has('sess-200'), true);

  // Persisted JSON out-of-range sanitization & null delete in json-settings-store
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-bva-store-'));
  try {
    await fs.writeFile(
      path.join(tempDir, 'settings.json'),
      JSON.stringify({
        version: 3,
        locale: 'ko',
        defaultCustomLimit: 31_999, // invalid -> sanitized to null
        sessions: [
          ['s-bad-low', { limit: 31_999, updatedAt: 1 }],
          ['s-bad-high', { limit: 980_001, updatedAt: 2 }],
          ['s-bad-float', { limit: 32_000.5, updatedAt: 3 }],
          ['s-ok-min', { limit: 32_000, updatedAt: 4 }],
          ['s-ok-max', { limit: 980_000, updatedAt: 5 }],
        ],
      }),
      'utf8',
    );
    const store = createJsonSettingsStore({ dataDir: tempDir });
    const loaded = await store.read();
    assert.equal(loaded.defaultCustomLimit, null);
    assert.equal(loaded.sessions.size, 2);
    assert.equal(loaded.sessions.get('s-ok-min').limit, 32_000);
    assert.equal(loaded.sessions.get('s-ok-max').limit, 980_000);

    // Null reset deletes session override
    const afterDelete = await store.update({ sessionLimit: { sessionId: 's-ok-min', limit: null } });
    assert.equal(afterDelete.sessions.has('s-ok-min'), false);
    assert.equal(afterDelete.sessions.has('s-ok-max'), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TC-BVA-05: statusbar-service.mjs auto-compact boundary (limit-1 vs limit vs limit+1, host default non-trigger, RUNNING deferral)', async () => {
  let now = 1_000_000;
  let telemetryState = {
    sessionId: 'sess-bva',
    status: 'IDLE',
    usedTokens: 31_999,
    maxContextTokens: 512_000,
    stepCount: 10,
  };
  let stored = {
    locale: 'ko',
    defaultCustomLimit: null,
    autoCompact: true,
    compactPrompt: '',
    customButtons: [],
    disabledRuntimeAddonIds: [],
    sessions: new Map([['sess-bva', { limit: 32_000, updatedAt: 1 }]]),
  };
  const compactCalls = [];

  const service = createStatusbarService({
    clock: () => now,
    telemetryPort: {
      listSessions: async () => [{ sessionId: 'sess-bva' }],
      getSessionTelemetry: async () => ({ ...telemetryState }),
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false }),
    },
    compactionPort: {
      compactSession: async (sid, opts) => {
        compactCalls.push({ sid, opts });
        return { accepted: true, method: 'rpc' };
      },
    },
    settingsPort: {
      read: async () => ({ ...stored, sessions: new Map(stored.sessions) }),
      update: async (patch) => {
        if ('defaultCustomLimit' in patch) stored.defaultCustomLimit = patch.defaultCustomLimit;
        if (patch.sessionLimit) {
          if (patch.sessionLimit.limit === null) stored.sessions.delete(patch.sessionLimit.sessionId);
          else stored.sessions.set(patch.sessionLimit.sessionId, { limit: patch.sessionLimit.limit, updatedAt: now });
        }
        return { ...stored, sessions: new Map(stored.sessions) };
      },
    },
  });

  // Invalid limit rejected at service boundary
  await assert.rejects(
    () => service.updateSettings({ sessionLimit: { sessionId: 'sess-bva', limit: 31_999 } }),
    (e) => e instanceof DomainError && e.code === ERROR_CODES.INVALID_CUSTOM_LIMIT,
  );
  await assert.rejects(
    () => service.updateSettings({ defaultCustomLimit: 980_001 }),
    (e) => e instanceof DomainError && e.code === ERROR_CODES.INVALID_CUSTOM_LIMIT,
  );

  // usedTokens = 31,999 (exact limit - 1) -> does NOT trigger auto-compact
  const snapBelow = await service.getSessionSnapshot('sess-bva');
  assert.equal(snapBelow.exceededSoftLimit, false);
  assert.equal(snapBelow.autoCompactTriggered, false);
  assert.equal(compactCalls.length, 0);

  // usedTokens = 32,000 while RUNNING -> defers auto-compact
  telemetryState = { ...telemetryState, usedTokens: 32_000, status: 'CASCADE_RUN_STATUS_RUNNING' };
  const snapRunning = await service.getSessionSnapshot('sess-bva');
  assert.equal(snapRunning.exceededSoftLimit, true);
  assert.equal(snapRunning.autoCompactTriggered, false);
  assert.equal(compactCalls.length, 0);

  // usedTokens = 32,000 when IDLE -> triggers auto-compact exactly once
  telemetryState = { ...telemetryState, status: 'IDLE' };
  const snapAtLimit = await service.getSessionSnapshot('sess-bva');
  assert.equal(snapAtLimit.exceededSoftLimit, true);
  assert.equal(snapAtLimit.autoCompactTriggered, true);
  await flush();
  assert.equal(compactCalls.length, 1);

  // Clearing sessionLimit (null) with no default -> host default (isCustomLimitActive=false) never auto-compacts
  await service.updateSettings({ sessionLimit: { sessionId: 'sess-bva', limit: null } });
  now += 200_000;
  telemetryState = { ...telemetryState, usedTokens: 512_000, stepCount: 20 };
  const snapHost = await service.getSessionSnapshot('sess-bva');
  assert.equal(snapHost.limitSource, 'host');
  assert.equal(snapHost.isCustomLimitActive, false);
  assert.equal(snapHost.autoCompactTriggered, false);
  assert.equal(compactCalls.length, 1);
});

test('TC-BVA-06: Sidecar HTTP /api/settings/update enforces exact context limit boundaries', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-bva-http-'));
  const settingsPort = createJsonSettingsStore({ dataDir: tempDir });
  const service = createStatusbarService({
    telemetryPort: {
      listSessions: async () => [],
      getSessionTelemetry: async () => null,
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false }),
    },
    compactionPort: { compactSession: async () => ({ accepted: true, method: 'rpc' }) },
    settingsPort,
  });
  const sidecar = createSidecarServer({ token: TEST_TOKEN, service });
  const { port } = await sidecar.listen();

  try {
    // Valid exact boundaries -> 200
    for (const validPayload of [
      { defaultCustomLimit: 32_000 },
      { defaultCustomLimit: 980_000 },
      { defaultCustomLimit: null },
      { sessionLimit: { sessionId: 's-http', limit: 32_000 } },
      { sessionLimit: { sessionId: 's-http', limit: 980_000 } },
      { sessionLimit: { sessionId: 's-http', limit: null } },
    ]) {
      const res = await rawPost({ port, path: '/api/settings/update', body: validPayload });
      assert.equal(res.status, 200, `Expected 200 for ${JSON.stringify(validPayload)}`);
    }

    // Invalid boundaries -> 400
    for (const invalidPayload of [
      { defaultCustomLimit: 31_999 },
      { defaultCustomLimit: 980_001 },
      { defaultCustomLimit: 32_000.5 },
      { defaultCustomLimit: '32000' },
      { sessionLimit: { sessionId: 's-http', limit: 31_999 } },
      { sessionLimit: { sessionId: 's-http', limit: 980_001 } },
      { sessionLimit: { sessionId: 's-http', limit: 100_000.25 } },
      { sessionLimit: null },
    ]) {
      const res = await rawPost({ port, path: '/api/settings/update', body: invalidPayload });
      assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(invalidPayload)}`);
      assert.ok(
        res.json.error.code === 'INVALID_CUSTOM_LIMIT' || res.json.error.code === 'INVALID_SETTINGS_PATCH',
      );
    }
  } finally {
    await sidecar.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TC-BVA-07: bar-controller.mjs strict decimal-integer validation, comma formatting, hostMax+1 clamped toast, and missing session guard', async () => {
  const { doc, El } = createBvaMockDom();
  const i18n = createInlineI18n('ko');
  const barView = createBarView({ doc, i18n });
  const popoverView = createPopoverView({ doc, i18n });

  const updates = [];
  const api = {
    isConnected: () => true,
    abortAll() {},
    async post(pathname, body) {
      if (pathname === '/api/settings/update') {
        updates.push(body);
        return {
          locale: 'ko',
          autoCompact: true,
          compactPrompt: '',
          defaultCustomLimit: body.defaultCustomLimit ?? null,
          sessions: body.sessionLimit?.limit
            ? [{ sessionId: body.sessionLimit.sessionId, limit: body.sessionLimit.limit }]
            : [],
          customButtons: [],
          disabledRuntimeAddonIds: [],
        };
      }
      if (pathname === '/api/snapshot') {
        return {
          sessionId: body.sessionId,
          usedTokens: 100_000,
          effectiveLimit: 512_000,
          maxContextTokens: 512_000,
          usagePercent: 19.5,
        };
      }
      return {};
    },
  };

  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: '',
    defaultCustomLimit: null,
    sessionLimits: new Map(),
    quotaState: null,
    fallbackSessionId: '',
  };
  const addons = createAddonRegistry({ api, onChange() {} });
  const ctrl = createBarController({
    doc,
    api,
    i18n,
    addons,
    barView,
    popoverView,
    sharedState,
    onSettingsChanged() {},
    onBurstRequested() {},
  });

  // Missing active session in 'session' scope -> rejected without API call
  popoverView.scopeSelect.value = 'session';
  popoverView.customInput.value = '64000';
  popoverView.applyBtn.click();
  await flush();
  assert.equal(updates.length, 0);
  assert.equal(popoverView.popEl.querySelector('.agy-inline-pop-feedback').textContent, i18n.t().noActiveSession);

  // Attach active session view
  const viewEl = new El('div', doc);
  viewEl.setAttribute('data-cascade-id', 'sess-ui-bva');
  ctrl.setTargetView(viewEl);
  await flush();

  // All invalid inputs MUST be rejected with zero API calls (including decimals, hex, scientific, negative, out-of-range)
  const invalidInputs = [
    '31999',
    '31,999',
    '980001',
    '980,001',
    '32000.5',
    '32000.0',
    '979999.9',
    '-32000',
    '+32000',
    '0x7d00',
    '32e3',
    'abc',
    '0',
  ];
  for (const bad of invalidInputs) {
    popoverView.customInput.value = bad;
    popoverView.applyBtn.click();
    await flush(5);
    assert.equal(updates.length, 0, `UI must reject invalid limit input "${bad}" without API call`);
    assert.equal(
      popoverView.popEl.querySelector('.agy-inline-pop-feedback').classList.contains('err'),
      true,
      `Expected error feedback for "${bad}"`,
    );
  }

  // Valid exact boundaries: 32,000 / 32,001 / 979,999 / 980,000 / blank ('') / spaces ('   ')
  const validPairs = [
    ['32,000', 32_000],
    ['32001', 32_001],
    ['512,000', 512_000],
    ['512,001', 512_001],
    ['979,999', 979_999],
    ['980,000', 980_000],
    ['', null],
    ['   ', null],
  ];
  for (const [inputStr, expectedLimit] of validPairs) {
    const before = updates.length;
    popoverView.customInput.value = inputStr;
    popoverView.applyBtn.click();
    await flush();
    assert.equal(updates.length, before + 1, `Expected API update for valid input "${inputStr}"`);
    assert.deepEqual(updates[updates.length - 1], {
      sessionLimit: { sessionId: 'sess-ui-bva', limit: expectedLimit },
    });

    const fbText = popoverView.popEl.querySelector('.agy-inline-pop-feedback').textContent;
    if (expectedLimit === 512_000) {
      assert.equal(fbText, i18n.t().applied, 'Exact hostMax (512,000) must show normal saved toast');
    } else if (expectedLimit === 512_001) {
      assert.ok(fbText.includes('512.0K'), 'hostMax + 1 (512,001) must show clamped-to-model-max toast');
    }
  }

  ctrl.destroy();
});
