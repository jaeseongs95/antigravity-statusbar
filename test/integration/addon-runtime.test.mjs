import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  renderAddonRendererBundle,
  renderAddonStandbyStub,
  renderAddonStaticBundle,
} from '../../src/adapters/antigravity/addon/bundle-builder.mjs';

const TEST_TOKEN = 'addon-runtime-secret-token-32-ok';

function createMockDom() {
  class MockClassList {
    constructor(el) {
      this._el = el;
      this._set = new Set();
    }
    _syncFromString(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _toString() {
      return Array.from(this._set).join(' ');
    }
    add(...names) {
      for (const n of names) if (n) this._set.add(n);
    }
    remove(...names) {
      for (const n of names) this._set.delete(n);
    }
    contains(name) {
      return this._set.has(name);
    }
    toggle(name, force) {
      if (force === undefined) {
        if (this._set.has(name)) {
          this._set.delete(name);
          return false;
        }
        this._set.add(name);
        return true;
      }
      if (force) {
        this._set.add(name);
        return true;
      }
      this._set.delete(name);
      return false;
    }
  }

  class MockElement {
    constructor(tagName, ownerDocument) {
      this.tagName = String(tagName).toUpperCase();
      this.nodeType = 1;
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.childNodes = [];
      this.attributes = new Map();
      this.style = {};
      this.classList = new MockClassList(this);
      this._textContent = '';
      this.value = '';
      this.disabled = false;
      this.title = '';
      this.type = '';
      this.placeholder = '';
      this.listeners = new Map();
      this.offsetParent = {};
    }
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get className() {
      return this.classList._toString();
    }
    set className(val) {
      this.classList._syncFromString(val);
    }
    get textContent() {
      if (this.childNodes.length === 0) return this._textContent;
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(val) {
      this.childNodes = [];
      this._textContent = String(val ?? '');
    }
    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    }
    getAttribute(name) {
      return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
    }
    removeAttribute(name) {
      this.attributes.delete(String(name));
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    matches(selector) {
      const attrMatch = /^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/.exec(selector);
      if (attrMatch) return this.getAttribute(attrMatch[1]) === attrMatch[2];
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      return this.tagName === selector.toUpperCase();
    }
    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.childNodes) {
          if (ch.nodeType === 1) {
            if (ch.matches(selector)) out.push(ch);
            walk(ch);
          }
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
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
      return [{ width: 300, height: 40 }];
    }
  }

  let directStyleCreateCount = 0;
  const docListeners = new Map();
  const doc = {
    body: null,
    head: null,
    activeElement: null,
    createElement(tag) {
      if (String(tag).toLowerCase() === 'style') directStyleCreateCount += 1;
      return new MockElement(tag, doc);
    },
    querySelectorAll(selector) {
      return doc.body ? doc.body.querySelectorAll(selector) : [];
    },
    querySelector(selector) {
      return doc.body ? doc.body.querySelector(selector) : null;
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
    getDirectStyleCreateCount() {
      return directStyleCreateCount;
    },
  };
  doc.body = new MockElement('body', doc);
  doc.head = new MockElement('head', doc);

  function createConversationView(sessionId, testId = 'conversation-view') {
    const view = new MockElement('div', doc);
    view.setAttribute('data-testid', testId);
    view.setAttribute('data-cascade-id', sessionId);
    const box = new MockElement('div', doc);
    box.setAttribute('data-testid', 'agent-input-box');
    const editor = new MockElement('textarea', doc);
    box.appendChild(editor);
    view.appendChild(box);
    doc.body.appendChild(view);
    return { view, box, editor };
  }

  return { doc, MockElement, createConversationView };
}

function findNodeById(tree, id) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.id === id) return tree;
  if (Array.isArray(tree.children)) {
    for (const ch of tree.children) {
      const found = findNodeById(ch, id);
      if (found) return found;
    }
  }
  return null;
}

