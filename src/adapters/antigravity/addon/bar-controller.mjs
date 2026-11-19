/**
 * Stateful inline statusbar + popover controller (SRP / DIP).
 * Depends exclusively on injected abstractions (`api`, `i18n`, `addons`, `barView`, `popoverView`).
 */

export function createBarController({
  doc,
  api,
  i18n,
  addons,
  barView,
  popoverView,
  sharedState,
  onSettingsChanged,
  onBurstRequested,
  presets,
}) {
  const PRESETS = Array.isArray(presets) && presets.length > 0
    ? presets
    : [32000, 64000, 128000, 200000, 256000, 384000, 512000, 980000];

  barView.barEl.appendChild(popoverView.popEl);

  const state = {
    disposed: false,
    viewEl: null,
    popOpen: false,
    activeTab: 'context',
    lastTriggerEl: barView.settingsBtn,
    feedbackTimer: null,
    noteTimer: null,
    lastSessionId: '',
    snapshot: null,
    epoch: 0,
    abortCtrl: null,
    inFlight: false,
    pendingRefresh: false,
    compacting: false,
    limitDirty: false,
    promptDirty: false,
    lastAddonsKey: '',
    syncedLimitKey: '',
    syncedPromptVal: null,
  };

  function getSessionId() {
    if (state.viewEl && typeof state.viewEl.getAttribute === 'function') {
      const attr = state.viewEl.getAttribute('data-cascade-id') || '';
      if (attr && attr !== 'remote-session') return attr;
    }
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
        doc.activeElement === popoverView.customInput ||
        doc.activeElement === popoverView.presetSelect
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
      if (doc.activeElement === popoverView.compactPromptInput) return;
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

  function setPopoverOpen(open, tab, triggerEl) {
    const nextOpen = Boolean(open);
    const wasOpen = state.popOpen;
    if (triggerEl) state.lastTriggerEl = triggerEl;
    if (tab) setActiveTab(tab);
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
      onRuntimeClick(rtDef, btnEl) {
        try {
          rtDef.onClick({ sessionId: getSessionId(), barEl: barView.barEl, buttonEl: btnEl });
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

    barView.renderSnapshot({
      snap,
      connected: api.isConnected(),
      compacting: state.compacting,
      hasSession: Boolean(getSessionId()),
      compactPrompt: sharedState.compactPrompt,
    });
    popoverView.renderSnapshotDetails(snap);
    if (snap) {
      syncLimitControls(false);
    }
    barView.renderQuota(sharedState.quotaState);
  }

  async function refreshSnapshot() {
    if (state.disposed) return;
    const sid = getSessionId();
    if (!sid) return;
    const sessionChanged = Boolean(state.lastSessionId && state.lastSessionId !== sid);
    if (sessionChanged) {
      state.snapshot = null;
      state.limitDirty = false;
      state.syncedLimitKey = '';
      render();
      if (state.abortCtrl) state.abortCtrl.abort();
    } else if (state.inFlight) {
      state.pendingRefresh = true;
      return;
    }
    state.lastSessionId = sid;
    state.inFlight = true;
    state.pendingRefresh = false;
    const reqEpoch = ++state.epoch;
    state.abortCtrl = new AbortController();
    try {
      const snap = await api.post('/api/snapshot', { sessionId: sid }, state.abortCtrl.signal);
      if (state.disposed || reqEpoch !== state.epoch) return;
      state.snapshot = snap;
      render();
    } catch (err) {
      if (state.disposed || err?.name === 'AbortError' || err?.message === 'aborted') return;
      if (!state.snapshot) {
        barView.setReconnecting();
      }
    } finally {
      if (reqEpoch === state.epoch) {
        state.inFlight = false;
        if (state.pendingRefresh && !state.disposed) {
          state.pendingRefresh = false;
          refreshSnapshot();
        }
      }
    }
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
    const raw = popoverView.customInput.value.replace(/[\s,]/g, '').trim();
    let limitVal = null;
    if (raw !== '') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 32000 || parsed > 980000) {
        showFeedback(tr.invalidLimit, true);
        return;
      }
      limitVal = Math.round(parsed);
    }
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
      await refreshSnapshot();
      syncLimitControls(true);
      const hostMax = state.snapshot?.maxContextTokens || 0;
      if (limitVal !== null && hostMax > 0 && limitVal > hostMax) {
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
    if (e.key === 'Escape' && state.popOpen) {
      setPopoverOpen(false);
      try {
        (state.lastTriggerEl || barView.settingsBtn).focus();
      } catch {}
    }
  };
  const onDocPointerDown = (e) => {
    if (!state.popOpen) return;
    const target = e.target;
    if (
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

  barView.ctxBtn.addEventListener('click', () => {
    if (state.popOpen && state.activeTab === 'context') {
      setPopoverOpen(false);
    } else {
      setPopoverOpen(true, 'context', barView.ctxBtn);
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
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('pointerdown', onDocPointerDown);

  function setTargetView(viewEl) {
    if (state.viewEl === viewEl) return;
    state.viewEl = viewEl || null;
    refreshSnapshot();
  }

  function destroy() {
    if (state.disposed) return;
    state.disposed = true;
    if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
    if (state.noteTimer) clearTimeout(state.noteTimer);
    if (state.abortCtrl) state.abortCtrl.abort();
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
    render,
    refreshSnapshot,
    destroy,
  });
}
