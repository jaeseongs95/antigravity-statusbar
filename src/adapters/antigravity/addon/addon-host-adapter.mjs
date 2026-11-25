/**
 * Adapter translating the Antigravity native-addon-host scoped capability handle (`addonHost`)
 * into the segregated `RendererHostPort` abstraction (DIP / LSP).
 *
 * Supports AddonManifest.v2 (v2.3.0+ Shadow DOM slots, `{ container }` mount options,
 * ShadowRoot-routed `injectStyle(..., { slotId })`, `hostProfileId` forwarding, and host
 * `openModal`/`openPopover` portals) while retaining backward-compatible behavior for v1 test doubles / hosts.
 *
 * Security & Isolation Invariants:
 * - Never exposes `addonHost` on `window` or DOM.
 * - Never creates style tags or appends directly to host containers;
 *   all DOM slots, styles, portals, and lifecycle cleanup delegate exclusively to `addonHost`.
 */

export function createAddonHostAdapter(addonHost, slotSpec = 'antigravity-statusbar.root') {
  if (
    !addonHost ||
    typeof addonHost !== 'object' ||
    typeof addonHost.mountSlot !== 'function' ||
    typeof addonHost.unmountSlot !== 'function' ||
    typeof addonHost.injectStyle !== 'function' ||
    typeof addonHost.removeStyle !== 'function' ||
    typeof addonHost.onDispose !== 'function'
  ) {
    throw new Error('ERR_MISSING_ADDON_HOST_CAPABILITY_HANDLE');
  }

  let rootSlotId = '';
  let popoverSlotId = 'antigravity-statusbar.popover';
  let modalSlotId = 'antigravity-statusbar.global-limit-modal';

  if (typeof slotSpec === 'string') {
    rootSlotId = slotSpec.trim();
  } else if (slotSpec && typeof slotSpec === 'object') {
    rootSlotId = typeof slotSpec.root === 'string' ? slotSpec.root.trim() : '';
    if (typeof slotSpec.popover === 'string' && slotSpec.popover.trim()) {
      popoverSlotId = slotSpec.popover.trim();
    }
    if (typeof slotSpec.modal === 'string' && slotSpec.modal.trim()) {
      modalSlotId = slotSpec.modal.trim();
    }
  }

  if (!rootSlotId) {
    throw new Error('ERR_INVALID_SLOT_ID');
  }

  const isV2Host =
    addonHost.schemaVersion === 2 ||
    typeof addonHost.openModal === 'function' ||
    typeof addonHost.openPopover === 'function';

  const hostProfileId =
    typeof addonHost.hostProfileId === 'string' && addonHost.hostProfileId.trim()
      ? addonHost.hostProfileId.trim()
      : null;

  let lastMountTarget = undefined;

  const adapter = {
    pluginId: typeof addonHost.pluginId === 'string' ? addonHost.pluginId : 'antigravity-statusbar',
    schemaVersion: isV2Host ? 2 : 1,
    hostProfileId,
    slotId: rootSlotId,
    popoverSlotId,
    modalSlotId,
    mountSlot(parentEl) {
      if (isV2Host) {
        const nextTarget = parentEl || null;
        if (lastMountTarget !== undefined && lastMountTarget !== nextTarget) {
          try {
            addonHost.unmountSlot(rootSlotId);
          } catch {}
          lastMountTarget = undefined;
        }
        const mounted = addonHost.mountSlot(
          rootSlotId,
          nextTarget ? { container: nextTarget } : {},
        );
        lastMountTarget = mounted ? nextTarget : undefined;
        return mounted;
      }
      const mounted = addonHost.mountSlot(rootSlotId, parentEl);
      lastMountTarget = mounted ? parentEl || null : undefined;
      return mounted;
    },
    unmountSlot() {
      lastMountTarget = undefined;
      return addonHost.unmountSlot(rootSlotId);
    },
    injectStyle(styleId, cssText, opts) {
      if (opts !== undefined) {
        return addonHost.injectStyle(styleId, cssText, opts);
      }
      return addonHost.injectStyle(styleId, cssText);
    },
    removeStyle(styleId) {
      return addonHost.removeStyle(styleId);
    },
    onDispose(fn) {
      if (typeof fn === 'function') {
        addonHost.onDispose(fn);
      }
    },
  };

  if (typeof addonHost.openPopover === 'function') {
    adapter.openPopover = (opts = {}) => addonHost.openPopover(popoverSlotId, opts);
  }
  if (typeof addonHost.openModal === 'function') {
    adapter.openModal = (opts = {}) => addonHost.openModal(modalSlotId, opts);
  }
  if (typeof addonHost.getSettings === 'function') {
    adapter.getSettings = () => addonHost.getSettings();
  }
  if (typeof addonHost.onSettingsChange === 'function') {
    adapter.onSettingsChange = (cb) => addonHost.onSettingsChange(cb);
  }
  if (typeof addonHost.saveSettings === 'function') {
    adapter.saveSettings = (nextData) => addonHost.saveSettings(nextData);
  }

  return Object.freeze(adapter);
}
