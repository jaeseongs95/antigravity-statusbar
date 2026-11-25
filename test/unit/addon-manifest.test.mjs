import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAddonRegistry } from '../../src/adapters/antigravity/addon/addon-bridge.mjs';
import { createAddonHostAdapter } from '../../src/adapters/antigravity/addon/addon-host-adapter.mjs';
import { createSidecarApiClient } from '../../src/adapters/antigravity/addon/api-client.mjs';
import { createInlineI18n } from '../../src/adapters/antigravity/addon/i18n.mjs';
import {
  assertAddonRegistryPort,
  assertPortalHostPort,
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

test('TC-ADDON-01: addon-manifest.v2.json conforms strictly to AddonManifest.v2 schema & reference profile', async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'addon-manifest.v2.json'), 'utf8'),
  );

  const allowedTopKeys = new Set([
    '$schema',
    'schemaVersion',
    'pluginId',
    'displayName',
    'version',
    'trustLevel',
    'compatibility',
    'capabilities',
    'entry',
    'integrity',
    'uiSlots',
    'isolation',
    'settingsBridge',
    'configBridge',
    'loadOrder',
  ]);
  for (const key of Object.keys(manifest)) {
    assert.ok(allowedTopKeys.has(key), `Unexpected manifest top-level property: ${key}`);
  }

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.pluginId, 'antigravity-statusbar');
  assert.equal(manifest.displayName, 'Antigravity Statusbar');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, '3.2.0');
  assert.equal(manifest.trustLevel, 'trusted');
  assert.deepEqual(manifest.settingsBridge, {
    fileName: DEFAULT_SETTINGS_BRIDGE_FILE,
    maxBytes: 16384,
  });
  assert.equal(manifest.configBridge, undefined);
  assert.deepEqual(manifest.compatibility, {
    hostProfile: 'antigravity-desktop',
    hostProfiles: ['antigravity-desktop', 'antigravity-remote-web'],
    minHostVersion: '2.3.0',
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
    {
      slot: 'overlay',
      slotId: 'antigravity-statusbar.popover',
      exclusive: false,
      scope: 'addon-owned-slot',
      shadow: true,
    },
    {
      slot: 'modal',
      slotId: 'antigravity-statusbar.global-limit-modal',
      exclusive: false,
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

test('TC-ADDON-02: ports.mjs enforces segregated ISP/DIP contracts', () => {
  assert.throws(() => assertRendererHostPort(null), /ERR_INVALID_RENDERER_HOST_PORT/);
  assert.throws(() => assertRendererHostPort({ mountSlot() {} }), /missing_unmountSlot/);
  const validHost = {
    mountSlot() {},
    unmountSlot() {},
    injectStyle() {},
    removeStyle() {},
    onDispose() {},
    getSettings() {},
    onSettingsChange() {},
    saveSettings() {},
  };
  assert.equal(assertRendererHostPort(validHost), validHost);
  assert.throws(
    () => assertRendererHostPort({ ...validHost, openModal: 'not-fn' }),
    /invalid_openModal/,
  );
  assert.throws(
    () => assertRendererHostPort({ ...validHost, getSettings: 'not-fn' }),
    /invalid_getSettings/,
  );
  assert.throws(
    () => assertRendererHostPort({ ...validHost, onSettingsChange: 123 }),
    /invalid_onSettingsChange/,
  );
  assert.throws(
    () => assertRendererHostPort({ ...validHost, saveSettings: true }),
    /invalid_saveSettings/,
  );

  assert.throws(() => assertPortalHostPort(validHost), /missing_openModal/);
  const validPortal = { openModal() {}, openPopover() {} };
  assert.equal(assertPortalHostPort(validPortal), validPortal);

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
  assert.throws(
    () => assertStatusbarApiPort({ ...validApi, configure: 'bad' }),
    /invalid_configure/,
  );

  assert.throws(() => assertAddonRegistryPort({ register() {} }), /ERR_INVALID_ADDON_REGISTRY_PORT/);
  assert.throws(() => assertRendererPublisherPort({ publish() {} }), /missing_teardown/);
  const validPublisher = { publish() {}, teardown() {} };
  assert.equal(assertRendererPublisherPort(validPublisher), validPublisher);
});

test('TC-ADDON-03: addon-host-adapter.mjs supports v1 compat and v2 Shadow DOM / { container } / openModal / openPopover contracts', () => {
  assert.throws(() => createAddonHostAdapter(null), /ERR_MISSING_ADDON_HOST_CAPABILITY_HANDLE/);
  assert.throws(() => createAddonHostAdapter({ mountSlot() {} }), /ERR_MISSING_ADDON_HOST_CAPABILITY_HANDLE/);

  // 1. Legacy v1 host compatibility
  const calls = [];
  const fakeEl = { id: 'slot-div' };
  const fakeHostV1 = {
    pluginId: 'antigravity-statusbar',
    mountSlot(slotId, parentEl) {
      calls.push(['mountSlot', slotId, parentEl]);
      return fakeEl;
    },
    unmountSlot(slotId) {
      calls.push(['unmountSlot', slotId]);
      return true;
    },
    injectStyle(styleId, css) {
      calls.push(['injectStyle', styleId, css]);
    },
    removeStyle(styleId) {
      calls.push(['removeStyle', styleId]);
      return true;
    },
    onDispose(fn) {
      calls.push(['onDispose', typeof fn]);
    },
  };

  const portV1 = assertRendererHostPort(createAddonHostAdapter(fakeHostV1, 'antigravity-statusbar.root'));
  assert.equal(portV1.schemaVersion, 1);
  assert.equal(portV1.hostProfileId, null);
  assert.equal(portV1.openModal, undefined);
  assert.equal(portV1.openPopover, undefined);
  assert.equal(portV1.mountSlot('BOX'), fakeEl);
  portV1.injectStyle('statusbar-main', '.x{}');
  portV1.onDispose(() => {});
  assert.equal(portV1.unmountSlot(), true);
  assert.equal(portV1.removeStyle('statusbar-main'), true);

  assert.deepEqual(calls, [
    ['mountSlot', 'antigravity-statusbar.root', 'BOX'],
    ['injectStyle', 'statusbar-main', '.x{}'],
    ['onDispose', 'function'],
    ['unmountSlot', 'antigravity-statusbar.root'],
    ['removeStyle', 'statusbar-main'],
  ]);

  // 2. Host v2.0.0 contract: { container }, container-switch unmount/remount, slotId style routing, openPopover/openModal
  const v2Calls = [];
  const box1 = { id: 'box-1' };
  const box2 = { id: 'box-2' };
  let settingsSubscriber = null;
  const fakeHostV2 = {
    pluginId: 'antigravity-statusbar',
    schemaVersion: 2,
    hostProfileId: 'antigravity-desktop',
    mountSlot(slotId, opts) {
      v2Calls.push(['mountSlot', slotId, opts]);
      return { id: `shadow-root-inner-${opts?.container?.id || 'anchor'}` };
    },
    unmountSlot(slotId) {
      v2Calls.push(['unmountSlot', slotId]);
      return true;
    },
    injectStyle(styleId, css, opts) {
      v2Calls.push(['injectStyle', styleId, css, opts]);
    },
    removeStyle(styleId) {
      v2Calls.push(['removeStyle', styleId]);
      return true;
    },
    openPopover(slotId, opts) {
      v2Calls.push(['openPopover', slotId, opts]);
      return { id: 'pop-1', element: {}, bodyEl: {}, close() {} };
    },
    openModal(slotId, opts) {
      v2Calls.push(['openModal', slotId, opts]);
      return { id: 'modal-1', element: {}, bodyEl: {}, close() {} };
    },
    getSettings() {
      v2Calls.push(['getSettings']);
      return { status: 'ok', data: { mode: 'standby' } };
    },
    onSettingsChange(cb) {
      v2Calls.push(['onSettingsChange', typeof cb]);
      settingsSubscriber = cb;
      return () => v2Calls.push(['unsubscribeSettings']);
    },
    async saveSettings(data) {
      v2Calls.push(['saveSettings', data]);
      return { ok: true, persistence: 'browser-local' };
    },
    onDispose(fn) {
      v2Calls.push(['onDispose', typeof fn]);
    },
  };

  const portV2 = assertPortalHostPort(
    assertRendererHostPort(
      createAddonHostAdapter(fakeHostV2, {
        root: 'antigravity-statusbar.root',
        popover: 'antigravity-statusbar.popover',
        modal: 'antigravity-statusbar.global-limit-modal',
      }),
    ),
  );
  assert.equal(portV2.schemaVersion, 2);
  assert.equal(portV2.hostProfileId, 'antigravity-desktop');
  const portRemoteWeb = assertRendererHostPort(
    createAddonHostAdapter({ ...fakeHostV2, hostProfileId: ' antigravity-remote-web ' }),
  );
  assert.equal(portRemoteWeb.hostProfileId, 'antigravity-remote-web');
  portV2.mountSlot(box1);
  // Same container -> no unmount before mount
  portV2.mountSlot(box1);
  // Different container (tab switch) -> unmounts old slot before mounting into new container
  portV2.mountSlot(box2);
  // Switching to null container (host anchor: "status-bar" dock fallback) -> unmounts old slot and passes {}
  portV2.mountSlot(null);
  portV2.mountSlot(null);
  portV2.injectStyle('statusbar-main', '.x{}', { slotId: 'antigravity-statusbar.root' });
  portV2.openPopover({ ignoreOutsideClickEls: [] });
  portV2.openModal({});
  assert.deepEqual(portV2.getSettings(), { status: 'ok', data: { mode: 'standby' } });
  const unsub = portV2.onSettingsChange(() => {});
  assert.equal(typeof settingsSubscriber, 'function');
  unsub();
  portV2.saveSettings({ locale: 'ko' });

  assert.deepEqual(v2Calls, [
    ['mountSlot', 'antigravity-statusbar.root', { container: box1 }],
    ['mountSlot', 'antigravity-statusbar.root', { container: box1 }],
    ['unmountSlot', 'antigravity-statusbar.root'],
    ['mountSlot', 'antigravity-statusbar.root', { container: box2 }],
    ['unmountSlot', 'antigravity-statusbar.root'],
    ['mountSlot', 'antigravity-statusbar.root', {}],
    ['mountSlot', 'antigravity-statusbar.root', {}],
    ['injectStyle', 'statusbar-main', '.x{}', { slotId: 'antigravity-statusbar.root' }],
    ['openPopover', 'antigravity-statusbar.popover', { ignoreOutsideClickEls: [] }],
    ['openModal', 'antigravity-statusbar.global-limit-modal', {}],
    ['getSettings'],
    ['onSettingsChange', 'function'],
    ['unsubscribeSettings'],
    ['saveSettings', { locale: 'ko' }],
  ]);
});

test('TC-ADDON-04: runtime-publisher.mjs enforces confinement for both settingsBridge (v3.2.0) and legacy renderer publisher', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-publisher-test-'));
  const pluginDir = path.join(tempRoot, 'antigravity-statusbar');
  const hostDataDir = path.join(tempRoot, 'host-data');
  const outsideFile = path.join(tempRoot, 'outside.js');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(hostDataDir, { recursive: true });
  await fs.writeFile(outsideFile, '// outside', 'utf8');

  try {
    // 1. v3.2.0 settingsBridge confinement & atomic publish/teardown/teardownSync
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
        `Reserved settingsBridge file must be rejected: ${reserved}`,
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
    assert.equal(activeJson.schemaVersion, 1);
    assert.equal(activeJson.mode, 'active');
    assert.equal(activeJson.baseUrl, 'http://127.0.0.1:44123');
    assert.equal(activeJson.token, TEST_TOKEN);

    await bridgePublisher.teardown();
    const standbyJson = JSON.parse(await fs.readFile(bridgePath, 'utf8'));
    assert.equal(standbyJson.mode, 'standby');
    assert.equal(standbyJson.baseUrl, null);
    assert.equal(standbyJson.token, null);

    await bridgePublisher.publish({ baseUrl: 'http://127.0.0.1:44124', token: TEST_TOKEN });
    bridgePublisher.teardownSync();
    const syncStandbyJson = JSON.parse(await fs.readFile(bridgePath, 'utf8'));
    assert.equal(syncStandbyJson.mode, 'standby');
    assert.equal(syncStandbyJson.baseUrl, null);
    assert.equal(syncStandbyJson.token, null);

    // 2. Legacy createAddonRuntimePublisher confinement & atomic publish/teardown
    assert.throws(
      () => resolveConfinedRendererTarget(pluginDir, '../outside.js'),
      /ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT/,
    );
    assert.throws(
      () => resolveConfinedRendererTarget(pluginDir, outsideFile),
      /ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT/,
    );
    assert.throws(
      () => resolveConfinedRendererTarget(pluginDir, 'runtime/a\0b.js'),
      /ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT/,
    );

    const publisher = assertRendererPublisherPort(
      createAddonRuntimePublisher({ pluginRootDir: pluginDir }),
    );
    const writtenPath = await publisher.publish({
      baseUrl: 'http://127.0.0.1:44123',
      token: TEST_TOKEN,
    });
    assert.equal(path.relative(pluginDir, writtenPath), path.join('runtime', 'statusbar-renderer.js'));
    const activeSrc = await fs.readFile(writtenPath, 'utf8');
    assert.ok(activeSrc.includes('http://127.0.0.1:44123'));
    assert.ok(activeSrc.includes('startAddonStatusbar'));

    await publisher.teardown();
    const standbySrc = await fs.readFile(writtenPath, 'utf8');
    assert.equal(standbySrc.includes(TEST_TOKEN), false);
    assert.equal(standbySrc.includes('http://127.0.0.1:44123'), false);
    assert.ok(standbySrc.includes('startStandbyStatusbar'));

    // Symlink escape guard (verify whenever platform grants symlink permission)
    const symlinkDir = path.join(pluginDir, 'escape-link');
    let symlinkCreated = false;
    try {
      await fs.symlink(tempRoot, symlinkDir, 'dir');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      assert.throws(
        () => resolveConfinedRendererTarget(pluginDir, 'escape-link/outside.js'),
        /ERR_SYMLINK_FORBIDDEN/,
      );
      assert.throws(
        () => resolveConfinedSettingsBridgeTarget(symlinkDir, DEFAULT_SETTINGS_BRIDGE_FILE),
        /ERR_SYMLINK_FORBIDDEN/,
      );
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('TC-ADDON-05: i18n.mjs, api-client.mjs (Desktop + Remote HTTPS reconfiguration), and addon-bridge.mjs satisfy unit contracts', async () => {
  const i18n = createInlineI18n('ko');
  assert.equal(i18n.getLocale(), 'ko');
  assert.equal(i18n.formatTokens(256000), '256.0K');
  assert.equal(i18n.formatTokens(1500000), '1.50M');
  assert.equal(i18n.localizeBreakdownLabel('Chat Messages'), '대화 메시지');
  i18n.setLocale('en');
  assert.equal(i18n.localizeBreakdownLabel('Chat Messages'), 'Chat Messages');
  assert.equal(i18n.formatTemplate('Max {max}', { max: '512K' }), 'Max 512K');

  assert.throws(
    () => createSidecarApiClient({ baseUrl: 'https://evil.example:443', token: TEST_TOKEN }),
    /ERR_INVALID_LOOPBACK_BASE_URL/,
  );
  assert.throws(
    () => createSidecarApiClient({ baseUrl: 'http://127.0.0.1:45555', token: 'short' }),
    /ERR_INVALID_SIDECAR_TOKEN/,
  );

  // Unconfigured startup + dynamic configure/clearConnection + Remote HTTPS validation
  const remoteRequests = [];
  const remoteApi = assertStatusbarApiPort(
    createSidecarApiClient({
      allowRemoteHttps: true,
      fetchImpl: async (url, init) => {
        remoteRequests.push({ url, init });
        if (url.endsWith('/unauth')) {
          return {
            ok: false,
            status: 401,
            async json() {
              return { error: { code: 'UNAUTHORIZED', message: 'Invalid token' } };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true };
          },
        };
      },
    }),
  );
  assert.equal(remoteApi.isConfigured(), false);
  assert.equal(remoteApi.getBaseUrl(), '');
  await assert.rejects(() => remoteApi.post('/api/settings/get', {}), /ERR_NOT_CONFIGURED/);
  assert.throws(
    () => remoteApi.configure({ baseUrl: 'http://remote.example.com:8080', token: TEST_TOKEN }),
    /ERR_INVALID_ENDPOINT_URL/,
  );
  assert.throws(
    () => remoteApi.configure({ baseUrl: 'https://user:pass@sidecar.example.com', token: TEST_TOKEN }),
    /ERR_INVALID_ENDPOINT_URL/,
  );
  assert.throws(
    () => remoteApi.configure({ baseUrl: 'https://sidecar.example.com/sub?q=1', token: TEST_TOKEN }),
    /ERR_INVALID_ENDPOINT_URL/,
  );
  assert.equal(
    remoteApi.configure({ baseUrl: 'https://sidecar.example.com:8443/prefix/', token: TEST_TOKEN }),
    true,
  );
  assert.equal(remoteApi.isConfigured(), true);
  assert.equal(remoteApi.getBaseUrl(), 'https://sidecar.example.com:8443/prefix');
  await remoteApi.post('/api/settings/get', {});
  assert.equal(remoteApi.isConnected(), true);
  assert.equal(remoteRequests[0].url, 'https://sidecar.example.com:8443/prefix/api/settings/get');
  // 401 flips connected=false
  await assert.rejects(() => remoteApi.post('/unauth', {}));
  assert.equal(remoteApi.isConnected(), false);
  assert.equal(remoteApi.clearConnection(), true);
  assert.equal(remoteApi.isConfigured(), false);

  const requests = [];
  const api = assertStatusbarApiPort(
    createSidecarApiClient({
      baseUrl: 'http://127.0.0.1:45555',
      token: TEST_TOKEN,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, customButtons: [], disabledRuntimeAddonIds: ['rt-1'] };
          },
        };
      },
    }),
  );
  assert.equal(api.isConfigured(), true);
  assert.equal(api.isConnected(), false);
  const res = await api.post('/api/settings/get', {});
  assert.equal(res.ok, true);
  assert.equal(api.isConnected(), true);
  assert.equal(requests[0].url, 'http://127.0.0.1:45555/api/settings/get');
  assert.equal(requests[0].init.headers['x-statusbar-token'], TEST_TOKEN);

  let changes = 0;
  const registry = assertAddonRegistryPort(
    createAddonRegistry({
      api,
      onChange() {
        changes += 1;
      },
    }),
  );
  assert.equal(registry.register({ id: 'bad id!', label: 'X', onClick() {} }), false);
  assert.equal(registry.register({ id: 'rt-1', label: 'MCP', onClick() {} }), true);
  assert.equal(changes, 1);
  assert.equal(registry.list().length, 1);
  assert.equal(await registry.setEnabled('rt-1', false), true);
  assert.equal(registry.isRuntimeDisabled('rt-1'), true);
  assert.equal(registry.unregister('rt-1'), true);
  assert.equal(registry.list().length, 0);
});
