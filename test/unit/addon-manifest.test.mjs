import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildStaticRenderer, parseBuildArgs } from '../../scripts/build-renderer.mjs';
import { createAddonRegistry } from '../../src/adapters/antigravity/addon/addon-bridge.mjs';
import { createAddonHostAdapter } from '../../src/adapters/antigravity/addon/addon-host-adapter.mjs';
import { createSidecarApiClient } from '../../src/adapters/antigravity/addon/api-client.mjs';
import { createInlineI18n } from '../../src/adapters/antigravity/addon/i18n.mjs';
import {
  assertAddonRegistryPort,
  assertOverlayHostPort,
  assertRendererHostPort,
  assertRendererPublisherPort,
  assertStatusbarApiPort,
} from '../../src/adapters/antigravity/addon/ports.mjs';
import {
  DEFAULT_SETTINGS_BRIDGE_FILE,
  createAddonRuntimePublisher,
  createSettingsBridgePublisher,
  resolveConfinedRendererTarget,
  resolveConfinedSettingsBridgeTarget,
} from '../../src/adapters/antigravity/addon/runtime-publisher.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_TOKEN = 'addon-unit-test-token-32-chars-ok';

test('TC-ADDON-01: addon-manifest.v3.json conforms strictly to AddonManifest.v3 least-privilege schema', async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'addon-manifest.v3.json'), 'utf8'),
  );

  const allowedTopKeys = new Set([
    '$schema',
    'schemaVersion',
    'apiVersion',
    'pluginId',
    'displayName',
    'description',
    'version',
    'trustLevel',
    'compatibility',
    'capabilities',
    'entry',
    'integrity',
    'permissions',
    'uiSlots',
    'isolation',
    'settingsBridge',
    'configBridge',
    'loadOrder',
  ]);
  for (const key of Object.keys(manifest)) {
    assert.ok(allowedTopKeys.has(key), `Unexpected manifest top-level property: ${key}`);
  }

  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.apiVersion, 3);
  assert.equal(manifest.pluginId, 'antigravity-statusbar');
  assert.equal(manifest.displayName, 'Antigravity Statusbar');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, '3.3.1');
  assert.equal(manifest.trustLevel, 'trusted');
  assert.deepEqual(manifest.settingsBridge, {
    fileName: DEFAULT_SETTINGS_BRIDGE_FILE,
    maxBytes: 16384,
  });
  assert.equal(manifest.configBridge, undefined);
  assert.equal(manifest.permissions?.events, undefined, 'Unused events permission must be omitted');
  assert.equal(manifest.permissions?.storage, undefined, 'Unused storage permission must be omitted (no plugin-owned remote URL/token storage)');
  assert.equal(manifest.permissions?.configBridge, undefined, 'Unused configBridge permission must be omitted');
  assert.equal(manifest.permissions?.ui?.dialogs, false);
  assert.equal(manifest.permissions?.ui?.statusItems, false);
  assert.deepEqual(manifest.permissions?.services, {
    provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }],
  });
  assert.deepEqual(manifest.permissions?.net, {
    localLoopback: ['antigravity-sidecar'],
  });
  assert.deepEqual(manifest.permissions?.dom, {
    documentTransform: false,
    anchors: ['status-bar'],
  });
  assert.deepEqual(manifest.compatibility, {
    surfaces: ['desktop', 'remote-web'],
    hostProfile: 'antigravity-desktop',
    hostProfiles: ['antigravity-desktop', 'antigravity-remote-web'],
    minHostVersion: '3.3.0',
  });
  assert.deepEqual(manifest.capabilities, ['renderer']);
  assert.deepEqual(manifest.entry, {
    rendererScript: 'runtime/statusbar-renderer.js',
    mainHookScript: null,
  });
  assert.deepEqual(manifest.uiSlots, [
    {
      slot: 'status-bar',
      slotId: 'antigravity-statusbar.root',
      anchor: 'status-bar',
      exclusive: true,
      scope: 'addon-owned-slot',
      shadow: true,
    },
  ]);
  assert.deepEqual(manifest.isolation, {
    noTranslate: true,
    i18nSelfManaged: true,
    respectsNoTranslate: true,
    storageNamespace: 'antigravity-statusbar',
  });
  assert.equal(manifest.loadOrder, 50);
});

