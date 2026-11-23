/**
 * Dedicated Global Context Limit modal window view (All-Models Default + Per-Model Global Limits) (SRP).
 * Safe DOM construction via createElement + textContent only (no HTML string injection).
 */

export function createGlobalLimitModalView({ doc, i18n, presets }) {
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

  const backdropEl = doc.createElement('div');
  backdropEl.className = 'agy-inline-modal-backdrop hidden';
  backdropEl.setAttribute('role', 'presentation');

  const dialogEl = doc.createElement('div');
  dialogEl.className = 'agy-inline-modal';
  dialogEl.setAttribute('role', 'dialog');
  dialogEl.setAttribute('aria-modal', 'true');
  dialogEl.setAttribute('aria-label', i18n.t().globalModalTitle);

  // Header
  const headEl = doc.createElement('div');
  headEl.className = 'agy-inline-pop-head';
  const titleEl = doc.createElement('span');
  titleEl.textContent = i18n.t().globalModalTitle;
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'agy-inline-pop-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', i18n.t().close);
  headEl.appendChild(titleEl);
  headEl.appendChild(closeBtn);

  // Priority pill
  const priorityEl = doc.createElement('div');
  priorityEl.className = 'agy-inline-priority-bar';
  priorityEl.textContent = i18n.t().priorityHint;

  // Session override warning banner (visible only when current session overrides global limits)
  const overrideBannerEl = doc.createElement('div');
  overrideBannerEl.className = 'agy-inline-override-banner hidden';
  const overrideTextEl = doc.createElement('span');
  overrideTextEl.className = 'agy-inline-override-text';
  const clearSessionLimitBtn = doc.createElement('button');
  clearSessionLimitBtn.type = 'button';
  clearSessionLimitBtn.className = 'agy-inline-btn';
  clearSessionLimitBtn.textContent = i18n.t().clearSessionLimit;
  overrideBannerEl.appendChild(overrideTextEl);
  overrideBannerEl.appendChild(clearSessionLimitBtn);

  // Card 1: All-models default global limit
  const defaultCard = doc.createElement('div');
  defaultCard.className = 'agy-inline-card';
  const defaultTitle = doc.createElement('div');
  defaultTitle.className = 'agy-inline-pop-subtitle';
  defaultTitle.textContent = i18n.t().globalDefaultCardTitle;
  const defaultHint = doc.createElement('div');
  defaultHint.className = 'agy-inline-pop-hint';
  defaultHint.textContent = i18n.t().globalDefaultCardHint;

  const defaultRow = doc.createElement('div');
  defaultRow.className = 'agy-inline-pop-input-row';
  const defaultPresetSelect = doc.createElement('select');
  defaultPresetSelect.className = 'agy-inline-pop-select';
  const defaultInput = doc.createElement('input');
  defaultInput.className = 'agy-inline-pop-input';
  defaultInput.type = 'text';
  defaultInput.inputMode = 'numeric';
  defaultInput.autocomplete = 'off';
  defaultInput.placeholder = i18n.t().limitPlaceholder;
  const defaultApplyBtn = doc.createElement('button');
  defaultApplyBtn.type = 'button';
  defaultApplyBtn.className = 'agy-inline-btn agy-inline-btn-primary';
  defaultApplyBtn.textContent = i18n.t().apply;
  const defaultResetBtn = doc.createElement('button');
  defaultResetBtn.type = 'button';
  defaultResetBtn.className = 'agy-inline-btn';
  defaultResetBtn.textContent = i18n.t().reset;

  defaultRow.appendChild(defaultPresetSelect);
  defaultRow.appendChild(defaultInput);
  defaultRow.appendChild(defaultApplyBtn);
  defaultRow.appendChild(defaultResetBtn);

  const defaultStatusEl = doc.createElement('div');
  defaultStatusEl.className = 'agy-inline-pop-hint';

  defaultCard.appendChild(defaultTitle);
  defaultCard.appendChild(defaultHint);
  defaultCard.appendChild(defaultRow);
  defaultCard.appendChild(defaultStatusEl);

  // Card 2: Per-model global limits
  const modelCard = doc.createElement('div');
  modelCard.className = 'agy-inline-card';
  const modelHeadRow = doc.createElement('div');
  modelHeadRow.className = 'agy-inline-pop-row';
  const modelTitle = doc.createElement('div');
  modelTitle.className = 'agy-inline-pop-subtitle';
  modelTitle.textContent = i18n.t().modelLimitsCardTitle;
  const useCurrentModelBtn = doc.createElement('button');
  useCurrentModelBtn.type = 'button';
  useCurrentModelBtn.className = 'agy-inline-btn hidden';
  useCurrentModelBtn.textContent = i18n.t().useCurrentModel;
  modelHeadRow.appendChild(modelTitle);
  modelHeadRow.appendChild(useCurrentModelBtn);

  const modelHint = doc.createElement('div');
  modelHint.className = 'agy-inline-pop-hint';
  modelHint.textContent = i18n.t().modelLimitsCardHint;

  const modelNameRow = doc.createElement('div');
  modelNameRow.className = 'agy-inline-pop-input-row';
  const modelNameInput = doc.createElement('input');
  modelNameInput.className = 'agy-inline-pop-input';
  modelNameInput.type = 'text';
  modelNameInput.maxLength = 128;
  modelNameInput.placeholder = i18n.t().modelNamePlaceholder;
  modelNameRow.appendChild(modelNameInput);

  const modelLimitRow = doc.createElement('div');
  modelLimitRow.className = 'agy-inline-pop-input-row';
  const modelPresetSelect = doc.createElement('select');
  modelPresetSelect.className = 'agy-inline-pop-select';
  const modelLimitInput = doc.createElement('input');
  modelLimitInput.className = 'agy-inline-pop-input';
  modelLimitInput.type = 'text';
  modelLimitInput.inputMode = 'numeric';
  modelLimitInput.autocomplete = 'off';
  modelLimitInput.placeholder = i18n.t().limitPlaceholder;
  const modelSaveBtn = doc.createElement('button');
  modelSaveBtn.type = 'button';
  modelSaveBtn.className = 'agy-inline-btn agy-inline-btn-primary';
  modelSaveBtn.textContent = i18n.t().save;

  modelLimitRow.appendChild(modelPresetSelect);
  modelLimitRow.appendChild(modelLimitInput);
  modelLimitRow.appendChild(modelSaveBtn);

  const modelListEl = doc.createElement('div');
  modelListEl.className = 'agy-inline-pop-list';

  modelCard.appendChild(modelHeadRow);
  modelCard.appendChild(modelHint);
  modelCard.appendChild(modelNameRow);
  modelCard.appendChild(modelLimitRow);
  modelCard.appendChild(modelListEl);

  const feedbackEl = doc.createElement('div');
  feedbackEl.className = 'agy-inline-pop-feedback';
  feedbackEl.setAttribute('role', 'status');
  feedbackEl.setAttribute('aria-live', 'polite');

  dialogEl.appendChild(headEl);
  dialogEl.appendChild(priorityEl);
  dialogEl.appendChild(overrideBannerEl);
  dialogEl.appendChild(defaultCard);
  dialogEl.appendChild(modelCard);
  dialogEl.appendChild(feedbackEl);
  backdropEl.appendChild(dialogEl);

  let lastPresetsLocale = '';
  let lastModelListKey = '';
  let currentOnEditModel = null;
  let currentOnRemoveModel = null;

  function fillPresetSelect(selectEl, includeHostDefault) {
    const prev = selectEl.value;
    clearChildren(selectEl);
    const tr = i18n.t();
    const firstOpt = doc.createElement('option');
    firstOpt.value = '';
    firstOpt.textContent = includeHostDefault ? tr.hostDefault : tr.selectPreset;
    selectEl.appendChild(firstOpt);
    for (const p of PRESETS) {
      const o = doc.createElement('option');
      o.value = String(p);
      o.textContent = `${Math.round(p / 1000)}K`;
      selectEl.appendChild(o);
    }
    selectEl.value = prev;
  }

  function rebuildPresetsIfNeeded() {
    const loc = i18n.getLocale();
    if (lastPresetsLocale === loc) return;
    lastPresetsLocale = loc;
    fillPresetSelect(defaultPresetSelect, true);
    fillPresetSelect(modelPresetSelect, false);
  }

  function setVisible(open) {
    backdropEl.classList.toggle('hidden', !open);
  }

  function setFeedback(text, isErr = false) {
    feedbackEl.className = isErr ? 'agy-inline-pop-feedback err' : 'agy-inline-pop-feedback';
    setText(feedbackEl, text);
  }

  function render({
    defaultCustomLimit,
    modelLimits,
    currentModelName,
    sessionOverrideLimit,
    syncDefaultInputs = false,
    onEditModel,
    onRemoveModel,
  }) {
    const tr = i18n.t();
    rebuildPresetsIfNeeded();
    setText(titleEl, tr.globalModalTitle);
    dialogEl.setAttribute('aria-label', tr.globalModalTitle);
    closeBtn.setAttribute('aria-label', tr.close);
    setText(priorityEl, tr.priorityHint);
    setText(clearSessionLimitBtn, tr.clearSessionLimit);
    setText(defaultTitle, tr.globalDefaultCardTitle);
    setText(defaultHint, tr.globalDefaultCardHint);
    defaultInput.placeholder = tr.limitPlaceholder;
    setText(defaultApplyBtn, tr.apply);
    setText(defaultResetBtn, tr.reset);
    setText(modelTitle, tr.modelLimitsCardTitle);
    setText(modelHint, tr.modelLimitsCardHint);
    modelNameInput.placeholder = tr.modelNamePlaceholder;
    modelLimitInput.placeholder = tr.limitPlaceholder;
    setText(modelSaveBtn, tr.save);

    if (typeof sessionOverrideLimit === 'number') {
      overrideBannerEl.classList.remove('hidden');
      setText(
        overrideTextEl,
        i18n.formatTemplate(tr.sessionOverrideWarning, {
          val: i18n.formatTokens(sessionOverrideLimit),
        }),
      );
    } else {
      overrideBannerEl.classList.add('hidden');
    }

    if (typeof defaultCustomLimit === 'number') {
      setText(
        defaultStatusEl,
        i18n.formatTemplate(tr.globalDefaultCurrent, {
          val: i18n.formatTokens(defaultCustomLimit),
        }),
      );
    } else {
      setText(defaultStatusEl, tr.globalDefaultUnset);
    }

    if (syncDefaultInputs) {
      const strVal = typeof defaultCustomLimit === 'number' ? String(defaultCustomLimit) : '';
      defaultInput.value = strVal;
      defaultPresetSelect.value =
        typeof defaultCustomLimit === 'number' && PRESETS.includes(defaultCustomLimit) ? strVal : '';
    }

    if (typeof currentModelName === 'string' && currentModelName.trim()) {
      useCurrentModelBtn.classList.remove('hidden');
      setText(useCurrentModelBtn, tr.useCurrentModel);
      useCurrentModelBtn.title = currentModelName.trim();
    } else {
      useCurrentModelBtn.classList.add('hidden');
    }

    currentOnEditModel = onEditModel;
    currentOnRemoveModel = onRemoveModel;

    const list = Array.isArray(modelLimits) ? modelLimits : [];
    const nextModelListKey = JSON.stringify({
      loc: i18n.getLocale(),
      items: list.map((item) => [item.model, item.limit]),
    });
    if (lastModelListKey === nextModelListKey) {
      return;
    }
    lastModelListKey = nextModelListKey;

    clearChildren(modelListEl);
    if (list.length === 0) {
      const emptyEl = doc.createElement('div');
      emptyEl.className = 'agy-inline-pop-hint';
      emptyEl.textContent = tr.modelEmpty;
      modelListEl.appendChild(emptyEl);
    } else {
      for (const item of list) {
        const row = doc.createElement('div');
        row.className = 'agy-inline-pop-btn-item';

        const meta = doc.createElement('span');
        meta.className = 'agy-inline-pop-btn-meta';
        const nameSpan = doc.createElement('span');
        nameSpan.textContent = item.model;
        const valPill = doc.createElement('span');
        valPill.className = 'agy-inline-source-pill';
        valPill.textContent = i18n.formatTokens(item.limit);
        meta.appendChild(nameSpan);
        meta.appendChild(valPill);
        meta.title = `${item.model}: ${item.limit.toLocaleString()}`;

        const actions = doc.createElement('div');
        actions.className = 'agy-inline-pop-controls';
        const editBtn = doc.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'agy-inline-btn';
        editBtn.textContent = tr.editBtn;
        editBtn.addEventListener('click', () => {
          if (typeof currentOnEditModel === 'function') currentOnEditModel(item);
        });

        const delBtn = doc.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'agy-inline-btn';
        delBtn.textContent = tr.delBtn;
        delBtn.addEventListener('click', () => {
          if (typeof currentOnRemoveModel === 'function') currentOnRemoveModel(item.model);
        });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        row.appendChild(meta);
        row.appendChild(actions);
        modelListEl.appendChild(row);
      }
    }
  }

  rebuildPresetsIfNeeded();

  return Object.freeze({
    backdropEl,
    dialogEl,
    closeBtn,
    clearSessionLimitBtn,
    defaultPresetSelect,
    defaultInput,
    defaultApplyBtn,
    defaultResetBtn,
    useCurrentModelBtn,
    modelNameInput,
    modelPresetSelect,
    modelLimitInput,
    modelSaveBtn,
    setVisible,
    setFeedback,
    render,
  });
}
