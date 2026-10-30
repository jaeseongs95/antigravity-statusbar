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

    const rightSlot = hostBarEl.querySelector('.agy-ctx-right');
    const compactBtn = rightSlot.querySelector('[data-agy-adapter-id="compact"]');
    await compactBtn.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.ok(sentCompactPayload, 'clicking [ compact ] on ga-remote-control should send SendUserCascadeMessage via proxyCommand');
    assert.equal(sentCompactPayload.cascadeId, '1f3f7633-f0b7-4fc7-a958-9fb667c85623');
    assert.equal(sentCompactPayload.items[0].item.slashCommand.info.name, 'compact');

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
});
