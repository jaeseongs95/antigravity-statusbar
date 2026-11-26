import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installPlugin, parseArgs } from '../../scripts/install-plugin.mjs';
import { createAntigravityCompactionAdapter, resolveSafeAgentApiExe } from '../../src/adapters/antigravity/compaction-adapter.mjs';
import { createLsTransport, encodeConnectFrame, parseLoopbackLsAddress } from '../../src/adapters/antigravity/ls-transport.mjs';
import { createSidecarServer, resolvePreferredSidecarPort, startSidecar } from '../../src/adapters/antigravity/sidecar-entry.mjs';
import {
  extractLatestUsageMetadata,
  extractTailCheckpoint,
  mapQuotaSummary,
  mapSessionTelemetry,
  normalizeResetTime,
} from '../../src/adapters/antigravity/telemetry-mapper.mjs';
import { createStatusbarService } from '../../src/core/app/statusbar-service.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function stopSidecarChildGracefully(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32' && child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
  } else {
    child.kill('SIGTERM');
  }
  let fallbackTimer = null;
  await Promise.race([
    exitPromise,
    new Promise((resolve) => {
      fallbackTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {}
        resolve();
      }, 4_000);
    }),
  ]);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  if (child.exitCode === null && child.signalCode === null) {
    await exitPromise;
  }
}

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
  await failAdapter.dispose();
  await adapter.dispose();
});

test('compaction-adapter appends custom compact prompt to SendUserCascadeMessage items and agentapi fallback', async () => {
  const rpcCalls = [];
  let rpcShouldFail = false;
  const fakeTransport = {
    callUnaryRpc: async (method, payload) => {
      rpcCalls.push({ method, payload });
      if (rpcShouldFail) throw new Error('RPC unavailable');
      return {};
    },
  };

  const spawnArgsList = [];
  const adapter = createAntigravityCompactionAdapter({
    lsTransport: fakeTransport,
    agentApiExePath: process.execPath,
    spawnFn: (_exe, args, opts) => {
      spawnArgsList.push(args);
      return spawn(process.execPath, ['-e', 'process.exit(0)'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: opts.signal,
      });
    },
  });

  // 1. Primary RPC with custom prompt appends { text: ' <prompt>' } after slashCommand
  const res1 = await adapter.compactSession('sess-p', { prompt: '핵심 결정사항만 유지해줘' });
  assert.equal(res1.accepted, true);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].method, 'SendUserCascadeMessage');
  assert.equal(rpcCalls[0].payload.items.length, 2);
  assert.equal(rpcCalls[0].payload.items[0].item.slashCommand.info.name, 'compact');
  assert.deepEqual(rpcCalls[0].payload.items[1], { text: ' 핵심 결정사항만 유지해줘' });

  // 2. Fallback spawn receives `/compact <prompt>`
  rpcShouldFail = true;
  const res2 = await adapter.compactSession('sess-p', { prompt: '핵심 결정사항만 유지해줘' });
  assert.equal(res2.accepted, true);
  assert.equal(res2.method, 'agentapi');
  assert.deepEqual(spawnArgsList[0], ['agentapi', 'send-message', 'sess-p', '/compact 핵심 결정사항만 유지해줘']);

  await adapter.dispose();
});

test('R4-F1 (D-0020): async dispose() terminates live SIGTERM-trapping child via SIGKILL escalation', async () => {
  let spawnedChild = null;
  const adapter = createAntigravityCompactionAdapter({
    lsTransport: {
      callUnaryRpc: async () => {
        throw new Error('RPC unavailable');
      },
    },
    agentApiExePath: process.execPath,
    fallbackTimeoutMs: 15_000,
    spawnFn: (_exe, _args, opts) => {
      // Child intentionally ignores SIGTERM (on POSIX) and stays alive until SIGKILL
      spawnedChild = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 10000);",
        ],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal },
      );
      return spawnedChild;
    },
  });

  const compactPromise = adapter.compactSession('sess-kill-test');

  // Wait until child prints READY so SIGTERM trap is registered
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child did not emit READY')), 5_000);
    const check = setInterval(() => {
      if (spawnedChild && spawnedChild.stdout) {
        clearInterval(check);
        spawnedChild.stdout.on('data', (chunk) => {
          if (chunk.toString('utf8').includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    }, 10);
  });

  assert.equal(adapter.activeChildCount, 1);

  // Dispose MUST escalate SIGTERM -> SIGKILL after graceMs and await full exit
  await adapter.dispose({ graceMs: 150 });
  assert.equal(adapter.activeChildCount, 0);
  assert.ok(
    spawnedChild.exitCode !== null || spawnedChild.signalCode !== null,
    'Expected child process to have exited after dispose()',
  );

  const compactRes = await compactPromise;
  assert.equal(compactRes.accepted, false);
});

