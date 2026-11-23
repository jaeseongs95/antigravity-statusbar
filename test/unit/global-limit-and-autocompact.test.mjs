import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAddonRegistry } from '../../src/adapters/antigravity/addon/addon-bridge.mjs';
import { createBarController } from '../../src/adapters/antigravity/addon/bar-controller.mjs';
import { createBarView } from '../../src/adapters/antigravity/addon/bar-view.mjs';
import { createGlobalLimitModalView } from '../../src/adapters/antigravity/addon/global-limit-modal-view.mjs';
import { createInlineI18n } from '../../src/adapters/antigravity/addon/i18n.mjs';
import { createPopoverView } from '../../src/adapters/antigravity/addon/popover-view.mjs';
import { createSidecarServer } from '../../src/adapters/antigravity/sidecar-entry.mjs';
import { createJsonSettingsStore } from '../../src/adapters/storage/json-settings-store.mjs';
import { createStatusbarService } from '../../src/core/app/statusbar-service.mjs';
import { DomainError, ERROR_CODES } from '../../src/core/i18n/error-codes.mjs';
import {
  MAX_MODEL_LIMITS,
  pruneModelLimits,
  resolveEffectiveLimit,
  resolveModelCustomLimit,
  validateModelName,
} from '../../src/core/model/context-policy.mjs';
import { createStatusbarApp } from '../../src/ui/app.js';

const TEST_TOKEN = 'global-limit-autocompact-token32';

function createMockDom() {
  class ClassList {
    constructor() { this._s = new Set(); }
    _set(v) { this._s = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
    _str() { return Array.from(this._s).join(' '); }
    add(...ns) { for (const n of ns) if (n) this._s.add(n); }
    remove(...ns) { for (const n of ns) this._s.delete(n); }
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
    get options() { return this.childNodes; }
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
    addEventListener(type, fn, opts) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => this.listeners.get(type)?.delete(fn), { once: true });
      }
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(evt) {
      const s = this.listeners.get(evt.type);
      if (s) for (const fn of Array.from(s)) fn(evt);
    }
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); }
    focus() { this.ownerDocument.activeElement = this; }
  }
  const byId = new Map();
  const docListeners = new Map();
  const doc = {
    activeElement: null,
    hidden: false,
    documentElement: { lang: 'en' },
    createElement(tag) { return new El(tag, doc); },
    registerId(id, tag = 'div') {
      const el = new El(tag, doc);
      el.id = id;
      byId.set(id, el);
      return el;
    },
    getElementById(id) { return byId.get(id) || null; },
    addEventListener(type, fn, opts) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => docListeners.get(type)?.delete(fn), { once: true });
      }
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
    dispatchEvent(evt) {
      const s = docListeners.get(evt.type);
      if (s) for (const fn of Array.from(s)) fn(evt);
    },
  };
  return { doc, El };
}

