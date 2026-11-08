'use strict';

const { PRESET_CONTEXT_WINDOWS } = require('./context-window-policy');

const COMPACT_ARGS = '현재 상황을 유지하고 이어서 작업할 수 있게 내부 컨텍스트(<CONTEXT_SUMMARY>)로만 요약해. 사용자의 요청 원문과 목표, 확정된 결정과 그 이유, 수정한 파일 경로와 핵심 변경, 실행한 검증과 결과(실패 메시지 포함), 진행 중인 작업과 남은 할 일, 사용자가 준 제약과 피드백은 빠짐없이 남기고, 끝난 탐색 과정과 긴 도구 출력은 결론만 남겨. 단, 채팅창 응답으로는 요약 내용을 다시 출력하거나 반복하지 말고 "컨텍스트 압축 완료." 한 줄만 출력하고 즉시 턴을 종료해.';

function registerCustomCwInPrototype(cw, underDefaultCwSet, onStyleUpdate, extraWin) {
  if (!cw) return;
  const kNum = parseInt(cw, 10);
  if (!isNaN(kNum) && kNum > 0 && kNum <= 256 && underDefaultCwSet && !underDefaultCwSet.has(cw)) {
    underDefaultCwSet.add(cw);
    if (typeof onStyleUpdate === 'function') {
      try { onStyleUpdate(); } catch {}
    }
  }
  if (cw === '256K' || cw === '512K' || cw === '900K') return;
  if (isNaN(kNum) || kNum <= 0) return;
  const tokens = kNum * 1000;
  const protos = [Object.prototype];
  try {
    if (extraWin?.Object?.prototype && extraWin.Object.prototype !== Object.prototype) {
      protos.push(extraWin.Object.prototype);
    }
  } catch {}
  for (const proto of protos) {
    if (Object.prototype.hasOwnProperty.call(proto, cw)) continue;
    try {
      Object.defineProperty(proto, cw, {
        configurable: true,
        enumerable: false,
        get() {
          if (this && this['512K'] === 512000 && this['900K'] === 900000) {
            return tokens;
          }
          if (this && typeof this['512K'] === 'string' && this['512K'].indexOf('512K') !== -1) {
            return `${cw} custom context limit (${tokens.toLocaleString('en-US')} tokens)`;
          }
          return undefined;
        },
      });
    } catch {}
  }
}

