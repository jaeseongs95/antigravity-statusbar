import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_LOCALE, DomainError, ERROR_CODES, normalizeLocale } from '../../core/i18n/error-codes.mjs';
import {
  MAX_SESSION_OVERRIDES,
  pruneSessionOverrides,
  validateCustomLimit,
  validateSessionId,
} from '../../core/model/context-policy.mjs';

const SETTINGS_FILENAME = 'settings.json';
const LOCK_FILENAME = 'settings.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_ZERO_BYTE_GRACE_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const RENAME_MAX_TOTAL_MS = 2_500;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user/privilege level.
    return err?.code === 'EPERM';
  }
}

function createDefaultState() {
  return {
    version: 3,
    locale: DEFAULT_LOCALE,
    localeUpdatedAt: 0,
    defaultCustomLimit: null,
    defaultCustomLimitUpdatedAt: 0,
    sessions: new Map(),
  };
}

function parsePersistedState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Settings root must be a JSON object.');
  }

  const state = createDefaultState();

  if (typeof raw.locale === 'string') {
    try {
      state.locale = normalizeLocale(raw.locale);
    } catch {
      state.locale = DEFAULT_LOCALE;
    }
  }
  if (typeof raw.localeUpdatedAt === 'number' && Number.isFinite(raw.localeUpdatedAt)) {
    state.localeUpdatedAt = Math.floor(raw.localeUpdatedAt);
  }

  if (raw.defaultCustomLimit === null || typeof raw.defaultCustomLimit === 'number') {
    try {
      state.defaultCustomLimit = validateCustomLimit(raw.defaultCustomLimit);
    } catch {
      state.defaultCustomLimit = null;
    }
  }
  if (
    typeof raw.defaultCustomLimitUpdatedAt === 'number' &&
    Number.isFinite(raw.defaultCustomLimitUpdatedAt)
  ) {
    state.defaultCustomLimitUpdatedAt = Math.floor(raw.defaultCustomLimitUpdatedAt);
  }

  if (Array.isArray(raw.sessions)) {
    state.sessions = pruneSessionOverrides(raw.sessions, MAX_SESSION_OVERRIDES);
  }

  return state;
}

function serializeState(state) {
  return JSON.stringify(
    {
      version: 3,
      locale: state.locale,
      localeUpdatedAt: state.localeUpdatedAt,
      defaultCustomLimit: state.defaultCustomLimit,
      defaultCustomLimitUpdatedAt: state.defaultCustomLimitUpdatedAt,
      sessions: Array.from(state.sessions.entries()),
    },
    null,
    2,
  );
}

/**
 * Atomic rename with bounded Windows EPERM/EBUSY/EACCES retry backoff (< 3s total, F7).
 */
