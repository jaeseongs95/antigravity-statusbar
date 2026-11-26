/**
 * Deterministic renderer script assembler & direct ESM setup entrypoint for AddonManifest.v3 (SRP).
 *
 * Composes the SOLID DIP factory modules into:
 * 1. `setupStatusbarV3(ctx, opts)` — direct ESM entrypoint for `@antigravity-addons/sdk` parity tests.
 * 2. `renderAddonRendererBundle(opts)` — deterministic self-contained script body executed by
 *    `antigravity-addons` v3.0.0+ in Isolated World 998 (`(function(addonHost){ ... })(ctx)`).
 *
 * Security Invariants:
 * - Zero manual popover/modal slots (only `antigravity-statusbar.root` for the Tier-3 inline bar).
 * - Branches strictly on `ctx.env.surface` (NEVER raw `hostProfileId`).
 * - Validates loopback-only `baseUrl` and >= 16-char `token` when explicitly provided for tests.
 * - Seals both `addonHost` and `token` strictly inside closure scope (never on `window` or DOM).
 */

import {
  MAX_CUSTOM_LIMIT,
  MIN_CUSTOM_LIMIT,
  PRESET_LIMITS,
} from '../../../core/model/context-policy.mjs';
import { createAddonRegistry } from './addon-bridge.mjs';
import { createAddonHostAdapter } from './addon-host-adapter.mjs';
import { createSidecarApiClient } from './api-client.mjs';
import { createBarController } from './bar-controller.mjs';
import { createBarView } from './bar-view.mjs';
import { startAddonStatusbar, startStandbyStatusbar } from './bootstrap.mjs';
import { createInlineI18n } from './i18n.mjs';
import {
  assertAddonRegistryPort,
  assertRendererHostPort,
  assertStatusbarApiPort,
} from './ports.mjs';
import { STATUSBAR_STYLE_ID, STATUSBAR_STYLES } from './styles.mjs';
import { createDeclarativeUiSchemas } from './ui-schemas.mjs';

const LOOPBACK_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const MIN_TOKEN_LENGTH = 16;

export const ADDON_SLOT_ID = 'antigravity-statusbar.root';
export const ADDON_SLOT_IDS = Object.freeze({
  root: ADDON_SLOT_ID,
});

