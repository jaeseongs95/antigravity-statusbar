import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  renderAddonRendererBundle,
  renderAddonStandbyStub,
  renderAddonStaticBundle,
} from '../../src/adapters/antigravity/addon/bundle-builder.mjs';

const TEST_TOKEN = 'addon-runtime-secret-token-32-ok';

/**
 * Minimal dependency-free DOM + EventTarget simulator tailored for AddonManifest.v1 runtime tests.
 */
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
      if (attrMatch) {
        return this.getAttribute(attrMatch[1]) === attrMatch[2];
      }
      if (selector.startsWith('.')) {
        return this.classList.contains(selector.slice(1));
      }
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
      for (const fn of Array.from(set)) {
        fn(evt);
      }
    }
    click() {
      this.dispatchEvent({ type: 'click', target: this, preventDefault() {} });
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
      if (String(tag).toLowerCase() === 'style') {
        directStyleCreateCount += 1;
      }
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

  function createConversationView(sessionId) {
    const view = new MockElement('div', doc);
    view.setAttribute('data-testid', 'conversation-view');
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

/**
 * Mock mirroring `antigravity-addons` (formerly `antigravity-native-addon-host`) createScopedHandle() semantics.
 */
function createMockAddonHost(doc, MockElement) {
  const pluginId = 'antigravity-statusbar';
  const allowedSlotId = 'antigravity-statusbar.root';
  const slots = new Map();
  const styles = new Map();
  const disposers = [];
  let disposed = false;
  const mountLog = [];

  const handle = Object.freeze({
    pluginId,
    hostVersion: '1.0.1',
    hostProfileId: 'antigravity-desktop',
    storageNamespace: pluginId,
    ipcChannelPrefix: null,
    getNoTranslateSelector() {
      return '[data-addon-host-owner], [translate="no"], [data-agy-no-translate="true"]';
    },
    mountSlot(slotId, parentEl) {
      if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
      if (slotId !== allowedSlotId) throw new Error(`ERR_UNDECLARED_SLOT:${slotId}`);
      let el = slots.get(slotId);
      if (!el) {
        el = new MockElement('div', doc);
        el.setAttribute('translate', 'no');
        el.setAttribute('data-agy-no-translate', 'true');
        el.setAttribute('data-addon-host-owner', pluginId);
        el.setAttribute('data-addon-host-slot', slotId);
        slots.set(slotId, el);
      }
      const parent = parentEl || doc.body;
      if (el.parentNode !== parent) {
        parent.appendChild(el);
      }
      mountLog.push({ slotId, parent });
      return el;
    },
    unmountSlot(slotId) {
      if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
      const el = slots.get(slotId);
      if (!el) return false;
      el.remove();
      slots.delete(slotId);
      return true;
    },
    injectStyle(styleId, cssText) {
      if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
      styles.set(styleId, String(cssText || ''));
      return { styleId };
    },
    removeStyle(styleId) {
      if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
      return styles.delete(styleId);
    },
    listOwnedSlots() {
      return Array.from(slots.keys());
    },
    onDispose(fn) {
      if (disposed) throw new Error(`ERR_HANDLE_DISPOSED:${pluginId}`);
      disposers.push(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch {}
      }
      for (const [, el] of slots) el.remove();
      slots.clear();
      styles.clear();
    },
  });

  return {
    handle,
    slots,
    styles,
    mountLog,
    isDisposed: () => disposed,
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

test('TC-ADDON-06, TC-ADDON-07 & TC-ADDON-08: bundled renderer uses addonHost capability API only, preserves full 2-tab UX, leaks zero credentials, and cleans up on dispose', async () => {
  const { doc, MockElement, createConversationView } = createMockDom();
  const v1 = createConversationView('sess-alpha');
  const v2 = createConversationView('sess-beta');
  v1.editor.focus();

  const host = createMockAddonHost(doc, MockElement);
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

  const mockFetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(init.body || '{}');
    assert.equal(init.headers['x-statusbar-token'], TEST_TOKEN);
    apiCalls.push({ pathname, body });

    if (pathname === '/api/settings/get') {
      return { ok: true, status: 200, async json() { return storedSettings; } };
    }
    if (pathname === '/api/settings/update') {
      if (typeof body.autoCompact === 'boolean' && failNextAutoCompact) {
        failNextAutoCompact = false;
        return {
          ok: false,
          status: 500,
          async json() { return { error: { code: 'SAVE_FAILED', message: 'Disk error' } }; },
        };
      }
      if (typeof body.autoCompact === 'boolean') storedSettings = { ...storedSettings, autoCompact: body.autoCompact };
      if (typeof body.compactPrompt === 'string') storedSettings = { ...storedSettings, compactPrompt: body.compactPrompt };
      if (typeof body.locale === 'string') storedSettings = { ...storedSettings, locale: body.locale };
      if (body.defaultCustomLimit !== undefined) {
        storedSettings = { ...storedSettings, defaultCustomLimit: body.defaultCustomLimit };
      }
      if (body.sessionLimit) {
        const others = storedSettings.sessions.filter((s) => s.sessionId !== body.sessionLimit.sessionId);
        if (body.sessionLimit.limit !== null) {
          others.push({ sessionId: body.sessionLimit.sessionId, limit: body.sessionLimit.limit });
        }
        storedSettings = { ...storedSettings, sessions: others };
      }
      return { ok: true, status: 200, async json() { return storedSettings; } };
    }
    if (pathname === '/api/quota') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            available: true,
            stale: false,
            groups: [{ label: 'Gemini', buckets: [{ window: '5h', remainingPercent: 84 }] }],
          };
        },
      };
    }
    if (pathname === '/api/sessions') {
      return {
        ok: true,
        status: 200,
        async json() { return { sessions: [{ sessionId: 'sess-alpha' }] }; },
      };
    }
    if (pathname === '/api/snapshot') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
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
          };
        },
      };
    }
    if (pathname === '/api/compact') {
      return { ok: true, status: 200, async json() { return { accepted: true }; } };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };

  let reloadCalled = 0;
  const sandboxWindow = {
    location: { reload() { reloadCalled += 1; } },
  };
  const sandbox = {
    window: sandboxWindow,
    document: doc,
    fetch: mockFetch,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addonHost: host.handle,
  };

  const bundleSource = renderAddonRendererBundle({
    baseUrl: 'http://127.0.0.1:43210',
    token: TEST_TOKEN,
  });

  // Execute exactly like antigravity-addons wrapper: (function(addonHost){ rawCode })(__addonHandle)
  vm.runInNewContext(
    `(function(addonHost){\n${bundleSource}\n})(addonHost);`,
    sandbox,
  );
  await flushMicrotasks();

  // TC-ADDON-06: Capability-only style & slot mounting, zero credential/handle leak on window
  assert.equal(doc.getDirectStyleCreateCount(), 0, 'Must never call document.createElement("style") directly');
  assert.ok(host.styles.has('statusbar-main'));
  assert.equal(host.slots.size, 1);
  const slotEl = host.slots.get('antigravity-statusbar.root');
  assert.equal(slotEl.parentNode, v1.box);
  assert.equal(slotEl.getAttribute('translate'), 'no');
  assert.equal(slotEl.getAttribute('data-addon-host-owner'), 'antigravity-statusbar');
  assert.equal(slotEl.getAttribute('data-agy-no-translate'), 'true');
  assert.equal(Object.prototype.hasOwnProperty.call(sandboxWindow, '__agyStatusbarInline'), false);
  assert.equal(JSON.stringify(sandboxWindow).includes(TEST_TOKEN), false);
  assert.ok(sandboxWindow.statusbarAddons && sandboxWindow.statusbarAddons.version === '1.0.0');

  // Single-slot safe reattachment when focus shifts to second agent-input-box
  v2.editor.focus();
  doc.dispatchEvent({ type: 'focusin', target: v2.editor });
  await flushMicrotasks();
  assert.equal(slotEl.parentNode, v2.box, 'Single slot should reattach cleanly to active input box');

  // StatusbarAddon.v1 runtime button bridge
  let rtClickedSession = '';
  assert.equal(
    sandboxWindow.statusbarAddons.register({
      id: 'peer-btn',
      label: 'Peer',
      onClick({ sessionId }) {
        rtClickedSession = sessionId;
      },
    }),
    true,
  );
  const customContainer = slotEl.querySelector('.agy-inline-custom-btns');
  assert.equal(customContainer.childNodes.length, 1);
  customContainer.childNodes[0].click();
  assert.equal(rtClickedSession, 'sess-beta');

  // TC-ADDON-07: 2-tab popover open, tab switch, Escape focus return, auto-compact rollback, compactPrompt save
  const ctxBtn = slotEl.querySelector('.agy-inline-metric-btn');
  const popEl = slotEl.querySelector('.agy-inline-popover');
  assert.equal(popEl.classList.contains('hidden'), true);
  ctxBtn.click();
  assert.equal(popEl.classList.contains('hidden'), false);
  assert.equal(ctxBtn.getAttribute('aria-expanded'), 'true');

  const tabs = popEl.querySelectorAll('.agy-inline-tab');
  assert.equal(tabs.length, 2);
  tabs[1].click(); // switch to Settings tab
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');

  // Auto-compact switch failure rollback
  const switchBtn = popEl.querySelector('.agy-inline-switch');
  assert.equal(switchBtn.getAttribute('aria-checked'), 'true');
  failNextAutoCompact = true;
  switchBtn.click();
  await flushMicrotasks();
  assert.equal(switchBtn.getAttribute('aria-checked'), 'true', 'Failed autoCompact update must roll back switch');

  // Compact prompt edit + save
  const textarea = popEl.querySelector('.agy-inline-pop-textarea');
  assert.equal(textarea.value, '핵심만 요약해줘');
  textarea.value = '변경된 파일과 테스트 결과만 요약';
  textarea.dispatchEvent({ type: 'input', target: textarea });
  const saveButtons = popEl.querySelectorAll('.agy-inline-btn-primary');
  const promptSaveBtn = saveButtons[saveButtons.length - 1];
  promptSaveBtn.click();
  await flushMicrotasks();
  assert.equal(storedSettings.compactPrompt, '변경된 파일과 테스트 결과만 요약');

  // Escape closes popover and returns focus to trigger
  doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(popEl.classList.contains('hidden'), true);
  assert.equal(doc.activeElement, ctxBtn);

  // Manual compact request
  const rightBtns = slotEl.querySelector('.agy-inline-right').querySelectorAll('.agy-inline-btn');
  const compactBtn = rightBtns.find((b) => b.textContent === 'compact');
  assert.ok(compactBtn);
  compactBtn.click();
  await flushMicrotasks();
  assert.ok(apiCalls.some((c) => c.pathname === '/api/compact' && c.body.sessionId === 'sess-beta'));

  // TC-ADDON-08: Host-managed dispose() cleans everything
  host.handle.dispose();
  assert.equal(host.isDisposed(), true);
  assert.equal(host.slots.size, 0);
  assert.equal(host.styles.size, 0);
  assert.equal(sandboxWindow.statusbarAddons, undefined);
  assert.equal(doc.getListenerCount('keydown'), 0);
  assert.equal(doc.getListenerCount('pointerdown'), 0);
  assert.equal(doc.getListenerCount('focusin'), 0);
  assert.equal(reloadCalled, 0);
});

