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
const { mountStatusBar, ensureRemoteCompanionScripts, STATUSBAR_VERSION } = require('../src/index.js');

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

    const { outFile, size, bundle: bundleCode } = buildBundle({ write: false });
    assert.equal(outFile, OUT_FILE);
    assert.ok(size > 1000);
    assert.ok(!bundleCode.includes('BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2'));

    const readmeEn = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const readmeKo = fs.readFileSync(path.join(__dirname, '..', 'README.ko.md'), 'utf8');
    assert.ok(readmeEn.includes('README.ko.md'), 'English README should link to Korean README');
    assert.ok(readmeKo.includes('README.md'), 'Korean README should link to English README');
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

    // 3. rpc-client metadata parser (REST JSON & protobuf-es oneof formats)
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

    const pbStats = extractStatsFromMetas([
      {
        metadata: {
          case: 'chatModel',
          value: {
            chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 80000n, maxContextTokens: 512000n } },
            usage: { cacheReadTokens: 70000n, inputTokens: 10000n },
          },
        },
      },
    ]);
    assert.equal(pbStats.used, 80000);
    assert.equal(pbStats.trajectoryMax, 512000);
    assert.equal(pbStats.cachePct, 88);

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

  function serializeDomNode(n) {
    if (!n) return '';
    if (n.nodeType === 3) {
      return String(n.nodeValue ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    const tag = String(n.tagName || 'div').toLowerCase();
    const attrMap = { ...(n.attrs || {}) };
    if (n.id && attrMap.id === undefined) attrMap.id = n.id;
    if (n.className && attrMap.class === undefined) attrMap.class = n.className;
    if (n.type && attrMap.type === undefined) attrMap.type = n.type;
    if (n.title && attrMap.title === undefined) attrMap.title = n.title;
    if (n.style && typeof n.style === 'object') {
      const styleParts = [];
      for (const [k, v] of Object.entries(n.style)) {
        if (k === 'cssText' || v === '' || v === null || v === undefined) continue;
        const prop = k.replace(/([A-Z])/g, '-$1').toLowerCase();
        styleParts.push(`${prop}:${v}`);
      }
      if (styleParts.length > 0) {
        attrMap.style = styleParts.join(';');
      }
    }
    const attrStr = Object.entries(attrMap)
      .map(([k, v]) => ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
      .join('');
    if (tag === 'input' || tag === 'br' || tag === 'hr' || tag === 'img') {
      return `<${tag}${attrStr}>`;
    }
    const inner =
      Array.isArray(n.childNodes) && n.childNodes.length > 0
        ? n.childNodes.map(serializeDomNode).join('')
        : String(n._rawHtml || '');
    return `<${tag}${attrStr}>${inner}</${tag}>`;
  }

  function matchesSimpleSelector(el, sel) {
    if (!el || el.nodeType === 3 || el.isConnected === false) return false;
    if (sel.startsWith('.')) {
      const targetCls = sel.slice(1);
      return String(el.className || '').split(/\s+/).includes(targetCls);
    }
    const m = sel.match(/^\[data-agy-adapter-id="([^"]+)"\]$/);
    if (m) {
      return el.getAttribute?.('data-agy-adapter-id') === m[1];
    }
    if (sel === '[data-agy-adapter-id]') {
      return Boolean(el.getAttribute?.('data-agy-adapter-id'));
    }
    return String(el.tagName || '').toLowerCase() === sel.toLowerCase();
  }

  function makeEl(tagName = 'div') {
    const el = {
      nodeType: 1,
      tagName: String(tagName).toUpperCase(),
      id: '',
      className: '',
      _text: '',
      _rawHtml: '',
      title: '',
      type: '',
      value: '',
      placeholder: '',
      style: {},
      isConnected: true,
      attrs: {},
      children: [],
      childNodes: [],
      firstChild: null,
      onclick: null,
      oncontextmenu: null,
      get textContent() {
        if (this.childNodes.length > 0) {
          return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
        }
        return this._text;
      },
      set textContent(v) {
        this._rawHtml = '';
        this.children = [];
        this.childNodes = [];
        const str = String(v ?? '');
        this._text = str;
        if (str) {
          const tn = { nodeType: 3, nodeValue: str };
          this.childNodes.push(tn);
        }
        this.firstChild = this.childNodes[0] || null;
      },
      get innerHTML() {
        if (this.childNodes.length > 0) {
          return this.childNodes.map(serializeDomNode).join('');
        }
        if (this._rawHtml) return this._rawHtml;
        if (this._text) {
          return String(this._text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        return '';
      },
      set innerHTML(v) {
        this._rawHtml = String(v ?? '');
        this._text = '';
        this.children = [];
        this.childNodes = [];
        this.firstChild = null;
      },
      getAttribute(k) { return this.attrs[k] ?? null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(child) {
        if (!child) return child;
        if (child.nodeType !== 3) {
          child.isConnected = true;
          child.parentNode = this;
          if (!this.children.includes(child)) this.children.push(child);
        }
        if (!this.childNodes.includes(child)) this.childNodes.push(child);
        this.firstChild = this.childNodes[0] || null;
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((c) => c !== child);
        this.childNodes = this.childNodes.filter((c) => c !== child);
        this.firstChild = this.childNodes[0] || null;
        return child;
      },
      remove() {
        this.isConnected = false;
        if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
          this.parentNode.removeChild(this);
        }
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const results = [];
        const walk = (parent) => {
          for (const c of parent.children || []) {
            if (matchesSimpleSelector(c, sel)) {
              results.push(c);
            }
            walk(c);
          }
        };
        walk(this);
        return results;
      },
    };
    return el;
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
        el.childNodes = [leftSlot, rightSlot];
        el.firstChild = leftSlot;
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
      createTextNode(txt) { return { nodeType: 3, nodeValue: String(txt ?? '') }; },
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

    assert.equal(getCwLimit('200K'), 200000);
    assert.ok(String(getCwQuotaHint('200K')).includes('절약 모드'));
    assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, '200K'), undefined, 'Object.prototype must remain clean');

    sandbox.localStorage.setItem('agy-session-ctx-windows-v1', JSON.stringify({ 'test-session-1': '350K' }));
    delete sandbox.window.__agyStatusBarActiveVersion;
    vm.runInNewContext(code, sandbox);

    assert.equal(triggerEl.getAttribute('data-context-window'), '350K');
    assert.equal(triggerEl.getAttribute('data-agy-cw-warn'), '1');
    assert.equal(getCwLimit('350K'), 350000);
    assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, '350K'), undefined, 'Object.prototype must remain clean');
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

  it('mounts and fetches stats/quota in Remote Control web mode (no csrfToken) via React Fiber RPC service', async () => {
    const { sandbox, getMountedBar } = createDomSandbox();
    delete sandbox.window.__APP_CONFIG__;

    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');
    view.__reactFiber$test.memoizedProps.value.retrieveUserQuotaSummary = async () => ({
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { window: '5h', remaining: { case: 'remainingFraction', value: 0.72 }, resetTime: { seconds: 1793332083 } },
              { window: 'weekly', remaining: { case: 'remainingFraction', value: 0.9 } },
            ],
          },
        ],
      },
    });
    view.__reactFiber$test.memoizedProps.value.getCascadeTrajectory = async () => ({
      trajectory: {
        generatorMetadata: [
          {
            metadata: {
              case: 'chatModel',
              value: {
                chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 51200, maxContextTokens: 256000 } },
                usage: { cacheReadTokens: 45000, inputTokens: 5000 },
              },
            },
          },
        ],
      },
    });

    const api = mountStatusBar(sandbox);
    assert.ok(api);
    await new Promise((r) => setTimeout(r, 25));

    const barEl = getMountedBar();
    assert.ok(barEl, 'statusbar should mount even without csrfToken when Remote Control service is in Fiber');
    const leftSlot = barEl.querySelector('.agy-ctx-left');
    const coreNode = leftSlot.querySelector('[data-agy-adapter-id="core-metrics"]');
    assert.ok(coreNode.innerHTML.includes('51k'));
    assert.ok(coreNode.innerHTML.includes('90%'));
    assert.ok(coreNode.innerHTML.includes('72%'));
    sandbox.window.__agyStatusBarCleanup();
  });

  it('mounts on antigravity.google.com/r/<uuid> (<ga-remote-control> Angular host shell) via RemoteControlComponent.proxyCommand', async () => {
    const { sandbox } = createDomSandbox();
    delete sandbox.window.__APP_CONFIG__;

    const messageListeners = [];
    sandbox.window.addEventListener = (type, fn) => {
      if (type === 'message') messageListeners.push(fn);
    };
    sandbox.window.dispatchEvent = (ev) => {
      for (const fn of messageListeners) fn(ev);
    };
    sandbox.window.MessageEvent = class {
      constructor(type, init) {
        this.type = type;
        this.data = init?.data;
      }
    };

    let sentCompactPayload = null;
    const requestedOffsets = [];
    class FakeRemoteControlComponent {
      constructor() {
        this.destroyed = false;
        this.lastSyncedChildPath = '';
      }
      selectedInstanceUuid() {
        return '547d3ff8-7d19-415f-a68a-9bbf28c06f6f-v2';
      }
      handleIframeMessage(ev) {
        if (ev?.data === '__agy_probe__') return;
      }
      streamProxyCommand(rpcPath, payloadBytes) {
        return { cancel() {} };
      }
      async proxyCommand(rpcPath, payloadBytes) {
        const req = JSON.parse(new TextDecoder().decode(payloadBytes));
        let resObj = {};
        if (rpcPath.endsWith('/GetAllCascadeTrajectories')) {
          resObj = {
            trajectorySummaries: {
              'e0b9092d-4949-4a25-9c5d-0afdfd030c10': {
                stepCount: 2612,
                lastModifiedTime: '2026-10-30T03:00:00Z',
                annotations: { lastUserViewTime: '2026-10-30T03:00:00Z' },
              },
              '1f3f7633-f0b7-4fc7-a958-9fb667c85623': {
                stepCount: 2667,
                lastModifiedTime: '2026-10-30T02:50:00Z',
                annotations: { lastUserViewTime: '2026-10-30T02:50:00Z' },
              },
            },
          };
        } else if (rpcPath.endsWith('/RetrieveUserQuotaSummary')) {
          resObj = {
            response: {
              groups: [
                {
                  displayName: 'Gemini',
                  buckets: [
                    { window: '5h', remainingFraction: 0.84 },
                    { window: 'weekly', remainingFraction: 0.61 },
                  ],
                },
              ],
            },
          };
        } else if (rpcPath.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
          const off = req.generatorMetadataOffset || 0;
          requestedOffsets.push(off);
          const actualLen = 1073;
          if (off >= actualLen) {
            resObj = {};
          } else {
            const count = actualLen - off;
            const usedTok = req.cascadeId === '1f3f7633-f0b7-4fc7-a958-9fb667c85623' ? 245000 : 128000;
            resObj = {
              generatorMetadata: Array.from({ length: count }, () => ({
                chatModel: {
                  chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: usedTok, maxContextTokens: 512000 } },
                  usage: { cacheReadTokens: 110000, inputTokens: 18000 },
                },
              })),
            };
          }
        } else if (rpcPath.endsWith('/SendUserCascadeMessage')) {
          sentCompactPayload = req;
          resObj = { ok: true };
        }
        return { payload: new TextEncoder().encode(JSON.stringify(resObj)), headers: {} };
      }
    }

    const rcInstance = new FakeRemoteControlComponent();
    sandbox.window.addEventListener('message', (e) => rcInstance.handleIframeMessage(e));
    sandbox.window.default_GoogleAntigravity = {
      iH: { RemoteControlComponent: FakeRemoteControlComponent },
    };

    let hostViewEl = null;
    let hostBarEl = null;
    const appContainerEl = {
      children: [],
      querySelector(sel) {
        if (sel === '.agy-rc-host-view') return hostViewEl;
        return null;
      },
      appendChild(el) {
        if (el.className === 'agy-rc-host-view') {
          hostViewEl = el;
          const hostBox = el.children[0];
          const origAppend = hostBox.appendChild.bind(hostBox);
          hostBox.querySelector = (s) => (s === '.agy-ctx-statusbar' ? hostBarEl : null);
          hostBox.appendChild = (child) => {
            if (child.className === 'agy-ctx-statusbar') {
              const leftSlot = sandbox.document.createElement('div');
              leftSlot.className = 'agy-ctx-left';
              const rightSlot = sandbox.document.createElement('div');
              rightSlot.className = 'agy-ctx-right';
              child.children = [leftSlot, rightSlot];
              hostBarEl = child;
            }
            return origAppend(child);
          };
          el.querySelector = (s) => (s === '[data-testid="agent-input-box"]' ? hostBox : null);
        }
        this.children.push(el);
        return el;
      },
    };
    const gaRemoteControlEl = {
      querySelector(sel) {
        if (sel === '.app-container') return appContainerEl;
        return null;
      },
    };

    sandbox.document.querySelector = (sel) => {
      if (sel === 'ga-remote-control') return gaRemoteControlEl;
      if (sel === '[data-testid="conversation-view"]:not(.agy-rc-host-view)') return null;
      if (sel === '.agy-rc-host-view' || sel === '[data-testid="conversation-view"]') return hostViewEl;
      return null;
    };
    sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('conversation-view')) return hostViewEl ? [hostViewEl] : [];
      if (sel === '.agy-ctx-statusbar') return hostBarEl ? [hostBarEl] : [];
      if (sel === '.agy-rc-host-view') return hostViewEl ? [hostViewEl] : [];
      return [];
    };

    const api = mountStatusBar(sandbox);
    assert.ok(api);
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(hostViewEl, 'synthetic .agy-rc-host-view should be created inside ga-remote-control');
    assert.equal(hostViewEl.getAttribute('data-cascade-id'), 'e0b9092d-4949-4a25-9c5d-0afdfd030c10');
    assert.ok(hostBarEl, 'statusbar should be mounted inside .agy-rc-host-view');

    const leftSlot = hostBarEl.querySelector('.agy-ctx-left');
    const coreNode = leftSlot.querySelector('[data-agy-adapter-id="core-metrics"]');
    assert.ok(coreNode.innerHTML.includes('128k'));
    assert.ok(coreNode.innerHTML.includes('84%'));
    assert.ok(coreNode.innerHTML.includes('61%'));
    assert.equal(requestedOffsets.includes(0), false, 'large trajectory should never fall back to offset 0');

    // Simulate switching conversation inside iframe via StreamAgentStateUpdates binary protobuf frame
    const protoSwitchBody = new TextEncoder().encode('\x0a\x241f3f7633-f0b7-4fc7-a958-9fb667c85623\x12\x08test-sub');
    rcInstance.streamProxyCommand('/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', protoSwitchBody);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(hostViewEl.getAttribute('data-cascade-id'), '1f3f7633-f0b7-4fc7-a958-9fb667c85623');
    assert.ok(coreNode.innerHTML.includes('245k'), 'switching session via StreamAgentStateUpdates should update context stats immediately');

    // Set custom context window on switched session and simulate >15s idle polling: must NOT revert to latestId (e0b9092d-...)
    api.setConversationContextWindow(hostViewEl, '1f3f7633-f0b7-4fc7-a958-9fb667c85623', '600K');
    sandbox.window.__agySniffedCascadeTs = Date.now() - 25000;
    api.updateAll();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      hostViewEl.getAttribute('data-cascade-id'),
      '1f3f7633-f0b7-4fc7-a958-9fb667c85623',
      'polling after 15s must not overwrite active switched session with latestId'
    );
    assert.equal(api.getConversationContextWindow(hostViewEl, '1f3f7633-f0b7-4fc7-a958-9fb667c85623'), '600K');
    assert.equal(api.getConversationContextWindow(hostViewEl, 'e0b9092d-4949-4a25-9c5d-0afdfd030c10'), '512K');

    const rightSlot = hostBarEl.querySelector('.agy-ctx-right');
    const compactBtn = rightSlot.querySelector('[data-agy-adapter-id="compact"]');
    await compactBtn.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.ok(sentCompactPayload, 'clicking [ compact ] on ga-remote-control should send SendUserCascadeMessage via proxyCommand');
    assert.equal(sentCompactPayload.cascadeId, '1f3f7633-f0b7-4fc7-a958-9fb667c85623');
    assert.equal(sentCompactPayload.items[0].item.slashCommand.info.name, 'compact');
    assert.equal(sentCompactPayload.cascadeConfig?.checkpointConfig?.contextWindow, '600K');
    assert.equal(sentCompactPayload.cascadeConfig?.checkpointConfig?.maxTokenLimit, 600000, 'remote proxyCommand SendUserCascadeMessage must also inject maxTokenLimit: 600000');

    sandbox.window.__agyStatusBarCleanup();
  });

  it('skips local HTTP fetch when isRemoteControl is true and handles Protobuf BigInt metrics + lsClient in Same-Origin remote iframe', async () => {
    const { sandbox, getMountedBar } = createDomSandbox();
    sandbox.window.__APP_CONFIG__ = {
      productName: 'antigravity',
      csrfToken: 'csrf_token',
      isRemoteControl: true,
    };

    let localHttpCalled = false;
    sandbox.fetch = async () => {
      localHttpCalled = true;
      throw new Error('local HTTP fetch should not be called when isRemoteControl is true');
    };
    sandbox.window.fetch = sandbox.fetch;

    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');
    view.__reactFiber$test.memoizedProps.value.core = {
      projectManagementService: {
        lsClient: {
          retrieveUserQuotaSummary: async () => ({
            response: {
              groups: [
                {
                  displayName: 'Gemini',
                  buckets: [
                    { window: '5h', remainingFraction: 0.65, resetTime: { seconds: 1793332083n } },
                    { window: 'weekly', remainingFraction: 0.88 },
                  ],
                },
              ],
            },
          }),
          getCascadeTrajectoryGeneratorMetadata: async () => ({
            generatorMetadata: [
              {
                chatModel: {
                  chatStartMetadata: {
                    contextWindowMetadata: {
                      estimatedTokensUsed: 64000n,
                      maxContextTokens: 256000n,
                    },
                  },
                  usage: {
                    cacheReadTokens: 60000n,
                    inputTokens: 4000n,
                  },
                },
              },
            ],
          }),
        },
      },
    };

    const api = mountStatusBar(sandbox);
    assert.ok(api);
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(localHttpCalled, false, 'should bypass local HTTP fetch when isRemoteControl is true');
    const barEl = getMountedBar();
    assert.ok(barEl);
    const leftSlot = barEl.querySelector('.agy-ctx-left');
    const coreNode = leftSlot.querySelector('[data-agy-adapter-id="core-metrics"]');
    assert.ok(coreNode.innerHTML.includes('64k'), 'should render BigInt token usage without TypeError');
    assert.ok(coreNode.innerHTML.includes('94%'), 'should compute cache hit rate from BigInt values');
    assert.ok(coreNode.innerHTML.includes('65%'), 'should render quota summary from core.projectManagementService.lsClient');

    sandbox.window.__agyStatusBarCleanup();
  });

  it('recovers CustomizationsStore when SubscribeToPlugins hangs in Loading installed plugins...', async () => {
    const { sandbox } = createDomSandbox();
    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');

    let refreshCalled = 0;
    let disableStreamingCalled = 0;
    const fakeCustomizationsStore = {
      hasReceivedStreamSnapshot: false,
      streamingDisabled: false,
      state: {
        getState: () => ({ isLoadingPlugins: !fakeCustomizationsStore.hasReceivedStreamSnapshot }),
      },
      disableStreaming() {
        disableStreamingCalled += 1;
        this.streamingDisabled = true;
      },
      receiveStreamedPlugins() {},
      async refresh() {
        refreshCalled += 1;
        this.hasReceivedStreamSnapshot = true;
      },
    };

    view.__reactFiber$test.return = {
      memoizedProps: { value: fakeCustomizationsStore },
      return: null,
    };

    const api = mountStatusBar(sandbox);
    assert.ok(api);
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(disableStreamingCalled, 1, 'should disable broken SubscribeToPlugins streaming');
    assert.equal(refreshCalled, 1, 'should trigger CustomizationsStore.refresh() fallback once');
    assert.equal(fakeCustomizationsStore.hasReceivedStreamSnapshot, true);

    sandbox.window.__agyStatusBarCleanup();
  });

  it('synchronizes per-session context window between Desktop nativeStorage and Mobile Remote Control via UpdateConversationAnnotations', async () => {
    const { sandbox, getMountedBar } = createDomSandbox();
    const cid = 'test-session-1';
    let serverProfile = '384K|512K|1793842900000';
    const annotationUpdates = [];

    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');
    view.__reactFiber$test.memoizedProps.value.core = {
      projectManagementService: {
        lsClient: {
          getAllCascadeTrajectories: async () => ({
            trajectorySummaries: {
              [cid]: {
                stepCount: 42,
                lastModifiedTime: '2026-11-05T01:40:00Z',
                annotations: {
                  lastUserViewTime: '2026-11-05T01:45:00Z',
                  activeProfile: serverProfile,
                },
              },
            },
          }),
          updateConversationAnnotations: async (req) => {
            annotationUpdates.push(req);
            serverProfile = req?.annotations?.activeProfile || serverProfile;
            return {};
          },
        },
      },
    };

    const api = mountStatusBar(sandbox);
    assert.ok(api);
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(api.getConversationContextWindow(view, cid), '384K', 'should adopt 384K from server annotations.activeProfile even when Redux seeded 256K');
    const barEl = getMountedBar();
    assert.ok(barEl);
    const coreNode = barEl.querySelector('.agy-ctx-left').querySelector('[data-agy-adapter-id="core-metrics"]');
    assert.ok(coreNode);
    assert.ok(coreNode.innerHTML.includes('[ 384k ▾ ]'), 'limit button should display [ 384k ▾ ] matching server annotation');

    // Change context window to 256K -> should push UpdateConversationAnnotations to server
    api.setConversationContextWindow(view, cid, '256K');
    api.updateAll();
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(api.getConversationContextWindow(view, cid), '256K');
    assert.ok(coreNode.innerHTML.includes('[ 256k ▾ ]'), 'limit button should update to [ 256k ▾ ]');
    assert.ok(annotationUpdates.length >= 1, 'changing context window should call UpdateConversationAnnotations');
    assert.deepEqual(annotationUpdates[annotationUpdates.length - 1].cascadeIds, [cid]);
    assert.ok(String(annotationUpdates[annotationUpdates.length - 1].annotations.activeProfile).startsWith('256K|'));

    sandbox.window.__agyStatusBarCleanup();
  });

  it('preserves independent per-session context windows across session switches, 1-arg msCtx wrapper, and mobile 15s polling', async () => {
    const { sandbox, triggerEl } = createDomSandbox();
    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');

    let currentCascadeId = 'session-alpha';
    view.getAttribute = (k) => (k === 'data-cascade-id' ? currentCascadeId : null);
    view.setAttribute = (k, v) => {
      if (k === 'data-cascade-id') currentCascadeId = String(v);
    };

    const reduxState = {
      modelSelection: {
        default: { model: 1418, contextWindow: '256K' },
        byConversation: {
          'session-alpha': { model: 1418, contextWindow: '256K' },
          'session-beta': { model: 1418, contextWindow: '256K' },
        },
      },
      userStatus: Object.freeze({
        cascadeModelConfigData: Object.freeze({
          clientModelConfigs: Object.freeze([
            Object.freeze({ label: 'Gemini 4 Argon (Medium)', value: 1418, contextWindowOptions: Object.freeze([]) }),
          ]),
        }),
      }),
    };

    const dispatchedActions = [];
    const reduxStore = {
      getState: () => reduxState,
      dispatch(action) {
        dispatchedActions.push(action);
        if (action.type === 'userStatus/setUserStatus') {
          reduxState.userStatus = action.payload;
        }
        if (action.type === 'modelSelection/modelPicked') {
          const { conversationId, model, customLabel, contextWindow } = action.payload;
          if (conversationId) {
            reduxState.modelSelection.byConversation[conversationId] = {
              model,
              customLabel,
              contextWindow,
            };
          } else {
            reduxState.modelSelection.default = {
              model,
              customLabel,
              contextWindow,
            };
          }
        }
      },
    };

    const buildBindingsProviderVal = {
      corpHost: undefined,
      cider: undefined,
      contextWindow: undefined,
    };

    // Simulate Antigravity 2.0 where jtc.Provider wraps setSelectedModel with 1-arg `m => { b(m); c(!1) }`
    // and contextWindow is initially undefined
    const selectedModelObj = { value: 1418, label: 'Gemini 4 Argon (Medium)' };
    triggerEl.__reactFiber$test = {
      memoizedProps: {
        value: {
          selectedModel: selectedModelObj,
          // 1-arg wrapper that ignores 2nd arg (targetCw)
          setSelectedModel(m) {
            reduxStore.dispatch({
              type: 'modelSelection/modelPicked',
              payload: { conversationId: currentCascadeId, model: m.value, contextWindow: '256K' },
            });
          },
          contextWindow: undefined,
        },
      },
      return: {
        memoizedProps: {
          value: buildBindingsProviderVal,
        },
        return: {
          memoizedProps: {
            value: { store: reduxStore },
          },
          return: null,
        },
      },
    };
    view.__reactFiber$test = triggerEl.__reactFiber$test;

    const api = mountStatusBar(sandbox);
    assert.ok(api);

    // 1. Set session-alpha to 384K and session-beta to 750K
    api.setConversationContextWindow(view, 'session-alpha', '384K');
    api.setConversationContextWindow(view, 'session-beta', '750K');

    assert.equal(reduxState.modelSelection.byConversation['session-alpha'].contextWindow, '384K', 'Redux byConversation for session-alpha must be 384K despite 1-arg setSelectedModel wrapper');
    assert.equal(reduxState.modelSelection.byConversation['session-beta'].contextWindow, '750K', 'Redux byConversation for session-beta must be 750K');
    assert.ok(buildBindingsProviderVal.contextWindow && typeof buildBindingsProviderVal.contextWindow === 'object', 'buildBindings contextWindow should be enabled');
    assert.ok(Array.isArray(selectedModelObj.contextWindowOptions) && selectedModelObj.contextWindowOptions.some((o) => o.name === '384K'), 'selectedModel.contextWindowOptions should include custom 384K option');
    assert.ok(
      reduxState.userStatus.cascadeModelConfigData.clientModelConfigs[0].contextWindowOptions.some((o) => o.name === '384K'),
      'frozen Redux clientModelConfigs should be updated via userStatus/setUserStatus without TypeError'
    );

    // 2. Render session-alpha first, then switch the same view element to session-beta where React initially renders data-context-window="256K"
    currentCascadeId = 'session-alpha';
    api.updateAll();
    assert.equal(triggerEl.getAttribute('data-context-window'), '384K');

    // Simulate switching tab/session in the same view: React resets DOM attribute to "256K" before statusbar runs
    currentCascadeId = 'session-beta';
    triggerEl.setAttribute('data-context-window', '256K');
    api.updateAll();

    assert.equal(
      api.getConversationContextWindow(view, 'session-beta'),
      '750K',
      'switching session must NOT overwrite session-beta saved 750K with React initial 256K'
    );
    assert.equal(triggerEl.getAttribute('data-context-window'), '750K');
    assert.equal(reduxState.modelSelection.byConversation['session-beta'].contextWindow, '750K');

    // Switch back to session-alpha -> triggerEl and statusbar must reflect 384K
    currentCascadeId = 'session-alpha';
    api.updateAll();
    assert.equal(triggerEl.getAttribute('data-context-window'), '384K');
    assert.equal(api.getConversationContextWindow(view, 'session-alpha'), '384K');

    // 3. Verify mobile migrateSessionOverride ('remote-session' -> resolved UUID)
    api.setConversationContextWindow(view, 'remote-session', '640K');
    assert.equal(api.getConversationContextWindow(view, 'remote-session'), '640K');

    sandbox.window.__agyStatusBarCleanup();
  });

  it('loads only the companion plugins actually installed on the host (1-plugin solo, 2-plugin combo, 3-plugin full, and offline host-block fallback)', async () => {
    const makeEnv = (hostBundleContent, fetchShouldFail = false) => {
      const appendedScripts = [];
      const fetchedUrls = [];
      const fakeDoc = {
        head: {
          appendChild(el) {
            appendedScripts.push(el);
          },
        },
        querySelector(sel) {
          if (sel === 'script[nonce]') return { nonce: 'test-csp-nonce' };
          return null;
        },
        createElement(tag) {
          return { tagName: tag.toUpperCase(), nonce: '', text: '' };
        },
      };
      const fakeWin = {
        location: { hostname: 'antigravity.google.com' },
      };
      const fakeFetch = async (url) => {
        fetchedUrls.push(url);
        if (fetchShouldFail) throw new Error('network blocked');
        return {
          ok: true,
          async text() {
            return `// loaded from github: ${url}`;
          },
        };
      };
      const fakeHostBridge = {
        async fetchHostInstalledPluginInfo() {
          const hasMcp = hostBundleContent.includes('BEGIN_AGY_MCP_MANAGER_V1') || hostBundleContent.includes('PLUGIN_ONLY_MCP');
          const hasKo = hostBundleContent.includes('BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2') || hostBundleContent.includes('PLUGIN_ONLY_KO');
          return {
            resolved: true,
            hasStatusbar: hostBundleContent.includes('mountStatusBar'),
            hasMcpManager: hasMcp,
            hasKoTranslator: hasKo,
            mcpManagerCode: hostBundleContent.includes('BEGIN_AGY_MCP_MANAGER_V1') ? '/* === BEGIN_AGY_MCP_MANAGER_V1 === */\nwindow.agyMcpManager={};\n/* === END_AGY_MCP_MANAGER_V1 === */' : '',
            koTranslatorCode: hostBundleContent.includes('BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2') ? '/* === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 === */\nwindow.__agyKoLocalizerActive=true;\n/* === END_AGY_KO_THOUGHT_LOCALIZER_V2 === */' : '',
            hostBundleText: hostBundleContent,
          };
        },
      };
      return { fakeWin, fakeDoc, fakeFetch, fakeHostBridge, appendedScripts, fetchedUrls };
    };

    // Case 1: User installed ONLY statusbar (1 plugin solo) -> must NOT load MCP Manager or KoTranslator
    {
      const env1 = makeEnv('function mountStatusBar() {}');
      await ensureRemoteCompanionScripts(env1.fakeWin, env1.fakeDoc, env1.fakeFetch, env1.fakeHostBridge);
      assert.equal(env1.fetchedUrls.length, 0, 'solo statusbar user must not fetch un-installed companions');
      assert.equal(env1.appendedScripts.length, 0, 'solo statusbar user must not inject un-installed companions');
    }

    // Case 2A: Host bundle already contains MCP Manager block -> executes local host block FIRST without external fetch
    {
      const env2a = makeEnv('function mountStatusBar() {}\n/* === BEGIN_AGY_MCP_MANAGER_V1 === */');
      await ensureRemoteCompanionScripts(env2a.fakeWin, env2a.fakeDoc, env2a.fakeFetch, env2a.fakeHostBridge);
      assert.equal(env2a.fetchedUrls.length, 0, 'must NOT call external fetch when host bundle code is already available');
      assert.equal(env2a.appendedScripts.length, 1);
      assert.ok(env2a.appendedScripts[0].text.includes('BEGIN_AGY_MCP_MANAGER_V1'));
    }

    // Case 2B: Host bundle already contains KoTranslator block -> executes local host block FIRST without external fetch
    {
      const env2b = makeEnv('function mountStatusBar() {}\n/* === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 === */');
      await ensureRemoteCompanionScripts(env2b.fakeWin, env2b.fakeDoc, env2b.fakeFetch, env2b.fakeHostBridge);
      assert.equal(env2b.fetchedUrls.length, 0, 'must NOT call external fetch when host bundle code is already available');
      assert.equal(env2b.appendedScripts.length, 1);
      assert.ok(env2b.appendedScripts[0].text.includes('BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2'));
    }

    // Case 3: Host reports plugins installed via GetAllPlugins (no inline block) -> falls back to jaeseongs95 GitHub Raw URLs
    {
      const env3 = makeEnv('function mountStatusBar() {}\nPLUGIN_ONLY_MCP\nPLUGIN_ONLY_KO');
      await ensureRemoteCompanionScripts(env3.fakeWin, env3.fakeDoc, env3.fakeFetch, env3.fakeHostBridge);
      assert.equal(env3.fetchedUrls.length, 2);
      assert.ok(env3.fetchedUrls.some((u) => u.includes('jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js')));
      assert.ok(env3.fetchedUrls.some((u) => u.includes('jaeseongs95/antigravity-ko-translator/main/plugins/ko-thought-translator/scripts/ko_thought_autoinject.js')));
      assert.ok(!env3.fetchedUrls.some((u) => u.includes('superselect321')));
      assert.equal(env3.appendedScripts.length, 2);
      assert.equal(env3.appendedScripts[0].nonce, 'test-csp-nonce');
    }

    // Case 4: Offline / GitHub fetch blocked -> falls back to host ReadFile marker block code
    {
      const env4 = makeEnv('function mountStatusBar() {}\n/* === BEGIN_AGY_MCP_MANAGER_V1 === */', true);
      await ensureRemoteCompanionScripts(env4.fakeWin, env4.fakeDoc, env4.fakeFetch, env4.fakeHostBridge);
      assert.equal(env4.appendedScripts.length, 1, 'should fall back to host bundle block when GitHub fetch fails');
      assert.ok(env4.appendedScripts[0].text.includes('BEGIN_AGY_MCP_MANAGER_V1'));
    }
  });

  it('injects cascadeConfig.checkpointConfig.maxTokenLimit into SendUserCascadeMessage (JSON and Protobuf binary) and updates stats immediately after Compacting', async () => {
    const { sandbox, getMountedBar } = createDomSandbox();
    const cid = 'test-session-1';
    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');

    // Extensible empty contextWindowOptions array (matches real GetUserStatus response)
    const mutableModelCfg = { label: 'Gemini 4 Argon (Medium)', value: 1418, contextWindowOptions: [] };
    let userStatusDispatchedCount = 0;
    const reduxState = {
      modelSelection: {
        default: { model: 1418, contextWindow: '256K' },
        byConversation: { [cid]: { model: 1418, contextWindow: '256K' } },
      },
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [mutableModelCfg],
        },
      },
    };
    const reduxStore = {
      getState: () => reduxState,
      dispatch(action) {
        if (action.type === 'userStatus/setUserStatus') {
          userStatusDispatchedCount += 1;
          reduxState.userStatus = action.payload;
        }
        if (action.type === 'modelSelection/modelPicked' && action.payload.conversationId) {
          reduxState.modelSelection.byConversation[action.payload.conversationId] = action.payload;
        }
      },
    };

    let compacted = false;
    let currentStepCount = 3257;
    view.__reactFiber$test.return = {
      memoizedProps: {
        value: {
          store: reduxStore,
          cascadeContext: {
            state: {
              agentStateProvider: {
                getState: () => ({
                  conversationId: 'test-session-1',
                  trajectorySlice: {
                    totalGeneratorMetadataLength: -1,
                    totalStepsLength: currentStepCount,
                  },
                  compactionInfo: {
                    compactedAtStepIndices: compacted ? [3258] : [],
                  },
                  contextWindowUsage: compacted
                    ? {
                        estimatedTokensUsed: 245038,
                        estimatedAfterCompaction: 33388,
                        maxContextTokens: 384000,
                        lastStepIndex: 3258,
                      }
                    : {
                        estimatedTokensUsed: 245038,
                        maxContextTokens: 384000,
                        lastStepIndex: 3257,
                      },
                }),
              },
            },
          },
        },
      },
      return: null,
    };

    let lastSentMessageReq = null;
    let lastSentProtoBytes = null;
    sandbox.fetch = async (url, init) => {
      if (String(url).endsWith('/SendUserCascadeMessage')) {
        if (typeof init?.body === 'string') {
          lastSentMessageReq = JSON.parse(init.body);
        } else if (init?.body instanceof Uint8Array) {
          lastSentProtoBytes = init.body;
        }
        return { ok: true, json: async () => ({}) };
      }
      if (String(url).endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
        return {
          ok: true,
          json: async () => ({
            generatorMetadata: [
              {
                stepIndices: [3256, 3257],
                chatModel: {
                  chatStartMetadata: {
                    contextWindowMetadata: {
                      estimatedTokensUsed: 245038,
                      maxContextTokens: 256000,
                    },
                  },
                  usage: { cacheReadTokens: 242000, inputTokens: 3038 },
                },
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    sandbox.window.fetch = sandbox.fetch;

    const api = mountStatusBar(sandbox);
    api.setConversationContextWindow(view, cid, '384K');
    await new Promise((r) => setTimeout(r, 25));

    assert.ok(userStatusDispatchedCount >= 1, 'must dispatch userStatus/setUserStatus with new clientModelConfig reference even when contextWindowOptions was an extensible []');
    assert.notEqual(
      reduxState.userStatus.cascadeModelConfigData.clientModelConfigs[0],
      mutableModelCfg,
      'updated clientModelConfig in Redux must be a new object reference to invalidate Reselect memoization'
    );

    const barEl = getMountedBar();
    const coreNode = barEl.querySelector('.agy-ctx-left').querySelector('[data-agy-adapter-id="core-metrics"]');
    assert.ok(coreNode.innerHTML.includes('245k'), 'before compaction, should show 245k');
    assert.ok(coreNode.innerHTML.includes('64%'), 'before compaction, 245k / 384k should be 64%');

    // 1. Test JSON SendUserCascadeMessage interception (string body)
    await sandbox.window.fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
      method: 'POST',
      body: JSON.stringify({ cascadeId: cid, items: [{ text: 'hello' }] }),
    });
    assert.ok(lastSentMessageReq, 'SendUserCascadeMessage JSON should be intercepted');
    assert.equal(lastSentMessageReq.cascadeConfig?.checkpointConfig?.contextWindow, '384K');
    assert.equal(lastSentMessageReq.cascadeConfig?.checkpointConfig?.maxTokenLimit, 384000, 'must inject maxTokenLimit: 384000 so language_server proto.Merge overrides 256000 default');

    // 1-B. Test Unframed UTF-8 JSON Uint8Array body (must NOT append binary 0x2a '*'!)
    const jsonBytesReq = new TextEncoder().encode(JSON.stringify({ cascadeId: cid, items: [{ text: 'json-u8' }] }));
    await sandbox.window.fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
      method: 'POST',
      body: jsonBytesReq,
    });
    assert.ok(lastSentProtoBytes instanceof Uint8Array);
    const decodedUnframedJson = new TextDecoder().decode(lastSentProtoBytes);
    assert.ok(!decodedUnframedJson.endsWith('*'), 'Unframed JSON Uint8Array must never have 0x2a (*) appended');
    const parsedUnframedJson = JSON.parse(decodedUnframedJson);
    assert.equal(parsedUnframedJson.cascadeConfig?.checkpointConfig?.maxTokenLimit, 384000);

    // 1-C. Test Connect 5-byte Framed UTF-8 JSON Uint8Array (`[0x00, len3..0]` + JSON, exact reproduction of line 1:787 invalid value *!)
    const framedOrigJsonBytes = new TextEncoder().encode(
      JSON.stringify({
        cascadeId: cid,
        items: [{ text: '혹시 띵킹켜는거 어디붙는지 봐줄래?' }],
        cascadeConfig: { checkpointConfig: { contextWindow: '384K' } },
      })
    );
    const framedJsonReq = new Uint8Array(5 + framedOrigJsonBytes.length);
    framedJsonReq[0] = 0;
    framedJsonReq[1] = (framedOrigJsonBytes.length >>> 24) & 0xff;
    framedJsonReq[2] = (framedOrigJsonBytes.length >>> 16) & 0xff;
    framedJsonReq[3] = (framedOrigJsonBytes.length >>> 8) & 0xff;
    framedJsonReq[4] = framedOrigJsonBytes.length & 0xff;
    framedJsonReq.set(framedOrigJsonBytes, 5);

    await sandbox.window.fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
      method: 'POST',
      body: framedJsonReq,
    });
    assert.ok(lastSentProtoBytes instanceof Uint8Array);
    assert.equal(lastSentProtoBytes[0], 0);
    const newFrameLen =
      ((lastSentProtoBytes[1] << 24) >>> 0) +
      (lastSentProtoBytes[2] << 16) +
      (lastSentProtoBytes[3] << 8) +
      lastSentProtoBytes[4];
    assert.equal(newFrameLen, lastSentProtoBytes.length - 5, '5-byte Connect frame length header must match new JSON payload byte length');
    const decodedFramedJson = new TextDecoder().decode(lastSentProtoBytes.subarray(5));
    assert.ok(!decodedFramedJson.includes('*'), 'Connect-framed JSON must NEVER have binary 0x2a (*) appended after JSON');
    const parsedFramedJson = JSON.parse(decodedFramedJson);
    assert.equal(parsedFramedJson.cascadeConfig?.checkpointConfig?.maxTokenLimit, 384000);
    assert.equal(parsedFramedJson.cascadeConfig?.checkpointConfig?.contextWindow, '384K');

    // 2. Test Protobuf binary SendUserCascadeMessage interception
    const rawProtoReq = new TextEncoder().encode(`\x0a\x24${cid}`);
    await sandbox.window.fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
      method: 'POST',
      body: rawProtoReq,
    });
    assert.ok(lastSentProtoBytes instanceof Uint8Array);
    assert.ok(lastSentProtoBytes.length > rawProtoReq.length, 'Protobuf binary request must have cascade_config.checkpoint_config suffix appended');
    const firstInjectedProtoLen = lastSentProtoBytes.length;
    const suffix = Array.from(lastSentProtoBytes.subarray(rawProtoReq.length));
    // 0x2a (field 5 cascade_config), len, 0x12 (field 2 checkpoint_config), len, 0x28 (field 5 max_token_limit), varint(384000) = [0x80, 0xb8, 0x17]
    assert.equal(suffix[0], 0x2a);
    assert.equal(suffix[2], 0x12);
    assert.equal(suffix[4], 0x28);
    assert.deepEqual(suffix.slice(5, 8), [0x80, 0xb8, 0x17], 'varint encoding of 384000 must be [0x80, 0xb8, 0x17]');

    // 2-B. Idempotency: passing already-injected Protobuf bytes a second time (e.g. handlePortRequest -> proxyCommand) must not double-append
    await sandbox.window.fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
      method: 'POST',
      body: lastSentProtoBytes,
    });
    assert.equal(lastSentProtoBytes.length, firstInjectedProtoLen, 'Protobuf suffix injection must be idempotent');

    // 3. Simulate Compacting completing at step 3258 -> statusbar must immediately reflect 33k (9%), NOT stay stuck at 245k (64%)
    compacted = true;
    currentStepCount = 3258;
    api.updateAll();
    await new Promise((r) => setTimeout(r, 25));

    assert.ok(coreNode.innerHTML.includes('33k'), `after compaction, statusbar must update from 245k to 33k, got: ${coreNode.innerHTML}`);
    assert.ok(coreNode.innerHTML.includes('9%'), `after compaction, percentage must update to 9% (33k/384k), got: ${coreNode.innerHTML}`);

    sandbox.window.__agyStatusBarCleanup();
  });

  it('covers D-0004~D-0010 regressions: lB() array/Uint8Array & line-marker extraction, seedSessionIfEmpty migration, incomplete Connect frame guard, Protobuf clone preservation, and listener cleanup', async () => {
    const { sandbox } = createDomSandbox();
    const { createHostBridge } = require('../src/host-bridge');
    const { createContextWindowStore } = require('../src/context-window-policy');
    const { escHtml } = require('../src/dom-styles');
    const { extractStatsFromMetas } = require('../src/rpc-client');

    // 1. D-0009: escHtml escapes single quotes, seedSessionIfEmpty sets ts so migrateSessionOverride works, and getDefaultCw is 512K
    assert.equal(escHtml("a'b\"c"), 'a&#39;b&quot;c');
    const store = createContextWindowStore({});
    assert.equal(store.getDefaultCw(), '512K');
    store.seedSessionIfEmpty('remote-session', '750K');
    assert.equal(store.migrateSessionOverride('remote-session', 'real-uuid-1234'), '750K');
    assert.equal(store.getSavedContextWindow('real-uuid-1234'), '750K');

    // 2. D-0007: extractStatsFromMetas handles estimatedTokensUsed === 0
    const zeroMeta = extractStatsFromMetas([
      {
        stepIndices: [1],
        chatModel: {
          chatStartMetadata: {
            contextWindowMetadata: { estimatedTokensUsed: 0, maxContextTokens: 256000 },
          },
        },
      },
    ]);
    assert.equal(zeroMeta.foundCtx, true);
    assert.equal(zeroMeta.used, 0);

    // 3. D-0004: fetchHostInstalledPluginInfo handles lB() array return, Uint8Array readFile, and // === BEGIN_... single-line markers
    const lineMarkedBundle = [
      'function mountStatusBar() {}',
      '// === BEGIN_AGY_MCP_MANAGER_V1 ===',
      'window.agyMcpManager = {};',
      '// === END_AGY_MCP_MANAGER_V1 ===',
      '// === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
      'window.__agyKoThoughtCleanup = () => {};',
      '// === END_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
    ].join('\n');

    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');
    view.__reactFiber$test.memoizedProps.value.core = {
      projectManagementService: {
        lsClient: {
          async getCustomizationStates(arg) {
            assert.ok(Array.isArray(arg), 'lB().getCustomizationStates expects workspaceUris array');
            return [{ path: 'C:/Users/Test/.gemini/antigravity/skills/test/SKILL.md' }];
          },
          async getAllPlugins() {
            return { plugins: [] };
          },
          async readFile(arg) {
            assert.equal(typeof arg, 'string', 'lB().readFile expects string URI');
            return new TextEncoder().encode(lineMarkedBundle);
          },
        },
      },
    };

    const hb = createHostBridge({
      window: sandbox.window,
      document: sandbox.document,
      localStorage: sandbox.localStorage,
      fetchFn: null,
      cwStore: store,
    });

    const pluginInfo = await hb.fetchHostInstalledPluginInfo(null, view);
    assert.equal(pluginInfo.resolved, true);
    assert.equal(pluginInfo.hasMcpManager, true);
    assert.equal(pluginInfo.hasKoTranslator, true);
    assert.ok(pluginInfo.mcpManagerCode.includes('window.agyMcpManager = {};'));
    assert.ok(pluginInfo.koTranslatorCode.includes('window.__agyKoThoughtCleanup'));

    // 4. D-0008: Incomplete Connect frame (`u8[0] === 0` with mismatched length) must NOT have raw 0x2a appended
    const incompleteFrame = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x20, 0x0a, 0x04, 0x74, 0x65, 0x73, 0x74]);
    const afterIncomplete = hb.injectCheckpointLimitIntoSendRequest(
      '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      incompleteFrame,
      null
    );
    assert.equal(afterIncomplete.length, incompleteFrame.length, 'incomplete Connect frame must be left untouched');

    // 5. D-0008: Protobuf Message instance prototype methods preserved when injecting unary object
    const validUuid = '12345678-1234-1234-1234-123456789abc';
    store.seedSessionIfEmpty('remote-session-2', '750K');
    assert.equal(store.migrateSessionOverride('remote-session-2', validUuid), '750K');
    class FakeProtoReq {
      constructor() {
        this.cascadeId = validUuid;
      }
      toBinary() {
        return new Uint8Array([1, 2, 3]);
      }
    }
    const protoInst = new FakeProtoReq();
    const injectedObj = hb.injectCheckpointLimitIntoSendRequest(
      '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      protoInst,
      null
    );
    assert.equal(typeof injectedObj.toBinary, 'function', 'prototype method toBinary must be preserved');
    assert.equal(injectedObj.cascadeConfig.checkpointConfig.maxTokenLimit, 750000);
  });

  it('covers SB-BUG-01..06 regressions: post-compaction token growth, Angular 19 numeric __ngContext__ & bound listener, ReadFile retry & Linux/Windows URI decoding, remote context modal tail offset, Connect frame flags > 1 & limit change replacement, and cross-origin SecurityError caching', async () => {
    const { sandbox } = createDomSandbox();
    const { createHostBridge } = require('../src/host-bridge');
    const { createContextWindowStore } = require('../src/context-window-policy');
    const { createRpcClient } = require('../src/rpc-client');
    const { createContextButtonAdapter } = require('../src/adapters/context-button');

    // 1. SB-BUG-01: Real /main.js flattened `fullState.compactedAtStepIndices` (no `compactionInfo`), boolean `estimatedAfterCompaction: true`, and `startStepIndex` without `stepIndices`
    let currentMetaStep = 100;
    let currentMetaTokens = 245000;
    let isJustCompactedBool = true;
    const view = sandbox.document.querySelector('[data-testid="conversation-view"]');
    const inputBox = view.querySelector('[data-testid="agent-input-box"]');
    const cid = view.getAttribute('data-cascade-id');

    const fakeAsp = {
      getState() {
        return {
          conversationId: cid,
          trajectorySlice: {
            totalGeneratorMetadataLength: 5,
            totalStepsLength: currentMetaStep + 1,
          },
          compactedAtStepIndices: [100],
          contextWindowUsage: {
            estimatedTokensUsed: isJustCompactedBool ? 33388 : currentMetaTokens,
            estimatedAfterCompaction: isJustCompactedBool,
            maxContextTokens: 512000,
            lastStepIndex: currentMetaStep,
          },
        };
      },
    };

    const rpc = createRpcClient({
      window: sandbox.window,
      fetchFn: async () => ({
        ok: true,
        async json() {
          return {
            generatorMetadata: [
              {
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M37',
                  usage: { inputTokens: 2000, cacheReadTokens: 8000 },
                  chatStartMetadata: {
                    startStepIndex: currentMetaStep,
                    contextWindowMetadata: {
                      estimatedTokensUsed: currentMetaTokens,
                      maxContextTokens: 512000,
                    },
                  },
                },
              },
            ],
          };
        },
      }),
      localStorage: sandbox.localStorage,
      getAgentStateProviderForInputBox: () => fakeAsp,
      getRemoteRpcServiceForElement: () => null,
    });

    // At step 100 (just compacted, boolean estimatedAfterCompaction: true, estimatedTokensUsed: 33388): should show 33,388 (NOT 1!)
    const statsAtCompact = await rpc.fetchCascadeStats(cid, 'csrf-123', inputBox);
    assert.equal(statsAtCompact.used, 33388, 'immediately after compaction at step 100 with boolean estimatedAfterCompaction:true, used must be 33388 (not 1)');

    // Now conversation continues to step 150 and actual tokens grow to 120,000 (> 33,388)
    isJustCompactedBool = false;
    currentMetaStep = 150;
    currentMetaTokens = 120000;
    const statsAfterGrowth = await rpc.fetchCascadeStats(cid, 'csrf-123', inputBox);
    assert.equal(statsAfterGrowth.used, 120000, 'once subsequent turns advance past latestCompactedStep, actual 120000 tokens must NOT be overwritten by old 33388 afterCompact');

    // 2. SB-BUG-02: Angular 19 numeric __ngContext__ WITHOUT ɵgetLContext, when handleIframeMessage was .bind(this) BEFORE bookmarklet and ignores '__agy_probe__'
    let urlChangedMutated = false;
    class ProdRemoteControlComponent {
      constructor(w) {
        this.destroyed = false;
        this._bound = this.handleIframeMessage.bind(this);
        w.addEventListener('message', this._bound);
      }
      handleIframeMessage(ev) {
        if (!ev || ev.data === '__agy_probe__') return;
        if (ev.data && ev.data.type === 'URL_CHANGED') {
          this.handleUrlChanged(ev.data.path || '');
        }
      }
      handleUrlChanged(_p) {
        urlChangedMutated = true;
      }
      async proxyCommand(_path, _bytes) {
        return { payload: new TextEncoder().encode(JSON.stringify({ ok: true })) };
      }
    }
    const winMsgListeners = [];
    const rcElNum = { __ngContext__: 77, querySelector: () => null };
    const rcDoc = {
      addEventListener() {},
      dispatchEvent() {},
      querySelector(sel) { return sel === 'ga-remote-control' ? rcElNum : null; },
      querySelectorAll() { return []; },
    };
    const rcWin = {
      document: rcDoc,
      location: { href: 'https://antigravity.google.com/r/123', origin: 'https://antigravity.google.com' },
      addEventListener(t, fn) { if (t === 'message') winMsgListeners.push(fn); },
      dispatchEvent(ev) { if (ev?.type === 'message') winMsgListeners.forEach((f) => f(ev)); },
      default_GoogleAntigravity: {
        m1: {
          RemoteControlComponent: ProdRemoteControlComponent,
        },
      },
      Event: class { constructor(t) { this.type = t; } },
      MessageEvent: class {
        constructor(t, i) {
          this.type = t;
          this.data = i?.data;
          this.origin = i?.origin;
          this.source = i?.source;
        }
      },
    };
    const prodRcInst = new ProdRemoteControlComponent(rcWin);
    const store = createContextWindowStore({});
    const rcHb = createHostBridge({
      window: rcWin,
      document: rcDoc,
      localStorage: sandbox.localStorage,
      fetchFn: null,
      cwStore: store,
    });
    const foundSvc = rcHb.getRemoteRpcServiceForElement(null);
    assert.ok(foundSvc && foundSvc.isRemoteControlHost, 'must acquire RemoteControl instance without ɵgetLContext via URL_CHANGED prototype hook');
    assert.equal(rcWin.__agyRemoteControlInstance, prodRcInst);
    assert.equal(urlChangedMutated, false, 'probing via URL_CHANGED must suppress original handleUrlChanged body');

    // 3. SB-BUG-03: fetchHostInstalledPluginInfo returns resolved:false when ReadFile fails even if candidatePaths.length > 0, and preserves Linux leading '/' & decodes Windows '%3A'
    let readAttempts = 0;
    view.__reactFiber$test.memoizedProps.value.core = {
      projectManagementService: {
        lsClient: {
          async getCustomizationStates() {
            return [{ path: 'file:///home/devuser/.gemini/config/plugins/ags/SKILL.md' }];
          },
          async getAllPlugins() {
            return { plugins: [] };
          },
          async readFile() {
            readAttempts += 1;
            if (readAttempts === 1) return null; // Transient failure on attempt 1
            return new TextEncoder().encode([
              'function mountStatusBar() {}',
              '// === BEGIN_AGY_MCP_MANAGER_V1 ===',
              'function mountMcpManager() {}',
              '// === END_AGY_MCP_MANAGER_V1 ===',
            ].join('\n'));
          },
        },
      },
    };
    const hbLinux = createHostBridge({
      window: sandbox.window,
      document: sandbox.document,
      localStorage: sandbox.localStorage,
      fetchFn: null,
      cwStore: store,
    });
    const attempt1 = await hbLinux.fetchHostInstalledPluginInfo(null, view);
    assert.equal(attempt1.geminiDir, '/home/devuser/.gemini', 'Linux file:/// URI must preserve leading slash');
    assert.equal(attempt1.resolved, false, 'when ReadFile fails on known geminiDir, resolved must be false so retry loop continues');

    const attempt2 = await hbLinux.fetchHostInstalledPluginInfo(null, view);
    assert.equal(attempt2.resolved, true);
    assert.equal(attempt2.hasMcpManager, true);

    // Percent-encoded Windows URI (`file:///c%3A/Users/...`)
    view.__reactFiber$test.memoizedProps.value.core.projectManagementService.lsClient.getCustomizationStates = async () => [
      { path: 'file:///c%3A/Users/Lenovo/.gemini/config/plugins/ags/SKILL.md' },
    ];
    const winEncodedInfo = await hbLinux.fetchHostInstalledPluginInfo(null, view);
    assert.equal(winEncodedInfo.geminiDir, 'c:/Users/Lenovo/.gemini');

    // 3b. SB-BUG-03 all 7 install combinations using real buildBundle({ write: false }).bundle without false positives
    const realSbBundle = buildBundle({ write: false }).bundle;
    const mcpBeginMark = '// === ' + ['BEGIN_AGY_MCP', 'MANAGER_V1'].join('_') + ' ===';
    const mcpEndMark = '// === ' + ['END_AGY_MCP', 'MANAGER_V1'].join('_') + ' ===';
    const koBeginMark = '// === ' + ['BEGIN_AGY_KO', 'THOUGHT_LOCALIZER_V2'].join('_') + ' ===';
    const koEndMark = '// === ' + ['END_AGY_KO', 'THOUGHT_LOCALIZER_V2'].join('_') + ' ===';
    const fakeMcpMarked = [
      mcpBeginMark,
      '// Antigravity Custom MCP Server Manager',
      'function mountMcpManager() { const s = "function mountStatusBar( agy-ctx-statusbar __agyKoThoughtCleanup"; }',
      mcpEndMark,
    ].join('\n');
    const fakeKoMarked = [
      koBeginMark,
      'const m = ["function mountStatusBar(", "function mountMcpManager(", "agy-ctx-statusbar"];',
      'window.__agyKoThoughtCleanup = () => {};',
      koEndMark,
    ].join('\n');

    const combos = [
      { name: '1: sb only', text: realSbBundle, exp: [true, false, false] },
      { name: '2: mcp only', text: fakeMcpMarked, exp: [false, true, false] },
      { name: '3: ko only', text: fakeKoMarked, exp: [false, false, true] },
      { name: '4: sb + mcp', text: `${realSbBundle}\n${fakeMcpMarked}`, exp: [true, true, false] },
      { name: '5: sb + ko', text: `${realSbBundle}\n${fakeKoMarked}`, exp: [true, false, true] },
      { name: '6: mcp + ko', text: `${fakeMcpMarked}\n${fakeKoMarked}`, exp: [false, true, true] },
      { name: '7: sb + mcp + ko', text: `${realSbBundle}\n${fakeMcpMarked}\n${fakeKoMarked}`, exp: [true, true, true] },
    ];
    for (const c of combos) {
      view.__reactFiber$test.memoizedProps.value.core.projectManagementService.lsClient.readFile = async () =>
        new TextEncoder().encode(c.text);
      const res = await hbLinux.fetchHostInstalledPluginInfo(null, view);
      assert.deepEqual(
        [res.hasStatusbar, res.hasMcpManager, res.hasKoTranslator],
        c.exp,
        `combo ${c.name} failed detection`
      );
    }

    // 4. SB-BUG-04: context-button on Remote Control web uses __agyRcGenLenByCascade / __agyRcStepCountByCascade to avoid offset 0
    sandbox.window.__agyRcGenLenByCascade = { [cid]: 1073 };
    sandbox.window.__agyRcStepCountByCascade = { [cid]: 2612 };
    const requestedModalOffsets = [];
    let appendedBackdrop = null;
    const modalBodyEl = { innerHTML: '' };
    const origBodyAppend = sandbox.document.body.appendChild;
    sandbox.document.body.appendChild = (el) => {
      appendedBackdrop = el;
      el.querySelector = (s) => (s === '#agy-ctx-modal-body' ? modalBodyEl : null);
    };
    const origGetById = sandbox.document.getElementById;
    sandbox.document.getElementById = (id) => {
      if (id === 'agy-ctx-debug-modal') return appendedBackdrop;
      if (id === 'agy-ctx-modal-body') return modalBodyEl;
      return origGetById(id);
    };
    const ctxBtn = createContextButtonAdapter({
      window: sandbox.window,
      document: sandbox.document,
      fetchFn: null,
      setHtml: (el, h) => { el.innerHTML = h; },
      cwStore: store,
      hostBridge: {
        getCascadeContextForElement: () => null,
        getAgentStateProviderForInputBox: () => null,
        getModelSelectorContextForView: () => null,
        getRemoteRpcServiceForElement: () => ({
          isRemoteControlHost: true,
          async getCascadeTrajectoryGeneratorMetadata(req) {
            requestedModalOffsets.push(req.generatorMetadataOffset);
            return {
              generatorMetadata: [
                {
                  stepIndices: [2611],
                  chatModel: {
                    model: 'Gemini 4 Argon',
                    usage: { inputTokens: 1000, cacheReadTokens: 9000 },
                    chatStartMetadata: {
                      startStepIndex: 2611,
                      contextWindowMetadata: { estimatedTokensUsed: 85000, maxContextTokens: 512000 },
                    },
                  },
                },
              ],
            };
          },
        }),
      },
    });
    await ctxBtn.openOrToggleDebugModal(view, inputBox);
    assert.equal(requestedModalOffsets[0], 1053, 'must request tail offset (1073 - 20 = 1053), never offset 0');
    assert.ok(modalBodyEl.innerHTML.includes('2,612 steps'), 'modal must display cached remote step count (2,612 steps)');
    await ctxBtn.openOrToggleDebugModal(view, inputBox); // close modal
    sandbox.document.body.appendChild = origBodyAppend;
    sandbox.document.getElementById = origGetById;

    // 5. SB-BUG-05: Connect frame with flag > 1 (0x02 EndStream / 0x80 Trailer) must not be corrupted, and changing session limit replaces old 0x2a suffix instead of duplicating
    const trailerFrame = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x04, 0x74, 0x65, 0x73, 0x74]);
    const afterTrailer = hbLinux.injectCheckpointLimitIntoSendRequest(
      '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      trailerFrame,
      null
    );
    assert.equal(afterTrailer.length, trailerFrame.length, 'Connect frame with flag 0x02 must NEVER have raw 0x2a bytes appended');

    store.saveContextWindowSetting(cid, '512K');
    const rawMsg = new TextEncoder().encode(`\x0a\x24${cid}`);
    const first512 = hbLinux.injectCheckpointLimitIntoSendRequest(
      '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      rawMsg,
      null
    );
    store.saveContextWindowSetting(cid, '384K');
    const second384 = hbLinux.injectCheckpointLimitIntoSendRequest(
      '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      first512,
      null
    );
    assert.equal(second384.length, first512.length, 'changing session limit from 512K to 384K must replace trailing suffix without growing byte length');
  });

  it('optimizes rendering: filters out ko-thought-translator / chat streaming mutations and updates core-metrics in-place without recreating limit button', () => {
    const { isRelevantStatusBarMutation } = require('../src/index');
    const { createCoreMetricsAdapter } = require('../src/adapters/core-metrics');
    const { createContextWindowStore } = require('../src/context-window-policy');

    // 1. MutationObserver filter ignores ko-thought-translator, mcp-manager, statusbar, and plain chat text mutations
    const koNode = {
      nodeType: 1,
      tagName: 'SPAN',
      hasAttribute: (k) => k === 'data-ko-translated',
      getAttribute: () => null,
      querySelector: () => null,
    };
    const chatStreamParagraph = {
      nodeType: 1,
      tagName: 'P',
      hasAttribute: () => false,
      getAttribute: () => null,
      querySelector: () => null,
    };
    const statusbarChild = {
      nodeType: 1,
      tagName: 'SPAN',
      className: 'agy-ctx-statusbar',
      hasAttribute: (k) => k === 'data-agy-no-translate',
    };
    assert.equal(
      isRelevantStatusBarMutation([
        { type: 'childList', target: chatStreamParagraph, addedNodes: [koNode], removedNodes: [] },
        { type: 'childList', target: statusbarChild, addedNodes: [chatStreamParagraph], removedNodes: [] },
      ]),
      false,
      'streaming chat paragraphs and ko-thought-translator mutations must not trigger statusbar reflows'
    );

    const newConvoView = {
      nodeType: 1,
      tagName: 'DIV',
      hasAttribute: () => false,
      getAttribute: (k) => (k === 'data-testid' ? 'conversation-view' : null),
      querySelector: () => null,
    };
    assert.equal(
      isRelevantStatusBarMutation([
        { type: 'childList', target: { nodeType: 1, tagName: 'DIV' }, addedNodes: [newConvoView], removedNodes: [] },
      ]),
      true,
      'mounting a new conversation-view must be detected as relevant'
    );

    // 2. Surgical in-place DOM update in core-metrics preserves limitBtn reference and avoids innerHTML replacement
    const store = createContextWindowStore({});
    const subNodes = {
      '.agy-ctx-bar-fill': { style: { width: '10%', background: '#58d68d' } },
      '.agy-ctx-pct-val': { className: 'agy-ctx-pct-val agy-ctx-ok', textContent: '10%' },
      '.agy-ctx-used-val': { textContent: '51k' },
      '.agy-ctx-btn-limit': {
        className: 'agy-ctx-btn agy-ctx-btn-limit agy-ctx-btn-limit-512',
        textContent: '[ 512k ▾ ]',
        title: '',
        attrs: {},
        getAttribute(k) { return this.attrs[k] ?? null; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
      },
      '.agy-ctx-cache': { textContent: '80%' },
      '.agy-ctx-quota-slot': { innerHTML: '' },
    };
    let setHtmlCallsOnContainer = 0;
    const containerEl = {
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      querySelector(sel) { return subNodes[sel] || null; },
    };
    const adapter = createCoreMetricsAdapter({
      document: {},
      setHtml(el, h) {
        if (el === containerEl) setHtmlCallsOnContainer += 1;
        el.innerHTML = h;
      },
      cwStore: store,
      getConversationContextWindow: () => '512K',
      setConversationContextWindow: () => '512K',
      cycleConversationContextWindow: () => '900K',
      updateAll: () => {},
    });

    adapter.render(containerEl, {
      barEl: {},
      view: {},
      cascadeId: 'sess-1',
      currentCw: '512K',
      stats: { used: 360000, cachePct: 92 },
      quota: { pct5h: 70, pct7d: 85, rst5h: '→18:00' },
    });

    assert.equal(setHtmlCallsOnContainer, 0, 'in-place update must not replace containerEl.innerHTML when sub-elements exist');
    assert.equal(subNodes['.agy-ctx-bar-fill'].style.width, '70%');
    assert.equal(subNodes['.agy-ctx-pct-val'].textContent, '70%');
    assert.ok(subNodes['.agy-ctx-pct-val'].className.includes('agy-ctx-warn'));
    assert.equal(subNodes['.agy-ctx-used-val'].textContent, '360k');
    assert.equal(subNodes['.agy-ctx-cache'].textContent, '92%');
    assert.equal(containerEl.attrs['data-agy-no-translate'], 'true');

    // Verify getModelSelectorContextForView short-TTL cache avoids repeated Fiber walks
    let triggerQueryCount = 0;
    const fakeTrigger = {
      isConnected: true,
      __reactFiber$opt: {
        memoizedProps: {
          value: {
            selectedModel: { value: 'gemini-pro', contextWindowOptions: [] },
            setSelectedModel: () => {},
          },
        },
        return: null,
      },
    };
    const fakeView = {
      querySelector(sel) {
        if (sel === '[data-testid="model-selector-trigger"]') {
          triggerQueryCount += 1;
          return fakeTrigger;
        }
        return null;
      },
    };
    const { createHostBridge } = require('../src/host-bridge');
    const hb = createHostBridge({
      window: {},
      document: { querySelectorAll: () => [fakeView] },
      localStorage: store,
      fetchFn: async () => ({ ok: true }),
      cwStore: store,
    });
    const ctx1 = hb.getModelSelectorContextForView(fakeView, '512K');
    const qAfterFirst = triggerQueryCount;
    const ctx2 = hb.getModelSelectorContextForView(fakeView, '512K');
    assert.equal(ctx1, ctx2, 'getModelSelectorContextForView must reuse short-TTL cached context');
    assert.equal(triggerQueryCount, qAfterFirst, 'cached getModelSelectorContextForView must skip redundant DOM/Fiber queries');

    // 3. Session switch synchronous immediate render prevents 2-frame flicker while RPC is still in-flight
    const { sandbox, getMountedBar } = createDomSandbox();
    sandbox.localStorage.setItem(
      'agy-stats-cache-v1',
      JSON.stringify([
        ['test-session-1', { used: 64000, trajectoryMax: 512000, cacheRead: 60000, inputTok: 4000, cachePct: 94, ts: Date.now() }],
        ['test-session-2', { used: 192000, trajectoryMax: 512000, cacheRead: 180000, inputTok: 12000, cachePct: 94, ts: Date.now() }],
      ])
    );
    sandbox.localStorage.setItem(
      'agy-session-ctx-windows-v1',
      JSON.stringify({ 'test-session-1': '512K', 'test-session-2': '256K' })
    );
    // Make fetch hang indefinitely during synchronous check
    sandbox.fetch = () => new Promise(() => {});
    sandbox.window.fetch = sandbox.fetch;

    const api = mountStatusBar(sandbox);
    assert.ok(api);
    const barEl = getMountedBar();
    assert.ok(barEl, 'barEl must be mounted synchronously on initial mountStatusBar()');
    const coreNode = barEl.querySelector('.agy-ctx-left').querySelector('[data-agy-adapter-id="core-metrics"]');
    assert.ok(coreNode, 'core-metrics node must be rendered synchronously before any async RPC resolves');
    assert.ok(coreNode.innerHTML.includes('64k'), 'initial synchronous render must show cached 64k immediately');
    assert.ok(coreNode.innerHTML.includes('[ 512k ▾ ]'), 'initial synchronous render must show session-1 limit [ 512k ▾ ] immediately');

    // Switch session to test-session-2 and call updateAll() synchronously (RPC still pending)
    const activeView = sandbox.document.querySelector('[data-testid="conversation-view"]');
    activeView.getAttribute = (k) => (k === 'data-cascade-id' ? 'test-session-2' : null);
    api.updateAll();
    assert.ok(coreNode.innerHTML.includes('192k'), 'session switch must synchronously update to session-2 cached 192k without waiting for async RPC');
    assert.ok(coreNode.innerHTML.includes('[ 256k ▾ ]'), 'session switch must synchronously update to session-2 limit [ 256k ▾ ] without waiting for async RPC');

    // Verify mobile RemoteControlComponent.prototype.handleUrlChanged sniffs session UUID even when handleIframeMessage was bound at construction time
    let sniffedViaUrlChanged = null;
    const rcWin = {
      __agyOnCascadeSniffed(cid) {
        sniffedViaUrlChanged = cid;
      },
    };
    class BoundMobileRc {
      selectedInstanceUuid() {
        return '547d3ff8-7d19-415f-a68a-9bbf28c06f6f-v2';
      }
      proxyCommand() {}
      handleUrlChanged(p) {
        this.lastSyncedChildPath = p;
      }
    }
    const mobileRcInst = new BoundMobileRc();
    const hbMobile = createHostBridge({
      window: {
        ...rcWin,
        default_GoogleAntigravity: { m: { RemoteControlComponent: BoundMobileRc } },
      },
      document: { querySelector: () => null },
      localStorage: store,
      fetchFn: async () => ({ ok: true }),
      cwStore: store,
    });
    hbMobile.getRemoteControlInstance((cid) => {
      sniffedViaUrlChanged = cid;
    });
    mobileRcInst.handleUrlChanged('/c/1f3f7633-f0b7-4fc7-a958-9fb667c85623');
    assert.equal(
      sniffedViaUrlChanged,
      '1f3f7633-f0b7-4fc7-a958-9fb667c85623',
      'mobile handleUrlChanged must immediately notify onCascadeChange with the new session UUID'
    );

    // 4. ANTIGRAVITY_STATUSBAR-D-0013 regression (including SB-D0013-BUG-01~04):
    //    - applyContextWindowToEngine must NOT dispatch pick: { atStep: 999999 }
    //    - applying a context window to a Low (1419) session must preserve BOTH global default.model as Medium (1418) AND low-convo.model as Low (1419) (SB-D0013-BUG-01)
    //    - 0-step conversation where user picked High (1417) with pick: { atStep: 0, queuedMessageIds: [] } and syncedKey: undefined must preserve High (1417) (SB-D0013-BUG-02)
    //    - sessions previously poisoned with pick: { atStep: 999999 } (or v24's atStep: 0 with syncedKey present) must be unlocked with pick: { atStep: -1, queuedMessageIds: [] } so host UBa returns { apply: true, pick: undefined } (SB-D0013-BUG-03)
    //    - unhydrated store (preferredModel === undefined) must NOT permanently latch the one-shot sanitization flag (SB-D0013-BUG-04)
    const dispatchedActions = [];
    const fakeReduxState = {
      userStatus: undefined, // Initially unhydrated to test SB-D0013-BUG-04
      modelSelection: {
        byConversation: {
          'poisoned-convo': { model: 1419, customLabel: 'Gemini 4 Argon (Low)', contextWindow: '384K' },
          'v24-relocked-convo': { model: 1418, customLabel: undefined, contextWindow: '384K' },
          'low-convo': { model: 1419, customLabel: 'Gemini 4 Argon (Low)', contextWindow: '256K' },
          'zero-step-high-convo': { model: 1417, customLabel: 'Gemini 4 Argon (High)', contextWindow: '256K' },
        },
        default: { model: 1419, customLabel: undefined, contextWindow: '512K' },
        trajectorySync: {
          'poisoned-convo': {
            syncedKey: 'exec-1:10:Gemini 4 Argon (Medium):384K',
            pick: { atStep: 999999, queuedMessageIds: [] },
          },
          'v24-relocked-convo': {
            syncedKey: 'exec-v24:Gemini 4 Argon (Low):',
            pick: { atStep: 0, queuedMessageIds: [] },
          },
          'low-convo': {
            syncedKey: 'exec-2:5:Gemini 4 Argon (Low):256K',
          },
          'zero-step-high-convo': {
            syncedKey: undefined,
            pick: { atStep: 0, queuedMessageIds: [] },
          },
        },
      },
    };

    // Host UBa(pick, obs) exact implementation from main.js offset 2385104
    function hostUBa(a, b) {
      if (!a) return { apply: true, pick: undefined };
      const c = (f) => (b.turnKey === undefined ? f : { ...f, checkedTurnKey: b.turnKey });
      if (b.turnKey !== undefined && a.checkedTurnKey === b.turnKey) return { apply: false, pick: a };
      if (a.atStep === 0) return { apply: false, pick: c({ ...a, atStep: (b.executionStartStep ?? 0) + 1 }) };
      if (b.executionStartStep !== undefined && b.executionStartStep <= a.atStep) return { apply: false, pick: c(a) };
      const d = (a.queuedMessageIds || []).filter((f) => (b.queuedMessageIds || []).includes(f));
      return d.length < (a.queuedMessageIds || []).length
        ? { apply: false, pick: c({ ...a, queuedMessageIds: d }) }
        : { apply: true, pick: undefined };
    }

    const fakeReduxStore = {
      getState() {
        return fakeReduxState;
      },
      dispatch(action) {
        dispatchedActions.push(action);
        if (action.type === 'modelSelection/modelPicked') {
          const { pick, ...rest } = action.payload;
          const cid = rest.conversationId;
          if (cid) {
            fakeReduxState.modelSelection.byConversation[cid] = {
              model: rest.model,
              customLabel: rest.customLabel,
              contextWindow: rest.contextWindow,
            };
          }
          // Host YBa reducer unconditionally overwrites default on modelPicked!
          fakeReduxState.modelSelection.default = {
            model: rest.model,
            customLabel: rest.customLabel,
            contextWindow: rest.contextWindow,
          };
          if (pick) {
            const key = cid ?? '';
            fakeReduxState.modelSelection.trajectorySync[key] = {
              ...fakeReduxState.modelSelection.trajectorySync[key],
              pick: { atStep: pick.atStep, queuedMessageIds: [...(pick.queuedMessageIds || [])] },
            };
          }
        }
      },
    };

    const reduxTriggerEl = {
      isConnected: true,
      attrs: { 'data-context-window': '256K' },
      getAttribute(k) { return this.attrs[k] ?? null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      __reactFiber$redux: {
        memoizedProps: {
          value: {
            store: fakeReduxStore,
            selectedModel: { value: 1419, label: 'Gemini 4 Argon (Low)', isCustom: false, contextWindowOptions: [] },
            setSelectedModel() {},
          },
        },
        return: null,
      },
    };
    const reduxView = {
      querySelector(sel) {
        return sel === '[data-testid="model-selector-trigger"]' ? reduxTriggerEl : null;
      },
    };
    const hbRedux = createHostBridge({
      window: {},
      document: { querySelectorAll: () => [reduxView] },
      localStorage: store,
      fetchFn: async () => ({ ok: true }),
      cwStore: store,
    });

    // First call while userStatus is still unhydrated (SB-D0013-BUG-04):
    hbRedux.applyContextWindowToEngine(reduxView, 'low-convo', '320K');
    // Now hydrate userStatus.cascadeModelConfigData (with Protobuf-ES choice.value structure)
    fakeReduxState.userStatus = {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 4 Argon (High)', modelOrAlias: { choice: { case: 'model', value: 1417 } } },
          { label: 'Gemini 4 Argon (Medium)', modelOrAlias: { choice: { case: 'model', value: 1418 } } },
          { label: 'Gemini 4 Argon (Low)', modelOrAlias: { choice: { case: 'model', value: 1419 } } },
        ],
        defaultOverrideModelConfig: { modelOrAlias: { choice: { case: 'model', value: 1418 } } },
      },
    };

    const appliedOk = hbRedux.applyContextWindowToEngine(reduxView, 'low-convo', '384K');
    assert.equal(appliedOk, true);
    assert.equal(
      fakeReduxState.modelSelection.default.model,
      1418,
      'global default.model must be restored to Medium (1418) after hydration and applying context window to a Low (1419) conversation'
    );
    assert.equal(
      fakeReduxState.modelSelection.byConversation['low-convo'].model,
      1419,
      'SB-D0013-BUG-01: legitimate Low (1419) conversation must keep model 1419 and NOT be overwritten to 1418 (Medium)'
    );
    assert.equal(
      fakeReduxState.modelSelection.byConversation['low-convo'].contextWindow,
      '384K',
      'low-convo contextWindow must be updated to 384K'
    );
    assert.equal(
      fakeReduxState.modelSelection.byConversation['zero-step-high-convo'].model,
      1417,
      'SB-D0013-BUG-02: 0-step conversation with pick.atStep=0 and syncedKey=undefined must preserve user-selected High (1417)'
    );
    assert.equal(
      fakeReduxState.modelSelection.trajectorySync['zero-step-high-convo']?.pick?.atStep,
      0,
      'SB-D0013-BUG-02: 0-step conversation pick.atStep=0 must remain untouched'
    );
    assert.equal(
      fakeReduxState.modelSelection.byConversation['poisoned-convo'].model,
      1418,
      'poisoned conversation with atStep=999999 and syncedKey Medium must be recovered from Low (1419) to Medium (1418)'
    );
    assert.equal(
      fakeReduxState.modelSelection.trajectorySync['poisoned-convo']?.pick?.atStep,
      -1,
      'SB-D0013-BUG-03: poisoned pick.atStep must be set to -1 (not 0 or 999999)'
    );
    const ubaPoisoned = hostUBa(fakeReduxState.modelSelection.trajectorySync['poisoned-convo']?.pick, {
      turnKey: 'turn-1',
      executionStartStep: 12,
      queuedMessageIds: [],
    });
    assert.deepEqual(
      ubaPoisoned,
      { apply: true, pick: undefined },
      'SB-D0013-BUG-03: host UBa must return { apply: true, pick: undefined } for sanitized poisoned-convo'
    );
    const ubaV24Relocked = hostUBa(fakeReduxState.modelSelection.trajectorySync['v24-relocked-convo']?.pick, {
      turnKey: 'turn-2',
      executionStartStep: 4042,
      queuedMessageIds: [],
    });
    assert.deepEqual(
      ubaV24Relocked,
      { apply: true, pick: undefined },
      'SB-D0013-BUG-03: host UBa must return { apply: true, pick: undefined } for v24-relocked-convo'
    );
    assert.equal(
      dispatchedActions.some((a) => a.payload?.pick?.atStep === 999999 || a.payload?.pick?.atStep === 0),
      false,
      'applyContextWindowToEngine must never dispatch pick.atStep === 999999 or pick.atStep === 0'
    );

    sandbox.window.__agyStatusBarCleanup();
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

  it('ANTIGRAVITY_STATUSBAR-D-0014: preserves cookie-only session context window override against seedSessionIfEmpty and ts=1 remote annotations', () => {
    const { createContextWindowStore } = require('../src/context-window-policy');
    const mockDoc = {
      cookie: 'agy_cw_cookie-only-cid=384K; agy_default_cw=512K',
    };
    const emptyLs = {
      getItem: () => null,
      setItem: () => {},
    };
    const cwStore = createContextWindowStore({
      document: mockDoc,
      localStorage: emptyLs,
    });

    assert.equal(
      cwStore.hasSessionOverride('cookie-only-cid'),
      true,
      'hasSessionOverride must detect cookie-backed session override even when localStorage is empty'
    );
    cwStore.seedSessionIfEmpty('cookie-only-cid', '256K');
    assert.equal(
      cwStore.getSavedContextWindow('cookie-only-cid'),
      '384K',
      'seedSessionIfEmpty must not overwrite cookie-backed session override with Redux default 256K'
    );

    const mockDoc2 = {
      cookie: 'agy_cw_cookie-ts-cid=640K',
    };
    const cwStore2 = createContextWindowStore({
      document: mockDoc2,
      localStorage: emptyLs,
    });
    assert.equal(cwStore2.getSavedContextWindow('cookie-ts-cid'), '640K');
    assert.equal(
      cwStore2.encodeRemoteAnnotationProfile('cookie-ts-cid'),
      '640K|512K|1',
      'cookie-restored override must receive baseline timestamp 1'
    );
    cwStore2.syncFromRemoteAnnotations({
      'cookie-ts-cid': {
        annotations: {
          activeProfile: '256K|512K|1',
        },
      },
    });
    assert.equal(
      cwStore2.getSavedContextWindow('cookie-ts-cid'),
      '640K',
      'SB-D0014-RESIDUAL-01: syncFromRemoteAnnotations with legacy ts=1 remote profile must not overwrite cookie-restored localTs=1 override'
    );

    let savedCookieJar = '';
    const cookieWritingDoc = {
      get cookie() {
        return savedCookieJar;
      },
      set cookie(val) {
        const pair = String(val).split(';')[0];
        savedCookieJar = savedCookieJar ? `${savedCookieJar}; ${pair}` : pair;
      },
    };
    const cwStoreWriter = createContextWindowStore({
      document: cookieWritingDoc,
      localStorage: emptyLs,
    });
    cwStoreWriter.saveContextWindowSetting('saved-cookie-cid', '640K', {
      updatedAtMs: 1793850000000,
    });

    const cwStoreReader = createContextWindowStore({
      document: cookieWritingDoc,
      localStorage: emptyLs,
    });
    assert.equal(cwStoreReader.getSavedContextWindow('saved-cookie-cid'), '640K');
    assert.equal(
      cwStoreReader.encodeRemoteAnnotationProfile('saved-cookie-cid'),
      '640K|512K|1793850000000',
      'SB-D0014-RESIDUAL-01: cookie must persist and restore the session override timestamp'
    );
    cwStoreReader.syncFromRemoteAnnotations({
      'saved-cookie-cid': {
        annotations: {
          activeProfile: '256K|512K|1793840000000',
        },
      },
    });
    assert.equal(
      cwStoreReader.getSavedContextWindow('saved-cookie-cid'),
      '640K',
      'SB-D0014-RESIDUAL-01: older remote annotation (ts=1793840000000) must not overwrite cookie-restored override (ts=1793850000000)'
    );

    // SB-D0014-SYNC-BEFORE-READ-OVERWRITE: calling syncFromRemoteAnnotations BEFORE getSavedContextWindow(cid)
    // on an unopened sidebar session whose override exists only in document.cookie must load the cookie first
    // and NOT overwrite 640K (ts=1793850000000) with an older remote annotation 256K (ts=1793840000000)
    const unopenedCookieDoc = {
      cookie: 'agy_cw_unopened-cookie-cid=640K%7C1793850000000; agy_default_cw=512K',
    };
    const cwStoreUnopened = createContextWindowStore({
      document: unopenedCookieDoc,
      localStorage: emptyLs,
    });
    const syncRes = cwStoreUnopened.syncFromRemoteAnnotations({
      'unopened-cookie-cid': {
        annotations: {
          activeProfile: '256K|512K|1793840000000',
        },
      },
    });
    assert.equal(
      cwStoreUnopened.getSavedContextWindow('unopened-cookie-cid'),
      '640K',
      'SB-D0014-SYNC-BEFORE-READ-OVERWRITE: syncFromRemoteAnnotations called before getSavedContextWindow must load cookie override first and preserve 640K against older remote profile 256K'
    );
    assert.ok(
      syncRes.unsyncedLocalIds.includes('unopened-cookie-cid'),
      'SB-D0014-SYNC-BEFORE-READ-OVERWRITE: unopened cookie override differing from older remote profile must be queued in unsyncedLocalIds'
    );
  });
});