test('TC-ADDON-02: ports.mjs enforces segregated v3 ISP/DIP contracts', () => {
  assert.throws(() => assertRendererHostPort(null), /ERR_INVALID_RENDERER_HOST_PORT/);
  assert.throws(() => assertRendererHostPort({ mountSlot() {} }), /missing_unmountSlot/);
  const validHost = {
    mountSlot() {},
    unmountSlot() {},
    injectStyle() {},
    removeStyle() {},
    onDispose() {},
    showToast() {},
    openPopup() {},
    openModal() {},
    openPanel() {},
    registerCommand() {},
    registerSettingsPage() {},
    addManagedListener() {},
    netFetch() {},
  };
  assert.equal(assertRendererHostPort(validHost), validHost);
  assert.throws(() => assertRendererHostPort({ ...validHost, openModal: 'not-fn' }), /invalid_openModal/);
  assert.throws(() => assertRendererHostPort({ ...validHost, openPopup: 123 }), /invalid_openPopup/);
  assert.throws(() => assertRendererHostPort({ ...validHost, showToast: true }), /invalid_showToast/);
  assert.throws(() => assertRendererHostPort({ ...validHost, registerCommand: 'bad' }), /invalid_registerCommand/);
  assert.throws(() => assertRendererHostPort({ ...validHost, registerSettingsPage: 42 }), /invalid_registerSettingsPage/);
  assert.throws(() => assertRendererHostPort({ ...validHost, netFetch: {} }), /invalid_netFetch/);

  assert.throws(() => assertOverlayHostPort({ openPopup() {} }), /missing_openModal/);
  assert.equal(assertOverlayHostPort({ openPopup() {}, openModal() {} }).openModal !== undefined, true);

  assert.throws(() => assertStatusbarApiPort({}), /missing_post/);
  const validApi = {
    post() {},
    isConnected() {},
    abortAll() {},
    isConfigured() {},
    getBaseUrl() {},
    configure() {},
    clearConnection() {},
  };
  assert.equal(assertStatusbarApiPort(validApi), validApi);
  assert.throws(() => assertStatusbarApiPort({ ...validApi, configure: 'bad' }), /invalid_configure/);

  assert.throws(() => assertAddonRegistryPort({ register() {} }), /ERR_INVALID_ADDON_REGISTRY_PORT/);
  assert.throws(() => assertRendererPublisherPort({ publish() {} }), /missing_teardown/);
  const validPublisher = { publish() {}, teardown() {} };
  assert.equal(assertRendererPublisherPort(validPublisher), validPublisher);
});