test('TC-ADDON-08: standby stub mounts via addonHost with zero credentials, triggers reload on click, and cleans up on dispose', () => {
  const { doc, MockElement, createConversationView } = createMockDom();
  const v1 = createConversationView('sess-standby');
  const host = createMockAddonHost(doc, MockElement);

  let reloadCount = 0;
  const sandboxWindow = {
    location: { reload() { reloadCount += 1; } },
  };
  const stubSource = renderAddonStandbyStub();
  assert.equal(stubSource.includes(TEST_TOKEN), false);

  vm.runInNewContext(
    `(function(addonHost){\n${stubSource}\n})(addonHost);`,
    {
      window: sandboxWindow,
      document: doc,
      addonHost: host.handle,
    },
  );

  assert.equal(doc.getDirectStyleCreateCount(), 0);
  assert.ok(host.styles.has('statusbar-main'));
  const slotEl = host.slots.get('antigravity-statusbar.root');
  assert.ok(slotEl);
  assert.equal(slotEl.parentNode, v1.box);
  const reloadBtn = slotEl.querySelector('.agy-inline-btn');
  assert.ok(reloadBtn);
  reloadBtn.click();
  assert.equal(reloadCount, 1);

  host.handle.dispose();
  assert.equal(host.slots.size, 0);
  assert.equal(host.styles.size, 0);
});

