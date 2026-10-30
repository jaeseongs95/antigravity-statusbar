'use strict';

const STYLE_CSS = `
    .agy-ctx-statusbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 10px 2px 10px;
      margin-top: 2px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      line-height: 1.4;
      color: rgba(160, 165, 175, 0.88);
      user-select: none;
      flex-wrap: wrap;
      position: relative;
    }
    .agy-ctx-left, .agy-ctx-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
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
      bottom: 24px;
      left: 50px;
      background: #1e1e24;
      border: 1px solid rgba(128, 128, 128, 0.35);
      border-radius: 6px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65);
      z-index: 10000;
      padding: 6px 0;
      display: flex;
      flex-direction: column;
      min-width: 215px;
    }
    .agy-ctx-menu-hdr {
      padding: 2px 10px 5px 10px;
      font-size: 10px;
      color: #94a3b8;
      border-bottom: 1px solid rgba(128, 128, 128, 0.2);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .agy-ctx-custom-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
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
    .agy-ctx-tbl td.num, .agy-ctx-tbl th.num {
      text-align: right;
    }
    ga-remote-control .iframe-panel {
      min-height: 0 !important;
      flex: 1 1 0% !important;
    }
    .agy-rc-host-view {
      flex-shrink: 0;
      width: 100%;
      background: #18181d;
      border-top: 1px solid rgba(128, 128, 128, 0.25);
      box-sizing: border-box;
      z-index: 1000;
    }
    .agy-rc-host-box .agy-ctx-statusbar {
      margin-top: 0;
      padding: 5px 10px;
    }
    .agy-rc-host-box .agy-ctx-menu {
      left: 10px;
      bottom: 28px;
    }
`;

function buildDynamicCwWarnCss(underDefaultCwSet) {
  const selectors = ['[data-testid="model-selector-trigger"][data-agy-cw-warn="0"] div:has(> .text-warning)'];
  for (const cw of underDefaultCwSet) {
    selectors.push(`[data-testid="model-selector-trigger"][data-context-window="${cw}"] div:has(> .text-warning)`);
  }
  return `\n    ${selectors.join(',\n    ')} {\n      display: none !important;\n    }\n`;
}

function ensureStyleElement(document, underDefaultCwSet) {
  if (!document) return;
  const parent = document.head || document.documentElement;
  if (!parent) return;
  let styleEl = document.getElementById('agy-ctx-statusbar-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'agy-ctx-statusbar-style';
    parent.appendChild(styleEl);
  }
  const fullCss = STYLE_CSS + buildDynamicCwWarnCss(underDefaultCwSet);
  if (styleEl.textContent !== fullCss) {
    styleEl.textContent = fullCss;
  }
}

function createTrustedHtmlSetter(window, document) {
  if (window?.__agyTrustedHtmlPolicy) {
    return (el, html) => { el.innerHTML = window.__agyTrustedHtmlPolicy.createHTML(html); };
  }
  if (window?.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
    const names = [
      'agy-statusbar',
      'angular#unsafe-bypass',
      'angular',
      'default',
      'dompurify',
      'nextjs#bundler',
      'agy-statusbar-' + Date.now(),
    ];
    for (const name of names) {
      try {
        const p = window.trustedTypes.createPolicy(name, { createHTML: (s) => s, createScript: (s) => s });
        try { window.__agyTrustedHtmlPolicy = p; } catch {}
        return (el, html) => { el.innerHTML = p.createHTML(html); };
      } catch {}
    }
  }
  return (el, html) => {
    try {
      el.innerHTML = html;
    } catch {
      if (document && typeof document.createRange === 'function') {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.deleteContents();
        el.appendChild(range.createContextualFragment(html));
      }
    }
  };
}

function fmtK(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US');
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtResetTime(iso) {
  if (!iso) return '';
  try {
    let d;
    if (typeof iso === 'object' && iso.seconds !== undefined) {
      d = new Date(Number(iso.seconds) * 1000);
    } else {
      d = new Date(iso);
    }
    if (isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `→${hh}:${mm}`;
  } catch {
    return '';
  }
}

module.exports = {
  STYLE_CSS,
  buildDynamicCwWarnCss,
  ensureStyleElement,
  createTrustedHtmlSetter,
  fmtK,
  fmtNum,
  escHtml,
  fmtResetTime,
};
