'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRfc6455WebSocketClient } = require('../../installer/rfc6455-client');

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || '';
}

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const hex = n.toString(16).padStart(n > 0xff ? 4 : 2, '0');
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
}

function derTlv(tag, body) {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

function generateSelfSignedTls() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algId = derTlv(0x30, Buffer.from('06082a8648ce3d040302', 'hex'));
  const ver = Buffer.from('a003020102', 'hex');
  const serialBytes = crypto.randomBytes(8);
  serialBytes[0] = (serialBytes[0] & 0x7f) | 0x01;
  const serial = derTlv(0x02, serialBytes);
  const cnAttr = derTlv(0x30, Buffer.concat([Buffer.from('0603550403', 'hex'), derTlv(0x0c, Buffer.from('localhost', 'utf8'))]));
  const name = derTlv(0x30, derTlv(0x31, cnAttr));
  const validity = derTlv(
    0x30,
    Buffer.concat([derTlv(0x17, Buffer.from('250101000000Z', 'ascii')), derTlv(0x18, Buffer.from('20500101000000Z', 'ascii'))])
  );
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = derTlv(0x30, Buffer.concat([ver, serial, algId, name, validity, name, spki]));
  const sig = crypto.sign('sha256', tbs, privateKey);
  const certDer = derTlv(0x30, Buffer.concat([tbs, algId, derTlv(0x03, Buffer.concat([Buffer.from([0x00]), sig]))]));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function loadReadmeBookmarklet() {
  const readmeMd = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const m = readmeMd.match(/javascript:\(\(\)=>\{[^\r\n]+\}\)\(\);/);
  assert.ok(m, 'README.md must contain valid single-line bookmarklet');
  return m[0].slice('javascript:'.length);
}

async function launchChromeWithCdp(chromeBin, profileDir, extraArgs = []) {
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-quic',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  );

  let stderrBuf = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DevTools URL timeout. stderr=${stderrBuf}`)), 15000);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s\r\n]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderrBuf}`));
    });
  });

  const cdpWs = createRfc6455WebSocketClient(wsUrl);
  let msgId = 0;
  const pending = new Map();
  const events = [];
  cdpWs.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
      else entry.resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  await new Promise((res, rej) => {
    cdpWs.onopen = res;
    cdpWs.onerror = rej;
  });

  const sendCdp = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
      cdpWs.send(JSON.stringify(payload));
    });

  return { proc, cdpWs, sendCdp, events };
}

async function stopChromeProcess(chrome) {
  if (!chrome) return;
  try { chrome.cdpWs?.close?.(); } catch {}
  const proc = chrome.proc;
  if (!proc) return;
  if (proc.exitCode === null && !proc.killed) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  await new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, 1500);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function cleanupProfileDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
}

