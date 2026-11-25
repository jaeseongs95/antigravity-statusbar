import assert from 'node:assert/strict';
import test from 'node:test';

import { createAddonRegistry } from '../../src/adapters/antigravity/addon/addon-bridge.mjs';
import { createSidecarApiClient } from '../../src/adapters/antigravity/addon/api-client.mjs';
import { createBarController } from '../../src/adapters/antigravity/addon/bar-controller.mjs';
import { createBarView } from '../../src/adapters/antigravity/addon/bar-view.mjs';
import { startAddonStatusbar, startStandbyStatusbar } from '../../src/adapters/antigravity/addon/bootstrap.mjs';
import { createInlineI18n } from '../../src/adapters/antigravity/addon/i18n.mjs';
import { createPopoverView } from '../../src/adapters/antigravity/addon/popover-view.mjs';
import { STATUSBAR_STYLE_ID, STATUSBAR_STYLES } from '../../src/adapters/antigravity/addon/styles.mjs';

const TEST_TOKEN = 'unit-ui-modules-token-32-chars-ok';

function createUnitMockDom() {
  class ClassList {
    constructor() {
      this._s = new Set();
    }
    _set(str) {
      this._s = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _str() {
      return Array.from(this._s).join(' ');
    }
    contains(n) {
      return this._s.has(n);
    }
    toggle(n, force) {
      if (force === undefined) {
        if (this._s.has(n)) {
          this._s.delete(n);
          return false;
        }
        this._s.add(n);
        return true;
      }
      if (force) {
        this._s.add(n);
        return true;
      }
      this._s.delete(n);
      return false;
    }
  }

  class El {
    constructor(tag, doc) {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.ownerDocument = doc;
      this.parentNode = null;
      this.childNodes = [];
      this.attributes = new Map();
      this.style = {};
      this.classList = new ClassList();
      this._text = '';
      this.value = '';
      this.disabled = false;
      this.title = '';
      this.type = '';
      this.placeholder = '';
      this.listeners = new Map();
      this.offsetParent = {};
      this.visible = true;
    }
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get className() {
      return this.classList._str();
    }
    set className(v) {
      this.classList._set(v);
    }
    get textContent() {
      if (this.childNodes.length === 0) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.childNodes = [];
      this._text = String(v ?? '');
    }
    setAttribute(k, v) {
      this.attributes.set(String(k), String(v));
    }
    getAttribute(k) {
      return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) {
        this.childNodes.splice(i, 1);
        child.parentNode = null;
      }
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    contains(other) {
      let c = other;
      while (c) {
        if (c === this) return true;
        c = c.parentNode;
      }
      return false;
    }
    matches(sel) {
      const m = /^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/.exec(sel);
      if (m) return this.getAttribute(m[1]) === m[2];
      if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
      return this.tagName === sel.toUpperCase();
    }
    closest(sel) {
      let c = this;
      while (c && c.nodeType === 1) {
        if (c.matches(sel)) return c;
        c = c.parentNode;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const ch of n.childNodes) {
          if (ch.nodeType === 1) {
            if (ch.matches(sel)) out.push(ch);
            walk(ch);
          }
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    dispatchEvent(evt) {
      const set = this.listeners.get(evt.type);
      if (!set) return;
      for (const fn of Array.from(set)) fn(evt);
    }
    click() {
      this.dispatchEvent({ type: 'click', target: this, preventDefault() {} });
    }
    focus() {
      this.ownerDocument.activeElement = this;
    }
    getClientRects() {
      return this.visible ? [{ width: 320, height: 36 }] : [];
    }
  }

  const docListeners = new Map();
  const doc = {
    body: null,
    activeElement: null,
    createElement(tag) {
      return new El(tag, doc);
    },
    querySelectorAll(sel) {
      return doc.body ? doc.body.querySelectorAll(sel) : [];
    },
    contains(node) {
      return Boolean(doc.body && doc.body.contains(node));
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      const set = docListeners.get(evt.type);
      if (!set) return;
      for (const fn of Array.from(set)) fn(evt);
    },
    getListenerCount(type) {
      return docListeners.get(type)?.size || 0;
    },
  };
  doc.body = new El('body', doc);
  return { doc, El };
}

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

test('TC-UNIT-03: bar-view.mjs renders thresholds (warn/danger/unclamped>100%), badge precedence, quota min+stale, and addon buttons', () => {
  const { doc } = createUnitMockDom();
  const i18n = createInlineI18n('ko');
  const view = createBarView({ doc, i18n });

  // Disconnected state
  view.renderSnapshot({ snap: null, connected: false, compacting: false, hasSession: false, compactPrompt: '' });
  assert.ok(view.ctxBtn.textContent.includes('연결 중'));
  assert.equal(view.compactBtn.disabled, true);

  // Unconfigured states: Desktop standby vs Remote Web setup hint + remote dock mode
  view.renderSnapshot({
    snap: null,
    connected: false,
    configured: false,
    isRemoteWeb: false,
    compacting: false,
    hasSession: false,
    compactPrompt: '',
  });
  assert.equal(view.ctxBtn.textContent, i18n.t().standby);

  view.renderSnapshot({
    snap: null,
    connected: false,
    configured: false,
    isRemoteWeb: true,
    compacting: false,
    hasSession: false,
    compactPrompt: '',
  });
  assert.equal(view.ctxBtn.textContent, i18n.t().remoteSetupNeeded);
  view.setRemoteDockMode(true);
  assert.equal(view.barEl.classList.contains('agy-remote-dock'), true);
  view.setRemoteDockMode(false);
  assert.equal(view.barEl.classList.contains('agy-remote-dock'), false);

  // Reconnecting state
  view.setReconnecting();
  assert.ok(view.ctxBtn.textContent.includes('재연결'));

  // 75% warn threshold
  const fill = view.barEl.querySelector('.agy-inline-bar-fill');
  const badge = view.barEl.querySelector('.agy-inline-badge');
  view.renderSnapshot({
    snap: { usedTokens: 150000, effectiveLimit: 200000, usagePercent: 75, cacheHitPercent: 60 },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '핵심만',
  });
  assert.equal(fill.style.width, '75%');
  assert.equal(fill.classList.contains('warn'), true);
  assert.equal(fill.classList.contains('danger'), false);
  assert.equal(badge.style.display, 'none');
  assert.equal(view.compactBtn.title, '/compact 핵심만');

  // 117% unclamped text, 100% bar fill clamp, badge precedence: auto > manual > softLimit
  view.renderSnapshot({
    snap: {
      usedTokens: 234000,
      effectiveLimit: 200000,
      usagePercent: 117,
      exceededSoftLimit: true,
      autoCompactTriggered: true,
      compaction: { inProgress: true, trigger: 'auto' },
      cache: { hitRatePercent: 88.4 },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
  });
  assert.equal(fill.style.width, '100%');
  assert.equal(fill.classList.contains('danger'), true);
  assert.ok(view.ctxBtn.textContent.includes('117%'));
  assert.equal(badge.textContent, i18n.t().autoCompacting);
  assert.equal(view.compactBtn.disabled, true);

  // Manual compaction badge takes precedence over softLimit
  view.renderSnapshot({
    snap: {
      usedTokens: 210000,
      effectiveLimit: 200000,
      usagePercent: 105,
      exceededSoftLimit: true,
      compaction: { inProgress: true, trigger: 'manual' },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
  });
  assert.equal(badge.textContent, i18n.t().compactingBadge);

  // Soft limit badge alone
  view.renderSnapshot({
    snap: {
      usedTokens: 210000,
      effectiveLimit: 200000,
      usagePercent: 105,
      exceededSoftLimit: true,
      compaction: { inProgress: false, trigger: null },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
  });
  assert.equal(badge.textContent, i18n.t().softLimit);

  // Quota renders 5h limit on the left + weekly limit on the right + stale tag + model-aware group matching + multiline tooltip
  view.renderQuota({
    available: true,
    stale: true,
    groups: [
      { label: 'Pro', buckets: [{ window: '5h', remainingPercent: 72 }] },
      { label: 'Flash', buckets: [{ window: '24h', remainingPercent: 41.2 }] },
    ],
  });
  const metrics = view.barEl.querySelectorAll('.agy-inline-metric');
  const quota5hEl = metrics[metrics.length - 2];
  const quotaWeeklyEl = metrics[metrics.length - 1];
  assert.equal(quota5hEl.textContent, '5시간 한도 72%');
  assert.equal(quotaWeeklyEl.textContent, '24h 41% (오래됨)');
  assert.ok(quotaWeeklyEl.title.includes('Pro (5h): 72%'));
  assert.ok(quotaWeeklyEl.title.includes('Flash (24h): 41%'));

  // Model-aware quota group selection: Gemini vs Claude/GPT
  const multiGroupQuota = {
    available: true,
    stale: false,
    groups: [
      {
        label: 'Gemini Models',
        buckets: [
          { window: 'weekly', remainingPercent: 73.3 },
          { window: '5h', remainingPercent: 76.1 },
        ],
      },
      {
        label: 'Claude and GPT models',
        buckets: [
          { window: 'weekly', remainingPercent: 100 },
          { window: '5h', remainingPercent: 98.4 },
        ],
      },
    ],
  };
  view.renderQuota(multiGroupQuota, 'Gemini 4 Neon (High)');
  assert.equal(quota5hEl.textContent, '5시간 한도 76%');
  assert.equal(quotaWeeklyEl.textContent, '주간한도 73%');
  view.renderQuota(multiGroupQuota, 'Claude Opus 5.5');
  assert.equal(quota5hEl.textContent, '5시간 한도 98%');
  assert.equal(quotaWeeklyEl.textContent, '주간한도 100%');

  // Addon buttons skip disabled persisted items and invoke click callbacks
  const clicks = [];
  view.renderAddonButtons({
    persistedButtons: [
      { id: 'a', label: 'A', command: '/a', enabled: true },
      { id: 'b', label: 'B', command: '/b', enabled: false },
    ],
    runtimeButtons: [{ id: 'r', label: 'R', title: 'Run R' }],
    onPersistedClick(def) { clicks.push(['p', def.id]); },
    onRuntimeClick(def) { clicks.push(['r', def.id]); },
  });
  const customContainer = view.barEl.querySelector('.agy-inline-custom-btns');
  assert.equal(customContainer.childNodes.length, 2);
  customContainer.childNodes[0].click();
  customContainer.childNodes[1].click();
  assert.deepEqual(clicks, [['p', 'a'], ['r', 'r']]);

  // Note & expanded state
  view.setNote('Saved');
  assert.equal(view.barEl.querySelector('.agy-inline-status-note').textContent, 'Saved');
  view.setExpandedState({ open: true, activeTab: 'settings' });
  assert.equal(view.ctxBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(view.settingsBtn.getAttribute('aria-expanded'), 'true');
});

test('TC-UNIT-03b (v3.3.0): localized quota tooltip timestamps, 5h HH:mm local reset display, and subagent model pill', () => {
  const toExpectedHHMM = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const toExpectedLocalDT = (iso) => {
    const d = new Date(iso);
    return (
      `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    );
  };

  const koI18n = createInlineI18n('ko');
  const enI18n = createInlineI18n('en');

  // 1. i18n local time formatters convert UTC & explicit timezone offsets to local time cleanly
  const iso5h = '2026-11-23T14:05:00Z';
  const iso5hOffset = '2026-11-23T09:05:00-05:00';
  const isoWeekly = '2026-11-30T00:00:00Z';

  assert.equal(koI18n.formatLocalTimeHHMM(iso5h), toExpectedHHMM(iso5h));
  assert.equal(koI18n.formatLocalTimeHHMM(iso5hOffset), koI18n.formatLocalTimeHHMM(iso5h));
  assert.equal(koI18n.formatLocalDateTime(iso5h), toExpectedLocalDT(iso5h));
  assert.equal(koI18n.formatLocalDateTime(iso5hOffset), koI18n.formatLocalDateTime(iso5h));
  assert.equal(koI18n.formatLocalDateTime(iso5h).includes('T'), false);
  assert.equal(koI18n.formatLocalDateTime(iso5h).endsWith('Z'), false);
  assert.equal(koI18n.formatLocalTimeHHMM(''), '');
  assert.equal(koI18n.formatLocalTimeHHMM('not-a-date'), '');
  assert.equal(koI18n.formatLocalDateTime(''), '');
  assert.equal(koI18n.formatLocalDateTime('soon'), 'soon');

  // 2. Quota 5h shows localized HH:mm reset time next to percentage; tooltip renders local date-time (never raw UTC ISO)
  const { doc } = createUnitMockDom();
  const view = createBarView({ doc, i18n: koI18n });
  const quotaPayload = {
    available: true,
    stale: false,
    groups: [
      {
        label: 'Gemini Models',
        buckets: [
          { window: '5h', remainingPercent: 85, resetTime: iso5h },
          { window: '5h', remainingPercent: 92, resetTime: '2026-11-23T16:30:00Z' },
          { window: 'weekly', remainingPercent: 60, resetTime: isoWeekly },
        ],
      },
    ],
  };

  view.renderQuota(quotaPayload, 'Gemini 4 Neon (High)');
  assert.equal(view.quota5hEl.textContent, `5시간 한도 85% (${toExpectedHHMM(iso5h)})`);
  assert.equal(view.quotaEl.textContent, '주간한도 60%');
  assert.equal(view.quota5hEl.title.includes(iso5h), false, 'Tooltip must not display raw UTC ISO resetTime');
  assert.equal(view.quota5hEl.title.includes(isoWeekly), false, 'Tooltip must not display raw UTC ISO weekly resetTime');
  assert.ok(view.quota5hEl.title.includes(`초기화 ${toExpectedLocalDT(iso5h)}`));
  assert.ok(view.quotaEl.title.includes(`초기화 ${toExpectedLocalDT(isoWeekly)}`));

  // English locale check
  const { doc: enDoc } = createUnitMockDom();
  const enView = createBarView({ doc: enDoc, i18n: enI18n });
  enView.renderQuota(quotaPayload, 'Gemini 4 Neon (High)');
  assert.equal(enView.quota5hEl.textContent, `5h Limit 85% (${toExpectedHHMM(iso5h)})`);
  assert.ok(enView.quota5hEl.title.includes(`Reset ${toExpectedLocalDT(iso5h)}`));
  assert.equal(enView.quota5hEl.title.includes(iso5h), false);

  // Invalid or absent resetTime omits (HH:mm) cleanly
  view.renderQuota(
    {
      available: true,
      stale: false,
      groups: [{ label: 'Gemini Models', buckets: [{ window: '5h', remainingPercent: 77, resetTime: 'invalid' }] }],
    },
    'Gemini 4 Neon (High)',
  );
  assert.equal(view.quota5hEl.textContent, '5시간 한도 77%');

  // 3. Subagent model pill visible on subagent views when modelName is present, hidden on main or empty model
  assert.ok(view.modelEl, 'createBarView must expose modelEl');
  view.renderSnapshot({
    snap: {
      usedTokens: 48000,
      effectiveLimit: 200000,
      usagePercent: 24,
      modelName: 'Gemini 4 Neon (High)',
      isSubagent: true,
      compaction: { inProgress: false, status: 'idle' },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
    isSubagent: true,
  });
  assert.equal(view.modelEl.style.display, '');
  assert.equal(view.modelEl.textContent, 'Gemini 4 Neon (High)');
  assert.equal(view.modelEl.title, '모델: Gemini 4 Neon (High)');
  assert.equal(view.modelEl.getAttribute('aria-label'), '모델: Gemini 4 Neon (High)');

  // Main conversation hides subagent model pill
  view.renderSnapshot({
    snap: {
      usedTokens: 48000,
      effectiveLimit: 200000,
      usagePercent: 24,
      modelName: 'Gemini 4 Neon (High)',
      isSubagent: false,
      compaction: { inProgress: false, status: 'idle' },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
    isSubagent: false,
  });
  assert.equal(view.modelEl.style.display, 'none');
  assert.equal(view.modelEl.textContent, '');

  // Subagent without modelName yet hides pill cleanly
  view.renderSnapshot({
    snap: {
      usedTokens: 10000,
      effectiveLimit: 200000,
      usagePercent: 5,
      modelName: null,
      isSubagent: true,
      compaction: { inProgress: false, status: 'idle' },
    },
    connected: true,
    compacting: false,
    hasSession: true,
    compactPrompt: '',
    isSubagent: true,
  });
  assert.equal(view.modelEl.style.display, 'none');

  // Null snapshot hides pill cleanly
  view.renderSnapshot({
    snap: null,
    connected: true,
    compacting: false,
    hasSession: false,
    compactPrompt: '',
    isSubagent: true,
  });
  assert.equal(view.modelEl.style.display, 'none');
});

test('TC-UNIT-04: popover-view.mjs renders 2 tabs, over-max presets, clamped limit status, sorted breakdown, and addon callbacks', () => {
  const { doc } = createUnitMockDom();
  const i18n = createInlineI18n('ko');
  const pop = createPopoverView({ doc, i18n });

  pop.setActiveTab('settings');
  assert.equal(pop.tabContextBtn.getAttribute('aria-selected'), 'false');
  assert.equal(pop.tabSettingsBtn.getAttribute('aria-selected'), 'true');
  const panels = pop.popEl.querySelectorAll('.agy-inline-tabpanel');
  assert.equal(panels[0].classList.contains('hidden'), true);
  assert.equal(panels[1].classList.contains('hidden'), false);

  // Over-max preset annotation and clamped limit status
  pop.renderSnapshotDetails({
    maxContextTokens: 512000,
    effectiveLimit: 512000,
    customLimit: 980000,
    limitSource: 'session',
    isClampedByHost: true,
    modelName: 'Gemini Neon',
    stepCount: 120,
    tokenBreakdown: [
      { label: 'System', tokens: 20000 },
      { label: 'Zero', tokens: 0 },
      { label: 'Chat Messages', tokens: 80000 },
    ],
  });

  const opt980 = pop.presetSelect.childNodes.find((o) => o.value === '980000');
  assert.ok(opt980.textContent.includes('512.0K'));
  const bdItems = pop.popEl.querySelectorAll('.agy-inline-bd-item');
  assert.equal(bdItems.length, 2, 'Zero-token items must be omitted');
  assert.ok(bdItems[0].textContent.includes('대화 메시지'), 'Highest token group should sort first in Korean');
  assert.ok(bdItems[1].textContent.includes('시스템'));

  // Feedback classes & prompt counter
  pop.compactPromptInput.value = 'abcde';
  pop.updatePromptCount();
  assert.equal(pop.popEl.querySelector('.agy-inline-char-count').textContent, '5 / 1,000');
  pop.setFeedback('Invalid', true);
  assert.equal(pop.popEl.querySelector('.agy-inline-pop-feedback').classList.contains('err'), true);

  // Empty vs populated addon list
  pop.renderAddonList({ items: [], onToggle() {}, onRemove() {} });
  assert.ok(pop.popEl.textContent.includes(i18n.t().addonEmpty));

  const actions = [];
  pop.renderAddonList({
    items: [{ id: 'p1', label: 'Plan', source: 'agent', detail: '/plan', enabled: true, runtime: false }],
    onToggle(id, enabled, rt) { actions.push(['toggle', id, enabled, rt]); },
    onRemove(id, rt) { actions.push(['remove', id, rt]); },
  });
  const rowBtns = pop.popEl.querySelector('.agy-inline-pop-btn-item').querySelectorAll('button');
  rowBtns[0].click();
  rowBtns[1].click();
  assert.deepEqual(actions, [['toggle', 'p1', false, false], ['remove', 'p1', false]]);

  // Desktop popover hides Remote Sidecar Connection card; Remote Web popover shows & localizes it
  assert.equal(pop.remoteConnCard.classList.contains('hidden'), true);
  const remotePop = createPopoverView({ doc, i18n, isRemoteWeb: true });
  assert.equal(remotePop.remoteConnCard.classList.contains('hidden'), false);
  assert.equal(remotePop.remoteUrlInput.type, 'text');
  assert.equal(remotePop.remoteTokenInput.type, 'password');
  remotePop.setRemoteConnectionStatus('Connected', false);
  assert.equal(remotePop.remoteConnStatusEl.textContent, 'Connected');
  assert.equal(remotePop.remoteConnStatusEl.classList.contains('err'), false);
  remotePop.setRemoteConnectionStatus('Auth failed', true);
  assert.equal(remotePop.remoteConnStatusEl.classList.contains('err'), true);
});

test('TC-UNIT-05: bar-controller.mjs coalesces refreshes, protects dirty edits, validates limit bounds, handles IME/keyboard, and cleans up on destroy', async () => {
  const { doc, El } = createUnitMockDom();
  const i18n = createInlineI18n('ko');
  const barView = createBarView({ doc, i18n });
  const popoverView = createPopoverView({ doc, i18n });

  let snapshotDeferred = [];
  let compactError = null;
  const sentRequests = [];
  const api = {
    isConnected: () => true,
    abortAll() {},
    async post(pathname, body, signal) {
      sentRequests.push({ pathname, body });
      if (pathname === '/api/snapshot') {
        return new Promise((resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }
          snapshotDeferred.push({ body, resolve });
        });
      }
      if (pathname === '/api/compact' && compactError) {
        const e = new Error(compactError.message);
        e.code = compactError.code;
        throw e;
      }
      if (pathname === '/api/settings/update') {
        return {
          locale: body.locale || 'ko',
          autoCompact: body.autoCompact ?? true,
          compactPrompt: body.compactPrompt ?? '',
          defaultCustomLimit: body.defaultCustomLimit ?? null,
          sessions: body.sessionLimit?.limit
            ? [{ sessionId: body.sessionLimit.sessionId, limit: body.sessionLimit.limit }]
            : [],
          customButtons: [],
          disabledRuntimeAddonIds: [],
        };
      }
      return { ok: true };
    },
  };

  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: 'initial',
    defaultCustomLimit: 128000,
    sessionLimits: new Map([['sess-1', 256000]]),
    quotaState: null,
    fallbackSessionId: '',
  };

  const addons = createAddonRegistry({ api, onChange() {} });
  const ctrl = createBarController({
    doc,
    api,
    i18n,
    addons,
    barView,
    popoverView,
    sharedState,
    onSettingsChanged(updated) {
      if (typeof updated.compactPrompt === 'string') sharedState.compactPrompt = updated.compactPrompt;
      if (updated.defaultCustomLimit !== undefined) sharedState.defaultCustomLimit = updated.defaultCustomLimit;
    },
    onBurstRequested() {},
  });

  const view1 = new El('div', doc);
  view1.setAttribute('data-cascade-id', 'sess-1');
  ctrl.setTargetView(view1);

  // Coalesce concurrent refreshes for the SAME session (should queue 1 pending, not abort first)
  ctrl.refreshSnapshot();
  ctrl.refreshSnapshot();
  assert.equal(snapshotDeferred.length, 1);
  snapshotDeferred.shift().resolve({
    sessionId: 'sess-1',
    usedTokens: 50000,
    effectiveLimit: 256000,
    maxContextTokens: 512000,
    usagePercent: 19.5,
  });
  await flush();
  assert.equal(snapshotDeferred.length, 1, 'Pending coalesced refresh should fire once first completes');
  snapshotDeferred.shift().resolve({
    sessionId: 'sess-1',
    usedTokens: 60000,
    effectiveLimit: 256000,
    maxContextTokens: 512000,
    usagePercent: 23.4,
  });
  await flush();

  // Open popover and verify dirty guard prevents background re-render from clobbering input
  barView.ctxBtn.click();
  assert.equal(popoverView.customInput.value, '256000');
  popoverView.customInput.value = '180000';
  popoverView.customInput.dispatchEvent({ type: 'input', target: popoverView.customInput });
  ctrl.render();
  assert.equal(popoverView.customInput.value, '180000', 'limitDirty must preserve in-progress user input');

  // Limit boundary rejection (<32000 and >980000)
  popoverView.customInput.value = '31999';
  popoverView.applyBtn.click();
  await flush();
  assert.equal(sentRequests.filter((r) => r.pathname === '/api/settings/update').length, 0);

  popoverView.customInput.value = '980001';
  popoverView.applyBtn.click();
  await flush();
  assert.equal(sentRequests.filter((r) => r.pathname === '/api/settings/update').length, 0);

  // Scope switch to default loads defaultCustomLimit (128000) and blank input resets to null
  popoverView.scopeSelect.value = 'default';
  popoverView.scopeSelect.dispatchEvent({ type: 'change', target: popoverView.scopeSelect });
  assert.equal(popoverView.customInput.value, '128000');
  popoverView.customInput.value = '';
  popoverView.applyBtn.click();
  await flush();
  // Resolve refresh triggered by apply
  if (snapshotDeferred.length > 0) {
    snapshotDeferred.shift().resolve({
      sessionId: 'sess-1',
      usedTokens: 60000,
      effectiveLimit: 512000,
      maxContextTokens: 512000,
      usagePercent: 11.7,
    });
    await flush();
  }
  assert.ok(
    sentRequests.some((r) => r.pathname === '/api/settings/update' && r.body.defaultCustomLimit === null),
  );

  // IME isComposing must NOT trigger Ctrl+Enter save
  popoverView.compactPromptInput.value = '한글 조합중';
  popoverView.compactPromptInput.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
    preventDefault() {},
  });
  await flush();
  assert.equal(
    sentRequests.some((r) => r.pathname === '/api/settings/update' && r.body.compactPrompt === '한글 조합중'),
    false,
  );

  // Non-composing Ctrl+Enter saves compactPrompt
  popoverView.compactPromptInput.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    ctrlKey: true,
    isComposing: false,
    preventDefault() {},
  });
  await flush();
  assert.ok(
    sentRequests.some((r) => r.pathname === '/api/settings/update' && r.body.compactPrompt === '한글 조합중'),
  );

  // ArrowRight switches tab and moves focus; outside pointerdown closes popover
  popoverView.tabContextBtn.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
  assert.equal(popoverView.tabSettingsBtn.getAttribute('aria-selected'), 'true');
  assert.equal(doc.activeElement, popoverView.tabSettingsBtn);
  doc.dispatchEvent({ type: 'pointerdown', target: doc.body });
  assert.equal(popoverView.popEl.classList.contains('hidden'), true);

  // COMPACTION_IN_PROGRESS error surfaces localized note
  compactError = { code: 'COMPACTION_IN_PROGRESS', message: 'busy' };
  barView.compactBtn.click();
  await flush();
  assert.equal(barView.barEl.querySelector('.agy-inline-status-note').textContent, i18n.t().compactInProgress);

  // destroy removes all document listeners
  ctrl.destroy();
  assert.equal(doc.getListenerCount('keydown'), 0);
  assert.equal(doc.getListenerCount('pointerdown'), 0);
});

test('TC-UNIT-05b (v3.2.0): bar-controller.mjs skips polling when unconfigured and handles Remote Web connect/disconnect & validation', async () => {
  const { doc } = createUnitMockDom();
  const i18n = createInlineI18n('ko');
  const barView = createBarView({ doc, i18n });
  const popoverView = createPopoverView({ doc, i18n, isRemoteWeb: true });

  let configured = false;
  let connected = false;
  let currentUrl = '';
  let postCount = 0;
  const savedEvents = [];
  let clearCount = 0;
  const api = {
    isConfigured: () => configured,
    isConnected: () => connected,
    getBaseUrl: () => currentUrl,
    abortAll() {},
    async post() {
      postCount += 1;
      return {};
    },
  };

  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: '',
    defaultCustomLimit: null,
    sessionLimits: new Map(),
    quotaState: null,
    fallbackSessionId: '',
  };
  const addons = createAddonRegistry({ api, onChange() {} });
  const ctrl = createBarController({
    doc,
    api,
    i18n,
    addons,
    barView,
    popoverView,
    sharedState,
    isRemoteWeb: true,
    onSettingsChanged() {},
    onBurstRequested() {},
    async onRemoteConnectionSave({ baseUrl, token }) {
      savedEvents.push({ baseUrl, token });
      if (baseUrl.startsWith('http://remote.')) {
        return { ok: false, code: 'ERR_INVALID_ENDPOINT_URL' };
      }
      if (token === 'wrong-token-16-chars!') {
        configured = true;
        connected = false;
        currentUrl = baseUrl;
        return { ok: false, status: 401, code: 'UNAUTHORIZED' };
      }
      configured = true;
      connected = true;
      currentUrl = baseUrl;
      return { ok: true, baseUrl };
    },
    async onRemoteConnectionClear() {
      clearCount += 1;
      configured = false;
      connected = false;
      currentUrl = '';
    },
  });

  // 1. Unconfigured Remote Web skips snapshot polling and opens Settings tab on ctxBtn click
  ctrl.render();
  await ctrl.refreshSnapshot();
  assert.equal(postCount, 0, 'Unconfigured controller must issue zero API fetches');
  assert.equal(barView.ctxBtn.textContent, i18n.t().remoteSetupNeeded);
  barView.ctxBtn.click();
  assert.equal(popoverView.popEl.classList.contains('hidden'), false);
  assert.equal(popoverView.tabSettingsBtn.getAttribute('aria-selected'), 'true');

  // 2. Invalid URL surfaces error feedback
  const popFeedback = popoverView.popEl.querySelector('.agy-inline-pop-feedback');
  popoverView.remoteUrlInput.value = 'http://remote.example:8080';
  popoverView.remoteTokenInput.value = TEST_TOKEN;
  popoverView.remoteConnectBtn.click();
  await flush();
  assert.equal(popFeedback.classList.contains('err'), true);
  assert.equal(popFeedback.textContent, i18n.t().remoteInvalidUrl);

  // 3. 401 unauthorized surfaces auth error
  popoverView.remoteUrlInput.value = 'https://sidecar.example.com';
  popoverView.remoteTokenInput.value = 'wrong-token-16-chars!';
  popoverView.remoteConnectBtn.click();
  await flush();
  assert.equal(popFeedback.classList.contains('err'), true);
  assert.equal(popFeedback.textContent, i18n.formatTemplate(i18n.t().remoteAuthFailed, { status: 401 }));
  assert.equal(popoverView.remoteConnStatusEl.classList.contains('err'), true);

  // 4. Valid HTTPS connection succeeds and updates status; Disconnect clears connection
  popoverView.remoteUrlInput.value = 'https://sidecar.example.com';
  popoverView.remoteTokenInput.value = TEST_TOKEN;
  popoverView.remoteConnectBtn.click();
  await flush();
  assert.equal(popFeedback.classList.contains('err'), false);
  assert.equal(popoverView.remoteConnStatusEl.classList.contains('err'), false);
  assert.ok(popoverView.remoteConnStatusEl.textContent.includes('https://sidecar.example.com'));
  assert.equal(savedEvents.length, 3);

  popoverView.remoteDisconnectBtn.click();
  await flush();
  assert.equal(clearCount, 1);
  assert.equal(configured, false);
  assert.equal(popoverView.remoteUrlInput.value, '');
  assert.equal(popoverView.remoteTokenInput.value, '');
  assert.equal(barView.ctxBtn.textContent, i18n.t().remoteSetupNeeded);

  ctrl.destroy();
});

test('TC-UNIT-06: bootstrap.mjs picks visible/focused input box, ignores own mutations, and tears down cleanly', async () => {
  const { doc, El } = createUnitMockDom();
  const vHidden = new El('div', doc);
  vHidden.setAttribute('data-testid', 'conversation-view');
  vHidden.setAttribute('data-cascade-id', 'sess-hidden');
  const bHidden = new El('div', doc);
  bHidden.setAttribute('data-testid', 'agent-input-box');
  bHidden.visible = false;
  bHidden.offsetParent = null;
  vHidden.appendChild(bHidden);
  doc.body.appendChild(vHidden);

  const vVis = new El('div', doc);
  vVis.setAttribute('data-testid', 'conversation-view');
  vVis.setAttribute('data-cascade-id', 'sess-visible');
  const bVis = new El('div', doc);
  bVis.setAttribute('data-testid', 'agent-input-box');
  vVis.appendChild(bVis);
  doc.body.appendChild(vVis);

  const disposers = [];
  const slotEl = new El('div', doc);
  slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
  let styleRemoved = false;
  let slotUnmounted = false;
  const hostPort = {
    pluginId: 'antigravity-statusbar',
    mountSlot(parentEl) {
      parentEl.appendChild(slotEl);
      return slotEl;
    },
    unmountSlot() {
      slotUnmounted = true;
      slotEl.remove();
      return true;
    },
    injectStyle() {},
    removeStyle() {
      styleRemoved = true;
      return true;
    },
    onDispose(fn) {
      disposers.push(fn);
    },
  };

  let aborted = false;
  const api = {
    isConnected: () => true,
    abortAll() { aborted = true; },
    async post() { return {}; },
  };
  const i18n = createInlineI18n('ko');
  const addons = createAddonRegistry({ api, onChange() {} });
  const win = { location: { reload() {} } };

  const runtime = startAddonStatusbar({
    hostPort,
    api,
    i18n,
    addons,
    createBarViewFn: createBarView,
    createPopoverViewFn: createPopoverView,
    createBarControllerFn: createBarController,
    doc,
    win,
    cssText: STATUSBAR_STYLES,
    styleId: STATUSBAR_STYLE_ID,
    pollConfig: { normalPollMs: 60000, quotaPollMs: 60000 },
  });

  // Should pick visible input box over hidden one
  assert.equal(slotEl.parentNode, bVis);
  assert.equal(win.statusbarAddons, addons.publicApi);

  // Trigger host dispose callback
  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.equal(aborted, true);
  assert.equal(slotUnmounted, true);
  assert.equal(styleRemoved, true);
  assert.equal(win.statusbarAddons, undefined);
  assert.equal(doc.getListenerCount('focusin'), 0);
  // Idempotent second dispose
  runtime.dispose();

  // Standby bootstrap unit check
  const standbyDisposers = [];
  let reloaded = 0;
  const standbyHost = {
    pluginId: 'antigravity-statusbar',
    mountSlot(parentEl) {
      parentEl.appendChild(slotEl);
      return slotEl;
    },
    unmountSlot() { slotEl.remove(); return true; },
    injectStyle() {},
    removeStyle() { return true; },
    onDispose(fn) { standbyDisposers.push(fn); },
  };
  startStandbyStatusbar({
    hostPort: standbyHost,
    i18n: createInlineI18n('en'),
    doc,
    win: { location: { reload() { reloaded += 1; } } },
    cssText: STATUSBAR_STYLES,
    styleId: STATUSBAR_STYLE_ID,
  });
  slotEl.querySelector('.agy-inline-btn').click();
  assert.equal(reloaded, 1);
  standbyDisposers[0]();
  assert.equal(slotEl.parentNode, null);
});

test('TC-UNIT-06b: subagent & side-question views stay strictly pinned to their own data-cascade-id without fallback fluctuation, support sibling/nested/pointerdown switching, and fail closed when unattributed', async () => {
  // 1. Subagent tab stays pinned to sub-A even while /api/sessions flips sessions[0] every poll (stock-chart bug reproduction)
  {
    const { doc, El } = createUnitMockDom();
    const subView = new El('div', doc);
    subView.setAttribute('data-testid', 'subagent-tab-conversation');
    subView.setAttribute('data-cascade-id', 'sub-A');
    const subBox = new El('div', doc);
    subBox.setAttribute('data-testid', 'agent-input-box');
    subView.appendChild(subBox);
    doc.body.appendChild(subView);

    const slotEl = new El('div', doc);
    slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
    const hostPort = {
      pluginId: 'antigravity-statusbar',
      mountSlot(parentEl) {
        parentEl.appendChild(slotEl);
        return slotEl;
      },
      unmountSlot() {
        slotEl.remove();
        return true;
      },
      injectStyle() {},
      removeStyle() {
        return true;
      },
      onDispose() {},
    };

    const snapshotsBySession = {
      'sub-A': { sessionId: 'sub-A', usedTokens: 45000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 22.5 },
      'main-1': { sessionId: 'main-1', usedTokens: 180000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 90.0 },
      'sub-B': { sessionId: 'sub-B', usedTokens: 120000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 60.0 },
      'sub-C': { sessionId: 'sub-C', usedTokens: 15000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 7.5 },
    };
    const sessionPolls = [
      [{ sessionId: 'main-1', isSubagent: false }, { sessionId: 'sub-A', isSubagent: true }],
      [{ sessionId: 'sub-B', isSubagent: true }, { sessionId: 'main-1', isSubagent: false }],
      [{ sessionId: 'sub-C', isSubagent: true }, { sessionId: 'sub-A', isSubagent: true }],
    ];
    let pollIdx = 0;
    const requestedSnapshotIds = [];

    const api = {
      isConnected: () => true,
      abortAll() {},
      async post(pathname, body) {
        if (pathname === '/api/sessions') {
          const list = sessionPolls[Math.min(pollIdx, sessionPolls.length - 1)];
          pollIdx += 1;
          return { sessions: list };
        }
        if (pathname === '/api/snapshot') {
          requestedSnapshotIds.push(body.sessionId);
          return snapshotsBySession[body.sessionId] || snapshotsBySession['sub-A'];
        }
        return {};
      },
    };

    const runtime = startAddonStatusbar({
      hostPort,
      api,
      i18n: createInlineI18n('ko'),
      addons: createAddonRegistry({ api, onChange() {} }),
      createBarViewFn: createBarView,
      createPopoverViewFn: createPopoverView,
      createBarControllerFn: createBarController,
      doc,
      win: { location: { reload() {} } },
      cssText: STATUSBAR_STYLES,
      styleId: STATUSBAR_STYLE_ID,
      pollConfig: { normalPollMs: 25, quotaPollMs: 60000 },
    });

    try {
      await flush(110);
      assert.ok(requestedSnapshotIds.length >= 2, 'Expected multiple snapshot polls');
      assert.ok(
        requestedSnapshotIds.every((id) => id === 'sub-A'),
        `Subagent statusbar must only query sub-A, got: ${JSON.stringify(requestedSnapshotIds)}`,
      );
      const ctxText = slotEl.querySelector('.agy-inline-metric-btn').textContent;
      assert.ok(ctxText.includes('45.0K'), `Expected sub-A 45.0K tokens, got: ${ctxText}`);
    } finally {
      runtime.dispose();
    }
    assert.equal(doc.getListenerCount('pointerdown'), 0, 'dispose must remove pointerdown listener');
  }

  // 2. Nested subagent inside main conversation-view (innermost wins), sibling layout, side-question, and multi-pane pointerdown switching
  {
    const { doc, El } = createUnitMockDom();

    // Main view containing a nested subagent view
    const mainView = new El('div', doc);
    mainView.setAttribute('data-testid', 'conversation-view');
    mainView.setAttribute('data-cascade-id', 'main-outer');
    const mainBox = new El('div', doc);
    mainBox.setAttribute('data-testid', 'agent-input-box');
    mainView.appendChild(mainBox);

    const nestedSub = new El('div', doc);
    nestedSub.setAttribute('data-testid', 'subagent-tab-conversation');
    nestedSub.setAttribute('data-cascade-id', 'sub-inner');
    const nestedSubText = new El('p', doc);
    nestedSubText.textContent = 'Subagent message';
    const nestedSubBox = new El('div', doc);
    nestedSubBox.setAttribute('data-testid', 'agent-input-box');
    nestedSub.appendChild(nestedSubText);
    nestedSub.appendChild(nestedSubBox);
    mainView.appendChild(nestedSub);
    doc.body.appendChild(mainView);

    // Sibling layout pane: subagent view and input box are siblings under one pane container
    const siblingPane = new El('div', doc);
    const siblingSub = new El('div', doc);
    siblingSub.setAttribute('data-testid', 'subagent-tab-conversation');
    siblingSub.setAttribute('data-cascade-id', 'sub-sibling');
    const siblingBox = new El('div', doc);
    siblingBox.setAttribute('data-testid', 'agent-input-box');
    siblingPane.appendChild(siblingSub);
    siblingPane.appendChild(siblingBox);
    doc.body.appendChild(siblingPane);

    // Side-question tab
    const sideQ = new El('div', doc);
    sideQ.setAttribute('data-testid', 'side-question-tab-conversation');
    sideQ.setAttribute('data-cascade-id', 'sq-1');
    const sideQBox = new El('div', doc);
    sideQBox.setAttribute('data-testid', 'agent-input-box');
    sideQ.appendChild(sideQBox);
    doc.body.appendChild(sideQ);

    const slotEl = new El('div', doc);
    slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
    const hostPort = {
      pluginId: 'antigravity-statusbar',
      mountSlot(parentEl) {
        parentEl.appendChild(slotEl);
        return slotEl;
      },
      unmountSlot() {
        slotEl.remove();
        return true;
      },
      injectStyle() {},
      removeStyle() {
        return true;
      },
      onDispose() {},
    };

    const requested = [];
    const api = {
      isConnected: () => true,
      abortAll() {},
      async post(pathname, body) {
        if (pathname === '/api/sessions') {
          return { sessions: [{ sessionId: 'main-outer', isSubagent: false }] };
        }
        if (pathname === '/api/snapshot') {
          requested.push(body.sessionId);
          return { sessionId: body.sessionId, usedTokens: 10000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 5 };
        }
        return {};
      },
    };

    // Focus side-question first
    sideQBox.focus();
    const runtime = startAddonStatusbar({
      hostPort,
      api,
      i18n: createInlineI18n('ko'),
      addons: createAddonRegistry({ api, onChange() {} }),
      createBarViewFn: createBarView,
      createPopoverViewFn: createPopoverView,
      createBarControllerFn: createBarController,
      doc,
      win: { location: { reload() {} } },
      cssText: STATUSBAR_STYLES,
      styleId: STATUSBAR_STYLE_ID,
      pollConfig: { normalPollMs: 60000, quotaPollMs: 60000 },
    });

    try {
      await flush(30);
      assert.equal(slotEl.parentNode, sideQBox);
      assert.equal(requested[requested.length - 1], 'sq-1');

      // Click non-focusable text inside nested subagent -> switches to nestedSubBox and binds to sub-inner (NOT main-outer!)
      doc.dispatchEvent({ type: 'pointerdown', target: nestedSubText });
      await flush(30);
      assert.equal(slotEl.parentNode, nestedSubBox);
      assert.equal(requested[requested.length - 1], 'sub-inner');

      // Click own statusbar node -> must NOT jump away from nestedSubBox
      doc.dispatchEvent({ type: 'pointerdown', target: slotEl.querySelector('.agy-inline-metric-btn') });
      await flush(20);
      assert.equal(slotEl.parentNode, nestedSubBox);

      // Focus sibling layout box -> binds to sub-sibling
      siblingBox.focus();
      doc.dispatchEvent({ type: 'focusin', target: siblingBox });
      await flush(30);
      assert.equal(slotEl.parentNode, siblingBox);
      assert.equal(requested[requested.length - 1], 'sub-sibling');
    } finally {
      runtime.dispose();
    }
  }

  // 3. Unattributed subagent view fails closed (never falls back to fallbackSessionId, clears stale snapshot) + stale response mismatch guard + fallback prefers non-subagent
  {
    const { doc, El } = createUnitMockDom();
    const i18n = createInlineI18n('ko');
    const barView = createBarView({ doc, i18n });
    const popoverView = createPopoverView({ doc, i18n });

    let nextSnap = { sessionId: 'main-1', usedTokens: 90000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 45 };
    const calls = [];
    const api = {
      isConnected: () => true,
      abortAll() {},
      async post(pathname, body) {
        calls.push({ pathname, body });
        return nextSnap;
      },
    };
    const sharedState = {
      autoCompactEnabled: true,
      compactPrompt: '',
      defaultCustomLimit: null,
      sessionLimits: new Map(),
      quotaState: null,
      fallbackSessionId: 'main-1',
    };
    const ctrl = createBarController({
      doc,
      api,
      i18n,
      addons: createAddonRegistry({ api, onChange() {} }),
      barView,
      popoverView,
      sharedState,
      onSettingsChanged() {},
      onBurstRequested() {},
    });

    // Load main-1 first
    const mainView = new El('div', doc);
    mainView.setAttribute('data-testid', 'conversation-view');
    mainView.setAttribute('data-cascade-id', 'main-1');
    ctrl.setTargetView(mainView);
    await flush(20);
    assert.ok(barView.ctxBtn.textContent.includes('90.0K'));

    // Switch to unattributed subagent view (no data-cascade-id yet) -> MUST fail closed (no snapshot call for main-1, stale 90.0K cleared!)
    const callsBefore = calls.length;
    const unattrSub = new El('div', doc);
    unattrSub.setAttribute('data-testid', 'subagent-tab-conversation');
    ctrl.setTargetView(unattrSub);
    await flush(20);
    assert.equal(calls.length, callsBefore, 'Unattributed subagent view must never fall back to fallbackSessionId');
    assert.equal(barView.ctxBtn.textContent.includes('90.0K'), false, 'Stale main-1 snapshot must be cleared');

    // Mismatched response sessionId must be rejected by bar-controller defense-in-depth guard
    const subView2 = new El('div', doc);
    subView2.setAttribute('data-testid', 'subagent-tab-conversation');
    subView2.setAttribute('data-cascade-id', 'sub-target');
    nextSnap = { sessionId: 'wrong-other-session', usedTokens: 175000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 87.5 };
    ctrl.setTargetView(subView2);
    await flush(20);
    assert.equal(barView.ctxBtn.textContent.includes('175.0K'), false, 'Mismatched snapshot sessionId must not render');

    ctrl.destroy();
  }

  // 4. Fallback mode (Remote Web dock with no DOM cascade-id) prefers latest non-subagent session over noisy background subagents
  {
    const { doc, El } = createUnitMockDom();
    const slotEl = new El('div', doc);
    slotEl.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
    const hostPort = {
      pluginId: 'antigravity-statusbar',
      hostProfileId: 'antigravity-remote-web',
      mountSlot() {
        doc.body.appendChild(slotEl);
        return slotEl;
      },
      unmountSlot() {
        slotEl.remove();
        return true;
      },
      injectStyle() {},
      removeStyle() {
        return true;
      },
      onDispose() {},
    };
    const snapIds = [];
    const api = {
      isConfigured: () => true,
      isConnected: () => true,
      abortAll() {},
      async post(pathname, body) {
        if (pathname === '/api/sessions') {
          return {
            sessions: [
              { sessionId: 'sub-bg-1', isSubagent: true },
              { sessionId: 'main-primary', isSubagent: false },
            ],
          };
        }
        if (pathname === '/api/snapshot') {
          snapIds.push(body.sessionId);
          return { sessionId: body.sessionId, usedTokens: 32000, effectiveLimit: 200000, maxContextTokens: 512000, usagePercent: 16 };
        }
        return {};
      },
    };
    const runtime = startAddonStatusbar({
      hostPort,
      api,
      i18n: createInlineI18n('ko'),
      addons: createAddonRegistry({ api, onChange() {} }),
      createBarViewFn: createBarView,
      createPopoverViewFn: createPopoverView,
      createBarControllerFn: createBarController,
      doc,
      win: { location: { reload() {} } },
      cssText: STATUSBAR_STYLES,
      styleId: STATUSBAR_STYLE_ID,
      pollConfig: { normalPollMs: 60000, quotaPollMs: 60000 },
    });
    try {
      await flush(40);
      assert.deepEqual(snapIds, ['main-primary'], 'Fallback mode must prefer latest non-subagent session');
    } finally {
      runtime.dispose();
    }
  }
});

test('TC-UNIT-07: api-client, addon-bridge, i18n dictionary symmetry, and styles edge cases', async () => {
  // Styles sanity
  assert.equal(STATUSBAR_STYLE_ID, 'statusbar-main');
  assert.ok(STATUSBAR_STYLES.includes('.agy-inline-statusbar'));
  assert.ok(STATUSBAR_STYLES.includes('.agy-inline-popover'));

  // i18n en/ko key parity & formatting edge cases
  const koI18n = createInlineI18n('ko');
  const enI18n = createInlineI18n('en');
  assert.deepEqual(Object.keys(koI18n.t()).sort(), Object.keys(enI18n.t()).sort());
  assert.equal(koI18n.formatTokens(-1), '--');
  assert.equal(koI18n.formatTokens(NaN), '--');
  assert.equal(koI18n.formatTokens(500), '500');
  assert.equal(koI18n.localizeBreakdownLabel('Unknown Custom'), 'Unknown Custom');

  // api-client: pre-aborted signal, 4xx/5xx error code extraction, non-JSON body, abortAll
  const preAbort = new AbortController();
  preAbort.abort();
  const api = createSidecarApiClient({
    baseUrl: 'http://127.0.0.1:41111',
    token: TEST_TOKEN,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/err-json')) {
        return {
          ok: false,
          status: 409,
          async json() { return { error: { code: 'COMPACTION_IN_PROGRESS', message: 'Busy' } }; },
        };
      }
      if (url.endsWith('/err-text')) {
        return {
          ok: false,
          status: 502,
          async json() { throw new SyntaxError('not json'); },
        };
      }
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  await assert.rejects(() => api.post('/any', {}, preAbort.signal), /aborted/);
  await assert.rejects(
    () => api.post('/err-json', {}),
    (e) => e.status === 409 && e.code === 'COMPACTION_IN_PROGRESS' && e.message === 'Busy',
  );
  await assert.rejects(
    () => api.post('/err-text', {}),
    (e) => e.status === 502 && e.code === 'HTTP_ERROR',
  );

  const hanging = api.post('/hang', {});
  api.abortAll();
  await assert.rejects(() => hanging, /aborted/);

  // addon-bridge truncation, sorting, and failed setEnabled
  const failingApi = { async post() { throw new Error('offline'); } };
  const reg = createAddonRegistry({ api: failingApi, onChange() {} });
  assert.equal(
    reg.register({
      id: 'z_btn',
      label: 'A'.repeat(40),
      description: 'D'.repeat(200),
      order: 20,
      onClick() {},
    }),
    true,
  );
  assert.equal(reg.register({ id: 'a_btn', label: 'First', order: 5, onClick() {} }), true);
  const sorted = reg.getSortedRuntime();
  assert.deepEqual(sorted.map((s) => s.id), ['a_btn', 'z_btn']);
  assert.equal(sorted[1].label.length, 24);
  assert.equal(sorted[1].description.length, 120);
  assert.equal(await reg.setEnabled('a_btn', false), false);
});
