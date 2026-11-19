import { DomainError, ERROR_CODES } from '../i18n/error-codes.mjs';

export const MIN_CUSTOM_LIMIT = 32_000;
export const MAX_CUSTOM_LIMIT = 980_000;
export const MAX_SESSION_OVERRIDES = 200;
export const MAX_CUSTOM_BUTTONS = 20;
export const MAX_BUTTON_LABEL_LEN = 24;
export const MAX_BUTTON_COMMAND_LEN = 500;

const CUSTOM_BUTTON_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

export const PRESET_LIMITS = Object.freeze([
  32_000,
  64_000,
  128_000,
  200_000,
  256_000,
  384_000,
  512_000,
  980_000,
]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} sessionId
 * @returns {string}
 */
export function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    throw new DomainError(ERROR_CODES.INVALID_SESSION_ID, 400, 'Session ID must be a string.');
  }
  const trimmed = sessionId.trim();
  if (!trimmed || FORBIDDEN_KEYS.has(trimmed) || !SESSION_ID_PATTERN.test(trimmed)) {
    throw new DomainError(ERROR_CODES.INVALID_SESSION_ID, 400, 'Session ID format is invalid.');
  }
  return trimmed;
}

/**
 * @param {unknown} limit
 * @returns {number | null}
 */
export function validateCustomLimit(limit) {
  if (limit === null) {
    return null;
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new DomainError(
      ERROR_CODES.INVALID_CUSTOM_LIMIT,
      400,
      'Custom context limit must be an integer or null.',
    );
  }
  if (limit < MIN_CUSTOM_LIMIT || limit > MAX_CUSTOM_LIMIT) {
    throw new DomainError(
      ERROR_CODES.INVALID_CUSTOM_LIMIT,
      400,
      `Custom context limit must be between ${MIN_CUSTOM_LIMIT} and ${MAX_CUSTOM_LIMIT}.`,
      { min: MIN_CUSTOM_LIMIT, max: MAX_CUSTOM_LIMIT, value: limit },
    );
  }
  return limit;
}

/**
 * Validates and normalizes user-configured custom action buttons.
 *
 * @param {unknown} rawButtons
 * @returns {Array<{ id: string, label: string, command: string }>}
 */
export function validateCustomButtons(rawButtons) {
  if (!Array.isArray(rawButtons)) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      'customButtons must be an array.',
    );
  }
  if (rawButtons.length > MAX_CUSTOM_BUTTONS) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      `customButtons cannot exceed ${MAX_CUSTOM_BUTTONS} items.`,
    );
  }

  const seen = new Set();
  const result = [];
  for (const raw of rawButtons) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DomainError(
        ERROR_CODES.INVALID_SETTINGS_PATCH,
        400,
        'Each custom button must be an object with id, label, and command.',
      );
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!id || FORBIDDEN_KEYS.has(id) || !CUSTOM_BUTTON_ID_PATTERN.test(id)) {
      throw new DomainError(
        ERROR_CODES.INVALID_SETTINGS_PATCH,
        400,
        'Custom button id must match [A-Za-z0-9_-]{1,48}.',
      );
    }
    if (seen.has(id)) {
      throw new DomainError(
        ERROR_CODES.INVALID_SETTINGS_PATCH,
        400,
        `Duplicate custom button id: ${id}`,
      );
    }
    if (!label || label.length > MAX_BUTTON_LABEL_LEN) {
      throw new DomainError(
        ERROR_CODES.INVALID_SETTINGS_PATCH,
        400,
        `Custom button label must be 1-${MAX_BUTTON_LABEL_LEN} characters.`,
      );
    }
    if (!command || command.length > MAX_BUTTON_COMMAND_LEN || command.includes('\0')) {
      throw new DomainError(
        ERROR_CODES.INVALID_SETTINGS_PATCH,
        400,
        `Custom button command must be 1-${MAX_BUTTON_COMMAND_LEN} characters.`,
      );
    }
    seen.add(id);
    result.push({ id, label, command });
  }
  return result;
}