test('TC-ADDON-03: addon-host-adapter.mjs adapts AddonContextV3 (surface/capabilities, Tier 1/2/3 UI, services, storage, net, lifecycle) and rejects non-v3 handles', () => {
  assert.throws(() => createAddonHostAdapter(null), /ERR_MISSING_ADDON_HOST_CAPABILITY_HANDLE/);
  assert.throws(
    () => createAddonHostAdapter({ schemaVersion: 2, mountSlot() {} }),
    /ERR_UNSUPPORTED_ADDON_HOST_VERSION/,
  );

  const calls = [];
  const box1 = { id: 'box-1' };
  const box2 = { id: 'box-2' };
  const abortCtrl = new AbortController();

  const fakeV3Ctx = {
    apiVersion: 3,
    meta: { pluginId: 'antigravity-statusbar', displayName: 'Antigravity Statusbar', version: '3.3.1', trustLevel: 'trusted' },
    env: {
      surface: 'desktop',
      layoutMode: 'desktop',
      capabilities: {
        hasLocalLoopback: true,
        hasNetHttps: false,
        hasConfigBridge: false,
        hasSettingsBridge: true,
        hasDocumentTransform: false,
      },
    },
    theme: {
      getMode: () => 'dark',
      getTokenCss: () => ':host { --ag-accent: #38bdf8; }',
      onDidChange: () => () => {},
    },
    i18n: {
      getLocale: () => 'ko',
      onDidChange: () => () => {},
    },
    ui: {
      showToast(opts) {
        calls.push(['showToast', opts.message]);
      },
      openPopup(opts) {
        calls.push(['openPopup', opts.title]);
        return { update() {}, close() {} };
      },
      openModal(opts) {
        calls.push(['openModal', opts.title]);
        return { update() {}, close() {} };
      },
      registerCommand(id, spec) {
        calls.push(['registerCommand', id, spec.label]);
        return { dispose() { calls.push(['disposeCommand', id]); } };
      },
      registerSettingsPage(spec) {
        calls.push(['registerSettingsPage', spec.id]);
        return { open() {}, update() {}, dispose() {} };
      },
      mountCanvas(slotId, opts) {
        calls.push(['mountCanvas', slotId, opts]);
        return { id: `canvas-${opts?.container?.id || 'anchor'}` };
      },
      injectStyle(styleId, css, opts) {
        calls.push(['injectStyle', styleId, opts]);
      },
      removeStyle(styleId) {
        calls.push(['removeStyle', styleId]);
        return true;
      },
    },
    dom: {
      unmountSlot(slotId) {
        calls.push(['unmountSlot', slotId]);
        return true;
      },
    },
    storage: {
      async get() { return null; },
      async set() {},
      async delete() {},
      onDidChange: () => () => {},
    },
    services: {
      provide(name, _impl, opts) {
        calls.push(['provide', name, opts]);
        return { dispose() {} };
      },
    },
    net: {
      async fetch(url, init) {
        calls.push(['netFetch', url, init.method]);
        return { ok: true, status: 200, bodyText: '{"ok":true}' };
      },
    },
    lifecycle: {
      signal: abortCtrl.signal,
      onDispose(fn) {
        calls.push(['onDispose', typeof fn]);
      },
      addManagedListener(_target, type) {
        calls.push(['addManagedListener', type]);
        return () => {};
      },
    },
  };

  const port = assertOverlayHostPort(
    assertRendererHostPort(createAddonHostAdapter(fakeV3Ctx, { root: 'antigravity-statusbar.root' })),
  );
  assert.equal(port.apiVersion, 3);
  assert.equal(port.surface, 'desktop');
  assert.equal(port.layoutMode, 'desktop');
  assert.equal(port.capabilities.hasLocalLoopback, true);
  assert.equal(port.lifecycleSignal, abortCtrl.signal);

  let liveBridgeConnected = false;
  const remotePort = createAddonHostAdapter({
    ...fakeV3Ctx,
    env: {
      surface: 'remote-web',
      layoutMode: 'compact',
      capabilities: {
        get hasLocalLoopback() {
          return liveBridgeConnected;
        },
        get hasRemoteHostBridge() {
          return liveBridgeConnected;
        },
      },
    },
  });
  assert.equal(remotePort.surface, 'remote-web');
  assert.equal(remotePort.layoutMode, 'compact');
  assert.equal(remotePort.capabilities.hasLocalLoopback, false);
  assert.equal(remotePort.capabilities.hasRemoteHostBridge, false);
  liveBridgeConnected = true;
  assert.equal(remotePort.capabilities.hasLocalLoopback, true);
  assert.equal(remotePort.capabilities.hasRemoteHostBridge, true);

  port.mountSlot(box1);
  port.mountSlot(box1);
  port.mountSlot(box2);
  port.mountSlot(null);
  port.injectStyle('statusbar-main', '.x{}', { slotId: 'antigravity-statusbar.root' });
  port.showToast({ message: 'Saved' });
  port.openPopup({ title: 'Context' });
  port.openModal({ title: 'Limits' });
  const cmdReg = port.registerCommand('open-settings', { label: 'Settings', run() {} });
  port.registerSettingsPage({ id: 'settings', schema: { type: 'stack' } });
  port.netFetch('http://127.0.0.1:18910/api/quota', { method: 'POST' });
  port.onDispose(() => {});
  cmdReg.dispose();
  port.removeStyle('statusbar-main');

  assert.deepEqual(calls, [
    ['mountCanvas', 'antigravity-statusbar.root', { container: box1 }],
    ['mountCanvas', 'antigravity-statusbar.root', { container: box1 }],
    ['unmountSlot', 'antigravity-statusbar.root'],
    ['mountCanvas', 'antigravity-statusbar.root', { container: box2 }],
    ['unmountSlot', 'antigravity-statusbar.root'],
    ['mountCanvas', 'antigravity-statusbar.root', {}],
    ['injectStyle', 'statusbar-main', { slotId: 'antigravity-statusbar.root' }],
    ['showToast', 'Saved'],
    ['openPopup', 'Context'],
    ['openModal', 'Limits'],
    ['registerCommand', 'open-settings', 'Settings'],
    ['registerSettingsPage', 'settings'],
    ['netFetch', 'http://127.0.0.1:18910/api/quota', 'POST'],
    ['onDispose', 'function'],
    ['disposeCommand', 'open-settings'],
    ['removeStyle', 'statusbar-main'],
  ]);
});

