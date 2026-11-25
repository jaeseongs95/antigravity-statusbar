/**
 * AddonManifest.v2 lifecycle bootstrap & slot/portal coordinator (SRP / DIP).
 *
 * Strictly uses `RendererHostPort` (mountSlot / unmountSlot / injectStyle / removeStyle / onDispose
 * plus optional v2 openPopover / openModal portals and trusted settingsBridge methods).
 * Never injects raw style tags directly and never exposes `addonHost` or Sidecar credentials on `window`.
 *
 * Supports both `antigravity-desktop` (live Sidecar credentials delivered via host `settingsBridge`
 * while keeping `runtime/statusbar-renderer.js` 100% static & immutable) and `antigravity-remote-web`
 * (browser-local connection settings persisted via `addonHost.saveSettings`, ignoring `packed-initial`
 * snapshots, with automatic fallback to the host `status-bar` anchor / dock when `agent-input-box` is absent).
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
  hasStaticInitialConnection = false,
}) {
  const isRemoteWeb = Boolean(hostPort && hostPort.hostProfileId === 'antigravity-remote-web');
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
  let unsubscribeSettings = null;
  let currentSlotEl = null;
  let activeBoxEl = null;
  let preferredBoxEl = null;

  const CONVERSATION_VIEW_TESTIDS = new Set([
    'conversation-view',
    'subagent-tab-conversation',
    'side-question-tab-conversation',
  ]);

  const sharedState = {
    autoCompactEnabled: true,
    compactPrompt: '',
    defaultCustomLimit: null,
    modelLimits: [],
    sessionLimits: new Map(),
    quotaState: null,
    fallbackSessionId: '',
  };

  function isApiConfigured() {
    return typeof api.isConfigured === 'function' ? Boolean(api.isConfigured()) : true;
  }

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
  const popoverView = createPopoverViewFn({ doc, i18n, isRemoteWeb });
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

  async function handleRemoteConnectionSave({ baseUrl, token }) {
    if (!isRemoteWeb || typeof api.configure !== 'function') {
      return { ok: false, code: 'ERR_REMOTE_UNAVAILABLE' };
    }
    const cleanToken = typeof token === 'string' ? token.trim() : '';
    try {
      api.configure({ baseUrl, token: cleanToken });
    } catch (err) {
      const msg = err?.message || '';
      if (msg === 'ERR_INVALID_ENDPOINT_URL' || msg === 'ERR_INVALID_LOOPBACK_BASE_URL') {
        return { ok: false, code: 'ERR_INVALID_ENDPOINT_URL' };
      }
      if (msg === 'ERR_INVALID_SIDECAR_TOKEN') {
        return { ok: false, code: 'ERR_INVALID_SIDECAR_TOKEN' };
      }
      return { ok: false, code: 'ERR_INVALID_ENDPOINT_URL', message: msg };
    }

    const normalizedUrl = typeof api.getBaseUrl === 'function' ? api.getBaseUrl() : baseUrl;
    if (typeof hostPort.saveSettings === 'function') {
      try {
        const saveRes = await hostPort.saveSettings({
          remoteBaseUrl: normalizedUrl,
          remoteToken: cleanToken,
          locale: i18n.getLocale(),
        });
        if (saveRes && saveRes.ok === false) {
          if (typeof api.clearConnection === 'function') api.clearConnection();
          return {
            ok: false,
            code: 'ERR_SAVE_SETTINGS_FAILED',
            reason: saveRes.reason || 'ERR_SETTINGS_SAVE_FAILED',
          };
        }
      } catch (saveErr) {
        if (typeof api.clearConnection === 'function') api.clearConnection();
        return {
          ok: false,
          code: 'ERR_SAVE_SETTINGS_FAILED',
          reason: saveErr?.message || 'ERR_SETTINGS_SAVE_FAILED',
        };
      }
    }

    try {
      const settings = await api.post('/api/settings/get', {});
      applySettingsPayload(settings);
      pollQuotaAndSettings();
      pollSessionsAndSnapshots();
      return { ok: true, baseUrl: normalizedUrl };
    } catch (connErr) {
      return {
        ok: false,
        status: connErr?.status,
        code: connErr?.code || 'ERR_UNREACHABLE',
        message: connErr?.message || 'Unable to reach Sidecar',
      };
    }
  }

  async function handleRemoteConnectionClear() {
    if (typeof api.clearConnection === 'function') {
      api.clearConnection();
    }
    if (isRemoteWeb && typeof hostPort.saveSettings === 'function') {
      try {
        await hostPort.saveSettings({
          remoteBaseUrl: '',
          remoteToken: '',
          locale: i18n.getLocale(),
        });
      } catch {}
    }
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
    isRemoteWeb,
    onSettingsChanged(updated) {
      applySettingsPayload(updated);
      controller.render();
    },
    onBurstRequested() {
      burstUntil = Date.now() + MAX_BURST_MS;
      scheduleSnapshotPoll();
    },
    onRemoteConnectionSave: isRemoteWeb ? handleRemoteConnectionSave : null,
    onRemoteConnectionClear: isRemoteWeb ? handleRemoteConnectionClear : null,
  });

  function applyHostSettingsBridgeSnapshot(snap, { triggerPoll = true } = {}) {
    if (disposed) return;
    if (!snap || typeof snap !== 'object') return;
    const data = snap.data && typeof snap.data === 'object' ? snap.data : null;

    if (isRemoteWeb) {
      // Defense-in-depth: never accept Desktop credentials accidentally packed via --include-settings-snapshots
      if (snap.persistence === 'packed-initial') {
        return;
      }
      if (snap.status !== 'ok' || !data) {
        return;
      }
      if (data.locale === 'ko' || data.locale === 'en') {
        i18n.setLocale(data.locale);
      }
      const nextUrl = typeof data.remoteBaseUrl === 'string' ? data.remoteBaseUrl.trim() : '';
      const nextToken = typeof data.remoteToken === 'string' ? data.remoteToken.trim() : '';
      if (nextUrl && nextToken.length >= 16 && typeof api.configure === 'function') {
        try {
          const changed = api.configure({ baseUrl: nextUrl, token: nextToken });
          if (changed && triggerPoll) {
            pollQuotaAndSettings();
            pollSessionsAndSnapshots();
          }
        } catch {}
      } else if (typeof api.clearConnection === 'function') {
        const cleared = api.clearConnection();
        if (cleared && typeof controller.resetConnectionState === 'function') {
          controller.resetConnectionState();
        }
      }
      controller.render();
      return;
    }

    // Desktop profile: consume live Sidecar connection published by Sidecar into HOST_DATA_DIR
    if (snap.status === 'ok' && data) {
      if (
        data.mode === 'active' &&
        typeof data.baseUrl === 'string' &&
        typeof data.token === 'string' &&
        typeof api.configure === 'function'
      ) {
        try {
          const changed = api.configure({ baseUrl: data.baseUrl, token: data.token });
          if (changed && triggerPoll) {
            pollQuotaAndSettings();
            pollSessionsAndSnapshots();
          }
        } catch {}
      } else if (data.mode === 'standby' && !hasStaticInitialConnection) {
        if (typeof api.clearConnection === 'function') {
          const cleared = api.clearConnection();
          if (cleared && typeof controller.resetConnectionState === 'function') {
            controller.resetConnectionState();
          }
        }
      }
      controller.render();
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.getClientRects === 'function') {
      const rects = el.getClientRects();
      if (rects && rects.length > 0) return true;
    }
    return el.offsetParent !== null;
  }

  function readCascadeId(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    const raw = String(el.getAttribute('data-cascade-id') || '').trim();
    return raw && raw !== 'remote-session' ? raw : '';
  }

  function isConversationViewEl(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    return CONVERSATION_VIEW_TESTIDS.has(el.getAttribute('data-testid'));
  }

  function findClosestCascadeCarrier(startEl) {
    let cur = startEl && startEl.nodeType === 3 ? startEl.parentElement : startEl;
    while (cur && cur.nodeType === 1) {
      if (readCascadeId(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function findClosestConversationView(startEl) {
    let cur = startEl && startEl.nodeType === 3 ? startEl.parentElement : startEl;
    while (cur && cur.nodeType === 1) {
      if (isConversationViewEl(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function findSingleDescendantViewOrCarrier(rootEl) {
    if (!rootEl || !rootEl.childNodes) return null;
    let firstCarrier = null;
    let matchedCascadeId = '';
    let ambiguousCarrier = false;
    let matchedView = null;
    let viewCount = 0;

    function walk(node) {
      if (!node || !node.childNodes) return;
      for (let i = 0; i < node.childNodes.length; i += 1) {
        const ch = node.childNodes[i];
        if (!ch || ch.nodeType !== 1 || isOwnNode(ch)) continue;
        const cid = readCascadeId(ch);
        if (cid) {
          if (!firstCarrier) {
            firstCarrier = ch;
            matchedCascadeId = cid;
          } else if (cid !== matchedCascadeId) {
            ambiguousCarrier = true;
          }
        }
        if (isConversationViewEl(ch)) {
          if (!matchedView) matchedView = ch;
          viewCount += 1;
        }
        walk(ch);
      }
    }

    walk(rootEl);
    if (ambiguousCarrier) return null;
    if (firstCarrier) return firstCarrier;
    if (viewCount === 1 && matchedView) return matchedView;
    return null;
  }

  function resolveConversationView(boxEl) {
    if (!boxEl) return null;
    const carrier = findClosestCascadeCarrier(boxEl);
    if (carrier) return carrier;
    const viewEl = findClosestConversationView(boxEl);
    if (viewEl) return viewEl;

    // Sibling / wrapper pane layout: walk upward only while within a single input-box pane
    let cur = boxEl.parentElement;
    while (cur && cur.nodeType === 1 && cur !== doc.body) {
      const paneBoxes =
        typeof cur.querySelectorAll === 'function'
          ? Array.from(cur.querySelectorAll('[data-testid="agent-input-box"]'))
          : [];
      const visiblePaneBoxes = paneBoxes.filter(isElementVisible);
      const effectiveCount =
        visiblePaneBoxes.length > 0 ? visiblePaneBoxes.length : paneBoxes.length;
      if (effectiveCount > 1) break;
      const candidate = findSingleDescendantViewOrCarrier(cur);
      if (candidate) return candidate;
      cur = cur.parentElement;
    }
    return boxEl;
  }

  function findBoxForView(viewEl, boxes) {
    if (!viewEl || !Array.isArray(boxes) || boxes.length === 0) return null;
    const directMatches = boxes.filter((b) => resolveConversationView(b) === viewEl);
    if (directMatches.length > 0) {
      const vis = directMatches.filter(isElementVisible);
      return vis.length > 0 ? vis[vis.length - 1] : directMatches[0];
    }
    if (typeof viewEl.querySelector === 'function') {
      const boxInView = viewEl.querySelector('[data-testid="agent-input-box"]');
      if (boxInView && boxes.includes(boxInView)) return boxInView;
    }
    return null;
  }

  function findActiveInputBox() {
    const boxes = Array.from(doc.querySelectorAll('[data-testid="agent-input-box"]'));
    if (boxes.length === 0) return null;

    if (preferredBoxEl) {
      if (doc.contains(preferredBoxEl) && boxes.includes(preferredBoxEl) && isElementVisible(preferredBoxEl)) {
        return preferredBoxEl;
      }
      preferredBoxEl = null;
    }

    const focused = doc.activeElement;
    if (focused && focused.nodeType === 1) {
      const focusedBox =
        typeof focused.closest === 'function'
          ? focused.closest('[data-testid="agent-input-box"]')
          : null;
      if (focusedBox && boxes.includes(focusedBox)) return focusedBox;

      const focusedView =
        findClosestConversationView(focused) || findClosestCascadeCarrier(focused);
      if (focusedView) {
        const boxInView = findBoxForView(focusedView, boxes);
        if (boxInView) return boxInView;
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
    if (!boxEl) {
      if (!isRemoteWeb) return false;
      activeBoxEl = null;
      const anchorSlotEl = hostPort.mountSlot(null);
      if (!anchorSlotEl) return false;
      currentSlotEl = anchorSlotEl;
      if (typeof barView.setRemoteDockMode === 'function') {
        barView.setRemoteDockMode(true);
      }
      if (controller.rootEl.parentNode !== anchorSlotEl) {
        anchorSlotEl.appendChild(controller.rootEl);
      }
      controller.setTargetView(null);
      return true;
    }

    activeBoxEl = boxEl;
    const slotEl = hostPort.mountSlot(boxEl);
    if (!slotEl) return false;
    currentSlotEl = slotEl;
    if (typeof barView.setRemoteDockMode === 'function') {
      barView.setRemoteDockMode(false);
    }
    if (controller.rootEl.parentNode !== slotEl) {
      slotEl.appendChild(controller.rootEl);
    }
    const viewEl = resolveConversationView(boxEl) || boxEl;
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
      if (isApiConfigured()) {
        controller.refreshSnapshot();
      }
    }, DOM_DEBOUNCE_MS);
  }

  async function pollSessionsAndSnapshots() {
    if (disposed) return;
    mountToActiveBox();
    if (!isApiConfigured()) {
      controller.render();
      return;
    }
    const snapshotPromise = controller.refreshSnapshot();
    const sessionsPromise = api
      .post('/api/sessions', {})
      .then((sessRes) => {
        if (Array.isArray(sessRes?.sessions) && sessRes.sessions.length > 0) {
          const preferredSession =
            sessRes.sessions.find((s) => s && s.sessionId && !s.isSubagent) ||
            sessRes.sessions[0];
          const topSid = preferredSession?.sessionId || '';
          if (topSid && topSid !== sharedState.fallbackSessionId) {
            sharedState.fallbackSessionId = topSid;
            if (
              typeof controller.hasExplicitSessionId !== 'function' ||
              !controller.hasExplicitSessionId()
            ) {
              controller.refreshSnapshot();
            }
          }
        }
      })
      .catch(() => {});
    await Promise.all([snapshotPromise, sessionsPromise]);
  }

  async function pollQuotaAndSettings() {
    if (disposed || !isApiConfigured()) return;
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
    preferredBoxEl = null;
    mountToActiveBox();
  };
  const onPointerDown = (e) => {
    if (disposed || !e || !e.target) return;
    const target = e.target.nodeType === 3 ? e.target.parentElement : e.target;
    if (!target || target.nodeType !== 1 || isOwnNode(target)) return;
    const boxes = Array.from(doc.querySelectorAll('[data-testid="agent-input-box"]'));
    if (boxes.length === 0) return;
    let targetBox =
      typeof target.closest === 'function'
        ? target.closest('[data-testid="agent-input-box"]')
        : null;
    if (targetBox && !boxes.includes(targetBox)) {
      targetBox = null;
    }
    if (!targetBox) {
      const clickedView =
        findClosestConversationView(target) || findClosestCascadeCarrier(target);
      if (clickedView) {
        targetBox = findBoxForView(clickedView, boxes);
      }
    }
    if (targetBox && isElementVisible(targetBox)) {
      preferredBoxEl = targetBox;
      activeBoxEl = targetBox;
      mountToActiveBox();
    }
  };
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('pointerdown', onPointerDown);

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
        if (isApiConfigured()) controller.refreshSnapshot();
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

  if (typeof hostPort.getSettings === 'function') {
    try {
      applyHostSettingsBridgeSnapshot(hostPort.getSettings(), { triggerPoll: false });
    } catch {}
  }
  if (typeof hostPort.onSettingsChange === 'function') {
    try {
      const unsub = hostPort.onSettingsChange((nextSnap) => {
        applyHostSettingsBridgeSnapshot(nextSnap, { triggerPoll: true });
      });
      if (typeof unsub === 'function') {
        unsubscribeSettings = unsub;
      }
    } catch {}
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (snapshotPollTimer) clearTimeout(snapshotPollTimer);
    if (domActivityTimer) clearTimeout(domActivityTimer);
    if (quotaPollTimer) clearInterval(quotaPollTimer);
    if (observer) observer.disconnect();
    if (typeof unsubscribeSettings === 'function') {
      try {
        unsubscribeSettings();
      } catch {}
      unsubscribeSettings = null;
    }
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('pointerdown', onPointerDown);
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
  if (isApiConfigured()) {
    pollQuotaAndSettings();
    pollSessionsAndSnapshots();
  } else {
    controller.render();
  }
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
  if (hostPort && hostPort.hostProfileId === 'antigravity-remote-web') {
    return Object.freeze({
      mountIfFound() {
        return false;
      },
      dispose() {},
    });
  }

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
