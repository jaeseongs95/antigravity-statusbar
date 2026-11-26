/**
 * AddonManifest.v3 / AddonContextV3 lifecycle bootstrap & host integration coordinator (SRP / DIP).
 *
 * API-First Architecture:
 * - Branches strictly on `hostPort.surface === 'remote-web'` (NEVER raw `hostProfileId`).
 * - Provides well-known service `host.statusbar` (`allowedCallers: ["*"]`) via `ctx.services.provide`
 *   so other plugins calling `ctx.ui.registerStatusItem(...)` render seamlessly on this statusbar.
 * - Registers Tier-1 commands (`open-settings`, `open-global-limits`, `refresh-quota`, `compact-now`)
 *   and Tier-1 unified settings page across both Desktop and Remote Web.
 * - Uses `ctx.storage` (KV + `onDidChange`) for browser-local Remote Web connection & locale state.
 * - Syncs `ctx.theme` (`getTokenCss()` + `onDidChange`) into the Tier-3 statusbar canvas style.
 * - Uses `ctx.lifecycle.signal` (`AbortSignal`), `addManagedListener`, and `onDispose` for cleanup.
 */

export function startAddonStatusbar({
  hostPort,
  api,
  i18n,
  addons,
  createBarViewFn,
  createDeclarativeUiSchemasFn,
  createBarControllerFn,
  doc,
  win,
  cssText,
  styleId = 'statusbar-main',
  pollConfig = {},
  hasStaticInitialConnection = false,
}) {
  const isRemoteWeb = Boolean(hostPort && hostPort.surface === 'remote-web');
  const NORMAL_POLL_MS = pollConfig.normalPollMs || 1000;
  const BURST_POLL_MS = pollConfig.burstPollMs || 400;
  const QUOTA_POLL_MS = pollConfig.quotaPollMs || 15000;
  const QUOTA_EXPIRED_RETRY_MS = pollConfig.quotaExpiredRetryMs || 5000;
  const QUOTA_FOCUS_THROTTLE_MS = pollConfig.quotaFocusThrottleMs || 3000;
  const MAX_BURST_MS = pollConfig.maxBurstMs || 20000;
  const DOM_DEBOUNCE_MS = pollConfig.domDebounceMs || 150;
  const REMOTE_STORAGE_KEY = 'remoteConnection';

  let disposed = false;
  let burstUntil = 0;
  let snapshotPollTimer = null;
  let quotaPollTimer = null;
  let domActivityTimer = null;
  let quotaInFlight = false;
  let lastQuotaRefreshAt = 0;
  let lastExpiredQuotaRetryAt = 0;
  let observer = null;
  let unsubscribeSettings = null;
  let unsubscribeTheme = null;
  let unsubscribeStorage = null;
  let statusbarServiceHandle = null;
  const hostDisposables = [];
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

  function applyThemeAndStyles() {
    if (disposed) return;
    let tokenCss = '';
    if (hostPort.theme && typeof hostPort.theme.getTokenCss === 'function') {
      try {
        tokenCss = String(hostPort.theme.getTokenCss() || '');
      } catch {}
    }
    const combinedCss = tokenCss ? `${tokenCss}\n${cssText || ''}` : cssText || '';
    if (hostPort.slotId) {
      hostPort.injectStyle(styleId, combinedCss, { slotId: hostPort.slotId });
    } else {
      hostPort.injectStyle(styleId, combinedCss);
    }
  }

  // Respect host i18n locale on initial boot before Sidecar settings override it
  if (hostPort.hostI18n && typeof hostPort.hostI18n.getLocale === 'function') {
    try {
      const hostLoc = String(hostPort.hostI18n.getLocale() || '').toLowerCase();
      if (hostLoc.startsWith('en')) i18n.setLocale('en');
      else if (hostLoc.startsWith('ko')) i18n.setLocale('ko');
    } catch {}
  }

  applyThemeAndStyles();
  if (hostPort.theme && typeof hostPort.theme.onDidChange === 'function') {
    try {
      unsubscribeTheme = hostPort.theme.onDidChange(() => applyThemeAndStyles());
    } catch {}
  }

  // Provide well-known service `host.statusbar` so other plugins' `ctx.ui.registerStatusItem()` render here
  if (hostPort.services && typeof hostPort.services.provide === 'function' && addons.statusbarService) {
    try {
      statusbarServiceHandle = hostPort.services.provide('host.statusbar', addons.statusbarService, {
        allowedCallers: ['*'],
      });
    } catch {}
  }

  const barView = createBarViewFn({ doc, i18n });
  const uiSchemas = createDeclarativeUiSchemasFn({ i18n });

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

  async function persistRemoteConnection(payload) {
    if (hostPort.storage && typeof hostPort.storage.set === 'function') {
      await hostPort.storage.set(REMOTE_STORAGE_KEY, payload);
      return { ok: true };
    }
    if (typeof hostPort.saveSettings === 'function') {
      return await hostPort.saveSettings(payload);
    }
    return { ok: true };
  }

  async function clearRemoteConnectionStorage() {
    if (hostPort.storage && typeof hostPort.storage.delete === 'function') {
      await hostPort.storage.delete(REMOTE_STORAGE_KEY);
      return;
    }
    if (typeof hostPort.saveSettings === 'function') {
      await hostPort.saveSettings({
        remoteBaseUrl: '',
        remoteToken: '',
        locale: i18n.getLocale(),
      });
    }
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
    try {
      const saveRes = await persistRemoteConnection({
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
    if (isRemoteWeb) {
      try {
        await clearRemoteConnectionStorage();
      } catch {}
    }
  }

  const controller = createBarControllerFn({
    api,
    i18n,
    addons,
    barView,
    uiSchemas,
    hostPort,
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

  function applyRemoteConnectionData(data, { triggerPoll = true } = {}) {
    if (disposed || !isRemoteWeb) return;
    if (!data || typeof data !== 'object') {
      if (typeof api.clearConnection === 'function') {
        const cleared = api.clearConnection();
        if (cleared && typeof controller.resetConnectionState === 'function') {
          controller.resetConnectionState();
        }
      }
      controller.render();
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
  }

  function applyHostSettingsBridgeSnapshot(snap, { triggerPoll = true } = {}) {
    if (disposed) return;
    if (!snap || typeof snap !== 'object') return;
    const data = snap.data && typeof snap.data === 'object' ? snap.data : null;

    if (isRemoteWeb) {
      if (snap.persistence === 'packed-initial') return;
      if (snap.status !== 'ok' || !data) return;
      applyRemoteConnectionData(data, { triggerPoll });
      return;
    }

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

  function isNodeInDocument(node) {
    if (!node) return false;
    if (typeof doc.contains === 'function') return doc.contains(node);
    if (doc.documentElement && typeof doc.documentElement.contains === 'function') {
      return doc.documentElement.contains(node);
    }
    if (doc.body && typeof doc.body.contains === 'function') {
      return doc.body.contains(node);
    }
    return node.isConnected !== false;
  }

  function findActiveInputBox() {
    const boxes = Array.from(doc.querySelectorAll('[data-testid="agent-input-box"]'));
    if (boxes.length === 0) return null;

    if (preferredBoxEl) {
      if (isNodeInDocument(preferredBoxEl) && boxes.includes(preferredBoxEl) && isElementVisible(preferredBoxEl)) {
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

    if (activeBoxEl && isNodeInDocument(activeBoxEl) && boxes.includes(activeBoxEl)) {
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

  function hasExpiredQuotaBucket(quotaState, now) {
    if (!quotaState || !quotaState.available || !Array.isArray(quotaState.groups)) return false;
    for (const g of quotaState.groups) {
      const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
      for (const b of buckets) {
        if (typeof b?.remainingPercent !== 'number' || b.remainingPercent >= 100) continue;
        if (typeof b?.resetTime !== 'string' || !b.resetTime.trim()) continue;
        const resetMs = Date.parse(b.resetTime.trim());
        if (Number.isFinite(resetMs) && resetMs <= now) {
          return true;
        }
      }
    }
    return false;
  }

  async function refreshQuotaNow({ forceRefresh = false } = {}) {
    if (disposed || !isApiConfigured() || quotaInFlight) return;
    quotaInFlight = true;
    lastQuotaRefreshAt = Date.now();
    try {
      const payload = forceRefresh ? { forceRefresh: true } : {};
      sharedState.quotaState = await api.post('/api/quota', payload, hostPort.lifecycleSignal || undefined);
      controller.render();
    } catch {} finally {
      quotaInFlight = false;
    }
  }

  async function pollSessionsAndSnapshots() {
    if (disposed) return;
    mountToActiveBox();
    if (!isApiConfigured()) {
      controller.render();
      return;
    }
    const now = Date.now();
    if (
      hasExpiredQuotaBucket(sharedState.quotaState, now) &&
      now - lastExpiredQuotaRetryAt >= QUOTA_EXPIRED_RETRY_MS
    ) {
      lastExpiredQuotaRetryAt = now;
      refreshQuotaNow({ forceRefresh: true });
    }
    const snapshotPromise = controller.refreshSnapshot();
    const sessionsPromise = api
      .post('/api/sessions', {}, hostPort.lifecycleSignal || undefined)
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
      const settings = await api.post('/api/settings/get', {}, hostPort.lifecycleSignal || undefined);
      applySettingsPayload(settings);
      controller.render();
    } catch {}
    const shouldForce = hasExpiredQuotaBucket(sharedState.quotaState, Date.now());
    await refreshQuotaNow({ forceRefresh: shouldForce });
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
  const onQuotaFocusOrVisible = () => {
    if (disposed || !isApiConfigured()) return;
    if (doc && doc.hidden === true) return;
    const now = Date.now();
    if (now - lastQuotaRefreshAt < QUOTA_FOCUS_THROTTLE_MS) return;
    refreshQuotaNow({ forceRefresh: true });
  };
  const onQuotaClick = () => {
    if (disposed || !isApiConfigured()) return;
    refreshQuotaNow({ forceRefresh: true });
  };

  function bindManaged(target, type, listener) {
    if (!target || typeof target.addEventListener !== 'function') return;
    if (typeof hostPort.addManagedListener === 'function') {
      const unsub = hostPort.addManagedListener(target, type, listener);
      if (typeof unsub === 'function') hostDisposables.push(unsub);
    } else {
      target.addEventListener(type, listener);
      hostDisposables.push(() => {
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, listener);
        }
      });
    }
  }

  bindManaged(doc, 'focusin', onFocusIn);
  bindManaged(doc, 'pointerdown', onPointerDown);
  bindManaged(doc, 'visibilitychange', onQuotaFocusOrVisible);
  if (win) bindManaged(win, 'focus', onQuotaFocusOrVisible);
  if (barView.quota5hEl) bindManaged(barView.quota5hEl, 'click', onQuotaClick);
  if (barView.quotaEl) bindManaged(barView.quotaEl, 'click', onQuotaClick);

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

  // Register Tier-1 commands across both Desktop and Remote Web
  if (typeof hostPort.registerCommand === 'function') {
    const commands = [
      {
        id: 'open-settings',
        label: `${i18n.t().settingsTitle}: ${i18n.t().tabSettings}`,
        run() {
          if (!disposed) controller.openSettings();
        },
      },
      {
        id: 'open-global-limits',
        label: `${i18n.t().settingsTitle}: ${i18n.t().globalLimitBtn}`,
        run() {
          if (!disposed) controller.openGlobalLimits();
        },
      },
      {
        id: 'refresh-quota',
        label: `${i18n.t().settingsTitle}: ${i18n.t().reloadNow}`,
        run() {
          if (!disposed && isApiConfigured()) {
            refreshQuotaNow({ forceRefresh: true });
          }
        },
      },
      {
        id: 'compact-now',
        label: `${i18n.t().settingsTitle}: /compact`,
        run() {
          if (!disposed && isApiConfigured() && typeof controller.triggerCompact === 'function') {
            controller.triggerCompact();
          }
        },
      },
    ];
    for (const cmd of commands) {
      try {
        const reg = hostPort.registerCommand(cmd.id, { label: cmd.label, run: cmd.run });
        if (reg && typeof reg.dispose === 'function') {
          hostDisposables.push(() => reg.dispose());
        } else if (reg && typeof reg.unregister === 'function') {
          hostDisposables.push(() => reg.unregister());
        }
      } catch {}
    }
  }

  // Remote Web: restore browser-local Sidecar connection via `ctx.storage`
  if (isRemoteWeb && hostPort.storage && typeof hostPort.storage.get === 'function') {
    Promise.resolve(hostPort.storage.get(REMOTE_STORAGE_KEY))
      .then((saved) => {
        if (!disposed && saved && typeof saved === 'object') {
          applyRemoteConnectionData(saved, { triggerPoll: true });
        }
      })
      .catch(() => {});
    if (typeof hostPort.storage.onDidChange === 'function') {
      try {
        unsubscribeStorage = hostPort.storage.onDidChange((ev) => {
          if (disposed || !ev || ev.key !== REMOTE_STORAGE_KEY) return;
          applyRemoteConnectionData(ev.newValue || null, { triggerPoll: true });
        });
      } catch {}
    }
  }

  // Optional host settingsBridge subscription (Desktop live Sidecar credentials once exposed by host Gap #1)
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
    if (typeof unsubscribeTheme === 'function') {
      try {
        unsubscribeTheme();
      } catch {}
      unsubscribeTheme = null;
    }
    if (typeof unsubscribeStorage === 'function') {
      try {
        unsubscribeStorage();
      } catch {}
      unsubscribeStorage = null;
    }
    if (statusbarServiceHandle && typeof statusbarServiceHandle.dispose === 'function') {
      try {
        statusbarServiceHandle.dispose();
      } catch {}
      statusbarServiceHandle = null;
    }
    while (hostDisposables.length > 0) {
      const fn = hostDisposables.pop();
      try {
        fn();
      } catch {}
    }
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
  }

  if (hostPort.lifecycleSignal && typeof hostPort.lifecycleSignal.addEventListener === 'function') {
    hostPort.lifecycleSignal.addEventListener('abort', dispose, { once: true });
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
    openContextPopup: controller.openContextPopup,
    openSettings: controller.openSettings,
    openGlobalLimits: controller.openGlobalLimits,
    dispose,
  });
}

/**
 * Credential-free standby renderer shown on Desktop when the Sidecar has not yet published
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
  if (hostPort && hostPort.surface === 'remote-web') {
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

  let tokenCss = '';
  if (hostPort.theme && typeof hostPort.theme.getTokenCss === 'function') {
    try {
      tokenCss = String(hostPort.theme.getTokenCss() || '');
    } catch {}
  }
  const combinedCss = tokenCss ? `${tokenCss}\n${cssText || ''}` : cssText || '';
  if (hostPort.slotId) {
    hostPort.injectStyle(styleId, combinedCss, { slotId: hostPort.slotId });
  } else {
    hostPort.injectStyle(styleId, combinedCss);
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
            : typeof doc.contains === 'function'
              ? doc.contains(currentSlotEl)
              : Boolean(doc.body && typeof doc.body.contains === 'function' && doc.body.contains(currentSlotEl))),
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
