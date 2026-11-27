import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setupStatusbarV3 } from '../../src/adapters/antigravity/addon/bundle-builder.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'addon-manifest.v3.json');
const TEST_TOKEN = 'v3-parity-sdk-secret-token-32-ok';

function loadAddonsSdk() {
  const req = createRequire(import.meta.url);
  const candidates = [
    '@extenra/sdk',
    path.resolve(REPO_ROOT, '..', 'extenra', 'packages', 'sdk', 'src', 'index.js'),
    '@antigravity-addons/sdk',
    path.resolve(REPO_ROOT, '..', 'antigravity-addons', 'packages', 'sdk', 'src', 'index.js'),
  ];
  for (const cand of candidates) {
    try {
      return req(cand);
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function flush(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryDeep(root, selector) {
  if (!root) return null;
  if (typeof root.querySelector === 'function') {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  }
  const nodes = Array.isArray(root.childNodes) ? root.childNodes : [];
  for (const child of nodes) {
    if (child && child.shadowRoot) {
      const inShadow = queryDeep(child.shadowRoot, selector);
      if (inShadow) return inShadow;
    }
    const nested = queryDeep(child, selector);
    if (nested) return nested;
  }
  return null;
}

function findDeepByClass(root, className) {
  if (!root) return null;
  if (typeof root.className === 'string' && root.className.split(/\s+/).includes(className)) {
    return root;
  }
  if (root.shadowRoot) {
    const inShadow = findDeepByClass(root.shadowRoot, className);
    if (inShadow) return inShadow;
  }
  const nodes = Array.isArray(root.childNodes) ? root.childNodes : [];
  for (const child of nodes) {
    const found = findDeepByClass(child, className);
    if (found) return found;
  }
  return null;
}

function appendConversationInputBox(doc, sessionId) {
  const view = doc.createElement('div');
  view.setAttribute('data-testid', 'conversation-view');
  view.setAttribute('data-cascade-id', sessionId);
  const box = doc.createElement('div');
  box.setAttribute('data-testid', 'agent-input-box');
  box.offsetParent = doc.body;
  view.appendChild(box);
  doc.body.appendChild(view);
  return { view, box };
}

test('TC-V3-PARITY-01 (Desktop): @antigravity-addons/sdk createTestHost({ surface: "desktop" }) verifies host.statusbar delegation, ctx.net.fetch, Tier 1/2 overlays, mobile sheet, and clean dispose', async (t) => {
  const sdk = loadAddonsSdk();
  if (!sdk || typeof sdk.createTestHost !== 'function') {
    if (process.env.REQUIRE_ADDONS_SDK === '1') {
      assert.fail('REQUIRE_ADDONS_SDK=1 set, but @antigravity-addons/sdk could not be loaded');
    }
    t.skip('@antigravity-addons/sdk sibling repo is not present on this CI runner');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const netCalls = [];
  let storedSettings = {
    locale: 'ko',
    autoCompact: true,
    compactPrompt: '핵심만 요약',
    defaultCustomLimit: 200000,
    modelLimits: [{ model: 'Gemini 4 Neon (High)', limit: 128000 }],
    sessions: [{ sessionId: 'sess-sdk-desktop', limit: 256000 }],
    customButtons: [],
    disabledRuntimeAddonIds: [],
  };

  const host = sdk.createTestHost({
    surface: 'desktop',
    viewport: { width: 1280, height: 800 },
    locale: 'ko',
    themeMode: 'dark',
    initialSettings: {
      'antigravity-statusbar': {
        status: 'ok',
        data: {
          mode: 'active',
          baseUrl: 'http://127.0.0.1:43210',
          token: TEST_TOKEN,
        },
      },
    },
    netHandler: (_pluginId, url, init) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(init?.body || '{}');
      netCalls.push({ url, pathname, body, token: init?.headers?.['x-statusbar-token'] });
      if (pathname === '/api/settings/get') {
        return { ok: true, status: 200, bodyText: JSON.stringify(storedSettings) };
      }
      if (pathname === '/api/settings/update') {
        if (typeof body.autoCompact === 'boolean') storedSettings = { ...storedSettings, autoCompact: body.autoCompact };
        if (typeof body.compactPrompt === 'string') storedSettings = { ...storedSettings, compactPrompt: body.compactPrompt };
        if (body.defaultCustomLimit !== undefined) storedSettings = { ...storedSettings, defaultCustomLimit: body.defaultCustomLimit };
        if (body.modelLimit) {
          const rest = storedSettings.modelLimits.filter((m) => m.model !== body.modelLimit.model);
          if (body.modelLimit.limit !== null) rest.push({ model: body.modelLimit.model, limit: body.modelLimit.limit });
          storedSettings = { ...storedSettings, modelLimits: rest };
        }
        if (body.sessionLimit) {
          const rest = storedSettings.sessions.filter((s) => s.sessionId !== body.sessionLimit.sessionId);
          if (body.sessionLimit.limit !== null) rest.push({ sessionId: body.sessionLimit.sessionId, limit: body.sessionLimit.limit });
          storedSettings = { ...storedSettings, sessions: rest };
        }
        return { ok: true, status: 200, bodyText: JSON.stringify(storedSettings) };
      }
      if (pathname === '/api/quota') {
        return {
          ok: true,
          status: 200,
          bodyText: JSON.stringify({
            available: true,
            stale: false,
            groups: [
              {
                label: 'Gemini Models',
                buckets: [
                  { window: '5h', remainingPercent: 88, resetTime: '2026-11-26T15:00:00Z' },
                  { window: 'weekly', remainingPercent: 72, resetTime: '2026-11-30T00:00:00Z' },
                ],
              },
            ],
          }),
        };
      }
      if (pathname === '/api/sessions') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ sessions: [{ sessionId: 'sess-sdk-desktop' }] }) };
      }
      if (pathname === '/api/snapshot') {
        return {
          ok: true,
          status: 200,
          bodyText: JSON.stringify({
            sessionId: body.sessionId,
            usedTokens: 128000,
            effectiveLimit: 256000,
            maxContextTokens: 512000,
            usagePercent: 50,
            cacheHitPercent: 91,
            modelName: 'Gemini 4 Neon (High)',
            stepCount: 18,
            limitSource: 'session',
            customLimit: 256000,
            isClampedByHost: false,
            compactPrompt: storedSettings.compactPrompt,
            compaction: { inProgress: false, lastError: null },
            tokenBreakdown: [
              { label: 'Chat Messages', tokens: 96000 },
              { label: 'System', tokens: 32000 },
            ],
          }),
        };
      }
      return { ok: true, status: 200, bodyText: JSON.stringify({ ok: true }) };
    },
  });

  appendConversationInputBox(host.doc, 'sess-sdk-desktop');

  let mountedApp = null;
  const ctx = await host.mountPlugin(manifest, (pluginCtx) => {
    // v3.0.3: Boot credential-free and receive dynamic Sidecar port + token strictly via ctx.settingsBridge
    mountedApp = setupStatusbarV3(pluginCtx, {
      doc: host.doc,
      win: host.win,
      pollConfig: { normalPollMs: 60_000, quotaPollMs: 60_000 },
    });
  });

  try {
    await flush(40);

    // 1. Desktop env capabilities, ctx.settingsBridge dynamic loopback port & ctx.net.fetch routing
    assert.equal(ctx.env.surface, 'desktop');
    assert.equal(ctx.env.capabilities.hasLocalLoopback, true);
    assert.equal(ctx.env.capabilities.hasSettingsBridge, true);
    assert.ok(ctx.settingsBridge, 'v3.0.3 trusted Desktop context must expose ctx.settingsBridge');
    assert.ok(
      netCalls.some((c) => c.url === 'http://127.0.0.1:43210/api/snapshot' && c.token === TEST_TOKEN),
      'Statusbar must route dynamic port from ctx.settingsBridge through ctx.net.fetch',
    );
    assert.ok(netCalls.some((c) => c.url === 'http://127.0.0.1:43210/api/quota'));

    // Dynamic port rotation pushed through ctx.settingsBridge switches live target without restart
    await ctx.settingsBridge.save({
      mode: 'active',
      baseUrl: 'http://127.0.0.1:43211',
      token: TEST_TOKEN,
    });
    await flush(40);
    assert.ok(
      netCalls.some((c) => c.url === 'http://127.0.0.1:43211/api/snapshot' && c.token === TEST_TOKEN),
      'Live ctx.settingsBridge update must switch Sidecar loopback port cleanly',
    );

    // 2. Well-known `host.statusbar` delegation accepts another plugin's `ctx.ui.registerStatusItem()`
    const peerManifest = {
      schemaVersion: 3,
      apiVersion: 3,
      pluginId: 'peer-translator',
      displayName: 'Peer Translator',
      version: '1.0.0',
      trustLevel: 'restricted',
      capabilities: ['renderer'],
      entry: { rendererScript: 'index.js', mainHookScript: null },
      permissions: { ui: { statusItems: true } },
    };
    let peerClickPayload = null;
    let peerItemHandle = null;
    await host.mountPlugin(peerManifest, (peerCtx) => {
      peerItemHandle = peerCtx.ui.registerStatusItem({
        id: 'mode',
        label: '번역:구글',
        icon: '🌐',
        badge: 'KO',
        tooltip: 'Translator mode',
        align: 'right',
        priority: 15,
        onClick(ev) {
          peerClickPayload = ev;
        },
      });
    });

    assert.equal(
      host.doc.querySelector('[data-addon-host-fallback-statusbar="1"]'),
      null,
      'Host must delegate to host.statusbar instead of creating fallback bar',
    );
    const delegatedBtn = queryDeep(host.doc.body, '[data-status-plugin-id="peer-translator"]');
    assert.ok(delegatedBtn, 'Peer plugin status item must render inside statusbar ShadowRoot via host.statusbar service');
    assert.ok(delegatedBtn.textContent.includes('번역:구글'));
    assert.ok(delegatedBtn.textContent.includes('KO'));

    // Update delegated item in place
    peerItemHandle.update({ label: '번역:DeepL', badge: 'EN' });
    const updatedBtn = queryDeep(host.doc.body, '[data-status-plugin-id="peer-translator"]');
    assert.ok(updatedBtn.textContent.includes('번역:DeepL'));
    assert.ok(updatedBtn.textContent.includes('EN'));

    // Trusted click forwards modifiers & anchorEl back to peer plugin
    updatedBtn.click({ shiftKey: true });
    assert.ok(peerClickPayload, 'Clicking delegated status item must invoke peer plugin onClick');
    assert.equal(peerClickPayload.shiftKey, true);
    assert.equal(peerClickPayload.anchorEl, updatedBtn);

    // Dispose peer status item removes it from statusbar
    peerItemHandle.dispose();
    assert.equal(queryDeep(host.doc.body, '[data-status-plugin-id="peer-translator"]'), null);

    // 3. Tier-1 Unified Settings Page registered with Extenra v3.3.2+ header locale switch & dynamic getTitle
    const pages = host.getSettingsPages();
    const statusbarPageMeta = pages.find((p) => p.pluginId === 'antigravity-statusbar' && p.id === 'settings');
    assert.ok(statusbarPageMeta);
    assert.equal(statusbarPageMeta.title, '상태바');
    assert.equal(statusbarPageMeta.showLocaleSwitch, true);
    const settingsHandle = mountedApp.runtime.openSettings();
    assert.ok(settingsHandle, 'openSettings must open Tier-1 registered settings page');
    assert.equal(settingsHandle.getElementById('set-remote-bridge-sec'), null, 'Desktop settings page must NOT render Remote Host Bridge section');
    assert.equal(settingsHandle.getElementById('set-remote-url'), null);
    assert.equal(settingsHandle.getElementById('set-remote-token'), null);
    assert.equal(settingsHandle.getElementById('set-lang-sec'), null, 'Settings body must NOT render redundant bottom language section');
    assert.equal(settingsHandle.getElementById('set-lang-select'), null, 'Settings body must NOT render duplicate language control');
    const globalSummaryEl = settingsHandle.getElementById('set-global-summary');
    assert.ok(globalSummaryEl, 'Desktop settings page must show live global limits summary');
    assert.ok(globalSummaryEl.textContent.includes('200.0K'));
    assert.ok(globalSummaryEl.textContent.includes('1'));
    assert.ok(settingsHandle.getElementById('set-autocompact-toggle'));

    // Extenra v3.3.2+ host-owned header [한국어|EN] switch & dynamic getTitle sync
    const headerTitleEl = findDeepByClass(settingsHandle.element, 'ag-ui-title');
    assert.equal(headerTitleEl?.textContent, '상태바');
    const headerLangSwitch = queryDeep(settingsHandle.element, '[data-addon-host-control="locale-switch"]');
    assert.ok(headerLangSwitch, 'Extenra v3.3.2+ Settings header must mount host-owned [한국어|EN] locale switch');
    const headerKoBtn = queryDeep(headerLangSwitch, '[data-addon-host-lang="ko"]');
    const headerEnBtn = queryDeep(headerLangSwitch, '[data-addon-host-lang="en"]');
    assert.equal(headerKoBtn?.textContent, '한국어');
    assert.equal(headerEnBtn?.textContent, 'EN');
    assert.equal(headerKoBtn?.getAttribute('aria-pressed'), 'true');
    assert.equal(headerEnBtn?.getAttribute('aria-pressed'), 'false');

    // Clicking EN in the host header updates global host locale, Settings header title, and body schema
    headerEnBtn.click();
    assert.equal(mountedApp.i18n.getLocale(), 'en');
    assert.equal(headerTitleEl?.textContent, 'Statusbar');
    assert.equal(headerEnBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(headerKoBtn.getAttribute('aria-pressed'), 'false');
    assert.ok(
      netCalls.some((c) => c.pathname === '/api/settings/update' && c.body?.locale === 'en'),
      'Header locale change must sync persisted locale to Sidecar',
    );
    // Clicking 한국어 in the host header switches back cleanly
    headerKoBtn.click();
    assert.equal(mountedApp.i18n.getLocale(), 'ko');
    assert.equal(headerTitleEl?.textContent, '상태바');
    assert.equal(headerKoBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(headerEnBtn.getAttribute('aria-pressed'), 'false');

    // External host.setLocale('en' -> 'ko') broadcast (e.g. from Addon Manager) stays synchronized
    if (typeof host.setLocale === 'function') {
      host.setLocale('en');
      assert.equal(mountedApp.i18n.getLocale(), 'en');
      assert.equal(headerTitleEl?.textContent, 'Statusbar');
      assert.equal(headerEnBtn.getAttribute('aria-pressed'), 'true');
      host.setLocale('ko');
      assert.equal(mountedApp.i18n.getLocale(), 'ko');
      assert.equal(headerTitleEl?.textContent, '상태바');
      assert.equal(headerKoBtn.getAttribute('aria-pressed'), 'true');
    }
    const compactPromptEl = settingsHandle.getElementById('set-compact-prompt');
    assert.equal(compactPromptEl?.getAttribute('rows'), '4');
    // Switching to Global Limits inside Settings updates in-place (zero modal-on-modal) and supports Back
    settingsHandle.getElementById('set-open-global-btn')?.click();
    assert.ok(settingsHandle.getElementById('gm-back-settings-btn'), 'Settings must switch in-place to Global Limits with Back button');
    assert.equal(settingsHandle.getElementById('gm-model-actions')?.className, 'ag-row');
    settingsHandle.getElementById('gm-back-settings-btn')?.click();
    assert.ok(settingsHandle.getElementById('set-open-global-btn'), 'Back button must restore main Settings view');
    assert.equal(settingsHandle.getElementById('set-lang-select'), null);
    settingsHandle.close();

    // 4. Tier-2 Context Popup via ui.openPopup + in-place update preserving focused input + <=640px mobile sheet
    const popupHandle = mountedApp.runtime.openContextPopup();
    assert.ok(popupHandle, 'openContextPopup must return Tier-2 OverlayHandle');
    const customInputNode = popupHandle.getElementById('ctx-custom-input');
    assert.ok(customInputNode);
    const inputControl =
      String(customInputNode.tagName || '').toLowerCase() === 'input'
        ? customInputNode
        : customInputNode.querySelector('input');
    assert.ok(inputControl);
    inputControl.focus();
    inputControl.value = '180000';
    // Background render/update must NOT overwrite focused input
    mountedApp.runtime.render();
    assert.equal(inputControl.value, '180000', 'Tier-2 handle.update must preserve focused input value');
    // Mobile viewport switch triggers host PlacementEngine bottom-sheet layout
    host.setViewport(480, 800);
    const mobilePlacement = popupHandle.getPlacement();
    assert.equal(mobilePlacement.zone, 'sheet', 'Narrow viewport <=640px must switch Tier-2 popup to bottom sheet');
    assert.equal(mobilePlacement.autoMobileSheet, true);
    popupHandle.close();

    // 5. Tier-2 Global Limits Modal via ui.openModal
    const modalHandle = mountedApp.runtime.openGlobalLimits();
    assert.ok(modalHandle);
    assert.ok(modalHandle.getElementById('gm-override-alert'));
    assert.ok(modalHandle.getElementById('gm-default-input'));
    modalHandle.close();

    // 6. Tier-1 Commands registered
    const cmds = ctx.ui.listCommands();
    for (const actionId of ['open-settings', 'open-global-limits', 'refresh-quota', 'compact-now']) {
      assert.ok(
        cmds.some((c) => c.pluginId === 'antigravity-statusbar' && c.actionId === actionId),
        `Expected Tier-1 command "${actionId}"`,
      );
    }

    // 7. Dispose cleans up signal, services, and DOM
    host.disposePlugin('antigravity-statusbar');
    assert.equal(ctx.lifecycle.signal.aborted, true, 'disposePlugin must abort ctx.lifecycle.signal');
    assert.equal(host.doc.querySelector('[data-addon-host-owner="antigravity-statusbar"]'), null);
  } finally {
    host.disposePlugin('antigravity-statusbar');
  }
});

test('TC-V3-PARITY-02 (Remote Web, Host Bridge Disconnected): @antigravity-addons/sdk v3.1.1 createTestHost({ surface: "remote-web", remoteBridgeConnected: false }) renders read-only Host Bridge guidance with zero URL/token inputs and zero fetches', async (t) => {
  const sdk = loadAddonsSdk();
  if (!sdk || typeof sdk.createTestHost !== 'function') {
    if (process.env.REQUIRE_ADDONS_SDK === '1') {
      assert.fail('REQUIRE_ADDONS_SDK=1 set, but @antigravity-addons/sdk could not be loaded');
    }
    t.skip('@antigravity-addons/sdk sibling repo is not present on this CI runner');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const netCalls = [];
  const host = sdk.createTestHost({
    surface: 'remote-web',
    remoteBridgeConnected: false,
    viewport: { width: 390, height: 844 },
    locale: 'ko',
    themeMode: 'light',
    netHandler: (_pluginId, url) => {
      netCalls.push(url);
      return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
    },
  });

  let mountedApp = null;
  const ctx = await host.mountPlugin(manifest, (pluginCtx) => {
    mountedApp = setupStatusbarV3(pluginCtx, {
      doc: host.doc,
      win: host.win,
      pollConfig: { normalPollMs: 60_000, quotaPollMs: 60_000 },
    });
  });

  try {
    await flush(40);

    // 1. Remote Web v3.1.1 offline capabilities & zero network calls
    assert.equal(ctx.env.surface, 'remote-web');
    assert.equal(ctx.env.capabilities.hasRemoteHostBridge, false);
    assert.equal(ctx.env.capabilities.hasLocalLoopback, false);
    assert.equal(ctx.env.capabilities.hasNetHttps, false);
    assert.equal(netCalls.length, 0, 'Disconnected Remote Web Host Bridge must issue zero Sidecar calls');

    // 2. Settings page shows read-only Host Bridge guidance and ZERO URL/token inputs
    const settingsHandle = mountedApp.runtime.openSettings();
    assert.ok(settingsHandle);
    const bridgeSec = settingsHandle.getElementById('set-remote-bridge-sec');
    assert.ok(bridgeSec, 'Remote Web settings page must show read-only Remote Host Bridge section');
    assert.equal(bridgeSec.hidden, false);
    assert.equal(settingsHandle.getElementById('set-remote-url'), null, 'Plugin-owned Sidecar URL input must be removed');
    assert.equal(settingsHandle.getElementById('set-remote-token'), null, 'Plugin-owned X-Statusbar-Token input must be removed');
    assert.equal(settingsHandle.getElementById('set-remote-connect-btn'), null);
    assert.equal(settingsHandle.getElementById('set-remote-disconnect-btn'), null);

    const badgeEl = settingsHandle.getElementById('set-remote-bridge-badge');
    const statusEl = settingsHandle.getElementById('set-remote-bridge-status');
    assert.ok(badgeEl && badgeEl.textContent.includes('Host Bridge 미연결'));
    assert.ok(statusEl && statusEl.textContent.includes('Addons → Host Bridge'));
    settingsHandle.close();

    // 3. host.statusbar delegation still works on Remote Web while offline
    const peerManifest = {
      schemaVersion: 3,
      apiVersion: 3,
      pluginId: 'remote-peer-offline',
      displayName: 'Remote Peer Offline',
      version: '1.0.0',
      trustLevel: 'restricted',
      capabilities: ['renderer'],
      entry: { rendererScript: 'index.js', mainHookScript: null },
      permissions: { ui: { statusItems: true } },
    };
    await host.mountPlugin(peerManifest, (peerCtx) => {
      peerCtx.ui.registerStatusItem({ id: 'ping', label: 'Ping', badge: 'OK' });
    });
    assert.equal(host.doc.querySelector('[data-addon-host-fallback-statusbar="1"]'), null);
    assert.ok(queryDeep(host.doc.body, '[data-status-plugin-id="remote-peer-offline"]'));

    host.disposePlugin('antigravity-statusbar');
    assert.equal(ctx.lifecycle.signal.aborted, true);
  } finally {
    host.disposePlugin('antigravity-statusbar');
  }
});

test('TC-V3-PARITY-03 (Remote Web, Host Bridge Connected): @antigravity-addons/sdk v3.1.1 createTestHost({ surface: "remote-web", remoteBridgeConnected: true }) routes localLoopback transparently via ctx.net.fetch + ctx.settingsBridge and reacts to host:remote-bridge-changed & ERR_REMOTE_HOST_NOT_CONNECTED', async (t) => {
  const sdk = loadAddonsSdk();
  if (!sdk || typeof sdk.createTestHost !== 'function') {
    if (process.env.REQUIRE_ADDONS_SDK === '1') {
      assert.fail('REQUIRE_ADDONS_SDK=1 set, but @antigravity-addons/sdk could not be loaded');
    }
    t.skip('@antigravity-addons/sdk sibling repo is not present on this CI runner');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const netCalls = [];
  let simulateBridgeDropped = false;
  const host = sdk.createTestHost({
    surface: 'remote-web',
    remoteBridgeConnected: true,
    viewport: { width: 390, height: 844 },
    locale: 'ko',
    themeMode: 'light',
    initialSettings: {
      'antigravity-statusbar': {
        status: 'ok',
        data: {
          mode: 'active',
          baseUrl: 'http://127.0.0.1:43210',
          token: TEST_TOKEN,
        },
      },
    },
    netHandler: (_pluginId, url, init) => {
      const parsed = new URL(url);
      netCalls.push({ url, pathname: parsed.pathname, token: init?.headers?.['x-statusbar-token'] });
      if (simulateBridgeDropped) {
        return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
      }
      if (parsed.pathname === '/api/settings/get') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ locale: 'ko', autoCompact: true, customButtons: [], disabledRuntimeAddonIds: [] }) };
      }
      if (parsed.pathname === '/api/quota') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ available: false, groups: [], stale: false }) };
      }
      if (parsed.pathname === '/api/sessions') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ sessions: [{ sessionId: 'sess-remote-sdk' }] }) };
      }
      return {
        ok: true,
        status: 200,
        bodyText: JSON.stringify({
          sessionId: 'sess-remote-sdk',
          usedTokens: 64000,
          effectiveLimit: 200000,
          maxContextTokens: 512000,
          usagePercent: 32,
          compaction: { inProgress: false, lastError: null },
        }),
      };
    },
  });

  let mountedApp = null;
  const ctx = await host.mountPlugin(manifest, (pluginCtx) => {
    mountedApp = setupStatusbarV3(pluginCtx, {
      doc: host.doc,
      win: host.win,
      pollConfig: { normalPollMs: 60_000, quotaPollMs: 60_000 },
    });
  });

  try {
    await flush(50);

    // 1. Remote Web v3.1.1 connected capabilities mirror Desktop localLoopback + settingsBridge transparently
    assert.equal(ctx.env.surface, 'remote-web');
    assert.equal(ctx.env.capabilities.hasRemoteHostBridge, true);
    assert.equal(ctx.env.capabilities.hasLocalLoopback, true);
    assert.equal(ctx.env.capabilities.hasNetHttps, false);
    assert.equal(typeof ctx.net?.fetch, 'function');
    assert.ok(
      netCalls.some((c) => c.url === 'http://127.0.0.1:43210/api/snapshot' && c.token === TEST_TOKEN),
      'Remote Web with connected Host Bridge must route Sidecar loopback calls via ctx.net.fetch identically to Desktop',
    );
    assert.equal((await ctx.storage.keys()).length, 0, 'Plugin must NOT store any remote credentials in ctx.storage');

    // 2. Settings page displays read-only connected status with ZERO URL/token inputs
    const settingsHandle = mountedApp.runtime.openSettings();
    assert.ok(settingsHandle);
    assert.equal(settingsHandle.getElementById('set-remote-url'), null);
    assert.equal(settingsHandle.getElementById('set-remote-token'), null);
    const badgeEl = settingsHandle.getElementById('set-remote-bridge-badge');
    const statusEl = settingsHandle.getElementById('set-remote-bridge-status');
    assert.ok(badgeEl && badgeEl.textContent.includes('Host Bridge 연결됨'));
    assert.ok(statusEl && statusEl.textContent.includes('Native Host 원격 브리지'));

    // 3. host:remote-bridge-changed disconnect event immediately transitions UI to offline guidance
    ctx.events.emit('host:remote-bridge-changed', { connected: false, baseUrl: null });
    await flush(30);
    assert.ok(badgeEl.textContent.includes('Host Bridge 미연결'));
    assert.ok(statusEl.textContent.includes('Addons → Host Bridge'));

    // 4. host:remote-bridge-changed reconnect event immediately resumes Sidecar polling & updates badge/URL
    const callsBeforeReconnect = netCalls.length;
    ctx.events.emit('host:remote-bridge-changed', { connected: true, baseUrl: 'http://127.0.0.1:19384' });
    await flush(50);
    assert.ok(netCalls.length > callsBeforeReconnect, 'Reconnecting Host Bridge must immediately resume Sidecar polling');
    assert.ok(badgeEl.textContent.includes('Host Bridge 연결됨'));
    assert.ok(statusEl.textContent.includes('http://127.0.0.1:19384'));

    // 5. Runtime ERR_REMOTE_HOST_NOT_CONNECTED from ctx.net.fetch drops cleanly back to offline guidance
    simulateBridgeDropped = true;
    await ctx.settingsBridge.save({
      mode: 'active',
      baseUrl: 'http://127.0.0.1:43211',
      token: TEST_TOKEN,
    });
    await flush(50);
    assert.ok(badgeEl.textContent.includes('Host Bridge 미연결'));
    assert.ok(statusEl.textContent.includes('Addons → Host Bridge'));
    settingsHandle.close();

    // 6. Clean disposal
    host.disposePlugin('antigravity-statusbar');
    assert.equal(ctx.lifecycle.signal.aborted, true);
  } finally {
    host.disposePlugin('antigravity-statusbar');
  }
});
