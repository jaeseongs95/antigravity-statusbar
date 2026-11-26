import assert from 'node:assert/strict';
import test from 'node:test';

import { createAddonRegistry } from '../../src/adapters/antigravity/addon/addon-bridge.mjs';
import { createSidecarApiClient } from '../../src/adapters/antigravity/addon/api-client.mjs';
import { createBarController } from '../../src/adapters/antigravity/addon/bar-controller.mjs';
import { createBarView } from '../../src/adapters/antigravity/addon/bar-view.mjs';
import { startAddonStatusbar, startStandbyStatusbar } from '../../src/adapters/antigravity/addon/bootstrap.mjs';
import { createInlineI18n } from '../../src/adapters/antigravity/addon/i18n.mjs';
import { STATUSBAR_STYLE_ID, STATUSBAR_STYLES } from '../../src/adapters/antigravity/addon/styles.mjs';
import { createDeclarativeUiSchemas } from '../../src/adapters/antigravity/addon/ui-schemas.mjs';

const TEST_TOKEN = 'unit-ui-modules-token-32-chars-ok';

function createUnitMockDom() {
  class ClassList {
    constructor() {
      this._s = new Set();
    }
    _set(str) {
      this._s = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _str() {
      return Array.from(this._s).join(' ');
    }
    contains(n) {
      return this._s.has(n);
    }
    toggle(n, force) {
      if (force === undefined) {
        if (this._s.has(n)) {
          this._s.delete(n);
          return false;
        }
        this._s.add(n);
        return true;
      }
      if (force) {
        this._s.add(n);
        return true;
      }
      this._s.delete(n);
      return false;
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
      this.offsetParent = {};
      this.visible = true;
    }
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get className() {
      return this.classList._str();
    }
    set className(v) {
      this.classList._set(v);
    }
    get textContent() {
      if (this.childNodes.length === 0) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.childNodes = [];
      this._text = String(v ?? '');
    }
    setAttribute(k, v) {
      this.attributes.set(String(k), String(v));
    }
    getAttribute(k) {
      return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
    }
    removeAttribute(k) {
      this.attributes.delete(String(k));
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) {
        this.childNodes.splice(i, 1);
        child.parentNode = null;
      }
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    contains(other) {
      let c = other;
      while (c) {
        if (c === this) return true;
        c = c.parentNode;
      }
      return false;
    }
    matches(sel) {
      const m = /^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/.exec(sel);
      if (m) return this.getAttribute(m[1]) === m[2];
      if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
      return this.tagName === sel.toUpperCase();
    }
    closest(sel) {
      let c = this;
      while (c && c.nodeType === 1) {
        if (c.matches(sel)) return c;
        c = c.parentNode;
      }
      return null;
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
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    dispatchEvent(evt) {
      const set = this.listeners.get(evt.type);
      if (!set) return;
      for (const fn of Array.from(set)) fn(evt);
    }
    click(extra = {}) {
      this.dispatchEvent({ type: 'click', target: this, isTrusted: true, preventDefault() {}, ...extra });
    }
    focus() {
      this.ownerDocument.activeElement = this;
    }
    getClientRects() {
      return this.visible ? [{ width: 320, height: 36 }] : [];
    }
  }

  const docListeners = new Map();
  const doc = {
    body: null,
    activeElement: null,
    createElement(tag) {
      return new El(tag, doc);
    },
    querySelectorAll(sel) {
      return doc.body ? doc.body.querySelectorAll(sel) : [];
    },
    contains(node) {
      return Boolean(doc.body && doc.body.contains(node));
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      const set = docListeners.get(evt.type);
      if (!set) return;
      for (const fn of Array.from(set)) fn(evt);
    },
    getListenerCount(type) {
      return docListeners.get(type)?.size || 0;
    },
  };
  doc.body = new El('body', doc);
  return { doc, El };
}

function findSchemaNode(tree, id) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.id === id) return tree;
  if (Array.isArray(tree.children)) {
    for (const ch of tree.children) {
      const found = findSchemaNode(ch, id);
      if (found) return found;
    }
  }
  return null;
}