test('TC-ADDON-09: AddonManifest.v2 bundled renderer mounts in Shadow DOM via { container }, routes styles per slotId, and uses host v2 openPopover & openModal portals cleanly', async () => {
  const { doc, MockElement, createConversationView } = createMockDom();
  const v1 = createConversationView('sess-v2-alpha');
  const v2 = createConversationView('sess-v2-beta');
  v1.editor.focus();

  const pluginId = 'antigravity-statusbar';
  const allowedSlots = new Map([
    ['antigravity-statusbar.root', 'status-bar'],
    ['antigravity-statusbar.popover', 'overlay'],
    ['antigravity-statusbar.global-limit-modal', 'modal'],
  ]);
  const mountedSlots = new Map();
  const styleRecords = [];
  const portals = [];
  const disposers = [];
  const disposeEvents = [];
  let disposed = false;

  const v2HostHandle = Object.freeze({
    pluginId,
    version: '3.2.0',
    trustLevel: 'trusted',
    hostProfileId: 'antigravity-desktop',
    schemaVersion: 2,
    sourceSchemaVersion: 2,
    mountSlot(slotId, opts = {}) {
      if (disposed) throw new Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
      if (!allowedSlots.has(slotId)) throw new Error(`ERR_UNDECLARED_SLOT:${pluginId}:${slotId}`);
      const existing = mountedSlots.get(slotId);
      if (existing && existing.hostEl.parentNode) {
        return existing.rootEl;
      }
      // Strictly enforces v2 `{ container }` contract (bare HTMLElement has no `.container` -> returns null!)
      const container = opts && opts.container ? opts.container : null;
      if (!container) return null;
      const hostEl = new MockElement('div', doc);
      hostEl.setAttribute('data-addon-host-owner', pluginId);
      hostEl.setAttribute('data-addon-host-slot', slotId);
      hostEl.setAttribute('translate', 'no');
      container.appendChild(hostEl);
      // Simulate open ShadowRoot inner `<div class="addon-host-slot-root">`
      const rootEl = new MockElement('div', doc);
      rootEl.className = 'addon-host-slot-root';
      rootEl.setAttribute('data-addon-host-owner', pluginId);
      rootEl.setAttribute('data-addon-host-slot', slotId);
      rootEl.isConnected = true;
      mountedSlots.set(slotId, { hostEl, rootEl, container });
      return rootEl;
    },
    unmountSlot(slotId) {
      if (disposed) throw new Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
      disposeEvents.push(['unmountSlot', slotId]);
      const rec = mountedSlots.get(slotId);
      if (!rec) return false;
      rec.hostEl.remove();
      rec.rootEl.isConnected = false;
      mountedSlots.delete(slotId);
      return true;
    },
    injectStyle(styleId, cssText, opts = {}) {
      if (disposed) throw new Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
      styleRecords.push({ styleId, slotId: opts.slotId || null, length: String(cssText || '').length });
      return { styleId };
    },
    removeStyle(styleId) {
      if (disposed) throw new Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
      disposeEvents.push(['removeStyle', styleId]);
      return Boolean(styleId);
    },
    openPopover(slotId, opts = {}) {
      if (allowedSlots.get(slotId) !== 'overlay') throw new Error(`ERR_INVALID_POPOVER_SLOT_KIND:${slotId}`);
      const pop = new MockElement('div', doc);
      pop.setAttribute('popover', 'manual');
      pop.setAttribute('data-addon-host-popover', '1');
      pop.setAttribute('data-addon-host-owner', pluginId);
      pop.setAttribute('data-addon-host-slot', slotId);
      const bodyEl = new MockElement('div', doc);
      bodyEl.className = 'addon-host-slot-root';
      pop.appendChild(bodyEl);
      doc.body.appendChild(pop);
      let closed = false;
      const entry = {
        kind: 'popover',
        slotId,
        element: pop,
        bodyEl,
        ignoreOutsideClickEls: opts.ignoreOutsideClickEls || [],
        isClosed: () => closed,
        close() {
          if (closed) return;
          closed = true;
          pop.remove();
          if (typeof opts.onClose === 'function') opts.onClose();
        },
      };
      portals.push(entry);
      return Object.freeze({ id: `popover-${portals.length}`, element: pop, bodyEl, close: entry.close });
    },
    openModal(slotId, opts = {}) {
      if (allowedSlots.get(slotId) !== 'modal') throw new Error(`ERR_INVALID_MODAL_SLOT_KIND:${slotId}`);
      const dlg = new MockElement('dialog', doc);
      dlg.setAttribute('data-addon-host-modal-dialog', '1');
      dlg.setAttribute('data-addon-host-owner', pluginId);
      dlg.setAttribute('data-addon-host-slot', slotId);
      // Mirror real host v2.2.0+ modal-portal.js centered `<dialog>` defaults
      dlg.style.position = 'fixed';
      dlg.style.top = 'max(env(titlebar-area-height, 36px), 36px)';
      dlg.style.right = '0';
      dlg.style.bottom = '0';
      dlg.style.left = '0';
      dlg.style.margin = 'auto';
      dlg.style.width = 'fit-content';
      dlg.style.height = 'fit-content';
      dlg.style.zIndex = '2147483001';
      const bodyEl = new MockElement('div', doc);
      bodyEl.className = 'addon-host-slot-root';
      dlg.appendChild(bodyEl);
      doc.body.appendChild(dlg);
      let closed = false;
      const entry = {
        kind: 'modal',
        slotId,
        element: dlg,
        bodyEl,
        isClosed: () => closed,
        close() {
          if (closed) return;
          closed = true;
          dlg.remove();
          if (typeof opts.onClose === 'function') opts.onClose();
        },
      };
      portals.push(entry);
      return Object.freeze({ id: `modal-${portals.length}`, element: dlg, bodyEl, close: entry.close });
    },
    onDispose(fn) {
      disposers.push(fn);
    },
    dispose() {
      if (disposed) return;
      // Mirror host v2.2.0+ I10 invariant: run onDispose callbacks BEFORE marking handle disposed
      // so plugin unmountSlot()/removeStyle() calls succeed without ERR_PLUGIN_HANDLE_DISPOSED.
      for (const fn of disposers.splice(0)) fn();
      disposed = true;
      for (const p of portals) p.close();
      for (const slotId of Array.from(mountedSlots.keys())) {
        mountedSlots.get(slotId).hostEl.remove();
      }
      mountedSlots.clear();
    },
  });

  const sandboxWindow = { innerWidth: 1440, innerHeight: 900, location: { reload() {} } };
  const bundleSource = renderAddonRendererBundle({
    baseUrl: 'http://127.0.0.1:45555',
    token: TEST_TOKEN,
  });

  vm.runInNewContext(
    `(function(addonHost){\n${bundleSource}\n})(addonHost);`,
    {
      window: sandboxWindow,
      document: doc,
      addonHost: v2HostHandle,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/api/settings/get') {
          return { ok: true, status: 200, async json() { return { locale: 'ko', autoCompact: true, defaultCustomLimit: 200000, modelLimits: [], sessions: [], customButtons: [], disabledRuntimeAddonIds: [] }; } };
        }
        if (pathname === '/api/quota') {
          return { ok: true, status: 200, async json() { return { available: false, groups: [], stale: false }; } };
        }
        if (pathname === '/api/sessions') {
          return { ok: true, status: 200, async json() { return { sessions: [{ sessionId: 'sess-v2-alpha' }] }; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sessionId: 'sess-v2-alpha',
              modelName: 'Gemini 4 Neon',
              usedTokens: 64000,
              effectiveLimit: 200000,
              maxContextTokens: 512000,
              limitSource: 'default',
              usagePercent: 32,
              compaction: { inProgress: false, lastError: null },
            };
          },
        };
      },
    },
  );
  await flushMicrotasks();

  // 1. Mounted inside ShadowRoot slot via `{ container: v1.box }` & root CSS routed to slotId
  const rootRec = mountedSlots.get('antigravity-statusbar.root');
  assert.ok(rootRec, 'v2 mountSlot({ container }) must mount root slot');
  assert.equal(rootRec.container, v1.box);
  assert.ok(
    styleRecords.some((r) => r.styleId === 'statusbar-main' && r.slotId === 'antigravity-statusbar.root'),
    'Root style must route to root slotId',
  );

  // 2. Clicking ctxBtn opens host v2 `openPopover` portal (NOT inline child of barEl)
  const ctxBtn = rootRec.rootEl.querySelector('.agy-inline-metric-btn');
  assert.ok(ctxBtn);
  ctxBtn.getBoundingClientRect = () => ({ left: 545, top: 860, right: 735, width: 190, height: 24 });
  ctxBtn.click();
  const popPortal = portals.find((p) => p.kind === 'popover');
  assert.ok(popPortal, 'Popover must open via host v2 openPopover');
  assert.equal(popPortal.slotId, 'antigravity-statusbar.popover');
  assert.equal(popPortal.isClosed(), false);
  assert.ok(popPortal.ignoreOutsideClickEls.includes(ctxBtn));
  assert.ok(
    styleRecords.some((r) => r.styleId === 'statusbar-main:popover' && r.slotId === 'antigravity-statusbar.popover'),
    'Popover style must route to popover slotId',
  );
  const popEl = popPortal.bodyEl.querySelector('.agy-inline-popover');
  assert.ok(popEl && popEl.classList.contains('agy-inline-popover-portal'));
  assert.equal(popPortal.element.style.position, 'fixed');
  assert.equal(popPortal.element.style.left, '545px', 'ctxBtn popover must align left to ctxBtn within viewport bounds');
  assert.equal(popPortal.element.style.right, 'auto');
  assert.equal(popPortal.element.style.width, 'fit-content');

  // 3. Clicking Global Limit Modal button inside popover closes popover portal & opens host v2 `<dialog>` openModal
  const modalTrigger = popEl.querySelectorAll('.agy-inline-btn').find((b) => b.textContent.includes('전역'));
  assert.ok(modalTrigger);
  modalTrigger.click();
  assert.equal(popPortal.isClosed(), true, 'Popover portal must close when opening Global Limit modal');
  const modalPortal = portals.find((p) => p.kind === 'modal');
  assert.ok(modalPortal, 'Global Limit Modal must open via host v2 openModal');
  assert.equal(modalPortal.slotId, 'antigravity-statusbar.global-limit-modal');
  assert.equal(modalPortal.element.tagName, 'DIALOG');
  assert.equal(modalPortal.element.style.position, 'fixed');
  assert.equal(modalPortal.element.style.top, 'max(env(titlebar-area-height, 36px), 36px)');
  assert.equal(modalPortal.element.style.right, '0');
  assert.equal(modalPortal.element.style.bottom, '0');
  assert.equal(modalPortal.element.style.left, '0');
  assert.equal(modalPortal.element.style.margin, 'auto');
  assert.equal(modalPortal.element.style.marginTop, 'auto', 'Must override host marginTop so <dialog> centers vertically & horizontally');
  assert.equal(modalPortal.element.style.marginLeft, 'auto');
  assert.equal(modalPortal.element.style.marginRight, 'auto');
  assert.equal(modalPortal.element.style.width, 'fit-content');
  assert.equal(modalPortal.element.style.height, 'fit-content');
  assert.ok(
    styleRecords.some((r) => r.styleId === 'statusbar-main:modal' && r.slotId === 'antigravity-statusbar.global-limit-modal'),
    'Modal style must route to modal slotId',
  );
  assert.ok(modalPortal.bodyEl.querySelector('.agy-inline-modal'));

  // Backdrop click on `<dialog>` element closes modal portal cleanly
  modalPortal.element.dispatchEvent({ type: 'click', target: modalPortal.element });
  assert.equal(modalPortal.isClosed(), true, 'Backdrop click on <dialog> must close modal portal');

  // Clicking settingsBtn opens right-anchored popover clamped inside viewport bounds
  const rightBtnsV2 = rootRec.rootEl.querySelector('.agy-inline-right').querySelectorAll('.agy-inline-btn');
  const settingsBtnV2 = rightBtnsV2[rightBtnsV2.length - 1];
  assert.ok(settingsBtnV2);
  settingsBtnV2.getBoundingClientRect = () => ({ left: 1100, top: 860, right: 1132, width: 32, height: 24 });
  settingsBtnV2.click();
  const settingsPopPortal = portals.filter((p) => p.kind === 'popover').pop();
  assert.ok(settingsPopPortal && !settingsPopPortal.isClosed());
  assert.equal(settingsPopPortal.element.style.left, 'auto');
  assert.equal(settingsPopPortal.element.style.right, '308px');
  settingsPopPortal.close();

  // 4. Switching active conversation tab unmounts old v1.box slot and remounts into v2.box!
  v2.editor.focus();
  doc.dispatchEvent({ type: 'focusin', target: v2.editor });
  const movedRec = mountedSlots.get('antigravity-statusbar.root');
  assert.equal(movedRec.container, v2.box, 'Tab switch must unmount and remount v2 Shadow slot into new active box');

  // 5. Dispose cleans up slots and portals cleanly under v2.2.0+ I10 ordering
  v2HostHandle.dispose();
  assert.equal(mountedSlots.size, 0);
  assert.equal(sandboxWindow.statusbarAddons, undefined);
  assert.ok(
    disposeEvents.some(([op, id]) => op === 'unmountSlot' && id === 'antigravity-statusbar.root'),
    'onDispose must unmount root slot before host handle transitions to disposed',
  );
  assert.ok(
    disposeEvents.some(([op, id]) => op === 'removeStyle' && id === 'statusbar-main'),
    'onDispose must remove main style before host handle transitions to disposed',
  );
});

