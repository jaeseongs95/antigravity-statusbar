/**
 * Confined atomic renderer publisher implementing `RendererPublisherPort` (SRP / DIP).
 *
 * Security & Confinement Invariants:
 * - Writes ONLY inside `<pluginRootDir>/<relativeEntryPath>` (default `runtime/statusbar-renderer.js`).
 * - Rejects absolute paths, `..` traversal, null bytes, and symlinked directories or targets.
 * - Uses `write-file-atomic` (`0o600`) so the addon host never observes a partial file write.
 * - Restores a credential-free standby stub on teardown so no stale Sidecar token lingers on disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import { renderAddonRendererBundle, renderAddonStandbyStub } from './bundle-builder.mjs';

export const DEFAULT_RENDERER_ENTRY = 'runtime/statusbar-renderer.js';

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