function createFakeV3HostPort({ surface = 'desktop' } = {}) {
  const toasts = [];
  const commands = new Map();
  const services = new Map();
  const storageMap = new Map();
  let activePopup = null;
  let activeModal = null;
  let settingsPage = null;

  const hostPort = {
    pluginId: 'antigravity-statusbar',
    apiVersion: 3,
    schemaVersion: 3,
    surface,
    layoutMode: 'desktop',
    capabilities: { hasLocalLoopback: surface === 'desktop', hasNetHttps: false, hasSettingsBridge: false },
    slotId: 'antigravity-statusbar.root',
    storage: {
      async get(key) {
        return storageMap.has(key) ? storageMap.get(key) : null;
      },
      async set(key, val) {
        storageMap.set(key, val);
      },
      async delete(key) {
        storageMap.delete(key);
      },
      onDidChange() {
        return () => {};
      },
    },
    services: {
      provide(name, impl, opts) {
        services.set(name, { impl, opts });
        return { dispose() { services.delete(name); } };
      },
    },
    mountSlot() {
      return null;
    },
    unmountSlot() {
      return true;
    },
    injectStyle() {},
    removeStyle() {
      return true;
    },
    onDispose() {},
    showToast(opts) {
      toasts.push(opts);
    },
    openPopup(opts) {
      const rec = {
        opts,
        tree: opts.tree,
        state: { ...(opts.state || {}) },
        closed: false,
        update(nextTree, nextState) {
          rec.tree = nextTree;
          rec.state = { ...(nextState || {}) };
        },
        close() {
          if (rec.closed) return;
          rec.closed = true;
          activePopup = null;
          if (typeof opts.onClose === 'function') opts.onClose();
        },
      };
      activePopup = rec;
      return rec;
    },
    openModal(opts) {
      const rec = {
        opts,
        tree: opts.tree,
        state: { ...(opts.state || {}) },
        closed: false,
        update(nextTree, nextState) {
          rec.tree = nextTree;
          rec.state = { ...(nextState || {}) };
        },
        close() {
          if (rec.closed) return;
          rec.closed = true;
          activeModal = null;
          if (typeof opts.onClose === 'function') opts.onClose();
        },
      };
      activeModal = rec;
      return rec;
    },
    registerCommand(id, spec) {
      commands.set(id, spec);
      return { dispose() { commands.delete(id); } };
    },
    registerSettingsPage(spec) {
      const rec = {
        spec,
        openFlag: false,
        tree: spec.schema,
        state: { ...(spec.state || {}) },
        open() {
          rec.openFlag = true;
          rec.tree = typeof spec.getSchema === 'function' ? spec.getSchema() : spec.schema;
          rec.state = typeof spec.getState === 'function' ? spec.getState() : { ...(spec.state || {}) };
          return rec;
        },
        update(nextTree, nextState) {
          if (nextTree) rec.tree = nextTree;
          if (nextState) rec.state = { ...nextState };
        },
        close() {
          rec.openFlag = false;
          if (typeof spec.onClose === 'function') spec.onClose();
        },
        dispose() {
          rec.openFlag = false;
          settingsPage = null;
        },
      };
      settingsPage = rec;
      return rec;
    },
  };

  return {
    hostPort,
    toasts,
    commands,
    services,
    storageMap,
    getPopup: () => activePopup,
    getModal: () => activeModal,
    getSettingsPage: () => settingsPage,
  };
}

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

