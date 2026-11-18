'use strict';

/**
 * Desktop Electron / React Fiber / Redux / Lexical Engine Adapter.
 *
 * Isolates all workbench React context traversal, Redux `modelSelection` state synchronization,
 * poisoned `trajectorySync` sanitization, and Lexical editor `/compact` command dispatch
 * away from Remote Control RPC & binary wire concerns.
 */

const { PRESET_CONTEXT_WINDOWS } = require('./context-window-policy');

const MAX_CASCADE_MAP_ENTRIES = 200;

const COMPACT_ARGS =
  '현재 상황을 유지하고 이어서 작업할 수 있게 내부 컨텍스트(<CONTEXT_SUMMARY>)로만 요약해. 사용자의 요청 원문과 목표, 확정된 결정과 그 이유, 수정한 파일 경로와 핵심 변경, 실행한 검증과 결과(실패 메시지 포함), 진행 중인 작업과 남은 할 일, 사용자가 준 제약과 피드백은 빠짐없이 남기고, 끝난 탐색 과정과 긴 도구 출력은 결론만 남겨. 단, 채팅창 응답으로는 요약 내용을 다시 출력하거나 반복하지 말고 "컨텍스트 압축 완료." 한 줄만 출력하고 즉시 턴을 종료해.';

function setBoundedMapRecord(win, propName, key, val) {
  if (!win || !key) return;
  if (!win[propName] || typeof win[propName] !== 'object') {
    win[propName] = {};
  }
  const mapObj = win[propName];
  if (Object.prototype.hasOwnProperty.call(mapObj, key)) {
    delete mapObj[key];
  }
  mapObj[key] = val;
  const keys = Object.keys(mapObj);
  if (keys.length > MAX_CASCADE_MAP_ENTRIES) {
    for (let i = 0; i < keys.length - MAX_CASCADE_MAP_ENTRIES; i++) {
      delete mapObj[keys[i]];
    }
  }
}

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

