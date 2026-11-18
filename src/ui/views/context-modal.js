'use strict';

/**
 * Context & Trajectory Debug Modal View (`context` builtin adapter).
 * Pure DOM composition via `dom-builder` (zero HTML strings) + `WeakMap` cleanup + `i18n` translator.
 */

const { fmtNum, getChatModelFromMeta } = require('../../domain/metrics-calculator');
const { DEFAULT_LOCALE, createTranslator } = require('../../domain/i18n');
const { h, clearChildren } = require('../dom-builder');
const { registerNodeCleanup, runNodeCleanup } = require('../adapter-registry');

function createContextModalAdapter({ document, documentHost, window, translator, loadDebugTelemetry, toggleInlineStats }) {
  const tr = translator || createTranslator(DEFAULT_LOCALE);

  function closeExistingModal() {
    const existing = document?.getElementById?.('agy-ctx-debug-modal');
    if (!existing) return false;
    runNodeCleanup(existing);
    try {
      existing.remove();
    } catch {}
    return true;
  }

  function renderTelemetryBody(bodyEl, payload) {
    const {
      currentCw,
      maxLimit,
      parsed,
      metas,
      totalGenLen,
      totalStepsLen,
      trajectoryId,
      cascadeId,
      latestCwm,
      latestSections,
      latestModel,
    } = payload;

    const used = parsed.used || 0;
    const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
    const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';

    const cardGrid = h(
      document,
      'div',
      { className: 'agy-ctx-card-grid' },
      h(
        document,
        'div',
        { className: 'agy-ctx-card' },
        h(document, 'div', { className: 'agy-ctx-card-lbl' }, tr.t('modal.cardCtx', { cw: currentCw })),
        h(
          document,
          'div',
          { className: 'agy-ctx-card-val', style: { color: barColor } },
          `${pct}% (${fmtNum(used)} / ${fmtNum(maxLimit)})`
        ),
        h(
          document,
          'div',
          {
            style: {
              marginTop: '5px',
              height: '5px',
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '3px',
              overflow: 'hidden',
            },
          },
          h(document, 'div', { style: { width: `${pct}%`, height: '100%', background: barColor } })
        )
      ),
      h(
        document,
        'div',
        { className: 'agy-ctx-card' },
        h(document, 'div', { className: 'agy-ctx-card-lbl' }, tr.t('modal.cardCache')),
        h(document, 'div', { className: 'agy-ctx-card-val agy-ctx-cache' }, `${parsed.cachePct}%`),
        h(
          document,
          'div',
          { style: { fontSize: '10px', color: '#94a3b8', marginTop: '2px' } },
          tr.t('modal.cardCacheSub', { cache: fmtNum(parsed.cacheRead), input: fmtNum(parsed.inputTok) })
        )
      ),
      h(
        document,
        'div',
        { className: 'agy-ctx-card' },
        h(document, 'div', { className: 'agy-ctx-card-lbl' }, tr.t('modal.cardTraj')),
        h(
          document,
          'div',
          { className: 'agy-ctx-card-val' },
          tr.t('modal.cardTrajVal', { steps: fmtNum(totalStepsLen), turns: fmtNum(totalGenLen) })
        ),
        h(
          document,
          'div',
          { style: { fontSize: '10px', color: '#94a3b8', marginTop: '2px' } },
          tr.t('modal.cardTrajSub', { max: fmtNum(parsed.trajectoryMax), model: latestModel || '-' })
        )
      )
    );

    const groups = latestCwm?.tokenBreakdown?.groups || [];
    let breakdownBlock = null;
    if (groups.length > 0) {
      const groupRows = groups.map((g) => {
        const gTok = Number(g.numTokens || 0);
        const gPct = used > 0 ? ((gTok / used) * 100).toFixed(1) : '0.0';
        return h(
          document,
          'tr',
          null,
          h(document, 'td', null, String(g.name || g.type || g.source || 'Section')),
          h(document, 'td', { className: 'num' }, fmtNum(gTok)),
          h(document, 'td', { className: 'num' }, `${gPct}%`)
        );
      });
      breakdownBlock = h(
        document,
        'div',
        null,
        h(
          document,
          'div',
          { className: 'agy-ctx-sec-title' },
          h(document, 'span', null, tr.t('modal.breakdownTitle')),
          h(
            document,
            'span',
            null,
            tr.t('modal.breakdownTotal', { total: fmtNum(latestCwm?.tokenBreakdown?.totalTokens || used) })
          )
        ),
        h(
          document,
          'table',
          { className: 'agy-ctx-tbl' },
          h(
            document,
            'thead',
            null,
            h(
              document,
              'tr',
              null,
              h(document, 'th', null, tr.t('modal.colGroupSource')),
              h(document, 'th', { className: 'num' }, tr.t('modal.colTokens')),
              h(document, 'th', { className: 'num' }, tr.t('modal.colShare'))
            )
          ),
          h(document, 'tbody', null, ...groupRows)
        )
      );
    } else if (latestSections.length > 0) {
      const sectionRows = latestSections.map((s, idx) => {
        const textLen = (s.content || s.templatedContent || '').length;
        return h(
          document,
          'tr',
          null,
          h(document, 'td', null, `#${idx + 1} ${String(s.title || s.tokenType || 'PromptSection')}`),
          h(document, 'td', null, String(s.tokenSource || s.metadata?.sourceType || '-')),
          h(document, 'td', { className: 'num' }, tr.t('modal.charsUnit', { count: fmtNum(textLen) }))
        );
      });
      breakdownBlock = h(
        document,
        'div',
        null,
        h(
          document,
          'div',
          { className: 'agy-ctx-sec-title' },
          h(document, 'span', null, tr.t('modal.sectionsTitle', { count: latestSections.length }))
        ),
        h(
          document,
          'table',
          { className: 'agy-ctx-tbl' },
          h(
            document,
            'thead',
            null,
            h(
              document,
              'tr',
              null,
              h(document, 'th', null, tr.t('modal.colSectionTitle')),
              h(document, 'th', null, tr.t('modal.colSource')),
              h(document, 'th', { className: 'num' }, tr.t('modal.colSize'))
            )
          ),
          h(document, 'tbody', null, ...sectionRows)
        )
      );
    }

    const turnRows = [];
    const fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
    for (let i = metas.length - 1; i >= 0 && turnRows.length < 12; i--) {
      const m = metas[i];
      const cm = getChatModelFromMeta(m);
      if (!cm) continue;
      const u = cm.usage || {};
      const cwm = cm.chatStartMetadata?.contextWindowMetadata;
      const stepIdx = cm.chatStartMetadata?.startStepIndex ?? m.stepIndices?.[0] ?? fetchOffset + i;
      const inTok = Number(u.inputTokens || 0);
      const crTok = Number(u.cacheReadTokens || 0);
      const outTok = Number(u.outputTokens || u.responseOutputTokens || 0);
      const thkTok = Number(u.thinkingOutputTokens || 0);
      const totP = inTok + crTok;
      const cPct = totP > 0 ? `${Math.round((crTok / totP) * 100)}%` : '-';

      turnRows.push(
        h(
          document,
          'tr',
          null,
          h(document, 'td', null, `#${String(stepIdx)}`),
          h(document, 'td', null, String(cm.modelDisplayName || cm.responseModel || cm.model || '-')),
          h(document, 'td', { className: 'num' }, cwm?.estimatedTokensUsed ? fmtNum(cwm.estimatedTokensUsed) : '-'),
          h(document, 'td', { className: 'num' }, `${fmtNum(crTok)} (${cPct})`),
          h(document, 'td', { className: 'num' }, fmtNum(inTok)),
          h(
            document,
            'td',
            { className: 'num' },
            fmtNum(outTok),
            thkTok ? h(document, 'span', { style: { opacity: '0.65' } }, ` ${tr.t('modal.thkSuffix', { count: fmtNum(thkTok) })}`) : null
          )
        )
      );
    }

    const turnsBlock = h(
      document,
      'div',
      null,
      h(
        document,
        'div',
        { className: 'agy-ctx-sec-title' },
        h(document, 'span', null, tr.t('modal.turnsTitle', { shown: turnRows.length, total: totalGenLen || metas.length })),
        h(
          document,
          'span',
          { style: { fontWeight: '400', opacity: '0.7' } },
          tr.t('modal.trajectoryId', { id: trajectoryId || cascadeId || 'unknown' })
        )
      ),
      h(
        document,
        'table',
        { className: 'agy-ctx-tbl' },
        h(
          document,
          'thead',
          null,
          h(
            document,
            'tr',
            null,
            h(document, 'th', null, tr.t('modal.colStep')),
            h(document, 'th', null, tr.t('modal.colModel')),
            h(document, 'th', { className: 'num' }, tr.t('modal.colEstCtx')),
            h(document, 'th', { className: 'num' }, tr.t('modal.colCacheRead')),
            h(document, 'th', { className: 'num' }, tr.t('modal.colFreshInput')),
            h(document, 'th', { className: 'num' }, tr.t('modal.colOutputThink'))
          )
        ),
        h(
          document,
          'tbody',
          null,
          ...(turnRows.length
            ? turnRows
            : [
                h(
                  document,
                  'tr',
                  null,
                  h(document, 'td', { colspan: '6', style: { opacity: '0.6' } }, tr.t('modal.noTurns'))
                ),
              ])
        )
      )
    );

    clearChildren(bodyEl);
    bodyEl.appendChild(cardGrid);
    if (breakdownBlock) bodyEl.appendChild(breakdownBlock);
    bodyEl.appendChild(turnsBlock);
  }

  async function openOrToggleDebugModal(view, inputBox) {
    if (closeExistingModal()) {
      return;
    }

    if ((!view || !inputBox) && documentHost && typeof documentHost.findFallbackSessionTarget === 'function') {
      const fb = documentHost.findFallbackSessionTarget();
      if (!view) view = fb?.view || null;
      if (!inputBox) inputBox = fb?.inputBox || null;
    }
    const rawCid = view?.getAttribute?.('data-cascade-id') || '';

    const bodyEl = h(
      document,
      'div',
      { id: 'agy-ctx-modal-body', className: 'agy-ctx-modal-body' },
      h(document, 'div', { style: { opacity: '0.75' } }, tr.t('modal.loading'))
    );

    let backdrop = null;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    const closeModal = () => {
      try {
        backdrop?.remove?.();
      } catch {}
      try {
        window?.removeEventListener?.('keydown', onKeyDown);
      } catch {}
    };

    const inlineBtn = h(
      document,
      'button',
      {
        type: 'button',
        id: 'agy-ctx-toggle-inline-debug',
        className: 'agy-ctx-btn',
        title: tr.t('modal.inlineStatsTitle'),
        onclick() {
          if (typeof toggleInlineStats === 'function') {
            toggleInlineStats(view, inputBox);
          }
        },
      },
      tr.t('modal.inlineStats')
    );

    const closeBtn = h(
      document,
      'button',
      {
        type: 'button',
        id: 'agy-ctx-modal-close',
        className: 'agy-ctx-btn',
        title: tr.t('modal.closeTitle'),
        onclick: closeModal,
      },
      tr.t('modal.close')
    );

    const titleCid = rawCid || 'unknown';
    const modalEl = h(
      document,
      'div',
      {
        className: 'agy-ctx-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': tr.t('modal.title'),
      },
      h(
        document,
        'div',
        { className: 'agy-ctx-modal-hdr' },
        h(
          document,
          'span',
          null,
          `${tr.t('modal.title')} `,
          h(document, 'span', { style: { opacity: '0.6', fontWeight: '400', fontSize: '11px' } }, `(${titleCid})`)
        ),
        h(document, 'div', { className: 'agy-ctx-modal-hdr-actions' }, inlineBtn, closeBtn)
      ),
      bodyEl
    );

    backdrop = h(
      document,
      'div',
      {
        id: 'agy-ctx-debug-modal',
        className: 'agy-ctx-modal-backdrop',
        'data-agy-no-translate': 'true',
        translate: 'no',
        onclick(e) {
          if (e.target === backdrop) closeModal();
        },
      },
      modalEl
    );

    registerNodeCleanup(backdrop, closeModal);
    window?.addEventListener?.('keydown', onKeyDown);
    document.body?.appendChild?.(backdrop);

    try {
      const payload = await loadDebugTelemetry(view, inputBox, rawCid);
      if (!backdrop.isConnected && document.getElementById?.('agy-ctx-debug-modal') !== backdrop) {
        return;
      }
      if (!payload || payload.unavailable) {
        clearChildren(bodyEl);
        bodyEl.appendChild(h(document, 'div', { className: 'agy-ctx-crit' }, tr.t('modal.noSession')));
        return;
      }
      renderTelemetryBody(bodyEl, payload);
    } catch (err) {
      clearChildren(bodyEl);
      bodyEl.appendChild(
        h(document, 'div', { className: 'agy-ctx-crit' }, tr.t('modal.fetchFailed', { error: err?.message || String(err) }))
      );
    }
  }

  return {
    id: 'context',
    slot: 'right',
    order: 20,
    builtin: true,
    className: 'agy-ctx-btn agy-ctx-btn-context',
    label: () => tr.t('context.label'),
    title: () => tr.t('context.title'),
    onClick({ view, inputBox }) {
      openOrToggleDebugModal(view, inputBox);
    },
    openOrToggleDebugModal,
    closeExistingModal,
  };
}

module.exports = {
  createContextModalAdapter,
};