function rawPost({ port, reqPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: reqPath,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-statusbar-token': TEST_TOKEN,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function flush(ms = 25) {
  return new Promise((r) => setTimeout(r, ms));
}

test('TC-GLOBAL-01: Option A 4-tier precedence (session > model > default > host) with case-insensitive model lookup and host clamping', () => {
  const modelMap = new Map([['Gemini 4 Neon (High)', { limit: 200_000, updatedAt: 10 }]]);
  assert.equal(resolveModelCustomLimit(modelMap, 'Gemini 4 Neon (High)'), 200_000);
  assert.equal(resolveModelCustomLimit(modelMap, '  gemini 4 neon (high) '), 200_000);
  assert.equal(resolveModelCustomLimit(modelMap, 'Other Model'), null);

  // 1. Session overrides model & default
  const rSession = resolveEffectiveLimit({
    hostMaxTokens: 512_000,
    sessionCustomLimit: 128_000,
    modelCustomLimit: 200_000,
    defaultCustomLimit: 256_000,
  });
  assert.equal(rSession.source, 'session');
  assert.equal(rSession.effectiveLimit, 128_000);
  assert.equal(rSession.isCustomActive, true);

  // 2. Model overrides default when session is null
  const rModel = resolveEffectiveLimit({
    hostMaxTokens: 512_000,
    sessionCustomLimit: null,
    modelCustomLimit: 200_000,
    defaultCustomLimit: 256_000,
  });
  assert.equal(rModel.source, 'model');
  assert.equal(rModel.effectiveLimit, 200_000);
  assert.equal(rModel.isCustomActive, true);

  // 3. Model limit clamped by hostMaxTokens
  const rModelClamped = resolveEffectiveLimit({
    hostMaxTokens: 128_000,
    sessionCustomLimit: null,
    modelCustomLimit: 256_000,
    defaultCustomLimit: null,
  });
  assert.equal(rModelClamped.source, 'model');
  assert.equal(rModelClamped.effectiveLimit, 128_000);
  assert.equal(rModelClamped.isClampedByHost, true);

  // 4. Default overrides host when session and model are null
  const rDefault = resolveEffectiveLimit({
    hostMaxTokens: 512_000,
    sessionCustomLimit: null,
    modelCustomLimit: null,
    defaultCustomLimit: 256_000,
  });
  assert.equal(rDefault.source, 'default');
  assert.equal(rDefault.effectiveLimit, 256_000);
  assert.equal(rDefault.isCustomActive, true);

  // 5. Host fallback
  const rHost = resolveEffectiveLimit({
    hostMaxTokens: 512_000,
    sessionCustomLimit: null,
    modelCustomLimit: null,
    defaultCustomLimit: null,
  });
  assert.equal(rHost.source, 'host');
  assert.equal(rHost.effectiveLimit, 512_000);
  assert.equal(rHost.isCustomActive, false);
});

test('TC-GLOBAL-02: modelLimits validation, 64-LRU pruning, persistence, and HTTP /api/settings/update modelLimit endpoint', async () => {
  assert.equal(MAX_MODEL_LIMITS, 64);
  assert.equal(validateModelName('  Gemini 4 Neon (High)  '), 'Gemini 4 Neon (High)');
  for (const bad of ['', '   ', 'a'.repeat(129), 'foo\0bar', 'foo\nbar', '__proto__', 'constructor', null]) {
    assert.throws(
      () => validateModelName(bad),
      (e) => e instanceof DomainError && e.code === ERROR_CODES.INVALID_SETTINGS_PATCH,
    );
  }

  // 65 entries -> evicts oldest 1
  const entries65 = Array.from({ length: 65 }, (_, i) => [
    `Model-${String(i).padStart(2, '0')}`,
    { limit: 128_000, updatedAt: i + 1 },
  ]);
  const pruned = pruneModelLimits(entries65);
  assert.equal(pruned.size, 64);
  assert.equal(pruned.has('Model-00'), false);
  assert.equal(pruned.has('Model-64'), true);

  // HTTP + store persistence roundtrip
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-global-model-'));
  const settingsPort = createJsonSettingsStore({ dataDir: tempDir });
  const service = createStatusbarService({
    telemetryPort: {
      listSessions: async () => [{ sessionId: 's1' }],
      getSessionTelemetry: async () => ({
        sessionId: 's1',
        status: 'IDLE',
        modelName: 'Gemini 4 Neon (High)',
        usedTokens: 100_000,
        maxContextTokens: 512_000,
      }),
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false }),
    },
    compactionPort: { compactSession: async () => ({ accepted: true, method: 'rpc' }) },
    settingsPort,
  });
  const sidecar = createSidecarServer({ token: TEST_TOKEN, service });
  const { port } = await sidecar.listen();
  try {
    // Save all-models default (300K) and per-model limit (200K)
    const r1 = await rawPost({ port, reqPath: '/api/settings/update', body: { defaultCustomLimit: 300_000 } });
    assert.equal(r1.status, 200);
    const r2 = await rawPost({
      port,
      reqPath: '/api/settings/update',
      body: { modelLimit: { model: 'Gemini 4 Neon (High)', limit: 200_000 } },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.modelLimits.length, 1);

    // Snapshot resolves model global limit (200K) over all-models default (300K)
    const snap1 = await rawPost({ port, reqPath: '/api/snapshot', body: { sessionId: 's1' } });
    assert.equal(snap1.json.limitSource, 'model');
    assert.equal(snap1.json.effectiveLimit, 200_000);

    // Delete model limit (case-insensitive) -> falls back to all-models default (300K)
    const r3 = await rawPost({
      port,
      reqPath: '/api/settings/update',
      body: { modelLimit: { model: 'gemini 4 neon (high)', limit: null } },
    });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.modelLimits.length, 0);

    const snap2 = await rawPost({ port, reqPath: '/api/snapshot', body: { sessionId: 's1' } });
    assert.equal(snap2.json.limitSource, 'default');
    assert.equal(snap2.json.effectiveLimit, 300_000);

    // Invalid modelLimit rejected with 400
    const rBad = await rawPost({
      port,
      reqPath: '/api/settings/update',
      body: { modelLimit: { model: '', limit: 128_000 } },
    });
    assert.equal(rBad.status, 400);
  } finally {
    await sidecar.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TC-GLOBAL-03: auto-compact fixes A-1 (failure retry after cooldown), A-2 (limit-change reset), A-3 (lastError surface), A-4 (undefined autoCompact defaults ON)', async () => {
  let now = 1_000_000;
  let shouldFailCompact = true;
  let telemetry = {
    sessionId: 'sess-ac',
    status: 'IDLE',
    modelName: 'Gemini 4 Neon (High)',
    usedTokens: 150_000,
    maxContextTokens: 512_000,
    stepCount: 10,
  };
  let stored = {
    locale: 'ko',
    defaultCustomLimit: 128_000,
    autoCompact: undefined, // A-4: undefined must default to enabled (!== false)
    compactPrompt: '',
    customButtons: [],
    disabledRuntimeAddonIds: [],
    modelLimits: new Map(),
    sessions: new Map(),
  };
  let attempts = 0;

  const service = createStatusbarService({
    clock: () => now,
    telemetryPort: {
      listSessions: async () => [{ sessionId: 'sess-ac' }],
      getSessionTelemetry: async () => ({ ...telemetry }),
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false }),
    },
    compactionPort: {
      compactSession: async () => {
        attempts += 1;
        if (shouldFailCompact) {
          return { accepted: false, method: 'rpc', reason: 'LS temporarily busy' };
        }
        return { accepted: true, method: 'rpc' };
      },
    },
    settingsPort: {
      read: async () => ({ ...stored, modelLimits: new Map(stored.modelLimits), sessions: new Map(stored.sessions) }),
      update: async (patch) => {
        if ('defaultCustomLimit' in patch) stored.defaultCustomLimit = patch.defaultCustomLimit;
        if ('autoCompact' in patch) stored.autoCompact = patch.autoCompact;
        if (patch.modelLimit) {
          if (patch.modelLimit.limit === null) stored.modelLimits.delete(patch.modelLimit.model);
          else stored.modelLimits.set(patch.modelLimit.model, { limit: patch.modelLimit.limit, updatedAt: now });
        }
        if (patch.sessionLimit) {
          if (patch.sessionLimit.limit === null) stored.sessions.delete(patch.sessionLimit.sessionId);
          else stored.sessions.set(patch.sessionLimit.sessionId, { limit: patch.sessionLimit.limit, updatedAt: now });
        }
        return { ...stored, modelLimits: new Map(stored.modelLimits), sessions: new Map(stored.sessions) };
      },
    },
  });

  // A-4: autoCompact === undefined triggers when global default (128K) is exceeded
  const s1 = await service.getSessionSnapshot('sess-ac');
  assert.equal(s1.autoCompact, true);
  assert.equal(s1.autoCompactTriggered, true);
  await flush();
  assert.equal(attempts, 1);

  // A-3: Failure reason is exposed in subsequent snapshot (not silently swallowed)
  const sAfterFail = await service.getSessionSnapshot('sess-ac');
  assert.equal(sAfterFail.autoCompactTriggered, false, 'Must respect cooldown immediately after failure');
  assert.ok(sAfterFail.compaction.lastError, 'Failure reason must be surfaced in compaction.lastError');
  assert.ok(sAfterFail.compaction.lastError.message.includes('LS temporarily busy'));

  // A-1: After 90s cooldown expires, auto-compact retries WITHOUT requiring +20K token growth!
  shouldFailCompact = false;
  now += 95_000;
  const sRetry = await service.getSessionSnapshot('sess-ac');
  assert.equal(sRetry.autoCompactTriggered, true, 'Must retry after cooldown expires following failure');
  await flush();
  assert.equal(attempts, 2);

  // Successful acceptance clears lastError
  now += 20_000; // exceed compactCooldownMs (15s) so mutex clears
  const sPostSuccess = await service.getSessionSnapshot('sess-ac');
  assert.equal(sPostSuccess.compaction.lastError, null);
  assert.equal(sPostSuccess.autoCompactTriggered, false, 'waitingForDrop prevents loop after successful compact');

  // A-2: Lowering limit (via modelLimit) clears waitingForDrop & cooldown so auto-compact triggers immediately
  await service.updateSettings({ modelLimit: { model: 'Gemini 4 Neon (High)', limit: 100_000 } });
  const sAfterLimitChange = await service.getSessionSnapshot('sess-ac');
  assert.equal(sAfterLimitChange.limitSource, 'model');
  assert.equal(sAfterLimitChange.autoCompactTriggered, true, 'Lowering limit must reset autoCompactState');
  await flush();
  assert.equal(attempts, 3);
});

