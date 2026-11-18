'use strict';

/**
 * Antigravity Status Bar v2.0.0 — Hexagonal Composition Root.
 * Sole module allowed to wire Domain + Ports + UI + Antigravity Drivers together.
 */

const { PLUGIN_BUS_SYMBOL, getOrCreatePluginBus } = require('../ports/contracts');
const { createTranslator } = require('../domain/i18n');
const { createContextWindowStore } = require('../domain/context-window-policy');
const { resolveHostAdapterConfig } = require('../drivers/antigravity/host-config');
const { createStorageAdapter, createLocalHttpTransport } = require('../drivers/antigravity/local-http-transport');
const { createRemotePortDriver, createDocumentHostDriver } = require('../drivers/antigravity/remote-port-driver');
const {
  createReactFiberDriver,
  registerCustomCwForStyles,
  cleanupLegacyObjectPrototypeCwGetters,
} = require('../drivers/antigravity/react-fiber-driver');
const { createCompactDriver } = require('../drivers/antigravity/compact-driver');
const { createCompanionDriver } = require('../drivers/antigravity/companion-driver');
const { ensureStyleElement, removeStyleElements, getCspNonce } = require('../ui/style-manager');
const { createAdapterRegistry } = require('../ui/adapter-registry');
const { createCoreMetricsAdapter } = require('../ui/views/metrics-view');
const { createCompactButtonAdapter } = require('../ui/views/compact-button');
const { createContextModalAdapter } = require('../ui/views/context-modal');
const { createDisposableScope } = require('./disposable');
const { createStateCoordinator } = require('./state-coordinator');

