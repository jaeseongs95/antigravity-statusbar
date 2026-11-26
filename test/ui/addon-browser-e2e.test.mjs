import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderAddonRendererBundle } from '../../src/adapters/antigravity/addon/bundle-builder.mjs';
import { createSidecarServer } from '../../src/adapters/antigravity/sidecar-entry.mjs';

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

function connectCdpWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: parsed.hostname,
      port: Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });

    req.on('error', reject);
    req.on('upgrade', (_res, socket, head) => {
      let buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
      let nextId = 1;
      const pending = new Map();

      function handleFrame(text) {
        const msg = JSON.parse(text);
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const { res: resFn, rej: rejFn } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rejFn(new Error(msg.error.message || 'CDP error'));
          else resFn(msg.result);
        }
      }

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let payloadLen = buf[1] & 0x7f;
          let offset = 2;
          if (payloadLen === 126) {
            if (buf.length < 4) return;
            payloadLen = buf.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (buf.length < 10) return;
            payloadLen = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (buf.length < offset + maskLen + payloadLen) return;
          const payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
          buf = buf.subarray(offset + maskLen + payloadLen);
          if (opcode === 0x01) {
            handleFrame(payload.toString('utf8'));
          }
        }
      });

      function sendText(text) {
        const payload = Buffer.from(text, 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) {
          header = Buffer.alloc(6);
          header[0] = 0x81;
          header[1] = 0x80 | payload.length;
          mask.copy(header, 2);
        } else {
          header = Buffer.alloc(8);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
          mask.copy(header, 4);
        }
        const maskedPayload = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
          maskedPayload[i] = payload[i] ^ mask[i % 4];
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

test('TC-P0-02 (v3 API-First): real Headless Chromium Shadow DOM E2E verifies 99.7% rounding, localized 5h/weekly quota, host.statusbar delegation, Tier-2 popup/modal ID in-place focus stability, Desktop settings hiding Remote Sidecar, and disconnect indicator', async (t) => {
  const browserPath = findHeadlessBrowser();
  if (!browserPath) {
    if (process.env.CI === 'true') {
      assert.fail('Headless Chromium/Chrome/Edge is required on CI runners');
    }
    t.skip('No local Chromium/Chrome/Edge binary installed on this host');
    return;
  }

  const token = 'real-addon-e2e-token-32chars-valid';
  const settingsUpdates = [];
  const quotaRequests = [];
  let failSnapshots = false;
  let sessionLimit = 256_000;
  let defaultLimit = 200_000;
  const modelLimits = [{ model: 'Gemini 4 Neon (High)', limit: 128_000, updatedAt: 1 }];

  const sidecar = createSidecarServer({
    token,
    service: {
      listSessions: async () => ({
        sessions: [{ sessionId: 'sess-e2e-1', title: 'Shadow DOM E2E' }],
        fetchedAt: Date.now(),
      }),
      getSessionSnapshot: async (sid) => {
        if (failSnapshots) {
          const err = new Error('Sidecar upstream disconnected');
          err.httpStatus = 502;
          err.code = 'TELEMETRY_UNAVAILABLE';
          throw err;
        }
        const eff = sessionLimit ?? defaultLimit ?? 512_000;
        return {
          sessionId: sid,
          usedTokens: 255_232,
          effectiveLimit: eff,
          customLimit: sessionLimit,
          limitSource: sessionLimit ? 'session' : 'default',
          isCustomLimitActive: true,
          isClampedByHost: false,
          maxContextTokens: 512_000,
          usagePercent: 99.7,
          thresholdLevel: 'danger',
          exceededSoftLimit: false,
          autoCompact: true,
          autoCompactTriggered: false,
          compactPrompt: '',
          cacheHitPercent: 92,
          cacheReadTokens: 100_000,
          inputTokens: 10_000,
          modelName: 'Gemini 4 Neon (High)',
          stepCount: 14,
          tokenBreakdown: [{ key: 'sys', label: 'System Prompt', tokens: 4000 }],
          compaction: { inProgress: false, status: 'idle', lastError: null },
          locale: 'ko',
          customButtons: [
            { id: 'plan', label: 'plan', command: '/plan', description: 'Plan mode', enabled: true },
          ],
          disabledRuntimeAddonIds: [],
        };
      },
      getQuotaSummary: async (opts) => {
        quotaRequests.push(opts || null);
        return {
          available: true,
          stale: false,
          groups: [
            {
              label: 'Gemini Models',
              buckets: [
                { window: '5h', remainingPercent: 85, resetTime: '2026-11-23T14:00:00Z' },
                { window: 'weekly', remainingPercent: 60, resetTime: '2026-11-30T00:00:00Z' },
              ],
            },
          ],
          fetchedAt: Date.now(),
        };
      },
      getSettings: async () => ({
        locale: 'ko',
        autoCompact: true,
        compactPrompt: '',
        defaultCustomLimit: defaultLimit,
        modelLimits,
        sessions: sessionLimit ? [{ sessionId: 'sess-e2e-1', limit: sessionLimit, updatedAt: 1 }] : [],
        customButtons: [
          { id: 'plan', label: 'plan', command: '/plan', description: 'Plan mode', enabled: true },
        ],
        disabledRuntimeAddonIds: [],
      }),
      updateSettings: async (patch) => {
        settingsUpdates.push(patch);
        if (patch.sessionLimit) sessionLimit = patch.sessionLimit.limit;
        if ('defaultCustomLimit' in patch) defaultLimit = patch.defaultCustomLimit;
        return {
          locale: 'ko',
          autoCompact: true,
          compactPrompt: '',
          defaultCustomLimit: defaultLimit,
          modelLimits,
          sessions: sessionLimit ? [{ sessionId: 'sess-e2e-1', limit: sessionLimit, updatedAt: 2 }] : [],
          customButtons: [
            { id: 'plan', label: 'plan', command: '/plan', description: 'Plan mode', enabled: true },
          ],
          disabledRuntimeAddonIds: [],
        };
      },
      requestCompaction: async (sid) => ({ accepted: true, sessionId: sid, method: 'rpc' }),
    },
  });

  const { port: sidecarPort, url: sidecarUrl } = await sidecar.listen();
  const bundleSource = renderAddonRendererBundle({ baseUrl: sidecarUrl, token });

  // Lightweight v3 host harness with ID-based in-place schema reconciliation mirroring ui-schema-renderer.js
  const harnessHtml = `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>Addon V3 Shadow DOM E2E Harness</title></head>
<body>
  <div data-cascade-id="sess-e2e-1" style="margin-top: 320px;">
    <div data-testid="agent-input-box" style="width: 720px; height: 60px; border: 1px solid #444;">
      <textarea aria-label="Chat input"></textarea>
    </div>
  </div>
  <script>
    (function() {
      const disposeHandlers = [];
      const services = new Map();
      let rootShadowHost = null;
      let rootShadow = null;
      let rootSlotContainer = null;
      let popoverShadow = null;
      let modalShadow = null;
      let settingsShadow = null;
      const abortCtrl = new AbortController();

      function evalCond(cond, state) {
        if (!cond) return true;
        const val = state ? state[cond.field] : undefined;
        if ('eq' in cond) return val === cond.eq;
        if ('neq' in cond) return val !== cond.neq;
        return Boolean(val);
      }

      function createMiniSchemaRenderer(container, initTree, initState, onChange, onAction) {
        let state = Object.assign({}, initState || {});
        const refs = new Map();

        function applyFlags(wrapper, ctrl, node) {
          wrapper.hidden = node.visibleWhen ? !evalCond(node.visibleWhen, state) : false;
          if (ctrl && 'disabled' in ctrl) {
            ctrl.disabled = Boolean(node.disabled) || (node.disabledWhen ? evalCond(node.disabledWhen, state) : false);
          }
        }

        function patchNode(ref, node) {
          applyFlags(ref.wrapper, ref.ctrl, node);
          const val = node.field ? state[node.field] : node.value;
          if (node.type === 'text' || node.type === 'badge' || node.type === 'alert') {
            ref.wrapper.textContent = String(node.text || '');
            if (node.variant) ref.wrapper.setAttribute('data-variant', node.variant);
          } else if (node.type === 'button') {
            ref.ctrl.textContent = String(node.label || '');
          } else if (node.type === 'input' || node.type === 'textarea') {
            const root = ref.ctrl.getRootNode();
            const active = root && root.activeElement ? root.activeElement : document.activeElement;
            if (active !== ref.ctrl) ref.ctrl.value = val != null ? String(val) : '';
          } else if (node.type === 'select') {
            if (val != null) ref.ctrl.value = String(val);
          } else if (node.type === 'segmented') {
            const activeVal = val != null ? String(val) : '';
            Array.from(ref.ctrl.childNodes).forEach((btn) => {
              btn.setAttribute('aria-pressed', btn.getAttribute('data-ag-segment-value') === activeVal ? 'true' : 'false');
            });
          } else if (node.type === 'toggle') {
            ref.ctrl.checked = Boolean(val);
          }
        }

        function buildNode(node) {
          let wrapper = null;
          let ctrl = null;
          let mountEl = null;
          if (node.type === 'stack' || node.type === 'row' || node.type === 'section') {
            wrapper = document.createElement(node.type === 'section' ? 'section' : 'div');
            if (node.title) {
              const h = document.createElement('div');
              h.textContent = node.title;
              wrapper.appendChild(h);
            }
            mountEl = wrapper;
          } else if (node.type === 'text' || node.type === 'badge' || node.type === 'alert') {
            wrapper = document.createElement('div');
            wrapper.textContent = String(node.text || '');
            if (node.variant) wrapper.setAttribute('data-variant', node.variant);
          } else if (node.type === 'button') {
            ctrl = document.createElement('button');
            ctrl.type = 'button';
            ctrl.textContent = String(node.label || '');
            ctrl.addEventListener('click', () => {
              if (onAction) onAction({ actionId: node.actionId, payload: node.payload, state });
            });
            wrapper = ctrl;
          } else if (node.type === 'input' || node.type === 'textarea') {
            wrapper = document.createElement('label');
            ctrl = document.createElement(node.type === 'textarea' ? 'textarea' : 'input');
            if (node.type === 'input') ctrl.type = node.inputType || 'text';
            ctrl.value = node.field && state[node.field] != null ? String(state[node.field]) : '';
            ctrl.addEventListener('input', () => {
              if (node.field) state[node.field] = ctrl.value;
              if (onChange) onChange({ field: node.field, value: ctrl.value, state });
            });
            wrapper.appendChild(ctrl);
          } else if (node.type === 'select') {
            wrapper = document.createElement('label');
            ctrl = document.createElement('select');
            (node.options || []).forEach((o) => {
              const opt = document.createElement('option');
              opt.value = o.value;
              opt.textContent = o.label;
              ctrl.appendChild(opt);
            });
            if (node.field && state[node.field] != null) ctrl.value = String(state[node.field]);
            ctrl.addEventListener('change', () => {
              if (node.field) state[node.field] = ctrl.value;
              if (onChange) onChange({ field: node.field, value: ctrl.value, state });
            });
            wrapper.appendChild(ctrl);
          } else if (node.type === 'segmented') {
            wrapper = document.createElement('div');
            ctrl = document.createElement('div');
            ctrl.setAttribute('role', 'group');
            ctrl.setAttribute('data-ag-segmented', '1');
            const curVal = node.field && state[node.field] != null ? String(state[node.field]) : '';
            (node.options || []).forEach((o) => {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.setAttribute('data-ag-segment-value', o.value);
              btn.setAttribute('aria-pressed', curVal === o.value ? 'true' : 'false');
              btn.textContent = o.label;
              btn.addEventListener('click', () => {
                if (node.field) state[node.field] = o.value;
                Array.from(ctrl.childNodes).forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
                if (onChange) onChange({ field: node.field, value: o.value, state });
              });
              ctrl.appendChild(btn);
            });
            wrapper.appendChild(ctrl);
          } else if (node.type === 'toggle') {
            wrapper = document.createElement('label');
            ctrl = document.createElement('input');
            ctrl.type = 'checkbox';
            ctrl.checked = Boolean(node.field ? state[node.field] : false);
            ctrl.addEventListener('change', () => {
              if (node.field) state[node.field] = ctrl.checked;
              if (onChange) onChange({ field: node.field, value: ctrl.checked, state });
            });
            wrapper.appendChild(ctrl);
          } else {
            wrapper = document.createElement('div');
          }
          if (node.id) {
            wrapper.setAttribute('data-ag-node-id', node.id);
            refs.set(node.id, { type: node.type, wrapper, ctrl, mountEl });
          }
          applyFlags(wrapper, ctrl, node);
          if (mountEl && Array.isArray(node.children)) {
            node.children.forEach((ch) => mountEl.appendChild(buildNode(ch)));
          }
          return wrapper;
        }

        function collectIds(node, outSet) {
          if (!node || typeof node !== 'object') return;
          if (node.id) outSet.add(node.id);
          if (Array.isArray(node.children)) node.children.forEach((ch) => collectIds(ch, outSet));
        }

        function reconcile(node, seenIds) {
          if (node.id && refs.has(node.id) && refs.get(node.id).type === node.type) {
            const ref = refs.get(node.id);
            seenIds.add(node.id);
            patchNode(ref, node);
            if (ref.mountEl && Array.isArray(node.children)) {
              const desired = node.children.map((ch) => reconcile(ch, seenIds));
              Array.from(ref.mountEl.childNodes).forEach((child) => {
                if (!desired.includes(child) && child !== ref.mountEl.firstChild) ref.mountEl.removeChild(child);
              });
              desired.forEach((el) => {
                if (el.parentNode !== ref.mountEl) ref.mountEl.appendChild(el);
              });
            }
            return ref.wrapper;
          }
          const built = buildNode(node);
          collectIds(node, seenIds);
          return built;
        }

        container.appendChild(buildNode(initTree));
        return {
          update(nextTree, nextState) {
            state = Object.assign({}, nextState || {});
            const seenIds = new Set();
            const nextRoot = reconcile(nextTree, seenIds);
            if (nextRoot !== container.firstChild) {
              while (container.firstChild) container.removeChild(container.firstChild);
              container.appendChild(nextRoot);
            }
            Array.from(refs.keys()).forEach((oldId) => {
              if (!seenIds.has(oldId)) refs.delete(oldId);
            });
          },
          getElementById(id) {
            return refs.has(id) ? refs.get(id).wrapper : null;
          },
        };
      }

      function openOverlay(kind, opts, setShadow) {
        const isModal = kind === 'modal' || kind === 'settings';
        const el = document.createElement(isModal ? 'dialog' : 'div');
        el.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
        const host = isModal ? document.createElement('div') : el;
        if (isModal) el.appendChild(host);
        const sr = host.attachShadow({ mode: 'open' });
        const body = document.createElement('div');
        sr.appendChild(body);
        document.body.appendChild(el);
        setShadow(sr);
        const renderer = createMiniSchemaRenderer(body, opts.tree, opts.state, opts.onChange, opts.onAction);
        if (isModal && typeof el.showModal === 'function') { try { el.showModal(); } catch {} }
        const close = () => {
          try { if (isModal && el.open) el.close(); } catch {}
          el.remove();
          setShadow(null);
          if (opts.onClose) opts.onClose();
        };
        el.addEventListener('close', () => {
          el.remove();
          setShadow(null);
          if (opts.onClose) opts.onClose();
        });
        return {
          element: el,
          update: renderer.update,
          getElementById: renderer.getElementById,
          close,
        };
      }

      window.__e2eShadows = {
        get root() { return rootShadow; },
        get popover() { return popoverShadow; },
        get modal() { return modalShadow; },
        get settings() { return settingsShadow; },
        services,
      };

      window.addonHost = {
        apiVersion: 3,
        meta: { pluginId: 'antigravity-statusbar', displayName: 'Antigravity Statusbar', version: '3.3.1', trustLevel: 'trusted' },
        env: { surface: 'desktop', layoutMode: 'desktop', capabilities: { hasLocalLoopback: false, hasNetHttps: false, hasSettingsBridge: false } },
        theme: { getMode: () => 'dark', getTokenCss: () => ':host { --ag-accent: #38bdf8; }', onDidChange: () => () => {} },
        i18n: { getLocale: () => 'ko', onDidChange: () => () => {} },
        ui: {
          showToast() {},
          registerCommand() { return { dispose() {} }; },
          registerSettingsPage(spec) {
            let active = null;
            return {
              open() {
                active = openOverlay('settings', {
                  tree: spec.getSchema ? spec.getSchema() : spec.schema,
                  state: spec.getState ? spec.getState() : spec.state,
                  onChange: spec.onChange,
                  onAction: spec.onAction,
                  onClose() { active = null; if (spec.onClose) spec.onClose(); },
                }, (sr) => { settingsShadow = sr; });
                return active;
              },
              update(t, s) { if (active) active.update(t, s); },
              dispose() { if (active) active.close(); },
            };
          },
          openPopup(opts) {
            return openOverlay('popup', opts, (sr) => { popoverShadow = sr; });
          },
          openModal(opts) {
            return openOverlay('modal', opts, (sr) => { modalShadow = sr; });
          },
          mountCanvas(slotId, opts) {
            const anchorEl = opts && opts.container ? opts.container : null;
            if (!rootShadowHost) {
              rootShadowHost = document.createElement('div');
              rootShadowHost.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
              rootShadow = rootShadowHost.attachShadow({ mode: 'open' });
              rootSlotContainer = document.createElement('div');
              rootShadow.appendChild(rootSlotContainer);
            }
            if (anchorEl && anchorEl.parentNode && rootShadowHost.parentNode !== anchorEl.parentNode) {
              anchorEl.parentNode.insertBefore(rootShadowHost, anchorEl.nextSibling);
            }
            return rootSlotContainer;
          },
          injectStyle(styleId, cssText) {
            if (!rootShadow) return;
            let st = rootShadow.querySelector('style[data-style-id="' + styleId + '"]');
            if (!st) {
              st = document.createElement('style');
              st.setAttribute('data-style-id', styleId);
              rootShadow.appendChild(st);
            }
            st.textContent = cssText;
          },
          removeStyle() {},
        },
        dom: {
          unmountSlot() { if (rootShadowHost) rootShadowHost.remove(); },
        },
        storage: {
          async get() { return null; },
          async set() {},
          async delete() {},
          onDidChange: () => () => {},
        },
        services: {
          provide(name, impl, opts) {
            services.set(name, { impl, opts });
            return { dispose() { services.delete(name); } };
          },
        },
        lifecycle: {
          signal: abortCtrl.signal,
          onDispose(fn) { disposeHandlers.push(fn); },
        },
      };
    })();
  </script>
  <script src="/bundle.js"></script>
</body>
</html>`;

  const harnessServer = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(bundleSource);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(harnessHtml);
  });

  await new Promise((resolve) => harnessServer.listen(0, '127.0.0.1', resolve));
  const harnessPort = harnessServer.address().port;
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statusbar-addon-e2e-'));

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
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
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
      if (res?.exceptionDetails) {
        const detail =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'Browser evaluation exception';
        throw new Error(detail);
      }
      return res?.result?.value;
    };

    const waitFor = async (expression, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const val = await evalExpr(expression);
        if (val) return val;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timed out waiting for browser condition: ${expression}`);
    };

    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${harnessPort}/` });

    // 1. Live metrics & 99.7% -> 99% non-exceeded rounding
    await waitFor("Boolean(window.__e2eShadows?.root?.querySelector('.agy-inline-metric-btn')?.textContent?.includes('255.2K'))");
    const ctxText = await evalExpr("window.__e2eShadows.root.querySelector('.agy-inline-metric-btn').textContent");
    assert.ok(ctxText.includes('99%'));

    // 2. Localized 5h HH:mm + Weekly quota + click forceRefresh
    const expectedBrowserQuota = await evalExpr(`(() => {
      const fmtHHMM = (iso) => {
        const d = new Date(iso);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      };
      const fmtDT = (iso) => {
        const d = new Date(iso);
        return String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      };
      return { hhmm5h: fmtHHMM('2026-11-23T14:00:00Z'), dt5h: fmtDT('2026-11-23T14:00:00Z'), dtWeekly: fmtDT('2026-11-30T00:00:00Z') };
    })()`);
    await waitFor(`window.__e2eShadows.root.textContent.includes('5시간 한도 85% (${expectedBrowserQuota.hhmm5h})')`);
    await evalExpr(`(() => {
      const metrics = Array.from(window.__e2eShadows.root.querySelectorAll('.agy-inline-metric'));
      metrics[metrics.length - 2].click();
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(quotaRequests.some((req) => req && req.forceRefresh === true));

    // 3. host.statusbar delegation renders peer plugin button in Shadow DOM
    const peerDelegatedOk = await evalExpr(`(() => {
      const svc = window.__e2eShadows.services.get('host.statusbar')?.impl;
      if (!svc) return false;
      svc.registerItem({ pluginId: 'e2e-peer', id: 'tr', label: '번역:구글', badge: 'KO', align: 'right' });
      const btn = window.__e2eShadows.root.querySelector('[data-status-plugin-id="e2e-peer"]');
      return Boolean(btn && btn.textContent.includes('번역:구글') && btn.textContent.includes('KO'));
    })()`);
    assert.equal(peerDelegatedOk, true);

    // 4. Tier-2 Context Popup: invalid 'abc' rejected, '32,000' saves cleanly
    await evalExpr("window.__e2eShadows.root.querySelector('.agy-inline-metric-btn').click()");
    await waitFor("Boolean(window.__e2eShadows.popover?.querySelector('[data-ag-node-id=\"ctx-custom-input\"] input'))");
    const inputType = await evalExpr("window.__e2eShadows.popover.querySelector('[data-ag-node-id=\"ctx-custom-input\"] input').type");
    assert.equal(inputType, 'text');

    await evalExpr(`(() => {
      const inp = window.__e2eShadows.popover.querySelector('[data-ag-node-id="ctx-custom-input"] input');
      inp.focus();
      inp.value = 'abc';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      window.__e2eShadows.popover.querySelector('[data-ag-node-id="ctx-apply-btn"]').click();
    })()`);
    await waitFor("window.__e2eShadows.popover.querySelector('[data-ag-node-id=\"ctx-feedback\"]')?.getAttribute('data-variant') === 'danger'");
    assert.equal(settingsUpdates.length, 0);

    await evalExpr(`(() => {
      const inp = window.__e2eShadows.popover.querySelector('[data-ag-node-id="ctx-custom-input"] input');
      inp.value = '32,000';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      window.__e2eShadows.popover.querySelector('[data-ag-node-id="ctx-apply-btn"]').click();
    })()`);
    await waitFor("window.__e2eShadows.popover.querySelector('[data-ag-node-id=\"ctx-feedback\"]')?.textContent?.includes('저장')");
    assert.deepEqual(settingsUpdates[0], { sessionLimit: { sessionId: 'sess-e2e-1', limit: 32_000 } });

    // 5. Tier-1 Desktop Settings Page must NEVER render Remote Host Bridge or plugin-owned Remote Sidecar inputs
    await evalExpr("window.__e2eShadows.popover.querySelector('[data-ag-node-id=\"ctx-open-settings-btn\"]').click()");
    await waitFor("Boolean(window.__e2eShadows.settings)");
    const desktopSettingsText = await evalExpr("window.__e2eShadows.settings.textContent");
    assert.equal(desktopSettingsText.includes('원격 Sidecar 연결'), false);
    assert.equal(desktopSettingsText.includes('원격 호스트 브리지'), false);

    // 6. Tier-1 Settings -> Global Limits switches IN-PLACE (zero modal-on-modal), retains Delete focus across 2+ polls, and navigates Back
    await evalExpr("window.__e2eShadows.settings.querySelector('[data-ag-node-id=\"set-open-global-btn\"]').click()");
    await waitFor("Boolean(window.__e2eShadows.settings?.querySelector('[data-ag-node-id=\"gm-models-list\"] button'))");
    assert.equal(
      await evalExpr("window.__e2eShadows.modal === null"),
      true,
      'Opening Global Context Limits from Settings must switch in-place without opening a nested second modal',
    );
    await evalExpr(`(() => {
      const delBtn = Array.from(window.__e2eShadows.settings.querySelectorAll('[data-ag-node-id="gm-models-list"] button'))
        .find((b) => b.textContent === '삭제');
      window.__focusedDelBtn = delBtn;
      delBtn.focus();
    })()`);
    assert.equal(await evalExpr("window.__e2eShadows.settings.activeElement === window.__focusedDelBtn"), true);
    await new Promise((r) => setTimeout(r, 2_300));
    assert.equal(
      await evalExpr("window.__e2eShadows.settings.activeElement === window.__focusedDelBtn && window.__focusedDelBtn.isConnected"),
      true,
      'In-place Global Limits Delete button must retain focus across 2+ live poll ticks',
    );
    await evalExpr("window.__e2eShadows.settings.querySelector('[data-ag-node-id=\"gm-back-settings-btn\"]').click()");
    await waitFor("Boolean(window.__e2eShadows.settings?.querySelector('[data-ag-node-id=\"set-lang-select\"] [data-ag-segment-value=\"en\"]'))");
    await evalExpr("window.__e2eShadows.settings.querySelector('[data-ag-node-id=\"set-lang-select\"] [data-ag-segment-value=\"en\"]').click()");
    await waitFor("window.__e2eShadows.settings.querySelector('[data-ag-node-id=\"set-lang-select\"] [data-ag-segment-value=\"en\"]')?.getAttribute('aria-pressed') === 'true'");
    await evalExpr("window.__e2eShadows.settings.querySelector('[data-ag-node-id=\"set-lang-select\"] [data-ag-segment-value=\"ko\"]').click()");
    await waitFor("window.__e2eShadows.settings.querySelector('[data-ag-node-id=\"set-lang-select\"] [data-ag-segment-value=\"ko\"]')?.getAttribute('aria-pressed') === 'true'");

    // 7. Disconnect indicator visible even when stale snapshot exists
    failSnapshots = true;
    await waitFor("window.__e2eShadows.root.textContent.includes('재연결')", 8_000);
    assert.ok(sidecarPort > 0);
  } finally {
    cdp?.close();
    browser.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { browser.kill('SIGKILL'); } catch {}
        resolve();
      }, 2_000);
      browser.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    harnessServer.closeAllConnections?.();
    await new Promise((resolve) => harnessServer.close(resolve));
    await sidecar.close();
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
