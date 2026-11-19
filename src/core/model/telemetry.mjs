/**
 * Pure domain telemetry normalization and calculations.
 * Honest unavailable semantics: missing metrics remain `null` rather than fabricated `0`.
 */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function toNonNegativeIntOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  return Math.floor(num);
}

/**
 * Computes prompt cache hit percentage [0, 100] with 1 decimal precision.
 * Returns `null` when required token counters are unavailable or total input is 0.
 *
 * @param {{ cacheReadTokens: number | null, inputTokens: number | null, inputIncludesCache: boolean }} input
 * @returns {number | null}
 */
export function computeCacheHitPercent({ cacheReadTokens, inputTokens, inputIncludesCache }) {
  const cached = toNonNegativeIntOrNull(cacheReadTokens);
  const input = toNonNegativeIntOrNull(inputTokens);
  if (cached === null || input === null) {
    return null;
  }
  const denominator = inputIncludesCache ? input : cached + input;
  if (denominator <= 0) {
    return null;
  }
  const clampedCached = Math.min(cached, denominator);
  return Math.round((clampedCached / denominator) * 1000) / 10;
}

/**
 * Normalizes a token breakdown group array.
 *
 * @param {unknown} groups
 * @returns {Array<{ key: string, label: string, tokens: number }>}
 */
export function normalizeTokenGroups(groups) {
  if (!Array.isArray(groups)) {
    return [];
  }
  const result = [];
  for (const item of groups) {
    if (!item || typeof item !== 'object') continue;
    const tokens = toNonNegativeIntOrNull(item.tokens);
    if (tokens === null) continue;
    const key = typeof item.key === 'string' && item.key.trim() ? item.key.trim() : 'unknown';
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : key;
    result.push({ key, label, tokens });
  }
  return result;
}

/**
 * Normalizes quota bucket percentage [0, 100].
 *
 * @param {unknown} remainingFraction
 * @returns {number | null}
 */
export function normalizeRemainingPercent(remainingFraction) {
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, remainingFraction));
  return Math.round(clamped * 1000) / 10;
}
