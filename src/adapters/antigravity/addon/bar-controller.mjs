/**
 * Stateful inline statusbar + popover controller (SRP / DIP).
 * Depends exclusively on injected abstractions (`api`, `i18n`, `addons`, `barView`, `popoverView`).
 */

export function createBarController({
  doc,
  win = null,
  api,
  i18n,
  addons,
  barView,
  popoverView,
  globalModalView = null,
  portalHost = null,
  sharedState,
  isRemoteWeb = false,
  onSettingsChanged,
  onBurstRequested,
  onRemoteConnectionSave = null,
  onRemoteConnectionClear = null,
  presets,
}) {
  const PRESETS = Array.isArray(presets) && presets.length > 0
    ? presets
    : [32000, 64000, 128000, 200000, 256000, 384000, 512000, 980000];

  const hasPopoverPortal = Boolean(portalHost && typeof portalHost.openPopover === 'function');
  const hasModalPortal = Boolean(portalHost && typeof portalHost.openModal === 'function');

  if (!hasPopoverPortal) {
    barView.barEl.appendChild(popoverView.popEl);
  }
  if (!hasModalPortal && globalModalView && globalModalView.backdropEl) {
    barView.barEl.appendChild(globalModalView.backdropEl);
  }

  const state = {
    disposed: false,
    viewEl: null,
    popOpen: false,
    modalOpen: false,
    popoverPortalHandle: null,
    popoverResizeListener: null,
    modalPortalHandle: null,
    modalBackdropListener: null,
    activeTab: 'context',
    lastTriggerEl: barView.settingsBtn,
    modalTriggerEl: barView.settingsBtn,
    feedbackTimer: null,
    modalFeedbackTimer: null,
    noteTimer: null,
    lastSessionId: '',
    snapshot: null,
    epoch: 0,
    abortCtrl: null,
    inFlight: false,
    inFlightPromise: null,
    pendingRefresh: false,
    compacting: false,
    limitDirty: false,
    promptDirty: false,
    lastAddonsKey: '',
    syncedLimitKey: '',
    syncedPromptVal: null,
    lastAutoErrAt: 0,
    consecutiveSnapshotFailures: 0,
    lastConnectionError: null,
    remoteUrlDirty: false,
  };

  function isApiConfigured() {
    return typeof api.isConfigured === 'function' ? Boolean(api.isConfigured()) : true;
  }

  function getApiBaseUrl() {
    return typeof api.getBaseUrl === 'function' ? api.getBaseUrl() : '';
  }

  function syncRemoteConnectionPanel(force = false) {
    if (!isRemoteWeb || !popoverView.remoteUrlInput) return;
    const tr = i18n.t();
    const configured = isApiConfigured();
    const currentUrl = getApiBaseUrl();
    if (force || (!state.remoteUrlDirty && !isElementFocused(popoverView.remoteUrlInput))) {
      popoverView.remoteUrlInput.value = currentUrl;
      state.remoteUrlDirty = false;
    }
    if (!configured) {
      popoverView.setRemoteConnectionStatus(tr.remoteDisconnected, false);
    } else if (api.isConnected()) {
      popoverView.setRemoteConnectionStatus(
        i18n.formatTemplate(tr.remoteConnected, { url: currentUrl }),
        false,
      );
    } else if (state.lastConnectionError) {
      const status = state.lastConnectionError.status;
      if (status === 401 || status === 403) {
        popoverView.setRemoteConnectionStatus(
          i18n.formatTemplate(tr.remoteAuthFailed, { status }),
          true,
        );
      } else {
        popoverView.setRemoteConnectionStatus(tr.remoteUnreachable, true);
      }
    } else {
      popoverView.setRemoteConnectionStatus(tr.connecting, false);
    }
  }

  function isElementFocused(el) {
    if (!el) return false;
    if (typeof el.getRootNode === 'function') {
      try {
        const root = el.getRootNode();
        if (root && root !== doc && 'activeElement' in root) {
          return root.activeElement === el;
        }
      } catch {}
    }
    return doc.activeElement === el;
  }

  function getViewportWindow() {
    return win || (typeof window !== 'undefined' ? window : null);
  }

  function applyModalPortalLayout(dialogEl) {
    if (!dialogEl || !dialogEl.style) return;
    dialogEl.style.position = 'fixed';
    dialogEl.style.inset = '0';
    dialogEl.style.top = '36px';
    dialogEl.style.top = 'max(env(titlebar-area-height, 36px), 36px)';
    dialogEl.style.right = '0';
    dialogEl.style.bottom = '0';
    dialogEl.style.left = '0';
    dialogEl.style.margin = 'auto';
    dialogEl.style.marginTop = 'auto';
    dialogEl.style.marginRight = 'auto';
    dialogEl.style.marginBottom = 'auto';
    dialogEl.style.marginLeft = 'auto';
    dialogEl.style.width = 'fit-content';
    dialogEl.style.height = 'fit-content';
    dialogEl.style.padding = '0';
    dialogEl.style.border = 'none';
    dialogEl.style.background = 'transparent';
    dialogEl.style.color = 'inherit';
    dialogEl.style.overflow = 'visible';
    dialogEl.style.maxWidth = 'calc(100vw - 32px)';
    dialogEl.style.maxHeight = 'calc(100vh - 72px)';
  }

  function positionPopoverPortal(portalEl, anchorEl) {
    if (!portalEl || !portalEl.style) return;
    const POPOVER_WIDTH = 352;
    const VIEWPORT_MARGIN = 8;
    const viewWin = getViewportWindow();
    const vw =
      viewWin && typeof viewWin.innerWidth === 'number' && viewWin.innerWidth > 0
        ? viewWin.innerWidth
        : 1280;
    const vh =
      viewWin && typeof viewWin.innerHeight === 'number' && viewWin.innerHeight > 0
        ? viewWin.innerHeight
        : 800;
    let rect = null;
    if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
      try {
        const r = anchorEl.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0 || r.top > 0 || r.right > 0 || r.left > 0)) {
          rect = r;
        }
      } catch {}
    }
    portalEl.style.top = 'auto';
    if (rect) {
      const maxEdgeOffset = Math.max(VIEWPORT_MARGIN, vw - POPOVER_WIDTH - VIEWPORT_MARGIN);
      if (rect.top < 220 && vh - rect.bottom > rect.top) {
        // ISS-10: Flip below anchor when insufficient vertical space exists above
        portalEl.style.bottom = 'auto';
        portalEl.style.top = `${Math.max(VIEWPORT_MARGIN, Math.round(rect.bottom + 8))}px`;
        popoverView.popEl.style.maxHeight = `${Math.max(160, Math.round(vh - rect.bottom - 16))}px`;
      } else {
        const bottomPx = Math.max(VIEWPORT_MARGIN, Math.min(vh - 80, Math.round(vh - rect.top + 8)));
        portalEl.style.bottom = `${bottomPx}px`;
        popoverView.popEl.style.maxHeight = `${Math.max(160, Math.round(rect.top - 16))}px`;
      }
      if (anchorEl === barView.ctxBtn && typeof rect.left === 'number') {
        const leftPx = Math.max(VIEWPORT_MARGIN, Math.min(maxEdgeOffset, Math.round(rect.left)));
        portalEl.style.left = `${leftPx}px`;
        portalEl.style.right = 'auto';
      } else {
        const rightPx = Math.max(
          VIEWPORT_MARGIN,
          Math.min(maxEdgeOffset, Math.round(vw - rect.right)),
        );
        portalEl.style.left = 'auto';
        portalEl.style.right = `${rightPx}px`;
      }
    } else {
      portalEl.style.left = 'auto';
      portalEl.style.bottom = '48px';
      portalEl.style.right = '12px';
    }
  }

  const SUBAGENT_VIEW_TESTIDS = new Set([
    'subagent-tab-conversation',
    'side-question-tab-conversation',
  ]);
  const CONVERSATION_VIEW_TESTIDS = new Set([
    'conversation-view',
    'subagent-tab-conversation',
    'side-question-tab-conversation',
  ]);

  function readCascadeId(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    const raw = String(el.getAttribute('data-cascade-id') || '').trim();
    return raw && raw !== 'remote-session' ? raw : '';
  }

  function isIsolatedSubagentView(el) {
    let cur = el && el.nodeType === 3 ? el.parentElement : el;
    while (cur && cur.nodeType === 1) {
      if (
        typeof cur.getAttribute === 'function' &&
        SUBAGENT_VIEW_TESTIDS.has(cur.getAttribute('data-testid'))
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function resolveDomSessionId() {
    if (!state.viewEl) return '';
    let cur = state.viewEl;
    while (cur && cur.nodeType === 1) {
      const attr = readCascadeId(cur);
      if (attr) return attr;
      cur = cur.parentElement;
    }
    if (
      typeof state.viewEl.getAttribute === 'function' &&
      CONVERSATION_VIEW_TESTIDS.has(state.viewEl.getAttribute('data-testid')) &&
      state.viewEl.childNodes
    ) {
      let foundId = '';
      let ambiguous = false;
      const walk = (node) => {
        if (ambiguous || !node || !node.childNodes) return;
        for (let i = 0; i < node.childNodes.length; i += 1) {
          const ch = node.childNodes[i];
          if (!ch || ch.nodeType !== 1) continue;
          const cid = readCascadeId(ch);
          if (cid) {
            if (!foundId) foundId = cid;
            else if (cid !== foundId) {
              ambiguous = true;
              return;
            }
          }
          walk(ch);
        }
      };
      walk(state.viewEl);
      if (!ambiguous && foundId) return foundId;
    }
    return '';
  }

  function hasExplicitSessionId() {
    return Boolean(resolveDomSessionId());
  }

  function getSessionId() {
    const domSid = resolveDomSessionId();
    if (domSid) return domSid;
    // Fail-Closed: never fall back to global fallbackSessionId inside an unattributed subagent/side-question view
    if (isIsolatedSubagentView(state.viewEl)) return '';
    return sharedState.fallbackSessionId || '';
  }

  function showNote(text, durationMs = 4000) {
    if (state.noteTimer) {
      clearTimeout(state.noteTimer);
      state.noteTimer = null;
    }
    barView.setNote(text);
    if (text && durationMs > 0) {
      state.noteTimer = setTimeout(() => {
        state.noteTimer = null;
        if (!state.disposed) barView.setNote('');
      }, durationMs);
    }
  }

  function showFeedback(text, isErr = false) {
    if (state.feedbackTimer) {
      clearTimeout(state.feedbackTimer);
      state.feedbackTimer = null;
    }
    popoverView.setFeedback(text, isErr);
    if (text) {
      state.feedbackTimer = setTimeout(() => {
        state.feedbackTimer = null;
        if (!state.disposed) popoverView.setFeedback('', false);
      }, 3500);
    }
  }

  function showModalFeedback(text, isErr = false) {
    if (!globalModalView) return;
    if (state.modalFeedbackTimer) {
      clearTimeout(state.modalFeedbackTimer);
      state.modalFeedbackTimer = null;
    }
    globalModalView.setFeedback(text, isErr);
    if (text) {
      state.modalFeedbackTimer = setTimeout(() => {
        state.modalFeedbackTimer = null;
        if (!state.disposed) globalModalView.setFeedback('', false);
      }, 4000);
    }
  }

  function parseStrictLimitInput(inputElOrValue, { allowBlank = true } = {}) {
    if (inputElOrValue && typeof inputElOrValue === 'object') {
      if (inputElOrValue.validity && inputElOrValue.validity.badInput === true) {
        return { ok: false, value: null };
      }
    }
    const rawStr =
      inputElOrValue && typeof inputElOrValue === 'object' ? inputElOrValue.value : inputElOrValue;
    const raw = String(rawStr || '').replace(/[\s,]/g, '').trim();
    if (raw === '') {
      return allowBlank ? { ok: true, value: null } : { ok: false, value: null };
    }
    if (!/^\d+$/.test(raw)) {
      return { ok: false, value: null };
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 32000 || parsed > 980000) {
      return { ok: false, value: null };
    }
    return { ok: true, value: parsed };
  }

  function getSavedLimitForScope(scope) {
    if (scope === 'default') {
      return typeof sharedState.defaultCustomLimit === 'number'
        ? sharedState.defaultCustomLimit
        : null;
    }
    const sid = getSessionId();
    if (sid && sharedState.sessionLimits.has(sid)) {
      return sharedState.sessionLimits.get(sid);
    }
    const snap = state.snapshot;
    if (snap && snap.limitSource === 'session' && typeof snap.customLimit === 'number') {
      return snap.customLimit;
    }
    return null;
  }

  function syncLimitControls(force = false) {
    const scope = popoverView.scopeSelect.value === 'default' ? 'default' : 'session';
    const sid = getSessionId();
    const savedVal = getSavedLimitForScope(scope);
    const nextKey = `${sid}:${scope}:${savedVal === null ? 'null' : savedVal}`;

    if (!force) {
      if (state.limitDirty) return;
      if (state.syncedLimitKey === nextKey) return;
      if (
        isElementFocused(popoverView.customInput) ||
        isElementFocused(popoverView.presetSelect)
      ) {
        return;
      }
    }

    state.syncedLimitKey = nextKey;
    state.limitDirty = false;
    const strVal = savedVal !== null ? String(savedVal) : '';
    popoverView.customInput.value = strVal;
    popoverView.presetSelect.value = savedVal !== null && PRESETS.includes(savedVal) ? strVal : '';
  }

  function syncCompactPrompt(force = false) {
    if (!force) {
      if (state.promptDirty) return;
      if (state.syncedPromptVal === sharedState.compactPrompt) return;
      if (isElementFocused(popoverView.compactPromptInput)) return;
    }
    state.syncedPromptVal = sharedState.compactPrompt;
    state.promptDirty = false;
    popoverView.compactPromptInput.value = sharedState.compactPrompt;
    popoverView.updatePromptCount();
  }

  function setActiveTab(tab) {
    const next = tab === 'settings' ? 'settings' : 'context';
    state.activeTab = next;
    popoverView.setActiveTab(next);
    barView.setExpandedState({ open: state.popOpen, activeTab: state.activeTab });
  }

  function detachPopoverResizeListener() {
    if (!state.popoverResizeListener) return;
    const viewWin = getViewportWindow();
    if (viewWin && typeof viewWin.removeEventListener === 'function') {
      try {
        viewWin.removeEventListener('resize', state.popoverResizeListener);
      } catch {}
    }
    state.popoverResizeListener = null;
  }

  function finalizePopoverClosed() {
    detachPopoverResizeListener();
    state.popoverPortalHandle = null;
    state.popOpen = false;
    popoverView.setVisible(false);
    popoverView.popEl.classList.remove('agy-inline-popover-portal');
    if (hasPopoverPortal) {
      try {
        popoverView.popEl.remove();
      } catch {}
    }
    barView.setExpandedState({ open: false, activeTab: state.activeTab });
  }

  function setPopoverOpen(open, tab, triggerEl) {
    const nextOpen = Boolean(open);
    const wasOpen = state.popOpen;
    if (triggerEl) state.lastTriggerEl = triggerEl;
    if (tab) setActiveTab(tab);

    if (hasPopoverPortal) {
      if (nextOpen) {
        if (!state.popoverPortalHandle) {
          const handle = portalHost.openPopover({
            ignoreOutsideClickEls: [barView.ctxBtn, barView.settingsBtn],
            onClose: finalizePopoverClosed,
          });
          if (!handle) return;
          state.popoverPortalHandle = handle;
          if (handle.element && handle.element.style) {
            handle.element.style.margin = '0';
            handle.element.style.marginTop = '0';
            handle.element.style.marginRight = '0';
            handle.element.style.marginBottom = '0';
            handle.element.style.marginLeft = '0';
            handle.element.style.width = 'fit-content';
            handle.element.style.height = 'fit-content';
            handle.element.style.padding = '0';
            handle.element.style.border = 'none';
            handle.element.style.background = 'transparent';
            handle.element.style.color = 'inherit';
            handle.element.style.overflow = 'visible';
            handle.element.style.position = 'fixed';
            handle.element.style.inset = 'auto';
          }
          positionPopoverPortal(handle.element, state.lastTriggerEl || barView.barEl);
          detachPopoverResizeListener();
          const viewWin = getViewportWindow();
          if (viewWin && typeof viewWin.addEventListener === 'function') {
            const onResize = () => {
              if (!state.disposed && state.popOpen && state.popoverPortalHandle?.element) {
                positionPopoverPortal(
                  state.popoverPortalHandle.element,
                  state.lastTriggerEl || barView.barEl,
                );
              }
            };
            state.popoverResizeListener = onResize;
            try {
              viewWin.addEventListener('resize', onResize);
            } catch {}
          }
          if (typeof portalHost.syncStyle === 'function') {
            portalHost.syncStyle('popover');
          }
          popoverView.popEl.classList.add('agy-inline-popover-portal');
          const mountTarget = handle.bodyEl || handle.element;
          if (mountTarget && popoverView.popEl.parentNode !== mountTarget) {
            mountTarget.appendChild(popoverView.popEl);
          }
        } else {
          positionPopoverPortal(
            state.popoverPortalHandle.element,
            state.lastTriggerEl || barView.barEl,
          );
        }
        state.popOpen = true;
        popoverView.setVisible(true);
        barView.setExpandedState({ open: true, activeTab: state.activeTab });
        if (!wasOpen) {
          showFeedback('', false);
          syncLimitControls(true);
          syncCompactPrompt(true);
        }
      } else if (state.popoverPortalHandle) {
        const handle = state.popoverPortalHandle;
        state.popoverPortalHandle = null;
        try {
          handle.close();
        } catch {}
        if (state.popOpen) {
          finalizePopoverClosed();
        }
      } else {
        finalizePopoverClosed();
      }
      return;
    }

    state.popOpen = nextOpen;
    popoverView.setVisible(state.popOpen);
    barView.setExpandedState({ open: state.popOpen, activeTab: state.activeTab });
    if (nextOpen && !wasOpen) {
      showFeedback('', false);
      syncLimitControls(true);
      syncCompactPrompt(true);
    }
  }

  async function handleCustomCommand(btnDef, btnEl) {
    const sid = getSessionId();
    if (!sid || !btnDef?.command) return;
    if (btnEl) btnEl.disabled = true;
    try {
      await api.post('/api/command', { sessionId: sid, command: btnDef.command });
      showNote(`${btnDef.label}: ${i18n.t().cmdSent}`);
      if (typeof onBurstRequested === 'function') onBurstRequested();
    } catch {
      showNote(`${btnDef.label}: ${i18n.t().cmdFail}`);
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function handleToggleAddon(id, enabled, isRuntime) {
    try {
      const updated = await api.post('/api/addons/toggle', { id, enabled, runtime: isRuntime });
      addons.applyPersistedSettings(updated);
      showFeedback(i18n.t().applied, false);
      render();
    } catch (err) {
      showFeedback(err?.message || 'Error', true);
    }
  }

  async function handleRemoveAddon(id, isRuntime) {
    if (isRuntime) {
      addons.removeRuntime(id);
      render();
      return;
    }
    try {
      const updated = await api.post('/api/addons/remove', { id });
      addons.applyPersistedSettings(updated);
      showFeedback(i18n.t().applied, false);
      render();
    } catch (err) {
      showFeedback(err?.message || 'Error', true);
    }
  }

  function renderAddons() {
    const persistedSorted = addons.getSortedPersisted();
    const runtimeSorted = addons.getSortedRuntime();
    const nextAddonsKey = JSON.stringify({
      locale: i18n.getLocale(),
      p: persistedSorted.map((b) => [
        b.id,
        b.label,
        b.command,
        b.description,
        b.enabled !== false,
        b.source,
      ]),
      r: runtimeSorted.map((r) => [
        r.id,
        r.label,
        r.title,
        r.description,
        !addons.isRuntimeDisabled(r.id),
        r.source,
      ]),
    });
    if (state.lastAddonsKey === nextAddonsKey) return;
    state.lastAddonsKey = nextAddonsKey;

    const visibleRuntime = runtimeSorted.filter((r) => !addons.isRuntimeDisabled(r.id));
    barView.renderAddonButtons({
      persistedButtons: persistedSorted,
      runtimeButtons: visibleRuntime,
      onPersistedClick: handleCustomCommand,
      onRuntimeClick(rtDef) {
        try {
          // P1: Do not leak live barEl/buttonEl DOM handles to peer runtime add-ons
          rtDef.onClick({ sessionId: getSessionId() });
        } catch {}
      },
    });

    const combined = [
      ...persistedSorted.map((b) => ({
        id: b.id,
        label: b.label,
        source: b.source || 'agent',
        detail: b.description || b.command,
        enabled: b.enabled !== false,
        runtime: false,
      })),
      ...runtimeSorted.map((r) => ({
        id: r.id,
        label: r.label,
        source: r.source || 'plugin',
        detail: r.description || r.title || r.id,
        enabled: !addons.isRuntimeDisabled(r.id),
        runtime: true,
      })),
    ];
    popoverView.renderAddonList({
      items: combined,
      onToggle: handleToggleAddon,
      onRemove: handleRemoveAddon,
    });
  }

  function render() {
    if (state.disposed) return;
    const snap = state.snapshot;
    if (snap && typeof snap.compactPrompt === 'string' && !state.promptDirty) {
      sharedState.compactPrompt = snap.compactPrompt;
    }
    popoverView.renderLocaleAndStatic({
      autoCompactEnabled: sharedState.autoCompactEnabled,
    });
    syncCompactPrompt(false);
    renderAddons();

    const configured = isApiConfigured();
    const isSubagentView = Boolean(snap?.isSubagent || isIsolatedSubagentView(state.viewEl));
    barView.renderSnapshot({
      snap,
      connected: api.isConnected(),
      configured,
      isRemoteWeb,
      compacting: state.compacting,
      hasSession: Boolean(getSessionId()),
      compactPrompt: sharedState.compactPrompt,
      isSubagent: isSubagentView,
    });
    if (configured && (state.consecutiveSnapshotFailures >= 2 || (snap && !api.isConnected()))) {
      barView.setReconnecting();
    }
    if (isRemoteWeb) {
      syncRemoteConnectionPanel(false);
    }
    popoverView.renderSnapshotDetails(snap);
    if (snap) {
      syncLimitControls(false);
      // A-3: Surface newly observed auto-compaction failure instead of hiding it silently
      const autoErr = snap.compaction?.lastError;
      if (autoErr && typeof autoErr.at === 'number' && autoErr.at > state.lastAutoErrAt) {
        state.lastAutoErrAt = autoErr.at;
        showNote(
          i18n.formatTemplate(i18n.t().autoCompactError, {
            msg: autoErr.message || autoErr.code || 'Error',
          }),
          6000,
        );
      }
    }
    barView.renderQuota(sharedState.quotaState, state.snapshot?.modelName || '');
    if (globalModalView && state.modalOpen) {
      renderGlobalModal(false);
    }
  }

  function renderGlobalModal(syncDefaultInputs = false) {
    if (!globalModalView) return;
    const sessionOverrideLimit = getSavedLimitForScope('session');
    globalModalView.render({
      defaultCustomLimit:
        typeof sharedState.defaultCustomLimit === 'number' ? sharedState.defaultCustomLimit : null,
      modelLimits: Array.isArray(sharedState.modelLimits) ? sharedState.modelLimits : [],
      currentModelName: state.snapshot?.modelName || '',
      sessionOverrideLimit,
      syncDefaultInputs,
      onEditModel(item) {
        globalModalView.modelNameInput.value = item.model;
        globalModalView.modelLimitInput.value = String(item.limit);
        globalModalView.modelPresetSelect.value = PRESETS.includes(item.limit)
          ? String(item.limit)
          : '';
        try {
          globalModalView.modelLimitInput.focus();
        } catch {}
      },
      onRemoveModel(modelName) {
        handleSaveModelLimit(modelName, null);
      },
    });
  }

  function finalizeModalClosed(returnFocus = true) {
    if (state.modalBackdropListener && state.modalPortalHandle?.element) {
      try {
        state.modalPortalHandle.element.removeEventListener('click', state.modalBackdropListener);
      } catch {}
    }
    state.modalBackdropListener = null;
    state.modalPortalHandle = null;
    state.modalOpen = false;
    if (hasModalPortal && globalModalView && globalModalView.dialogEl) {
      try {
        globalModalView.dialogEl.remove();
      } catch {}
    }
    if (returnFocus && !state.disposed) {
      try {
        (state.modalTriggerEl || barView.settingsBtn).focus();
      } catch {}
    }
  }

  function openGlobalModal(triggerEl) {
    if (!globalModalView) return;
    // ISS-10: Always restore focus to a visible bar trigger (never a detached popover button)
    const isVisibleBarTrigger =
      triggerEl === barView.settingsBtn || triggerEl === barView.ctxBtn;
    state.modalTriggerEl = isVisibleBarTrigger ? triggerEl : barView.settingsBtn;
    setPopoverOpen(false);

    if (hasModalPortal) {
      if (!state.modalPortalHandle) {
        const handle = portalHost.openModal({
          onClose: finalizeModalClosed,
        });
        if (!handle) return;
        state.modalPortalHandle = handle;
        applyModalPortalLayout(handle.element);
        const onDialogBackdropClick = (e) => {
          if (e && e.target === handle.element) {
            closeGlobalModal(true);
          }
        };
        if (handle.element && typeof handle.element.addEventListener === 'function') {
          handle.element.addEventListener('click', onDialogBackdropClick);
          state.modalBackdropListener = onDialogBackdropClick;
        }
        if (typeof portalHost.syncStyle === 'function') {
          portalHost.syncStyle('modal');
        }
        const mountTarget = handle.bodyEl || handle.element;
        if (mountTarget && globalModalView.dialogEl.parentNode !== mountTarget) {
          mountTarget.appendChild(globalModalView.dialogEl);
        }
      }
      state.modalOpen = true;
      showModalFeedback('', false);
      renderGlobalModal(true);
      try {
        globalModalView.defaultInput.focus();
      } catch {}
      return;
    }

    state.modalOpen = true;
    showModalFeedback('', false);
    renderGlobalModal(true);
    globalModalView.setVisible(true);
    try {
      globalModalView.defaultInput.focus();
    } catch {}
  }

  function closeGlobalModal(returnFocus = true) {
    if (!globalModalView || !state.modalOpen) return;
    if (hasModalPortal && state.modalPortalHandle) {
      const handle = state.modalPortalHandle;
      try {
        handle.close();
      } catch {}
      if (state.modalOpen) {
        finalizeModalClosed();
      }
      if (returnFocus) {
        try {
          (state.modalTriggerEl || barView.settingsBtn).focus();
        } catch {}
      }
      return;
    }
    state.modalOpen = false;
    globalModalView.setVisible(false);
    if (returnFocus) {
      try {
        (state.modalTriggerEl || barView.settingsBtn).focus();
      } catch {}
    }
  }

  async function refreshSnapshot({ waitForFresh = false } = {}) {
    if (state.disposed) return;
    if (!isApiConfigured()) {
      if (state.snapshot !== null) {
        state.snapshot = null;
        render();
      }
      return;
    }
    const sid = getSessionId();
    if (!sid) {
      const hadState = Boolean(state.lastSessionId || state.snapshot !== null || state.inFlight);
      if (hadState) {
        state.epoch += 1;
        if (state.abortCtrl) {
          try {
            state.abortCtrl.abort();
          } catch {}
          state.abortCtrl = null;
        }
        state.inFlight = false;
        state.inFlightPromise = null;
        state.pendingRefresh = false;
        state.lastSessionId = '';
        state.snapshot = null;
        state.limitDirty = false;
        state.syncedLimitKey = '';
        render();
      }
      return;
    }
    const sessionChanged = Boolean(state.lastSessionId && state.lastSessionId !== sid);
    if (sessionChanged) {
      state.snapshot = null;
      state.limitDirty = false;
      state.syncedLimitKey = '';
      render();
      if (state.abortCtrl) state.abortCtrl.abort();
    } else if (state.inFlight) {
      state.pendingRefresh = true;
      if (waitForFresh && state.inFlightPromise) {
        // G-1: Wait for the in-flight poll to finish AND await the fresh post-update snapshot
        await state.inFlightPromise;
        if (!state.disposed && state.inFlightPromise) {
          await state.inFlightPromise;
        }
      }
      return;
    }
    state.lastSessionId = sid;
    state.inFlight = true;
    state.pendingRefresh = false;
    const reqEpoch = ++state.epoch;
    state.abortCtrl = new AbortController();
    const runPromise = (async () => {
      try {
        const snap = await api.post('/api/snapshot', { sessionId: sid }, state.abortCtrl.signal);
        if (state.disposed || reqEpoch !== state.epoch) return;
        if (getSessionId() !== sid) return;
        if (snap && typeof snap.sessionId === 'string' && snap.sessionId && snap.sessionId !== sid) {
          return;
        }
        state.consecutiveSnapshotFailures = 0;
        state.lastConnectionError = null;
        state.snapshot = snap;
        render();
      } catch (err) {
        if (state.disposed || err?.name === 'AbortError' || err?.message === 'aborted') return;
        state.consecutiveSnapshotFailures += 1;
        state.lastConnectionError = err;
        if (!state.snapshot || state.consecutiveSnapshotFailures >= 2 || !api.isConnected()) {
          barView.setReconnecting();
        }
        if (isRemoteWeb) {
          syncRemoteConnectionPanel(false);
        }
      } finally {
        if (reqEpoch === state.epoch) {
          state.inFlight = false;
          state.inFlightPromise = null;
          if (state.pendingRefresh && !state.disposed) {
            state.pendingRefresh = false;
            refreshSnapshot();
          }
        }
      }
    })();
    state.inFlightPromise = runPromise;
    await runPromise;
  }

  async function handleCompact() {
    const sid = getSessionId();
    if (!sid || state.compacting || state.snapshot?.compaction?.inProgress) return;
    state.compacting = true;
    barView.compactBtn.disabled = true;
    render();
    try {
      await api.post('/api/compact', { sessionId: sid });
      showNote(i18n.t().compactSent);
      if (typeof onBurstRequested === 'function') onBurstRequested();
      refreshSnapshot();
    } catch (err) {
      showNote(
        err?.code === 'COMPACTION_IN_PROGRESS' ? i18n.t().compactInProgress : i18n.t().compactFail,
      );
    } finally {
      state.compacting = false;
      render();
    }
  }

  async function handleApplyLimit() {
    const tr = i18n.t();
    const parsedLimit = parseStrictLimitInput(popoverView.customInput, { allowBlank: true });
    if (!parsedLimit.ok) {
      showFeedback(tr.invalidLimit, true);
      return;
    }
    const limitVal = parsedLimit.value;
    const scope = popoverView.scopeSelect.value === 'default' ? 'default' : 'session';
    const sid = getSessionId();
    if (scope === 'session' && !sid) {
      showFeedback(tr.noActiveSession, true);
      return;
    }
    const payload =
      scope === 'default'
        ? { defaultCustomLimit: limitVal }
        : { sessionLimit: { sessionId: sid, limit: limitVal } };
    try {
      const updated = await api.post('/api/settings/update', payload);
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.limitDirty = false;
      state.syncedLimitKey = '';
      await refreshSnapshot({ waitForFresh: true });
      syncLimitControls(true);
      const hostMax = state.snapshot?.maxContextTokens || 0;
      const sessionOverrideVal = getSavedLimitForScope('session');
      if (scope === 'default' && limitVal !== null && typeof sessionOverrideVal === 'number') {
        showFeedback(
          i18n.formatTemplate(tr.appliedMaskedBySession, {
            val: i18n.formatTokens(limitVal),
            sessionVal: i18n.formatTokens(sessionOverrideVal),
          }),
          false,
        );
      } else if (limitVal !== null && hostMax > 0 && limitVal > hostMax) {
        showFeedback(
          i18n.formatTemplate(tr.appliedClamped, {
            val: i18n.formatTokens(limitVal),
            max: i18n.formatTokens(hostMax),
          }),
          false,
        );
      } else {
        showFeedback(tr.applied, false);
      }
    } catch (err) {
      showFeedback(err?.message || 'Error', true);
    }
  }

  async function handleSaveGlobalDefault(rawInputValue) {
    const tr = i18n.t();
    const parsedLimit = parseStrictLimitInput(rawInputValue, { allowBlank: true });
    if (!parsedLimit.ok) {
      showModalFeedback(tr.invalidLimit, true);
      return;
    }
    const limitVal = parsedLimit.value;
    try {
      const updated = await api.post('/api/settings/update', { defaultCustomLimit: limitVal });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.limitDirty = false;
      state.syncedLimitKey = '';
      await refreshSnapshot({ waitForFresh: true });
      syncLimitControls(true);
      renderGlobalModal(true);
      const sessionOverrideVal = getSavedLimitForScope('session');
      if (limitVal !== null && typeof sessionOverrideVal === 'number') {
        showModalFeedback(
          i18n.formatTemplate(tr.appliedMaskedBySession, {
            val: i18n.formatTokens(limitVal),
            sessionVal: i18n.formatTokens(sessionOverrideVal),
          }),
          false,
        );
      } else {
        showModalFeedback(tr.applied, false);
      }
    } catch (err) {
      showModalFeedback(err?.message || 'Error', true);
    }
  }

  async function handleSaveModelLimit(rawModelName, rawLimitValue) {
    const tr = i18n.t();
    const model = String(rawModelName || '').trim();
    if (!model || model.length > 128) {
      showModalFeedback(tr.invalidModelName, true);
      return;
    }
    let limitVal = null;
    if (rawLimitValue !== null) {
      const parsedLimit = parseStrictLimitInput(rawLimitValue, { allowBlank: false });
      if (!parsedLimit.ok) {
        showModalFeedback(tr.invalidLimit, true);
        return;
      }
      limitVal = parsedLimit.value;
    }
    try {
      const updated = await api.post('/api/settings/update', {
        modelLimit: { model, limit: limitVal },
      });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.limitDirty = false;
      state.syncedLimitKey = '';
      await refreshSnapshot({ waitForFresh: true });
      syncLimitControls(true);
      if (globalModalView && limitVal !== null) {
        globalModalView.modelNameInput.value = '';
        globalModalView.modelLimitInput.value = '';
        globalModalView.modelPresetSelect.value = '';
      }
      renderGlobalModal(false);
      showModalFeedback(tr.applied, false);
    } catch (err) {
      showModalFeedback(err?.message || 'Error', true);
    }
  }

  async function handleClearCurrentSessionLimit() {
    const tr = i18n.t();
    const sid = getSessionId();
    if (!sid) {
      showModalFeedback(tr.noActiveSession, true);
      return;
    }
    try {
      const updated = await api.post('/api/settings/update', {
        sessionLimit: { sessionId: sid, limit: null },
      });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.limitDirty = false;
      state.syncedLimitKey = '';
      await refreshSnapshot({ waitForFresh: true });
      syncLimitControls(true);
      renderGlobalModal(false);
      showModalFeedback(tr.applied, false);
    } catch (err) {
      showModalFeedback(err?.message || 'Error', true);
    }
  }

  async function handleToggleAutoCompact() {
    const next = !sharedState.autoCompactEnabled;
    sharedState.autoCompactEnabled = next;
    render();
    try {
      const updated = await api.post('/api/settings/update', { autoCompact: next });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      showFeedback(i18n.t().applied, false);
    } catch (err) {
      sharedState.autoCompactEnabled = !next;
      render();
      showFeedback(err?.message || 'Error', true);
    }
  }

  async function saveCompactPromptValue(rawValue) {
    const nextPrompt = String(rawValue || '').trim();
    try {
      const updated = await api.post('/api/settings/update', { compactPrompt: nextPrompt });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      sharedState.compactPrompt =
        typeof updated?.compactPrompt === 'string' ? updated.compactPrompt : nextPrompt;
      state.promptDirty = false;
      state.syncedPromptVal = sharedState.compactPrompt;
      popoverView.compactPromptInput.value = sharedState.compactPrompt;
      popoverView.updatePromptCount();
      render();
      showFeedback(i18n.t().applied, false);
    } catch (err) {
      showFeedback(err?.message || 'Error', true);
    }
  }

  async function applyLocale(next) {
    if (next !== 'ko' && next !== 'en') return;
    i18n.setLocale(next);
    render();
    try {
      const updated = await api.post('/api/settings/update', { locale: next });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
    } catch {}
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (state.modalOpen) {
        // When host v2 ModalPortal owns the modal, host capture-phase Escape closes it (LIFO).
        if (state.modalPortalHandle) return;
        closeGlobalModal(true);
        return;
      }
      if (state.popOpen) {
        if (state.popoverPortalHandle) return;
        setPopoverOpen(false);
        try {
          (state.lastTriggerEl || barView.settingsBtn).focus();
        } catch {}
      }
    }
  };
  const onDocPointerDown = (e) => {
    if (!state.popOpen || state.popoverPortalHandle) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const target = e.target;
    if (
      path.includes(popoverView.popEl) ||
      path.includes(barView.settingsBtn) ||
      path.includes(barView.ctxBtn) ||
      popoverView.popEl.contains(target) ||
      barView.settingsBtn.contains(target) ||
      barView.ctxBtn.contains(target)
    ) {
      return;
    }
    setPopoverOpen(false);
  };
  const onInputKeyDown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyLimit();
    }
  };
  const onPresetChange = () => {
    state.limitDirty = true;
    popoverView.customInput.value = popoverView.presetSelect.value;
    showFeedback('', false);
  };
  const onCustomInput = () => {
    state.limitDirty = true;
    const raw = popoverView.customInput.value.replace(/[\s,]/g, '').trim();
    const parsed = raw ? Number(raw) : NaN;
    popoverView.presetSelect.value = PRESETS.includes(parsed) ? String(parsed) : '';
    showFeedback('', false);
  };
  const onScopeChange = () => {
    // G-1: Preserve a valid in-progress numeric entry when switching scope before clicking Apply;
    // discard invalid/blank inputs so target scope's saved limit loads cleanly.
    if (
      state.limitDirty &&
      parseStrictLimitInput(popoverView.customInput.value, { allowBlank: false }).ok
    ) {
      showFeedback('', false);
      return;
    }
    state.limitDirty = false;
    state.syncedLimitKey = '';
    showFeedback('', false);
    syncLimitControls(true);
  };
  const onPromptInput = () => {
    state.promptDirty = true;
    popoverView.updatePromptCount();
    showFeedback('', false);
  };
  const onPromptKeyDown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveCompactPromptValue(popoverView.compactPromptInput.value);
    }
  };
  const onTabKeyDown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = state.activeTab === 'context' ? 'settings' : 'context';
      setActiveTab(next);
      try {
        (next === 'context' ? popoverView.tabContextBtn : popoverView.tabSettingsBtn).focus();
      } catch {}
    }
  };

  async function handleRemoteConnect() {
    if (!isRemoteWeb || typeof onRemoteConnectionSave !== 'function') return;
    const tr = i18n.t();
    const baseUrl = popoverView.remoteUrlInput ? popoverView.remoteUrlInput.value.trim() : '';
    const token = popoverView.remoteTokenInput ? popoverView.remoteTokenInput.value.trim() : '';
    try {
      const result = await onRemoteConnectionSave({ baseUrl, token });
      state.remoteUrlDirty = false;
      if (result && result.ok) {
        state.consecutiveSnapshotFailures = 0;
        state.lastConnectionError = null;
        if (popoverView.remoteTokenInput) popoverView.remoteTokenInput.value = '';
        showFeedback(
          i18n.formatTemplate(tr.remoteConnected, { url: result.baseUrl || baseUrl }),
          false,
        );
      } else if (result && result.code === 'ERR_INVALID_ENDPOINT_URL') {
        showFeedback(tr.remoteInvalidUrl, true);
      } else if (result && result.code === 'ERR_INVALID_SIDECAR_TOKEN') {
        showFeedback(tr.remoteInvalidToken, true);
      } else if (result && (result.status === 401 || result.status === 403)) {
        state.lastConnectionError = { status: result.status };
        showFeedback(i18n.formatTemplate(tr.remoteAuthFailed, { status: result.status }), true);
      } else if (result && result.code === 'ERR_SAVE_SETTINGS_FAILED') {
        showFeedback(
          i18n.formatTemplate(tr.remoteSaveFailed, { reason: result.reason || 'Error' }),
          true,
        );
      } else {
        state.lastConnectionError = new Error(result?.message || 'unreachable');
        showFeedback(tr.remoteUnreachable, true);
      }
      render();
    } catch (err) {
      state.lastConnectionError = err;
      showFeedback(err?.message || tr.remoteUnreachable, true);
      render();
    }
  }

  async function handleRemoteDisconnect() {
    if (!isRemoteWeb || typeof onRemoteConnectionClear !== 'function') return;
    const tr = i18n.t();
    try {
      await onRemoteConnectionClear();
      state.remoteUrlDirty = false;
      if (popoverView.remoteUrlInput) popoverView.remoteUrlInput.value = '';
      if (popoverView.remoteTokenInput) popoverView.remoteTokenInput.value = '';
      resetConnectionState();
      showFeedback(tr.remoteDisconnectedSaved, false);
    } catch (err) {
      showFeedback(err?.message || 'Error', true);
    }
  }

  barView.ctxBtn.addEventListener('click', () => {
    const preferredTab = isRemoteWeb && !isApiConfigured() ? 'settings' : 'context';
    if (state.popOpen && state.activeTab === preferredTab) {
      setPopoverOpen(false);
    } else {
      setPopoverOpen(true, preferredTab, barView.ctxBtn);
      if (preferredTab === 'settings' && isRemoteWeb) {
        syncRemoteConnectionPanel(true);
      }
    }
  });
  barView.settingsBtn.addEventListener('click', () => {
    if (state.popOpen && state.activeTab === 'settings') {
      setPopoverOpen(false);
    } else {
      setPopoverOpen(true, 'settings', barView.settingsBtn);
    }
  });
  popoverView.tabContextBtn.addEventListener('click', () => setActiveTab('context'));
  popoverView.tabSettingsBtn.addEventListener('click', () => setActiveTab('settings'));
  popoverView.tabContextBtn.addEventListener('keydown', onTabKeyDown);
  popoverView.tabSettingsBtn.addEventListener('keydown', onTabKeyDown);
  popoverView.closeBtn.addEventListener('click', () => {
    setPopoverOpen(false);
    try {
      (state.lastTriggerEl || barView.settingsBtn).focus();
    } catch {}
  });
  barView.compactBtn.addEventListener('click', handleCompact);
  popoverView.applyBtn.addEventListener('click', handleApplyLimit);
  popoverView.autoCompactBtn.addEventListener('click', handleToggleAutoCompact);
  popoverView.autoCompactStateText.addEventListener('click', handleToggleAutoCompact);
  popoverView.compactPromptSaveBtn.addEventListener('click', () =>
    saveCompactPromptValue(popoverView.compactPromptInput.value),
  );
  popoverView.compactPromptResetBtn.addEventListener('click', () => {
    popoverView.compactPromptInput.value = '';
    popoverView.updatePromptCount();
    saveCompactPromptValue('');
  });
  popoverView.compactPromptInput.addEventListener('input', onPromptInput);
  popoverView.compactPromptInput.addEventListener('keydown', onPromptKeyDown);
  popoverView.langSelect.addEventListener('change', () => applyLocale(popoverView.langSelect.value));
  popoverView.scopeSelect.addEventListener('change', onScopeChange);
  popoverView.presetSelect.addEventListener('change', onPresetChange);
  popoverView.customInput.addEventListener('input', onCustomInput);
  popoverView.customInput.addEventListener('keydown', onInputKeyDown);
  if (isRemoteWeb && popoverView.remoteConnectBtn) {
    popoverView.remoteConnectBtn.addEventListener('click', handleRemoteConnect);
  }
  if (isRemoteWeb && popoverView.remoteDisconnectBtn) {
    popoverView.remoteDisconnectBtn.addEventListener('click', handleRemoteDisconnect);
  }
  if (isRemoteWeb && popoverView.remoteUrlInput) {
    popoverView.remoteUrlInput.addEventListener('input', () => {
      state.remoteUrlDirty = true;
      showFeedback('', false);
    });
    popoverView.remoteUrlInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRemoteConnect();
      }
    });
  }
  if (isRemoteWeb && popoverView.remoteTokenInput) {
    popoverView.remoteTokenInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRemoteConnect();
      }
    });
  }
  if (popoverView.openGlobalModalBtn) {
    popoverView.openGlobalModalBtn.addEventListener('click', () =>
      openGlobalModal(popoverView.openGlobalModalBtn),
    );
  }
  if (popoverView.openGlobalModalSettingsBtn) {
    popoverView.openGlobalModalSettingsBtn.addEventListener('click', () =>
      openGlobalModal(popoverView.openGlobalModalSettingsBtn),
    );
  }
  if (globalModalView) {
    globalModalView.closeBtn.addEventListener('click', () => closeGlobalModal(true));
    globalModalView.backdropEl.addEventListener('click', (e) => {
      if (e.target === globalModalView.backdropEl) closeGlobalModal(true);
    });
    globalModalView.clearSessionLimitBtn.addEventListener('click', handleClearCurrentSessionLimit);
    globalModalView.defaultPresetSelect.addEventListener('change', () => {
      globalModalView.defaultInput.value = globalModalView.defaultPresetSelect.value;
      showModalFeedback('', false);
    });
    globalModalView.defaultInput.addEventListener('input', () => {
      const raw = globalModalView.defaultInput.value.replace(/[\s,]/g, '').trim();
      const parsed = raw ? Number(raw) : NaN;
      globalModalView.defaultPresetSelect.value = PRESETS.includes(parsed) ? String(parsed) : '';
      showModalFeedback('', false);
    });
    globalModalView.defaultInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSaveGlobalDefault(globalModalView.defaultInput.value);
      }
    });
    globalModalView.defaultApplyBtn.addEventListener('click', () =>
      handleSaveGlobalDefault(globalModalView.defaultInput.value),
    );
    globalModalView.defaultResetBtn.addEventListener('click', () => {
      globalModalView.defaultInput.value = '';
      globalModalView.defaultPresetSelect.value = '';
      handleSaveGlobalDefault('');
    });
    globalModalView.useCurrentModelBtn.addEventListener('click', () => {
      const curModel = state.snapshot?.modelName || '';
      if (curModel) {
        globalModalView.modelNameInput.value = curModel;
        try {
          globalModalView.modelLimitInput.focus();
        } catch {}
      }
    });
    globalModalView.modelPresetSelect.addEventListener('change', () => {
      globalModalView.modelLimitInput.value = globalModalView.modelPresetSelect.value;
      showModalFeedback('', false);
    });
    globalModalView.modelLimitInput.addEventListener('input', () => {
      const raw = globalModalView.modelLimitInput.value.replace(/[\s,]/g, '').trim();
      const parsed = raw ? Number(raw) : NaN;
      globalModalView.modelPresetSelect.value = PRESETS.includes(parsed) ? String(parsed) : '';
      showModalFeedback('', false);
    });
    globalModalView.modelLimitInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSaveModelLimit(
          globalModalView.modelNameInput.value,
          globalModalView.modelLimitInput.value,
        );
      }
    });
    globalModalView.modelSaveBtn.addEventListener('click', () =>
      handleSaveModelLimit(
        globalModalView.modelNameInput.value,
        globalModalView.modelLimitInput.value,
      ),
    );
  }
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('pointerdown', onDocPointerDown);

  function setTargetView(viewEl) {
    const nextView = viewEl || null;
    const prevView = state.viewEl;
    state.viewEl = nextView;
    const nextSid = getSessionId();
    if (prevView === nextView && nextSid === state.lastSessionId) return;
    refreshSnapshot();
  }

  function resetConnectionState() {
    if (state.abortCtrl) {
      try {
        state.abortCtrl.abort();
      } catch {}
      state.abortCtrl = null;
    }
    state.snapshot = null;
    state.consecutiveSnapshotFailures = 0;
    state.lastConnectionError = null;
    sharedState.quotaState = null;
    render();
  }

  function destroy() {
    if (state.disposed) return;
    state.disposed = true;
    if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
    if (state.modalFeedbackTimer) clearTimeout(state.modalFeedbackTimer);
    if (state.noteTimer) clearTimeout(state.noteTimer);
    if (state.abortCtrl) state.abortCtrl.abort();
    if (state.modalPortalHandle) {
      try {
        state.modalPortalHandle.close();
      } catch {}
      finalizeModalClosed();
    }
    if (state.popoverPortalHandle) {
      try {
        state.popoverPortalHandle.close();
      } catch {}
      finalizePopoverClosed();
    }
    detachPopoverResizeListener();
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('pointerdown', onDocPointerDown);
    try {
      barView.barEl.remove();
    } catch {}
  }

  render();

  return Object.freeze({
    rootEl: barView.barEl,
    setTargetView,
    hasExplicitSessionId,
    render,
    refreshSnapshot,
    resetConnectionState,
    destroy,
  });
}
