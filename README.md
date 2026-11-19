# Antigravity Statusbar (v3.0.0)

Official **Antigravity Native Plugin + Auxiliary Pane Sidecar (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)** for monitoring real-time session context usage, prompt cache hit rate, account quota, per-session soft context limits, token breakdown, and one-click `/compact`.

[한국어 문서 (README.ko.md)](./README.ko.md)

## Why v3.0.0 (Clean-Slate Native Plugin)

Previous versions patched Electron `app.asar` and hooked renderer internals (`lsClient` / React Fiber / Protobuf). Antigravity `2.33.0` upgraded to `@bufbuild/protobuf` v2, proving renderer mutation is unsafe.

**v3.0.0 is rebuilt from scratch** as a 100% official native plugin:
- **Zero `app.asar` patching**, zero Electron renderer injection, zero React Fiber/Redux/Protobuf mutation, zero `hooks.json`.
- **Ports & Adapters (Hexagonal) Architecture**: `src/core/` and `src/ui/` are 100% vendor-neutral. All Antigravity integration lives exclusively in `src/adapters/antigravity/`.
- **Hardened Sidecar Security**: Fail-closed auth (`ANTIGRAVITY_SIDECAR_UI_TOKEN >= 16`), `POST`-only `/api/*`, `Host` + exact `Origin` validation, SHA-256 `timingSafeEqual`, `16KB` body cap, zero CORS, strict CSP, and `path.relative` + `realpathSync` static asset jail.

## Features

1. **Real-Time Context Window Usage**: Current tokens / effective limit / %, immediate post-compaction updates, and strict cross-session isolation.
2. **Prompt Cache Hit %**: Accurate cache hit ratio from provider-aware token usage (`cacheReadTokens` vs `inputTokens`).
3. **5h & 7d Account Quota**: Remaining percentage and reset countdown per quota group.
4. **Per-Session & Default Soft Context Limit (`32K`–`980K`)**: Option A per-session soft limit — never mutates global host engine flags (`SetMendelFlagOverrides`), warns when reached, and offers one-click compaction.
5. **One-Click `[ compact ]`**: Async `SendUserCascadeMessage` RPC with bounded non-acceptance-only `agentapi` fallback and per-session mutex.
6. **`[ context ]` Token Breakdown**: Model name, step count, and 8-group token breakdown.
7. **`EN` / `KO` Locale Toggle**: Instant language switching persisted across sessions.

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

Restart Antigravity and enable **Antigravity Statusbar** in Plugins Manager, then open the **Statusbar** auxiliary pane on the right.

## Verification

```bash
npm test
```

## License

MIT
