# Antigravity Statusbar (v3.1.1)

Official **Antigravity Native Plugin (`AddonManifest.v2` Inline Statusbar + Headless Native Sidecar)** for monitoring real-time session context usage, prompt cache hit rate, 5h & weekly account quota, 4-tier soft context limits (`session > model > default > host`), guarded auto-compaction with auto-resume, token breakdown, and one-click `/compact`.

[한국어 문서 (README.ko.md)](./README.ko.md)

## Why v3.1.1 (AddonManifest.v2 Inline Statusbar + Headless Native Sidecar)

Previous v1/v2 versions patched Electron `app.asar` and hooked renderer internals (`lsClient` / React Fiber / Protobuf). Antigravity `2.33.0` upgraded to `@bufbuild/protobuf` v2, proving renderer mutation is unsafe.

**v3.1.1** runs on the official native plugin + `antigravity-native-addon-host` v2 (`AddonManifest.v2`) architecture:
- **Zero `app.asar` patching**, zero Electron renderer injection, zero React Fiber/Redux/Protobuf mutation, zero `hooks.json`.
- **Isolated Shadow DOM Inline UI (`AddonManifest.v2`)**: Renders directly beneath the chat input box using host-owned Shadow DOM slots (`status-bar`, `overlay` popover, `modal` `<dialog>`) with zero credential leakage onto `window` or DOM. The redundant right-hand `AUX_PANE` tab is removed (`sidecar.json` `has_web_ui: false`).
- **Ports & Adapters (Hexagonal) Architecture**: `src/core/` and `src/ui/` are 100% vendor-neutral. All Antigravity integration lives exclusively in `src/adapters/antigravity/`.
- **Hardened Sidecar Security**: Fail-closed auth (explicit `ANTIGRAVITY_SIDECAR_UI_TOKEN >= 16`, or 256-bit per-process ephemeral cryptographic token in headless mode when unset), `POST`-only `/api/*`, `Host` + exact `Origin` validation, SHA-256 `timingSafeEqual`, `16KB` body cap, strict CSP, `path.relative` + `realpathSync` static asset jail, and synchronous `teardownSync()` credential revocation on shutdown/exit.

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

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar
npm ci --omit=dev
npm run install-plugin
```

Or preview without writing:

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
