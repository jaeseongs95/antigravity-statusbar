import { DomainError, ERROR_CODES } from '../i18n/error-codes.mjs';

/**
 * Validates that an injected port object implements all required methods.
 *
 * @param {unknown} port
 * @param {string} portName
 * @param {string[]} requiredMethods
 */
function assertPort(port, portName, requiredMethods) {
  if (!port || typeof port !== 'object') {
    throw new DomainError(ERROR_CODES.INVALID_PORT, 500, `${portName} must be an object.`);
  }
  for (const method of requiredMethods) {
    if (typeof port[method] !== 'function') {
      throw new DomainError(
        ERROR_CODES.INVALID_PORT,
        500,
        `${portName} is missing required method: ${method}`,
      );
    }
  }
}

export function assertTelemetryPort(port) {
  assertPort(port, 'telemetryPort', ['listSessions', 'getSessionTelemetry', 'getQuotaSummary']);
}

export function assertCompactionPort(port) {
  assertPort(port, 'compactionPort', ['compactSession']);
}

export function assertSettingsPort(port) {
  assertPort(port, 'settingsPort', ['read', 'update']);
}
