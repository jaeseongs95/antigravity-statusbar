/**
 * Vendor-neutral host bridge client for the UI layer.
 * Uses the runtime-injected bridge (`__STATUSBAR_HOST_BRIDGE__`) so `src/ui/`
 * has zero host-specific transport or auth coupling.
 */
export function createHostBridgeClient(globalObj = globalThis) {
  function getBridge() {
    const bridge = globalObj?.__STATUSBAR_HOST_BRIDGE__;
    if (!bridge || typeof bridge.request !== 'function') {
      throw new Error('Host bridge is unavailable.');
    }
    return bridge;
  }

  return {
    hasToken() {
      const bridge = globalObj?.__STATUSBAR_HOST_BRIDGE__;
      return Boolean(bridge && typeof bridge.hasToken === 'function' && bridge.hasToken());
    },

    listSessions(signal) {
      return getBridge().request('/api/sessions', {}, signal);
    },

    getSessionSnapshot(sessionId, signal) {
      return getBridge().request('/api/snapshot', { sessionId }, signal);
    },

    getQuotaSummary(signal) {
      return getBridge().request('/api/quota', {}, signal);
    },

    getSettings(signal) {
      return getBridge().request('/api/settings/get', {}, signal);
    },

    updateSettings(patch, signal) {
      return getBridge().request('/api/settings/update', patch, signal);
    },

    requestCompaction(sessionId, signal) {
      return getBridge().request('/api/compact', { sessionId }, signal);
    },
  };
}
