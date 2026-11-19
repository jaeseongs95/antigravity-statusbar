#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'antigravity-statusbar';
const INCLUDE_ENTRIES = [
  'plugin.json',
  'package.json',
  'package-lock.json',
  'sidecars',
  'src',
  'node_modules',
  'LICENSE',
  'README.md',
];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_TOTAL_MS = 2_500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(srcPath, destPath) {
  const startedAt = Date.now();
  let delayMs = 20;

  while (true) {
    try {
      await fs.rename(srcPath, destPath);
      return;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (!RETRYABLE_RENAME_CODES.has(err?.code) || elapsed + delayMs >= RENAME_MAX_TOTAL_MS) {
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
 * Copies files/directories using Node 20 built-in `fs.cp` with explicit symlink refusal.
 */
async function copySafe(src, dest) {
  const rootStat = await fs.lstat(src);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink: ${src}`);
  }
  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (srcPath) => {
      const stat = await fs.lstat(srcPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to copy symlink: ${srcPath}`);
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
export async function installPlugin({ repoRoot, destDir, dryRun = false }) {
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

  const parentDir = path.dirname(destDir);
  await fs.mkdir(parentDir, { recursive: true });

  const stagingDir = path.join(parentDir, `.${PLUGIN_NAME}.staging.${process.pid}.${Date.now()}`);
  const preservedDataDir = path.join(destDir, 'data');
  const stagedDataDir = path.join(stagingDir, 'data');

  try {
    await fs.mkdir(stagingDir, { recursive: true });
    for (const rel of plannedFiles) {
      await copySafe(path.join(repoRoot, rel), path.join(stagingDir, rel));
    }

    // Preserve user data/ (settings.json) if it already exists
    try {
      const dataStat = await fs.stat(preservedDataDir);
      if (dataStat.isDirectory()) {
        await copySafe(preservedDataDir, stagedDataDir);
      }
    } catch {
      // No existing data directory
    }

    const backupDir = path.join(parentDir, `.${PLUGIN_NAME}.old.${process.pid}.${Date.now()}`);
    let hadExisting = false;
    try {
      await fs.access(destDir);
      hadExisting = true;
    } catch {
      hadExisting = false;
    }

    if (hadExisting) {
      await renameWithRetry(destDir, backupDir);
    }
    try {
      await renameWithRetry(stagingDir, destDir);
    } catch (err) {
      if (hadExisting) {
        await renameWithRetry(backupDir, destDir).catch(() => {});
      }
      throw err;
    }
    if (hadExisting) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }

    return { installed: true, dryRun: false, destDir, entries: plannedFiles };
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
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
