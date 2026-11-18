'use strict';

/**
 * Antigravity Auto-Patcher CLI Entrypoint (`--worker`, `--status`, default hook fast-path).
 */

const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PATCH_MARKER, isAsarPatchedFast } = require('./asar-codec');
const { LOCK_STALE_MS, acquireFileLock, releaseFileLock } = require('./file-lock');
const { injectViaCdpLive, readDevToolsEndpoint } = require('./cdp-injector');
const { DEFAULT_PATHS, syncAppStorageCode, writeStatus, patchAsarOnDisk, uninstallFromDisk } = require('./host-patcher');

const LOCK_TOKEN = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;

function acquireLock(lockPath = DEFAULT_PATHS.LOCK_PATH, token = LOCK_TOKEN) {
  return acquireFileLock(lockPath, token, LOCK_STALE_MS);
}

function releaseLock(lockPath = DEFAULT_PATHS.LOCK_PATH, token = LOCK_TOKEN) {
  return releaseFileLock(lockPath, token);
}

async function runWorkerMode(opts = {}) {
  const lockPath = opts.lockPath || DEFAULT_PATHS.LOCK_PATH;
  const statusPath = opts.statusPath || DEFAULT_PATHS.STATUS_PATH;
  const autoinjectPath = opts.autoinjectPath || DEFAULT_PATHS.AUTOINJECT_PATH;
  const devToolsPortFile = opts.devToolsPortFile || DEFAULT_PATHS.DEVTOOLS_PORT_FILE;
  const asarPath = opts.asarPath || DEFAULT_PATHS.ASAR_PATH;
  const token = opts.lockToken || LOCK_TOKEN;

  if (!acquireLock(lockPath, token)) {
    return null;
  }
  const statusReport = {
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    cdp: null,
    asar: null,
  };

  try {
    try {
      statusReport.cdp = await injectViaCdpLive({ autoinjectPath, devToolsPortFile });
    } catch (err) {
      statusReport.cdp = { error: String(err?.message || err) };
    }

    try {
      statusReport.asar = patchAsarOnDisk({ ...opts, asarPath, autoinjectPath, lockToken: token });
    } catch (err) {
      statusReport.asar = { status: 'ERROR_EXCEPTION', error: String(err?.message || err) };
    }

    if (
      !fs.existsSync(statusPath) ||
      (statusReport.cdp && statusReport.cdp.injectedCount > 0) ||
      (statusReport.asar && statusReport.asar.status !== 'ALREADY_PATCHED')
    ) {
      writeStatus(statusReport, statusPath);
    }
    return statusReport;
  } finally {
    releaseLock(lockPath, token);
  }
}

async function runHookFastPath(entryFilename = __filename) {
  try {
    if (process.stdin && !process.stdin.isTTY) {
      process.stdin.on('error', () => {});
      process.stdin.resume();
    }
  } catch {}

  try {
    syncAppStorageCode();
    if (!isAsarPatchedFast(DEFAULT_PATHS.ASAR_PATH)) {
      const child = spawn(process.execPath, [entryFilename, '--worker'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else {
      await injectViaCdpLive({
        autoinjectPath: DEFAULT_PATHS.AUTOINJECT_PATH,
        devToolsPortFile: DEFAULT_PATHS.DEVTOOLS_PORT_FILE,
      });
    }
  } catch {}
  process.exit(0);
}

async function main(entryFilename = __filename) {
  const args = process.argv.slice(2);
  if (args.includes('--worker')) {
    await runWorkerMode();
    process.exit(0);
  } else if (args.includes('--uninstall')) {
    const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
    if (!acquireLock(DEFAULT_PATHS.LOCK_PATH, token)) {
      process.stderr.write(JSON.stringify({ status: 'FAILED_LOCK_HELD' }) + '\n');
      process.exit(1);
    }
    let res;
    try {
      res = uninstallFromDisk();
    } finally {
      releaseLock(DEFAULT_PATHS.LOCK_PATH, token);
    }
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.exit(res.asarStatus === 'FAILED_WRITE_BUSY' ? 1 : 0);
  } else if (args.includes('--status')) {
    const patched = isAsarPatchedFast(DEFAULT_PATHS.ASAR_PATH);
    let lastStatus = null;
    try {
      if (fs.existsSync(DEFAULT_PATHS.STATUS_PATH)) {
        lastStatus = JSON.parse(fs.readFileSync(DEFAULT_PATHS.STATUS_PATH, 'utf8'));
      }
    } catch {}
    process.stdout.write(JSON.stringify({ isAsarPatched: patched, patchVersion: PATCH_MARKER, lastStatus }, null, 2) + '\n');
    process.exit(0);
  } else {
    await runHookFastPath(entryFilename);
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  runWorkerMode,
  runHookFastPath,
  main,
  readDevToolsEndpoint: () => readDevToolsEndpoint(DEFAULT_PATHS.DEVTOOLS_PORT_FILE),
};
