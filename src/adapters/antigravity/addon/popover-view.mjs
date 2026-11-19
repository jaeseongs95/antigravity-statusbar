/**
 * 2-tab popover DOM view (Context tab + Settings tab) for the inline statusbar (SRP).
 * Safe DOM construction via createElement + textContent only (no HTML string injection).
 */

export function createPopoverView({ doc, i18n, presets }) {
  const PRESETS = Array.isArray(presets) && presets.length > 0
    ? presets
    : [32000, 64000, 128000, 200000, 256000, 384000, 512000, 980000];

  function setText(el, text) {
    if (el && el.textContent !== text) {
      el.textContent = text;
    }
  }

  function clearChildren(el) {
    while (el && el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  const popEl = doc.createElement('div');
  popEl.className = 'agy-inline-popover hidden';
  popEl.setAttribute('role', 'dialog');
  popEl.setAttribute('aria-label', i18n.t().settingsTitle);

  const popHead = doc.createElement('div');
  popHead.className = 'agy-inline-pop-head';
  const popTitle = doc.createElement('span');
  popTitle.textContent = i18n.t().settingsTitle;

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'agy-inline-pop-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', i18n.t().close);
  popHead.appendChild(popTitle);
  popHead.appendChild(closeBtn);

  const tabList = doc.createElement('div');
  tabList.className = 'agy-inline-tabs';
  tabList.setAttribute('role', 'tablist');

  const tabContextBtn = doc.createElement('button');
  tabContextBtn.type = 'button';
  tabContextBtn.className = 'agy-inline-tab';
  tabContextBtn.setAttribute('role', 'tab');
  tabContextBtn.setAttribute('aria-selected', 'true');
  tabContextBtn.textContent = i18n.t().tabContext;

  const tabSettingsBtn = doc.createElement('button');
  tabSettingsBtn.type = 'button';
  tabSettingsBtn.className = 'agy-inline-tab';
  tabSettingsBtn.setAttribute('role', 'tab');
  tabSettingsBtn.setAttribute('aria-selected', 'false');
  tabSettingsBtn.textContent = i18n.t().tabSettings;

  tabList.appendChild(tabContextBtn);
  tabList.appendChild(tabSettingsBtn);

  // Panel 1: Context (model meta + token breakdown + session context limit)
  const panelContext = doc.createElement('div');
  panelContext.className = 'agy-inline-tabpanel';
  panelContext.setAttribute('role', 'tabpanel');

  const popMeta = doc.createElement('div');
  popMeta.className = 'agy-inline-pop-meta-card';
  const popModel = doc.createElement('span');
  popModel.className = 'agy-inline-pop-meta-model';
  const popSteps = doc.createElement('span');
  popSteps.className = 'agy-inline-pop-meta-steps';
  popMeta.appendChild(popModel);
  popMeta.appendChild(popSteps);

  const breakdownSection = doc.createElement('div');
  breakdownSection.className = 'agy-inline-card';
  const breakdownTitle = doc.createElement('div');
  breakdownTitle.className = 'agy-inline-pop-subtitle';
  breakdownTitle.textContent = i18n.t().breakdownTitle;
  const breakdownList = doc.createElement('ul');
  breakdownList.className = 'agy-inline-pop-list';
  breakdownSection.appendChild(breakdownTitle);
  breakdownSection.appendChild(breakdownList);

  const limitSection = doc.createElement('div');
  limitSection.className = 'agy-inline-card';
  const limitTitle = doc.createElement('div');
  limitTitle.className = 'agy-inline-pop-subtitle';
  limitTitle.textContent = i18n.t().limitTitle;
  const limitHint = doc.createElement('div');
  limitHint.className = 'agy-inline-pop-hint';
  limitHint.textContent = i18n.t().limitHint;

  const limitRow1 = doc.createElement('div');
  limitRow1.className = 'agy-inline-pop-grid2';

  const scopeSelect = doc.createElement('select');
  scopeSelect.className = 'agy-inline-pop-select';
  const optSession = doc.createElement('option');
  optSession.value = 'session';
  optSession.textContent = i18n.t().scopeSession;
  const optDefault = doc.createElement('option');
  optDefault.value = 'default';
  optDefault.textContent = i18n.t().scopeDefault;
  scopeSelect.appendChild(optSession);
  scopeSelect.appendChild(optDefault);

  const presetSelect = doc.createElement('select');
  presetSelect.className = 'agy-inline-pop-select';

  limitRow1.appendChild(scopeSelect);
  limitRow1.appendChild(presetSelect);

  const limitRow2 = doc.createElement('div');
  limitRow2.className = 'agy-inline-pop-input-row';

  const customInput = doc.createElement('input');
  customInput.className = 'agy-inline-pop-input';
  customInput.type = 'number';
  customInput.min = '32000';
  customInput.max = '980000';
  customInput.step = '1000';
  customInput.placeholder = i18n.t().limitPlaceholder;

  const applyBtn = doc.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'agy-inline-btn agy-inline-btn-primary';
  applyBtn.textContent = i18n.t().apply;

  limitRow2.appendChild(customInput);
  limitRow2.appendChild(applyBtn);

  const limitStatusEl = doc.createElement('div');
  limitStatusEl.className = 'agy-inline-pop-hint';

  limitSection.appendChild(limitTitle);
  limitSection.appendChild(limitHint);
  limitSection.appendChild(limitRow1);
  limitSection.appendChild(limitRow2);
  limitSection.appendChild(limitStatusEl);

  panelContext.appendChild(popMeta);
  panelContext.appendChild(breakdownSection);
  panelContext.appendChild(limitSection);

  // Panel 2: Settings (compaction auto-toggle + prompt + add-ons + language)
  const panelSettings = doc.createElement('div');
  panelSettings.className = 'agy-inline-tabpanel hidden';
  panelSettings.setAttribute('role', 'tabpanel');

  const compactionCard = doc.createElement('div');
  compactionCard.className = 'agy-inline-card';

  const compactionCardTitle = doc.createElement('div');
  compactionCardTitle.className = 'agy-inline-pop-subtitle';
  compactionCardTitle.textContent = i18n.t().compactionSettingsTitle;

  const autoCompactRow = doc.createElement('div');
  autoCompactRow.className = 'agy-inline-pop-row';
  const autoCompactLbl = doc.createElement('span');
  autoCompactLbl.className = 'agy-inline-pop-hint';
  autoCompactLbl.textContent = i18n.t().autoCompactLabel;

  const autoCompactWrap = doc.createElement('span');
  autoCompactWrap.className = 'agy-inline-switch-wrap';
  const autoCompactStateText = doc.createElement('span');
  autoCompactStateText.className = 'agy-inline-switch-state';
  autoCompactStateText.textContent = i18n.t().addonOn;
  const autoCompactBtn = doc.createElement('button');
  autoCompactBtn.type = 'button';
  autoCompactBtn.className = 'agy-inline-switch';
  autoCompactBtn.setAttribute('role', 'switch');
  autoCompactBtn.setAttribute('aria-checked', 'true');
  autoCompactBtn.setAttribute('aria-label', i18n.t().autoCompactLabel);
  autoCompactWrap.appendChild(autoCompactStateText);
  autoCompactWrap.appendChild(autoCompactBtn);

  autoCompactRow.appendChild(autoCompactLbl);
  autoCompactRow.appendChild(autoCompactWrap);

  const compactDivider = doc.createElement('div');
  compactDivider.className = 'agy-inline-pop-divider';

  const compactPromptHead = doc.createElement('div');
  compactPromptHead.className = 'agy-inline-pop-row';
  const compactPromptTitle = doc.createElement('div');
  compactPromptTitle.className = 'agy-inline-pop-subtitle';
  compactPromptTitle.textContent = i18n.t().compactPromptTitle;
  const compactPromptCount = doc.createElement('span');
  compactPromptCount.className = 'agy-inline-char-count';
  compactPromptCount.textContent = '0 / 1,000';
  compactPromptHead.appendChild(compactPromptTitle);
  compactPromptHead.appendChild(compactPromptCount);

  const compactPromptInput = doc.createElement('textarea');
  compactPromptInput.className = 'agy-inline-pop-textarea';
  compactPromptInput.rows = 2;
  compactPromptInput.maxLength = 1000;
  compactPromptInput.placeholder = i18n.t().compactPromptPlaceholder;

  const compactPromptFoot = doc.createElement('div');
  compactPromptFoot.className = 'agy-inline-pop-foot-row';
  const compactPromptHintEl = doc.createElement('span');
  compactPromptHintEl.className = 'agy-inline-pop-hint';
  compactPromptHintEl.textContent = i18n.t().compactPromptHint;

  const compactPromptActions = doc.createElement('div');
  compactPromptActions.className = 'agy-inline-pop-actions-end';
  const compactPromptResetBtn = doc.createElement('button');
  compactPromptResetBtn.type = 'button';
  compactPromptResetBtn.className = 'agy-inline-btn';
  compactPromptResetBtn.textContent = i18n.t().reset;
  const compactPromptSaveBtn = doc.createElement('button');
  compactPromptSaveBtn.type = 'button';
  compactPromptSaveBtn.className = 'agy-inline-btn agy-inline-btn-primary';
  compactPromptSaveBtn.textContent = i18n.t().save;
  compactPromptActions.appendChild(compactPromptResetBtn);
  compactPromptActions.appendChild(compactPromptSaveBtn);

  compactPromptFoot.appendChild(compactPromptHintEl);
  compactPromptFoot.appendChild(compactPromptActions);

  compactionCard.appendChild(compactionCardTitle);
  compactionCard.appendChild(autoCompactRow);
  compactionCard.appendChild(compactDivider);
  compactionCard.appendChild(compactPromptHead);
  compactionCard.appendChild(compactPromptInput);
  compactionCard.appendChild(compactPromptFoot);

  const addonSection = doc.createElement('div');
  addonSection.className = 'agy-inline-card';
  const addonTitle = doc.createElement('div');
  addonTitle.className = 'agy-inline-pop-subtitle';
  addonTitle.textContent = i18n.t().addonsTitle;
  const addonListEl = doc.createElement('div');
  addonListEl.className = 'agy-inline-pop-list';
  addonSection.appendChild(addonTitle);
  addonSection.appendChild(addonListEl);

  const langSection = doc.createElement('div');
  langSection.className = 'agy-inline-card';
  const langRow = doc.createElement('div');
  langRow.className = 'agy-inline-pop-row';
  const langRowLabel = doc.createElement('label');
  langRowLabel.className = 'agy-inline-pop-subtitle';
  langRowLabel.textContent = i18n.t().langLabel;

  const langSelect = doc.createElement('select');
  langSelect.className = 'agy-inline-pop-select';
  langSelect.setAttribute('aria-label', i18n.t().langLabel);
  const optKo = doc.createElement('option');
  optKo.value = 'ko';
  optKo.textContent = '한국어';
  const optEn = doc.createElement('option');
  optEn.value = 'en';
  optEn.textContent = 'English';
  langSelect.appendChild(optKo);
  langSelect.appendChild(optEn);
  langSelect.value = i18n.getLocale();

  langRow.appendChild(langRowLabel);
  langRow.appendChild(langSelect);
  langSection.appendChild(langRow);

  panelSettings.appendChild(compactionCard);
  panelSettings.appendChild(addonSection);
  panelSettings.appendChild(langSection);

  const popFeedback = doc.createElement('div');
  popFeedback.className = 'agy-inline-pop-feedback';
  popFeedback.setAttribute('role', 'status');
  popFeedback.setAttribute('aria-live', 'polite');

  popEl.appendChild(popHead);
  popEl.appendChild(tabList);
  popEl.appendChild(panelContext);
  popEl.appendChild(panelSettings);
  popEl.appendChild(popFeedback);

  let lastPresetsKey = '';

  function rebuildPresets(hostMaxTokens = 0) {
    const safeHostMax =
      typeof hostMaxTokens === 'number' && Number.isFinite(hostMaxTokens) && hostMaxTokens > 0
        ? Math.floor(hostMaxTokens)
        : 0;
    const nextKey = `${i18n.getLocale()}:${safeHostMax}`;
    if (lastPresetsKey === nextKey) return;
    lastPresetsKey = nextKey;

    const prev = presetSelect.value;
    clearChildren(presetSelect);
    const tr = i18n.t();
    const hostOpt = doc.createElement('option');
    hostOpt.value = '';
    hostOpt.textContent = tr.hostDefault;
    presetSelect.appendChild(hostOpt);
    for (const p of PRESETS) {
      const o = doc.createElement('option');
      o.value = String(p);
      const kLabel = `${Math.round(p / 1000)}K`;
      if (safeHostMax > 0 && p > safeHostMax) {
        o.textContent = `${kLabel} (${i18n.formatTemplate(tr.overModelMax, { max: i18n.formatTokens(safeHostMax) })})`;
      } else {
        o.textContent = kLabel;
      }
      presetSelect.appendChild(o);
    }
    presetSelect.value = prev;
  }

  function setActiveTab(tab) {
    const isCtx = tab !== 'settings';
    tabContextBtn.setAttribute('aria-selected', String(isCtx));
    tabSettingsBtn.setAttribute('aria-selected', String(!isCtx));
    panelContext.classList.toggle('hidden', !isCtx);
    panelSettings.classList.toggle('hidden', isCtx);
  }

  function setVisible(open) {
    popEl.classList.toggle('hidden', !open);
  }

  function setFeedback(text, isErr = false) {
    popFeedback.className = isErr ? 'agy-inline-pop-feedback err' : 'agy-inline-pop-feedback';
    setText(popFeedback, text);
  }

  function updatePromptCount() {
    const len = compactPromptInput.value.length;
    setText(compactPromptCount, `${len.toLocaleString()} / 1,000`);
  }

  function renderLocaleAndStatic({ autoCompactEnabled }) {
    const tr = i18n.t();
    setText(popTitle, tr.settingsTitle);
    popEl.setAttribute('aria-label', tr.settingsTitle);
    closeBtn.setAttribute('aria-label', tr.close);
    setText(tabContextBtn, tr.tabContext);
    setText(tabSettingsBtn, tr.tabSettings);
    setText(compactionCardTitle, tr.compactionSettingsTitle);
    setText(breakdownTitle, tr.breakdownTitle);
    setText(limitTitle, tr.limitTitle);
    setText(limitHint, tr.limitHint);
    setText(autoCompactLbl, tr.autoCompactLabel);
    autoCompactBtn.setAttribute('aria-checked', String(Boolean(autoCompactEnabled)));
    autoCompactBtn.setAttribute('aria-label', tr.autoCompactLabel);
    setText(autoCompactStateText, autoCompactEnabled ? tr.addonOn : tr.addonOff);
    customInput.placeholder = tr.limitPlaceholder;
    setText(optSession, tr.scopeSession);
    setText(optDefault, tr.scopeDefault);
    setText(applyBtn, tr.apply);
    setText(compactPromptTitle, tr.compactPromptTitle);
    compactPromptInput.placeholder = tr.compactPromptPlaceholder;
    setText(compactPromptHintEl, tr.compactPromptHint);
    setText(compactPromptResetBtn, tr.reset);
    setText(compactPromptSaveBtn, tr.save);
    setText(addonTitle, tr.addonsTitle);
    setText(langRowLabel, tr.langLabel);
    langSelect.setAttribute('aria-label', tr.langLabel);
    if (langSelect.value !== i18n.getLocale()) {
      langSelect.value = i18n.getLocale();
    }
  }

  function renderSnapshotDetails(snap) {
    const tr = i18n.t();
    rebuildPresets(snap?.maxContextTokens || 0);
    if (!snap) {
      setText(limitStatusEl, '');
      setText(popModel, '--');
      setText(popSteps, `${tr.steps} --`);
      clearChildren(breakdownList);
      breakdownSection.style.display = 'none';
      return;
    }

    const limitStr = i18n.formatTokens(snap.effectiveLimit);
    const sourceName =
      snap.limitSource === 'session'
        ? tr.sourceSession
        : snap.limitSource === 'default'
          ? tr.sourceDefault
          : tr.sourceHost;
    const hostMaxStr = i18n.formatTokens(snap.maxContextTokens);
    if (snap.isClampedByHost && typeof snap.customLimit === 'number') {
      setText(
        limitStatusEl,
        i18n.formatTemplate(tr.limitStatusClamped, {
          custom: i18n.formatTokens(snap.customLimit),
          max: hostMaxStr,
        }),
      );
    } else {
      setText(
        limitStatusEl,
        i18n.formatTemplate(tr.limitStatusNormal, {
          eff: limitStr,
          source: sourceName,
          max: hostMaxStr,
        }),
      );
    }

    setText(popModel, snap.modelName || '--');
    const stepStr = typeof snap.stepCount === 'number' ? snap.stepCount.toLocaleString() : '--';
    setText(popSteps, `${tr.steps} ${stepStr}`);

    clearChildren(breakdownList);
    const bdList = Array.isArray(snap.tokenBreakdown)
      ? [...snap.tokenBreakdown].sort((a, b) => (b?.tokens || 0) - (a?.tokens || 0))
      : [];
    const bdTotal = bdList.reduce(
      (sum, it) => sum + (typeof it?.tokens === 'number' ? it.tokens : 0),
      0,
    );
    breakdownSection.style.display = bdList.length > 0 ? '' : 'none';
    for (const item of bdList) {
      if (!item || typeof item.tokens !== 'number' || item.tokens <= 0) continue;
      const sharePct = bdTotal > 0 ? Math.min(100, (item.tokens / bdTotal) * 100) : 0;
      const li = doc.createElement('li');
      li.className = 'agy-inline-bd-item';

      const head = doc.createElement('div');
      head.className = 'agy-inline-bd-head';
      const lbl = doc.createElement('span');
      lbl.className = 'agy-inline-bd-label';
      lbl.textContent = i18n.localizeBreakdownLabel(item.label || item.key || 'Other');
      const val = doc.createElement('span');
      val.className = 'agy-inline-bd-val';
      val.textContent = `${i18n.formatTokens(item.tokens)} (${Math.round(sharePct)}%)`;
      head.appendChild(lbl);
      head.appendChild(val);

      const track = doc.createElement('div');
      track.className = 'agy-inline-bd-track';
      const bar = doc.createElement('div');
      bar.className = 'agy-inline-bd-fill';
      bar.style.width = `${Math.max(2, sharePct).toFixed(1)}%`;
      track.appendChild(bar);

      li.appendChild(head);
      li.appendChild(track);
      breakdownList.appendChild(li);
    }
  }

  function renderAddonList({ items, onToggle, onRemove }) {
    const tr = i18n.t();
    clearChildren(addonListEl);
    if (!Array.isArray(items) || items.length === 0) {
      const emptyEl = doc.createElement('div');
      emptyEl.className = 'agy-inline-pop-hint';
      emptyEl.textContent = tr.addonEmpty;
      addonListEl.appendChild(emptyEl);
      return;
    }

    for (const item of items) {
      const row = doc.createElement('div');
      row.className = 'agy-inline-pop-btn-item';

      const meta = doc.createElement('span');
      meta.className = 'agy-inline-pop-btn-meta';
      const nameSpan = doc.createElement('span');
      nameSpan.textContent = item.label;
      const pillSpan = doc.createElement('span');
      pillSpan.className = 'agy-inline-source-pill';
      pillSpan.textContent = item.source;
      meta.appendChild(nameSpan);
      meta.appendChild(pillSpan);
      meta.title = item.detail;

      const actions = doc.createElement('div');
      actions.className = 'agy-inline-pop-controls';

      const toggleBtn = doc.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = item.enabled ? 'agy-inline-btn agy-inline-btn-on' : 'agy-inline-btn';
      toggleBtn.textContent = item.enabled ? tr.addonOn : tr.addonOff;
      toggleBtn.addEventListener('click', () => onToggle(item.id, !item.enabled, item.runtime));

      const delBtn = doc.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'agy-inline-btn';
      delBtn.textContent = tr.delBtn;
      delBtn.addEventListener('click', () => onRemove(item.id, item.runtime));

      actions.appendChild(toggleBtn);
      actions.appendChild(delBtn);
      row.appendChild(meta);
      row.appendChild(actions);
      addonListEl.appendChild(row);
    }
  }

  rebuildPresets(0);

  return Object.freeze({
    popEl,
    closeBtn,
    tabContextBtn,
    tabSettingsBtn,
    scopeSelect,
    presetSelect,
    customInput,
    applyBtn,
    autoCompactBtn,
    autoCompactStateText,
    compactPromptInput,
    compactPromptSaveBtn,
    compactPromptResetBtn,
    langSelect,
    rebuildPresets,
    setActiveTab,
    setVisible,
    setFeedback,
    updatePromptCount,
    renderLocaleAndStatic,
    renderSnapshotDetails,
    renderAddonList,
  });
}
