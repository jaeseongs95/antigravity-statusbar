import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  renderAddonRendererBundle,
  renderAddonStandbyStub,
  renderAddonStaticBundle,
} from '../../src/adapters/antigravity/addon/bundle-builder.mjs';
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
    runCustomCommand: async (sid, cmd) => ({ accepted: true, sessionId: sid, command: cmd, method: 'agentapi' }),
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
    // 1. Static GET with evil Host header -> 403 (F8-F9), loopback proxy Host -> 200
    for (const badHost of ['evil.attacker.example:80', '127.0.0.1.evil.com:80', 'localhost:99999']) {
      const badHostStatic = await rawHttpRequest({
        port,
        method: 'GET',
        path: '/',
        headers: { host: badHost },
      });
      assert.equal(badHostStatic.status, 403, `Expected 403 for Host ${badHost}`);
    }
    const proxyHostStatic = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/',
      headers: { host: 'localhost:54321' },
    });
    assert.equal(proxyHostStatic.status, 200);

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

    // 5. Non-POST/OPTIONS on /api/* -> 405 Method Not Allowed & ZERO CORS headers (F8-F9)
    for (const m of ['GET', 'PUT', 'DELETE']) {
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

    // 5b. OPTIONS preflight: allowed ONLY for loopback Origin; foreign/missing -> 403 & ZERO CORS
    const badPreflight = await rawHttpRequest({
      port,
      method: 'OPTIONS',
      path: '/api/sessions',
      headers: { host: validHost, origin: 'https://evil.example' },
    });
    assert.equal(badPreflight.status, 403);
    assert.equal(badPreflight.headers['access-control-allow-origin'], undefined);

    const loopbackCrossPortOrigin = 'http://localhost:54321';
    const okPreflight = await rawHttpRequest({
      port,
      method: 'OPTIONS',
      path: '/api/sessions',
      headers: { host: validHost, origin: loopbackCrossPortOrigin },
    });
    assert.equal(okPreflight.status, 204);
    assert.equal(okPreflight.headers['access-control-allow-origin'], loopbackCrossPortOrigin);
    assert.equal(okPreflight.headers['access-control-allow-private-network'], 'true');
    assert.equal(okPreflight.headers.vary, 'Origin');

    const httpsPreflight = await rawHttpRequest({
      port,
      method: 'OPTIONS',
      path: '/api/command',
      headers: { host: validHost, origin: 'https://app.antigravity.google.com' },
    });
    assert.equal(httpsPreflight.status, 204);
    assert.equal(httpsPreflight.headers['access-control-allow-origin'], 'https://app.antigravity.google.com');

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

    // 9. Valid authenticated POST /api/sessions -> 200 (both same-port & cross-port loopback origin)
    const okRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/sessions',
      headers: {
        host: validHost,
        origin: loopbackCrossPortOrigin,
        'x-statusbar-token': TEST_TOKEN,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers['access-control-allow-origin'], loopbackCrossPortOrigin);
    const parsed = JSON.parse(okRes.body);
    assert.equal(parsed.sessions[0].sessionId, 'sess-1');

    // 10. Authenticated POST /api/command -> 200
    const cmdRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/command',
      headers: {
        host: validHost,
        origin: 'https://localhost:54321',
        'x-statusbar-token': TEST_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 'sess-1', command: '/plan' }),
    });
    assert.equal(cmdRes.status, 200);
    assert.equal(JSON.parse(cmdRes.body).command, '/plan');
  } finally {
    await sidecar.close();
  }
});

test('v3.2.0 static renderer bundle is deterministic, credential-free, AST-safe, and legacy test bundle still validates loopback/token', () => {
  const staticBundleA = renderAddonRendererBundle();
  const staticBundleB = renderAddonStaticBundle();
  assert.equal(staticBundleA, staticBundleB, 'renderAddonRendererBundle() without args must emit deterministic static bundle');
  assert.equal(staticBundleA.includes(TEST_TOKEN), false);
  assert.equal(/http:\/\/127\.0\.0\.1:\d+/.test(staticBundleA), false, 'Static bundle must never embed concrete loopback ports');
  assert.ok(staticBundleA.includes('antigravity-statusbar.root'));
  assert.ok(staticBundleA.includes('startAddonStatusbar'));

  // Host v2.5.3 verifyRemoteBundleAst banned sink & dynamic execution checks
  const bannedAstPatterns = [
    /\binnerHTML\b/,
    /\bouterHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bdocument\.write\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\brequire\s*\(/,
    /createPolicy\s*\(\s*['"]default['"]\s*\)/,
    /SetMendelFlagOverrides/,
    /createElement\s*\(\s*['"]style['"]\s*\)/,
    /window\.__agyStatusbarInline/,
  ];
  for (const pat of bannedAstPatterns) {
    assert.equal(pat.test(staticBundleA), false, `Static bundle matched forbidden pattern ${pat}`);
  }

  // Legacy explicit credentials validation (used by existing local E2E harnesses)
  assert.throws(() =>
    renderAddonRendererBundle({ baseUrl: 'https://evil.example:443', token: TEST_TOKEN }),
  );
  assert.throws(() =>
    renderAddonRendererBundle({ baseUrl: 'http://127.0.0.1:43210', token: 'short' }),
  );
  const script = renderAddonRendererBundle({
    baseUrl: 'http://127.0.0.1:43210',
    token: TEST_TOKEN,
  });
  assert.ok(script.includes('http://127.0.0.1:43210'));
  assert.ok(script.includes('antigravity-statusbar.root'));
  for (const pat of bannedAstPatterns) {
    assert.equal(pat.test(script), false, `Explicit bundle matched forbidden pattern ${pat}`);
  }

  const stub = renderAddonStandbyStub();
  assert.equal(stub.includes(TEST_TOKEN), false);
  assert.equal(stub.includes('http://127.0.0.1'), false);
  assert.ok(stub.includes('antigravity-statusbar.root'));
  assert.ok(stub.includes('startStandbyStatusbar'));
});
