'use strict';

/**
 * Antigravity Desktop Electron / React Fiber / Redux / Fetch Engine Driver.
 *
 * Implements `EnginePort` and isolates all React Fiber traversal, Redux `modelSelection`,
 * `fetch`/`lsClient` checkpoint injection, poisoned `trajectorySync` sanitization (`D-0013`),
 * `subscribeToPlugins` 600ms timeout guard (`D-0008`), and `<ga-remote-control>` shell view
 * management — without mutating `Object.prototype` or polluting `window.__agy*`.
 */

const { PRESET_CONTEXT_WINDOWS } = require('../../domain/context-window-policy');
const { isStateForCascade } = require('../../domain/metrics-calculator');
const { resolveHostAdapterConfig } = require('./host-config');
const {
  UUID_RE,
  CONVO_RPC_RE,
  createTextCodec,
  extractCascadeIdFromBody,
  injectCheckpointPayload,
} = require('./protobuf-wire-codec');
const { setBoundedLruMap } = require('./local-http-transport');

const MAX_CASCADE_MAP_ENTRIES = 200;

function cleanupLegacyObjectPrototypeCwGetters(extraWin) {
  const protos = [Object.prototype];
  try {
    if (extraWin?.Object?.prototype && extraWin.Object.prototype !== Object.prototype) {
      protos.push(extraWin.Object.prototype);
    }
  } catch {}
  for (const proto of protos) {
    try {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (!/^\d+K$/.test(key)) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (desc && desc.configurable && typeof desc.get === 'function' && String(desc.get).includes('512000')) {
          delete proto[key];
        }
      }
    } catch {}
  }
}

function registerCustomCwForStyles(cw, underDefaultCwSet, onStyleUpdate, extraWin) {
  cleanupLegacyObjectPrototypeCwGetters(extraWin);
  if (!cw) return;
  const kNum = parseInt(cw, 10);
  if (!isNaN(kNum) && kNum > 0 && kNum <= 256 && underDefaultCwSet && !underDefaultCwSet.has(cw)) {
    underDefaultCwSet.add(cw);
    if (typeof onStyleUpdate === 'function') {
      try { onStyleUpdate(); } catch {}
    }
  }
}

function extractModelValFromModelOrAlias(moa) {
  if (!moa || typeof moa !== 'object') return undefined;
  if (moa.model !== undefined) return moa.model;
  if (moa.choice && (moa.choice.case === 'model' || moa.choice.case === 'alias') && moa.choice.value !== undefined) {
    return moa.choice.value;
  }
  return undefined;
}