test('TC-GLOBAL-04 & TC-GLOBAL-05: Global Limit Modal (all-models + per-model + clear session override), G-1 fresh refresh, and A-3 error note', async () => {
  const { doc, El } = createMockDom();
  const i18n = createInlineI18n('ko');
  const barView = createBarView({ doc, i18n });
  const popoverView = createPopoverView({ doc, i18n });
  const globalModalView = createGlobalLimitModalView({ doc, i18n });

  let snapshotQueue = [];
  const updatePayloads = [];
  let currentMaxTokens = 512_000;
  let currentAutoErr = null;
  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: '',
    defaultCustomLimit: null,
    modelLimits: [],
    sessionLimits: new Map([['sess-m', 256_000]]),
    quotaState: null,
    fallbackSessionId: '',
  };

  const api = {
    isConnected: () => true,
    abortAll() {},
    async post(pathname, body) {
      if (pathname === '/api/snapshot') {
        if (snapshotQueue.length > 0 && snapshotQueue[0].defer) {
          const item = snapshotQueue.shift();
          return new Promise((resolve) => { item.resolve = resolve; });
        }
        return {
          sessionId: body.sessionId,
          modelName: 'Gemini 4 Neon (High)',
          usedTokens: 100_000,
          effectiveLimit: sharedState.sessionLimits.get(body.sessionId) || sharedState.defaultCustomLimit || currentMaxTokens,
          maxContextTokens: currentMaxTokens,
          limitSource: sharedState.sessionLimits.has(body.sessionId) ? 'session' : sharedState.defaultCustomLimit ? 'default' : 'host',
          customLimit: sharedState.sessionLimits.get(body.sessionId) ?? sharedState.defaultCustomLimit ?? null,
          usagePercent: 39,
          compaction: { inProgress: false, trigger: null, lastError: currentAutoErr },
        };
      }
      if (pathname === '/api/settings/update') {
        updatePayloads.push(body);
        if ('defaultCustomLimit' in body) sharedState.defaultCustomLimit = body.defaultCustomLimit;
        if (body.modelLimit) {
          sharedState.modelLimits = sharedState.modelLimits.filter((m) => m.model !== body.modelLimit.model);
          if (body.modelLimit.limit !== null) {
            sharedState.modelLimits.push({ model: body.modelLimit.model, limit: body.modelLimit.limit, updatedAt: Date.now() });
          }
        }
        if (body.sessionLimit) {
          if (body.sessionLimit.limit === null) sharedState.sessionLimits.delete(body.sessionLimit.sessionId);
          else sharedState.sessionLimits.set(body.sessionLimit.sessionId, body.sessionLimit.limit);
        }
        return {
          locale: 'ko',
          autoCompact: true,
          compactPrompt: '',
          defaultCustomLimit: sharedState.defaultCustomLimit,
          modelLimits: [...sharedState.modelLimits],
          sessions: Array.from(sharedState.sessionLimits.entries()).map(([sessionId, limit]) => ({ sessionId, limit })),
          customButtons: [],
          disabledRuntimeAddonIds: [],
        };
      }
      return {};
    },
  };

  const addons = createAddonRegistry({ api, onChange() {} });
  const ctrl = createBarController({
    doc,
    api,
    i18n,
    addons,
    barView,
    popoverView,
    globalModalView,
    sharedState,
    onSettingsChanged() {},
    onBurstRequested() {},
  });

  const viewEl = new El('div', doc);
  viewEl.setAttribute('data-cascade-id', 'sess-m');
  ctrl.setTargetView(viewEl);
  await flush();

  // G-1: Typing value BEFORE switching scope preserves the value instead of wiping it
  barView.ctxBtn.click();
  popoverView.customInput.value = '180000';
  popoverView.customInput.dispatchEvent({ type: 'input', target: popoverView.customInput });
  popoverView.scopeSelect.value = 'default';
  popoverView.scopeSelect.dispatchEvent({ type: 'change', target: popoverView.scopeSelect });
  assert.equal(popoverView.customInput.value, '180000', 'G-1: Switching scope with dirty input must preserve value');

  // Open Global Context Limit Modal from popover
  popoverView.openGlobalModalBtn.click();
  assert.equal(globalModalView.backdropEl.classList.contains('hidden'), false);
  assert.equal(popoverView.popEl.classList.contains('hidden'), true);

  // Session override warning banner is visible because sess-m has 256K override
  const overrideBanner = globalModalView.dialogEl.querySelector('.agy-inline-override-banner');
  assert.equal(overrideBanner.classList.contains('hidden'), false);

  // Save all-models global default (200K) -> warns that current session override (256K) masks it
  globalModalView.defaultInput.value = '200000';
  globalModalView.defaultApplyBtn.click();
  await flush();
  assert.deepEqual(updatePayloads[updatePayloads.length - 1], { defaultCustomLimit: 200_000 });
  const modalFb = globalModalView.dialogEl.querySelector('.agy-inline-pop-feedback').textContent;
  assert.ok(modalFb.includes('256.0K'), 'Modal feedback must inform user when current session override masks global default');

  // Use current model button populates modelNameInput, then save per-model global limit
  globalModalView.useCurrentModelBtn.click();
  assert.equal(globalModalView.modelNameInput.value, 'Gemini 4 Neon (High)');
  globalModalView.modelLimitInput.value = '192000';
  globalModalView.modelSaveBtn.click();
  await flush();
  assert.deepEqual(updatePayloads[updatePayloads.length - 1], {
    modelLimit: { model: 'Gemini 4 Neon (High)', limit: 192_000 },
  });

  // Clear current session override in one click -> banner hides!
  globalModalView.clearSessionLimitBtn.click();
  await flush();
  assert.deepEqual(updatePayloads[updatePayloads.length - 1], {
    sessionLimit: { sessionId: 'sess-m', limit: null },
  });
  assert.equal(overrideBanner.classList.contains('hidden'), true);

  // Escape closes modal and returns focus to visible bar settings button (ISS-10)
  doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(globalModalView.backdropEl.classList.contains('hidden'), true);
  assert.equal(doc.activeElement, barView.settingsBtn);

  // G-1: Concurrent in-flight snapshot does NOT cause handleApplyLimit to inspect stale maxContextTokens
  const deferredPoll = { defer: true, resolve: null };
  snapshotQueue.push(deferredPoll);
  const bgPollPromise = ctrl.refreshSnapshot(); // now inFlight === true
  currentMaxTokens = 128_000; // backend now reports 128K host max on the NEXT fresh poll
  popoverView.scopeSelect.value = 'session';
  popoverView.customInput.value = '200000';
  popoverView.applyBtn.click();
  await flush(10);
  // Complete the stale in-flight poll (with old 512K); fresh follow-up poll will fetch 128K
  deferredPoll.resolve({
    sessionId: 'sess-m',
    modelName: 'Gemini 4 Neon (High)',
    usedTokens: 50_000,
    effectiveLimit: 512_000,
    maxContextTokens: 512_000,
    usagePercent: 10,
  });
  await bgPollPromise;
  await flush();
  const clampedFb = popoverView.popEl.querySelector('.agy-inline-pop-feedback').textContent;
  assert.ok(clampedFb.includes('128.0K'), `Expected fresh 128.0K clamped toast, got: ${clampedFb}`);

  // A-3: Auto-compact failure surfaces in statusbar note
  currentAutoErr = { code: 'COMPACTION_FAILED', message: 'RPC timeout', at: 999999 };
  await ctrl.refreshSnapshot({ waitForFresh: true });
  const noteText = barView.barEl.querySelector('.agy-inline-status-note').textContent;
  assert.ok(noteText.includes('RPC timeout'));

  ctrl.destroy();
});

