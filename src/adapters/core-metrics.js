'use strict';

const { PRESET_CONTEXT_WINDOWS } = require('../context-window-policy');
const { fmtK, escHtml } = require('../dom-styles');

function createCoreMetricsAdapter({
  document,
  setHtml,
  cwStore,
  getConversationContextWindow,
  setConversationContextWindow,
  cycleConversationContextWindow,
  updateAll,
}) {
  function showContextMenu(barEl, view, cascadeId, limitBtn) {
    const existing = barEl.querySelector('.agy-ctx-menu');
    if (existing) {
      existing.remove();
      return;
    }

    const currentCw = getConversationContextWindow(view, cascadeId);
    const currentKNum = parseInt(currentCw, 10) || 512;
    const menu = document.createElement('div');
    menu.className = 'agy-ctx-menu';

    if (typeof menu.addEventListener === 'function') {
      for (const evtName of ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'contextmenu']) {
        menu.addEventListener(evtName, (ev) => ev.stopPropagation());
      }
    }

    const hdr = document.createElement('div');
    hdr.className = 'agy-ctx-menu-hdr';
    setHtml(hdr, `
      <span>세션 컨텍스트 한도</span>
      <span style="opacity:0.75">${escHtml(cascadeId ? cascadeId.slice(0, 8) : '현재 세션')}</span>
    `);
    menu.appendChild(hdr);

    const customRow = document.createElement('div');
    customRow.className = 'agy-ctx-custom-row';
    setHtml(customRow, `
      <input type="text" class="agy-ctx-custom-input" value="${escHtml(currentKNum)}" placeholder="32~980" title="32 ~ 980 사이 숫자 입력 (예: 400 입력 시 400K 적용)" />
      <span class="agy-ctx-custom-unit">K</span>
      <button type="button" class="agy-ctx-custom-apply">적용</button>
    `);
    menu.appendChild(customRow);

    const closeMenu = () => {
      menu.remove();
      document?.removeEventListener('mousedown', outsideHandler, true);
    };

    const inputEl = customRow.querySelector('.agy-ctx-custom-input');
    const applyBtn = customRow.querySelector('.agy-ctx-custom-apply');
    const applyCustomInput = () => {
      if (!inputEl) return;
      const norm = cwStore.normalize(inputEl.value);
      if (!norm) {
        if (inputEl.style) inputEl.style.borderColor = '#ec7063';
        return;
      }
      setConversationContextWindow(view, cascadeId, norm);
      closeMenu();
      updateAll();
    };

    if (applyBtn) {
      applyBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyCustomInput();
      };
    }
    if (inputEl) {
      inputEl.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          applyCustomInput();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
        }
      };
    }

    const optionsList = [...PRESET_CONTEXT_WINDOWS];
    if (currentCw && !optionsList.includes(currentCw)) {
      optionsList.unshift(currentCw);
    }

    for (const cw of optionsList) {
      const item = document.createElement('div');
      item.className = 'agy-ctx-menu-item' + (cw === currentCw ? ' active' : '');
      item.setAttribute('data-cw-option', cw);
      setHtml(item, `
        <span>${cw === currentCw ? '✓ ' : '  '}${escHtml(cw)}</span>
        <span class="agy-ctx-menu-hint">${escHtml(cwStore.getQuotaHint(cw))}</span>
      `);
      item.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setConversationContextWindow(view, cascadeId, cw);
        closeMenu();
        updateAll();
      };
      menu.appendChild(item);
    }

    const outsideHandler = (e) => {
      if (!menu.contains || (!menu.contains(e.target) && e.target !== limitBtn)) {
        closeMenu();
      }
    };
    setTimeout(() => {
      document?.addEventListener('mousedown', outsideHandler, true);
      const isCoarseOrNarrow = typeof document?.defaultView?.matchMedia === 'function'
        && document.defaultView.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
      if (!isCoarseOrNarrow && inputEl && inputEl.isConnected && typeof inputEl.focus === 'function') {
        inputEl.focus();
        if (typeof inputEl.select === 'function') inputEl.select();
      }
    }, 10);
    barEl.appendChild(menu);
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
      const currentCw = getConversationContextWindow(view, cascadeId);
      const maxLimit = cwStore.getLimit(currentCw);
      const used = stats ? stats.used : 0;
      const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
      const usedStr = stats ? fmtK(used) : '…';
      const cachePct = stats ? stats.cachePct : 0;

      const colorClass = pct >= 85 ? 'agy-ctx-crit' : pct >= 65 ? 'agy-ctx-warn' : 'agy-ctx-ok';
      const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';

      const limitModClass = maxLimit >= 750000 ? 'agy-ctx-btn-limit-900' : (maxLimit > 256000 ? 'agy-ctx-btn-limit-512' : '');
      const limitTitle = `이 세션(${cascadeId ? cascadeId.slice(0, 8) : '현재'})의 컨텍스트 한도: ${currentCw} (${cwStore.getQuotaHint(currentCw)})\n클릭 시 직접 입력 / 프리셋 선택 메뉴 열기 (세션별 독립 적용)\nShift+클릭 시 256K → 512K → 900K 빠른 순환`;

      let quotaHtml = '';
      if (quota) {
        const qParts = [];
        if (quota.pct5h !== null) {
          qParts.push(`5h <strong class="agy-ctx-quota">${quota.pct5h}%</strong><span class="agy-ctx-quota-left"> left</span>${quota.rst5h ? ' ' + quota.rst5h : ''}`);
        }
        if (quota.pct7d !== null) {
          qParts.push(`7d <strong class="agy-ctx-quota">${quota.pct7d}%</strong><span class="agy-ctx-quota-left"> left</span>`);
        }
        if (qParts.length) {
          quotaHtml = `<span class="agy-ctx-sep agy-ctx-sep-pipe">|</span><span class="agy-ctx-group agy-ctx-group-quota">${qParts.join(' <span class="agy-ctx-sep">·</span> ')}</span>`;
        }
      }

      const html = `
        <span class="agy-ctx-group agy-ctx-group-ctx">
          <span class="agy-ctx-bar-wrap"><span class="agy-ctx-bar-fill" style="width:${pct}%;background:${barColor}"></span></span>
          <span>ctx <strong class="${colorClass}">${pct}%</strong> ${usedStr}/<button type="button" class="agy-ctx-btn agy-ctx-btn-limit ${limitModClass}" title="${limitTitle}">[ ${currentCw.toLowerCase()} ▾ ]</button></span>
          <span class="agy-ctx-sep">·</span>
          <span>cache <strong class="agy-ctx-cache">${cachePct}%</strong></span>
        </span>
        ${quotaHtml}
      `;

      if (containerEl.__lastHtml !== html) {
        containerEl.__lastHtml = html;
        setHtml(containerEl, html);

        const limitBtn = containerEl.querySelector ? containerEl.querySelector('.agy-ctx-btn-limit') : null;
        if (limitBtn) {
          limitBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
              cycleConversationContextWindow(view, cascadeId);
              updateAll();
            } else {
              showContextMenu(barEl, view, cascadeId, limitBtn);
            }
          };
          limitBtn.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(barEl, view, cascadeId, limitBtn);
          };
        }
      }
    },
  };
}

module.exports = {
  createCoreMetricsAdapter,
};
