/**
 * Sidecar HTTP API client implementing `StatusbarApiPort` (SRP / DIP).
 *
 * AddonManifest.v3 Networking & Security Invariants:
 * - Routes requests through `ctx.net.fetch` (`netFetchImpl`) whenever granted by the host
 *   (Desktop `permissions.net.localLoopback` and Remote Web via Native Host v3.1.1 Host Bridge).
 * - Eliminates non-standard userscript XHR probing and plugin-owned remote HTTPS endpoints;
 *   all host network privileges remain behind the host `ctx.net.fetch` broker.
 * - Restricts requests strictly to loopback `http://127.0.0.1|localhost|[::1]:<port>`
 *   (on Remote Web, Native Host v3.1.1 transparently proxies `localLoopback` over the paired Host Bridge).
 * - Seals `token` strictly inside closure scope; never writes or returns it on `window`, DOM, or API getters.
 */

export function createSidecarApiClient({
  baseUrl = null,
  token = null,
  netFetchImpl = null,
  fetchImpl,
} = {}) {
  const LOOPBACK_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/?$/;

  function normalizeValidatedBaseUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
      throw new Error('ERR_INVALID_LOOPBACK_BASE_URL');
    }
    const trimmed = rawUrl.trim();
    const loopbackMatch = LOOPBACK_RE.exec(trimmed);
    if (loopbackMatch) {
      const port = Number(loopbackMatch[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('ERR_INVALID_LOOPBACK_BASE_URL');
      }
      return trimmed.replace(/\/+$/, '');
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
  const doNetFetch = typeof netFetchImpl === 'function' ? netFetchImpl : null;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : typeof fetch === 'function' ? fetch : null;
  const activeControllers = new Set();
  let connected = false;

  if ((baseUrl !== null && baseUrl !== undefined) || (token !== null && token !== undefined)) {
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

  async function postViaNetBroker(targetUrl, targetToken, payloadText, signal) {
    if (signal && signal.aborted) {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const resp = await doNetFetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-statusbar-token': targetToken,
      },
      body: payloadText,
    });
    if (signal && signal.aborted) {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const status = typeof resp?.status === 'number' ? resp.status : 0;
    const rawText = typeof resp?.bodyText === 'string' ? resp.bodyText : '';
    let json = {};
    if (rawText) {
      try {
        json = JSON.parse(rawText);
      } catch {
        json = {};
      }
    }
    if (!resp || resp.ok === false || (status > 0 && (status < 200 || status >= 300))) {
      if (status === 0 || status >= 500 || status === 401 || status === 403) {
        connected = false;
      }
      const reason = resp?.reason || json?.error?.code || 'HTTP_ERROR';
      const err = new Error(json?.error?.message || resp?.reason || `HTTP ${status}`);
      if (status > 0) err.status = status;
      err.code = reason;
      throw err;
    }
    connected = true;
    return json;
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
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    const targetBase = normalizedBaseUrl;
    const targetToken = sealedToken;
    const targetUrl = `${targetBase}${pathname}`;
    const payloadText = JSON.stringify(bodyObj || {});
    try {
      if (doNetFetch) {
        return await postViaNetBroker(targetUrl, targetToken, payloadText, ctrl.signal);
      }
      if (!doFetch) {
        const err = new Error('No permitted network transport available.');
        err.code = 'ERR_NET_UNAVAILABLE';
        throw err;
      }
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
