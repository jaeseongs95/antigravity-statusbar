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

  function getAgentStateProviderForInputBox(inputBox) {
    const cc = getCascadeContextForElement(inputBox);
    return cc?.state?.agentStateProvider || null;
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
    if (!editable || !editable.__lexicalEditor) return;
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
    getModelSelectorContextForView,
    getCascadeContextForElement,
    getAgentStateProviderForInputBox,
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
