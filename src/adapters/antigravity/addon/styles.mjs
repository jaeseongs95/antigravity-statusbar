/**
 * Dedicated CSS stylesheet module for the AddonManifest.v3 Tier-3 inline statusbar canvas (SRP).
 *
 * All popover, modal, settings-page, and toast styling is now 100% owned by the host Tier 1/2
 * declarative UI renderer (`ui-schema-renderer.js`). This stylesheet covers ONLY the compact
 * inline statusbar strip mounted in `antigravity-statusbar.root` and adapts to Dark/Light
 * themes via `--ag-*` semantic host CSS tokens.
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
  border-top: 1px solid var(--ag-border, rgba(255, 255, 255, 0.08));
  font-family: var(--ag-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  font-size: 11px;
  line-height: 1.3;
  color: var(--ag-text-muted, rgba(255, 255, 255, 0.72));
  user-select: none;
  position: relative;
  flex-wrap: wrap;
}
.agy-inline-statusbar.agy-remote-dock {
  margin-top: 0;
  padding: 6px 12px;
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.14));
  border-radius: var(--ag-radius, 10px);
  background: var(--ag-surface, rgba(18, 22, 30, 0.94));
  color: var(--ag-text, #e6edf3);
  box-shadow: var(--ag-shadow, 0 8px 24px rgba(0, 0, 0, 0.45));
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
  color: var(--ag-text, rgba(255, 255, 255, 0.92));
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
  color: var(--ag-accent, #b7d7ff);
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
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.08));
  outline: none;
}
.agy-inline-bar-track {
  display: inline-block;
  width: 48px;
  height: 5px;
  border-radius: 999px;
  background: var(--ag-border, rgba(255, 255, 255, 0.14));
  overflow: hidden;
  flex-shrink: 0;
}
.agy-inline-bar-fill {
  display: block;
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: var(--ag-accent, #4ea1ff);
  transition: width 160ms ease, background-color 160ms ease;
}
.agy-inline-bar-fill.warn {
  background: var(--ag-warning, #f5b942);
}
.agy-inline-bar-fill.danger {
  background: var(--ag-danger, #f06565);
}
.agy-inline-sep {
  opacity: 0.35;
}
.agy-inline-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(240, 101, 101, 0.2);
  color: var(--ag-danger, #ff9c9c);
  font-weight: 600;
}
.agy-inline-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.07));
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.14));
  border-radius: 5px;
  color: var(--ag-text, rgba(255, 255, 255, 0.88));
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
.agy-inline-item-badge {
  display: inline-flex;
  align-items: center;
  font-size: 9.5px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.22);
  color: var(--ag-accent, #7dd3fc);
}
.agy-inline-custom-btns,
.agy-inline-delegated-btns {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.agy-inline-status-note {
  font-size: 10px;
  color: var(--ag-text-muted, rgba(255, 255, 255, 0.6));
}
@media (prefers-reduced-motion: reduce) {
  .agy-inline-bar-fill {
    transition: none;
  }
}
`;