function serializeSafeJson(val) {
  return JSON.stringify(val)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Direct ESM `AddonContextV3` setup function for SDK `createTestHost` parity testing and modular consumers.
 *
 * @param {object} ctx AddonContextV3 handle
 * @param {object} [opts]
 */
export function setupStatusbarV3(
  ctx,
  {
    doc = typeof document !== 'undefined' ? document : null,
    win = typeof window !== 'undefined' ? window : null,
    baseUrl = null,
    token = null,
    fetchImpl = undefined,
    pollConfig = {},
  } = {},
) {
  const hostPort = assertRendererHostPort(createAddonHostAdapter(ctx, ADDON_SLOT_IDS));
  const isRemoteWeb = hostPort.surface === 'remote-web';
  const hasStaticInitialConnection = Boolean(!isRemoteWeb && baseUrl && token);
  const netFetchImpl = typeof hostPort.netFetch === 'function' ? hostPort.netFetch : null;
  const api = assertStatusbarApiPort(
    createSidecarApiClient({
      baseUrl: hasStaticInitialConnection ? baseUrl : null,
      token: hasStaticInitialConnection ? token : null,
      netFetchImpl,
      fetchImpl,
    }),
  );
  const i18n = createInlineI18n('ko');
  let runtimeRef = null;
  const addons = assertAddonRegistryPort(
    createAddonRegistry({
      api,
      onChange() {
        if (runtimeRef && typeof runtimeRef.render === 'function') runtimeRef.render();
      },
    }),
  );
  runtimeRef = startAddonStatusbar({
    hostPort,
    api,
    i18n,
    addons,
    createBarViewFn: createBarView,
    createDeclarativeUiSchemasFn: createDeclarativeUiSchemas,
    createBarControllerFn: createBarController,
    doc,
    win,
    cssText: STATUSBAR_STYLES,
    styleId: STATUSBAR_STYLE_ID,
    pollConfig,
    hasStaticInitialConnection,
  });
  return Object.freeze({
    hostPort,
    api,
    i18n,
    addons,
    runtime: runtimeRef,
  });
}

/**
 * Builds the deterministic AddonManifest.v3 renderer script body.
 *
 * Default (`renderAddonRendererBundle()` with no arguments) emits a 100% static, immutable,
 * credential-free bundle suitable for SHA-256 trust pinning and Remote Web static packing.
 *
 * @param {{ baseUrl?: string, token?: string }} [opts]
 * @returns {string}
 */
export function renderAddonRendererBundle(opts = {}) {
  const hasExplicitCreds =
    opts &&
    typeof opts === 'object' &&
    (opts.baseUrl !== undefined || opts.token !== undefined);

  let initialConnection = null;
  if (hasExplicitCreds) {
    const { baseUrl, token } = opts;
    if (typeof baseUrl !== 'string' || !LOOPBACK_URL_RE.test(baseUrl)) {
      throw new Error('Invalid loopback baseUrl for AddonManifest.v3 renderer bundle.');
    }
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
      throw new Error('Invalid token for AddonManifest.v3 renderer bundle.');
    }
    initialConnection = { baseUrl, token };
  }

  const serializedCfg = serializeSafeJson({
    ...(initialConnection ? { baseUrl: initialConnection.baseUrl, token: initialConnection.token } : {}),
    slotIds: ADDON_SLOT_IDS,
    styleId: STATUSBAR_STYLE_ID,
    styles: STATUSBAR_STYLES,
    limits: {
      min: MIN_CUSTOM_LIMIT,
      max: MAX_CUSTOM_LIMIT,
      presets: PRESET_LIMITS,
    },
  });

  return [
    '// Auto-generated by antigravity-statusbar (AddonManifest.v3 API-First static trusted renderer bundle)',
    "'use strict';",
    '(function(hostHandle, cfg) {',
    "  if (typeof window === 'undefined' || typeof document === 'undefined') return;",
    `  ${assertRendererHostPort.toString()}`,
    `  ${assertStatusbarApiPort.toString()}`,
    `  ${assertAddonRegistryPort.toString()}`,
    `  ${createAddonHostAdapter.toString()}`,
    `  ${createInlineI18n.toString()}`,
    `  ${createSidecarApiClient.toString()}`,
    `  ${createAddonRegistry.toString()}`,
    `  ${createBarView.toString()}`,
    `  ${createDeclarativeUiSchemas.toString()}`,
    `  ${createBarController.toString()}`,
    `  ${startAddonStatusbar.toString()}`,
    '  const hostPort = assertRendererHostPort(createAddonHostAdapter(hostHandle, cfg.slotIds));',
    "  const isRemoteWeb = hostPort.surface === 'remote-web';",
    '  const hasStaticInitialConnection = Boolean(!isRemoteWeb && cfg.baseUrl && cfg.token);',
    "  const netFetchImpl = typeof hostPort.netFetch === 'function' ? hostPort.netFetch : null;",
    '  const api = assertStatusbarApiPort(createSidecarApiClient({',
    '    baseUrl: hasStaticInitialConnection ? cfg.baseUrl : null,',
    '    token: hasStaticInitialConnection ? cfg.token : null,',
    '    netFetchImpl,',
    '  }));',
    "  const i18n = createInlineI18n('ko');",
    '  let runtimeRef = null;',
    '  const addons = assertAddonRegistryPort(createAddonRegistry({',
    '    api,',
    '    onChange() {',
    '      if (runtimeRef && typeof runtimeRef.render === "function") runtimeRef.render();',
    '    },',
    '  }));',
    '  runtimeRef = startAddonStatusbar({',
    '    hostPort,',
    '    api,',
    '    i18n,',
    '    addons,',
    '    createBarViewFn: createBarView,',
    '    createDeclarativeUiSchemasFn: createDeclarativeUiSchemas,',
    '    createBarControllerFn: createBarController,',
    '    doc: document,',
    '    win: window,',
    '    cssText: cfg.styles,',
    '    styleId: cfg.styleId,',
    '    hasStaticInitialConnection,',
    '  });',
    `})(typeof addonHost !== 'undefined' ? addonHost : null, ${serializedCfg});`,
    '',
  ].join('\n');
}

/**
 * Explicit alias emitting the deterministic, immutable, credential-free v3 static renderer bundle.
 *
 * @returns {string}
 */
export function renderAddonStaticBundle() {
  return renderAddonRendererBundle();
}

/**
 * Builds the credential-free AddonManifest.v3 standby renderer stub installed prior to
 * Sidecar startup and written back on Sidecar shutdown.
 *
 * @returns {string}
 */
export function renderAddonStandbyStub() {
  const serializedCfg = serializeSafeJson({
    slotIds: ADDON_SLOT_IDS,
    styleId: STATUSBAR_STYLE_ID,
    styles: STATUSBAR_STYLES,
  });

  return [
    '// antigravity-statusbar (AddonManifest.v3 standby renderer stub — zero credentials)',
    "'use strict';",
    '(function(hostHandle, cfg) {',
    "  if (typeof window === 'undefined' || typeof document === 'undefined') return;",
    `  ${assertRendererHostPort.toString()}`,
    `  ${createAddonHostAdapter.toString()}`,
    `  ${createInlineI18n.toString()}`,
    `  ${startStandbyStatusbar.toString()}`,
    '  const hostPort = assertRendererHostPort(createAddonHostAdapter(hostHandle, cfg.slotIds));',
    "  const i18n = createInlineI18n('ko');",
    '  startStandbyStatusbar({',
    '    hostPort,',
    '    i18n,',
    '    doc: document,',
    '    win: window,',
    '    cssText: cfg.styles,',
    '    styleId: cfg.styleId,',
    '  });',
    `})(typeof addonHost !== 'undefined' ? addonHost : null, ${serializedCfg});`,
    '',
  ].join('\n');
}
