import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStatusbarService } from '../../core/app/statusbar-service.mjs';
import { DomainError } from '../../core/i18n/error-codes.mjs';
import { createJsonSettingsStore } from '../storage/json-settings-store.mjs';
import { assertRendererPublisherPort } from './addon/ports.mjs';
import { createSettingsBridgePublisher } from './addon/runtime-publisher.mjs';
import { createAntigravityCompactionAdapter } from './compaction-adapter.mjs';
import { createLsTransport } from './ls-transport.mjs';
import { createAntigravityTelemetryAdapter } from './telemetry-mapper.mjs';
import { renderUiBridgeScript } from './ui-bridge.mjs';

const MIN_TOKEN_LENGTH = 16;
const MAX_BODY_BYTES = 16 * 1024; // 16KB hard cap
const DEFAULT_FRAME_ANCESTORS = "'self' vscode-webview: vscode-file: file: http://127.0.0.1:* http://localhost:*";

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
});

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function timingSafeTokenMatch(expectedDigest, candidate) {
  if (typeof candidate !== 'string' || candidate.length < MIN_TOKEN_LENGTH) {
    return false;
  }
  const candidateDigest = sha256Buffer(candidate);
  return crypto.timingSafeEqual(expectedDigest, candidateDigest);
}

const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/;
const ALLOWED_ORIGIN_RE =
  /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])|https:\/\/(?:[a-z0-9-]+\.)*antigravity\.google\.com)(?::(\d{1,5}))?$/;

function isValidPortString(portStr) {
  if (portStr === undefined) return true;
  const n = Number(portStr);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function isAllowedLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) {
    return false;
  }
  const match = LOOPBACK_HOST_RE.exec(hostHeader.trim().toLowerCase());
  return Boolean(match && isValidPortString(match[1]));
}

function isAllowedLoopbackOrigin(originHeader) {
  if (typeof originHeader !== 'string' || !originHeader.trim()) {
    return false;
  }
  const normalized = originHeader.trim().toLowerCase();
  if (normalized === 'null') {
    return false;
  }
  const match = ALLOWED_ORIGIN_RE.exec(normalized);
  return Boolean(match && isValidPortString(match[1]));
}

/**
 * Reads a request body with strict chunk-accumulated byte cap (16KB -> 413).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (status, code, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.httpStatus = status;
      err.code = code;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        fail(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`);
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      fail(400, 'BAD_REQUEST', 'Request stream error.');
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks, total).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object.');
          err.httpStatus = 400;
          err.code = 'INVALID_JSON';
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error('Malformed JSON request body.');
        err.httpStatus = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });
  });
}

/**
 * Resolves a static asset path inside uiRootReal with strict path.relative + path.sep jail (F9).
 *
 * @param {string} rawPathname
 * @param {string} uiRootReal
 * @returns {{ ok: true, filePath: string, ext: string } | { ok: false, status: number }}
 */
export function resolveStaticAssetPath(rawPathname, uiRootReal) {
  if (typeof rawPathname !== 'string' || rawPathname.includes('\0')) {
    return { ok: false, status: 400 };
  }

  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return { ok: false, status: 400 };
  }

  if (decoded.includes('\0') || decoded.includes('\\')) {
    return { ok: false, status: 400 };
  }

  const relativeReq = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(uiRootReal, relativeReq);

  const relPre = path.relative(uiRootReal, candidate);
  if (relPre.startsWith('..') || path.isAbsolute(relPre)) {
    return { ok: false, status: 403 };
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    return { ok: false, status: 404 };
  }

  const relReal = path.relative(uiRootReal, realTarget);
  if (
    relReal.startsWith('..') ||
    path.isAbsolute(relReal) ||
    (realTarget !== uiRootReal && !realTarget.startsWith(uiRootReal + path.sep))
  ) {
    return { ok: false, status: 403 };
  }

  let stat;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    return { ok: false, status: 404 };
  }

  if (!stat.isFile()) {
    return { ok: false, status: 404 };
  }

  const ext = path.extname(realTarget).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MIME_TYPES, ext)) {
    return { ok: false, status: 403 };
  }

  return { ok: true, filePath: realTarget, ext };
}

/**
 * Creates the hardened Sidecar HTTP server (injectable for unit/security/integration tests).
 *
 * @param {{
 *   token: string,
 *   service: ReturnType<typeof createStatusbarService>,
 *   uiRootDir?: string,
 *   frameAncestors?: string,
 *   port?: number,
 * }} options
 */