test('TC-ADDON-04: runtime-publisher.mjs enforces confinement for both settingsBridge and legacy renderer publisher', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-publisher-test-'));
  const pluginDir = path.join(tempRoot, 'antigravity-statusbar');
  const hostDataDir = path.join(tempRoot, 'host-data');
  const outsideFile = path.join(tempRoot, 'outside.js');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(hostDataDir, { recursive: true });
  await fs.writeFile(outsideFile, '// outside', 'utf8');

  try {
    assert.throws(
      () => resolveConfinedSettingsBridgeTarget(hostDataDir, '../escape.json'),
      /ERR_INVALID_SETTINGS_BRIDGE_FILE/,
    );
    assert.throws(
      () => resolveConfinedSettingsBridgeTarget(hostDataDir, 'sub/runtime.json'),
      /ERR_INVALID_SETTINGS_BRIDGE_FILE/,
    );
    for (const reserved of [
      'trust-policy.json',
      'config.json',
      'remote-preferences.json',
      'foo.orig.json',
      'nul.json',
    ]) {
      assert.throws(
        () => resolveConfinedSettingsBridgeTarget(hostDataDir, reserved),
        /ERR_RESERVED_SETTINGS_BRIDGE_FILE/,
      );
    }

    const bridgePublisher = assertRendererPublisherPort(
      createSettingsBridgePublisher({ hostDataDir }),
    );
    await assert.rejects(
      () => bridgePublisher.publish({ baseUrl: 'https://evil.example:443', token: TEST_TOKEN }),
      /ERR_INVALID_LOOPBACK_BASE_URL/,
    );
    await assert.rejects(
      () => bridgePublisher.publish({ baseUrl: 'http://127.0.0.1:44123', token: 'short' }),
      /ERR_INVALID_SIDECAR_TOKEN/,
    );

    const bridgePath = await bridgePublisher.publish({
      baseUrl: 'http://127.0.0.1:44123',
      token: TEST_TOKEN,
    });
    assert.equal(path.basename(bridgePath), DEFAULT_SETTINGS_BRIDGE_FILE);
    const activeJson = JSON.parse(await fs.readFile(bridgePath, 'utf8'));
    assert.equal(activeJson.mode, 'active');
    assert.equal(activeJson.baseUrl, 'http://127.0.0.1:44123');
    assert.equal(activeJson.token, TEST_TOKEN);

    await bridgePublisher.teardown();
    const standbyJson = JSON.parse(await fs.readFile(bridgePath, 'utf8'));
    assert.equal(standbyJson.mode, 'standby');

    assert.throws(
      () => resolveConfinedRendererTarget(pluginDir, '../outside.js'),
      /ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT/,
    );
    assert.throws(
      () => resolveConfinedRendererTarget(pluginDir, outsideFile),
      /ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT/,
    );

    const publisher = assertRendererPublisherPort(
      createAddonRuntimePublisher({ pluginRootDir: pluginDir }),
    );
    const writtenPath = await publisher.publish({
      baseUrl: 'http://127.0.0.1:44123',
      token: TEST_TOKEN,
    });
    const activeSrc = await fs.readFile(writtenPath, 'utf8');
    assert.ok(activeSrc.includes('http://127.0.0.1:44123'));
    assert.ok(activeSrc.includes('startAddonStatusbar'));

    await publisher.teardown();
    const standbySrc = await fs.readFile(writtenPath, 'utf8');
    assert.equal(standbySrc.includes(TEST_TOKEN), false);
    assert.ok(standbySrc.includes('startStandbyStatusbar'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('TC-ADDON-05: i18n.mjs, api-client.mjs (ctx.net.fetch + fetchImpl), and addon-bridge.mjs (host.statusbar service) satisfy unit contracts', async () => {
  const i18n = createInlineI18n('ko');
  assert.equal(i18n.getLocale(), 'ko');
  assert.equal(i18n.formatTokens(256000), '256.0K');
  assert.equal(i18n.formatTokens(1500000), '1.50M');
  assert.equal(i18n.localizeBreakdownLabel('Chat Messages'), '대화 메시지');
  i18n.setLocale('en');
  assert.equal(i18n.localizeBreakdownLabel('Chat Messages'), 'Chat Messages');

  assert.throws(
    () => createSidecarApiClient({ baseUrl: 'https://evil.example:443', token: TEST_TOKEN }),
    /ERR_INVALID_LOOPBACK_BASE_URL/,
  );
  assert.throws(
    () => createSidecarApiClient({ baseUrl: 'http://127.0.0.1:45555', token: 'short' }),
    /ERR_INVALID_SIDECAR_TOKEN/,
  );

  // 1. v3 ctx.net.fetch broker transport (success + policy rejection propagation)
  const netCalls = [];
  const netApi = assertStatusbarApiPort(
    createSidecarApiClient({
      baseUrl: 'http://127.0.0.1:18910',
      token: TEST_TOKEN,
      netFetchImpl: async (url, init) => {
        netCalls.push({ url, init });
        if (url.endsWith('/blocked')) {
          return { ok: false, reason: 'ERR_NET_LOOPBACK_PORT_NOT_ALLOWED:18910' };
        }
        return { ok: true, status: 200, bodyText: JSON.stringify({ ok: true, via: 'net-broker' }) };
      },
    }),
  );
  const netRes = await netApi.post('/api/settings/get', {});
  assert.equal(netRes.via, 'net-broker');
  assert.equal(netApi.isConnected(), true);
  assert.equal(netCalls[0].init.headers['x-statusbar-token'], TEST_TOKEN);
  await assert.rejects(
    () => netApi.post('/blocked', {}),
    (err) => err?.code === 'ERR_NET_LOOPBACK_PORT_NOT_ALLOWED:18910',
  );
  assert.equal(netApi.isConnected(), false);

  // 2. Strictly loopback-only validation (non-loopback HTTPS rejected; ERR_REMOTE_HOST_NOT_CONNECTED propagated)
  const bridgeApi = assertStatusbarApiPort(
    createSidecarApiClient({
      netFetchImpl: async (url) => {
        if (url.endsWith('/offline')) {
          return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
        }
        return { ok: true, status: 200, bodyText: JSON.stringify({ ok: true }) };
      },
    }),
  );
  assert.equal(bridgeApi.isConfigured(), false);
  assert.throws(
    () => bridgeApi.configure({ baseUrl: 'https://sidecar.example.com', token: TEST_TOKEN }),
    /ERR_INVALID_LOOPBACK_BASE_URL/,
  );
  assert.throws(
    () => bridgeApi.configure({ baseUrl: 'http://remote.example.com:8080', token: TEST_TOKEN }),
    /ERR_INVALID_LOOPBACK_BASE_URL/,
  );
  assert.equal(
    bridgeApi.configure({ baseUrl: 'http://127.0.0.1:43210/', token: TEST_TOKEN }),
    true,
  );
  assert.equal(bridgeApi.getBaseUrl(), 'http://127.0.0.1:43210');
  await bridgeApi.post('/api/settings/get', {});
  assert.equal(bridgeApi.isConnected(), true);
  await assert.rejects(
    () => bridgeApi.post('/offline', {}),
    (err) => err?.code === 'ERR_REMOTE_HOST_NOT_CONNECTED',
  );
  assert.equal(bridgeApi.isConnected(), false);
  assert.equal(bridgeApi.clearConnection(), true);

  // 3. addon-bridge well-known `host.statusbar` service contract
  let changes = 0;
  const registry = assertAddonRegistryPort(
    createAddonRegistry({
      api: netApi,
      onChange() {
        changes += 1;
      },
    }),
  );
  const itemHandle = registry.statusbarService.registerItem({
    pluginId: 'peer-translator',
    id: 'mode',
    label: '번역:구글',
    icon: '🌐',
    badge: 'KO',
    tooltip: 'Translation mode',
    align: 'right',
    priority: 20,
    onClick() {},
  });
  const leftHandle = registry.statusbarService.registerItem({
    pluginId: 'peer-sync',
    id: 'cloud',
    label: 'Sync',
    align: 'left',
    priority: 10,
    onClick() {},
  });
  assert.equal(changes, 2);
  let sorted = registry.getSortedDelegatedItems();
  assert.equal(sorted.left.length, 1);
  assert.equal(sorted.right.length, 1);
  assert.equal(sorted.right[0].badge, 'KO');

  registry.statusbarService.updateItem('peer-translator', 'mode', { label: '번역:DeepL', badge: 'EN' });
  sorted = registry.getSortedDelegatedItems();
  assert.equal(sorted.right[0].label, '번역:DeepL');
  assert.equal(sorted.right[0].badge, 'EN');

  itemHandle.dispose();
  assert.equal(registry.getSortedDelegatedItems().right.length, 0);
  registry.statusbarService.removeItem('peer-sync', 'cloud');
  assert.equal(registry.getSortedDelegatedItems().left.length, 0);
  leftHandle.dispose();
});

test('TC-ADDON-13 (v3.0.0): build-renderer.mjs emits deterministic credential-free v3 runtime/statusbar-renderer.js', async () => {
  assert.throws(() => parseBuildArgs(['--out']), /valid output file path/);
  const parsed = parseBuildArgs(['--check', '--out', 'runtime/test-out.js']);
  assert.equal(parsed.check, true);
  assert.ok(parsed.outPath.endsWith(path.join('runtime', 'test-out.js')));

  const checkRes = await buildStaticRenderer({ check: true });
  assert.equal(checkRes.ok, true);
  assert.match(checkRes.sha256, /^[a-f0-9]{64}$/);
  assert.ok(checkRes.bytes > 1000);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-build-renderer-'));
  try {
    const outFile = path.join(tmpDir, 'runtime', 'statusbar-renderer.js');
    const writeRes = await buildStaticRenderer({ outPath: outFile, check: false });
    assert.equal(writeRes.sha256, checkRes.sha256);
    const content = await fs.readFile(outFile, 'utf8');
    assert.equal(content.includes('\r\n'), false);
    assert.equal(/http:\/\/127\.0\.0\.1:\d+/.test(content), false);
    assert.ok(content.includes('host.statusbar'), 'v3 bundle must provide host.statusbar service');
    assert.ok(content.includes('registerSettingsPage'), 'v3 bundle must register Tier-1 settings page');
    assert.ok(content.includes('registerCommand'), 'v3 bundle must register Tier-1 commands');
    assert.equal(/hostProfileId/.test(content), false, 'v3 bundle must not inspect raw hostProfileId');
    assert.equal(/GM_xmlhttpRequest/.test(content), false, 'v3 bundle must not probe GM_xmlhttpRequest directly');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
