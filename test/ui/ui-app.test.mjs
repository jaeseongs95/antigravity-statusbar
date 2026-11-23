import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { createSidecarServer } from '../../src/adapters/antigravity/sidecar-entry.mjs';
import { renderUiBridgeScript } from '../../src/adapters/antigravity/ui-bridge.mjs';
import { createStatusbarApp } from '../../src/ui/app.js';

function findHeadlessBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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

  // R2-F5: If history.replaceState throws in restricted webview, authToken MUST still be retained!
  const winThrow = {
    location: { href: 'http://127.0.0.1:41234/?token=retained-token-after-throw-1234' },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    history: {
      replaceState: () => {
        throw new Error('SecurityError: replaceState blocked');
      },
    },
    URL,
  };
  winThrow.window = winThrow;
  vm.runInNewContext(scriptCode, winThrow);
  assert.equal(winThrow.__STATUSBAR_HOST_BRIDGE__.hasToken(), true);
});

test('F5, R2-F3 & NB2: session switch clears transient feedback, blocks stale async compact/limit errors, distinguishes backend save failure, and syncs limit inputs', async () => {
  const doc = createMockDocument();
  const win = createMockElement('window');

  let rejectCompact;
  const compactPromise = new Promise((_resolve, reject) => {
    rejectCompact = reject;
  });
  let rejectLimit;
  let limitShouldFail = false;

  const bridge = {
    getSettings: async () => ({ locale: 'en' }),
    updateSettings: () => {
      if (limitShouldFail) {
        return new Promise((_resolve, reject) => {
          rejectLimit = reject;
        });
      }
      return Promise.resolve({ locale: 'en' });
    },
    listSessions: async () => ({
      sessions: [
        { sessionId: 'sess-1', title: 'First' },
        { sessionId: 'sess-2', title: 'Second' },
      ],
    }),
    getSessionSnapshot: async (sid) => ({
      sessionId: sid,
      usedTokens: 10_000,
      effectiveLimit: 100_000,
      customLimit: sid === 'sess-1' ? 128_000 : null,
      limitSource: sid === 'sess-1' ? 'session' : 'host',
      usagePercent: 10,
      thresholdLevel: 'normal',
      exceededSoftLimit: false,
      cacheHitPercent: 50,
      cacheReadTokens: 5000,
      inputTokens: 5000,
      modelName: 'gemini-2.5-pro',
      stepCount: 3,
      tokenBreakdown: [],
      compaction: { inProgress: false, status: 'idle' },
      locale: 'en',
    }),
    getQuotaSummary: async () => ({ available: false, stale: false, groups: [] }),
    requestCompaction: () => compactPromise,
  };

  const app = createStatusbarApp({ doc, win, bridge });
  await app.start();

  // NB2: Limit input synced on initial session load
  assert.equal(doc.byId.get('limit-custom-input').value, '128000');

  // NB2: Second refreshSessions with identical list must NOT recreate <option> nodes
  const firstOptRef = doc.byId.get('session-select').options[0];
  await app.refreshSessions();
  assert.equal(doc.byId.get('session-select').options[0], firstOptRef);

  // R2-F3: Backend save error shows limitSaveFailed (NOT integer validation error!)
  limitShouldFail = true;
  doc.byId.get('limit-custom-input').value = '256000';
  const failLimitClick = doc.byId.get('btn-apply-limit').dispatch('click');
  rejectLimit(new Error('HTTP 503'));
  await failLimitClick;
  assert.equal(doc.byId.get('limit-feedback').textContent, 'Failed to save limit.');

  // Trigger compact + limit save on sess-1, then switch to sess-2 BEFORE both reject
  const compactClick = doc.byId.get('btn-compact').dispatch('click');
  const limitClick2 = doc.byId.get('btn-apply-limit').dispatch('click');
  assert.equal(doc.byId.get('compact-status').classList.contains('hidden'), false);

  doc.byId.get('session-select').value = 'sess-2';
  await doc.byId.get('session-select').dispatch('change');
  // F5 & NB2: transient feedback cleared and limit input synced to sess-2 (empty/host default)
  assert.equal(doc.byId.get('compact-status').classList.contains('hidden'), true);
  assert.equal(doc.byId.get('limit-feedback').classList.contains('hidden'), true);
  assert.equal(doc.byId.get('limit-custom-input').value, '');

  // Reject sess-1's stale compaction & limit requests -> MUST NOT contaminate sess-2!
  rejectCompact(new Error('network failed'));
  rejectLimit(new Error('HTTP 500'));
  await Promise.all([compactClick, limitClick2]);
  assert.equal(doc.byId.get('compact-status').classList.contains('hidden'), true);
  assert.equal(doc.byId.get('limit-feedback').classList.contains('hidden'), true);

  app.dispose();
});

