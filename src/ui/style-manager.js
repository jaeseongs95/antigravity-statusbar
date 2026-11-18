'use strict';

/**
 * Pure CSP Nonce-Aware Style Sheet Injector & Scoped Cleanup.
 * Zero sibling dependencies, zero hardcoded host DOM selectors.
 */

const STYLE_CSS = `
    .agy-ctx-statusbar {
      display: flex;
      align-items: center;
      justify-content: center;
      row-gap: 4px;
      column-gap: 10px;
      min-height: 22px;
      padding: 4px 10px 2px 10px;
      margin-top: 2px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      line-height: 1.4;
      color: rgba(160, 165, 175, 0.88);
      user-select: none;
      flex-wrap: wrap;
      position: relative;
      text-align: center;
      contain: layout style;
    }
    .agy-ctx-left, .agy-ctx-core {
      display: contents;
    }
    .agy-ctx-group {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      white-space: nowrap;
    }
    .agy-ctx-right {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }
    .agy-ctx-sep {
      color: rgba(160, 165, 175, 0.35);
    }
    .agy-ctx-bar-wrap {
      display: inline-flex;
      align-items: center;
      width: 44px;
      height: 5px;
      background: rgba(128, 128, 128, 0.22);
      border-radius: 3px;
      overflow: hidden;
      vertical-align: middle;
    }
    .agy-ctx-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.2s ease;
    }
    [data-agy-session-switching="1"] .agy-ctx-bar-fill {
      transition: none !important;
    }
    .agy-ctx-ok { color: #58d68d; }
    .agy-ctx-warn { color: #f5b041; }
    .agy-ctx-crit { color: #ec7063; }
    .agy-ctx-cache { color: #5dade2; }
    .agy-ctx-quota { color: #bb8fce; }
    .agy-ctx-btn {
      cursor: pointer;
      padding: 0px 5px;
      border-radius: 3px;
      color: rgba(160, 165, 175, 0.85);
      background: rgba(128, 128, 128, 0.12);
      border: 1px solid rgba(128, 128, 128, 0.2);
      font-family: inherit;
      font-size: 10.5px;
      line-height: 1.3;
      transition: all 0.15s ease;
    }
    .agy-ctx-btn:hover {
      color: #fff;
      background: rgba(128, 128, 128, 0.28);
    }
    .agy-ctx-btn-compact:hover {
      color: #5dade2;
      border-color: rgba(93, 173, 226, 0.45);
      background: rgba(93, 173, 226, 0.14);
    }
    .agy-ctx-btn-limit {
      font-weight: 600;
      color: #5dade2;
      background: rgba(93, 173, 226, 0.1);
      border-color: rgba(93, 173, 226, 0.35);
      padding: 0px 4px;
      margin: 0 1px;
    }
    .agy-ctx-btn-limit:hover {
      color: #ffffff;
      background: rgba(93, 173, 226, 0.25);
      border-color: rgba(93, 173, 226, 0.6);
    }
    .agy-ctx-btn-limit-512 {
      color: #a569bd;
      background: rgba(165, 105, 189, 0.12);
      border-color: rgba(165, 105, 189, 0.4);
    }
    .agy-ctx-btn-limit-512:hover {
      color: #ffffff;
      background: rgba(165, 105, 189, 0.28);
      border-color: rgba(165, 105, 189, 0.7);
    }
    .agy-ctx-btn-limit-900 {
      color: #f39c12;
      background: rgba(243, 156, 18, 0.14);
      border-color: rgba(243, 156, 18, 0.45);
    }
    .agy-ctx-btn-limit-900:hover {
      color: #ffffff;
      background: rgba(243, 156, 18, 0.3);
      border-color: rgba(243, 156, 18, 0.75);
    }
    .agy-ctx-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 50%;
      transform: translateX(-50%);
      background: #1e1e24;
      border: 1px solid rgba(128, 128, 128, 0.35);
      border-radius: 6px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65);
      z-index: 10000;
      padding: 6px 0;
      display: flex;
      flex-direction: column;
      min-width: 225px;
      text-align: left;
    }
    .agy-ctx-menu-hdr {
      padding: 2px 10px 5px 10px;
      font-size: 10px;
      color: #94a3b8;
      border-bottom: 1px solid rgba(128, 128, 128, 0.2);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .agy-ctx-custom-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px 3px 10px;
      background: rgba(255, 255, 255, 0.02);
    }
    .agy-ctx-custom-hint {
      padding: 0 10px 6px 10px;
      font-size: 9.5px;
      color: rgba(148, 163, 184, 0.78);
      border-bottom: 1px solid rgba(128, 128, 128, 0.2);
      background: rgba(255, 255, 255, 0.02);
    }
    .agy-ctx-custom-input {
      flex: 1;
      min-width: 0;
      width: 90px;
      background: #121216;
      border: 1px solid rgba(93, 173, 226, 0.45);
      border-radius: 3px;
      color: #f8fafc;
      font-family: inherit;
      font-size: 11px;
      padding: 3px 6px;
      outline: none;
      user-select: text;
    }
    .agy-ctx-custom-input:focus {
      border-color: #5dade2;
      box-shadow: 0 0 0 1px rgba(93, 173, 226, 0.35);
    }
    .agy-ctx-custom-unit {
      font-size: 10.5px;
      color: #94a3b8;
      font-weight: 600;
    }
    .agy-ctx-custom-apply {
      padding: 3px 7px;
      font-size: 10.5px;
      font-weight: 600;
      color: #fff;
      background: rgba(93, 173, 226, 0.28);
      border: 1px solid rgba(93, 173, 226, 0.55);
      border-radius: 3px;
      cursor: pointer;
    }
    .agy-ctx-custom-apply:hover {
      background: rgba(93, 173, 226, 0.48);
    }
    .agy-ctx-menu-item {
      padding: 5px 10px;
      font-size: 11px;
      color: #cbd5e1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .agy-ctx-menu-item:hover {
      background: rgba(93, 173, 226, 0.2);
      color: #ffffff;
    }
    .agy-ctx-menu-item.active {
      font-weight: bold;
      color: #5dade2;
    }
    .agy-ctx-menu-default {
      margin-top: 2px;
      border-top: 1px solid rgba(128, 128, 128, 0.2);
      font-size: 10px;
      color: #93c5fd;
    }
    .agy-ctx-menu-hint {
      font-size: 9.5px;
      color: rgba(160, 165, 175, 0.7);
    }
    .agy-ctx-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.62);
      backdrop-filter: blur(2px);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #e2e8f0;
    }
    .agy-ctx-modal {
      background: #18181d;
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 8px;
      width: 100%;
      max-width: 820px;
      max-height: 84vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 45px rgba(0, 0, 0, 0.7);
      overflow: hidden;
    }
    .agy-ctx-modal-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: #202027;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      font-size: 12.5px;
      font-weight: 600;
    }
    .agy-ctx-modal-hdr-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .agy-ctx-modal-body {
      padding: 14px;
      overflow-y: auto;
      font-size: 11.5px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .agy-ctx-card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
      gap: 8px;
    }
    .agy-ctx-card {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 6px;
      padding: 8px 10px;
    }
    .agy-ctx-card-lbl {
      font-size: 10px;
      color: #94a3b8;
      margin-bottom: 2px;
    }
    .agy-ctx-card-val {
      font-size: 13.5px;
      font-weight: 700;
    }
    .agy-ctx-sec-title {
      font-size: 11.5px;
      font-weight: 600;
      color: #cbd5e1;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .agy-ctx-tbl {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    .agy-ctx-tbl th, .agy-ctx-tbl td {
      padding: 4px 8px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      text-align: left;
    }
    .agy-ctx-tbl th {
      color: #94a3b8;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.02);
    }
    .agy-tbl td.num, .agy-ctx-tbl td.num, .agy-ctx-tbl th.num {
      text-align: right;
    }
    .agy-rc-host-view {
      flex-shrink: 0;
      width: 100%;
      background: #18181d;
      border-top: 1px solid rgba(128, 128, 128, 0.25);
      box-sizing: border-box;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      z-index: 1000;
    }
    .agy-rc-host-box .agy-ctx-statusbar {
      margin-top: 0;
      min-height: 24px;
      padding: 5px 10px;
      justify-content: center;
      row-gap: 4px;
      column-gap: 12px;
    }
    .agy-rc-host-box .agy-ctx-menu {
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(100% + 4px);
    }
    @media (max-width: 640px) {
      .agy-ctx-statusbar,
      .agy-rc-host-box .agy-ctx-statusbar {
        min-height: 40px;
        padding: 4px 8px;
        row-gap: 3px;
        column-gap: 8px;
        font-size: 10.5px;
      }
      .agy-ctx-bar-wrap {
        width: 34px;
      }
      .agy-ctx-sep-pipe,
      .agy-ctx-quota-left {
        display: none;
      }
      .agy-ctx-group-ctx {
        flex-basis: 100%;
      }
      .agy-ctx-menu,
      .agy-rc-host-box .agy-ctx-menu {
        min-width: min(250px, calc(100vw - 24px));
        max-width: calc(100vw - 16px);
      }
      .agy-ctx-menu-item {
        padding: 7px 12px;
        font-size: 12px;
      }
      .agy-ctx-custom-input {
        font-size: 16px;
        padding: 4px 8px;
      }
      .agy-ctx-custom-apply {
        padding: 5px 10px;
        font-size: 11.5px;
      }
      .agy-ctx-modal-backdrop {
        padding: 8px;
      }
      .agy-ctx-modal {
        max-height: 90vh;
        max-height: 90dvh;
      }
      .agy-ctx-modal-hdr {
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 10px;
        font-size: 11.5px;
      }
      .agy-ctx-modal-body {
        padding: 10px;
        gap: 10px;
      }
      .agy-ctx-card-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
      }
      .agy-ctx-tbl {
        display: block;
        overflow-x: auto;
      }
    }
`.replace(/\s+/g, ' ').trim();

