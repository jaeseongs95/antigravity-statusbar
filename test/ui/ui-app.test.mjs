import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { renderUiBridgeScript } from '../../src/adapters/antigravity/ui-bridge.mjs';
import { createStatusbarApp } from '../../src/ui/app.js';

/**
 * Minimal deterministic DOM mock for headless Node verification of src/ui/app.js
 * without external browser binaries (tests D-0006, D-0012, D-0020, D-0025, D-0033).
 */
function createMockElement(tag = 'div', id = '') {
  const listeners = new Map();
  const attrs = new Map();
  const classSet = new Set();

  const el = {
    tagName: tag.toUpperCase(),
    id,
    value: '',
    disabled: false,
    textContent: '',
    style: {},
    children: [],
    options: [],
    get firstChild() {
      return this.children[0] || null;
    },
    get className() {
      return Array.from(classSet).join(' ');
    },
    set className(val) {
      classSet.clear();
      for (const cls of String(val || '').split(/\s+/).filter(Boolean)) {
        classSet.add(cls);
      }
    },
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classSet.has(c)) classSet.delete(c);
          else classSet.add(c);
        } else if (force) {
          classSet.add(c);
        } else {
          classSet.delete(c);
        }
      },
    },
    appendChild(child) {
      this.children.push(child);
      if (child.tagName === 'OPTION') {
        this.options.push(child);
      }
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      const optIdx = this.options.indexOf(child);
      if (optIdx >= 0) this.options.splice(optIdx, 1);
      return child;
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
    addEventListener(type, fn, opts) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          listeners.get(type)?.delete(fn);
        });
      }
    },
    async dispatch(type) {
      for (const fn of Array.from(listeners.get(type) || [])) {
        await fn({ target: this });
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
  return el;
}

function createMockDocument() {
  const ids = [
    'app',
    'panel-title',
    'conn-badge',
    'btn-locale',
    'lbl-session',
    'session-mode-badge',
    'session-select',
    'lbl-context',
    'context-pct',
    'context-progress',
    'context-progress-fill',
    'context-tokens',
    'context-limit-tag',
    'soft-limit-banner',
    'soft-limit-banner-text',
    'btn-compact',
    'btn-context-detail',
    'compact-status',
    'context-detail-panel',
    'lbl-detail-title',
    'detail-steps',
    'detail-model',
    'breakdown-list',
    'lbl-custom-limit',
    'limit-scope-select',
    'limit-preset-select',
    'limit-custom-input',
    'btn-apply-limit',
    'limit-feedback',
    'lbl-cache',
    'cache-pct',
    'cache-detail',
    'lbl-quota',
    'quota-stale-badge',
    'quota-groups',
  ];

  const byId = new Map();
  for (const id of ids) {
    const node = createMockElement('div', id);
    byId.set(id, node);
  }
  const scopeSelect = byId.get('limit-scope-select');
  scopeSelect.appendChild(createMockElement('option'));
  scopeSelect.appendChild(createMockElement('option'));
  scopeSelect.value = 'session';

  const docListeners = new Map();

  return {
    byId,
    hidden: false,
    documentElement: { lang: 'en' },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => createMockElement(tag),
    addEventListener(type, fn, opts) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => docListeners.get(type)?.delete(fn));
      }
    },
    docListenerCount(type) {
      return docListeners.get(type)?.size || 0;
    },
  };
}

