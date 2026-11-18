'use strict';

/**
 * Live CDP Target & Browser WebSocket Injector.
 */

const fs = require('fs');
const http = require('http');
const { assertLoopbackWsUrl, openCdpWebSocket } = require('./rfc6455-client');
const { sha256Hex } = require('./asar-codec');

function readDevToolsEndpoint(devToolsPortFile) {
  try {
    if (!devToolsPortFile || !fs.existsSync(devToolsPortFile)) return null;
    const lines = fs.readFileSync(devToolsPortFile, 'utf8').trim().split(/\r?\n/);
    const port = parseInt(lines[0], 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    const rawWsLine = (lines[1] || '').trim();
    const browserWsUrl = rawWsLine
      ? rawWsLine.startsWith('ws://') || rawWsLine.startsWith('wss://')
        ? rawWsLine
        : `ws://127.0.0.1:${port}${rawWsLine.startsWith('/') ? rawWsLine : `/${rawWsLine}`}`
      : null;
    if (browserWsUrl) {
      assertLoopbackWsUrl(browserWsUrl);
    }
    return { port, browserWsUrl };
  } catch {
    return null;
  }
}

function readDevToolsPort(devToolsPortFile) {
  const ep = readDevToolsEndpoint(devToolsPortFile);
  return ep ? ep.port : null;
}

function httpGetJson(port, reqPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('HTTP timeout'));
    });
  });
}

function detectBundledPlugins(scriptCode) {
  const text = typeof scriptCode === 'string' ? scriptCode : '';
  const expectsStatusbar =
    /^(?:\/\/ @name[ \t]+Antigravity Custom Statusbar\b|\/\/ === BEGIN_AGY_STATUSBAR(?:_V\d+)? ===|\/\* === BEGIN_AGY_STATUSBAR(?:_V\d+)? === \*\/|[ \t]*function\s+mountStatusBar\s*\()/m.test(
      text
    );
  const expectsMcp =
    /^(?:\/\/ @name[ \t]+Antigravity Custom MCP Server Manager\b|\/\/ === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? ===|\/\* === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? === \*\/|[ \t]*function\s+mountMcpManager\s*\()/m.test(
      text
    );
  const expectsKo =
    /^(?:\/\/ @name[ \t]+Antigravity Korean Thought & UI Translator\b|\/\/ === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? ===|\/\* === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? === \*\/|[ \t]*window\.__agyKoThoughtCleanup\s*=)/m.test(
      text
    );
  return { expectsStatusbar, expectsMcp, expectsKo };
}

function buildImmediateEvalExpression(scriptCode, scriptHash) {
  const { expectsStatusbar, expectsMcp, expectsKo } = detectBundledPlugins(scriptCode);
  const activeChecks = [];
  if (expectsStatusbar) {
    activeChecks.push('Boolean(window.agyStatusBar && typeof window.__agyStatusBarCleanup === "function")');
  }
  if (expectsMcp) {
    activeChecks.push('Boolean(window.agyMcpManager && typeof window.agyMcpManager.destroy === "function")');
  }
  if (expectsKo) {
    activeChecks.push('Boolean(typeof window.__agyKoThoughtCleanup === "function" || window.__agyKoLocalizerActive)');
  }
  const activeGuardExpr = activeChecks.length > 0 ? activeChecks.join(' && ') : 'false';
  return `(() => {
      const hasActivePlugin = ${activeGuardExpr};
      if (hasActivePlugin && window.__agyStatusBarHash === ${JSON.stringify(scriptHash)}) {
        return 'ALREADY_ACTIVE';
      }
      ${scriptCode}
      window.__agyStatusBarHash = ${JSON.stringify(scriptHash)};
      return 'INJECTED_OK';
    })()`;
}

function isInjectablePageTarget(t) {
  if (!t || t.type !== 'page') return false;
  const u = String(t.url || '');
  return (
    !u.startsWith('devtools://') &&
    !u.startsWith('chrome-devtools://') &&
    !u.startsWith('data:') &&
    !u.startsWith('about:')
  );
}

function configureTargetViaCdp(wsUrl, scriptCode, scriptHash, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = openCdpWebSocket(wsUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error('WebSocket evaluation timeout'));
    }, timeoutMs);

    const immediateExpr = buildImmediateEvalExpression(scriptCode, scriptHash);

    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: immediateExpr,
              returnByValue: true,
            },
          })
        );
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          reject(err);
        }
      }
    };

    ws.onmessage = (event) => {
      if (settled) return;
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (msg.id === 1) {
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          if (msg.error) {
            reject(new Error(msg.error.message || 'CDP Runtime.evaluate error'));
            return;
          }
          if (msg?.result?.exceptionDetails) {
            const det = msg.result.exceptionDetails;
            const desc = det?.exception?.description || det?.text || 'CDP Runtime.evaluate exception';
            reject(new Error(desc));
            return;
          }
          resolve(msg?.result?.result?.value ?? null);
        }
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        reject(err);
      }
    };

    ws.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      reject(err instanceof Error ? err : new Error('WebSocket error'));
    };

    ws.onclose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('WebSocket closed before CDP evaluation completed'));
    };
  });
}

