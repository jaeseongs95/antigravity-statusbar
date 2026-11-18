#!/usr/bin/env node
'use strict';

/**
 * Compatibility Shim for Antigravity Statusbar Auto-Patch & Live CDP Recovery (v2.0 modular installer).
 * Resolves `installer/` from either the repository (`../installer`) or installed `~/.gemini/antigravity/installer/`.
 */

const fs = require('fs');
const path = require('path');

function resolveInstallerDir() {
  const candidates = [
    path.join(__dirname, '..', 'installer'),
    path.join(__dirname, 'installer'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'cli.js'))) {
      return dir;
    }
  }
  throw new Error('Unable to locate antigravity-statusbar installer/ directory');
}

const INSTALLER_DIR = resolveInstallerDir();
const asarCodec = require(path.join(INSTALLER_DIR, 'asar-codec'));
const cdpInjector = require(path.join(INSTALLER_DIR, 'cdp-injector'));
const hostPatcher = require(path.join(INSTALLER_DIR, 'host-patcher'));
const cli = require(path.join(INSTALLER_DIR, 'cli'));
const rfc6455 = require(path.join(INSTALLER_DIR, 'rfc6455-client'));

const {
  PATCH_MARKER,
  UTILS_ANCHOR_TARGET,
  UTILS_ANCHOR_REPLACEMENT,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  PRELOAD_ANCHOR_TARGET,
  PRELOAD_ANCHOR_REPLACEMENT,
  sha256Hex,
  computeIntegrity,
  transformExactSize,
  isAsarPatchedFast,
} = asarCodec;

const { DEFAULT_PATHS, syncAppStorageCode } = hostPatcher;
const { detectBundledPlugins, configureTargetViaCdp, injectViaBrowserCdpWs } = cdpInjector;
const { createRfc6455WebSocketClient } = rfc6455;
const { acquireLock, releaseLock, main } = cli;

module.exports = {
  PATCH_MARKER,
  UTILS_ANCHOR_TARGET,
  UTILS_ANCHOR_REPLACEMENT,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  PRELOAD_ANCHOR_TARGET,
  PRELOAD_ANCHOR_REPLACEMENT,
  sha256Hex,
  computeIntegrity,
  transformExactSize,
  isAsarPatchedFast: (asarPath = DEFAULT_PATHS.ASAR_PATH) => isAsarPatchedFast(asarPath),
  acquireLock: () => acquireLock(DEFAULT_PATHS.LOCK_PATH),
  releaseLock: () => releaseLock(DEFAULT_PATHS.LOCK_PATH),
  syncAppStorageCode: () => syncAppStorageCode(),
  detectBundledPlugins,
  createRfc6455WebSocketClient,
  configureTargetViaCdp,
  injectViaBrowserCdpWs,
  readDevToolsEndpoint: () => cdpInjector.readDevToolsEndpoint(DEFAULT_PATHS.DEVTOOLS_PORT_FILE),
};

if (require.main === module) {
  main(__filename).catch(() => process.exit(0));
}