describe('D-0015..D-0021 full audit regressions', () => {
  it('D-0015: install.js and host-bridge extractCompanionBlocks ignore indented marker literals and preserve block-comment/double-wrapped companion blocks', async () => {
    const { createHostBridge } = require('../src/host-bridge.js');
    const installCode = fs.readFileSync(SRC_INSTALL_PATH, 'utf8').replace(/^#!.*\n/, '');
    const existingBundle = [
      '/* statusbar old */',
      'function mountStatusBar() {}',
      '',
      '// === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
      '/* === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 === */',
      '(() => {',
      '  const markerLiterals = [',
      "    '// === BEGIN_AGY_MCP_MANAGER_V1 ===',",
      "    '// === END_AGY_MCP_MANAGER_V1 ===',",
      "    '// === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 ===',",
      '  ];',
      '  // === BEGIN_AGY_MCP_MANAGER_V1 ===',
      '  // === END_AGY_MCP_MANAGER_V1 ===',
      '  globalThis.__koMarkerCount = markerLiterals.length;',
      '})();',
      '/* === END_AGY_KO_THOUGHT_LOCALIZER_V2 === */',
      '// === END_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
      '',
    ].join('\n');

    const virtualFiles = new Map();
    const fakeHome = '/virtual-home';
    const targetAuto = path.join(fakeHome, '.gemini', 'antigravity', 'statusbar_autoinject.js');
    virtualFiles.set(targetAuto, existingBundle);
    virtualFiles.set('/virtual-out/statusbar_autoinject.js', '(() => { function mountStatusBar() {} globalThis.__sbOk = true; })();\n');

    const customRequire = (spec) => {
      if (spec === 'fs') {
        return {
          mkdirSync() {},
          existsSync: (p) => virtualFiles.has(p) || p === SRC_PATCHER_PATH,
          readFileSync: (p) => virtualFiles.get(p) || '',
          writeFileSync: (p, data) => virtualFiles.set(p, String(data)),
          copyFileSync() {},
        };
      }
      if (spec === 'os') return { homedir: () => fakeHome };
      if (spec === 'path') return path;
      if (spec === 'child_process') {
        return { spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) };
      }
      if (spec === './build') {
        return { buildBundle: () => ({ outFile: '/virtual-out/statusbar_autoinject.js' }) };
      }
      return require(spec);
    };

    const mod = { exports: {} };
    const sbInstallCtx = vm.createContext({
      require: customRequire,
      module: mod,
      exports: mod.exports,
      __dirname: path.dirname(SRC_INSTALL_PATH),
      __filename: SRC_INSTALL_PATH,
      process: {
        env: { USERPROFILE: fakeHome, HOME: fakeHome },
        execPath: process.execPath,
        stdout: { write() {} },
        stderr: { write() {} },
        exit() {},
      },
      Buffer,
      console,
    });
    new vm.Script(installCode, { filename: 'install.js' }).runInContext(sbInstallCtx);
    mod.exports.install();

    const merged = virtualFiles.get(targetAuto);
    assert.ok(merged, 'D-0015: install() must write merged statusbar_autoinject.js');
    assert.doesNotThrow(
      () => new vm.Script(merged, { filename: 'merged_statusbar_autoinject.js' }),
      'D-0015: install() must not slice indented string literals into a broken MCP block causing SyntaxError'
    );
    const evalCtx = vm.createContext({ globalThis: {} });
    evalCtx.globalThis = evalCtx;
    new vm.Script(merged).runInContext(evalCtx);
    assert.equal(evalCtx.__sbOk, true);
    assert.equal(evalCtx.__koMarkerCount, 3, 'D-0015: ko-thought-translator block must execute intact');
    assert.equal(
      /^\/\/ === BEGIN_AGY_MCP_MANAGER_V1 ===$/m.test(merged),
      false,
      'D-0015: install() must not synthesize a top-level MCP block when none was installed'
    );

    // Also verify block-comment-only companion markers (`/* === BEGIN_... === */`) are preserved by install()
    const blockCommentExisting = [
      'function mountStatusBar() {}',
      '/* === BEGIN_AGY_MCP_MANAGER === */',
      'globalThis.__mcpBlockCommentOk = 1;',
      '/* === END_AGY_MCP_MANAGER === */',
      '/* === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 === */',
      'globalThis.__koBlockCommentOk = 2;',
      '/* === END_AGY_KO_THOUGHT_LOCALIZER_V2 === */',
    ].join('\n');
    virtualFiles.set(targetAuto, blockCommentExisting);
    mod.exports.install();
    const mergedBlockComment = virtualFiles.get(targetAuto);
    const evalCtx2 = vm.createContext({});
    evalCtx2.globalThis = evalCtx2;
    new vm.Script(mergedBlockComment).runInContext(evalCtx2);
    assert.equal(evalCtx2.__mcpBlockCommentOk, 1, 'D-0015: block-comment MCP block must be preserved');
    assert.equal(evalCtx2.__koBlockCommentOk, 2, 'D-0015: block-comment KO block must be preserved');

    // Verify hostBridge.fetchHostInstalledPluginInfo ignores indented markers and captures trailing outer end marker
    const encodedBytes = new TextEncoder().encode(existingBundle);
    const fakeRc = {
      destroyed: false,
      localUserInfo: { selectedGeminiDir: '/virtual-home/.gemini' },
      async proxyCommand(method) {
        if (String(method).includes('GetCustomizationStates')) {
          return { payload: new TextEncoder().encode(JSON.stringify({ states: [] })) };
        }
        if (String(method).includes('ReadFile')) {
          return { payload: new TextEncoder().encode(JSON.stringify({ contents: Buffer.from(encodedBytes).toString('base64') })) };
        }
        return { payload: new Uint8Array(0) };
      },
    };
    const fakeWin = {
      __agyRemoteControlInstance: fakeRc,
      fetch: async () => ({ ok: true }),
      document: { querySelector: () => null, querySelectorAll: () => [] },
    };
    const cwStore = createContextWindowStore({ document: { cookie: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
    const bridge = createHostBridge({
      window: fakeWin,
      document: fakeWin.document,
      cwStore,
      rpcClient: { extractStatsFromMetas: () => null },
    });
    const hostInfo = await bridge.fetchHostInstalledPluginInfo({});
    assert.equal(hostInfo.hasStatusbar, true);
    assert.equal(hostInfo.hasKoTranslator, true);
    assert.equal(hostInfo.hasMcpManager, false, 'D-0015: indented MCP marker comments/literals inside KO block must not set hasMcpManager=true');
    assert.ok(
      hostInfo.koTranslatorCode.endsWith('// === END_AGY_KO_THOUGHT_LOCALIZER_V2 ==='),
      'D-0015: double-wrapped KO block must include the final outer end marker line'
    );

    // Also verify future/versionless (?:_V\d+)? markers in hostBridge.fetchHostInstalledPluginInfo
    const v3Bundle = [
      'function mountStatusBar() {}',
      '// === BEGIN_AGY_MCP_MANAGER_V2 ===',
      'window.agyMcpManager = {};',
      '// === END_AGY_MCP_MANAGER_V2 ===',
      '// === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V3 ===',
      'window.__agyKoThoughtCleanup = () => {};',
      '// === END_AGY_KO_THOUGHT_LOCALIZER_V3 ===',
    ].join('\n');
    const v3Bytes = new TextEncoder().encode(v3Bundle);
    fakeRc.proxyCommand = async (method) => {
      if (String(method).includes('GetCustomizationStates')) {
        return { payload: new TextEncoder().encode(JSON.stringify({ states: [] })) };
      }
      if (String(method).includes('ReadFile')) {
        return { payload: new TextEncoder().encode(JSON.stringify({ contents: Buffer.from(v3Bytes).toString('base64') })) };
      }
      return { payload: new Uint8Array(0) };
    };
    const hostInfoV3 = await bridge.fetchHostInstalledPluginInfo({});
    assert.equal(hostInfoV3.hasMcpManager, true, 'D-0015: host-bridge must support MCP_MANAGER_V2+ via (?:_V\\d+)?');
    assert.equal(hostInfoV3.hasKoTranslator, true, 'D-0015: host-bridge must support KO_THOUGHT_LOCALIZER_V3+ via (?:_V\\d+)?');
  });

  it('D-0016: ensure_statusbar_patch rejects on exceptionDetails, avoids expectsKo/expectsMcp false positives, and falls back to Electron 35+ Browser CDP WS', async () => {
    const http = require('node:http');
    const crypto = require('node:crypto');
    const patcherSrc = fs.readFileSync(SRC_PATCHER_PATH, 'utf8').replace(/^#!.*\n/, '');
    let nextWsBehavior = null;
    let lastSentPayload = null;
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        setImmediate(() => {
          if (typeof this.onopen === 'function') this.onopen();
        });
      }
      send(raw) {
        lastSentPayload = JSON.parse(raw);
        if (nextWsBehavior) nextWsBehavior(this, lastSentPayload);
      }
      close() {}
    }
    const ctx = vm.createContext({
      require,
      module: { exports: {} },
      exports: {},
      __dirname: path.dirname(SRC_PATCHER_PATH),
      __filename: SRC_PATCHER_PATH,
      process: { ...process, argv: [process.execPath, SRC_PATCHER_PATH], exit() {} },
      WebSocket: FakeWebSocket,
      Buffer,
      setTimeout,
      clearTimeout,
      console,
    });
    new vm.Script(
      patcherSrc + '\n;globalThis.__testConfigureCdp = configureTargetViaCdp;',
      { filename: 'ensure_statusbar_patch.js' }
    ).runInContext(ctx);

    nextWsBehavior = (ws) => {
      setImmediate(() => {
        ws.onmessage({
          data: JSON.stringify({
            id: 1,
            result: {
              result: { type: 'object', subtype: 'error', description: 'SyntaxError: Unexpected token' },
              exceptionDetails: { text: 'Uncaught SyntaxError: Unexpected token' },
            },
          }),
        });
      });
    };
    await assert.rejects(
      () => ctx.__testConfigureCdp('ws://127.0.0.1:9222/devtools/page/1', 'window.__x = 1;', 'hash-1', 1000),
      /SyntaxError/,
      'D-0016: configureTargetViaCdp must reject when Runtime.evaluate returns exceptionDetails'
    );

    const multiPluginScript = [
      'function mountStatusBar() { window.agyStatusBar = {}; window.__agyStatusBarCleanup = () => {}; }',
      'function mountMcpManager() { window.agyMcpManager = { destroy() {} }; }',
      'window.__injectedRuns = (window.__injectedRuns || 0) + 1;',
      'mountStatusBar(); mountMcpManager();',
    ].join('\n');
    nextWsBehavior = (ws) => {
      setImmediate(() => {
        ws.onmessage({ data: JSON.stringify({ id: 1, result: { result: { value: 'INJECTED_OK' } } }) });
      });
    };
    await ctx.__testConfigureCdp('ws://127.0.0.1:9222/devtools/page/1', multiPluginScript, 'hash-multi', 1000);
    const expr = lastSentPayload.params.expression;

    // Case A: Statusbar is active on welcome screen (no .agy-ctx-statusbar DOM node), AND MCP manager is active -> ALREADY_ACTIVE
    const welcomeWin = {
      agyStatusBar: {},
      __agyStatusBarCleanup: () => {},
      agyMcpManager: { destroy() {} },
      __agyStatusBarHash: 'hash-multi',
      document: { querySelector: () => null },
    };
    welcomeWin.window = welcomeWin;
    const resWelcome = vm.runInNewContext(expr, welcomeWin);
    assert.equal(
      resWelcome,
      'ALREADY_ACTIVE',
      'D-0016: mounted statusbar on welcome screen without .agy-ctx-statusbar DOM must still be recognized as ALREADY_ACTIVE'
    );

    // Case B: Statusbar is active, but bundled MCP manager is missing -> must re-inject instead of short-circuiting via OR
    const partialWin = {
      agyStatusBar: {},
      __agyStatusBarCleanup: () => {},
      __agyStatusBarHash: 'hash-multi',
      document: { querySelector: () => ({}) },
    };
    partialWin.window = partialWin;
    const resPartial = vm.runInNewContext(expr, partialWin);
    assert.equal(
      resPartial,
      'INJECTED_OK',
      'D-0016: when one bundled companion plugin is inactive, CDP guard must re-inject instead of returning ALREADY_ACTIVE'
    );
    assert.equal(partialWin.__injectedRuns, 1);

    // Case C: Real standalone dist/statusbar_autoinject.js contains win.__agyKoThoughtCleanup reference;
    // in a 1-plugin solo installation (no KO installed), guard MUST return ALREADY_ACTIVE (must NOT set expectsKo=true)!
    const { bundle: soloSbBundle } = buildBundle({ write: false });
    await ctx.__testConfigureCdp('ws://127.0.0.1:9222/devtools/page/1', soloSbBundle, 'hash-solo-sb', 1000);
    const soloGuardOnly = lastSentPayload.params.expression.replace(soloSbBundle, 'window.__soloReinjected = true;');
    const soloActiveWin = {
      agyStatusBar: {},
      __agyStatusBarCleanup: () => {},
      __agyStatusBarHash: 'hash-solo-sb',
      document: { querySelector: () => null },
    };
    soloActiveWin.window = soloActiveWin;
    assert.equal(
      vm.runInNewContext(soloGuardOnly, soloActiveWin),
      'ALREADY_ACTIVE',
      'D-0016: standalone statusbar bundle must NOT falsely set expectsKo=true from win.__agyKoThoughtCleanup reference'
    );

    // Case D: 2-plugin (SB + KO) bundle where KO contains indented BEGIN_AGY_MCP_MANAGER_V1 string literal -> must NOT set expectsMcp=true
    const sbPlusKoBundle = [
      soloSbBundle,
      '// === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
      "  const m = '// === BEGIN_AGY_MCP_MANAGER_V1 ===';",
      '  window.__agyKoThoughtCleanup = () => {};',
      '// === END_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
    ].join('\n');
    await ctx.__testConfigureCdp('ws://127.0.0.1:9222/devtools/page/1', sbPlusKoBundle, 'hash-sb-ko', 1000);
    const sbKoGuardOnly = lastSentPayload.params.expression.replace(sbPlusKoBundle, 'window.__sbKoReinjected = true;');
    const sbKoActiveWin = {
      agyStatusBar: {},
      __agyStatusBarCleanup: () => {},
      __agyKoThoughtCleanup: () => {},
      __agyStatusBarHash: 'hash-sb-ko',
      document: { querySelector: () => null },
    };
    sbKoActiveWin.window = sbKoActiveWin;
    assert.equal(
      vm.runInNewContext(sbKoGuardOnly, sbKoActiveWin),
      'ALREADY_ACTIVE',
      'D-0016: SB+KO bundle with indented MCP marker literal must NOT falsely set expectsMcp=true'
    );

    // Case E: Electron 35+ (Antigravity v2.31.0) where /json/list returns [] -> must fall back to DevToolsActivePort line 2 Browser CDP WS
    const cdpMethodsSeen = [];
    const sendWsFrame = (socket, obj) => {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      let hdr;
      if (payload.length < 126) {
        hdr = Buffer.from([0x81, payload.length]);
      } else {
        hdr = Buffer.alloc(4);
        hdr[0] = 0x81;
        hdr[1] = 126;
        hdr.writeUInt16BE(payload.length, 2);
      }
      socket.write(Buffer.concat([hdr, payload]));
    };
    const server = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on('upgrade', (req, socket) => {
      if (req.url !== '/devtools/browser/test-browser-id') {
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      let recvBuf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        recvBuf = Buffer.concat([recvBuf, chunk]);
        while (recvBuf.length >= 2) {
          const opcode = recvBuf[0] & 0x0f;
          if (opcode === 0x08) {
            socket.end();
            return;
          }
          const masked = (recvBuf[1] & 0x80) !== 0;
          let len = recvBuf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (recvBuf.length < 4) return;
            len = recvBuf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (recvBuf.length < 10) return;
            len = Number(recvBuf.readBigUInt64BE(2));
            offset = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (recvBuf.length < offset + maskLen + len) return;
          const body = Buffer.from(recvBuf.subarray(offset + maskLen, offset + maskLen + len));
          if (masked) {
            const mask = recvBuf.subarray(offset, offset + 4);
            for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
          }
          recvBuf = recvBuf.subarray(offset + maskLen + len);
          const msg = JSON.parse(body.toString('utf8'));
          cdpMethodsSeen.push(msg.method);
          if (msg.method === 'Target.getTargets') {
            sendWsFrame(socket, {
              id: msg.id,
              result: {
                targetInfos: [
                  { targetId: 'page-1', type: 'page', url: 'https://127.0.0.1:51234/workbench.html' },
                  { targetId: 'dev-1', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
                ],
              },
            });
          } else if (msg.method === 'Target.attachToTarget') {
            sendWsFrame(socket, { id: msg.id, result: { sessionId: 'flat-sess-1' } });
          } else if (msg.method === 'Runtime.evaluate' && msg.sessionId === 'flat-sess-1') {
            sendWsFrame(socket, {
              id: msg.id,
              sessionId: 'flat-sess-1',
              result: { result: { type: 'string', value: 'INJECTED_OK' } },
            });
          } else if (msg.method === 'Target.detachFromTarget') {
            sendWsFrame(socket, { id: msg.id, result: {} });
          }
        }
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const fakeHome = '/virtual-cdp-home';
      const fakeAppData = '/virtual-cdp-appdata';
      const autoPath = path.join(fakeHome, '.gemini', 'antigravity', 'statusbar_autoinject.js');
      const portFilePath = path.join(fakeAppData, 'Antigravity', 'DevToolsActivePort');
      const customReq = (spec) => {
        if (spec === 'fs') {
          return {
            existsSync: (p) => p === autoPath || p === portFilePath,
            readFileSync: (p) => {
              if (p === autoPath) return 'function mountStatusBar() {}\nwindow.__ok = 1;\n';
              if (p === portFilePath) return `${port}\n/devtools/browser/test-browser-id\n`;
              return '';
            },
          };
        }
        return require(spec);
      };
      const liveCtx = vm.createContext({
        require: customReq,
        module: { exports: {} },
        exports: {},
        __dirname: path.dirname(SRC_PATCHER_PATH),
        __filename: SRC_PATCHER_PATH,
        process: {
          ...process,
          env: { USERPROFILE: fakeHome, HOME: fakeHome, APPDATA: fakeAppData },
          argv: [process.execPath, SRC_PATCHER_PATH],
          exit() {},
        },
        WebSocket: undefined,
        URL,
        Buffer,
        setTimeout,
        clearTimeout,
        console,
      });
      new vm.Script(
        patcherSrc + '\n;globalThis.__testInjectLive = injectViaCdpLive;',
        { filename: 'ensure_statusbar_patch.js' }
      ).runInContext(liveCtx);

      const liveRes = await liveCtx.__testInjectLive();
      assert.equal(liveRes.pageTargetCount, 1, 'D-0016: Browser CDP WS fallback must discover 1 injectable page target when /json/list is []');
      assert.equal(liveRes.injectedCount, 1, 'D-0016: Browser CDP WS fallback must inject via Target.attachToTarget + Runtime.evaluate');
      assert.ok(cdpMethodsSeen.includes('Target.getTargets'));
      assert.ok(cdpMethodsSeen.includes('Target.attachToTarget'));
      assert.ok(cdpMethodsSeen.includes('Target.detachFromTarget'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('D-0017: scripts/build.js preserves multiline template literals across regex literals (/\\/*/, /`/, /^file:\\/\\//i, /"/g, [/])', () => {
    const buildSrc = fs.readFileSync(SRC_BUILD_PATH, 'utf8').replace(/^#!.*\n/, '');
    const sampleTemplate = [
      'const tpl = `first line',
      '',
      '// comment-like line inside template literal',
      'no-indent line`;',
      'const rBlockLookalike = /\\/*/;',
      'const tplAfterBlockRegex = `a1',
      '',
      '// keep-after-block-regex',
      'b1`;',
      'const rBacktick = /`/;',
      'const tplAfterBacktickRegex = `a2',
      '',
      '// keep-after-backtick-regex',
      'b2`;',
      "const rFileScheme = 'file:///tmp'.replace(/^file:\\/\\//i, `a3",
      '',
      '// keep-after-file-regex',
      'b3`);',
      'const rQuote = \'"\'.replace(/"/g, `a4',
      '',
      '// keep-after-quote-regex',
      'b4`);',
      "const rCharClass = '/web/2.31/x'.match(/\\/web\\/([^/]+)/)[1] + `a5",
      '',
      '// keep-after-charclass-regex',
      'b5`;',
      '// real comment to strip',
      'module.exports = { tpl, rBlockLookalike: Boolean(rBlockLookalike), tplAfterBlockRegex, tplAfterBacktickRegex, rFileScheme, rQuote, rCharClass };',
    ].join('\n');

    const customRequire = (spec) => {
      if (spec === 'fs') {
        return {
          readFileSync: (p) => {
            if (String(p).endsWith('package.json')) return JSON.stringify({ version: '1.3.23' });
            if (String(p).endsWith('index.js')) return "module.exports = require('./dom-styles');\n";
            if (String(p).endsWith('dom-styles.js')) return sampleTemplate;
            return 'module.exports = {};\n';
          },
          mkdirSync() {},
          writeFileSync() {},
        };
      }
      return require(spec);
    };
    const mod = { exports: {} };
    const ctx = vm.createContext({
      require: customRequire,
      module: mod,
      exports: mod.exports,
      __dirname: path.dirname(SRC_BUILD_PATH),
      __filename: SRC_BUILD_PATH,
      process,
      Buffer,
      console,
    });
    new vm.Script(buildSrc, { filename: 'build.js' }).runInContext(ctx);
    const { bundle } = mod.exports.buildBundle({ write: false });
    const evalBox = vm.createContext({});
    const runnable = bundle.replace("__require('.', './index');", "globalThis.__out = __require('.', './index');");
    evalBox.globalThis = evalBox;
    new vm.Script(runnable).runInContext(evalBox);
    assert.equal(
      evalBox.__out.tpl,
      'first line\n\n// comment-like line inside template literal\nno-indent line',
      'D-0017: bundler must preserve blank lines, // prefixes, and indentation inside multiline template literals'
    );
    assert.equal(evalBox.__out.tplAfterBlockRegex, 'a1\n\n// keep-after-block-regex\nb1', 'D-0017: /\\/*/ regex must not trigger block comment state');
    assert.equal(evalBox.__out.tplAfterBacktickRegex, 'a2\n\n// keep-after-backtick-regex\nb2', 'D-0017: /`/ regex must not corrupt template stack');
    assert.equal(evalBox.__out.rFileScheme, 'a3\n\n// keep-after-file-regex\nb3/tmp', 'D-0017: /^file:\\/\\//i regex must not prematurely break line scan');
    assert.equal(evalBox.__out.rQuote, 'a4\n\n// keep-after-quote-regex\nb4', 'D-0017: /"/g regex must not corrupt double-quote state');
    assert.equal(evalBox.__out.rCharClass, '2.31a5\n\n// keep-after-charclass-regex\nb5', 'D-0017: [/] inside regex character class must not terminate regex early');
  });

  it('D-0018: context-window-policy syncs cookie-only session overrides even when remote activeProfile is absent and enforces 200-entry cap', () => {
    const lsMap = new Map();
    const fakeLs = {
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: (k) => lsMap.delete(k),
    };
    const cookieOnlyStore = createContextWindowStore({
      document: { cookie: 'agy_cw_cookie-push-cid=900K%7C1793900000000; agy_cw_cookie-no-remote-profile=750K; agy_default_cw=512K' },
      localStorage: fakeLs,
    });
    // Before calling getSavedContextWindow or encodeRemoteAnnotationProfile, syncFromRemoteAnnotations runs
    // with a trajectory summary that has NO annotations.activeProfile yet (`parsed === null`):
    const syncNoProfile = cookieOnlyStore.syncFromRemoteAnnotations({
      'cookie-no-remote-profile': { stepCount: 5, annotations: {} },
    });
    assert.ok(
      syncNoProfile.unsyncedLocalIds.includes('cookie-no-remote-profile'),
      'D-0018: cookie-only override must be hydrated before !parsed continue so unsyncedLocalIds queues pushSessionCwToServer'
    );

    const encoded = cookieOnlyStore.encodeRemoteAnnotationProfile('cookie-push-cid');
    assert.ok(
      typeof encoded === 'string' && encoded.includes('900K'),
      'D-0018: encodeRemoteAnnotationProfile must restore cookie-only session override instead of returning null'
    );

    const bulkObj = {};
    for (let i = 0; i < 210; i++) {
      bulkObj[`cid-${String(i).padStart(3, '0')}`] = '512K';
    }
    lsMap.set('agy-session-ctx-windows-v1', JSON.stringify(bulkObj));
    const cappedStore = createContextWindowStore({
      document: { cookie: '' },
      localStorage: fakeLs,
    });
    cappedStore.saveContextWindowSetting('cid-new', '900K');
    const persisted = JSON.parse(lsMap.get('agy-session-ctx-windows-v1'));
    assert.ok(
      Object.keys(persisted).length <= 200,
      `D-0018: serialized session map must enforce <= 200 entries cap, got ${Object.keys(persisted).length}`
    );
  });

  it('D-0019: stripTrailingCheckpointSuffix preserves user protobuf payloads whose trailing bytes falsely resemble 1-byte suffix offsets and replaces multi-byte varint suffixes', () => {
    const { createHostBridge } = require('../src/host-bridge.js');
    const cwStore = createContextWindowStore({
      document: { cookie: '' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    });
    const bridge = createHostBridge({
      window: { fetch: async () => ({ ok: true }) },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      cwStore,
      rpcClient: { extractStatsFromMetas: () => null },
    });
    const sendRpcPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';

    // Payload starts with valid protobuf field 1 string (`0x0a, 0x02, 0x68, 0x69`) followed by 7 bytes
    // `[0x2a, 0x05, 0x12, 0x03, 0x28, 0x01, 0x10]` where `0x28, 0x01` ends 1 byte early (`0x10` extra field),
    // so it is NOT a valid single-varint maxTokenLimit suffix!
    cwStore.saveContextWindowSetting(null, '512K');
    const falseLookalike = new Uint8Array([0x0a, 0x02, 0x68, 0x69, 0x2a, 0x05, 0x12, 0x03, 0x28, 0x01, 0x10]);
    const expectedSuffix = bridge.buildSendMessageCheckpointSuffix(512000, '512K');
    const out = bridge.injectCheckpointLimitIntoSendRequest(sendRpcPath, falseLookalike, null);
    assert.equal(
      out.length,
      falseLookalike.length + expectedSuffix.length,
      'D-0019: false-lookalike trailing bytes must NOT be stripped from user protobuf payload'
    );
    assert.deepEqual(Array.from(out.subarray(0, falseLookalike.length)), Array.from(falseLookalike));

    // Conversely, a genuine prior checkpoint suffix (e.g. 256K -> replaced by 900K) MUST be cleanly replaced once
    const baseMsg = new Uint8Array([0x0a, 0x02, 0x68, 0x69]);
    cwStore.saveContextWindowSetting(null, '256K');
    const with256k = bridge.injectCheckpointLimitIntoSendRequest(sendRpcPath, baseMsg, null);
    cwStore.saveContextWindowSetting(null, '900K');
    const with900k = bridge.injectCheckpointLimitIntoSendRequest(sendRpcPath, with256k, null);
    const suffix900k = bridge.buildSendMessageCheckpointSuffix(900000, '900K');
    assert.equal(with900k.length, baseMsg.length + suffix900k.length);
    assert.deepEqual(Array.from(with900k.subarray(baseMsg.length)), Array.from(suffix900k));
  });

  it('D-0020: STATUSBAR_VERSION upgrades from v28 via cleanup and __agyStatusBarCleanup unmounts adapters, removes style tag, and clears globals', () => {
    assert.notEqual(STATUSBAR_VERSION, 'v28', 'D-0020: STATUSBAR_VERSION must be bumped past v28 so v1.3.22 windows run cleanup on upgrade');
    const styleEl = { id: 'agy-ctx-statusbar-style', removed: false, remove() { this.removed = true; } };
    const headChildren = [];
    const fakeDoc = {
      cookie: '',
      head: {
        appendChild(el) {
          el.remove = () => {
            el.removed = true;
            const i = headChildren.indexOf(el);
            if (i !== -1) headChildren.splice(i, 1);
          };
          headChildren.push(el);
          return el;
        },
      },
      body: {},
      documentElement: {},
      createElement(tag) {
        return {
          tagName: String(tag).toUpperCase(),
          id: '',
          className: '',
          textContent: '',
          style: {},
          children: [],
          attrs: {},
          setAttribute(k, v) { this.attrs[k] = String(v); },
          getAttribute(k) { return this.attrs[k] ?? null; },
          appendChild(c) { this.children.push(c); return c; },
          querySelector: () => null,
          querySelectorAll: () => [],
          remove() { this.removed = true; },
        };
      },
      getElementById(id) {
        return headChildren.find((c) => c.id === id) || (id === styleEl.id && !styleEl.removed ? styleEl : null) || null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    let v28CleanedUp = 0;
    const fakeWin = {
      __agyStatusBarActiveVersion: 'v28',
      agyStatusBar: { version: 'v28', legacy: true },
      __agyStatusBarCleanup() {
        v28CleanedUp += 1;
      },
      document: fakeDoc,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setInterval: () => 1,
      clearInterval() {},
      MutationObserver: class { observe() {} disconnect() {} },
    };

    const api = mountStatusBar({ window: fakeWin, document: fakeDoc });
    assert.equal(v28CleanedUp, 1, 'D-0020: mounting over an active v28 instance must invoke prior __agyStatusBarCleanup()');
    assert.equal(api.version, STATUSBAR_VERSION);
    let customUnmounted = 0;
    api.registerAdapter({
      id: 'cleanup-probe-adapter',
      slot: 'right',
      render() {},
      unmount() { customUnmounted += 1; },
    });
    assert.ok(fakeDoc.getElementById('agy-ctx-statusbar-style'), 'style element should exist after mount');
    assert.ok(fakeWin.agyStatusBar, 'window.agyStatusBar should exist after mount');

    fakeWin.__agyStatusBarCleanup();
    assert.equal(customUnmounted, 1, 'D-0020: __agyStatusBarCleanup must call adapter.unmount()');
    assert.equal(fakeDoc.getElementById('agy-ctx-statusbar-style'), null, 'D-0020: __agyStatusBarCleanup must remove injected style tag');
    assert.equal(fakeWin.agyStatusBar, undefined, 'D-0020: __agyStatusBarCleanup must clear window.agyStatusBar');
  });

  it('D-0021: README.md and README.ko.md match package version, STATUSBAR_VERSION, test count (24/24), and runtime API paths', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const readmeEn = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const readmeKo = fs.readFileSync(path.join(__dirname, '..', 'README.ko.md'), 'utf8');

    const expectedHeader = `# antigravity-statusbar (\`v${pkg.version}\` / \`${STATUSBAR_VERSION}\`)`;
    assert.ok(readmeEn.startsWith(expectedHeader), `D-0021: README.md title must start with ${expectedHeader}`);
    assert.ok(readmeKo.startsWith(expectedHeader), `D-0021: README.ko.md title must start with ${expectedHeader}`);
    assert.equal(readmeEn.includes('17/17'), false, 'D-0021: stale 17/17 test count must be updated in README.md');
    assert.equal(readmeKo.includes('17/17'), false, 'D-0021: stale 17/17 test count must be updated in README.ko.md');
    assert.ok(readmeEn.includes('32/32'), 'D-0021: README.md must state 32/32 tests');
    assert.ok(readmeKo.includes('32/32'), 'D-0021: README.ko.md must state 32/32 tests');
    assert.equal(readmeEn.includes('getContextEstimate()'), false, 'D-0021: README.md must not reference non-existent getContextEstimate()');
    assert.equal(readmeKo.includes('getContextEstimate()'), false, 'D-0021: README.ko.md must not reference non-existent getContextEstimate()');
    assert.equal(readmeEn.includes('agyCwLimit'), false, 'D-0021: README.md must not reference stale agyCwLimit key');
    assert.equal(readmeKo.includes('agyCwLimit'), false, 'D-0021: README.ko.md must not reference stale agyCwLimit key');
    assert.ok(readmeEn.includes('contextWindowUsage.estimatedAfterCompaction'), 'D-0021: README.md must document contextWindowUsage.estimatedAfterCompaction');
    assert.ok(readmeKo.includes('contextWindowUsage.estimatedAfterCompaction'), 'D-0021: README.ko.md must document contextWindowUsage.estimatedAfterCompaction');
    assert.ok(readmeEn.includes('activeProfile'), 'D-0021: README.md must document annotations.activeProfile');
    assert.ok(readmeKo.includes('activeProfile'), 'D-0021: README.ko.md must document annotations.activeProfile');
  });

  it('D-0022: injectCheckpointLimitIntoSendRequest skips cascade_config when continue_after_injection is true and merges existing binary field 5 without duplicate tags', () => {
    const { createHostBridge } = require('../src/host-bridge');
    const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
    const bridge = createHostBridge({
      window: {},
      document: { cookie: '' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      cwStore: {
        getSavedContextWindow: () => '384K',
        getLimit: () => 393216,
      },
    });

    // 1. JSON requests with continueAfterInjection / continue_after_injection = true MUST NOT get cascadeConfig injected
    const jsonContCamel = JSON.stringify({ cascadeId: 'cid-1', continueAfterInjection: true });
    const outJsonCamel = JSON.parse(bridge.injectCheckpointLimitIntoSendRequest(sendPath, jsonContCamel));
    assert.equal(outJsonCamel.cascadeConfig, undefined, 'D-0022: JSON continueAfterInjection=true must not inject cascadeConfig');
    assert.equal(outJsonCamel.cascade_config, undefined, 'D-0022: JSON continueAfterInjection=true must not inject cascade_config');

    const jsonContSnake = JSON.stringify({ cascade_id: 'cid-1', continue_after_injection: true });
    const outJsonSnake = JSON.parse(bridge.injectCheckpointLimitIntoSendRequest(sendPath, jsonContSnake));
    assert.equal(outJsonSnake.cascadeConfig, undefined, 'D-0022: JSON continue_after_injection=true must not inject cascadeConfig');
    assert.equal(outJsonSnake.cascade_config, undefined, 'D-0022: JSON continue_after_injection=true must not inject cascade_config');

    // 2. Protobuf binary request with field 20 (tag = (20 << 3) | 0 = 160 = 0xa0 0x01, val = 1) MUST NOT get field 5 (0x2a) appended
    const pbContinueTrue = Uint8Array.from([
      0x0a, 0x05, 0x63, 0x69, 0x64, 0x2d, 0x31, // field 1: cascade_id = "cid-1"
      0xa0, 0x01, 0x01, // field 20: continue_after_injection = true
    ]);
    const outPbCont = bridge.injectCheckpointLimitIntoSendRequest(sendPath, pbContinueTrue);
    assert.deepEqual(
      Array.from(outPbCont),
      Array.from(pbContinueTrue),
      'D-0022: Protobuf request with field 20 continue_after_injection=1 must be passed through untouched'
    );

    // Connect-framed Protobuf with field 20 = 1 must also be untouched
    const framedCont = new Uint8Array(5 + pbContinueTrue.length);
    framedCont[0] = 0;
    framedCont[4] = pbContinueTrue.length;
    framedCont.set(pbContinueTrue, 5);
    const outFramedCont = bridge.injectCheckpointLimitIntoSendRequest(sendPath, framedCont);
    assert.deepEqual(
      Array.from(outFramedCont),
      Array.from(framedCont),
      'D-0022: Connect-framed Protobuf with continue_after_injection=1 must be passed through untouched'
    );

    // 3. Binary Protobuf request that ALREADY has field 5 (cascade_config) containing field 1 (planner_config = {0x08, 0x01})
    //    must merge field 2 (checkpoint_config) inside the existing field 5 instead of emitting two top-level 0x2a fields!
    const validExistingCascadeCfg = Uint8Array.from([
      0x0a, 0x02, 0x08, 0x01, // field 1: planner_config
      0x12, 0x05, 0x30, 0x01, 0x28, 0x80, 0x10, // field 2: checkpoint_config { enabled(6)=1, max_token_limit(5)=2048 }
    ]);
    const pbWithExistingField5 = Uint8Array.from([
      0x0a, 0x05, 0x63, 0x69, 0x64, 0x2d, 0x32, // field 1: "cid-2"
      0x2a, validExistingCascadeCfg.length, ...validExistingCascadeCfg, // field 5: cascade_config
    ]);
    const mergedPb = bridge.injectCheckpointLimitIntoSendRequest(sendPath, pbWithExistingField5);
    // Count top-level field 5 (0x2a) occurrences by walking top-level wire tags
    let pos = 0;
    let field5Count = 0;
    let field5Bytes = null;
    const readVarint = (b, o) => {
      let val = 0, shift = 0, i = o;
      while (i < b.length) {
        const byte = b[i++];
        val += (byte & 0x7f) * (2 ** shift);
        if ((byte & 0x80) === 0) return { val, next: i };
        shift += 7;
      }
      throw new Error('truncated varint');
    };
    while (pos < mergedPb.length) {
      const tag = readVarint(mergedPb, pos);
      pos = tag.next;
      const wireType = tag.val & 0x07;
      const fieldNo = tag.val >>> 3;
      if (wireType === 0) {
        pos = readVarint(mergedPb, pos).next;
      } else if (wireType === 2) {
        const len = readVarint(mergedPb, pos);
        const start = len.next;
        const end = start + len.val;
        if (fieldNo === 5) {
          field5Count += 1;
          field5Bytes = mergedPb.subarray(start, end);
        }
        pos = end;
      } else {
        assert.fail(`Unexpected wireType ${wireType}`);
      }
    }
    assert.equal(field5Count, 1, 'D-0022: merged Protobuf message must contain exactly ONE top-level field 5 (cascade_config)');
    assert.ok(field5Bytes && field5Bytes[0] === 0x0a && field5Bytes[1] === 0x02, 'D-0022: sibling CascadeConfig field 1 (planner_config) must be preserved');
  });

  it('D-0023: ensure_statusbar_patch preserves // and /* inside strings/templates, parses NUL-padded ASAR headers, and skips non-http(s) / scriptJail frames', () => {
    const patcher = require('../scripts/ensure_statusbar_patch');
    const srcWithUrlAndStringComments = [
      '"use strict";',
      '// removable header comment line 1 about padding budget for statusbar injection code',
      '// removable header comment line 2 with extra space so patched replacement fits easily',
      '// removable header comment line 3 with extra space so patched replacement fits easily',
      '// removable header comment line 4 with extra space so patched replacement fits easily',
      '// removable header comment line 5 with extra space so patched replacement fits easily',
      '// removable header comment line 6 with extra space so patched replacement fits easily',
      '// removable header comment line 7 with extra space so patched replacement fits easily',
      '// removable header comment line 8 with extra space so patched replacement fits easily',
      'const tpl = `first line',
      '// MUST_KEEP_TEMPLATE_SLASH_LINE',
      '/* MUST_KEEP_TEMPLATE_BLOCK_COMMENT_LINE */',
      'last line`;',
      "    void win.loadURL(url);",
      'module.exports = { tpl };',
      '',
    ].join('\n');

    const origBuf = Buffer.from(srcWithUrlAndStringComments, 'utf8');
    const outBuf = patcher.transformExactSize(
      origBuf,
      patcher.UTILS_ANCHOR_TARGET,
      patcher.UTILS_ANCHOR_REPLACEMENT
    );
    assert.equal(outBuf.length, origBuf.length, 'D-0023: exact byte length must be preserved');
    const outStr = outBuf.toString('utf8');
    assert.ok(
      outStr.includes('// MUST_KEEP_TEMPLATE_SLASH_LINE'),
      'D-0023: transformExactSize must NOT delete // lines inside multiline template literals'
    );
    assert.ok(
      outStr.includes('/* MUST_KEEP_TEMPLATE_BLOCK_COMMENT_LINE */'),
      'D-0023: transformExactSize must NOT delete /* */ lines inside multiline template literals'
    );
    assert.ok(
      patcher.MAIN_ANCHOR_REPLACEMENT.includes('isScriptJailSession') || patcher.MAIN_ANCHOR_REPLACEMENT.includes('getURL'),
      'D-0023: MAIN_ANCHOR_REPLACEMENT must guard against scriptJail / non-http(s) frames'
    );

    // NUL-padded ASAR header test using temporary in-memory/tmpdir archive check
    const os = require('node:os');
    const tmpAsar = path.join(os.tmpdir(), `agy-sb-nul-asar-${process.pid}-${Date.now()}.asar`);
    try {
      const uBody = Buffer.from(`"use strict"; // ${patcher.PATCH_MARKER}\n`, 'utf8');
      const mBody = Buffer.from(`"use strict"; // ${patcher.PATCH_MARKER}\n`, 'utf8');
      const pBody = Buffer.from(`"use strict"; // ${patcher.PATCH_MARKER}\n`, 'utf8');
      const hdrJson = JSON.stringify({
        files: {
          dist: {
            files: {
              'utils.js': { size: uBody.length, offset: '0' },
              'main.js': { size: mBody.length, offset: String(uBody.length) },
              'preload.js': { size: pBody.length, offset: String(uBody.length + mBody.length) },
            },
          },
        },
      });
      const rawHdr = Buffer.from(hdrJson, 'utf8');
      const paddedLen = rawHdr.length + 3; // deliberate trailing \0\0\0 included in strSize
      const aligned = Math.ceil(paddedLen / 4) * 4;
      const u8Size = 4 + aligned;
      const u4Size = 4 + u8Size;
      const prefix = Buffer.alloc(8 + u4Size, 0);
      prefix.writeUInt32LE(4, 0);
      prefix.writeUInt32LE(u4Size, 4);
      prefix.writeUInt32LE(u8Size, 8);
      prefix.writeUInt32LE(paddedLen, 12);
      rawHdr.copy(prefix, 16);
      fs.writeFileSync(tmpAsar, Buffer.concat([prefix, uBody, mBody, pBody]));
      assert.equal(
        patcher.isAsarPatchedFast(tmpAsar),
        true,
        'D-0023: isAsarPatchedFast must parse NUL-padded ASAR JSON header without SyntaxError'
      );
    } finally {
      try { fs.unlinkSync(tmpAsar); } catch {}
    }
  });

  it('D-0024: scripts/build.js handles string literals ending with even vs odd backslashes and validates src/ MODULE_ORDER completeness', () => {
    const { stripCommentsAndEmptyLines } = require('../scripts/build');
    const evenBackslashSource = "'unclosed\\\\\n// comment-after-even-backslash-must-strip\nconst x = 1;";
    const strippedEven = stripCommentsAndEmptyLines(evenBackslashSource);
    assert.equal(
      strippedEven.includes('comment-after-even-backslash-must-strip'),
      false,
      'D-0024: line ending with even backslashes (\\\\) is NOT a line continuation and must not keep inSingle=true'
    );

    const oddBackslashSource = "'continued\\\n// keep-inside-continued-string\n';";
    const strippedOdd = stripCommentsAndEmptyLines(oddBackslashSource);
    assert.equal(
      strippedOdd.includes('// keep-inside-continued-string'),
      true,
      'D-0024: line ending with odd backslashes (\\) IS a line continuation and must preserve next line inside string'
    );

    const vm = require('node:vm');
    const buildPath = path.join(__dirname, '..', 'scripts', 'build.js');
    const buildSrc = fs.readFileSync(buildPath, 'utf8').replace(/^#!.*\n/, '');
    const customReq = (spec) => {
      if (spec === 'fs') {
        return {
          ...fs,
          readdirSync: (dir, opts) => {
            const entries = fs.readdirSync(dir, opts);
            if (path.resolve(String(dir)) === path.resolve(path.join(__dirname, '..', 'src'))) {
              return [
                ...entries,
                opts && opts.withFileTypes
                  ? { name: 'orphan-unlisted-module.js', isDirectory: () => false, isFile: () => true }
                  : 'orphan-unlisted-module.js',
              ];
            }
            return entries;
          },
          mkdirSync() {},
          writeFileSync() {},
        };
      }
      return require(spec);
    };
    const mod = { exports: {} };
    new vm.Script(buildSrc).runInContext(vm.createContext({
      require: customReq,
      module: mod,
      exports: mod.exports,
      __dirname: path.dirname(buildPath),
      __filename: buildPath,
      process,
      Buffer,
      console,
    }));
    assert.throws(
      () => mod.exports.buildBundle({ write: false }),
      /orphan-unlisted-module\.js|MODULE_ORDER/,
      'D-0024: buildBundle must fail fast when a src/*.js file is missing from MODULE_ORDER'
    );
  });

  it('D-0025 & D-0026: multi-policy TrustedTypes + Blob fallback in companion loader, quota HTML escaping, empty title removal, bounded cascade maps, and iframe DOM cleanup', async () => {
    // 1. Strict TrustedTypes that blocks primary agy-statusbar / agy-rc-* but allows plugin-scoped 'agy-statusbar-companion'
    const appendedScripts = [];
    const strictWin = {
      location: { hostname: 'antigravity.google.com' },
      trustedTypes: {
        createPolicy(name, rules) {
          if (name !== 'agy-statusbar-companion') throw new TypeError(`Policy ${name} disallowed by CSP`);
          return {
            createScript: (s) => `TT_COMPANION:${rules.createScript(s)}`,
            createScriptURL: (u) => u,
          };
        },
      },
      __agyHostInstalledPlugins: {
        resolved: true,
        hasStatusbar: true,
        hasMcpManager: true,
        hasKoTranslator: false,
        mcpManagerCode: 'window.__mcpLoadedViaCompanionTT = true;',
      },
    };
    const strictDoc = {
      head: { appendChild(el) { appendedScripts.push(el); } },
      createElement(tag) { return { tagName: tag, text: '', src: '' }; },
      querySelector: () => null,
    };
    await ensureRemoteCompanionScripts(strictWin, strictDoc, null, null);
    assert.equal(appendedScripts.length, 1, 'D-0025: companion script must be injected using secondary plugin-scoped TrustedTypes policy');
    assert.ok(String(appendedScripts[0].text).startsWith('TT_COMPANION:'), 'D-0025: agy-statusbar-companion policy createScript must be used');

    // 2. Adapter registry clears title attribute when dynamic title becomes empty string
    const { createAdapterRegistry } = require('../src/adapter-registry');
    let dynamicTitle = 'Initial Tooltip';
    const slotChildren = [];
    const fakeBtn = {
      type: '',
      className: '',
      textContent: '',
      title: '',
      attrs: new Map(),
      setAttribute(k, v) { this.attrs.set(k, String(v)); },
      getAttribute(k) { return this.attrs.get(k) ?? null; },
      removeAttribute(k) { this.attrs.delete(k); },
      remove() {},
    };
    const reg = createAdapterRegistry({
      window: {},
      document: {
        createElement: () => fakeBtn,
        querySelectorAll: () => [],
      },
      setHtml() {},
    });
    reg.registerAdapter({
      id: 'dyn-title-btn',
      slot: 'right',
      label: 'Btn',
      title: () => dynamicTitle,
      onClick() {},
    });
    const slotEl = {
      children: slotChildren,
      appendChild(c) { if (!slotChildren.includes(c)) slotChildren.push(c); return c; },
      querySelector(sel) { return sel.includes('dyn-title-btn') && slotChildren.length ? fakeBtn : null; },
      querySelectorAll: () => [],
    };
    reg.renderSlotAdapters(slotEl, 'right', {});
    assert.equal(fakeBtn.getAttribute('title'), 'Initial Tooltip');
    dynamicTitle = '';
    reg.renderSlotAdapters(slotEl, 'right', {});
    assert.equal(fakeBtn.getAttribute('title'), null, 'D-0026: empty dynamic title must remove stale title attribute');

    // 3. core-metrics escapes quota strings against XSS
    const { createCoreMetricsAdapter } = require('../src/adapters/core-metrics');
    let capturedHtml = '';
    const metricsAdapter = createCoreMetricsAdapter({
      document: { createElement: () => ({ querySelector: () => null, querySelectorAll: () => [] }) },
      setHtml(_el, html) { capturedHtml = html; },
      cwStore: { getLimit: () => 262144, getQuotaHint: () => '256K' },
      getConversationContextWindow: () => '256K',
      setConversationContextWindow() {},
      cycleConversationContextWindow() {},
      updateAll() {},
    });
    const hostSpan = {
      children: [],
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    metricsAdapter.render(hostSpan, {
      cascadeId: 'c1',
      currentCw: '256K',
      stats: { used: 1000, cachePct: 50, cacheRead: 500 },
      quota: { pct5h: 80, pct7d: 90, rst5h: '<img src=x onerror=alert(1)>' },
    });
    assert.equal(capturedHtml.includes('<img'), false, 'D-0025: core-metrics must HTML-escape quota.rst5h');

    // 4. cleanupStatusBar cleans up .agy-ctx-statusbar and .agy-ctx-menu inside same-origin remote iframe too
    let iframeBarRemoved = false;
    let iframeMenuCleaned = false;
    const iframeDoc = {
      getElementById: () => null,
      querySelectorAll(sel) {
        if (sel === '.agy-ctx-statusbar') return [{ remove() { iframeBarRemoved = true; } }];
        if (sel === '.agy-ctx-menu') return [{ __agyCleanup() { iframeMenuCleaned = true; } }];
        return [];
      },
    };
    const parentDoc = {
      head: { appendChild() {} },
      body: {},
      createElement: () => ({ setAttribute() {}, remove() {} }),
      getElementById: () => null,
      querySelector(sel) {
        if (sel === 'ga-remote-control iframe') return { contentDocument: iframeDoc };
        return null;
      },
      querySelectorAll: () => [],
    };
    const parentWin = {
      document: parentDoc,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setInterval: () => 1,
      clearInterval() {},
      MutationObserver: class { observe() {} disconnect() {} },
    };
    mountStatusBar({ window: parentWin, document: parentDoc });
    parentWin.__agyStatusBarCleanup();
    assert.equal(iframeBarRemoved, true, 'D-0026: cleanupStatusBar must remove .agy-ctx-statusbar inside same-origin remote iframe');
    assert.equal(iframeMenuCleaned, true, 'D-0026: cleanupStatusBar must invoke __agyCleanup on .agy-ctx-menu inside same-origin remote iframe');
  });

  it('D-0027: host-adapter-config decouples RPC service prefix, CSRF header, remote host domain, and companion URLs from core modules', async () => {
    const { resolveHostAdapterConfig, DEFAULT_HOST_ADAPTER_CONFIG } = require('../src/host-adapter-config');
    const { createRpcClient } = require('../src/rpc-client');
    assert.ok(DEFAULT_HOST_ADAPTER_CONFIG.rpcServicePrefix);
    const customCfg = resolveHostAdapterConfig({
      rpcServicePrefix: '/custom.vendor.v1.AgentService',
      csrfHeaderName: 'x-custom-csrf',
      remoteHostDomains: ['portal.custom-ide.example'],
      companionScripts: {
        mcpManagerUrl: 'https://cdn.custom-ide.example/mcp.js',
        koTranslatorUrl: 'https://cdn.custom-ide.example/ko.js',
      },
    });
    assert.equal(customCfg.buildRpcPath('RetrieveUserQuotaSummary'), '/custom.vendor.v1.AgentService/RetrieveUserQuotaSummary');

    const seenRequests = [];
    const rpc = createRpcClient({
      window: { location: { protocol: 'https:', hostname: '127.0.0.1' } },
      hostConfig: customCfg,
      fetchFn: async (url, opts) => {
        seenRequests.push({ url, headers: opts?.headers || {} });
        return {
          ok: true,
          async json() {
            return { groups: [] };
          },
        };
      },
      localStorage: { getItem: () => null, setItem() {} },
    });
    await rpc.fetchQuota('tok-custom-123');
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0].url, '/custom.vendor.v1.AgentService/RetrieveUserQuotaSummary');
    assert.equal(seenRequests[0].headers['x-custom-csrf'], 'tok-custom-123');
    assert.equal(seenRequests[0].headers['x-codeium-csrf-token'], undefined);

    const fetchedCompanionUrls = [];
    const customRemoteWin = {
      location: { hostname: 'portal.custom-ide.example' },
      __agyHostInstalledPlugins: {
        resolved: true,
        hasStatusbar: true,
        hasMcpManager: true,
        hasKoTranslator: false,
      },
    };
    const customRemoteDoc = {
      head: { appendChild() {} },
      createElement: () => ({ text: '' }),
      querySelector: () => null,
    };
    await ensureRemoteCompanionScripts(
      customRemoteWin,
      customRemoteDoc,
      async (u) => {
        fetchedCompanionUrls.push(u);
        return { ok: true, async text() { return '// custom mcp'; } };
      },
      null,
      customCfg
    );
    assert.equal(fetchedCompanionUrls.length, 1);
    assert.ok(fetchedCompanionUrls[0].startsWith('https://cdn.custom-ide.example/mcp.js'));
  });

  it('D-0028 & D-0029: GitFlow CI workflow triggers, documentation templates, and pre-test specification exist and are consistent', () => {
    const rootDir = path.join(__dirname, '..');
    const ciYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.ok(ciYml.includes('develop'), 'D-0028: ci.yml must trigger on develop branch');
    assert.ok(ciYml.includes('fix/**'), 'D-0028: ci.yml must trigger on fix/** branches');
    assert.ok(ciYml.includes('feature/**'), 'D-0028: ci.yml must trigger on feature/** branches');
    assert.ok(ciYml.includes('workflow_dispatch'), 'D-0028: ci.yml must support workflow_dispatch');

    assert.equal(fs.existsSync(path.join(rootDir, 'docs', 'templates', 'README_TEMPLATE.md')), true, 'D-0029: README_TEMPLATE.md must exist');
    assert.equal(fs.existsSync(path.join(rootDir, 'docs', 'templates', 'RELEASE_NOTES_TEMPLATE.md')), true, 'D-0029: RELEASE_NOTES_TEMPLATE.md must exist');
    assert.equal(fs.existsSync(path.join(rootDir, 'docs', 'TEST_CASES.md')), true, 'D-0029: docs/TEST_CASES.md must exist');

    const relTpl = fs.readFileSync(path.join(rootDir, 'docs', 'templates', 'RELEASE_NOTES_TEMPLATE.md'), 'utf8');
    assert.ok(relTpl.includes('[English]') && relTpl.includes('[한국어]'), 'D-0029: RELEASE_NOTES_TEMPLATE.md must contain both English and Korean inline sections');
  });

  it('D-0031 & D-0032: isRemoteHost blocks substring domain spoofing and TrustedTypes never registers global passthrough policies', async () => {
    const { resolveHostAdapterConfig } = require('../src/host-adapter-config');
    const { createTrustedHtmlSetter } = require('../src/dom-styles');

    const defaultCfg = resolveHostAdapterConfig();
    assert.equal(defaultCfg.isRemoteHost('antigravity.google.com'), true);
    assert.equal(defaultCfg.isRemoteHost('r.antigravity.google.com'), true);
    assert.equal(
      defaultCfg.isRemoteHost('antigravity.google.com.evil.example'),
      false,
      'D-0031: suffix-appended attacker domain must NOT match remoteHostDomains'
    );
    assert.equal(
      defaultCfg.isRemoteHost('evil-antigravity.google.com'),
      false,
      'D-0031: hyphen-prefixed attacker domain without dot boundary must NOT match remoteHostDomains'
    );

    const dottedCfg = resolveHostAdapterConfig({ remoteHostDomains: ['.portal.example.', '  '] });
    assert.equal(dottedCfg.isRemoteHost('portal.example'), true);
    assert.equal(dottedCfg.isRemoteHost('sub.portal.example'), true);
    assert.equal(dottedCfg.isRemoteHost('portal.example.attacker.test'), false);
    assert.equal(dottedCfg.isRemoteHost('fakeportal.example'), false);

    const forbiddenGlobalPolicies = new Set(['default', 'dompurify', 'angular', 'angular#unsafe-bypass', 'nextjs#bundler']);
    const TRUSTED_HTML_BRAND = Symbol('TrustedHTML');
    const TRUSTED_SCRIPT_BRAND = Symbol('TrustedScript');
    const TRUSTED_SCRIPT_URL_BRAND = Symbol('TrustedScriptURL');

    // W3C-accurate strict TrustedTypes environment where ALLpolicies are denied (policy === null)
    // and innerHTML, outerHTML, insertAdjacentHTML, Range.createContextualFragment, AND DOMParser.parseFromString
    // all throw TypeError unless branded as TrustedHTML!
    const attemptedHtmlPolicies = [];
    const htmlWin = {
      DOMParser: class {
        parseFromString(v) {
          if (!v || v[TRUSTED_HTML_BRAND] !== true) {
            throw new TypeError("Failed to execute 'parseFromString' on 'DOMParser': This document requires 'TrustedHTML' assignment.");
          }
          return {};
        }
      },
      trustedTypes: {
        createPolicy(name) {
          attemptedHtmlPolicies.push(name);
          throw new TypeError(`Disallowed policy ${name}`);
        },
      },
    };
    function makeStrictNode(tag) {
      const node = {
        nodeType: 1,
        tagName: String(tag || 'div').toUpperCase(),
        attrs: {},
        style: {},
        className: '',
        children: [],
        childNodes: [],
        firstChild: null,
        set innerHTML(v) {
          if (!v || v[TRUSTED_HTML_BRAND] !== true) {
            throw new TypeError("Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.");
          }
        },
        set outerHTML(_v) {
          throw new TypeError("Failed to set the 'outerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.");
        },
        insertAdjacentHTML() {
          throw new TypeError("Failed to execute 'insertAdjacentHTML' on 'Element': This document requires 'TrustedHTML' assignment.");
        },
        setAttribute(k, val) {
          this.attrs[k] = String(val);
          if (k === 'class') this.className = String(val);
          if (k === 'id') this.id = String(val);
        },
        getAttribute(k) {
          return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
        },
        appendChild(ch) {
          ch.parentNode = this;
          this.childNodes.push(ch);
          if (ch.nodeType === 1) this.children.push(ch);
          this.firstChild = this.childNodes[0] || null;
          return ch;
        },
        removeChild(ch) {
          this.childNodes = this.childNodes.filter((x) => x !== ch);
          this.children = this.children.filter((x) => x !== ch);
          this.firstChild = this.childNodes[0] || null;
          return ch;
        },
        get textContent() {
          return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
        },
        set textContent(val) {
          this.childNodes = [];
          this.children = [];
          if (val) {
            const tn = { nodeType: 3, nodeValue: String(val) };
            this.childNodes.push(tn);
          }
          this.firstChild = this.childNodes[0] || null;
        },
        querySelectorAll(sel) {
          const out = [];
          const walk = (el) => {
            for (const c of el.children || []) {
              if (
                (sel.startsWith('.') && String(c.className || '').split(/\s+/).includes(sel.slice(1))) ||
                c.tagName.toLowerCase() === sel.toLowerCase()
              ) {
                out.push(c);
              }
              walk(c);
            }
          };
          walk(this);
          return out;
        },
        querySelector(sel) {
          return this.querySelectorAll(sel)[0] || null;
        },
      };
      return node;
    }
    const htmlDoc = {
      createElement: (t) => makeStrictNode(t),
      createTextNode: (txt) => ({ nodeType: 3, nodeValue: String(txt) }),
      createDocumentFragment: () => makeStrictNode('fragment'),
      createRange() {
        return {
          selectNodeContents() {},
          deleteContents() {},
          createContextualFragment(v) {
            if (!v || v[TRUSTED_HTML_BRAND] !== true) {
              throw new TypeError("Failed to execute 'createContextualFragment' on 'Range': This document requires 'TrustedHTML' assignment.");
            }
            return makeStrictNode('fragment');
          },
        };
      },
    };
    const setHtml = createTrustedHtmlSetter(htmlWin, htmlDoc);
    const targetEl = makeStrictNode('span');
    setHtml(
      targetEl,
      '<span class="agy-ctx-group" onclick="alert(1)" data-agy-no-translate="true"><span>ctx <strong class="agy-ctx-pct-val agy-ctx-ok">42%</strong> <button type="button" class="agy-ctx-btn-limit">[ 384k ▾ ]</button></span></span><script>evil()</script>'
    );
    assert.ok(targetEl.querySelector('.agy-ctx-pct-val'), 'D-0032: sink-free DOM builder must construct nested elements when TrustedTypes rejects all policies');
    assert.equal(targetEl.querySelector('.agy-ctx-pct-val').textContent, '42%');
    assert.equal(targetEl.querySelector('.agy-ctx-btn-limit').textContent, '[ 384k ▾ ]');
    assert.equal(targetEl.querySelector('script'), null, 'D-0032: sink-free DOM builder must drop disallowed <script> tags');
    assert.equal(targetEl.querySelector('.agy-ctx-group').getAttribute('onclick'), null, 'D-0032: sink-free DOM builder must strip inline event handler attributes');
    for (const p of attemptedHtmlPolicies) {
      assert.equal(forbiddenGlobalPolicies.has(p), false, `D-0032: createTrustedHtmlSetter must never attempt global policy '${p}'`);
      assert.ok(p.startsWith('agy-statusbar'), `D-0032: policy '${p}' must be namespaced under agy-statusbar`);
    }

    // Strict TrustedTypes script sink: when all policies are denied, BOTH s.text AND s.src require branded objects!
    const attemptedScriptPolicies = [];
    const strictBlockedWin = {
      location: { hostname: 'antigravity.google.com' },
      Blob: class { constructor(parts) { this.parts = parts; } },
      URL: {
        createObjectURL: () => 'blob:https://antigravity.google.com/blocked-1',
        revokeObjectURL() {},
      },
      trustedTypes: {
        createPolicy(name) {
          attemptedScriptPolicies.push(name);
          throw new TypeError(`Disallowed policy ${name}`);
        },
      },
      __agyHostInstalledPlugins: {
        resolved: true,
        hasStatusbar: true,
        hasMcpManager: true,
        hasKoTranslator: false,
        mcpManagerCode: 'window.agyMcpManager = { version: "1.4.18" };',
      },
    };
    const makeStrictScriptDoc = (onAppend) => ({
      head: { appendChild: onAppend },
      createElement(tag) {
        let _src = '';
        let _text = '';
        const listeners = {};
        return {
          tagName: tag,
          get src() { return _src; },
          set src(v) {
            if (!v || v[TRUSTED_SCRIPT_URL_BRAND] !== true) {
              throw new TypeError("Failed to set the 'src' property on 'HTMLScriptElement': This document requires 'TrustedScriptURL' assignment.");
            }
            _src = v.url;
          },
          get text() { return _text; },
          set text(v) {
            if (!v || v[TRUSTED_SCRIPT_BRAND] !== true) {
              throw new TypeError("Failed to set the 'text' property on 'HTMLScriptElement': This document requires 'TrustedScript' assignment.");
            }
            _text = v.code;
          },
          addEventListener(ev, fn) { listeners[ev] = fn; },
          _fire(ev) { if (listeners[ev]) listeners[ev](); },
        };
      },
      querySelector: () => null,
    });
    const blockedDoc = makeStrictScriptDoc(() => {
      throw new Error('Should not append unbranded script');
    });
    await ensureRemoteCompanionScripts(strictBlockedWin, blockedDoc, async () => ({ ok: false }), null);
    assert.equal(strictBlockedWin.__agyLoadingMcpManagerCompanion, false, 'D-0032: when TrustedTypes rejects all policies, loading flag must reset to false instead of faking success');
    for (const p of attemptedScriptPolicies) {
      assert.equal(forbiddenGlobalPolicies.has(p), false, `D-0032: injectScriptText must never attempt global policy '${p}'`);
      assert.ok(p.startsWith('agy-statusbar') || p.startsWith('agy-rc-'), `D-0032: policy '${p}' must be plugin-scoped`);
    }

    // Async CSP block on inline/blob must fall back to remote allowed URL with branded TrustedScriptURL!
    const appendedUrls = [];
    const cspFallbackWin = {
      location: { hostname: 'antigravity.google.com' },
      Blob: class { constructor(parts) { this.parts = parts; } },
      URL: {
        createObjectURL: () => 'blob:https://antigravity.google.com/csp-blocked-blob',
        revokeObjectURL() {},
      },
      trustedTypes: {
        createPolicy(name, rules) {
          if (name === 'agy-statusbar') {
            return {
              createScript: (c) => ({ [TRUSTED_SCRIPT_BRAND]: true, code: rules.createScript(c) }),
              createScriptURL: (u) => ({ [TRUSTED_SCRIPT_URL_BRAND]: true, url: rules.createScriptURL(u) }),
            };
          }
          throw new TypeError(`Disallowed policy ${name}`);
        },
      },
      __agyHostInstalledPlugins: {
        resolved: true,
        hasStatusbar: true,
        hasMcpManager: true,
        hasKoTranslator: false,
        mcpManagerCode: '/* inline blocked by CSP without throwing synchronously */',
      },
    };
    const cspFallbackDoc = makeStrictScriptDoc((el) => {
      if (el.src) {
        appendedUrls.push(el.src);
        if (el.src.startsWith('blob:')) {
          Promise.resolve().then(() => el._fire('error'));
        } else {
          cspFallbackWin.agyMcpManager = { version: '1.4.18' };
          Promise.resolve().then(() => el._fire('load'));
        }
      }
    });
    await ensureRemoteCompanionScripts(cspFallbackWin, cspFallbackDoc, null, null);
    assert.ok(
      appendedUrls.some((u) => u.startsWith('https://raw.githubusercontent.com/')),
      'D-0032: when inline & blob scripts are blocked by CSP, loader must fall back to remote companion script URL'
    );
    assert.ok(cspFallbackWin.agyMcpManager, 'D-0032: remote companion URL fallback must complete mounting');
  });

  it('D-0012, D-0013, D-0020, D-0023, D-0030, D-0033: eliminates session-switch flicker, Object.prototype pollution, RFC6455 violations, and lock TOCTOU', async () => {
    const net = require('node:net');
    const crypto = require('node:crypto');
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    const { createRpcClient } = require('../src/rpc-client');
    const { createHostBridge, registerCustomCwInPrototype } = require('../src/host-bridge');

    // 1. D-0020: registerCustomCwInPrototype must NEVER define properties on Object.prototype
    const underSet = new Set(['128K', '256K']);
    registerCustomCwInPrototype('384K', underSet, () => {});
    registerCustomCwInPrototype('200K', underSet, () => {});
    assert.equal(
      Object.getOwnPropertyDescriptor(Object.prototype, '384K'),
      undefined,
      'D-0020: Object.prototype must NEVER be polluted with 384K getter'
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(Object.prototype, '200K'),
      undefined,
      'D-0020: Object.prototype must NEVER be polluted with 200K getter'
    );
    assert.equal(underSet.has('200K'), true, 'underDefaultCwSet should still track <=256K custom values');

    // 2. D-0033: Cross-session agentStateProvider state bleed on same-DOM session switch
    let liveAspState = {
      conversationId: 'session-a',
      compactedAtStepIndices: [9400],
      contextWindowUsage: {
        estimatedTokensUsed: 331000,
        estimatedAfterCompaction: 290000,
        maxContextTokens: 384000,
        lastStepIndex: 9500,
      },
      trajectorySlice: { totalGeneratorMetadataLength: 420, totalStepsLength: 9500 },
    };
    const rpc = createRpcClient({
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      getAgentStateProviderForInputBox: () => ({ getState: () => liveAspState }),
      fetchFn: async (_url, init) => {
        const req = JSON.parse(init.body);
        if (req.cascadeId === 'session-b') {
          return {
            ok: true,
            json: async () => ({
              generatorMetadata: [
                {
                  stepIndices: [120],
                  chatModel: {
                    chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 30000, maxContextTokens: 256000 } },
                    usage: { cacheReadTokens: 25000, inputTokens: 5000 },
                  },
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({ generatorMetadata: [] }) };
      },
    });
    // Switch DOM to session-b while liveAspState still points to session-a!
    const immStale = rpc.getImmediateStats('session-b', {});
    assert.equal(
      immStale,
      null,
      'D-0033: getImmediateStats(session-b) must NOT bleed session-a 290k/331k tokens when fullState.conversationId === session-a'
    );
    const fetchedB = await rpc.fetchCascadeStats('session-b', 'csrf-1', {});
    assert.equal(
      fetchedB.used,
      30000,
      'D-0033: fetchCascadeStats(session-b) must NOT overwrite session-b 30k RPC result with stale session-a fullState'
    );

    // 3. D-0012 & D-0013: No repeated userStatus/setUserStatus on frozen clientModelConfigs AND zero redundant modelPicked on default 256K session switch
    const reduxDispatches = [];
    const frozenCfg = Object.freeze({
      label: 'Gemini 4 Carbon (Medium)',
      modelOrAlias: { choice: { case: 'model', value: 1437 } },
    });
    const liveReduxState = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: Object.freeze([frozenCfg]),
          defaultOverrideModelConfig: { modelOrAlias: { choice: { case: 'model', value: 1437 } } },
        },
      },
      modelSelection: {
        default: { model: 1437, contextWindow: '256K' },
        byConversation: {
          'convo-384': { model: 1437, contextWindow: '384K' },
          // 'convo-default-256' is intentionally absent (native v2.32.1 default state)
        },
        trajectorySync: {},
      },
    };
    const liveReduxStore = {
      getState: () => liveReduxState,
      dispatch(action) {
        reduxDispatches.push(action);
        if (action.type === 'modelSelection/modelPicked') {
          const cid = action.payload.conversationId;
          if (cid) {
            liveReduxState.modelSelection.byConversation[cid] = {
              model: action.payload.model,
              customLabel: action.payload.customLabel,
              contextWindow: action.payload.contextWindow,
            };
          }
          liveReduxState.modelSelection.default = {
            model: action.payload.model,
            customLabel: action.payload.customLabel,
            contextWindow: action.payload.contextWindow,
          };
        }
      },
    };
    const sharedTrigger = {
      isConnected: true,
      attrs: { 'data-testid': 'model-selector-trigger' },
      getAttribute(k) { return this.attrs[k] ?? null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      __reactFiber$1: {
        memoizedProps: {
          value: {
            store: liveReduxStore,
            selectedModel: { value: 1437, label: 'Gemini 4 Carbon (Medium)', contextWindowOptions: [] },
            setSelectedModel() {},
          },
        },
        return: null,
      },
    };
    let activeCascadeAttr = 'convo-default-256';
    const sharedView = {
      getAttribute(k) { return k === 'data-cascade-id' ? activeCascadeAttr : null; },
      querySelector(sel) { return sel === '[data-testid="model-selector-trigger"]' ? sharedTrigger : null; },
    };
    const cwLsMap = new Map([
      ['agy-session-ctx-windows-v1', JSON.stringify({ 'convo-default-256': '256K', 'convo-384': '384K' })],
    ]);
    const cwStoreLive = createContextWindowStore({
      document: { cookie: '' },
      localStorage: {
        getItem: (k) => cwLsMap.get(k) ?? null,
        setItem: (k, v) => cwLsMap.set(k, String(v)),
      },
    });
    const origWinFetch = async () => ({ ok: true, json: async () => ({}) });
    const origRcMethod = function () { return 'orig-rc'; };
    function FakeRcComponent() {}
    FakeRcComponent.prototype.proxyCommand = origRcMethod;
    FakeRcComponent.prototype.handleIframeMessage = origRcMethod;
    const hbWin = {
      fetch: origWinFetch,
      __agyRemoteControlInstance: new FakeRcComponent(),
    };
    const hbLive = createHostBridge({
      window: hbWin,
      document: { querySelectorAll: () => [sharedView], querySelector: () => sharedView },
      localStorage: { getItem: () => null, setItem() {} },
      fetchFn: origWinFetch,
      cwStore: cwStoreLive,
    });
    hbLive.getRemoteControlInstance();
    // Repeated ensureContextWindowSelectorFlag calls with different extraCw across session switches:
    hbLive.ensureContextWindowSelectorFlag();
    hbLive.ensureContextWindowSelectorFlag('384K');
    hbLive.ensureContextWindowSelectorFlag();
    hbLive.ensureContextWindowSelectorFlag('384K');
    const setUserStatusCount = reduxDispatches.filter((a) => a.type === 'userStatus/setUserStatus').length;
    assert.ok(
      setUserStatusCount <= 1,
      `D-0012: ensureContextWindowSelectorFlag must NOT repeatedly dispatch userStatus/setUserStatus on frozen clientModelConfigs (got ${setUserStatusCount})`
    );

    reduxDispatches.length = 0;
    // Switching to default 256K session where byConversation['convo-default-256'] is undefined:
    hbLive.applyContextWindowToEngine(sharedView, 'convo-default-256', '256K');
    assert.equal(
      reduxDispatches.filter((a) => a.type === 'modelSelection/modelPicked').length,
      0,
      'D-0013: switching to a 256K session when Redux effective contextWindow is already 256K must dispatch 0 modelPicked actions'
    );
    // Switching to already-hydrated 384K session and back to 256K:
    activeCascadeAttr = 'convo-384';
    hbLive.applyContextWindowToEngine(sharedView, 'convo-384', '384K');
    activeCascadeAttr = 'convo-default-256';
    hbLive.applyContextWindowToEngine(sharedView, 'convo-default-256', '256K');
    assert.equal(
      reduxDispatches.filter((a) => a.type === 'modelSelection/modelPicked').length,
      0,
      'D-0013: switching between 384K and 256K sessions whose Redux state already matches must dispatch 0 modelPicked actions'
    );
    // Applying a new custom 384K session ('convo-new-384') must NOT corrupt global default.contextWindow to '512K'
    activeCascadeAttr = 'convo-new-384';
    hbLive.applyContextWindowToEngine(sharedView, 'convo-new-384', '384K');
    assert.equal(
      liveReduxState.modelSelection.default.contextWindow,
      '256K',
      'D-0013: applying 384K to a session when lsDef is unset must restore host prevDefault.contextWindow (256K) instead of polluting global default with 512K'
    );

    // D-0020: dispose() must restore window.fetch and RemoteControlComponent.prototype methods!
    hbLive.dispose();
    assert.equal(hbWin.fetch, origWinFetch, 'D-0020: hostBridge.dispose() must restore original window.fetch');
    assert.equal(
      FakeRcComponent.prototype.proxyCommand,
      origRcMethod,
      'D-0020: hostBridge.dispose() must restore RemoteControlComponent.prototype.proxyCommand'
    );

    // 4. D-0012 (uncached session switch 2-step 0% jump): switching mounted bar to uncached session must NOT flash 0% before async stats resolve
    const { sandbox: sbSandbox, getMountedBar } = createDomSandbox();
    sbSandbox.localStorage.setItem(
      'agy-session-ctx-windows-v1',
      JSON.stringify({ 'test-session-1': '256K', 'cid-uncached-b': '256K' })
    );
    let activeSbCid = 'test-session-1';
    const sbView = sbSandbox.document.querySelector('[data-testid="conversation-view"]');
    sbView.getAttribute = (k) => (k === 'data-cascade-id' ? activeSbCid : null);
    let currentFetchDelayResolve = null;
    mountStatusBar({
      window: sbSandbox.window,
      document: sbSandbox.document,
      localStorage: sbSandbox.localStorage,
      fetch: async (url, init) => {
        if (String(url).includes('RetrieveUserQuotaSummary')) {
          return { ok: true, json: async () => ({ groups: [] }) };
        }
        const body = JSON.parse(init.body || '{}');
        if (body.cascadeId === 'cid-uncached-b') {
          return new Promise((resolve) => {
            currentFetchDelayResolve = () =>
              resolve({
                ok: true,
                json: async () => ({
                  generatorMetadata: [
                    {
                      chatModel: {
                        chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 128000, maxContextTokens: 256000 } },
                        usage: { cacheReadTokens: 64000, inputTokens: 64000 },
                      },
                    },
                  ],
                }),
              });
          });
        }
        return {
          ok: true,
          json: async () => ({
            generatorMetadata: [
              {
                chatModel: {
                  chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 204800, maxContextTokens: 256000 } },
                  usage: { cacheReadTokens: 100000, inputTokens: 104800 },
                },
              },
            ],
          }),
        };
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    });
    await new Promise((r) => setTimeout(r, 30));
    const mountedBar = getMountedBar();
    const coreEl = mountedBar.querySelector('.agy-ctx-left').querySelector('[data-agy-adapter-id="core-metrics"]');
    assert.ok(coreEl.innerHTML.includes('>80%<'), 'session A should initially render 80%');

    // Switch same DOM view to uncached 'cid-uncached-b' while RPC is still in-flight:
    activeSbCid = 'cid-uncached-b';
    sbSandbox.window.agyStatusBar.updateAll();
    assert.equal(
      coreEl.innerHTML.includes('>0%<'),
      false,
      'D-0012: switching mounted statusbar to an uncached session must NOT flash intermediate ctx 0% before async RPC resolves'
    );
    assert.ok(currentFetchDelayResolve, 'in-flight RPC for cid-uncached-b should be pending');
    currentFetchDelayResolve();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(coreEl.innerHTML.includes('>50%<'), 'once async RPC resolves, statusbar renders 50% in a single step');
    assert.ok(
      coreEl.innerHTML.includes('transition:none'),
      'D-0012: cross-session render must suppress .agy-ctx-bar-fill width transition'
    );
    sbSandbox.window.__agyStatusBarCleanup();

    // 5. D-0030: RFC 6455 payload Ping -> Pong echo, FIN/Continuation fragmentation, and >16MB frame cap
    const { configureTargetViaCdp } = require('../scripts/ensure_statusbar_patch');
    const savedWs = globalThis.WebSocket;
    delete globalThis.WebSocket;
    let receivedPongPayload = null;
    const rawWsServer = net.createServer((socket) => {
      let upgraded = false;
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (!upgraded) {
          const txt = chunk.toString('utf8');
          if (!txt.includes('\r\n\r\n')) return;
          upgraded = true;
          const keyMatch = txt.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i);
          const accept = crypto
            .createHash('sha1')
            .update(keyMatch[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
          );
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 6) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 8) return;
            len = buf.readUInt16BE(2);
            off = 4;
          }
          if (buf.length < off + 4 + len) return;
          const mask = buf.subarray(off, off + 4);
          const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
          buf = buf.subarray(off + 4 + len);

          if (opcode === 0x0a) {
            receivedPongPayload = payload.toString('utf8');
            // Now send fragmented JSON response (3 fragments: FIN=0 op=1, FIN=0 op=0, FIN=1 op=0)
            const fullJson = Buffer.from(
              JSON.stringify({ id: 1, result: { result: { value: 'INJECTED_OK' } } }),
              'utf8'
            );
            const p1 = fullJson.subarray(0, 12);
            const p2 = fullJson.subarray(12, 28);
            const p3 = fullJson.subarray(28);
            socket.write(Buffer.concat([Buffer.from([0x01, p1.length]), p1]));
            socket.write(Buffer.concat([Buffer.from([0x00, p2.length]), p2]));
            socket.write(Buffer.concat([Buffer.from([0x80, p3.length]), p3]));
          } else if (opcode === 0x01) {
            // First send a Ping WITH payload 'agy-ping-payload' before replying!
            const pingData = Buffer.from('agy-ping-payload', 'utf8');
            socket.write(Buffer.concat([Buffer.from([0x89, pingData.length]), pingData]));
          }
        }
      });
    });
    await new Promise((r) => rawWsServer.listen(0, '127.0.0.1', r));
    try {
      const port = rawWsServer.address().port;
      const evalResult = await configureTargetViaCdp(`ws://127.0.0.1:${port}/devtools/page/1`, 'void 0;', 'hash1', 1500);
      assert.equal(
        receivedPongPayload,
        'agy-ping-payload',
        'D-0030: RFC 6455 client must echo non-empty Ping payload verbatim in Pong frame'
      );
      assert.equal(
        evalResult,
        'INJECTED_OK',
        'D-0030: RFC 6455 client must reassemble multi-fragment (FIN=0 + Continuation) CDP JSON frames'
      );
    } finally {
      if (savedWs !== undefined) globalThis.WebSocket = savedWs;
      rawWsServer.close();
    }

    // 6. D-0023: Isolated child-process check for foreign-owner releaseLock protection and locked syncAppStorageCode preservation
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sb-lock-test-'));
    try {
      const agyDir = path.join(tmpHome, '.gemini', 'antigravity');
      const appDataDir = path.join(tmpHome, 'AppData', 'Roaming');
      const agyAppData = path.join(appDataDir, 'Antigravity');
      fs.mkdirSync(agyDir, { recursive: true });
      fs.mkdirSync(agyAppData, { recursive: true });
      fs.writeFileSync(path.join(agyDir, 'statusbar_autoinject.js'), '// v32 test code\n', 'utf8');
      fs.writeFileSync(
        path.join(agyAppData, 'app_storage.json'),
        JSON.stringify({ existingHostSetting: { windowZoom: 1.25 }, 'agy-statusbar-code': 'old' }),
        'utf8'
      );
      const lockFile = path.join(agyDir, 'statusbar_patch.lock');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'foreign-owner-token', startedAt: new Date().toISOString() }), 'utf8');

      const out = execFileSync(
        process.execPath,
        [
          '-e',
          `const p = require(${JSON.stringify(SRC_PATCHER_PATH)});
           if (typeof p.releaseLock === 'function') p.releaseLock();
           const lockSurvived = require('fs').existsSync(${JSON.stringify(lockFile)});
           const synced1 = typeof p.syncAppStorageCode === 'function' ? p.syncAppStorageCode() : false;
           const synced2 = typeof p.syncAppStorageCode === 'function' ? p.syncAppStorageCode() : true;
           console.log(JSON.stringify({ lockSurvived, synced1, synced2 }));`,
        ],
        {
          env: {
            ...process.env,
            USERPROFILE: tmpHome,
            HOME: tmpHome,
            APPDATA: appDataDir,
            LOCALAPPDATA: path.join(tmpHome, 'AppData', 'Local'),
          },
          encoding: 'utf8',
        }
      );
      const parsedOut = JSON.parse(out.trim());
      assert.equal(parsedOut.lockSurvived, true, 'D-0023: releaseLock() must NOT delete a lock owned by another live process/token');
      assert.equal(parsedOut.synced1, true, 'D-0023: syncAppStorageCode() must update when code differs');
      assert.equal(parsedOut.synced2, false, 'D-0023: syncAppStorageCode() must no-op when code already matches');
      const updatedStorage = JSON.parse(fs.readFileSync(path.join(agyAppData, 'app_storage.json'), 'utf8'));
      assert.deepEqual(updatedStorage.existingHostSetting, { windowZoom: 1.25 }, 'D-0023: syncAppStorageCode() must preserve concurrent host keys');
      assert.equal(updatedStorage['agy-statusbar-code'], '// v32 test code\n');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('Round-2 audit reopen (D-0012, D-0020, D-0023, D-0030, D-0032, D-0033): unified TrustedTypes policy, Fail-Closed RPC state & fallback TTL cache, Promise.all rejection recovery, full dispose cleanup, RFC6455 close/interleaving, and lock release race protection', async () => {
    const net = require('node:net');
    const crypto = require('node:crypto');
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    const { createRpcClient } = require('../src/rpc-client');
    const { createHostBridge } = require('../src/host-bridge');
    const { configureTargetViaCdp } = require('../scripts/ensure_statusbar_patch');

    // 1. D-0032: Full mountStatusBar on remote host with strict Chromium TrustedTypes ('trusted-types agy-statusbar', duplicate name throws)
    const createdPolicies = new Set();
    const remoteScriptUrls = [];
    const { sandbox: ttSb } = createDomSandbox();
    ttSb.window.location = { protocol: 'https:', hostname: 'antigravity.google.com', href: 'https://antigravity.google.com/' };
    ttSb.window.__agyHostInstalledPlugins = {
      resolved: true,
      hasStatusbar: true,
      hasMcpManager: true,
      hasKoTranslator: false,
      mcpManagerCode: 'window.agyMcpManager = { version: "mock" };',
    };
    let capturedPolicyRules = null;
    ttSb.window.trustedTypes = {
      createPolicy(name, rules) {
        if (name !== 'agy-statusbar') {
          throw new TypeError(`Refused to create a TrustedTypePolicy named '${name}': violates CSP 'trusted-types agy-statusbar'.`);
        }
        if (createdPolicies.has(name)) {
          throw new TypeError(`Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': Policy with name '${name}' already exists.`);
        }
        createdPolicies.add(name);
        capturedPolicyRules = rules;
        const pol = {};
        if (typeof rules.createHTML === 'function') {
          pol.createHTML = (s) => ({ __ttHtml: String(rules.createHTML(s)) });
        }
        if (typeof rules.createScript === 'function') {
          pol.createScript = (s) => ({ __ttScript: String(rules.createScript(s)) });
        }
        if (typeof rules.createScriptURL === 'function') {
          pol.createScriptURL = (u) => ({ __ttScriptUrl: String(rules.createScriptURL(u)) });
        }
        return pol;
      },
    };
    const origCreateEl = ttSb.document.createElement.bind(ttSb.document);
    ttSb.document.head = {
      appendChild(el) {
        if (el.tagName === 'SCRIPT') {
          if (el.text) {
            // Simulate strict CSP blocking inline script execution asynchronously
            return el;
          }
          if (el.src) {
            if (typeof el.src !== 'object' || !el.src.__ttScriptUrl) {
              throw new TypeError("Failed to set the 'src' property on 'HTMLScriptElement': This document requires 'TrustedScriptURL' assignment.");
            }
            const rawSrc = el.src.__ttScriptUrl;
            if (rawSrc.startsWith('blob:')) {
              // Simulate strict CSP script-src blocking blob: so companion loader falls back to allowed https: URL
              setTimeout(() => el._listeners?.error?.(), 2);
              return el;
            }
            remoteScriptUrls.push(rawSrc);
            setTimeout(() => {
              ttSb.window.agyMcpManager = { version: 'loaded-via-url' };
              el._listeners?.load?.();
            }, 5);
          }
        }
        return el;
      },
    };
    ttSb.document.createElement = (tag) => {
      const el = origCreateEl(tag);
      if (String(tag).toLowerCase() === 'script') {
        el._listeners = {};
        el.addEventListener = (ev, fn) => { el._listeners[ev] = fn; };
        let _text = '';
        Object.defineProperty(el, 'text', {
          get: () => _text,
          set(v) {
            if (typeof v !== 'object' || !v.__ttScript) {
              throw new TypeError("Failed to set the 'text' property on 'HTMLScriptElement': This document requires 'TrustedScript' assignment.");
            }
            _text = v.__ttScript;
          },
        });
      } else {
        const origDesc = Object.getOwnPropertyDescriptor(el, 'innerHTML');
        Object.defineProperty(el, 'innerHTML', {
          get: () => (origDesc && origDesc.get ? origDesc.get.call(el) : ''),
          set() {
            throw new TypeError("D-0032: innerHTML sink must never be invoked when rendering statusbar DOM.");
          },
        });
      }
      return el;
    };

    mountStatusBar({
      window: ttSb.window,
      document: ttSb.document,
      localStorage: ttSb.localStorage,
      fetch: async () => ({ ok: true, json: async () => ({ groups: [], generatorMetadata: [] }) }),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(capturedPolicyRules, 'D-0032: companion loader must register agy-statusbar policy');
    assert.equal(
      typeof capturedPolicyRules.createHTML,
      'undefined',
      'D-0032: TrustedTypes policy must NOT expose a passthrough createHTML callback'
    );
    assert.equal(typeof capturedPolicyRules.createScript, 'function');
    assert.equal(typeof capturedPolicyRules.createScriptURL, 'function');
    assert.ok(
      remoteScriptUrls.some((u) => u.startsWith('https://raw.githubusercontent.com/')),
      'D-0032: companion loader must succeed using the single strict agy-statusbar TrustedTypes policy'
    );
    ttSb.window.__agyStatusBarCleanup?.();

    // 2. D-0033: Fail-Closed when stateCid === null AND no repeated RPC storm when latestState === null
    let rpcFetchCalls = 0;
    const rpcFailClosed = createRpcClient({
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      getAgentStateProviderForInputBox: () => ({
        // Host schema without conversationId / cascadeId -> stateCid === null
        getState: () => ({
          compactedAtStepIndices: [500],
          contextWindowUsage: { estimatedTokensUsed: 331000, estimatedAfterCompaction: 280000, maxContextTokens: 384000 },
        }),
      }),
      fetchFn: async () => {
        rpcFetchCalls += 1;
        return {
          ok: true,
          json: async () => ({
            generatorMetadata: [
              {
                chatModel: {
                  chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 42000, maxContextTokens: 256000 } },
                  usage: { cacheReadTokens: 20000, inputTokens: 22000 },
                },
              },
            ],
          }),
        };
      },
    });
    assert.equal(
      rpcFailClosed.getImmediateStats('session-target', {}),
      null,
      'D-0033: isStateForCascade must Fail-Closed (return false) when stateCid is null/missing'
    );
    const s1 = await rpcFailClosed.fetchCascadeStats('session-target', 'csrf-tok', {});
    const s2 = await rpcFailClosed.fetchCascadeStats('session-target', 'csrf-tok', {});
    const s3 = await rpcFailClosed.fetchCascadeStats('session-target', 'csrf-tok', {});
    assert.equal(s1.used, 42000);
    assert.equal(s2.used, 42000);
    assert.equal(s3.used, 42000);
    assert.equal(
      rpcFetchCalls,
      1,
      `D-0033: fetchCascadeStats must reuse cached entry within 3000ms fallback TTL when latestState is null instead of hammering RPC on every poll (got ${rpcFetchCalls} calls)`
    );
    rpcFailClosed.dispose();

    // 3. D-0012: Promise.all rejection in updateAll must not cause unhandledRejection or freeze previous session metrics
    const { sandbox: rejSb, getMountedBar: getRejBar } = createDomSandbox();
    rejSb.localStorage.setItem(
      'agy-session-ctx-windows-v1',
      JSON.stringify({ 'test-session-1': '256K', 'session-reject-b': '256K' })
    );
    let rejActiveCid = 'test-session-1';
    const rejView = rejSb.document.querySelector('[data-testid="conversation-view"]');
    rejView.getAttribute = (k) => (k === 'data-cascade-id' ? rejActiveCid : null);
    let rejectQuotaNow = false;
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      mountStatusBar({
        window: rejSb.window,
        document: rejSb.document,
        localStorage: rejSb.localStorage,
        fetch: async (url) => {
          if (String(url).includes('RetrieveUserQuotaSummary')) {
            if (rejectQuotaNow) throw new Error('Simulated quota transport failure');
            return { ok: true, json: async () => ({ groups: [] }) };
          }
          if (rejActiveCid === 'session-reject-b') {
            throw new Error('Simulated stats failure');
          }
          return {
            ok: true,
            json: async () => ({
              generatorMetadata: [
                {
                  chatModel: {
                    chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 204800, maxContextTokens: 256000 } },
                    usage: { cacheReadTokens: 100000, inputTokens: 104800 },
                  },
                },
              ],
            }),
          };
        },
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      await new Promise((r) => setTimeout(r, 25));
      const rejCore = getRejBar().querySelector('.agy-ctx-left').querySelector('[data-agy-adapter-id="core-metrics"]');
      assert.ok(rejCore.innerHTML.includes('>80%<'));

      rejActiveCid = 'session-reject-b';
      rejectQuotaNow = true;
      rejSb.window.agyStatusBar.updateAll();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(unhandled.length, 0, 'D-0012: Promise.all in updateAll must catch rejections without unhandledRejection');
      assert.ok(
        rejCore.innerHTML.includes('>0%<'),
        'D-0012: when async fetch fails/returns null on uncached session switch, deferred metrics must unfreeze and render fallback 0%'
      );
      rejSb.window.__agyStatusBarCleanup?.();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // 4. D-0020: hookLsClient without sendUserCascadeMessage & full cleanup of __agyLastAppliedContextWindow*, __agySniffedCascadeId*, __agyCapturedLsClient
    const { sandbox: cleanSb } = createDomSandbox();
    const readOnlyLsClient = {
      retrieveUserQuotaSummary: async () => ({ groups: [] }),
      getCascadeTrajectory: async () => ({ trajectory: { generatorMetadata: [] } }),
    };
    cleanSb.window.__agyCapturedLsClient = readOnlyLsClient;
    mountStatusBar({
      window: cleanSb.window,
      document: cleanSb.document,
      localStorage: cleanSb.localStorage,
      fetch: async () => ({ ok: true, json: async () => ({ groups: [], generatorMetadata: [] }) }),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    });
    cleanSb.window.__agySniffedCascadeId = '11111111-2222-3333-4444-555555555555';
    cleanSb.window.__agySniffedCascadeTs = Date.now();
    cleanSb.window.__agyRcStepCountByCascade = { '11111111-2222-3333-4444-555555555555': 3 };
    cleanSb.window.__agyRcGenLenByCascade = { '11111111-2222-3333-4444-555555555555': 2 };
    cleanSb.window.__agyLastAppliedContextWindow = '1437:256K';
    cleanSb.window.__agyLastAppliedContextWindowByCascade = { 'test-session-1': '1437:256K' };
    // Trigger getRemoteRpcServiceForElement via non-csrf remote update path so hookLsClient runs on readOnlyLsClient
    delete cleanSb.window.__APP_CONFIG__.csrfToken;
    cleanSb.window.agyStatusBar.updateAll();
    await new Promise((r) => setTimeout(r, 20));
    cleanSb.window.__agyStatusBarCleanup();
    assert.equal(
      Object.prototype.hasOwnProperty.call(readOnlyLsClient, '__agyCwHooked') ||
        Object.prototype.hasOwnProperty.call(readOnlyLsClient, '__agyCwHookV2'),
      false,
      'D-0020: hookLsClient markers must be cleaned up on dispose even when sendUserCascadeMessage is absent'
    );
    for (const leakedKey of [
      '__agyLastAppliedContextWindow',
      '__agyLastAppliedContextWindowByCascade',
      '__agySniffedCascadeId',
      '__agySniffedCascadeTs',
      '__agyCapturedLsClient',
      '__agyRcStepCountByCascade',
      '__agyRcGenLenByCascade',
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(cleanSb.window, leakedKey),
        false,
        `D-0020: cleanupStatusBar/dispose must delete window.${leakedKey}`
      );
    }

    // 5. D-0030: Close frame delivery (no immediate destroy RST), fast reject on server 0x08/close, and RFC6455 §5.4 fragmentation interleaving error
    const savedGlobalWs = globalThis.WebSocket;
    delete globalThis.WebSocket;
    try {
      // 5a) Normal close sends 0x08 frame cleanly before socket teardown
      let sawClientCloseFrame = false;
      const srvCloseCheck = net.createServer((socket) => {
        let upgraded = false;
        let buf = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          if (!upgraded) {
            const txt = chunk.toString('utf8');
            if (!txt.includes('\r\n\r\n')) return;
            upgraded = true;
            const key = txt.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)[1].trim();
            const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
            return;
          }
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 6) {
            const op = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) {
              if (buf.length < 8) return;
              len = buf.readUInt16BE(2);
              off = 4;
            }
            if (buf.length < off + 4 + len) return;
            buf = buf.subarray(off + 4 + len);
            if (op === 0x01) {
              const rep = Buffer.from(JSON.stringify({ id: 1, result: { result: { value: 'INJECTED_OK' } } }), 'utf8');
              socket.write(Buffer.concat([Buffer.from([0x81, rep.length]), rep]));
            } else if (op === 0x08) {
              sawClientCloseFrame = true;
              socket.end();
            }
          }
        });
      });
      await new Promise((r) => srvCloseCheck.listen(0, '127.0.0.1', r));
      try {
        const resVal = await configureTargetViaCdp(`ws://127.0.0.1:${srvCloseCheck.address().port}/devtools/page/1`, 'void 0;', 'h1', 1500);
        assert.equal(resVal, 'INJECTED_OK');
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(sawClientCloseFrame, true, 'D-0030: client.close() must flush Close frame (0x08) without immediate sock.destroy() RST');
      } finally {
        srvCloseCheck.close();
      }

      // 5b) Server sends 0x08 Close before CDP reply -> configureTargetViaCdp must reject immediately (<400ms), NOT wait for 2000ms timeout!
      const srvAbruptClose = net.createServer((socket) => {
        let upgraded = false;
        let sentClose = false;
        socket.on('data', (chunk) => {
          if (!upgraded) {
            const txt = chunk.toString('utf8');
            if (!txt.includes('\r\n\r\n')) return;
            upgraded = true;
            const key = txt.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)[1].trim();
            const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
            return;
          }
          if (sentClose) return;
          sentClose = true;
          // Immediately send server Close frame (0x88, 0x00) without replying id:1
          socket.end(Buffer.from([0x88, 0x00]));
        });
      });
      await new Promise((r) => srvAbruptClose.listen(0, '127.0.0.1', r));
      try {
        const t0 = Date.now();
        await assert.rejects(
          () => configureTargetViaCdp(`ws://127.0.0.1:${srvAbruptClose.address().port}/devtools/page/1`, 'void 0;', 'h1', 2000),
          /closed|WebSocket/i,
          'D-0030: configureTargetViaCdp must reject when server sends 0x08 / closes socket'
        );
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 600, `D-0030: server close must reject promptly without waiting for 2000ms timeout (took ${elapsed}ms)`);
      } finally {
        srvAbruptClose.close();
      }

      // 5c) RFC 6455 §5.4: New data frame (opcode=0x01) during active fragmentation (fragOpcode !== 0) must fail with protocol error
      const srvBadFrag = net.createServer((socket) => {
        let upgraded = false;
        let sentBad = false;
        socket.on('data', (chunk) => {
          if (!upgraded) {
            const txt = chunk.toString('utf8');
            if (!txt.includes('\r\n\r\n')) return;
            upgraded = true;
            const key = txt.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)[1].trim();
            const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
            return;
          }
          if (sentBad) return;
          sentBad = true;
          const fragStart = Buffer.from('{"id":1,', 'utf8');
          const illegalNewData = Buffer.from(JSON.stringify({ id: 1, result: { result: { value: 'INJECTED_OK' } } }), 'utf8');
          // FIN=0 opcode=0x01 followed illegally by FIN=1 opcode=0x01 (instead of opcode=0x00 continuation)
          socket.write(Buffer.concat([Buffer.from([0x01, fragStart.length]), fragStart]));
          socket.write(Buffer.concat([Buffer.from([0x81, illegalNewData.length]), illegalNewData]));
        });
      });
      await new Promise((r) => srvBadFrag.listen(0, '127.0.0.1', r));
      try {
        await assert.rejects(
          () => configureTargetViaCdp(`ws://127.0.0.1:${srvBadFrag.address().port}/devtools/page/1`, 'void 0;', 'h1', 1500),
          /fragment|interleaved|protocol|WebSocket/i,
          'D-0030: interleaved data frame during fragmentation must trigger RFC6455 §5.4 protocol error'
        );
      } finally {
        srvBadFrag.close();
      }
    } finally {
      if (savedGlobalWs !== undefined) globalThis.WebSocket = savedGlobalWs;
    }

    // 6. D-0023: Deterministic stale-lock takeover race between readFileSync and renameSync inside releaseLock()
    const raceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sb-relrace-'));
    try {
      const agyDir = path.join(raceHome, '.gemini', 'antigravity');
      const lockFile = path.join(agyDir, 'statusbar_patch.lock');
      const raceOut = execFileSync(
        process.execPath,
        [
          '-e',
          `const fs = require('fs');
           const p = require(${JSON.stringify(SRC_PATCHER_PATH)});
           const acquired = p.acquireLock();
           const origRead = fs.readFileSync.bind(fs);
           let injected = false;
           fs.readFileSync = function(targetPath, ...rest) {
             const res = origRead(targetPath, ...rest);
             if (!injected && String(targetPath) === ${JSON.stringify(lockFile)}) {
               injected = true;
               // Simulate Process B reclaiming stale lock and writing token-B right after Process A's initial readFileSync!
               fs.writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({ pid: 99999, token: 'process-b-fresh-token', startedAt: new Date().toISOString() }), 'utf8');
             }
             return res;
           };
           const released = p.releaseLock();
           fs.readFileSync = origRead;
           const existsAfter = fs.existsSync(${JSON.stringify(lockFile)});
           const survivingToken = existsAfter ? JSON.parse(origRead(${JSON.stringify(lockFile)}, 'utf8')).token : null;
           console.log(JSON.stringify({ acquired, released, existsAfter, survivingToken }));`,
        ],
        {
          env: { ...process.env, USERPROFILE: raceHome, HOME: raceHome },
          encoding: 'utf8',
        }
      );
      const raceRes = JSON.parse(raceOut.trim());
      assert.equal(raceRes.acquired, true);
      assert.equal(raceRes.released, false, 'D-0023: releaseLock must return false when lock was replaced after initial read');
      assert.equal(raceRes.existsAfter, true, 'D-0023: Process B new lock file must survive Process A stale releaseLock');
      assert.equal(raceRes.survivingToken, 'process-b-fresh-token', 'D-0023: Process B lock token must remain intact');
    } finally {
      fs.rmSync(raceHome, { recursive: true, force: true });
    }
  });

  it('SB-TC-035 Round-3 audit reopen (D-0020, D-0032): zero-innerHTML createTrustedHtmlSetter, strict allowlist TrustedTypes policy rejecting arbitrary scripts/URLs, and residual policy global cleanup', async () => {
    const { createTrustedHtmlSetter } = require('../src/dom-styles');

    // 1. D-0032: createTrustedHtmlSetter must NEVER call createPolicy and NEVER write innerHTML
    let htmlPolicyCalls = 0;
    const { sandbox: domSb } = createDomSandbox();
    domSb.window.trustedTypes = {
      createPolicy() {
        htmlPolicyCalls += 1;
        throw new Error('D-0032: createTrustedHtmlSetter must not create any TrustedTypes policy');
      },
    };
    const hostSpan = domSb.document.createElement('span');
    Object.defineProperty(hostSpan, 'innerHTML', {
      get: () => hostSpan.childNodes.map((c) => c.textContent || '').join(''),
      set() {
        throw new TypeError('D-0032: innerHTML assignment is strictly forbidden');
      },
    });
    const setHtml = createTrustedHtmlSetter(domSb.window, domSb.document);
    setHtml(hostSpan, '<strong class="agy-ctx-pct-val">77%</strong><script>evil()</script>');
    assert.equal(htmlPolicyCalls, 0, 'D-0032: createTrustedHtmlSetter must make zero createPolicy calls');
    assert.equal(hostSpan.querySelector('.agy-ctx-pct-val')?.textContent, '77%');
    assert.equal(hostSpan.querySelector('script'), null);

    // 2. D-0032: Companion TrustedTypes policy must NOT expose createHTML and MUST reject arbitrary scripts & untrusted URLs
    let capturedRules = null;
    const inlineCodeSample = 'window.agyMcpManager = { version: "1.4.18" };';
    const strictWin = {
      location: { protocol: 'https:', hostname: 'antigravity.google.com', href: 'https://antigravity.google.com/' },
      __agyHostInstalledPlugins: {
        resolved: true,
        hasStatusbar: true,
        hasMcpManager: true,
        hasKoTranslator: false,
        mcpManagerCode: inlineCodeSample,
      },
      trustedTypes: {
        createPolicy(name, rules) {
          capturedRules = rules;
          return {
            name,
            createScript: (s) => ({ __brand: 'script', val: rules.createScript(s) }),
            createScriptURL: (u) => ({ __brand: 'url', val: rules.createScriptURL(u) }),
          };
        },
      },
    };
    const strictDoc = {
      head: {
        appendChild(el) {
          if (el.text && el.text.__brand === 'script') {
            strictWin.agyMcpManager = { version: '1.4.18' };
          }
          return el;
        },
      },
      createElement(tag) {
        return { tagName: tag.toUpperCase() };
      },
      querySelector: () => null,
    };
    await ensureRemoteCompanionScripts(strictWin, strictDoc, null, null);
    assert.ok(capturedRules, 'D-0032: strict TrustedTypes policy rules must be created');
    assert.equal(typeof capturedRules.createHTML, 'undefined', 'D-0032: createHTML must NOT exist on TrustedTypes policy');
    assert.throws(
      () => capturedRules.createScript('alert(1)'),
      TypeError,
      'D-0032: arbitrary inline script must be rejected with TypeError'
    );
    assert.throws(
      () => capturedRules.createScript(inlineCodeSample),
      TypeError,
      'D-0032: one-shot inline script token must be revoked immediately after injection'
    );
    assert.throws(
      () => capturedRules.createScriptURL('javascript:alert(1)'),
      TypeError,
      'D-0032: javascript: URL must be rejected with TypeError'
    );
    assert.throws(
      () => capturedRules.createScriptURL('http://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js'),
      TypeError,
      'D-0032: plaintext http: URL must be rejected with TypeError'
    );
    assert.throws(
      () => capturedRules.createScriptURL('https://evil.example/pwn.js'),
      TypeError,
      'D-0032: untrusted external domain must be rejected with TypeError'
    );
    assert.throws(
      () => capturedRules.createScriptURL('blob:https://antigravity.google.com/unregistered-forged-blob'),
      TypeError,
      'D-0032: forged unregistered blob: URL must be rejected with TypeError'
    );
    assert.equal(
      capturedRules.createScriptURL('https://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js?t=12345'),
      'https://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js?t=12345',
      'D-0032: allowlisted official https: companion script URL must be permitted'
    );

    // 3. D-0020: cleanupStatusBar() must clean up residual __agyTrustedTypesPolicy / __agyTrustedHtmlPolicy when companion is inactive
    const { sandbox: cleanSb } = createDomSandbox();
    cleanSb.window.__agyTrustedTypesPolicy = { legacy: true };
    cleanSb.window.__agyTrustedHtmlPolicy = { legacy: true };
    mountStatusBar({
      window: cleanSb.window,
      document: cleanSb.document,
      localStorage: cleanSb.localStorage,
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    });
    cleanSb.window.__agyStatusBarCleanup();
    assert.equal(
      Object.prototype.hasOwnProperty.call(cleanSb.window, '__agyTrustedTypesPolicy'),
      false,
      'D-0020: cleanupStatusBar must delete window.__agyTrustedTypesPolicy when companion is inactive'
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(cleanSb.window, '__agyTrustedHtmlPolicy'),
      false,
      'D-0020: cleanupStatusBar must delete window.__agyTrustedHtmlPolicy when companion is inactive'
    );
  });
});
