'use strict';

/**
 * Atomic PID + Token File Lock with Stale Lock Recovery.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_STALE_MS = 60000;
const APP_STORAGE_LOCK_STALE_MS = 15000;

function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function writeLockPayload(lockPath, token) {
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
      'utf8'
    );
  } finally {
    fs.closeSync(fd);
  }
}

function restoreDisplacedLockFile(relTmp, lockPath) {
  try {
    fs.linkSync(relTmp, lockPath);
    try {
      fs.unlinkSync(relTmp);
    } catch {}
    return;
  } catch {}
  try {
    if (!fs.existsSync(lockPath)) {
      fs.renameSync(relTmp, lockPath);
      return;
    }
  } catch {}
  try {
    fs.unlinkSync(relTmp);
  } catch {}
}

function acquireFileLock(lockPath, token, staleMs = LOCK_STALE_MS) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      writeLockPayload(lockPath, token);
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
    }

    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    let ownerPid = 0;
    try {
      const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      ownerPid = Number(lockInfo?.pid || 0);
    } catch {}
    const ownerAlive = ownerPid > 0 && isProcessAlive(ownerPid);
    const isStale = (ownerPid > 0 && !ownerAlive) || (!ownerAlive && ageMs > staleMs) || ageMs > staleMs * 10;
    if (!isStale) return false;

    const staleTmp = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lockPath, staleTmp);
    } catch {
      return false;
    }
    try {
      const displacedStat = fs.statSync(staleTmp);
      const displacedAgeMs = Date.now() - displacedStat.mtimeMs;
      const displacedInfo = JSON.parse(fs.readFileSync(staleTmp, 'utf8'));
      const displacedPid = Number(displacedInfo?.pid || 0);
      const displacedAlive = displacedPid > 0 && isProcessAlive(displacedPid);
      const displacedStillStale =
        (displacedPid > 0 && !displacedAlive) ||
        (!displacedAlive && displacedAgeMs > staleMs) ||
        displacedAgeMs > staleMs * 10;
      if (!displacedStillStale) {
        restoreDisplacedLockFile(staleTmp, lockPath);
        return false;
      }
    } catch {}
    try {
      fs.unlinkSync(staleTmp);
    } catch {}
    writeLockPayload(lockPath, token);
    return true;
  } catch {
    return false;
  }
}

function releaseFileLock(lockPath, token) {
  try {
    if (!fs.existsSync(lockPath)) return false;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lockInfo = JSON.parse(raw);
    if (!lockInfo || lockInfo.token !== token) {
      return false;
    }
    const relTmp = `${lockPath}.rel.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lockPath, relTmp);
    } catch {
      return false;
    }
    let movedInfo = null;
    try {
      movedInfo = JSON.parse(fs.readFileSync(relTmp, 'utf8'));
    } catch {}
    if (!movedInfo || movedInfo.token !== token) {
      restoreDisplacedLockFile(relTmp, lockPath);
      return false;
    }
    try {
      fs.unlinkSync(relTmp);
    } catch {}
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  LOCK_STALE_MS,
  APP_STORAGE_LOCK_STALE_MS,
  isProcessAlive,
  acquireFileLock,
  releaseFileLock,
};
