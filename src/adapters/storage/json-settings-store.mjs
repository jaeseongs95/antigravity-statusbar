import fs from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';

import { DEFAULT_LOCALE, DomainError, ERROR_CODES, normalizeLocale } from '../../core/i18n/error-codes.mjs';
import {
  MAX_SESSION_OVERRIDES,
  pruneSessionOverrides,
  validateCustomButtons,
  validateCustomLimit,
  validateSessionId,
} from '../../core/model/context-policy.mjs';

const SETTINGS_FILENAME = 'settings.json';
const DEFAULT_STALE_LOCK_MS = 15_000;
const DEFAULT_LOCK_RETRIES = 25;

function createDefaultState() {
  return {
    version: 3,
    locale: DEFAULT_LOCALE,
    localeUpdatedAt: 0,
    defaultCustomLimit: null,
    defaultCustomLimitUpdatedAt: 0,
    customButtons: [],
    customButtonsUpdatedAt: 0,
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

  if (Array.isArray(raw.customButtons)) {
    try {
      state.customButtons = validateCustomButtons(raw.customButtons);
    } catch {
      state.customButtons = [];
    }
  }
  if (
    typeof raw.customButtonsUpdatedAt === 'number' &&
    Number.isFinite(raw.customButtonsUpdatedAt)
  ) {
    state.customButtonsUpdatedAt = Math.floor(raw.customButtonsUpdatedAt);
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
      customButtons: state.customButtons,
      customButtonsUpdatedAt: state.customButtonsUpdatedAt,
      sessions: Array.from(state.sessions.entries()),
    },
    null,
    2,
  );
}

/**
 * Creates a file-backed SettingsPort implementation using battle-tested libraries
 * (`proper-lockfile` atomic mkdir locking + `write-file-atomic` cross-platform atomic writes):
 * - Injected dataDir (F10: no direct environment variable reads)
 * - In-process async mutex + cross-process proper-lockfile lock (F2)
 * - Monotonic timestamps for same-ms updates (F10)
 * - Corrupt settings backup (.corrupt.<ts>) inside lock
 * - 0o600 permissions
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   staleLockMs?: number,
 *   lockRetries?: number,
 * }} options
 */
export function createJsonSettingsStore({
  dataDir,
  clock = () => Date.now(),
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  lockRetries = DEFAULT_LOCK_RETRIES,
}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new DomainError(ERROR_CODES.STORAGE_IO_ERROR, 500, 'dataDir must be a non-empty string.');
  }

  const resolvedDir = path.resolve(dataDir);
  const settingsPath = path.join(resolvedDir, SETTINGS_FILENAME);
  const lockPath = `${resolvedDir}.lock`;

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

  async function withLock(fn) {
    const run = async () => {
      await ensureDir();
      let release;
      try {
        // F2: Atomic mkdir-based cross-process lock via proper-lockfile (with heartbeat & safe stale recovery)
        release = await lockfile.lock(resolvedDir, {
          realpath: false,
          stale: Math.max(5_000, staleLockMs),
          retries: {
            retries: lockRetries,
            factor: 1.4,
            minTimeout: 15,
            maxTimeout: 150,
          },
        });
      } catch (err) {
        if (err?.code === 'ELOCKED') {
          throw new DomainError(
            ERROR_CODES.STORAGE_LOCK_TIMEOUT,
            503,
            'Timed out waiting for cross-process settings lock.',
          );
        }
        throw new DomainError(
          ERROR_CODES.STORAGE_IO_ERROR,
          500,
          `Failed to acquire settings lock: ${err?.message || String(err)}`,
        );
      }

      try {
        return await fn();
      } finally {
        await release().catch(() => {});
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
    const payload = serializeState(state);
    try {
      await writeFileAtomic(settingsPath, payload, {
        encoding: 'utf8',
        mode: 0o600,
        fsync: true,
      });
    } catch (err) {
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
        customButtons: state.customButtons.map((b) => ({ ...b })),
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

        if (Object.prototype.hasOwnProperty.call(patch, 'customButtons')) {
          const ts = nextTimestamp(current.customButtonsUpdatedAt);
          current.customButtons = validateCustomButtons(patch.customButtons);
          current.customButtonsUpdatedAt = ts;
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
          customButtons: current.customButtons.map((b) => ({ ...b })),
          sessions: new Map(current.sessions),
        };
      });
    },
  };
}