test('F1: mapSessionTelemetry is Fail-Closed on missing conversationId and parses real Antigravity LS fields', () => {
  // 1. Missing conversationId -> sessionId is '' (NOT requestedSessionId!) so statusbar-service rejects 409
  const missingId = mapSessionTelemetry({
    requestedSessionId: 'sess-1',
    streamFrame: { update: { contextWindowUsage: { estimatedTokensUsed: 1000 } } },
  });
  assert.equal(missingId.sessionId, '');

  // 2. Real Antigravity LS schema: compactedAtStepIndices[], boolean estimatedAfterCompaction,
  //    chatStartMetadata.contextWindowMetadata.tokenBreakdown.groups[].numTokens
  const realSchema = mapSessionTelemetry({
    requestedSessionId: 'sess-1',
    streamFrame: {
      update: {
        conversationId: 'sess-1',
        compactionInfo: { compactedAtStepIndices: [4, 14] },
        contextWindowUsage: {
          estimatedTokensUsed: 28_500,
          estimatedAfterCompaction: true,
          maxContextTokens: 200_000,
          lastStepIndex: 14,
        },
      },
    },
    generatorMetadata: [
      {
        stepIndex: 13,
        chatModel: {
          model: 'gemini-2.5-pro',
          usage: {
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            inputTokens: '7049',
            cacheReadTokens: '452934',
          },
          chatStartMetadata: {
            contextWindowMetadata: {
              tokenBreakdown: {
                groups: [
                  { groupType: 'TOKEN_GROUP_SYSTEM_PROMPT', numTokens: '4200' },
                  { groupType: 'TOKEN_GROUP_USER_MESSAGES', numTokens: '9100' },
                ],
              },
            },
          },
        },
      },
    ],
  });

  assert.equal(realSchema.sessionId, 'sess-1');
  assert.equal(realSchema.lastCompactedStep, 14);
  assert.equal(realSchema.usedTokens, 28_500);
  assert.equal(realSchema.usedTokensSource, 'after_compaction');
  assert.equal(realSchema.compactionJustCompleted, true);
  assert.equal(realSchema.cacheHitPercent, 98.5);
  assert.equal(realSchema.tokenBreakdown.length, 2);
  assert.equal(realSchema.tokenBreakdown[0].tokens, 4200);
  assert.equal(realSchema.tokenBreakdown[1].tokens, 9100);

  // 3. R2-F1: estimatedAfterCompaction: true with newer steps (lastStepIndex 18 > lastCompactedStep 14) -> compactionJustCompleted MUST be false
  const staleAfterCompact = mapSessionTelemetry({
    requestedSessionId: 'sess-1',
    streamFrame: {
      update: {
        conversationId: 'sess-1',
        compactionInfo: { compactedAtStepIndices: [14] },
        contextWindowUsage: {
          estimatedTokensUsed: 52_000,
          estimatedAfterCompaction: true,
          maxContextTokens: 200_000,
          lastStepIndex: 18,
        },
      },
    },
  });
  assert.equal(staleAfterCompact.compactionJustCompleted, false);
  assert.equal(staleAfterCompact.usedTokensSource, 'estimated');

  // 4. R2-F4 & R3-F2 & NB4: protobuf-es oneof { metadata: { case: 'chatModel', value } },
  //    chatModel.chatStartMetadata.startStepIndex, stepIndices[last], contextWindowMetadata.{estimatedTokensUsed, maxContextTokens} fallback,
  //    and skipping empty usage: {} to find earlier valid usage
  const oneofSchema = mapSessionTelemetry({
    requestedSessionId: 'sess-oneof',
    streamFrame: {
      update: {
        conversationId: 'sess-oneof',
        contextWindowUsage: { lastStepIndex: 8 },
      },
    },
    generatorMetadata: [
      {
        stepIndices: [3, 5],
        chatModel: {
          usage: {
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            inputTokens: '5000',
            cacheReadTokens: '45000',
          },
        },
      },
      {
        stepIndices: [6, 8],
        metadata: {
          case: 'chatModel',
          value: {
            modelDisplayName: 'Gemini 2.5 Pro',
            usage: {},
            chatStartMetadata: {
              startStepIndex: 8,
              contextWindowMetadata: {
                estimatedTokensUsed: 44_000,
                maxContextTokens: 256_000,
                tokenBreakdown: {
                  groups: [{ source: 'TOKEN_GROUP_FILES', numTokens: '6500' }],
                },
              },
            },
          },
        },
      },
    ],
  });
  assert.equal(oneofSchema.modelName, 'Gemini 2.5 Pro');
  assert.equal(oneofSchema.usedTokens, 44_000);
  assert.equal(oneofSchema.maxContextTokens, 256_000);
  assert.equal(oneofSchema.cacheHitPercent, 90);
  assert.equal(oneofSchema.tokenBreakdown[0].key, 'TOKEN_GROUP_FILES');
  assert.equal(oneofSchema.tokenBreakdown[0].tokens, 6500);

  // 5. Real oversized >4MB session post-compaction sync:
  //    `stepIndices[last]` (18861) takes precedence over `chatStartMetadata.startStepIndex` (18527),
  //    and a completed CORTEX_STEP_TYPE_CHECKPOINT (18866 > 18861) immediately drops stale pre-compaction tokens!
  const preCompactMeta = [
    {
      stepIndices: [18861],
      chatModel: {
        modelDisplayName: 'Gemini 4 Neon (High)',
        usage: {
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
          inputTokens: '2832',
          cacheReadTokens: '350492',
        },
        chatStartMetadata: {
          startStepIndex: 18527,
          contextWindowMetadata: {
            estimatedTokensUsed: 324_643,
            maxContextTokens: 512_000,
            tokenBreakdown: {
              groups: [
                { source: 'TOKEN_SOURCE_SYSTEM', numTokens: '26360' },
                { source: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: '298283' },
              ],
            },
          },
        },
      },
    },
  ];
  assert.equal(extractLatestUsageMetadata(preCompactMeta)?.stepIndex, 18861);

  const postCompactOversized = mapSessionTelemetry({
    requestedSessionId: 'sess-oversized',
    streamFrame: { update: { conversationId: 'sess-oversized', status: 'CASCADE_RUN_STATUS_IDLE' } },
    trajectorySummary: { summary: 'Big', stepCount: 18867, status: 'CASCADE_RUN_STATUS_IDLE' },
    generatorMetadata: preCompactMeta,
    tailStepsOffset: 18860,
    tailSteps: [
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: { sourceTrajectoryStepInfo: { stepIndex: 18866 } },
        checkpoint: { includedStepIndexEnd: 18866, sessionSummary: 'x'.repeat(15_718) },
      },
    ],
  });
  assert.equal(postCompactOversized.lastCompactedStep, 18866);
  assert.equal(postCompactOversized.compactionJustCompleted, true);
  assert.equal(postCompactOversized.usedTokensSource, 'after_compaction');
  assert.equal(postCompactOversized.usedTokens, 31_600);
  assert.equal(postCompactOversized.cacheHitPercent, null);
  assert.equal(postCompactOversized.hostCompactionInProgress, false);

  // Once the next post-compaction PLANNER_RESPONSE runs (stepIndices [18872] > 18866),
  // switch seamlessly back to live cwmEst even though startStepIndex stays 18866.
  const nextTurnAfterCompact = mapSessionTelemetry({
    requestedSessionId: 'sess-oversized',
    streamFrame: { update: { conversationId: 'sess-oversized', status: 'CASCADE_RUN_STATUS_IDLE' } },
    trajectorySummary: { summary: 'Big', stepCount: 18873, status: 'CASCADE_RUN_STATUS_IDLE' },
    generatorMetadata: [
      ...preCompactMeta,
      {
        stepIndices: [18872],
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (High)',
          usage: { apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '33061', cacheReadTokens: '0' },
          chatStartMetadata: {
            startStepIndex: 18866,
            contextWindowMetadata: { estimatedTokensUsed: 41_065, maxContextTokens: 512_000 },
          },
        },
      },
    ],
    tailStepsOffset: 18866,
    tailSteps: [
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        checkpoint: { includedStepIndexEnd: 18866, sessionSummary: 'x'.repeat(15_718) },
      },
    ],
  });
  assert.equal(nextTurnAfterCompact.usedTokens, 41_065);
  assert.equal(nextTurnAfterCompact.usedTokensSource, 'estimated');
  assert.equal(nextTurnAfterCompact.compactionJustCompleted, false);

  // Running CHECKPOINT step surfaces hostCompactionInProgress: true
  const runningCp = extractTailCheckpoint([
    { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_RUNNING' },
  ], 18866);
  assert.equal(runningCp.inProgress, true);
  assert.equal(runningCp.lastCompletedStep, null);
});

