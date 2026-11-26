# Antigravity Statusbar (v3.3.1)

Official **Antigravity Native Plugin (`AddonManifest.v3` API-First Trusted Statusbar + `host.statusbar` Provider + Native Host `v3.1.1` Remote Bridge + Headless Native Sidecar)** for monitoring real-time session context usage, prompt cache hit rate, localized 5h & weekly account quota, subagent model display, 4-tier soft context limits (`session > model > default > host`), guarded auto-compaction with auto-resume, token breakdown, and one-click `/compact`.

[한국어 문서 (README.ko.md)](./README.ko.md)

## Why v3.3.1 (`AddonManifest.v3` API-First + Native Host `v3.1.1+` / Extenra `v3.2.1` Polish)

**v3.3.1** runs on [Extenra](https://github.com/jaeseongs95/extenra) (formerly `antigravity-addons`) **`>= 3.1.1`** (`AddonManifest.v3` + `AddonContextV3`) with least-privilege `trustLevel: "trusted"` and polishes inline statusbar wrapping/deduplication, Settings form layout, in-place Global Context Limits navigation (zero modal-on-modal stacking), and button row alignment:

- **3-Tier API-First UI (Zero Manual Overlay DOM)**:
  - **Tier 1**: Unified Settings page (`ctx.ui.registerSettingsPage` — rendered inline inside Desktop Settings and in Remote Web), commands (`ctx.ui.registerCommand`), and notifications (`ctx.ui.showToast`).
  - **Tier 2**: Context Details popup (`ctx.ui.openPopup`) and Global Context Limits modal (`ctx.ui.openModal`) driven by declarative schemas (`handle.update(nextTree, nextState)` ID in-place patching) with automatic viewport flip/shift and mobile `<=640px` bottom-sheet adaptation.
  - **Tier 3**: Compact inline statusbar canvas (`ctx.ui.mountCanvas`) adapting to Dark/Light `--ag-*` theme tokens.
- **Well-Known `host.statusbar` Service Provider**: Declares `permissions.services.provide: [{ name: "host.statusbar", allowedCallers: ["*"] }]` so peer plugins calling `ctx.ui.registerStatusItem(...)` render seamlessly inside the statusbar on both Desktop and Remote Web.
- **Native Host `v3.1.1` Centralized Remote Host Bridge**: Removes plugin-owned remote Sidecar URL/token input forms, browser credential storage, and direct remote HTTPS endpoints. Both Desktop and Remote Web use the exact same `ctx.net.fetch` (`permissions.net.localLoopback: ["antigravity-sidecar"]`) + `ctx.settingsBridge` path. On Remote Web, pair once in **Addons → Host Bridge**; the statusbar subscribes to `host:remote-bridge-changed` and displays read-only connection status and guidance when offline (`ERR_REMOTE_HOST_NOT_CONNECTED`).
- **Trusted Immutable Static Renderer**: `scripts/install-plugin.mjs` writes a deterministic, credential-free `runtime/statusbar-renderer.js` for SHA-256 trust pinning. The headless Sidecar publishes live loopback credentials atomically (`0o600`) to `HOST_DATA_DIR/antigravity-statusbar-runtime.json` (`settingsBridge`) and scrubs it to `mode: "standby"` on exit.
- **Ports & Adapters (Hexagonal) Architecture & Hardened Sidecar Security**: `src/core/` and `src/ui/` are 100% vendor-neutral. Zero `app.asar` patching, zero renderer internals mutation, fail-closed token auth, `POST`-only `/api/*`, `Host` + exact `Origin` validation, SHA-256 `timingSafeEqual`, and synchronous `teardownSync()` scrubbing.

## Features

1. **Real-Time Context Window Usage**: Current tokens / effective limit / % (honest 99% floor below soft-limit boundary), immediate post-compaction updates, and strict cross-session isolation.
2. **Subagent Model Pill & Focus Pinning**: Displays the active model pill on subagent conversation views (`[data-testid="subagent-tab-conversation"]`) and keeps subagent/main views stably pinned on click/focus.
3. **Prompt Cache Hit %**: Accurate cache hit ratio from provider-aware token usage (`cacheReadTokens` vs `inputTokens`).
4. **Localized 5h & Weekly Account Quota**: Displays 5h remaining % with local `HH:mm` reset time and weekly quota (with full local timestamps in tooltips), plus automatic refresh on expired `resetTime`, window focus, or click.
5. **4-Tier Context Limits (`32K`–`980K`) & Global Limit Modal**: `This session > Per-model global > All-models global default > Host default` — never mutates global host engine flags (`SetMendelFlagOverrides`).
6. **Guarded Auto-Compaction & Auto-Resume (`autoCompactWhileRunning`)**:
   - `'resume'` (default): Compacts immediately when a `RUNNING` session reaches its custom limit and dispatches a single-shot guarded continuation prompt once settled into `IDLE` (protected by a 3-run circuit breaker).
   - `'defer'`: Defers compaction until the active `RUNNING` turn finishes into `IDLE`.
7. **One-Click `[ compact ]`, Custom Prompt & `StatusbarAddon.v1`**: Per-session mutex, editable `/compact <prompt>`, custom command buttons via `scripts/statusbar-addon.mjs`, and `EN` / `KO` locale switching.

## Installation

Requires [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons) `>= 3.1.1` installed on Antigravity Desktop.

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar
npm ci --omit=dev
npm run install-plugin
```

Register `addon-manifest.v3.json` in `antigravity-addons`, approve `trustLevel: "trusted"` (SHA-256 pinning of the immutable `runtime/statusbar-renderer.js`), and optionally rebuild the Remote Web bundle (NEVER pass `--include-settings-snapshots`):

```bash
# Run from your antigravity-addons directory
node bin/addon-host.js --register ~/.gemini/config/plugins/antigravity-statusbar/addon-manifest.v3.json
node bin/addon-host.js trust approve antigravity-statusbar
# Optional: rebuild Remote Web bundle (without --include-settings-snapshots)
node bin/addon-host.js --build-remote --out-dir ~/.gemini/antigravity/remote-dist
```

Or preview the plugin copy without writing:

```bash
node scripts/install-plugin.mjs --dry-run
```

Restart Antigravity and enable **Antigravity Statusbar** in Plugins Manager. For Remote Web, enable **Remote Host Bridge** in Desktop Settings → Addon Manager and pair once inside the Remote Web **Addons → Host Bridge** tab.

## Verification

```bash
npm test
```

## License

MIT
