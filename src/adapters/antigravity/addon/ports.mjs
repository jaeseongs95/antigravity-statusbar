/**
 * Segregated SOLID port contracts (ISP / DIP) for AddonManifest.v2 statusbar modules.
 *
 * Each assertion function is self-contained (zero outer closures) so it can be imported
 * directly in Node unit tests and deterministically assembled into the renderer bundle.
 */

export function assertRendererHostPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('ERR_INVALID_RENDERER_HOST_PORT');
  }
  const required = ['mountSlot', 'unmountSlot', 'injectStyle', 'removeStyle', 'onDispose'];
  for (let i = 0; i < required.length; i += 1) {
    if (typeof port[required[i]] !== 'function') {
      throw new Error(`ERR_INVALID_RENDERER_HOST_PORT:missing_${required[i]}`);
    }
  }
  const optionalPortals = ['openModal', 'openPopover'];
  for (let i = 0; i < optionalPortals.length; i += 1) {
    const key = optionalPortals[i];
    if (port[key] !== undefined && port[key] !== null && typeof port[key] !== 'function') {
      throw new Error(`ERR_INVALID_RENDERER_HOST_PORT:invalid_${key}`);
    }
  }
  return port;
}

export function assertPortalHostPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('ERR_INVALID_PORTAL_HOST_PORT');
  }
  const required = ['openModal', 'openPopover'];
  for (let i = 0; i < required.length; i += 1) {
    if (typeof port[required[i]] !== 'function') {
      throw new Error(`ERR_INVALID_PORTAL_HOST_PORT:missing_${required[i]}`);
    }
  }
  return port;
}

export function assertStatusbarApiPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('ERR_INVALID_STATUSBAR_API_PORT');
  }
  const required = ['post', 'isConnected', 'abortAll'];
  for (let i = 0; i < required.length; i += 1) {
    if (typeof port[required[i]] !== 'function') {
      throw new Error(`ERR_INVALID_STATUSBAR_API_PORT:missing_${required[i]}`);
    }
  }
  return port;
}

export function assertAddonRegistryPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('ERR_INVALID_ADDON_REGISTRY_PORT');
  }
  const required = [
    'register',
    'unregister',
    'list',
    'setEnabled',
    'getSortedPersisted',
    'getSortedRuntime',
    'isRuntimeDisabled',
    'applyPersistedSettings',
    'removeRuntime',
    'clear',
    'publicApi',
  ];
  for (let i = 0; i < required.length; i += 1) {
    const key = required[i];
    if (key === 'publicApi') {
      if (!port.publicApi || typeof port.publicApi !== 'object') {
        throw new Error('ERR_INVALID_ADDON_REGISTRY_PORT:missing_publicApi');
      }
    } else if (typeof port[key] !== 'function') {
      throw new Error(`ERR_INVALID_ADDON_REGISTRY_PORT:missing_${key}`);
    }
  }
  return port;
}

export function assertRendererPublisherPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('ERR_INVALID_RENDERER_PUBLISHER_PORT');
  }
  const required = ['publish', 'teardown'];
  for (let i = 0; i < required.length; i += 1) {
    if (typeof port[required[i]] !== 'function') {
      throw new Error(`ERR_INVALID_RENDERER_PUBLISHER_PORT:missing_${required[i]}`);
    }
  }
  return port;
}