function createMockAddonContextV3(doc, MockElement, { surface = 'desktop', remoteBridgeConnected = false, netHandler = null, dockEl = null, settingsBridge = null } = {}) {
  const pluginId = 'antigravity-statusbar';
  const allowedSlotId = 'antigravity-statusbar.root';
  const slots = new Map();
  const styles = new Map();
  const disposers = [];
  const managedCleanups = [];
  const toasts = [];
  const popups = [];
  const modals = [];
  const commands = new Map();
  const services = new Map();
  const eventListeners = new Map();
  const storageMap = new Map();
  const storageListeners = new Set();
  const mountLog = [];
  let bridgeConnectedFlag = surface === 'remote-web' && Boolean(remoteBridgeConnected);
  let settingsPage = null;
  let disposed = false;
  const abortCtrl = new AbortController();

  const ctx = Object.freeze({
    apiVersion: 3,
    meta: Object.freeze({
      pluginId,
      displayName: 'Antigravity Statusbar',
      version: '3.3.0',
      trustLevel: 'trusted',
      sourceSchemaVersion: 3,
    }),
    env: Object.freeze({
      surface,
      layoutMode: 'desktop',
      capabilities: Object.freeze({
        get hasLocalLoopback() {
          return (surface === 'desktop' && typeof netHandler === 'function') || (surface === 'remote-web' && bridgeConnectedFlag);
        },
        get hasRemoteHostBridge() {
          return surface === 'remote-web' && bridgeConnectedFlag;
        },
        hasNetHttps: false,
        hasConfigBridge: false,
        hasSettingsBridge: Boolean(settingsBridge),
        hasDocumentTransform: false,
      }),
    }),
    theme: Object.freeze({
      getMode: () => 'dark',
      getTokens: () => ({ accent: '#38bdf8' }),
      getTokenCss: () => ':host { --ag-accent: #38bdf8; }',
      onDidChange: () => () => {},
    }),
    i18n: Object.freeze({
      getLocale: () => 'ko',
      onDidChange: () => () => {},
    }),
    ui: Object.freeze({
      showToast(opts) {
        toasts.push(opts);
        return { close() {} };
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
            if (typeof opts.onClose === 'function') opts.onClose();
          },
        };
        popups.push(rec);
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
            if (typeof opts.onClose === 'function') opts.onClose();
          },
        };
        modals.push(rec);
        return rec;
      },
      registerCommand(id, spec) {
        commands.set(id, spec);
        return Object.freeze({ dispose() { commands.delete(id); } });
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
      mountCanvas(slotId, opts = {}) {
        if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
        if (slotId !== allowedSlotId) throw new Error(`ERR_UNDECLARED_SLOT:${slotId}`);
        const parent = opts?.container || dockEl || doc.body;
        let rec = slots.get(slotId);
        if (!rec) {
          const hostEl = new MockElement('div', doc);
          hostEl.setAttribute('translate', 'no');
          hostEl.setAttribute('data-agy-no-translate', 'true');
          hostEl.setAttribute('data-addon-host-owner', pluginId);
          hostEl.setAttribute('data-addon-host-slot', slotId);
          const rootEl = new MockElement('div', doc);
          rootEl.className = 'addon-host-slot-root';
          rootEl.setAttribute('data-addon-host-owner', pluginId);
          hostEl.appendChild(rootEl);
          rec = { hostEl, rootEl, container: parent };
          slots.set(slotId, rec);
        }
        if (rec.hostEl.parentNode !== parent) {
          parent.appendChild(rec.hostEl);
          rec.container = parent;
        }
        mountLog.push({ slotId, opts, parent });
        return rec.rootEl;
      },
      injectStyle(styleId, cssText, opts) {
        if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
        styles.set(styleId, { cssText: String(cssText || ''), opts: opts || null });
        return { styleId };
      },
      removeStyle(styleId) {
        if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
        return styles.delete(styleId);
      },
    }),
    dom: Object.freeze({
      unmountSlot(slotId) {
        if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
        const rec = slots.get(slotId);
        if (!rec) return false;
        rec.hostEl.remove();
        slots.delete(slotId);
        return true;
      },
    }),
    storage: Object.freeze({
      async get(key) {
        return storageMap.has(key) ? storageMap.get(key) : null;
      },
      async set(key, value) {
        const oldValue = storageMap.has(key) ? storageMap.get(key) : null;
        storageMap.set(key, value);
        for (const fn of storageListeners) fn({ key, oldValue, newValue: value });
      },
      async delete(key) {
        const oldValue = storageMap.has(key) ? storageMap.get(key) : null;
        storageMap.delete(key);
        for (const fn of storageListeners) fn({ key, oldValue, newValue: null });
      },
      onDidChange(cb) {
        storageListeners.add(cb);
        return () => storageListeners.delete(cb);
      },
    }),
    services: Object.freeze({
      provide(name, impl, opts) {
        services.set(name, { impl, opts });
        return Object.freeze({ dispose() { services.delete(name); } });
      },
    }),
    events: Object.freeze({
      on(topic, handler) {
        if (!eventListeners.has(topic)) eventListeners.set(topic, new Set());
        eventListeners.get(topic).add(handler);
        return () => eventListeners.get(topic)?.delete(handler);
      },
      emit(topic, payload) {
        const set = eventListeners.get(topic);
        if (!set) return 0;
        for (const fn of Array.from(set)) fn(payload, { topic, sourcePluginId: '__host__' });
        return set.size;
      },
    }),
    ...(typeof netHandler === 'function'
      ? {
          net: Object.freeze({
            fetch: (url, init) => Promise.resolve(netHandler(url, init)),
          }),
        }
      : {}),
    ...(settingsBridge ? { settingsBridge } : {}),
    lifecycle: Object.freeze({
      signal: abortCtrl.signal,
      onDispose(fn) {
        if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
        disposers.push(fn);
      },
      addManagedListener(target, type, listener, opts) {
        target.addEventListener(type, listener, opts);
        const cleanup = () => target.removeEventListener(type, listener, opts);
        managedCleanups.push(cleanup);
        return cleanup;
      },
      dispose() {
        if (disposed) return;
        for (const fn of disposers.splice(0)) {
          try {
            fn();
          } catch {}
        }
        disposed = true;
        abortCtrl.abort();
        for (const fn of managedCleanups.splice(0)) {
          try {
            fn();
          } catch {}
        }
        for (const [, rec] of slots) rec.hostEl.remove();
        slots.clear();
        styles.clear();
      },
    }),
  });

  return {
    ctx,
    slots,
    styles,
    toasts,
    popups,
    modals,
    commands,
    services,
    storageMap,
    mountLog,
    setRemoteBridgeConnected(next, baseUrl = '') {
      bridgeConnectedFlag = Boolean(next);
      ctx.events.emit('host:remote-bridge-changed', { connected: bridgeConnectedFlag, baseUrl: baseUrl || null });
    },
    getSettingsPage: () => settingsPage,
    isDisposed: () => disposed,
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

test('TC-ADDON-06, TC-ADDON-07 & TC-ADDON-08: bundled v3 renderer uses AddonContextV3, provides host.statusbar, drives Tier 1/2 overlays, leaks zero credentials, and cleans up on dispose', async () => {
  const { doc, MockElement, createConversationView } = createMockDom();
  const v1 = createConversationView('sess-alpha');
  const v2 = createConversationView('sess-beta');
  v1.editor.focus();

  const apiCalls = [];
  let failNextAutoCompact = false;
  let storedSettings = {
    locale: 'ko',
    autoCompact: true,
    compactPrompt: '핵심만 요약해줘',
    defaultCustomLimit: null,
    sessions: [{ sessionId: 'sess-alpha', limit: 256000 }],
    customButtons: [],
    disabledRuntimeAddonIds: [],
  };

  const netHandler = async (url, init) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(init.body || '{}');
    assert.equal(init.headers['x-statusbar-token'], TEST_TOKEN);
    apiCalls.push({ pathname, body });

    if (pathname === '/api/settings/get') {
      return { ok: true, status: 200, bodyText: JSON.stringify(storedSettings) };
    }
    if (pathname === '/api/settings/update') {
      if (typeof body.autoCompact === 'boolean' && failNextAutoCompact) {
        failNextAutoCompact = false;
        return { ok: false, status: 500, bodyText: JSON.stringify({ error: { code: 'SAVE_FAILED', message: 'Disk error' } }) };
      }
      if (typeof body.autoCompact === 'boolean') storedSettings = { ...storedSettings, autoCompact: body.autoCompact };
      if (typeof body.compactPrompt === 'string') storedSettings = { ...storedSettings, compactPrompt: body.compactPrompt };
      if (typeof body.locale === 'string') storedSettings = { ...storedSettings, locale: body.locale };
      return { ok: true, status: 200, bodyText: JSON.stringify(storedSettings) };
    }
    if (pathname === '/api/quota') {
      return {
        ok: true,
        status: 200,
        bodyText: JSON.stringify({
          available: true,
          stale: false,
          groups: [{ label: 'Gemini', buckets: [{ window: '5h', remainingPercent: 84 }] }],
        }),
      };
    }
    if (pathname === '/api/sessions') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ sessions: [{ sessionId: 'sess-alpha' }] }) };
    }
    if (pathname === '/api/snapshot') {
      return {
        ok: true,
        status: 200,
        bodyText: JSON.stringify({
          sessionId: body.sessionId,
          usedTokens: 128000,
          effectiveLimit: 256000,
          maxContextTokens: 512000,
          usagePercent: 50,
          cacheHitPercent: 72,
          modelName: 'Gemini Test',
          stepCount: 42,
          limitSource: 'session',
          customLimit: 256000,
          isClampedByHost: false,
          compactPrompt: storedSettings.compactPrompt,
          compaction: { inProgress: false, trigger: null },
          tokenBreakdown: [
            { label: 'Chat Messages', tokens: 100000 },
            { label: 'System', tokens: 28000 },
          ],
        }),
      };
    }
    if (pathname === '/api/compact') {
      return { ok: true, status: 200, bodyText: JSON.stringify({ accepted: true }) };
    }
    return { ok: true, status: 200, bodyText: '{}' };
  };

  const host = createMockAddonContextV3(doc, MockElement, { surface: 'desktop', netHandler });
  const sandboxWindow = { location: { reload() {} } };

  const bundleSource = renderAddonRendererBundle({
    baseUrl: 'http://127.0.0.1:18910',
    token: TEST_TOKEN,
  });

  vm.runInNewContext(`(function(addonHost){\n${bundleSource}\n})(addonHost);`, {
    window: sandboxWindow,
    document: doc,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addonHost: host.ctx,
  });
  try {
    await flushMicrotasks();

    // 1. Capability-only canvas & style injection with theme tokens, zero credential leak
    assert.equal(doc.getDirectStyleCreateCount(), 0);
    assert.ok(host.styles.has('statusbar-main'));
    assert.ok(host.styles.get('statusbar-main').cssText.includes('--ag-accent'));
    assert.equal(host.slots.size, 1);
    const rootRec = host.slots.get('antigravity-statusbar.root');
    assert.equal(rootRec.container, v1.box);
    assert.equal(JSON.stringify(sandboxWindow).includes(TEST_TOKEN), false);

    // 2. Well-known `host.statusbar` service delegation
    assert.ok(host.services.has('host.statusbar'));
    const sbSvc = host.services.get('host.statusbar').impl;
    let delegatedClicked = null;
    const itemHandle = sbSvc.registerItem({
      pluginId: 'peer-x',
      id: 'btn1',
      label: 'PeerX',
      badge: '1',
      align: 'right',
      onClick(ev) { delegatedClicked = ev; },
    });
    const delegatedEl = rootRec.rootEl.querySelector('[data-status-plugin-id="peer-x"]');
    assert.ok(delegatedEl);
    delegatedEl.click({ ctrlKey: true });
    assert.equal(delegatedClicked?.ctrlKey, true);
    itemHandle.dispose();
    assert.equal(rootRec.rootEl.querySelector('[data-status-plugin-id="peer-x"]'), null);

    // 3. Focus switch reattaches canvas to v2.box (mountSlot unmounts old slot & mounts fresh slot)
    v2.editor.focus();
    doc.dispatchEvent({ type: 'focusin', target: v2.editor });
    await flushMicrotasks();
    const activeRootRec = host.slots.get('antigravity-statusbar.root');
    assert.equal(activeRootRec.container, v2.box);

    // 4. Tier-2 Context Popup & Global Limits Modal + Tier-1 Settings Page (autoCompact rollback + prompt save)
    const ctxBtn = activeRootRec.rootEl.querySelector('.agy-inline-metric-btn');
    assert.ok(ctxBtn, 'Expected context metric button inside active slot after focus switch');
    ctxBtn.click();
    assert.equal(host.popups.length, 1);
    assert.equal(host.popups[0].opts.placement.zone, 'anchor');
    host.popups[0].opts.onAction({ actionId: 'open-global-limits' });
    assert.equal(host.popups[0].closed, true);
    assert.equal(host.modals.length, 1);
    host.modals[0].close();

    const settingsPage = host.getSettingsPage();
    assert.ok(settingsPage);
    settingsPage.open();
    assert.equal(findNodeById(settingsPage.tree, 'set-remote-bridge-sec'), null, 'Desktop settings must omit Remote Host Bridge section');
    assert.equal(findNodeById(settingsPage.tree, 'set-remote-url'), null);

    failNextAutoCompact = true;
    settingsPage.spec.onChange({ field: 'autoCompact', value: false });
    await flushMicrotasks();
    assert.equal(settingsPage.state.autoCompact, true, 'Failed autoCompact update must roll back');

    settingsPage.spec.onChange({ field: 'compactPrompt', value: '변경된 파일만 요약' });
    settingsPage.spec.onAction({ actionId: 'save-compact-prompt' });
    await flushMicrotasks();
    assert.equal(storedSettings.compactPrompt, '변경된 파일만 요약');

    // 5. Manual compact request
    const compactBtn = activeRootRec.rootEl.querySelectorAll('.agy-inline-btn').find((b) => b.textContent === 'compact');
    assert.ok(compactBtn, 'Expected compact button inside active slot');
    compactBtn.click();
    await flushMicrotasks();
    assert.ok(apiCalls.some((c) => c.pathname === '/api/compact' && c.body.sessionId === 'sess-beta'));

    // 6. Dispose cleans up everything
    host.ctx.lifecycle.dispose();
    assert.equal(host.isDisposed(), true);
    assert.equal(host.slots.size, 0);
    assert.equal(host.styles.size, 0);
    assert.equal(host.services.size, 0);
    assert.equal(host.commands.size, 0);
    assert.equal(sandboxWindow.statusbarAddons, undefined);
    assert.equal(doc.getListenerCount('focusin'), 0);
    assert.equal(doc.getListenerCount('pointerdown'), 0);
  } finally {
    host.ctx.lifecycle.dispose();
  }
});