/**
 * Minimal CDP WebSocket client over Node built-in http Upgrade (works on Node 20, 22, 24).
 */
function connectCdpWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('error', reject);
    req.on('upgrade', (_res, socket, head) => {
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      let nextId = 1;
      const pending = new Map();

      function parseFrames() {
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (buf.length < offset + maskLen + len) return;
          const payload = buf.subarray(offset + maskLen, offset + maskLen + len);
          buf = buf.subarray(offset + maskLen + len);

          if (opcode === 0x01) {
            try {
              const msg = JSON.parse(payload.toString('utf8'));
              if (msg.id && pending.has(msg.id)) {
                const { res: r, rej } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
                else r(msg.result);
              }
            } catch {
              // ignore non-JSON frame
            }
          }
        }
      }

      socket.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        parseFrames();
      });
      socket.on('error', () => {});

      function sendText(text) {
        const data = Buffer.from(text, 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (data.length < 126) {
          header = Buffer.alloc(6);
          header[0] = 0x81;
          header[1] = 0x80 | data.length;
          mask.copy(header, 2);
        } else if (data.length < 65536) {
          header = Buffer.alloc(8);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(data.length, 2);
          mask.copy(header, 4);
        } else {
          header = Buffer.alloc(14);
          header[0] = 0x81;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(data.length), 2);
          mask.copy(header, 10);
        }
        const maskedPayload = Buffer.allocUnsafe(data.length);
        for (let i = 0; i < data.length; i += 1) {
          maskedPayload[i] = data[i] ^ mask[i & 3];
        }
        socket.write(Buffer.concat([header, maskedPayload]));
      }

      resolve({
        call(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            sendText(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.destroy();
        },
      });
    });
    req.end();
  });
}

