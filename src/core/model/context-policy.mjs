import { DomainError, ERROR_CODES } from '../i18n/error-codes.mjs';

export const MIN_CUSTOM_LIMIT = 32_000;
export const MAX_CUSTOM_LIMIT = 980_000;
export const MAX_SESSION_OVERRIDES = 200;
export const MAX_CUSTOM_BUTTONS = 20;
export const MAX_BUTTON_LABEL_LEN = 24;
export const MAX_BUTTON_COMMAND_LEN = 500;
export const MAX_COMPACT_PROMPT_LEN = 1000;

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
 * Validates optional custom instructions appended to `/compact`.
 * Empty string or null clears the custom prompt (uses default `/compact`).
 *
 * @param {unknown} rawPrompt
 * @returns {string}
 */
export function validateCompactPrompt(rawPrompt) {
  if (rawPrompt === null || rawPrompt === undefined) {
    return '';
  }
  if (typeof rawPrompt !== 'string') {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      'compactPrompt must be a string or null.',
    );
  }
  if (rawPrompt.includes('\0')) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      'compactPrompt cannot contain null bytes.',
    );
  }
  const trimmed = rawPrompt.trim();
  if (trimmed.length > MAX_COMPACT_PROMPT_LEN) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      `compactPrompt must be at most ${MAX_COMPACT_PROMPT_LEN} characters.`,
      { max: MAX_COMPACT_PROMPT_LEN, length: trimmed.length },
    );
  }
  return trimmed;
}

/**
 * Validates a single StatusbarAddon.v1 identifier.
 *
 * @param {unknown} rawId
 * @returns {string}
 */
export function validateAddonId(rawId) {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id || FORBIDDEN_KEYS.has(id) || !CUSTOM_BUTTON_ID_PATTERN.test(id)) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      'Addon id must match [A-Za-z0-9_-]{1,48}.',
    );
  }
  return id;
}

/**
 * Validates a single StatusbarAddon.v1 descriptor.
 *
 * @param {unknown} raw
 * @returns {{ id: string, label: string, command: string, description: string, slot: 'left' | 'right', order: number, enabled: boolean, source: string }}
 */
export function validateAddonDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      'Each addon must be an object with id, label, and command.',
    );
  }
  const id = validateAddonId(raw.id);
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  const description =
    typeof raw.description === 'string' ? raw.description.trim().slice(0, 120) : '';
  const slot = raw.slot === 'left' ? 'left' : 'right';
  const order =
    typeof raw.order === 'number' && Number.isFinite(raw.order)
      ? Math.max(-999, Math.min(999, Math.round(raw.order)))
      : 100;
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  const rawSource = typeof raw.source === 'string' ? raw.source.trim().toLowerCase() : 'agent';
  const source =
    rawSource === 'plugin' || rawSource === 'user' || rawSource === 'agent' ? rawSource : 'agent';

  if (!label || label.length > MAX_BUTTON_LABEL_LEN) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      `Addon label must be 1-${MAX_BUTTON_LABEL_LEN} characters.`,
    );
  }
  if (!command || command.length > MAX_BUTTON_COMMAND_LEN || command.includes('\0')) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      `Addon command must be 1-${MAX_BUTTON_COMMAND_LEN} characters.`,
    );
  }
  return { id, label, command, description, slot, order, enabled, source };
}

/**
 * Validates and normalizes persisted StatusbarAddon.v1 items (`customButtons`).
 *
 * @param {unknown} rawButtons
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
    const item = validateAddonDescriptor(raw);
    if (seen.has(item.id)) {
      throw new DomainError(
        ERROR_CODES.INVALID_SETTINGS_PATCH,
        400,
        `Duplicate addon id: ${item.id}`,
      );
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

/**
 * Validates disabled runtime addon ID list.
 *
 * @param {unknown} rawIds
 * @returns {string[]}
 */
export function validateDisabledAddonIds(rawIds) {
  if (!Array.isArray(rawIds)) {
    throw new DomainError(
      ERROR_CODES.INVALID_SETTINGS_PATCH,
      400,
      'disabledRuntimeAddonIds must be an array.',
    );
  }
  const seen = new Set();
  const out = [];
  for (const raw of rawIds.slice(0, 64)) {
    const id = validateAddonId(raw);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
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
