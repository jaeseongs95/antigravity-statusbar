/**
 * Generates the virtual `/bridge.js` served to the UI webview.
 *
 * Security & Lifecycle (F2, F8, F9):
 * - Captures `?token=` from the initial URL into module closure + sessionStorage
 *   so webview reloads after `history.replaceState` retain authentication (F9).
 * - Immediately strips `?token=` from the URL via `history.replaceState`.
 * - Sends all API calls as `POST /api/*` with `X-Statusbar-Token` header.
 * - Keeps `src/ui/` 100% vendor-neutral without needing `/preload.js` (F2).
 */
export function renderUiBridgeScript() {
  return `(() => {
  'use strict';
  const STORAGE_KEY = '__statusbar_sidecar_token__';

  function captureToken() {
    let token = '';
    try {
      const url = new URL(window.location.href);
      const fromQuery = url.searchParams.get('token');
      if (fromQuery && fromQuery.length >= 16) {
        token = fromQuery;
        try {
          window.sessionStorage.setItem(STORAGE_KEY, token);
        } catch {
          // sessionStorage may be restricted in sandboxed webviews
        }
        url.searchParams.delete('token');
        const cleanSearch = url.searchParams.toString();
        const cleanUrl = url.pathname + (cleanSearch ? '?' + cleanSearch : '') + url.hash;
        window.history.replaceState(null, '', cleanUrl);
      } else {
        try {
          token = window.sessionStorage.getItem(STORAGE_KEY) || '';
        } catch {
          token = '';
        }
      }
    } catch {
      token = '';
    }
    return token;
  }

  const authToken = captureToken();

  async function request(endpoint, body, signal) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/')) {
      throw new Error('Invalid API endpoint');
    }
    const headers = {
      'content-type': 'application/json',
    };
    if (authToken) {
      headers['x-statusbar-token'] = authToken;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || ('HTTP ' + res.status));
      err.status = res.status;
      err.code = data?.error?.code || 'HTTP_ERROR';
      throw err;
    }
    return data;
  }

  Object.defineProperty(window, '__STATUSBAR_HOST_BRIDGE__', {
    value: Object.freeze({
      hasToken: () => Boolean(authToken),
      request,
    }),
    writable: false,
    configurable: false,
  });
})();
`;
}
