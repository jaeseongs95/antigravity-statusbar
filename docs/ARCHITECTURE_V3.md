# Architecture v3.0.0 — Official Antigravity Native Plugin (AUX_PANE Sidecar)

## 1. Design Principles

1. **Zero Host Mutation**: No `app.asar` patching, no Electron renderer injection, no React Fiber/Redux/Protobuf mutation, no `SetMendelFlagOverrides`, no `hooks.json`.
2. **Strict Vendor Neutrality (Ports & Adapters)**:
   - `src/core/`: Pure ESM domain models, context limit policy, error codes, port contracts, and application service. Zero Node I/O, zero vendor strings.
   - `src/ui/`: Self-contained browser UI (`index.html`, `styles.css`, `i18n.mjs`, `bridge/host-bridge.mjs`, `app.js`). Zero `innerHTML`, zero inline scripts/styles, zero `../core` imports, zero vendor strings.
   - `src/adapters/storage/`: File-backed `json-settings-store.mjs` with injected `dataDir`, cross-process `settings.lock`, monotonic timestamps, and atomic writes.
   - `src/adapters/antigravity/`: All Antigravity-specific Language Server transport (`ls-transport.mjs`), telemetry mapping (`telemetry-mapper.mjs`), compaction (`compaction-adapter.mjs`), UI bridge (`/bridge.js`), and hardened Sidecar HTTP server (`sidecar-entry.mjs`).

## 2. Data Flow

```text
Antigravity AUX_PANE Webview (src/ui/)
   │  POST /api/* + X-Statusbar-Token + exact same-origin Origin
   ▼
Sidecar HTTP Server (src/adapters/antigravity/sidecar-entry.mjs)
   │  Fail-Closed auth, Host/Origin/CSP/path.relative jail
   ▼
Statusbar Service (src/core/app/statusbar-service.mjs)
   ├── TelemetryPort  ──► ls-transport.mjs (loopback Connect JSON & 5B stream)
   ├── CompactionPort ──► compaction-adapter.mjs (SendUserCascadeMessage RPC + bounded spawn fallback)
   └── SettingsPort   ──► json-settings-store.mjs (proper-lockfile + write-file-atomic)
```

## 3. Hardening Guarantees (Gate 1 PASS `F1`–`F10`)

- **F1**: Ledger migration records `D-0010` as local ASAR/UserScript removal with `evidence_uri` on all 7 `NOT_DEFECT` transitions.
- **F2**: Unused `/preload.js` static exception removed; `src/core/i18n/error-codes.mjs` separated from `src/ui/i18n.mjs`.
- **F3**: Connect 5B stream verifies `status === 200` and `application/connect+json`, checks `len <= 4MB` before buffering, and attaches permanent `'error'` listeners before `destroy()`.
- **F4**: Post-compaction guard requires `lastCompactedStep >= 0 && afterCompact > 0 && lastCompactedStep >= max(lastMetaStepIndex, lastStepIndex)`; `effectiveLimit = hostMax > 0 ? Math.min(hostMax, custom) : custom`.
- **F5**: `compactingSessions` mutex is released immediately if both primary RPC and fallback fail; cleared automatically when telemetry confirms completion.
- **F6**: Fallback uses `spawn` (`shell: false`, `windowsHide: true`, `stdio: ['ignore','pipe','pipe']`, `AbortSignal`), `64KB` bounded stream drain, and `dispose()` PID cleanup.
- **F7**: Cross-process locking and atomic persistence use user-approved trusted libraries (`proper-lockfile` atomic `mkdir` lock with heartbeat + `write-file-atomic`).
- **F8–F9**: `Host` validation on both static `GET` and API `POST`, `405` + zero CORS on non-`POST` `/api/*`, `path.relative` + `path.sep` `realpathSync` jail (`%` -> `400`, `\0` -> `400`), and `sessionStorage` token retention across webview reloads after `history.replaceState`.
- **F10**: `dataDir` injected into `json-settings-store.mjs`; monotonic timestamps prevent same-ms overwrite races.
