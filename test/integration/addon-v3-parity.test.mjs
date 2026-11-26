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

    // 3. Tier-1 Unified Settings Page registered & Desktop hides Remote Sidecar Connection
    const pages = host.getSettingsPages();
    assert.ok(pages.some((p) => p.pluginId === 'antigravity-statusbar' && p.id === 'settings'));
    const settingsHandle = mountedApp.runtime.openSettings();
    assert.ok(settingsHandle, 'openSettings must open Tier-1 registered settings page');
    assert.equal(settingsHandle.getElementById('set-remote-sec'), null, 'Desktop settings page must NOT render Remote Sidecar Connection');
    const globalSummaryEl = settingsHandle.getElementById('set-global-summary');
    assert.ok(globalSummaryEl, 'Desktop settings page must show live global limits summary');
    assert.ok(globalSummaryEl.textContent.includes('200.0K'));
    assert.ok(globalSummaryEl.textContent.includes('1'));
    assert.ok(settingsHandle.getElementById('set-autocompact-toggle'));
    assert.ok(settingsHandle.getElementById('set-lang-select'));
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

test('TC-V3-PARITY-02 (Remote Web): @antigravity-addons/sdk createTestHost({ surface: "remote-web" }) verifies userApprovedHttps unapproved/approved UX, ctx.net.fetch, dock fallback, host.statusbar, and ctx.storage persistence', async (t) => {
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
  const approvedHosts = new Set();
  const host = sdk.createTestHost({
    surface: 'remote-web',
    viewport: { width: 390, height: 844 },
    locale: 'ko',
    themeMode: 'light',
    netHandler: (_pluginId, url, init) => {
      const parsed = new URL(url);
      netCalls.push({ url, host: parsed.hostname, port: parsed.port || '443', token: init?.headers?.['x-statusbar-token'] });
      if (parsed.protocol !== 'https:') {
        return { ok: false, reason: 'ERR_NET_LOOPBACK_NOT_SUPPORTED' };
      }
      if (parsed.port && parsed.port !== '443') {
        return { ok: false, reason: 'ERR_NET_NON_STANDARD_HTTPS_PORT_FORBIDDEN' };
      }
      if (approvedHosts.size === 0) {
        return { ok: false, reason: 'ERR_NET_USER_HTTPS_HOST_NOT_APPROVED' };
      }
      if (!approvedHosts.has(parsed.hostname)) {
        return { ok: false, reason: `ERR_NET_HOST_NOT_ALLOWED:${parsed.hostname}` };
      }
      const pathname = parsed.pathname;
      if (pathname === '/api/settings/get') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ locale: 'ko', autoCompact: true, customButtons: [], disabledRuntimeAddonIds: [] }) };
      }
      if (pathname === '/api/quota') {
        return { ok: true, status: 200, bodyText: JSON.stringify({ available: false, groups: [], stale: false }) };
      }
      if (pathname === '/api/sessions') {
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

  // No agent-input-box on Remote Web -> mounts into host status-bar dock fallback
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

    // 1. Remote Web surface & v3.0.3 userApprovedHttps capabilities (zero localLoopback, ctx.net.fetch active)
    assert.equal(ctx.env.surface, 'remote-web');
    assert.equal(ctx.env.capabilities.hasLocalLoopback, false);
    assert.equal(ctx.env.capabilities.hasNetHttps, true, 'userApprovedHttps: true must enable ctx.env.capabilities.hasNetHttps on Remote Web');
    assert.equal(typeof ctx.net?.fetch, 'function', 'Remote Web must expose ctx.net.fetch for userApprovedHttps');
    assert.equal(netCalls.length, 0, 'Unconfigured Remote Web must issue zero fetches');

    // 2. Remote Web Settings Page includes Remote Sidecar Connection section + clear unapproved/approved UX
    const settingsHandle = mountedApp.runtime.openSettings();
    assert.ok(settingsHandle);
    const remoteSec = settingsHandle.getElementById('set-remote-sec');
    assert.ok(remoteSec, 'Remote Web settings page must render Remote Sidecar Connection section');
    assert.equal(remoteSec.hidden, false);

    const badgeEl = settingsHandle.getElementById('set-remote-approval-badge');
    const statusEl = settingsHandle.getElementById('set-remote-status');
    assert.ok(badgeEl && badgeEl.textContent.includes('미연결'));

    const urlNode = settingsHandle.getElementById('set-remote-url');
    const tokenNode = settingsHandle.getElementById('set-remote-token');
    const urlInput = String(urlNode?.tagName || '').toLowerCase() === 'input' ? urlNode : urlNode?.querySelector('input');
    const tokenInput = String(tokenNode?.tagName || '').toLowerCase() === 'input' ? tokenNode : tokenNode?.querySelector('input');
    const connectBtn = settingsHandle.getElementById('set-remote-connect-btn');

    // 2a. Unapproved HTTPS host -> clear userApprovedHttps approval guidance
    urlInput.value = 'https://remote-sidecar.example.com';
    urlInput.dispatchEvent({ type: 'input', isTrusted: true });
    tokenInput.value = TEST_TOKEN;
    tokenInput.dispatchEvent({ type: 'input', isTrusted: true });
    connectBtn.click({ isTrusted: true });
    await flush(60);

    assert.ok(badgeEl.textContent.includes('HTTPS 승인 필요'), `Expected approval-required badge, got: ${badgeEl.textContent}`);
    assert.ok(statusEl.textContent.includes('HTTPS 도메인 미승인'), `Expected unapproved host guidance, got: ${statusEl.textContent}`);
    assert.ok(statusEl.textContent.includes('Allowed HTTPS Hosts (User Consent)'));

    // 2b. Non-standard HTTPS port -> clear port 443 guidance
    urlInput.value = 'https://remote-sidecar.example.com:8443';
    urlInput.dispatchEvent({ type: 'input', isTrusted: true });
    connectBtn.click({ isTrusted: true });
    await flush(60);
    assert.ok(statusEl.textContent.includes('443'), `Expected port 443 guidance, got: ${statusEl.textContent}`);

    // 2c. User approves host in Remote Web Drawer -> Connect succeeds via ctx.net.fetch & persists in ctx.storage
    approvedHosts.add('remote-sidecar.example.com');
    urlInput.value = 'https://remote-sidecar.example.com';
    urlInput.dispatchEvent({ type: 'input', isTrusted: true });
    tokenInput.value = TEST_TOKEN;
    tokenInput.dispatchEvent({ type: 'input', isTrusted: true });
    connectBtn.click({ isTrusted: true });
    await flush(60);

    const savedConn = await ctx.storage.get('remoteConnection');
    assert.equal(savedConn?.remoteBaseUrl, 'https://remote-sidecar.example.com');
    assert.equal(savedConn?.remoteToken, TEST_TOKEN);
    assert.ok(netCalls.some((c) => c.url === 'https://remote-sidecar.example.com/api/settings/get'));
    assert.ok(badgeEl.textContent.includes('HTTPS 승인됨 · 연결됨'), `Expected approved badge, got: ${badgeEl.textContent}`);
    assert.ok(statusEl.textContent.includes('호스트 HTTPS 승인 확인'), `Expected approved connected message, got: ${statusEl.textContent}`);

    // Disconnect deletes ctx.storage record and resets badge cleanly
    const disconnectBtn = settingsHandle.getElementById('set-remote-disconnect-btn');
    disconnectBtn.click({ isTrusted: true });
    await flush(40);
    assert.equal(await ctx.storage.get('remoteConnection'), undefined);
    assert.ok(badgeEl.textContent.includes('미연결'));
    settingsHandle.close();

    // 3. host.statusbar delegation works identically on Remote Web
    const peerManifest = {
      schemaVersion: 3,
      apiVersion: 3,
      pluginId: 'remote-peer',
      displayName: 'Remote Peer',
      version: '1.0.0',
      trustLevel: 'restricted',
      capabilities: ['renderer'],
      entry: { rendererScript: 'index.js', mainHookScript: null },
      permissions: { ui: { statusItems: true } },
    };
    await host.mountPlugin(peerManifest, (peerCtx) => {
      peerCtx.ui.registerStatusItem({ id: 'ping', label: 'Ping', badge: '12ms' });
    });
    assert.equal(host.doc.querySelector('[data-addon-host-fallback-statusbar="1"]'), null);
    assert.ok(queryDeep(host.doc.body, '[data-status-plugin-id="remote-peer"]'));

    // 4. Clean disposal
    host.disposePlugin('antigravity-statusbar');
    assert.equal(ctx.lifecycle.signal.aborted, true);
  } finally {
    host.disposePlugin('antigravity-statusbar');
  }
});