test('F1 & R2-F4 & NB2: mapQuotaSummary parses real response.groups, displayName, remaining.case, and protobuf Timestamp resetTime', () => {
  const isoFromProto = normalizeResetTime({ seconds: '1795070000', nanos: 0 });
  assert.ok(isoFromProto && isoFromProto.endsWith('Z'));
  // NB2: null/empty seconds must return null (not 1970 epoch)
  assert.equal(normalizeResetTime({ seconds: null }), null);
  assert.equal(normalizeResetTime({ seconds: '' }), null);
  assert.equal(normalizeResetTime({ seconds: '   ' }), null);

  const mapped = mapQuotaSummary({
    data: {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                window: '5h',
                remaining: { case: 'remainingFraction', value: 0.85 },
                resetTime: { seconds: '1795070000', nanos: 0 },
              },
              {
                window: 'weekly',
                remaining: { case: 'remainingFraction', value: 0.92 },
                resetTime: '2026-11-25T00:00:00Z',
              },
            ],
          },
        ],
      },
    },
    stale: false,
    fetchedAt: 1000,
  });
  assert.equal(mapped.available, true);
  assert.equal(mapped.groups[0].label, 'Gemini Models');
  assert.equal(mapped.groups[0].buckets[0].remainingPercent, 85);
  assert.equal(mapped.groups[0].buckets[0].resetTime, isoFromProto);
  assert.equal(mapped.groups[0].buckets[1].remainingPercent, 92);

  const empty = mapQuotaSummary({ data: null, stale: true, fetchedAt: 1000 });
  assert.equal(empty.available, false);
});

