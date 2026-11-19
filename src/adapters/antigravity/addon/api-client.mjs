/**
 * Sidecar HTTP API client implementing `StatusbarApiPort` (SRP / DIP).
 *
 * Security Invariants:
 * - Restricts requests strictly to the injected loopback `baseUrl`.
 * - Seals `token` inside closure scope; never writes it to `window`, DOM, or storage.
 */

export function createSidecarApiClient({ baseUrl, token, fetchImpl }) {
  if (typeof baseUrl !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(baseUrl)) {
    throw new Error('ERR_INVALID_LOOPBACK_BASE_URL');
  }
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('ERR_INVALID_SIDECAR_TOKEN');
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const sealedToken = token;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const activeControllers = new Set();
  let connected = false;

  async function post(pathname, bodyObj, externalSignal) {
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
    try {
      const res = await doFetch(`${normalizedBaseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-statusbar-token': sealedToken,
        },
        body: JSON.stringify(bodyObj || {}),
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(json?.error?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = json?.error?.code || 'HTTP_ERROR';
        throw err;
      }
      connected = true;
      return json;
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

  function abortAll() {
    for (const c of activeControllers) {
      try {
        c.abort();
      } catch {}
    }
    activeControllers.clear();
  }

  return Object.freeze({
    post,
    isConnected,
    abortAll,
  });
}
