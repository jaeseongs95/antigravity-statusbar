'use strict';

/**
 * Core Metrics & Context Window Selector View (`core-metrics` builtin adapter).
 * Pure DOM node composition via `dom-builder` (zero HTML strings) + `WeakMap` state + `i18n` translator.
 */

const { PRESET_CONTEXT_WINDOWS } = require('../../domain/context-window-policy');
const { fmtK } = require('../../domain/metrics-calculator');
const { DEFAULT_LOCALE, createTranslator } = require('../../domain/i18n');
const { h, setText, clearChildren } = require('../dom-builder');
const { registerNodeCleanup, runNodeCleanup } = require('../adapter-registry');

const containerStateMap = new WeakMap();

function getContainerState(containerEl) {
  let state = containerStateMap.get(containerEl);
  if (!state) {
    state = {
      lastCascadeId: '',
      pendingCrossSessionNoTransition: false,
      lastSignature: '',
      lastQuotaKey: '',
      refs: null,
    };
    containerStateMap.set(containerEl, state);
  }
  return state;
}

function createCoreMetricsAdapter({
  document,
  documentHost,
  cwStore,
  translator,
  getConversationContextWindow,
  setConversationContextWindow,
  cycleConversationContextWindow,
  saveDefaultContextWindow,
  updateAll,
}) {
  const tr = translator || createTranslator(DEFAULT_LOCALE);

  function closeExistingMenu(menu) {
    if (!menu) return;
    runNodeCleanup(menu);
    try {
      menu.remove();
    } catch {}
  }

  function showContextMenu(barEl, view, cascadeId, limitBtn) {
    const existing = barEl.querySelector?.('.agy-ctx-menu');
    if (existing) {
      closeExistingMenu(existing);
      return;
    }

    if (document && typeof document.querySelectorAll === 'function') {
      const openMenus = document.querySelectorAll('.agy-ctx-menu');
      for (const m of openMenus) {
        if (m.parentNode === barEl) continue;
        closeExistingMenu(m);
      }
    }

    const resolveCurrentCascadeId = () => view?.getAttribute?.('data-cascade-id') || cascadeId;
    const currentCw = getConversationContextWindow(view, resolveCurrentCascadeId());
    const currentKNum = parseInt(currentCw, 10) || 512;
    const activeHdrCid = resolveCurrentCascadeId();
    const sessionLabel =
      activeHdrCid && activeHdrCid !== 'remote-session' ? activeHdrCid.slice(0, 8) : tr.t('metrics.currentSession');

    const winObj = document?.defaultView || null;
    const nativeSetTimeout = winObj && typeof winObj.setTimeout === 'function' ? winObj.setTimeout.bind(winObj) : setTimeout;
    const nativeClearTimeout =
      winObj && typeof winObj.clearTimeout === 'function' ? winObj.clearTimeout.bind(winObj) : clearTimeout;

    let iframeDoc = null;
    try {
      iframeDoc = documentHost?.getIframeDocument?.() || null;
    } catch {}

    let attachTimer = null;
    let menu = null;

    const outsideHandler = (e) => {
      if (!menu) return;
      if (!menu.contains || (!menu.contains(e.target) && e.target !== limitBtn)) {
        closeMenu();
      }
    };

    const closeMenu = () => {
      if (attachTimer !== null) {
        nativeClearTimeout(attachTimer);
        attachTimer = null;
      }
      if (menu) {
        menu.remove();
      }
      for (const evt of ['mousedown', 'pointerdown', 'touchstart']) {
        document?.removeEventListener?.(evt, outsideHandler, true);
        try {
          iframeDoc?.removeEventListener?.(evt, outsideHandler, true);
        } catch {}
      }
      try {
        winObj?.removeEventListener?.('blur', closeMenu);
      } catch {}
    };

    const applyCustomInput = () => {
      if (!inputEl) return;
      const norm = cwStore.normalize(inputEl.value);
      if (!norm) {
        if (inputEl.style) inputEl.style.borderColor = '#ec7063';
        return;
      }
      setConversationContextWindow(view, resolveCurrentCascadeId(), norm);
      closeMenu();
      updateAll();
    };

    const inputEl = h(document, 'input', {
      type: 'text',
      inputmode: 'numeric',
      pattern: '[0-9kKmM.]*',
      className: 'agy-ctx-custom-input',
      value: String(currentKNum),
      placeholder: tr.t('menu.customPlaceholder'),
      title: tr.t('menu.customHint'),
      onkeydown(e) {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          applyCustomInput();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
        }
      },
    });

    const applyBtn = h(
      document,
      'button',
      {
        type: 'button',
        className: 'agy-ctx-custom-apply',
        onclick(e) {
          e.preventDefault();
          e.stopPropagation();
          applyCustomInput();
        },
      },
      tr.t('menu.apply')
    );

    const optionsList = [...PRESET_CONTEXT_WINDOWS];
    if (currentCw && !optionsList.includes(currentCw)) {
      optionsList.unshift(currentCw);
    }

    const optionNodes = optionsList.map((cw) =>
      h(
        document,
        'div',
        {
          className: `agy-ctx-menu-item${cw === currentCw ? ' active' : ''}`,
          'data-cw-option': cw,
          onclick(e) {
            e.preventDefault();
            e.stopPropagation();
            setConversationContextWindow(view, resolveCurrentCascadeId(), cw);
            closeMenu();
            updateAll();
          },
        },
        h(document, 'span', null, `${cw === currentCw ? '✓ ' : '  '}${cw}`),
        h(document, 'span', { className: 'agy-ctx-menu-hint' }, cwStore.getQuotaHint(cw))
      )
    );

    const defaultCw = typeof cwStore.getDefaultCw === 'function' ? cwStore.getDefaultCw() : '512K';
    const saveDefaultNode =
      typeof saveDefaultContextWindow === 'function' && currentCw !== defaultCw
        ? h(
            document,
            'div',
            {
              className: 'agy-ctx-menu-item agy-ctx-menu-default',
              'data-cw-save-default': currentCw,
              onclick(e) {
                e.preventDefault();
                e.stopPropagation();
                saveDefaultContextWindow(currentCw);
                closeMenu();
                updateAll();
              },
            },
            h(document, 'span', null, tr.t('menu.saveAsDefault', { cw: currentCw, defCw: defaultCw }))
          )
        : null;

    menu = h(
      document,
      'div',
      {
        className: 'agy-ctx-menu',
        'data-agy-no-translate': 'true',
        translate: 'no',
      },
      h(
        document,
        'div',
        { className: 'agy-ctx-menu-hdr' },
        h(document, 'span', null, tr.t('menu.headerLeft')),
        h(document, 'span', { style: { opacity: '0.75' } }, sessionLabel)
      ),
      h(
        document,
        'div',
        { className: 'agy-ctx-custom-row' },
        inputEl,
        h(document, 'span', { className: 'agy-ctx-custom-unit' }, 'K'),
        applyBtn
      ),
      h(document, 'div', { className: 'agy-ctx-custom-hint' }, tr.t('menu.customHint')),
      ...optionNodes,
      saveDefaultNode
    );

    if (typeof menu.addEventListener === 'function') {
      for (const evtName of [
        'mousedown',
        'mouseup',
        'pointerdown',
        'pointerup',
        'touchstart',
        'touchend',
        'click',
        'dblclick',
        'keydown',
        'keyup',
        'keypress',
        'contextmenu',
      ]) {
        menu.addEventListener(evtName, (ev) => ev.stopPropagation());
      }
    }

    registerNodeCleanup(menu, closeMenu);

    attachTimer = nativeSetTimeout(() => {
      attachTimer = null;
      if (!menu.isConnected && menu.parentNode !== barEl) return;
      for (const evt of ['mousedown', 'pointerdown', 'touchstart']) {
        document?.addEventListener?.(evt, outsideHandler, true);
        try {
          iframeDoc?.addEventListener?.(evt, outsideHandler, true);
        } catch {}
      }
      try {
        winObj?.addEventListener?.('blur', closeMenu);
      } catch {}
      const isCoarseOrNarrow =
        typeof winObj?.matchMedia === 'function' && winObj.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
      if (!isCoarseOrNarrow && inputEl.isConnected && typeof inputEl.focus === 'function') {
        inputEl.focus();
        if (typeof inputEl.select === 'function') inputEl.select();
      }
    }, 10);

    barEl.appendChild(menu);
  }

  function renderQuotaSlot(quotaSlotEl, quota, localeKey) {
    clearChildren(quotaSlotEl);
    if (!quota) return;

    const parts = [];
    if (quota.pct5h !== null && quota.pct5h !== undefined) {
      parts.push(
        h(
          document,
          'span',
          null,
          '5h ',
          h(document, 'strong', { className: 'agy-ctx-quota' }, `${quota.pct5h}%`),
          h(document, 'span', { className: 'agy-ctx-quota-left' }, ` ${tr.t('metrics.leftLabel')}`),
          quota.rst5h ? ` ${quota.rst5h}` : null
        )
      );
    }
    if (quota.pct7d !== null && quota.pct7d !== undefined) {
      parts.push(
        h(
          document,
          'span',
          null,
          '7d ',
          h(document, 'strong', { className: 'agy-ctx-quota' }, `${quota.pct7d}%`),
          h(document, 'span', { className: 'agy-ctx-quota-left' }, ` ${tr.t('metrics.leftLabel')}`)
        )
      );
    }
    if (!parts.length) return;

    const groupChildren = [];
    parts.forEach((part, idx) => {
      if (idx > 0) {
        groupChildren.push(h(document, 'span', { className: 'agy-ctx-sep' }, ' · '));
      }
      groupChildren.push(part);
    });

    quotaSlotEl.appendChild(h(document, 'span', { className: 'agy-ctx-sep agy-ctx-sep-pipe' }, '|'));
    quotaSlotEl.appendChild(
      h(document, 'span', { className: 'agy-ctx-group agy-ctx-group-quota', 'data-locale': localeKey }, ...groupChildren)
    );
  }

  return {
    id: 'core-metrics',
    slot: 'left',
    order: 10,
    builtin: true,
    tagName: 'span',
    className: 'agy-ctx-core',
    render(containerEl, ctx) {
      const { barEl, view, cascadeId, stats, quota } = ctx;
      containerEl.setAttribute?.('data-agy-no-translate', 'true');
      containerEl.setAttribute?.('translate', 'no');

      const state = getContainerState(containerEl);
      const localeKey = tr.getLocale();
      const currentCw = ctx.currentCw || getConversationContextWindow(view, cascadeId);
      const maxLimit = cwStore.getLimit(currentCw);
      const used = stats ? stats.used : 0;
      const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
      const usedStr = stats ? fmtK(used) : '…';
      const cachePct = stats ? stats.cachePct : 0;

      const colorClass = pct >= 85 ? 'agy-ctx-crit' : pct >= 65 ? 'agy-ctx-warn' : 'agy-ctx-ok';
      const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';

      const limitModClass =
        maxLimit >= 750000 ? 'agy-ctx-btn-limit-900' : maxLimit > 256000 ? 'agy-ctx-btn-limit-512' : '';
      const titleSessionLabel =
        cascadeId && cascadeId !== 'remote-session' ? cascadeId.slice(0, 8) : tr.t('metrics.currentSession');
      const limitTitle = tr.t('metrics.limitTitle', {
        session: titleSessionLabel,
        cw: currentCw,
        hint: cwStore.getQuotaHint(currentCw),
      });

      const sessionChanged = Boolean(state.lastCascadeId && state.lastCascadeId !== cascadeId);
      state.lastCascadeId = cascadeId;

      if (ctx.deferUncachedMetrics) {
        const existingLimitBtn = state.refs?.limitBtn || containerEl.querySelector?.('.agy-ctx-btn-limit');
        if (existingLimitBtn) {
          const nextLimitClass = `agy-ctx-btn agy-ctx-btn-limit ${limitModClass}`.trim();
          if (existingLimitBtn.className !== nextLimitClass) existingLimitBtn.className = nextLimitClass;
          if (existingLimitBtn.getAttribute?.('title') !== limitTitle) {
            existingLimitBtn.setAttribute?.('title', limitTitle);
            existingLimitBtn.title = limitTitle;
          }
          setText(existingLimitBtn, `[ ${currentCw.toLowerCase()} ▾ ]`);
          state.pendingCrossSessionNoTransition = true;
          state.lastSignature = '';
          return;
        }
        if (state.lastSignature) {
          state.pendingCrossSessionNoTransition = true;
          state.lastSignature = '';
          return;
        }
      }

      const suppressBarTransition = sessionChanged || state.pendingCrossSessionNoTransition;
      state.pendingCrossSessionNoTransition = false;

      const quotaKey = quota ? `${localeKey}|${quota.pct5h ?? ''}|${quota.rst5h ?? ''}|${quota.pct7d ?? ''}` : '';
      const signature = `${localeKey}|${pct}|${usedStr}|${currentCw}|${cachePct}|${limitTitle}|${quotaKey}`;
      if (state.lastSignature === signature && !suppressBarTransition && state.refs) {
        return;
      }
      state.lastSignature = signature;

      if (!state.refs) {
        const barFill = h(document, 'span', {
          className: 'agy-ctx-bar-fill',
          style: {
            width: `${pct}%`,
            background: barColor,
            ...(suppressBarTransition ? { transition: 'none' } : {}),
          },
        });
        const pctValEl = h(document, 'strong', { className: `agy-ctx-pct-val ${colorClass}` }, `${pct}%`);
        const usedValEl = h(document, 'span', { className: 'agy-ctx-used-val' }, usedStr);
        const limitBtn = h(
          document,
          'button',
          {
            type: 'button',
            className: `agy-ctx-btn agy-ctx-btn-limit ${limitModClass}`.trim(),
            title: limitTitle,
            onclick(e) {
              e.preventDefault();
              e.stopPropagation();
              const activeCid = view?.getAttribute?.('data-cascade-id') || state.lastCascadeId;
              if (e.shiftKey) {
                cycleConversationContextWindow(view, activeCid);
                updateAll();
              } else {
                showContextMenu(barEl, view, activeCid, limitBtn);
              }
            },
            oncontextmenu(e) {
              e.preventDefault();
              e.stopPropagation();
              const activeCid = view?.getAttribute?.('data-cascade-id') || state.lastCascadeId;
              showContextMenu(barEl, view, activeCid, limitBtn);
            },
          },
          `[ ${currentCw.toLowerCase()} ▾ ]`
        );
        const ctxLabelEl = h(document, 'span', null, `${tr.t('metrics.ctxLabel')} `);
        const cacheLabelEl = h(document, 'span', null, `${tr.t('metrics.cacheLabel')} `);
        const cacheEl = h(document, 'strong', { className: 'agy-ctx-cache' }, `${cachePct}%`);
        const quotaSlotEl = h(document, 'span', {
          className: 'agy-ctx-quota-slot',
          'data-agy-no-translate': 'true',
          translate: 'no',
        });

        const groupCtx = h(
          document,
          'span',
          {
            className: 'agy-ctx-group agy-ctx-group-ctx',
            'data-agy-no-translate': 'true',
            translate: 'no',
          },
          h(document, 'span', { className: 'agy-ctx-bar-wrap' }, barFill),
          h(document, 'span', null, ctxLabelEl, pctValEl, ' ', usedValEl, '/', limitBtn),
          h(document, 'span', { className: 'agy-ctx-sep' }, '·'),
          h(document, 'span', null, cacheLabelEl, cacheEl)
        );

        clearChildren(containerEl);
        containerEl.appendChild(groupCtx);
        containerEl.appendChild(quotaSlotEl);

        state.refs = {
          barFill,
          pctValEl,
          usedValEl,
          limitBtn,
          ctxLabelEl,
          cacheLabelEl,
          cacheEl,
          quotaSlotEl,
        };
        state.lastQuotaKey = quotaKey;
        renderQuotaSlot(quotaSlotEl, quota, localeKey);
        return;
      }

      const { barFill, pctValEl, usedValEl, limitBtn, ctxLabelEl, cacheLabelEl, cacheEl, quotaSlotEl } = state.refs;
      if (barFill.style) {
        barFill.style.transition = suppressBarTransition ? 'none' : '';
        barFill.style.width = `${pct}%`;
        barFill.style.background = barColor;
      }
      const nextPctClass = `agy-ctx-pct-val ${colorClass}`;
      if (pctValEl.className !== nextPctClass) pctValEl.className = nextPctClass;
      setText(pctValEl, `${pct}%`);
      setText(usedValEl, usedStr);
      const nextLimitClass = `agy-ctx-btn agy-ctx-btn-limit ${limitModClass}`.trim();
      if (limitBtn.className !== nextLimitClass) limitBtn.className = nextLimitClass;
      if (limitBtn.getAttribute?.('title') !== limitTitle) {
        limitBtn.setAttribute?.('title', limitTitle);
        limitBtn.title = limitTitle;
      }
      setText(limitBtn, `[ ${currentCw.toLowerCase()} ▾ ]`);
      setText(ctxLabelEl, `${tr.t('metrics.ctxLabel')} `);
      setText(cacheLabelEl, `${tr.t('metrics.cacheLabel')} `);
      setText(cacheEl, `${cachePct}%`);

      if (state.lastQuotaKey !== quotaKey) {
        state.lastQuotaKey = quotaKey;
        renderQuotaSlot(quotaSlotEl, quota, localeKey);
      }
    },
  };
}

module.exports = {
  createCoreMetricsAdapter,
};
