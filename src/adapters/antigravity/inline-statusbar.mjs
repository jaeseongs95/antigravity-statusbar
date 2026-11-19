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
  display: inline-block;
  width: 48px;
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
  flex-shrink: 0;
}
.agy-inline-bar-fill {
  display: block;
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
.agy-inline-lang-select {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.88);
  font: inherit;
  font-size: 11px;
  padding: 2px 5px;
  cursor: pointer;
  line-height: 1.3;
}
.agy-inline-lang-select option {
  background: #1e1f22;
  color: #e6e7ea;
}
.agy-inline-custom-btns {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.agy-inline-pop-section {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.agy-inline-pop-subtitle {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  letter-spacing: -0.01em;
}
.agy-inline-pop-hint {
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.56);
  word-break: keep-all;
}
.agy-inline-pop-meta-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 11px;
}
.agy-inline-pop-meta-model {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agy-inline-pop-meta-steps {
  color: rgba(255, 255, 255, 0.6);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.agy-inline-bd-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.agy-inline-bd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
}
.agy-inline-bd-label {
  color: rgba(255, 255, 255, 0.82);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agy-inline-bd-val {
  color: rgba(255, 255, 255, 0.9);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.agy-inline-bd-track {
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.agy-inline-bd-fill {
  height: 100%;
  border-radius: 999px;
  background: #4ea1ff;
}
.agy-inline-pop-grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.agy-inline-pop-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.agy-inline-pop-btn-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 7px;
  padding: 5px 8px;
}
.agy-inline-pop-btn-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.agy-inline-source-pill {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.62);
}
.agy-inline-btn-primary {
  background: #2f7cf6;
  border-color: #3f88ff;
  color: #ffffff;
  font-weight: 500;
}
.agy-inline-btn-primary:hover:not(:disabled),
.agy-inline-btn-primary:focus-visible:not(:disabled) {
  background: #3d87fb;
}
.agy-inline-btn-on {
  background: rgba(78, 161, 255, 0.2);
  border-color: rgba(78, 161, 255, 0.45);
  color: #9dceff;
}
.agy-inline-status-note {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
}
.agy-inline-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 8px;
  width: 336px;
  max-width: calc(100vw - 24px);
  background: #1b1c20;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
  padding: 14px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  gap: 11px;
  word-break: keep-all;
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
  font-size: 13px;
  color: #f3f4f6;
}
.agy-inline-pop-close {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.65);
  font-size: 15px;
  line-height: 1;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.agy-inline-pop-close:hover,
.agy-inline-pop-close:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
  outline: none;
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
  gap: 6px;
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
  background: #131417;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  font-size: 11px;
  padding: 5px 8px;
  min-width: 0;
}
.agy-inline-pop-select:focus-visible,
.agy-inline-pop-input:focus-visible {
  border-color: #4ea1ff;
  outline: none;
}
.agy-inline-pop-input {
  flex: 1;
  font-variant-numeric: tabular-nums;
}
.agy-inline-pop-textarea {
  width: 100%;
  min-height: 48px;
  max-height: 110px;
  resize: vertical;
  box-sizing: border-box;
  background: #131417;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.4;
  padding: 6px 8px;
}
.agy-inline-pop-textarea:focus-visible {
  border-color: #4ea1ff;
  outline: none;
}
.agy-inline-pop-actions-end {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.agy-inline-pop-feedback {
  font-size: 11px;
  color: #8cc8ff;
}
.agy-inline-pop-feedback:empty {
  display: none;
}
.agy-inline-pop-feedback.err {
  color: #ff9c9c;
}
@media (prefers-reduced-motion: reduce) {
  .agy-inline-bar-fill {
    transition: none;
  }
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
  const NORMAL_POLL_MS = 1000;
  const BURST_POLL_MS = 400;
  const QUOTA_POLL_MS = 15000;
  const MAX_BURST_MS = 20000;

  const STRINGS = {
    en: {
      connecting: 'Statusbar: Connecting…',
      reconnecting: 'Statusbar: Reconnecting…',
      ctx: 'Ctx',
      cache: 'Cache',
      quota: 'Quota',
      softLimit: 'Limit Reached',
      autoCompacting: 'Auto-compacting…',
      compactingBadge: 'Compacting…',
      compact: 'compact',
      compacting: '…',
      compactSent: 'Compaction requested',
      compactInProgress: 'Compaction already in progress',
      compactFail: 'Compaction failed',
      noActiveSession: 'No active session found',
      settingsTitle: 'Statusbar Settings',
      breakdownTitle: 'Token Breakdown',
      limitTitle: 'Session Context Limit',
      limitHint: 'Saved per session. Runs /compact automatically when the limit is reached.',
      autoCompactLabel: 'Auto /compact on limit',
      compactPromptTitle: 'Compaction Prompt (/compact …)',
      compactPromptPlaceholder: 'e.g. Focus on modified files and remaining tasks (blank = default /compact)',
      save: 'Save',
      reset: 'Reset',
      limitPlaceholder: 'Custom tokens (32,000 - 980,000)',
      hostDefault: 'Host default',
      scopeSession: 'This session',
      scopeDefault: 'Default',
      apply: 'Apply',
      applied: 'Saved',
      appliedClamped: 'Saved ({val}) — clamped to model max ({max})',
      limitStatusNormal: 'Active: {eff} ({source}) · Model max {max}',
      limitStatusClamped: 'Set {custom} → clamped to model max {max}',
      sourceSession: 'this session',
      sourceDefault: 'default',
      sourceHost: 'host default',
      overModelMax: 'over {max} max',
      invalidLimit: 'Enter 32,000–980,000 or leave blank for host default.',
      steps: 'Steps',
      model: 'Model',
      close: 'Close',
      langLabel: 'Language',
      stale: 'stale',
      addonsTitle: 'Attached Add-ons',
      addonEmpty: 'No add-ons attached. Ask an agent to attach a button.',
      addonOn: 'ON',
      addonOff: 'OFF',
      delBtn: 'Remove',
      cmdSent: 'Sent',
      cmdFail: 'Failed',
    },
    ko: {
      connecting: '상태바: 연결 중…',
      reconnecting: '상태바: 재연결 중…',
      ctx: '컨텍스트',
      cache: '캐시',
      quota: '할당량',
      softLimit: '한도 도달',
      autoCompacting: '자동 컴팩션 중…',
      compactingBadge: '컴팩션 중…',
      compact: 'compact',
      compacting: '…',
      compactSent: '컴팩션 요청됨',
      compactInProgress: '이미 컴팩션 진행 중',
      compactFail: '컴팩션 실패',
      noActiveSession: '활성 세션을 찾을 수 없습니다.',
      settingsTitle: '상태바 상세 · 설정',
      breakdownTitle: '토큰 구성',
      limitTitle: '세션 컨텍스트 한도',
      limitHint: '세션마다 따로 저장되며, 한도에 도달하면 자동으로 /compact를 실행합니다.',
      autoCompactLabel: '한도 도달 시 자동 /compact',
      compactPromptTitle: '컴팩션 요약 문구 (/compact …)',
      compactPromptPlaceholder: '예: 수정 중인 파일과 남은 작업 위주로 요약해줘 (비우면 기본 /compact)',
      save: '저장',
      reset: '초기화',
      limitPlaceholder: '직접 입력 (32,000 ~ 980,000)',
      hostDefault: '호스트 기본값',
      scopeSession: '현재 세션',
      scopeDefault: '기본값',
      apply: '적용',
      applied: '저장되었습니다.',
      appliedClamped: '{val} 저장됨 (모델 최대 {max}로 제한 적용)',
      limitStatusNormal: '적용 중: {eff} ({source}) · 모델 최대 {max}',
      limitStatusClamped: '{custom} 설정됨 → 모델 최대 {max}로 제한 적용됨',
      sourceSession: '현재 세션',
      sourceDefault: '기본값',
      sourceHost: '호스트 기본값',
      overModelMax: '최대 {max} 초과',
      invalidLimit: '32,000~980,000 사이 숫자 또는 비움(기본값)을 입력하세요.',
      steps: '스텝',
      model: '모델',
      close: '닫기',
      langLabel: '언어 선택',
      stale: '오래됨',
      addonsTitle: '연결된 애드온',
      addonEmpty: '연결된 애드온이 없습니다. 에이전트에게 버튼 추가를 요청하세요.',
      addonOn: '켜짐',
      addonOff: '꺼짐',
      delBtn: '삭제',
      cmdSent: '전송됨',
      cmdFail: '전송 실패',
    },
  };

  const KO_BREAKDOWN_LABELS = {
    System: '시스템',
    'System Prompt': '시스템 프롬프트',
    'Chat Messages': '대화 메시지',
    'User Messages': '사용자 메시지',
    'Assistant Messages': '응답 메시지',
    Tools: '도구',
    'Tool Results': '도구 결과',
    'Files / Context': '파일 · 컨텍스트',
    Thoughts: '사고 과정',
    Other: '기타',
  };

  let disposed = false;
  let locale = 'ko';
  let autoCompactEnabled = true;
  let compactPrompt = '';
  let defaultCustomLimit = null;
  const sessionLimits = new Map();
  let customButtons = [];
  let disabledRuntimeAddonIds = new Set();
  const runtimeButtons = new Map();
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

    const customBtnsContainer = document.createElement('div');
    customBtnsContainer.className = 'agy-inline-custom-btns';

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
    rightEl.appendChild(customBtnsContainer);
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

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'agy-inline-pop-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', t().close);
    popHead.appendChild(popTitle);
    popHead.appendChild(closeBtn);

    const popMeta = document.createElement('div');
    popMeta.className = 'agy-inline-pop-meta-card';
    const popModel = document.createElement('span');
    popModel.className = 'agy-inline-pop-meta-model';
    const popSteps = document.createElement('span');
    popSteps.className = 'agy-inline-pop-meta-steps';
    popMeta.appendChild(popModel);
    popMeta.appendChild(popSteps);

    const breakdownSection = document.createElement('div');
    breakdownSection.className = 'agy-inline-pop-section';
    const breakdownTitle = document.createElement('div');
    breakdownTitle.className = 'agy-inline-pop-subtitle';
    breakdownTitle.textContent = t().breakdownTitle;
    const breakdownList = document.createElement('ul');
    breakdownList.className = 'agy-inline-pop-list';
    breakdownSection.appendChild(breakdownTitle);
    breakdownSection.appendChild(breakdownList);

    const limitSection = document.createElement('div');
    limitSection.className = 'agy-inline-pop-section';
    const limitTitle = document.createElement('div');
    limitTitle.className = 'agy-inline-pop-subtitle';
    limitTitle.textContent = t().limitTitle;
    const limitHint = document.createElement('div');
    limitHint.className = 'agy-inline-pop-hint';
    limitHint.textContent = t().limitHint;

    const limitRow1 = document.createElement('div');
    limitRow1.className = 'agy-inline-pop-grid2';

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

    limitRow1.appendChild(scopeSelect);
    limitRow1.appendChild(presetSelect);

    const limitRow2 = document.createElement('div');
    limitRow2.className = 'agy-inline-pop-input-row';

    const customInput = document.createElement('input');
    customInput.className = 'agy-inline-pop-input';
    customInput.type = 'number';
    customInput.min = '32000';
    customInput.max = '980000';
    customInput.step = '1000';
    customInput.placeholder = t().limitPlaceholder;

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'agy-inline-btn agy-inline-btn-primary';
    applyBtn.textContent = t().apply;

    limitRow2.appendChild(customInput);
    limitRow2.appendChild(applyBtn);

    const autoCompactRow = document.createElement('div');
    autoCompactRow.className = 'agy-inline-pop-row';
    const autoCompactLbl = document.createElement('span');
    autoCompactLbl.className = 'agy-inline-pop-hint';
    autoCompactLbl.textContent = t().autoCompactLabel;
    const autoCompactBtn = document.createElement('button');
    autoCompactBtn.type = 'button';
    autoCompactBtn.className = 'agy-inline-btn agy-inline-btn-on';
    autoCompactBtn.textContent = t().addonOn;
    autoCompactRow.appendChild(autoCompactLbl);
    autoCompactRow.appendChild(autoCompactBtn);

    const limitStatusEl = document.createElement('div');
    limitStatusEl.className = 'agy-inline-pop-hint';

    limitSection.appendChild(limitTitle);
    limitSection.appendChild(limitHint);
    limitSection.appendChild(limitRow1);
    limitSection.appendChild(limitRow2);
    limitSection.appendChild(limitStatusEl);
    limitSection.appendChild(autoCompactRow);

    const compactPromptSection = document.createElement('div');
    compactPromptSection.className = 'agy-inline-pop-section';
    const compactPromptTitle = document.createElement('div');
    compactPromptTitle.className = 'agy-inline-pop-subtitle';
    compactPromptTitle.textContent = t().compactPromptTitle;

    const compactPromptInput = document.createElement('textarea');
    compactPromptInput.className = 'agy-inline-pop-textarea';
    compactPromptInput.rows = 2;
    compactPromptInput.maxLength = 1000;
    compactPromptInput.placeholder = t().compactPromptPlaceholder;

    const compactPromptActions = document.createElement('div');
    compactPromptActions.className = 'agy-inline-pop-actions-end';
    const compactPromptResetBtn = document.createElement('button');
    compactPromptResetBtn.type = 'button';
    compactPromptResetBtn.className = 'agy-inline-btn';
    compactPromptResetBtn.textContent = t().reset;
    const compactPromptSaveBtn = document.createElement('button');
    compactPromptSaveBtn.type = 'button';
    compactPromptSaveBtn.className = 'agy-inline-btn agy-inline-btn-primary';
    compactPromptSaveBtn.textContent = t().save;
    compactPromptActions.appendChild(compactPromptResetBtn);
    compactPromptActions.appendChild(compactPromptSaveBtn);

    compactPromptSection.appendChild(compactPromptTitle);
    compactPromptSection.appendChild(compactPromptInput);
    compactPromptSection.appendChild(compactPromptActions);

    const popFeedback = document.createElement('div');
    popFeedback.className = 'agy-inline-pop-feedback';

    // Attached Add-ons management bridge (enable/disable/remove agent & plugin add-ons)
    const addonSection = document.createElement('div');
    addonSection.className = 'agy-inline-pop-section';

    const addonTitle = document.createElement('div');
    addonTitle.className = 'agy-inline-pop-subtitle';
    addonTitle.textContent = t().addonsTitle;

    const addonListEl = document.createElement('div');
    addonListEl.className = 'agy-inline-pop-list';

    addonSection.appendChild(addonTitle);
    addonSection.appendChild(addonListEl);

    // Language selector inside settings popover
    const langSection = document.createElement('div');
    langSection.className = 'agy-inline-pop-section';
    const langRow = document.createElement('div');
    langRow.className = 'agy-inline-pop-row';
    const langRowLabel = document.createElement('label');
    langRowLabel.className = 'agy-inline-pop-subtitle';
    langRowLabel.textContent = t().langLabel;

    const langSelect = document.createElement('select');
    langSelect.className = 'agy-inline-pop-select';
    langSelect.setAttribute('aria-label', t().langLabel);
    const optKo = document.createElement('option');
    optKo.value = 'ko';
    optKo.textContent = '한국어';
    const optEn = document.createElement('option');
    optEn.value = 'en';
    optEn.textContent = 'English';
    langSelect.appendChild(optKo);
    langSelect.appendChild(optEn);
    langSelect.value = locale;

    langRow.appendChild(langRowLabel);
    langRow.appendChild(langSelect);
    langSection.appendChild(langRow);

    popEl.appendChild(popHead);
    popEl.appendChild(popMeta);
    popEl.appendChild(breakdownSection);
    popEl.appendChild(limitSection);
    popEl.appendChild(compactPromptSection);
    popEl.appendChild(addonSection);
    popEl.appendChild(langSection);
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
      lastSessionId: '',
      snapshot: null,
      epoch: 0,
      abortCtrl: null,
      inFlight: false,
      pendingRefresh: false,
      compacting: false,
      limitDirty: false,
      promptDirty: false,
      lastPresetsKey: '',
      lastAddonsKey: '',
      syncedLimitKey: '',
      syncedPromptVal: null,
    };

    function formatTemplate(tpl, vars) {
      return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) =>
        Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : '',
      );
    }

    function rebuildPresets(hostMaxTokens = 0) {
      const safeHostMax =
        typeof hostMaxTokens === 'number' && Number.isFinite(hostMaxTokens) && hostMaxTokens > 0
          ? Math.floor(hostMaxTokens)
          : 0;
      const nextKey = `${locale}:${safeHostMax}`;
      if (state.lastPresetsKey === nextKey) return;
      state.lastPresetsKey = nextKey;

      const prev = presetSelect.value;
      clearChildren(presetSelect);
      const tr = t();
      const hostOpt = document.createElement('option');
      hostOpt.value = '';
      hostOpt.textContent = tr.hostDefault;
      presetSelect.appendChild(hostOpt);
      for (const p of PRESETS) {
        const o = document.createElement('option');
        o.value = String(p);
        const kLabel = `${Math.round(p / 1000)}K`;
        if (safeHostMax > 0 && p > safeHostMax) {
          o.textContent = `${kLabel} (${formatTemplate(tr.overModelMax, { max: formatTokens(safeHostMax) })})`;
        } else {
          o.textContent = kLabel;
        }
        presetSelect.appendChild(o);
      }
      presetSelect.value = prev;
    }

    function getSavedLimitForScope(scope) {
      if (scope === 'default') {
        return typeof defaultCustomLimit === 'number' ? defaultCustomLimit : null;
      }
      const sid = getSessionId();
      if (sid && sessionLimits.has(sid)) {
        return sessionLimits.get(sid);
      }
      const snap = state.snapshot;
      if (snap && snap.limitSource === 'session' && typeof snap.customLimit === 'number') {
        return snap.customLimit;
      }
      return null;
    }

    function syncLimitControls(force = false) {
      const scope = scopeSelect.value === 'default' ? 'default' : 'session';
      const sid = getSessionId();
      const savedVal = getSavedLimitForScope(scope);
      const nextKey = `${sid}:${scope}:${savedVal === null ? 'null' : savedVal}`;

      if (!force) {
        if (state.limitDirty) return;
        if (state.syncedLimitKey === nextKey) return;
        if (document.activeElement === customInput || document.activeElement === presetSelect) return;
      }

      state.syncedLimitKey = nextKey;
      state.limitDirty = false;
      const strVal = savedVal !== null ? String(savedVal) : '';
      customInput.value = strVal;
      presetSelect.value = savedVal !== null && PRESETS.includes(savedVal) ? strVal : '';
    }

    function syncCompactPrompt(force = false) {
      if (!force) {
        if (state.promptDirty) return;
        if (state.syncedPromptVal === compactPrompt) return;
        if (document.activeElement === compactPromptInput) return;
      }
      state.syncedPromptVal = compactPrompt;
      state.promptDirty = false;
      compactPromptInput.value = compactPrompt;
    }

    function setPopoverOpen(open) {
      const nextOpen = Boolean(open);
      const wasOpen = state.popOpen;
      state.popOpen = nextOpen;
      popEl.classList.toggle('hidden', !state.popOpen);
      ctxBtn.setAttribute('aria-expanded', String(state.popOpen));
      settingsBtn.setAttribute('aria-expanded', String(state.popOpen));
      if (nextOpen && !wasOpen) {
        setText(popFeedback, '');
        syncLimitControls(true);
        syncCompactPrompt(true);
      }
    }

    function getSessionId() {
      const attr = viewEl.getAttribute('data-cascade-id') || '';
      if (attr && attr !== 'remote-session') return attr;
      return fallbackSessionId;
    }

    function renderAddons() {
      const tr = t();
      const persistedSorted = [...customButtons].sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
      );
      const runtimeSorted = Array.from(runtimeButtons.values()).sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
      );
      const nextAddonsKey = JSON.stringify({
        locale,
        p: persistedSorted.map((b) => [b.id, b.label, b.command, b.description, b.enabled !== false, b.source]),
        r: runtimeSorted.map((r) => [r.id, r.label, r.title, r.description, !disabledRuntimeAddonIds.has(r.id), r.source]),
      });
      if (state.lastAddonsKey === nextAddonsKey) return;
      state.lastAddonsKey = nextAddonsKey;

      clearChildren(customBtnsContainer);

      for (const btnDef of persistedSorted) {
        if (btnDef.enabled === false) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'agy-inline-btn';
        b.textContent = btnDef.label;
        b.title = btnDef.description || btnDef.command;
        b.addEventListener('click', () => handleCustomCommand(btnDef, b));
        customBtnsContainer.appendChild(b);
      }

      for (const rtDef of runtimeSorted) {
        if (disabledRuntimeAddonIds.has(rtDef.id)) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'agy-inline-btn';
        b.textContent = rtDef.label;
        if (rtDef.title || rtDef.description) b.title = rtDef.title || rtDef.description;
        b.addEventListener('click', () => {
          try {
            rtDef.onClick({ sessionId: getSessionId(), barEl, buttonEl: b });
          } catch {}
        });
        customBtnsContainer.appendChild(b);
      }

      // Settings bridge list: manage both persisted agent add-ons and runtime plugin add-ons
      clearChildren(addonListEl);
      const combined = [
        ...persistedSorted.map((b) => ({
          id: b.id,
          label: b.label,
          source: b.source || 'agent',
          detail: b.description || b.command,
          enabled: b.enabled !== false,
          runtime: false,
        })),
        ...runtimeSorted.map((r) => ({
          id: r.id,
          label: r.label,
          source: r.source || 'plugin',
          detail: r.description || r.title || r.id,
          enabled: !disabledRuntimeAddonIds.has(r.id),
          runtime: true,
        })),
      ];

      if (combined.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'agy-inline-pop-hint';
        emptyEl.textContent = tr.addonEmpty;
        addonListEl.appendChild(emptyEl);
      } else {
        for (const item of combined) {
          const row = document.createElement('div');
          row.className = 'agy-inline-pop-btn-item';

          const meta = document.createElement('span');
          meta.className = 'agy-inline-pop-btn-meta';
          const nameSpan = document.createElement('span');
          nameSpan.textContent = item.label;
          const pillSpan = document.createElement('span');
          pillSpan.className = 'agy-inline-source-pill';
          pillSpan.textContent = item.source;
          meta.appendChild(nameSpan);
          meta.appendChild(pillSpan);
          meta.title = item.detail;

          const actions = document.createElement('div');
          actions.className = 'agy-inline-pop-controls';

          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = item.enabled
            ? 'agy-inline-btn agy-inline-btn-on'
            : 'agy-inline-btn';
          toggleBtn.textContent = item.enabled ? tr.addonOn : tr.addonOff;
          toggleBtn.addEventListener('click', () =>
            handleToggleAddon(item.id, !item.enabled, item.runtime),
          );

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'agy-inline-btn';
          delBtn.textContent = tr.delBtn;
          delBtn.addEventListener('click', () => handleRemoveAddon(item.id, item.runtime));

          actions.appendChild(toggleBtn);
          actions.appendChild(delBtn);
          row.appendChild(meta);
          row.appendChild(actions);
          addonListEl.appendChild(row);
        }
      }
    }

    function localizeBreakdownLabel(rawLabel) {
      if (locale === 'ko' && Object.prototype.hasOwnProperty.call(KO_BREAKDOWN_LABELS, rawLabel)) {
        return KO_BREAKDOWN_LABELS[rawLabel];
      }
      return rawLabel;
    }

    function render() {
      const tr = t();
      setText(popTitle, tr.settingsTitle);
      setText(breakdownTitle, tr.breakdownTitle);
      setText(limitTitle, tr.limitTitle);
      setText(limitHint, tr.limitHint);
      setText(autoCompactLbl, tr.autoCompactLabel);
      autoCompactBtn.className = autoCompactEnabled
        ? 'agy-inline-btn agy-inline-btn-on'
        : 'agy-inline-btn';
      setText(autoCompactBtn, autoCompactEnabled ? tr.addonOn : tr.addonOff);
      customInput.placeholder = tr.limitPlaceholder;
      setText(optSession, tr.scopeSession);
      setText(optDefault, tr.scopeDefault);
      setText(applyBtn, tr.apply);
      setText(compactPromptTitle, tr.compactPromptTitle);
      compactPromptInput.placeholder = tr.compactPromptPlaceholder;
      setText(compactPromptResetBtn, tr.reset);
      setText(compactPromptSaveBtn, tr.save);
      const snap = state.snapshot;
      if (snap && typeof snap.compactPrompt === 'string' && !state.promptDirty) {
        compactPrompt = snap.compactPrompt;
      }
      syncCompactPrompt(false);
      const isBackendCompacting = Boolean(snap?.compaction?.inProgress);
      const isCompactingNow = state.compacting || isBackendCompacting;
      compactBtn.disabled = isCompactingNow || !getSessionId();
      setText(compactBtn, isCompactingNow ? tr.compacting : tr.compact);
      compactBtn.title = compactPrompt ? `/compact ${compactPrompt}` : '/compact';
      setText(addonTitle, tr.addonsTitle);
      setText(langRowLabel, tr.langLabel);
      langSelect.setAttribute('aria-label', tr.langLabel);
      if (langSelect.value !== locale) langSelect.value = locale;
      rebuildPresets(snap?.maxContextTokens || 0);
      renderAddons();

      if (!snap) {
        setText(ctxTextEl, lastConnected ? `${tr.ctx} --` : tr.connecting);
        fillEl.style.width = '0%';
        fillEl.className = 'agy-inline-bar-fill';
        softBadgeEl.style.display = 'none';
        setText(cacheEl, `${tr.cache} --`);
        setText(limitStatusEl, '');
      } else {
        const rawPct = typeof snap.usagePercent === 'number' && Number.isFinite(snap.usagePercent) ? Math.max(0, snap.usagePercent) : 0;
        const barPct = Math.min(100, rawPct);
        const usedStr = formatTokens(snap.usedTokens);
        const limitStr = formatTokens(snap.effectiveLimit);
        setText(ctxTextEl, `${tr.ctx} ${rawPct.toFixed(0)}% (${usedStr} / ${limitStr})`);
        const isSoftExceeded = Boolean(snap.exceededSoftLimit || snap.softLimitExceeded);
        fillEl.style.width = `${barPct}%`;
        fillEl.className =
          'agy-inline-bar-fill' +
          (isSoftExceeded || rawPct >= 90 ? ' danger' : rawPct >= 75 ? ' warn' : '');

        if (snap.autoCompactTriggered || snap.compaction?.trigger === 'auto') {
          softBadgeEl.style.display = '';
          setText(softBadgeEl, tr.autoCompacting);
        } else if (isBackendCompacting) {
          softBadgeEl.style.display = '';
          setText(softBadgeEl, tr.compactingBadge);
        } else if (isSoftExceeded) {
          softBadgeEl.style.display = '';
          setText(softBadgeEl, tr.softLimit);
        } else {
          softBadgeEl.style.display = 'none';
        }

        const sourceName =
          snap.limitSource === 'session'
            ? tr.sourceSession
            : snap.limitSource === 'default'
              ? tr.sourceDefault
              : tr.sourceHost;
        const hostMaxStr = formatTokens(snap.maxContextTokens);
        if (snap.isClampedByHost && typeof snap.customLimit === 'number') {
          setText(
            limitStatusEl,
            formatTemplate(tr.limitStatusClamped, {
              custom: formatTokens(snap.customLimit),
              max: hostMaxStr,
            }),
          );
        } else {
          setText(
            limitStatusEl,
            formatTemplate(tr.limitStatusNormal, {
              eff: limitStr,
              source: sourceName,
              max: hostMaxStr,
            }),
          );
        }

        const rawCachePct =
          typeof snap.cacheHitPercent === 'number'
            ? snap.cacheHitPercent
            : snap.cache && typeof snap.cache.hitRatePercent === 'number'
              ? snap.cache.hitRatePercent
              : null;
        const cachePct = rawCachePct !== null ? `${rawCachePct.toFixed(0)}%` : '--';
        setText(cacheEl, `${tr.cache} ${cachePct}`);

        setText(popModel, snap.modelName || '--');
        const stepStr =
          typeof snap.stepCount === 'number' ? snap.stepCount.toLocaleString() : '--';
        setText(popSteps, `${tr.steps} ${stepStr}`);

        clearChildren(breakdownList);
        const bdList = Array.isArray(snap.tokenBreakdown)
          ? [...snap.tokenBreakdown].sort((a, b) => (b?.tokens || 0) - (a?.tokens || 0))
          : [];
        const bdTotal = bdList.reduce((sum, it) => sum + (typeof it?.tokens === 'number' ? it.tokens : 0), 0);
        breakdownSection.style.display = bdList.length > 0 ? '' : 'none';
        for (const item of bdList) {
          if (!item || typeof item.tokens !== 'number' || item.tokens <= 0) continue;
          const sharePct = bdTotal > 0 ? Math.min(100, (item.tokens / bdTotal) * 100) : 0;
          const li = document.createElement('li');
          li.className = 'agy-inline-bd-item';

          const head = document.createElement('div');
          head.className = 'agy-inline-bd-head';
          const lbl = document.createElement('span');
          lbl.className = 'agy-inline-bd-label';
          lbl.textContent = localizeBreakdownLabel(item.label || item.key || 'Other');
          const val = document.createElement('span');
          val.className = 'agy-inline-bd-val';
          val.textContent = `${formatTokens(item.tokens)} (${Math.round(sharePct)}%)`;
          head.appendChild(lbl);
          head.appendChild(val);

          const track = document.createElement('div');
          track.className = 'agy-inline-bd-track';
          const bar = document.createElement('div');
          bar.className = 'agy-inline-bd-fill';
          bar.style.width = `${Math.max(2, sharePct).toFixed(1)}%`;
          track.appendChild(bar);

          li.appendChild(head);
          li.appendChild(track);
          breakdownList.appendChild(li);
        }

        syncLimitControls(false);
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
      const sessionChanged = Boolean(state.lastSessionId && state.lastSessionId !== sid);
      if (sessionChanged) {
        state.snapshot = null;
        state.limitDirty = false;
        state.syncedLimitKey = '';
        render();
        if (state.abortCtrl) state.abortCtrl.abort();
      } else if (state.inFlight) {
        // Coalesce concurrent refreshes for the same session instead of aborting in-flight responses
        state.pendingRefresh = true;
        return;
      }
      state.lastSessionId = sid;
      state.inFlight = true;
      state.pendingRefresh = false;
      const reqEpoch = ++state.epoch;
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
      } finally {
        if (reqEpoch === state.epoch) {
          state.inFlight = false;
          if (state.pendingRefresh && !disposed) {
            state.pendingRefresh = false;
            refreshSnapshot();
          }
        }
      }
    }

    async function handleCompact() {
      const sid = getSessionId();
      if (!sid || state.compacting || state.snapshot?.compaction?.inProgress) return;
      state.compacting = true;
      compactBtn.disabled = true;
      render();
      try {
        await apiPost('/api/compact', { sessionId: sid });
        setText(noteEl, t().compactSent);
        burstUntil = Date.now() + MAX_BURST_MS;
        scheduleSnapshotPoll();
        refreshSnapshot();
      } catch (err) {
        setText(
          noteEl,
          err?.code === 'COMPACTION_IN_PROGRESS' ? t().compactInProgress : t().compactFail,
        );
      } finally {
        state.compacting = false;
        render();
        setTimeout(() => {
          if (!disposed) setText(noteEl, '');
        }, 4000);
      }
    }

    async function handleCustomCommand(btnDef, btnEl) {
      const sid = getSessionId();
      if (!sid || !btnDef?.command) return;
      if (btnEl) btnEl.disabled = true;
      try {
        await apiPost('/api/command', { sessionId: sid, command: btnDef.command });
        setText(noteEl, `${btnDef.label}: ${t().cmdSent}`);
        burstUntil = Date.now() + MAX_BURST_MS;
        scheduleSnapshotPoll();
      } catch {
        setText(noteEl, `${btnDef.label}: ${t().cmdFail}`);
      } finally {
        if (btnEl) btnEl.disabled = false;
        setTimeout(() => {
          if (!disposed) setText(noteEl, '');
        }, 4000);
      }
    }

    async function handleToggleAddon(id, enabled, isRuntime) {
      try {
        const updated = await apiPost('/api/addons/toggle', { id, enabled, runtime: isRuntime });
        if (Array.isArray(updated?.customButtons)) customButtons = updated.customButtons;
        if (Array.isArray(updated?.disabledRuntimeAddonIds)) {
          disabledRuntimeAddonIds = new Set(updated.disabledRuntimeAddonIds);
        }
        popFeedback.className = 'agy-inline-pop-feedback';
        setText(popFeedback, t().applied);
        for (const ctrl of barControllers.values()) ctrl.render();
      } catch (err) {
        popFeedback.className = 'agy-inline-pop-feedback err';
        setText(popFeedback, err?.message || 'Error');
      }
    }

    async function handleRemoveAddon(id, isRuntime) {
      if (isRuntime) {
        runtimeButtons.delete(id);
        for (const ctrl of barControllers.values()) ctrl.render();
        return;
      }
      try {
        const updated = await apiPost('/api/addons/remove', { id });
        if (Array.isArray(updated?.customButtons)) customButtons = updated.customButtons;
        popFeedback.className = 'agy-inline-pop-feedback';
        setText(popFeedback, t().applied);
        for (const ctrl of barControllers.values()) ctrl.render();
      } catch (err) {
        popFeedback.className = 'agy-inline-pop-feedback err';
        setText(popFeedback, err?.message || 'Error');
      }
    }

    async function handleApplyLimit() {
      const tr = t();
      const raw = customInput.value.replace(/[\s,]/g, '').trim();
      let limitVal = null;
      if (raw !== '') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 32000 || parsed > 980000) {
          popFeedback.className = 'agy-inline-pop-feedback err';
          setText(popFeedback, tr.invalidLimit);
          return;
        }
        limitVal = Math.round(parsed);
      }
      const scope = scopeSelect.value === 'default' ? 'default' : 'session';
      const sid = getSessionId();
      if (scope === 'session' && !sid) {
        popFeedback.className = 'agy-inline-pop-feedback err';
        setText(popFeedback, tr.noActiveSession);
        return;
      }
      const payload =
        scope === 'default'
          ? { defaultCustomLimit: limitVal }
          : { sessionLimit: { sessionId: sid, limit: limitVal } };
      try {
        const updated = await apiPost('/api/settings/update', payload);
        applySettingsPayload(updated);
        state.limitDirty = false;
        state.syncedLimitKey = '';
        await refreshSnapshot();
        syncLimitControls(true);
        const hostMax = state.snapshot?.maxContextTokens || 0;
        popFeedback.className = 'agy-inline-pop-feedback';
        if (limitVal !== null && hostMax > 0 && limitVal > hostMax) {
          setText(
            popFeedback,
            formatTemplate(tr.appliedClamped, {
              val: formatTokens(limitVal),
              max: formatTokens(hostMax),
            }),
          );
        } else {
          setText(popFeedback, tr.applied);
        }
      } catch (err) {
        popFeedback.className = 'agy-inline-pop-feedback err';
        setText(popFeedback, err?.message || 'Error');
      }
    }

    async function handleToggleAutoCompact() {
      const next = !autoCompactEnabled;
      autoCompactEnabled = next;
      for (const ctrl of barControllers.values()) ctrl.render();
      try {
        await apiPost('/api/settings/update', { autoCompact: next });
        popFeedback.className = 'agy-inline-pop-feedback';
        setText(popFeedback, t().applied);
      } catch (err) {
        popFeedback.className = 'agy-inline-pop-feedback err';
        setText(popFeedback, err?.message || 'Error');
      }
    }

    async function saveCompactPromptValue(rawValue) {
      const nextPrompt = String(rawValue || '').trim();
      try {
        const updated = await apiPost('/api/settings/update', { compactPrompt: nextPrompt });
        applySettingsPayload(updated);
        compactPrompt = typeof updated?.compactPrompt === 'string' ? updated.compactPrompt : nextPrompt;
        state.promptDirty = false;
        state.syncedPromptVal = compactPrompt;
        compactPromptInput.value = compactPrompt;
        for (const ctrl of barControllers.values()) ctrl.render();
        popFeedback.className = 'agy-inline-pop-feedback';
        setText(popFeedback, t().applied);
      } catch (err) {
        popFeedback.className = 'agy-inline-pop-feedback err';
        setText(popFeedback, err?.message || 'Error');
      }
    }

    function handleSaveCompactPrompt() {
      return saveCompactPromptValue(compactPromptInput.value);
    }

    function handleResetCompactPrompt() {
      compactPromptInput.value = '';
      return saveCompactPromptValue('');
    }

    async function applyLocale(next) {
      if (next !== 'ko' && next !== 'en') return;
      locale = next;
      for (const ctrl of barControllers.values()) ctrl.render();
      try {
        await apiPost('/api/settings/update', { locale: next });
      } catch {}
    }

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && state.popOpen) {
        setPopoverOpen(false);
        try {
          settingsBtn.focus();
        } catch {}
      }
    };
    const onDocPointerDown = (e) => {
      if (!state.popOpen) return;
      const target = e.target;
      if (popEl.contains(target) || settingsBtn.contains(target) || ctxBtn.contains(target)) {
        return;
      }
      setPopoverOpen(false);
    };
    const onInputKeyDown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleApplyLimit();
      }
    };
    const onPresetChange = () => {
      state.limitDirty = true;
      customInput.value = presetSelect.value;
      setText(popFeedback, '');
    };
    const onCustomInput = () => {
      state.limitDirty = true;
      const raw = customInput.value.replace(/[\s,]/g, '').trim();
      const parsed = raw ? Number(raw) : NaN;
      presetSelect.value = PRESETS.includes(parsed) ? String(parsed) : '';
      setText(popFeedback, '');
    };
    const onScopeChange = () => {
      state.limitDirty = false;
      state.syncedLimitKey = '';
      setText(popFeedback, '');
      syncLimitControls(true);
    };
    const onPromptInput = () => {
      state.promptDirty = true;
      setText(popFeedback, '');
    };
    const onPromptKeyDown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSaveCompactPrompt();
      }
    };
    const onLangChange = () => {
      applyLocale(langSelect.value);
    };

    ctxBtn.addEventListener('click', () => setPopoverOpen(!state.popOpen));
    settingsBtn.addEventListener('click', () => setPopoverOpen(!state.popOpen));
    closeBtn.addEventListener('click', () => {
      setPopoverOpen(false);
      try {
        settingsBtn.focus();
      } catch {}
    });
    compactBtn.addEventListener('click', handleCompact);
    applyBtn.addEventListener('click', handleApplyLimit);
    autoCompactBtn.addEventListener('click', handleToggleAutoCompact);
    compactPromptSaveBtn.addEventListener('click', handleSaveCompactPrompt);
    compactPromptResetBtn.addEventListener('click', handleResetCompactPrompt);
    compactPromptInput.addEventListener('input', onPromptInput);
    compactPromptInput.addEventListener('keydown', onPromptKeyDown);
    langSelect.addEventListener('change', onLangChange);
    scopeSelect.addEventListener('change', onScopeChange);
    presetSelect.addEventListener('change', onPresetChange);
    customInput.addEventListener('input', onCustomInput);
    customInput.addEventListener('keydown', onInputKeyDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onDocPointerDown);

    rebuildPresets();
    render();

    return {
      render,
      refreshSnapshot,
      destroy() {
        if (state.abortCtrl) state.abortCtrl.abort();
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('pointerdown', onDocPointerDown);
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

  let domActivityTimer = null;
  function triggerImmediateActivityRefresh() {
    if (disposed) return;
    burstUntil = Math.max(burstUntil, Date.now() + 8000);
    if (domActivityTimer) return;
    domActivityTimer = setTimeout(() => {
      domActivityTimer = null;
      if (disposed) return;
      scanAndMount();
      for (const ctrl of barControllers.values()) {
        ctrl.refreshSnapshot();
      }
    }, 150);
  }

  async function pollSessionsAndSnapshots() {
    if (disposed) return;
    scanAndMount();
    const snapshotPromises = [];
    for (const ctrl of barControllers.values()) {
      snapshotPromises.push(ctrl.refreshSnapshot());
    }
    const sessionsPromise = apiPost('/api/sessions', {})
      .then((sessRes) => {
        if (Array.isArray(sessRes?.sessions) && sessRes.sessions.length > 0) {
          const topSid = sessRes.sessions[0].sessionId || '';
          if (topSid && topSid !== fallbackSessionId) {
            fallbackSessionId = topSid;
            for (const ctrl of barControllers.values()) ctrl.refreshSnapshot();
          }
        }
      })
      .catch(() => {});
    await Promise.all([...snapshotPromises, sessionsPromise]);
  }

  function applySettingsPayload(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (settings.locale === 'ko' || settings.locale === 'en') {
      locale = settings.locale;
    }
    if (typeof settings.autoCompact === 'boolean') {
      autoCompactEnabled = settings.autoCompact;
    }
    if (typeof settings.compactPrompt === 'string') {
      compactPrompt = settings.compactPrompt;
    }
    if (settings.defaultCustomLimit === null || typeof settings.defaultCustomLimit === 'number') {
      defaultCustomLimit = settings.defaultCustomLimit;
    }
    if (Array.isArray(settings.sessions)) {
      sessionLimits.clear();
      for (const entry of settings.sessions) {
        if (entry && typeof entry.sessionId === 'string' && typeof entry.limit === 'number') {
          sessionLimits.set(entry.sessionId, entry.limit);
        }
      }
    }
    if (Array.isArray(settings.customButtons)) {
      customButtons = settings.customButtons;
    }
    if (Array.isArray(settings.disabledRuntimeAddonIds)) {
      disabledRuntimeAddonIds = new Set(settings.disabledRuntimeAddonIds);
    }
  }

  async function pollQuotaAndSettings() {
    if (disposed) return;
    try {
      const settings = await apiPost('/api/settings/get', {});
      applySettingsPayload(settings);
      for (const ctrl of barControllers.values()) ctrl.render();
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
      let sawCascadeAttr = false;
      let sawExternalChange = false;
      for (const m of mutations) {
        if (isOwnNode(m.target)) continue;
        sawExternalChange = true;
        if (m.type === 'attributes' && m.attributeName === 'data-cascade-id') {
          sawCascadeAttr = true;
        }
      }
      if (sawCascadeAttr) {
        scanAndMount();
        for (const ctrl of barControllers.values()) ctrl.refreshSnapshot();
      } else if (sawExternalChange) {
        scanAndMount();
        triggerImmediateActivityRefresh();
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

  const addonsBridge = Object.freeze({
    version: '1.0.0',
    register(def) {
      if (!def || typeof def !== 'object') return false;
      const id = typeof def.id === 'string' ? def.id.trim() : '';
      const label = typeof def.label === 'string' ? def.label.trim() : '';
      if (!id || !/^[A-Za-z0-9_-]{1,48}$/.test(id) || !label || typeof def.onClick !== 'function') {
        return false;
      }
      runtimeButtons.set(id, {
        id,
        label: label.slice(0, 24),
        title: typeof def.title === 'string' ? def.title : '',
        description: typeof def.description === 'string' ? def.description.slice(0, 120) : '',
        order: typeof def.order === 'number' && Number.isFinite(def.order) ? def.order : 100,
        source: typeof def.source === 'string' && def.source.trim() ? def.source.trim() : 'plugin',
        onClick: def.onClick,
      });
      for (const ctrl of barControllers.values()) ctrl.render();
      return true;
    },
    unregister(id) {
      if (!runtimeButtons.delete(String(id || ''))) return false;
      for (const ctrl of barControllers.values()) ctrl.render();
      return true;
    },
    list() {
      return [
        ...customButtons.map((b) => ({
          id: b.id,
          label: b.label,
          source: b.source || 'agent',
          enabled: b.enabled !== false,
          runtime: false,
        })),
        ...Array.from(runtimeButtons.values()).map((r) => ({
          id: r.id,
          label: r.label,
          source: r.source || 'plugin',
          enabled: !disabledRuntimeAddonIds.has(r.id),
          runtime: true,
        })),
      ];
    },
    async setEnabled(id, enabled) {
      const targetId = String(id || '').trim();
      if (!targetId) return false;
      const isRuntime = runtimeButtons.has(targetId);
      try {
        const updated = await apiPost('/api/addons/toggle', {
          id: targetId,
          enabled: Boolean(enabled),
          runtime: isRuntime,
        });
        if (Array.isArray(updated?.customButtons)) customButtons = updated.customButtons;
        if (Array.isArray(updated?.disabledRuntimeAddonIds)) {
          disabledRuntimeAddonIds = new Set(updated.disabledRuntimeAddonIds);
        }
        for (const ctrl of barControllers.values()) ctrl.render();
        return true;
      } catch {
        return false;
      }
    },
  });

  const api = {
    addons: addonsBridge,
    addButton: addonsBridge.register,
    removeButton: addonsBridge.unregister,
    destroy() {
      if (disposed) return;
      disposed = true;
      if (snapshotPollTimer) clearTimeout(snapshotPollTimer);
      if (domActivityTimer) clearTimeout(domActivityTimer);
      if (quotaPollTimer) clearInterval(quotaPollTimer);
      if (observer) observer.disconnect();
      for (const c of activeControllers) c.abort();
      activeControllers.clear();
      runtimeButtons.clear();
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
        if (window.statusbarAddons === addonsBridge) {
          delete window.statusbarAddons;
        }
      } catch {}
    },
  };

  window.__agyStatusbarInline = api;
  window.statusbarAddons = addonsBridge;
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
