#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import writeFileAtomic from 'write-file-atomic';

import { renderAddonRendererBundle } from '../src/adapters/antigravity/addon/bundle-builder.mjs';
import {
  DEFAULT_RENDERER_ENTRY,
  resolveConfinedRendererTarget,
} from '../src/adapters/antigravity/addon/runtime-publisher.mjs';

const PLUGIN_NAME = 'antigravity-statusbar';
const INCLUDE_ENTRIES = [
  'plugin.json',
  'addon-manifest.v2.json',
  'package.json',
  'package-lock.json',
  'sidecars',
  'skills',
  'scripts',
  'src',
  'node_modules',
  'LICENSE',
  'README.md',
];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const FALLBACK_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EXDEV']);
const RENAME_MAX_TOTAL_MS = 2_500;
const RM_CLEANUP_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSameOrSubpath(candidate, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isSameFilesystem(statA, pathA, statB, pathB) {
  if (!statA || !statB) return false;
  if (statA.dev !== statB.dev) return false;
  if (process.platform === 'win32') {
    const rootA = path.parse(path.resolve(pathA)).root.toLowerCase();
    const rootB = path.parse(path.resolve(pathB)).root.toLowerCase();
    if (rootA && rootB && rootA !== rootB) {
      return false;
    }
  }
  return true;
}

/**
 * Resolves a staging/backup parent directory outside `parentDir` (e.g. outside watched
 * `~/.gemini/config/plugins/`) so the host app never discovers staging artifacts as plugins
 * or creates `plugin_data/.antigravity-statusbar.staging.*` entries.
 *
 * Prefers `os.tmpdir()` when on the same filesystem for atomic `fs.rename`; falls back to
 * `path.dirname(parentDir)` on cross-filesystem `/tmp` (e.g. Linux tmpfs) if writable on
 * the same filesystem; otherwise returns `os.tmpdir()` and relies on `EXDEV` in-place fallback.
 */
export async function resolveInstallWorkParent(
  parentDir,
  { tmpDir = os.tmpdir(), statFn = fs.stat, accessFn = fs.access } = {},
) {
  const resolvedParent = path.resolve(parentDir);
  const resolvedTmp = path.resolve(tmpDir);

  let parentStat = null;
  try {
    parentStat = await statFn(resolvedParent);
  } catch {
    parentStat = null;
  }

  if (!isSameOrSubpath(resolvedTmp, resolvedParent)) {
    try {
      const tmpStat = await statFn(resolvedTmp);
      if (isSameFilesystem(tmpStat, resolvedTmp, parentStat, resolvedParent)) {
        await accessFn(resolvedTmp, fsConstants.W_OK);
        return resolvedTmp;
      }
    } catch {
      // Fall through to check same-filesystem grandparent outside parentDir
    }
  }

  const grandParent = path.dirname(resolvedParent);
  if (grandParent && grandParent !== resolvedParent && !isSameOrSubpath(grandParent, resolvedParent)) {
    try {
      const grandStat = await statFn(grandParent);
      if (isSameFilesystem(grandStat, grandParent, parentStat, resolvedParent)) {
        await accessFn(grandParent, fsConstants.W_OK);
        return grandParent;
      }
    } catch {
      // Fall through to tmpDir (installPlugin handles EXDEV cleanly via in-place fallback)
    }
  }

  return resolvedTmp;
}

async function renameWithRetry(
  srcPath,
  destPath,
  { renameFn = fs.rename, maxTotalMs = RENAME_MAX_TOTAL_MS } = {},
) {
  const startedAt = Date.now();
  let delayMs = 20;

  while (true) {
    try {
      await renameFn(srcPath, destPath);
      return;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (!RETRYABLE_RENAME_CODES.has(err?.code) || elapsed + delayMs >= maxTotalMs) {
        throw err;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 400);
    }
  }
}

export function parseArgs(argv) {
  let targetDir = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--target') {
      const next = argv[i + 1];
      // NB3: Reject missing, single/double-dash flag-like, or null-byte --target values
      if (!next || next.startsWith('-') || next.includes('\0')) {
        throw new Error('--target requires a valid destination directory path.');
      }
      targetDir = next;
      i += 1;
    }
  }

  const defaultPluginsRoot =
    process.env.ANTIGRAVITY_PLUGINS_DIR ||
    path.join(os.homedir(), '.gemini', 'config', 'plugins');

  const destDir = path.resolve(targetDir || path.join(defaultPluginsRoot, PLUGIN_NAME));
  return { destDir, dryRun };
}

