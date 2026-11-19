/**
 * Lightweight display-only inline chat-input-bar UI for Antigravity Desktop.
 *
 * Security & Architecture invariants:
 * - Zero React Fiber, zero lsClient, zero Protobuf, zero host flag overrides.
 * - Zero innerHTML / outerHTML / insertAdjacentHTML (DOM createElement + textContent only).
 * - Auth token is sealed inside the IIFE closure and NEVER exposed on window, DOM, or storage.
 * - Talks exclusively to the local v3 Sidecar backend over loopback HTTP POST with X-Statusbar-Token.
 */

const INLINE_STYLES = `
.agy-inline-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  margin-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11px;
  line-height: 1.3;
  color: rgba(255, 255, 255, 0.72);
  user-select: none;
  position: relative;
  flex-wrap: wrap;
}
.agy-inline-left,
.agy-inline-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.agy-inline-metric {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.agy-inline-metric-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  padding: 1px 4px;
  border-radius: 4px;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.agy-inline-metric-btn:hover,
.agy-inline-metric-btn:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  outline: none;
}
.agy-inline-bar-track {
  width: 44px;
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
  flex-shrink: 0;
}
.agy-inline-bar-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: #4ea1ff;
  transition: width 160ms ease, background-color 160ms ease;
}
.agy-inline-bar-fill.warn {
  background: #f5b942;
}
.agy-inline-bar-fill.danger {
  background: #f06565;
}
.agy-inline-sep {
  opacity: 0.35;
}
.agy-inline-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(240, 101, 101, 0.2);
  color: #ff9c9c;
  font-weight: 600;
}
.agy-inline-btn {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.88);
  font: inherit;
  font-size: 11px;
  padding: 2px 7px;
  cursor: pointer;
  line-height: 1.3;
}
.agy-inline-btn:hover:not(:disabled),
.agy-inline-btn:focus-visible:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  outline: none;
}
.agy-inline-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.agy-inline-status-note {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
}
.agy-inline-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 8px;
  width: 290px;
  max-width: calc(100vw - 24px);
  background: #1e1f22;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  padding: 10px 12px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agy-inline-popover.hidden {
  display: none;
}
.agy-inline-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
  font-size: 12px;
}
.agy-inline-pop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}
.agy-inline-pop-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
}
.agy-inline-pop-controls {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.agy-inline-pop-select,
.agy-inline-pop-input {
  background: #141517;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 5px;
  font-size: 11px;
  padding: 3px 6px;
}
.agy-inline-pop-input {
  width: 84px;
}
.agy-inline-pop-feedback {
  font-size: 10px;
  color: #8cc8ff;
}
.agy-inline-pop-feedback.err {
  color: #ff9c9c;
}
`;

/**
 * Self-contained browser runtime function. Must remain standalone (no outer closures)
 * because `renderInlineStatusbarScript` serializes it via `.toString()`.
 */
