'use strict';

/**
 * Antigravity Lexical Editor `/compact` Dispatch Driver.
 */

const { DEFAULT_COMPACT_PROMPT } = require('../../domain/i18n');

function createCompactDriver({ window, document, getRemoteRpcServiceForElement, getActiveCascadeId, resolveEffectiveInputBox, compactPrompt }) {
  const effPrompt = typeof compactPrompt === 'string' && compactPrompt.trim() ? compactPrompt.trim() : DEFAULT_COMPACT_PROMPT;
  const bindTimer = (name, fallback) =>
    window && typeof window[name] === 'function' ? window[name].bind(window) : fallback;

  async function runCompactForInputBox(inputBox, promptOverride) {
    const promptText =
      typeof promptOverride === 'string' && promptOverride.trim() ? promptOverride.trim() : effPrompt;
    const effBox = typeof resolveEffectiveInputBox === 'function' ? resolveEffectiveInputBox(inputBox) : inputBox;
    if (!effBox) return false;

    const editable = effBox.querySelector ? effBox.querySelector('[contenteditable="true"]') : null;
    if (!editable || !editable.__lexicalEditor) {
      const svc = typeof getRemoteRpcServiceForElement === 'function' ? getRemoteRpcServiceForElement(effBox) : null;
      const cid =
        (typeof getActiveCascadeId === 'function' ? getActiveCascadeId(effBox) : null) ||
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
                text: ' ' + promptText,
              },
            ],
          });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    const ed = editable.__lexicalEditor;
    const PClass = ed._nodes?.get?.('paragraph')?.klass;
    const MClass = ed._nodes?.get?.('contextScopeItemMention')?.klass;
    const TClass = ed._nodes?.get?.('text')?.klass;
    if (!PClass || !MClass || !TClass) return false;

    ed.update(() => {
      const root = ed.getEditorState()._nodeMap.get('root').getWritable();
      root.clear();
      const p = PClass.importJSON({
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
        textFormat: 0,
        textStyle: '',
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
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        text: ' ' + promptText,
        type: 'text',
        version: 1,
      });
      p.append(mention, text);
      root.append(p);
    });

    const setT = bindTimer('setTimeout', typeof setTimeout === 'function' ? setTimeout : null);
    if (setT) {
      await new Promise((r) => setT(r, 60));
    }

    const fiberKey = Object.keys(editable).find((k) => k.startsWith('__reactFiber$'));
    let curr = fiberKey ? editable[fiberKey] : null;
    while (curr && (!curr.memoizedProps || typeof curr.memoizedProps.handleEnter !== 'function')) {
      curr = curr.return;
    }
    if (curr && curr.memoizedProps && typeof curr.memoizedProps.handleEnter === 'function') {
      const Evt =
        window?.KeyboardEvent ||
        (typeof KeyboardEvent === 'function' ? KeyboardEvent : function (t, o) { Object.assign(this, o, { type: t }); });
      await curr.memoizedProps.handleEnter(new Evt('keydown', { key: 'Enter' }), ed);
      return true;
    }
    const sendBtn = effBox.querySelector ? effBox.querySelector('[data-testid="send-button"]') : null;
    if (sendBtn && !sendBtn.disabled && typeof sendBtn.click === 'function') {
      sendBtn.click();
      return true;
    }
    return false;
  }

  return {
    compactPrompt: effPrompt,
    runCompactForInputBox,
  };
}

module.exports = {
  createCompactDriver,
};
