'use strict';

/**
 * Pure Port Contracts, Validators, and Isolated v2 Plugin Bus (`Symbol.for('agy.plugin.bus.v2')`).
 * Zero DOM, browser global, or vendor string dependencies.
 */

const PLUGIN_BUS_SYMBOL = Symbol.for('agy.plugin.bus.v2');

function assertPortMethods(port, portName, requiredMethods) {
  if (!port || typeof port !== 'object') {
    throw new TypeError(`${portName} must be an object`);
  }
  for (const method of requiredMethods) {
    if (typeof port[method] !== 'function') {
      throw new TypeError(`${portName} missing required method "${method}"`);
    }
  }
  return port;
}

const TRANSPORT_PORT_METHODS = Object.freeze([
  'getStats',
  'getCachedStats',
  'getImmediateStats',
  'getQuota',
  'getLatestQuota',
  'getAllTrajectories',
  'updateAnnotations',
  'getGeneratorMetadataRange',
  'dispose',
]);

const STORAGE_PORT_METHODS = Object.freeze([
  'loadPersistent',
  'readSessionCookie',
  'writeSessionCookie',
  'deleteSessionCookie',
  'readDefaultCookie',
  'writeDefaultCookie',
  'getLocalItem',
  'setLocalItem',
  'flushNative',
]);

const ENGINE_PORT_METHODS = Object.freeze([
  'observeSessions',
  'getActiveSessions',
  'applyContextLimit',
  'triggerCompact',
  'getSelectedModelKey',
  'getDebugSnapshot',
  'dispose',
]);

const DOCUMENT_HOST_PORT_METHODS = Object.freeze([
  'getAccessibleDocs',
  'getIframeDocument',
  'buildWarningSuppressionCss',
  'findFallbackSessionTarget',
]);

const COMPANION_LOADER_PORT_METHODS = Object.freeze([
  'discoverCompanions',
  'loadCompanions',
]);

function validateTransportPort(port) {
  return assertPortMethods(port, 'TransportPort', TRANSPORT_PORT_METHODS);
}

function validateStoragePort(port) {
  return assertPortMethods(port, 'StoragePort', STORAGE_PORT_METHODS);
}

function validateEnginePort(port) {
  return assertPortMethods(port, 'EnginePort', ENGINE_PORT_METHODS);
}

function validateDocumentHostPort(port) {
  return assertPortMethods(port, 'DocumentHostPort', DOCUMENT_HOST_PORT_METHODS);
}

function validateCompanionLoaderPort(port) {
  return assertPortMethods(port, 'CompanionLoaderPort', COMPANION_LOADER_PORT_METHODS);
}

function getOrCreatePluginBus(hostRoot) {
  const target = hostRoot && (typeof hostRoot === 'object' || typeof hostRoot === 'function') ? hostRoot : globalThis;
  const existing = target[PLUGIN_BUS_SYMBOL];
  if (
    existing &&
    typeof existing === 'object' &&
    existing.version === 2 &&
    typeof existing.registerPlugin === 'function' &&
    typeof existing.on === 'function'
  ) {
    return existing;
  }

  const plugins = new Map();
  const listeners = new Map();

  const bus = {
    version: 2,
    registerPlugin(id, metadata = {}) {
      const cleanId = typeof id === 'string' ? id.trim() : '';
      if (!cleanId) {
        throw new TypeError('Plugin id must be a non-empty string');
      }
      const entry = Object.freeze({
        id: cleanId,
        version: String(metadata.version || '0.0.0'),
        capabilities: Array.isArray(metadata.capabilities) ? Object.freeze([...metadata.capabilities]) : Object.freeze([]),
        registeredAt: Date.now(),
      });
      plugins.set(cleanId, entry);
      bus.emit('plugin:registered', entry);
      return () => bus.unregisterPlugin(cleanId);
    },
    unregisterPlugin(id) {
      const cleanId = typeof id === 'string' ? id.trim() : '';
      if (!cleanId || !plugins.has(cleanId)) return false;
      const prev = plugins.get(cleanId);
      plugins.delete(cleanId);
      bus.emit('plugin:unregistered', prev);
      return true;
    },
    getPlugin(id) {
      return plugins.get(id) || null;
    },
    listPlugins() {
      return Array.from(plugins.values());
    },
    on(event, handler) {
      if (typeof event !== 'string' || !event || typeof handler !== 'function') {
        return () => {};
      }
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(event);
      };
    },
    off(event, handler) {
      const set = listeners.get(event);
      if (!set) return false;
      const deleted = set.delete(handler);
      if (set.size === 0) listeners.delete(event);
      return deleted;
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set || set.size === 0) return 0;
      let count = 0;
      for (const fn of Array.from(set)) {
        try {
          fn(payload);
          count += 1;
        } catch {}
      }
      return count;
    },
  };

  try {
    Object.defineProperty(target, PLUGIN_BUS_SYMBOL, {
      value: bus,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    target[PLUGIN_BUS_SYMBOL] = bus;
  }
  return bus;
}

module.exports = {
  PLUGIN_BUS_SYMBOL,
  TRANSPORT_PORT_METHODS,
  STORAGE_PORT_METHODS,
  ENGINE_PORT_METHODS,
  DOCUMENT_HOST_PORT_METHODS,
  COMPANION_LOADER_PORT_METHODS,
  assertPortMethods,
  validateTransportPort,
  validateStoragePort,
  validateEnginePort,
  validateDocumentHostPort,
  validateCompanionLoaderPort,
  getOrCreatePluginBus,
};
