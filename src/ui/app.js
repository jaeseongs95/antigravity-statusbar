import { createHostBridgeClient } from './bridge/host-bridge.mjs';
import { formatResetTime, formatTokenCount, getStrings } from './i18n.mjs';

const NORMAL_POLL_MS = 3_000;
const BURST_POLL_MS = 1_000;
const QUOTA_POLL_MS = 15_000;
const MAX_BURST_MS = 30_000;
const PRESETS = [32_000, 64_000, 128_000, 200_000, 256_000, 384_000, 512_000, 980_000];

/**
 * Pure controller factory so UI logic can be tested both in a browser and in Node unit/DOM tests.
 * Zero innerHTML usage anywhere (D-0012, D-0025).
 * Strict per-channel epoch + AbortController cancellation (D-0006, D-0020, D-0033).
 */
export function createStatusbarApp({
  doc = globalThis.document,
  win = globalThis.window,
  bridge = createHostBridgeClient(globalThis),
}) {
  const el = {
    panelTitle: doc.getElementById('panel-title'),
    connBadge: doc.getElementById('conn-badge'),
    btnLocale: doc.getElementById('btn-locale'),
    lblSession: doc.getElementById('lbl-session'),
    sessionModeBadge: doc.getElementById('session-mode-badge'),
    sessionSelect: doc.getElementById('session-select'),
    lblContext: doc.getElementById('lbl-context'),
    contextPct: doc.getElementById('context-pct'),
    contextProgress: doc.getElementById('context-progress'),
    contextProgressFill: doc.getElementById('context-progress-fill'),
    contextTokens: doc.getElementById('context-tokens'),
    contextLimitTag: doc.getElementById('context-limit-tag'),
    softLimitBanner: doc.getElementById('soft-limit-banner'),
    softLimitBannerText: doc.getElementById('soft-limit-banner-text'),
    btnCompact: doc.getElementById('btn-compact'),
    btnContextDetail: doc.getElementById('btn-context-detail'),
    compactStatus: doc.getElementById('compact-status'),
    contextDetailPanel: doc.getElementById('context-detail-panel'),
    lblDetailTitle: doc.getElementById('lbl-detail-title'),
    detailSteps: doc.getElementById('detail-steps'),
    detailModel: doc.getElementById('detail-model'),
    breakdownList: doc.getElementById('breakdown-list'),
    lblCustomLimit: doc.getElementById('lbl-custom-limit'),
    limitScopeSelect: doc.getElementById('limit-scope-select'),
    limitPresetSelect: doc.getElementById('limit-preset-select'),
    limitCustomInput: doc.getElementById('limit-custom-input'),
    btnApplyLimit: doc.getElementById('btn-apply-limit'),
    limitFeedback: doc.getElementById('limit-feedback'),
    lblCache: doc.getElementById('lbl-cache'),
    cachePct: doc.getElementById('cache-pct'),
    cacheDetail: doc.getElementById('cache-detail'),
    lblQuota: doc.getElementById('lbl-quota'),
    quotaStaleBadge: doc.getElementById('quota-stale-badge'),
    quotaGroups: doc.getElementById('quota-groups'),
  };

  const state = {
    locale: 'en',
    selectionMode: 'auto', // 'auto' | 'manual'
    selectedSessionId: null,
    sessions: [],
    snapshot: null,
    quota: null,
    detailExpanded: false,
    burstUntil: 0,
    sawRunningDuringBurst: false,
    connected: false,
    disposed: false,
  };

  // Per-channel epochs & AbortControllers for strict cross-session isolation (D-0033)
  let sessionListEpoch = 0;
  let snapshotEpoch = 0;
  let quotaEpoch = 0;
  let snapshotController = null;
  let pollTimer = null;
  let quotaTimer = null;
  const listenerController = new AbortController();

  function setTextIfChanged(node, text) {
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
  }

  function clearChildren(node) {
    if (!node) return;
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function renderPresetOptions() {
    const t = getStrings(state.locale);
    const prevValue = el.limitPresetSelect.value;
    clearChildren(el.limitPresetSelect);

    const hostOpt = doc.createElement('option');
    hostOpt.value = '';
    hostOpt.textContent = t.presetHostDefault;
    el.limitPresetSelect.appendChild(hostOpt);

    for (const preset of PRESETS) {
      const opt = doc.createElement('option');
      opt.value = String(preset);
      opt.textContent = `${Math.round(preset / 1000)}K`;
      el.limitPresetSelect.appendChild(opt);
    }
    el.limitPresetSelect.value = prevValue;
  }

  function applyLocaleStrings() {
    const t = getStrings(state.locale);
    doc.documentElement.lang = state.locale;
    setTextIfChanged(el.panelTitle, t.title);
    setTextIfChanged(el.btnLocale, t.toggleLocaleLabel);
    setTextIfChanged(el.lblSession, t.session);
    setTextIfChanged(
      el.sessionModeBadge,
      state.selectionMode === 'manual' ? t.modeManual : t.modeAuto,
    );
    setTextIfChanged(el.lblContext, t.contextWindow);
    setTextIfChanged(el.softLimitBannerText, t.softLimitExceeded);
    setTextIfChanged(el.btnContextDetail, t.contextBtn);
    setTextIfChanged(el.lblDetailTitle, t.tokenBreakdown);
    setTextIfChanged(el.lblCustomLimit, t.customLimit);
    setTextIfChanged(el.btnApplyLimit, t.applyBtn);
    setTextIfChanged(el.lblCache, t.cacheHit);
    setTextIfChanged(el.lblQuota, t.quotaTitle);
    setTextIfChanged(el.quotaStaleBadge, t.quotaStale);

    if (el.limitScopeSelect && el.limitScopeSelect.options.length >= 2) {
      el.limitScopeSelect.options[0].textContent = t.scopeSession;
      el.limitScopeSelect.options[1].textContent = t.scopeDefault;
    }

    renderPresetOptions();
    renderConnectionBadge();
    renderSnapshot();
    renderQuota();
  }

  function renderConnectionBadge() {
    const t = getStrings(state.locale);
    if (state.connected) {
      setTextIfChanged(el.connBadge, t.connected);
      el.connBadge.className = 'badge badge-ok';
    } else {
      setTextIfChanged(el.connBadge, t.offline);
      el.connBadge.className = 'badge badge-muted';
    }
  }

  function renderSessionSelect() {
    const t = getStrings(state.locale);
    clearChildren(el.sessionSelect);

    if (state.sessions.length === 0) {
      const emptyOpt = doc.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = t.noSessions;
      el.sessionSelect.appendChild(emptyOpt);
      el.sessionSelect.disabled = true;
      return;
    }

    el.sessionSelect.disabled = false;
    for (const s of state.sessions) {
      const opt = doc.createElement('option');
      opt.value = s.sessionId;
      const shortId = s.sessionId.slice(0, 8);
      opt.textContent = s.title ? `${s.title} (${shortId})` : shortId;
      el.sessionSelect.appendChild(opt);
    }

    if (state.selectedSessionId) {
      el.sessionSelect.value = state.selectedSessionId;
    }
    setTextIfChanged(
      el.sessionModeBadge,
      state.selectionMode === 'manual' ? t.modeManual : t.modeAuto,
    );
  }

  function renderSnapshot() {
    const t = getStrings(state.locale);
    const snap = state.snapshot;

    if (!snap) {
      setTextIfChanged(el.contextPct, '--%');
      setTextIfChanged(el.contextTokens, '-- / --');
      setTextIfChanged(el.contextLimitTag, t.sourceHost);
      el.contextProgressFill.style.width = '0%';
      el.contextProgressFill.className = 'progress-fill';
      el.contextProgress.setAttribute('aria-valuenow', '0');
      el.softLimitBanner.classList.add('hidden');
      setTextIfChanged(el.btnCompact, t.compactBtn);
      el.btnCompact.disabled = true;
      setTextIfChanged(el.cachePct, '--%');
      setTextIfChanged(el.cacheDetail, t.cacheUnavailable);
      setTextIfChanged(el.detailModel, t.modelUnavailable);
      setTextIfChanged(el.detailSteps, '--');
      clearChildren(el.breakdownList);
      return;
    }

    const pctText = typeof snap.usagePercent === 'number' ? `${snap.usagePercent.toFixed(1)}%` : '--%';
    setTextIfChanged(el.contextPct, pctText);

    const usedText = formatTokenCount(snap.usedTokens);
    const limitText = snap.effectiveLimit > 0 ? formatTokenCount(snap.effectiveLimit) : '--';
    setTextIfChanged(el.contextTokens, `${usedText} / ${limitText}`);

    const sourceLabel =
      snap.limitSource === 'session'
        ? t.sourceSession
        : snap.limitSource === 'default'
          ? t.sourceDefault
          : t.sourceHost;
    setTextIfChanged(el.contextLimitTag, sourceLabel);

    const clampedPct = typeof snap.usagePercent === 'number' ? Math.max(0, Math.min(100, snap.usagePercent)) : 0;
    el.contextProgressFill.style.width = `${clampedPct}%`;
    el.contextProgressFill.className = `progress-fill level-${snap.thresholdLevel || 'normal'}`;
    el.contextProgress.setAttribute('aria-valuenow', String(Math.round(clampedPct)));

    if (snap.exceededSoftLimit) {
      el.softLimitBanner.classList.remove('hidden');
    } else {
      el.softLimitBanner.classList.add('hidden');
    }

    const isCompacting = Boolean(snap.compaction?.inProgress);
    setTextIfChanged(el.btnCompact, isCompacting ? t.compactingBtn : t.compactBtn);
    el.btnCompact.disabled = isCompacting || !state.selectedSessionId;

    if (snap.compaction?.status === 'completed') {
      setTextIfChanged(el.compactStatus, t.compactCompleted);
      el.compactStatus.classList.remove('hidden');
    }

    // Prompt cache hit
    if (typeof snap.cacheHitPercent === 'number') {
      setTextIfChanged(el.cachePct, `${snap.cacheHitPercent.toFixed(1)}%`);
      setTextIfChanged(
        el.cacheDetail,
        `cache: ${formatTokenCount(snap.cacheReadTokens)} / input: ${formatTokenCount(snap.inputTokens)}`,
      );
    } else {
      setTextIfChanged(el.cachePct, '--%');
      setTextIfChanged(el.cacheDetail, t.cacheUnavailable);
    }

    // Detail panel
    setTextIfChanged(el.detailModel, snap.modelName ? snap.modelName : t.modelUnavailable);
    setTextIfChanged(
      el.detailSteps,
      typeof snap.stepCount === 'number' ? `${snap.stepCount} ${t.stepsLabel}` : '--',
    );

    clearChildren(el.breakdownList);
    if (Array.isArray(snap.tokenBreakdown) && snap.tokenBreakdown.length > 0) {
      for (const item of snap.tokenBreakdown) {
        const li = doc.createElement('li');
        li.className = 'breakdown-item';
        const nameSpan = doc.createElement('span');
        nameSpan.textContent = item.label;
        const valSpan = doc.createElement('span');
        valSpan.className = 'muted';
        valSpan.textContent = formatTokenCount(item.tokens);
        li.appendChild(nameSpan);
        li.appendChild(valSpan);
        el.breakdownList.appendChild(li);
      }
    } else {
      const li = doc.createElement('li');
      li.className = 'muted';
      li.textContent = t.noBreakdown;
      el.breakdownList.appendChild(li);
    }
  }

  function renderQuota() {
    const t = getStrings(state.locale);
    const quota = state.quota;
    clearChildren(el.quotaGroups);

    if (!quota || !quota.available || !Array.isArray(quota.groups) || quota.groups.length === 0) {
      el.quotaStaleBadge.classList.add('hidden');
      const empty = doc.createElement('div');
      empty.className = 'muted';
      empty.textContent = t.quotaUnavailable;
      el.quotaGroups.appendChild(empty);
      return;
    }

    if (quota.stale) {
      el.quotaStaleBadge.classList.remove('hidden');
    } else {
      el.quotaStaleBadge.classList.add('hidden');
    }

    for (const group of quota.groups) {
      const groupDiv = doc.createElement('div');
      groupDiv.className = 'quota-group';

      const titleDiv = doc.createElement('div');
      titleDiv.className = 'quota-group-title';
      titleDiv.textContent = group.label;
      groupDiv.appendChild(titleDiv);

      for (const bucket of group.buckets || []) {
        const row = doc.createElement('div');
        row.className = 'quota-bucket-row';

        const left = doc.createElement('span');
        const pct =
          typeof bucket.remainingPercent === 'number' ? `${bucket.remainingPercent.toFixed(0)}%` : '--%';
        left.textContent = `${bucket.window}: ${pct}`;

        const right = doc.createElement('span');
        right.className = 'muted';
        right.textContent = `${t.resetPrefix} ${formatResetTime(bucket.resetTime)}`;

        row.appendChild(left);
        row.appendChild(right);
        groupDiv.appendChild(row);
      }

      el.quotaGroups.appendChild(groupDiv);
    }
  }

  async function refreshSnapshot(sessionId) {
    if (!sessionId || state.disposed) return;

    const myEpoch = ++snapshotEpoch;
    if (snapshotController) {
      snapshotController.abort();
    }
    snapshotController = new AbortController();

    try {
      const snap = await bridge.getSessionSnapshot(sessionId, snapshotController.signal);
      if (state.disposed || myEpoch !== snapshotEpoch || state.selectedSessionId !== sessionId) {
        return;
      }
      if (snap.sessionId !== sessionId) {
        return;
      }
      state.connected = true;
      state.snapshot = snap;
      if (snap.locale && snap.locale !== state.locale) {
        state.locale = snap.locale;
        applyLocaleStrings();
      } else {
        renderConnectionBadge();
        renderSnapshot();
      }

      // Burst polling completion state machine (sawRunning)
      if (state.burstUntil > Date.now()) {
        if (snap.compaction?.inProgress) {
          state.sawRunningDuringBurst = true;
        } else if (state.sawRunningDuringBurst || snap.compaction?.status === 'completed') {
          state.burstUntil = 0;
          state.sawRunningDuringBurst = false;
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || state.disposed || myEpoch !== snapshotEpoch) {
        return;
      }
      state.connected = false;
      renderConnectionBadge();
    }
  }

  async function refreshSessions() {
    if (state.disposed) return;
    const myEpoch = ++sessionListEpoch;
    try {
      const resp = await bridge.listSessions();
      if (state.disposed || myEpoch !== sessionListEpoch) return;
      state.connected = true;
      state.sessions = Array.isArray(resp?.sessions) ? resp.sessions : [];

      if (state.sessions.length === 0) {
        state.selectedSessionId = null;
        state.snapshot = null;
      } else if (state.selectionMode === 'auto') {
        const newestId = state.sessions[0].sessionId;
        if (state.selectedSessionId !== newestId) {
          state.selectedSessionId = newestId;
          state.snapshot = null;
        }
      } else {
        const stillExists = state.sessions.some((s) => s.sessionId === state.selectedSessionId);
        if (!stillExists) {
          state.selectionMode = 'auto';
          state.selectedSessionId = state.sessions[0].sessionId;
          state.snapshot = null;
        }
      }

      renderConnectionBadge();
      renderSessionSelect();
      if (state.selectedSessionId) {
        await refreshSnapshot(state.selectedSessionId);
      } else {
        renderSnapshot();
      }
    } catch {
      if (state.disposed || myEpoch !== sessionListEpoch) return;
      state.connected = false;
      renderConnectionBadge();
    }
  }

  async function refreshQuota() {
    if (state.disposed) return;
    const myEpoch = ++quotaEpoch;
    try {
      const resp = await bridge.getQuotaSummary();
      if (state.disposed || myEpoch !== quotaEpoch) return;
      state.quota = resp;
      renderQuota();
    } catch {
      // Keep last known quota state
    }
  }

  function scheduleNextPoll() {
    if (state.disposed) return;
    clearTimeout(pollTimer);
    if (doc.hidden) return;
    const delay = state.burstUntil > Date.now() ? BURST_POLL_MS : NORMAL_POLL_MS;
    pollTimer = setTimeout(async () => {
      await refreshSessions();
      scheduleNextPoll();
    }, delay);
  }

  function startQuotaTimer() {
    clearInterval(quotaTimer);
    if (state.disposed || doc.hidden) return;
    quotaTimer = setInterval(() => {
      refreshQuota();
    }, QUOTA_POLL_MS);
  }

  function bindEvents() {
    const sig = listenerController.signal;

    el.sessionSelect.addEventListener(
      'change',
      async () => {
        const nextId = el.sessionSelect.value;
        if (!nextId) return;
        state.selectionMode = 'manual';
        state.selectedSessionId = nextId;
        state.snapshot = null;
        renderSessionSelect();
        renderSnapshot();
        await refreshSnapshot(nextId);
      },
      { signal: sig },
    );

    el.btnLocale.addEventListener(
      'click',
      async () => {
        const nextLocale = state.locale === 'ko' ? 'en' : 'ko';
        state.locale = nextLocale;
        applyLocaleStrings();
        try {
          await bridge.updateSettings({ locale: nextLocale });
        } catch {
          // Non-fatal UI fallback
        }
      },
      { signal: sig },
    );

    el.btnContextDetail.addEventListener(
      'click',
      () => {
        state.detailExpanded = !state.detailExpanded;
        el.btnContextDetail.setAttribute('aria-expanded', String(state.detailExpanded));
        el.contextDetailPanel.classList.toggle('hidden', !state.detailExpanded);
      },
      { signal: sig },
    );

    el.limitPresetSelect.addEventListener(
      'change',
      () => {
        el.limitCustomInput.value = el.limitPresetSelect.value;
      },
      { signal: sig },
    );

    el.btnApplyLimit.addEventListener(
      'click',
      async () => {
        const t = getStrings(state.locale);
        const rawStr = el.limitCustomInput.value.trim() || el.limitPresetSelect.value.trim();
        let limit = null;
        if (rawStr !== '') {
          const parsed = Number(rawStr);
          if (!Number.isInteger(parsed) || parsed < 32_000 || parsed > 980_000) {
            setTextIfChanged(el.limitFeedback, t.limitInvalid);
            el.limitFeedback.classList.remove('hidden');
            return;
          }
          limit = parsed;
        }

        const scope = el.limitScopeSelect.value;
        const patch =
          scope === 'default'
            ? { defaultCustomLimit: limit }
            : state.selectedSessionId
              ? { sessionLimit: { sessionId: state.selectedSessionId, limit } }
              : { defaultCustomLimit: limit };

        try {
          await bridge.updateSettings(patch);
          setTextIfChanged(el.limitFeedback, t.limitSaved);
          el.limitFeedback.classList.remove('hidden');
          if (state.selectedSessionId) {
            await refreshSnapshot(state.selectedSessionId);
          }
        } catch {
          setTextIfChanged(el.limitFeedback, t.limitInvalid);
          el.limitFeedback.classList.remove('hidden');
        }
      },
      { signal: sig },
    );

    el.btnCompact.addEventListener(
      'click',
      async () => {
        if (!state.selectedSessionId) return;
        const t = getStrings(state.locale);
        el.btnCompact.disabled = true;
        setTextIfChanged(el.btnCompact, t.compactingBtn);
        setTextIfChanged(el.compactStatus, t.compactAccepted);
        el.compactStatus.classList.remove('hidden');

        try {
          await bridge.requestCompaction(state.selectedSessionId);
          state.burstUntil = Date.now() + MAX_BURST_MS;
          state.sawRunningDuringBurst = false;
          scheduleNextPoll();
          await refreshSnapshot(state.selectedSessionId);
        } catch (err) {
          const msg = err?.code === 'COMPACTION_IN_PROGRESS' ? t.compactInProgress : t.compactFailed;
          setTextIfChanged(el.compactStatus, msg);
          el.compactStatus.classList.remove('hidden');
          el.btnCompact.disabled = false;
          setTextIfChanged(el.btnCompact, t.compactBtn);
        }
      },
      { signal: sig },
    );

    doc.addEventListener(
      'visibilitychange',
      () => {
        if (doc.hidden) {
          clearTimeout(pollTimer);
          clearInterval(quotaTimer);
        } else {
          refreshSessions().then(() => scheduleNextPoll());
          refreshQuota();
          startQuotaTimer();
        }
      },
      { signal: sig },
    );

    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', dispose, { signal: sig });
      win.addEventListener('beforeunload', dispose, { signal: sig });
    }
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    clearTimeout(pollTimer);
    clearInterval(quotaTimer);
    if (snapshotController) {
      snapshotController.abort();
      snapshotController = null;
    }
    listenerController.abort();
  }

  async function start() {
    bindEvents();
    applyLocaleStrings();
    try {
      const settings = await bridge.getSettings();
      if (settings?.locale) {
        state.locale = settings.locale;
        applyLocaleStrings();
      }
    } catch {
      // Proceed with default locale
    }
    await Promise.all([refreshSessions(), refreshQuota()]);
    scheduleNextPoll();
    startQuotaTimer();
  }

  return {
    state,
    start,
    dispose,
    refreshSessions,
    refreshSnapshot,
    refreshQuota,
  };
}

// Auto-bootstrap when running inside a real browser document
if (typeof document !== 'undefined' && document.getElementById('app')) {
  const app = createStatusbarApp({ doc: document, win: window });
  app.start();
}