function mountStatusBar(targetWindow = typeof window !== 'undefined' ? window : globalThis, overrides = {}) {
  const win = targetWindow || globalThis;
  const doc = overrides.document || win.document;

  if (typeof win.__agyStatusBarCleanup === 'function') {
    try {
      win.__agyStatusBarCleanup();
    } catch {}
  }

  const scope = createDisposableScope(win);
  const resolvedHostConfig = resolveHostAdapterConfig(overrides.hostConfig, win);
  const resolveCsrfToken = () => resolvedHostConfig.resolveCsrfToken(win);
  const translator = createTranslator(
    resolvedHostConfig.locale,
    win.navigator?.language || win.navigator?.userLanguage || ''
  );

  const remotePortDriver = createRemotePortDriver({
    window: win,
    document: doc,
    hostConfig: resolvedHostConfig,
    scope,
  });
  const documentHost = createDocumentHostDriver({
    document: doc,
    remotePortDriver,
  });

  const underDefaultCwSet = new Set(['128K', '256K']);
  const ensureStyles = () => ensureStyleElement(doc, underDefaultCwSet, documentHost);
  const removeStyles = () => removeStyleElements(doc, documentHost);

  let localStorageObj = overrides.localStorage || null;
  if (!localStorageObj) {
    try {
      localStorageObj = win.localStorage;
    } catch {
      localStorageObj = null;
    }
  }

  const storage = createStorageAdapter({
    window: win,
    document: doc,
    localStorage: localStorageObj,
  });

  let engineRef = null;
  let coordinatorRef = null;
  let flushSaveTimer = null;

  const cwStore = createContextWindowStore({
    storage,
    translator,
    onCustomCw(cw) {
      registerCustomCwForStyles(cw, underDefaultCwSet, ensureStyles, win);
    },
    onSaveCw() {
      if (flushSaveTimer) scope.clearTimeout(flushSaveTimer);
      flushSaveTimer = scope.setTimeout(() => {
        flushSaveTimer = null;
        if (!scope.isDisposed() && engineRef) {
          Promise.resolve(
            engineRef.syncDesktopAnnotations(resolveCsrfToken(), null)
          ).catch(() => {});
        }
      }, 250);
    },
  });
  cwStore.loadPersistentContextSettings().then(() => coordinatorRef?.updateAll?.()).catch(() => {});

  const fetchImpl =
    overrides.fetch ||
    (typeof win.fetch === 'function' ? win.fetch.bind(win) : typeof fetch === 'function' ? fetch : null);

  const transport = createLocalHttpTransport({
    fetchFn: fetchImpl,
    window: win,
    localStorage: localStorageObj,
    hostConfig: resolvedHostConfig,
    scope,
    getRemoteRpcServiceForElement: (el) => engineRef?.getRemoteRpcServiceForElement?.(el) || null,
    onQuotaUpdated() {
      coordinatorRef?.scheduleUpdate?.(20);
    },
  });

  const engine = createReactFiberDriver({
    window: win,
    document: doc,
    localStorage: localStorageObj,
    cwStore,
    transport,
    remotePortDriver,
    hostConfig: resolvedHostConfig,
    scope,
    onCascadeSniffed() {
      coordinatorRef?.scheduleUpdate?.(20);
    },
    onRemoteAnnotationsUpdated(updated) {
      if (updated) {
        coordinatorRef?.scheduleUpdate?.(30);
      }
    },
  });
  engineRef = engine;

  const compactDriver = createCompactDriver({
    window: win,
    document: doc,
    getRemoteRpcServiceForElement: (el) => engine.getRemoteRpcServiceForElement(el),
    getActiveCascadeId: (el) =>
      el?.closest?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id') || engine.getActiveSniffedCascadeId(),
    resolveEffectiveInputBox: (el) => engine.resolveEffectiveInputBox(el),
    compactPrompt: resolvedHostConfig.compactPrompt,
  });
  engine.triggerCompact = (inputBox, promptOverride) => compactDriver.runCompactForInputBox(inputBox, promptOverride);

  const adapterRegistry = createAdapterRegistry({
    window: win,
    document: doc,
    documentHost,
    onUpdate() {
      coordinatorRef?.updateAll?.();
    },
  });

  const coordinator = createStateCoordinator({
    document: doc,
    documentHost,
    transport,
    storage,
    engine,
    cwStore,
    translator,
    adapterRegistry,
    underDefaultCwSet,
    ensureStyles,
    removeStyles,
    scope,
    csrfProvider: resolveCsrfToken,
    getRcGenLen: (cid) => transport.getKnownGenLen?.(cid) || 0,
    getRcStepLen: (cid) => transport.getStepCount?.(cid) || 0,
  });
  coordinatorRef = coordinator;

  const coreMetricsAdapter = createCoreMetricsAdapter({
    document: doc,
    documentHost,
    cwStore,
    translator,
    getConversationContextWindow: coordinator.getConversationContextWindow,
    setConversationContextWindow: coordinator.setConversationContextWindow,
    cycleConversationContextWindow: coordinator.cycleConversationContextWindow,
    saveDefaultContextWindow: coordinator.saveDefaultContextWindow,
    updateAll: coordinator.updateAll,
  });

  const compactAdapter = createCompactButtonAdapter({
    runCompactForInputBox: (inputBox) => compactDriver.runCompactForInputBox(inputBox),
    translator,
  });

  const contextModalAdapter = createContextModalAdapter({
    document: doc,
    documentHost,
    window: win,
    translator,
    loadDebugTelemetry: coordinator.loadDebugTelemetry,
    toggleInlineStats(view, inputBox) {
      const snap = engine.getDebugSnapshot(view, inputBox);
      snap?.toggleInlineDebug?.();
    },
  });

  adapterRegistry.registerBuiltinAdapters([coreMetricsAdapter, compactAdapter, contextModalAdapter]);

  const companionDriver = createCompanionDriver({
    window: win,
    document: doc,
    hostConfig: resolvedHostConfig,
    transport,
    remotePortDriver,
    scope,
    getNonce: () => getCspNonce(doc),
  });
  const isRemoteHostActive = resolvedHostConfig.isRemoteHost(win.location?.hostname);
  if (
    isRemoteHostActive ||
    (Array.isArray(resolvedHostConfig.companionScripts) && resolvedHostConfig.companionScripts.length > 0)
  ) {
    Promise.resolve(companionDriver.loadCompanions({ fetch: fetchImpl })).catch(() => {});
  }

  const pluginBus = getOrCreatePluginBus(win);
  const unregisterBus = pluginBus.registerPlugin('antigravity-statusbar', {
    version: '2.0.0',
    capabilities: ['context-window', 'metrics', 'compact', 'debug-modal', 'i18n'],
  });

  scope.add(() => unregisterBus());
  scope.add(() => adapterRegistry.dispose?.());
  scope.add(() => coordinator.dispose());
  scope.add(() => engine.dispose());
  scope.add(() => transport.dispose());
  scope.add(() => remotePortDriver.dispose());
  scope.add(() => cleanupLegacyObjectPrototypeCwGetters(win));

  // Initial sync of desktop conversation annotations (best effort, bounded)
  if (!isRemoteHostActive) {
    Promise.resolve(engine.syncDesktopAnnotations(resolveCsrfToken(), null)).catch(() => {});
  }

  coordinator.start();

  const destroy = () => {
    scope.dispose();
    if (win.__agyStatusBarCleanup === destroy) {
      delete win.__agyStatusBarCleanup;
    }
  };

  scope.listen(win, 'pagehide', destroy);
  win.__agyStatusBarCleanup = destroy;

  const api = {
    version: '2.0.0',
    pluginBus,
    registerAdapter: adapterRegistry.registerAdapter,
    unregisterAdapter: adapterRegistry.unregisterAdapter,
    getAdapters: adapterRegistry.getAdapters,
    getContextWindow: (cascadeId) => cwStore.getSavedContextWindow(cascadeId),
    setContextWindow: (cascadeId, cw) => {
      const res = coordinator.setConversationContextWindow(null, cascadeId, cw);
      coordinator.updateAll();
      return res;
    },
    getConversationContextWindow: (viewOrId, cascadeIdOpt) => {
      if (typeof viewOrId === 'string') {
        return coordinator.getConversationContextWindow(null, viewOrId);
      }
      return coordinator.getConversationContextWindow(viewOrId || null, cascadeIdOpt || '');
    },
    setConversationContextWindow: (viewOrId, cascadeIdOrCw, cwOpt, opts) => {
      const res =
        typeof viewOrId === 'string' && cwOpt === undefined
          ? coordinator.setConversationContextWindow(null, viewOrId, cascadeIdOrCw)
          : coordinator.setConversationContextWindow(viewOrId || null, cascadeIdOrCw || '', cwOpt, opts);
      coordinator.updateAll();
      return res;
    },
    getLocale: () => translator.getLocale(),
    setLocale: (locale) => {
      const next = translator.setLocale(locale);
      coordinator.updateAll();
      return next;
    },
    updateAll: coordinator.updateAll,
    runCompact: (inputBox, promptOverride) => compactDriver.runCompactForInputBox(inputBox, promptOverride),
    openDebugModal: (view, inputBox) => contextModalAdapter.openOrToggleDebugModal(view, inputBox),
    destroy,
  };

  win.agyStatusBar = api;
  return api;
}

function shouldAutoMount() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (globalThis.__AGY_STATUSBAR_DISABLE_AUTOMOUNT__ || window.__AGY_STATUSBAR_DISABLE_AUTOMOUNT__) return false;
  if (typeof process !== 'undefined' && process.env && process.env.AGY_STATUSBAR_DISABLE_AUTOMOUNT === '1') {
    return false;
  }
  return true;
}

if (shouldAutoMount()) {
  try {
    mountStatusBar(window);
  } catch (err) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[agy-statusbar] mount failed:', err);
    }
  }
}

module.exports = {
  PLUGIN_BUS_SYMBOL,
  mountStatusBar,
};
