/**
 * Main inline statusbar DOM view (SRP).
 * Zero innerHTML / outerHTML / insertAdjacentHTML — DOM createElement + textContent only.
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

  const quotaEl = doc.createElement('span');
  quotaEl.className = 'agy-inline-metric';
  quotaEl.textContent = `${i18n.t().quota} --`;

  leftEl.appendChild(ctxBtn);
  leftEl.appendChild(softBadgeEl);
  leftEl.appendChild(sep1);
  leftEl.appendChild(cacheEl);
  leftEl.appendChild(sep2);
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

  function renderQuota(quotaState) {
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
        const minPct = Math.min(...allBuckets.map((b) => b.pct));
        const staleTag = quotaState.stale ? ` (${tr.stale})` : '';
        setText(quotaEl, `${tr.quota} ${Math.round(minPct)}%${staleTag}`);
        quotaEl.title = allBuckets
          .map((b) => `${b.label}${b.window ? ` (${b.window})` : ''}: ${Math.round(b.pct)}%`)
          .join('\n');
        return;
      }
    }
    setText(quotaEl, `${tr.quota} --`);
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
