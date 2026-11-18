'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { h, setText, clearChildren } = require('../../src/ui/dom-builder');
const { getCspNonce, ensureStyleElement, removeStyleElements } = require('../../src/ui/style-manager');
const { createAdapterRegistry } = require('../../src/ui/adapter-registry');
const { createCoreMetricsAdapter } = require('../../src/ui/views/metrics-view');
const { createCompactButtonAdapter } = require('../../src/ui/views/compact-button');
const { createContextModalAdapter } = require('../../src/ui/views/context-modal');
const { createContextWindowStore } = require('../../src/domain/context-window-policy');
const { createTranslator } = require('../../src/domain/i18n');

function createMockDom() {
  const byId = new Map();

  class MockText {
    constructor(text) {
      this.nodeType = 3;
      this.textContent = String(text ?? '');
      this.parentNode = null;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
  }

  class MockElement {
    constructor(tagName, ownerDocument) {
      this.nodeType = 1;
      this.tagName = String(tagName || 'div').toUpperCase();
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.childNodes = [];
      this.attributes = new Map();
      this.style = {};
      this.listeners = new Map();
      this.parentNode = null;
      this.isConnected = false;
      this._id = '';
      this._className = '';
      this._textContent = '';
      this.nonce = '';
      this.value = '';
      this.title = '';
      this.type = '';
      this.placeholder = '';
      this.onclick = null;
      this.onkeydown = null;
      this.oncontextmenu = null;
    }
    get id() { return this._id; }
    set id(v) {
      if (this._id && byId.get(this._id) === this) byId.delete(this._id);
      this._id = String(v || '');
      if (this._id) {
        this.attributes.set('id', this._id);
        if (this.isConnected) byId.set(this._id, this);
      }
    }
    get className() { return this._className; }
    set className(v) {
      this._className = String(v || '');
      this.attributes.set('class', this._className);
    }
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() {
      if (this.childNodes.length === 0) return this._textContent;
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
      this.childNodes = [];
      this.children = [];
    }
    set innerHTML(_v) {
      throw new Error('SECURITY VIOLATION: innerHTML must never be written');
    }
    get innerHTML() {
      return '';
    }
    setAttribute(k, v) {
      const val = String(v);
      this.attributes.set(k, val);
      if (k === 'id') this.id = val;
      if (k === 'class') this._className = val;
      if (k === 'title') this.title = val;
      if (k === 'nonce') this.nonce = val;
    }
    getAttribute(k) {
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    removeAttribute(k) {
      this.attributes.delete(k);
      if (k === 'title') this.title = '';
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) {
        this.children.push(child);
        const markConnected = (n) => {
          n.isConnected = this.isConnected || this === doc.body || this === doc.head || this === doc.documentElement;
          if (n.isConnected && n._id) byId.set(n._id, n);
          for (const ch of n.children || []) markConnected(ch);
        };
        markConnected(child);
      }
      return child;
    }
    removeChild(child) {
      const i1 = this.childNodes.indexOf(child);
      if (i1 >= 0) this.childNodes.splice(i1, 1);
      const i2 = this.children.indexOf(child);
      if (i2 >= 0) this.children.splice(i2, 1);
      child.parentNode = null;
      if (child.nodeType === 1) {
        child.isConnected = false;
        if (child._id && byId.get(child._id) === child) byId.delete(child._id);
      }
    }
    replaceChildren(...nodes) {
      this._textContent = '';
      for (const ch of [...this.childNodes]) this.removeChild(ch);
      for (const n of nodes) this.appendChild(n);
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    contains(target) {
      if (target === this) return true;
      for (const ch of this.children) {
        if (ch.contains(target)) return true;
      }
      return false;
    }
    addEventListener(evt, fn) {
      if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
      this.listeners.get(evt).add(fn);
    }
    removeEventListener(evt, fn) {
      this.listeners.get(evt)?.delete(fn);
    }
    matchesSingle(sel) {
      if (sel.startsWith('#')) return this._id === sel.slice(1);
      if (sel.startsWith('.')) return this._className.split(/\s+/).includes(sel.slice(1));
      const attrMatch = sel.match(/^\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/);
      if (attrMatch) {
        if (!this.attributes.has(attrMatch[1])) return false;
        return attrMatch[2] === undefined ? true : this.attributes.get(attrMatch[1]) === attrMatch[2];
      }
      const tagAttr = sel.match(/^([a-z]+)\[([a-zA-Z0-9-]+)\]$/i);
      if (tagAttr) {
        return this.tagName === tagAttr[1].toUpperCase() && this.attributes.has(tagAttr[2]);
      }
      return this.tagName === sel.toUpperCase();
    }
    querySelectorAll(sel) {
      const sels = sel.split(',').map((s) => s.trim()).filter(Boolean);
      const out = [];
      const walk = (n) => {
        for (const ch of n.children || []) {
          if (sels.some((s) => ch.matchesSingle(s))) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  const docListeners = new Map();
  const winListeners = new Map();
  const win = {
    addEventListener(evt, fn) {
      if (!winListeners.has(evt)) winListeners.set(evt, new Set());
      winListeners.get(evt).add(fn);
    },
    removeEventListener(evt, fn) {
      winListeners.get(evt)?.delete(fn);
    },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
  };

  const doc = {
    defaultView: win,
    documentElement: null,
    head: null,
    body: null,
    createElement(tag) {
      return new MockElement(tag, doc);
    },
    createTextNode(txt) {
      return new MockText(txt);
    },
    getElementById(id) {
      return byId.get(id) || null;
    },
    querySelector(sel) {
      return this.documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return this.documentElement.querySelectorAll(sel);
    },
    addEventListener(evt, fn) {
      if (!docListeners.has(evt)) docListeners.set(evt, new Set());
      docListeners.get(evt).add(fn);
    },
    removeEventListener(evt, fn) {
      docListeners.get(evt)?.delete(fn);
    },
    _docListeners: docListeners,
    _winListeners: winListeners,
  };

  doc.documentElement = new MockElement('html', doc);
  doc.documentElement.isConnected = true;
  doc.head = new MockElement('head', doc);
  doc.body = new MockElement('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  win.document = doc;

  return { doc, win };
}

describe('v2.0 Zero-HTML UI, CSP Nonce StyleManager & Adapter Registry Suite', () => {
  it('SB2-TC-005 (D-0009, D-0025, D-0032): Zero innerHTML writes, zero TrustedTypes HTML policies, XSS payload escaped as text, CSS nonce propagated', () => {
    const { doc, win } = createMockDom();
    const policyCalls = [];
    globalThis.trustedTypes = {
      createPolicy(name) {
        policyCalls.push(name);
        throw new Error('Should not create any policy in UI modules');
      },
    };
    try {
      const seedScript = doc.createElement('script');
      seedScript.setAttribute('nonce', 'csp-nonce-xyz');
      doc.head.appendChild(seedScript);
      assert.equal(getCspNonce(doc), 'csp-nonce-xyz');

      ensureStyleElement(doc, new Set(['128K', '256K']));
      const styleEl = doc.getElementById('agy-ctx-statusbar-style');
      assert.ok(styleEl, 'Style element injected');
      assert.equal(styleEl.nonce, 'csp-nonce-xyz');
      assert.equal(styleEl.getAttribute('nonce'), 'csp-nonce-xyz');
      assert.equal(policyCalls.length, 0);

      // Render untrusted model name / cascadeId containing HTML payloads without executing or using innerHTML
      const payload = '<img src=x onerror="alert(1)"><script>evil()</script>';
      const el = h(doc, 'div', { title: payload }, payload);
      assert.equal(el.textContent, payload);
      assert.equal(el.children.length, 0, 'XSS payload must be pure text node, zero element nodes');

      setText(el, 'updated');
      assert.equal(el.textContent, 'updated');
      clearChildren(el);
      assert.equal(el.textContent, '');

      // dom-builder rejects dangerous tags and unsafe href/on* attributes
      assert.throws(() => h(doc, 'script', null, 'evil()'), /Disallowed UI element tag/);
      assert.throws(() => h(doc, 'svg', null), /Disallowed UI element tag/);
      assert.throws(() => h(doc, 'a', { attrs: { href: 'javascript:alert(1)' } }, 'x'), /Disallowed UI attribute/);
      assert.throws(() => h(doc, 'div', { attrs: { onclick: 'alert(1)' } }, 'x'), /Disallowed UI attribute/);

      removeStyleElements(doc);
      assert.equal(doc.getElementById('agy-ctx-statusbar-style'), null);
    } finally {
      delete globalThis.trustedTypes;
    }
  });

  it('SB2-TC-006 (D-0006, D-0012, D-0026): Adapter ordering, in-place metric updates, menu/modal listener cleanup & i18n reactivity', async () => {
    const { doc, win } = createMockDom();
    const translator = createTranslator('en');
    const storage = {
      loadPersistent: () => ({ sessionMap: {}, sessionTsMap: {}, defaultCw: '512K', hasExplicitDefault: false }),
      readSessionCookie: () => null,
      writeSessionCookie: () => {},
      readDefaultCookie: () => null,
      writeDefaultCookie: () => {},
      getLocalItem: () => null,
      setLocalItem: () => {},
      flushNative: () => {},
    };
    const cwStore = createContextWindowStore({ storage, translator });

    let updateCalls = 0;
    const registry = createAdapterRegistry({
      window: win,
      document: doc,
      onUpdate: () => { updateCalls += 1; },
    });

    const core = createCoreMetricsAdapter({
      document: doc,
      cwStore,
      translator,
      getConversationContextWindow: (_v, cid) => cwStore.getSavedContextWindow(cid),
      setConversationContextWindow: (_v, cid, cw) => cwStore.setSessionContextWindow(cid, cw),
      cycleConversationContextWindow: () => '900K',
      saveDefaultContextWindow: (cw) => cwStore.setDefaultContextWindow(cw),
      updateAll: () => { updateCalls += 1; },
    });
    const compact = createCompactButtonAdapter({ runCompactForInputBox: () => {}, translator });
    const modal = createContextModalAdapter({
      document: doc,
      window: win,
      translator,
      loadDebugTelemetry: async () => ({
        unavailable: false,
        cascadeId: 'cid-1234',
        trajectoryId: 'traj-1',
        currentCw: '512K',
        maxLimit: 512000,
        parsed: { used: 128000, cachePct: 75, cacheRead: 3000, inputTok: 1000, trajectoryMax: 512000 },
        metas: [],
        totalGenLen: 4,
        totalStepsLen: 8,
        latestCwm: { tokenBreakdown: { totalTokens: 128000, groups: [{ name: '<system> & "raw"', numTokens: 128000 }] } },
        latestSections: [],
        latestModel: 'Claude <Test>',
      }),
    });

    registry.registerBuiltinAdapters([core, compact, modal]);
    const unregCustom = registry.registerAdapter({
      id: 'z-ext',
      slot: 'right',
      order: 5,
      label: 'Custom',
      title: 'Initial',
      onClick: () => {},
    });
    assert.throws(() => registry.registerAdapter({ id: 'bad"]id', label: 'x', onClick() {} }), /valid/);
    assert.throws(() => registry.registerAdapter({ id: 'bad-tag', tagName: 'script', render() {} }), /disallowed tagName/);

    assert.deepEqual(
      registry.getAdapters().map((a) => a.id),
      ['core-metrics', 'z-ext', 'compact', 'context']
    );

    const view = h(doc, 'div', { 'data-cascade-id': 'cid-1234' });
    const bar = h(doc, 'div', { className: 'agy-ctx-statusbar' });
    view.appendChild(bar);
    doc.body.appendChild(view);

    const { leftEl, rightEl } = registry.ensureBarStructure(bar);
    const ctx = {
      barEl: bar,
      view,
      inputBox: view,
      cascadeId: 'cid-1234',
      currentCw: '512K',
      stats: { used: 128000, cachePct: 80 },
      quota: { pct5h: 92, rst5h: '→14:00', pct7d: 88 },
    };
    registry.renderSlotAdapters(leftEl, 'left', ctx);
    registry.renderSlotAdapters(rightEl, 'right', ctx);

    const limitBtnBefore = bar.querySelector('.agy-ctx-btn-limit');
    assert.ok(limitBtnBefore);
    assert.equal(limitBtnBefore.textContent, '[ 512k ▾ ]');

    // In-place update preserves button DOM node identity!
    ctx.stats = { used: 256000, cachePct: 85 };
    registry.renderSlotAdapters(leftEl, 'left', ctx);
    const limitBtnAfter = bar.querySelector('.agy-ctx-btn-limit');
    assert.equal(limitBtnBefore, limitBtnAfter);

    // Clearing empty title (D-0026)
    registry.registerAdapter({ id: 'z-ext', slot: 'right', order: 5, label: 'Custom2', title: '', onClick: () => {} });
    registry.renderSlotAdapters(rightEl, 'right', ctx);
    const extBtn = rightEl.children[0];
    assert.equal(extBtn.getAttribute('title'), null);
    unregCustom();
    assert.equal(registry.getAdapters().some((a) => a.id === 'z-ext'), false);

    // Popover menu open + delay listener attach + toggle close clears listeners cleanly
    limitBtnAfter.onclick({ preventDefault() {}, stopPropagation() {}, shiftKey: false });
    const menu = bar.querySelector('.agy-ctx-menu');
    assert.ok(menu, 'Menu should open on click');
    await new Promise((r) => setTimeout(r, 25));
    assert.ok((doc._docListeners.get('mousedown')?.size || 0) > 0, 'Outside listeners attached');

    limitBtnAfter.onclick({ preventDefault() {}, stopPropagation() {}, shiftKey: false });
    assert.equal(bar.querySelector('.agy-ctx-menu'), null, 'Toggle closes menu');
    assert.equal(doc._docListeners.get('mousedown')?.size || 0, 0, 'Outside listeners removed on close');

    // Modal open -> async render -> Escape closes and removes keydown listener
    await modal.openOrToggleDebugModal(view, view);
    const modalEl = doc.getElementById('agy-ctx-debug-modal');
    assert.ok(modalEl, 'Debug modal mounted');
    assert.ok((doc._winListeners.get('keydown')?.size || 0) === 1);
    for (const fn of doc._winListeners.get('keydown')) fn({ key: 'Escape' });
    assert.equal(doc.getElementById('agy-ctx-debug-modal'), null);
    assert.equal(doc._winListeners.get('keydown')?.size || 0, 0);
    assert.ok(updateCalls > 0);
  });
});
