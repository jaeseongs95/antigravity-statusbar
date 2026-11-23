/**
 * StatusbarAddon.v1 runtime & persisted add-on registry implementing `AddonRegistryPort` (SRP / OCP).
 *
 * Exposes only a frozen, capability-free `publicApi` (`window.statusbarAddons` in Isolated World 999)
 * containing zero host handles or Sidecar credentials.
 */

export function createAddonRegistry({ api, onChange }) {
  const runtimeButtons = new Map();
  let customButtons = [];
  let disabledRuntimeAddonIds = new Set();

  function notify() {
    if (typeof onChange === 'function') {
      onChange();
    }
  }

  function register(def) {
    if (!def || typeof def !== 'object') return false;
    const id = typeof def.id === 'string' ? def.id.trim() : '';
    const label = typeof def.label === 'string' ? def.label.trim() : '';
    if (!id || !/^[A-Za-z0-9_-]{1,48}$/.test(id) || !label || typeof def.onClick !== 'function') {
      return false;
    }
    runtimeButtons.set(id, {
      id,
      label: label.slice(0, 24),
      title: typeof def.title === 'string' ? def.title : '',
      description: typeof def.description === 'string' ? def.description.slice(0, 120) : '',
      order: typeof def.order === 'number' && Number.isFinite(def.order) ? def.order : 100,
      source: typeof def.source === 'string' && def.source.trim() ? def.source.trim() : 'plugin',
      onClick: def.onClick,
    });
    notify();
    return true;
  }

  function unregister(id) {
    if (!runtimeButtons.delete(String(id || ''))) return false;
    notify();
    return true;
  }

  function removeRuntime(id) {
    return unregister(id);
  }

  function list() {
    return [
      ...customButtons.map((b) => ({
        id: b.id,
        label: b.label,
        source: b.source || 'agent',
        enabled: b.enabled !== false,
        runtime: false,
      })),
      ...Array.from(runtimeButtons.values()).map((r) => ({
        id: r.id,
        label: r.label,
        source: r.source || 'plugin',
        enabled: !disabledRuntimeAddonIds.has(r.id),
        runtime: true,
      })),
    ];
  }

  function applyPersistedSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (Array.isArray(settings.customButtons)) {
      customButtons = settings.customButtons;
    }
    if (Array.isArray(settings.disabledRuntimeAddonIds)) {
      disabledRuntimeAddonIds = new Set(settings.disabledRuntimeAddonIds);
    }
  }

  async function setEnabled(id, enabled) {
    const targetId = String(id || '').trim();
    if (!targetId) return false;
    const isRuntime = runtimeButtons.has(targetId);
    try {
      const updated = await api.post('/api/addons/toggle', {
        id: targetId,
        enabled: Boolean(enabled),
        runtime: isRuntime,
      });
      applyPersistedSettings(updated);
      notify();
      return true;
    } catch {
      return false;
    }
  }

  function getSortedPersisted() {
    return [...customButtons].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
    );
  }

  function getSortedRuntime() {
    return Array.from(runtimeButtons.values()).sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
    );
  }

  function isRuntimeDisabled(id) {
    return disabledRuntimeAddonIds.has(id);
  }

  function clear() {
    runtimeButtons.clear();
    customButtons = [];
    disabledRuntimeAddonIds.clear();
  }

  const publicApi = Object.freeze({
    version: '1.0.0',
    register,
    unregister,
    list,
    setEnabled,
  });

  return Object.freeze({
    register,
    unregister,
    removeRuntime,
    list,
    setEnabled,
    applyPersistedSettings,
    getSortedPersisted,
    getSortedRuntime,
    isRuntimeDisabled,
    clear,
    publicApi,
  });
}