function injectViaBrowserCdpWs(browserWsUrl, scriptCode, scriptHash, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let closed = false;
    let nextId = 1;
    const pending = new Map();
    let ws;
    try {
      ws = openCdpWebSocket(browserWsUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const immediateExpr = buildImmediateEvalExpression(scriptCode, scriptHash);

    const finish = (err, val) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const [, p] of pending) {
        p.reject(err || new Error('Browser CDP socket closed'));
      }
      pending.clear();
      try {
        ws.close();
      } catch {}
      if (err) reject(err);
      else resolve(val);
    };

    const timer = setTimeout(() => {
      finish(new Error('Browser CDP WebSocket timeout'));
    }, timeoutMs);

    const sendCdp = (method, params = {}, sessionId = undefined) =>
      new Promise((res, rej) => {
        if (closed) {
          rej(new Error('Browser CDP socket closed'));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          pending.delete(id);
          rej(err);
        }
      });

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || `CDP ${msg.error.code || ''} error`));
          } else {
            entry.resolve(msg.result);
          }
        }
      } catch {}
    };

    ws.onerror = (err) => {
      finish(err instanceof Error ? err : new Error('Browser CDP WebSocket error'));
    };

    ws.onclose = () => {
      finish(new Error('Browser CDP WebSocket closed before completion'));
    };

    ws.onopen = async () => {
      try {
        const targetsRes = await sendCdp('Target.getTargets', {});
        const targetInfos = Array.isArray(targetsRes?.targetInfos) ? targetsRes.targetInfos : [];
        const pageTargets = targetInfos.filter((t) => t && t.targetId && isInjectablePageTarget(t));
        let injectedCount = 0;
        let skippedAlreadyActive = 0;

        const results = await Promise.allSettled(
          pageTargets.map(async (target) => {
            let sessionId = null;
            try {
              const attachRes = await sendCdp('Target.attachToTarget', {
                targetId: target.targetId,
                flatten: true,
              });
              sessionId = attachRes?.sessionId || null;
              if (!sessionId) return null;
              const evalRes = await sendCdp(
                'Runtime.evaluate',
                { expression: immediateExpr, returnByValue: true },
                sessionId
              );
              if (evalRes?.exceptionDetails) {
                const det = evalRes.exceptionDetails;
                throw new Error(det?.exception?.description || det?.text || 'CDP Runtime.evaluate exception');
              }
              return evalRes?.result?.value ?? null;
            } finally {
              if (sessionId) {
                await sendCdp('Target.detachFromTarget', { sessionId }).catch(() => {});
              }
            }
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value === 'INJECTED_OK') injectedCount++;
            else if (r.value === 'ALREADY_ACTIVE') skippedAlreadyActive++;
          }
        }

        finish(null, {
          pageTargetCount: pageTargets.length,
          injectedCount,
          skippedAlreadyActive,
        });
      } catch (err) {
        finish(err);
      }
    };
  });
}

async function injectViaCdpLive({ autoinjectPath, devToolsPortFile }) {
  if (!autoinjectPath || !fs.existsSync(autoinjectPath)) {
    return { attempted: false, reason: 'autoinject_script_missing', injectedCount: 0 };
  }
  const endpoint = readDevToolsEndpoint(devToolsPortFile);
  if (!endpoint || !endpoint.port) {
    return { attempted: false, reason: 'devtools_port_missing', injectedCount: 0 };
  }
  const { port } = endpoint;
  let { browserWsUrl } = endpoint;

  const scriptCode = fs.readFileSync(autoinjectPath, 'utf8');
  const scriptHash = sha256Hex(scriptCode).slice(0, 16);

  let pageTargets = [];
  try {
    const targets = await httpGetJson(port, '/json/list', 1500);
    pageTargets = (Array.isArray(targets) ? targets : []).filter(
      (t) => t && t.webSocketDebuggerUrl && isInjectablePageTarget(t)
    );
  } catch {
    pageTargets = [];
  }

  let injectedCount = 0;
  let skippedAlreadyActive = 0;

  if (pageTargets.length > 0) {
    const settled = await Promise.allSettled(
      pageTargets.map((target) => configureTargetViaCdp(target.webSocketDebuggerUrl, scriptCode, scriptHash, 1500))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if (r.value === 'INJECTED_OK') injectedCount++;
        else if (r.value === 'ALREADY_ACTIVE') skippedAlreadyActive++;
      }
    }
    return {
      attempted: true,
      port,
      mode: 'http_json_list',
      pageTargetCount: pageTargets.length,
      injectedCount,
      skippedAlreadyActive,
    };
  }

  if (!browserWsUrl) {
    try {
      const ver = await httpGetJson(port, '/json/version', 1000);
      if (ver && typeof ver.webSocketDebuggerUrl === 'string' && ver.webSocketDebuggerUrl) {
        browserWsUrl = ver.webSocketDebuggerUrl;
      }
    } catch {}
  }

  if (browserWsUrl) {
    const browserRes = await injectViaBrowserCdpWs(browserWsUrl, scriptCode, scriptHash, 4000);
    return {
      attempted: true,
      port,
      mode: 'browser_ws',
      pageTargetCount: browserRes.pageTargetCount,
      injectedCount: browserRes.injectedCount,
      skippedAlreadyActive: browserRes.skippedAlreadyActive,
    };
  }

  return {
    attempted: true,
    port,
    mode: 'none',
    pageTargetCount: 0,
    injectedCount: 0,
    skippedAlreadyActive: 0,
  };
}

module.exports = {
  readDevToolsEndpoint,
  readDevToolsPort,
  httpGetJson,
  detectBundledPlugins,
  buildImmediateEvalExpression,
  isInjectablePageTarget,
  configureTargetViaCdp,
  injectViaBrowserCdpWs,
  injectViaCdpLive,
};
