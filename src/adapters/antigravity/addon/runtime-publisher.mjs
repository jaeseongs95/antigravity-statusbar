/**
 * Confined atomic publishers implementing `RendererPublisherPort` (SRP / DIP / LSP).
 *
 * v3.2.0 (`trustLevel: "trusted"`):
 * - `createSettingsBridgePublisher` publishes Desktop Sidecar runtime connection metadata
 *   (`{ schemaVersion, mode, baseUrl, token, updatedAt }`) strictly inside host-owned
 *   `HOST_DATA_DIR/<fileName>` (default `antigravity-statusbar-runtime.json`) so the signed
 *   `runtime/statusbar-renderer.js` stays 100% static and immutable (SHA-256 pinned).
 * - Rejects reserved host filenames, path traversal, separators, null bytes, and symlinks.
 * - Uses `write-file-atomic` (`0o600`) and scrubs credentials back to `mode: "standby"` on
 *   `teardown()` / `teardownSync()`.
 *
 * Legacy `createAddonRuntimePublisher` is retained for unit/backward compatibility.
 */

import fs from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import { renderAddonRendererBundle, renderAddonStandbyStub } from './bundle-builder.mjs';

export const DEFAULT_RENDERER_ENTRY = 'runtime/statusbar-renderer.js';
export const DEFAULT_SETTINGS_BRIDGE_FILE = 'antigravity-statusbar-runtime.json';

const SETTINGS_FILE_RE = /^[a-z0-9][a-z0-9._-]{1,63}\.json$/;
const LOOPBACK_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;
const MIN_TOKEN_LENGTH = 16;
const RESERVED_SETTINGS_FILES = new Set([
  'trust-policy.json',
  'config.json',
  'index.json',
  'build-manifest.json',
  'package.json',
  'remote-preferences.json',
]);
const WINDOWS_DOS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Resolves and verifies that `fileName` is a flat, non-reserved JSON file strictly inside
 * `hostDataDir` with zero symlink escapes.
 *
 * @param {string} hostDataDir
 * @param {string} fileName
 * @returns {string}
 */
export function resolveConfinedSettingsBridgeTarget(
  hostDataDir,
  fileName = DEFAULT_SETTINGS_BRIDGE_FILE,
) {
  if (typeof hostDataDir !== 'string' || !hostDataDir.trim() || hostDataDir.includes('\0')) {
    throw new Error('ERR_INVALID_HOST_DATA_DIR');
  }
  if (
    typeof fileName !== 'string' ||
    !SETTINGS_FILE_RE.test(fileName) ||
    fileName.includes('..') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new Error('ERR_INVALID_SETTINGS_BRIDGE_FILE');
  }
  const lower = fileName.toLowerCase();
  if (
    RESERVED_SETTINGS_FILES.has(lower) ||
    lower.endsWith('.orig.json') ||
    WINDOWS_DOS_DEVICE_RE.test(lower)
  ) {
    throw new Error('ERR_RESERVED_SETTINGS_BRIDGE_FILE');
  }

  const resolvedBase = path.resolve(hostDataDir);
  if (fs.existsSync(resolvedBase)) {
    const baseLstat = fs.lstatSync(resolvedBase);
    if (baseLstat.isSymbolicLink()) {
      throw new Error('ERR_SYMLINK_FORBIDDEN');
    }
    if (!baseLstat.isDirectory()) {
      throw new Error('ERR_INVALID_HOST_DATA_DIR');
    }
    const realBase = fs.realpathSync(resolvedBase);
    const targetPath = path.resolve(realBase, fileName);
    if (path.dirname(targetPath) !== realBase) {
      throw new Error('ERR_SETTINGS_BRIDGE_ESCAPES_HOST_DATA_DIR');
    }
    if (fs.existsSync(targetPath)) {
      const targetLstat = fs.lstatSync(targetPath);
      if (targetLstat.isSymbolicLink()) {
        throw new Error('ERR_SYMLINK_FORBIDDEN');
      }
      if (!targetLstat.isFile()) {
        throw new Error('ERR_INVALID_SETTINGS_BRIDGE_FILE');
      }
      const realTarget = fs.realpathSync(targetPath);
      if (path.dirname(realTarget) !== realBase) {
        throw new Error('ERR_SETTINGS_BRIDGE_ESCAPES_HOST_DATA_DIR');
      }
    }
    return targetPath;
  }

  const targetPath = path.resolve(resolvedBase, fileName);
  if (path.dirname(targetPath) !== resolvedBase) {
    throw new Error('ERR_SETTINGS_BRIDGE_ESCAPES_HOST_DATA_DIR');
  }
  return targetPath;
}

/**
 * Creates a confined `settingsBridge` runtime publisher (`RendererPublisherPort` LSP).
 * Keeps `runtime/statusbar-renderer.js` 100% immutable while delivering per-launch Desktop
 * loopback credentials atomically to `HOST_DATA_DIR/antigravity-statusbar-runtime.json`.
 *
 * @param {{
 *   hostDataDir: string,
 *   fileName?: string,
 * }} opts
 */