describe('v2.0 Standalone Headless Chromium E2E Suite', () => {
  it('SB2-TC-011 (D-0025, D-0032, D-0034): Standalone TLS RemoteControl host w/ verbatim CSP, TrustedTypes, zero HTML sinks, promoted child iframe, host-marker companion load, RC hook coexistence, debug modal & cleanup', async (t) => {
    const chromeBin = findChromeExecutable();
    if (!chromeBin) {
      t.skip('No local Chromium/Edge binary available');
      return;
    }

    const builtBundle = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'statusbar_autoinject.js'), 'utf8');
    const bookmarkletExpr = loadReadmeBookmarklet();
    const tlsOpts = generateSelfSignedTls();
    const hostNonce = '6MrTi0i9YKUcbrCAvGN0sg';

    const hostServer = https.createServer(tlsOpts, (req, res) => {
      const u = new URL(req.url, 'https://antigravity.google.com');
      if (u.pathname === '/_/GoogleAntigravity/cspreport') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (u.pathname === '/child-frame.html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html><body><div id="inner-child" data-testid="conversation-view" data-cascade-id="547d3ff8-7d19-415f-a68a-9bbf28c06f5f"><div data-testid="agent-input-box"><div>child input</div></div></div></body></html>');
        return;
      }
      if (u.pathname === '/r/style-nonce-only') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', [
          `script-src 'nonce-${hostNonce}';style-src 'nonce-${hostNonce}';connect-src *;worker-src 'self'`,
          "require-trusted-types-for 'script'",
        ]);
        res.end(`<!doctype html><html><head><style nonce="${hostNonce}">body{margin:0}</style></head><body><div id="style-only">ok</div></body></html>`);
        return;
      }

      const cspHeaders = [
        `script-src 'report-sample' 'nonce-${hostNonce}' 'unsafe-inline';object-src 'none';base-uri 'self';report-uri /_/GoogleAntigravity/cspreport;worker-src 'self'`,
        "require-trusted-types-for 'script';report-uri /_/GoogleAntigravity/cspreport",
      ];
      if (u.pathname.includes('strict-tt-block-all')) {
        cspHeaders.push('trusted-types ogb-qtm#html');
      } else if (u.pathname.includes('strict-tt-preflight')) {
        cspHeaders.push('trusted-types ogb-qtm#html agy-sb-bm');
      }
      if (u.searchParams.get('styleNonce') === '1') {
        cspHeaders.push(`style-src-elem 'nonce-${hostNonce}'`);
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', cspHeaders);
      res.end(`<!doctype html><html><head>
        <script nonce="${hostNonce}">
          window.__e2eCspViolations = [];
          window.__e2eErrors = [];
          window.__AGY_STATUSBAR_HOST_CONFIG__ = {
            companionScripts: [
              'https://raw.githubusercontent.com/jaeseongs95/antigravity-mcp-manager/main/dist/mcp_manager_autoinject.js',
            ],
          };
          document.addEventListener('securitypolicyviolation', (e) => {
            window.__e2eCspViolations.push(e.violatedDirective + ':' + e.blockedURI);
          });
          window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message || e)));
          window.addEventListener('unhandledrejection', (e) => window.__e2eErrors.push(String(e.reason || e)));
        </script>
      </head><body>
        <ga-remote-control>
          <div class="app-container">
            <iframe src="https://antigravity.static.usercontent.goog/web/child.html" style="width:100%;height:300px;border:0"></iframe>
          </div>
        </ga-remote-control>
        <script nonce="${hostNonce}">
          const dec = new TextDecoder();
          const enc = (obj) => ({ payload: new TextEncoder().encode(JSON.stringify(obj)) });
          window.__nativeOnLoadCalls = 0;
          class RemoteControlComponent {
            constructor(ifr) { this.iframe = ifr; }
            onIframeLoad() { window.__nativeOnLoadCalls += 1; }
            async proxyCommand(rpcPath) {
              if (rpcPath.endsWith('/GetAllCascadeTrajectories')) {
                return enc({ trajectorySummaries: { '547d3ff8-7d19-415f-a68a-9bbf28c06f5f': { stepCount: 12, lastModifiedTime: '2026-11-18T12:00:00Z' } } });
              }
              if (rpcPath.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
                return enc({
                  generatorMetadata: [{
                    stepIndices: [11],
                    chatModel: {
                      modelDisplayName: 'Claude Sonnet <V2>',
                      chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 189440, maxContextTokens: 256000 } },
                      usage: { inputTokens: 3800, cacheReadTokens: 185640, outputTokens: 1200 },
                    },
                  }],
                });
              }
              if (rpcPath.endsWith('/RetrieveUserQuotaSummary')) {
                return enc({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ modelOrAlias: { choice: { case: 'model', value: 'MODEL_CLAUDE_3_7_SONNET' } }, quotaInfo: { remainingFraction: 0.91 } }] } } });
              }
              return enc({});
            }
          }
          const origWrap = RemoteControlComponent.prototype.onIframeLoad;
          RemoteControlComponent.prototype.onIframeLoad = function () {
            if (this.__agySuppressAutoIframeLoad) return;
            return origWrap.apply(this, arguments);
          };
          const inst = new RemoteControlComponent(document.querySelector('ga-remote-control iframe'));
          inst.__agySuppressAutoIframeLoad = true;
          window.__agyRemoteControlInstance = inst;
        </script>
      </body></html>`);
    });

    const cdnServer = https.createServer(tlsOpts, (req, res) => {
      const u = new URL(req.url, 'https://localhost');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (u.pathname.endsWith('/statusbar_autoinject.js')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(builtBundle);
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body><div>static child</div></body></html>');
    });

    await new Promise((r) => hostServer.listen(0, '127.0.0.1', r));
    await new Promise((r) => cdnServer.listen(0, '127.0.0.1', r));
    const hostPort = hostServer.address().port;
    const cdnPort = cdnServer.address().port;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sb2-chrome-'));
    let chrome = null;

    try {
      chrome = await launchChromeWithCdp(chromeBin, profileDir, [
        '--ignore-certificate-errors',
        `--host-resolver-rules=MAP antigravity.google.com 127.0.0.1:${hostPort},MAP antigravity.static.usercontent.goog 127.0.0.1:${cdnPort},MAP raw.githubusercontent.com 127.0.0.1:${cdnPort}`,
      ]);
      const { sendCdp } = chrome;
      const { targetInfos } = await sendCdp('Target.getTargets');
      const pageTarget = targetInfos.find((ti) => ti.type === 'page');
      const { sessionId } = await sendCdp('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
      await sendCdp('Page.enable', {}, sessionId);
      await sendCdp('Runtime.enable', {}, sessionId);

      // Rewrite target ports in bookmarklet origin via Fetch interception only on 443 -> hostPort/cdnPort not needed when host-resolver handles host:port? Wait: Chromium ignores port in MAP when URL has default 443, so route via Fetch!
      await sendCdp(
        'Fetch.enable',
        { patterns: [{ urlPattern: 'https://raw.githubusercontent.com/*', requestStage: 'Request' }] },
        sessionId
      );
      const requestedRawUrls = [];
      const prevOnMsg = chrome.cdpWs.onmessage;
      chrome.cdpWs.onmessage = (ev) => {
        prevOnMsg(ev);
        const msg = JSON.parse(String(ev.data));
        if (msg.method === 'Fetch.requestPaused') {
          const reqUrl = String(msg.params?.request?.url || '');
          requestedRawUrls.push(reqUrl);
          const payload = reqUrl.includes('mcp_manager_autoinject.js')
            ? '// === BEGIN_AGY_MCP_MANAGER ===\nwindow.__agyCompanionMarkerLoaded = (window.__agyCompanionMarkerLoaded || 0) + 1;\n// === END_AGY_MCP_MANAGER ===\n'
            : builtBundle;
          sendCdp(
            'Fetch.fulfillRequest',
            {
              requestId: msg.params.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
                { name: 'Access-Control-Allow-Origin', value: '*' },
              ],
              body: Buffer.from(payload, 'utf8').toString('base64'),
            },
            sessionId
          ).catch(() => {});
        }
      };

      // Navigate with explicit local hostPort for hostServer
      await sendCdp('Page.navigate', { url: `https://antigravity.google.com:${hostPort}/r/session-1-v2?styleNonce=1` }, sessionId);
      for (let i = 0; i < 60; i++) {
        const ready = await sendCdp('Runtime.evaluate', { expression: 'document.readyState === "complete"', returnByValue: true }, sessionId);
        if (ready?.result?.value === true) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const bmRes = await sendCdp('Runtime.evaluate', { expression: bookmarkletExpr, returnByValue: true }, sessionId);
      assert.equal(bmRes.exceptionDetails, undefined, 'Bookmarklet eval must not throw');

      let snap = null;
      for (let i = 0; i < 120; i++) {
        const r = await sendCdp(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const bar = document.querySelector('.agy-ctx-statusbar');
              if (!bar || !bar.textContent.includes('98%')) return null;
              window.__agyRemoteControlInstance.onIframeLoad();
              return {
                text: bar.textContent,
                version: window.agyStatusBar?.version || '',
                locale: window.agyStatusBar?.getLocale?.() || '',
                nativeCalls: window.__nativeOnLoadCalls,
                busPlugin: Boolean(window[Symbol.for('agy.plugin.bus.v2')]?.getPlugin?.('antigravity-statusbar')),
                csp: window.__e2eCspViolations || [],
                err: window.__e2eErrors || [],
              };
            })()`,
            returnByValue: true,
          },
          sessionId
        );
        if (r?.result?.value) {
          snap = r.result.value;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(snap, 'Statusbar must mount and display cache 98% telemetry in live Chrome');
      assert.equal(snap.version, '2.0.0');
      assert.equal(snap.locale, 'en');
      assert.equal(snap.nativeCalls, 0, 'D-0034: existing RC hook suppression guard must remain active');
      assert.equal(snap.busPlugin, true);
      assert.deepEqual(snap.csp, []);
      assert.deepEqual(snap.err, []);

      // Verify host-config + marker-based companion load under strict CSP/TrustedTypes (only configured companion loads)
      let companionCount = 0;
      for (let i = 0; i < 60; i++) {
        const cr = await sendCdp(
          'Runtime.evaluate',
          { expression: 'Number(window.__agyCompanionMarkerLoaded || 0)', returnByValue: true },
          sessionId
        );
        companionCount = Number(cr?.result?.value || 0);
        if (companionCount >= 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(companionCount, 1, 'Configured marker companion must load once via TrustedTypes + nonce');
      assert.equal(requestedRawUrls.some((u) => u.includes('mcp_manager_autoinject.js')), true);
      assert.equal(requestedRawUrls.some((u) => u.includes('ko_thought_autoinject.js')), false, 'Unconfigured companion must never be fetched');

      // Simulate sibling/host promotion of cross-origin child iframe -> same-origin /child-frame.html and verify child mount
      await sendCdp(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const ifr = document.querySelector('ga-remote-control iframe');
            if (ifr) ifr.src = '/child-frame.html';
          })()`,
          returnByValue: true,
        },
        sessionId
      );
      let childBarSnap = null;
      for (let i = 0; i < 100; i++) {
        const cr = await sendCdp(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const ifr = document.querySelector('ga-remote-control iframe');
              const cDoc = ifr?.contentDocument;
              const childBar = cDoc?.querySelector?.('.agy-ctx-statusbar');
              if (!childBar || !childBar.textContent.includes('98%')) return null;
              return {
                text: childBar.textContent,
                hasChildStyle: Boolean(cDoc.getElementById('agy-ctx-statusbar-style')),
                csp: window.__e2eCspViolations || [],
                err: window.__e2eErrors || [],
              };
            })()`,
            returnByValue: true,
          },
          sessionId
        );
        if (cr?.result?.value) {
          childBarSnap = cr.result.value;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(childBarSnap, 'Promoted same-origin child iframe must mount .agy-ctx-statusbar with live 98% telemetry');
      assert.equal(childBarSnap.hasChildStyle, true);
      assert.deepEqual(childBarSnap.csp, []);
      assert.deepEqual(childBarSnap.err, []);

      // 3-plugin coexistence check: verify another RC-prototype wrapper coexists and StatusBar survives mid-chain removal
      const threePluginSnap = (
        await sendCdp(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const RC = window.__agyRemoteControlInstance?.constructor;
              if (!RC || !RC.prototype) return { ok: false };
              const prevProxy = RC.prototype.proxyCommand;
              let callsA = 0;
              RC.prototype.proxyCommand = function (...args) {
                callsA += 1;
                return prevProxy.apply(this, args);
              };
              const callsCheck = window.__agyRemoteControlInstance.proxyCommand('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', new Uint8Array(0));
              return Promise.resolve(callsCheck).then(() => {
                RC.prototype.proxyCommand = prevProxy;
                return { ok: true, callsA };
              });
            })()`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId
        )
      )?.result?.value;
      assert.equal(threePluginSnap.ok, true);
      assert.equal(threePluginSnap.callsA, 1);

      // Open debug modal, toggle locale to ko, verify, then clean up cleanly
      const modalSnap = (
        await sendCdp(
          'Runtime.evaluate',
          {
            expression: `(async () => {
              window.agyStatusBar.setLocale('ko');
              await window.agyStatusBar.openDebugModal();
              await new Promise((r) => setTimeout(r, 120));
              const modalText = document.getElementById('agy-ctx-debug-modal')?.textContent || '';
              const ifrDoc = document.querySelector('ga-remote-control iframe')?.contentDocument;
              window.__agyStatusBarCleanup();
              return {
                hasModalTitle: modalText.includes('Trajectory & Context Debug View'),
                hasClaudeText: modalText.includes('Claude Sonnet <V2>'),
                barAfterCleanup: Boolean(document.querySelector('.agy-ctx-statusbar')),
                modalAfterCleanup: Boolean(document.getElementById('agy-ctx-debug-modal')),
                styleAfterCleanup: Boolean(document.getElementById('agy-ctx-statusbar-style')),
                childBarAfterCleanup: Boolean(ifrDoc?.querySelector?.('.agy-ctx-statusbar')),
                childStyleAfterCleanup: Boolean(ifrDoc?.getElementById?.('agy-ctx-statusbar-style')),
                csp: window.__e2eCspViolations || [],
                err: window.__e2eErrors || [],
              };
            })()`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId
        )
      )?.result?.value;

      assert.equal(modalSnap.hasModalTitle, true);
      assert.equal(modalSnap.hasClaudeText, true, 'Model name with HTML chars must render safely as text');
      assert.equal(modalSnap.barAfterCleanup, false);
      assert.equal(modalSnap.modalAfterCleanup, false);
      assert.equal(modalSnap.styleAfterCleanup, false);
      assert.equal(modalSnap.childBarAfterCleanup, false, 'Promoted child iframe statusbar must be removed on cleanup');
      assert.equal(modalSnap.childStyleAfterCleanup, false, 'Promoted child iframe style must be removed on cleanup');
      assert.deepEqual(modalSnap.csp, []);
      assert.deepEqual(modalSnap.err, []);

      // Graceful failure on denied trusted-types allowlist (strict-tt-block-all)
      await sendCdp('Page.navigate', { url: `https://antigravity.google.com:${hostPort}/r/strict-tt-block-all-v2` }, sessionId);
      for (let i = 0; i < 40; i++) {
        const ready = await sendCdp('Runtime.evaluate', { expression: 'document.readyState === "complete"', returnByValue: true }, sessionId);
        if (ready?.result?.value === true) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await sendCdp('Runtime.evaluate', { expression: bookmarkletExpr, returnByValue: true }, sessionId);
      await new Promise((r) => setTimeout(r, 250));
      const blockedSnap = (
        await sendCdp('Runtime.evaluate', { expression: '({ mounted: Boolean(window.agyStatusBar), err: window.__e2eErrors || [] })', returnByValue: true }, sessionId)
      )?.result?.value;
      assert.equal(blockedSnap.mounted, false);
      assert.deepEqual(blockedSnap.err, []);
    } finally {
      await stopChromeProcess(chrome);
      cleanupProfileDir(profileDir);
      await new Promise((r) => hostServer.close(r));
      await new Promise((r) => cdnServer.close(r));
    }
  });

  it('SB2-TC-012 (AUDIT-M5): Live unauthenticated https://antigravity.google.com/r/00000000-0000-0000-0000-000000000000-v2 CSP & nonce smoke test', async (t) => {
    const chromeBin = findChromeExecutable();
    if (!chromeBin) {
      t.skip('No local Chromium/Edge binary available');
      return;
    }

    const builtBundle = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'statusbar_autoinject.js'), 'utf8');
    const bookmarkletExpr = loadReadmeBookmarklet();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sb2-live-'));
    let chrome = null;

    try {
      chrome = await launchChromeWithCdp(chromeBin, profileDir);
      const { sendCdp } = chrome;
      const { targetInfos } = await sendCdp('Target.getTargets');
      const pageTarget = targetInfos.find((ti) => ti.type === 'page');
      const { sessionId } = await sendCdp('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
      await sendCdp('Page.enable', {}, sessionId);
      await sendCdp('Runtime.enable', {}, sessionId);

      let servedRaw = 0;
      const prevOnMsg = chrome.cdpWs.onmessage;
      chrome.cdpWs.onmessage = (ev) => {
        prevOnMsg(ev);
        const msg = JSON.parse(String(ev.data));
        if (msg.method === 'Fetch.requestPaused') {
          servedRaw += 1;
          sendCdp(
            'Fetch.fulfillRequest',
            {
              requestId: msg.params.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
                { name: 'Access-Control-Allow-Origin', value: '*' },
              ],
              body: Buffer.from(builtBundle, 'utf8').toString('base64'),
            },
            sessionId
          ).catch(() => {});
        }
      };
      await sendCdp(
        'Fetch.enable',
        { patterns: [{ urlPattern: 'https://raw.githubusercontent.com/jaeseongs95/*', requestStage: 'Request' }] },
        sessionId
      );

      await sendCdp('Page.navigate', { url: 'https://antigravity.google.com/r/00000000-0000-0000-0000-000000000000-v2' }, sessionId);
      let loaded = false;
      for (let i = 0; i < 100; i++) {
        const r = await sendCdp(
          'Runtime.evaluate',
          { expression: 'document.readyState === "complete" && location.href.startsWith("https://antigravity.google.com/")', returnByValue: true },
          sessionId
        );
        if (r?.result?.value === true) {
          loaded = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!loaded) {
        t.skip('Live antigravity.google.com unreachable in current network environment');
        return;
      }

      await sendCdp(
        'Runtime.evaluate',
        {
          expression: `(() => {
            window.__liveSbCsp = [];
            window.__liveSbErr = [];
            document.addEventListener('securitypolicyviolation', (e) => window.__liveSbCsp.push(e.violatedDirective + ':' + (e.blockedURI || '')));
            window.addEventListener('error', (e) => window.__liveSbErr.push(String(e?.message || e)));
            window.addEventListener('unhandledrejection', (e) => window.__liveSbErr.push(String(e?.reason || e)));
          })()`,
          returnByValue: true,
        },
        sessionId
      );

      const bmRes = await sendCdp('Runtime.evaluate', { expression: bookmarkletExpr, returnByValue: true }, sessionId);
      assert.equal(bmRes.exceptionDetails, undefined);

      for (let i = 0; i < 60; i++) {
        const r = await sendCdp(
          'Runtime.evaluate',
          { expression: 'Boolean(window.agyStatusBar && typeof window.__agyStatusBarCleanup === "function")', returnByValue: true },
          sessionId
        );
        if (r?.result?.value === true) break;
        await new Promise((r) => setTimeout(r, 80));
      }

      const liveSnap = (
        await sendCdp(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const liveNonce = [...document.querySelectorAll('script,style,link')].find((e) => e.nonce)?.nonce || '';
              const styleEl = document.getElementById('agy-ctx-statusbar-style');
              const styleNonce = styleEl ? (styleEl.nonce || styleEl.getAttribute('nonce') || '') : '';
              const sbVersion = window.agyStatusBar?.version || '';
              window.__agyStatusBarCleanup?.();
              return {
                href: location.href,
                sbVersion,
                liveNonceLen: liveNonce.length,
                liveNonce,
                styleNonce,
                hasStyle: Boolean(styleEl),
                styleAfterCleanup: Boolean(document.getElementById('agy-ctx-statusbar-style')),
                cspViolations: window.__liveSbCsp || [],
                runtimeErrors: window.__liveSbErr || [],
              };
            })()`,
            returnByValue: true,
          },
          sessionId
        )
      )?.result?.value;

      assert.equal(servedRaw, 1);
      assert.equal(liveSnap.sbVersion, '2.0.0');
      assert.ok(liveSnap.liveNonceLen >= 8);
      assert.equal(liveSnap.hasStyle, true);
      assert.equal(liveSnap.styleNonce, liveSnap.liveNonce);
      assert.equal(liveSnap.styleAfterCleanup, false);
      assert.deepEqual(liveSnap.cspViolations, []);
      assert.deepEqual(liveSnap.runtimeErrors, []);
    } finally {
      await stopChromeProcess(chrome);
      cleanupProfileDir(profileDir);
    }
  });
});