test('R2-F6: interactive Headless Chromium/Edge CDP E2E verifies load, session switch, limit save, compact click, and reload token retention', async (t) => {
  const browserPath = findHeadlessBrowser();
  if (!browserPath) {
    if (process.env.CI === 'true') {
      assert.fail('Headless Chromium/Chrome/Edge is required on CI runners');
    }
    t.skip('No local Chromium/Chrome/Edge binary installed on this host');
    return;
  }

  const token = 'real-browser-cdp-token-32chars-ok';
  const settingsUpdates = [];
  const compactCalls = [];
  let resolveCompactCalled = null;
  const compactCalled = new Promise((resolve) => {
    resolveCompactCalled = resolve;
  });
  let savedLimitForSess2 = null;

  const sidecar = createSidecarServer({
    token,
    service: {
      listSessions: async () => ({
        sessions: [
          { sessionId: 'sess-chrome-1', title: 'Blink Session One' },
          { sessionId: 'sess-chrome-2', title: 'Blink Session Two' },
        ],
        fetchedAt: Date.now(),
      }),
      getSessionSnapshot: async (sid) => ({
        sessionId: sid,
        usedTokens: sid === 'sess-chrome-1' ? 64_000 : 22_000,
        effectiveLimit: sid === 'sess-chrome-2' && savedLimitForSess2 ? savedLimitForSess2 : 100_000,
        customLimit: sid === 'sess-chrome-2' ? savedLimitForSess2 : null,
        limitSource: sid === 'sess-chrome-2' && savedLimitForSess2 ? 'session' : 'host',
        usagePercent: sid === 'sess-chrome-1' ? 64.0 : 22.0,
        thresholdLevel: 'normal',
        exceededSoftLimit: false,
        cacheHitPercent: 90.0,
        cacheReadTokens: 90_000,
        inputTokens: 10_000,
        modelName: 'gemini-2.5-pro',
        stepCount: 8,
        tokenBreakdown: [{ key: 'sys', label: 'System Prompt', tokens: 3500 }],
        compaction: compactCalls.includes(sid)
          ? { inProgress: true, status: 'accepted' }
          : { inProgress: false, status: 'idle' },
        locale: 'en',
      }),
      getQuotaSummary: async () => ({
        available: true,
        stale: false,
        groups: [
          {
            label: 'Gemini Models',
            buckets: [{ window: '5h', remainingPercent: 88, resetTime: '2026-11-19T12:00:00Z' }],
          },
        ],
        fetchedAt: Date.now(),
      }),
      getSettings: async () => ({ locale: 'en', defaultCustomLimit: null, sessions: [] }),
      updateSettings: async (patch) => {
        settingsUpdates.push(patch);
        if (patch?.sessionLimit?.sessionId === 'sess-chrome-2') {
          savedLimitForSess2 = patch.sessionLimit.limit;
        }
        return { locale: 'en', defaultCustomLimit: null, sessions: [] };
      },
      requestCompaction: async (sid) => {
        compactCalls.push(sid);
        resolveCompactCalled?.(sid);
        return { accepted: true, sessionId: sid, method: 'rpc' };
      },
    },
  });

  const { port } = await sidecar.listen();
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statusbar-cdp-profile-'));

  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );

  let cdp = null;
  try {
    const devToolsWsBase = await new Promise((resolve, reject) => {
      let errBuf = '';
      const timer = setTimeout(() => reject(new Error(`CDP startup timeout: ${errBuf}`)), 30_000);
      browser.stderr.on('data', (chunk) => {
        errBuf += chunk.toString('utf8');
        const m = errBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      browser.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Browser exited early (${code}): ${errBuf}`));
      });
    });

    const cdpPort = new URL(devToolsWsBase).port;
    const targetsRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find((tg) => tg.type === 'page' && tg.webSocketDebuggerUrl);
    assert.ok(pageTarget, 'Expected a page target from CDP /json/list');

    cdp = await connectCdpWebSocket(pageTarget.webSocketDebuggerUrl);
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');

    const evalExpr = async (expression) => {
      const res = await cdp.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return res?.result?.value;
    };

    const waitForCondition = async (expression, timeoutMs = 8_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const val = await evalExpr(expression);
        if (val) return val;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timed out waiting for browser condition: ${expression}`);
    };

    // 1. Navigate with ?token= -> verify token stripped via replaceState & initial live metrics render
    await cdp.call('Page.navigate', {
      url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
    });
    await waitForCondition("document.getElementById('context-pct')?.textContent === '64.0%'");
    assert.equal(await evalExpr('window.location.search'), '');
    assert.equal(await evalExpr("document.getElementById('cache-pct')?.textContent"), '90.0%');
    assert.ok(
      String(await evalExpr("document.getElementById('quota-groups')?.textContent")).includes('Gemini Models'),
    );

    // 2. Interactive session switch -> context-pct updates to 22.0%
    await evalExpr(`(() => {
      const sel = document.getElementById('session-select');
      sel.value = 'sess-chrome-2';
      sel.dispatchEvent(new Event('change'));
    })()`);
    await waitForCondition("document.getElementById('context-pct')?.textContent === '22.0%'");

    // 3. Interactive custom soft limit save -> POST /api/settings/update + feedback
    await evalExpr(`(() => {
      const inp = document.getElementById('limit-custom-input');
      inp.value = '256000';
      document.getElementById('btn-apply-limit').click();
    })()`);
    await waitForCondition("document.getElementById('limit-feedback')?.textContent === 'Limit updated.'");
    assert.deepEqual(settingsUpdates[0], {
      sessionLimit: { sessionId: 'sess-chrome-2', limit: 256_000 },
    });

    // 4. Interactive compact button click -> POST /api/compact
    await evalExpr("document.getElementById('btn-compact').click()");
    await waitForCondition("document.getElementById('compact-status')?.textContent === 'Compaction requested...'");
    let compactWaitTimer = null;
    try {
      await Promise.race([
        compactCalled,
        new Promise((_, reject) => {
          compactWaitTimer = setTimeout(
            () => reject(new Error('Timed out waiting for POST /api/compact')),
            8_000,
          );
        }),
      ]);
    } finally {
      if (compactWaitTimer) clearTimeout(compactWaitTimer);
    }
    assert.equal(compactCalls[0], 'sess-chrome-2');

    // 5. Real browser reload WITHOUT ?token= in URL -> sessionStorage retains auth & re-renders live data
    await cdp.call('Page.reload', { ignoreCache: true });
    await waitForCondition("document.getElementById('context-pct')?.textContent === '64.0%'");
    assert.equal(await evalExpr('window.location.search'), '');
    assert.equal(await evalExpr("document.getElementById('conn-badge')?.textContent"), 'Live');
  } finally {
    cdp?.close();
    browser.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          browser.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);
      browser.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    await sidecar.close();
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
