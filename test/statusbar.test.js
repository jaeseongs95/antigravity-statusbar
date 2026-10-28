const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  PATCH_MARKER,
  UTILS_ANCHOR_TARGET,
  UTILS_ANCHOR_REPLACEMENT,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  PRELOAD_ANCHOR_TARGET,
  PRELOAD_ANCHOR_REPLACEMENT,
  transformExactSize,
  computeIntegrity,
} = require('../scripts/ensure_statusbar_patch.js');

const SRC_STATUSBAR_PATH = path.join(__dirname, '..', 'src', 'statusbar_autoinject.js');
const SRC_PATCHER_PATH = path.join(__dirname, '..', 'scripts', 'ensure_statusbar_patch.js');
const SRC_INSTALL_PATH = path.join(__dirname, '..', 'scripts', 'install.js');

describe('antigravity-statusbar syntax & bundle checks', () => {
  it('parses all scripts cleanly via vm.Script', () => {
    for (const filePath of [SRC_STATUSBAR_PATH, SRC_PATCHER_PATH, SRC_INSTALL_PATH]) {
      const code = fs.readFileSync(filePath, 'utf8');
      assert.doesNotThrow(() => new vm.Script(code, { filename: filePath }));
    }
  });

  it('contains required statusbar v7 features, adapter registry, and no embedded external plugin markers', () => {
    const code = fs.readFileSync(SRC_STATUSBAR_PATH, 'utf8');
    assert.ok(code.includes("const STATUSBAR_VERSION = 'v7';"));
    assert.ok(code.includes('function registerCustomCwInPrototype(cw)'));
    assert.ok(code.includes('function normalizeContextWindow(raw)'));
    assert.ok(code.includes('function buildDynamicCwWarnCss()'));
    assert.ok(code.includes('function registerStatusBarAdapter(rawAdapter)'));
    assert.ok(code.includes('function unregisterStatusBarAdapter(id)'));
    assert.ok(code.includes('window.agyStatusBar ='));
    assert.ok(code.includes('data-agy-cw-warn'));
    assert.ok(!code.includes('BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2'));
  });
});

