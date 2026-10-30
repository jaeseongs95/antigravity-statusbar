'use strict';

const COMPACT_ARGS = '현재 상황을 유지하고 이어서 작업할 수 있게 내부 컨텍스트(<CONTEXT_SUMMARY>)로만 요약해. 사용자의 요청 원문과 목표, 확정된 결정과 그 이유, 수정한 파일 경로와 핵심 변경, 실행한 검증과 결과(실패 메시지 포함), 진행 중인 작업과 남은 할 일, 사용자가 준 제약과 피드백은 빠짐없이 남기고, 끝난 탐색 과정과 긴 도구 출력은 결론만 남겨. 단, 채팅창 응답으로는 요약 내용을 다시 출력하거나 반복하지 말고 "컨텍스트 압축 완료." 한 줄만 출력하고 즉시 턴을 종료해.';

function registerCustomCwInPrototype(cw, underDefaultCwSet, onStyleUpdate) {
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
  if (Object.prototype.hasOwnProperty.call(Object.prototype, cw)) return;
  try {
    Object.defineProperty(Object.prototype, cw, {
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

function createHostBridge({ window, document, localStorage, cwStore }) {
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

  function ensureContextWindowSelectorFlag() {
    if (!document) return;
    const views = document.querySelectorAll('[data-testid="conversation-view"]');
    for (const view of views) {
      const fk = Object.keys(view).find((k) => k.startsWith('__reactFiber$'));
      let fiber = fk ? view[fk] : null;
      while (fiber) {
        const val = fiber.memoizedProps?.value;
        if (val && typeof val === 'object' && typeof val.get === 'function') {
          if (!val.__cwsPatched) {
            const origGet = val.get;
            val.get = function (name) {
              if (name === 'contextWindowSelector') {
                return { enabled: true, feature: { enabled: true } };
              }
              return origGet.apply(this, arguments);
            };
            val.__cwsPatched = true;
          }
        }
        fiber = fiber.return;
      }
    }
  }

  function getModelSelectorContextForView(view) {
    ensureContextWindowSelectorFlag();
    if (!view) return null;
    const triggerEl = view.querySelector('[data-testid="model-selector-trigger"]');
    const startEl = triggerEl || view;
    const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? startEl[fk] : null;
    let msCtx = null;
    let reduxStore = null;
    let legacyCtx = null;
    while (fiber) {
      const val = fiber.memoizedProps?.value;
      if (val && typeof val === 'object') {
        if (!msCtx && typeof val.setSelectedModel === 'function' && ('selectedModel' in val)) {
          msCtx = val;
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
    return { msCtx, reduxStore, legacyCtx, triggerEl };
  }

  function getCascadeContextForElement(el) {
    if (!el) return null;
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let curr = fk ? el[fk] : null;
    while (curr) {
      const val = curr.memoizedProps?.value;
      if (val?.cascadeContext?.state?.agentStateProvider) {
        return val.cascadeContext;
      }
      if (val?.state?.agentStateProvider && val?.debug) {
        return val;
      }
      curr = curr.return;
    }
    return null;
  }

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const PROTO_UUID_RE = /\x0a\x24([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const CONVO_RPC_RE = /\/(StreamAgentStateUpdates|RequestAgentStatePageUpdate|StreamCascadeReactiveUpdates|GetCascadeTrajectory|GetCascadeTrajectorySteps|GetCascadeTrajectoryGeneratorMetadata|GetCascadeModelConfigData|SendUserCascadeMessage|UpdateConversationAnnotations|StartCascade)$/i;
  let lastRcTrajectoryPollTs = 0;
  let rcTrajectoryPollInFlight = false;

  function decodeBytesToText(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    try {
      const TD = window?.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
      if (TD) {
        const u8 = body instanceof Uint8Array ? body : (body.buffer ? new Uint8Array(body.buffer) : new Uint8Array(body));
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

  function extractCascadeIdFromBody(body, ignoreUuid) {
    const text = decodeBytesToText(body);
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
      if (/\/(SendUserCascadeMessage|StartCascade)$/i.test(path)) {
        window.__agyRcStepCountByCascade = window.__agyRcStepCountByCascade || {};
        window.__agyRcStepCountByCascade[cid] = (window.__agyRcStepCountByCascade[cid] || 0) + 1;
        setTimeout(() => {
          if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(cid);
        }, 1500);
      }
      if (changed && typeof window.__agyOnCascadeSniffed === 'function') {
        window.__agyOnCascadeSniffed(cid);
      }
    }
  }

  function hookRemoteControlPrototype(proto) {
    if (!proto || proto.__agyHooked) return;
    proto.__agyHooked = true;

    if (typeof proto.handleIframeMessage === 'function') {
      const origMsg = proto.handleIframeMessage;
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
        const origFn = proto[mName];
        proto[mName] = function (path, body) {
          window.__agyRemoteControlInstance = this;
          sniffCascadeIdFromRpc(path, body, this);
          return origFn.apply(this, arguments);
        };
      }
    }

    if (typeof proto.handlePortRequest === 'function') {
      const origPort = proto.handlePortRequest;
      proto.handlePortRequest = function (msg) {
        window.__agyRemoteControlInstance = this;
        if (msg && typeof msg.path === 'string') {
          sniffCascadeIdFromRpc(msg.path, msg.body, this);
        }
        return origPort.apply(this, arguments);
      };
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

    const nsRoot = window?.default_GoogleAntigravity;
    if (nsRoot && typeof nsRoot === 'object') {
      for (const k of Object.keys(nsRoot)) {
        const mod = nsRoot[k];
        if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
        const RC = mod.RemoteControlComponent || (typeof mod.prototype?.proxyCommand === 'function' ? mod : null);
        if (RC && RC.prototype && typeof RC.prototype.proxyCommand === 'function') {
          hookRemoteControlPrototype(RC.prototype);
          break;
        }
      }
    }

    const rcEl = document?.querySelector?.('ga-remote-control');
    if (rcEl) {
      const ctx = rcEl.__ngContext__;
      if (ctx && typeof ctx === 'object') {
        const list = Array.isArray(ctx) ? ctx : (Array.isArray(ctx.lView) ? ctx.lView : [ctx.component, ctx]);
        for (const item of list) {
          if (item && typeof item === 'object' && typeof item.proxyCommand === 'function') {
            window.__agyRemoteControlInstance = item;
            hookRemoteControlPrototype(Object.getPrototypeOf(item));
            break;
          }
        }
      }
    }

    if (!window?.__agyRemoteControlInstance && typeof window?.dispatchEvent === 'function') {
      try {
        const Evt = window.MessageEvent || (typeof MessageEvent !== 'undefined' ? MessageEvent : null);
        if (Evt) {
          window.dispatchEvent(new Evt('message', { data: '__agy_probe__' }));
        }
      } catch {}
    }

    return (window?.__agyRemoteControlInstance && !window.__agyRemoteControlInstance.destroyed)
      ? window.__agyRemoteControlInstance
      : null;
  }

  function createRcServiceAdapter(rcInst) {
    async function callJson(rpcPath, reqObj) {
      if (!rcInst || typeof rcInst.proxyCommand !== 'function') return null;
      const bytes = encodeTextToBytes(JSON.stringify(reqObj || {}));
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
      async sendUserCascadeMessage(req) {
        return await callJson('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', req || {});
      },
    };
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
    let activeCid = window.__agySniffedCascadeId || '';
    if (!activeCid) {
      const childPath = rcInst?.lastSyncedChildPath || window?.location?.search || '';
      const m = String(childPath).match(UUID_RE);
      if (m && m[0] && m[0] !== ignoreUuid) activeCid = m[0];
    }

    const currentAttr = hostView.getAttribute('data-cascade-id');
    const nextAttr = activeCid || currentAttr || 'remote-session';
    if (currentAttr !== nextAttr) {
      hostView.setAttribute('data-cascade-id', nextAttr);
    }

    const now = Date.now();
    const recentlySniffed = window.__agySniffedCascadeTs && (now - window.__agySniffedCascadeTs < 15000);
    if (rcInst && !rcTrajectoryPollInFlight && (now - lastRcTrajectoryPollTs >= 4000 || nextAttr === 'remote-session')) {
      lastRcTrajectoryPollTs = now;
      rcTrajectoryPollInFlight = true;
      createRcServiceAdapter(rcInst).getAllCascadeTrajectories().then((all) => {
        const summaries = all?.trajectorySummaries || {};
        const entries = Object.entries(summaries);
        if (!entries.length) return;
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
          if (!recentlySniffed || !window.__agySniffedCascadeId) {
            window.__agySniffedCascadeId = latestId;
          }
          const resolvedId = window.__agySniffedCascadeId || latestId;
          const nextSteps = window.__agyRcStepCountByCascade[resolvedId] ?? -1;
          const prevObservedSteps = hostView.__agyObservedStepCount;
          hostView.__agyObservedStepCount = nextSteps;
          if (prevId !== resolvedId || prevObservedSteps !== nextSteps) {
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
            totalGeneratorMetadataLength: typeof knownGenLen === 'number' ? knownGenLen : -1,
            totalStepsLength: typeof steps === 'number' ? steps : -1,
          },
        }),
      };
    }
    return null;
  }

  function getRemoteRpcServiceForElement(el) {
    const candidates = [el, document?.querySelector?.('[data-testid="conversation-view"]')].filter(Boolean);
    for (const startEl of candidates) {
      const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
      let curr = fk ? startEl[fk] : null;
      while (curr) {
        const val = curr.memoizedProps?.value;
        if (val && typeof val === 'object' && (typeof val.retrieveUserQuotaSummary === 'function' || typeof val.getCascadeTrajectory === 'function')) {
          return val;
        }
        curr = curr.return;
      }
    }
    const rcInst = getRemoteControlInstance();
    if (rcInst && typeof rcInst.proxyCommand === 'function') {
      return createRcServiceAdapter(rcInst);
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

  function applyContextWindowToEngine(view, cascadeId, rawTargetCw, force = false) {
    const targetCw = cwStore.normalize(rawTargetCw);
    if (!view || !cascadeId || !targetCw) return false;
    const info = getModelSelectorContextForView(view);
    if (!info) return false;

    const { msCtx, reduxStore, legacyCtx, triggerEl } = info;
    if (triggerEl) {
      const warnAttr = cwStore.getLimit(targetCw) > 256000 ? '1' : '0';
      if (triggerEl.getAttribute('data-agy-cw-warn') !== warnAttr) {
        triggerEl.setAttribute('data-agy-cw-warn', warnAttr);
      }
    }
    const currentInDom = triggerEl ? cwStore.normalize(triggerEl.getAttribute('data-context-window')) : null;
    const selectedModel = getSelectedModelKey(view, cascadeId, info);
    const applyKey = (selectedModel || '') + ':' + String(targetCw);
    if ((currentInDom === targetCw || window.__agyLastAppliedContextWindow === applyKey) && !force) return true;

    if (msCtx || reduxStore) {
      const state = reduxStore ? reduxStore.getState() : null;
      const byConvo = state?.modelSelection?.byConversation?.[cascadeId];
      const currentInRedux = byConvo?.contextWindow || msCtx?.contextWindow?.selected || currentInDom || '256K';
      const selectedModelObj = msCtx?.selectedModel;
      let dispatched = false;

      if (currentInRedux !== targetCw || force) {
        const prevDefaultCw = state?.modelSelection?.default?.contextWindow;
        if (msCtx?.contextWindow && typeof msCtx.contextWindow.select === 'function' && selectedModelObj) {
          msCtx.contextWindow.select(selectedModelObj, targetCw);
          dispatched = true;
        } else if (typeof msCtx?.setSelectedModel === 'function' && selectedModelObj) {
          msCtx.setSelectedModel(selectedModelObj, targetCw);
          dispatched = true;
        } else if (reduxStore) {
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
      if (triggerEl && triggerEl.getAttribute('data-context-window') !== String(targetCw)) {
        triggerEl.setAttribute('data-context-window', String(targetCw));
      }
      return true;
    }
    return false;
  }

  async function runCompactForInputBox(inputBox) {
    if (!inputBox) return;
    const editable = inputBox.querySelector('[contenteditable="true"]');
    if (!editable || !editable.__lexicalEditor) {
      const rcInst = getRemoteControlInstance();
      const cid = window?.__agySniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id');
      if (rcInst && cid && cid !== 'remote-session') {
        try {
          await createRcServiceAdapter(rcInst).sendUserCascadeMessage({
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
      const sendBtn = inputBox.querySelector('[data-testid="send-button"]');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }
  }

  return {
    ensureContextWindowSelectorFlag,
    ensureRemoteHostView,
    getRemoteControlInstance,
    getModelSelectorContextForView,
    getCascadeContextForElement,
    getAgentStateProviderForInputBox,
    getRemoteRpcServiceForElement,
    getSelectedModelKey,
    applyContextWindowToEngine,
    runCompactForInputBox,
  };
}

module.exports = {
  COMPACT_ARGS,
  registerCustomCwInPrototype,
  createHostBridge,
};
