/**
 * Adapter translating the Antigravity native-addon-host scoped capability handle (`addonHost`)
 * into the segregated `RendererHostPort` abstraction (DIP / LSP).
 *
 * Security & Isolation Invariants:
 * - Never exposes `addonHost` on `window` or DOM.
 * - Never creates `<style>` tags or appends directly to `document.head` / host containers;
 *   all DOM slots, styles, and lifecycle cleanup delegate exclusively to `addonHost`.
 */

export function createAddonHostAdapter(addonHost, slotId = 'antigravity-statusbar.root') {
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
  if (typeof slotId !== 'string' || !slotId.trim()) {
    throw new Error('ERR_INVALID_SLOT_ID');
  }

  const ownedSlotId = slotId.trim();

  return Object.freeze({
    pluginId: typeof addonHost.pluginId === 'string' ? addonHost.pluginId : 'antigravity-statusbar',
    slotId: ownedSlotId,
    mountSlot(parentEl) {
      return addonHost.mountSlot(ownedSlotId, parentEl);
    },
    unmountSlot() {
      return addonHost.unmountSlot(ownedSlotId);
    },
    injectStyle(styleId, cssText) {
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
  });
}