function registerCustomCwInPrototype(cw, underDefaultCwSet, onStyleUpdate, extraWin) {
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

function setTriggerCwAttribute(triggerEl, cwStr) {
  if (!triggerEl || typeof triggerEl.setAttribute !== 'function') return;
  const str = String(cwStr);
  if (triggerEl.getAttribute('data-context-window') !== str) {
    triggerEl.__agyInternalDomCw = str;
    triggerEl.setAttribute('data-context-window', str);
  }
}

function createDesktopReactBridge({
  window,
  document,
  localStorage,
  cwStore,
  ensureFetchHook,
  getAccessibleRemoteIframeWin,
  getAccessibleRemoteIframeDoc,
  getRemoteRpcServiceForElement,
  cleanupCallbacks,
}) {
  cleanupLegacyObjectPrototypeCwGetters();

  try {
    const raw = localStorage?.getItem('jetski.developer.customFlagOverrides');
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
      localStorage?.setItem('jetski.developer.customFlagOverrides', JSON.stringify(flags));
    }
  } catch {}

  try {
    if (window && !window.__agyLsClientDecoratorHooked) {
      window.__agyLsClientDecoratorHooked = true;
      const hadOwnDec = Object.prototype.hasOwnProperty.call(window, '__JETSKI_LS_CLIENT_DECORATOR__');
      const prevDec = window.__JETSKI_LS_CLIENT_DECORATOR__;
      const wrappedDec = function (client) {
        const decorated = typeof prevDec === 'function' ? (prevDec(client) || client) : client;
        if (decorated && typeof decorated === 'object') {
          window.__agyCapturedLsClient = decorated;
          if (
            typeof decorated.subscribeToPlugins === 'function' &&
            typeof decorated.getAllPlugins === 'function' &&
            !decorated.__agyPluginsStreamPatched
          ) {
            decorated.__agyPluginsStreamPatched = true;
            const origSubRaw = decorated.subscribeToPlugins;
            const origSub = origSubRaw.bind(decorated);
            decorated.subscribeToPlugins = function (req, opts) {
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
                        const raceRes = await Promise.race([
                          firstPromise.then((r) => ({ from: 'stream', r })),
                          new Promise((resolve) => {
                            timer = setTimeout(() => resolve({ from: 'timeout' }), 600);
                          }),
                        ]);
                        clearTimeout(timer);
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
            cleanupCallbacks.push(() => {
              try {
                decorated.subscribeToPlugins = origSubRaw;
                delete decorated.__agyPluginsStreamPatched;
              } catch {}
            });
          }
        }
        return decorated;
      };
      window.__JETSKI_LS_CLIENT_DECORATOR__ = wrappedDec;
      cleanupCallbacks.push(() => {
        try {
          if (window.__JETSKI_LS_CLIENT_DECORATOR__ === wrappedDec) {
            if (hadOwnDec) window.__JETSKI_LS_CLIENT_DECORATOR__ = prevDec;
            else delete window.__JETSKI_LS_CLIENT_DECORATOR__;
          }
          delete window.__agyLsClientDecoratorHooked;
        } catch {}
      });
    }
  } catch {}

  function resolveEffectiveView(view) {
    if (view && view.classList?.contains?.('agy-rc-host-view')) {
      const cdoc = getAccessibleRemoteIframeDoc();
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
      const cdoc = getAccessibleRemoteIframeDoc();
      if (cdoc) {
        const innerBox = cdoc.querySelector('[data-testid="agent-input-box"]');
        if (innerBox) return innerBox;
      }
    }
    return inputBox;
  }

  const frozenModelCloneCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  const patchedStoreConfigsCache = typeof WeakMap === 'function' ? new WeakMap() : null;

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
        toAdd.push({
          name: cw,
          description: hint,
          expensive: limit > 256000,
        });
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
      if (byKey && byKey.has(wantedKey)) {
        return byKey.get(wantedKey);
      }
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
    const cwin = getAccessibleRemoteIframeWin();
    if (cwin) ensureFetchHook(cwin);
    if (!document) return;
    const now = Date.now();
    const effectiveExtraKey =
      extraCw && !PRESET_CONTEXT_WINDOWS.includes(extraCw) ? String(extraCw) : '__presets__';
    const docs = [document, getAccessibleRemoteIframeDoc()].filter(Boolean);
    for (const d of docs) {
      const views = d.querySelectorAll('[data-testid="conversation-view"]');
      for (const view of views) {
        const cacheKey = effectiveExtraKey;
        const currentCid = view.getAttribute?.('data-cascade-id') || '';
        if (
          view.__agyCwsPatchTs &&
          now - view.__agyCwsPatchTs < 3000 &&
          view.__agyCwsPatchExtraCw === cacheKey &&
          view.__agyCwsPatchCid === currentCid
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
                if (!val.__cwsPatched) {
                  try {
                    const origGet = val.get;
                    val.get = function (name) {
                      if (name === 'contextWindowSelector') {
                        return { enabled: true, feature: { enabled: true } };
                      }
                      return origGet.apply(this, arguments);
                    };
                    val.__cwsPatched = true;
                    cleanupCallbacks.push(() => {
                      try {
                        val.get = origGet;
                        delete val.__cwsPatched;
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
                    storeRec.extraCwKeys.has(cacheKey);
                  if (!alreadyHandledRef) {
                    let needsReduxUpdate = false;
                    const updatedConfigs = [];
                    for (const cfg of clientConfigs) {
                      const nextCfg = ensureModelContextWindowOptions(cfg, extraCw, true);
                      updatedConfigs.push(nextCfg);
                      if (nextCfg !== cfg) {
                        needsReduxUpdate = true;
                      }
                    }
                    if (!storeRec && patchedStoreConfigsCache) {
                      storeRec = {
                        configsRefs: new WeakSet(),
                        extraCwKeys: new Set(),
                      };
                      patchedStoreConfigsCache.set(val.store, storeRec);
                    }
                    if (storeRec) {
                      storeRec.configsRefs.add(clientConfigs);
                      storeRec.configsRefs.add(updatedConfigs);
                      storeRec.extraCwKeys.add(cacheKey);
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
        if (patchedAny) {
          view.__agyCwsPatchTs = now;
          view.__agyCwsPatchExtraCw = cacheKey;
          view.__agyCwsPatchCid = currentCid;
        }
      }
    }
  }

  function ensureCustomizationsStoreLoaded() {
    if (!document) return;
    const now = Date.now();
    const docs = [document, getAccessibleRemoteIframeDoc()].filter(Boolean);
    for (const d of docs) {
      const cachedStore = d.__agyCachedCustomizationsStore;
      if (cachedStore && cachedStore.hasReceivedStreamSnapshot && cachedStore.streamingDisabled) {
        continue;
      }
      const views = d.querySelectorAll?.('[data-testid="conversation-view"]') || [];
      const rootEl = d.querySelector?.('#root, #app') || d.body?.firstElementChild;
      const startNodes = [...views, rootEl].filter(Boolean);
      for (const node of startNodes) {
        const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
        const startFiber = fk ? node[fk] : null;
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
        if (!foundStore && node === rootEl) {
          if (d.__agyLastCustomizationsDfsTs && now - d.__agyLastCustomizationsDfsTs < 10000) {
            continue;
          }
          d.__agyLastCustomizationsDfsTs = now;
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
          d.__agyCachedCustomizationsStore = foundStore;
          try {
            if (typeof foundStore.disableStreaming === 'function' && !foundStore.streamingDisabled) {
              foundStore.disableStreaming();
            }
            const st = typeof foundStore.state?.getState === 'function' ? foundStore.state.getState() : null;
            if ((!foundStore.hasReceivedStreamSnapshot || st?.isLoadingPlugins) && !foundStore.__agyInitialRefreshTriggered) {
              foundStore.__agyInitialRefreshTriggered = true;
              Promise.resolve(foundStore.refresh()).catch(() => {
                foundStore.__agyInitialRefreshTriggered = false;
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
    const cachedCtx = effView.__agyMsCtxCache;
    if (
      cachedCtx &&
      effView.__agyMsCtxCacheCid === currentCid &&
      now - (effView.__agyMsCtxCacheTs || 0) < 400 &&
      (!cachedCtx.triggerEl || cachedCtx.triggerEl.isConnected !== false) &&
      (cachedCtx.msCtx || cachedCtx.reduxStore || cachedCtx.legacyCtx)
    ) {
      if (cachedCtx.msCtx?.selectedModel) {
        ensureModelContextWindowOptions(cachedCtx.msCtx.selectedModel, extraCw);
      }
      return cachedCtx;
    }
    const triggerEl = effView.querySelector('[data-testid="model-selector-trigger"]');
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
    if (msCtx || reduxStore || legacyCtx) {
      effView.__agyMsCtxCache = res;
      effView.__agyMsCtxCacheTs = now;
      effView.__agyMsCtxCacheCid = currentCid;
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

  function getSelectedModelKey(view, cascadeId, infoOpt) {
    const info = infoOpt || getModelSelectorContextForView(view);
    const state = info?.reduxStore ? info.reduxStore.getState() : null;
    const byConvo = state?.modelSelection?.byConversation?.[cascadeId];
    const sm = info?.msCtx?.selectedModel;
    const raw =
      byConvo?.model ??
      (sm && typeof sm === 'object' ? (sm.value ?? sm.label) : sm) ??
      state?.modelSelection?.default?.model ??
      info?.legacyCtx?.getModelConfigForConversation?.(cascadeId)?.value ??
      '';
    return `${cascadeId || ''}:${String(raw ?? '')}`;
  }

  function sanitizePoisonedModelSelection(reduxStore) {
    if (!reduxStore || typeof reduxStore.getState !== 'function' || typeof reduxStore.dispatch !== 'function') {
      return;
    }
    try {
      if (reduxStore.__agyPoisonSanitizedV25) return;
      const st = reduxStore.getState();
      const ms = st?.modelSelection;
      if (!ms || typeof ms !== 'object') return;
      const syncMap = ms.trajectorySync;
      const byConvoMap = ms.byConversation;
      if (!syncMap || typeof syncMap !== 'object') return;

      const overrideDefaultModel = extractModelValFromModelOrAlias(
        st?.userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias
      );
      let cleanConvoModel = undefined;
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
      let recoveredTargetModel = undefined;

      for (const cid of Object.keys(syncMap)) {
        const entry = syncMap[cid];
        const step = entry?.pick?.atStep;
        const hasSyncedKey = typeof entry?.syncedKey === 'string' && entry.syncedKey.length > 0;
        const syncedLabel = extractLabelFromSyncedKey(entry?.syncedKey);
        const isV24Relocked =
          hasSyncedKey &&
          (step === 0 || (typeof step === 'number' && step > 0 && entry?.pick?.checkedTurnKey !== undefined));
        const isPoisoned = step === 999999 || isV24Relocked;
        if (isPoisoned) {
          poisonedCids.push(cid);
          const syncedModelVal = resolveModelValueFromLabel(st, syncedLabel);
          if (syncedModelVal !== undefined && recoveredTargetModel === undefined) {
            recoveredTargetModel = syncedModelVal;
          }
        }
      }

      if (poisonedCids.length === 0 && ms.default?.model === preferredModel) {
        reduxStore.__agyPoisonSanitizedV25 = true;
        return;
      }
      reduxStore.__agyPoisonSanitizedV25 = true;

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

  function applyContextWindowToEngine(view, cascadeId, rawTargetCw, force = false) {
    const targetCw = cwStore.normalize(rawTargetCw);
    if (!view || !cascadeId || !targetCw) return false;
    const info = getModelSelectorContextForView(view, targetCw);
    if (!info) return false;

    const { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl } = info;
    if (reduxStore) {
      sanitizePoisonedModelSelection(reduxStore);
    }
    if (triggerEl) {
      const warnAttr = cwStore.getLimit(targetCw) > 256000 ? '1' : '0';
      if (triggerEl.getAttribute('data-agy-cw-warn') !== warnAttr) {
        triggerEl.setAttribute('data-agy-cw-warn', warnAttr);
      }
    }
    const currentInDom = triggerEl ? cwStore.normalize(triggerEl.getAttribute('data-context-window')) : null;
    const selectedModel = getSelectedModelKey(view, cascadeId, info);
    const applyKey = (selectedModel || '') + ':' + String(targetCw);
    window.__agyLastAppliedContextWindowByCascade = window.__agyLastAppliedContextWindowByCascade || {};
    const lastAppliedForCascade = window.__agyLastAppliedContextWindowByCascade[cascadeId];
    const initialState = reduxStore ? reduxStore.getState() : null;
    const initialByConvo = initialState?.modelSelection?.byConversation?.[cascadeId];
    const defaultReduxCw = cwStore.normalize(initialState?.modelSelection?.default?.contextWindow) || '256K';
    const effectiveInitialReduxCw = cwStore.normalize(initialByConvo?.contextWindow) || defaultReduxCw;
    const reduxAlreadyMatches = !reduxStore || effectiveInitialReduxCw === targetCw;

    if ((currentInDom === targetCw || lastAppliedForCascade === applyKey || window.__agyLastAppliedContextWindow === applyKey) && reduxAlreadyMatches && !force) {
      window.__agyLastAppliedContextWindow = applyKey;
      setBoundedMapRecord(window, '__agyLastAppliedContextWindowByCascade', cascadeId, applyKey);
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
      if (selectedModelObj) {
        ensureModelContextWindowOptions(selectedModelObj, targetCw);
      }
      let dispatched = false;

      if (currentInRedux !== targetCw || force) {
        const prevDefault = state?.modelSelection?.default;
        const prevDefaultModel = prevDefault?.model;
        const prevDefaultCustomLabel = prevDefault?.customLabel;
        const prevDefaultCw = prevDefault?.contextWindow;
        if (reduxStore) {
          const syncEntry = state?.modelSelection?.trajectorySync?.[cascadeId];
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
                conversationId: cascadeId,
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
        window.__agyLastAppliedContextWindow = applyKey;
        setBoundedMapRecord(window, '__agyLastAppliedContextWindowByCascade', cascadeId, applyKey);
        setTriggerCwAttribute(triggerEl, targetCw);
        return true;
      }
      return false;
    }

    if (legacyCtx) {
      const modelCfg = legacyCtx.getModelConfigForConversation(cascadeId);
      if (!modelCfg || modelCfg.value === undefined) return false;
      const currentInEngine = legacyCtx.getContextWindowForConversation(cascadeId) || '256K';
      if (currentInEngine !== targetCw || force) {
        if (currentInEngine === targetCw && currentInDom !== targetCw) {
          const tempCw = targetCw === '256K' ? '512K' : '256K';
          legacyCtx.setModelForConversation(cascadeId, modelCfg.value, true, modelCfg.label, tempCw);
        }
        legacyCtx.setModelForConversation(cascadeId, modelCfg.value, true, modelCfg.label, targetCw);
      }
      window.__agyLastAppliedContextWindow = applyKey;
      setBoundedMapRecord(window, '__agyLastAppliedContextWindowByCascade', cascadeId, applyKey);
      setTriggerCwAttribute(triggerEl, targetCw);
      return true;
    }
    return false;
  }

  async function runCompactForInputBox(inputBox) {
    const effBox = resolveEffectiveInputBox(inputBox);
    if (!effBox) return;
    const editable = effBox.querySelector('[contenteditable="true"]');
    if (!editable || !editable.__lexicalEditor) {
      const svc = getRemoteRpcServiceForElement(effBox);
      const cid =
        window?.__agySniffedCascadeId ||
        document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id') ||
        effBox.closest?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id');
      if (svc && typeof svc.sendUserCascadeMessage === 'function' && cid && cid !== 'remote-session') {
        try {
          await svc.sendUserCascadeMessage({
            cascadeId: cid,
            items: [
              {
                item: {
                  slashCommand: {
                    info: { name: 'compact', type: 'SLASH_COMMAND_TYPE_SYSTEM', icon: 'collapse_all' },
                  },
                },
              },
              {
                text: ' ' + COMPACT_ARGS,
              },
            ],
          });
        } catch {}
      }
      return;
    }
    const ed = editable.__lexicalEditor;
    const PClass = ed._nodes.get('paragraph')?.klass;
    const MClass = ed._nodes.get('contextScopeItemMention')?.klass;
    const TClass = ed._nodes.get('text')?.klass;
    if (!PClass || !MClass || !TClass) return;

    ed.update(() => {
      const root = ed.getEditorState()._nodeMap.get('root').getWritable();
      root.clear();
      const p = PClass.importJSON({
        direction: null, format: '', indent: 0, type: 'paragraph', version: 1, textFormat: 0, textStyle: '',
      });
      const mention = MClass.importJSON({
        trigger: '@',
        value: 'contextScopeItemMention',
        data: {
          mentionText: 'compact',
          data: JSON.stringify({
            slashCommand: {
              info: { name: 'compact', type: 'SLASH_COMMAND_TYPE_SYSTEM', icon: 'collapse_all' },
            },
          }),
        },
        type: 'contextScopeItemMention',
        version: 1,
      });
      const text = TClass.importJSON({
        detail: 0, format: 0, mode: 'normal', style: '', text: ' ' + COMPACT_ARGS, type: 'text', version: 1,
      });
      p.append(mention, text);
      root.append(p);
    });

    await new Promise((r) => setTimeout(r, 60));

    const fiberKey = Object.keys(editable).find((k) => k.startsWith('__reactFiber$'));
    let curr = fiberKey ? editable[fiberKey] : null;
    while (curr && (!curr.memoizedProps || typeof curr.memoizedProps.handleEnter !== 'function')) {
      curr = curr.return;
    }
    if (curr && curr.memoizedProps && typeof curr.memoizedProps.handleEnter === 'function') {
      const Evt = typeof KeyboardEvent === 'function' ? KeyboardEvent : function (t, o) { Object.assign(this, o, { type: t }); };
      await curr.memoizedProps.handleEnter(new Evt('keydown', { key: 'Enter' }), ed);
    } else {
      const sendBtn = effBox.querySelector('[data-testid="send-button"]');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }
  }

  return {
    resolveEffectiveView,
    resolveEffectiveInputBox,
    ensureContextWindowSelectorFlag,
    ensureCustomizationsStoreLoaded,
    getModelSelectorContextForView,
    getCascadeContextForElement,
    getSelectedModelKey,
    applyContextWindowToEngine,
    runCompactForInputBox,
  };
}

module.exports = {
  MAX_CASCADE_MAP_ENTRIES,
  COMPACT_ARGS,
  setBoundedMapRecord,
  cleanupLegacyObjectPrototypeCwGetters,
  registerCustomCwInPrototype,
  createDesktopReactBridge,
};
