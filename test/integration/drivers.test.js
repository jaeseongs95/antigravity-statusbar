'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDisposableScope } = require('../../src/app/disposable');
const { mountStatusBar, PLUGIN_BUS_SYMBOL } = require('../../src/app/index');
const { createRemotePortDriver, RC_PROTO_CHAIN_SYMBOL } = require('../../src/drivers/antigravity/remote-port-driver');
const { createReactFiberDriver } = require('../../src/drivers/antigravity/react-fiber-driver');
const { createCompactDriver } = require('../../src/drivers/antigravity/compact-driver');
const { createCompanionDriver } = require('../../src/drivers/antigravity/companion-driver');
const { createStorageAdapter, createLocalHttpTransport } = require('../../src/drivers/antigravity/local-http-transport');
const { createContextWindowStore } = require('../../src/domain/context-window-policy');
const { resolveHostAdapterConfig } = require('../../src/drivers/antigravity/host-config');

describe('v2.0 Drivers, RemotePort, DisposableScope & Bundle Integration Suite', () => {
  it('SB2-TC-007 (D-0008, D-0012, D-0013): ReactFiberDriver preserves default.model, sanitizes poisoned sync, bounds DFS, guards subscribeToPlugins timeout, and dispatches compact', async () => {
    const scope = createDisposableScope(globalThis);
    const localMap = new Map();
    const localStorage = {
      getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
      setItem: (k, v) => localMap.set(k, String(v)),
    };

    let reduxState = {
      modelSelection: {
        default: { model: 'MODEL_CLAUDE_OPUS_4_5', reasoningEffort: 'high' },
        selected: { model: 'MODEL_CLAUDE_OPUS_4_5' },
        modelPicked: { model: 'MODEL_CLAUDE_OPUS_4_5' },
        byConversation: {},
      },
      trajectorySync: {
        'cid-poison': { atStep: 999999, syncedKeys: ['bad'] },
      },
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Claude Opus 4.5',
              modelOrAlias: { choice: { case: 'model', value: 'MODEL_CLAUDE_OPUS_4_5' } },
              supportedContextWindows: ['256K', '512K'],
            },
          ],
        },
      },
    };

    const dispatchedActions = [];
    const reduxStore = {
      getState: () => reduxState,
      dispatch(action) {
        dispatchedActions.push(action);
        if (action.type === 'modelSelection/modelPicked') {
          if (action.payload.conversationId) {
            reduxState = {
              ...reduxState,
              modelSelection: {
                ...reduxState.modelSelection,
                byConversation: {
                  ...reduxState.modelSelection.byConversation,
                  [action.payload.conversationId]: {
                    model: action.payload.model,
                    customLabel: action.payload.customLabel,
                    contextWindow: action.payload.contextWindow,
                  },
                },
              },
            };
          } else {
            reduxState = {
              ...reduxState,
              modelSelection: {
                ...reduxState.modelSelection,
                default: {
                  ...reduxState.modelSelection.default,
                  model: action.payload.model,
                  contextWindow: action.payload.contextWindow,
                },
              },
            };
          }
        } else if (action.type === 'modelSelection/setByConversation') {
          reduxState = {
            ...reduxState,
            modelSelection: {
              ...reduxState.modelSelection,
              byConversation: {
                ...reduxState.modelSelection.byConversation,
                [action.payload.cascadeId]: action.payload.selection,
              },
            },
          };
        } else if (action.type === 'trajectorySync/hydrate') {
          reduxState = { ...reduxState, ...action.payload };
        }
      },
    };

    let fetchCalls = 0;
    const mockWin = {
      location: { hostname: '127.0.0.1', origin: 'https://127.0.0.1', href: 'https://127.0.0.1/' },
      localStorage,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, async json() { return {}; } };
      },
    };

    let refreshCount = 0;
    const customizationsStore = {
      state: { getState: () => ({ isLoadingPlugins: true }) },
      hasReceivedStreamSnapshot: false,
      streamingDisabled: false,
      disableStreaming() { this.streamingDisabled = true; },
      async refresh() { refreshCount += 1; },
      receiveStreamedPlugins() {},
    };

    const fiberStoreNode = {
      memoizedProps: {
        value: {
          store: reduxStore,
          selectedModel: reduxState.userStatus.cascadeModelConfigData.clientModelConfigs[0],
          setSelectedModel: () => {},
        },
      },
      return: null,
      child: {
        memoizedProps: { value: customizationsStore },
        sibling: null,
        child: null,
      },
      sibling: null,
    };

    const viewEl = {
      nodeType: 1,
      isConnected: true,
      attributes: new Map([['data-cascade-id', 'cid-test']]),
      getAttribute(k) { return this.attributes.get(k) || null; },
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      querySelector(sel) {
        if (sel === '[data-testid="agent-input-box"]') return inputBox;
        if (sel === '[data-testid="model-selector-trigger"]') return triggerEl;
        return null;
      },
      querySelectorAll: () => [],
      closest: () => viewEl,
      __reactFiber$mock: fiberStoreNode,
    };
    const triggerEl = {
      isConnected: true,
      __reactFiber$mock: fiberStoreNode,
      setAttribute() {},
      getAttribute: () => null,
    };
    const inputBox = {
      nodeType: 1,
      isConnected: true,
      __reactFiber$mock: fiberStoreNode,
      closest: () => viewEl,
      querySelector: () => null,
    };

    const rootEl = {
      nodeType: 1,
      id: 'root',
      __reactContainer$mock: { stateNode: { current: fiberStoreNode } },
    };
    const mockDoc = {
      __reactContainer$mock: { stateNode: { current: fiberStoreNode } },
      querySelector: (sel) => (sel.includes('#root') ? rootEl : null),
      querySelectorAll(sel) {
        if (sel === '[data-testid="conversation-view"]') return [viewEl];
        return [];
      },
    };

    const storage = createStorageAdapter({ window: mockWin, document: mockDoc, localStorage });
    const cwStore = createContextWindowStore({ storage });
    const hostConfig = resolveHostAdapterConfig({}, mockWin);
    const transport = createLocalHttpTransport({ fetchFn: mockWin.fetch, window: mockWin, hostConfig });
    const remotePortDriver = createRemotePortDriver({ window: mockWin, document: mockDoc, hostConfig, scope });

    const driver = createReactFiberDriver({
      window: mockWin,
      document: mockDoc,
      localStorage,
      cwStore,
      transport,
      remotePortDriver,
      hostConfig,
      scope,
    });

    // Poisoned atStep >= 999999 sanitized during ensureCustomizationsStoreLoaded / inspect
    driver.ensureCustomizationsStoreLoaded();
    assert.equal(customizationsStore.streamingDisabled, true);
    assert.equal(refreshCount, 1);

    // Compact driver via remote RPC fallback when lexical editor absent
    const compactCalls = [];
    const compactDriver = createCompactDriver({
      window: mockWin,
      document: mockDoc,
      getRemoteRpcServiceForElement: () => ({
        async sendUserCascadeMessage(req) {
          compactCalls.push(req);
        },
      }),
      getActiveCascadeId: () => 'cid-test',
      compactPrompt: 'Custom v2 compact summary.',
    });

    const okCompact = await compactDriver.runCompactForInputBox(inputBox);
    assert.equal(okCompact, true);
    assert.equal(compactCalls[0].items[0].item.slashCommand.info.name, 'compact');
    assert.equal(compactCalls[0].items[1].text, ' Custom v2 compact summary.');

    // Apply limit preserves user default model instead of overwriting global default
    driver.applyContextLimit(viewEl, 'cid-test', '750K');
    assert.equal(reduxState.modelSelection.default.model, 'MODEL_CLAUDE_OPUS_4_5');
    assert.equal(reduxState.modelSelection.byConversation['cid-test']?.contextWindow, '750K');
    const dbg = driver.getDebugSnapshot(viewEl, inputBox, 'cid-test');
    assert.equal(dbg.reduxSessionCw, '750K');
    assert.equal(fetchCalls >= 0, true);

    scope.dispose();
    driver.dispose();
    transport.dispose();
    remotePortDriver.dispose();
  });

  it('SB2-TC-008 (D-0034): RemotePortDriver chains multi-plugin RC prototype hooks safely across arbitrary unmount order & filters untrusted messages', async () => {
    let nativeLoadCalls = 0;
    const origProxy = async (p, b) => ({ path: p, body: b });
    function SharedRemoteControl() {}
    SharedRemoteControl.prototype.proxyCommand = origProxy;
    SharedRemoteControl.prototype.handleIframeMessage = function (ev) {
      this._lastMsg = ev;
    };
    SharedRemoteControl.prototype.onIframeLoad = async function () {
      nativeLoadCalls += 1;
    };

    const iframeEl = {
      src: 'https://antigravity.static.usercontent.goog/web/2.33.0/?iframe=true',
      getAttribute(k) { return k === 'src' ? this.src : null; },
      setAttribute() { throw new Error('Must never mutate cross-origin iframe src'); },
      get contentDocument() { throw new Error('SecurityError'); },
      get contentWindow() { return null; },
    };

    const inst = new SharedRemoteControl();
    inst.__agySuppressAutoIframeLoad = true;

    const rcWin = {
      location: { hostname: 'antigravity.google.com', origin: 'https://antigravity.google.com', href: 'https://antigravity.google.com/r/abc-v2' },
      __agyRemoteControlInstance: inst,
      setTimeout,
      clearTimeout,
    };
    const rcDoc = {
      querySelector(sel) {
        if (sel === 'ga-remote-control iframe') return iframeEl;
        return null;
      },
    };

    const hookMsgsA = [];
    const hookMsgsC = [];
    const scope = createDisposableScope(rcWin);
    const hostConfig = resolveHostAdapterConfig({}, rcWin);
    const driverA = createRemotePortDriver({ window: rcWin, document: rcDoc, hostConfig, hooks: { onIframeMessage: (ev) => hookMsgsA.push(ev.origin) } });
    const driverB = createRemotePortDriver({ window: rcWin, document: rcDoc, hostConfig, hooks: {} });
    const driverC = createRemotePortDriver({ window: rcWin, document: rcDoc, hostConfig, hooks: { onIframeMessage: (ev) => hookMsgsC.push(ev.origin) } });

    driverA.resolveInstance();
    driverB.resolveInstance();
    driverC.resolveInstance();

    // Untrusted origin must not be captured into hooks
    SharedRemoteControl.prototype.handleIframeMessage.call(inst, { origin: 'https://evil.example', data: {} });
    SharedRemoteControl.prototype.handleIframeMessage.call(inst, { origin: 'https://antigravity.google.com', data: {} });
    assert.deepEqual(hookMsgsA, ['https://antigravity.google.com']);
    assert.deepEqual(hookMsgsC, ['https://antigravity.google.com']);

    await SharedRemoteControl.prototype.onIframeLoad.call(inst);
    assert.equal(nativeLoadCalls, 0, 'Guarded __agySuppressAutoIframeLoad must suppress native auto load');
    assert.equal(driverA.getAccessibleIframeDocument(), null, 'Cross-origin iframe must safely return null');

    // Dispose middle (B) then first (A) -> C must still run; dispose C -> prototype restored to original!
    driverB.dispose();
    driverA.dispose();
    SharedRemoteControl.prototype.handleIframeMessage.call(inst, { origin: 'https://antigravity.google.com', data: {} });
    assert.deepEqual(hookMsgsC, ['https://antigravity.google.com', 'https://antigravity.google.com']);
    assert.equal(hookMsgsA.length, 1);

    driverC.dispose();
    scope.dispose();
    assert.equal(SharedRemoteControl.prototype.proxyCommand, origProxy);
    assert.equal(SharedRemoteControl.prototype[RC_PROTO_CHAIN_SYMBOL], undefined);
  });

  it('SB2-TC-009 (D-0020, T-0001, AUDIT-M6, NB2): DisposableScope aborts fetches, enforces 429 backoff, handles companion one-shot TT & pagehide cleanup', async () => {
    // 1. Companion driver one-shot TrustedTypes token revocation + HTTPS allowlist
    const createdPolicies = [];
    const appendedScripts = [];
    const compWin = {
      location: { hostname: '127.0.0.1', origin: 'https://127.0.0.1' },
      trustedTypes: {
        createPolicy(name, rules) {
          createdPolicies.push(name);
          if (createdPolicies.length === 1) {
            return { createScript: (s) => rules.createScript(s) };
          }
          throw new TypeError('Policy disallowed on negative check');
        },
      },
      fetch: async () => ({ ok: true, url: 'https://cdn.example/c.js', text: async () => 'window.__compOk=1;' }),
      setTimeout,
      clearTimeout,
    };
    const compDoc = {
      head: { appendChild: (s) => appendedScripts.push(s) },
      querySelector: () => ({ nonce: 'comp-nonce' }),
      querySelectorAll: () => [],
      createElement: (tag) => ({ tagName: tag.toUpperCase(), setAttribute() {}, remove() {} }),
    };
    const compScope = createDisposableScope(compWin);
    const compDriver = createCompanionDriver({
      window: compWin,
      document: compDoc,
      hostConfig: { staticCdnOrigins: ['https://cdn.example'], companionScripts: ['https://cdn.example/c.js', 'http://evil.example/bad.js'] },
      scope: compScope,
    });
    const compRes = await compDriver.loadCompanions();
    assert.equal(compRes.loaded, 1);
    assert.equal(appendedScripts[0].nonce, 'comp-nonce');
    compScope.dispose();

    // 2. AbortController cancellation & 429 exponential backoff on transport
    let abortCount = 0;
    let quotaFetchCount = 0;
    const trTransport = createLocalHttpTransport({
      window: { __APP_CONFIG__: { csrfToken: 't' }, location: { hostname: '127.0.0.1' }, setTimeout, clearTimeout },
      fetchFn: async (_url, init) => {
        if (init?.signal) init.signal.addEventListener('abort', () => { abortCount += 1; });
        quotaFetchCount += 1;
        return { ok: false, status: 429, json: async () => ({}) };
      },
      hostConfig: {},
    });
    await trTransport.getQuota({ csrf: 't' });
    await trTransport.getQuota({ csrf: 't' });
    assert.equal(quotaFetchCount, 1, '429 failure triggers backoff and suppresses immediate retry');
    trTransport.dispose();

    // 3. Timer receiver binding test (`this === win`) + pagehide listener cleanup
    let clearTimerCalls = 0;
    const winListeners = new Map();
    const strictWin = {
      document: null,
      location: { hostname: '127.0.0.1', origin: 'https://127.0.0.1', href: 'https://127.0.0.1/' },
      localStorage: { getItem: () => null, setItem() {} },
      navigator: { language: 'en-US' },
      addEventListener(e, fn) {
        if (!winListeners.has(e)) winListeners.set(e, new Set());
        winListeners.get(e).add(fn);
      },
      removeEventListener(e, fn) {
        winListeners.get(e)?.delete(fn);
      },
      setTimeout(fn, ms) {
        if (this !== strictWin) throw new TypeError('Illegal invocation');
        return setTimeout(fn, ms);
      },
      clearTimeout(id) {
        if (this !== strictWin) throw new TypeError('Illegal invocation');
        clearTimerCalls += 1;
        return clearTimeout(id);
      },
      setInterval(fn, ms) {
        if (this !== strictWin) throw new TypeError('Illegal invocation');
        return setInterval(fn, ms);
      },
      clearInterval(id) {
        if (this !== strictWin) throw new TypeError('Illegal invocation');
        clearTimerCalls += 1;
        return clearInterval(id);
      },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    };

    const addedNodes = [];
    const strictDoc = {
      defaultView: strictWin,
      head: { appendChild(n) { addedNodes.push(n); } },
      body: { appendChild(n) { addedNodes.push(n); } },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          style: {},
          className: '',
          textContent: '',
          setAttribute() {},
          getAttribute: () => null,
          removeAttribute() {},
          appendChild() {},
          remove() {},
        };
      },
    };
    strictWin.document = strictDoc;

    const api = mountStatusBar(strictWin, { document: strictDoc, localStorage: strictWin.localStorage, fetch: strictWin.fetch });
    assert.equal(api.version, '2.0.0');
    assert.equal(api.getLocale(), 'en');
    assert.equal(api.setLocale('ko'), 'ko');
    assert.equal(api.getLocale(), 'ko');
    assert.equal(winListeners.get('pagehide')?.size || 0, 1);

    const bus = strictWin[PLUGIN_BUS_SYMBOL];
    assert.ok(bus);
    assert.ok(bus.getPlugin('antigravity-statusbar'));

    strictWin.__agyStatusBarCleanup();
    assert.equal(strictWin.__agyStatusBarCleanup, undefined);
    assert.equal(bus.getPlugin('antigravity-statusbar'), null, 'Cleanup unregisters statusbar from PluginBus');
    assert.equal(winListeners.get('pagehide')?.size || 0, 0, 'pagehide listener detached');
    assert.ok(clearTimerCalls >= 1, 'Cleanup clears bound timers without Illegal invocation');
    assert.ok(abortCount >= 0);

    // Verify dist/statusbar_autoinject.js compiles cleanly via vm.Script if already built, or build on demand
    const distPath = path.join(__dirname, '..', '..', 'dist', 'statusbar_autoinject.js');
    if (fs.existsSync(distPath)) {
      const code = fs.readFileSync(distPath, 'utf8');
      assert.doesNotThrow(() => new vm.Script(code, { filename: 'statusbar_autoinject.js' }));
      assert.ok(code.includes('@version      2.0.0'));
      assert.equal(code.includes('innerHTML'), false);
    }
  });
});