function createHostBridge({ window, document, localStorage, fetchFn, cwStore }) {
  // Ensure context-window-selector flag is enabled in customFlagOverrides
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
      const prevDec = window.__JETSKI_LS_CLIENT_DECORATOR__;
      window.__JETSKI_LS_CLIENT_DECORATOR__ = function (client) {
        const decorated = typeof prevDec === 'function' ? (prevDec(client) || client) : client;
        if (decorated && typeof decorated === 'object') {
          window.__agyCapturedLsClient = decorated;
          if (typeof decorated.subscribeToPlugins === 'function' && typeof decorated.getAllPlugins === 'function' && !decorated.__agyPluginsStreamPatched) {
            decorated.__agyPluginsStreamPatched = true;
            const origSub = decorated.subscribeToPlugins.bind(decorated);
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
          }
        }
        return decorated;
      };
    }
  } catch {}

  function getAccessibleRemoteIframeWin() {
    try {
      const iframe = document?.querySelector?.('ga-remote-control iframe');
      if (!iframe || iframe.__agyCrossOriginInaccessible) return null;
      const cwin = iframe.contentWindow;
      if (!cwin) return null;
      // Probe cross-origin restriction once; if accessible, clear any stale flag
      void cwin.document;
      return cwin;
    } catch {
      try {
        const iframe = document?.querySelector?.('ga-remote-control iframe');
        if (iframe) iframe.__agyCrossOriginInaccessible = true;
      } catch {}
      return null;
    }
  }

  function getAccessibleRemoteIframeDoc() {
    try {
      const iframe = document?.querySelector?.('ga-remote-control iframe');
      if (!iframe || iframe.__agyCrossOriginInaccessible) return null;
      const cdoc = iframe.contentDocument || iframe.contentWindow?.document;
      return cdoc || null;
    } catch {
      try {
        const iframe = document?.querySelector?.('ga-remote-control iframe');
        if (iframe) iframe.__agyCrossOriginInaccessible = true;
      } catch {}
      return null;
    }
  }

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

  function ensureModelContextWindowOptions(modelObj, extraCw) {
    if (!modelObj || typeof modelObj !== 'object') return modelObj;
    const curArr = Array.isArray(modelObj.contextWindowOptions) ? modelObj.contextWindowOptions : [];
    const existingNames = new Set(
      curArr.map((o) => o && o.name).filter(Boolean)
    );
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
    try {
      if (Array.isArray(modelObj.contextWindowOptions) && Object.isExtensible(modelObj.contextWindowOptions)) {
        modelObj.contextWindowOptions.push(...toAdd);
      } else {
        modelObj.contextWindowOptions = nextArr;
      }
    } catch {}
    try {
      const proto = Object.getPrototypeOf(modelObj);
      if (proto && proto !== Object.prototype) {
        const clone = Object.assign(Object.create(proto), modelObj, { contextWindowOptions: nextArr });
        return clone;
      }
      return { ...modelObj, contextWindowOptions: nextArr };
    } catch {
      return modelObj;
    }
  }

  function ensureContextWindowSelectorFlag(extraCw) {
    ensureFetchHook(window);
    const cwin = getAccessibleRemoteIframeWin();
    if (cwin) ensureFetchHook(cwin);
    if (!document) return;
    const docs = [document, getAccessibleRemoteIframeDoc()].filter(Boolean);
    for (const d of docs) {
      const views = d.querySelectorAll('[data-testid="conversation-view"]');
      for (const view of views) {
        const triggerEl = view.querySelector?.('[data-testid="model-selector-trigger"]');
        const startNodes = [triggerEl, view].filter(Boolean);
        for (const node of startNodes) {
          const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
          let fiber = fk ? node[fk] : null;
          while (fiber) {
            const val = fiber.memoizedProps?.value;
            if (val && typeof val === 'object') {
              if (typeof val.get === 'function' && !val.__cwsPatched) {
                try {
                  const origGet = val.get;
                  val.get = function (name) {
                    if (name === 'contextWindowSelector') {
                      return { enabled: true, feature: { enabled: true } };
                    }
                    return origGet.apply(this, arguments);
                  };
                  val.__cwsPatched = true;
                } catch {}
              }
              if ('corpHost' in val && 'cider' in val && 'contextWindow' in val && val.contextWindow === undefined) {
                try { val.contextWindow = {}; } catch {}
              }
              if (val.selectedModel && typeof val.selectedModel === 'object') {
                const nextSm = ensureModelContextWindowOptions(val.selectedModel, extraCw);
                if (nextSm !== val.selectedModel) {
                  try { val.selectedModel = nextSm; } catch {}
                }
              }
              if (Array.isArray(val.modelOptions)) {
                if (Object.isExtensible(val.modelOptions)) {
                  for (let i = 0; i < val.modelOptions.length; i++) {
                    const nextOpt = ensureModelContextWindowOptions(val.modelOptions[i], extraCw);
                    if (nextOpt !== val.modelOptions[i]) {
                      try { val.modelOptions[i] = nextOpt; } catch {}
                    }
                  }
                } else {
                  try {
                    val.modelOptions = val.modelOptions.map((opt) => ensureModelContextWindowOptions(opt, extraCw));
                  } catch {}
                }
              }
              if (val.store && typeof val.store.getState === 'function') {
                const st = val.store.getState();
                const clientConfigs = st?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
                if (Array.isArray(clientConfigs)) {
                  let needsReduxUpdate = false;
                  const updatedConfigs = [];
                  for (const cfg of clientConfigs) {
                    const nextCfg = ensureModelContextWindowOptions(cfg, extraCw);
                    updatedConfigs.push(nextCfg);
                    if (nextCfg !== cfg) {
                      needsReduxUpdate = true;
                    }
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
                    } catch {}
                  }
                }
              }
            }
            fiber = fiber.return;
          }
        }
      }
    }
  }

  function ensureCustomizationsStoreLoaded() {
    if (!document) return;
    const docs = [document, getAccessibleRemoteIframeDoc()].filter(Boolean);
    for (const d of docs) {
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
    return { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl };
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

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const PROTO_UUID_RE = /\x0a\x24([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const CONVO_RPC_RE = /\/(StreamAgentStateUpdates|RequestAgentStatePageUpdate|StreamCascadeReactiveUpdates|GetCascadeTrajectory|GetCascadeTrajectorySteps|GetCascadeTrajectoryGeneratorMetadata|GetCascadeModelConfigData|SendUserCascadeMessage|UpdateConversationAnnotations|StartCascade)$/i;
  let lastRcTrajectoryPollTs = 0;
  let rcTrajectoryPollInFlight = false;

  function toUint8Slice(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength ?? body.buffer.byteLength);
    }
    if (body.buffer instanceof ArrayBuffer) {
      return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength ?? body.buffer.byteLength);
    }
    return null;
  }

  function decodeBytesToText(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    try {
      const TD = window?.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
      if (TD) {
        const u8 = toUint8Slice(body) || new Uint8Array(body);
        return new TD('utf-8').decode(u8);
      }
    } catch {}
    return '';
  }

  function encodeTextToBytes(str) {
    const TE = window?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
    if (TE) return new TE().encode(str);
    return Uint8Array.from(String(str).split('').map((c) => c.charCodeAt(0) & 0xff));
  }

  function decodeBase64ToUtf8(b64) {
    if (!b64 || typeof b64 !== 'string') return '';
    try {
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        return Buffer.from(b64, 'base64').toString('utf8');
      }
      const atobFn = window?.atob || (typeof atob === 'function' ? atob : null);
      if (atobFn) {
        const bin = atobFn(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
        return decodeBytesToText(bytes);
      }
    } catch {}
    return '';
  }

  function encodeVarint(val) {
    const out = [];
    let v = Math.max(0, Math.floor(Number(val) || 0)) >>> 0;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v & 0x7f);
    return out;
  }

  function buildSendMessageCheckpointSuffix(maxTokenLimit, contextWindow) {
    // CheckpointConfig: field 5 (max_token_limit, uint32 varint) -> wire tag 0x28
    const cpBytes = [0x28, ...encodeVarint(maxTokenLimit)];
    if (contextWindow && typeof contextWindow === 'string') {
      // CheckpointConfig: field 36 (context_window, string) -> wire tag (36 << 3) | 2 = 0x122 -> varint [0xa2, 0x02]
      const cwBytes = Array.from(encodeTextToBytes(contextWindow));
      cpBytes.push(0xa2, 0x02, ...encodeVarint(cwBytes.length), ...cwBytes);
    }
    // CascadeConfig: field 2 (checkpoint_config, bytes) -> wire tag 0x12
    const ccBytes = [0x12, ...encodeVarint(cpBytes.length), ...cpBytes];
    // SendUserCascadeMessageRequest: field 5 (cascade_config, bytes) -> wire tag 0x2a
    return new Uint8Array([0x2a, ...encodeVarint(ccBytes.length), ...ccBytes]);
  }

  function resolveEffectiveCascadeId(body, rcInst) {
    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const fromBody = extractCascadeIdFromBody(body, ignoreUuid);
    if (fromBody) return fromBody;
    if (window?.__agySniffedCascadeId && window.__agySniffedCascadeId !== 'remote-session') {
      return window.__agySniffedCascadeId;
    }
    const activeView = document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
    const domCid = activeView?.getAttribute?.('data-cascade-id');
    if (domCid && domCid !== 'remote-session') return domCid;
    return null;
  }

  function findFirstNonWsByte(u8) {
    if (!u8 || u8.length === 0) return -1;
    let i = 0;
    // Skip UTF-8 BOM (EF BB BF) if present
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
      i = 3;
    }
    while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x09 || u8[i] === 0x0a || u8[i] === 0x0d)) {
      i++;
    }
    return i < u8.length ? u8[i] : -1;
  }

  function endsWithByteSequence(u8, seq) {
    if (!u8 || !seq || u8.length < seq.length) return false;
    const offset = u8.length - seq.length;
    for (let i = 0; i < seq.length; i++) {
      if (u8[offset + i] !== seq[i]) return false;
    }
    return true;
  }

  function buildConnectFramedBytes(flagByte, payloadBytes) {
    const len = payloadBytes.length;
    const framed = new Uint8Array(5 + len);
    framed[0] = flagByte & 0xff;
    framed[1] = (len >>> 24) & 0xff;
    framed[2] = (len >>> 16) & 0xff;
    framed[3] = (len >>> 8) & 0xff;
    framed[4] = len & 0xff;
    framed.set(payloadBytes, 5);
    return framed;
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

      const applyCheckpointToJsonObj = (j) => {
        if (!j || typeof j !== 'object') return j;
        j.cascadeConfig = j.cascadeConfig || {};
        j.cascadeConfig.checkpointConfig = {
          ...(j.cascadeConfig.checkpointConfig || {}),
          contextWindow: cw,
          maxTokenLimit: limit,
        };
        return j;
      };

      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (trimmed.startsWith('{')) {
          const j = applyCheckpointToJsonObj(JSON.parse(trimmed));
          return JSON.stringify(j);
        }
        return body;
      }

      const u8 = toUint8Slice(body);
      if (!u8) {
        if (typeof body === 'object') {
          const cloned = typeof body.clone === 'function'
            ? body.clone()
            : Object.assign(Object.create(Object.getPrototypeOf(body)), body);
          const prevCc = body.cascadeConfig;
          const nextCc = prevCc && typeof prevCc === 'object'
            ? (typeof prevCc.clone === 'function' ? prevCc.clone() : Object.assign(Object.create(Object.getPrototypeOf(prevCc)), prevCc))
            : {};
          const prevCp = prevCc?.checkpointConfig;
          const nextCp = prevCp && typeof prevCp === 'object'
            ? (typeof prevCp.clone === 'function' ? prevCp.clone() : Object.assign(Object.create(Object.getPrototypeOf(prevCp)), prevCp))
            : {};
          nextCp.contextWindow = cw;
          nextCp.maxTokenLimit = limit;
          nextCc.checkpointConfig = nextCp;
          cloned.cascadeConfig = nextCc;
          return cloned;
        }
        return body;
      }
      if (u8.length === 0) return body;

      // 1. Unframed UTF-8 JSON bytes (`{...}`)
      if (findFirstNonWsByte(u8) === 0x7b) {
        const text = decodeBytesToText(u8);
        const j = applyCheckpointToJsonObj(JSON.parse(text));
        return encodeTextToBytes(JSON.stringify(j));
      }

      const suffix = buildSendMessageCheckpointSuffix(limit, cw);

      // Strip any previously injected trailing 0x2a cascade_config suffix (`[0x2a, ccLen, 0x12, cpLen, 0x28, ...]`)
      const stripTrailingCheckpointSuffix = (bytes) => {
        if (!bytes || bytes.length < 7) return bytes;
        for (let pos = Math.max(0, bytes.length - 32); pos <= bytes.length - 7; pos++) {
          if (bytes[pos] === 0x2a && bytes[pos + 2] === 0x12 && bytes[pos + 4] === 0x28) {
            const ccLen = bytes[pos + 1];
            const cpLen = bytes[pos + 3];
            if (pos + 2 + ccLen === bytes.length && ccLen === cpLen + 2) {
              return bytes.subarray(0, pos);
            }
          }
        }
        return bytes;
      };

      // 2. Connect-RPC / gRPC-Web 5-byte framed envelope (`[flags(1B), length(4B), payload]`)
      // In Protobuf wire format, field number 0 (`(u8[0] >>> 3) === 0`, i.e., `u8[0] < 8`) is never a valid unframed message start!
      // Also flag bit 0x80 (e.g. `0x80` trailer frame) or any frame matching `frameLen === u8.length - 5` is a Connect/gRPC-Web frame.
      const frameLen = u8.length >= 5
        ? (((u8[1] << 24) >>> 0) + (u8[2] << 16) + (u8[3] << 8) + u8[4])
        : -1;
      const isConnectFrame = u8.length >= 5 && (u8[0] < 8 || (u8[0] & 0x80) !== 0 || frameLen === u8.length - 5);
      if (isConnectFrame) {
        if (frameLen !== u8.length - 5 || u8[0] !== 0) {
          // Compressed, trailer, end-stream (`u8[0] > 0`), or incomplete/multi-frame Connect envelope: never append raw bytes
          return body;
        }
        const payload = u8.subarray(5);
        if (findFirstNonWsByte(payload) === 0x7b) {
          // Connect-Framed JSON (`0x00` + 4B len + `{"cascadeId":...}`)!
          // Parse JSON, inject checkpointConfig, re-encode JSON, and update 5-byte frame header length!
          const text = decodeBytesToText(payload);
          const j = applyCheckpointToJsonObj(JSON.parse(text));
          const newPayload = encodeTextToBytes(JSON.stringify(j));
          return buildConnectFramedBytes(0, newPayload);
        }
        if (endsWithByteSequence(payload, suffix)) {
          return body;
        }
        const cleanPayload = stripTrailingCheckpointSuffix(payload);
        const newPayload = new Uint8Array(cleanPayload.length + suffix.length);
        newPayload.set(cleanPayload, 0);
        newPayload.set(suffix, cleanPayload.length);
        return buildConnectFramedBytes(0, newPayload);
      }

      // 3. Unframed Protobuf binary (idempotent guard against double injection or limit change)
      if (endsWithByteSequence(u8, suffix)) {
        return body;
      }
      const cleanU8 = stripTrailingCheckpointSuffix(u8);
      const merged = new Uint8Array(cleanU8.length + suffix.length);
      merged.set(cleanU8, 0);
      merged.set(suffix, cleanU8.length);
      return merged;
    } catch {
      return body;
    }
  }

  window.__agyInjectCheckpointLimit = injectCheckpointLimitIntoSendRequest;
  window.__agySniffCascadeFromRpc = sniffCascadeIdFromRpc;

  function ensureFetchHook(targetWin) {
    try {
      const w = targetWin || window;
      if (!w || typeof w.fetch !== 'function') return;
      w.__agyInjectCheckpointLimit = injectCheckpointLimitIntoSendRequest;
      w.__agySniffCascadeFromRpc = sniffCascadeIdFromRpc;
      if (w.fetch.__agyCwHookV2) return;
      const prevFetch = w.__agyOrigFetch || w.fetch;
      const isLegacyV1Hook = Boolean(prevFetch.__agyCwHooked && !prevFetch.__agyCwHookV2);
      if (!isLegacyV1Hook && !w.__agyOrigFetch) {
        w.__agyOrigFetch = prevFetch;
      }
      const wrappedFetch = function (input, init) {
        let nextInput = input;
        let nextInit = init;
        try {
          const url = typeof input === 'string'
            ? input
            : (input && typeof input.url === 'string'
              ? input.url
              : (input && typeof input.href === 'string' ? input.href : ''));
          const sniffFn = w.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
          const injectFn = w.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
          if (url && CONVO_RPC_RE.test(url)) {
            if (nextInit && nextInit.body) {
              sniffFn(url, nextInit.body, null);
              if (/\/SendUserCascadeMessage$/i.test(url)) {
                nextInit = { ...nextInit, body: injectFn(url, nextInit.body, null) };
                // If wrapping over a legacy v1.3.8 hook in an un-reloaded window, pass a URL object
                // so v1.3.8's `typeof input === 'string' || typeof input.url === 'string'` check is bypassed!
                if (isLegacyV1Hook && typeof URL === 'function') {
                  try {
                    nextInput = new URL(url, w.location?.href || 'http://127.0.0.1');
                  } catch {}
                }
              }
            } else if (input && typeof input === 'object' && typeof input.arrayBuffer === 'function' && typeof input.clone === 'function' && /\/SendUserCascadeMessage$/i.test(url)) {
              return input.clone().arrayBuffer().then((ab) => {
                const rawBytes = new Uint8Array(ab);
                sniffFn(url, rawBytes, null);
                const injectedBody = injectFn(url, rawBytes, null);
                const ReqCtor = w.Request || (typeof Request === 'function' ? Request : null);
                if (ReqCtor) {
                  return prevFetch.call(this, new ReqCtor(input, { body: injectedBody }), nextInit);
                }
                return prevFetch.call(this, nextInput, { ...(nextInit || {}), body: injectedBody });
              }).catch(() => prevFetch.call(this, nextInput, nextInit));
            }
          }
        } catch {}
        return prevFetch.call(this, nextInput, nextInit);
      };
      wrappedFetch.__agyCwHooked = true;
      wrappedFetch.__agyCwHookV2 = true;
      w.fetch = wrappedFetch;
    } catch {}
  }

  function hookLsClient(lsClient) {
    if (!lsClient || typeof lsClient !== 'object') return lsClient;
    if (lsClient.__agyCwHookV2) return lsClient;
    try {
      lsClient.__agyCwHooked = true;
      lsClient.__agyCwHookV2 = true;
      if (typeof lsClient.sendUserCascadeMessage === 'function') {
        const origSend = lsClient.__agyOrigSendUserCascadeMessage || lsClient.sendUserCascadeMessage;
        lsClient.__agyOrigSendUserCascadeMessage = origSend;
        lsClient.sendUserCascadeMessage = function (req, ...rest) {
          const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
          const nextReq = injectFn(
            '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
            req,
            null
          );
          return origSend.call(this, nextReq, ...rest);
        };
      }
    } catch {}
    return lsClient;
  }

  function extractCascadeIdFromBody(body, ignoreUuid) {
    const u8 = toUint8Slice(body);
    if (!u8 && body && typeof body === 'object') {
      const cid = body.cascadeId || body.conversationId;
      if (typeof cid === 'string' && UUID_RE.test(cid) && cid !== ignoreUuid) return cid;
    }
    let targetBody = u8 || body;
    if (u8 && u8.length >= 5 && u8[0] === 0) {
      const frameLen = ((u8[1] << 24) >>> 0) + (u8[2] << 16) + (u8[3] << 8) + u8[4];
      if (frameLen === u8.length - 5) {
        targetBody = u8.subarray(5);
      }
    }
    const text = decodeBytesToText(targetBody);
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed);
        const cid = j.cascadeId || j.conversationId;
        if (typeof cid === 'string' && UUID_RE.test(cid) && cid !== ignoreUuid) return cid;
      } catch {}
    }
    const pm = text.match(PROTO_UUID_RE);
    if (pm && pm[1] && pm[1] !== ignoreUuid) return pm[1];
    const um = text.match(UUID_RE);
    if (um && um[0] && um[0] !== ignoreUuid) return um[0];
    return null;
  }

  function sniffCascadeIdFromRpc(path, body, rcInst) {
    if (typeof path !== 'string' || !CONVO_RPC_RE.test(path)) return;
    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const cid = extractCascadeIdFromBody(body, ignoreUuid);
    if (cid) {
      const changed = window.__agySniffedCascadeId !== cid;
      window.__agySniffedCascadeId = cid;
      window.__agySniffedCascadeTs = Date.now();
      if (/\/(SendUserCascadeMessage|StartCascade|StreamCascadeReactiveUpdates|StreamAgentStateUpdates)$/i.test(path)) {
        lastRcTrajectoryPollTs = 0;
        if (/\/(SendUserCascadeMessage|StartCascade)$/i.test(path)) {
          window.__agyRcStepCountByCascade = window.__agyRcStepCountByCascade || {};
          window.__agyRcStepCountByCascade[cid] = (window.__agyRcStepCountByCascade[cid] || 0) + 1;
        }
        setTimeout(() => {
          lastRcTrajectoryPollTs = 0;
          if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(cid);
        }, 1200);
      }
      if (changed && typeof window.__agyOnCascadeSniffed === 'function') {
        window.__agyOnCascadeSniffed(cid);
      }
    }
  }

  function hookRemoteControlPrototype(proto) {
    if (!proto || proto.__agyHookV2) return;
    proto.__agyHooked = true;
    proto.__agyHookV2 = true;

    if (typeof proto.handleIframeMessage === 'function') {
      const origMsg = proto.__agyOrigHandleIframeMessage || proto.handleIframeMessage;
      proto.__agyOrigHandleIframeMessage = origMsg;
      proto.handleIframeMessage = function (ev) {
        window.__agyRemoteControlInstance = this;
        if (ev && ev.data === '__agy_probe__') return;
        if (ev && ev.data && typeof ev.data.path === 'string') {
          const ignoreUuid = typeof this.selectedInstanceUuid === 'function' ? this.selectedInstanceUuid() : '';
          const m = ev.data.path.match(UUID_RE);
          if (m && m[0] && m[0] !== ignoreUuid && window.__agySniffedCascadeId !== m[0]) {
            window.__agySniffedCascadeId = m[0];
            window.__agySniffedCascadeTs = Date.now();
            if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(m[0]);
          }
        }
        return origMsg.apply(this, arguments);
      };
    }

    for (const mName of ['proxyCommand', 'streamProxyCommand']) {
      if (typeof proto[mName] === 'function') {
        const origKey = `__agyOrig_${mName}`;
        const origFn = proto[origKey] || proto[mName];
        proto[origKey] = origFn;
        proto[mName] = function (path, body, ...rest) {
          window.__agyRemoteControlInstance = this;
          const sniffFn = window?.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
          const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
          sniffFn(path, body, this);
          const nextBody = injectFn(path, body, this);
          return origFn.call(this, path, nextBody, ...rest);
        };
      }
    }

    if (typeof proto.handlePortRequest === 'function') {
      const origPort = proto.__agyOrigHandlePortRequest || proto.handlePortRequest;
      proto.__agyOrigHandlePortRequest = origPort;
      proto.handlePortRequest = function (msg) {
        window.__agyRemoteControlInstance = this;
        if (msg && typeof msg.path === 'string') {
          const sniffFn = window?.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
          const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
          sniffFn(msg.path, msg.body, this);
          if (/\/SendUserCascadeMessage$/i.test(msg.path) && msg.body) {
            msg = { ...msg, body: injectFn(msg.path, msg.body, this) };
          }
        }
        return origPort.call(this, msg);
      };
    }
    for (const mName of [
      'managePolling',
      'shouldPoll',
      'loadInstances',
      'isDisconnected',
      'onIframeLoad',
      'onWindowOnline',
      'onWindowOffline',
      'isOffline',
      'isDirectIngressMode',
      'isTabHidden',
      'getSelectedInstance',
      'instanceInfos',
      'remoteConversationsInfos',
    ]) {
      if (typeof proto[mName] === 'function') {
        const origKey = `__agyOrig_${mName}`;
        const origFn = proto[origKey] || proto[mName];
        proto[origKey] = origFn;
        proto[mName] = function () {
          if (this && !this.destroyed) {
            window.__agyRemoteControlInstance = this;
          }
          return origFn.apply(this, arguments);
        };
      }
    }
  }

  function getRemoteControlInstance(onCascadeChange) {
    if (typeof onCascadeChange === 'function') {
      window.__agyOnCascadeSniffed = onCascadeChange;
    }
    if (window?.__agyRemoteControlInstance && !window.__agyRemoteControlInstance.destroyed) {
      hookRemoteControlPrototype(Object.getPrototypeOf(window.__agyRemoteControlInstance));
      return window.__agyRemoteControlInstance;
    }

    const isRcInstance = (obj) =>
      Boolean(
        obj &&
          typeof obj === 'object' &&
          !obj.destroyed &&
          (typeof obj.proxyCommand === 'function' ||
            typeof obj.onIframeLoad === 'function' ||
            typeof obj.handleIframeMessage === 'function')
      );

    const extractFromLContext = (lCtx) => {
      if (!lCtx || typeof lCtx !== 'object') return null;
      if (isRcInstance(lCtx)) return lCtx;
      if (isRcInstance(lCtx.component)) return lCtx.component;
      const lView = lCtx.lView;
      if (Array.isArray(lView)) {
        try {
          const tView = lView[1];
          const nodeIndex = typeof lCtx.nodeIndex === 'number' ? lCtx.nodeIndex : -1;
          const tNode = nodeIndex >= 0 && Array.isArray(tView?.data) ? tView.data[nodeIndex] : null;
          if (
            tNode &&
            typeof tNode.directiveStart === 'number' &&
            typeof tNode.componentOffset === 'number' &&
            tNode.componentOffset > -1
          ) {
            const comp = lView[tNode.directiveStart + tNode.componentOffset];
            if (isRcInstance(comp)) return comp;
          }
        } catch {}
        for (let i = 0; i < Math.min(lView.length, 300); i++) {
          if (isRcInstance(lView[i])) return lView[i];
        }
      }
      return null;
    };

    const searchNgContext = (ctx) => {
      if (!ctx || typeof ctx !== 'object') return null;
      const direct = extractFromLContext(ctx);
      if (direct) return direct;
      const visited = new Set();
      const queue = [ctx];
      let steps = 0;
      while (queue.length > 0 && steps < 400) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
        visited.add(cur);
        steps++;
        const extracted = extractFromLContext(cur);
        if (extracted) return extracted;
        if (Array.isArray(cur)) {
          const scanLen = Math.min(cur.length, 300);
          for (let i = 0; i < scanLen; i++) {
            if (isRcInstance(cur[i])) return cur[i];
          }
          for (let i = 0; i < scanLen; i++) {
            const item = cur[i];
            if (item && typeof item === 'object' && (Array.isArray(item) || isRcInstance(item.component))) {
              queue.push(item);
            }
          }
        } else {
          for (const k of ['component', 'lView', 'data', 'context', '_lView']) {
            if (cur[k] && typeof cur[k] === 'object') queue.push(cur[k]);
          }
        }
      }
      return null;
    };

    const rcEl = document?.querySelector?.('ga-remote-control') || null;
    const gaRootEl = document?.querySelector?.('ga-root') || null;

    if (rcEl) {
      const ngFn = window?.ng && typeof window.ng.getComponent === 'function' ? window.ng.getComponent : null;
      if (ngFn) {
        try {
          const comp = ngFn(rcEl);
          if (isRcInstance(comp)) {
            window.__agyRemoteControlInstance = comp;
            hookRemoteControlPrototype(Object.getPrototypeOf(comp));
            return comp;
          }
        } catch {}
      }
      const ctxKey = Object.keys(rcEl).find((k) => k.startsWith('__ngContext'));
      const found = searchNgContext(rcEl.__ngContext__ || (ctxKey ? rcEl[ctxKey] : null));
      if (found) {
        window.__agyRemoteControlInstance = found;
        hookRemoteControlPrototype(Object.getPrototypeOf(found));
        return found;
      }
    }

    if (gaRootEl) {
      const rootCtxKey = Object.keys(gaRootEl).find((k) => k.startsWith('__ngContext'));
      const foundFromRoot = searchNgContext(gaRootEl.__ngContext__ || (rootCtxKey ? gaRootEl[rootCtxKey] : null));
      if (foundFromRoot) {
        window.__agyRemoteControlInstance = foundFromRoot;
        hookRemoteControlPrototype(Object.getPrototypeOf(foundFromRoot));
        return foundFromRoot;
      }
    }

    const nsRoot = window?.default_GoogleAntigravity;
    if (nsRoot && typeof nsRoot === 'object') {
      const targetCandidates = [];
      if (rcEl) {
        targetCandidates.push(rcEl);
        if (rcEl.firstElementChild) targetCandidates.push(rcEl.firstElementChild);
        if (typeof rcEl.querySelector === 'function') {
          const innerContainer = rcEl.querySelector('.app-container, .iframe-panel, iframe');
          if (innerContainer && !targetCandidates.includes(innerContainer)) {
            targetCandidates.push(innerContainer);
          }
        }
      }
      if (gaRootEl) {
        targetCandidates.push(gaRootEl);
        if (gaRootEl.firstElementChild) targetCandidates.push(gaRootEl.firstElementChild);
      }

      for (const k of Object.keys(nsRoot)) {
        const mod = nsRoot[k];
        if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
        for (const targetEl of targetCandidates) {
          if (!targetEl) continue;
          try {
            if (typeof mod.getDebugNode === 'function') {
              const dbgNode = mod.getDebugNode(targetEl);
              const dbgComp = dbgNode?.componentInstance || dbgNode?.context;
              if (isRcInstance(dbgComp)) {
                window.__agyRemoteControlInstance = dbgComp;
                hookRemoteControlPrototype(Object.getPrototypeOf(dbgComp));
                return dbgComp;
              }
              const foundFromDbg = searchNgContext(dbgComp || dbgNode);
              if (foundFromDbg) {
                window.__agyRemoteControlInstance = foundFromDbg;
                hookRemoteControlPrototype(Object.getPrototypeOf(foundFromDbg));
                return foundFromDbg;
              }
            }
            if (typeof mod.getComponent === 'function') {
              const comp = mod.getComponent(targetEl);
              if (isRcInstance(comp)) {
                window.__agyRemoteControlInstance = comp;
                hookRemoteControlPrototype(Object.getPrototypeOf(comp));
                return comp;
              }
            }
            const getLCtx = mod['\u0275getLContext'] || mod.getLContext;
            if (typeof getLCtx === 'function') {
              const lCtx = getLCtx(targetEl);
              const foundFromLCtx = extractFromLContext(lCtx) || searchNgContext(lCtx?.lView || lCtx);
              if (foundFromLCtx) {
                window.__agyRemoteControlInstance = foundFromLCtx;
                hookRemoteControlPrototype(Object.getPrototypeOf(foundFromLCtx));
                return foundFromLCtx;
              }
            }
          } catch {}
        }
        const RC = mod.RemoteControlComponent || (typeof mod.prototype?.proxyCommand === 'function' ? mod : null);
        if (RC && RC.prototype && typeof RC.prototype.proxyCommand === 'function') {
          hookRemoteControlPrototype(RC.prototype);
        }
      }
    }

    try {
      if (!window?.__agyRemoteControlInstance && typeof document?.dispatchEvent === 'function') {
        const BaseEvt = window?.Event || (typeof Event !== 'undefined' ? Event : null);
        if (BaseEvt) {
          document.dispatchEvent(new BaseEvt('visibilitychange'));
        }
      }
      if (!window?.__agyRemoteControlInstance && typeof window?.dispatchEvent === 'function') {
        const Evt = window.MessageEvent || (typeof MessageEvent !== 'undefined' ? MessageEvent : null);
        if (Evt) {
          window.dispatchEvent(new Evt('message', { data: '__agy_probe__' }));
        }
      }
    } catch {}

    return (window?.__agyRemoteControlInstance && !window.__agyRemoteControlInstance.destroyed)
      ? window.__agyRemoteControlInstance
      : null;
  }

  function createRcServiceAdapter(rcInst) {
    async function callJson(rpcPath, reqObj) {
      if (!rcInst || typeof rcInst.proxyCommand !== 'function') return null;
      const payloadObj = /\/SendUserCascadeMessage$/i.test(rpcPath)
        ? injectCheckpointLimitIntoSendRequest(rpcPath, reqObj || {}, rcInst)
        : (reqObj || {});
      const bytes = encodeTextToBytes(JSON.stringify(payloadObj));
      const res = await rcInst.proxyCommand(rpcPath, bytes);
      if (!res || !res.payload) return null;
      const text = decodeBytesToText(res.payload);
      return text ? JSON.parse(text) : null;
    }
    return {
      isRemoteControlHost: true,
      rcInst,
      callJson,
      async retrieveUserQuotaSummary(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', req || {});
      },
      async getCascadeTrajectoryGeneratorMetadata(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', req || {});
      },
      async getCascadeTrajectory(req) {
        const metaRes = await callJson('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
          cascadeId: req?.cascadeId,
          generatorMetadataOffset: req?.generatorMetadataOffset || 0,
        });
        if (metaRes && Array.isArray(metaRes.generatorMetadata)) {
          return { trajectory: { generatorMetadata: metaRes.generatorMetadata } };
        }
        return await callJson('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', req || {});
      },
      async getAllCascadeTrajectories() {
        return await callJson('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {});
      },
      async updateConversationAnnotations(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', req || {});
      },
      async sendUserCascadeMessage(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', req || {});
      },
      async getCustomizationStates(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/GetCustomizationStates', req || {});
      },
      async getAllSkills(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/GetAllSkills', req || {});
      },
      async getAllPlugins(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/GetAllPlugins', req || {});
      },
      async readFile(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/ReadFile', req || {});
      },
    };
  }

  function extractAnchoredMarkerBlock(bundleText, beginRe, endRe) {
    if (!bundleText || typeof bundleText !== 'string') return '';
    const bMatch = beginRe.exec(bundleText);
    if (!bMatch) return '';
    const startIdx = bMatch.index;
    const afterStart = bundleText.slice(startIdx);
    const eMatch = endRe.exec(afterStart);
    if (!eMatch) return afterStart;
    return afterStart.slice(0, eMatch.index + eMatch[0].length);
  }

  async function fetchHostInstalledPluginInfo(csrf, viewOrEl) {
    const svc = getRemoteRpcServiceForElement(viewOrEl);
    const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
    const canCallHttp = Boolean(effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function');

    async function callRpc(methodName, rpcPath, reqObj) {
      if (svc && typeof svc[methodName] === 'function') {
        try {
          let arg = reqObj || {};
          if (!svc.isRemoteControlHost) {
            if (methodName === 'getCustomizationStates') arg = [];
            else if (methodName === 'getAllSkills') arg = [];
            else if (methodName === 'readFile' && arg && typeof arg === 'object' && typeof arg.uri === 'string') arg = arg.uri;
          }
          const r = await svc[methodName](arg);
          if (r !== undefined && r !== null) return r;
        } catch {}
      }
      if (svc && typeof svc.callJson === 'function') {
        try {
          const r = await svc.callJson(rpcPath, reqObj || {});
          if (r) return r;
        } catch {}
      }
      if (canCallHttp) {
        try {
          const res = await fetchFn(rpcPath, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': effCsrf },
            body: JSON.stringify(reqObj || {}),
          });
          if (res && res.ok !== false) return await res.json();
        } catch {}
      }
      return null;
    }

    const [statesRes, pluginsRes] = await Promise.all([
      callRpc('getCustomizationStates', '/exa.language_server_pb.LanguageServerService/GetCustomizationStates', {}),
      callRpc('getAllPlugins', '/exa.language_server_pb.LanguageServerService/GetAllPlugins', {}),
    ]);

    const candidatePaths = [];
    const pluginNames = new Set();
    const statesList = Array.isArray(statesRes) ? statesRes : (Array.isArray(statesRes?.states) ? statesRes.states : []);
    for (const s of statesList) {
      const p = s?.path || s?.uri || '';
      if (p) {
        candidatePaths.push(p);
        if (String(p).includes('ko-thought-translator')) pluginNames.add('ko-thought-translator');
        if (String(p).includes('antigravity-mcp-manager')) pluginNames.add('antigravity-mcp-manager');
        if (String(p).includes('antigravity-statusbar')) pluginNames.add('antigravity-statusbar');
      }
    }
    const pluginsList = Array.isArray(pluginsRes) ? pluginsRes : (Array.isArray(pluginsRes?.plugins) ? pluginsRes.plugins : []);
    for (const p of pluginsList) {
      if (p?.name) pluginNames.add(String(p.name));
      if (p?.path) candidatePaths.push(p.path);
    }
    if (!candidatePaths.length) {
      const skillsRes = await callRpc('getAllSkills', '/exa.language_server_pb.LanguageServerService/GetAllSkills', {});
      const skillsList = Array.isArray(skillsRes) ? skillsRes : (Array.isArray(skillsRes?.skills) ? skillsRes.skills : []);
      for (const sk of skillsList) {
        const p = sk?.path || sk?.uri || '';
        if (p) {
          candidatePaths.push(p);
          if (String(p).includes('ko-thought-translator')) pluginNames.add('ko-thought-translator');
        }
      }
    }

    let geminiDir = null;
    for (const rawPath of candidatePaths) {
      let decoded = String(rawPath).trim();
      try {
        decoded = decodeURIComponent(decoded);
      } catch {}
      const isFileUri = /^file:\/\//i.test(decoded);
      let norm = decoded.replace(/^file:\/\//i, '').replace(/\\/g, '/');
      if (isFileUri && /^\/[A-Za-z]:\//.test(norm)) {
        norm = norm.slice(1);
      } else if (isFileUri && !norm.startsWith('/') && !/^[A-Za-z]:\//.test(norm)) {
        norm = '/' + norm;
      }
      const idx = norm.indexOf('/.gemini/');
      if (idx !== -1) {
        geminiDir = norm.slice(0, idx + '/.gemini'.length);
        break;
      }
    }

    let hostBundleText = '';
    let readAttemptedAndFailed = false;
    if (geminiDir) {
      const uriPrefix = geminiDir.startsWith('/') ? 'file://' : 'file:///';
      const uri = `${uriPrefix}${geminiDir}/antigravity/statusbar_autoinject.js`;
      const rf = await callRpc('readFile', '/exa.language_server_pb.LanguageServerService/ReadFile', { uri });
      if (rf instanceof Uint8Array || ArrayBuffer.isView(rf) || rf instanceof ArrayBuffer) {
        hostBundleText = decodeBytesToText(rf);
      } else if (typeof rf === 'string' && rf.length > 0) {
        hostBundleText = rf;
      } else if (rf && (rf.content instanceof Uint8Array || ArrayBuffer.isView(rf.content) || rf.content instanceof ArrayBuffer)) {
        hostBundleText = decodeBytesToText(rf.content);
      } else if (rf && typeof rf.content === 'string' && rf.content.length > 0) {
        hostBundleText = decodeBase64ToUtf8(rf.content);
      }
      if (!hostBundleText) {
        readAttemptedAndFailed = true;
      }
    }

    const mcpBeginStr = ['BEGIN_AGY_MCP', 'MANAGER'].join('_');
    const mcpEndStr = ['END_AGY_MCP', 'MANAGER'].join('_');
    const koBeginStr = ['BEGIN_AGY_KO', 'THOUGHT_LOCALIZER_V2'].join('_');
    const koEndStr = ['END_AGY_KO', 'THOUGHT_LOCALIZER_V2'].join('_');

    const mcpBeginRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${mcpBeginStr}(?:_V1)? ===|\\/\\* === ${mcpBeginStr}(?:_V1)? === \\*\\/)[ \\t]*$`, 'm');
    const mcpEndRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${mcpEndStr}(?:_V1)? ===|\\/\\* === ${mcpEndStr}(?:_V1)? === \\*\\/)[ \\t]*$`, 'm');
    const koBeginRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${koBeginStr} ===|\\/\\* === ${koBeginStr} === \\*\\/)[ \\t]*$`, 'm');
    const koEndRe = new RegExp(`^[ \\t]*(?:\\/\\/ === ${koEndStr} ===|\\/\\* === ${koEndStr} === \\*\\/)[ \\t]*$`, 'm');

    const mcpManagerCode = extractAnchoredMarkerBlock(hostBundleText, mcpBeginRe, mcpEndRe);
    const koTranslatorCode = extractAnchoredMarkerBlock(hostBundleText, koBeginRe, koEndRe);

    const hasMcpMarker = Boolean(mcpManagerCode) || hostBundleText.includes('function mountMcpManager(');
    const hasKoMarker = Boolean(koTranslatorCode) || hostBundleText.includes('__agyKoThoughtCleanup');
    const hasStatusbarMarker = hostBundleText.includes('function mountStatusBar(') || hostBundleText.includes('agy-ctx-statusbar');

    const hasStatusbar = hasStatusbarMarker || pluginNames.has('antigravity-statusbar');
    const hasMcpManager = hasMcpMarker || pluginNames.has('antigravity-mcp-manager');
    const hasKoTranslator = hasKoMarker || pluginNames.has('ko-thought-translator');

    const resolved = Boolean(hostBundleText) || (!readAttemptedAndFailed && pluginNames.size > 0);

    return {
      resolved,
      geminiDir,
      hasStatusbar,
      hasMcpManager,
      hasKoTranslator,
      mcpManagerCode,
      koTranslatorCode,
      hostBundleText,
    };
  }

  let lastDesktopTrajectorySyncTs = 0;
  let desktopTrajectorySyncInFlight = false;

  async function pushSessionCwToServer(cascadeId, csrf, viewOrEl) {
    if (!cwStore || typeof cwStore.encodeRemoteAnnotationProfile !== 'function') return false;
    let targetIds = [];
    if (cascadeId && cascadeId !== 'remote-session') {
      targetIds = [cascadeId];
    } else if (!cascadeId) {
      const activeView = viewOrEl || document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
      const activeCid = activeView?.getAttribute?.('data-cascade-id') || window?.__agySniffedCascadeId;
      if (activeCid && activeCid !== 'remote-session') {
        targetIds = [activeCid];
      }
    }
    if (!targetIds.length) return false;

    for (const cid of targetIds) {
      const profileStr = cwStore.encodeRemoteAnnotationProfile(cid);
      if (!profileStr) continue;
      const reqPayload = {
        cascadeIds: [cid],
        annotations: { activeProfile: profileStr },
        mergeAnnotations: true,
      };
      const svc = getRemoteRpcServiceForElement(viewOrEl);
      if (svc && typeof svc.updateConversationAnnotations === 'function') {
        try {
          await svc.updateConversationAnnotations(reqPayload);
          continue;
        } catch {}
      }
      const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
      if (effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function') {
        try {
          await fetchFn('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': effCsrf },
            body: JSON.stringify(reqPayload),
          });
        } catch {}
      }
    }
    return true;
  }

  function pullAndBackfillTrajectorySummaries(summaries, csrf, viewOrEl, onRemoteUpdated) {
    if (!summaries || typeof summaries !== 'object' || typeof cwStore?.syncFromRemoteAnnotations !== 'function') {
      return false;
    }
    const { changed, unsyncedLocalIds } = cwStore.syncFromRemoteAnnotations(summaries);
    if (Array.isArray(unsyncedLocalIds) && unsyncedLocalIds.length > 0) {
      for (const cid of unsyncedLocalIds) {
        pushSessionCwToServer(cid, csrf, viewOrEl).catch?.(() => {});
      }
    }
    if (changed && typeof onRemoteUpdated === 'function') {
      try { onRemoteUpdated(); } catch {}
    }
    return changed;
  }

  function syncDesktopAnnotations(csrf, viewOrEl, onRemoteUpdated, force = false) {
    const nativeView = document?.querySelector?.('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
    if (!nativeView && document?.querySelector?.('ga-remote-control')) return;
    const now = Date.now();
    if (desktopTrajectorySyncInFlight || (!force && now - lastDesktopTrajectorySyncTs < 4000)) return;
    const svc = getRemoteRpcServiceForElement(viewOrEl);
    const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
    const canCallSvc = svc && typeof svc.getAllCascadeTrajectories === 'function';
    const canCallHttp = effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function';
    if (!canCallSvc && !canCallHttp) return;

    lastDesktopTrajectorySyncTs = now;
    desktopTrajectorySyncInFlight = true;
    const p = canCallSvc
      ? svc.getAllCascadeTrajectories({})
      : fetchFn('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': effCsrf },
          body: '{}',
        }).then((r) => (r && r.ok !== false ? r.json() : null));

    Promise.resolve(p)
      .then((all) => {
        const summaries = all?.trajectorySummaries;
        if (summaries) {
          pullAndBackfillTrajectorySummaries(summaries, effCsrf, viewOrEl, onRemoteUpdated);
        }
      })
      .catch(() => {})
      .finally(() => {
        desktopTrajectorySyncInFlight = false;
      });
  }

  function ensureRemoteHostView(onCascadeChange) {
    if (!document) return null;
    const nativeView = document.querySelector('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
    if (nativeView) return null;
    const rcEl = document.querySelector('ga-remote-control');
    if (!rcEl) return null;

    const rcInst = getRemoteControlInstance(onCascadeChange);
    const appContainer = rcEl.querySelector('.app-container') || rcEl;
    let hostView = appContainer.querySelector('.agy-rc-host-view');
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

    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const cdoc = getAccessibleRemoteIframeDoc();
    const innerView = cdoc?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
    const rawInnerCid = innerView?.getAttribute?.('data-cascade-id');
    const innerCid = (rawInnerCid && UUID_RE.test(rawInnerCid) && rawInnerCid !== ignoreUuid) ? rawInnerCid : '';

    const childPath = rcInst?.lastSyncedChildPath || window?.location?.search || '';
    const pathMatch = String(childPath).match(UUID_RE);
    const pathCid = (pathMatch && pathMatch[0] && pathMatch[0] !== ignoreUuid) ? pathMatch[0] : '';

    let activeCid = '';
    if (innerCid) {
      activeCid = innerCid;
      if (window.__agySniffedCascadeId !== innerCid) {
        window.__agySniffedCascadeId = innerCid;
        window.__agySniffedCascadeTs = Date.now();
      }
    } else if (pathCid && pathCid !== hostView.__agyLastChildPathCid) {
      hostView.__agyLastChildPathCid = pathCid;
      activeCid = pathCid;
      window.__agySniffedCascadeId = pathCid;
      window.__agySniffedCascadeTs = Date.now();
    } else {
      activeCid = window.__agySniffedCascadeId || pathCid || '';
    }

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
      createRcServiceAdapter(rcInst).getAllCascadeTrajectories().then((all) => {
        const summaries = all?.trajectorySummaries || {};
        const entries = Object.entries(summaries);
        if (!entries.length) return;
        const cwChanged = pullAndBackfillTrajectorySummaries(summaries, null, hostView);
        window.__agyRcStepCountByCascade = window.__agyRcStepCountByCascade || {};
        for (const [id, sum] of entries) {
          if (typeof sum?.stepCount === 'number') {
            window.__agyRcStepCountByCascade[id] = sum.stepCount;
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
            window.__agySniffedCascadeId &&
            window.__agySniffedCascadeId !== 'remote-session' &&
            summaries[window.__agySniffedCascadeId]
          );
          if (!hasValidActive && (!prevId || prevId === 'remote-session' || !summaries[prevId])) {
            window.__agySniffedCascadeId = latestId;
          }
          const resolvedId = window.__agySniffedCascadeId || (prevId && prevId !== 'remote-session' ? prevId : latestId);
          if (prevId === 'remote-session' && resolvedId && resolvedId !== 'remote-session') {
            cwStore?.migrateSessionOverride?.('remote-session', resolvedId);
          }
          const nextSteps = window.__agyRcStepCountByCascade[resolvedId] ?? -1;
          const prevObservedSteps = hostView.__agyObservedStepCount;
          hostView.__agyObservedStepCount = nextSteps;
          if (prevId !== resolvedId || prevObservedSteps !== nextSteps || cwChanged) {
            hostView.setAttribute('data-cascade-id', resolvedId);
            if (typeof onCascadeChange === 'function') onCascadeChange(resolvedId);
          }
        }
      }).catch(() => {}).finally(() => {
        rcTrajectoryPollInFlight = false;
      });
    }

    return hostView;
  }

  function getAgentStateProviderForInputBox(inputBox) {
    const cc = getCascadeContextForElement(inputBox);
    if (cc?.state?.agentStateProvider) return cc.state.agentStateProvider;
    const cid = window?.__agySniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id');
    const steps = cid && window?.__agyRcStepCountByCascade ? window.__agyRcStepCountByCascade[cid] : undefined;
    const knownGenLen = cid && window?.__agyRcGenLenByCascade ? window.__agyRcGenLenByCascade[cid] : undefined;
    if ((typeof steps === 'number' && steps >= 0) || (typeof knownGenLen === 'number' && knownGenLen >= 0)) {
      return {
        getState: () => ({
          trajectorySlice: {
            totalGeneratorMetadataLength: -1,
            totalStepsLength: typeof steps === 'number' ? steps : -1,
          },
        }),
      };
    }
    return null;
  }

  function getRemoteRpcServiceForElement(el) {
    if (window?.__agyCapturedLsClient && (typeof window.__agyCapturedLsClient.retrieveUserQuotaSummary === 'function' || typeof window.__agyCapturedLsClient.getCascadeTrajectory === 'function')) {
      return hookLsClient(window.__agyCapturedLsClient);
    }
    const cwin = getAccessibleRemoteIframeWin();
    if (cwin?.__agyCapturedLsClient && (typeof cwin.__agyCapturedLsClient.retrieveUserQuotaSummary === 'function' || typeof cwin.__agyCapturedLsClient.getCascadeTrajectory === 'function')) {
      return hookLsClient(cwin.__agyCapturedLsClient);
    }
    const cdoc = getAccessibleRemoteIframeDoc();
    const candidates = [
      resolveEffectiveInputBox(resolveEffectiveView(el)),
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
          if (typeof val.retrieveUserQuotaSummary === 'function' || typeof val.getCascadeTrajectory === 'function' || typeof val.getAllCascadeTrajectories === 'function' || typeof val.updateConversationAnnotations === 'function' || typeof val.getCustomizationStates === 'function' || typeof val.readFile === 'function') {
            return hookLsClient(val);
          }
          const lsClient = val.core?.projectManagementService?.lsClient || val.projectManagementService?.lsClient || val.lsClient;
          if (lsClient && (typeof lsClient.retrieveUserQuotaSummary === 'function' || typeof lsClient.getCascadeTrajectory === 'function' || typeof lsClient.getAllCascadeTrajectories === 'function' || typeof lsClient.updateConversationAnnotations === 'function' || typeof lsClient.getCustomizationStates === 'function' || typeof lsClient.readFile === 'function')) {
            return hookLsClient(lsClient);
          }
        }
        curr = curr.return;
      }
    }
    const rcInst = getRemoteControlInstance();
    if (rcInst && typeof rcInst.proxyCommand === 'function') {
      return createRcServiceAdapter(rcInst);
    }
    try {
      const parentWin = window?.parent !== window ? window?.parent : null;
      const pRc = parentWin?.__agyRemoteControlInstance;
      if (pRc && !pRc.destroyed && typeof pRc.proxyCommand === 'function') {
        return createRcServiceAdapter(pRc);
      }
    } catch {}
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

  function applyContextWindowToEngine(view, cascadeId, rawTargetCw, force = false) {
    const targetCw = cwStore.normalize(rawTargetCw);
    if (!view || !cascadeId || !targetCw) return false;
    const info = getModelSelectorContextForView(view, targetCw);
    if (!info) return false;

    const { msCtx, setSelectedModelWithCw, reduxStore, legacyCtx, triggerEl } = info;
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
    const initialReduxCw = initialState?.modelSelection?.byConversation?.[cascadeId]?.contextWindow;
    const reduxAlreadyMatches = !reduxStore || initialReduxCw === targetCw;

    if ((currentInDom === targetCw || lastAppliedForCascade === applyKey || window.__agyLastAppliedContextWindow === applyKey) && reduxAlreadyMatches && !force) {
      if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
        triggerEl.setAttribute('data-context-window', String(targetCw));
      }
      return true;
    }

    if (msCtx || reduxStore) {
      const state = initialState;
      const byConvo = state?.modelSelection?.byConversation?.[cascadeId];
      const currentInRedux = byConvo?.contextWindow || msCtx?.contextWindow?.selected || currentInDom || '256K';
      const selectedModelObj = msCtx?.selectedModel;
      if (selectedModelObj) {
        ensureModelContextWindowOptions(selectedModelObj, targetCw);
      }
      let dispatched = false;

      if (currentInRedux !== targetCw || (reduxStore && byConvo?.contextWindow !== targetCw) || force) {
        const prevDefaultCw = state?.modelSelection?.default?.contextWindow;
        if (reduxStore) {
          const modelVal = byConvo?.model ?? selectedModelObj?.value ?? state?.modelSelection?.default?.model;
          const customLabel = byConvo?.customLabel ?? (selectedModelObj?.isCustom ? selectedModelObj?.label : undefined);
          if (modelVal !== undefined) {
            reduxStore.dispatch({
              type: 'modelSelection/modelPicked',
              payload: {
                conversationId: cascadeId,
                model: modelVal,
                customLabel,
                contextWindow: targetCw,
                pick: { atStep: 999999, queuedMessageIds: [] },
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
          const desiredDefaultCw = cwStore.getDefaultCw() || prevDefaultCw || '256K';
          if (defObj && defObj.contextWindow !== desiredDefaultCw) {
            reduxStore.dispatch({
              type: 'modelSelection/modelPicked',
              payload: {
                conversationId: undefined,
                model: defObj.model,
                customLabel: defObj.customLabel,
                contextWindow: desiredDefaultCw,
              },
            });
          }
        }
      }

      if (dispatched || currentInRedux === targetCw) {
        window.__agyLastAppliedContextWindow = applyKey;
        window.__agyLastAppliedContextWindowByCascade[cascadeId] = applyKey;
        if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
          triggerEl.setAttribute('data-context-window', String(targetCw));
        }
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
      window.__agyLastAppliedContextWindowByCascade[cascadeId] = applyKey;
      if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
        triggerEl.setAttribute('data-context-window', String(targetCw));
      }
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
      const cid = window?.__agySniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id') || effBox.closest?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id');
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
    ensureContextWindowSelectorFlag,
    ensureCustomizationsStoreLoaded,
    ensureRemoteHostView,
    getRemoteControlInstance,
    getModelSelectorContextForView,
    getCascadeContextForElement,
    getAgentStateProviderForInputBox,
    getRemoteRpcServiceForElement,
    getSelectedModelKey,
    applyContextWindowToEngine,
    runCompactForInputBox,
    pushSessionCwToServer,
    pullAndBackfillTrajectorySummaries,
    syncDesktopAnnotations,
    fetchHostInstalledPluginInfo,
    injectCheckpointLimitIntoSendRequest,
    buildSendMessageCheckpointSuffix,
  };
}

module.exports = {
  COMPACT_ARGS,
  registerCustomCwInPrototype,
  createHostBridge,
};