/**
 * Resolves the effective soft context limit for a session.
 * Never mutates host global settings; when hostMaxTokens is known (> 0),
 * clamps custom soft limit to hostMaxTokens to avoid misleading >100% ceilings
 * while preventing division by zero when hostMaxTokens is 0 or unavailable (F4).
 *
 * @param {{ hostMaxTokens: number | null | undefined, sessionCustomLimit: number | null | undefined, defaultCustomLimit: number | null | undefined }} input
 */
export function resolveEffectiveLimit({ hostMaxTokens, sessionCustomLimit, defaultCustomLimit }) {
  const hostMax =
    typeof hostMaxTokens === 'number' && Number.isFinite(hostMaxTokens) && hostMaxTokens > 0
      ? Math.floor(hostMaxTokens)
      : 0;

  const customSource =
    typeof sessionCustomLimit === 'number'
      ? 'session'
      : typeof defaultCustomLimit === 'number'
        ? 'default'
        : 'host';

  const customLimit =
    customSource === 'session'
      ? sessionCustomLimit
      : customSource === 'default'
        ? defaultCustomLimit
        : null;

  if (customLimit !== null) {
    const effectiveLimit = hostMax > 0 ? Math.min(hostMax, customLimit) : customLimit;
    return {
      effectiveLimit,
      hostMaxTokens: hostMax > 0 ? hostMax : null,
      customLimit,
      source: customSource,
      isCustomActive: true,
      isClampedByHost: hostMax > 0 && customLimit > hostMax,
    };
  }

  return {
    effectiveLimit: hostMax,
    hostMaxTokens: hostMax > 0 ? hostMax : null,
    customLimit: null,
    source: 'host',
    isCustomActive: false,
    isClampedByHost: false,
  };
}

/**
 * @param {{ usedTokens: number | null | undefined, effectiveLimit: number }} input
 */
export function evaluateContextThreshold({ usedTokens, effectiveLimit }) {
  if (
    typeof usedTokens !== 'number' ||
    !Number.isFinite(usedTokens) ||
    usedTokens < 0 ||
    typeof effectiveLimit !== 'number' ||
    !Number.isFinite(effectiveLimit) ||
    effectiveLimit <= 0
  ) {
    return {
      usagePercent: null,
      thresholdLevel: 'unknown',
      exceededSoftLimit: false,
    };
  }

  const rawPercent = (usedTokens / effectiveLimit) * 100;
  const usagePercent = Math.round(rawPercent * 10) / 10;

  let thresholdLevel = 'normal';
  if (usagePercent >= 100) {
    thresholdLevel = 'exceeded';
  } else if (usagePercent >= 90) {
    thresholdLevel = 'critical';
  } else if (usagePercent >= 80) {
    thresholdLevel = 'warning';
  }

  return {
    usagePercent,
    thresholdLevel,
    exceededSoftLimit: usedTokens >= effectiveLimit,
  };
}

/**
 * Builds a bounded LRU Map of session overrides (max 200 entries).
 *
 * @param {Array<[string, { limit: number, updatedAt: number }]> | Map<string, { limit: number, updatedAt: number }>} entries
 * @param {number} [maxEntries=200]
 * @returns {Map<string, { limit: number, updatedAt: number }>}
 */
export function pruneSessionOverrides(entries, maxEntries = MAX_SESSION_OVERRIDES) {
  const list = [];
  const iterable = entries instanceof Map ? entries.entries() : Array.isArray(entries) ? entries : [];

  for (const pair of iterable) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [rawId, value] = pair;
    if (!value || typeof value !== 'object') continue;
    let sessionId;
    let limit;
    try {
      sessionId = validateSessionId(rawId);
      limit = validateCustomLimit(value.limit);
    } catch {
      continue;
    }
    if (limit === null) continue;
    const updatedAt =
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? Math.floor(value.updatedAt)
        : 0;
    list.push([sessionId, { limit, updatedAt }]);
  }

  list.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const sliced = list.length > maxEntries ? list.slice(list.length - maxEntries) : list;
  return new Map(sliced);
}