async function atomicRenameWithRetry(srcPath, destPath) {
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

/**
 * Creates a file-backed SettingsPort implementation with:
 * - Injected dataDir (F10: no direct environment variable reads)
 * - In-process async mutex + cross-process O_EXCL settings.lock (F7)
 * - 0-byte lock mtime > 10s grace + rename-aside & token check stale recovery (F7)
 * - Monotonic timestamps for same-ms updates (F10)
 * - Corrupt settings backup (.corrupt.<ts>) inside lock
 * - 0o600 permissions + Windows EPERM/EBUSY/EACCES rename backoff (< 3s)
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   lockTimeoutMs?: number,
 *   zeroByteGraceMs?: number,
 *   staleLockMs?: number,
 * }} options
 */
export function createJsonSettingsStore({
  dataDir,
  clock = () => Date.now(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  zeroByteGraceMs = DEFAULT_ZERO_BYTE_GRACE_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new DomainError(ERROR_CODES.STORAGE_IO_ERROR, 500, 'dataDir must be a non-empty string.');
  }

  const resolvedDir = path.resolve(dataDir);
  const settingsPath = path.join(resolvedDir, SETTINGS_FILENAME);
  const lockPath = path.join(resolvedDir, LOCK_FILENAME);

  let inProcessChain = Promise.resolve();
  let lastMonotonicTs = 0;

  function nextTimestamp(minPrev = 0) {
    const now = Math.floor(clock());
    const next = Math.max(now, minPrev + 1, lastMonotonicTs + 1);
    lastMonotonicTs = next;
    return next;
  }

  async function ensureDir() {
    await fs.mkdir(resolvedDir, { recursive: true, mode: 0o700 });
  }

  async function tryRecoverStaleLock() {
    let stat;
    try {
      stat = await fs.stat(lockPath);
    } catch (err) {
      if (err?.code === 'ENOENT') return true;
      return false;
    }

    const now = Date.now();
    const ageMs = now - stat.mtimeMs;

    // F7: 0-byte lock grace period (10s) to avoid stealing a lock currently being written.
    if (stat.size === 0) {
      if (ageMs < zeroByteGraceMs) {
        return false;
      }
      const asidePath = `${lockPath}.stale.${crypto.randomUUID()}`;
      try {
        await fs.rename(lockPath, asidePath);
        await fs.unlink(asidePath).catch(() => {});
        return true;
      } catch {
        return false;
      }
    }

    let rawContent = '';
    try {
      rawContent = await fs.readFile(lockPath, 'utf8');
    } catch {
      return false;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // Corrupt lock payload: treat as stale only after grace window
      if (ageMs < zeroByteGraceMs) {
        return false;
      }
    }

    const observedToken = typeof parsed?.token === 'string' ? parsed.token : null;
    const ownerPid = typeof parsed?.pid === 'number' ? parsed.pid : -1;
    const isStale = !isPidAlive(ownerPid) || ageMs >= staleLockMs;

    if (!isStale) {
      return false;
    }

    // F7: Stale recovery via rename-aside + token verification before unlink.
    const asidePath = `${lockPath}.stale.${crypto.randomUUID()}`;
    try {
      await fs.rename(lockPath, asidePath);
    } catch {
      return false;
    }

    try {
      const movedContent = await fs.readFile(asidePath, 'utf8').catch(() => '');
      if (observedToken !== null) {
        let movedParsed = null;
        try {
          movedParsed = JSON.parse(movedContent);
        } catch {
          movedParsed = null;
        }
        if (movedParsed?.token !== observedToken) {
          // Unexpectedly moved a different lock; do not silently discard without logging.
          await fs.unlink(asidePath).catch(() => {});
          return false;
        }
      }
      await fs.unlink(asidePath).catch(() => {});
      return true;
    } catch {
      await fs.unlink(asidePath).catch(() => {});
      return false;
    }
  }

  async function acquireFileLock() {
    await ensureDir();
    const token = crypto.randomUUID();
    const deadline = Date.now() + lockTimeoutMs;
    let attempt = 0;

    while (true) {
      let handle = null;
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
        const payload = JSON.stringify({
          pid: process.pid,
          token,
          createdAt: Date.now(),
        });
        await handle.writeFile(payload, 'utf8');
        await handle.sync().catch(() => {});
        await handle.close();
        handle = null;
        return token;
      } catch (err) {
        if (handle) {
          await handle.close().catch(() => {});
        }
        if (err?.code !== 'EEXIST') {
          throw new DomainError(
            ERROR_CODES.STORAGE_IO_ERROR,
            500,
            `Failed to acquire settings lock: ${err?.message || String(err)}`,
          );
        }

        const recovered = await tryRecoverStaleLock();
        if (recovered) {
          continue;
        }

        if (Date.now() >= deadline) {
          throw new DomainError(
            ERROR_CODES.STORAGE_LOCK_TIMEOUT,
            503,
            'Timed out waiting for settings.lock.',
          );
        }

        attempt += 1;
        const backoff = Math.min(15 + attempt * 15, 120);
        await sleep(backoff);
      }
    }
  }

  async function releaseFileLock(token) {
    try {
      const content = await fs.readFile(lockPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed?.token === token) {
        await fs.unlink(lockPath);
      }
    } catch {
      // Lock already removed or unreadable
    }
  }

  async function withLock(fn) {
    const run = async () => {
      const token = await acquireFileLock();
      try {
        return await fn();
      } finally {
        await releaseFileLock(token);
      }
    };

    const next = inProcessChain.then(run, run);
    inProcessChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async function readStateUnlocked({ backupCorrupt = false } = {}) {
    let rawText;
    try {
      rawText = await fs.readFile(settingsPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return createDefaultState();
      }
      throw new DomainError(
        ERROR_CODES.STORAGE_IO_ERROR,
        500,
        `Failed to read settings: ${err?.message || String(err)}`,
      );
    }

    try {
      return parsePersistedState(JSON.parse(rawText));
    } catch {
      if (backupCorrupt) {
        const corruptPath = `${settingsPath}.corrupt.${Date.now()}`;
        await fs.rename(settingsPath, corruptPath).catch(() => {});
      }
      return createDefaultState();
    }
  }

  async function writeStateUnlocked(state) {
    const tmpPath = `${settingsPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    const payload = serializeState(state);
    let handle = null;
    try {
      handle = await fs.open(tmpPath, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync().catch(() => {});
      await handle.close();
      handle = null;
      await atomicRenameWithRetry(tmpPath, settingsPath);
      await fs.chmod(settingsPath, 0o600).catch(() => {});
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await fs.unlink(tmpPath).catch(() => {});
      throw new DomainError(
        ERROR_CODES.STORAGE_IO_ERROR,
        500,
        `Failed to write settings: ${err?.message || String(err)}`,
      );
    }
  }

  return {
    settingsPath,
    lockPath,

    async read() {
      const state = await readStateUnlocked({ backupCorrupt: false });
      return {
        locale: state.locale,
        defaultCustomLimit: state.defaultCustomLimit,
        sessions: new Map(state.sessions),
      };
    },

    async update(patch) {
      return withLock(async () => {
        const current = await readStateUnlocked({ backupCorrupt: true });

        if (Object.prototype.hasOwnProperty.call(patch, 'locale')) {
          const ts = nextTimestamp(current.localeUpdatedAt);
          current.locale = normalizeLocale(patch.locale);
          current.localeUpdatedAt = ts;
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'defaultCustomLimit')) {
          const ts = nextTimestamp(current.defaultCustomLimitUpdatedAt);
          current.defaultCustomLimit = validateCustomLimit(patch.defaultCustomLimit);
          current.defaultCustomLimitUpdatedAt = ts;
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'sessionLimit') && patch.sessionLimit) {
          const sid = validateSessionId(patch.sessionLimit.sessionId);
          const limit = validateCustomLimit(patch.sessionLimit.limit);
          const prevEntry = current.sessions.get(sid);
          const ts = nextTimestamp(prevEntry ? prevEntry.updatedAt : 0);
          if (limit === null) {
            current.sessions.delete(sid);
          } else {
            current.sessions.set(sid, { limit, updatedAt: ts });
          }
          current.sessions = pruneSessionOverrides(current.sessions, MAX_SESSION_OVERRIDES);
        }

        await writeStateUnlocked(current);

        return {
          locale: current.locale,
          defaultCustomLimit: current.defaultCustomLimit,
          sessions: new Map(current.sessions),
        };
      });
    },
  };
}
