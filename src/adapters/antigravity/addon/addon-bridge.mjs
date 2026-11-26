/**
 * Add-on & well-known `host.statusbar` service item registry implementing `AddonRegistryPort` (SRP / OCP).
 *
 * - Provides the `host.statusbar` well-known service (`registerItem`, `updateItem`, `removeItem`)
 *   so other v3 plugins calling `ctx.ui.registerStatusItem(...)` render natively on this statusbar.
 * - Retains frozen, capability-free `publicApi` (`window.statusbarAddons`) and persisted Sidecar
 *   command buttons without exposing host handles or Sidecar credentials.
 */

export function createAddonRegistry({ api, onChange }) {
  const runtimeButtons = new Map();
  const delegatedItems = new Map(); // `${pluginId}:${id}` -> item
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

  function registerDelegatedItem(spec) {
    if (!spec || typeof spec !== 'object') {
      throw new Error('ERR_INVALID_STATUS_ITEM_SPEC');
    }
    const pluginId = typeof spec.pluginId === 'string' ? spec.pluginId.trim() : '';
    const id = typeof spec.id === 'string' ? spec.id.trim() : '';
    if (!pluginId || !id) {
      throw new Error('ERR_INVALID_STATUS_ITEM_ID');
    }
    const key = `${pluginId}:${id}`;
    const priorityNum = Number(spec.priority);
    delegatedItems.set(key, {
      key,
      pluginId,
      id,
      label: String(spec.label || id).slice(0, 48),
      icon: typeof spec.icon === 'string' ? spec.icon.slice(0, 8) : '',
      tooltip: typeof spec.tooltip === 'string' ? spec.tooltip.slice(0, 200) : '',
      badge: spec.badge !== undefined && spec.badge !== null ? String(spec.badge).slice(0, 16) : '',
      align: spec.align === 'left' ? 'left' : 'right',
      priority: Number.isFinite(priorityNum) ? priorityNum : 100,
      onClick: typeof spec.onClick === 'function' ? spec.onClick : null,
    });
    notify();
    return Object.freeze({
      dispose() {
        removeDelegatedItem(pluginId, id);
      },
    });
  }

  function updateDelegatedItem(pluginId, id, patch) {
    const key = `${String(pluginId || '').trim()}:${String(id || '').trim()}`;
    const existing = delegatedItems.get(key);
    if (!existing || !patch || typeof patch !== 'object') return false;
    if (patch.label !== undefined) existing.label = String(patch.label || existing.id).slice(0, 48);
    if (patch.icon !== undefined) existing.icon = typeof patch.icon === 'string' ? patch.icon.slice(0, 8) : '';
    if (patch.tooltip !== undefined) existing.tooltip = typeof patch.tooltip === 'string' ? patch.tooltip.slice(0, 200) : '';
    if (patch.badge !== undefined) {
      existing.badge = patch.badge === null ? '' : String(patch.badge).slice(0, 16);
    }
    if (patch.priority !== undefined) {
      const p = Number(patch.priority);
      if (Number.isFinite(p)) existing.priority = p;
    }
    notify();
    return true;
  }

  function removeDelegatedItem(pluginId, id) {
    const key = `${String(pluginId || '').trim()}:${String(id || '').trim()}`;
    if (!delegatedItems.delete(key)) return false;
    notify();
    return true;
  }

  function getSortedDelegatedItems() {
    const sorted = Array.from(delegatedItems.values()).sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
      return a.id.localeCompare(b.id);
    });
    return {
      left: sorted.filter((it) => it.align === 'left'),
      right: sorted.filter((it) => it.align !== 'left'),
    };
  }

  function list() {
    return [
      ...customButtons.map((b) => ({
        id: b.id,
        label: b.label,
        source: b.source || 'agent',
        enabled: b.enabled !== false,
        runtime: false,
        delegated: false,
      })),
      ...Array.from(runtimeButtons.values()).map((r) => ({
        id: r.id,
        label: r.label,
        source: r.source || 'plugin',
        enabled: !disabledRuntimeAddonIds.has(r.id),
        runtime: true,
        delegated: false,
      })),
      ...Array.from(delegatedItems.values()).map((d) => ({
        id: d.key,
        label: d.label,
        source: d.pluginId,
        enabled: true,
        runtime: true,
        delegated: true,
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
    delegatedItems.clear();
    customButtons = [];
    disabledRuntimeAddonIds.clear();
  }

  const statusbarService = Object.freeze({
    registerItem: registerDelegatedItem,
    updateItem: updateDelegatedItem,
    removeItem: removeDelegatedItem,
  });

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
    getSortedDelegatedItems,
    isRuntimeDisabled,
    statusbarService,
    clear,
    publicApi,
  });
}