test('F4: real sidecars/statusbar/main.mjs (startSidecar + createAntigravityTelemetryAdapter + callUnaryRpc) end-to-end', async () => {
  const seenOffsets = [];
  const seenCompactPayloads = [];
  const lsServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      if (req.url?.endsWith('/GetAllCascadeTrajectories')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            trajectorySummaries: {
              'sess-live-1': {
                summary: 'Live E2E Session',
                stepCount: 22,
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-11-19T02:00:00Z',
              },
            },
          }),
        );
        return;
      }
      if (req.url?.endsWith('/StreamAgentStateUpdates')) {
        res.writeHead(200, { 'content-type': 'application/connect+json' });
        res.write(
          encodeConnectFrame({
            update: {
              conversationId: 'sess-live-1',
              status: 'CASCADE_RUN_STATUS_IDLE',
              compactionInfo: { compactedAtStepIndices: [10] },
              trajectorySlice: { totalGeneratorMetadataLength: 5100 },
              contextWindowUsage: {
                estimatedTokensUsed: 64_000,
                estimatedAfterCompaction: false,
                maxContextTokens: 200_000,
                lastStepIndex: 21,
              },
            },
          }),
        );
        return;
      }
      if (req.url?.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
        const parsed = JSON.parse(bodyStr || '{}');
        seenOffsets.push(parsed.generatorMetadataOffset);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            generatorMetadata: [
              {
                stepIndex: 21,
                chatModel: {
                  model: 'gemini-2.5-pro',
                  usage: {
                    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                    inputTokens: '10000',
                    cacheReadTokens: '90000',
                  },
                  chatStartMetadata: {
                    contextWindowMetadata: {
                      tokenBreakdown: {
                        groups: [{ groupType: 'TOKEN_GROUP_SYSTEM_PROMPT', numTokens: '3500' }],
                      },
                    },
                  },
                },
              },
            ],
          }),
        );
        return;
      }
      if (req.url?.endsWith('/RetrieveUserQuotaSummary')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            response: {
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    {
                      window: '5h',
                      remaining: { case: 'remainingFraction', value: 0.77 },
                      resetTime: '2026-11-19T08:00:00Z',
                    },
                  ],
                },
              ],
            },
          }),
        );
        return;
      }
      if (req.url?.endsWith('/SendUserCascadeMessage')) {
        seenCompactPayloads.push(JSON.parse(bodyStr || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((resolve) => lsServer.listen(0, '127.0.0.1', resolve));
  const lsPort = lsServer.address().port;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-e2e-data-'));
  const hostDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-e2e-host-'));
  const token = 'e2e-real-sidecar-token-32chars-ok';

  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'sidecars', 'statusbar', 'main.mjs')], {
    env: {
      ...process.env,
      ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      ANTIGRAVITY_LS_ADDRESS: `localhost:${lsPort}`,
      ANTIGRAVITY_LS_CSRF_TOKEN: 'e2e-csrf',
      ANTIGRAVITY_PLUGIN_DATA_DIR: dataDir,
      ANTIGRAVITY_ADDON_HOST_DATA_DIR: hostDataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    const readyLine = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Sidecar ready timeout')), 8_000);
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited prematurely with code ${code}`));
      });
    });

    const ready = JSON.parse(readyLine);
    assert.equal(ready.type, 'sidecar_ready');
    const port = ready.port;
    const origin = `http://127.0.0.1:${port}`;
    const apiHeaders = {
      'content-type': 'application/json',
      origin,
      'x-statusbar-token': token,
    };

    const sessionsRes = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: apiHeaders,
      body: '{}',
    });
    assert.equal(sessionsRes.status, 200);
    const sessionsData = await sessionsRes.json();
    assert.equal(sessionsData.sessions[0].sessionId, 'sess-live-1');

    const snapRes = await fetch(`${origin}/api/snapshot`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({ sessionId: 'sess-live-1' }),
    });
    assert.equal(snapRes.status, 200);
    const snap = await snapRes.json();
    assert.equal(snap.usedTokens, 64_000);
    assert.equal(snap.cacheHitPercent, 90);
    assert.equal(snap.tokenBreakdown[0].tokens, 3500);
    // F1: Verify tail offset used trajectorySlice.totalGeneratorMetadataLength (5100 - 20 = 5080), NOT 0!
    assert.equal(seenOffsets[0], 5080);

    const quotaRes = await fetch(`${origin}/api/quota`, {
      method: 'POST',
      headers: apiHeaders,
      body: '{}',
    });
    assert.equal(quotaRes.status, 200);
    const quota = await quotaRes.json();
    assert.equal(quota.groups[0].label, 'Gemini Models');
    assert.equal(quota.groups[0].buckets[0].remainingPercent, 77);

    const compactRes = await fetch(`${origin}/api/compact`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({ sessionId: 'sess-live-1' }),
    });
    assert.equal(compactRes.status, 200);
    const compactData = await compactRes.json();
    assert.equal(compactData.accepted, true);
    // R3-F1: Verify exact structured slashCommand ContextScopeItem payload received by LS
    assert.deepEqual(seenCompactPayloads[0], {
      cascadeId: 'sess-live-1',
      items: [
        {
          item: {
            slashCommand: {
              info: {
                name: 'compact',
                type: 'SLASH_COMMAND_TYPE_SYSTEM',
                icon: 'collapse_all',
              },
            },
          },
        },
      ],
    });
    // Verify settingsBridge active payload was published strictly in isolated hostDataDir
    const bridgeRuntimePath = path.join(hostDataDir, 'antigravity-statusbar-runtime.json');
    const publishedBridge = JSON.parse(await fs.readFile(bridgeRuntimePath, 'utf8'));
    assert.equal(publishedBridge.mode, 'active');
    assert.equal(publishedBridge.baseUrl, origin);
    assert.equal(publishedBridge.token, token);

    await stopSidecarChildGracefully(child);
    const afterStopBridge = JSON.parse(
      await fs.readFile(path.join(hostDataDir, 'antigravity-statusbar-runtime.json'), 'utf8'),
    );
    assert.equal(afterStopBridge.mode, 'standby');
    assert.equal(afterStopBridge.baseUrl, null);
    assert.equal(afterStopBridge.token, null);
  } finally {
    await stopSidecarChildGracefully(child);
    lsServer.closeAllConnections?.();
    await new Promise((resolve) => lsServer.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(hostDataDir, { recursive: true, force: true });
  }
});