test('TC-ADDON-10a (v3.2.0): Desktop trusted static bundle consumes live settingsBridge credentials (standby -> active -> rotation -> standby) with zero hardcoded secrets', async () => {
  const staticSource = renderAddonRendererBundle();
  assert.equal(staticSource, renderAddonStaticBundle());
  assert.equal(staticSource.includes(TEST_TOKEN), false);
  assert.equal(/http:\/\/127\.0\.0\.1:\d+/.test(staticSource), false);
  assert.equal(/\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/.test(staticSource), false);
  assert.equal(/\beval\s*\(|\bnew\s+Function\b|\brequire\s*\(/.test(staticSource), false);

  const { doc, MockElement, createConversationView } = createMockDom();
  const v1 = createConversationView('sess-desktop-bridge');
  v1.editor.focus();

  const mountedSlots = new Map();
  const settingsListeners = new Set();
  const disposers = [];
  let unsubscribedCount = 0;
  let currentSettingsSnap = { status: 'ok', data: { mode: 'standby', baseUrl: null, token: null } };

  const desktopHost = Object.freeze({
    pluginId: 'antigravity-statusbar',
    version: '3.2.0',
    trustLevel: 'trusted',
    hostProfileId: 'antigravity-desktop',
    schemaVersion: 2,
    mountSlot(slotId, opts = {}) {
      const container = opts && opts.container ? opts.container : doc.body;
      const existing = mountedSlots.get(slotId);
      if (existing && existing.hostEl.parentNode) return existing.rootEl;
      const hostEl = new MockElement('div', doc);
      container.appendChild(hostEl);
      const rootEl = new MockElement('div', doc);
      rootEl.className = 'addon-host-slot-root';
      mountedSlots.set(slotId, { hostEl, rootEl, container });
      return rootEl;
    },
    unmountSlot(slotId) {
      const rec = mountedSlots.get(slotId);
      if (!rec) return false;
      rec.hostEl.remove();
      mountedSlots.delete(slotId);
      return true;
    },
    injectStyle() {
      return { styleId: 'statusbar-main' };
    },
    removeStyle() {
      return true;
    },
    getSettings() {
      return currentSettingsSnap;
    },
    onSettingsChange(cb) {
      settingsListeners.add(cb);
      return () => {
        settingsListeners.delete(cb);
        unsubscribedCount += 1;
      };
    },
    onDispose(fn) {
      disposers.push(fn);
    },
    dispose() {
      for (const fn of disposers.splice(0)) fn();
    },
  });

  const seenRequests = [];
  const sandboxWindow = { innerWidth: 1280, innerHeight: 800, location: { reload() {} } };
  vm.runInNewContext(
    `(function(addonHost){\n${staticSource}\n})(addonHost);`,
    {
      window: sandboxWindow,
      document: doc,
      addonHost: desktopHost,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: async (url, init) => {
        seenRequests.push({ url, token: init.headers['x-statusbar-token'] });
        const pathname = new URL(url).pathname;
        if (pathname === '/api/settings/get') {
          return { ok: true, status: 200, async json() { return { locale: 'ko', autoCompact: true, customButtons: [], disabledRuntimeAddonIds: [] }; } };
        }
        if (pathname === '/api/quota') {
          return { ok: true, status: 200, async json() { return { available: false, groups: [], stale: false }; } };
        }
        if (pathname === '/api/sessions') {
          return { ok: true, status: 200, async json() { return { sessions: [{ sessionId: 'sess-desktop-bridge' }] }; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sessionId: 'sess-desktop-bridge',
              usedTokens: 48000,
              effectiveLimit: 200000,
              maxContextTokens: 512000,
              usagePercent: 24,
              compaction: { inProgress: false, lastError: null },
            };
          },
        };
      },
    },
  );
  try {
    await flushMicrotasks();

    // 1. Boots in standby with ZERO fetches
    assert.equal(seenRequests.length, 0, 'Standby settingsBridge must issue zero fetches');
    const rootEl = mountedSlots.get('antigravity-statusbar.root').rootEl;
    assert.ok(rootEl.querySelector('.agy-inline-metric-btn').textContent.includes('Sidecar'));

    // 2. Sidecar publishes active credentials via settingsBridge -> renderer immediately connects
    currentSettingsSnap = {
      status: 'ok',
      data: { mode: 'active', baseUrl: 'http://127.0.0.1:46001', token: TEST_TOKEN },
    };
    for (const cb of settingsListeners) cb(currentSettingsSnap);
    await flushMicrotasks();
    assert.ok(seenRequests.some((r) => r.url.startsWith('http://127.0.0.1:46001/') && r.token === TEST_TOKEN));
    assert.ok(rootEl.querySelector('.agy-inline-metric-btn').textContent.includes('48.0K'));

    // 3. Sidecar restarts on a new port/token -> live rotation without reload
    const rotatedToken = 'rotated-desktop-bridge-token-32ok';
    currentSettingsSnap = {
      status: 'ok',
      data: { mode: 'active', baseUrl: 'http://127.0.0.1:46002', token: rotatedToken },
    };
    for (const cb of settingsListeners) cb(currentSettingsSnap);
    await flushMicrotasks();
    assert.ok(seenRequests.some((r) => r.url.startsWith('http://127.0.0.1:46002/') && r.token === rotatedToken));

    // 4. Sidecar shuts down (mode: standby) -> clears connection back to standby
    const reqCountBeforeStandby = seenRequests.length;
    currentSettingsSnap = { status: 'ok', data: { mode: 'standby', baseUrl: null, token: null } };
    for (const cb of settingsListeners) cb(currentSettingsSnap);
    await flushMicrotasks();
    assert.equal(seenRequests.length, reqCountBeforeStandby);
    assert.ok(rootEl.querySelector('.agy-inline-metric-btn').textContent.includes('Sidecar'));

    // 5. Dispose unsubscribes settingsBridge listener and cleans up slots
    desktopHost.dispose();
    assert.equal(unsubscribedCount, 1);
    assert.equal(mountedSlots.size, 0);
  } finally {
    desktopHost.dispose();
  }
});

test('TC-ADDON-10b (v3.2.0): Remote Web profile ignores packed-initial snapshots, falls back to host status-bar anchor dock, and connects/disconnects via browser-local saveSettings', async () => {
  const staticSource = renderAddonRendererBundle();
  const { doc, MockElement } = createMockDom();
  // Intentionally NO [data-testid="agent-input-box"] in Remote Web DOM -> must use host status-bar dock fallback!

  const remoteDock = new MockElement('div', doc);
  remoteDock.setAttribute('id', 'remote-addon-host-slot-dock');
  doc.body.appendChild(remoteDock);

  const mountedSlots = new Map();
  const mountOptsLog = [];
  const savedPayloads = [];
  const portals = [];
  const registeredTabs = [];
  const registeredActions = [];
  const unregisteredIds = [];
  const disposers = [];
  let unsubscribedCount = 0;

  // Simulate an accidental packed-initial snapshot containing Desktop credentials -> MUST BE IGNORED!
  let hostSettings = {
    status: 'ok',
    persistence: 'packed-initial',
    data: {
      mode: 'active',
      baseUrl: 'http://127.0.0.1:49991',
      token: 'leaked-desktop-packed-token-32ok',
      remoteBaseUrl: 'http://127.0.0.1:49991',
      remoteToken: 'leaked-desktop-packed-token-32ok',
    },
  };

  const remoteWebHost = Object.freeze({
    pluginId: 'antigravity-statusbar',
    version: '3.2.0',
    trustLevel: 'trusted',
    hostProfileId: 'antigravity-remote-web',
    schemaVersion: 2,
    mountSlot(slotId, opts = {}) {
      mountOptsLog.push({ slotId, opts });
      const existing = mountedSlots.get(slotId);
      if (existing && existing.hostEl.parentNode) return existing.rootEl;
      const container = opts && opts.container ? opts.container : remoteDock;
      const hostEl = new MockElement('div', doc);
      container.appendChild(hostEl);
      const rootEl = new MockElement('div', doc);
      rootEl.className = 'addon-host-slot-root';
      mountedSlots.set(slotId, { hostEl, rootEl, container });
      return rootEl;
    },
    unmountSlot(slotId) {
      const rec = mountedSlots.get(slotId);
      if (!rec) return false;
      rec.hostEl.remove();
      mountedSlots.delete(slotId);
      return true;
    },
    injectStyle() {
      return { styleId: 'statusbar-main' };
    },
    removeStyle() {
      return true;
    },
    openPopover(slotId, opts = {}) {
      const pop = new MockElement('div', doc);
      const bodyEl = new MockElement('div', doc);
      pop.appendChild(bodyEl);
      doc.body.appendChild(pop);
      let closed = false;
      const entry = {
        slotId,
        element: pop,
        bodyEl,
        close() {
          if (closed) return;
          closed = true;
          pop.remove();
          if (typeof opts.onClose === 'function') opts.onClose();
        },
      };
      portals.push(entry);
      return Object.freeze({ id: `pop-${portals.length}`, element: pop, bodyEl, close: entry.close });
    },
    openModal(slotId, opts = {}) {
      const dlg = new MockElement('dialog', doc);
      const bodyEl = new MockElement('div', doc);
      dlg.appendChild(bodyEl);
      doc.body.appendChild(dlg);
      let closed = false;
      const entry = {
        kind: 'modal',
        slotId,
        element: dlg,
        bodyEl,
        close() {
          if (closed) return;
          closed = true;
          dlg.remove();
          if (typeof opts.onClose === 'function') opts.onClose();
        },
      };
      portals.push(entry);
      return Object.freeze({ id: `modal-${portals.length}`, element: dlg, bodyEl, close: entry.close });
    },
    registerSettingsTab(tabId, opts) {
      registeredTabs.push({ tabId, opts });
      return Object.freeze({
        unregister() {
          unregisteredIds.push(`tab:${tabId}`);
        },
      });
    },
    registerAction(actionId, spec) {
      registeredActions.push({ actionId, spec });
      return Object.freeze({
        unregister() {
          unregisteredIds.push(`action:${actionId}`);
        },
      });
    },
    getSettings() {
      return hostSettings;
    },
    onSettingsChange() {
      return () => {
        unsubscribedCount += 1;
      };
    },
    async saveSettings(data) {
      savedPayloads.push(data);
      hostSettings = { status: 'ok', persistence: 'browser-local', data };
      return { ok: true, persistence: 'browser-local' };
    },
    onDispose(fn) {
      disposers.push(fn);
    },
    dispose() {
      for (const fn of disposers.splice(0)) fn();
    },
  });

  const remoteToken = 'remote-web-user-token-32-charsok';
  const fetchLog = [];
  const sandboxWindow = { innerWidth: 1280, innerHeight: 800, location: { reload() {} } };

  vm.runInNewContext(
    `(function(addonHost){\n${staticSource}\n})(addonHost);`,
    {
      window: sandboxWindow,
      document: doc,
      addonHost: remoteWebHost,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: async (url, init) => {
        fetchLog.push({ url, token: init.headers['x-statusbar-token'] });
        const pathname = new URL(url).pathname;
        if (pathname === '/api/settings/get') {
          return { ok: true, status: 200, async json() { return { locale: 'ko', autoCompact: true, customButtons: [], disabledRuntimeAddonIds: [] }; } };
        }
        if (pathname === '/api/quota') {
          return { ok: true, status: 200, async json() { return { available: false, groups: [], stale: false }; } };
        }
        if (pathname === '/api/sessions') {
          return { ok: true, status: 200, async json() { return { sessions: [{ sessionId: 'sess-remote-1' }] }; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sessionId: 'sess-remote-1',
              usedTokens: 75000,
              effectiveLimit: 250000,
              maxContextTokens: 512000,
              usagePercent: 30,
              compaction: { inProgress: false, lastError: null },
            };
          },
        };
      },
    },
  );
  try {
    await flushMicrotasks();

    // 1. Packed-initial snapshot MUST be ignored -> zero fetches on startup!
    assert.equal(fetchLog.length, 0, 'Remote Web must ignore packed-initial snapshot and perform zero fetches');
    // 2. Mounted via host status-bar anchor fallback ({} without container) and styled as .agy-remote-dock
    assert.equal(mountOptsLog[0].slotId, 'antigravity-statusbar.root');
    assert.deepEqual(Object.keys(mountOptsLog[0].opts), []);
    const rootRec = mountedSlots.get('antigravity-statusbar.root');
    assert.equal(rootRec.container, remoteDock);
    assert.equal(rootRec.rootEl.querySelector('.agy-inline-statusbar').classList.contains('agy-remote-dock'), true);

    // 2b. Host v2.8.0 Remote Web Drawer registers Settings tab & Quick Actions
    assert.equal(registeredTabs.length, 1);
    assert.equal(registeredTabs[0].tabId, 'settings');
    assert.deepEqual(
      registeredActions.map((a) => a.actionId),
      ['open-settings', 'open-global-limits', 'refresh-quota'],
    );
    // Invoking Drawer Settings tab opens popover on Settings tab
    registeredTabs[0].opts.onSelect();
    assert.ok(portals.some((p) => p.slotId === 'antigravity-statusbar.popover'));
    // Invoking Drawer Global Limits action opens modal portal
    registeredActions.find((a) => a.actionId === 'open-global-limits').spec.run();
    assert.ok(portals.some((p) => p.kind === 'modal' && p.slotId === 'antigravity-statusbar.global-limit-modal'));
    portals.find((p) => p.kind === 'modal').close();

    // 3. Clicking bar opens Settings tab with visible Remote Sidecar Connection card
    const ctxBtn = rootRec.rootEl.querySelector('.agy-inline-metric-btn');
    ctxBtn.getBoundingClientRect = () => ({ left: 400, top: 760, right: 560, width: 160, height: 24 });
    ctxBtn.click();
    const popPortal = portals[portals.length - 1];
    assert.ok(popPortal, 'Clicking unconfigured Remote Web bar must open popover portal');
    const inputs = popPortal.bodyEl.querySelectorAll('.agy-inline-pop-input');
    const urlInput = inputs.find((el) => el.type === 'text' && el.placeholder.includes('http'));
    const tokenInput = inputs.find((el) => el.type === 'password');
    assert.ok(urlInput && tokenInput, 'Remote Web Settings tab must render URL and password token inputs');

    // 4. Connect to HTTPS endpoint -> persists via addonHost.saveSettings and fetches live snapshot!
    urlInput.value = 'https://my-sidecar.example.com:8443';
    tokenInput.value = remoteToken;
    const connectBtn = popPortal.bodyEl.querySelectorAll('.agy-inline-btn-primary').find((b) => b.textContent.includes('연결'));
    assert.ok(connectBtn);
    connectBtn.click();
    await flushMicrotasks();

    assert.equal(savedPayloads.length, 1);
    assert.equal(savedPayloads[0].remoteBaseUrl, 'https://my-sidecar.example.com:8443');
    assert.equal(savedPayloads[0].remoteToken, remoteToken);
    assert.ok(fetchLog.some((r) => r.url === 'https://my-sidecar.example.com:8443/api/settings/get' && r.token === remoteToken));
    assert.ok(rootRec.rootEl.querySelector('.agy-inline-metric-btn').textContent.includes('75.0K'));

    // 5. Disconnect clears browser-local settings and stops polling
    const disconnectBtn = popPortal.bodyEl.querySelectorAll('.agy-inline-btn').find((b) => b.textContent.includes('해제'));
    assert.ok(disconnectBtn);
    disconnectBtn.click();
    await flushMicrotasks();
    assert.equal(savedPayloads.length, 2);
    assert.equal(savedPayloads[1].remoteBaseUrl, '');
    assert.equal(savedPayloads[1].remoteToken, '');

    // 6. Dispose unsubscribes, unregisters drawer tabs/actions & unmounts cleanly
    remoteWebHost.dispose();
    assert.equal(unsubscribedCount, 1);
    assert.equal(mountedSlots.size, 0);
    assert.ok(unregisteredIds.includes('tab:settings'));
    assert.ok(unregisteredIds.includes('action:open-settings'));
    assert.ok(unregisteredIds.includes('action:open-global-limits'));
    assert.ok(unregisteredIds.includes('action:refresh-quota'));
  } finally {
    remoteWebHost.dispose();
  }
});

test('TC-ADDON-12 (v3.2.0): bundled static renderer pins subagent-tab-conversation to its own data-cascade-id without stock-chart fallback drift and cleans up pointerdown listener on dispose', async () => {
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

  const host = createMockAddonHost(doc, MockElement);
  let sessionCallCount = 0;
  const snapshotCalls = [];
  const sessionSequences = [
    [{ sessionId: 'sess-main-vm', isSubagent: false }, { sessionId: 'sess-sub-vm', isSubagent: true }],
    [{ sessionId: 'sess-other-sub', isSubagent: true }, { sessionId: 'sess-main-vm', isSubagent: false }],
  ];

  const sandboxWindow = { innerWidth: 1280, innerHeight: 800, location: { reload() {} } };
  vm.runInNewContext(
    `(function(addonHost){\n${staticSource}\n})(addonHost);`,
    {
      window: sandboxWindow,
      document: doc,
      addonHost: host.handle,
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
          const sessions = sessionSequences[sessionCallCount % sessionSequences.length];
          sessionCallCount += 1;
          return { ok: true, status: 200, async json() { return { sessions }; } };
        }
        if (pathname === '/api/snapshot') {
          snapshotCalls.push(body.sessionId);
          const isSub = body.sessionId === 'sess-sub-vm';
          const usedTokens = isSub ? 52000 : 190000;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                sessionId: body.sessionId,
                isSubagent: isSub,
                modelName: isSub ? 'Gemini 4 Neon (High)' : 'Claude Opus 5.5',
                usedTokens,
                effectiveLimit: 200000,
                maxContextTokens: 512000,
                usagePercent: usedTokens / 2000,
                compaction: { inProgress: false, lastError: null },
              };
            },
          };
        }
        return { ok: true, status: 200, async json() { return {}; } };
      },
    },
  );

  try {
    // Initially mounts on last visible box (subBox) and MUST stay pinned to sess-sub-vm despite sessions[0] flipping
    await flushMicrotasks();
    const slotEl = host.slots.get('antigravity-statusbar.root');
    assert.equal(slotEl.parentNode, subBox);
    assert.ok(snapshotCalls.length >= 1);
    assert.ok(
      snapshotCalls.every((id) => id === 'sess-sub-vm'),
      `Bundled renderer must query only sess-sub-vm while on subagent tab, got: ${JSON.stringify(snapshotCalls)}`,
    );
    assert.ok(slotEl.querySelector('.agy-inline-metric-btn').textContent.includes('52.0K'));
    const subModelPill = slotEl.querySelector('.agy-inline-model-pill');
    assert.ok(subModelPill, 'Bundled renderer must include .agy-inline-model-pill element');
    assert.equal(subModelPill.style.display, '', 'Subagent tab must display running model pill');
    assert.equal(subModelPill.textContent, 'Gemini 4 Neon (High)');

    const d5h = new Date('2026-11-23T14:05:00Z');
    const expectedHHMM = `${String(d5h.getHours()).padStart(2, '0')}:${String(d5h.getMinutes()).padStart(2, '0')}`;
    const expectedDT =
      `${String(d5h.getFullYear())}-${String(d5h.getMonth() + 1).padStart(2, '0')}-${String(d5h.getDate()).padStart(2, '0')} ` +
      expectedHHMM;
    const metrics = slotEl.querySelectorAll('.agy-inline-metric');
    const quota5hEl = metrics[metrics.length - 2];
    assert.equal(quota5hEl.textContent, `5시간 한도 84% (${expectedHHMM})`);
    assert.ok(quota5hEl.title.includes(`초기화 ${expectedDT}`));
    assert.equal(quota5hEl.title.includes('2026-11-23T14:05:00Z'), false);

    // Switching to main via pointerdown moves to mainBox, queries sess-main-vm, and hides subagent model pill
    doc.dispatchEvent({ type: 'pointerdown', target: mainView });
    await flushMicrotasks();
    assert.equal(slotEl.parentNode, mainBox);
    assert.equal(snapshotCalls[snapshotCalls.length - 1], 'sess-main-vm');
    assert.equal(subModelPill.style.display, 'none', 'Main conversation view must hide subagent model pill');

    doc.dispatchEvent({ type: 'pointerdown', target: subText });
    await flushMicrotasks();
    assert.equal(slotEl.parentNode, subBox);
    assert.equal(snapshotCalls[snapshotCalls.length - 1], 'sess-sub-vm');
    assert.equal(subModelPill.style.display, '', 'Switching back to subagent tab must restore model pill');
    assert.equal(subModelPill.textContent, 'Gemini 4 Neon (High)');

    host.handle.dispose();
    assert.equal(doc.getListenerCount('pointerdown'), 0);
    assert.equal(doc.getListenerCount('focusin'), 0);
  } finally {
    host.handle.dispose();
  }
});
