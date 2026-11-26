/**
 * Pure Tier-2 Declarative UI Schema Builders (16 closed primitives, zero raw DOM / HTML) (SRP).
 *
 * Every function is self-contained (zero outer closures) so it can be imported directly in Node
 * unit/parity tests and deterministically assembled into the v3 static renderer bundle.
 *
 * Replaces all manual popover/modal DOM construction and coordinate calculation with
 * host-managed `ui.openPopup`, `ui.openModal`, and `ui.registerSettingsPage` schemas.
 */

export function createDeclarativeUiSchemas({ i18n, presets }) {
  const PRESETS =
    Array.isArray(presets) && presets.length > 0
      ? presets
      : [32000, 64000, 128000, 200000, 256000, 384000, 512000, 980000];

  function toSafeNodeKey(raw, fallback) {
    const cleaned = String(raw || '')
      .replace(/[^a-zA-Z0-9._:-]/g, '_')
      .slice(0, 36);
    if (!cleaned || !/^[a-zA-Z0-9]/.test(cleaned)) {
      return fallback;
    }
    return cleaned;
  }

  function buildPresetOptions(maxContextTokens, includeHostDefault = true) {
    const tr = i18n.t();
    const opts = [
      {
        value: '',
        label: includeHostDefault ? tr.hostDefault : tr.selectPreset,
      },
    ];
    for (let i = 0; i < PRESETS.length; i += 1) {
      const p = PRESETS[i];
      const overMax = typeof maxContextTokens === 'number' && maxContextTokens > 0 && p > maxContextTokens;
      opts.push({
        value: String(p),
        label: overMax
          ? `${p.toLocaleString()} (${i18n.formatTemplate(tr.overModelMax, { max: i18n.formatTokens(maxContextTokens) })})`
          : p.toLocaleString(),
      });
    }
    return opts;
  }

  function buildLimitStatusText(snap) {
    if (!snap) return '';
    const tr = i18n.t();
    const maxTokens = typeof snap.maxContextTokens === 'number' ? snap.maxContextTokens : 0;
    const sourceLabel =
      snap.limitSource === 'session'
        ? tr.sourceSession
        : snap.limitSource === 'model'
          ? tr.sourceModel
          : snap.limitSource === 'default'
            ? tr.sourceDefault
            : tr.sourceHost;
    if (snap.isClampedByHost && typeof snap.customLimit === 'number') {
      return i18n.formatTemplate(tr.limitStatusClamped, {
        custom: i18n.formatTokens(snap.customLimit),
        max: i18n.formatTokens(maxTokens),
      });
    }
    return i18n.formatTemplate(tr.limitStatusNormal, {
      eff: i18n.formatTokens(snap.effectiveLimit),
      source: sourceLabel,
      max: i18n.formatTokens(maxTokens),
    });
  }

  function buildContextPopupSpec({
    snap = null,
    scope = 'session',
    customLimit = '',
    preset = '',
    feedback = '',
    feedbackIsErr = false,
  } = {}) {
    const tr = i18n.t();
    const modelName = snap && typeof snap.modelName === 'string' && snap.modelName ? snap.modelName : '--';
    const stepCount = snap && typeof snap.stepCount === 'number' ? snap.stepCount : '--';
    const maxTokens = snap && typeof snap.maxContextTokens === 'number' ? snap.maxContextTokens : 0;

    const rawBd = Array.isArray(snap?.tokenBreakdown) ? snap.tokenBreakdown : [];
    const sortedBd = rawBd
      .filter((item) => item && typeof item.tokens === 'number' && item.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);
    const totalBd = sortedBd.reduce((sum, item) => sum + item.tokens, 0) || 1;

    const breakdownChildren = [];
    if (sortedBd.length === 0) {
      breakdownChildren.push({
        type: 'text',
        id: 'ctx-bd-empty',
        text: '--',
        tone: 'muted',
      });
    } else {
      for (let i = 0; i < sortedBd.length; i += 1) {
        const item = sortedBd[i];
        const pct = Math.min(100, Math.round((item.tokens / totalBd) * 100));
        const label = i18n.localizeBreakdownLabel(item.label || item.key || 'Other');
        breakdownChildren.push({
          type: 'progress',
          id: `ctx-bd-${i}`,
          label: `${label} · ${i18n.formatTokens(item.tokens)} (${pct}%)`,
          value: pct,
          max: 100,
        });
      }
    }

    const limitStatus = buildLimitStatusText(snap);

    const tree = {
      type: 'stack',
      id: 'ctx-root',
      children: [
        {
          type: 'row',
          id: 'ctx-meta-row',
          children: [
            { type: 'badge', id: 'ctx-model-badge', text: modelName },
            { type: 'text', id: 'ctx-steps-text', text: `${tr.steps}: ${stepCount}`, tone: 'muted' },
          ],
        },
        {
          type: 'section',
          id: 'ctx-breakdown-sec',
          title: tr.breakdownTitle,
          children: breakdownChildren,
        },
        {
          type: 'section',
          id: 'ctx-limit-sec',
          title: tr.limitTitle,
          children: [
            { type: 'text', id: 'ctx-limit-hint', text: tr.limitHint, tone: 'muted' },
            {
              type: 'select',
              id: 'ctx-scope-select',
              label: tr.scopeSession,
              field: 'scope',
              options: [
                { value: 'session', label: tr.scopeSession },
                { value: 'default', label: tr.scopeDefault },
              ],
            },
            {
              type: 'select',
              id: 'ctx-preset-select',
              label: tr.selectPreset,
              field: 'preset',
              options: buildPresetOptions(maxTokens, true),
            },
            {
              type: 'input',
              id: 'ctx-custom-input',
              label: tr.limitPlaceholder,
              field: 'customLimit',
              inputType: 'text',
              placeholder: tr.limitPlaceholder,
              submitActionId: 'apply-limit',
            },
            {
              type: 'row',
              id: 'ctx-limit-actions',
              children: [
                {
                  type: 'button',
                  id: 'ctx-apply-btn',
                  label: tr.apply,
                  variant: 'primary',
                  actionId: 'apply-limit',
                },
                {
                  type: 'button',
                  id: 'ctx-global-btn',
                  label: tr.globalLimitBtn,
                  actionId: 'open-global-limits',
                },
                {
                  type: 'button',
                  id: 'ctx-open-settings-btn',
                  label: tr.tabSettings,
                  actionId: 'open-settings',
                },
              ],
            },
            {
              type: 'text',
              id: 'ctx-limit-status',
              text: limitStatus,
              tone: 'muted',
              visibleWhen: { field: 'hasLimitStatus', eq: true },
            },
          ],
        },
        {
          type: 'alert',
          id: 'ctx-feedback',
          text: feedback || '',
          variant: feedbackIsErr ? 'danger' : 'info',
          visibleWhen: { field: 'hasFeedback', eq: true },
        },
      ],
    };

    const state = {
      scope: scope === 'default' ? 'default' : 'session',
      preset: String(preset || ''),
      customLimit: String(customLimit || ''),
      hasLimitStatus: Boolean(limitStatus),
      hasFeedback: Boolean(feedback),
    };

    return { tree, state };
  }

  function buildGlobalLimitModalSpec({
    defaultCustomLimit = null,
    defaultLimitInput = '',
    defaultPreset = '',
    modelLimits = [],
    currentModelName = '',
    modelNameInput = '',
    modelLimitInput = '',
    modelPreset = '',
    sessionOverrideLimit = null,
    showBackToSettings = false,
    feedback = '',
    feedbackIsErr = false,
  } = {}) {
    const tr = i18n.t();
    const hasSessionOverride = typeof sessionOverrideLimit === 'number';
    const hasCurrentModel = Boolean(currentModelName && String(currentModelName).trim());
    const defaultStatusText =
      typeof defaultCustomLimit === 'number'
        ? i18n.formatTemplate(tr.globalDefaultCurrent, {
            val: `${defaultCustomLimit.toLocaleString()} (${i18n.formatTokens(defaultCustomLimit)})`,
          })
        : tr.globalDefaultUnset;

    const sortedModels = Array.isArray(modelLimits)
      ? [...modelLimits]
          .filter((m) => m && typeof m.model === 'string' && typeof m.limit === 'number')
          .sort((a, b) => a.model.localeCompare(b.model))
          .slice(0, 25)
      : [];

    const modelRows = [];
    if (sortedModels.length === 0) {
      modelRows.push({
        type: 'text',
        id: 'gm-models-empty',
        text: tr.modelEmpty,
        tone: 'muted',
      });
    } else {
      for (let i = 0; i < sortedModels.length; i += 1) {
        const item = sortedModels[i];
        const rowKey = `${i}-${toSafeNodeKey(item.model, `m${i}`)}`;
        modelRows.push({
          type: 'row',
          id: `gm-mrow-${rowKey}`,
          children: [
            {
              type: 'text',
              id: `gm-mlbl-${rowKey}`,
              text: `${item.model} · ${i18n.formatTokens(item.limit)}`,
            },
            {
              type: 'button',
              id: `gm-medit-${rowKey}`,
              label: tr.editBtn,
              actionId: 'edit-model-limit',
              payload: { model: item.model, limit: item.limit },
            },
            {
              type: 'button',
              id: `gm-mdel-${rowKey}`,
              label: tr.delBtn,
              variant: 'danger',
              actionId: 'remove-model-limit',
              payload: { model: item.model },
            },
          ],
        });
      }
    }

    const rootChildren = [];
    if (showBackToSettings) {
      rootChildren.push({
        type: 'row',
        id: 'gm-back-row',
        children: [
          {
            type: 'button',
            id: 'gm-back-settings-btn',
            label: tr.backToSettings,
            actionId: 'back-to-settings',
          },
          {
            type: 'heading',
            id: 'gm-subview-heading',
            level: 3,
            text: tr.globalModalTitle,
          },
        ],
      });
    }
    rootChildren.push(
        { type: 'text', id: 'gm-priority-hint', text: tr.priorityHint, tone: 'muted' },
        {
          type: 'section',
          id: 'gm-override-sec',
          visibleWhen: { field: 'hasSessionOverride', eq: true },
          children: [
            {
              type: 'alert',
              id: 'gm-override-alert',
              variant: 'warning',
              text: hasSessionOverride
                ? i18n.formatTemplate(tr.sessionOverrideWarning, {
                    val: i18n.formatTokens(sessionOverrideLimit),
                  })
                : '',
            },
            {
              type: 'row',
              id: 'gm-override-actions',
              children: [
                {
                  type: 'button',
                  id: 'gm-clear-session-btn',
                  label: tr.clearSessionLimit,
                  actionId: 'clear-session-limit',
                },
              ],
            },
          ],
        },
        {
          type: 'section',
          id: 'gm-default-sec',
          title: tr.globalDefaultCardTitle,
          children: [
            { type: 'text', id: 'gm-default-hint', text: tr.globalDefaultCardHint, tone: 'muted' },
            { type: 'text', id: 'gm-default-status', text: defaultStatusText, tone: 'muted' },
            {
              type: 'select',
              id: 'gm-default-preset',
              label: tr.selectPreset,
              field: 'defaultPreset',
              options: buildPresetOptions(0, true),
            },
            {
              type: 'input',
              id: 'gm-default-input',
              label: tr.limitPlaceholder,
              field: 'defaultLimitInput',
              inputType: 'text',
              placeholder: tr.limitPlaceholder,
              submitActionId: 'save-default-limit',
            },
            {
              type: 'row',
              id: 'gm-default-actions',
              children: [
                {
                  type: 'button',
                  id: 'gm-default-apply-btn',
                  label: tr.apply,
                  variant: 'primary',
                  actionId: 'save-default-limit',
                },
                {
                  type: 'button',
                  id: 'gm-default-reset-btn',
                  label: tr.reset,
                  actionId: 'reset-default-limit',
                },
              ],
            },
          ],
        },
        {
          type: 'section',
          id: 'gm-model-sec',
          title: tr.modelLimitsCardTitle,
          children: [
            { type: 'text', id: 'gm-model-hint', text: tr.modelLimitsCardHint, tone: 'muted' },
            {
              type: 'row',
              id: 'gm-model-pick-actions',
              children: [
                {
                  type: 'button',
                  id: 'gm-use-current-model-btn',
                  label: tr.useCurrentModel,
                  actionId: 'use-current-model',
                  disabledWhen: { field: 'hasCurrentModel', eq: false },
                },
              ],
            },
            {
              type: 'input',
              id: 'gm-model-name-input',
              label: tr.model,
              field: 'modelNameInput',
              inputType: 'text',
              placeholder: tr.modelNamePlaceholder,
            },
            {
              type: 'select',
              id: 'gm-model-preset',
              label: tr.selectPreset,
              field: 'modelPreset',
              options: buildPresetOptions(0, false),
            },
            {
              type: 'input',
              id: 'gm-model-limit-input',
              label: tr.limitPlaceholder,
              field: 'modelLimitInput',
              inputType: 'text',
              placeholder: tr.limitPlaceholder,
              submitActionId: 'save-model-limit',
            },
            {
              type: 'row',
              id: 'gm-model-actions',
              children: [
                {
                  type: 'button',
                  id: 'gm-model-save-btn',
                  label: tr.save,
                  variant: 'primary',
                  actionId: 'save-model-limit',
                },
              ],
            },
            { type: 'divider', id: 'gm-models-div' },
            {
              type: 'stack',
              id: 'gm-models-list',
              children: modelRows,
            },
          ],
        },
        {
          type: 'alert',
          id: 'gm-feedback',
          text: feedback || '',
          variant: feedbackIsErr ? 'danger' : 'info',
          visibleWhen: { field: 'hasFeedback', eq: true },
        },
    );

    const tree = {
      type: 'stack',
      id: 'gm-root',
      children: rootChildren,
    };

    const state = {
      hasSessionOverride,
      hasCurrentModel,
      defaultPreset: String(defaultPreset || ''),
      defaultLimitInput: String(defaultLimitInput || ''),
      modelNameInput: String(modelNameInput || ''),
      modelPreset: String(modelPreset || ''),
      modelLimitInput: String(modelLimitInput || ''),
      hasFeedback: Boolean(feedback),
    };

    return { tree, state };
  }

  function buildSettingsPageSpec({
    isRemoteWeb = false,
    remoteBridgeStatusText = '',
    remoteBridgeStatusVariant = 'info',
    remoteBridgeBadgeText = '',
    remoteBridgeBadgeVariant = '',
    globalSummaryText = '',
    autoCompact = true,
    compactPrompt = '',
    addonsList = [],
    locale = 'ko',
    feedback = '',
    feedbackIsErr = false,
  } = {}) {
    const tr = i18n.t();
    const promptLen = String(compactPrompt || '').length;
    const sections = [];

    // Remote Web ONLY: read-only Native Host Remote Bridge status & guidance (zero plugin-owned URL/token inputs)
    if (isRemoteWeb) {
      const bridgeChildren = [];
      if (remoteBridgeBadgeText) {
        const badgeNode = {
          type: 'badge',
          id: 'set-remote-bridge-badge',
          text: remoteBridgeBadgeText,
        };
        if (remoteBridgeBadgeVariant) {
          badgeNode.variant = remoteBridgeBadgeVariant;
        }
        bridgeChildren.push({
          type: 'row',
          id: 'set-remote-bridge-badge-row',
          children: [badgeNode],
        });
      }
      bridgeChildren.push({
        type: 'alert',
        id: 'set-remote-bridge-status',
        text: remoteBridgeStatusText || tr.remoteBridgeGuideDisconnected,
        variant: remoteBridgeStatusVariant || 'warning',
      });
      sections.push({
        type: 'section',
        id: 'set-remote-bridge-sec',
        title: tr.remoteBridgeTitle,
        visibleWhen: { field: 'isRemoteWeb', eq: true },
        children: bridgeChildren,
      });
    }

    const globalSecChildren = [
      { type: 'text', id: 'set-global-hint', text: tr.priorityHint, tone: 'muted' },
    ];
    if (globalSummaryText) {
      globalSecChildren.push({
        type: 'text',
        id: 'set-global-summary',
        text: globalSummaryText,
      });
    }
    globalSecChildren.push({
      type: 'row',
      id: 'set-global-actions',
      children: [
        {
          type: 'button',
          id: 'set-open-global-btn',
          label: tr.globalLimitSettingsBtn,
          actionId: 'open-global-limits',
        },
      ],
    });

    sections.push({
      type: 'section',
      id: 'set-global-sec',
      title: tr.globalModalTitle,
      children: globalSecChildren,
    });

    sections.push({
      type: 'section',
      id: 'set-compact-sec',
      title: tr.compactionSettingsTitle,
      children: [
        {
          type: 'toggle',
          id: 'set-autocompact-toggle',
          label: tr.autoCompactLabel,
          field: 'autoCompact',
        },
        {
          type: 'textarea',
          id: 'set-compact-prompt',
          label: tr.compactPromptTitle,
          field: 'compactPrompt',
          rows: 4,
          placeholder: tr.compactPromptPlaceholder,
        },
        {
          type: 'text',
          id: 'set-prompt-count',
          text: `${promptLen.toLocaleString()} / 1,000`,
          tone: 'muted',
        },
        {
          type: 'row',
          id: 'set-prompt-actions',
          children: [
            {
              type: 'button',
              id: 'set-prompt-save-btn',
              label: tr.save,
              variant: 'primary',
              actionId: 'save-compact-prompt',
            },
            {
              type: 'button',
              id: 'set-prompt-reset-btn',
              label: tr.reset,
              actionId: 'reset-compact-prompt',
            },
          ],
        },
      ],
    });

    const visibleAddons = Array.isArray(addonsList) ? addonsList.slice(0, 25) : [];
    const addonRows = [];
    if (visibleAddons.length === 0) {
      addonRows.push({
        type: 'text',
        id: 'set-addons-empty',
        text: tr.addonEmpty,
        tone: 'muted',
      });
    } else {
      for (let i = 0; i < visibleAddons.length; i += 1) {
        const item = visibleAddons[i];
        const key = `${i}-${toSafeNodeKey(item.id, `a${i}`)}`;
        const rowChildren = [
          {
            type: 'text',
            id: `set-addon-lbl-${key}`,
            text: `${item.label} (${item.source || 'plugin'})`,
          },
        ];
        if (!item.delegated) {
          rowChildren.push(
            {
              type: 'button',
              id: `set-addon-tog-${key}`,
              label: item.enabled ? tr.addonOn : tr.addonOff,
              variant: item.enabled ? 'primary' : undefined,
              actionId: 'toggle-addon',
              payload: { id: item.id, enabled: !item.enabled, runtime: Boolean(item.runtime) },
            },
            {
              type: 'button',
              id: `set-addon-del-${key}`,
              label: tr.delBtn,
              variant: 'danger',
              actionId: 'remove-addon',
              payload: { id: item.id, runtime: Boolean(item.runtime) },
            },
          );
        } else {
          rowChildren.push({
            type: 'badge',
            id: `set-addon-badge-${key}`,
            text: 'host.statusbar',
            variant: 'success',
          });
        }
        addonRows.push({
          type: 'row',
          id: `set-addon-row-${key}`,
          children: rowChildren,
        });
      }
    }

    sections.push({
      type: 'section',
      id: 'set-addons-sec',
      title: tr.addonsTitle,
      children: addonRows,
    });

    sections.push({
      type: 'section',
      id: 'set-lang-sec',
      title: tr.langLabel,
      children: [
        {
          type: 'segmented',
          id: 'set-lang-select',
          field: 'locale',
          options: [
            { value: 'ko', label: '한국어' },
            { value: 'en', label: 'EN' },
          ],
        },
      ],
    });

    sections.push({
      type: 'alert',
      id: 'set-feedback',
      text: feedback || '',
      variant: feedbackIsErr ? 'danger' : 'info',
      visibleWhen: { field: 'hasFeedback', eq: true },
    });

    const tree = {
      type: 'stack',
      id: 'set-root',
      children: sections,
    };

    const state = {
      isRemoteWeb: Boolean(isRemoteWeb),
      autoCompact: Boolean(autoCompact),
      compactPrompt: String(compactPrompt || ''),
      locale: locale === 'en' ? 'en' : 'ko',
      hasFeedback: Boolean(feedback),
    };

    return { tree, state };
  }

  return Object.freeze({
    buildContextPopupSpec,
    buildGlobalLimitModalSpec,
    buildSettingsPageSpec,
  });
}
