'use strict';

const { CONTEXT_WINDOWS, PRESET_CONTEXT_WINDOWS, createContextWindowStore } = require('./context-window-policy');
const { ensureStyleElement, createTrustedHtmlSetter } = require('./dom-styles');
const { registerCustomCwInPrototype, createHostBridge } = require('./host-bridge');
const { createRpcClient } = require('./rpc-client');
const { createAdapterRegistry } = require('./adapter-registry');
const { createCoreMetricsAdapter } = require('./adapters/core-metrics');
const { createCompactButtonAdapter } = require('./adapters/compact-button');
const { createContextButtonAdapter } = require('./adapters/context-button');

const STATUSBAR_VERSION = 'v19';

function injectScriptText(win, doc, code) {
  if (!code || !doc?.head) return false;
  const s = doc.createElement('script');
  const nonceEl = doc.querySelector?.('script[nonce]');
  const nonce = nonceEl ? nonceEl.nonce || nonceEl.getAttribute?.('nonce') : '';
  if (nonce) s.nonce = nonce;
  let policy = win.__agyTrustedTypesPolicy || null;
  if (!policy && win.trustedTypes && typeof win.trustedTypes.createPolicy === 'function') {
    try {
      policy = win.trustedTypes.createPolicy('agy-rc-' + Date.now(), {
        createScript: (x) => x,
      });
      win.__agyTrustedTypesPolicy = policy;
    } catch {}
  }
  s.text = policy ? policy.createScript(code) : code;
  doc.head.appendChild(s);
  return true;
}

function ensureRemoteCompanionScripts(win, doc, fetchFn, hostBridge) {
  try {
    const isRemoteWeb = Boolean(
      win?.location?.hostname && String(win.location.hostname).includes('antigravity.google.com')
    );
    if (!isRemoteWeb || !doc?.head) return Promise.resolve(null);
    const effFetch = fetchFn || win?.fetch;

    const loadScript = (flagKey, url, fallbackCode) => {
      if (win[flagKey]) return Promise.resolve(false);
      win[flagKey] = true;
      if (fallbackCode && injectScriptText(win, doc, fallbackCode)) {
        return Promise.resolve(true);
      }
      if (typeof effFetch !== 'function') {
        win[flagKey] = false;
        return Promise.resolve(false);
      }
      return Promise.resolve(
        effFetch(`${url}?t=${Date.now()}`)
      )
        .then((r) => (r && r.ok !== false && typeof r.text === 'function' ? r.text() : ''))
        .then((code) => {
          if (!code) {
            win[flagKey] = false;
            return false;
          }
          return injectScriptText(win, doc, code);
        })
        .catch(() => {
          win[flagKey] = false;
          return false;
        });
    };

    const resolveHostInfo = async () => {
      if (win.__agyHostInstalledPlugins && typeof win.__agyHostInstalledPlugins === 'object') {
        return { resolved: true, ...win.__agyHostInstalledPlugins };
      }
      if (hostBridge && typeof hostBridge.fetchHostInstalledPluginInfo === 'function') {
        const info = await hostBridge.fetchHostInstalledPluginInfo(
          win.__APP_CONFIG__?.csrfToken,
          doc.querySelector?.('[data-testid="conversation-view"]')
        );
        if (info && info.resolved) {
          win.__agyHostInstalledPlugins = info;
          return info;
        }
      }
      return { resolved: false, hasStatusbar: true, hasMcpManager: false, hasKoTranslator: false };
    };

    let attempts = 0;
    const tryLoadInstalledCompanions = async () => {
      attempts += 1;
      const info = await resolveHostInfo();
      if (!info.resolved) {
        if (attempts < 5) {
          const setTimeoutFn = win.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
          if (setTimeoutFn) {
            const t = setTimeoutFn(tryLoadInstalledCompanions, 1500);
            if (t && typeof t.unref === 'function') t.unref();
          }
        }
        return info;
      }

      const tasks = [];
      if (info.hasMcpManager && !win.agyMcpManager) {
        tasks.push(
          loadScript(
            '__agyLoadingMcpManagerCompanion',
            'https://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js',
            info.mcpManagerCode
          )
        );
      }
      if (info.hasKoTranslator && !win.__agyKoLocalizerActive && !win.__agyKoThoughtCleanup) {
        tasks.push(
          loadScript(
            '__agyLoadingKoTranslatorCompanion',
            'https://raw.githubusercontent.com/jaeseongs95/antigravity-ko-translator/main/plugins/ko-thought-translator/scripts/ko_thought_autoinject.js',
            info.koTranslatorCode
          )
        );
      }
      await Promise.all(tasks);
      return info;
    };

    return tryLoadInstalledCompanions();
  } catch {
    return Promise.resolve(null);
  }
}

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
  hostBridge = createHostBridge({
    window: win,
    document: doc,
    localStorage: ls,
    fetchFn,
    cwStore,
  });
  ensureRemoteCompanionScripts(win, doc, fetchFn, hostBridge);

  const rpcClient = createRpcClient({
    window: win,
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
    hostBridge.syncDesktopAnnotations(
      win.__APP_CONFIG__?.csrfToken,
      doc.querySelector?.('[data-testid="conversation-view"]'),
      () => updateAll(),
      true
    );
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
        const actual = cwStore.normalize(trigger.getAttribute('data-context-window')) || '256K';
        const expected = cwStore.getSavedContextWindow(cid);
        const model = hostBridge.getSelectedModelKey(view, cid);
        const expectedKey = (model || '') + ':' + String(expected);
        const lastByCid = win.__agyLastAppliedContextWindowByCascade?.[cid];
        if (actual !== expected && lastByCid !== expectedKey && win.__agyLastAppliedContextWindow !== expectedKey) {
          const canAdopt = !view.__ignoreDomCwUntil || Date.now() > view.__ignoreDomCwUntil;
          if (canAdopt && PRESET_CONTEXT_WINDOWS.includes(actual) && view.__lastObservedDomCw && view.__lastObservedDomCw !== actual && view.__lastAppliedTargetCw === view.__lastObservedDomCw) {
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
    if (m) {
      if (typeof m.__agyCleanup === 'function') m.__agyCleanup();
      else m.remove();
    }
    const menus = doc.querySelectorAll('.agy-ctx-menu');
    for (const menu of menus) {
      if (typeof menu.__agyCleanup === 'function') menu.__agyCleanup();
      else menu.remove();
    }
    const bars = doc.querySelectorAll('.agy-ctx-statusbar');
    for (const b of bars) b.remove();
    const hostViews = doc.querySelectorAll('.agy-rc-host-view');
    for (const hv of hostViews) hv.remove();
  };
  win.__agyStatusBarActiveVersion = STATUSBAR_VERSION;

  return win.agyStatusBar;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountStatusBar();
}

module.exports = {
  STATUSBAR_VERSION,
  ensureRemoteCompanionScripts,
  mountStatusBar,
};
