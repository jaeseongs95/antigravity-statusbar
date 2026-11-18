'use strict';

/**
 * Pure Application State Coordinator.
 * Connects Domain + Ports + UI without touching any Driver implementation directly.
 */

const {
  validateTransportPort,
  validateStoragePort,
  validateEnginePort,
} = require('../ports/contracts');
const { CONTEXT_WINDOWS } = require('../domain/context-window-policy');
const { extractStatsFromMetas, applyRealtimeCompactionAndUsage, getChatModelFromMeta } = require('../domain/metrics-calculator');

function createStateCoordinator({
  document,
  documentHost,
  transport,
  storage,
  engine,
  cwStore,
  translator,
  adapterRegistry,
  underDefaultCwSet,
  ensureStyles,
  removeStyles,
  scope,
  csrfProvider,
  getRcGenLen,
  getRcStepLen,
}) {
  validateTransportPort(transport);
  validateStoragePort(storage);
  validateEnginePort(engine);

  let updateScheduled = false;
  let scheduledTimer = null;
  let lastViewCount = 0;
  let quotaRefreshing = false;

  const statsPendingRefresh = new Set();
  const statsAttemptedSessions = new Set();

  function getCsrf() {
    return typeof csrfProvider === 'function' ? csrfProvider() : '';
  }

  function getConversationContextWindow(view, cascadeId) {
    return cwStore.getSavedContextWindow(cascadeId);
  }

  function setConversationContextWindow(view, cascadeId, cw, opts = {}) {
    const norm = cwStore.normalize(cw);
    if (!norm) return null;
    if (cascadeId && cascadeId !== 'remote-session') {
      cwStore.saveContextWindowSetting(cascadeId, norm);
    } else {
      cwStore.saveContextWindowSetting(null, norm);
    }
    const maxLimit = cwStore.getLimit(norm);
    const shouldWarn = maxLimit <= 256000;
    if (shouldWarn && underDefaultCwSet) {
      underDefaultCwSet.add(norm);
      ensureStyles?.();
    }
    if (opts.applyEngine !== false) {
      try {
        engine.applyContextLimit(view, cascadeId, norm, opts.userTriggered !== false);
      } catch {}
    }
    return norm;
  }

  function cycleConversationContextWindow(view, cascadeId) {
    const current = getConversationContextWindow(view, cascadeId);
    const idx = CONTEXT_WINDOWS.indexOf(current);
    const next = idx >= 0 ? CONTEXT_WINDOWS[(idx + 1) % CONTEXT_WINDOWS.length] : CONTEXT_WINDOWS[0];
    return setConversationContextWindow(view, cascadeId, next);
  }

  function saveDefaultContextWindow(cw) {
    const norm = cwStore.saveContextWindowSetting(null, cw);
    if (norm && underDefaultCwSet && cwStore.getLimit(norm) <= 256000) {
      underDefaultCwSet.add(norm);
      ensureStyles?.();
    }
    return norm;
  }

  function getTargetDocs() {
    if (documentHost && typeof documentHost.getAccessibleDocs === 'function') {
      const docs = documentHost.getAccessibleDocs(document);
      if (Array.isArray(docs) && docs.length > 0) return docs;
    }
    return document ? [document] : [];
  }

  function removeOrphanHostViews(activeHostViews) {
    for (const targetDoc of getTargetDocs()) {
      if (!targetDoc || typeof targetDoc.querySelectorAll !== 'function') continue;
      const hostViews = targetDoc.querySelectorAll('.agy-rc-host-view');
      for (const hv of hostViews) {
        if (!activeHostViews.has(hv)) {
          try {
            hv.remove();
          } catch {}
        }
      }
    }
  }

  function renderSessionBar(session) {
    const cascadeId = session?.sessionId || session?.cascadeId || '';
    const view = session?.viewEl || session?.view || null;
    const inputBox = session?.inputEl || session?.inputBox || null;
    const isRemoteHost = Boolean(session?.isRemoteShell || session?.isRemoteHost);
    const hostBox = session?.hostBox || (isRemoteHost ? inputBox : null);
    const isRemotePlaceholder = !cascadeId || cascadeId === 'remote-session';

    const asp = !isRemotePlaceholder && typeof engine.getAgentStateProviderForInputBox === 'function'
      ? engine.getAgentStateProviderForInputBox(inputBox || view, cascadeId)
      : null;
    const rawState = session?.rawState || asp?.getState?.() || null;

    const cachedStats = isRemotePlaceholder ? null : transport.getCachedStats(cascadeId);
    const immediateStats = isRemotePlaceholder ? null : transport.getImmediateStats(cascadeId, rawState);
    if (!isRemotePlaceholder && session?.observedEngineCw && !cwStore.hasSessionOverride(cascadeId)) {
      cwStore.seedSessionIfEmpty(cascadeId, session.observedEngineCw);
    }
    const currentCw = getConversationContextWindow(view, isRemotePlaceholder ? '' : cascadeId);

    // Sync active model's Redux state when drift is detected
    try {
      engine.applyContextLimit(view, isRemotePlaceholder ? '' : cascadeId, currentCw, false);
    } catch {}

    const activeStats = immediateStats || cachedStats || null;
    const deferUncachedMetrics = Boolean(
      !isRemotePlaceholder && !activeStats && lastViewCount > 0 && !statsAttemptedSessions.has(cascadeId)
    );

    if (!isRemotePlaceholder && !statsPendingRefresh.has(cascadeId)) {
      const csrf = getCsrf();
      statsPendingRefresh.add(cascadeId);
      transport
        .getStats({
          cascadeId,
          rawState,
          getLatestState: () => {
            const curAsp =
              typeof engine.getAgentStateProviderForInputBox === 'function'
                ? engine.getAgentStateProviderForInputBox(inputBox || view, cascadeId)
                : asp;
            return curAsp?.getState?.() || null;
          },
          el: inputBox || view,
          csrf,
          totalGenLen: typeof getRcGenLen === 'function' ? getRcGenLen(cascadeId) : 0,
          totalStepsLen: typeof getRcStepLen === 'function' ? getRcStepLen(cascadeId) : -1,
        })
        .then((nextStats) => {
          const firstCompletion = !statsAttemptedSessions.has(cascadeId);
          statsAttemptedSessions.add(cascadeId);
          statsPendingRefresh.delete(cascadeId);
          if ((nextStats && nextStats !== activeStats) || firstCompletion) {
            scheduleUpdate();
          }
        })
        .catch(() => {
          const firstCompletion = !statsAttemptedSessions.has(cascadeId);
          statsAttemptedSessions.add(cascadeId);
          statsPendingRefresh.delete(cascadeId);
          if (firstCompletion) {
            scheduleUpdate();
          }
        });
    }

    const barTarget = isRemoteHost && hostBox ? hostBox : inputBox;
    if (!barTarget) return;

    const barDoc = barTarget.ownerDocument || document;
    let barEl = barTarget.querySelector?.('.agy-ctx-statusbar') || null;
    if (!barEl) {
      barEl = barDoc.createElement('div');
      barEl.className = 'agy-ctx-statusbar';
      barEl.setAttribute?.('data-agy-no-translate', 'true');
      barEl.setAttribute?.('translate', 'no');
      barTarget.appendChild(barEl);
    }

    const { leftEl, rightEl } = adapterRegistry.ensureBarStructure(barEl);
    const renderCtx = {
      barEl,
      view,
      inputBox: inputBox || view,
      cascadeId: isRemotePlaceholder ? '' : cascadeId,
      currentCw,
      stats: activeStats,
      quota: transport.getLatestQuota(),
      deferUncachedMetrics,
    };

    adapterRegistry.renderSlotAdapters(leftEl, 'left', renderCtx);
    adapterRegistry.renderSlotAdapters(rightEl, 'right', renderCtx);
  }

  function updateAll() {
    if (scope?.isDisposed?.()) return;
    ensureStyles?.();
    const sessions = engine.getActiveSessions(() => scheduleUpdate(40)) || [];
    const activeHostViews = new Set();
    for (const s of sessions) {
      const isRemoteHost = Boolean(s?.isRemoteShell || s?.isRemoteHost);
      const view = s?.viewEl || s?.view || null;
      if (isRemoteHost && view) {
        activeHostViews.add(view);
      }
      renderSessionBar(s);
    }
    removeOrphanHostViews(activeHostViews);
    lastViewCount = sessions.length;

    const csrf = getCsrf();
    if (!quotaRefreshing && (csrf || sessions.some((s) => s.isRemoteShell || s.isRemoteHost || s.isRemoteIframe))) {
      quotaRefreshing = true;
      const sampleEl = sessions[0]?.inputEl || sessions[0]?.inputBox || sessions[0]?.viewEl || sessions[0]?.view || null;
      transport
        .getQuota({ el: sampleEl, csrf })
        .then(() => {
          quotaRefreshing = false;
        })
        .catch(() => {
          quotaRefreshing = false;
        });
    }
  }

  function scheduleUpdate(delayMs = 50) {
    if (scope?.isDisposed?.()) return;
    if (updateScheduled) return;
    updateScheduled = true;
    scheduledTimer = scope.setTimeout(() => {
      updateScheduled = false;
      scheduledTimer = null;
      updateAll();
    }, delayMs);
  }

  async function loadDebugTelemetry(view, inputBox, rawCid) {
    const snap = engine.getDebugSnapshot(view, inputBox, rawCid);
    const csrf = getCsrf();
    const cascadeId = snap?.cascadeId || rawCid || '';

    if (!cascadeId || (!csrf && !snap?.hasRemoteSvc)) {
      return { unavailable: true };
    }

    const currentCw = cwStore.getSavedContextWindow(cascadeId);
    const maxLimit = cwStore.getLimit(currentCw);
    let totalGenLen = snap?.totalGenLen || (typeof getRcGenLen === 'function' ? getRcGenLen(cascadeId) : 0) || 0;
    const totalStepsLen = snap?.totalStepsLen || (typeof getRcStepLen === 'function' ? getRcStepLen(cascadeId) : 0) || 0;

    let fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
    let metas = [];
    if (typeof transport.getGeneratorMetadataRange === 'function') {
      metas = await transport.getGeneratorMetadataRange({
        cascadeId,
        offset: fetchOffset,
        el: inputBox || view,
        csrf,
      });
    }
    if (metas.length > 0) {
      const possibleEnd = fetchOffset + metas.length;
      if (possibleEnd > totalGenLen) totalGenLen = possibleEnd;
    }

    let parsed = extractStatsFromMetas(metas);
    if (snap?.rawState) {
      parsed = applyRealtimeCompactionAndUsage(parsed, snap.rawState);
    }

    let latestCwm = null;
    let latestSections = [];
    let latestModel = '';
    for (let i = metas.length - 1; i >= 0; i--) {
      const cm = getChatModelFromMeta(metas[i]);
      if (!cm) continue;
      if (!latestModel && (cm.modelDisplayName || cm.responseModel || cm.model)) {
        latestModel = cm.modelDisplayName || cm.responseModel || cm.model;
      }
      const cwm = cm.chatStartMetadata?.contextWindowMetadata;
      if (!latestCwm && cwm && cwm.estimatedTokensUsed !== undefined && cwm.estimatedTokensUsed !== null) {
        latestCwm = cwm;
      }
      if (!latestSections.length && Array.isArray(cm.promptSections) && cm.promptSections.length > 0) {
        latestSections = cm.promptSections;
      }
    }

    return {
      unavailable: false,
      cascadeId,
      trajectoryId: snap?.trajectoryId || '',
      currentCw: snap?.reduxSessionCw || currentCw,
      maxLimit,
      parsed,
      metas: metas.length > 20 ? metas.slice(-20) : metas,
      totalGenLen,
      totalStepsLen,
      latestCwm,
      latestSections,
      latestModel,
    };
  }

  function start() {
    updateAll();
    const stopObs = engine.observeSessions(() => scheduleUpdate(40));
    scope.add(stopObs);
    scope.setInterval(() => {
      if (!scope.isDisposed()) updateAll();
    }, 3000);
  }

  function dispose() {
    if (scheduledTimer !== null) {
      scope.clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
    for (const targetDoc of getTargetDocs()) {
      adapterRegistry.clearAllMenus?.(targetDoc);
      try {
        const bars = targetDoc?.querySelectorAll?.('.agy-ctx-statusbar') || [];
        for (const b of bars) {
          adapterRegistry.runNodeCleanup?.(b);
          b.remove?.();
        }
        const hostViews = targetDoc?.querySelectorAll?.('.agy-rc-host-view') || [];
        for (const hv of hostViews) hv.remove?.();
        const modal = targetDoc?.getElementById?.('agy-ctx-debug-modal');
        if (modal) {
          adapterRegistry.runNodeCleanup?.(modal);
          modal.remove?.();
        }
      } catch {}
    }
    removeStyles?.();
    statsPendingRefresh.clear();
    statsAttemptedSessions.clear();
  }

  return {
    getConversationContextWindow,
    setConversationContextWindow,
    cycleConversationContextWindow,
    saveDefaultContextWindow,
    loadDebugTelemetry,
    updateAll,
    scheduleUpdate,
    start,
    dispose,
  };
}

module.exports = {
  createStateCoordinator,
};
