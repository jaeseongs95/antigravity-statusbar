const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildBundle, OUT_FILE, MODULE_ORDER } = require('../scripts/build.js');
const {
  normalizeContextWindow,
  getCwLimit,
  getCwQuotaHint,
  createContextWindowStore,
} = require('../src/context-window-policy.js');
const { normalizeAdapter, createAdapterRegistry } = require('../src/adapter-registry.js');
const { extractStatsFromMetas } = require('../src/rpc-client.js');
const { buildDynamicCwWarnCss, fmtK, fmtNum, escHtml } = require('../src/dom-styles.js');
const { mountStatusBar, STATUSBAR_VERSION } = require('../src/index.js');

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

const SRC_DIR = path.join(__dirname, '..', 'src');
const SRC_PATCHER_PATH = path.join(__dirname, '..', 'scripts', 'ensure_statusbar_patch.js');
const SRC_INSTALL_PATH = path.join(__dirname, '..', 'scripts', 'install.js');
const SRC_BUILD_PATH = path.join(__dirname, '..', 'scripts', 'build.js');

describe('modular architecture & bundle verification', () => {
  it('verifies all separated SOLID modules exist, parse cleanly, and build into dist/statusbar_autoinject.js', () => {
    assert.equal(fs.existsSync(path.join(SRC_DIR, 'statusbar_autoinject.js')), false, 'monolithic src/statusbar_autoinject.js should be removed');

    for (const rel of MODULE_ORDER) {
      const fullPath = path.join(SRC_DIR, rel);
      assert.ok(fs.existsSync(fullPath), `module ${rel} should exist`);
      const code = fs.readFileSync(fullPath, 'utf8');
      assert.doesNotThrow(() => new vm.Script(code, { filename: fullPath }));
    }

    for (const scriptPath of [SRC_PATCHER_PATH, SRC_INSTALL_PATH, SRC_BUILD_PATH]) {
      const code = fs.readFileSync(scriptPath, 'utf8');
      assert.doesNotThrow(() => new vm.Script(code, { filename: scriptPath }));
    }

    const { outFile, size } = buildBundle();
    assert.equal(outFile, OUT_FILE);
    assert.ok(size > 1000);
    const bundleCode = fs.readFileSync(OUT_FILE, 'utf8');
    assert.ok(!bundleCode.includes('BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2'));
  });

  it('unit-tests isolated modules (context-window-policy, adapter-registry, rpc-client, dom-styles)', () => {
    // 1. context-window-policy
    assert.equal(normalizeContextWindow('200'), '200K');
    assert.equal(normalizeContextWindow('0.5m'), '500K');
    assert.equal(normalizeContextWindow('10'), '32K');
    assert.equal(normalizeContextWindow('1500'), '980K');
    assert.equal(getCwLimit('350K'), 350000);
    assert.ok(getCwQuotaHint('200K').includes('절약 모드'));

    const fakeLs = {
      map: new Map(),
      getItem(k) { return this.map.get(k) ?? null; },
      setItem(k, v) { this.map.set(k, String(v)); },
    };
    const store = createContextWindowStore({ document: { cookie: '' }, localStorage: fakeLs });
    store.saveContextWindowSetting('conv-a', '320');
    assert.equal(store.getSavedContextWindow('conv-a'), '320K');
    assert.equal(store.getSavedContextWindow('conv-b'), '512K');

    // 2. adapter-registry
    assert.throws(() => normalizeAdapter({ id: '' }), /non-empty string id/);
    assert.throws(() => normalizeAdapter({ id: 'invalid' }), /must provide either render/);
    let updates = 0;
    const reg = createAdapterRegistry({
      window: {},
      document: {},
      setHtml() {},
      onUpdate() { updates++; },
    });
    const off = reg.registerAdapter({ id: 'btn-1', slot: 'right', order: 15, label: '[ one ]' });
    assert.equal(reg.getAdapters().length, 1);
    assert.equal(updates, 1);
    off();
    assert.equal(reg.getAdapters().length, 0);

    // 3. rpc-client metadata parser
    const stats = extractStatsFromMetas([
      {
        chatModel: {
          chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 64000, maxContextTokens: 256000 } },
          usage: { cacheReadTokens: 60000, inputTokens: 4000 },
        },
      },
    ]);
    assert.equal(stats.used, 64000);
    assert.equal(stats.cachePct, 94);

    // 4. dom-styles
    assert.equal(fmtK(12500), '13k');
    assert.equal(fmtNum(123456), '123,456');
    assert.equal(escHtml('<a>"x"</a>'), '&lt;a&gt;&quot;x&quot;&lt;/a&gt;');
    assert.ok(buildDynamicCwWarnCss(new Set(['200K'])).includes('data-context-window="200K"'));
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
  sandbox.window.fetch = sandbox.fetch;
  sandbox.window.MutationObserver = sandbox.MutationObserver;

  return { sandbox, triggerEl, styleEl, getMountedBar: () => mountedBarEl };
}

describe('context window normalization, prototype bridge, and <=256K warning suppression', () => {
  it('normalizes preset and custom context windows and suppresses warning icon for <=256K', () => {
    buildBundle();
    const code = fs.readFileSync(OUT_FILE, 'utf8');
    const { sandbox, triggerEl, styleEl } = createDomSandbox();

    vm.runInNewContext(code, sandbox);

    sandbox.localStorage.setItem('agy-session-ctx-windows-v1', JSON.stringify({ 'test-session-1': '200' }));
    delete sandbox.window.__agyStatusBarActiveVersion;
    vm.runInNewContext(code, sandbox);

    assert.equal(triggerEl.getAttribute('data-context-window'), '200K');
    assert.equal(triggerEl.getAttribute('data-agy-cw-warn'), '0');
    assert.ok(styleEl.textContent.includes('[data-testid="model-selector-trigger"][data-context-window="200K"] div:has(> .text-warning)'));

    const mockUgb = { '256K': 256000, '512K': 512000, '900K': 900000 };
    const mockVgb = { '512K': '512K context window', '900K': '900K context window' };
    assert.equal(mockUgb['200K'], 200000);
    assert.ok(String(mockVgb['200K']).includes('200K custom context limit'));

    sandbox.localStorage.setItem('agy-session-ctx-windows-v1', JSON.stringify({ 'test-session-1': '350K' }));
    delete sandbox.window.__agyStatusBarActiveVersion;
    vm.runInNewContext(code, sandbox);

    assert.equal(triggerEl.getAttribute('data-context-window'), '350K');
    assert.equal(triggerEl.getAttribute('data-agy-cw-warn'), '1');
    assert.equal(mockUgb['350K'], 350000);
  });
});

describe('statusbar adapter architecture and built-in button adapters', () => {
  it('registers built-in adapters (core-metrics, compact, context) and supports custom adapter lifecycle via mountStatusBar', async () => {
    const { sandbox, getMountedBar } = createDomSandbox();

    const api = mountStatusBar(sandbox);
    assert.ok(api, 'mountStatusBar should return window.agyStatusBar API');
    assert.equal(api.version, STATUSBAR_VERSION);

    const initialAdapters = JSON.parse(JSON.stringify(api.getAdapters()));
    assert.deepEqual(
      initialAdapters.map((a) => ({ id: a.id, slot: a.slot, builtin: a.builtin })),
      [
        { id: 'core-metrics', slot: 'left', builtin: true },
        { id: 'compact', slot: 'right', builtin: true },
        { id: 'context', slot: 'right', builtin: true },
      ]
    );

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

    assert.equal(typeof sandbox.window.__agyStatusBarCleanup, 'function');
    sandbox.window.__agyStatusBarCleanup();
    assert.equal(sandbox.window.__agyStatusBarActiveVersion, undefined);
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
    const patchedMain = transformExactSize(fakeMain, MAIN_ANCHOR_TARGET, UTILS_ANCHOR_TARGET ? MAIN_ANCHOR_REPLACEMENT : '');
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
