/**
 * Dedicated CSS stylesheet module for the AddonManifest.v1 inline statusbar & 2-tab popover (SRP).
 * Injected exclusively through `addonHost.injectStyle('statusbar-main', cssText)`.
 */

export const STATUSBAR_STYLE_ID = 'statusbar-main';

export const STATUSBAR_STYLES = `
.agy-inline-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  margin-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11px;
  line-height: 1.3;
  color: rgba(255, 255, 255, 0.72);
  user-select: none;
  position: relative;
  flex-wrap: wrap;
}
.agy-inline-statusbar.agy-remote-dock {
  margin-top: 0;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(18, 22, 30, 0.94);
  color: #e6edf3;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.agy-inline-left,
.agy-inline-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.agy-inline-metric {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.agy-inline-quota-refreshable {
  cursor: pointer;
}
.agy-inline-quota-refreshable:hover {
  color: rgba(255, 255, 255, 0.92);
}
.agy-inline-model-pill {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(78, 161, 255, 0.14);
  border: 1px solid rgba(78, 161, 255, 0.28);
  color: #b7d7ff;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}
.agy-inline-metric-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  padding: 1px 4px;
  border-radius: 4px;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.agy-inline-metric-btn:hover,
.agy-inline-metric-btn:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  outline: none;
}
.agy-inline-bar-track {
  display: inline-block;
  width: 48px;
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
  flex-shrink: 0;
}
.agy-inline-bar-fill {
  display: block;
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: #4ea1ff;
  transition: width 160ms ease, background-color 160ms ease;
}
.agy-inline-bar-fill.warn {
  background: #f5b942;
}
.agy-inline-bar-fill.danger {
  background: #f06565;
}
.agy-inline-sep {
  opacity: 0.35;
}
.agy-inline-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(240, 101, 101, 0.2);
  color: #ff9c9c;
  font-weight: 600;
}
.agy-inline-btn {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.88);
  font: inherit;
  font-size: 11px;
  padding: 2px 7px;
  cursor: pointer;
  line-height: 1.3;
}
.agy-inline-btn:hover:not(:disabled),
.agy-inline-btn:focus-visible:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  outline: none;
}
.agy-inline-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.agy-inline-custom-btns {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.agy-inline-pop-subtitle {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  letter-spacing: -0.01em;
}
.agy-inline-pop-hint {
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.56);
  word-break: keep-all;
}
.agy-inline-pop-meta-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 11px;
}
.agy-inline-pop-meta-model {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agy-inline-pop-meta-steps {
  color: rgba(255, 255, 255, 0.6);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.agy-inline-bd-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.agy-inline-bd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
}
.agy-inline-bd-label {
  color: rgba(255, 255, 255, 0.82);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agy-inline-bd-val {
  color: rgba(255, 255, 255, 0.9);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.agy-inline-bd-track {
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.agy-inline-bd-fill {
  height: 100%;
  border-radius: 999px;
  background: #4ea1ff;
}
.agy-inline-pop-grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.agy-inline-pop-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.agy-inline-pop-btn-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 7px;
  padding: 5px 8px;
}
.agy-inline-pop-btn-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.agy-inline-source-pill {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.62);
}
.agy-inline-btn-primary {
  background: #2f7cf6;
  border-color: #3f88ff;
  color: #ffffff;
  font-weight: 500;
}
.agy-inline-btn-primary:hover:not(:disabled),
.agy-inline-btn-primary:focus-visible:not(:disabled) {
  background: #3d87fb;
}
.agy-inline-btn-on {
  background: rgba(78, 161, 255, 0.2);
  border-color: rgba(78, 161, 255, 0.45);
  color: #9dceff;
}
.agy-inline-status-note {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
}
.agy-inline-popover {
  box-sizing: border-box;
  position: absolute;
  bottom: calc(100% + 8px);
  right: 8px;
  width: 352px;
  max-width: calc(100vw - 24px);
  max-height: min(540px, calc(100vh - 110px));
  overflow-y: auto;
  background: #1a1b1f;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 13px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(0, 0, 0, 0.25);
  padding: 12px 14px 13px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  gap: 10px;
  word-break: keep-all;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.agy-inline-popover.hidden {
  display: none;
}
.agy-inline-popover.agy-inline-popover-portal {
  position: static;
  bottom: auto;
  right: auto;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 56px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11px;
  line-height: 1.4;
}
.agy-inline-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  color: #f3f4f6;
}
.agy-inline-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 9px;
}
.agy-inline-tab {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.62);
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  padding: 5px 8px;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.agy-inline-tab:hover {
  color: rgba(255, 255, 255, 0.88);
}
.agy-inline-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(78, 161, 255, 0.4);
}
.agy-inline-tab[aria-selected="true"] {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.08);
  color: #ffffff;
  font-weight: 600;
}
.agy-inline-tabpanel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.agy-inline-tabpanel.hidden {
  display: none;
}
.agy-inline-card {
  background: rgba(255, 255, 255, 0.032);
  border: 1px solid rgba(255, 255, 255, 0.075);
  border-radius: 10px;
  padding: 10px 11px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agy-inline-card.hidden {
  display: none;
}
.agy-inline-switch-wrap {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
.agy-inline-switch-state {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.68);
  min-width: 24px;
  text-align: right;
}
.agy-inline-switch {
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.14);
  padding: 0;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 150ms ease, border-color 150ms ease;
}
.agy-inline-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #e6e7ea;
  transition: transform 150ms ease, background-color 150ms ease;
}
.agy-inline-switch[aria-checked="true"] {
  background: #2f7cf6;
  border-color: #468eff;
}
.agy-inline-switch[aria-checked="true"]::after {
  transform: translateX(14px);
  background: #ffffff;
}
.agy-inline-switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(78, 161, 255, 0.45);
}
.agy-inline-pop-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.07);
  margin: 1px 0;
}
.agy-inline-char-count {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.48);
  font-variant-numeric: tabular-nums;
}
.agy-inline-pop-foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.agy-inline-pop-close {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.65);
  font-size: 15px;
  line-height: 1;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.agy-inline-pop-close:hover,
.agy-inline-pop-close:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
  outline: none;
}
.agy-inline-pop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}
.agy-inline-pop-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
}
.agy-inline-pop-controls {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.agy-inline-pop-select,
.agy-inline-pop-input {
  background: #131417;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  font-size: 11px;
  padding: 5px 8px;
  min-width: 0;
}
.agy-inline-pop-select:focus-visible,
.agy-inline-pop-input:focus-visible {
  border-color: #4ea1ff;
  box-shadow: 0 0 0 2px rgba(78, 161, 255, 0.28);
  outline: none;
}
.agy-inline-pop-input {
  flex: 1;
  font-variant-numeric: tabular-nums;
}
.agy-inline-pop-textarea {
  width: 100%;
  min-height: 54px;
  max-height: 120px;
  resize: vertical;
  box-sizing: border-box;
  background: #121317;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 7px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.45;
  padding: 7px 9px;
}
.agy-inline-pop-textarea:focus,
.agy-inline-pop-textarea:focus-visible {
  border-color: #4ea1ff;
  box-shadow: 0 0 0 2px rgba(78, 161, 255, 0.28);
  outline: none;
}
.agy-inline-pop-actions-end {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.agy-inline-pop-feedback {
  font-size: 11px;
  color: #8cc8ff;
  background: rgba(78, 161, 255, 0.12);
  border: 1px solid rgba(78, 161, 255, 0.25);
  border-radius: 7px;
  padding: 5px 9px;
}
.agy-inline-pop-feedback:empty {
  display: none;
}
.agy-inline-pop-feedback.err {
  color: #ff9c9c;
  background: rgba(240, 101, 101, 0.12);
  border-color: rgba(240, 101, 101, 0.28);
}
.agy-inline-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(2px);
  z-index: 2147483100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
}
.agy-inline-modal-backdrop.hidden {
  display: none;
}
.agy-inline-modal {
  box-sizing: border-box;
  width: 440px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  background: #1a1b1f;
  color: #e6e7ea;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 14px;
  box-shadow: 0 22px 54px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(0, 0, 0, 0.35);
  padding: 14px 16px 15px;
  display: flex;
  flex-direction: column;
  gap: 11px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11px;
  line-height: 1.4;
  word-break: keep-all;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.agy-inline-priority-bar {
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.66);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 6px 9px;
}
.agy-inline-override-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: rgba(245, 185, 66, 0.12);
  border: 1px solid rgba(245, 185, 66, 0.32);
  border-radius: 8px;
  padding: 7px 9px;
  color: #ffd98a;
  font-size: 11px;
}
.agy-inline-override-banner.hidden {
  display: none;
}
.agy-inline-override-text {
  min-width: 0;
  flex: 1;
}
.agy-inline-btn.hidden {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .agy-inline-bar-fill,
  .agy-inline-tab,
  .agy-inline-switch,
  .agy-inline-switch::after {
    transition: none;
  }
}
`;