export function inlineStatusbarBootstrap(cfg) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (!cfg || typeof cfg.baseUrl !== 'string' || typeof cfg.token !== 'string') return null;

  try {
    if (window.__agyStatusbarInline && typeof window.__agyStatusbarInline.destroy === 'function') {
      window.__agyStatusbarInline.destroy();
    }
  } catch {}

  const BASE_URL = cfg.baseUrl.replace(/\/+$/, '');
  const TOKEN = cfg.token;
  const STYLE_ID = 'agy-inline-statusbar-style';
  const PRESETS = [32000, 64000, 128000, 200000, 256000, 384000, 512000, 980000];
  const NORMAL_POLL_MS = 3000;
  const BURST_POLL_MS = 1000;
  const QUOTA_POLL_MS = 15000;
  const MAX_BURST_MS = 30000;

  const STRINGS = {
    en: {
      connecting: 'Statusbar: Connecting…',
      reconnecting: 'Statusbar: Reconnecting…',
      ctx: 'Ctx',
      cache: 'Cache',
      quota: 'Quota',
      softLimit: 'Soft Limit',
      compact: 'compact',
      compacting: '…',
      compactSent: 'Compaction requested',
      compactFail: 'Compaction failed',
      settingsTitle: 'Statusbar Details & Limit',
      hostDefault: 'Host default',
      scopeSession: 'This session',
      scopeDefault: 'Default',
      apply: 'Apply',
      applied: 'Saved',
      invalidLimit: 'Enter 32000-980000 or empty',
      steps: 'Steps',
      model: 'Model',
      close: 'Close',
      localeBtn: 'KO',
      stale: 'stale',
    },
    ko: {
      connecting: '상태바: 연결 중…',
      reconnecting: '상태바: 재연결 중…',
      ctx: '컨텍스트',
      cache: '캐시',
      quota: '할당량',
      softLimit: '소프트 한도 초과',
      compact: 'compact',
      compacting: '…',
      compactSent: '컴팩션 요청됨',
      compactFail: '컴팩션 실패',
      settingsTitle: '상태바 상세 · 한도 설정',
      hostDefault: '호스트 기본값',
      scopeSession: '현재 세션',
      scopeDefault: '기본값',
      apply: '적용',
      applied: '저장됨',
      invalidLimit: '32000~980000 또는 비움',
      steps: '스텝',
      model: '모델',
      close: '닫기',
      localeBtn: 'EN',
      stale: '오래됨',
    },
  };

  let disposed = false;
  let locale = 'ko';
  let quotaState = null;
  let quotaPollTimer = null;
  let snapshotPollTimer = null;
  let burstUntil = 0;
  let fallbackSessionId = '';
  let lastConnected = false;
  const barControllers = new Map();
  const activeControllers = new Set();

  function t() {
    return STRINGS[locale] || STRINGS.ko;
  }

  function formatTokens(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '--';
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(Math.round(n));
  }

  function setText(el, text) {
    if (el && el.textContent !== text) {
      el.textContent = text;
    }
  }

  function clearChildren(el) {
    while (el && el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  async function apiPost(pathname, bodyObj, externalSignal) {
    const ctrl = new AbortController();
    activeControllers.add(ctrl);
    const onAbort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        activeControllers.delete(ctrl);
        throw new Error('aborted');
      }
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(`${BASE_URL}${pathname}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-statusbar-token': TOKEN,
        },
        body: JSON.stringify(bodyObj || {}),
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(json?.error?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = json?.error?.code || 'HTTP_ERROR';
        throw err;
      }
      lastConnected = true;
      return json;
    } finally {
      activeControllers.delete(ctrl);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  function ensureStyle() {
    if (!document.head || document.getElementById(STYLE_ID)) return;
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = cfg.styles || '';
    document.head.appendChild(styleEl);
  }

  function createBarForInputBox(viewEl, boxEl) {
    const barEl = document.createElement('div');
    barEl.className = 'agy-inline-statusbar';
    barEl.setAttribute('data-agy-no-translate', 'true');
    barEl.setAttribute('translate', 'no');
    barEl.setAttribute('role', 'region');
    barEl.setAttribute('aria-label', 'Statusbar');

    const leftEl = document.createElement('div');
    leftEl.className = 'agy-inline-left';

    const ctxBtn = document.createElement('button');
    ctxBtn.type = 'button';
    ctxBtn.className = 'agy-inline-metric-btn';
    ctxBtn.setAttribute('aria-expanded', 'false');

    const trackEl = document.createElement('span');
    trackEl.className = 'agy-inline-bar-track';
    const fillEl = document.createElement('span');
    fillEl.className = 'agy-inline-bar-fill';
    trackEl.appendChild(fillEl);

    const ctxTextEl = document.createElement('span');
    ctxTextEl.textContent = t().connecting;

    ctxBtn.appendChild(trackEl);
    ctxBtn.appendChild(ctxTextEl);

    const softBadgeEl = document.createElement('span');
    softBadgeEl.className = 'agy-inline-badge';
    softBadgeEl.style.display = 'none';

    const sep1 = document.createElement('span');
    sep1.className = 'agy-inline-sep';
    sep1.textContent = '·';

    const cacheEl = document.createElement('span');
    cacheEl.className = 'agy-inline-metric';
    cacheEl.textContent = `${t().cache} --`;

    const sep2 = document.createElement('span');
    sep2.className = 'agy-inline-sep';
    sep2.textContent = '·';

    const quotaEl = document.createElement('span');
    quotaEl.className = 'agy-inline-metric';
    quotaEl.textContent = `${t().quota} --`;

    leftEl.appendChild(ctxBtn);
    leftEl.appendChild(softBadgeEl);
    leftEl.appendChild(sep1);
    leftEl.appendChild(cacheEl);
    leftEl.appendChild(sep2);
    leftEl.appendChild(quotaEl);

    const rightEl = document.createElement('div');
    rightEl.className = 'agy-inline-right';

    const noteEl = document.createElement('span');
    noteEl.className = 'agy-inline-status-note';

    const compactBtn = document.createElement('button');
    compactBtn.type = 'button';
    compactBtn.className = 'agy-inline-btn';
    compactBtn.textContent = t().compact;

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'agy-inline-btn';
    settingsBtn.textContent = '⚙';
    settingsBtn.setAttribute('aria-label', t().settingsTitle);
    settingsBtn.setAttribute('aria-expanded', 'false');

    rightEl.appendChild(noteEl);
    rightEl.appendChild(compactBtn);
    rightEl.appendChild(settingsBtn);

    // Popover for breakdown + soft context limit + locale
    const popEl = document.createElement('div');
    popEl.className = 'agy-inline-popover hidden';
    popEl.setAttribute('data-agy-no-translate', 'true');
    popEl.setAttribute('translate', 'no');

    const popHead = document.createElement('div');
    popHead.className = 'agy-inline-pop-head';
    const popTitle = document.createElement('span');
    popTitle.textContent = t().settingsTitle;

    const popHeadActions = document.createElement('div');
    popHeadActions.className = 'agy-inline-pop-controls';
    const localeBtn = document.createElement('button');
    localeBtn.type = 'button';
    localeBtn.className = 'agy-inline-btn';
    localeBtn.textContent = t().localeBtn;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'agy-inline-btn';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', t().close);
    popHeadActions.appendChild(localeBtn);
    popHeadActions.appendChild(closeBtn);
    popHead.appendChild(popTitle);
    popHead.appendChild(popHeadActions);

    const popMeta = document.createElement('div');
    popMeta.className = 'agy-inline-pop-row';
    const popModel = document.createElement('span');
    const popSteps = document.createElement('span');
    popMeta.appendChild(popModel);
    popMeta.appendChild(popSteps);

    const breakdownList = document.createElement('ul');
    breakdownList.className = 'agy-inline-pop-list';

    const limitControls = document.createElement('div');
    limitControls.className = 'agy-inline-pop-controls';

    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'agy-inline-pop-select';
    const optSession = document.createElement('option');
    optSession.value = 'session';
    optSession.textContent = t().scopeSession;
    const optDefault = document.createElement('option');
    optDefault.value = 'default';
    optDefault.textContent = t().scopeDefault;
    scopeSelect.appendChild(optSession);
    scopeSelect.appendChild(optDefault);

    const presetSelect = document.createElement('select');
    presetSelect.className = 'agy-inline-pop-select';

    const customInput = document.createElement('input');
    customInput.className = 'agy-inline-pop-input';
    customInput.type = 'number';
    customInput.min = '32000';
    customInput.max = '980000';
    customInput.step = '1000';
    customInput.placeholder = '32000-980000';

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'agy-inline-btn';
    applyBtn.textContent = t().apply;

    limitControls.appendChild(scopeSelect);
    limitControls.appendChild(presetSelect);
    limitControls.appendChild(customInput);
    limitControls.appendChild(applyBtn);

    const popFeedback = document.createElement('div');
    popFeedback.className = 'agy-inline-pop-feedback';

    popEl.appendChild(popHead);
    popEl.appendChild(popMeta);
    popEl.appendChild(breakdownList);
    popEl.appendChild(limitControls);
    popEl.appendChild(popFeedback);

    barEl.appendChild(leftEl);
    barEl.appendChild(rightEl);
    barEl.appendChild(popEl);

    boxEl.appendChild(barEl);

    const state = {
      viewEl,
      boxEl,
      barEl,
      popEl,
      popOpen: false,
      snapshot: null,
      epoch: 0,
      abortCtrl: null,
      compacting: false,
    };

    function rebuildPresets() {
      const prev = presetSelect.value;
      clearChildren(presetSelect);
      const hostOpt = document.createElement('option');
      hostOpt.value = '';
      hostOpt.textContent = t().hostDefault;
      presetSelect.appendChild(hostOpt);
      for (const p of PRESETS) {
        const o = document.createElement('option');
        o.value = String(p);
        o.textContent = `${Math.round(p / 1000)}K`;
        presetSelect.appendChild(o);
      }
      presetSelect.value = prev;
    }

    function setPopoverOpen(open) {
      state.popOpen = Boolean(open);
      popEl.classList.toggle('hidden', !state.popOpen);
      ctxBtn.setAttribute('aria-expanded', String(state.popOpen));
      settingsBtn.setAttribute('aria-expanded', String(state.popOpen));
    }

    function getSessionId() {
      const attr = viewEl.getAttribute('data-cascade-id') || '';
      if (attr && attr !== 'remote-session') return attr;
      return fallbackSessionId;
    }

    function render() {
      const tr = t();
      setText(popTitle, tr.settingsTitle);
      setText(localeBtn, tr.localeBtn);
      setText(optSession, tr.scopeSession);
      setText(optDefault, tr.scopeDefault);
      setText(applyBtn, tr.apply);
      setText(compactBtn, state.compacting ? tr.compacting : tr.compact);
      rebuildPresets();

      const snap = state.snapshot;
      if (!snap) {
        setText(ctxTextEl, lastConnected ? `${tr.ctx} --` : tr.connecting);
        fillEl.style.width = '0%';
        fillEl.className = 'agy-inline-bar-fill';
        softBadgeEl.style.display = 'none';
        setText(cacheEl, `${tr.cache} --`);
      } else {
        const pct = typeof snap.usagePercent === 'number' ? Math.max(0, Math.min(100, snap.usagePercent)) : 0;
        const usedStr = formatTokens(snap.usedTokens);
        const limitStr = formatTokens(snap.effectiveLimit);
        setText(ctxTextEl, `${tr.ctx} ${pct.toFixed(0)}% (${usedStr} / ${limitStr})`);
        const isSoftExceeded = Boolean(snap.exceededSoftLimit || snap.softLimitExceeded);
        fillEl.style.width = `${pct}%`;
        fillEl.className =
          'agy-inline-bar-fill' +
          (isSoftExceeded || pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : '');

        if (isSoftExceeded) {
          softBadgeEl.style.display = '';
          setText(softBadgeEl, tr.softLimit);
        } else {
          softBadgeEl.style.display = 'none';
        }

        const rawCachePct =
          typeof snap.cacheHitPercent === 'number'
            ? snap.cacheHitPercent
            : snap.cache && typeof snap.cache.hitRatePercent === 'number'
              ? snap.cache.hitRatePercent
              : null;
        const cachePct = rawCachePct !== null ? `${rawCachePct.toFixed(0)}%` : '--';
        setText(cacheEl, `${tr.cache} ${cachePct}`);

        setText(popModel, `${tr.model}: ${snap.modelName || '--'}`);
        setText(popSteps, `${tr.steps}: ${snap.stepCount ?? '--'}`);

        clearChildren(breakdownList);
        const bdList = Array.isArray(snap.tokenBreakdown) ? snap.tokenBreakdown : [];
        for (const item of bdList) {
          if (!item || typeof item.tokens !== 'number' || item.tokens <= 0) continue;
          const li = document.createElement('li');
          li.className = 'agy-inline-pop-row';
          const lbl = document.createElement('span');
          lbl.textContent = item.label || item.key || 'Other';
          const val = document.createElement('span');
          val.textContent = formatTokens(item.tokens);
          li.appendChild(lbl);
          li.appendChild(val);
          breakdownList.appendChild(li);
        }

        if (typeof snap.customLimit === 'number') {
          if (document.activeElement !== customInput) {
            customInput.value = String(snap.customLimit);
          }
          if (document.activeElement !== presetSelect) {
            presetSelect.value = PRESETS.includes(snap.customLimit) ? String(snap.customLimit) : '';
          }
        }
      }

      if (quotaState && quotaState.available && Array.isArray(quotaState.groups) && quotaState.groups.length > 0) {
        const allBuckets = [];
        for (const g of quotaState.groups) {
          const buckets = Array.isArray(g.buckets) ? g.buckets : [];
          for (const b of buckets) {
            if (typeof b.remainingPercent === 'number') {
              allBuckets.push({
                label: g.label || 'Quota',
                window: b.window || '',
                pct: b.remainingPercent,
              });
            }
          }
        }
        if (allBuckets.length > 0) {
          const minPct = Math.min(...allBuckets.map((b) => b.pct));
          const staleTag = quotaState.stale ? ` (${tr.stale})` : '';
          setText(quotaEl, `${tr.quota} ${Math.round(minPct)}%${staleTag}`);
          quotaEl.title = allBuckets
            .map((b) => `${b.label}${b.window ? ` (${b.window})` : ''}: ${Math.round(b.pct)}%`)
            .join('\n');
        } else {
          setText(quotaEl, `${tr.quota} --`);
          quotaEl.title = '';
        }
      } else {
        setText(quotaEl, `${tr.quota} --`);
        quotaEl.title = '';
      }
    }

    async function refreshSnapshot() {
      if (disposed) return;
      const sid = getSessionId();
      if (!sid) return;
      const reqEpoch = ++state.epoch;
      if (state.abortCtrl) state.abortCtrl.abort();
      state.abortCtrl = new AbortController();
      try {
        const snap = await apiPost('/api/snapshot', { sessionId: sid }, state.abortCtrl.signal);
        if (disposed || reqEpoch !== state.epoch) return;
        state.snapshot = snap;
        render();
      } catch (err) {
        if (disposed || err?.name === 'AbortError' || err?.message === 'aborted') return;
        if (!state.snapshot) {
          setText(ctxTextEl, t().reconnecting);
        }
      }
    }

    async function handleCompact() {
      const sid = getSessionId();
      if (!sid || state.compacting) return;
      state.compacting = true;
      compactBtn.disabled = true;
      render();
      try {
        await apiPost('/api/compact', { sessionId: sid });
        setText(noteEl, t().compactSent);
        burstUntil = Date.now() + MAX_BURST_MS;
        scheduleSnapshotPoll();
      } catch {
        setText(noteEl, t().compactFail);
      } finally {
        state.compacting = false;
        compactBtn.disabled = false;
        render();
        setTimeout(() => {
          if (!disposed) setText(noteEl, '');
        }, 4000);
      }
    }

    async function handleApplyLimit() {
      const raw = customInput.value.trim();
      let limitVal = null;
      if (raw !== '') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 32000 || parsed > 980000) {
          popFeedback.className = 'agy-inline-pop-feedback err';
          setText(popFeedback, t().invalidLimit);
          return;
        }
        limitVal = Math.round(parsed);
      }
      const scope = scopeSelect.value === 'default' ? 'default' : 'session';
      const payload =
        scope === 'default'
          ? { defaultCustomLimit: limitVal }
          : { sessionId: getSessionId(), customLimit: limitVal };
      try {
        await apiPost('/api/settings/update', payload);
        popFeedback.className = 'agy-inline-pop-feedback';
        setText(popFeedback, t().applied);
        await refreshSnapshot();
      } catch (err) {
        popFeedback.className = 'agy-inline-pop-feedback err';
        setText(popFeedback, err?.message || 'Error');
      }
    }

    async function handleToggleLocale() {
      const next = locale === 'ko' ? 'en' : 'ko';
      locale = next;
      for (const ctrl of barControllers.values()) ctrl.render();
      try {
        await apiPost('/api/settings/update', { locale: next });
      } catch {}
    }

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && state.popOpen) {
        setPopoverOpen(false);
      }
    };
    const onInputKeyDown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleApplyLimit();
      }
    };
    const onPresetChange = () => {
      customInput.value = presetSelect.value;
    };

    ctxBtn.addEventListener('click', () => setPopoverOpen(!state.popOpen));
    settingsBtn.addEventListener('click', () => setPopoverOpen(!state.popOpen));
    closeBtn.addEventListener('click', () => setPopoverOpen(false));
    compactBtn.addEventListener('click', handleCompact);
    applyBtn.addEventListener('click', handleApplyLimit);
    localeBtn.addEventListener('click', handleToggleLocale);
    presetSelect.addEventListener('change', onPresetChange);
    customInput.addEventListener('keydown', onInputKeyDown);
    document.addEventListener('keydown', onKeyDown);

    rebuildPresets();
    render();

    return {
      render,
      refreshSnapshot,
      destroy() {
        if (state.abortCtrl) state.abortCtrl.abort();
        document.removeEventListener('keydown', onKeyDown);
        try {
          barEl.remove();
        } catch {}
      },
    };
  }

  function scanAndMount() {
    if (disposed) return;
    ensureStyle();
    const views = Array.from(document.querySelectorAll('[data-testid="conversation-view"]'));
    const liveBoxes = new Set();

    for (const viewEl of views) {
      const boxEl = viewEl.querySelector('[data-testid="agent-input-box"]');
      if (!boxEl) continue;
      liveBoxes.add(boxEl);
      if (!barControllers.has(boxEl)) {
        const ctrl = createBarForInputBox(viewEl, boxEl);
        barControllers.set(boxEl, ctrl);
        ctrl.refreshSnapshot();
      }
    }

    const allBoxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]'));
    for (const boxEl of allBoxes) {
      if (liveBoxes.has(boxEl)) continue;
      liveBoxes.add(boxEl);
      if (!barControllers.has(boxEl)) {
        const viewEl = boxEl.closest('[data-testid="conversation-view"]') || boxEl;
        const ctrl = createBarForInputBox(viewEl, boxEl);
        barControllers.set(boxEl, ctrl);
        ctrl.refreshSnapshot();
      }
    }

    for (const [boxEl, ctrl] of barControllers.entries()) {
      if (!liveBoxes.has(boxEl) || !document.contains(boxEl)) {
        ctrl.destroy();
        barControllers.delete(boxEl);
      }
    }
  }

  async function pollSessionsAndSnapshots() {
    if (disposed) return;
    try {
      const sessRes = await apiPost('/api/sessions', {});
      if (Array.isArray(sessRes?.sessions) && sessRes.sessions.length > 0) {
        fallbackSessionId = sessRes.sessions[0].sessionId || '';
      }
    } catch {}
    scanAndMount();
    for (const ctrl of barControllers.values()) {
      ctrl.refreshSnapshot();
    }
  }

  async function pollQuotaAndSettings() {
    if (disposed) return;
    try {
      const settings = await apiPost('/api/settings/get', {});
      if (settings && (settings.locale === 'ko' || settings.locale === 'en')) {
        locale = settings.locale;
      }
    } catch {}
    try {
      quotaState = await apiPost('/api/quota', {});
      for (const ctrl of barControllers.values()) ctrl.render();
    } catch {}
  }

  function scheduleSnapshotPoll() {
    if (snapshotPollTimer) clearTimeout(snapshotPollTimer);
    if (disposed) return;
    const delay = Date.now() < burstUntil ? BURST_POLL_MS : NORMAL_POLL_MS;
    snapshotPollTimer = setTimeout(async () => {
      await pollSessionsAndSnapshots();
      scheduleSnapshotPoll();
    }, delay);
  }

  function isOwnNode(node) {
    let cur = node && node.nodeType === 3 ? node.parentElement : node;
    while (cur && cur.nodeType === 1) {
      if (
        cur.id === STYLE_ID ||
        (cur.classList &&
          (cur.classList.contains('agy-inline-statusbar') ||
            cur.classList.contains('agy-inline-popover')))
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  let observer = null;
  if (typeof MutationObserver !== 'undefined' && document.body) {
    observer = new MutationObserver((mutations) => {
      if (disposed) return;
      for (const m of mutations) {
        if (!isOwnNode(m.target)) {
          scanAndMount();
          return;
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cascade-id'],
    });
  }

  scanAndMount();
  pollQuotaAndSettings();
  pollSessionsAndSnapshots();
  scheduleSnapshotPoll();
  quotaPollTimer = setInterval(pollQuotaAndSettings, QUOTA_POLL_MS);

  const api = {
    destroy() {
      if (disposed) return;
      disposed = true;
      if (snapshotPollTimer) clearTimeout(snapshotPollTimer);
      if (quotaPollTimer) clearInterval(quotaPollTimer);
      if (observer) observer.disconnect();
      for (const c of activeControllers) c.abort();
      activeControllers.clear();
      for (const ctrl of barControllers.values()) ctrl.destroy();
      barControllers.clear();
      try {
        const st = document.getElementById(STYLE_ID);
        if (st) st.remove();
      } catch {}
      try {
        if (window.__agyStatusbarInline === api) {
          delete window.__agyStatusbarInline;
        }
      } catch {}
    },
  };

  window.__agyStatusbarInline = api;
  return api;
}

/**
 * Renders the self-contained inline script with `{ baseUrl, token }` sealed inside
 * an IIFE closure (never exposed on `window`, `localStorage`, or DOM).
 *
 * @param {{ baseUrl: string, token: string }} opts
 * @returns {string}
 */
export function renderInlineStatusbarScript({ baseUrl, token }) {
  if (typeof baseUrl !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(baseUrl)) {
    throw new Error('Invalid loopback baseUrl for inline statusbar script.');
  }
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('Invalid token for inline statusbar script.');
  }
  const serializedCfg = JSON.stringify({ baseUrl, token, styles: INLINE_STYLES });
  return `// Auto-generated by antigravity-statusbar v3 Sidecar (display-only inline UI)\n(${inlineStatusbarBootstrap.toString()})(${serializedCfg});\n`;
}

/**
 * Renders a safe teardown stub written on Sidecar shutdown so no stale token lingers on disk.
 *
 * @returns {string}
 */
export function renderInlineTeardownStub() {
  return (
    '// antigravity-statusbar v3 Sidecar stopped (teardown stub, zero credentials)\n' +
    'if (typeof window !== "undefined" && window.__agyStatusbarInline && typeof window.__agyStatusbarInline.destroy === "function") {\n' +
    '  try { window.__agyStatusbarInline.destroy(); } catch (_e) {}\n' +
    '}\n'
  );
}
