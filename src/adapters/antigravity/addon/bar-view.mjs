/**
 * Main inline statusbar DOM view (SRP).
 * Safe DOM construction via createElement + textContent only (no HTML string injection).
 */

export function createBarView({ doc, i18n }) {
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

  const barEl = doc.createElement('div');
  barEl.className = 'agy-inline-statusbar';
  barEl.setAttribute('role', 'region');
  barEl.setAttribute('aria-label', 'Statusbar');

  const leftEl = doc.createElement('div');
  leftEl.className = 'agy-inline-left';

  const ctxBtn = doc.createElement('button');
  ctxBtn.type = 'button';
  ctxBtn.className = 'agy-inline-metric-btn';
  ctxBtn.setAttribute('aria-expanded', 'false');

  const trackEl = doc.createElement('span');
  trackEl.className = 'agy-inline-bar-track';
  const fillEl = doc.createElement('span');
  fillEl.className = 'agy-inline-bar-fill';
  trackEl.appendChild(fillEl);

  const ctxTextEl = doc.createElement('span');
  ctxTextEl.textContent = i18n.t().connecting;

  ctxBtn.appendChild(trackEl);
  ctxBtn.appendChild(ctxTextEl);

  const softBadgeEl = doc.createElement('span');
  softBadgeEl.className = 'agy-inline-badge';
  softBadgeEl.style.display = 'none';

  const sep1 = doc.createElement('span');
  sep1.className = 'agy-inline-sep';
  sep1.textContent = '·';

  const cacheEl = doc.createElement('span');
  cacheEl.className = 'agy-inline-metric';
  cacheEl.textContent = `${i18n.t().cache} --`;

  const sep2 = doc.createElement('span');
  sep2.className = 'agy-inline-sep';
  sep2.textContent = '·';

  const quota5hEl = doc.createElement('span');
  quota5hEl.className = 'agy-inline-metric';
  quota5hEl.textContent = `${i18n.t().quota5h} --`;

  const sep3 = doc.createElement('span');
  sep3.className = 'agy-inline-sep';
  sep3.textContent = '·';

  const quotaEl = doc.createElement('span');
  quotaEl.className = 'agy-inline-metric';
  quotaEl.textContent = `${i18n.t().quotaWeekly} --`;

  leftEl.appendChild(ctxBtn);
  leftEl.appendChild(softBadgeEl);
  leftEl.appendChild(sep1);
  leftEl.appendChild(cacheEl);
  leftEl.appendChild(sep2);
  leftEl.appendChild(quota5hEl);
  leftEl.appendChild(sep3);
  leftEl.appendChild(quotaEl);

  const rightEl = doc.createElement('div');
  rightEl.className = 'agy-inline-right';

  const noteEl = doc.createElement('span');
  noteEl.className = 'agy-inline-status-note';

  const customBtnsContainer = doc.createElement('div');
  customBtnsContainer.className = 'agy-inline-custom-btns';

  const compactBtn = doc.createElement('button');
  compactBtn.type = 'button';
  compactBtn.className = 'agy-inline-btn';
  compactBtn.textContent = i18n.t().compact;

  const settingsBtn = doc.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'agy-inline-btn';
  settingsBtn.textContent = '⚙';
  settingsBtn.setAttribute('aria-label', i18n.t().settingsTitle);
  settingsBtn.setAttribute('aria-expanded', 'false');

  rightEl.appendChild(noteEl);
  rightEl.appendChild(customBtnsContainer);
  rightEl.appendChild(compactBtn);
  rightEl.appendChild(settingsBtn);

  barEl.appendChild(leftEl);
  barEl.appendChild(rightEl);

  function renderSnapshot({ snap, connected, compacting, hasSession, compactPrompt }) {
    const tr = i18n.t();
    const isBackendCompacting = Boolean(snap?.compaction?.inProgress);
    const isCompactingNow = Boolean(compacting || isBackendCompacting);
    compactBtn.disabled = isCompactingNow || !hasSession;
    setText(compactBtn, isCompactingNow ? tr.compacting : tr.compact);
    compactBtn.title = compactPrompt ? `/compact ${compactPrompt}` : '/compact';
    settingsBtn.setAttribute('aria-label', tr.settingsTitle);

    if (!snap) {
      setText(ctxTextEl, connected ? `${tr.ctx} --` : tr.connecting);
      fillEl.style.width = '0%';
      fillEl.className = 'agy-inline-bar-fill';
      softBadgeEl.style.display = 'none';
      setText(cacheEl, `${tr.cache} --`);
      return;
    }

    const rawPct =
      typeof snap.usagePercent === 'number' && Number.isFinite(snap.usagePercent)
        ? Math.max(0, snap.usagePercent)
        : 0;
    const barPct = Math.min(100, rawPct);
    const usedStr = i18n.formatTokens(snap.usedTokens);
    const limitStr = i18n.formatTokens(snap.effectiveLimit);
    setText(ctxTextEl, `${tr.ctx} ${rawPct.toFixed(0)}% (${usedStr} / ${limitStr})`);

    const isSoftExceeded = Boolean(snap.exceededSoftLimit || snap.softLimitExceeded);
    fillEl.style.width = `${barPct}%`;
    fillEl.className =
      'agy-inline-bar-fill' +
      (isSoftExceeded || rawPct >= 90 ? ' danger' : rawPct >= 75 ? ' warn' : '');

    if (snap.autoCompactTriggered || snap.compaction?.trigger === 'auto') {
      softBadgeEl.style.display = '';
      setText(softBadgeEl, tr.autoCompacting);
    } else if (isBackendCompacting) {
      softBadgeEl.style.display = '';
      setText(softBadgeEl, tr.compactingBadge);
    } else if (isSoftExceeded) {
      softBadgeEl.style.display = '';
      setText(softBadgeEl, tr.softLimit);
    } else {
      softBadgeEl.style.display = 'none';
    }

    const rawCachePct =
      typeof snap.cacheHitPercent === 'number'
        ? snap.cacheHitPercent
        : snap.cache && typeof snap.cache.hitRatePercent === 'number'
          ? snap.cache.hitRatePercent
          : null;
    const cachePct = rawCachePct !== null ? `${rawCachePct.toFixed(0)}%` : '--';
    setText(cacheEl, `${tr.cache} ${cachePct}`);
  }

  function classifyQuotaWindow(rawWindow) {
    const w = String(rawWindow || '').trim().toLowerCase();
    if (
      w === '5h' ||
      w.includes('5h') ||
      w.includes('5-hour') ||
      w.includes('five hour') ||
      w.includes('5 hour')
    ) {
      return '5h';
    }
    if (w === 'weekly' || w.includes('week') || w === '7d') {
      return 'weekly';
    }
    return 'other';
  }

  function matchQuotaGroupsForModel(groups, modelName) {
    const lowerModel = typeof modelName === 'string' ? modelName.toLowerCase() : '';
    if (!lowerModel) return groups;
    const isThirdParty = /\b(?:claude|gpt|openai|o1|o3|o4)\b/.test(lowerModel);
    const isGemini = /\b(?:gemini|orchestrator)\b/.test(lowerModel);
    if (isThirdParty) {
      const matched = groups.filter((g) =>
        /\b(?:claude|gpt|3p|openai)\b/i.test(String(g?.label || '')),
      );
      if (matched.length > 0) return matched;
    } else if (isGemini) {
      const matched = groups.filter((g) => /\bgemini\b/i.test(String(g?.label || '')));
      if (matched.length > 0) return matched;
    }
    return groups;
  }

  function renderQuota(quotaState, modelName = '') {
    const tr = i18n.t();
    if (quotaState && quotaState.available && Array.isArray(quotaState.groups) && quotaState.groups.length > 0) {
      const allBuckets = [];
      for (const g of quotaState.groups) {
        const buckets = Array.isArray(g.buckets) ? g.buckets : [];
        for (const b of buckets) {
          if (typeof b.remainingPercent === 'number') {
            allBuckets.push({
              label: g.label || 'Quota',
              window: b.window || '',
              pct: b.remainingPercent,
            });
          }
        }
      }
      if (allBuckets.length > 0) {
        const targetGroups = matchQuotaGroupsForModel(quotaState.groups, modelName);
        const fiveHourPcts = [];
        const weeklyPcts = [];
        const otherPcts = [];
        for (const g of targetGroups) {
          const buckets = Array.isArray(g.buckets) ? g.buckets : [];
          for (const b of buckets) {
            if (typeof b.remainingPercent !== 'number') continue;
            const kind = classifyQuotaWindow(b.window);
            if (kind === '5h') fiveHourPcts.push(b.remainingPercent);
            else if (kind === 'weekly') weeklyPcts.push(b.remainingPercent);
            else otherPcts.push(b.remainingPercent);
          }
        }

        const fiveHourPct = fiveHourPcts.length > 0 ? Math.min(...fiveHourPcts) : null;
        const weeklyPct =
          weeklyPcts.length > 0
            ? Math.min(...weeklyPcts)
            : otherPcts.length > 0
              ? Math.min(...otherPcts)
              : null;
        const staleTag = quotaState.stale ? ` (${tr.stale})` : '';
        const tooltip = allBuckets
          .map((b) => `${b.label}${b.window ? ` (${b.window})` : ''}: ${Math.round(b.pct)}%`)
          .join('\n');

        if (fiveHourPct !== null && weeklyPct !== null) {
          quota5hEl.style.display = '';
          sep3.style.display = '';
          quotaEl.style.display = '';
          setText(quota5hEl, `${tr.quota5h} ${Math.round(fiveHourPct)}%`);
          setText(quotaEl, `${tr.quotaWeekly} ${Math.round(weeklyPct)}%${staleTag}`);
        } else if (fiveHourPct !== null) {
          quota5hEl.style.display = '';
          sep3.style.display = 'none';
          quotaEl.style.display = 'none';
          setText(quota5hEl, `${tr.quota5h} ${Math.round(fiveHourPct)}%${staleTag}`);
        } else if (weeklyPct !== null) {
          quota5hEl.style.display = 'none';
          sep3.style.display = 'none';
          quotaEl.style.display = '';
          setText(quotaEl, `${tr.quotaWeekly} ${Math.round(weeklyPct)}%${staleTag}`);
        }
        quota5hEl.title = tooltip;
        quotaEl.title = tooltip;
        return;
      }
    }
    quota5hEl.style.display = '';
    sep3.style.display = '';
    quotaEl.style.display = '';
    setText(quota5hEl, `${tr.quota5h} --`);
    setText(quotaEl, `${tr.quotaWeekly} --`);
    quota5hEl.title = '';
    quotaEl.title = '';
  }

  function renderAddonButtons({ persistedButtons, runtimeButtons, onPersistedClick, onRuntimeClick }) {
    clearChildren(customBtnsContainer);
    for (const btnDef of persistedButtons) {
      if (btnDef.enabled === false) continue;
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'agy-inline-btn';
      b.textContent = btnDef.label;
      b.title = btnDef.description || btnDef.command;
      b.addEventListener('click', () => onPersistedClick(btnDef, b));
      customBtnsContainer.appendChild(b);
    }
    for (const rtDef of runtimeButtons) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'agy-inline-btn';
      b.textContent = rtDef.label;
      if (rtDef.title || rtDef.description) b.title = rtDef.title || rtDef.description;
      b.addEventListener('click', () => onRuntimeClick(rtDef, b));
      customBtnsContainer.appendChild(b);
    }
  }

  function setNote(text) {
    setText(noteEl, text);
  }

  function setReconnecting() {
    setText(ctxTextEl, i18n.t().reconnecting);
  }

  function setExpandedState({ open, activeTab }) {
    ctxBtn.setAttribute('aria-expanded', String(Boolean(open && activeTab === 'context')));
    settingsBtn.setAttribute('aria-expanded', String(Boolean(open && activeTab === 'settings')));
  }

  return Object.freeze({
    barEl,
    ctxBtn,
    compactBtn,
    settingsBtn,
    renderSnapshot,
    renderQuota,
    renderAddonButtons,
    setNote,
    setReconnecting,
    setExpandedState,
  });
}
