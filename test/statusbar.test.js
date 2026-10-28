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

  it('contains required statusbar v6 features and no embedded external plugin markers', () => {
    const code = fs.readFileSync(SRC_STATUSBAR_PATH, 'utf8');
    assert.ok(code.includes("const STATUSBAR_VERSION = 'v6';"));
    assert.ok(code.includes('function registerCustomCwInPrototype(cw)'));
    assert.ok(code.includes('function normalizeContextWindow(raw)'));
    assert.ok(code.includes('function buildDynamicCwWarnCss()'));
    assert.ok(code.includes('data-agy-cw-warn'));
    assert.ok(!code.includes('BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2'));
  });
});

describe('context window normalization, prototype bridge, and <=256K warning suppression', () => {
  it('normalizes preset and custom context windows and suppresses warning icon for <=256K', () => {
    const code = fs.readFileSync(SRC_STATUSBAR_PATH, 'utf8');

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
    const triggerEl = {
      attrs: { 'data-context-window': '256K' },
      __reactFiber$test: fiberNode,
      getAttribute(k) { return this.attrs[k] ?? null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
    };
    const fakeInputBox = {
      querySelector() { return null; },
      appendChild() {},
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
        body: {},
        getElementById(id) {
          return id === 'agy-ctx-statusbar-style' ? styleEl : null;
        },
        querySelectorAll(sel) {
          if (sel.includes('conversation-view')) return [fakeView];
          return [];
        },
        querySelector() { return fakeView; },
        createElement() {
          return {
            id: '',
            textContent: '',
            setAttribute() {},
            appendChild() {},
          };
        },
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
      parseInt,
      parseFloat,
      isNaN,
      encodeURIComponent,
      decodeURIComponent,
    };
    sandbox.window.document = sandbox.document;
    sandbox.window.localStorage = sandbox.localStorage;

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