test('R3-F3, NB3, NB4 & v3.2.0 trusted SHA-256 immutability: install-plugin writes static credential-free renderer untouched by live Sidecar lifecycle while settingsBridge publishes/tears down', async () => {
  assert.throws(() => parseArgs(['--target']), /--target requires/);
  assert.throws(() => parseArgs(['--target', '-x']), /--target requires/);
  assert.throws(() => parseArgs(['--target', '--dry-run']), /--target requires/);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-install-test-'));
  const emptyRepo = path.join(tempRoot, 'empty-repo');
  const destDir = path.join(tempRoot, 'antigravity-statusbar');
  const dataDir = path.join(destDir, 'data');
  const hostDataDir = path.join(tempRoot, 'host-data');

  try {
    // 1. R3-F3: Fail-Closed when node_modules is missing on non-dry-run install
    await fs.mkdir(emptyRepo, { recursive: true });
    await fs.mkdir(hostDataDir, { recursive: true });
    await fs.writeFile(path.join(emptyRepo, 'plugin.json'), '{}', 'utf8');
    await assert.rejects(
      () => installPlugin({ repoRoot: emptyRepo, destDir, dryRun: false }),
      /Missing runtime dependency/,
    );

    // 2. Full install from REPO_ROOT preserves existing data/settings.json
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'settings.json'), '{"locale":"ko"}', 'utf8');

    const res = await installPlugin({ repoRoot: REPO_ROOT, destDir, dryRun: false });
    assert.equal(res.installed, true);

    const parentEntries = await fs.readdir(tempRoot);
    assert.deepEqual(
      parentEntries.filter((name) => name !== 'empty-repo' && name !== 'host-data'),
      ['antigravity-statusbar'],
      'installPlugin must never leave staging or backup directories inside parentDir',
    );

    const preserved = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8');
    assert.equal(preserved, '{"locale":"ko"}');
    const manifest = JSON.parse(await fs.readFile(path.join(destDir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.version, '3.3.0');
    const addonManifest = JSON.parse(
      await fs.readFile(path.join(destDir, 'addon-manifest.v3.json'), 'utf8'),
    );
    assert.equal(addonManifest.schemaVersion, 3);
    assert.equal(addonManifest.apiVersion, 3);
    assert.equal(addonManifest.pluginId, 'antigravity-statusbar');
    assert.equal(addonManifest.version, '3.3.0');
    assert.equal(addonManifest.trustLevel, 'trusted');
    assert.deepEqual(addonManifest.compatibility.surfaces, ['desktop', 'remote-web']);
    assert.deepEqual(addonManifest.compatibility.hostProfiles, [
      'antigravity-desktop',
      'antigravity-remote-web',
    ]);
    assert.equal(addonManifest.compatibility.excludeHostProfiles, undefined);
    assert.equal(addonManifest.compatibility.minHostVersion, '3.1.1');
    assert.deepEqual(addonManifest.permissions.net, {
      localLoopback: ['antigravity-sidecar'],
    });
    assert.equal(addonManifest.permissions.storage, undefined);
    assert.deepEqual(addonManifest.permissions.services, {
      provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }],
    });
    assert.deepEqual(addonManifest.settingsBridge, {
      fileName: 'antigravity-statusbar-runtime.json',
      maxBytes: 16384,
    });
    assert.equal(addonManifest.uiSlots.length, 1);
    assert.equal(addonManifest.uiSlots[0].anchor, 'status-bar');
    assert.equal(addonManifest.entry.rendererScript, 'runtime/statusbar-renderer.js');

    const installedRendererPath = path.join(destDir, 'runtime', 'statusbar-renderer.js');
    const installedSource = await fs.readFile(installedRendererPath, 'utf8');
    assert.ok(installedSource.includes('startAddonStatusbar'));
    assert.equal(installedSource.includes('installed-dest-token-32-chars-ok'), false);
    assert.equal(/http:\/\/127\.0\.0\.1:\d+/.test(installedSource), false);
    const shaBefore = crypto.createHash('sha256').update(installedSource).digest('hex');

    // 3. Boot installed sidecar directly from destDir: rendererScript SHA-256 MUST stay 100% immutable!
    const installedChild = spawn(
      process.execPath,
      [path.join(destDir, 'sidecars', 'statusbar', 'main.mjs')],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_SIDECAR_UI_TOKEN: 'installed-dest-token-32-chars-ok',
          ANTIGRAVITY_LS_ADDRESS: 'localhost:49999',
          ANTIGRAVITY_PLUGIN_DATA_DIR: dataDir,
          ANTIGRAVITY_ADDON_HOST_DATA_DIR: hostDataDir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    try {
      const readyLine = await new Promise((resolve, reject) => {
        let out = '';
        let errOut = '';
        const timer = setTimeout(() => reject(new Error(`Installed sidecar timeout: ${errOut}`)), 8_000);
        installedChild.stdout.on('data', (c) => {
          out += c.toString('utf8');
          const nl = out.indexOf('\n');
          if (nl >= 0) {
            clearTimeout(timer);
            resolve(out.slice(0, nl));
          }
        });
        installedChild.stderr.on('data', (c) => {
          errOut += c.toString('utf8');
        });
        installedChild.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Installed sidecar exited ${code}: ${errOut}`));
        });
      });
      const ready = JSON.parse(readyLine);
      assert.equal(ready.type, 'sidecar_ready');
      assert.ok(ready.port > 0);

      const shaDuring = crypto
        .createHash('sha256')
        .update(await fs.readFile(installedRendererPath, 'utf8'))
        .digest('hex');
      assert.equal(shaDuring, shaBefore, 'trusted runtime/statusbar-renderer.js SHA-256 must never change on Sidecar start');

      const bridgeData = JSON.parse(
        await fs.readFile(path.join(hostDataDir, 'antigravity-statusbar-runtime.json'), 'utf8'),
      );
      assert.equal(bridgeData.mode, 'active');
      assert.equal(bridgeData.baseUrl, `http://127.0.0.1:${ready.port}`);
      assert.equal(bridgeData.token, 'installed-dest-token-32-chars-ok');
    } finally {
      await stopSidecarChildGracefully(installedChild);
    }

    const shaAfter = crypto
      .createHash('sha256')
      .update(await fs.readFile(installedRendererPath, 'utf8'))
      .digest('hex');
    assert.equal(shaAfter, shaBefore, 'trusted runtime/statusbar-renderer.js SHA-256 must never change on Sidecar shutdown');

    const bridgeAfter = JSON.parse(
      await fs.readFile(path.join(hostDataDir, 'antigravity-statusbar-runtime.json'), 'utf8'),
    );
    assert.equal(bridgeAfter.mode, 'standby');
    assert.equal(bridgeAfter.baseUrl, null);
    assert.equal(bridgeAfter.token, null);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('TC-ADDON-11 (v3.2.0): resolvePreferredSidecarPort validates [1024, 65535] precedence and startSidecar falls back to ephemeral port on EADDRINUSE', async () => {
  assert.equal(resolvePreferredSidecarPort({}), 0);
  assert.equal(resolvePreferredSidecarPort({ STATUSBAR_SIDECAR_PORT: '80' }), 0);
  assert.equal(resolvePreferredSidecarPort({ STATUSBAR_SIDECAR_PORT: '70000' }), 0);
  assert.equal(resolvePreferredSidecarPort({ STATUSBAR_SIDECAR_PORT: 'abc' }), 0);
  assert.equal(
    resolvePreferredSidecarPort({
      STATUSBAR_SIDECAR_PORT: '43120',
      ANTIGRAVITY_SIDECAR_WEB_PORT: '43121',
    }),
    43120,
  );
  assert.equal(resolvePreferredSidecarPort({ ANTIGRAVITY_SIDECAR_WEB_PORT: '43121' }), 43121);
  assert.equal(resolvePreferredSidecarPort({ ANTIGRAVITY_SIDECAR_PORT: '43122' }), 43122);

  // Occupy a loopback port so startSidecar must detect EADDRINUSE and fall back to an ephemeral port
  const blocker = http.createServer((_req, res) => res.end());
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = blocker.address().port;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-port-fallback-'));

  let started = null;
  try {
    started = await startSidecar(
      {
        STATUSBAR_SIDECAR_PORT: String(occupiedPort),
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-port-test',
        ANTIGRAVITY_PLUGIN_DATA_DIR: tmpDir,
        STATUSBAR_DISABLE_ADDON_PUBLISH: '1',
        STATUSBAR_SWEEP_INTERVAL_MS: '600000',
      },
      { watchStdin: false },
    );
    assert.ok(started.port > 0);
    assert.notEqual(started.port, occupiedPort, 'EADDRINUSE must fall back to an ephemeral loopback port');
  } finally {
    if (started) await started.stop();
    blocker.closeAllConnections?.();
    await new Promise((resolve) => blocker.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('TC-ADAPTER-SUBAGENT-MODEL (v3.3.0): mapSessionTelemetry and statusbar-service propagate isSubagent and fallback modelName cleanly', async () => {
  const subMapped = mapSessionTelemetry({
    requestedSessionId: 'sess-sub-1',
    streamFrame: { update: { conversationId: 'sess-sub-1', status: 'CASCADE_RUN_STATUS_RUNNING' } },
    trajectorySummary: {
      summary: 'Subagent worker',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      parentCascadeId: 'sess-main-1',
      modelDisplayName: 'Gemini 4 Neon (High)',
    },
    generatorMetadata: [],
  });
  assert.equal(subMapped.isSubagent, true);
  assert.equal(subMapped.modelName, 'Gemini 4 Neon (High)');

  const mainMapped = mapSessionTelemetry({
    requestedSessionId: 'sess-main-1',
    streamFrame: { update: { conversationId: 'sess-main-1', status: 'CASCADE_RUN_STATUS_IDLE' } },
    trajectorySummary: { summary: 'Main chat', status: 'CASCADE_RUN_STATUS_IDLE' },
    generatorMetadata: [
      {
        stepIndices: [1],
        chatModel: { modelDisplayName: 'Claude Opus 5.5' },
      },
    ],
  });
  assert.equal(mainMapped.isSubagent, false);
  assert.equal(mainMapped.modelName, 'Claude Opus 5.5');

  const service = createStatusbarService({
    telemetryPort: {
      listSessions: async () => [],
      getSessionTelemetry: async (sid) => (sid === 'sess-sub-1' ? subMapped : mainMapped),
      getQuotaSummary: async () => ({ available: false, groups: [], stale: false, fetchedAt: Date.now() }),
    },
    compactionPort: { compactSession: async () => ({ accepted: true, method: 'rpc' }) },
    settingsPort: {
      read: async () => ({
        locale: 'ko',
        autoCompact: true,
        autoCompactWhileRunning: 'resume',
        compactPrompt: '',
        defaultCustomLimit: null,
        modelLimits: new Map(),
        sessions: new Map(),
        customButtons: [],
        disabledRuntimeAddonIds: [],
      }),
      update: async () => ({}),
    },
  });

  const subSnap = await service.getSessionSnapshot('sess-sub-1');
  assert.equal(subSnap.isSubagent, true);
  assert.equal(subSnap.modelName, 'Gemini 4 Neon (High)');

  const mainSnap = await service.getSessionSnapshot('sess-main-1');
  assert.equal(mainSnap.isSubagent, false);
  assert.equal(mainSnap.modelName, 'Claude Opus 5.5');
});

test('TC-ADAPTER-QUOTA-REFRESH (v3.3.0): ls-transport bypasses 15s quotaCache on expired resetTime or forceRefresh and /api/quota forwards forceRefresh', async () => {
  let rpcCount = 0;
  let nowMs = Date.parse('2026-11-25T08:00:00Z');
  const resetAtIso = '2026-11-25T08:00:10Z';
  const nextResetIso = '2026-11-25T13:00:00Z';

  const mockLs = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.includes('RetrieveUserQuotaSummary')) {
        rpcCount += 1;
        const payload =
          rpcCount === 1
            ? {
                response: {
                  groups: [
                    {
                      displayName: 'Gemini Models',
                      buckets: [
                        {
                          window: '5h',
                          remainingFraction: 0,
                          resetTime: resetAtIso,
                        },
                      ],
                    },
                  ],
                },
              }
            : {
                response: {
                  groups: [
                    {
                      displayName: 'Gemini Models',
                      buckets: [
                        {
                          window: '5h',
                          remainingFraction: 1,
                          resetTime: nextResetIso,
                        },
                      ],
                    },
                  ],
                },
              };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((resolve) => mockLs.listen(0, '127.0.0.1', resolve));
  const lsPort = mockLs.address().port;

  let sidecar = null;
  try {
    const transport = createLsTransport({
      lsAddress: `127.0.0.1:${lsPort}`,
      csrfToken: 'csrf-quota-refresh',
      clock: () => nowMs,
    });

    // 1. Initial fetch populates cache with 0% bucket expiring at +10s
    const r1 = await transport.getQuotaSummaryRaw();
    assert.equal(rpcCount, 1);
    assert.equal(r1.data.response.groups[0].buckets[0].remainingFraction, 0);

    // 2. At +2s (before resetTime & within 15s TTL) -> served from cache
    nowMs += 2_000;
    const r2 = await transport.getQuotaSummaryRaw();
    assert.equal(rpcCount, 1);
    assert.equal(r2.data.response.groups[0].buckets[0].remainingFraction, 0);

    // 3. At +11s (still within 15s TTL, but resetTime has passed and >=3s since last fetch) -> auto bypasses cache!
    nowMs += 9_000;
    const r3 = await transport.getQuotaSummaryRaw();
    assert.equal(rpcCount, 2, 'Expired bucket resetTime must bypass 15s quotaCache');
    assert.equal(r3.data.response.groups[0].buckets[0].remainingFraction, 1);

    // 4. At +12s (fresh 100% bucket, future resetTime) -> served from cache
    nowMs += 1_000;
    await transport.getQuotaSummaryRaw();
    assert.equal(rpcCount, 2);

    // 5. Explicit forceRefresh: true bypasses cache immediately
    nowMs += 500;
    await transport.getQuotaSummaryRaw({ forceRefresh: true });
    assert.equal(rpcCount, 3, 'forceRefresh: true must bypass 15s quotaCache');

    // 6. Sidecar POST /api/quota forwards { forceRefresh: true } cleanly
    const seenOpts = [];
    const token = 'quota-refresh-test-token-32chars!';
    sidecar = createSidecarServer({
      token,
      service: {
        listSessions: async () => ({ sessions: [], fetchedAt: nowMs }),
        getSessionSnapshot: async () => ({}),
        getQuotaSummary: async (opts) => {
          seenOpts.push(opts);
          return { available: true, groups: [], stale: false, fetchedAt: nowMs };
        },
        getSettings: async () => ({}),
        updateSettings: async () => ({}),
        requestCompaction: async () => ({ accepted: true }),
      },
    });
    const { url } = await sidecar.listen();
    const resNormal = await fetch(`${url}/api/quota`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: url,
        'x-statusbar-token': token,
      },
      body: JSON.stringify({}),
    });
    assert.equal(resNormal.status, 200);
    const resForce = await fetch(`${url}/api/quota`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: url,
        'x-statusbar-token': token,
      },
      body: JSON.stringify({ forceRefresh: true }),
    });
    assert.equal(resForce.status, 200);
    assert.deepEqual(seenOpts, [undefined, { forceRefresh: true }]);
  } finally {
    if (sidecar) await sidecar.close();
    mockLs.closeAllConnections?.();
    await new Promise((resolve) => mockLs.close(resolve));
  }
});
