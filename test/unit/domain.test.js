'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTEXT_WINDOWS,
  PRESET_CONTEXT_WINDOWS,
  MAX_SESSION_ENTRIES,
  normalizeContextWindow,
  getCwLimit,
  createContextWindowStore,
} = require('../../src/domain/context-window-policy');
const {
  fmtK,
  fmtNum,
  fmtResetTime,
  extractStatsFromMetas,
  parseQuotaResponse,
  isStateForCascade,
  applyRealtimeCompactionAndUsage,
  extractVersionMetrics,
} = require('../../src/domain/metrics-calculator');
const {
  DEFAULT_LOCALE,
  DEFAULT_COMPACT_PROMPT,
  resolveLocale,
  createTranslator,
} = require('../../src/domain/i18n');
const {
  validateTransportPort,
  validateStoragePort,
  validateEnginePort,
  getOrCreatePluginBus,
  PLUGIN_BUS_SYMBOL,
} = require('../../src/ports/contracts');
const {
  createTextCodec,
  mergeCheckpointIntoProtobufBytes,
  buildConnectFramedBytes,
  injectCheckpointPayload,
} = require('../../src/drivers/antigravity/protobuf-wire-codec');
const { DEFAULT_HOST_ADAPTER_CONFIG, resolveHostAdapterConfig } = require('../../src/drivers/antigravity/host-config');

