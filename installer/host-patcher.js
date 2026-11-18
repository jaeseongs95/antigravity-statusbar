'use strict';

/**
 * Antigravity Host Path Defaults, Atomic `app_storage.json` Sync, & ASAR Patch Orchestrator.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  PATCH_MARKER,
  LEGACY_MARKERS,
  UTILS_ANCHOR_TARGET,
  UTILS_ANCHOR_REPLACEMENT,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  PRELOAD_ANCHOR_TARGET,
  PRELOAD_ANCHOR_REPLACEMENT,
  sha256Hex,
  transformExactSize,
  isAsarPatchedFast,
  readAsarArchive,
  serializeAsarBuffer,
} = require('./asar-codec');
const {
  APP_STORAGE_LOCK_STALE_MS,
  acquireFileLock,
  releaseFileLock,
} = require('./file-lock');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME_DIR, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming');

const DEFAULT_PATHS = Object.freeze({
  HOME_DIR,
  LOCAL_APPDATA,
  APPDATA,
  ASAR_PATH: path.join(LOCAL_APPDATA, 'Programs', 'antigravity', 'resources', 'app.asar'),
  AGY_DIR: path.join(HOME_DIR, '.gemini', 'antigravity'),
  AUTOINJECT_PATH: path.join(HOME_DIR, '.gemini', 'antigravity', 'statusbar_autoinject.js'),
  LOCK_PATH: path.join(HOME_DIR, '.gemini', 'antigravity', 'statusbar_patch.lock'),
  APP_STORAGE_LOCK_PATH: path.join(HOME_DIR, '.gemini', 'antigravity', 'statusbar_app_storage.lock'),
  STATUS_PATH: path.join(HOME_DIR, '.gemini', 'antigravity', 'statusbar_patch_status.json'),
  DEVTOOLS_PORT_FILE: path.join(APPDATA, 'Antigravity', 'DevToolsActivePort'),
  APP_STORAGE_PATH: path.join(APPDATA, 'Antigravity', 'app_storage.json'),
  STORAGE_CODE_KEY: 'agy-statusbar-code',
});

function syncAppStorageCode(opts = {}) {
  const autoinjectPath = opts.autoinjectPath || DEFAULT_PATHS.AUTOINJECT_PATH;
  const appStoragePath = opts.appStoragePath || DEFAULT_PATHS.APP_STORAGE_PATH;
  const appStorageLockPath = opts.appStorageLockPath || DEFAULT_PATHS.APP_STORAGE_LOCK_PATH;
  const storageCodeKey = opts.storageCodeKey || DEFAULT_PATHS.STORAGE_CODE_KEY;
  const lockTokenBase = opts.lockToken || `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;

  let tmpPath = null;
  let storageLockToken = null;
  try {
    if (!fs.existsSync(autoinjectPath) || !fs.existsSync(appStoragePath)) {
      return false;
    }
    const code = fs.readFileSync(autoinjectPath, 'utf8');
    const fastRaw = fs.readFileSync(appStoragePath, 'utf8');
    const fastData = JSON.parse(fastRaw);
    if (fastData && typeof fastData === 'object' && fastData[storageCodeKey] === code) {
      return false;
    }

    const candToken = `${lockTokenBase}:storage:${crypto.randomBytes(4).toString('hex')}`;
    if (!acquireFileLock(appStorageLockPath, candToken, APP_STORAGE_LOCK_STALE_MS)) {
      return false;
    }
    storageLockToken = candToken;

    const latestRaw = fs.readFileSync(appStoragePath, 'utf8');
    const data = JSON.parse(latestRaw);
    if (!data || typeof data !== 'object' || data[storageCodeKey] === code) {
      return false;
    }
    data[storageCodeKey] = code;
    const serialized = JSON.stringify(data, null, 2);
    tmpPath = `${appStoragePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    try {
      fs.renameSync(tmpPath, appStoragePath);
    } catch {
      fs.copyFileSync(tmpPath, appStoragePath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    return true;
  } catch {
    return false;
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    if (storageLockToken) {
      releaseFileLock(appStorageLockPath, storageLockToken);
    }
  }
}

function writeFileAtomicVerified(filePath, dataBufOrStr, encoding = null) {
  const expectedBuf = Buffer.isBuffer(dataBufOrStr)
    ? dataBufOrStr
    : Buffer.from(String(dataBufOrStr), encoding || 'utf8');
  const expectedSha = sha256Hex(expectedBuf);
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, expectedBuf);
    const writtenBuf = fs.readFileSync(tmpPath);
    if (writtenBuf.length !== expectedBuf.length || sha256Hex(writtenBuf) !== expectedSha) {
      throw new Error(`Atomic temp verification failed for ${filePath}`);
    }
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }
}

function removeAppStorageCode(opts = {}) {
  const appStoragePath = opts.appStoragePath || DEFAULT_PATHS.APP_STORAGE_PATH;
  const appStorageLockPath = opts.appStorageLockPath || DEFAULT_PATHS.APP_STORAGE_LOCK_PATH;
  const storageCodeKey = opts.storageCodeKey || DEFAULT_PATHS.STORAGE_CODE_KEY;
  const lockTokenBase = opts.lockToken || `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;

  let storageLockToken = null;
  try {
    if (!fs.existsSync(appStoragePath)) return false;
    const fastData = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
    if (!fastData || typeof fastData !== 'object' || !(storageCodeKey in fastData)) {
      return false;
    }

    const candToken = `${lockTokenBase}:storage-del:${crypto.randomBytes(4).toString('hex')}`;
    if (!acquireFileLock(appStorageLockPath, candToken, APP_STORAGE_LOCK_STALE_MS)) {
      return false;
    }
    storageLockToken = candToken;

    const data = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
    if (!data || typeof data !== 'object' || !(storageCodeKey in data)) {
      return false;
    }
    delete data[storageCodeKey];
    writeFileAtomicVerified(appStoragePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (storageLockToken) {
      releaseFileLock(appStorageLockPath, storageLockToken);
    }
  }
}

function writeStatus(statusObj, statusPath = DEFAULT_PATHS.STATUS_PATH) {
  try {
    writeFileAtomicVerified(statusPath, JSON.stringify(statusObj, null, 2) + '\n', 'utf8');
  } catch {}
}

function patchAsarOnDisk(opts = {}) {
  const asarPath = opts.asarPath || DEFAULT_PATHS.ASAR_PATH;
  const autoinjectPath = opts.autoinjectPath || DEFAULT_PATHS.AUTOINJECT_PATH;
  const renameFn = typeof opts.renameFn === 'function' ? opts.renameFn : fs.renameSync;

  syncAppStorageCode(opts);

  if (!fs.existsSync(asarPath)) {
    return { status: 'SKIPPED_NO_ASAR' };
  }
  if (!fs.existsSync(autoinjectPath)) {
    return { status: 'SKIPPED_NO_AUTOINJECT_SCRIPT' };
  }

  if (isAsarPatchedFast(asarPath)) {
    let currentArchive = null;
    try {
      currentArchive = readAsarArchive(asarPath);
    } catch {}
    return {
      status: 'ALREADY_PATCHED',
      patchVersion: PATCH_MARKER,
      appVersion: currentArchive?.appVersion || 'unknown',
    };
  }

  let archive = readAsarArchive(asarPath);
  const appVersion = archive.appVersion;
  const backupPath = `${asarPath}.v${appVersion}.orig`;

  const curUtils = archive.fileMap.get('dist/utils.js')?.toString('utf8') || '';
  const curMain = archive.fileMap.get('dist/main.js')?.toString('utf8') || '';
  const curPreload = archive.fileMap.get('dist/preload.js')?.toString('utf8') || '';

  const hasAnyMarker = (str) => str.includes(PATCH_MARKER) || LEGACY_MARKERS.some((m) => str.includes(m));
  const isPureUnpatched = !hasAnyMarker(curUtils) && !hasAnyMarker(curMain) && !hasAnyMarker(curPreload);

  let backupCreated = false;
  if (isPureUnpatched && !fs.existsSync(backupPath)) {
    writeFileAtomicVerified(backupPath, archive.buf);
    backupCreated = true;
  } else if (!isPureUnpatched && fs.existsSync(backupPath)) {
    try {
      const candidateBackup = readAsarArchive(backupPath);
      if (
        !candidateBackup?.fileMap?.get('dist/utils.js') ||
        !candidateBackup?.fileMap?.get('dist/main.js') ||
        !candidateBackup?.fileMap?.get('dist/preload.js')
      ) {
        return {
          status: 'FAILED_CORRUPTED_BACKUP',
          appVersion,
          backupPath,
          detail: 'Backup ASAR archive is missing required dist/{utils,main,preload}.js entries',
        };
      }
      archive = candidateBackup;
    } catch (backupErr) {
      return {
        status: 'FAILED_CORRUPTED_BACKUP',
        appVersion,
        backupPath,
        detail: String(backupErr?.message || backupErr),
      };
    }
  }

  const origArchiveSize = archive.buf.length;
  const origPreloadOffset = archive.header?.files?.dist?.files?.['preload.js']?.offset;
  const { u0, header, fileMap } = archive;

  const utilsBuf = fileMap.get('dist/utils.js');
  const mainBuf = fileMap.get('dist/main.js');
  const preloadBuf = fileMap.get('dist/preload.js');
  if (!utilsBuf || !mainBuf || !preloadBuf) {
    return { status: 'FAILED_TARGET_FILES_MISSING', appVersion };
  }

  let patchedUtilsBuf;
  let patchedMainBuf;
  let patchedPreloadBuf;
  try {
    patchedUtilsBuf = transformExactSize(utilsBuf, UTILS_ANCHOR_TARGET, UTILS_ANCHOR_REPLACEMENT);
    patchedMainBuf = transformExactSize(mainBuf, MAIN_ANCHOR_TARGET, MAIN_ANCHOR_REPLACEMENT);
    patchedPreloadBuf = transformExactSize(preloadBuf, PRELOAD_ANCHOR_TARGET, PRELOAD_ANCHOR_REPLACEMENT);
  } catch (err) {
    return {
      status: 'FAILED_PATTERN_OR_SIZE',
      appVersion,
      detail: String(err?.message || err),
    };
  }

  fileMap.set('dist/utils.js', patchedUtilsBuf);
  fileMap.set('dist/main.js', patchedMainBuf);
  fileMap.set('dist/preload.js', patchedPreloadBuf);

  const outBuf = serializeAsarBuffer(u0, header, fileMap);
  const outSha = sha256Hex(outBuf);

  const newPreloadOffset = header?.files?.dist?.files?.['preload.js']?.offset;
  if (origPreloadOffset !== newPreloadOffset) {
    return {
      status: 'FAILED_OFFSET_DRIFT',
      appVersion,
      detail: `preload.js offset drifted: ${origPreloadOffset} -> ${newPreloadOffset}`,
    };
  }

  if (outBuf.length !== origArchiveSize) {
    return {
      status: 'FAILED_ARCHIVE_SIZE_DRIFT',
      appVersion,
      detail: `archive size drifted: ${origArchiveSize} -> ${outBuf.length}`,
    };
  }

  const tmpPath = `${asarPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, outBuf);
    const written = fs.readFileSync(tmpPath);
    if (written.length !== outBuf.length || sha256Hex(written) !== outSha) {
      return { status: 'FAILED_TEMP_VERIFICATION', appVersion };
    }
    try {
      renameFn(tmpPath, asarPath);
    } catch (renameErr) {
      return {
        status: 'FAILED_WRITE_BUSY',
        appVersion,
        errorCode: renameErr?.code || 'ERR_RENAME',
        detail: String(renameErr?.message || renameErr),
        backupPath,
      };
    }
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }

  return {
    status: 'PATCHED',
    patchVersion: PATCH_MARKER,
    appVersion,
    backupPath,
    backupCreated,
    exactOffsetPreserved: true,
    preloadOffset: newPreloadOffset,
    bytes: outBuf.length,
    sha256: outSha.toUpperCase(),
  };
}

function findAsarOrigBackup(asarPath) {
  try {
    const dir = path.dirname(asarPath);
    const base = path.basename(asarPath);
    if (!fs.existsSync(dir)) return null;
    const prefix = `${base}.v`;
    const candidates = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.orig'))
      .sort()
      .reverse();
    return candidates.length > 0 ? path.join(dir, candidates[0]) : null;
  } catch {
    return null;
  }
}

function uninstallFromDisk(opts = {}) {
  const asarPath = opts.asarPath || DEFAULT_PATHS.ASAR_PATH;
  const autoinjectPath = opts.autoinjectPath || DEFAULT_PATHS.AUTOINJECT_PATH;
  const agyDir = opts.agyDir || path.dirname(autoinjectPath);
  const statusPath = opts.statusPath || path.join(agyDir, 'statusbar_patch_status.json');
  const patcherShimPath = opts.patcherShimPath || path.join(agyDir, 'ensure_statusbar_patch.js');
  const installerDir = opts.installerDir || path.join(agyDir, 'installer');
  const renameFn = typeof opts.renameFn === 'function' ? opts.renameFn : fs.renameSync;

  const report = {
    asarRestored: false,
    asarStatus: 'SKIPPED_NO_ASAR',
    appStorageRemoved: false,
    removedFiles: [],
  };

  if (fs.existsSync(asarPath)) {
    let backupPath = opts.backupPath || null;
    if (!backupPath) {
      try {
        const cur = readAsarArchive(asarPath);
        const versionCandidate = `${asarPath}.v${cur.appVersion}.orig`;
        if (fs.existsSync(versionCandidate)) backupPath = versionCandidate;
      } catch {}
      if (!backupPath) backupPath = findAsarOrigBackup(asarPath);
    }

    if (backupPath && fs.existsSync(backupPath)) {
      let backupArchive = null;
      try {
        backupArchive = readAsarArchive(backupPath);
        if (
          !backupArchive?.fileMap?.get('dist/utils.js') ||
          !backupArchive?.fileMap?.get('dist/main.js') ||
          !backupArchive?.fileMap?.get('dist/preload.js')
        ) {
          throw new Error('Backup ASAR archive is missing required dist/{utils,main,preload}.js entries');
        }
      } catch (backupErr) {
        report.asarStatus = 'FAILED_CORRUPTED_BACKUP';
        report.detail = String(backupErr?.message || backupErr);
        return report;
      }
      const tmpRestore = `${asarPath}.restore.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(tmpRestore, backupArchive.buf);
        const check = fs.readFileSync(tmpRestore);
        if (check.length !== backupArchive.buf.length || sha256Hex(check) !== sha256Hex(backupArchive.buf)) {
          throw new Error('Backup restore verification failed');
        }
        try {
          renameFn(tmpRestore, asarPath);
          report.asarRestored = true;
          report.asarStatus = 'RESTORED';
          report.restoredFrom = backupPath;
        } catch (err) {
          report.asarStatus = 'FAILED_WRITE_BUSY';
          report.errorCode = err?.code || 'ERR_RENAME';
          return report;
        }
      } finally {
        if (fs.existsSync(tmpRestore)) {
          try { fs.unlinkSync(tmpRestore); } catch {}
        }
      }
    } else if (isAsarPatchedFast(asarPath)) {
      report.asarStatus = 'NO_BACKUP_FOUND';
      return report;
    } else {
      report.asarStatus = 'ALREADY_UNPATCHED';
    }
  }

  report.appStorageRemoved = removeAppStorageCode(opts);

  for (const fileTarget of [autoinjectPath, patcherShimPath, statusPath]) {
    if (fileTarget && fs.existsSync(fileTarget)) {
      try {
        fs.unlinkSync(fileTarget);
        report.removedFiles.push(fileTarget);
      } catch {}
    }
  }
  if (installerDir && fs.existsSync(installerDir)) {
    try {
      fs.rmSync(installerDir, { recursive: true, force: true });
      report.removedFiles.push(installerDir);
    } catch {}
  }

  return report;
}

module.exports = {
  DEFAULT_PATHS,
  writeFileAtomicVerified,
  syncAppStorageCode,
  removeAppStorageCode,
  writeStatus,
  patchAsarOnDisk,
  uninstallFromDisk,
};
