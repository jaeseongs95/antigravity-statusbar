'use strict';

const { CONTEXT_WINDOWS, PRESET_CONTEXT_WINDOWS, createContextWindowStore } = require('./context-window-policy');
const { resolveHostAdapterConfig } = require('./host-adapter-config');
const { ensureStyleElement, createTrustedHtmlSetter } = require('./dom-styles');
const {
  disposeCompanionPolicyController,
  ensureRemoteCompanionScripts,
} = require('./companion-loader');
const { registerCustomCwInPrototype, createHostBridge } = require('./host-bridge');
const { createRpcClient } = require('./rpc-client');
const { createAdapterRegistry } = require('./adapter-registry');
const { createCoreMetricsAdapter } = require('./adapters/core-metrics');
const { createCompactButtonAdapter } = require('./adapters/compact-button');
const { createContextButtonAdapter } = require('./adapters/context-button');

const STATUSBAR_VERSION = 'v34';

function isIgnoredCustomOrTranslatedNode(node) {
  let cur = node && node.nodeType !== 1 ? (node.parentElement || node.parentNode) : node;
  while (cur && cur.nodeType === 1) {
    const id = cur.id || '';
    if (
      id === 'agy-ctx-debug-modal' ||
      id === 'agy-ctx-statusbar-style' ||
      id === 'agy-mcp-remote-launcher' ||
      id === 'agy-mcp-manager-modal-backdrop' ||
      id === 'agy-mcp-edit-popup-backdrop' ||
      id === 'agy-mcp-oauth-connect-backdrop' ||
      id === 'agy-mcp-settings-pane' ||
      id === 'agy-ko-settings-pane' ||
      id === 'agy-mcp-manager-styles'
    ) {
      return true;
    }
    const cls = typeof cur.className === 'string' ? cur.className : '';
    if (
      cls.includes('agy-ctx-statusbar') ||
      cls.includes('agy-ctx-menu') ||
      cur.classList?.contains?.('agy-ctx-statusbar') ||
      cur.classList?.contains?.('agy-ctx-menu')
    ) {
      return true;
    }
    if (
      typeof cur.hasAttribute === 'function' &&
      (cur.hasAttribute('data-agy-no-translate') ||
        cur.hasAttribute('data-agy-custom-mcp-btn') ||
        cur.hasAttribute('data-ko-translated') ||
        cur.hasAttribute('data-agy-ko-translated'))
    ) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return false;
}

function nodeTouchesStatusBarAnchors(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = String(node.tagName || '').toUpperCase();
  if (tag === 'GA-REMOTE-CONTROL' || tag === 'IFRAME') return true;
  const tid = typeof node.getAttribute === 'function' ? node.getAttribute('data-testid') : '';
  if (tid === 'conversation-view' || tid === 'agent-input-box' || tid === 'model-selector-trigger') {
    return true;
  }
  if (typeof node.querySelector === 'function') {
    try {
      if (
        node.querySelector(
          '[data-testid="conversation-view"], [data-testid="agent-input-box"], [data-testid="model-selector-trigger"], ga-remote-control'
        )
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

function isRelevantStatusBarMutation(mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) return true;
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (!m) continue;
    if (isIgnoredCustomOrTranslatedNode(m.target)) continue;
    if (m.type === 'attributes') {
      if (
        m.attributeName === 'data-context-window' &&
        m.target?.__agyInternalDomCw &&
        typeof m.target.getAttribute === 'function' &&
        m.target.getAttribute('data-context-window') === m.target.__agyInternalDomCw
      ) {
        continue;
      }
      if (!m.attributeName || m.attributeName === 'data-cascade-id' || m.attributeName === 'data-context-window') {
        return true;
      }
      continue;
    }
    if (!m.addedNodes && !m.removedNodes) return true;
    const targetTid = m.target && typeof m.target.getAttribute === 'function' ? m.target.getAttribute('data-testid') : '';
    if (targetTid === 'agent-input-box' || targetTid === 'conversation-view' || targetTid === 'model-selector-trigger') {
      return true;
    }
    const added = m.addedNodes;
    if (added && added.length > 0) {
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (!n || isIgnoredCustomOrTranslatedNode(n)) continue;
        if (!n.nodeType || nodeTouchesStatusBarAnchors(n)) return true;
      }
    }
    const removed = m.removedNodes;
    if (removed && removed.length > 0) {
      for (let j = 0; j < removed.length; j++) {
        const n = removed[j];
        if (!n) continue;
        if (
          (typeof n.className === 'string' && n.className.includes('agy-ctx-statusbar')) ||
          nodeTouchesStatusBarAnchors(n)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function mountStatusBar(env = {}) {
  const win = env.window || (typeof window !== 'undefined' ? window : null);
  const doc = env.document || win?.document || (typeof document !== 'undefined' ? document : null);
  let ls = env.localStorage || null;
  if (!ls) {
    try {
      ls = win?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
    } catch {
      ls = null;
    }
  }
  const fetchFn = env.fetch || win?.fetch || (typeof fetch !== 'undefined' ? fetch : null);

  if (!win || !doc) return null;

  if (win.__agyStatusBarActiveVersion === STATUSBAR_VERSION && win.__agyStatusBarCleanup) {
    return win.agyStatusBar;
  }
  if (win.__agyStatusBarCleanup) {
    try { win.__agyStatusBarCleanup(); } catch {}
  }

  const underDefaultCwSet = new Set(['128K', '256K']);
  const refreshStyles = () => ensureStyleElement(doc, underDefaultCwSet);
  let hostBridge = null;

  const cwStore = createContextWindowStore({
    document: doc,
    localStorage: ls,
    nativeStorage: win.nativeStorage,
    onCustomCw: (cw) => {
      let extraWin = null;
      try {
        extraWin = doc.querySelector?.('ga-remote-control iframe')?.contentWindow || null;
      } catch {}
      registerCustomCwInPrototype(cw, underDefaultCwSet, refreshStyles, extraWin);
    },
    onSaveCw: (cid) => {
      if (hostBridge && typeof hostBridge.pushSessionCwToServer === 'function') {
        const targetView = (cid && doc.querySelector?.(`[data-testid="conversation-view"][data-cascade-id="${cid}"]`))
          || doc.querySelector?.('[data-testid="conversation-view"]');
        hostBridge.pushSessionCwToServer(
          cid,
          win.__APP_CONFIG__?.csrfToken,
          targetView
        );
      }
    },
  });

  refreshStyles();

  const setHtml = createTrustedHtmlSetter(win, doc);
  const resolvedHostConfig = resolveHostAdapterConfig(env.hostConfig, win);
  hostBridge = createHostBridge({
    window: win,
    document: doc,
    localStorage: ls,
    fetchFn,
    cwStore,
    hostConfig: resolvedHostConfig,
  });
  Promise.resolve(ensureRemoteCompanionScripts(win, doc, fetchFn, hostBridge, resolvedHostConfig)).catch(() => null);

  const rpcClient = createRpcClient({
    window: win,
    fetchFn,
    localStorage: ls,
    getAgentStateProviderForInputBox: hostBridge.getAgentStateProviderForInputBox,
    getRemoteRpcServiceForElement: hostBridge.getRemoteRpcServiceForElement,
    hostConfig: resolvedHostConfig,
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
    hostConfig: resolvedHostConfig,
  });

  registry.registerBuiltinAdapters([
    coreMetricsAdapter,
    compactButtonAdapter,
    contextButtonAdapter,
  ]);

  function renderBar(barEl, view, inputBox, stats, quota, precomputedCw, extraCtx) {
    const cascadeId = view.getAttribute('data-cascade-id');
    const { leftEl, rightEl } = registry.ensureBarStructure(barEl);
    const currentCw = precomputedCw || getConversationContextWindow(view, cascadeId);
    const ctx = {
      barEl,
      view,
      inputBox,
      cascadeId,
      currentCw,
      stats,
      quota,
      deferUncachedMetrics: Boolean(extraCtx && extraCtx.deferUncachedMetrics),
      updateAll,
      getConversationContextWindow: () => getConversationContextWindow(view, cascadeId),
      setConversationContextWindow: (cw) => setConversationContextWindow(view, cascadeId, cw),
    };
    registry.renderSlotAdapters(leftEl, 'left', ctx);
    registry.renderSlotAdapters(rightEl, 'right', ctx);
  }

  let disposed = false;
  function updateAll() {
    if (disposed) return;
    refreshStyles();
    hostBridge.ensureContextWindowSelectorFlag();
    hostBridge.ensureCustomizationsStoreLoaded();
    hostBridge.ensureRemoteHostView(() => updateAll());
    const csrf = win.__APP_CONFIG__ && win.__APP_CONFIG__.csrfToken;
    const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    if (!views.length) return;
    if (!csrf && !hostBridge.getRemoteRpcServiceForElement(views[0])) return;

    const quotaPromise = rpcClient.fetchQuota(csrf, views[0]);
    hostBridge.syncDesktopAnnotations(csrf, views[0], () => updateAll());

    for (const view of views) {
      const cascadeId = view.getAttribute('data-cascade-id');
      const inputBox = view.querySelector('[data-testid="agent-input-box"]');
      if (!cascadeId || !inputBox) continue;

      if (view.__lastTrackedCascadeId !== cascadeId) {
        view.__lastTrackedCascadeId = cascadeId;
        view.__lastObservedDomCw = null;
        view.__lastAppliedTargetCw = null;
        view.__ignoreDomCwUntil = Date.now() + 500;
      }
      inputBox.__lastCascadeId = cascadeId;

      const triggerEl = hostBridge.getModelSelectorContextForView(view)?.triggerEl || view.querySelector('[data-testid="model-selector-trigger"]');
      const domCw = cwStore.normalize(triggerEl ? triggerEl.getAttribute('data-context-window') : null);
      const canAdoptFromDom = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
      if (canAdoptFromDom && domCw && PRESET_CONTEXT_WINDOWS.includes(domCw) && view.__lastObservedDomCw && view.__lastObservedDomCw !== domCw) {
        const savedCw = cwStore.getSavedContextWindow(cascadeId);
        if (domCw !== savedCw && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
          cwStore.saveContextWindowSetting(cascadeId, domCw);
        }
      }

      const targetCw = getConversationContextWindow(view, cascadeId);
      view.__lastAppliedTargetCw = targetCw;
      if (triggerEl && canAdoptFromDom) {
        view.__lastObservedDomCw = triggerEl.getAttribute('data-context-window') || targetCw;
      }

      let barEl = inputBox.querySelector('.agy-ctx-statusbar');
      const isNewlyCreatedBar = !barEl;
      if (!barEl) {
        barEl = doc.createElement('div');
        barEl.className = 'agy-ctx-statusbar';
        barEl.setAttribute?.('data-agy-no-translate', 'true');
        barEl.setAttribute?.('translate', 'no');
        inputBox.appendChild(barEl);
      }

      const cachedData = rpcClient.getCachedStats(cascadeId);
      const immediateData = rpcClient.getImmediateStats
        ? rpcClient.getImmediateStats(cascadeId, inputBox)
        : cachedData;
      const deferUncachedMetrics = Boolean(!isNewlyCreatedBar && !immediateData);

      renderBar(barEl, view, inputBox, immediateData, rpcClient.getLatestQuota(), targetCw, { deferUncachedMetrics });

      Promise.all([
        Promise.resolve(rpcClient.fetchCascadeStats(cascadeId, csrf, inputBox)).catch(() => null),
        Promise.resolve(quotaPromise).catch(() => null),
      ]).then(([data, freshQuota]) => {
        if (disposed || !barEl.isConnected || view.getAttribute('data-cascade-id') !== cascadeId) return;
        const finalData = data || cachedData || immediateData;
        renderBar(barEl, view, inputBox, finalData, freshQuota || rpcClient.getLatestQuota(), targetCw, { deferUncachedMetrics: false });
      }).catch(() => {
        if (disposed || !barEl.isConnected || view.getAttribute('data-cascade-id') !== cascadeId) return;
        renderBar(barEl, view, inputBox, cachedData || immediateData || null, rpcClient.getLatestQuota(), targetCw, { deferUncachedMetrics: false });
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

  Promise.resolve(cwStore.loadPersistentContextSettings()).then(() => {
    if (disposed) return;
    hostBridge.syncDesktopAnnotations(
      win.__APP_CONFIG__?.csrfToken,
      doc.querySelector?.('[data-testid="conversation-view"]'),
      () => updateAll(),
      true
    );
    updateAll();
  }).catch(() => {});
  updateAll();

  const setIntervalFn = env.setInterval || win.setInterval || setInterval;
  const clearIntervalFn = env.clearInterval || win.clearInterval || clearInterval;
  const timer = setIntervalFn(updateAll, 3000);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  const ObsClass = env.MutationObserver || win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
  const obs = ObsClass ? new ObsClass((mutations) => {
    if (!isRelevantStatusBarMutation(mutations)) return;
    const views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    for (const view of views) {
      const cid = view.getAttribute('data-cascade-id');
      const box = view.querySelector('[data-testid="agent-input-box"]');
      if (box && (!box.querySelector('.agy-ctx-statusbar') || box.__lastCascadeId !== cid || view.__lastTrackedCascadeId !== cid)) {
        box.__lastCascadeId = cid;
        view.__lastTrackedCascadeId = cid;
        view.__lastObservedDomCw = null;
        view.__lastAppliedTargetCw = null;
        view.__ignoreDomCwUntil = Date.now() + 500;
        updateAll();
        return;
      }
      const trigger = hostBridge.getModelSelectorContextForView(view)?.triggerEl || view.querySelector('[data-testid="model-selector-trigger"]');
      if (cid && trigger) {
        const rawDomCw = trigger.getAttribute('data-context-window');
        const actual = cwStore.normalize(rawDomCw) || '256K';
        const expected = cwStore.getSavedContextWindow(cid);
        const model = hostBridge.getSelectedModelKey(view, cid);
        const expectedKey = (model || '') + ':' + String(expected);
        const lastByCid = win.__agyLastAppliedContextWindowByCascade?.[cid];
        const domMissingOrDrifted = !rawDomCw || actual !== expected;
        if (domMissingOrDrifted && (lastByCid !== expectedKey || win.__agyLastAppliedContextWindow !== expectedKey || !rawDomCw || actual !== expected)) {
          const canAdopt = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
          if (canAdopt && rawDomCw && PRESET_CONTEXT_WINDOWS.includes(actual) && view.__lastObservedDomCw && view.__lastObservedDomCw !== actual && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
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

  const cleanupStatusBar = () => {
    disposed = true;
    delete win.__agyStatusBarActiveVersion;
    clearIntervalFn(timer);
    win.removeEventListener?.('DOMContentLoaded', attachBodyObserver);
    if (obs) obs.disconnect();
    for (const adapter of registry.getSortedAdapters()) {
      if (typeof adapter.unmount === 'function') {
        try { adapter.unmount(); } catch {}
      }
    }
    if (typeof rpcClient?.dispose === 'function') {
      try { rpcClient.dispose(); } catch {}
    }
    if (typeof hostBridge?.dispose === 'function') {
      try { hostBridge.dispose(); } catch {}
    }
    const targetDocs = [doc];
    try {
      const iframeDoc = doc.querySelector?.('ga-remote-control iframe')?.contentDocument;
      if (iframeDoc && iframeDoc !== doc) targetDocs.push(iframeDoc);
    } catch {}
    for (const targetDoc of targetDocs) {
      const m = targetDoc.getElementById?.('agy-ctx-debug-modal');
      if (m) {
        if (typeof m.__agyCleanup === 'function') m.__agyCleanup();
        else m.remove?.();
      }
      const menus = targetDoc.querySelectorAll?.('.agy-ctx-menu') || [];
      for (const menu of menus) {
        if (typeof menu.__agyCleanup === 'function') menu.__agyCleanup();
        else menu.remove?.();
      }
      const bars = targetDoc.querySelectorAll?.('.agy-ctx-statusbar') || [];
      for (const b of bars) b.remove?.();
      const hostViews = targetDoc.querySelectorAll?.('.agy-rc-host-view') || [];
      for (const hv of hostViews) hv.remove?.();
      const styleEl = targetDoc.getElementById?.('agy-ctx-statusbar-style');
      if (styleEl && typeof styleEl.remove === 'function') {
        styleEl.remove();
      }
    }
    try {
      delete win.__agyRcGenLenByCascade;
      delete win.__agyRcStepCountByCascade;
      delete win.__agyLastAppliedContextWindow;
      delete win.__agyLastAppliedContextWindowByCascade;
      delete win.__agySniffedCascadeId;
      delete win.__agySniffedCascadeTs;
      disposeCompanionPolicyController(win);
      const hasActiveCompanions = Boolean(
        win.agyMcpManager || win.__agyKoLocalizerActive || win.__agyKoThoughtCleanup
      );
      if (!hasActiveCompanions) {
        delete win.__agyHostInstalledPlugins;
        delete win.__agyLoadingMcpManagerCompanion;
        delete win.__agyLoadingKoTranslatorCompanion;
        delete win.__agyLoadingKoThoughtCompanion;
        delete win.__agyCapturedLsClient;
        delete win.__agyRemoteControlInstance;
        delete win.__agyTrustedTypesPolicy;
        delete win.__agyTrustedHtmlPolicy;
      }
    } catch {}
    try {
      delete win.agyStatusBar;
    } catch {
      win.agyStatusBar = undefined;
    }
    if (win.__agyStatusBarCleanup === cleanupStatusBar) {
      try {
        delete win.__agyStatusBarCleanup;
      } catch {
        win.__agyStatusBarCleanup = undefined;
      }
    }
  };
  win.__agyStatusBarCleanup = cleanupStatusBar;
  win.__agyStatusBarActiveVersion = STATUSBAR_VERSION;

  return win.agyStatusBar;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountStatusBar();
}

module.exports = {
  STATUSBAR_VERSION,
  isIgnoredCustomOrTranslatedNode,
  isRelevantStatusBarMutation,
  ensureRemoteCompanionScripts,
  mountStatusBar,
};
