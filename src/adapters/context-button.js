'use strict';

const { fmtNum, escHtml } = require('../dom-styles');
const { getChatModelFromMeta, extractStatsFromMetas } = require('../rpc-client');

function createContextButtonAdapter({
  window,
  document,
  fetchFn,
  setHtml,
  cwStore,
  hostBridge,
}) {
  async function openOrToggleDebugModal(view, inputBox) {
    const existingModal = document.getElementById('agy-ctx-debug-modal');
    if (existingModal) {
      existingModal.remove();
      return;
    }

    if (!view) {
      view = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    }
    if (!inputBox && view) {
      inputBox = view.querySelector('[data-testid="agent-input-box"]');
    }
    const cascadeId = view ? view.getAttribute('data-cascade-id') : '';
    const csrf = window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken;
    const currentCw = cwStore.getSavedContextWindow(cascadeId);
    const maxLimit = cwStore.getLimit(currentCw);
    const cc = hostBridge.getCascadeContextForElement(inputBox || view);
    const asp = cc?.state?.agentStateProvider;
    const slice = asp?.getState?.()?.trajectorySlice;
    const totalGenLen = slice?.totalGeneratorMetadataLength ?? 0;
    const totalStepsLen = slice?.totalStepsLength ?? 0;
    const trajectoryId = slice?.trajectoryId || '';

    const backdrop = document.createElement('div');
    backdrop.id = 'agy-ctx-debug-modal';
    backdrop.className = 'agy-ctx-modal-backdrop';
    setHtml(backdrop, `
      <div class="agy-ctx-modal" role="dialog" aria-label="Trajectory & Context Debug View">
        <div class="agy-ctx-modal-hdr">
          <span>Trajectory &amp; Context Debug View <span style="opacity:0.6;font-weight:400;font-size:11px">(${escHtml(cascadeId || 'unknown')})</span></span>
          <div class="agy-ctx-modal-hdr-actions">
            <button type="button" class="agy-ctx-btn" id="agy-ctx-toggle-inline-debug" title="채팅창 상단 내장 Trajectory Stats 표시 토글">[ inline stats ]</button>
            <button type="button" class="agy-ctx-btn" id="agy-ctx-modal-close" title="닫기 (ESC)">[ × ]</button>
          </div>
        </div>
        <div class="agy-ctx-modal-body" id="agy-ctx-modal-body">
          <div style="opacity:0.75">컨텍스트 메타데이터를 불러오는 중…</div>
        </div>
      </div>
    `);

    const closeModal = () => {
      backdrop.remove();
      window.removeEventListener('keydown', onKeyDown);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    backdrop.onclick = (e) => {
      if (e.target === backdrop) closeModal();
    };
    document.body.appendChild(backdrop);

    const closeBtn = backdrop.querySelector('#agy-ctx-modal-close');
    if (closeBtn) closeBtn.onclick = closeModal;

    const inlineBtn = backdrop.querySelector('#agy-ctx-toggle-inline-debug');
    if (inlineBtn) {
      inlineBtn.onclick = () => {
        const curCc = hostBridge.getCascadeContextForElement(inputBox || view);
        if (curCc?.debug && typeof curCc.debug.setDebugMode === 'function') {
          curCc.debug.setDebugMode(!curCc.debug.debugMode);
        }
      };
    }

    const bodyEl = backdrop.querySelector('#agy-ctx-modal-body');
    const remoteSvc = hostBridge.getRemoteRpcServiceForElement ? hostBridge.getRemoteRpcServiceForElement(inputBox || view) : null;
    if (!cascadeId || (!csrf && !remoteSvc)) {
      if (bodyEl) {
        setHtml(bodyEl, `<div class="agy-ctx-crit">세션 정보(cascadeId 또는 RPC 연결)를 찾을 수 없습니다.</div>`);
      }
      return;
    }

    try {
      const fetchOffset = Math.max(0, totalGenLen > 20 ? totalGenLen - 20 : 0);
      let metas = [];
      if (csrf && typeof fetchFn === 'function') {
        try {
          const r = await fetchFn('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
            body: JSON.stringify({ cascadeId, generatorMetadataOffset: fetchOffset }),
          });
          if (r && r.ok !== false) {
            const j = await r.json();
            metas = j.generatorMetadata || [];
          }
        } catch {}
      }
      if (!metas.length && remoteSvc && typeof remoteSvc.getCascadeTrajectoryGeneratorMetadata === 'function') {
        const j = await remoteSvc.getCascadeTrajectoryGeneratorMetadata({ cascadeId, generatorMetadataOffset: fetchOffset });
        const allMetas = j?.generatorMetadata || [];
        metas = allMetas.length > 20 ? allMetas.slice(-20) : allMetas;
      }
      if (!metas.length && remoteSvc && typeof remoteSvc.getCascadeTrajectory === 'function') {
        const t = await remoteSvc.getCascadeTrajectory({ cascadeId });
        const allMetas = t?.trajectory?.generatorMetadata || [];
        metas = allMetas.length > 20 ? allMetas.slice(-20) : allMetas;
      }
      const parsed = extractStatsFromMetas(metas);

      let latestCwm = null;
      let latestSections = [];
      let latestModel = '';
      for (let i = metas.length - 1; i >= 0; i--) {
        const cm = getChatModelFromMeta(metas[i]);
        if (!cm) continue;
        if (!latestModel && (cm.modelDisplayName || cm.responseModel || cm.model)) {
          latestModel = cm.modelDisplayName || cm.responseModel || cm.model;
        }
        if (!latestCwm && cm.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed) {
          latestCwm = cm.chatStartMetadata.contextWindowMetadata;
        }
        if (!latestSections.length && Array.isArray(cm.promptSections) && cm.promptSections.length > 0) {
          latestSections = cm.promptSections;
        }
      }

      const used = parsed.used || 0;
      const pct = maxLimit > 0 ? Math.min(100, Math.round((used / maxLimit) * 100)) : 0;
      const barColor = pct >= 85 ? '#ec7063' : pct >= 65 ? '#f5b041' : '#58d68d';

      const groups = latestCwm?.tokenBreakdown?.groups || [];
      let breakdownHtml = '';
      if (groups.length > 0) {
        const rows = groups.map((g) => {
          const gTok = Number(g.numTokens || 0);
          const gPct = used > 0 ? ((gTok / used) * 100).toFixed(1) : '0.0';
          return `<tr>
            <td>${escHtml(g.name || g.type || g.source || 'Section')}</td>
            <td class="num">${fmtNum(gTok)}</td>
            <td class="num">${gPct}%</td>
          </tr>`;
        }).join('');
        breakdownHtml = `
          <div>
            <div class="agy-ctx-sec-title"><span>Context Window Token Breakdown</span><span>Total: ${fmtNum(latestCwm?.tokenBreakdown?.totalTokens || used)}</span></div>
            <table class="agy-ctx-tbl">
              <thead><tr><th>Group / Source</th><th class="num">Tokens</th><th class="num">Share</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      } else if (latestSections.length > 0) {
        const rows = latestSections.map((s, idx) => {
          const textLen = (s.content || s.templatedContent || '').length;
          return `<tr>
            <td>#${idx + 1} ${escHtml(s.title || s.tokenType || 'PromptSection')}</td>
            <td>${escHtml(s.tokenSource || s.metadata?.sourceType || '-')}</td>
            <td class="num">${fmtNum(textLen)} chars</td>
          </tr>`;
        }).join('');
        breakdownHtml = `
          <div>
            <div class="agy-ctx-sec-title"><span>Prompt Sections (${latestSections.length})</span></div>
            <table class="agy-ctx-tbl">
              <thead><tr><th>Section Title</th><th>Source</th><th class="num">Size</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }

      const recentTurns = [];
      for (let i = metas.length - 1; i >= 0 && recentTurns.length < 12; i--) {
        const m = metas[i];
        const cm = getChatModelFromMeta(m);
        if (!cm) continue;
        const u = cm.usage || {};
        const cwm = cm.chatStartMetadata?.contextWindowMetadata;
        const stepIdx = cm.chatStartMetadata?.startStepIndex ?? m.stepIndices?.[0] ?? (fetchOffset + i);
        const inTok = Number(u.inputTokens || 0);
        const crTok = Number(u.cacheReadTokens || 0);
        const outTok = Number(u.outputTokens || u.responseOutputTokens || 0);
        const thkTok = Number(u.thinkingOutputTokens || 0);
        const totP = inTok + crTok;
        const cPct = totP > 0 ? Math.round((crTok / totP) * 100) + '%' : '-';
        recentTurns.push(`
          <tr>
            <td>#${escHtml(stepIdx)}</td>
            <td>${escHtml(cm.modelDisplayName || cm.responseModel || cm.model || '-')}</td>
            <td class="num">${cwm?.estimatedTokensUsed ? fmtNum(cwm.estimatedTokensUsed) : '-'}</td>
            <td class="num">${fmtNum(crTok)} (${cPct})</td>
            <td class="num">${fmtNum(inTok)}</td>
            <td class="num">${fmtNum(outTok)}${thkTok ? ` <span style="opacity:0.65">(+${fmtNum(thkTok)} thk)</span>` : ''}</td>
          </tr>
        `);
      }

      const info = hostBridge.getModelSelectorContextForView(view);
      const reduxSessionCw = info?.reduxStore?.getState?.()?.modelSelection?.byConversation?.[cascadeId]?.contextWindow || currentCw;

      if (bodyEl) {
        setHtml(bodyEl, `
          <div class="agy-ctx-card-grid">
            <div class="agy-ctx-card">
              <div class="agy-ctx-card-lbl">Context Used / Session Limit (${escHtml(reduxSessionCw)})</div>
              <div class="agy-ctx-card-val" style="color:${barColor}">${pct}% (${fmtNum(used)} / ${fmtNum(maxLimit)})</div>
              <div style="margin-top:5px;height:5px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden">
                <div style="width:${pct}%;height:100%;background:${barColor}"></div>
              </div>
            </div>
            <div class="agy-ctx-card">
              <div class="agy-ctx-card-lbl">Prompt Cache Hit Rate</div>
              <div class="agy-ctx-card-val agy-ctx-cache">${parsed.cachePct}%</div>
              <div style="font-size:10px;color:#94a3b8;margin-top:2px">Cache: ${fmtNum(parsed.cacheRead)} · Fresh Input: ${fmtNum(parsed.inputTok)}</div>
            </div>
            <div class="agy-ctx-card">
              <div class="agy-ctx-card-lbl">Trajectory Metadata</div>
              <div class="agy-ctx-card-val">${fmtNum(totalStepsLen)} steps · ${fmtNum(totalGenLen)} turns</div>
              <div style="font-size:10px;color:#94a3b8;margin-top:2px">Last Turn Max: ${fmtNum(parsed.trajectoryMax)} · Model: ${escHtml(latestModel || '-')}</div>
            </div>
          </div>
          ${breakdownHtml}
          <div>
            <div class="agy-ctx-sec-title">
              <span>Recent Generator Turns (Latest ${recentTurns.length} of ${totalGenLen || metas.length})</span>
              <span style="font-weight:400;opacity:0.7">Trajectory ID: ${escHtml(trajectoryId || cascadeId)}</span>
            </div>
            <table class="agy-ctx-tbl">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Model</th>
                  <th class="num">Est. Ctx</th>
                  <th class="num">Cache Read</th>
                  <th class="num">Fresh Input</th>
                  <th class="num">Output (+Think)</th>
                </tr>
              </thead>
              <tbody>
                ${recentTurns.length ? recentTurns.join('') : '<tr><td colspan="6" style="opacity:0.6">생성된 턴 메타데이터가 아직 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>
        `);
      }
    } catch (err) {
      if (bodyEl) {
        setHtml(bodyEl, `<div class="agy-ctx-crit">메타데이터 조회 실패: ${escHtml(err?.message || err)}</div>`);
      }
    }
  }

  return {
    id: 'context',
    slot: 'right',
    order: 20,
    builtin: true,
    className: 'agy-ctx-btn agy-ctx-btn-context',
    label: '[ context ]',
    title: '상세 컨텍스트 디버그 창 열기/닫기',
    onClick({ view, inputBox }) {
      openOrToggleDebugModal(view, inputBox);
    },
    openOrToggleDebugModal,
  };
}

module.exports = {
  createContextButtonAdapter,
};