test('TC-UNIT-03: bar-view.mjs renders thresholds (warn/danger/unclamped>100%), badge precedence, quota min+stale, host.statusbar delegated items, and addon buttons', () => {
  const { doc } = createUnitMockDom();
  const i18n = createInlineI18n('ko');
  const view = createBarView({ doc, i18n });

  view.renderSnapshot({ snap: null, connected: false, compacting: false, hasSession: false, compactPrompt: '' });
  assert.ok(view.ctxBtn.textContent.includes('연결 중'));
  assert.equal(view.compactBtn.disabled, true);

  view.renderSnapshot({
    snap: null,
    connected: false,
    configured: false,
    isRemoteWeb: false,
    compacting: false,
    hasSession: false,
    compactPrompt: '',
  });
  assert.equal(view.ctxBtn.textContent, i18n.t().standby);

  view.renderSnapshot({
    snap: null,
    connected: false,
    configured: false,
    isRemoteWeb: true,
    remoteBridgeConnected: false,
    compacting: false,
    hasSession: false,
    compactPrompt: '',
  });
  assert.equal(view.ctxBtn.textContent, i18n.t().remoteSetupNeeded);

  view.renderSnapshot({
    snap: null,
    connected: false,
    configured: false,
    isRemoteWeb: true,
    remoteBridgeConnected: true,
    compacting: false,
    hasSession: false,
    compactPrompt: '',
  });
  assert.equal(view.ctxBtn.textContent, i18n.t().standby);
  view.setRemoteDockMode(true);
  assert.equal(view.barEl.classList.contains('agy-remote-dock'), true);
  view.setRemoteDockMode(false);
  assert.equal(view.barEl.classList.contains('agy-remote-dock'), false);

  view.setReconnecting();
  assert.ok(view.ctxBtn.textContent.includes('재연결'));

  const fill = view.barEl.querySelector('.agy-inline-bar-fill');
  const badge = view.barEl.querySelector('.agy-inline-badge');
  view.renderSnapshot({
    snap: { usedTokens: 150000, effectiveLimit: 200000, usagePercent: 75, cacheHitPercent: 60 },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '핵심만',
  });
  assert.equal(fill.style.width, '75%');
  assert.equal(fill.classList.contains('warn'), true);
  assert.equal(badge.style.display, 'none');
  assert.equal(view.compactBtn.title, '/compact 핵심만');

  view.renderSnapshot({
    snap: {
      usedTokens: 234000,
      effectiveLimit: 200000,
      usagePercent: 117,
      exceededSoftLimit: true,
      autoCompactTriggered: true,
      compaction: { inProgress: true, trigger: 'auto' },
      cache: { hitRatePercent: 88.4 },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
  });
  assert.equal(fill.style.width, '100%');
  assert.equal(fill.classList.contains('danger'), true);
  assert.ok(view.ctxBtn.textContent.includes('117%'));
  assert.equal(badge.textContent, i18n.t().autoCompacting);
  assert.equal(view.compactBtn.disabled, true);

  // host.statusbar delegated items (left & right, badge, tooltip, trusted click payload, untrusted click rejected)
  const delegatedClicks = [];
  view.renderDelegatedItems({
    leftItems: [
      {
        pluginId: 'p-left',
        id: 'sync',
        label: 'Sync',
        icon: '⚡',
        badge: '3',
        tooltip: 'Sync status',
        onClick(ev) {
          delegatedClicks.push(['left', ev]);
        },
      },
    ],
    rightItems: [
      {
        pluginId: 'p-right',
        id: 'tr',
        label: '번역:구글',
        icon: '',
        badge: '',
        tooltip: 'Translate',
        onClick(ev) {
          delegatedClicks.push(['right', ev]);
        },
      },
    ],
  });
  assert.equal(view.leftDelegatedContainer.childNodes.length, 1);
  assert.equal(view.rightDelegatedContainer.childNodes.length, 1);
  const leftBtn = view.leftDelegatedContainer.childNodes[0];
  assert.equal(leftBtn.title, 'Sync status');
  assert.ok(leftBtn.textContent.includes('⚡ Sync'));
  assert.ok(leftBtn.textContent.includes('3'));
  // Untrusted click ignored
  leftBtn.click({ isTrusted: false });
  assert.equal(delegatedClicks.length, 0);
  // Trusted click delivers modifiers + anchorEl
  leftBtn.click({ isTrusted: true, altKey: true });
  assert.equal(delegatedClicks.length, 1);
  assert.equal(delegatedClicks[0][1].altKey, true);
  assert.equal(delegatedClicks[0][1].anchorEl, leftBtn);

  // Addon buttons skip disabled persisted items
  const clicks = [];
  view.renderAddonButtons({
    persistedButtons: [
      { id: 'a', label: 'A', command: '/a', enabled: true },
      { id: 'b', label: 'B', command: '/b', enabled: false },
    ],
    runtimeButtons: [{ id: 'r', label: 'R', title: 'Run R' }],
    onPersistedClick(def) { clicks.push(['p', def.id]); },
    onRuntimeClick(def) { clicks.push(['r', def.id]); },
  });
  const customContainer = view.barEl.querySelector('.agy-inline-custom-btns');
  assert.equal(customContainer.childNodes.length, 2);
  customContainer.childNodes[0].click();
  customContainer.childNodes[1].click();
  assert.deepEqual(clicks, [['p', 'a'], ['r', 'r']]);
});

test('TC-UNIT-03b (v3.3.0): localized quota tooltip timestamps, 5h HH:mm local reset display, Neon-to-Gemini matching, and subagent model pill', () => {
  const toExpectedHHMM = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const toExpectedLocalDT = (iso) => {
    const d = new Date(iso);
    return (
      `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    );
  };

  const koI18n = createInlineI18n('ko');
  const iso5h = '2026-11-23T14:05:00Z';
  const isoWeekly = '2026-11-30T00:00:00Z';
  const { doc } = createUnitMockDom();
  const view = createBarView({ doc, i18n: koI18n });

  view.renderQuota(
    {
      available: true,
      stale: false,
      groups: [
        {
          label: 'Gemini Models',
          buckets: [
            { window: '5h', remainingPercent: 100, resetTime: iso5h },
            { window: 'weekly', remainingPercent: 80, resetTime: isoWeekly },
          ],
        },
        {
          label: 'Claude and GPT models',
          buckets: [
            { window: '5h', remainingPercent: 0, resetTime: iso5h },
            { window: 'weekly', remainingPercent: 58, resetTime: isoWeekly },
          ],
        },
      ],
    },
    'Neon High',
  );
  assert.equal(view.quota5hEl.textContent, `5시간 한도 100% (${toExpectedHHMM(iso5h)})`);
  assert.equal(view.quotaEl.textContent, '주간한도 80%');
  assert.ok(view.quota5hEl.title.includes(`초기화 ${toExpectedLocalDT(iso5h)}`));
  assert.equal(view.quota5hEl.title.includes(iso5h), false);

  view.renderSnapshot({
    snap: {
      usedTokens: 48000,
      effectiveLimit: 200000,
      usagePercent: 24,
      modelName: 'Gemini 4 Neon (High)',
      isSubagent: true,
      compaction: { inProgress: false, status: 'idle' },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
    isSubagent: true,
  });
  assert.equal(view.modelEl.style.display, '');
  assert.equal(view.modelEl.textContent, 'Gemini 4 Neon (High)');
});

test('TC-UNIT-04: ui-schemas.mjs builds valid Tier-2 declarative trees (Context Popup, Global Limits Modal, and Desktop vs Remote Web Settings parity)', () => {
  const i18n = createInlineI18n('ko');
  const schemas = createDeclarativeUiSchemas({ i18n });

  // 1. Context Popup schema: over-max preset annotation, sorted localized progress bars, inputType: 'text'
  const ctxSpec = schemas.buildContextPopupSpec({
    snap: {
      maxContextTokens: 512000,
      effectiveLimit: 512000,
      customLimit: 980000,
      limitSource: 'session',
      isClampedByHost: true,
      modelName: 'Gemini Neon',
      stepCount: 120,
      tokenBreakdown: [
        { label: 'System', tokens: 20000 },
        { label: 'Zero', tokens: 0 },
        { label: 'Chat Messages', tokens: 80000 },
      ],
    },
    scope: 'session',
    customLimit: '980000',
    preset: '980000',
    feedback: 'Invalid',
    feedbackIsErr: true,
  });
  const presetNode = findSchemaNode(ctxSpec.tree, 'ctx-preset-select');
  assert.ok(presetNode.options.find((o) => o.value === '980000').label.includes('512.0K'));
  const customInput = findSchemaNode(ctxSpec.tree, 'ctx-custom-input');
  assert.equal(customInput.inputType, 'text');
  const bdSec = findSchemaNode(ctxSpec.tree, 'ctx-breakdown-sec');
  assert.equal(bdSec.children.length, 2, 'Zero-token items must be omitted');
  assert.ok(bdSec.children[0].label.includes('대화 메시지'));
  assert.ok(bdSec.children[1].label.includes('시스템'));
  const feedbackNode = findSchemaNode(ctxSpec.tree, 'ctx-feedback');
  assert.equal(feedbackNode.variant, 'danger');
  assert.equal(ctxSpec.state.hasFeedback, true);

  // 2. Desktop Settings Page omits Remote Host Bridge section; Remote Web shows read-only status with zero URL/token inputs
  const desktopSettings = schemas.buildSettingsPageSpec({
    isRemoteWeb: false,
    autoCompact: true,
    compactPrompt: 'abcde',
    addonsList: [
      { id: 'p1', label: 'Plan', source: 'agent', enabled: true, runtime: false, delegated: false },
      { id: 'peer:mode', label: '번역', source: 'peer', enabled: true, runtime: true, delegated: true },
    ],
    locale: 'ko',
  });
  assert.equal(findSchemaNode(desktopSettings.tree, 'set-remote-bridge-sec'), null, 'Desktop settings schema must omit Remote Host Bridge section');
  assert.equal(findSchemaNode(desktopSettings.tree, 'set-remote-url'), null);
  assert.equal(findSchemaNode(desktopSettings.tree, 'set-remote-token'), null);
  assert.equal(findSchemaNode(desktopSettings.tree, 'set-prompt-count').text, '5 / 1,000');

  const remoteSettings = schemas.buildSettingsPageSpec({
    isRemoteWeb: true,
    remoteBridgeBadgeText: 'Host Bridge 미연결',
    remoteBridgeBadgeVariant: 'warning',
    remoteBridgeStatusText: i18n.t().remoteBridgeGuideDisconnected,
    remoteBridgeStatusVariant: 'warning',
    autoCompact: true,
    compactPrompt: '',
    addonsList: [],
    locale: 'ko',
  });
  assert.ok(findSchemaNode(remoteSettings.tree, 'set-remote-bridge-sec'));
  assert.equal(findSchemaNode(remoteSettings.tree, 'set-remote-bridge-badge').text, 'Host Bridge 미연결');
  assert.ok(findSchemaNode(remoteSettings.tree, 'set-remote-bridge-status').text.includes('Host Bridge'));
  assert.equal(findSchemaNode(remoteSettings.tree, 'set-remote-url'), null, 'Must NOT render plugin-owned Sidecar URL input');
  assert.equal(findSchemaNode(remoteSettings.tree, 'set-remote-token'), null, 'Must NOT render plugin-owned X-Statusbar-Token input');
  assert.equal(findSchemaNode(remoteSettings.tree, 'set-remote-connect-btn'), null);
  assert.equal(findSchemaNode(remoteSettings.tree, 'set-remote-disconnect-btn'), null);

  // 3. Global Limit Modal schema
  const modalSpec = schemas.buildGlobalLimitModalSpec({
    defaultCustomLimit: 200000,
    defaultLimitInput: '200000',
    modelLimits: [{ model: 'Gemini 4 Neon (High)', limit: 128000 }],
    currentModelName: 'Gemini 4 Neon (High)',
    sessionOverrideLimit: 256000,
  });
  assert.equal(modalSpec.state.hasSessionOverride, true);
  assert.equal(modalSpec.state.hasCurrentModel, true);
  assert.ok(findSchemaNode(modalSpec.tree, 'gm-override-alert').text.includes('256.0K'));
});

test('TC-UNIT-05: bar-controller.mjs coalesces refreshes, protects dirty drafts across polls, validates limit bounds, drives Tier 1/2 overlays & toasts, and cleans up on destroy', async () => {
  const { doc, El } = createUnitMockDom();
  const i18n = createInlineI18n('ko');
  const barView = createBarView({ doc, i18n });
  const uiSchemas = createDeclarativeUiSchemas({ i18n });
  const fakeHost = createFakeV3HostPort({ surface: 'desktop' });

  const snapshotDeferred = [];
  let compactError = null;
  const sentRequests = [];
  const api = {
    isConnected: () => true,
    abortAll() {},
    async post(pathname, body, signal) {
      sentRequests.push({ pathname, body });
      if (pathname === '/api/snapshot') {
        return new Promise((resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }
          snapshotDeferred.push({ body, resolve });
        });
      }
      if (pathname === '/api/compact' && compactError) {
        const e = new Error(compactError.message);
        e.code = compactError.code;
        throw e;
      }
      if (pathname === '/api/settings/update') {
        return {
          locale: body.locale || 'ko',
          autoCompact: body.autoCompact ?? true,
          compactPrompt: body.compactPrompt ?? '',
          defaultCustomLimit: body.defaultCustomLimit ?? null,
          sessions: body.sessionLimit?.limit
            ? [{ sessionId: body.sessionLimit.sessionId, limit: body.sessionLimit.limit }]
            : [],
          customButtons: [],
          disabledRuntimeAddonIds: [],
        };
      }
      return { ok: true };
    },
  };

  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: 'initial',
    defaultCustomLimit: 128000,
    modelLimits: [],
    sessionLimits: new Map([['sess-1', 256000]]),
    quotaState: null,
    fallbackSessionId: '',
  };

  const addons = createAddonRegistry({ api, onChange() {} });
  const ctrl = createBarController({
    api,
    i18n,
    addons,
    barView,
    uiSchemas,
    hostPort: fakeHost.hostPort,
    sharedState,
    onSettingsChanged(updated) {
      if (typeof updated.compactPrompt === 'string') sharedState.compactPrompt = updated.compactPrompt;
      if (updated.defaultCustomLimit !== undefined) sharedState.defaultCustomLimit = updated.defaultCustomLimit;
    },
    onBurstRequested() {},
  });

  const view1 = new El('div', doc);
  view1.setAttribute('data-cascade-id', 'sess-1');
  ctrl.setTargetView(view1);

  // Coalesce concurrent refreshes
  ctrl.refreshSnapshot();
  ctrl.refreshSnapshot();
  assert.equal(snapshotDeferred.length, 1);
  snapshotDeferred.shift().resolve({
    sessionId: 'sess-1',
    usedTokens: 50000,
    effectiveLimit: 256000,
    maxContextTokens: 512000,
    usagePercent: 19.5,
  });
  await flush();
  assert.equal(snapshotDeferred.length, 1);
  snapshotDeferred.shift().resolve({
    sessionId: 'sess-1',
    usedTokens: 60000,
    effectiveLimit: 256000,
    maxContextTokens: 512000,
    usagePercent: 23.4,
  });
  await flush();

  // Open Tier-2 Context Popup & verify dirty draft preserved across render
  barView.ctxBtn.click();
  const popup = fakeHost.getPopup();
  assert.ok(popup, 'Clicking ctxBtn must open Tier-2 popup');
  assert.equal(popup.state.customLimit, '256000');
  popup.opts.onChange({ field: 'customLimit', value: '180000' });
  ctrl.render();
  assert.equal(popup.state.customLimit, '180000', 'Dirty draft must survive background render');

  // Limit boundary rejection (<32000 and >980000)
  popup.opts.onChange({ field: 'customLimit', value: '31999' });
  popup.opts.onAction({ actionId: 'apply-limit' });
  await flush();
  assert.equal(sentRequests.filter((r) => r.pathname === '/api/settings/update').length, 0);
  assert.equal(popup.state.hasFeedback, true);

  popup.opts.onChange({ field: 'customLimit', value: '980001' });
  popup.opts.onAction({ actionId: 'apply-limit' });
  await flush();
  assert.equal(sentRequests.filter((r) => r.pathname === '/api/settings/update').length, 0);

  // Scope switch to default loads 128000; blank resets to null
  popup.opts.onChange({ field: 'customLimit', value: '' });
  popup.opts.onChange({ field: 'scope', value: 'default' });
  assert.equal(popup.state.customLimit, '128000');
  popup.opts.onChange({ field: 'customLimit', value: '' });
  popup.opts.onAction({ actionId: 'apply-limit' });
  await flush();
  if (snapshotDeferred.length > 0) {
    snapshotDeferred.shift().resolve({
      sessionId: 'sess-1',
      usedTokens: 60000,
      effectiveLimit: 512000,
      maxContextTokens: 512000,
      usagePercent: 11.7,
    });
    await flush();
  }
  assert.ok(
    sentRequests.some((r) => r.pathname === '/api/settings/update' && r.body.defaultCustomLimit === null),
  );

  // Open Tier-1 Settings Page & save compactPrompt
  barView.settingsBtn.click();
  const settingsPage = fakeHost.getSettingsPage();
  assert.equal(settingsPage.openFlag, true);
  settingsPage.spec.onChange({ field: 'compactPrompt', value: '핵심만' });
  settingsPage.spec.onAction({ actionId: 'save-compact-prompt' });
  await flush();
  assert.ok(
    sentRequests.some((r) => r.pathname === '/api/settings/update' && r.body.compactPrompt === '핵심만'),
  );

  // COMPACTION_IN_PROGRESS error emits localized note & danger toast
  compactError = { code: 'COMPACTION_IN_PROGRESS', message: 'busy' };
  barView.compactBtn.click();
  await flush();
  assert.equal(barView.barEl.querySelector('.agy-inline-status-note').textContent, i18n.t().compactInProgress);
  assert.ok(fakeHost.toasts.some((t) => t.variant === 'danger' && t.message === i18n.t().compactInProgress));

  ctrl.destroy();
  assert.equal(fakeHost.getPopup(), null);
  assert.equal(fakeHost.getSettingsPage(), null);
});

test('TC-UNIT-05b (v3.1.1): bar-controller.mjs shows read-only Host Bridge guidance when offline or on ERR_REMOTE_HOST_NOT_CONNECTED, and renders live data when Host Bridge is connected', async () => {
  const { doc } = createUnitMockDom();
  const i18n = createInlineI18n('ko');
  const barView = createBarView({ doc, i18n });
  const uiSchemas = createDeclarativeUiSchemas({ i18n });
  const fakeHost = createFakeV3HostPort({ surface: 'remote-web' });

  let bridgeConnected = false;
  let bridgeBaseUrl = '';
  let configured = false;
  let connected = false;
  let returnBridgeOfflineErr = false;
  let postCount = 0;
  const api = {
    isConfigured: () => configured,
    isConnected: () => connected,
    abortAll() {},
    async post(pathname) {
      postCount += 1;
      if (returnBridgeOfflineErr) {
        connected = false;
        const err = new Error('ERR_REMOTE_HOST_NOT_CONNECTED');
        err.code = 'ERR_REMOTE_HOST_NOT_CONNECTED';
        throw err;
      }
      connected = true;
      if (pathname === '/api/snapshot') {
        return {
          sessionId: 'sess-remote-unit',
          usedTokens: 64000,
          effectiveLimit: 200000,
          maxContextTokens: 512000,
          usagePercent: 32,
          compaction: { inProgress: false, lastError: null },
        };
      }
      return {};
    },
  };

  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: '',
    defaultCustomLimit: null,
    modelLimits: [],
    sessionLimits: new Map(),
    quotaState: null,
    fallbackSessionId: 'sess-remote-unit',
  };
  const addons = createAddonRegistry({ api, onChange() {} });
  const ctrl = createBarController({
    api,
    i18n,
    addons,
    barView,
    uiSchemas,
    hostPort: fakeHost.hostPort,
    sharedState,
    isRemoteWeb: true,
    getRemoteBridgeState: () => ({ connected: bridgeConnected, baseUrl: bridgeBaseUrl }),
    onSettingsChanged() {},
    onBurstRequested() {},
  });

  // 1. Disconnected Host Bridge: zero polling, bar shows Host Bridge offline, Settings shows read-only guidance
  ctrl.render();
  await ctrl.refreshSnapshot();
  assert.equal(postCount, 0);
  assert.equal(barView.ctxBtn.textContent, i18n.t().remoteSetupNeeded);
  barView.ctxBtn.click();
  const settingsPage = fakeHost.getSettingsPage();
  assert.equal(settingsPage.openFlag, true);
  assert.equal(findSchemaNode(settingsPage.tree, 'set-remote-url'), null);
  assert.equal(findSchemaNode(settingsPage.tree, 'set-remote-token'), null);
  assert.equal(findSchemaNode(settingsPage.tree, 'set-remote-bridge-badge').text, i18n.t().remoteBridgeBadgeOffline);
  assert.equal(findSchemaNode(settingsPage.tree, 'set-remote-bridge-status').text, i18n.t().remoteBridgeGuideDisconnected);

  // 2. Host Bridge connected + Sidecar active: renders snapshot and connected status
  bridgeConnected = true;
  bridgeBaseUrl = 'http://127.0.0.1:19384';
  configured = true;
  await ctrl.refreshSnapshot();
  assert.equal(postCount, 1);
  assert.ok(barView.ctxBtn.textContent.includes('64.0K'));
  assert.equal(findSchemaNode(settingsPage.tree, 'set-remote-bridge-badge').text, i18n.t().remoteBridgeBadgeConnected);
  assert.ok(findSchemaNode(settingsPage.tree, 'set-remote-bridge-status').text.includes('http://127.0.0.1:19384'));

  // 3. Runtime ERR_REMOTE_HOST_NOT_CONNECTED clears stale snapshot and displays Host Bridge guidance
  returnBridgeOfflineErr = true;
  await ctrl.refreshSnapshot();
  assert.equal(barView.ctxBtn.textContent, i18n.t().remoteSetupNeeded);
  assert.equal(findSchemaNode(settingsPage.tree, 'set-remote-bridge-badge').text, i18n.t().remoteBridgeBadgeOffline);
  assert.equal(findSchemaNode(settingsPage.tree, 'set-remote-bridge-status').text, i18n.t().remoteBridgeGuideDisconnected);

  ctrl.destroy();
});

test('TC-UNIT-06: bootstrap.mjs picks visible input box, provides host.statusbar service, registers commands, and tears down cleanly', async () => {
  const { doc, El } = createUnitMockDom();
  const vHidden = new El('div', doc);
  vHidden.setAttribute('data-testid', 'conversation-view');
  vHidden.setAttribute('data-cascade-id', 'sess-hidden');
  const bHidden = new El('div', doc);
  bHidden.setAttribute('data-testid', 'agent-input-box');
  bHidden.visible = false;
  bHidden.offsetParent = null;
  vHidden.appendChild(bHidden);
  doc.body.appendChild(vHidden);

  const vVis = new El('div', doc);
  vVis.setAttribute('data-testid', 'conversation-view');
  vVis.setAttribute('data-cascade-id', 'sess-visible');
  const bVis = new El('div', doc);
  bVis.setAttribute('data-testid', 'agent-input-box');
  vVis.appendChild(bVis);
  doc.body.appendChild(vVis);

  const disposers = [];
  const slotEl = new El('div', doc);
  slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
  let styleRemoved = false;
  let slotUnmounted = false;
  const fakeHost = createFakeV3HostPort({ surface: 'desktop' });
  const hostPort = {
    ...fakeHost.hostPort,
    mountSlot(parentEl) {
      parentEl.appendChild(slotEl);
      return slotEl;
    },
    unmountSlot() {
      slotUnmounted = true;
      slotEl.remove();
      return true;
    },
    removeStyle() {
      styleRemoved = true;
      return true;
    },
    onDispose(fn) {
      disposers.push(fn);
    },
  };

  let aborted = false;
  const api = {
    isConnected: () => true,
    abortAll() { aborted = true; },
    async post() { return {}; },
  };
  const i18n = createInlineI18n('ko');
  const addons = createAddonRegistry({ api, onChange() {} });
  const win = { location: { reload() {} } };

  const runtime = startAddonStatusbar({
    hostPort,
    api,
    i18n,
    addons,
    createBarViewFn: createBarView,
    createDeclarativeUiSchemasFn: createDeclarativeUiSchemas,
    createBarControllerFn: createBarController,
    doc,
    win,
    cssText: STATUSBAR_STYLES,
    styleId: STATUSBAR_STYLE_ID,
    pollConfig: { normalPollMs: 60000, quotaPollMs: 60000 },
  });

  assert.equal(slotEl.parentNode, bVis);
  assert.equal(win.statusbarAddons, addons.publicApi);
  assert.ok(fakeHost.services.has('host.statusbar'), 'Must provide host.statusbar service');
  assert.deepEqual(fakeHost.services.get('host.statusbar').opts, { allowedCallers: ['*'] });
  assert.equal(fakeHost.commands.has('open-settings'), true);
  assert.equal(fakeHost.commands.has('compact-now'), true);

  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.equal(aborted, true);
  assert.equal(slotUnmounted, true);
  assert.equal(styleRemoved, true);
  assert.equal(fakeHost.services.has('host.statusbar'), false);
  assert.equal(fakeHost.commands.size, 0);
  assert.equal(win.statusbarAddons, undefined);
  assert.equal(doc.getListenerCount('focusin'), 0);
  runtime.dispose();

  // Standby bootstrap unit check
  const standbyDisposers = [];
  let reloaded = 0;
  const standbyHost = {
    pluginId: 'antigravity-statusbar',
    surface: 'desktop',
    slotId: 'antigravity-statusbar.root',
    mountSlot(parentEl) {
      parentEl.appendChild(slotEl);
      return slotEl;
    },
    unmountSlot() { slotEl.remove(); return true; },
    injectStyle() {},
    removeStyle() { return true; },
    onDispose(fn) { standbyDisposers.push(fn); },
  };
  startStandbyStatusbar({
    hostPort: standbyHost,
    i18n: createInlineI18n('en'),
    doc,
    win: { location: { reload() { reloaded += 1; } } },
    cssText: STATUSBAR_STYLES,
    styleId: STATUSBAR_STYLE_ID,
  });
  slotEl.querySelector('.agy-inline-btn').click();
  assert.equal(reloaded, 1);
  standbyDisposers[0]();
  assert.equal(slotEl.parentNode, null);
});

test('TC-UNIT-06c (v3.3.0): bootstrap.mjs force-refreshes /api/quota on click, visibilitychange/focus, and expired resetTime, and cleans up listeners on dispose', async () => {
  const { doc, El } = createUnitMockDom();
  doc.hidden = false;
  const viewEl = new El('div', doc);
  viewEl.setAttribute('data-testid', 'conversation-view');
  viewEl.setAttribute('data-cascade-id', 'sess-quota-1');
  const boxEl = new El('div', doc);
  boxEl.setAttribute('data-testid', 'agent-input-box');
  viewEl.appendChild(boxEl);
  doc.body.appendChild(viewEl);

  const slotEl = new El('div', doc);
  slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
  const fakeHost = createFakeV3HostPort({ surface: 'desktop' });
  const hostPort = {
    ...fakeHost.hostPort,
    mountSlot(parentEl) {
      parentEl.appendChild(slotEl);
      return slotEl;
    },
    unmountSlot() {
      slotEl.remove();
      return true;
    },
  };

  const quotaCalls = [];
  let quotaReturnCount = 0;
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  const futureIso = new Date(Date.now() + 3_600_000).toISOString();
  const api = {
    isConnected: () => true,
    isConfigured: () => true,
    abortAll() {},
    async post(pathname, body) {
      if (pathname === '/api/quota') {
        quotaCalls.push(body);
        quotaReturnCount += 1;
        if (quotaReturnCount === 1) {
          return {
            available: true,
            stale: false,
            groups: [
              {
                label: 'Gemini Models',
                buckets: [{ window: '5h', remainingPercent: 0, resetTime: pastIso }],
              },
            ],
          };
        }
        return {
          available: true,
          stale: false,
          groups: [
            {
              label: 'Gemini Models',
              buckets: [{ window: '5h', remainingPercent: 100, resetTime: futureIso }],
            },
          ],
        };
      }
      if (pathname === '/api/snapshot') {
        return {
          sessionId: 'sess-quota-1',
          usedTokens: 10_000,
          effectiveLimit: 200_000,
          maxContextTokens: 200_000,
          usagePercent: 5,
          modelName: 'Neon High',
          compaction: { inProgress: false, status: 'idle' },
        };
      }
      return {};
    },
  };

  const winListeners = new Map();
  const win = {
    location: { reload() {} },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      for (const fn of winListeners.get(evt.type) || []) fn(evt);
    },
  };

  const runtime = startAddonStatusbar({
    hostPort,
    api,
    i18n: createInlineI18n('ko'),
    addons: createAddonRegistry({ api, onChange() {} }),
    createBarViewFn: createBarView,
    createDeclarativeUiSchemasFn: createDeclarativeUiSchemas,
    createBarControllerFn: createBarController,
    doc,
    win,
    cssText: STATUSBAR_STYLES,
    styleId: STATUSBAR_STYLE_ID,
    pollConfig: {
      normalPollMs: 40,
      quotaPollMs: 60_000,
      quotaExpiredRetryMs: 10,
      quotaFocusThrottleMs: 10,
    },
  });

  try {
    await flush();
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    assert.ok(quotaCalls.some((b) => b && b.forceRefresh === true));
    const metricsAfterAuto = slotEl.querySelectorAll('.agy-inline-metric');
    assert.ok(metricsAfterAuto[1].textContent.includes('5시간 한도 100%'));

    const beforeClick = quotaCalls.length;
    metricsAfterAuto[1].click();
    await flush();
    assert.equal(quotaCalls.length, beforeClick + 1);
    assert.deepEqual(quotaCalls[quotaCalls.length - 1], { forceRefresh: true });

    await new Promise((r) => setTimeout(r, 20));
    const beforeFocus = quotaCalls.length;
    win.dispatchEvent({ type: 'focus' });
    await flush();
    assert.equal(quotaCalls.length, beforeFocus + 1);
    assert.deepEqual(quotaCalls[quotaCalls.length - 1], { forceRefresh: true });
  } finally {
    runtime.dispose();
  }

  assert.equal(doc.getListenerCount('visibilitychange'), 0);
  assert.equal(winListeners.get('focus')?.size || 0, 0);
});

test('TC-UNIT-06b: subagent views stay pinned without fallback fluctuation, fail closed when unattributed, and Remote Web fallback prefers non-subagent', async () => {
  // 1. Subagent tab stays pinned to sub-A
  {
    const { doc, El } = createUnitMockDom();
    const subView = new El('div', doc);
    subView.setAttribute('data-testid', 'subagent-tab-conversation');
    subView.setAttribute('data-cascade-id', 'sub-A');
    const subBox = new El('div', doc);
    subBox.setAttribute('data-testid', 'agent-input-box');
    subView.appendChild(subBox);
    doc.body.appendChild(subView);

    const slotEl = new El('div', doc);
    slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
    const fakeHost = createFakeV3HostPort({ surface: 'desktop' });
    const hostPort = {
      ...fakeHost.hostPort,
      mountSlot(parentEl) {
        parentEl.appendChild(slotEl);
        return slotEl;
      },
      unmountSlot() {
        slotEl.remove();
        return true;
      },
    };

    const requestedSnapshotIds = [];
    const api = {
      isConnected: () => true,
      abortAll() {},
      async post(pathname, body) {
        if (pathname === '/api/sessions') {
          return { sessions: [{ sessionId: 'main-1', isSubagent: false }, { sessionId: 'sub-A', isSubagent: true }] };
        }
        if (pathname === '/api/snapshot') {
          requestedSnapshotIds.push(body.sessionId);
          return { sessionId: body.sessionId, usedTokens: 45000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 22.5 };
        }
        return {};
      },
    };

    const runtime = startAddonStatusbar({
      hostPort,
      api,
      i18n: createInlineI18n('ko'),
      addons: createAddonRegistry({ api, onChange() {} }),
      createBarViewFn: createBarView,
      createDeclarativeUiSchemasFn: createDeclarativeUiSchemas,
      createBarControllerFn: createBarController,
      doc,
      win: { location: { reload() {} } },
      cssText: STATUSBAR_STYLES,
      styleId: STATUSBAR_STYLE_ID,
      pollConfig: { normalPollMs: 25, quotaPollMs: 60000 },
    });
    try {
      await flush(100);
      assert.ok(requestedSnapshotIds.length >= 2);
      assert.ok(requestedSnapshotIds.every((id) => id === 'sub-A'));
    } finally {
      runtime.dispose();
    }
  }

  // 2. Unattributed subagent view fails closed
  {
    const { doc, El } = createUnitMockDom();
    const i18n = createInlineI18n('ko');
    const barView = createBarView({ doc, i18n });
    const uiSchemas = createDeclarativeUiSchemas({ i18n });
    const fakeHost = createFakeV3HostPort({ surface: 'desktop' });
    const calls = [];
    const api = {
      isConnected: () => true,
      abortAll() {},
      async post(pathname, body) {
        calls.push({ pathname, body });
        return { sessionId: 'main-1', usedTokens: 90000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 45 };
      },
    };
    const ctrl = createBarController({
      api,
      i18n,
      addons: createAddonRegistry({ api, onChange() {} }),
      barView,
      uiSchemas,
      hostPort: fakeHost.hostPort,
      sharedState: {
        autoCompactEnabled: true,
        compactPrompt: '',
        defaultCustomLimit: null,
        modelLimits: [],
        sessionLimits: new Map(),
        quotaState: null,
        fallbackSessionId: 'main-1',
      },
      onSettingsChanged() {},
      onBurstRequested() {},
    });
    const unattrSub = new El('div', doc);
    unattrSub.setAttribute('data-testid', 'subagent-tab-conversation');
    ctrl.setTargetView(unattrSub);
    await flush(20);
    assert.equal(calls.length, 0);
    ctrl.destroy();
  }

  // 3. Remote Web dock fallback prefers latest non-subagent session
  {
    const { doc, El } = createUnitMockDom();
    const slotEl = new El('div', doc);
    slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
    const fakeHost = createFakeV3HostPort({ surface: 'remote-web' });
    const hostPort = {
      ...fakeHost.hostPort,
      capabilities: {
        hasLocalLoopback: true,
        hasRemoteHostBridge: true,
        hasNetHttps: false,
        hasSettingsBridge: true,
      },
      mountSlot() {
        doc.body.appendChild(slotEl);
        return slotEl;
      },
      unmountSlot() {
        slotEl.remove();
        return true;
      },
    };
    const snapIds = [];
    const api = {
      isConfigured: () => true,
      isConnected: () => true,
      abortAll() {},
      async post(pathname, body) {
        if (pathname === '/api/sessions') {
          return {
            sessions: [
              { sessionId: 'sub-bg-1', isSubagent: true },
              { sessionId: 'main-primary', isSubagent: false },
            ],
          };
        }
        if (pathname === '/api/snapshot') {
          snapIds.push(body.sessionId);
          return { sessionId: body.sessionId, usedTokens: 32000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 16 };
        }
        return {};
      },
    };
    const runtime = startAddonStatusbar({
      hostPort,
      api,
      i18n: createInlineI18n('ko'),
      addons: createAddonRegistry({ api, onChange() {} }),
      createBarViewFn: createBarView,
      createDeclarativeUiSchemasFn: createDeclarativeUiSchemas,
      createBarControllerFn: createBarController,
      doc,
      win: { location: { reload() {} } },
      cssText: STATUSBAR_STYLES,
      styleId: STATUSBAR_STYLE_ID,
      pollConfig: { normalPollMs: 60000, quotaPollMs: 60000 },
    });
    try {
      await flush(40);
      assert.deepEqual(snapIds, ['main-primary']);
    } finally {
      runtime.dispose();
    }
  }
});

test('TC-UNIT-07: api-client, i18n dictionary symmetry, and slim v3 styles checks', async () => {
  assert.equal(STATUSBAR_STYLE_ID, 'statusbar-main');
  assert.ok(STATUSBAR_STYLES.includes('.agy-inline-statusbar'));
  assert.ok(STATUSBAR_STYLES.includes('--ag-accent'));
  assert.equal(STATUSBAR_STYLES.includes('.agy-inline-popover'), false);

  const koI18n = createInlineI18n('ko');
  const enI18n = createInlineI18n('en');
  assert.deepEqual(Object.keys(koI18n.t()).sort(), Object.keys(enI18n.t()).sort());
  assert.equal(koI18n.formatTokens(-1), '--');
  assert.equal(koI18n.formatTokens(500), '500');

  const preAbort = new AbortController();
  preAbort.abort();
  const api = createSidecarApiClient({
    baseUrl: 'http://127.0.0.1:41111',
    token: TEST_TOKEN,
    fetchImpl: async (url) => {
      if (url.endsWith('/err-json')) {
        return {
          ok: false,
          status: 409,
          async json() { return { error: { code: 'COMPACTION_IN_PROGRESS', message: 'Busy' } }; },
        };
      }
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    },
  });
  await assert.rejects(() => api.post('/any', {}, preAbort.signal), /aborted/);
  await assert.rejects(
    () => api.post('/err-json', {}),
    (err) => err.status === 409 && err.code === 'COMPACTION_IN_PROGRESS',
  );
  api.abortAll();
});
