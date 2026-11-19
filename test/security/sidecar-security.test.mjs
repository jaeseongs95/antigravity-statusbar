import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createSidecarServer } from '../../src/adapters/antigravity/sidecar-entry.mjs';

const TEST_TOKEN = 'statusbar-test-token-32-chars-ok';

function rawHttpRequest({ port, method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function createFakeService() {
  return {
    listSessions: async () => ({ sessions: [{ sessionId: 'sess-1', title: 'Demo' }], fetchedAt: 1 }),
    getSessionSnapshot: async (sid) => ({ sessionId: sid, usedTokens: 1000, effectiveLimit: 10000 }),
    getQuotaSummary: async () => ({ available: true, groups: [], stale: false, fetchedAt: 1 }),
    getSettings: async () => ({ locale: 'en', defaultCustomLimit: null, sessions: [] }),
    updateSettings: async (p) => ({ locale: p.locale || 'en', defaultCustomLimit: null, sessions: [] }),
    requestCompaction: async (sid) => ({ accepted: true, sessionId: sid, method: 'rpc' }),
  };
}

test('createSidecarServer fails closed when token is missing or < 16 chars', () => {
  assert.throws(() => createSidecarServer({ token: '', service: createFakeService() }));
  assert.throws(() => createSidecarServer({ token: 'short-token-15c', service: createFakeService() }));
});

test('sidecar HTTP security: Host check on GET & POST, POST-only API w/ 405 & zero CORS, Origin/Token/16KB/Path jail (F2, F8, F9)', async () => {
  const sidecar = createSidecarServer({
    token: TEST_TOKEN,
    service: createFakeService(),
  });
  const { port } = await sidecar.listen();
  const validHost = `127.0.0.1:${port}`;
  const validOrigin = `http://127.0.0.1:${port}`;

  try {
    // 1. Static GET with evil Host header -> 403 (F8-F9)
    const badHostStatic = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/',
      headers: { host: 'evil.attacker.example:80' },
    });
    assert.equal(badHostStatic.status, 403);

    // 2. Static GET / returns index.html with strict CSP (including vscode-file:), Referrer-Policy, Cache-Control, nosniff
    const indexRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/',
      headers: { host: validHost },
    });
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers['content-security-policy']?.includes("default-src 'none'"));
    assert.ok(indexRes.headers['content-security-policy']?.includes('vscode-file:'));
    assert.equal(indexRes.headers['referrer-policy'], 'no-referrer');
    assert.equal(indexRes.headers['cache-control'], 'no-store');
    assert.equal(indexRes.headers['x-content-type-options'], 'nosniff');

    // 3. F2: /preload.js is NOT served (404)
    const preloadRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/preload.js',
      headers: { host: validHost },
    });
    assert.equal(preloadRes.status, 404);

    // 4. F9: Path traversal, malformed %, and null byte blocked
    const traversalRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/..%2f..%2fpackage.json',
      headers: { host: validHost },
    });
    assert.equal(traversalRes.status, 403);

    const malformedPctRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/%E0%A4%A',
      headers: { host: validHost },
    });
    assert.equal(malformedPctRes.status, 400);

    // 5. Non-POST on /api/* -> 405 Method Not Allowed & ZERO CORS headers (F8-F9)
    for (const m of ['GET', 'OPTIONS', 'PUT', 'DELETE']) {
      const nonPost = await rawHttpRequest({
        port,
        method: m,
        path: '/api/sessions',
        headers: { host: validHost, origin: validOrigin },
      });
      assert.equal(nonPost.status, 405, `Expected 405 for ${m} /api/sessions`);
      assert.equal(nonPost.headers['access-control-allow-origin'], undefined);
      assert.equal(nonPost.headers['access-control-allow-methods'], undefined);
    }

    // 6. Missing or null or foreign Origin on API POST -> 403
    for (const badOrigin of [undefined, 'null', 'https://evil.example']) {
      const headers = {
        host: validHost,
        'x-statusbar-token': TEST_TOKEN,
        'content-type': 'application/json',
      };
      if (badOrigin !== undefined) headers.origin = badOrigin;
      const res = await rawHttpRequest({
        port,
        method: 'POST',
        path: '/api/sessions',
        headers,
        body: '{}',
      });
      assert.equal(res.status, 403);
    }

    // 7. Wrong token -> 401
    const badToken = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/sessions',
      headers: {
        host: validHost,
        origin: validOrigin,
        'x-statusbar-token': 'wrong-token-of-sufficient-length-123',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(badToken.status, 401);

    // 8. Body > 16KB -> 413 Payload Too Large + Connection: close (NB1)
    const hugeBody = JSON.stringify({ pad: 'a'.repeat(20 * 1024) });
    const tooLarge = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/settings/update',
      headers: {
        host: validHost,
        origin: validOrigin,
        'x-statusbar-token': TEST_TOKEN,
        'content-type': 'application/json',
      },
      body: hugeBody,
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(String(tooLarge.headers.connection || '').toLowerCase(), 'close');

    // 9. Valid authenticated POST /api/sessions -> 200
    const okRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/sessions',
      headers: {
        host: validHost,
        origin: validOrigin,
        'x-statusbar-token': TEST_TOKEN,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(okRes.status, 200);
    const parsed = JSON.parse(okRes.body);
    assert.equal(parsed.sessions[0].sessionId, 'sess-1');
  } finally {
    await sidecar.close();
  }
});
