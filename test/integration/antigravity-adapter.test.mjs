import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

import { createAntigravityCompactionAdapter, resolveSafeAgentApiExe } from '../../src/adapters/antigravity/compaction-adapter.mjs';
import { createLsTransport, encodeConnectFrame, parseLoopbackLsAddress } from '../../src/adapters/antigravity/ls-transport.mjs';
import { mapQuotaSummary, mapSessionTelemetry } from '../../src/adapters/antigravity/telemetry-mapper.mjs';

test('parseLoopbackLsAddress normalizes schemeless loopback and rejects non-loopback hosts', () => {
  const norm = parseLoopbackLsAddress('localhost:42424');
  assert.equal(norm.protocol, 'http:');
  assert.equal(norm.hostname, 'localhost');
  assert.equal(norm.port, 42424);

  assert.throws(() => parseLoopbackLsAddress('http://192.168.1.10:42424'));
  assert.throws(() => parseLoopbackLsAddress('https://evil.example:443'));
  assert.throws(() => parseLoopbackLsAddress('localhost:99999'));
});

test('Connect 5B stream enforces status===200, 4MB frame cap, and safe early destroy (F3)', async () => {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (mode === 'bad_status') {
      res.writeHead(500, { 'content-type': 'application/connect+json' });
      res.end();
      return;
    }
    if (mode === 'oversize_frame') {
      res.writeHead(200, { 'content-type': 'application/connect+json' });
      const hdr = Buffer.alloc(5);
      hdr[0] = 0;
      hdr.writeUInt32BE(5 * 1024 * 1024, 1); // 5MB > 4MB cap
      res.write(hdr);
      res.end();
      return;
    }
    // mode === 'ok': send 1st snapshot frame and keep stream open to verify clean early destroy()
    res.writeHead(200, { 'content-type': 'application/connect+json' });
    res.write(
      encodeConnectFrame({
        update: {
          conversationId: 'sess-1',
          contextWindowUsage: { estimatedTokensUsed: 42000, maxContextTokens: 200000 },
        },
      }),
    );
    // Intentionally do not end() immediately; client must destroy() without unhandled error
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const transport = createLsTransport({ lsAddress: `127.0.0.1:${port}`, csrfToken: 'csrf-1' });

    // 1. Valid 1st frame + safe early destroy
    const frame = await transport.readFirstStreamFrame('StreamAgentStateUpdates', {
      conversationId: 'sess-1',
    });
    assert.equal(frame.update.conversationId, 'sess-1');

    // 2. Non-200 status rejected before buffering
    mode = 'bad_status';
    await assert.rejects(() =>
      transport.readFirstStreamFrame('StreamAgentStateUpdates', { conversationId: 'sess-1' }),
    );

    // 3. > 4MB frame length rejected before buffering
    mode = 'oversize_frame';
    await assert.rejects(() =>
      transport.readFirstStreamFrame('StreamAgentStateUpdates', { conversationId: 'sess-1' }),
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mapSessionTelemetry enforces F4 post-compaction guard and Gemini cache formula', () => {
  // Post-compaction active: lastCompactedStep >= max(lastMetaStepIndex, lastStepIndex) && afterCompact > 0
  const postCompact = mapSessionTelemetry({
    requestedSessionId: 'sess-1',
    streamFrame: {
      update: {
        conversationId: 'sess-1',
        compactionInfo: { lastCompactedStepIndex: 10 },
        contextWindowUsage: {
          estimatedTokensUsed: 190_000,
          estimatedAfterCompaction: 25_000,
          maxContextTokens: 200_000,
          lastStepIndex: 10,
          tokenGroups: [{ groupType: 'TOKEN_GROUP_SYSTEM_PROMPT', estimatedTokens: 4000 }],
        },
      },
    },
    generatorMetadata: [
      {
        stepIndex: 9,
        chatModel: {
          model: 'gemini-2.5-pro',
          usage: {
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            inputTokens: '7049',
            cacheReadTokens: '452934',
          },
        },
      },
    ],
  });

  assert.equal(postCompact.usedTokens, 25_000);
  assert.equal(postCompact.usedTokensSource, 'after_compaction');
  assert.equal(postCompact.cacheHitPercent, 98.5);
  assert.equal(postCompact.tokenBreakdown.length, 1);

  // When new steps occurred after compaction (lastStepIndex 12 > lastCompactedStep 10), use estimatedTokensUsed
  const afterNewTurn = mapSessionTelemetry({
    requestedSessionId: 'sess-1',
    streamFrame: {
      update: {
        conversationId: 'sess-1',
        compactionInfo: { lastCompactedStepIndex: 10 },
        contextWindowUsage: {
          estimatedTokensUsed: 55_000,
          estimatedAfterCompaction: 25_000,
          maxContextTokens: 200_000,
          lastStepIndex: 12,
        },
      },
    },
  });
  assert.equal(afterNewTurn.usedTokens, 55_000);
  assert.equal(afterNewTurn.usedTokensSource, 'estimated');
});

test('compaction-adapter rejects UNC exe paths and runs bounded spawn fallback only on RPC failure (F6)', async () => {
  assert.equal(resolveSafeAgentApiExe('\\\\evil-server\\share\\agentapi.exe'), null);
  assert.equal(resolveSafeAgentApiExe('//evil-server/share/agentapi'), null);
  assert.equal(resolveSafeAgentApiExe('relative/path/agentapi'), null);

  // Use current Node binary as a safe existing executable for bounded spawn test
  let rpcShouldFail = false;
  const fakeTransport = {
    callUnaryRpc: async () => {
      if (rpcShouldFail) throw new Error('RPC unavailable');
      return {};
    },
  };

  let spawnCalled = 0;
  const adapter = createAntigravityCompactionAdapter({
    lsTransport: fakeTransport,
    agentApiExePath: process.execPath,
    spawnFn: (_exe, _args, opts) => {
      spawnCalled += 1;
      assert.equal(opts.shell, false);
      assert.equal(opts.windowsHide, true);
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
      // Emit > 64KB to verify F6 bounded drain does not crash or exceed cap
      return spawn(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(100000)); process.stderr.write('e'.repeat(100000));"],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal },
      );
    },
  });

  // 1. Primary RPC succeeds -> fallback MUST NOT run
  const primaryRes = await adapter.compactSession('sess-1');
  assert.equal(primaryRes.accepted, true);
  assert.equal(primaryRes.method, 'rpc');
  assert.equal(spawnCalled, 0);

  // 2. Primary RPC fails -> bounded spawn fallback runs and succeeds even with > 64KB stdio (F6)
  rpcShouldFail = true;
  const fallbackRes = await adapter.compactSession('sess-1');
  assert.equal(fallbackRes.accepted, true);
  assert.equal(fallbackRes.method, 'agentapi');
  assert.equal(spawnCalled, 1);
  assert.equal(adapter.activeChildCount, 0);

  // 3. When both primary RPC fails and no valid exe -> accepted: false
  const failAdapter = createAntigravityCompactionAdapter({
    lsTransport: fakeTransport,
    agentApiExePath: null,
  });
  const failRes = await failAdapter.compactSession('sess-1');
  assert.equal(failRes.accepted, false);
  failAdapter.dispose();
  adapter.dispose();
});

test('mapQuotaSummary handles 5h/weekly buckets and honest unavailable', () => {
  const mapped = mapQuotaSummary({
    data: {
      groups: [
        {
          label: 'Gemini Models',
          buckets: [
            { window: '5h', remainingFraction: 0.85, resetTime: '2026-11-19T05:00:00Z' },
            { window: 'weekly', remainingFraction: 0.92, resetTime: '2026-11-25T00:00:00Z' },
          ],
        },
      ],
    },
    stale: false,
    fetchedAt: 1000,
  });
  assert.equal(mapped.available, true);
  assert.equal(mapped.groups[0].buckets[0].remainingPercent, 85);
  assert.equal(mapped.groups[0].buckets[1].remainingPercent, 92);

  const empty = mapQuotaSummary({ data: null, stale: true, fetchedAt: 1000 });
  assert.equal(empty.available, false);
});