test('UI controller renders metrics safely via textContent, toggles EN/KO, enforces session isolation, and cleans up listeners on dispose (D-0006, D-0020, D-0025, D-0033)', async () => {
  const doc = createMockDocument();
  const win = createMockElement('window');

  const xssTitle = '<img src=x onerror=alert(1)>';
  const bridge = {
    getSettings: async () => ({ locale: 'en' }),
    updateSettings: async (patch) => ({ locale: patch.locale || 'en' }),
    listSessions: async () => ({
      sessions: [
        { sessionId: 'sess-1', title: xssTitle },
        { sessionId: 'sess-2', title: 'Second' },
      ],
    }),
    getSessionSnapshot: async (sid) => ({
      sessionId: sid,
      usedTokens: sid === 'sess-1' ? 140_000 : 20_000,
      effectiveLimit: 128_000,
      limitSource: 'session',
      usagePercent: sid === 'sess-1' ? 109.4 : 15.6,
      thresholdLevel: sid === 'sess-1' ? 'exceeded' : 'normal',
      exceededSoftLimit: sid === 'sess-1',
      cacheHitPercent: 91.2,
      cacheReadTokens: 100_000,
      inputTokens: 9_600,
      modelName: 'gemini-2.5-pro',
      stepCount: 12,
      tokenBreakdown: [{ key: 'sys', label: 'System Prompt', tokens: 4000 }],
      compaction: { inProgress: false, status: 'idle' },
      locale: 'en',
    }),
    getQuotaSummary: async () => ({
      available: true,
      stale: false,
      groups: [
        {
          label: 'Gemini Models',
          buckets: [{ window: '5h', remainingPercent: 80, resetTime: '2026-11-19T05:00:00Z' }],
        },
      ],
    }),
    requestCompaction: async (sid) => ({ accepted: true, sessionId: sid }),
  };

  const app = createStatusbarApp({ doc, win, bridge });
  await app.start();

  // D-0025: XSS string stays literal textContent in option
  assert.equal(doc.byId.get('session-select').options[0].textContent.includes(xssTitle), true);
  // Soft limit banner visible when exceeded
  assert.equal(doc.byId.get('soft-limit-banner').classList.contains('hidden'), false);
  assert.equal(doc.byId.get('context-pct').textContent, '109.4%');
  assert.equal(doc.byId.get('cache-pct').textContent, '91.2%');

  // Locale toggle EN -> KO
  await doc.byId.get('btn-locale').dispatch('click');
  assert.equal(doc.documentElement.lang, 'ko');
  assert.equal(doc.byId.get('panel-title').textContent, '상태바');

  // Switch session manually -> D-0033 updates strictly to sess-2
  doc.byId.get('session-select').value = 'sess-2';
  await doc.byId.get('session-select').dispatch('change');
  assert.equal(app.state.selectionMode, 'manual');
  assert.equal(doc.byId.get('context-pct').textContent, '15.6%');
  assert.equal(doc.byId.get('soft-limit-banner').classList.contains('hidden'), true);

  // D-0006 & D-0020: dispose removes all listeners via AbortController
  app.dispose();
  assert.equal(doc.byId.get('btn-locale').listenerCount('click'), 0);
  assert.equal(doc.byId.get('btn-compact').listenerCount('click'), 0);
  assert.equal(doc.docListenerCount('visibilitychange'), 0);
});

test('/bridge.js strips ?token= via history.replaceState and retains token on reload via sessionStorage (F9)', () => {
  const scriptCode = renderUiBridgeScript();
  const storage = new Map();
  let replacedUrl = null;

  const makeWindow = (href) => {
    const win = {
      location: { href },
      sessionStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
      },
      history: {
        replaceState: (_state, _title, nextUrl) => {
          replacedUrl = nextUrl;
        },
      },
      URL,
    };
    win.window = win;
    return win;
  };

  // First load with ?token=...
  const win1 = makeWindow('http://127.0.0.1:41234/?token=abcdefghijklmnop123456');
  vm.runInNewContext(scriptCode, win1);
  assert.equal(win1.__STATUSBAR_HOST_BRIDGE__.hasToken(), true);
  assert.equal(replacedUrl, '/');

  // Reload without ?token= in URL -> still authenticated via sessionStorage (F9)
  const win2 = makeWindow('http://127.0.0.1:41234/');
  vm.runInNewContext(scriptCode, win2);
  assert.equal(win2.__STATUSBAR_HOST_BRIDGE__.hasToken(), true);
});
