'use strict';

const { CONTEXT_WINDOWS, createContextWindowStore } = require('./context-window-policy');
const { ensureStyleElement, createTrustedHtmlSetter } = require('./dom-styles');
const { registerCustomCwInPrototype, createHostBridge } = require('./host-bridge');
const { createRpcClient } = require('./rpc-client');
const { createAdapterRegistry } = require('./adapter-registry');
const { createCoreMetricsAdapter } = require('./adapters/core-metrics');
const { createCompactButtonAdapter } = require('./adapters/compact-button');
const { createContextButtonAdapter } = require('./adapters/context-button');

const STATUSBAR_VERSION = 'v9';

function mountStatusBar(env = {}) {
  const win = env.window || (typeof window !== 'undefined' ? window : null);
  const doc = env.document || win?.document || (typeof document !== 'undefined' ? document : null);
  const ls = env.localStorage || win?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const fetchFn = env.fetch || win?.fetch || (typeof fetch !== 'undefined' ? fetch : null);

  if (!win || !doc) return null;

  if (win.__agyStatusBarActiveVersion === STATUSBAR_VERSION && win.__agyStatusBarCleanup) {
    return win.agyStatusBar;
  }
  if (win.__agyStatusBarCleanup) {
    try { win.__agyStatusBarCleanup(); } catch {}
  }
  win.__agyStatusBarActiveVersion = STATUSBAR_VERSION;

  const underDefaultCwSet = new Set(['128K', '256K']);
  const refreshStyles = () => ensureStyleElement(doc, underDefaultCwSet);

  const cwStore = createContextWindowStore({
    document: doc,
    localStorage: ls,
    nativeStorage: win.nativeStorage,
    onCustomCw: (cw) => registerCustomCwInPrototype(cw, underDefaultCwSet, refreshStyles),
  });

  refreshStyles();

  const setHtml = createTrustedHtmlSetter(win, doc);
  const hostBridge = createHostBridge({
    window: win,
    document: doc,
    localStorage: ls,
    cwStore,
  });

  const rpcClient = createRpcClient({
    fetchFn,
    localStorage: ls,
    getAgentStateProviderForInputBox: hostBridge.getAgentStateProviderForInputBox,
    getRemoteRpcServiceForElement: hostBridge.getRemoteRpcServiceForElement,
  });

  function getConversationContextWindow(view, cascadeId) {
    if (cascadeId && !cwStore.hasSessionOverride(cascadeId)) {
      const info = hostBridge.getModelSelectorContextForView(view);
      const reduxCw = info?.reduxStore?.getState?.()?.modelSelection?.byConversation?.[cascadeId]?.contextWindow;
      cwStore.seedSessionIfEmpty(cascadeId, reduxCw);
    }
    const saved = cwStore.getSavedContextWindow(cascadeId);
    hostBridge.applyContextWindowToEngine(view, cascadeId, saved);
    return saved;
  }

  function setConversationContextWindow(view, cascadeId, rawTargetCw) {
    const norm = cwStore.saveContextWindowSetting(cascadeId, rawTargetCw);
    if (!norm) return null;
    if (view) {
      view.__lastAppliedTargetCw = norm;
      view.__lastObservedDomCw = norm;
      view.__ignoreDomCwUntil = Date.now() + 500;
    }
    hostBridge.applyContextWindowToEngine(view, cascadeId, norm, true);
    return norm;
  }

  function cycleConversationContextWindow(view, cascadeId) {
    const current = cwStore.getSavedContextWindow(cascadeId);
    const idx = CONTEXT_WINDOWS.indexOf(current);
    const next = CONTEXT_WINDOWS[(idx + 1) % CONTEXT_WINDOWS.length];
    setConversationContextWindow(view, cascadeId, next);
    return next;
  }

  const registry = createAdapterRegistry({
    window: win,
    document: doc,
    setHtml,
    onUpdate: () => updateAll(),
  });

  const coreMetricsAdapter = createCoreMetricsAdapter({
    document: doc,
    setHtml,
    cwStore,
    getConversationContextWindow,
    setConversationContextWindow,
    cycleConversationContextWindow,
    updateAll: () => updateAll(),
  });

  const compactButtonAdapter = createCompactButtonAdapter({
    runCompactForInputBox: hostBridge.runCompactForInputBox,
  });

  const contextButtonAdapter = createContextButtonAdapter({
    window: win,
    document: doc,
    fetchFn,
    setHtml,
    cwStore,
    hostBridge,
  });

  registry.registerBuiltinAdapters([
    coreMetricsAdapter,
    compactButtonAdapter,
    contextButtonAdapter,
  ]);

  function renderBar(barEl, view, inputBox, stats, quota) {
    const cascadeId = view.getAttribute('data-cascade-id');
    const { leftEl, rightEl } = registry.ensureBarStructure(barEl);
    const ctx = {
      barEl,
      view,
      inputBox,
      cascadeId,
      stats,
      quota,
      updateAll,
      getConversationContextWindow: () => getConversationContextWindow(view, cascadeId),
      setConversationContextWindow: (cw) => setConversationContextWindow(view, cascadeId, cw),
    };
    registry.renderSlotAdapters(leftEl, 'left', ctx);
    registry.renderSlotAdapters(rightEl, 'right', ctx);
  }

  function updateAll() {
    refreshStyles();
    hostBridge.ensureContextWindowSelectorFlag();
    hostBridge.ensureRemoteHostView(() => updateAll());
    const csrf = win.__APP_CONFIG__ && win.__APP_CONFIG__.csrfToken;
    const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    if (!views.length) return;
    if (!csrf && !hostBridge.getRemoteRpcServiceForElement(views[0])) return;

    const quotaPromise = rpcClient.fetchQuota(csrf, views[0]);

    for (const view of views) {
      const cascadeId = view.getAttribute('data-cascade-id');
      const inputBox = view.querySelector('[data-testid="agent-input-box"]');
      if (!cascadeId || !inputBox) continue;

      const triggerEl = view.querySelector('[data-testid="model-selector-trigger"]');
      const domCw = cwStore.normalize(triggerEl ? triggerEl.getAttribute('data-context-window') : null);
      const canAdoptFromDom = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
      if (canAdoptFromDom && domCw && CONTEXT_WINDOWS.includes(domCw) && view.__lastObservedDomCw && view.__lastObservedDomCw !== domCw) {
        const savedCw = cwStore.getSavedContextWindow(cascadeId);
        if (domCw !== savedCw && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
          cwStore.saveContextWindowSetting(cascadeId, domCw);
        }
      }

      const targetCw = cwStore.getSavedContextWindow(cascadeId);
      hostBridge.applyContextWindowToEngine(view, cascadeId, targetCw);
      view.__lastAppliedTargetCw = targetCw;
      if (triggerEl && canAdoptFromDom) {
        view.__lastObservedDomCw = triggerEl.getAttribute('data-context-window') || targetCw;
      }

      let barEl = inputBox.querySelector('.agy-ctx-statusbar');
      if (!barEl) {
        barEl = doc.createElement('div');
        barEl.className = 'agy-ctx-statusbar';
        inputBox.appendChild(barEl);
      }

      const cachedData = rpcClient.getCachedStats(cascadeId);

      Promise.all([
        rpcClient.fetchCascadeStats(cascadeId, csrf, inputBox),
        quotaPromise,
      ]).then(([data, freshQuota]) => {
        if (!barEl.isConnected || view.getAttribute('data-cascade-id') !== cascadeId) return;
        const finalData = data || cachedData;
        renderBar(barEl, view, inputBox, finalData, freshQuota || rpcClient.getLatestQuota());
      });
    }
  }

  win.agyStatusBar = {
    version: STATUSBAR_VERSION,
    registerAdapter: registry.registerAdapter,
    unregisterAdapter: registry.unregisterAdapter,
    getAdapters: registry.getAdapters,
    updateAll,
    getConversationContextWindow,
    setConversationContextWindow,
  };

  cwStore.loadPersistentContextSettings().then(() => {
    updateAll();
  });
  updateAll();

  const setIntervalFn = env.setInterval || win.setInterval || setInterval;
  const clearIntervalFn = env.clearInterval || win.clearInterval || clearInterval;
  const timer = setIntervalFn(updateAll, 3000);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  const ObsClass = env.MutationObserver || win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
  const obs = ObsClass ? new ObsClass(() => {
    const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    for (const view of views) {
      const cid = view.getAttribute('data-cascade-id');
      const box = view.querySelector('[data-testid="agent-input-box"]');
      if (box && (!box.querySelector('.agy-ctx-statusbar') || box.__lastCascadeId !== cid)) {
        box.__lastCascadeId = cid;
        updateAll();
        return;
      }
      const trigger = view.querySelector('[data-testid="model-selector-trigger"]');
      if (cid && trigger) {
        const actual = cwStore.normalize(trigger.getAttribute('data-context-window')) || '256K';
        const expected = cwStore.getSavedContextWindow(cid);
        const model = hostBridge.getSelectedModelKey(view, cid);
        const expectedKey = (model || '') + ':' + String(expected);
        if (actual !== expected && win.__agyLastAppliedContextWindow !== expectedKey) {
          const canAdopt = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
          if (canAdopt && CONTEXT_WINDOWS.includes(actual) && view.__lastObservedDomCw && view.__lastObservedDomCw !== actual && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
            cwStore.saveContextWindowSetting(cid, actual);
            view.__lastAppliedTargetCw = actual;
            view.__lastObservedDomCw = actual;
            updateAll();
          } else {
            hostBridge.applyContextWindowToEngine(view, cid, expected);
            view.__lastObservedDomCw = trigger.getAttribute('data-context-window') || expected;
          }
        }
      }
    }
  }) : null;

  function attachBodyObserver() {
    if (!obs) return;
    const rootTarget = doc.body || doc.documentElement;
    if (!rootTarget) {
      win.addEventListener?.('DOMContentLoaded', attachBodyObserver, { once: true });
      return;
    }
    obs.observe(rootTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cascade-id', 'data-context-window'],
    });
  }
  attachBodyObserver();

  win.__agyStatusBarCleanup = () => {
    delete win.__agyStatusBarActiveVersion;
    clearIntervalFn(timer);
    if (obs) obs.disconnect();
    const m = doc.getElementById('agy-ctx-debug-modal');
    if (m) m.remove();
    const bars = doc.querySelectorAll('.agy-ctx-statusbar');
    for (const b of bars) b.remove();
    const hostViews = doc.querySelectorAll('.agy-rc-host-view');
    for (const hv of hostViews) hv.remove();
  };

  return win.agyStatusBar;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountStatusBar();
}

module.exports = {
  STATUSBAR_VERSION,
  mountStatusBar,
};