function createDomSandbox() {
  const styleEl = { id: 'agy-ctx-statusbar-style', textContent: '' };
  const fiberNode = {
    memoizedProps: {
      value: {
        selectedModel: { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
        setSelectedModel() {},
        contextWindow: {
          selected: '256K',
          select(_model, cw) {
            this.selected = cw;
          },
        },
      },
    },
    return: null,
  };

  function makeEl(tagName = 'div') {
    return {
      tagName: String(tagName).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      title: '',
      type: '',
      innerHTML: '',
      isConnected: true,
      attrs: {},
      children: [],
      onclick: null,
      oncontextmenu: null,
      getAttribute(k) { return this.attrs[k] ?? null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(child) {
        child.isConnected = true;
        if (!this.children.includes(child)) this.children.push(child);
        return child;
      },
      remove() {
        this.isConnected = false;
      },
      querySelector(sel) {
        if (sel === '.agy-ctx-left') return this.children.find((c) => c.className === 'agy-ctx-left') || null;
        if (sel === '.agy-ctx-right') return this.children.find((c) => c.className === 'agy-ctx-right') || null;
        const m = sel.match(/^\[data-agy-adapter-id="([^"]+)"\]$/);
        if (m) {
          return this.children.find((c) => c.isConnected !== false && c.getAttribute('data-agy-adapter-id') === m[1]) || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-agy-adapter-id]') {
          return this.children.filter((c) => c.isConnected !== false && c.getAttribute('data-agy-adapter-id'));
        }
        const m = sel.match(/^\[data-agy-adapter-id="([^"]+)"\]$/);
        if (m) {
          return this.children.filter((c) => c.isConnected !== false && c.getAttribute('data-agy-adapter-id') === m[1]);
        }
        return [];
      },
    };
  }

  const triggerEl = makeEl('button');
  triggerEl.setAttribute('data-context-window', '256K');
  triggerEl.__reactFiber$test = fiberNode;

  let mountedBarEl = null;
  const fakeInputBox = {
    querySelector(sel) {
      if (sel === '.agy-ctx-statusbar') return mountedBarEl;
      return null;
    },
    appendChild(el) {
      if (el.className === 'agy-ctx-statusbar') {
        const leftSlot = makeEl('div');
        leftSlot.className = 'agy-ctx-left';
        const rightSlot = makeEl('div');
        rightSlot.className = 'agy-ctx-right';
        el.children = [leftSlot, rightSlot];
        mountedBarEl = el;
      }
      return el;
    },
  };

  const fakeView = {
    getAttribute(k) { return k === 'data-cascade-id' ? 'test-session-1' : null; },
    querySelector(sel) {
      if (sel === '[data-testid="model-selector-trigger"]') return triggerEl;
      if (sel === '[data-testid="agent-input-box"]') return fakeInputBox;
      return null;
    },
    __reactFiber$test: fiberNode,
  };

  const sandbox = {
    window: {
      __APP_CONFIG__: { csrfToken: 'test-csrf' },
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      cookie: '',
      head: {
        appendChild(el) {
          if (el.id === 'agy-ctx-statusbar-style') {
            styleEl.textContent = el.textContent;
          }
        },
      },
      documentElement: {},
      body: { appendChild() {} },
      getElementById(id) {
        return id === 'agy-ctx-statusbar-style' ? styleEl : null;
      },
      querySelectorAll(sel) {
        if (sel.includes('conversation-view')) return [fakeView];
        if (sel === '.agy-ctx-statusbar') return mountedBarEl ? [mountedBarEl] : [];
        return [];
      },
      querySelector() { return fakeView; },
      createElement(tag) { return makeEl(tag); },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.get(k) ?? null; },
      setItem(k, v) { this.store.set(k, String(v)); },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    fetch: async () => ({ json: async () => ({}) }),
    Object,
    Map,
    Set,
    Promise,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    RegExp,
    Array,
    TypeError,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;

  return { sandbox, triggerEl, styleEl, getMountedBar: () => mountedBarEl };
}

describe('context window normalization, prototype bridge, and <=256K warning suppression', () => {
  it('normalizes preset and custom context windows and suppresses warning icon for <=256K', () => {
    const code = fs.readFileSync(SRC_STATUSBAR_PATH, 'utf8');
    const { sandbox, triggerEl, styleEl } = createDomSandbox();

    vm.runInNewContext(code, sandbox);

    // Simulate applying 200K (<= 256K) via localStorage per-session map
    sandbox.localStorage.setItem('agy-session-ctx-windows-v1', JSON.stringify({ 'test-session-1': '200' }));
    delete sandbox.window.__agyStatusBarActiveVersion;
    vm.runInNewContext(code, sandbox);

    assert.equal(triggerEl.getAttribute('data-context-window'), '200K');
    assert.equal(triggerEl.getAttribute('data-agy-cw-warn'), '0');
    assert.ok(styleEl.textContent.includes('[data-testid="model-selector-trigger"][data-context-window="200K"] div:has(> .text-warning)'));

    // Verify Object.prototype non-enumerable getter works for v2.27 ugb (token map) and vgb (tooltip map)
    const mockUgb = { '256K': 256000, '512K': 512000, '900K': 900000 };
    const mockVgb = { '512K': '512K context window', '900K': '900K context window' };
    assert.equal(mockUgb['200K'], 200000);
    assert.ok(String(mockVgb['200K']).includes('200K custom context limit'));

    // Simulate applying 350K (> 256K)
    sandbox.localStorage.setItem('agy-session-ctx-windows-v1', JSON.stringify({ 'test-session-1': '350K' }));
    delete sandbox.window.__agyStatusBarActiveVersion;
    vm.runInNewContext(code, sandbox);

    assert.equal(triggerEl.getAttribute('data-context-window'), '350K');
    assert.equal(triggerEl.getAttribute('data-agy-cw-warn'), '1');
    assert.equal(mockUgb['350K'], 350000);
  });
});

describe('statusbar adapter architecture and built-in button adapters', () => {
  it('registers built-in adapters (core-metrics, compact, context) and supports custom adapter lifecycle', async () => {
    const code = fs.readFileSync(SRC_STATUSBAR_PATH, 'utf8');
    const { sandbox, getMountedBar } = createDomSandbox();

    vm.runInNewContext(code, sandbox);

    const api = sandbox.window.agyStatusBar;
    assert.ok(api, 'window.agyStatusBar should be exposed');
    assert.equal(api.version, 'v7');

    const initialAdapters = JSON.parse(JSON.stringify(api.getAdapters()));
    assert.deepEqual(
      initialAdapters.map((a) => ({ id: a.id, slot: a.slot, builtin: a.builtin })),
      [
        { id: 'core-metrics', slot: 'left', builtin: true },
        { id: 'compact', slot: 'right', builtin: true },
        { id: 'context', slot: 'right', builtin: true },
      ]
    );

    // Wait microtask for Promise.all([fetchCascadeStats, quotaPromise]).then(renderBar)
    await new Promise((r) => setTimeout(r, 10));

    const barEl = getMountedBar();
    assert.ok(barEl, 'statusbar element should be mounted');
    const rightSlot = barEl.querySelector('.agy-ctx-right');
    const compactBtn = rightSlot.querySelector('[data-agy-adapter-id="compact"]');
    const contextBtn = rightSlot.querySelector('[data-agy-adapter-id="context"]');
    assert.ok(compactBtn, 'compact button adapter should be rendered in right slot');
    assert.ok(contextBtn, 'context button adapter should be rendered in right slot');
    assert.equal(compactBtn.textContent, '[ compact ]');
    assert.equal(contextBtn.textContent, '[ context ]');
    assert.ok(compactBtn.className.includes('agy-ctx-btn-compact'));
    assert.ok(contextBtn.className.includes('agy-ctx-btn-context'));

    // Register a custom adapter and verify click handler and unmount lifecycle
    let clickedSessionId = null;
    let unmounted = false;
    const dispose = api.registerAdapter({
      id: 'custom-tool',
      slot: 'right',
      order: 30,
      label: '[ tool ]',
      title: 'Custom tool button',
      onClick(ctx) {
        clickedSessionId = ctx.cascadeId;
      },
      unmount() {
        unmounted = true;
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    const customBtn = rightSlot.querySelector('[data-agy-adapter-id="custom-tool"]');
    assert.ok(customBtn, 'custom adapter button should be mounted');
    assert.equal(customBtn.textContent, '[ tool ]');

    customBtn.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.equal(clickedSessionId, 'test-session-1');

    dispose();
    assert.equal(unmounted, true);
    assert.equal(api.getAdapters().some((a) => a.id === 'custom-tool'), false);

    // Validate explicit error on invalid adapter registration
    assert.throws(() => api.registerAdapter({ id: '' }), /non-empty string id/);
    assert.throws(() => api.registerAdapter({ id: 'no-render-or-label' }), /must provide either render/);
  });
});

describe('ASAR exact-size transformation', () => {
  it('preserves exact byte length for utils.js, main.js, and preload.js patches', () => {
    const commentPadding = Array.from({ length: 30 }, (_, i) => `// comment line ${i} padding for exact size transform`).join('\n');

    const fakeUtils = Buffer.from(`"use strict";\n${commentPadding}\nfunction createWindow(url) {\n${UTILS_ANCHOR_TARGET}\n}\n`, 'utf8');
    const patchedUtils = transformExactSize(fakeUtils, UTILS_ANCHOR_TARGET, UTILS_ANCHOR_REPLACEMENT);
    assert.equal(patchedUtils.length, fakeUtils.length);
    assert.ok(patchedUtils.toString('utf8').includes(PATCH_MARKER));

    const fakeMain = Buffer.from(`"use strict";\n${commentPadding}\n${MAIN_ANCHOR_TARGET}\n  console.log(contents);\n});\n`, 'utf8');
    const patchedMain = transformExactSize(fakeMain, MAIN_ANCHOR_TARGET, MAIN_ANCHOR_REPLACEMENT);
    assert.equal(patchedMain.length, fakeMain.length);
    assert.ok(patchedMain.toString('utf8').includes(PATCH_MARKER));

    const fakePreload = Buffer.from(`"use strict";\n${commentPadding}\n${PRELOAD_ANCHOR_TARGET}\n`, 'utf8');
    const patchedPreload = transformExactSize(fakePreload, PRELOAD_ANCHOR_TARGET, PRELOAD_ANCHOR_REPLACEMENT);
    assert.equal(patchedPreload.length, fakePreload.length);
    assert.ok(patchedPreload.toString('utf8').startsWith('"use strict";'));
    assert.ok(patchedPreload.toString('utf8').includes(PATCH_MARKER));

    const integrity = computeIntegrity(patchedPreload);
    assert.equal(integrity.algorithm, 'SHA256');
    assert.equal(integrity.blocks.length, 1);
  });
});
