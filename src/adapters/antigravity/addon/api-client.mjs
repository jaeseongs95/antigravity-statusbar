/**
 * Sidecar HTTP API client implementing `StatusbarApiPort` (SRP / DIP).
 *
 * Security Invariants:
 * - On Desktop (default), restricts requests strictly to loopback `http://127.0.0.1|localhost|[::1]:<port>`.
 * - On Remote Web (`allowRemoteHttps: true`), allows loopback HTTP or explicit `https://` endpoints
 *   with zero embedded URL credentials, query strings, or fragments (rejects cleartext remote HTTP).
 * - Seals `token` strictly inside closure scope; never writes or returns it on `window`, DOM, or API getters.
 * - Supports live reconfiguration via `configure()` and credential revocation via `clearConnection()`.
 */

export function createSidecarApiClient({
  baseUrl = null,
  token = null,
  allowRemoteHttps = false,
  fetchImpl,
  gmXhrImpl,
} = {}) {
  const LOOPBACK_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/?$/;

  function normalizeValidatedBaseUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
      throw new Error(allowRemoteHttps ? 'ERR_INVALID_ENDPOINT_URL' : 'ERR_INVALID_LOOPBACK_BASE_URL');
    }
    const trimmed = rawUrl.trim();
    const loopbackMatch = LOOPBACK_RE.exec(trimmed);
    if (loopbackMatch) {
      const port = Number(loopbackMatch[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(allowRemoteHttps ? 'ERR_INVALID_ENDPOINT_URL' : 'ERR_INVALID_LOOPBACK_BASE_URL');
      }
      return trimmed.replace(/\/+$/, '');
    }
    if (allowRemoteHttps) {
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error('ERR_INVALID_ENDPOINT_URL');
      }
      if (
        parsed.protocol !== 'https:' ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error('ERR_INVALID_ENDPOINT_URL');
      }
      const cleanedPath = parsed.pathname && parsed.pathname !== '/'
        ? parsed.pathname.replace(/\/+$/, '')
        : '';
      return `${parsed.origin}${cleanedPath}`;
    }
    throw new Error('ERR_INVALID_LOOPBACK_BASE_URL');
  }

  function normalizeValidatedToken(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.trim().length < 16) {
      throw new Error('ERR_INVALID_SIDECAR_TOKEN');
    }
    return rawToken.trim();
  }

  let normalizedBaseUrl = '';
  let sealedToken = '';
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const activeControllers = new Set();
  let connected = false;

  function resolveGmXhr() {
    if (!allowRemoteHttps) return null;
    if (typeof gmXhrImpl === 'function') return gmXhrImpl;
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
      return GM.xmlHttpRequest.bind(GM);
    }
    return null;
  }

  function postViaGmXhr(gmXhr, url, targetToken, payloadText, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        reject(abortErr);
        return;
      }
      let settled = false;
      let handle = null;
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbortSignal);
      };
      const finishResolve = (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      };
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onAbortSignal = () => {
        try {
          if (handle && typeof handle.abort === 'function') handle.abort();
        } catch {}
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        finishReject(abortErr);
      };
      if (signal) {
        signal.addEventListener('abort', onAbortSignal, { once: true });
      }
      try {
        handle = gmXhr({
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/json',
            'x-statusbar-token': targetToken,
          },
          data: payloadText,
          responseType: 'text',
          onload(resp) {
            const status = typeof resp?.status === 'number' ? resp.status : 0;
            const rawText = typeof resp?.responseText === 'string' ? resp.responseText : '';
            let json = {};
            if (rawText) {
              try {
                json = JSON.parse(rawText);
              } catch {
                json = {};
              }
            }
            if (status < 200 || status >= 300) {
              if (status >= 500 || status === 401 || status === 403 || status === 0) {
                connected = false;
              }
              const err = new Error(json?.error?.message || `HTTP ${status}`);
              err.status = status;
              err.code = json?.error?.code || 'HTTP_ERROR';
              finishReject(err);
              return;
            }
            connected = true;
            finishResolve(json);
          },
          onerror() {
            connected = false;
            const err = new Error('Network error');
            err.code = 'ERR_GM_XHR_NETWORK';
            finishReject(err);
          },
          ontimeout() {
            connected = false;
            const err = new Error('Request timed out');
            err.code = 'ERR_GM_XHR_TIMEOUT';
            finishReject(err);
          },
          onabort() {
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            finishReject(abortErr);
          },
        });
      } catch (err) {
        finishReject(err);
      }
    });
  }

  if (baseUrl !== null && baseUrl !== undefined || token !== null && token !== undefined) {
    normalizedBaseUrl = normalizeValidatedBaseUrl(baseUrl);
    sealedToken = normalizeValidatedToken(token);
  }

  function abortAll() {
    for (const c of activeControllers) {
      try {
        c.abort();
      } catch {}
    }
    activeControllers.clear();
  }

  function configure({ baseUrl: nextUrl, token: nextToken }) {
    const validatedUrl = normalizeValidatedBaseUrl(nextUrl);
    const validatedToken = normalizeValidatedToken(nextToken);
    if (validatedUrl === normalizedBaseUrl && validatedToken === sealedToken) {
      return false;
    }
    abortAll();
    normalizedBaseUrl = validatedUrl;
    sealedToken = validatedToken;
    connected = false;
    return true;
  }

  function clearConnection() {
    const hadConn = Boolean(normalizedBaseUrl || sealedToken);
    abortAll();
    normalizedBaseUrl = '';
    sealedToken = '';
    connected = false;
    return hadConn;
  }

  function isConfigured() {
    return Boolean(normalizedBaseUrl && sealedToken);
  }

  function getBaseUrl() {
    return normalizedBaseUrl;
  }

  async function post(pathname, bodyObj, externalSignal) {
    if (!normalizedBaseUrl || !sealedToken) {
      const err = new Error('Sidecar connection is not configured.');
      err.code = 'ERR_SIDECAR_NOT_CONFIGURED';
      throw err;
    }
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
    const targetBase = normalizedBaseUrl;
    const targetToken = sealedToken;
    const targetUrl = `${targetBase}${pathname}`;
    const payloadText = JSON.stringify(bodyObj || {});
    try {
      const res = await doFetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-statusbar-token': targetToken,
        },
        body: payloadText,
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status >= 500 || res.status === 401 || res.status === 403) {
          connected = false;
        }
        const err = new Error(json?.error?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = json?.error?.code || 'HTTP_ERROR';
        throw err;
      }
      connected = true;
      return json;
    } catch (err) {
      const isAborted = err?.name === 'AbortError' || err?.message === 'aborted' || ctrl.signal.aborted;
      const gmXhr = !isAborted && err?.status === undefined ? resolveGmXhr() : null;
      if (gmXhr) {
        return await postViaGmXhr(gmXhr, targetUrl, targetToken, payloadText, ctrl.signal);
      }
      if (!isAborted && (err?.status === undefined || err.status >= 500 || err.status === 401 || err.status === 403)) {
        connected = false;
      }
      throw err;
    } finally {
      activeControllers.delete(ctrl);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  function isConnected() {
    return connected;
  }

  return Object.freeze({
    post,
    isConnected,
    isConfigured,
    getBaseUrl,
    configure,
    clearConnection,
    abortAll,
  });
}
