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

test('TC-P0-02 (ISS-01, ISS-02, ISS-10): real Headless Chromium Shadow DOM E2E verifies badInput non-reset, 99.7% rounding, modal focus stability across polls, Escape focus return, and disconnect indicator', async (t) => {
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

  const harnessHtml = `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>Addon Shadow DOM E2E Harness</title></head>
<body>
  <div data-cascade-id="sess-e2e-1" style="margin-top: 320px;">
    <div data-testid="agent-input-box" style="width: 720px; height: 60px; border: 1px solid #444;">
      <textarea aria-label="Chat input"></textarea>
    </div>
  </div>
  <script>
    (function() {
      const disposeHandlers = [];
      let rootShadowHost = null;
      let rootShadow = null;
      let rootSlotContainer = null;
      let popoverHost = null;
      let popoverShadow = null;
      let modalDialog = null;
      let modalShadow = null;

      window.__e2eShadows = {
        get root() { return rootShadow; },
        get popover() { return popoverShadow; },
        get modal() { return modalShadow; },
      };

      window.addonHost = {
        schemaVersion: 2,
        pluginId: 'antigravity-statusbar',
        mountSlot(slotId, opts) {
          const anchorEl = opts && opts.container ? opts.container : opts;
          if (!rootShadowHost) {
            rootShadowHost = document.createElement('div');
            rootShadowHost.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
            rootShadowHost.setAttribute('data-slot-id', slotId);
            rootShadow = rootShadowHost.attachShadow({ mode: 'open' });
            rootSlotContainer = document.createElement('div');
            rootShadow.appendChild(rootSlotContainer);
          }
          if (anchorEl && anchorEl.parentNode && rootShadowHost.parentNode !== anchorEl.parentNode) {
            anchorEl.parentNode.insertBefore(rootShadowHost, anchorEl.nextSibling);
          } else if (anchorEl && !anchorEl.parentNode) {
            document.body.appendChild(rootShadowHost);
          }
          return rootSlotContainer;
        },
        unmountSlot() {
          if (rootShadowHost && rootShadowHost.parentNode) rootShadowHost.remove();
        },
        injectStyle(styleId, cssText, opts) {
          const slotId = opts && opts.slotId;
          const target = slotId === 'antigravity-statusbar.popover'
            ? popoverShadow
            : slotId === 'antigravity-statusbar.global-limit-modal'
              ? modalShadow
              : rootShadow || document.head;
          if (!target) return;
          let st = target.querySelector('style[data-style-id="' + styleId + '"]');
          if (!st) {
            st = document.createElement('style');
            st.setAttribute('data-style-id', styleId);
            target.appendChild(st);
          }
          st.textContent = cssText;
        },
        removeStyle() {},
        openPopover(slotId, opts) {
          if (popoverHost) popoverHost.remove();
          popoverHost = document.createElement('div');
          popoverHost.setAttribute('popover', 'manual');
          popoverHost.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
          popoverHost.style.position = 'fixed';
          popoverShadow = popoverHost.attachShadow({ mode: 'open' });
          const bodyEl = document.createElement('div');
          popoverShadow.appendChild(bodyEl);
          document.body.appendChild(popoverHost);
          if (typeof popoverHost.showPopover === 'function') {
            try { popoverHost.showPopover(); } catch {}
          }
          return {
            element: popoverHost,
            bodyEl,
            close() {
              if (popoverHost) {
                try { popoverHost.hidePopover(); } catch {}
                popoverHost.remove();
                popoverHost = null;
                popoverShadow = null;
              }
              if (opts && typeof opts.onClose === 'function') opts.onClose();
            },
          };
        },
        openModal(slotId, opts) {
          if (modalDialog) modalDialog.remove();
          modalDialog = document.createElement('dialog');
          modalDialog.setAttribute('data-addon-host-owner', 'antigravity-statusbar');
          const modalHost = document.createElement('div');
          modalDialog.appendChild(modalHost);
          modalShadow = modalHost.attachShadow({ mode: 'open' });
          const bodyEl = document.createElement('div');
          modalShadow.appendChild(bodyEl);
          document.body.appendChild(modalDialog);
          modalDialog.addEventListener('close', () => {
            if (modalDialog) {
              modalDialog.remove();
              modalDialog = null;
              modalShadow = null;
            }
            if (opts && typeof opts.onClose === 'function') opts.onClose();
          });
          if (typeof modalDialog.showModal === 'function') {
            try { modalDialog.showModal(); } catch {}
          }
          return {
            element: modalDialog,
            bodyEl,
            close() {
              if (modalDialog) {
                try { modalDialog.close(); } catch {}
                modalDialog.remove();
                modalDialog = null;
                modalShadow = null;
              }
            },
          };
        },
        onDispose(fn) { disposeHandlers.push(fn); },
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

    // 1. Wait for inline bar in Shadow DOM to render live metrics
    await waitFor("Boolean(window.__e2eShadows?.root?.querySelector('.agy-inline-metric-btn')?.textContent?.includes('255.2K'))");

    // Verify 99.7% non-exceeded displays 99% (not 100%)
    const ctxText = await evalExpr("window.__e2eShadows.root.querySelector('.agy-inline-metric-btn').textContent");
    assert.ok(ctxText.includes('99%'), `Expected 99% for non-exceeded 99.7%, got "${ctxText}"`);

    // Verify 5h (with localized HH:mm reset time) + Weekly quota labels and localized tooltip rendered in Shadow DOM
    const expectedBrowserQuota = await evalExpr(`(() => {
      const fmtHHMM = (iso) => {
        const d = new Date(iso);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      };
      const fmtDT = (iso) => {
        const d = new Date(iso);
        return (
          String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
          String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        );
      };
      return {
        hhmm5h: fmtHHMM('2026-11-23T14:00:00Z'),
        dt5h: fmtDT('2026-11-23T14:00:00Z'),
        dtWeekly: fmtDT('2026-11-30T00:00:00Z'),
      };
    })()`);
    await waitFor(
      `window.__e2eShadows.root.textContent.includes('5시간 한도 85% (${expectedBrowserQuota.hhmm5h})') && window.__e2eShadows.root.textContent.includes('주간한도 60%')`,
    );
    const quotaTooltip = await evalExpr(`(() => {
      const metrics = Array.from(window.__e2eShadows.root.querySelectorAll('.agy-inline-metric'));
      return metrics[metrics.length - 2]?.title || '';
    })()`);
    assert.ok(
      quotaTooltip.includes(`초기화 ${expectedBrowserQuota.dt5h}`) &&
        quotaTooltip.includes(`초기화 ${expectedBrowserQuota.dtWeekly}`),
      `Expected localized quota tooltip in Shadow DOM, got "${quotaTooltip}"`,
    );
    assert.equal(
      quotaTooltip.includes('2026-11-23T14:00:00Z') || quotaTooltip.includes('2026-11-30T00:00:00Z'),
      false,
      `Shadow DOM quota tooltip must not expose raw UTC ISO strings, got "${quotaTooltip}"`,
    );

    // Click 5h quota metric in Shadow DOM -> triggers forceRefresh: true request to /api/quota
    await evalExpr(`(() => {
      const metrics = Array.from(window.__e2eShadows.root.querySelectorAll('.agy-inline-metric'));
      metrics[metrics.length - 2].click();
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      quotaRequests.some((req) => req && req.forceRefresh === true),
      `Clicking 5h quota must send forceRefresh: true, got ${JSON.stringify(quotaRequests)}`,
    );

    // Verify window.statusbarAddons is non-writable (P1)
    const writableDesc = await evalExpr("Object.getOwnPropertyDescriptor(window, 'statusbarAddons')?.writable");
    assert.equal(writableDesc, false, 'window.statusbarAddons must be non-writable');

    // 2. ISS-01: Open popover, inspect customInput.type === 'text', enter 'abc' -> must NOT silently reset limit to null!
    await evalExpr("window.__e2eShadows.root.querySelector('.agy-inline-metric-btn').click()");
    await waitFor("Boolean(window.__e2eShadows.popover?.querySelector('.agy-inline-pop-input'))");

    const inputType = await evalExpr("window.__e2eShadows.popover.querySelector('.agy-inline-pop-input').type");
    assert.equal(inputType, 'text', 'Popover custom limit input must use type="text" to prevent Chromium badInput empty-string silent reset');

    await evalExpr(`(() => {
      const inp = window.__e2eShadows.popover.querySelector('.agy-inline-pop-input');
      inp.focus();
      inp.value = 'abc';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const applyBtn = Array.from(window.__e2eShadows.popover.querySelectorAll('button')).find((b) => b.textContent === '적용');
      applyBtn.click();
    })()`);
    await waitFor("window.__e2eShadows.popover.querySelector('.agy-inline-pop-feedback')?.classList.contains('err')");
    assert.equal(settingsUpdates.length, 0, 'Invalid input "abc" must NOT trigger settings update or silent reset to null');

    // Enter '32,000' -> must save 32000 cleanly!
    await evalExpr(`(() => {
      const inp = window.__e2eShadows.popover.querySelector('.agy-inline-pop-input');
      inp.value = '32,000';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const applyBtn = Array.from(window.__e2eShadows.popover.querySelectorAll('button')).find((b) => b.textContent === '적용');
      applyBtn.click();
    })()`);
    await waitFor("window.__e2eShadows.popover.querySelector('.agy-inline-pop-feedback')?.textContent?.includes('저장')");
    assert.deepEqual(settingsUpdates[0], { sessionLimit: { sessionId: 'sess-e2e-1', limit: 32_000 } });

    // 2b. Desktop Settings tab must NOT render or display Remote Sidecar Connection card in real Chromium Shadow DOM
    await evalExpr(`(() => {
      const settingsTab = Array.from(window.__e2eShadows.popover.querySelectorAll('button[role="tab"]'))
        .find((b) => b.textContent === '설정');
      settingsTab.click();
    })()`);
    await waitFor("Array.from(window.__e2eShadows.popover.querySelectorAll('button[role=\"tab\"]')).find((b) => b.textContent === '설정')?.getAttribute('aria-selected') === 'true'");
    const desktopSettingsText = await evalExpr("window.__e2eShadows.popover.textContent");
    assert.equal(
      desktopSettingsText.includes('원격 Sidecar 연결'),
      false,
      `Desktop Settings tab must NEVER render Remote Sidecar Connection card, got "${desktopSettingsText}"`,
    );

    // 3. ISS-10: Open Global Limit Modal, focus model Delete button, wait >2.2s across live polls -> focus MUST stay on the same button!
    await evalExpr(`(() => {
      const btn = Array.from(window.__e2eShadows.popover.querySelectorAll('button')).find((b) => b.textContent.includes('전역'));
      btn.click();
    })()`);
    await waitFor("Boolean(window.__e2eShadows.modal?.querySelector('.agy-inline-pop-list button'))");

    await evalExpr(`(() => {
      const delBtn = Array.from(window.__e2eShadows.modal.querySelectorAll('.agy-inline-pop-list button')).find((b) => b.textContent === '삭제');
      window.__focusedDelBtn = delBtn;
      delBtn.focus();
    })()`);
    const focusedBefore = await evalExpr("window.__e2eShadows.modal.activeElement === window.__focusedDelBtn");
    assert.equal(focusedBefore, true);

    await new Promise((r) => setTimeout(r, 2_300));
    const focusedAfterPolls = await evalExpr("window.__e2eShadows.modal.activeElement === window.__focusedDelBtn && window.__focusedDelBtn.isConnected");
    assert.equal(focusedAfterPolls, true, 'Modal model list Delete button must retain focus across 2+ poll ticks');

    // Close modal via native dialog Escape/close -> focus returns to visible settings button on the bar
    await evalExpr(`(() => {
      const dlg = document.querySelector('dialog[data-addon-host-owner="antigravity-statusbar"]');
      dlg.close();
    })()`);
    await waitFor("!window.__e2eShadows.modal");
    const focusedBackOnBar = await evalExpr("window.__e2eShadows.root.activeElement === window.__e2eShadows.root.querySelector('button[aria-label=\"상태바\"]')");
    assert.equal(focusedBackOnBar, true, 'Closing modal must restore focus to visible bar settings button');

    // 4. ISS-10: Disconnect indicator visible even when stale snapshot exists
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
