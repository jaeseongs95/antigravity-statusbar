# Antigravity Statusbar (v3.2.0)

Official **Antigravity Native Plugin (`AddonManifest.v2` Trusted Inline Statusbar + Remote Web Support + Headless Native Sidecar)** for monitoring real-time session context usage, prompt cache hit rate, 5h & weekly account quota, 4-tier soft context limits (`session > model > default > host`), guarded auto-compaction with auto-resume, token breakdown, and one-click `/compact`.

[한국어 문서 (README.ko.md)](./README.ko.md)

## Why v3.2.0 (Trusted Static Renderer + `settingsBridge` + Remote Web Support)

Previous v1/v2 versions patched Electron `app.asar` and hooked renderer internals (`lsClient` / React Fiber / Protobuf). Antigravity `2.33.0` upgraded to `@bufbuild/protobuf` v2, proving renderer mutation is unsafe.

**v3.2.0** runs on the official native plugin + [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons) (formerly `antigravity-native-addon-host`) **`>= 2.3.0`** (`v2.5.3+` recommended for Remote Web management UI) with `trustLevel: "trusted"`:
- **Zero `app.asar` patching**, zero Electron renderer injection, zero React Fiber/Redux/Protobuf mutation, zero `hooks.json`.
- **Trusted Immutable Static Renderer (`trustLevel: "trusted"`)**: `scripts/install-plugin.mjs` writes a 100% static, deterministic, credential-free `runtime/statusbar-renderer.js` that passes `antigravity-addons` SHA-256 trust pinning and strict AST hygiene (zero HTML sinks, zero `eval`/`new Function`/`require`). The Sidecar **never** overwrites `runtime/statusbar-renderer.js`.
- **Desktop Live Credentials via `settingsBridge`**: On `antigravity-desktop`, the headless Sidecar publishes its per-launch loopback URL and 256-bit token atomically (`0o600`) to `HOST_DATA_DIR/antigravity-statusbar-runtime.json` (`settingsBridge`) and scrubs it back to `mode: "standby"` on shutdown/exit. Supports optional fixed loopback port via `STATUSBAR_SIDECAR_PORT` (`1024`–`65535`) with automatic `EADDRINUSE` fallback to an ephemeral port.
- **Remote Web (`antigravity-remote-web`) Support**: Declares `hostProfiles: ["antigravity-desktop", "antigravity-remote-web"]` and `uiSlots[0].anchor: "status-bar"`. When `[data-testid="agent-input-box"]` is absent in Remote Web, mounts automatically into the host's `status-bar` anchor / `#remote-addon-host-slot-dock`. Boots cleanly with zero fetches when unconfigured, rejects `packed-initial` snapshots as defense-in-depth, and provides a Settings-tab **Remote Sidecar Connection** UI saving a loopback HTTP or HTTPS endpoint + token strictly in browser-local storage via `addonHost.saveSettings(...)`.
  - **Security Warning**: NEVER pass `--include-settings-snapshots` to `addon-host --build-remote` when `antigravity-statusbar` is active; otherwise the host could inline Desktop runtime credentials into the static Remote Web bundle.
  - **Note on Live CSP**: Direct loopback/HTTPS `fetch` behavior from `https://antigravity.google.com` depends on live site `connect-src` CSP and browser Private Network Access (PNA) rules and should be verified in the target browser environment.
- **Ports & Adapters (Hexagonal) Architecture**: `src/core/` and `src/ui/` are 100% vendor-neutral. All Antigravity integration lives exclusively in `src/adapters/antigravity/`.
- **Hardened Sidecar Security**: Fail-closed auth (explicit `ANTIGRAVITY_SIDECAR_UI_TOKEN >= 16`, or 256-bit per-process ephemeral cryptographic token in headless mode when unset), `POST`-only `/api/*`, `Host` + exact `Origin` validation (including `Access-Control-Allow-Private-Network: true`), SHA-256 `timingSafeEqual`, `16KB` body cap, strict CSP, `path.relative` + `realpathSync` static asset jail, and synchronous `teardownSync()` credential scrubbing on shutdown/exit.

## Features

1. **Real-Time Context Window Usage**: Current tokens / effective limit / % (with honest 99% floor below soft-limit boundary), immediate post-compaction updates, and strict cross-session isolation.
2. **Prompt Cache Hit %**: Accurate cache hit ratio from provider-aware token usage (`cacheReadTokens` vs `inputTokens`).
3. **5h & Weekly Account Quota**: Displays 5h and weekly (or exact window label for non-weekly buckets) remaining percentages with reset timestamps in tooltip.
4. **4-Tier Context Limits (`32K`–`980K`) & Global Limit Modal**: `This session > Per-model global > All-models global default > Host default` — never mutates global host engine flags (`SetMendelFlagOverrides`).
5. **Guarded Auto-Compaction & Auto-Resume (`autoCompactWhileRunning`)**:
   - `'resume'` (default): Compacts immediately when a `RUNNING` session reaches its custom limit, latches checkpoint completion across transient `RUNNING` status windows, and dispatches a single-shot guarded continuation prompt (`agentapi send-message` first with `SendUserCascadeMessage` RPC fallback) once the session settles into `IDLE` (never resumes manual `/compact`, `IDLE` sessions, cancelled/errored runs, host self-resume, or after manual user input; surfaces `AUTO_RESUME_FAILED` on delivery failure; protected by a 3-run circuit breaker).
   - `'defer'`: Defers compaction until the active `RUNNING` turn finishes into `IDLE`.
   - Background sweep excludes identifiable subagent cascades by default.
6. **One-Click `[ compact ]` & Custom Prompt**: Async `SendUserCascadeMessage` RPC with bounded non-acceptance-only `agentapi` fallback, per-session mutex, and editable `/compact <prompt>`.
7. **Statusbar Add-ons (`StatusbarAddon.v1`) & `EN` / `KO` Locale Toggle**: Atomic lock-protected custom command buttons via `scripts/statusbar-addon.mjs` and instant `EN`/`KO` switching.

## Installation

Requires [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons) (formerly `antigravity-native-addon-host`) `>= 2.3.0` installed on Antigravity Desktop.

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar
npm ci --omit=dev
npm run install-plugin
```

Register the updated `AddonManifest.v2` manifest in `antigravity-addons`, approve `trustLevel: "trusted"` (SHA-256 pinning of the immutable `runtime/statusbar-renderer.js`), and optionally rebuild the Remote Web bundle (NEVER pass `--include-settings-snapshots`):

```bash
# Run from your antigravity-addons directory
node bin/addon-host.js --register ~/.gemini/config/plugins/antigravity-statusbar/addon-manifest.v2.json
node bin/addon-host.js trust approve antigravity-statusbar
# Optional: rebuild Remote Web UserScript/bookmarklet (without --include-settings-snapshots)
node bin/addon-host.js --build-remote --out-dir ~/.gemini/antigravity/remote-dist
```

Or preview the plugin copy without writing:

```bash
node scripts/install-plugin.mjs --dry-run
```

Restart Antigravity and enable **Antigravity Statusbar** in Plugins Manager. The inline statusbar renders automatically beneath the chat input box.

## Verification

```bash
npm test
```

## License

MIT
