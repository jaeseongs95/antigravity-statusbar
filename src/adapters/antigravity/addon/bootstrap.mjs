/**
 * AddonManifest.v2 lifecycle bootstrap & slot/portal coordinator (SRP / DIP).
 *
 * Strictly uses `RendererHostPort` (mountSlot / unmountSlot / injectStyle / removeStyle / onDispose
 * plus optional v2 openPopover / openModal portals).
 * Never injects raw style tags directly and never exposes `addonHost` or Sidecar credentials on `window`.
 */

export function startAddonStatusbar({
  hostPort,
  api,
  i18n,
  addons,
  createBarViewFn,
  createPopoverViewFn,
  createGlobalLimitModalViewFn = null,
  createBarControllerFn,
  doc,
  win,
  cssText,
  styleId = 'statusbar-main',
  pollConfig = {},
}) {
  const NORMAL_POLL_MS = pollConfig.normalPollMs || 1000;
  const BURST_POLL_MS = pollConfig.burstPollMs || 400;
  const QUOTA_POLL_MS = pollConfig.quotaPollMs || 15000;
  const MAX_BURST_MS = pollConfig.maxBurstMs || 20000;
  const DOM_DEBOUNCE_MS = pollConfig.domDebounceMs || 150;

  let disposed = false;
  let burstUntil = 0;
  let snapshotPollTimer = null;
  let quotaPollTimer = null;
  let domActivityTimer = null;
  let observer = null;
  let currentSlotEl = null;
  let activeBoxEl = null;

  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: '',
    defaultCustomLimit: null,
    modelLimits: [],
    sessionLimits: new Map(),
    quotaState: null,
    fallbackSessionId: '',
  };

  const isV2Host = hostPort.schemaVersion === 2;
  if (isV2Host && hostPort.slotId) {
    hostPort.injectStyle(styleId, cssText || '', { slotId: hostPort.slotId });
  } else {
    hostPort.injectStyle(styleId, cssText || '');
  }

  const portalHost =
    typeof hostPort.openPopover === 'function' || typeof hostPort.openModal === 'function'
      ? Object.freeze({
          openPopover:
            typeof hostPort.openPopover === 'function'
              ? (opts) => hostPort.openPopover(opts)
              : undefined,
          openModal:
            typeof hostPort.openModal === 'function'
              ? (opts) => hostPort.openModal(opts)
              : undefined,
          syncStyle(kind) {
            const targetSlotId =
              kind === 'popover'
                ? hostPort.popoverSlotId
                : kind === 'modal'
                  ? hostPort.modalSlotId
                  : hostPort.slotId;
            if (targetSlotId) {
              hostPort.injectStyle(`${styleId}:${kind}`, cssText || '', {
                slotId: targetSlotId,
              });
            }
          },
        })
      : null;

  const barView = createBarViewFn({ doc, i18n });
  const popoverView = createPopoverViewFn({ doc, i18n });
  const globalModalView =
    typeof createGlobalLimitModalViewFn === 'function'
      ? createGlobalLimitModalViewFn({ doc, i18n })
      : null;

  function applySettingsPayload(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (settings.locale === 'ko' || settings.locale === 'en') {
      i18n.setLocale(settings.locale);
    }
    if (typeof settings.autoCompact === 'boolean') {
      sharedState.autoCompactEnabled = settings.autoCompact;
    }
    if (typeof settings.compactPrompt === 'string') {
      sharedState.compactPrompt = settings.compactPrompt;
    }
    if (settings.defaultCustomLimit === null || typeof settings.defaultCustomLimit === 'number') {
      sharedState.defaultCustomLimit = settings.defaultCustomLimit;
    }
    if (Array.isArray(settings.modelLimits)) {
      sharedState.modelLimits = settings.modelLimits.filter(
        (m) => m && typeof m.model === 'string' && typeof m.limit === 'number',
      );
    }
    if (Array.isArray(settings.sessions)) {
      sharedState.sessionLimits.clear();
      for (const entry of settings.sessions) {
        if (entry && typeof entry.sessionId === 'string' && typeof entry.limit === 'number') {
          sharedState.sessionLimits.set(entry.sessionId, entry.limit);
        }
      }
    }
    addons.applyPersistedSettings(settings);
  }

  function scheduleSnapshotPoll() {
    if (snapshotPollTimer) clearTimeout(snapshotPollTimer);
    if (disposed) return;
    const delay = Date.now() < burstUntil ? BURST_POLL_MS : NORMAL_POLL_MS;
    snapshotPollTimer = setTimeout(async () => {
      await pollSessionsAndSnapshots();
      scheduleSnapshotPoll();
    }, delay);
  }

  const controller = createBarControllerFn({
    doc,
    win,
    api,
    i18n,
    addons,
    barView,
    popoverView,
    globalModalView,
    portalHost,
    sharedState,
    onSettingsChanged(updated) {
      applySettingsPayload(updated);
      controller.render();
    },
    onBurstRequested() {
      burstUntil = Date.now() + MAX_BURST_MS;
      scheduleSnapshotPoll();
    },
  });

  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.getClientRects === 'function') {
      const rects = el.getClientRects();
      if (rects && rects.length > 0) return true;
    }
    return el.offsetParent !== null;
  }

  function findActiveInputBox() {
    const boxes = Array.from(doc.querySelectorAll('[data-testid="agent-input-box"]'));
    if (boxes.length === 0) return null;

    const focused = doc.activeElement;
    if (focused && focused.nodeType === 1) {
      const focusedBox =
        typeof focused.closest === 'function'
          ? focused.closest('[data-testid="agent-input-box"]')
          : null;
      if (focusedBox && boxes.includes(focusedBox)) return focusedBox;

      const focusedView =
        typeof focused.closest === 'function'
          ? focused.closest('[data-testid="conversation-view"]')
          : null;
      if (focusedView) {
        const boxInView = focusedView.querySelector('[data-testid="agent-input-box"]');
        if (boxInView && boxes.includes(boxInView)) return boxInView;
      }
    }

    if (activeBoxEl && doc.contains(activeBoxEl) && boxes.includes(activeBoxEl)) {
      if (isElementVisible(activeBoxEl)) return activeBoxEl;
    }

    const visibleBoxes = boxes.filter(isElementVisible);
    if (visibleBoxes.length > 0) {
      return visibleBoxes[visibleBoxes.length - 1];
    }
    return boxes[boxes.length - 1];
  }

  function mountToActiveBox() {
    if (disposed) return false;
    const boxEl = findActiveInputBox();
    if (!boxEl) return false;

    activeBoxEl = boxEl;
    const slotEl = hostPort.mountSlot(boxEl);
    if (!slotEl) return false;
    currentSlotEl = slotEl;
    if (controller.rootEl.parentNode !== slotEl) {
      slotEl.appendChild(controller.rootEl);
    }
    const viewEl =
      typeof boxEl.closest === 'function'
        ? boxEl.closest('[data-testid="conversation-view"]') || boxEl
        : boxEl;
    controller.setTargetView(viewEl);
    return true;
  }

  function triggerImmediateActivityRefresh() {
    if (disposed) return;
    burstUntil = Math.max(burstUntil, Date.now() + 8000);
    if (domActivityTimer) return;
    domActivityTimer = setTimeout(() => {
      domActivityTimer = null;
      if (disposed) return;
      mountToActiveBox();
      controller.refreshSnapshot();
    }, DOM_DEBOUNCE_MS);
  }

  async function pollSessionsAndSnapshots() {
    if (disposed) return;
    mountToActiveBox();
    const snapshotPromise = controller.refreshSnapshot();
    const sessionsPromise = api
      .post('/api/sessions', {})
      .then((sessRes) => {
        if (Array.isArray(sessRes?.sessions) && sessRes.sessions.length > 0) {
          const topSid = sessRes.sessions[0].sessionId || '';
          if (topSid && topSid !== sharedState.fallbackSessionId) {
            sharedState.fallbackSessionId = topSid;
            controller.refreshSnapshot();
          }
        }
      })
      .catch(() => {});
    await Promise.all([snapshotPromise, sessionsPromise]);
  }

  async function pollQuotaAndSettings() {
    if (disposed) return;
    try {
      const settings = await api.post('/api/settings/get', {});
      applySettingsPayload(settings);
      controller.render();
    } catch {}
    try {
      sharedState.quotaState = await api.post('/api/quota', {});
      controller.render();
    } catch {}
  }

  function isOwnNode(node) {
    let cur = node && node.nodeType === 3 ? node.parentElement : node;
    while (cur && cur.nodeType === 1) {
      if (
        cur === currentSlotEl ||
        cur === controller.rootEl ||
        (cur.getAttribute && cur.getAttribute('data-addon-host-owner') === hostPort.pluginId)
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function isOwnMutation(m) {
    if (isOwnNode(m.target)) return true;
    if (m.type === 'childList') {
      const added = m.addedNodes ? Array.from(m.addedNodes) : [];
      const removed = m.removedNodes ? Array.from(m.removedNodes) : [];
      const changed = added.concat(removed);
      if (changed.length > 0 && changed.every((n) => isOwnNode(n))) {
        return true;
      }
    }
    return false;
  }

  const onFocusIn = () => {
    if (disposed) return;
    mountToActiveBox();
  };
  doc.addEventListener('focusin', onFocusIn);

  if (typeof MutationObserver !== 'undefined' && doc.body) {
    observer = new MutationObserver((mutations) => {
      if (disposed) return;
      let sawCascadeAttr = false;
      let sawExternalChange = false;
      for (const m of mutations) {
        if (isOwnMutation(m)) continue;
        sawExternalChange = true;
        if (m.type === 'attributes' && m.attributeName === 'data-cascade-id') {
          sawCascadeAttr = true;
        }
      }
      if (sawCascadeAttr) {
        mountToActiveBox();
        controller.refreshSnapshot();
      } else if (sawExternalChange) {
        mountToActiveBox();
        triggerImmediateActivityRefresh();
      }
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cascade-id'],
    });
  }

  // Expose ONLY the frozen, credential-free StatusbarAddon.v1 registry in Isolated World 998
  // P1: Define non-writable so peer scripts cannot overwrite `window.statusbarAddons`
  if (win && typeof win === 'object') {
    try {
      Object.defineProperty(win, 'statusbarAddons', {
        value: addons.publicApi,
        writable: false,
        enumerable: true,
        configurable: true,
      });
    } catch {
      try {
        win.statusbarAddons = addons.publicApi;
      } catch {}
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (snapshotPollTimer) clearTimeout(snapshotPollTimer);
    if (domActivityTimer) clearTimeout(domActivityTimer);
    if (quotaPollTimer) clearInterval(quotaPollTimer);
    if (observer) observer.disconnect();
    doc.removeEventListener('focusin', onFocusIn);
    api.abortAll();
    controller.destroy();
    addons.clear();
    if (win && typeof win === 'object') {
      try {
        if (win.statusbarAddons === addons.publicApi) {
          delete win.statusbarAddons;
        }
      } catch {}
    }
    try {
      hostPort.unmountSlot();
    } catch {}
    try {
      hostPort.removeStyle(styleId);
    } catch {}
    try {
      hostPort.removeStyle(`${styleId}:popover`);
    } catch {}
    try {
      hostPort.removeStyle(`${styleId}:modal`);
    } catch {}
  }

  hostPort.onDispose(dispose);

  mountToActiveBox();
  pollQuotaAndSettings();
  pollSessionsAndSnapshots();
  scheduleSnapshotPoll();
  quotaPollTimer = setInterval(pollQuotaAndSettings, QUOTA_POLL_MS);

  return Object.freeze({
    render: controller.render,
    mountToActiveBox,
    dispose,
  });
}

/**
 * Credential-free standby renderer shown when the Sidecar has not yet published
 * its runtime credentials before `dom-ready`/`did-finish-load` or after shutdown.
 */
export function startStandbyStatusbar({
  hostPort,
  i18n,
  doc,
  win,
  cssText,
  styleId = 'statusbar-main',
}) {
  let disposed = false;
  let observer = null;
  let currentSlotEl = null;

  if (hostPort.schemaVersion === 2 && hostPort.slotId) {
    hostPort.injectStyle(styleId, cssText || '', { slotId: hostPort.slotId });
  } else {
    hostPort.injectStyle(styleId, cssText || '');
  }

  const barEl = doc.createElement('div');
  barEl.className = 'agy-inline-statusbar';
  barEl.setAttribute('role', 'region');
  barEl.setAttribute('aria-label', 'Statusbar Standby');

  const leftEl = doc.createElement('div');
  leftEl.className = 'agy-inline-left';
  const msgEl = doc.createElement('span');
  msgEl.className = 'agy-inline-metric';
  msgEl.textContent = i18n.t().standby;
  leftEl.appendChild(msgEl);

  const rightEl = doc.createElement('div');
  rightEl.className = 'agy-inline-right';
  const reloadBtn = doc.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'agy-inline-btn';
  reloadBtn.textContent = i18n.t().reloadNow;
  reloadBtn.addEventListener('click', () => {
    try {
      if (win && win.location && typeof win.location.reload === 'function') {
        win.location.reload();
      }
    } catch {}
  });
  rightEl.appendChild(reloadBtn);

  barEl.appendChild(leftEl);
  barEl.appendChild(rightEl);

  function mountIfFound() {
    if (disposed) return false;
    const boxes = Array.from(doc.querySelectorAll('[data-testid="agent-input-box"]'));
    if (boxes.length === 0) return false;
    const boxEl = boxes[boxes.length - 1];
    const slotEl = hostPort.mountSlot(boxEl);
    if (!slotEl) return false;
    currentSlotEl = slotEl;
    if (barEl.parentNode !== slotEl) {
      slotEl.appendChild(barEl);
    }
    return true;
  }

  if (typeof MutationObserver !== 'undefined' && doc.body) {
    observer = new MutationObserver(() => {
      if (disposed) return;
      const connected = Boolean(
        currentSlotEl &&
          (currentSlotEl.isConnected !== undefined
            ? currentSlotEl.isConnected
            : doc.contains(currentSlotEl)),
      );
      if (!connected) {
        mountIfFound();
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (observer) observer.disconnect();
    try {
      barEl.remove();
    } catch {}
    try {
      hostPort.unmountSlot();
    } catch {}
    try {
      hostPort.removeStyle(styleId);
    } catch {}
  }

  hostPort.onDispose(dispose);
  mountIfFound();

  return Object.freeze({
    mountIfFound,
    dispose,
  });
}
