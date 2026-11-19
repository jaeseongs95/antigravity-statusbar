export const SUPPORTED_LOCALES = Object.freeze(['en', 'ko']);
export const DEFAULT_LOCALE = 'en';

export const ERROR_CODES = Object.freeze({
  INVALID_SESSION_ID: 'INVALID_SESSION_ID',
  INVALID_CUSTOM_LIMIT: 'INVALID_CUSTOM_LIMIT',
  INVALID_LOCALE: 'INVALID_LOCALE',
  INVALID_SETTINGS_PATCH: 'INVALID_SETTINGS_PATCH',
  SESSION_MISMATCH: 'SESSION_MISMATCH',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  COMPACTION_IN_PROGRESS: 'COMPACTION_IN_PROGRESS',
  COMPACTION_FAILED: 'COMPACTION_FAILED',
  TELEMETRY_UNAVAILABLE: 'TELEMETRY_UNAVAILABLE',
  QUOTA_UNAVAILABLE: 'QUOTA_UNAVAILABLE',
  STORAGE_LOCK_TIMEOUT: 'STORAGE_LOCK_TIMEOUT',
  STORAGE_IO_ERROR: 'STORAGE_IO_ERROR',
  INVALID_PORT: 'INVALID_PORT',
});

export class DomainError extends Error {
  /**
   * @param {string} code
   * @param {number} [httpStatus=400]
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, httpStatus = 400, message = code, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/**
 * @param {unknown} value
 * @returns {'en' | 'ko'}
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') {
    throw new DomainError(ERROR_CODES.INVALID_LOCALE, 400, 'Locale must be a string.');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'en' || normalized === 'ko') {
    return normalized;
  }
  throw new DomainError(ERROR_CODES.INVALID_LOCALE, 400, `Unsupported locale: ${value}`);
}