test('TC-ADDON-08: v3 standby stub mounts via AddonContextV3 with zero credentials, triggers reload on click, and cleans up on dispose', () => {
  const { doc, MockElement, createConversationView } = createMockDom();
  const v1 = createConversationView('sess-standby');
  const host = createMockAddonContextV3(doc, MockElement, { surface: 'desktop' });

  let reloadCount = 0;
  const stubSource = renderAddonStandbyStub();
  assert.equal(stubSource.includes(TEST_TOKEN), false);

  vm.runInNewContext(`(function(addonHost){\n${stubSource}\n})(addonHost);`, {
    window: { location: { reload() { reloadCount += 1; } } },
    document: doc,
    addonHost: host.ctx,
  });

  assert.equal(doc.getDirectStyleCreateCount(), 0);
  assert.ok(host.styles.has('statusbar-main'));
  const rootRec = host.slots.get('antigravity-statusbar.root');
  assert.equal(rootRec.container, v1.box);
  rootRec.rootEl.querySelector('.agy-inline-btn').click();
  assert.equal(reloadCount, 1);

  host.ctx.lifecycle.dispose();
  assert.equal(host.slots.size, 0);
  assert.equal(host.styles.size, 0);
});

test('TC-ADDON-10b (v3.1.1): Remote Web static bundle falls back to host dock, shows read-only Host Bridge guidance when offline, and transparently routes loopback via ctx.net.fetch + host:remote-bridge-changed', async () => {
  const staticSource = renderAddonRendererBundle();
  assert.equal(staticSource, renderAddonStaticBundle());
  assert.equal(/http:\/\/127\.0\.0\.1:\d+/.test(staticSource), false);
  assert.equal(/hostProfileId/.test(staticSource), false);

  const { doc, MockElement } = createMockDom();
  const remoteDock = new MockElement('div', doc);
  doc.body.appendChild(remoteDock);

  const netLog = [];
  let currentSettingsSnap = null;
  const settingsSubs = new Set();
  const settingsBridge = {
    getSnapshot: () => currentSettingsSnap,
    onDidChange(cb) {
      settingsSubs.add(cb);
      return () => settingsSubs.delete(cb);
    },
    async save(next) {
      currentSettingsSnap = { status: 'ok', data: next };
      for (const cb of settingsSubs) cb(currentSettingsSnap);
      return { ok: true, snapshot: currentSettingsSnap };
    },
  };

  const host = createMockAddonContextV3(doc, MockElement, {
    surface: 'remote-web',
    remoteBridgeConnected: false,
    dockEl: remoteDock,
    settingsBridge,
    netHandler: async (url, init) => {
      netLog.push({ url, token: init?.headers?.['x-statusbar-token'] });
      if (!host.ctx.env.capabilities.hasRemoteHostBridge) {
        return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
      }
      const pathname = new URL(url).pathname;
      if (pathname === '/api/settings/get') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ locale: 'ko', autoCompact: true, customButtons: [], disabledRuntimeAddonIds: [] }) };
      }
      if (pathname === '/api/quota') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ available: false, groups: [], stale: false }) };
      }
      if (pathname === '/api/sessions') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ sessions: [{ sessionId: 'sess-remote-1' }] }) };
      }
      return {
        ok: true,
        status: 200,
        bodyText: JSON.stringify({
          sessionId: 'sess-remote-1',
          usedTokens: 75000,
          effectiveLimit: 250000,
          maxContextTokens: 512000,
          usagePercent: 30,
          compaction: { inProgress: false, lastError: null },
        }),
      };
    },
  });

  vm.runInNewContext(`(function(addonHost){\n${staticSource}\n})(addonHost);`, {
    window: { innerWidth: 1280, innerHeight: 800, location: { reload() {} } },
    document: doc,
    addonHost: host.ctx,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  try {
    await flushMicrotasks();
    assert.equal(netLog.length, 0, 'Offline Host Bridge must issue zero Sidecar calls');
    const rootRec = host.slots.get('antigravity-statusbar.root');
    assert.equal(rootRec.container, remoteDock);
    assert.equal(rootRec.rootEl.querySelector('.agy-inline-statusbar').classList.contains('agy-remote-dock'), true);
    assert.equal(host.commands.has('open-settings'), true);

    // Click bar while offline -> opens Settings with read-only Host Bridge guidance and ZERO URL/token inputs
    rootRec.rootEl.querySelector('.agy-inline-metric-btn').click();
    const settingsPage = host.getSettingsPage();
    assert.equal(settingsPage.openFlag, true);
    assert.ok(findNodeById(settingsPage.tree, 'set-remote-bridge-sec'));
    assert.equal(findNodeById(settingsPage.tree, 'set-remote-url'), null);
    assert.equal(findNodeById(settingsPage.tree, 'set-remote-token'), null);
    assert.ok(findNodeById(settingsPage.tree, 'set-remote-bridge-status').text.includes('Host Bridge'));

    // Native Host pairs Remote Bridge -> pushes settingsBridge snapshot + emits host:remote-bridge-changed
    await settingsBridge.save({
      mode: 'active',
      baseUrl: 'http://127.0.0.1:43210',
      token: TEST_TOKEN,
    });
    host.setRemoteBridgeConnected(true, 'http://127.0.0.1:19384');
    await flushMicrotasks();

    assert.equal(host.storageMap.size, 0, 'Plugin must never store remote URL/token in ctx.storage');
    assert.ok(netLog.some((r) => r.url === 'http://127.0.0.1:43210/api/snapshot' && r.token === TEST_TOKEN));
    assert.ok(rootRec.rootEl.querySelector('.agy-inline-metric-btn').textContent.includes('75.0K'));
    assert.ok(findNodeById(settingsPage.tree, 'set-remote-bridge-badge').text.includes('연결됨'));

    // Native Host disconnects Remote Bridge -> clears snapshot & shows Host Bridge offline guidance
    host.setRemoteBridgeConnected(false, '');
    await flushMicrotasks();
    assert.ok(rootRec.rootEl.querySelector('.agy-inline-metric-btn').textContent.includes('Host Bridge'));
    assert.ok(findNodeById(settingsPage.tree, 'set-remote-bridge-badge').text.includes('미연결'));
  } finally {
    host.ctx.lifecycle.dispose();
  }
});