test('TC-GLOBAL-06: G-2 AUX_PANE app.js syncs global default scope on scope switch and renders model source label', async () => {
  const { doc, El } = createMockDom();
  const ids = [
    'panel-title', 'conn-badge', 'btn-locale', 'lbl-session', 'session-mode-badge',
    'session-select', 'lbl-context', 'context-pct', 'context-progress', 'context-progress-fill',
    'context-tokens', 'context-limit-tag', 'soft-limit-banner', 'soft-limit-banner-text',
    'btn-compact', 'btn-context-detail', 'compact-status', 'context-detail-panel',
    'lbl-detail-title', 'detail-steps', 'detail-model', 'breakdown-list',
    'lbl-custom-limit', 'limit-scope-select', 'limit-preset-select', 'limit-custom-input',
    'btn-apply-limit', 'limit-feedback', 'lbl-cache', 'cache-pct', 'cache-detail',
    'lbl-quota', 'quota-stale-badge', 'quota-groups',
  ];
  for (const id of ids) doc.registerId(id);

  const scopeSel = doc.getElementById('limit-scope-select');
  const optS = new El('option', doc); optS.value = 'session'; scopeSel.appendChild(optS);
  const optD = new El('option', doc); optD.value = 'default'; scopeSel.appendChild(optD);
  scopeSel.value = 'session';

  const bridge = {
    getSettings: async () => ({ locale: 'ko', defaultCustomLimit: 256_000 }),
    listSessions: async () => ({ sessions: [{ sessionId: 's-aux', title: 'Aux' }] }),
    getSessionSnapshot: async () => ({
      sessionId: 's-aux',
      locale: 'ko',
      usedTokens: 50_000,
      effectiveLimit: 192_000,
      maxContextTokens: 512_000,
      customLimit: 192_000,
      limitSource: 'model',
      usagePercent: 26,
      thresholdLevel: 'normal',
      exceededSoftLimit: false,
      compaction: { inProgress: false, status: 'idle' },
      tokenBreakdown: [],
    }),
    getQuotaSummary: async () => ({ available: false, groups: [], stale: false }),
    updateSettings: async (patch) => ({ locale: 'ko', defaultCustomLimit: patch.defaultCustomLimit ?? 256_000 }),
    requestCompaction: async () => ({ accepted: true }),
  };

  const app = createStatusbarApp({ doc, win: {}, bridge });
  await app.start();

  // Renders '모델별 전역' source badge without leaking model limit into session input (ISS-09)
  assert.equal(doc.getElementById('context-limit-tag').textContent, '모델별 전역');
  assert.equal(doc.getElementById('limit-custom-input').value, '');

  // Switching scope to 'default' displays stored global default (256000)
  scopeSel.value = 'default';
  scopeSel.dispatchEvent({ type: 'change', target: scopeSel });
  assert.equal(doc.getElementById('limit-custom-input').value, '256000');

  app.dispose();
});