function resolveModelValueFromLabel(state, label) {
  if (!label || typeof label !== 'string') return undefined;
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  const configs = state?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) return undefined;
  for (const cfg of configs) {
    if (cfg && cfg.label === trimmed) {
      const v = extractModelValFromModelOrAlias(cfg.modelOrAlias);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function extractLabelFromSyncedKey(syncedKey) {
  if (typeof syncedKey !== 'string' || !syncedKey) return undefined;
  const parts = syncedKey.split(':');
  if (parts.length >= 4) {
    const label = parts.slice(2, parts.length - 1).join(':').trim();
    if (label) return label;
  }
  if (parts.length === 3) {
    const label = parts[1].trim();
    if (label) return label;
  }
  return undefined;
}

function createReactFiberDriver({
  window,
  document,
  localStorage,
  cwStore,
  transport,
  remotePortDriver,
  hostConfig,
  scope,
  onCascadeSniffed,
  onRemoteAnnotationsUpdated,
}) {
  const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, window);
  const codec = createTextCodec(window);

  let activeSniffedCascadeId = '';
  let lastAppliedCwGlobal = '';
  const lastAppliedCwByCascade = new Map();
  let capturedLsClient = null;
  let lastRcTrajectoryPollTs = 0;
  let rcTrajectoryPollInFlight = false;
  let lastDesktopTrajectorySyncTs = 0;
  let desktopTrajectorySyncInFlight = false;

  // Private WeakMaps instead of DOM/object expandos
  const viewPatchCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  const viewMsCtxCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  const frozenModelCloneCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  const patchedStoreConfigsCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  const sanitizedStores = typeof WeakSet === 'function' ? new WeakSet() : null;
  const patchedCwsObjects = typeof WeakSet === 'function' ? new WeakSet() : null;
  const hookedFetchWindows = typeof WeakSet === 'function' ? new WeakSet() : null;
  const hookedLsClients = typeof WeakSet === 'function' ? new WeakSet() : null;
  const patchedStreamClients = typeof WeakSet === 'function' ? new WeakSet() : null;
  const cachedCustomizationsStores = typeof WeakMap === 'function' ? new WeakMap() : null;
  const lastCustomizationsDfsByDoc = typeof WeakMap === 'function' ? new WeakMap() : null;
  const triggeredStoreRefresh = typeof WeakSet === 'function' ? new WeakSet() : null;
  const hostViewState = typeof WeakMap === 'function' ? new WeakMap() : null;

  cleanupLegacyObjectPrototypeCwGetters(window);

  // Opt-in feature flag for native selector
  try {
    const raw = localStorage?.getItem?.('jetski.developer.customFlagOverrides');
    const flags = raw ? JSON.parse(raw) : {};
    let changed = false;
    if (flags['context-window-selector'] !== true) {
      flags['context-window-selector'] = true;
      changed = true;
    }
    if (!flags['contextWindowSelector'] || flags['contextWindowSelector'].enabled !== true) {
      flags['contextWindowSelector'] = { enabled: true };
      changed = true;
    }
    if (changed) {
      localStorage?.setItem?.('jetski.developer.customFlagOverrides', JSON.stringify(flags));
    }
  } catch {}

  function setTriggerCwAttribute(triggerEl, cwStr) {
    if (!triggerEl || typeof triggerEl.setAttribute !== 'function') return;
    const str = String(cwStr);
    if (triggerEl.getAttribute('data-context-window') !== str) {
      triggerEl.setAttribute('data-context-window', str);
    }
  }

  function resolveEffectiveView(view) {
    if (view && view.classList?.contains?.('agy-rc-host-view')) {
      const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
      if (cdoc) {
        const cid = view.getAttribute('data-cascade-id');
        if (cid && cid !== 'remote-session') {
          const exact = cdoc.querySelector(`[data-testid="conversation-view"][data-cascade-id="${cid}"]`);
          if (exact) return exact;
        }
        const anyView = cdoc.querySelector('[data-testid="conversation-view"]');
        if (anyView) return anyView;
      }
    }
    return view;
  }

  function resolveEffectiveInputBox(inputBox) {
    if (inputBox && inputBox.classList?.contains?.('agy-rc-host-box')) {
      const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
      if (cdoc) {
        const innerBox = cdoc.querySelector('[data-testid="agent-input-box"]');
        if (innerBox) return innerBox;
      }
    }
    return inputBox;
  }

  function resolveEffectiveCascadeId(body, rcInst) {
    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const fromBody = extractCascadeIdFromBody(body, ignoreUuid, codec);
    if (fromBody) return fromBody;
    if (activeSniffedCascadeId && activeSniffedCascadeId !== 'remote-session') {
      return activeSniffedCascadeId;
    }
    const activeView = document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
    const domCid = activeView?.getAttribute?.('data-cascade-id');
    if (domCid && domCid !== 'remote-session') return domCid;
    return null;
  }

  function injectCheckpointLimitIntoSendRequest(path, body, rcInst) {
    if (typeof path !== 'string' || !/\/SendUserCascadeMessage$/i.test(path) || !body || !cwStore) {
      return body;
    }
    try {
      const cid = resolveEffectiveCascadeId(body, rcInst);
      const cw = cwStore.getSavedContextWindow(cid);
      const limit = cwStore.getLimit(cw);
      if (!cw || !limit || limit <= 0) return body;
      return injectCheckpointPayload({
        path,
        body,
        contextWindow: cw,
        maxTokenLimit: limit,
        codec,
      });
    } catch {
      return body;
    }
  }

  function notifyCascadeSniffed(cid) {
    if (typeof onCascadeSniffed === 'function') {
      try { onCascadeSniffed(cid); } catch {}
    }
  }

  function sniffCascadeIdFromRpc(path, body, rcInst) {
    if (typeof path !== 'string' || !CONVO_RPC_RE.test(path)) return;
    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const cid = extractCascadeIdFromBody(body, ignoreUuid, codec);
    if (cid) {
      const changed = activeSniffedCascadeId !== cid;
      activeSniffedCascadeId = cid;
      if (/\/(SendUserCascadeMessage|StartCascade|StreamCascadeReactiveUpdates|StreamAgentStateUpdates)$/i.test(path)) {
        lastRcTrajectoryPollTs = 0;
        if (/\/(SendUserCascadeMessage|StartCascade)$/i.test(path)) {
          transport?.recordStepEvent?.(cid);
        }
        scope?.setTimeout?.(() => {
          lastRcTrajectoryPollTs = 0;
          notifyCascadeSniffed(cid);
        }, 1200);
      }
      if (changed) notifyCascadeSniffed(cid);
    }
  }

  function ensureFetchHook(targetWin) {
    try {
      const w = targetWin || window;
      if (!w || typeof w.fetch !== 'function') return;
      if (hookedFetchWindows && hookedFetchWindows.has(w)) return;
      if (w.fetch.__agyCwHookV2) return;
      const origFetch = w.fetch;
      const wrappedFetch = function (input, init) {
        let nextInput = input;
        let nextInit = init;
        try {
          const url =
            typeof input === 'string'
              ? input
              : input && typeof input.url === 'string'
                ? input.url
                : input && typeof input.href === 'string'
                  ? input.href
                  : '';
          if (url && CONVO_RPC_RE.test(url)) {
            if (nextInit && nextInit.body) {
              sniffCascadeIdFromRpc(url, nextInit.body, null);
              if (/\/SendUserCascadeMessage$/i.test(url)) {
                nextInit = { ...nextInit, body: injectCheckpointLimitIntoSendRequest(url, nextInit.body, null) };
              }
            } else if (
              input &&
              typeof input === 'object' &&
              typeof input.arrayBuffer === 'function' &&
              typeof input.clone === 'function' &&
              /\/SendUserCascadeMessage$/i.test(url)
            ) {
              return input
                .clone()
                .arrayBuffer()
                .then((ab) => {
                  const rawBytes = new Uint8Array(ab);
                  sniffCascadeIdFromRpc(url, rawBytes, null);
                  const injectedBody = injectCheckpointLimitIntoSendRequest(url, rawBytes, null);
                  const ReqCtor = w.Request || (typeof Request === 'function' ? Request : null);
                  if (ReqCtor) {
                    return origFetch.call(this, new ReqCtor(input, { body: injectedBody }), nextInit);
                  }
                  return origFetch.call(this, nextInput, { ...(nextInit || {}), body: injectedBody });
                })
                .catch(() => origFetch.call(this, nextInput, nextInit));
            }
          }
        } catch {}
        return origFetch.call(this, nextInput, nextInit);
      };
      wrappedFetch.__agyCwHookV2 = true;
      w.fetch = wrappedFetch;
      if (hookedFetchWindows) hookedFetchWindows.add(w);
      scope?.add?.(() => {
        try {
          if (w.fetch === wrappedFetch) {
            w.fetch = origFetch;
          }
        } catch {}
      });
    } catch {}
  }

  function hookLsClient(lsClient) {
    if (!lsClient || typeof lsClient !== 'object') return lsClient;
    if (hookedLsClients && hookedLsClients.has(lsClient)) return lsClient;
    if (lsClient.__agyCwHookV2) return lsClient;
    try {
      let hooked = false;
      const origSend = lsClient.sendUserCascadeMessage;
      let wrappedSend = null;
      if (typeof origSend === 'function') {
        wrappedSend = function (req, ...rest) {
          const nextReq = injectCheckpointLimitIntoSendRequest(
            resolvedHostConfig.buildRpcPath('SendUserCascadeMessage'),
            req,
            null
          );
          return origSend.call(this, nextReq, ...rest);
        };
        wrappedSend.__agyCwHookV2 = true;
        lsClient.sendUserCascadeMessage = wrappedSend;
        hooked = true;
      }
      if (hookedLsClients) hookedLsClients.add(lsClient);
      if (hooked) {
        scope?.add?.(() => {
          try {
            if (wrappedSend && lsClient.sendUserCascadeMessage === wrappedSend) {
              lsClient.sendUserCascadeMessage = origSend;
            }
          } catch {}
        });
      }
    } catch {}
    return lsClient;
  }

  // Install `__JETSKI_LS_CLIENT_DECORATOR__` hook safely with cleanup
  let lsDecoratorInstalled = false;
  function installLsClientDecoratorHook() {
    if (lsDecoratorInstalled || !window) return;
    lsDecoratorInstalled = true;
    try {
      const hadOwnDec = Object.prototype.hasOwnProperty.call(window, '__JETSKI_LS_CLIENT_DECORATOR__');
      const prevDec = window.__JETSKI_LS_CLIENT_DECORATOR__;
      const wrappedDec = function (client) {
        const decorated = typeof prevDec === 'function' ? prevDec(client) || client : client;
        if (decorated && typeof decorated === 'object') {
          capturedLsClient = decorated;
          if (
            typeof decorated.subscribeToPlugins === 'function' &&
            typeof decorated.getAllPlugins === 'function' &&
            (!patchedStreamClients || !patchedStreamClients.has(decorated))
          ) {
            if (patchedStreamClients) patchedStreamClients.add(decorated);
            const origSubRaw = decorated.subscribeToPlugins;
            const origSub = origSubRaw.bind(decorated);
            const wrappedSub = function (req, opts) {
              const stream = origSub(req, opts);
              if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream;
              return {
                [Symbol.asyncIterator]() {
                  const it = stream[Symbol.asyncIterator]();
                  let yieldedFirst = false;
                  let pendingFirstNext = null;
                  return {
                    async next() {
                      if (!yieldedFirst) {
                        yieldedFirst = true;
                        let timer;
                        const firstPromise = it.next();
                        firstPromise.catch(() => {});
                        const setT =
                          window && typeof window.setTimeout === 'function'
                            ? window.setTimeout.bind(window)
                            : setTimeout;
                        const clearT =
                          window && typeof window.clearTimeout === 'function'
                            ? window.clearTimeout.bind(window)
                            : clearTimeout;
                        const raceRes = await Promise.race([
                          firstPromise.then((r) => ({ from: 'stream', r })),
                          new Promise((resolve) => {
                            timer = setT(() => resolve({ from: 'timeout' }), 600);
                          }),
                        ]);
                        clearT(timer);
                        if (raceRes.from === 'stream') return raceRes.r;
                        pendingFirstNext = firstPromise;
                        try {
                          const res = await decorated.getAllPlugins({ workspaceUris: [] });
                          return { done: false, value: { plugins: res?.plugins || [] } };
                        } catch {
                          const p = pendingFirstNext;
                          pendingFirstNext = null;
                          return p;
                        }
                      }
                      if (pendingFirstNext) {
                        const p = pendingFirstNext;
                        pendingFirstNext = null;
                        return p;
                      }
                      return it.next();
                    },
                    return(v) {
                      return typeof it.return === 'function' ? it.return(v) : Promise.resolve({ done: true, value: v });
                    },
                    throw(e) {
                      return typeof it.throw === 'function' ? it.throw(e) : Promise.reject(e);
                    },
                  };
                },
              };
            };
            decorated.subscribeToPlugins = wrappedSub;
            scope?.add?.(() => {
              try {
                if (decorated.subscribeToPlugins === wrappedSub) {
                  decorated.subscribeToPlugins = origSubRaw;
                }
              } catch {}
            });
          }
        }
        return decorated;
      };
      window.__JETSKI_LS_CLIENT_DECORATOR__ = wrappedDec;
      scope?.add?.(() => {
        try {
          if (window.__JETSKI_LS_CLIENT_DECORATOR__ === wrappedDec) {
            if (hadOwnDec) window.__JETSKI_LS_CLIENT_DECORATOR__ = prevDec;
            else delete window.__JETSKI_LS_CLIENT_DECORATOR__;
          }
        } catch {}
      });
    } catch {}
  }

  function ensureModelContextWindowOptions(modelObj, extraCw, forceClone = false) {
    if (!modelObj || typeof modelObj !== 'object') return modelObj;
    const curArr = Array.isArray(modelObj.contextWindowOptions) ? modelObj.contextWindowOptions : [];
    const existingNames = new Set(curArr.map((o) => o && o.name).filter(Boolean));
    const wanted = [...PRESET_CONTEXT_WINDOWS];
    if (extraCw && !wanted.includes(extraCw)) {
      wanted.push(extraCw);
    }
    const toAdd = [];
    for (const cw of wanted) {
      if (!existingNames.has(cw)) {
        const limit = cwStore ? cwStore.getLimit(cw) : 256000;
        const hint = cwStore ? cwStore.getQuotaHint(cw) : cw;
        toAdd.push({ name: cw, description: hint, expensive: limit > 256000 });
        existingNames.add(cw);
      }
    }
    if (toAdd.length === 0 && Array.isArray(modelObj.contextWindowOptions)) {
      return modelObj;
    }
    const nextArr = [...curArr, ...toAdd];
    if (!forceClone) {
      try {
        if (Array.isArray(modelObj.contextWindowOptions) && Object.isExtensible(modelObj.contextWindowOptions)) {
          modelObj.contextWindowOptions.push(...toAdd);
          return modelObj;
        }
        if (Object.isExtensible(modelObj)) {
          modelObj.contextWindowOptions = nextArr;
          return modelObj;
        }
      } catch {}
    }
    const wantedKey = wanted.join('|');
    if (frozenModelCloneCache) {
      const byKey = frozenModelCloneCache.get(modelObj);
      if (byKey && byKey.has(wantedKey)) return byKey.get(wantedKey);
    }
    try {
      const proto = Object.getPrototypeOf(modelObj);
      const clone =
        proto && proto !== Object.prototype
          ? Object.assign(Object.create(proto), modelObj, { contextWindowOptions: nextArr })
          : { ...modelObj, contextWindowOptions: nextArr };
      if (frozenModelCloneCache) {
        let byKey = frozenModelCloneCache.get(modelObj);
        if (!byKey) {
          byKey = new Map();
          frozenModelCloneCache.set(modelObj, byKey);
        }
        byKey.set(wantedKey, clone);
      }
      return clone;
    } catch {
      return modelObj;
    }
  }

  function ensureContextWindowSelectorFlag(extraCw) {
    ensureFetchHook(window);
    const cwin = remotePortDriver?.getAccessibleIframeWindow?.();
    if (cwin) ensureFetchHook(cwin);
    if (!document) return;
    const now = Date.now();
    const effectiveExtraKey =
      extraCw && !PRESET_CONTEXT_WINDOWS.includes(extraCw) ? String(extraCw) : '__presets__';
    const docs = [document, remotePortDriver?.getAccessibleIframeDocument?.()].filter(Boolean);
    for (const d of docs) {
      const views = d.querySelectorAll?.('[data-testid="conversation-view"]') || [];
      for (const view of views) {
        const currentCid = view.getAttribute?.('data-cascade-id') || '';
        const prevRec = viewPatchCache ? viewPatchCache.get(view) : null;
        if (
          prevRec &&
          now - prevRec.ts < 3000 &&
          prevRec.extraCw === effectiveExtraKey &&
          prevRec.cid === currentCid
        ) {
          continue;
        }
        const triggerEl = view.querySelector?.('[data-testid="model-selector-trigger"]');
        const startNodes = [triggerEl, view].filter(Boolean);
        let patchedAny = false;
        for (const node of startNodes) {
          const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
          let fiber = fk ? node[fk] : null;
          while (fiber) {
            const val = fiber.memoizedProps?.value;
            if (val && typeof val === 'object') {
              if (typeof val.get === 'function') {
                patchedAny = true;
                if (!patchedCwsObjects || !patchedCwsObjects.has(val)) {
                  try {
                    const origGet = val.get;
                    const wrappedGet = function (name) {
                      if (name === 'contextWindowSelector') {
                        return { enabled: true, feature: { enabled: true } };
                      }
                      return origGet.apply(this, arguments);
                    };
                    val.get = wrappedGet;
                    if (patchedCwsObjects) patchedCwsObjects.add(val);
                    scope?.add?.(() => {
                      try {
                        if (val.get === wrappedGet) val.get = origGet;
                      } catch {}
                    });
                  } catch {}
                }
              }
              if ('corpHost' in val && 'cider' in val && 'contextWindow' in val && val.contextWindow === undefined) {
                try { val.contextWindow = {}; } catch {}
              }
              if (val.selectedModel && typeof val.selectedModel === 'object') {
                patchedAny = true;
                const nextSm = ensureModelContextWindowOptions(val.selectedModel, extraCw);
                if (nextSm !== val.selectedModel && Object.isExtensible(val)) {
                  try { val.selectedModel = nextSm; } catch {}
                }
              }
              if (Array.isArray(val.modelOptions)) {
                patchedAny = true;
                if (Object.isExtensible(val.modelOptions)) {
                  for (let i = 0; i < val.modelOptions.length; i++) {
                    const nextOpt = ensureModelContextWindowOptions(val.modelOptions[i], extraCw);
                    if (nextOpt !== val.modelOptions[i]) {
                      try { val.modelOptions[i] = nextOpt; } catch {}
                    }
                  }
                } else if (Object.isExtensible(val)) {
                  let changedOpt = false;
                  const mapped = val.modelOptions.map((opt) => {
                    const nextOpt = ensureModelContextWindowOptions(opt, extraCw);
                    if (nextOpt !== opt) changedOpt = true;
                    return nextOpt;
                  });
                  if (changedOpt) {
                    try { val.modelOptions = mapped; } catch {}
                  }
                }
              }
              if (val.store && typeof val.store.getState === 'function') {
                patchedAny = true;
                const st = val.store.getState();
                const clientConfigs = st?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
                if (Array.isArray(clientConfigs)) {
                  let storeRec = patchedStoreConfigsCache ? patchedStoreConfigsCache.get(val.store) : null;
                  const alreadyHandledRef =
                    storeRec &&
                    storeRec.configsRefs.has(clientConfigs) &&
                    storeRec.extraCwKeys.has(effectiveExtraKey);
                  if (!alreadyHandledRef) {
                    let needsReduxUpdate = false;
                    const updatedConfigs = [];
                    for (const cfg of clientConfigs) {
                      const nextCfg = ensureModelContextWindowOptions(cfg, extraCw, true);
                      updatedConfigs.push(nextCfg);
                      if (nextCfg !== cfg) needsReduxUpdate = true;
                    }
                    if (!storeRec && patchedStoreConfigsCache) {
                      storeRec = { configsRefs: new WeakSet(), extraCwKeys: new Set() };
                      patchedStoreConfigsCache.set(val.store, storeRec);
                    }
                    if (storeRec) {
                      storeRec.configsRefs.add(clientConfigs);
                      storeRec.configsRefs.add(updatedConfigs);
                      storeRec.extraCwKeys.add(effectiveExtraKey);
                    }
                    if (needsReduxUpdate && typeof val.store.dispatch === 'function') {
                      try {
                        val.store.dispatch({
                          type: 'userStatus/setUserStatus',
                          payload: {
                            ...st.userStatus,
                            cascadeModelConfigData: {
                              ...st.userStatus.cascadeModelConfigData,
                              clientModelConfigs: updatedConfigs,
                            },
                          },
                        });
                        const afterConfigs = val.store.getState()?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
                        if (storeRec && Array.isArray(afterConfigs)) {
                          storeRec.configsRefs.add(afterConfigs);
                        }
                      } catch {}
                    }
                  }
                }
              }
            }
            fiber = fiber.return;
          }
        }
        if (patchedAny && viewPatchCache) {
          viewPatchCache.set(view, { ts: now, extraCw: effectiveExtraKey, cid: currentCid });
        }
      }
    }
  }

  function ensureCustomizationsStoreLoaded() {
    if (!document) return;
    const now = Date.now();
    const docs = [document, remotePortDriver?.getAccessibleIframeDocument?.()].filter(Boolean);
    for (const d of docs) {
      const cachedStore = cachedCustomizationsStores?.get(d);
      if (cachedStore && cachedStore.hasReceivedStreamSnapshot && cachedStore.streamingDisabled) {
        continue;
      }
      const views = d.querySelectorAll?.('[data-testid="conversation-view"]') || [];
      const rootEl = d.querySelector?.('#root, #app') || d.body?.firstElementChild;
      const startNodes = [...views, rootEl, d].filter(Boolean);
      for (const node of startNodes) {
        const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
        const rawRoot = fk ? node[fk] : null;
        const startFiber = rawRoot?.stateNode?.current || rawRoot;
        if (!startFiber) continue;
        let up = startFiber;
        let foundStore = null;
        while (up) {
          const val = up.memoizedProps?.value;
          if (val && typeof val === 'object' && val.state && typeof val.receiveStreamedPlugins === 'function' && typeof val.refresh === 'function') {
            foundStore = val;
            break;
          }
          up = up.return;
        }
        if (!foundStore && (node === rootEl || node === d)) {
          const lastDfs = lastCustomizationsDfsByDoc?.get(d) || 0;
          if (lastDfs && now - lastDfs < 10000) continue;
          lastCustomizationsDfsByDoc?.set(d, now);
          const stack = [startFiber];
          const visited = new Set();
          while (stack.length > 0 && visited.size < 2500) {
            const f = stack.pop();
            if (!f || visited.has(f)) continue;
            visited.add(f);
            const val = f.memoizedProps?.value;
            if (val && typeof val === 'object' && val.state && typeof val.receiveStreamedPlugins === 'function' && typeof val.refresh === 'function') {
              foundStore = val;
              break;
            }
            if (f.sibling) stack.push(f.sibling);
            if (f.child) stack.push(f.child);
          }
        }
        if (foundStore) {
          cachedCustomizationsStores?.set(d, foundStore);
          try {
            if (typeof foundStore.disableStreaming === 'function' && !foundStore.streamingDisabled) {
              foundStore.disableStreaming();
            }
            const st = typeof foundStore.state?.getState === 'function' ? foundStore.state.getState() : null;
            if ((!foundStore.hasReceivedStreamSnapshot || st?.isLoadingPlugins) && !triggeredStoreRefresh?.has(foundStore)) {
              triggeredStoreRefresh?.add(foundStore);
              Promise.resolve(foundStore.refresh()).catch(() => {
                triggeredStoreRefresh?.delete(foundStore);
              });
            }
          } catch {}
          break;
        }
      }
    }
  }

  function getModelSelectorContextForView(view, extraCw) {
    ensureContextWindowSelectorFlag(extraCw);
    const effView = resolveEffectiveView(view);
    if (!effView) return null;
    const now = Date.now();
    const currentCid = effView.getAttribute?.('data-cascade-id') || view?.getAttribute?.('data-cascade-id') || '';
    const cachedRec = viewMsCtxCache?.get(effView);
    if (
      cachedRec &&
      cachedRec.cid === currentCid &&
      now - cachedRec.ts < 400 &&
      (!cachedRec.ctx.triggerEl || cachedRec.ctx.triggerEl.isConnected !== false) &&
      (cachedRec.ctx.msCtx || cachedRec.ctx.reduxStore || cachedRec.ctx.legacyCtx)
    ) {
      if (cachedRec.ctx.msCtx?.selectedModel) {
        ensureModelContextWindowOptions(cachedRec.ctx.msCtx.selectedModel, extraCw);
      }
      return cachedRec.ctx;
    }
    const triggerEl = effView.querySelector?.('[data-testid="model-selector-trigger"]') || null;
    const startEl = triggerEl || effView;
    const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? startEl[fk] : null;
    let msCtx = null;
    let setSelectedModelWithCw = null;
    let reduxStore = null;
    let legacyCtx = null;
    while (fiber) {
      const props = fiber.memoizedProps;
      if (!setSelectedModelWithCw && typeof props?.setSelectedModel === 'function' && props.setSelectedModel.length >= 2) {
        setSelectedModelWithCw = props.setSelectedModel;
      }
      const val = props?.value;
      if (val && typeof val === 'object') {
        if (!msCtx && typeof val.setSelectedModel === 'function' && ('selectedModel' in val)) {
          msCtx = val;
        }
        if (!setSelectedModelWithCw && typeof val.setSelectedModel === 'function' && val.setSelectedModel.length >= 2) {
          setSelectedModelWithCw = val.setSelectedModel;
        }
        if (!reduxStore && val.store && typeof val.store.dispatch === 'function' && typeof val.store.getState === 'function') {
          reduxStore = val.store;
        }
        if (!legacyCtx && typeof val.setModelForConversation === 'function') {
          legacyCtx = val;
        }
      }
      fiber = fiber.return;
    }
    if (msCtx?.selectedModel) {
      ensureModelContextWindowOptions(msCtx.selectedModel, extraCw);
    }
    const res = { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl };
    if ((msCtx || reduxStore || legacyCtx) && viewMsCtxCache) {
      viewMsCtxCache.set(effView, { ctx: res, ts: now, cid: currentCid });
    }
    return res;
  }

  function getCascadeContextForElement(el) {
    const effEl = resolveEffectiveInputBox(resolveEffectiveView(el));
    const candidates = [
      effEl,
      effEl?.closest?.('[data-testid="conversation-view"]'),
      document?.querySelector?.('[data-testid="conversation-view"]'),
    ].filter(Boolean);
    for (const node of candidates) {
      const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
      let curr = fk ? node[fk] : null;
      while (curr) {
        const val = curr.memoizedProps?.value;
        if (val?.cascadeContext?.state?.agentStateProvider) {
          return val.cascadeContext;
        }
        if (val?.state?.agentStateProvider && (val?.debug || val?.cascadeContext !== undefined || val?.state)) {
          return val;
        }
        curr = curr.return;
      }
    }
    return null;
  }

  function getRemoteRpcServiceForElement(el) {
    if (
      capturedLsClient &&
      (typeof capturedLsClient.retrieveUserQuotaSummary === 'function' ||
        typeof capturedLsClient.getCascadeTrajectory === 'function')
    ) {
      return hookLsClient(capturedLsClient);
    }
    const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
    const effBox = resolveEffectiveInputBox(resolveEffectiveView(el));
    const candidates = [
      effBox,
      el,
      document?.querySelector?.('[data-testid="conversation-view"]'),
      cdoc?.querySelector?.('[data-testid="conversation-view"]'),
    ].filter(Boolean);
    for (const startEl of candidates) {
      const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
      let curr = fk ? startEl[fk] : null;
      while (curr) {
        const val = curr.memoizedProps?.value;
        if (val && typeof val === 'object') {
          if (
            typeof val.retrieveUserQuotaSummary === 'function' ||
            typeof val.getCascadeTrajectory === 'function' ||
            typeof val.getAllCascadeTrajectories === 'function' ||
            typeof val.updateConversationAnnotations === 'function'
          ) {
            return hookLsClient(val);
          }
          const lsClient =
            val.core?.projectManagementService?.lsClient ||
            val.projectManagementService?.lsClient ||
            val.lsClient;
          if (
            lsClient &&
            (typeof lsClient.retrieveUserQuotaSummary === 'function' ||
              typeof lsClient.getCascadeTrajectory === 'function' ||
              typeof lsClient.getAllCascadeTrajectories === 'function' ||
              typeof lsClient.updateConversationAnnotations === 'function')
          ) {
            return hookLsClient(lsClient);
          }
        }
        curr = curr.return;
      }
    }
    const rcInst = remotePortDriver?.resolveInstance?.();
    if (rcInst && typeof rcInst.proxyCommand === 'function') {
      return remotePortDriver.createRcServiceAdapter(rcInst, codec, injectCheckpointLimitIntoSendRequest);
    }
    return null;
  }

  function getSelectedModelKey(view, sessionId, infoOpt) {
    const info = infoOpt || getModelSelectorContextForView(view);
    const state = info?.reduxStore ? info.reduxStore.getState() : null;
    const byConvo = state?.modelSelection?.byConversation?.[sessionId];
    const sm = info?.msCtx?.selectedModel;
    const raw =
      byConvo?.model ??
      (sm && typeof sm === 'object' ? (sm.value ?? sm.label) : sm) ??
      state?.modelSelection?.default?.model ??
      info?.legacyCtx?.getModelConfigForConversation?.(sessionId)?.value ??
      '';
    return `${sessionId || ''}:${String(raw ?? '')}`;
  }

  function sanitizePoisonedModelSelection(reduxStore) {
    if (!reduxStore || typeof reduxStore.getState !== 'function' || typeof reduxStore.dispatch !== 'function') {
      return;
    }
    try {
      if (sanitizedStores && sanitizedStores.has(reduxStore)) return;
      const st = reduxStore.getState();
      const ms = st?.modelSelection;
      if (!ms || typeof ms !== 'object') return;
      const syncMap = ms.trajectorySync;
      const byConvoMap = ms.byConversation;
      if (!syncMap || typeof syncMap !== 'object') return;

      const overrideDefaultModel = extractModelValFromModelOrAlias(
        st?.userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias
      );
      let cleanConvoModel;
      for (const cid of Object.keys(syncMap)) {
        const entry = syncMap[cid];
        const step = entry?.pick?.atStep;
        if (step === undefined || step === -1) {
          const syncedLabel = extractLabelFromSyncedKey(entry?.syncedKey);
          const mVal = resolveModelValueFromLabel(st, syncedLabel);
          if (mVal !== undefined) {
            cleanConvoModel = mVal;
            if (syncedLabel && /\(medium\)/i.test(syncedLabel)) break;
          }
        }
      }

      const preferredModel = overrideDefaultModel ?? cleanConvoModel;
      if (preferredModel === undefined) return;

      const poisonedCids = [];
      let recoveredTargetModel;

      for (const cid of Object.keys(syncMap)) {
        const entry = syncMap[cid];
        const step = entry?.pick?.atStep;
        const hasSyncedKey = typeof entry?.syncedKey === 'string' && entry.syncedKey.length > 0;
        const syncedLabel = extractLabelFromSyncedKey(entry?.syncedKey);
        const isRelocked =
          hasSyncedKey &&
          (step === 0 || (typeof step === 'number' && step > 0 && entry?.pick?.checkedTurnKey !== undefined));
        if (step === 999999 || isRelocked) {
          poisonedCids.push(cid);
          const syncedModelVal = resolveModelValueFromLabel(st, syncedLabel);
          if (syncedModelVal !== undefined && recoveredTargetModel === undefined) {
            recoveredTargetModel = syncedModelVal;
          }
        }
      }

      if (poisonedCids.length === 0 && ms.default?.model === preferredModel) {
        sanitizedStores?.add(reduxStore);
        return;
      }
      sanitizedStores?.add(reduxStore);

      const currentDefaultModel = ms.default?.model;
      const currentDefaultCustomLabel = ms.default?.customLabel;
      const desiredDefaultCw = cwStore?.hasExplicitDefaultCw?.()
        ? cwStore.getDefaultCw()
        : (ms.default?.contextWindow || '256K');
      const safeDefaultModel = preferredModel ?? recoveredTargetModel ?? currentDefaultModel;

      for (const cid of poisonedCids) {
        const entry = syncMap[cid];
        const convo = byConvoMap?.[cid];
        const syncedLabel = extractLabelFromSyncedKey(entry?.syncedKey);
        const syncedModelVal = resolveModelValueFromLabel(st, syncedLabel);
        const targetModel =
          syncedLabel && !/\(low\)/i.test(syncedLabel) && syncedModelVal !== undefined
            ? syncedModelVal
            : (preferredModel ?? syncedModelVal ?? safeDefaultModel ?? convo?.model);
        const targetCw = cwStore?.getSavedContextWindow?.(cid) || convo?.contextWindow || desiredDefaultCw;
        if (targetModel !== undefined) {
          reduxStore.dispatch({
            type: 'modelSelection/modelPicked',
            payload: {
              conversationId: cid,
              model: targetModel,
              customLabel: undefined,
              contextWindow: targetCw,
              pick: { atStep: -1, queuedMessageIds: [] },
            },
          });
        }
      }

      if (safeDefaultModel !== undefined) {
        reduxStore.dispatch({
          type: 'modelSelection/modelPicked',
          payload: {
            conversationId: undefined,
            model: safeDefaultModel,
            customLabel: safeDefaultModel === currentDefaultModel ? currentDefaultCustomLabel : undefined,
            contextWindow: desiredDefaultCw,
          },
        });
      }
    } catch {}
  }

  function applyContextLimit(arg1, sessionIdArg, cwArg, userTriggeredArg = false) {
    const isOptsObj = Boolean(
      arg1 &&
        typeof arg1 === 'object' &&
        arg1.nodeType === undefined &&
        ('contextWindow' in arg1 || 'viewEl' in arg1 || 'sessionId' in arg1)
    );
    const viewEl = isOptsObj ? arg1.viewEl : arg1;
    const sessionId = isOptsObj ? arg1.sessionId : sessionIdArg;
    const contextWindow = isOptsObj ? arg1.contextWindow : cwArg;
    const userTriggered = isOptsObj ? Boolean(arg1.userTriggered) : Boolean(userTriggeredArg);

    const targetCw = cwStore?.normalize?.(contextWindow);
    if (!viewEl || !sessionId || !targetCw) return false;
    const info = getModelSelectorContextForView(viewEl, targetCw);
    if (!info) return false;

    const { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl } = info;
    if (reduxStore) sanitizePoisonedModelSelection(reduxStore);
    if (triggerEl && typeof triggerEl.setAttribute === 'function') {
      const warnAttr = cwStore.getLimit(targetCw) > 256000 ? '1' : '0';
      if (triggerEl.getAttribute('data-agy-cw-warn') !== warnAttr) {
        triggerEl.setAttribute('data-agy-cw-warn', warnAttr);
      }
    }
    const currentInDom = triggerEl ? cwStore.normalize(triggerEl.getAttribute?.('data-context-window')) : null;
    const selectedModel = getSelectedModelKey(viewEl, sessionId, info);
    const applyKey = (selectedModel || '') + ':' + String(targetCw);
    const lastAppliedForCascade = lastAppliedCwByCascade.get(sessionId);
    const initialState = reduxStore ? reduxStore.getState() : null;
    const initialByConvo = initialState?.modelSelection?.byConversation?.[sessionId];
    const defaultReduxCw = cwStore.normalize(initialState?.modelSelection?.default?.contextWindow) || '256K';
    const effectiveInitialReduxCw = cwStore.normalize(initialByConvo?.contextWindow) || defaultReduxCw;
    const reduxAlreadyMatches = !reduxStore || effectiveInitialReduxCw === targetCw;

    if (
      (currentInDom === targetCw || lastAppliedForCascade === applyKey || lastAppliedCwGlobal === applyKey) &&
      reduxAlreadyMatches &&
      !userTriggered
    ) {
      lastAppliedCwGlobal = applyKey;
      setBoundedLruMap(lastAppliedCwByCascade, sessionId, applyKey, MAX_CASCADE_MAP_ENTRIES);
      setTriggerCwAttribute(triggerEl, targetCw);
      return true;
    }

    if (msCtx || reduxStore) {
      const state = initialState;
      const byConvo = initialByConvo;
      const currentInRedux = reduxStore
        ? effectiveInitialReduxCw
        : (cwStore.normalize(msCtx?.contextWindow?.selected) || currentInDom || '256K');
      const selectedModelObj = msCtx?.selectedModel;
      if (selectedModelObj) ensureModelContextWindowOptions(selectedModelObj, targetCw);
      let dispatched = false;

      if (currentInRedux !== targetCw || userTriggered) {
        const prevDefault = state?.modelSelection?.default;
        const prevDefaultModel = prevDefault?.model;
        const prevDefaultCustomLabel = prevDefault?.customLabel;
        const prevDefaultCw = prevDefault?.contextWindow;
        if (reduxStore) {
          const syncEntry = state?.modelSelection?.trajectorySync?.[sessionId];
          const syncedModelVal =
            syncEntry?.pick?.atStep === 999999
              ? resolveModelValueFromLabel(state, extractLabelFromSyncedKey(syncEntry?.syncedKey))
              : undefined;
          const modelVal = syncedModelVal ?? byConvo?.model ?? selectedModelObj?.value ?? prevDefaultModel;
          const isCustomModel = Boolean(selectedModelObj?.isCustom && selectedModelObj?.value === modelVal);
          const customLabel = isCustomModel ? selectedModelObj?.label : undefined;
          if (modelVal !== undefined) {
            reduxStore.dispatch({
              type: 'modelSelection/modelPicked',
              payload: {
                conversationId: sessionId,
                model: modelVal,
                customLabel,
                contextWindow: targetCw,
              },
            });
            dispatched = true;
          }
        } else if (msCtx?.contextWindow && typeof msCtx.contextWindow.select === 'function' && selectedModelObj) {
          msCtx.contextWindow.select(selectedModelObj, targetCw);
          dispatched = true;
        } else if (typeof setSelectedModelWithCw === 'function' && selectedModelObj) {
          setSelectedModelWithCw(selectedModelObj, targetCw);
          dispatched = true;
        } else if (typeof msCtx?.setSelectedModel === 'function' && selectedModelObj) {
          msCtx.setSelectedModel(selectedModelObj, targetCw);
          dispatched = true;
        }

        if (dispatched && reduxStore) {
          const nextState = reduxStore.getState();
          const defObj = nextState?.modelSelection?.default;
          const desiredDefaultCw =
            prevDefaultCw !== undefined
              ? prevDefaultCw
              : (cwStore.hasExplicitDefaultCw?.() ? cwStore.getDefaultCw() : '256K');
          const desiredDefaultModel = prevDefaultModel !== undefined ? prevDefaultModel : defObj?.model;
          const desiredDefaultCustomLabel =
            prevDefaultModel !== undefined ? prevDefaultCustomLabel : defObj?.customLabel;
          const defCwNormalized = cwStore.normalize(defObj?.contextWindow) || '256K';
          const desiredCwNormalized = cwStore.normalize(desiredDefaultCw) || '256K';
          if (
            defObj &&
            (defObj.model !== desiredDefaultModel ||
              defObj.customLabel !== desiredDefaultCustomLabel ||
              defCwNormalized !== desiredCwNormalized)
          ) {
            reduxStore.dispatch({
              type: 'modelSelection/modelPicked',
              payload: {
                conversationId: undefined,
                model: desiredDefaultModel,
                customLabel: desiredDefaultCustomLabel,
                contextWindow: desiredDefaultCw,
              },
            });
          }
        }
      }

      if (dispatched || currentInRedux === targetCw) {
        lastAppliedCwGlobal = applyKey;
        setBoundedLruMap(lastAppliedCwByCascade, sessionId, applyKey, MAX_CASCADE_MAP_ENTRIES);
        setTriggerCwAttribute(triggerEl, targetCw);
        return true;
      }
      return false;
    }

    if (legacyCtx) {
      const modelCfg = legacyCtx.getModelConfigForConversation(sessionId);
      if (!modelCfg || modelCfg.value === undefined) return false;
      const currentInEngine = legacyCtx.getContextWindowForConversation(sessionId) || '256K';
      if (currentInEngine !== targetCw || userTriggered) {
        if (currentInEngine === targetCw && currentInDom !== targetCw) {
          const tempCw = targetCw === '256K' ? '512K' : '256K';
          legacyCtx.setModelForConversation(sessionId, modelCfg.value, true, modelCfg.label, tempCw);
        }
        legacyCtx.setModelForConversation(sessionId, modelCfg.value, true, modelCfg.label, targetCw);
      }
      lastAppliedCwGlobal = applyKey;
      setBoundedLruMap(lastAppliedCwByCascade, sessionId, applyKey, MAX_CASCADE_MAP_ENTRIES);
      setTriggerCwAttribute(triggerEl, targetCw);
      return true;
    }
    return false;
  }

  function pullAndBackfillTrajectorySummaries(summaries, csrf, viewOrEl) {
    if (!summaries || typeof summaries !== 'object' || typeof cwStore?.syncFromRemoteAnnotations !== 'function') {
      return false;
    }
    const { changed, unsyncedLocalIds } = cwStore.syncFromRemoteAnnotations(summaries);
    if (Array.isArray(unsyncedLocalIds) && unsyncedLocalIds.length > 0 && transport?.updateAnnotations) {
      for (const cid of unsyncedLocalIds) {
        const profileStr = cwStore.encodeRemoteAnnotationProfile(cid);
        if (profileStr) {
          transport
            .updateAnnotations({
              cascadeIds: [cid],
              annotations: { activeProfile: profileStr },
              mergeAnnotations: true,
              el: viewOrEl,
              csrf,
            })
            .catch?.(() => {});
        }
      }
    }
    if (changed && typeof onRemoteAnnotationsUpdated === 'function') {
      try { onRemoteAnnotationsUpdated(); } catch {}
    }
    return changed;
  }

  function syncDesktopAnnotations(csrf, viewOrEl, force = false) {
    const nativeView = document?.querySelector?.('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
    if (!nativeView && document?.querySelector?.('ga-remote-control')) return Promise.resolve(false);
    const now = Date.now();
    if (desktopTrajectorySyncInFlight || (!force && now - lastDesktopTrajectorySyncTs < 4000)) {
      return Promise.resolve(false);
    }
    if (!transport?.getAllTrajectories) return Promise.resolve(false);

    lastDesktopTrajectorySyncTs = now;
    desktopTrajectorySyncInFlight = true;
    return Promise.resolve(transport.getAllTrajectories(viewOrEl, csrf))
      .then((all) => {
        const summaries = all?.trajectorySummaries;
        if (summaries) return pullAndBackfillTrajectorySummaries(summaries, csrf, viewOrEl);
        return false;
      })
      .catch(() => false)
      .finally(() => {
        desktopTrajectorySyncInFlight = false;
      });
  }

  function ensureRemoteHostView(onCascadeChange) {
    if (!document) return null;
    const nativeView = document.querySelector?.('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
    if (nativeView) return null;
    const rcEl = document.querySelector?.('ga-remote-control');
    if (!rcEl) return null;

    const rcInst = remotePortDriver?.resolveInstance?.();
    const appContainer = rcEl.querySelector?.('.app-container') || rcEl;
    let hostView = appContainer.querySelector?.('.agy-rc-host-view') || null;
    if (!hostView) {
      hostView = document.createElement('div');
      hostView.className = 'agy-rc-host-view';
      hostView.setAttribute('data-testid', 'conversation-view');
      const hostBox = document.createElement('div');
      hostBox.className = 'agy-rc-host-box';
      hostBox.setAttribute('data-testid', 'agent-input-box');
      hostView.appendChild(hostBox);
      appContainer.appendChild(hostView);
    }

    const stateRec = hostViewState?.get(hostView) || { lastChildPathCid: '', observedSteps: -1 };
    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
    const innerView = cdoc?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
    const rawInnerCid = innerView?.getAttribute?.('data-cascade-id');
    const innerCid = rawInnerCid && UUID_RE.test(rawInnerCid) && rawInnerCid !== ignoreUuid ? rawInnerCid : '';

    const childPath = rcInst?.lastSyncedChildPath || window?.location?.search || '';
    const pathMatch = String(childPath).match(UUID_RE);
    const pathCid = pathMatch && pathMatch[0] && pathMatch[0] !== ignoreUuid ? pathMatch[0] : '';

    let activeCid = '';
    if (innerCid) {
      activeCid = innerCid;
      if (activeSniffedCascadeId !== innerCid) activeSniffedCascadeId = innerCid;
    } else if (pathCid && pathCid !== stateRec.lastChildPathCid) {
      stateRec.lastChildPathCid = pathCid;
      activeCid = pathCid;
      activeSniffedCascadeId = pathCid;
    } else {
      activeCid = activeSniffedCascadeId || pathCid || '';
    }
    hostViewState?.set(hostView, stateRec);

    const currentAttr = hostView.getAttribute('data-cascade-id');
    const nextAttr = activeCid || currentAttr || 'remote-session';
    if (currentAttr !== nextAttr) {
      if (currentAttr === 'remote-session' && nextAttr !== 'remote-session') {
        cwStore?.migrateSessionOverride?.('remote-session', nextAttr);
      }
      hostView.setAttribute('data-cascade-id', nextAttr);
    }

    const now = Date.now();
    if (rcInst && !rcTrajectoryPollInFlight && (now - lastRcTrajectoryPollTs >= 2500 || nextAttr === 'remote-session')) {
      lastRcTrajectoryPollTs = now;
      rcTrajectoryPollInFlight = true;
      const rcSvc = remotePortDriver.createRcServiceAdapter(rcInst, codec, injectCheckpointLimitIntoSendRequest);
      rcSvc
        .getAllCascadeTrajectories()
        .then((all) => {
          const summaries = all?.trajectorySummaries || {};
          const entries = Object.entries(summaries);
          if (!entries.length) return;
          const cwChanged = pullAndBackfillTrajectorySummaries(summaries, null, hostView);
          for (const [id, sum] of entries) {
            if (typeof sum?.stepCount === 'number') {
              transport?.recordStepEvent?.(id, sum.stepCount);
            }
          }
          entries.sort((a, b) => {
            const vA = Date.parse(a[1]?.annotations?.lastUserViewTime || 0) || 0;
            const vB = Date.parse(b[1]?.annotations?.lastUserViewTime || 0) || 0;
            if (vA !== vB) return vB - vA;
            const mA = Date.parse(a[1]?.lastModifiedTime || 0) || 0;
            const mB = Date.parse(b[1]?.lastModifiedTime || 0) || 0;
            return mB - mA;
          });
          const [latestId] = entries[0];
          if (latestId) {
            const prevId = hostView.getAttribute('data-cascade-id');
            const hasValidActive = Boolean(
              activeSniffedCascadeId && activeSniffedCascadeId !== 'remote-session' && summaries[activeSniffedCascadeId]
            );
            if (!hasValidActive && (!prevId || prevId === 'remote-session' || !summaries[prevId])) {
              activeSniffedCascadeId = latestId;
            }
            const resolvedId = activeSniffedCascadeId || (prevId && prevId !== 'remote-session' ? prevId : latestId);
            if (prevId === 'remote-session' && resolvedId && resolvedId !== 'remote-session') {
              cwStore?.migrateSessionOverride?.('remote-session', resolvedId);
            }
            const nextSteps = transport?.getStepCount?.(resolvedId) ?? -1;
            const prevSteps = stateRec.observedSteps;
            stateRec.observedSteps = nextSteps;
            hostViewState?.set(hostView, stateRec);
            if (prevId !== resolvedId || prevSteps !== nextSteps || cwChanged) {
              hostView.setAttribute('data-cascade-id', resolvedId);
              if (typeof onCascadeChange === 'function') onCascadeChange(resolvedId);
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          rcTrajectoryPollInFlight = false;
        });
    }

    return hostView;
  }

  function getActiveSessions(onCascadeChange) {
    ensureCustomizationsStoreLoaded();
    ensureRemoteHostView(onCascadeChange);
    const sessions = [];
    const seenBoxes = new Set();
    const views = Array.from(document?.querySelectorAll?.('[data-testid="conversation-view"]') || []);
    const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
    if (cdoc) {
      views.push(...Array.from(cdoc.querySelectorAll?.('[data-testid="conversation-view"]') || []));
    }

    for (const viewEl of views) {
      const boxEl = viewEl.querySelector?.('[data-testid="agent-input-box"]') || null;
      if (!boxEl || seenBoxes.has(boxEl)) continue;
      seenBoxes.add(boxEl);

      const isRemoteShell = Boolean(viewEl.classList?.contains?.('agy-rc-host-view'));
      let sessionId = viewEl.getAttribute?.('data-cascade-id') || '';
      if (!sessionId || sessionId === 'remote-session') {
        const effView = resolveEffectiveView(viewEl);
        const effCid = effView?.getAttribute?.('data-cascade-id');
        if (effCid && effCid !== 'remote-session') {
          sessionId = effCid;
        } else if (activeSniffedCascadeId) {
          sessionId = activeSniffedCascadeId;
        }
      }
      const effView = resolveEffectiveView(viewEl);
      const triggerEl = effView?.querySelector?.('[data-testid="model-selector-trigger"]') || null;
      let observedEngineCw = triggerEl?.getAttribute?.('data-context-window') || '';
      if (!observedEngineCw && sessionId && sessionId !== 'remote-session') {
        const info = getModelSelectorContextForView(effView);
        const st = info?.reduxStore ? info.reduxStore.getState() : null;
        observedEngineCw =
          st?.modelSelection?.byConversation?.[sessionId]?.contextWindow ||
          info?.legacyCtx?.getContextWindowForConversation?.(sessionId) ||
          '';
      }
      sessions.push({
        sessionId: sessionId || 'remote-session',
        viewEl,
        inputEl: boxEl,
        triggerEl,
        isRemoteShell,
        observedEngineCw: observedEngineCw || undefined,
      });
    }
    return sessions;
  }

  function getAgentStateProviderForInputBox(inputBox, sessionIdOpt) {
    const cc = getCascadeContextForElement(inputBox);
    if (cc?.state?.agentStateProvider) return cc.state.agentStateProvider;
    const cid = sessionIdOpt || activeSniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id');
    const steps = cid && transport?.getStepCount ? transport.getStepCount(cid) : -1;
    const knownGenLen = cid && transport?.getKnownGenLen ? transport.getKnownGenLen(cid) : 0;
    if ((typeof steps === 'number' && steps >= 0) || (typeof knownGenLen === 'number' && knownGenLen > 0)) {
      return {
        getState: () => ({
          conversationId: cid,
          trajectorySlice: {
            totalGeneratorMetadataLength: -1,
            totalStepsLength: typeof steps === 'number' ? steps : -1,
          },
        }),
      };
    }
    return null;
  }

  function getDebugSnapshot(arg1, arg2, arg3) {
    let viewEl = null;
    let inputBox = null;
    let sessionId = '';
    if (typeof arg1 === 'string') {
      sessionId = arg1;
      viewEl = arg2 || null;
    } else {
      viewEl = arg1 || null;
      inputBox = arg2 || null;
      sessionId =
        (typeof arg3 === 'string' && arg3) ||
        viewEl?.getAttribute?.('data-cascade-id') ||
        activeSniffedCascadeId ||
        '';
    }
    const cc = getCascadeContextForElement(viewEl || inputBox);
    const asp = getAgentStateProviderForInputBox(inputBox || viewEl, sessionId);
    const rawState = asp?.getState?.();
    const stateMatches = isStateForCascade(rawState, sessionId);
    const slice = stateMatches ? rawState?.trajectorySlice : null;
    const rcGenLen = transport?.getKnownGenLen?.(sessionId) || 0;
    const rcStepLen = transport?.getStepCount?.(sessionId) ?? -1;
    const totalGenLen =
      typeof slice?.totalGeneratorMetadataLength === 'number' && slice.totalGeneratorMetadataLength > 0
        ? slice.totalGeneratorMetadataLength
        : (rcGenLen > 0 ? rcGenLen : 0);
    const totalStepsLen =
      typeof slice?.totalStepsLength === 'number' && slice.totalStepsLength > 0
        ? slice.totalStepsLength
        : (rcStepLen > 0 ? rcStepLen : 0);

    const msInfo = viewEl ? getModelSelectorContextForView(viewEl) : null;
    const msState = msInfo?.reduxStore ? msInfo.reduxStore.getState() : null;
    const rawReduxCw =
      (sessionId && msState?.modelSelection?.byConversation?.[sessionId]?.contextWindow) ||
      msState?.modelSelection?.default?.contextWindow ||
      msInfo?.legacyCtx?.getContextWindowForConversation?.(sessionId) ||
      null;
    const reduxSessionCw = rawReduxCw ? cwStore?.normalize?.(rawReduxCw) || null : null;
    const rpcSvc = getRemoteRpcServiceForElement(inputBox || viewEl);

    return {
      cascadeId: sessionId,
      reduxSessionCw,
      hasRemoteSvc: Boolean(rpcSvc && rpcSvc.isRemoteControlHost),
      totalGenLen,
      totalStepsLen,
      trajectoryId: slice?.trajectoryId || '',
      rawState: stateMatches ? rawState : null,
      canToggleInlineDebug: Boolean(cc?.debug && typeof cc.debug.setDebugMode === 'function'),
      toggleInlineDebug() {
        const curCc = getCascadeContextForElement(viewEl || inputBox);
        if (curCc?.debug && typeof curCc.debug.setDebugMode === 'function') {
          curCc.debug.setDebugMode(!curCc.debug.debugMode);
        }
      },
    };
  }

  function observeSessions(onRelevantChange) {
    const MoCtor = window?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const rootTarget = document?.body || document?.documentElement || null;
    if (!MoCtor || !rootTarget) return () => {};

    const isIgnoredNode = (node) => {
      let cur = node && node.nodeType === 3 ? node.parentElement : node;
      while (cur && cur.nodeType === 1) {
        if (
          cur.id === 'agy-ctx-statusbar-style' ||
          cur.id === 'agy-ctx-debug-modal' ||
          (cur.classList &&
            (cur.classList.contains('agy-ctx-statusbar') ||
              cur.classList.contains('agy-ctx-menu') ||
              cur.classList.contains('agy-ctx-modal-backdrop'))) ||
          (cur.getAttribute && cur.getAttribute('data-agy-no-translate') === 'true')
        ) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    const obsOptions = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cascade-id', 'data-context-window'],
    };

    const observers = [];
    const observedDocs = typeof WeakSet === 'function' ? new WeakSet() : null;

    const handleMutations = (mutations) => {
      if (!mutations || mutations.length === 0) return;
      attachChildIframeObserver();
      let relevant = false;
      for (const m of mutations) {
        if (!isIgnoredNode(m.target)) {
          relevant = true;
          break;
        }
      }
      if (relevant && typeof onRelevantChange === 'function') {
        onRelevantChange();
      }
    };

    const observeDocTarget = (targetDoc) => {
      if (!targetDoc) return;
      if (observedDocs && observedDocs.has(targetDoc)) return;
      const targetNode = targetDoc.body || targetDoc.documentElement;
      if (!targetNode) return;
      try {
        const WinMo = targetDoc.defaultView?.MutationObserver || MoCtor;
        const o = new WinMo(handleMutations);
        o.observe(targetNode, obsOptions);
        observers.push(o);
        observedDocs?.add(targetDoc);
      } catch {}
    };

    const attachChildIframeObserver = () => {
      const cdoc = remotePortDriver?.getAccessibleIframeDocument?.();
      if (cdoc && cdoc !== document) {
        observeDocTarget(cdoc);
      }
    };

    observeDocTarget(document);
    attachChildIframeObserver();
    const iframePollId = scope?.setInterval?.(() => {
      if (!scope.isDisposed()) attachChildIframeObserver();
    }, 1500);

    const stop = () => {
      if (iframePollId !== null && iframePollId !== undefined) {
        scope?.clearInterval?.(iframePollId);
      }
      for (const o of observers) {
        try { o.disconnect(); } catch {}
      }
      observers.length = 0;
    };
    scope?.add?.(stop);
    return stop;
  }

  // Trigger initial fetch + LS decorator setup when constructed
  installLsClientDecoratorHook();
  ensureFetchHook(window);

  return {
    observeSessions,
    getActiveSessions,
    applyContextLimit,
    triggerCompact: () => false, // Composed in coordinator via CompactDriver
    getSelectedModelKey,
    getDebugSnapshot,
    getAgentStateProviderForInputBox,
    getRemoteRpcServiceForElement,
    getModelSelectorContextForView,
    ensureContextWindowSelectorFlag,
    ensureCustomizationsStoreLoaded,
    ensureRemoteHostView,
    syncDesktopAnnotations,
    injectCheckpointLimitIntoSendRequest,
    sniffCascadeIdFromRpc,
    resolveEffectiveInputBox,
    resolveEffectiveView,
    getActiveSniffedCascadeId: () => activeSniffedCascadeId,
    setActiveSniffedCascadeId: (cid) => {
      if (cid) activeSniffedCascadeId = cid;
    },
    dispose() {
      lastAppliedCwByCascade.clear();
      capturedLsClient = null;
      activeSniffedCascadeId = '';
    },
  };
}

module.exports = {
  MAX_CASCADE_MAP_ENTRIES,
  cleanupLegacyObjectPrototypeCwGetters,
  registerCustomCwForStyles,
  createReactFiberDriver,
};