describe('v2.0 Domain, Ports, Codecs, HostConfig & Hexagonal Boundary Suite', () => {
  it('SB2-TC-001 (D-0009, D-0014, D-0018, D-0021): Context window clamping, 200-entry LRU eviction, and cookie-only override restoration', async () => {
    assert.deepEqual(CONTEXT_WINDOWS, ['256K', '512K', '900K']);
    assert.deepEqual(PRESET_CONTEXT_WINDOWS, ['128K', '256K', '384K', '512K', '750K', '900K']);
    assert.equal(MAX_SESSION_ENTRIES, 200);

    assert.equal(normalizeContextWindow('16K'), '32K');
    assert.equal(normalizeContextWindow('1200K'), '980K');
    assert.equal(normalizeContextWindow('0.5m'), '500K');
    assert.equal(normalizeContextWindow('500000'), '500K');
    assert.equal(normalizeContextWindow('invalid'), null);
    assert.equal(getCwLimit('400K'), 400000);

    const persisted = {
      defaultCw: null,
      sessionMap: null,
      tsMap: null,
    };
    const lazyOverrides = { 's-fresh-cookie': { cw: '900K', ts: 500 } };
    const evictedIds = [];
    const storage = {
      loadSnapshot: () => persisted,
      loadPersistent: async () => ({
        sessionMap: { 's-cookie-only': '750K' },
        tsMap: { 's-cookie-only': 100 },
        defaultCw: '384K',
      }),
      readSessionOverride: (cid) => lazyOverrides[cid] || null,
      saveSessionOverride: (cid, cw, meta = {}) => {
        if (cid && cw) lazyOverrides[cid] = { cw, ts: meta.ts || 1 };
        if (meta.sessionMap !== undefined) persisted.sessionMap = meta.sessionMap;
        if (meta.tsMap !== undefined) persisted.tsMap = meta.tsMap;
      },
      evictSessionOverride: (cid) => {
        evictedIds.push(cid);
        delete lazyOverrides[cid];
      },
      saveDefaultLimit: (cw, meta = {}) => {
        persisted.defaultCw = cw;
        if (meta.tsMap !== undefined) persisted.tsMap = meta.tsMap;
      },
    };
    validateStoragePort(storage);

    const customSeen = [];
    const savedEvents = [];
    const store = createContextWindowStore({
      storage,
      onCustomCw: (cw) => customSeen.push(cw),
      onSaveCw: (cid, cw) => savedEvents.push({ cid, cw }),
    });
    await store.loadPersistentContextSettings();

    // Persistent + lazy override preserved even with older monotonic seed attempt (D-0018)
    assert.equal(store.getSavedContextWindow('s-cookie-only'), '750K');
    assert.equal(store.getDefaultCw(), '384K');

    assert.equal(store.getSavedContextWindow('s-fresh-cookie'), '900K');
    store.seedSessionIfEmpty('s-fresh-cookie', '128K');
    assert.equal(store.getSavedContextWindow('s-fresh-cookie'), '900K');

    // 200-entry synchronized LRU eviction
    for (let i = 0; i < 215; i++) {
      store.saveContextWindowSetting(`sess-${i}`, i % 2 === 0 ? '400K' : '640K', { updatedAtMs: 1000 + i });
    }
    const serialized = typeof persisted.sessionMap === 'string' ? JSON.parse(persisted.sessionMap) : persisted.sessionMap;
    const serializedTs = typeof persisted.tsMap === 'string' ? JSON.parse(persisted.tsMap) : persisted.tsMap;
    assert.equal(Object.keys(serialized).length, 200);
    assert.equal(Object.keys(serializedTs).length, 200);
    assert.equal(serialized['sess-0'], undefined);
    assert.ok(evictedIds.includes('sess-0'), 'Evicted session override must be cleaned up');
    assert.equal(store.saveContextWindowSetting('__proto__', '512K'), null);
    assert.equal(store.saveContextWindowSetting('constructor', '512K'), null);
    assert.equal(store.saveContextWindowSetting('bad;id=1', '512K'), null);
    assert.ok(serialized['sess-214']);
    assert.ok(customSeen.includes('400K'));
    assert.ok(savedEvents.length > 0);
  });

  it('SB2-TC-002 (D-0007, D-0012, D-0033): Metrics parsing, fail-closed isStateForCascade, quota oneofs, and en/ko i18n translator', () => {
    assert.equal(fmtK(0), '0');
    assert.equal(fmtK(256400), '256k');
    assert.equal(fmtK(1500000), '1.5M');
    assert.equal(fmtNum(123456), '123,456');
    assert.match(fmtResetTime({ seconds: 1700000000 }), /^→\d{2}:\d{2}$/);

    // Estimated tokens 0 handling
    const zeroStats = extractStatsFromMetas([
      {
        stepIndices: [0],
        chatModel: {
          chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 0, maxContextTokens: 256000 } },
          usage: { inputTokens: 100, cacheReadTokens: 900 },
        },
      },
    ]);
    assert.equal(zeroStats.foundCtx, true);
    assert.equal(zeroStats.used, 0);
    assert.equal(zeroStats.cachePct, 90);

    // Fail-closed isStateForCascade (D-0033)
    assert.equal(isStateForCascade({ conversationId: 'cid-a' }, 'cid-a'), true);
    assert.equal(isStateForCascade({ conversationId: 'cid-b' }, 'cid-a'), false);
    assert.equal(isStateForCascade({ trajectoryId: 'other' }, 'cid-a'), false);
    assert.equal(isStateForCascade(null, 'cid-a'), false);
    assert.equal(isStateForCascade({ conversationId: 'cid-a' }, ''), false);

    // Post-compaction real-time reduction
    const compacted = applyRealtimeCompactionAndUsage(
      { used: 220000, foundCtx: true, foundUsage: true, lastMetaStepIndex: 10 },
      {
        compactedAtStepIndices: [12],
        contextWindowUsage: {
          estimatedTokensUsed: 220000,
          estimatedAfterCompaction: 48000,
          maxContextTokens: 512000,
          lastStepIndex: 12,
        },
      }
    );
    assert.equal(compacted.used, 48000);
    assert.equal(compacted.trajectoryMax, 512000);

    // Quota protobuf-es response parsing
    const quota = parseQuotaResponse({
      response: {
        groups: [
          {
            displayName: 'Gemini Quota',
            buckets: [
              {
                window: '5h',
                remaining: { case: 'remainingFraction', value: 0.85 },
                resetTime: '2026-11-18T15:00:00Z',
              },
              {
                window: 'weekly',
                remainingFraction: 0.92,
              },
            ],
          },
        ],
      },
    });
    assert.equal(quota.pct5h, 85);
    assert.equal(quota.pct7d, 92);
    assert.equal(extractVersionMetrics({ trajectorySlice: { totalStepsLength: 3, totalGeneratorMetadataLength: 2 } }).versionKey, '2:3:-1:0');

    // i18n default en + ko toggle + prompt
    assert.equal(DEFAULT_LOCALE, 'en');
    assert.ok(DEFAULT_COMPACT_PROMPT.length > 20);
    assert.equal(resolveLocale('auto', 'ko-KR'), 'ko');
    assert.equal(resolveLocale('auto', 'en-US'), 'en');
    const tr = createTranslator('en');
    assert.equal(tr.getLocale(), 'en');
    assert.equal(tr.t('menu.headerLeft'), 'Session Context Limit');
    tr.setLocale('ko');
    assert.equal(tr.t('menu.headerLeft'), '컨텍스트 한도 설정');

    // Port validators & Plugin Bus v2
    const noop = () => {};
    assert.throws(() => validateTransportPort({}), /missing required method/);
    assert.throws(() => validateStoragePort(null), /must be an object/);
    assert.throws(() => validateEnginePort({ observeSessions: noop }), /missing required method/);

    const host = {};
    const bus1 = getOrCreatePluginBus(host);
    const bus2 = getOrCreatePluginBus(host);
    assert.equal(bus1, bus2);
    assert.equal(host[PLUGIN_BUS_SYMBOL], bus1);
    const seenEvents = [];
    const off = bus1.on('plugin:registered', (e) => seenEvents.push(e.id));
    const unreg = bus1.registerPlugin('sample-plugin', { version: '2.0.0', capabilities: ['test'] });
    assert.equal(bus1.listPlugins().length, 1);
    assert.deepEqual(seenEvents, ['sample-plugin']);
    unreg();
    off();
    assert.equal(bus1.listPlugins().length, 0);
  });

  it('SB2-TC-003 (D-0008, D-0019, D-0022): Protobuf & Connect frame checkpoint codec merges field 5 and skips field 20 / continue_after_injection', () => {
    const codec = createTextCodec();
    const rpcPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
    const jsonUpdatedRaw = injectCheckpointPayload({
      path: rpcPath,
      body: JSON.stringify({ cascadeId: 'c1', cascadeConfig: { plannerConfig: { mode: 1 } } }),
      contextWindow: '512K',
      maxTokenLimit: 512000,
      codec,
    });
    const jsonUpdated = JSON.parse(jsonUpdatedRaw);
    assert.equal(jsonUpdated.cascadeConfig.checkpointConfig.maxTokenLimit, 512000);
    assert.equal(jsonUpdated.cascadeConfig.plannerConfig.mode, 1);

    const skippedBody = JSON.stringify({ cascadeId: 'c1', continueAfterInjection: true });
    assert.equal(
      injectCheckpointPayload({ path: rpcPath, body: skippedBody, contextWindow: '512K', maxTokenLimit: 512000, codec }),
      skippedBody
    );

    // Non-SendUserCascadeMessage paths must pass through untouched
    const rawOther = JSON.stringify({ cascadeId: 'c1' });
    assert.equal(
      injectCheckpointPayload({ path: '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', body: rawOther, contextWindow: '512K', maxTokenLimit: 512000, codec }),
      rawOther
    );

    // Build wire message: field 1 string "c1", field 5 { field 1 varint 7 (preserved) }
    const f1 = Buffer.from([0x0a, 0x02, 0x63, 0x31]);
    const innerF1 = Buffer.from([0x08, 0x07]);
    const f5 = Buffer.concat([Buffer.from([0x2a, innerF1.length]), innerF1]);
    const rawMsg = Buffer.concat([f1, f5]);
    const patchedWire = mergeCheckpointIntoProtobufBytes(rawMsg, 900000, '900K', codec.encodeTextToBytes);
    assert.ok(patchedWire && patchedWire.length > rawMsg.length);
    // Re-injecting idempotently strips trailing tag 8 before appending fresh tag 8
    const rePatchedWire = mergeCheckpointIntoProtobufBytes(patchedWire, 750000, '750K', codec.encodeTextToBytes);
    assert.ok(rePatchedWire);

    // Connect 5-byte envelope (flag=0 + JSON)
    const framed = buildConnectFramedBytes(0, codec.encodeTextToBytes(JSON.stringify({ cascadeId: 'c1' })));
    const envelopeOut = injectCheckpointPayload({
      path: rpcPath,
      body: framed,
      contextWindow: '512K',
      maxTokenLimit: 512000,
      codec,
    });
    assert.ok(envelopeOut instanceof Uint8Array);
    const outLen = (envelopeOut[1] << 24) | (envelopeOut[2] << 16) | (envelopeOut[3] << 8) | envelopeOut[4];
    const parsedOut = JSON.parse(Buffer.from(envelopeOut.slice(5, 5 + outLen)).toString('utf8'));
    assert.equal(parsedOut.cascadeConfig.checkpointConfig.maxTokenLimit, 512000);

    // Compressed envelope (flag=1) untouched
    const compFramed = buildConnectFramedBytes(1, new Uint8Array([1, 2, 3]));
    assert.equal(
      injectCheckpointPayload({ path: rpcPath, body: compFramed, contextWindow: '512K', maxTokenLimit: 512000, codec }),
      compFramed
    );
  });

  it('SB2-TC-004 (D-0027, D-0031): Host config enforces exact/dot-boundary isRemoteHost and HTTPS-only URLs without sibling coupling', () => {
    const cfg = resolveHostAdapterConfig({
      locale: 'ko',
      compactPrompt: 'Custom summary prompt',
      cdnOrigin: 'https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js',
    });

    assert.equal(cfg.isRemoteHost('antigravity.google.com'), true);
    assert.equal(cfg.isRemoteHost('web.antigravity.google.com'), true);
    assert.equal(cfg.isRemoteHost('antigravity.google.com.evil.example'), false);
    assert.equal(cfg.isRemoteHost('evil-antigravity.google.com'), false);
    assert.equal(cfg.isRemoteHost('127.0.0.1'), false);

    assert.equal(cfg.locale, 'ko');
    assert.equal(cfg.compactPrompt, 'Custom summary prompt');
    assert.equal(
      resolveHostAdapterConfig({ cdnOrigin: 'http://insecure.example/x.js' }).cdnOrigin,
      DEFAULT_HOST_ADAPTER_CONFIG.cdnOrigin
    );
    assert.equal(
      resolveHostAdapterConfig({ cdnOrigin: 'https://user:pass@example.com/x.js' }).cdnOrigin,
      DEFAULT_HOST_ADAPTER_CONFIG.cdnOrigin
    );
    // Reject DOM-clobbering, single-label domains, and unsafe rpcServicePrefix
    const clobberedWin = {
      __AGY_HOST_ADAPTER_CONFIG__: { nodeType: 1, rpcServicePrefix: '//evil.com' },
      __AGY_STATUSBAR_HOST_CONFIG__: { locale: 'ko' },
      __APP_CONFIG__: { csrfToken: ' csrf-123 ' },
    };
    const safeFromClobber = resolveHostAdapterConfig(
      { rpcServicePrefix: '//evil.example/rpc', remoteHostDomains: ['com', 'evil'] },
      clobberedWin
    );
    assert.equal(safeFromClobber.rpcServicePrefix, DEFAULT_HOST_ADAPTER_CONFIG.rpcServicePrefix);
    assert.deepEqual(safeFromClobber.remoteHostDomains, DEFAULT_HOST_ADAPTER_CONFIG.remoteHostDomains);
    assert.equal(safeFromClobber.locale, 'ko');
    assert.equal(safeFromClobber.resolveCsrfToken(clobberedWin), 'csrf-123');
    assert.equal(safeFromClobber.resolveCsrfToken({ __APP_CONFIG__: { nodeType: 1, csrfToken: 'bad' } }), '');
  });

  it('Static Hexagonal Architecture & Standalone Boundary Check (zero sibling URLs, zero HTML sinks, strict imports)', () => {
    const rootDir = path.join(__dirname, '..', '..');
    const srcLayers = ['ports', 'domain', 'drivers/antigravity', 'ui', 'app'];

    const collectFiles = (dir) => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectFiles(abs));
        else if (entry.name.endsWith('.js')) out.push(abs);
      }
      return out;
    };

    const layerOf = (abs) => {
      const rel = path.relative(path.join(rootDir, 'src'), abs).replace(/\\/g, '/');
      if (rel.startsWith('ports/')) return 'ports';
      if (rel.startsWith('domain/')) return 'domain';
      if (rel.startsWith('drivers/')) return 'drivers';
      if (rel.startsWith('ui/')) return 'ui';
      if (rel.startsWith('app/index.js')) return 'app_root';
      if (rel.startsWith('app/')) return 'app';
      return 'other';
    };

    const files = srcLayers.flatMap((d) => collectFiles(path.join(rootDir, 'src', d)));
    assert.ok(files.length >= 16, `Expected >= 16 v2 source modules, found ${files.length}`);

    const forbiddenStrings = ['mcp-manager', 'ko-thought-translator', 'innerHTML', 'outerHTML', 'insertAdjacentHTML'];
    const allowedDeps = {
      ports: new Set(['ports']),
      domain: new Set(['ports', 'domain']),
      drivers: new Set(['ports', 'domain', 'drivers']),
      ui: new Set(['ports', 'domain', 'ui']),
      app: new Set(['ports', 'domain', 'ui', 'app']),
      app_root: new Set(['ports', 'domain', 'drivers', 'ui', 'app']),
    };

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      const rel = path.relative(rootDir, file).replace(/\\/g, '/');
      for (const bad of forbiddenStrings) {
        assert.equal(code.includes(bad), false, `${rel} must never contain "${bad}"`);
      }
      assert.equal(code.includes('createHTML'), false, `${rel} must never define or touch createHTML TrustedTypes sinks`);
      if (!rel.endsWith('drivers/antigravity/companion-driver.js')) {
        assert.equal(/\.createPolicy\s*\(/.test(code), false, `${rel} must never invoke trustedTypes.createPolicy`);
      } else {
        assert.ok(code.includes('agy-sb-companion-'), `${rel} script policy must use scoped agy-sb-* prefix`);
      }

      const myLayer = layerOf(file);
      if (myLayer === 'ports' || myLayer === 'domain' || myLayer === 'ui' || myLayer === 'app' || myLayer === 'app_root') {
        assert.equal(code.includes('__APP_CONFIG__'), false, `${rel} must never reference vendor __APP_CONFIG__ directly`);
      }
      if (myLayer === 'ports' || myLayer === 'domain') {
        assert.equal(/Cookie|localStorage/i.test(code), false, `${rel} must remain storage-mechanism neutral`);
      }
      if (myLayer === 'ui') {
        assert.equal(
          /ga-remote-control|data-cascade-id|remote-session|exa\.language_server_pb/.test(code),
          false,
          `${rel} must never embed Antigravity host DOM selectors or placeholders`
        );
      }
      const reqMatches = [...code.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)];
      for (const m of reqMatches) {
        const resolved = path.resolve(path.dirname(file), `${m[1]}.js`);
        const targetLayer = layerOf(resolved);
        assert.ok(
          allowedDeps[myLayer].has(targetLayer),
          `Hexagonal violation in ${rel} (${myLayer}): forbidden import from ${m[1]} (${targetLayer})`
        );
      }
    }

    const ciYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.equal(ciYml.includes('antigravity-mcp-manager'), false, 'ci.yml must not reference sibling repo');
    assert.equal(ciYml.includes('ko-thought-translator'), false, 'ci.yml must not reference sibling repo');
    assert.ok(ciYml.includes('develop'), 'ci.yml must cover develop branch (D-0028)');

    const relNotes = fs.readFileSync(path.join(rootDir, 'RELEASE_NOTES.md'), 'utf8');
    assert.ok(relNotes.includes('## [English] `v2.0.0` Release Notes'), 'RELEASE_NOTES.md must contain inline English edition (D-0029)');
    assert.ok(relNotes.includes('## [한국어] `v2.0.0` 릴리즈 노트'), 'RELEASE_NOTES.md must contain inline Korean edition (D-0029)');
  });
});
