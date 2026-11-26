/**
 * Stateful AddonContextV3 statusbar controller (SRP / DIP).
 *
 * API-First 3-Tier Design:
 * - Zero manual overlay DOM construction, coordinate math, resize listeners, or manual Escape/outside-click handling.
 * - Context details & session limit popup -> Tier 2 `hostPort.openPopup({ placement: { zone: 'anchor', ... }, tree, state })`
 * - Global context limits modal -> Tier 2 `hostPort.openModal({ placement: { zone: 'surface-center', ... }, tree, state })`
 * - Settings UI (Desktop + Remote Web unified) -> Tier 1 `hostPort.registerSettingsPage(...)`
 * - Transient notifications -> Tier 1 `hostPort.showToast(...)` (plus inline bar status note fallback)
 * - In-place ID-based DOM patching via `handle.update(nextTree, nextState)` preserves focused inputs across 1s polls.
 */

export function createBarController({
  api,
  i18n,
  addons,
  barView,
  uiSchemas,
  hostPort,
  sharedState,
  isRemoteWeb = false,
  onSettingsChanged,
  onBurstRequested,
  onRemoteConnectionSave = null,
  onRemoteConnectionClear = null,
  presets,
}) {
  const PRESETS =
    Array.isArray(presets) && presets.length > 0
      ? presets
      : [32000, 64000, 128000, 200000, 256000, 384000, 512000, 980000];

  const state = {
    disposed: false,
    viewEl: null,
    contextPopupHandle: null,
    globalModalHandle: null,
    settingsPageHandle: null,
    settingsPageOpen: false,
    noteTimer: null,
    popupFeedbackTimer: null,
    modalFeedbackTimer: null,
    settingsFeedbackTimer: null,
    lastSessionId: '',
    snapshot: null,
    epoch: 0,
    abortCtrl: null,
    inFlight: false,
    inFlightPromise: null,
    pendingRefresh: false,
    compacting: false,
    lastAddonsKey: '',
    lastAutoErrAt: 0,
    consecutiveSnapshotFailures: 0,
    lastConnectionError: null,
    // Controlled Tier-2 declarative form drafts (preserved across live poll updates)
    popupDraft: {
      scope: 'session',
      preset: '',
      customLimit: '',
      dirty: false,
      syncedKey: '',
      feedback: '',
      feedbackIsErr: false,
    },
    modalDraft: {
      defaultPreset: '',
      defaultLimitInput: '',
      defaultDirty: false,
      modelNameInput: '',
      modelPreset: '',
      modelLimitInput: '',
      feedback: '',
      feedbackIsErr: false,
    },
    settingsDraft: {
      remoteUrl: '',
      remoteUrlDirty: false,
      remoteToken: '',
      compactPrompt: '',
      promptDirty: false,
      syncedPromptVal: null,
      feedback: '',
      feedbackIsErr: false,
    },
  };

  function isApiConfigured() {
    return typeof api.isConfigured === 'function' ? Boolean(api.isConfigured()) : true;
  }

  function getApiBaseUrl() {
    return typeof api.getBaseUrl === 'function' ? api.getBaseUrl() : '';
  }

  function emitToast(message, variant = 'info', durationMs = 3500) {
    if (!message || state.disposed) return;
    if (hostPort && typeof hostPort.showToast === 'function') {
      try {
        hostPort.showToast({ message, variant, durationMs });
      } catch {}
    }
  }

  function showNote(text, durationMs = 4000, toastVariant = null) {
    if (state.noteTimer) {
      clearTimeout(state.noteTimer);
      state.noteTimer = null;
    }
    barView.setNote(text);
    if (text && toastVariant) {
      emitToast(text, toastVariant, durationMs);
    }
    if (text && durationMs > 0) {
      state.noteTimer = setTimeout(() => {
        state.noteTimer = null;
        if (!state.disposed) barView.setNote('');
      }, durationMs);
    }
  }

  function setPopupFeedback(text, isErr = false) {
    if (state.popupFeedbackTimer) {
      clearTimeout(state.popupFeedbackTimer);
      state.popupFeedbackTimer = null;
    }
    state.popupDraft.feedback = text || '';
    state.popupDraft.feedbackIsErr = Boolean(isErr);
    if (text) {
      emitToast(text, isErr ? 'danger' : 'success', 3500);
      state.popupFeedbackTimer = setTimeout(() => {
        state.popupFeedbackTimer = null;
        if (!state.disposed) {
          state.popupDraft.feedback = '';
          state.popupDraft.feedbackIsErr = false;
          updateContextPopupInPlace();
        }
      }, 3500);
    }
    updateContextPopupInPlace();
  }

  function setModalFeedback(text, isErr = false) {
    if (state.modalFeedbackTimer) {
      clearTimeout(state.modalFeedbackTimer);
      state.modalFeedbackTimer = null;
    }
    state.modalDraft.feedback = text || '';
    state.modalDraft.feedbackIsErr = Boolean(isErr);
    if (text) {
      emitToast(text, isErr ? 'danger' : 'success', 4000);
      state.modalFeedbackTimer = setTimeout(() => {
        state.modalFeedbackTimer = null;
        if (!state.disposed) {
          state.modalDraft.feedback = '';
          state.modalDraft.feedbackIsErr = false;
          updateGlobalModalInPlace();
        }
      }, 4000);
    }
    updateGlobalModalInPlace();
  }

  function setSettingsFeedback(text, isErr = false) {
    if (state.settingsFeedbackTimer) {
      clearTimeout(state.settingsFeedbackTimer);
      state.settingsFeedbackTimer = null;
    }
    state.settingsDraft.feedback = text || '';
    state.settingsDraft.feedbackIsErr = Boolean(isErr);
    if (text) {
      emitToast(text, isErr ? 'danger' : 'success', 3500);
      state.settingsFeedbackTimer = setTimeout(() => {
        state.settingsFeedbackTimer = null;
        if (!state.disposed) {
          state.settingsDraft.feedback = '';
          state.settingsDraft.feedbackIsErr = false;
          updateSettingsPageInPlace();
        }
      }, 3500);
    }
    updateSettingsPageInPlace();
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
    if (isIsolatedSubagentView(state.viewEl)) return '';
    return sharedState.fallbackSessionId || '';
  }

  function parseStrictLimitInput(rawValue, { allowBlank = true } = {}) {
    const raw = String(rawValue ?? '').replace(/[\s,]/g, '').trim();
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

  function syncPopupLimitDraft(force = false) {
    const scope = state.popupDraft.scope === 'default' ? 'default' : 'session';
    const sid = getSessionId();
    const savedVal = getSavedLimitForScope(scope);
    const nextKey = `${sid}:${scope}:${savedVal === null ? 'null' : savedVal}`;
    if (!force && (state.popupDraft.dirty || state.popupDraft.syncedKey === nextKey)) {
      return;
    }
    state.popupDraft.syncedKey = nextKey;
    state.popupDraft.dirty = false;
    const strVal = savedVal !== null ? String(savedVal) : '';
    state.popupDraft.customLimit = strVal;
    state.popupDraft.preset = savedVal !== null && PRESETS.includes(savedVal) ? strVal : '';
  }

  function syncModalDefaultDraft(force = false) {
    if (!force && state.modalDraft.defaultDirty) return;
    const defVal = typeof sharedState.defaultCustomLimit === 'number' ? sharedState.defaultCustomLimit : null;
    const strVal = defVal !== null ? String(defVal) : '';
    state.modalDraft.defaultLimitInput = strVal;
    state.modalDraft.defaultPreset = defVal !== null && PRESETS.includes(defVal) ? strVal : '';
    state.modalDraft.defaultDirty = false;
  }

  function syncSettingsDraft(force = false) {
    if (force || (!state.settingsDraft.promptDirty && state.settingsDraft.syncedPromptVal !== sharedState.compactPrompt)) {
      state.settingsDraft.syncedPromptVal = sharedState.compactPrompt;
      state.settingsDraft.compactPrompt = sharedState.compactPrompt;
      state.settingsDraft.promptDirty = false;
    }
    if (isRemoteWeb && (force || !state.settingsDraft.remoteUrlDirty)) {
      state.settingsDraft.remoteUrl = getApiBaseUrl();
      state.settingsDraft.remoteUrlDirty = false;
    }
  }

  function buildRemoteStatusSummary() {
    const tr = i18n.t();
    const configured = isApiConfigured();
    const currentUrl = getApiBaseUrl();
    if (!configured) {
      return { text: tr.remoteDisconnected, isErr: false };
    }
    if (api.isConnected()) {
      return {
        text: i18n.formatTemplate(tr.remoteConnected, { url: currentUrl }),
        isErr: false,
      };
    }
    if (state.lastConnectionError) {
      const status = state.lastConnectionError.status;
      if (status === 401 || status === 403) {
        return {
          text: i18n.formatTemplate(tr.remoteAuthFailed, { status }),
          isErr: true,
        };
      }
      return { text: tr.remoteUnreachable, isErr: true };
    }
    return { text: tr.connecting, isErr: false };
  }

  function getCombinedAddonsForSettings() {
    const persistedSorted = addons.getSortedPersisted();
    const runtimeSorted = addons.getSortedRuntime();
    const delegated =
      typeof addons.getSortedDelegatedItems === 'function'
        ? addons.getSortedDelegatedItems()
        : { left: [], right: [] };
    const allDelegated = [...delegated.left, ...delegated.right];
    return [
      ...persistedSorted.map((b) => ({
        id: b.id,
        label: b.label,
        source: b.source || 'agent',
        detail: b.description || b.command,
        enabled: b.enabled !== false,
        runtime: false,
        delegated: false,
      })),
      ...runtimeSorted.map((r) => ({
        id: r.id,
        label: r.label,
        source: r.source || 'plugin',
        detail: r.description || r.title || r.id,
        enabled: !addons.isRuntimeDisabled(r.id),
        runtime: true,
        delegated: false,
      })),
      ...allDelegated.map((d) => ({
        id: d.key,
        label: d.label,
        source: d.pluginId,
        detail: d.tooltip || d.id,
        enabled: true,
        runtime: true,
        delegated: true,
      })),
    ];
  }

  function buildCurrentContextPopupSpec() {
    return uiSchemas.buildContextPopupSpec({
      snap: state.snapshot,
      scope: state.popupDraft.scope,
      customLimit: state.popupDraft.customLimit,
      preset: state.popupDraft.preset,
      feedback: state.popupDraft.feedback,
      feedbackIsErr: state.popupDraft.feedbackIsErr,
    });
  }

  function buildCurrentGlobalModalSpec() {
    return uiSchemas.buildGlobalLimitModalSpec({
      defaultCustomLimit:
        typeof sharedState.defaultCustomLimit === 'number' ? sharedState.defaultCustomLimit : null,
      defaultLimitInput: state.modalDraft.defaultLimitInput,
      defaultPreset: state.modalDraft.defaultPreset,
      modelLimits: Array.isArray(sharedState.modelLimits) ? sharedState.modelLimits : [],
      currentModelName: state.snapshot?.modelName || '',
      modelNameInput: state.modalDraft.modelNameInput,
      modelLimitInput: state.modalDraft.modelLimitInput,
      modelPreset: state.modalDraft.modelPreset,
      sessionOverrideLimit: getSavedLimitForScope('session'),
      feedback: state.modalDraft.feedback,
      feedbackIsErr: state.modalDraft.feedbackIsErr,
    });
  }

  function buildCurrentSettingsPageSpec() {
    const remoteStatus = buildRemoteStatusSummary();
    return uiSchemas.buildSettingsPageSpec({
      isRemoteWeb,
      remoteUrl: state.settingsDraft.remoteUrl,
      remoteToken: state.settingsDraft.remoteToken,
      remoteStatusText: remoteStatus.text,
      remoteStatusErr: remoteStatus.isErr,
      autoCompact: sharedState.autoCompactEnabled,
      compactPrompt: state.settingsDraft.compactPrompt,
      addonsList: getCombinedAddonsForSettings(),
      locale: i18n.getLocale(),
      feedback: state.settingsDraft.feedback,
      feedbackIsErr: state.settingsDraft.feedbackIsErr,
    });
  }

  function updateContextPopupInPlace() {
    if (!state.contextPopupHandle || state.disposed) return;
    try {
      const { tree, state: nextState } = buildCurrentContextPopupSpec();
      state.contextPopupHandle.update(tree, nextState);
    } catch {}
  }

  function updateGlobalModalInPlace() {
    if (!state.globalModalHandle || state.disposed) return;
    try {
      const { tree, state: nextState } = buildCurrentGlobalModalSpec();
      state.globalModalHandle.update(tree, nextState);
    } catch {}
  }

  function updateSettingsPageInPlace() {
    if (!state.settingsPageHandle || state.disposed) return;
    try {
      const { tree, state: nextState } = buildCurrentSettingsPageSpec();
      state.settingsPageHandle.update(tree, nextState);
    } catch {}
  }

  function closeContextPopup() {
    if (!state.contextPopupHandle) return;
    const handle = state.contextPopupHandle;
    state.contextPopupHandle = null;
    try {
      handle.close();
    } catch {}
    barView.setExpandedState({ open: state.settingsPageOpen, activeTab: state.settingsPageOpen ? 'settings' : 'context' });
  }

  function closeGlobalModal() {
    if (!state.globalModalHandle) return;
    const handle = state.globalModalHandle;
    state.globalModalHandle = null;
    try {
      handle.close();
    } catch {}
  }

  function openContextPopup(anchorEl) {
    if (state.disposed || !hostPort || typeof hostPort.openPopup !== 'function') return null;
    if (state.contextPopupHandle) {
      closeContextPopup();
      return null;
    }
    state.popupDraft.feedback = '';
    state.popupDraft.feedbackIsErr = false;
    syncPopupLimitDraft(true);
    const { tree, state: initState } = buildCurrentContextPopupSpec();
    const handle = hostPort.openPopup({
      title: `${i18n.t().settingsTitle} · ${i18n.t().tabContext}`,
      placement: {
        zone: 'anchor',
        anchorEl: anchorEl || barView.ctxBtn,
        prefer: 'top-start',
        width: 360,
      },
      tree,
      state: initState,
      closeOnOutsideClick: true,
      onChange({ field, value }) {
        if (field === 'scope') {
          const nextScope = value === 'default' ? 'default' : 'session';
          state.popupDraft.scope = nextScope;
          if (
            state.popupDraft.dirty &&
            parseStrictLimitInput(state.popupDraft.customLimit, { allowBlank: false }).ok
          ) {
            state.popupDraft.feedback = '';
            updateContextPopupInPlace();
            return;
          }
          state.popupDraft.dirty = false;
          state.popupDraft.syncedKey = '';
          state.popupDraft.feedback = '';
          syncPopupLimitDraft(true);
          updateContextPopupInPlace();
          return;
        }
        if (field === 'preset') {
          state.popupDraft.dirty = true;
          state.popupDraft.preset = String(value || '');
          state.popupDraft.customLimit = String(value || '');
          state.popupDraft.feedback = '';
          updateContextPopupInPlace();
          return;
        }
        if (field === 'customLimit') {
          state.popupDraft.dirty = true;
          state.popupDraft.customLimit = String(value ?? '');
          const raw = state.popupDraft.customLimit.replace(/[\s,]/g, '').trim();
          const parsed = raw ? Number(raw) : NaN;
          state.popupDraft.preset = PRESETS.includes(parsed) ? String(parsed) : '';
          state.popupDraft.feedback = '';
          updateContextPopupInPlace();
        }
      },
      onAction({ actionId }) {
        if (actionId === 'apply-limit') {
          handleApplyLimit();
        } else if (actionId === 'open-global-limits') {
          openGlobalLimits();
        } else if (actionId === 'open-settings') {
          closeContextPopup();
          openSettings();
        }
      },
      onClose() {
        state.contextPopupHandle = null;
        barView.setExpandedState({
          open: state.settingsPageOpen,
          activeTab: state.settingsPageOpen ? 'settings' : 'context',
        });
      },
    });
    state.contextPopupHandle = handle;
    barView.setExpandedState({ open: true, activeTab: 'context' });
    return handle;
  }

  function openGlobalLimits() {
    if (state.disposed || !hostPort || typeof hostPort.openModal !== 'function') return null;
    closeContextPopup();
    if (state.globalModalHandle) {
      updateGlobalModalInPlace();
      return state.globalModalHandle;
    }
    state.modalDraft.feedback = '';
    state.modalDraft.feedbackIsErr = false;
    syncModalDefaultDraft(true);
    const { tree, state: initState } = buildCurrentGlobalModalSpec();
    const handle = hostPort.openModal({
      title: i18n.t().globalModalTitle,
      placement: { zone: 'surface-center', width: 460 },
      tree,
      state: initState,
      onChange({ field, value }) {
        if (field === 'defaultPreset') {
          state.modalDraft.defaultDirty = true;
          state.modalDraft.defaultPreset = String(value || '');
          state.modalDraft.defaultLimitInput = String(value || '');
          state.modalDraft.feedback = '';
          updateGlobalModalInPlace();
          return;
        }
        if (field === 'defaultLimitInput') {
          state.modalDraft.defaultDirty = true;
          state.modalDraft.defaultLimitInput = String(value ?? '');
          const raw = state.modalDraft.defaultLimitInput.replace(/[\s,]/g, '').trim();
          const parsed = raw ? Number(raw) : NaN;
          state.modalDraft.defaultPreset = PRESETS.includes(parsed) ? String(parsed) : '';
          state.modalDraft.feedback = '';
          updateGlobalModalInPlace();
          return;
        }
        if (field === 'modelNameInput') {
          state.modalDraft.modelNameInput = String(value ?? '');
          state.modalDraft.feedback = '';
          return;
        }
        if (field === 'modelPreset') {
          state.modalDraft.modelPreset = String(value || '');
          state.modalDraft.modelLimitInput = String(value || '');
          state.modalDraft.feedback = '';
          updateGlobalModalInPlace();
          return;
        }
        if (field === 'modelLimitInput') {
          state.modalDraft.modelLimitInput = String(value ?? '');
          const raw = state.modalDraft.modelLimitInput.replace(/[\s,]/g, '').trim();
          const parsed = raw ? Number(raw) : NaN;
          state.modalDraft.modelPreset = PRESETS.includes(parsed) ? String(parsed) : '';
          state.modalDraft.feedback = '';
          updateGlobalModalInPlace();
        }
      },
      onAction({ actionId, payload }) {
        if (actionId === 'clear-session-limit') {
          handleClearCurrentSessionLimit();
        } else if (actionId === 'save-default-limit') {
          handleSaveGlobalDefault(state.modalDraft.defaultLimitInput);
        } else if (actionId === 'reset-default-limit') {
          state.modalDraft.defaultLimitInput = '';
          state.modalDraft.defaultPreset = '';
          handleSaveGlobalDefault('');
        } else if (actionId === 'use-current-model') {
          const curModel = state.snapshot?.modelName || '';
          if (curModel) {
            state.modalDraft.modelNameInput = curModel;
            updateGlobalModalInPlace();
          }
        } else if (actionId === 'save-model-limit') {
          handleSaveModelLimit(state.modalDraft.modelNameInput, state.modalDraft.modelLimitInput);
        } else if (actionId === 'edit-model-limit' && payload) {
          state.modalDraft.modelNameInput = String(payload.model || '');
          state.modalDraft.modelLimitInput = String(payload.limit || '');
          state.modalDraft.modelPreset = PRESETS.includes(payload.limit) ? String(payload.limit) : '';
          updateGlobalModalInPlace();
        } else if (actionId === 'remove-model-limit' && payload) {
          handleSaveModelLimit(payload.model, null);
        }
      },
      onClose() {
        state.globalModalHandle = null;
      },
    });
    state.globalModalHandle = handle;
    return handle;
  }

  function registerUnifiedSettingsPage() {
    if (!hostPort || typeof hostPort.registerSettingsPage !== 'function') return null;
    syncSettingsDraft(true);
    const initial = buildCurrentSettingsPageSpec();
    const reg = hostPort.registerSettingsPage({
      id: 'settings',
      title: i18n.t().settingsTitle,
      order: 50,
      width: 520,
      schema: initial.tree,
      state: initial.state,
      getSchema() {
        syncSettingsDraft(false);
        return buildCurrentSettingsPageSpec().tree;
      },
      getState() {
        syncSettingsDraft(false);
        return buildCurrentSettingsPageSpec().state;
      },
      onChange({ field, value }) {
        if (field === 'autoCompact') {
          handleToggleAutoCompact(Boolean(value));
        } else if (field === 'compactPrompt') {
          state.settingsDraft.promptDirty = true;
          state.settingsDraft.compactPrompt = String(value ?? '');
          state.settingsDraft.feedback = '';
          updateSettingsPageInPlace();
        } else if (field === 'locale') {
          applyLocale(String(value || 'ko'));
        } else if (field === 'remoteUrl') {
          state.settingsDraft.remoteUrlDirty = true;
          state.settingsDraft.remoteUrl = String(value ?? '');
          state.settingsDraft.feedback = '';
        } else if (field === 'remoteToken') {
          state.settingsDraft.remoteToken = String(value ?? '');
          state.settingsDraft.feedback = '';
        }
      },
      onAction({ actionId, payload }) {
        if (actionId === 'open-global-limits') {
          openGlobalLimits();
        } else if (actionId === 'save-compact-prompt') {
          saveCompactPromptValue(state.settingsDraft.compactPrompt);
        } else if (actionId === 'reset-compact-prompt') {
          state.settingsDraft.compactPrompt = '';
          saveCompactPromptValue('');
        } else if (actionId === 'toggle-addon' && payload) {
          handleToggleAddon(payload.id, payload.enabled, Boolean(payload.runtime));
        } else if (actionId === 'remove-addon' && payload) {
          handleRemoveAddon(payload.id, Boolean(payload.runtime));
        } else if (actionId === 'remote-connect') {
          handleRemoteConnect();
        } else if (actionId === 'remote-disconnect') {
          handleRemoteDisconnect();
        }
      },
      onClose() {
        state.settingsPageOpen = false;
        barView.setExpandedState({
          open: Boolean(state.contextPopupHandle),
          activeTab: state.contextPopupHandle ? 'context' : 'settings',
        });
      },
    });
    state.settingsPageHandle = reg;
    return reg;
  }

  function openSettings() {
    if (state.disposed) return null;
    closeContextPopup();
    state.settingsDraft.feedback = '';
    state.settingsDraft.feedbackIsErr = false;
    syncSettingsDraft(true);
    if (state.settingsPageHandle && typeof state.settingsPageHandle.open === 'function') {
      state.settingsPageOpen = true;
      barView.setExpandedState({ open: true, activeTab: 'settings' });
      return state.settingsPageHandle.open();
    }
    return null;
  }

  async function handleCustomCommand(btnDef, btnEl) {
    const sid = getSessionId();
    if (!sid || !btnDef?.command) return;
    if (btnEl) btnEl.disabled = true;
    try {
      await api.post('/api/command', { sessionId: sid, command: btnDef.command });
      showNote(`${btnDef.label}: ${i18n.t().cmdSent}`, 4000, 'success');
      if (typeof onBurstRequested === 'function') onBurstRequested();
    } catch {
      showNote(`${btnDef.label}: ${i18n.t().cmdFail}`, 4000, 'danger');
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function handleToggleAddon(id, enabled, isRuntime) {
    try {
      const updated = await api.post('/api/addons/toggle', { id, enabled, runtime: isRuntime });
      addons.applyPersistedSettings(updated);
      setSettingsFeedback(i18n.t().applied, false);
      render();
    } catch (err) {
      setSettingsFeedback(err?.message || 'Error', true);
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
      setSettingsFeedback(i18n.t().applied, false);
      render();
    } catch (err) {
      setSettingsFeedback(err?.message || 'Error', true);
    }
  }

  function renderAddons() {
    const persistedSorted = addons.getSortedPersisted();
    const runtimeSorted = addons.getSortedRuntime();
    const delegated =
      typeof addons.getSortedDelegatedItems === 'function'
        ? addons.getSortedDelegatedItems()
        : { left: [], right: [] };
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
      dl: delegated.left.map((d) => [d.key, d.label, d.icon, d.badge, d.tooltip, d.priority]),
      dr: delegated.right.map((d) => [d.key, d.label, d.icon, d.badge, d.tooltip, d.priority]),
    });
    if (state.lastAddonsKey === nextAddonsKey) return;
    state.lastAddonsKey = nextAddonsKey;

    if (typeof barView.renderDelegatedItems === 'function') {
      barView.renderDelegatedItems({
        leftItems: delegated.left,
        rightItems: delegated.right,
      });
    }

    const visibleRuntime = runtimeSorted.filter((r) => !addons.isRuntimeDisabled(r.id));
    barView.renderAddonButtons({
      persistedButtons: persistedSorted,
      runtimeButtons: visibleRuntime,
      onPersistedClick: handleCustomCommand,
      onRuntimeClick(rtDef) {
        try {
          rtDef.onClick({ sessionId: getSessionId() });
        } catch {}
      },
    });
  }

  function render() {
    if (state.disposed) return;
    const snap = state.snapshot;
    if (snap && typeof snap.compactPrompt === 'string' && !state.settingsDraft.promptDirty) {
      sharedState.compactPrompt = snap.compactPrompt;
    }
    syncSettingsDraft(false);
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
    if (snap) {
      syncPopupLimitDraft(false);
      const autoErr = snap.compaction?.lastError;
      if (autoErr && typeof autoErr.at === 'number' && autoErr.at > state.lastAutoErrAt) {
        state.lastAutoErrAt = autoErr.at;
        showNote(
          i18n.formatTemplate(i18n.t().autoCompactError, {
            msg: autoErr.message || autoErr.code || 'Error',
          }),
          6000,
          'danger',
        );
      }
    }
    barView.renderQuota(sharedState.quotaState, state.snapshot?.modelName || '');

    if (state.contextPopupHandle) {
      updateContextPopupInPlace();
    }
    if (state.globalModalHandle) {
      syncModalDefaultDraft(false);
      updateGlobalModalInPlace();
    }
    if (state.settingsPageOpen && state.settingsPageHandle) {
      updateSettingsPageInPlace();
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
        state.popupDraft.dirty = false;
        state.popupDraft.syncedKey = '';
        render();
      }
      return;
    }
    const sessionChanged = Boolean(state.lastSessionId && state.lastSessionId !== sid);
    if (sessionChanged) {
      state.snapshot = null;
      state.popupDraft.dirty = false;
      state.popupDraft.syncedKey = '';
      render();
      if (state.abortCtrl) state.abortCtrl.abort();
    } else if (state.inFlight) {
      state.pendingRefresh = true;
      if (waitForFresh && state.inFlightPromise) {
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
        if (isRemoteWeb && state.settingsPageOpen) {
          updateSettingsPageInPlace();
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
      showNote(i18n.t().compactSent, 4000, 'success');
      if (typeof onBurstRequested === 'function') onBurstRequested();
      refreshSnapshot();
    } catch (err) {
      showNote(
        err?.code === 'COMPACTION_IN_PROGRESS' ? i18n.t().compactInProgress : i18n.t().compactFail,
        4000,
        'danger',
      );
    } finally {
      state.compacting = false;
      render();
    }
  }

  async function handleApplyLimit() {
    const tr = i18n.t();
    const parsedLimit = parseStrictLimitInput(state.popupDraft.customLimit, { allowBlank: true });
    if (!parsedLimit.ok) {
      setPopupFeedback(tr.invalidLimit, true);
      return;
    }
    const limitVal = parsedLimit.value;
    const scope = state.popupDraft.scope === 'default' ? 'default' : 'session';
    const sid = getSessionId();
    if (scope === 'session' && !sid) {
      setPopupFeedback(tr.noActiveSession, true);
      return;
    }
    const payload =
      scope === 'default'
        ? { defaultCustomLimit: limitVal }
        : { sessionLimit: { sessionId: sid, limit: limitVal } };
    try {
      const updated = await api.post('/api/settings/update', payload);
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.popupDraft.dirty = false;
      state.popupDraft.syncedKey = '';
      await refreshSnapshot({ waitForFresh: true });
      syncPopupLimitDraft(true);
      const hostMax = state.snapshot?.maxContextTokens || 0;
      const sessionOverrideVal = getSavedLimitForScope('session');
      if (scope === 'default' && limitVal !== null && typeof sessionOverrideVal === 'number') {
        setPopupFeedback(
          i18n.formatTemplate(tr.appliedMaskedBySession, {
            val: i18n.formatTokens(limitVal),
            sessionVal: i18n.formatTokens(sessionOverrideVal),
          }),
          false,
        );
      } else if (limitVal !== null && hostMax > 0 && limitVal > hostMax) {
        setPopupFeedback(
          i18n.formatTemplate(tr.appliedClamped, {
            val: i18n.formatTokens(limitVal),
            max: i18n.formatTokens(hostMax),
          }),
          false,
        );
      } else {
        setPopupFeedback(tr.applied, false);
      }
    } catch (err) {
      setPopupFeedback(err?.message || 'Error', true);
    }
  }

  async function handleSaveGlobalDefault(rawInputValue) {
    const tr = i18n.t();
    const parsedLimit = parseStrictLimitInput(rawInputValue, { allowBlank: true });
    if (!parsedLimit.ok) {
      setModalFeedback(tr.invalidLimit, true);
      return;
    }
    const limitVal = parsedLimit.value;
    try {
      const updated = await api.post('/api/settings/update', { defaultCustomLimit: limitVal });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.popupDraft.dirty = false;
      state.popupDraft.syncedKey = '';
      state.modalDraft.defaultDirty = false;
      await refreshSnapshot({ waitForFresh: true });
      syncPopupLimitDraft(true);
      syncModalDefaultDraft(true);
      const sessionOverrideVal = getSavedLimitForScope('session');
      if (limitVal !== null && typeof sessionOverrideVal === 'number') {
        setModalFeedback(
          i18n.formatTemplate(tr.appliedMaskedBySession, {
            val: i18n.formatTokens(limitVal),
            sessionVal: i18n.formatTokens(sessionOverrideVal),
          }),
          false,
        );
      } else {
        setModalFeedback(tr.applied, false);
      }
    } catch (err) {
      setModalFeedback(err?.message || 'Error', true);
    }
  }

  async function handleSaveModelLimit(rawModelName, rawLimitValue) {
    const tr = i18n.t();
    const model = String(rawModelName || '').trim();
    if (!model || model.length > 128) {
      setModalFeedback(tr.invalidModelName, true);
      return;
    }
    let limitVal = null;
    if (rawLimitValue !== null) {
      const parsedLimit = parseStrictLimitInput(rawLimitValue, { allowBlank: false });
      if (!parsedLimit.ok) {
        setModalFeedback(tr.invalidLimit, true);
        return;
      }
      limitVal = parsedLimit.value;
    }
    try {
      const updated = await api.post('/api/settings/update', {
        modelLimit: { model, limit: limitVal },
      });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.popupDraft.dirty = false;
      state.popupDraft.syncedKey = '';
      await refreshSnapshot({ waitForFresh: true });
      syncPopupLimitDraft(true);
      if (limitVal !== null) {
        state.modalDraft.modelNameInput = '';
        state.modalDraft.modelLimitInput = '';
        state.modalDraft.modelPreset = '';
      }
      setModalFeedback(tr.applied, false);
    } catch (err) {
      setModalFeedback(err?.message || 'Error', true);
    }
  }

  async function handleClearCurrentSessionLimit() {
    const tr = i18n.t();
    const sid = getSessionId();
    if (!sid) {
      setModalFeedback(tr.noActiveSession, true);
      return;
    }
    try {
      const updated = await api.post('/api/settings/update', {
        sessionLimit: { sessionId: sid, limit: null },
      });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      state.popupDraft.dirty = false;
      state.popupDraft.syncedKey = '';
      await refreshSnapshot({ waitForFresh: true });
      syncPopupLimitDraft(true);
      setModalFeedback(tr.applied, false);
    } catch (err) {
      setModalFeedback(err?.message || 'Error', true);
    }
  }

  async function handleToggleAutoCompact(nextValue) {
    const prev = sharedState.autoCompactEnabled;
    const next = typeof nextValue === 'boolean' ? nextValue : !prev;
    sharedState.autoCompactEnabled = next;
    render();
    try {
      const updated = await api.post('/api/settings/update', { autoCompact: next });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      setSettingsFeedback(i18n.t().applied, false);
    } catch (err) {
      sharedState.autoCompactEnabled = prev;
      render();
      setSettingsFeedback(err?.message || 'Error', true);
    }
  }

  async function saveCompactPromptValue(rawValue) {
    const nextPrompt = String(rawValue || '').trim();
    try {
      const updated = await api.post('/api/settings/update', { compactPrompt: nextPrompt });
      if (typeof onSettingsChanged === 'function') onSettingsChanged(updated);
      sharedState.compactPrompt =
        typeof updated?.compactPrompt === 'string' ? updated.compactPrompt : nextPrompt;
      state.settingsDraft.promptDirty = false;
      state.settingsDraft.syncedPromptVal = sharedState.compactPrompt;
      state.settingsDraft.compactPrompt = sharedState.compactPrompt;
      render();
      setSettingsFeedback(i18n.t().applied, false);
    } catch (err) {
      setSettingsFeedback(err?.message || 'Error', true);
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

  async function handleRemoteConnect() {
    if (!isRemoteWeb || typeof onRemoteConnectionSave !== 'function') return;
    const tr = i18n.t();
    const baseUrl = String(state.settingsDraft.remoteUrl || '').trim();
    const token = String(state.settingsDraft.remoteToken || '').trim();
    try {
      const result = await onRemoteConnectionSave({ baseUrl, token });
      state.settingsDraft.remoteUrlDirty = false;
      if (result && result.ok) {
        state.consecutiveSnapshotFailures = 0;
        state.lastConnectionError = null;
        state.settingsDraft.remoteToken = '';
        state.settingsDraft.remoteUrl = result.baseUrl || baseUrl;
        setSettingsFeedback(
          i18n.formatTemplate(tr.remoteConnected, { url: result.baseUrl || baseUrl }),
          false,
        );
      } else if (result && result.code === 'ERR_INVALID_ENDPOINT_URL') {
        setSettingsFeedback(tr.remoteInvalidUrl, true);
      } else if (result && result.code === 'ERR_INVALID_SIDECAR_TOKEN') {
        setSettingsFeedback(tr.remoteInvalidToken, true);
      } else if (result && (result.status === 401 || result.status === 403)) {
        state.lastConnectionError = { status: result.status };
        setSettingsFeedback(i18n.formatTemplate(tr.remoteAuthFailed, { status: result.status }), true);
      } else if (result && result.code === 'ERR_SAVE_SETTINGS_FAILED') {
        setSettingsFeedback(
          i18n.formatTemplate(tr.remoteSaveFailed, { reason: result.reason || 'Error' }),
          true,
        );
      } else {
        state.lastConnectionError = new Error(result?.message || 'unreachable');
        setSettingsFeedback(tr.remoteUnreachable, true);
      }
      render();
    } catch (err) {
      state.lastConnectionError = err;
      setSettingsFeedback(err?.message || tr.remoteUnreachable, true);
      render();
    }
  }

  async function handleRemoteDisconnect() {
    if (!isRemoteWeb || typeof onRemoteConnectionClear !== 'function') return;
    const tr = i18n.t();
    try {
      await onRemoteConnectionClear();
      state.settingsDraft.remoteUrlDirty = false;
      state.settingsDraft.remoteUrl = '';
      state.settingsDraft.remoteToken = '';
      resetConnectionState();
      setSettingsFeedback(tr.remoteDisconnectedSaved, false);
    } catch (err) {
      setSettingsFeedback(err?.message || 'Error', true);
    }
  }

  barView.ctxBtn.addEventListener('click', () => {
    if (isRemoteWeb && !isApiConfigured()) {
      openSettings();
      return;
    }
    openContextPopup(barView.ctxBtn);
  });
  barView.settingsBtn.addEventListener('click', () => {
    openSettings();
  });
  barView.compactBtn.addEventListener('click', handleCompact);

  registerUnifiedSettingsPage();

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
    if (state.noteTimer) clearTimeout(state.noteTimer);
    if (state.popupFeedbackTimer) clearTimeout(state.popupFeedbackTimer);
    if (state.modalFeedbackTimer) clearTimeout(state.modalFeedbackTimer);
    if (state.settingsFeedbackTimer) clearTimeout(state.settingsFeedbackTimer);
    if (state.abortCtrl) state.abortCtrl.abort();
    closeGlobalModal();
    closeContextPopup();
    if (state.settingsPageHandle && typeof state.settingsPageHandle.dispose === 'function') {
      try {
        state.settingsPageHandle.dispose();
      } catch {}
    }
    state.settingsPageHandle = null;
    state.settingsPageOpen = false;
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
    openContextPopup,
    openSettings,
    openGlobalLimits,
    triggerCompact: handleCompact,
    destroy,
  });
}