function buildDynamicCwWarnCss(underDefaultCwSet, documentHost) {
  if (documentHost && typeof documentHost.buildWarningSuppressionCss === 'function') {
    return documentHost.buildWarningSuppressionCss(underDefaultCwSet);
  }
  return '';
}

function getCspNonce(doc) {
  if (!doc) return '';
  try {
    const curNonce = doc.currentScript && (doc.currentScript.nonce || doc.currentScript.getAttribute?.('nonce'));
    if (curNonce) return String(curNonce);
  } catch {}

  const selectors = ['style[nonce]', 'script[nonce]', 'link[nonce]'];
  for (const sel of selectors) {
    try {
      const node = doc.querySelector?.(sel);
      const val = node && (node.nonce || node.getAttribute?.('nonce'));
      if (val) return String(val);
    } catch {}
  }

  try {
    const nodes = doc.querySelectorAll?.('style, script, link') || [];
    for (const node of nodes) {
      const val = node && (node.nonce || node.getAttribute?.('nonce'));
      if (val) return String(val);
    }
  } catch {}

  return '';
}

function resolveDocs(rootDoc, documentHost) {
  if (documentHost && typeof documentHost.getAccessibleDocs === 'function') {
    const list = documentHost.getAccessibleDocs(rootDoc);
    if (Array.isArray(list) && list.length > 0) return list;
  }
  return rootDoc ? [rootDoc] : [];
}

