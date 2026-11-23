import fs from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';

import { DEFAULT_LOCALE, DomainError, ERROR_CODES, normalizeLocale } from '../../core/i18n/error-codes.mjs';
import {
  MAX_CUSTOM_BUTTONS,
  MAX_MODEL_LIMITS,
  MAX_SESSION_OVERRIDES,
  normalizeAutoCompactWhileRunning,
  pruneModelLimits,
  pruneSessionOverrides,
  validateAddonDescriptor,
  validateAddonId,
  validateCompactPrompt,
  validateCustomButtons,
  validateCustomLimit,
  validateDisabledAddonIds,
  validateModelName,
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
    autoCompact: true,
    autoCompactWhileRunning: 'resume',
    compactPrompt: '',
    customButtons: [],
    customButtonsUpdatedAt: 0,
    disabledRuntimeAddonIds: [],
    modelLimits: new Map(),
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

  if (typeof raw.autoCompact === 'boolean') {
    state.autoCompact = raw.autoCompact;
  }

  if (typeof raw.autoCompactWhileRunning === 'string') {
    try {
      state.autoCompactWhileRunning = normalizeAutoCompactWhileRunning(raw.autoCompactWhileRunning);
    } catch {
      state.autoCompactWhileRunning = 'resume';
    }
  }

  if (typeof raw.compactPrompt === 'string') {
    try {
      state.compactPrompt = validateCompactPrompt(raw.compactPrompt);
    } catch {
      state.compactPrompt = '';
    }
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

  if (Array.isArray(raw.disabledRuntimeAddonIds)) {
    try {
      state.disabledRuntimeAddonIds = validateDisabledAddonIds(raw.disabledRuntimeAddonIds);
    } catch {
      state.disabledRuntimeAddonIds = [];
    }
  }

  if (Array.isArray(raw.modelLimits)) {
    state.modelLimits = pruneModelLimits(raw.modelLimits, MAX_MODEL_LIMITS);
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
      autoCompact: state.autoCompact,
      autoCompactWhileRunning: state.autoCompactWhileRunning,
      compactPrompt: state.compactPrompt,
      customButtons: state.customButtons,
      customButtonsUpdatedAt: state.customButtonsUpdatedAt,
      disabledRuntimeAddonIds: state.disabledRuntimeAddonIds,
      modelLimits: Array.from(state.modelLimits.entries()),
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
        autoCompact: state.autoCompact,
        autoCompactWhileRunning: state.autoCompactWhileRunning,
        compactPrompt: state.compactPrompt,
        customButtons: state.customButtons.map((b) => ({ ...b })),
        disabledRuntimeAddonIds: [...state.disabledRuntimeAddonIds],
        modelLimits: new Map(state.modelLimits),
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

        if (Object.prototype.hasOwnProperty.call(patch, 'autoCompact')) {
          current.autoCompact = Boolean(patch.autoCompact);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'autoCompactWhileRunning')) {
          current.autoCompactWhileRunning = normalizeAutoCompactWhileRunning(
            patch.autoCompactWhileRunning,
          );
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'compactPrompt')) {
          current.compactPrompt = validateCompactPrompt(patch.compactPrompt);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'customButtons')) {
          const ts = nextTimestamp(current.customButtonsUpdatedAt);
          current.customButtons = validateCustomButtons(patch.customButtons);
          current.customButtonsUpdatedAt = ts;
        }

        // ISS-07: Atomic in-lock delta patches for StatusbarAddon.v1 mutations (no lost updates)
        if (Object.prototype.hasOwnProperty.call(patch, 'addonUpsert') && patch.addonUpsert) {
          const descriptor = validateAddonDescriptor(patch.addonUpsert);
          const list = current.customButtons.map((b) => ({ ...b }));
          const idx = list.findIndex((b) => b.id === descriptor.id);
          if (idx >= 0) {
            list[idx] = descriptor;
          } else {
            if (list.length >= MAX_CUSTOM_BUTTONS) {
              throw new DomainError(
                ERROR_CODES.INVALID_SETTINGS_PATCH,
                400,
                `customButtons cannot exceed ${MAX_CUSTOM_BUTTONS} items.`,
              );
            }
            list.push(descriptor);
          }
          const ts = nextTimestamp(current.customButtonsUpdatedAt);
          current.customButtons = validateCustomButtons(list);
          current.customButtonsUpdatedAt = ts;
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'addonToggle') && patch.addonToggle) {
          const id = validateAddonId(patch.addonToggle.id);
          const enabled = Boolean(patch.addonToggle.enabled);
          const isRuntime = Boolean(patch.addonToggle.runtime);
          if (isRuntime) {
            const disabled = new Set(current.disabledRuntimeAddonIds);
            if (enabled) disabled.delete(id);
            else disabled.add(id);
            current.disabledRuntimeAddonIds = validateDisabledAddonIds(Array.from(disabled));
          } else {
            const nextList = current.customButtons.map((b) =>
              b.id === id ? { ...b, enabled } : { ...b },
            );
            const ts = nextTimestamp(current.customButtonsUpdatedAt);
            current.customButtons = validateCustomButtons(nextList);
            current.customButtonsUpdatedAt = ts;
          }
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'addonRemove') && patch.addonRemove) {
          const rawId =
            typeof patch.addonRemove === 'string' ? patch.addonRemove : patch.addonRemove.id;
          const id = validateAddonId(rawId);
          const nextList = current.customButtons.filter((b) => b.id !== id);
          const ts = nextTimestamp(current.customButtonsUpdatedAt);
          current.customButtons = validateCustomButtons(nextList);
          current.customButtonsUpdatedAt = ts;
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'disabledRuntimeAddonIds')) {
          current.disabledRuntimeAddonIds = validateDisabledAddonIds(patch.disabledRuntimeAddonIds);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'modelLimit') && patch.modelLimit) {
          const model = validateModelName(patch.modelLimit.model);
          const limit = validateCustomLimit(patch.modelLimit.limit);
          const lower = model.toLowerCase();
          let prevUpdatedAt = 0;
          for (const [k, v] of Array.from(current.modelLimits.entries())) {
            if (k.toLowerCase() === lower) {
              prevUpdatedAt = Math.max(prevUpdatedAt, v?.updatedAt || 0);
              current.modelLimits.delete(k);
            }
          }
          if (limit !== null) {
            const ts = nextTimestamp(prevUpdatedAt);
            current.modelLimits.set(model, { limit, updatedAt: ts });
          }
          current.modelLimits = pruneModelLimits(current.modelLimits, MAX_MODEL_LIMITS);
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
          autoCompact: current.autoCompact,
          autoCompactWhileRunning: current.autoCompactWhileRunning,
          compactPrompt: current.compactPrompt,
          customButtons: current.customButtons.map((b) => ({ ...b })),
          disabledRuntimeAddonIds: [...current.disabledRuntimeAddonIds],
          modelLimits: new Map(current.modelLimits),
          sessions: new Map(current.sessions),
        };
      });
    },
  };
}