export function createSettingsBridgePublisher({
  hostDataDir,
  fileName = DEFAULT_SETTINGS_BRIDGE_FILE,
}) {
  // Fail-closed validation at construction time
  resolveConfinedSettingsBridgeTarget(hostDataDir, fileName);

  function buildActivePayload({ baseUrl, token }) {
    const m = typeof baseUrl === 'string' ? LOOPBACK_URL_RE.exec(baseUrl.trim()) : null;
    const port = m ? Number(m[1]) : 0;
    if (!m || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('ERR_INVALID_LOOPBACK_BASE_URL');
    }
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
      throw new Error('ERR_INVALID_SIDECAR_TOKEN');
    }
    return `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'active',
        baseUrl: baseUrl.trim(),
        token,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`;
  }

  function buildStandbyPayload() {
    return `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'standby',
        baseUrl: null,
        token: null,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`;
  }

  async function writeAtomically(payloadText) {
    fs.mkdirSync(path.resolve(hostDataDir), { recursive: true });
    const verifiedTarget = resolveConfinedSettingsBridgeTarget(hostDataDir, fileName);
    await writeFileAtomic(verifiedTarget, payloadText, { encoding: 'utf8', mode: 0o600 });
    return verifiedTarget;
  }

  async function publish({ baseUrl, token }) {
    return writeAtomically(buildActivePayload({ baseUrl, token }));
  }

  async function teardown() {
    return writeAtomically(buildStandbyPayload());
  }

  function teardownSync() {
    fs.mkdirSync(path.resolve(hostDataDir), { recursive: true });
    const verifiedTarget = resolveConfinedSettingsBridgeTarget(hostDataDir, fileName);
    writeFileAtomic.sync(verifiedTarget, buildStandbyPayload(), { encoding: 'utf8', mode: 0o600 });
    return verifiedTarget;
  }

  return Object.freeze({
    publish,
    teardown,
    teardownSync,
  });
}

/**
 * Resolves and verifies that `relativeEntryPath` stays strictly inside `pluginRootDir`
 * with zero symlink escapes.
 *
 * @param {string} pluginRootDir
 * @param {string} relativeEntryPath
 * @returns {string}
 */
export function resolveConfinedRendererTarget(pluginRootDir, relativeEntryPath = DEFAULT_RENDERER_ENTRY) {
  if (typeof pluginRootDir !== 'string' || !pluginRootDir.trim()) {
    throw new Error('ERR_INVALID_PLUGIN_ROOT_DIR');
  }
  if (
    typeof relativeEntryPath !== 'string' ||
    !relativeEntryPath.trim() ||
    relativeEntryPath.includes('\0') ||
    path.isAbsolute(relativeEntryPath) ||
    /^[A-Za-z]:/.test(relativeEntryPath)
  ) {
    throw new Error('ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT');
  }

  const normalizedRel = path.normalize(relativeEntryPath);
  if (normalizedRel.startsWith('..') || normalizedRel.includes(`..${path.sep}`)) {
    throw new Error('ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT');
  }

  const rootResolved = path.resolve(pluginRootDir);
  if (!fs.existsSync(rootResolved) || !fs.statSync(rootResolved).isDirectory()) {
    throw new Error('ERR_PLUGIN_ROOT_NOT_FOUND');
  }
  const realRoot = fs.realpathSync(rootResolved);
  const candidateTarget = path.resolve(realRoot, normalizedRel);
  const relCheck = path.relative(realRoot, candidateTarget);
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error('ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT');
  }

  // Verify no intermediate directory or existing target file is a symlink
  const segments = relCheck.split(path.sep);
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = path.join(cursor, segments[i]);
    if (fs.existsSync(cursor)) {
      const lstat = fs.lstatSync(cursor);
      if (lstat.isSymbolicLink()) {
        throw new Error('ERR_SYMLINK_FORBIDDEN');
      }
      const realCursor = fs.realpathSync(cursor);
      const cursorRel = path.relative(realRoot, realCursor);
      if (!cursorRel || cursorRel.startsWith('..') || path.isAbsolute(cursorRel)) {
        throw new Error('ERR_RENDERER_ENTRY_ESCAPES_PLUGIN_ROOT');
      }
    }
  }

  return candidateTarget;
}

/**
 * Creates a confined `RendererPublisherPort` instance.
 *
 * @param {{
 *   pluginRootDir: string,
 *   relativeEntryPath?: string,
 *   buildBundle?: typeof renderAddonRendererBundle,
 *   buildStandby?: typeof renderAddonStandbyStub,
 * }} opts
 */
export function createAddonRuntimePublisher({
  pluginRootDir,
  relativeEntryPath = DEFAULT_RENDERER_ENTRY,
  buildBundle = renderAddonRendererBundle,
  buildStandby = renderAddonStandbyStub,
}) {
  // Validate confinement eagerly at construction time (fail-closed)
  resolveConfinedRendererTarget(pluginRootDir, relativeEntryPath);

  async function writeAtomically(sourceText) {
    const targetPath = resolveConfinedRendererTarget(pluginRootDir, relativeEntryPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    // Re-check after mkdir to prevent symlink swap races
    const verifiedTarget = resolveConfinedRendererTarget(pluginRootDir, relativeEntryPath);
    await writeFileAtomic(verifiedTarget, sourceText, { encoding: 'utf8', mode: 0o600 });
    return verifiedTarget;
  }

  async function publish({ baseUrl, token }) {
    const bundleSource = buildBundle({ baseUrl, token });
    return writeAtomically(bundleSource);
  }

  async function teardown() {
    const standbySource = buildStandby();
    return writeAtomically(standbySource);
  }

  /**
   * Synchronous last-resort credential teardown for process `exit` / `uncaughtException`.
   */
  function teardownSync() {
    const standbySource = buildStandby();
    const targetPath = resolveConfinedRendererTarget(pluginRootDir, relativeEntryPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const verifiedTarget = resolveConfinedRendererTarget(pluginRootDir, relativeEntryPath);
    writeFileAtomic.sync(verifiedTarget, standbySource, { encoding: 'utf8', mode: 0o600 });
    return verifiedTarget;
  }

  return Object.freeze({
    publish,
    teardown,
    teardownSync,
  });
}
