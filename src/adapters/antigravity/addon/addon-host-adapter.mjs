/**
 * Adapter translating the Antigravity `AddonContextV3` capability handle (`addonHost`)
 * into the segregated `RendererHostPort` abstraction (DIP / LSP).
 *
 * AddonManifest.v3 / AddonContextV3 API-First Contract:
 * - Branches strictly on `ctx.env.surface`, `ctx.env.layoutMode`, and `ctx.env.capabilities`
 *   (NEVER inspects raw `hostProfileId`).
 * - Mounts the Tier-3 inline statusbar canvas via `ctx.ui.mountCanvas(slotId, opts)` and
 *   unmounts via `ctx.dom.unmountSlot(slotId)`.
 * - Delegates all popups, modals, settings pages, commands, toasts, storage, services,
 *   networking (`ctx.net.fetch`), theme tokens, and AbortSignal lifecycle directly to `ctx`.
 * - Never exposes `addonHost` on `window` or DOM and never creates raw `<style>` tags.
 */

export function createAddonHostAdapter(addonHost, slotSpec = 'antigravity-statusbar.root') {
  if (!addonHost || typeof addonHost !== 'object') {
    throw new Error('ERR_MISSING_ADDON_HOST_CAPABILITY_HANDLE');
  }

  let rootSlotId = '';
  if (typeof slotSpec === 'string') {
    rootSlotId = slotSpec.trim();
  } else if (slotSpec && typeof slotSpec === 'object') {
    rootSlotId = typeof slotSpec.root === 'string' ? slotSpec.root.trim() : '';
  }

  if (!rootSlotId) {
    throw new Error('ERR_INVALID_SLOT_ID');
  }

  const isV3Context =
    addonHost.apiVersion === 3 &&
    Boolean(addonHost.ui && typeof addonHost.ui === 'object') &&
    Boolean(addonHost.lifecycle && typeof addonHost.lifecycle === 'object');

  if (!isV3Context) {
    throw new Error('ERR_UNSUPPORTED_ADDON_HOST_VERSION:expected_v3');
  }

  if (
    typeof addonHost.ui.mountCanvas !== 'function' ||
    typeof addonHost.ui.injectStyle !== 'function' ||
    typeof addonHost.ui.removeStyle !== 'function' ||
    typeof addonHost.lifecycle.onDispose !== 'function'
  ) {
    throw new Error('ERR_MISSING_ADDON_HOST_CAPABILITY_HANDLE');
  }

  const envObj = addonHost.env && typeof addonHost.env === 'object' ? addonHost.env : {};
  const surface = envObj.surface === 'remote-web' ? 'remote-web' : 'desktop';
  const capabilities = Object.freeze({
    hasLocalLoopback: Boolean(envObj.capabilities?.hasLocalLoopback),
    hasNetHttps: Boolean(envObj.capabilities?.hasNetHttps),
    hasConfigBridge: Boolean(envObj.capabilities?.hasConfigBridge),
    hasSettingsBridge: Boolean(envObj.capabilities?.hasSettingsBridge),
    hasDocumentTransform: Boolean(envObj.capabilities?.hasDocumentTransform),
  });

  let lastMountTarget = undefined;

  const unmountRoot = () => {
    lastMountTarget = undefined;
    if (addonHost.dom && typeof addonHost.dom.unmountSlot === 'function') {
      return addonHost.dom.unmountSlot(rootSlotId);
    }
    return false;
  };

  const adapter = {
    pluginId:
      typeof addonHost.meta?.pluginId === 'string' && addonHost.meta.pluginId.trim()
        ? addonHost.meta.pluginId.trim()
        : 'antigravity-statusbar',
    apiVersion: 3,
    schemaVersion: 3,
    surface,
    get layoutMode() {
      return addonHost.env?.layoutMode || 'desktop';
    },
    capabilities,
    slotId: rootSlotId,
    theme: addonHost.theme && typeof addonHost.theme === 'object' ? addonHost.theme : null,
    hostI18n: addonHost.i18n && typeof addonHost.i18n === 'object' ? addonHost.i18n : null,
    storage: addonHost.storage && typeof addonHost.storage === 'object' ? addonHost.storage : null,
    services: addonHost.services && typeof addonHost.services === 'object' ? addonHost.services : null,
    events: addonHost.events && typeof addonHost.events === 'object' ? addonHost.events : null,
    lifecycleSignal: addonHost.lifecycle.signal || null,
    mountSlot(parentEl) {
      const nextTarget = parentEl || null;
      if (lastMountTarget !== undefined && lastMountTarget !== nextTarget) {
        try {
          unmountRoot();
        } catch {}
      }
      const mounted = addonHost.ui.mountCanvas(
        rootSlotId,
        nextTarget
          ? { container: nextTarget }
          : surface === 'remote-web'
            ? { fallbackToBody: true }
            : {},
      );
      lastMountTarget = mounted ? nextTarget : undefined;
      return mounted;
    },
    unmountSlot: unmountRoot,
    injectStyle(styleId, cssText, opts) {
      if (opts !== undefined) {
        return addonHost.ui.injectStyle(styleId, cssText, opts);
      }
      return addonHost.ui.injectStyle(styleId, cssText);
    },
    removeStyle(styleId) {
      return addonHost.ui.removeStyle(styleId);
    },
    onDispose(fn) {
      if (typeof fn === 'function') {
        addonHost.lifecycle.onDispose(fn);
      }
    },
  };

  if (typeof addonHost.lifecycle.addManagedListener === 'function') {
    adapter.addManagedListener = (target, type, listener, opts) =>
      addonHost.lifecycle.addManagedListener(target, type, listener, opts);
  }
  if (typeof addonHost.ui.showToast === 'function') {
    adapter.showToast = (opts) => addonHost.ui.showToast(opts);
  }
  if (typeof addonHost.ui.openPopup === 'function') {
    adapter.openPopup = (opts) => addonHost.ui.openPopup(opts);
  }
  if (typeof addonHost.ui.openModal === 'function') {
    adapter.openModal = (opts) => addonHost.ui.openModal(opts);
  }
  if (typeof addonHost.ui.openPanel === 'function') {
    adapter.openPanel = (opts) => addonHost.ui.openPanel(opts);
  }
  if (typeof addonHost.ui.registerCommand === 'function') {
    adapter.registerCommand = (commandId, spec) => addonHost.ui.registerCommand(commandId, spec);
  }
  if (typeof addonHost.ui.registerSettingsPage === 'function') {
    adapter.registerSettingsPage = (spec) => addonHost.ui.registerSettingsPage(spec);
  }
  if (addonHost.net && typeof addonHost.net.fetch === 'function') {
    adapter.netFetch = (url, init) => addonHost.net.fetch(url, init);
  }

  // Forward antigravity-addons v3.0.3+ settingsBridge namespace (trusted plugins declaring settingsBridge)
  const sb = addonHost.settingsBridge;
  if (sb && typeof sb === 'object') {
    const getFn = typeof sb.getSnapshot === 'function' ? sb.getSnapshot : sb.getSettings;
    const subFn = typeof sb.onDidChange === 'function' ? sb.onDidChange : sb.onSettingsChange;
    const saveFn = typeof sb.save === 'function' ? sb.save : sb.saveSettings;
    if (typeof getFn === 'function') adapter.getSettings = () => getFn.call(sb);
    if (typeof subFn === 'function') adapter.onSettingsChange = (cb) => subFn.call(sb, cb);
    if (typeof saveFn === 'function') adapter.saveSettings = (data) => saveFn.call(sb, data);
  }

  return Object.freeze(adapter);
}