export function createSidecarServer({
  token,
  service,
  uiRootDir,
  frameAncestors = DEFAULT_FRAME_ANCESTORS,
  port = 0,
}) {
  // Fail-Closed token length check
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `ANTIGRAVITY_SIDECAR_UI_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (Fail-Closed).`,
    );
  }

  const expectedTokenDigest = sha256Buffer(token);
  const defaultUiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui');
  const uiRootReal = fs.realpathSync(uiRootDir || defaultUiDir);
  const bridgeScriptBuf = Buffer.from(renderUiBridgeScript(), 'utf8');

  const cspHeader = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');

  let boundPort = port;

  function applySecurityHeaders(res) {
    res.setHeader('content-security-policy', cspHeader);
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    applySecurityHeaders(res);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      ...extraHeaders,
    });
    res.end(body);
  }

  async function handleApiRequest(req, res, pathname) {
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const originAllowed = isAllowedLoopbackOrigin(rawOrigin);

    // Loopback-only CORS preflight for cross-port Antigravity desktop renderer
    if (req.method === 'OPTIONS') {
      if (!originAllowed) {
        sendJson(res, 403, {
          error: { code: 'FORBIDDEN_ORIGIN', message: 'Invalid or missing Origin header.' },
        });
        return;
      }
      applySecurityHeaders(res);
      res.writeHead(204, {
        'access-control-allow-origin': rawOrigin,
        vary: 'Origin',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-statusbar-token',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    // Non-POST on /api/* -> 405 Method Not Allowed, ZERO CORS headers
    if (req.method !== 'POST') {
      sendJson(
        res,
        405,
        { error: { code: 'METHOD_NOT_ALLOWED', message: 'API endpoints require POST.' } },
        { allow: 'POST, OPTIONS' },
      );
      return;
    }

    // Strict loopback Origin check (missing or 'null' or foreign -> 403, ZERO CORS headers)
    if (!originAllowed) {
      sendJson(res, 403, {
        error: { code: 'FORBIDDEN_ORIGIN', message: 'Invalid or missing Origin header.' },
      });
      return;
    }

    const corsHeaders = {
      'access-control-allow-origin': rawOrigin,
      vary: 'Origin',
    };

    // SHA-256 32-byte timingSafeEqual token validation
    const suppliedToken = req.headers['x-statusbar-token'];
    if (!timingSafeTokenMatch(expectedTokenDigest, suppliedToken)) {
      sendJson(
        res,
        401,
        { error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token.' } },
        corsHeaders,
      );
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      const status = err.httpStatus || 400;
      // NB1: Close keep-alive connection on 413 after pausing unread oversized payload
      const extraHeaders = status === 413 ? { ...corsHeaders, connection: 'close' } : corsHeaders;
      sendJson(
        res,
        status,
        { error: { code: err.code || 'BAD_REQUEST', message: err.message } },
        extraHeaders,
      );
      return;
    }

    try {
      if (pathname === '/api/sessions') {
        const result = await service.listSessions();
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/snapshot') {
        const result = await service.getSessionSnapshot(body.sessionId);
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/quota') {
        const result = await service.getQuotaSummary();
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/settings/get') {
        const result = await service.getSettings();
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/settings/update') {
        const result = await service.updateSettings(body);
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/compact') {
        const result = await service.requestCompaction(
          body.sessionId,
          body.prompt !== undefined ? { prompt: body.prompt } : undefined,
        );
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/command') {
        const result = await service.runCustomCommand(body.sessionId, body.command);
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/addons/upsert') {
        const result = await service.upsertAddon(body);
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/addons/toggle') {
        const result = await service.setAddonEnabled(
          body.id,
          Boolean(body.enabled),
          Boolean(body.runtime),
        );
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      if (pathname === '/api/addons/remove') {
        const result = await service.removeAddon(body.id);
        sendJson(res, 200, result, corsHeaders);
        return;
      }
      sendJson(
        res,
        404,
        { error: { code: 'NOT_FOUND', message: `Unknown API endpoint: ${pathname}` } },
        corsHeaders,
      );
    } catch (err) {
      if (err instanceof DomainError) {
        sendJson(
          res,
          err.httpStatus,
          { error: { code: err.code, message: err.message, details: err.details } },
          corsHeaders,
        );
        return;
      }
      sendJson(
        res,
        500,
        { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
        corsHeaders,
      );
    }
  }

  function handleStaticRequest(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(
        res,
        405,
        { error: { code: 'METHOD_NOT_ALLOWED', message: 'Static assets require GET.' } },
        { allow: 'GET, HEAD' },
      );
      return;
    }

    if (pathname === '/bridge.js') {
      applySecurityHeaders(res);
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(bridgeScriptBuf.length),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(bridgeScriptBuf);
      return;
    }

    const resolved = resolveStaticAssetPath(pathname, uiRootReal);
    if (!resolved.ok) {
      sendJson(res, resolved.status, {
        error: { code: 'STATIC_ERROR', message: 'Asset unavailable.' },
      });
      return;
    }

    let content;
    try {
      // NB1: Guard readFileSync against race deletion/permission errors
      content = fs.readFileSync(resolved.filePath);
    } catch {
      sendJson(res, 404, {
        error: { code: 'STATIC_ERROR', message: 'Asset unavailable.' },
      });
      return;
    }
    applySecurityHeaders(res);
    res.writeHead(200, {
      'content-type': MIME_TYPES[resolved.ext],
      'content-length': String(content.length),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(content);
  }

  const server = http.createServer((req, res) => {
    // F8-F9: Host check on BOTH static GET and API POST
    if (!isAllowedLoopbackHostHeader(req.headers.host, boundPort)) {
      sendJson(res, 403, {
        error: { code: 'FORBIDDEN_HOST', message: 'Invalid Host header.' },
      });
      return;
    }

    const rawUrl = req.url || '/';
    if (rawUrl.includes('\0')) {
      sendJson(res, 400, {
        error: { code: 'BAD_REQUEST', message: 'Invalid request URL.' },
      });
      return;
    }

    let pathname;
    try {
      const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${boundPort}`);
      pathname = parsedUrl.pathname;
    } catch {
      sendJson(res, 400, {
        error: { code: 'BAD_REQUEST', message: 'Malformed request URL.' },
      });
      return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      handleApiRequest(req, res, pathname).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: { code: 'INTERNAL_ERROR', message: 'Unhandled error.' },
          });
        }
      });
      return;
    }

    handleStaticRequest(req, res, pathname);
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const addr = server.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve({ port: boundPort, url: `http://127.0.0.1:${boundPort}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Resolves an optional configured Sidecar loopback port from environment variables.
 * Accepts integers in [1024, 65535]; falls back to `0` (ephemeral OS-assigned port) otherwise.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function resolvePreferredSidecarPort(env = process.env) {
  const raw =
    env?.STATUSBAR_SIDECAR_PORT ||
    env?.ANTIGRAVITY_SIDECAR_WEB_PORT ||
    env?.ANTIGRAVITY_SIDECAR_PORT ||
    '';
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return 0;
  return parsed;
}

/**
 * Production sidecar entrypoint invoked by sidecars/statusbar/main.mjs.
 */
export async function startSidecar(env = process.env, deps = {}) {
  const rawToken = env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  let token;
  if (typeof rawToken === 'string' && rawToken.length > 0) {
    if (rawToken.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `ANTIGRAVITY_SIDECAR_UI_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters.`,
      );
    }
    token = rawToken;
  } else {
    // Headless mode (has_web_ui: false): mint a 256-bit per-process cryptographic token for inline addon bridge.
    token = crypto.randomBytes(32).toString('hex');
  }

  const hostDataDir =
    env.ANTIGRAVITY_ADDON_HOST_DATA_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity');

  const dataDir =
    env.ANTIGRAVITY_PLUGIN_DATA_DIR ||
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-statusbar', 'data');

  const lsTransport = createLsTransport({
    lsAddress: env.ANTIGRAVITY_LS_ADDRESS || '',
    csrfToken: env.ANTIGRAVITY_CSRF_TOKEN || env.ANTIGRAVITY_LS_CSRF_TOKEN || '',
  });

  const telemetryPort = createAntigravityTelemetryAdapter(lsTransport);
  const compactionPort = createAntigravityCompactionAdapter({
    lsTransport,
    agentApiExePath: env.ANTIGRAVITY_AGENTAPI_EXE || null,
  });
  const settingsPort = createJsonSettingsStore({ dataDir });

  const service = createStatusbarService({
    telemetryPort,
    compactionPort,
    settingsPort,
  });

  const preferredPort = resolvePreferredSidecarPort(env);
  let sidecar = createSidecarServer({
    token,
    service,
    frameAncestors: env.STATUSBAR_FRAME_ANCESTORS || DEFAULT_FRAME_ANCESTORS,
    port: preferredPort,
  });

  let listenInfo;
  try {
    listenInfo = await sidecar.listen();
  } catch (listenErr) {
    if (preferredPort > 0 && listenErr?.code === 'EADDRINUSE') {
      process.stderr.write(
        `[statusbar-sidecar] preferred port ${preferredPort} in use; falling back to ephemeral loopback port\n`,
      );
      sidecar = createSidecarServer({
        token,
        service,
        frameAncestors: env.STATUSBAR_FRAME_ANCESTORS || DEFAULT_FRAME_ANCESTORS,
        port: 0,
      });
      listenInfo = await sidecar.listen();
    } else {
      throw listenErr;
    }
  }
  const { port, url } = listenInfo;

  // v3.2.0 (trusted): Publish live Desktop loopback connection exclusively via host settingsBridge
  // (`HOST_DATA_DIR/antigravity-statusbar-runtime.json`) so `runtime/statusbar-renderer.js` stays 100% immutable.
  const addonPublishDisabled = env.STATUSBAR_DISABLE_ADDON_PUBLISH === '1';
  let rendererPublisher = null;
  if (!addonPublishDisabled) {
    try {
      rendererPublisher = assertRendererPublisherPort(
        deps.rendererPublisher ||
          createSettingsBridgePublisher({
            hostDataDir,
          }),
      );
      await rendererPublisher.publish({ baseUrl: url, token });
    } catch (pubErr) {
      // Non-fatal: Sidecar remains operational even if host data directory is read-only
      process.stderr.write(
        `[statusbar-sidecar] settingsBridge runtime publish warning: ${pubErr?.message || String(pubErr)}\n`,
      );
    }
  }

  // Announce readiness to Antigravity Sidecar host (JSON line on stdout)
  process.stdout.write(
    `${JSON.stringify({
      type: 'sidecar_ready',
      url: `${url}/?token=${encodeURIComponent(token)}`,
      port,
    })}\n`,
  );

  // Background active-session sweep protects non-focused RUNNING tabs under global/model limits
  let sweepInFlight = false;
  const sweepIntervalMs = Math.max(
    1_000,
    Number(env.STATUSBAR_SWEEP_INTERVAL_MS) || 5_000,
  );
  const sweepTimer = setInterval(() => {
    if (shuttingDown || sweepInFlight) return;
    sweepInFlight = true;
    service
      .sweepActiveSessions()
      .catch(() => {})
      .finally(() => {
        sweepInFlight = false;
      });
  }, sweepIntervalMs);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }

  let rendererCleanedUp = false;
  let shuttingDown = false;
  const cleanupResources = async () => {
    clearInterval(sweepTimer);
    process.removeListener('SIGTERM', onSigTerm);
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGBREAK', onSigBreak);
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('exit', onExit);
    if (process.stdin && typeof process.stdin.removeListener === 'function') {
      process.stdin.removeListener('end', onStdinClose);
      process.stdin.removeListener('close', onStdinClose);
    }
    if (rendererPublisher && !rendererCleanedUp) {
      try {
        await rendererPublisher.teardown();
        rendererCleanedUp = true;
      } catch {
        // Best-effort credential cleanup on shutdown; exit handler tries teardownSync
      }
    }
    await compactionPort.dispose();
    if (typeof sidecar.server.closeAllConnections === 'function') {
      sidecar.server.closeAllConnections();
    }
    await sidecar.close();
  };

  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await cleanupResources();
  };

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await cleanupResources();
    process.exit(typeof exitCode === 'number' ? exitCode : 0);
  };

  const onSigTerm = () => {
    void shutdown(0);
  };
  const onSigInt = () => {
    void shutdown(0);
  };
  const onSigBreak = () => {
    void shutdown(0);
  };
  const onStdinClose = () => {
    void shutdown(0);
  };
  const onUncaught = (err) => {
    process.stderr.write(`[statusbar-sidecar] uncaughtException: ${err?.stack || err?.message || String(err)}\n`);
    if (rendererPublisher && !rendererCleanedUp && typeof rendererPublisher.teardownSync === 'function') {
      try {
        rendererPublisher.teardownSync();
        rendererCleanedUp = true;
      } catch {}
    }
    compactionPort.disposeSync();
    process.exit(1);
  };
  const onExit = () => {
    if (rendererPublisher && !rendererCleanedUp && typeof rendererPublisher.teardownSync === 'function') {
      try {
        rendererPublisher.teardownSync();
        rendererCleanedUp = true;
      } catch {}
    }
    compactionPort.disposeSync();
  };

  process.once('SIGTERM', onSigTerm);
  process.once('SIGINT', onSigInt);
  process.once('SIGBREAK', onSigBreak);
  if (process.stdin && typeof process.stdin.on === 'function') {
    process.stdin.once('end', onStdinClose);
    process.stdin.once('close', onStdinClose);
  }
  process.once('uncaughtException', onUncaught);
  process.once('exit', onExit);

  return { sidecar, port, url, shutdown, stop };
}