function ensureStyleElement(document, underDefaultCwSet, documentHost) {
  if (!document) return;
  const fullCss = STYLE_CSS + buildDynamicCwWarnCss(underDefaultCwSet, documentHost);
  const docs = resolveDocs(document, documentHost);
  const fallbackNonce = getCspNonce(document);

  for (const d of docs) {
    const parent = d.head || d.documentElement;
    if (!parent) continue;
    let docNonce = getCspNonce(d);
    if (!docNonce) {
      try {
        const pw = d.defaultView && d.defaultView.parent;
        if (pw && pw !== d.defaultView && pw.document) {
          docNonce = getCspNonce(pw.document);
        }
      } catch {}
    }
    const styleNonce = docNonce || fallbackNonce;
    let styleEl = d.getElementById('agy-ctx-statusbar-style');
    if (!styleEl) {
      styleEl = d.createElement('style');
      styleEl.id = 'agy-ctx-statusbar-style';
      if (styleNonce) {
        styleEl.nonce = styleNonce;
        styleEl.setAttribute?.('nonce', styleNonce);
      }
      parent.appendChild(styleEl);
    } else if (styleNonce && !styleEl.nonce && !styleEl.getAttribute?.('nonce')) {
      styleEl.nonce = styleNonce;
      styleEl.setAttribute?.('nonce', styleNonce);
    }
    if (styleEl.textContent !== fullCss) {
      styleEl.textContent = fullCss;
    }
  }
}

function removeStyleElements(document, documentHost) {
  for (const d of resolveDocs(document, documentHost)) {
    try {
      const styleEl = d.getElementById?.('agy-ctx-statusbar-style');
      styleEl?.remove?.();
    } catch {}
  }
}

module.exports = {
  STYLE_CSS,
  buildDynamicCwWarnCss,
  getCspNonce,
  ensureStyleElement,
  removeStyleElements,
};
