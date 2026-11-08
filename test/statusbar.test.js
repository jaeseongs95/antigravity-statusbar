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

    // 4. ANTIGRAVITY_STATUSBAR-D-0013 regression:
    //    - applyContextWindowToEngine must NOT dispatch pick: { atStep: 999999 }
    //    - applying a context window to a Low (1419) session must preserve global default.model as Medium (1418)
    //    - sessions previously poisoned with pick: { atStep: 999999 } and model: 1419 (Low) while syncedKey says Medium (1418) must be recovered to 1418
    const dispatchedActions = [];
    const fakeReduxState = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 1417 } },
            { label: 'Gemini 4 Argon (Medium)', modelOrAlias: { model: 1418 } },
            { label: 'Gemini 4 Argon (Low)', modelOrAlias: { model: 1419 } },
          ],
          defaultOverrideModelConfig: { modelOrAlias: { model: 1418 } },
        },
      },
      modelSelection: {
        byConversation: {
          'poisoned-convo': { model: 1419, customLabel: 'Gemini 4 Argon (Low)', contextWindow: '384K' },
          'low-convo': { model: 1419, customLabel: 'Gemini 4 Argon (Low)', contextWindow: '256K' },
        },
        default: { model: 1418, customLabel: undefined, contextWindow: '512K' },
        trajectorySync: {
          'poisoned-convo': {
            syncedKey: 'exec-1:10:Gemini 4 Argon (Medium):384K',
            pick: { atStep: 999999, queuedMessageIds: [] },
          },
          'low-convo': {
            syncedKey: 'exec-2:5:Gemini 4 Argon (Low):256K',
          },
        },
      },
    };

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

    const appliedOk = hbRedux.applyContextWindowToEngine(reduxView, 'low-convo', '384K');
    assert.equal(appliedOk, true);
    assert.equal(
      fakeReduxState.modelSelection.default.model,
      1418,
      'global default.model must remain Medium (1418) even after applying context window to a Low (1419) conversation'
    );
    assert.equal(
      fakeReduxState.modelSelection.byConversation['poisoned-convo'].model,
      1418,
      'poisoned conversation with atStep=999999 and syncedKey Medium must be recovered from Low (1419) to Medium (1418)'
    );
    assert.notEqual(
      fakeReduxState.modelSelection.trajectorySync['poisoned-convo']?.pick?.atStep,
      999999,
      'poisoned pick.atStep=999999 must be cleared so trajectoryModelObserved sync works'
    );
    assert.equal(
      dispatchedActions.some((a) => a.payload?.pick?.atStep === 999999),
      false,
      'applyContextWindowToEngine must never dispatch pick.atStep === 999999'
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
});