/**
 * Verifies that an existing destination path (if any) is not a symlink.
 */
async function assertNotSymlinkIfExists(targetPath) {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink destination: ${targetPath}`);
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Copies files/directories using Node 20 built-in `fs.cp` with explicit symlink refusal
 * on both source and destination sides (ISS-06).
 */
async function copySafe(src, dest) {
  const rootStat = await fs.lstat(src);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink: ${src}`);
  }
  await assertNotSymlinkIfExists(dest);
  await fs.cp(src, dest, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: async (srcPath, destPath) => {
      const stat = await fs.lstat(srcPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to copy symlink: ${srcPath}`);
      }
      if (destPath) {
        await assertNotSymlinkIfExists(destPath);
      }
      return true;
    },
  });
}

/**
 * Installs antigravity-statusbar as an official Antigravity Native Plugin.
 * Preserves existing plugin `data/` directory (settings.json) and never touches
 * host installation binaries or global host configuration files.
 */
export async function installPlugin({
  repoRoot,
  destDir,
  dryRun = false,
  renameFn = fs.rename,
  renameMaxTotalMs = RENAME_MAX_TOTAL_MS,
  tmpDir = os.tmpdir(),
  statFn = fs.stat,
  accessFn = fs.access,
}) {
  const plannedFiles = [];
  for (const rel of INCLUDE_ENTRIES) {
    const full = path.join(repoRoot, rel);
    try {
      await fs.access(full);
      plannedFiles.push(rel);
    } catch {
      // Optional entry (e.g. LICENSE or node_modules in dry-run before install)
    }
  }

  if (dryRun) {
    return { installed: false, dryRun: true, destDir, entries: plannedFiles };
  }

  // F3: Fail-Closed when runtime dependencies (node_modules) are missing on real install
  const requiredDeps = ['proper-lockfile', 'write-file-atomic'];
  for (const dep of requiredDeps) {
    try {
      await fs.access(path.join(repoRoot, 'node_modules', dep));
    } catch {
      throw new Error(
        `Missing runtime dependency '${dep}' in node_modules. Run 'npm ci --omit=dev' before installing the plugin.`,
      );
    }
  }

  const parentDir = path.dirname(destDir);
  await fs.mkdir(parentDir, { recursive: true });

  const workParent = await resolveInstallWorkParent(parentDir, { tmpDir, statFn, accessFn });
  await fs.mkdir(workParent, { recursive: true });
  const workRoot = await fs.mkdtemp(path.join(workParent, `.${PLUGIN_NAME}-install-`));
  const stagingDir = path.join(workRoot, 'staging');
  const backupDir = path.join(workRoot, 'backup');
  const preservedDataDir = path.join(destDir, 'data');
  const stagedDataDir = path.join(stagingDir, 'data');
  let preserveWorkRoot = false;

  try {
    await fs.mkdir(stagingDir, { recursive: true });
    for (const rel of plannedFiles) {
      await copySafe(path.join(repoRoot, rel), path.join(stagingDir, rel));
    }

    // Write deterministic, immutable, credential-free AddonManifest.v2 static renderer bundle
    // inside confined runtime/ so `trustLevel: "trusted"` SHA-256 pinning never drifts at runtime.
    const staticRendererBundle = renderAddonRendererBundle();
    const stagedRendererPath = path.join(stagingDir, DEFAULT_RENDERER_ENTRY);
    await fs.mkdir(path.dirname(stagedRendererPath), { recursive: true });
    await fs.writeFile(stagedRendererPath, staticRendererBundle, {
      encoding: 'utf8',
      mode: 0o600,
    });

    // Preserve user data/ (settings.json) if it already exists — fail-fast on symlink or copy error (ISS-06)
    let dataStat = null;
    try {
      dataStat = await fs.lstat(preservedDataDir);
    } catch (statErr) {
      if (statErr?.code !== 'ENOENT') {
        throw statErr;
      }
    }
    if (dataStat) {
      if (dataStat.isSymbolicLink()) {
        throw new Error(`Refusing to follow symlinked plugin data directory: ${preservedDataDir}`);
      }
      if (!dataStat.isDirectory()) {
        throw new Error(`Existing plugin data path is not a directory: ${preservedDataDir}`);
      }
      await copySafe(preservedDataDir, stagedDataDir);
    }

    let hadExisting = false;
    try {
      const existingStat = await fs.lstat(destDir);
      if (existingStat.isSymbolicLink()) {
        throw new Error(`Refusing to install over symlink destination: ${destDir}`);
      }
      hadExisting = true;
    } catch (accessErr) {
      if (accessErr?.code !== 'ENOENT') {
        throw accessErr;
      }
      hadExisting = false;
    }

    let movedExistingToBackup = false;
    const renameOpts = { renameFn, maxTotalMs: renameMaxTotalMs };
    try {
      if (hadExisting) {
        await renameWithRetry(destDir, backupDir, renameOpts);
        movedExistingToBackup = true;
      }
      await renameWithRetry(stagingDir, destDir, renameOpts);
      return { installed: true, dryRun: false, mode: 'atomic-rename', destDir, entries: plannedFiles };
    } catch (renameErr) {
      if (movedExistingToBackup) {
        try {
          await renameWithRetry(backupDir, destDir, renameOpts);
          movedExistingToBackup = false;
        } catch (restoreErr) {
          preserveWorkRoot = true;
          throw new Error(
            `Install swap failed (${renameErr?.message || renameErr}) and restoring backup failed (${restoreErr?.message || restoreErr}). Your preserved plugin data remains at: ${backupDir}`,
          );
        }
      }
      // On Windows, a running host app watching ~/.gemini/config/plugins/ may hold a directory handle
      // causing EPERM/EBUSY/EACCES on directory rename; cross-device rename throws EXDEV.
      // Fall back to direct in-place copy preserving data/.
      if (!FALLBACK_RENAME_CODES.has(renameErr?.code)) {
        throw renameErr;
      }
      await fs.mkdir(destDir, { recursive: true });
      for (const rel of plannedFiles) {
        await copySafe(path.join(repoRoot, rel), path.join(destDir, rel));
      }
      // v3.2.0 (trusted): Always atomically write the deterministic static credential-free
      // renderer bundle on install/upgrade after verifying target is not a symlink.
      const fallbackRendererPath = resolveConfinedRendererTarget(destDir, DEFAULT_RENDERER_ENTRY);
      try {
        const rStat = await fs.lstat(fallbackRendererPath);
        if (rStat.isSymbolicLink()) {
          throw new Error(`Refusing to overwrite symlink renderer: ${fallbackRendererPath}`);
        }
      } catch (rErr) {
        if (rErr?.code !== 'ENOENT') throw rErr;
      }
      await fs.mkdir(path.dirname(fallbackRendererPath), { recursive: true });
      await writeFileAtomic(fallbackRendererPath, staticRendererBundle, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return { installed: true, dryRun: false, mode: 'in-place-fallback', destDir, entries: plannedFiles };
    }
  } finally {
    if (!preserveWorkRoot) {
      await fs.rm(workRoot, RM_CLEANUP_OPTIONS).catch(() => {});
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { destDir, dryRun } = parseArgs(process.argv.slice(2));
  installPlugin({ repoRoot, destDir, dryRun })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`[install-plugin] failed: ${err?.message || String(err)}\n`);
      process.exit(1);
    });
}