test('TC-ADDON-12 (v3.3.0): bundled v3 renderer pins subagent-tab-conversation, shows model pill, formats localized 5h HH:mm reset, and cleans up on dispose', async () => {
  const staticSource = renderAddonRendererBundle({
    baseUrl: 'http://127.0.0.1:46111',
    token: TEST_TOKEN,
  });
  const { doc, MockElement } = createMockDom();

  const mainView = new MockElement('div', doc);
  mainView.setAttribute('data-testid', 'conversation-view');
  mainView.setAttribute('data-cascade-id', 'sess-main-vm');
  const mainBox = new MockElement('div', doc);
  mainBox.setAttribute('data-testid', 'agent-input-box');
  mainView.appendChild(mainBox);
  doc.body.appendChild(mainView);

  const subView = new MockElement('div', doc);
  subView.setAttribute('data-testid', 'subagent-tab-conversation');
  subView.setAttribute('data-cascade-id', 'sess-sub-vm');
  const subText = new MockElement('p', doc);
  subText.textContent = 'Subagent transcript';
  const subBox = new MockElement('div', doc);
  subBox.setAttribute('data-testid', 'agent-input-box');
  subView.appendChild(subText);
  subView.appendChild(subBox);
  doc.body.appendChild(subView);

  const host = createMockAddonContextV3(doc, MockElement, { surface: 'desktop' });
  const snapshotCalls = [];

  vm.runInNewContext(`(function(addonHost){\n${staticSource}\n})(addonHost);`, {
    window: { innerWidth: 1280, innerHeight: 800, location: { reload() {} } },
    document: doc,
    addonHost: host.ctx,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(init.body || '{}');
      if (pathname === '/api/settings/get') {
        return { ok: true, status: 200, async json() { return { locale: 'ko', autoCompact: true, customButtons: [], disabledRuntimeAddonIds: [] }; } };
      }
      if (pathname === '/api/quota') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              available: true,
              stale: false,
              groups: [
                {
                  label: 'Gemini Models',
                  buckets: [
                    { window: '5h', remainingPercent: 84, resetTime: '2026-11-23T14:05:00Z' },
                    { window: 'weekly', remainingPercent: 61, resetTime: '2026-11-30T00:00:00Z' },
                  ],
                },
              ],
            };
          },
        };
      }
      if (pathname === '/api/sessions') {
        return { ok: true, status: 200, async json() { return { sessions: [{ sessionId: 'sess-main-vm', isSubagent: false }] }; } };
      }
      if (pathname === '/api/snapshot') {
        snapshotCalls.push(body.sessionId);
        const isSub = body.sessionId === 'sess-sub-vm';
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sessionId: body.sessionId,
              isSubagent: isSub,
              modelName: isSub ? 'Gemini 4 Neon (High)' : 'Claude Opus 5.5',
              usedTokens: isSub ? 52000 : 190000,
              effectiveLimit: 200000,
              maxContextTokens: 512000,
              usagePercent: isSub ? 26 : 95,
              compaction: { inProgress: false, lastError: null },
            };
          },
        };
      }
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });

  try {
    await flushMicrotasks();
    const rootRec = host.slots.get('antigravity-statusbar.root');
    assert.equal(rootRec.container, subBox);
    assert.ok(snapshotCalls.every((id) => id === 'sess-sub-vm'));
    const subModelPill = rootRec.rootEl.querySelector('.agy-inline-model-pill');
    assert.equal(subModelPill.style.display, '');
    assert.equal(subModelPill.textContent, 'Gemini 4 Neon (High)');

    const d5h = new Date('2026-11-23T14:05:00Z');
    const expectedHHMM = `${String(d5h.getHours()).padStart(2, '0')}:${String(d5h.getMinutes()).padStart(2, '0')}`;
    const metrics = rootRec.rootEl.querySelectorAll('.agy-inline-metric');
    assert.equal(metrics[metrics.length - 2].textContent, `5시간 한도 84% (${expectedHHMM})`);

    doc.dispatchEvent({ type: 'pointerdown', target: mainView });
    await flushMicrotasks();
    assert.equal(host.slots.get('antigravity-statusbar.root').container, mainBox);
    assert.equal(subModelPill.style.display, 'none');

    doc.dispatchEvent({ type: 'pointerdown', target: subText });
    await flushMicrotasks();
    assert.equal(host.slots.get('antigravity-statusbar.root').container, subBox);
    assert.equal(subModelPill.style.display, '');
  } finally {
    host.ctx.lifecycle.dispose();
  }
});
