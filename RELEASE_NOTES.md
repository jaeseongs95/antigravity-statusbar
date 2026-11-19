# Release Notes

## v3.0.0 (Clean-Slate Official Native Plugin)

### Breaking Changes
- **Removed all `app.asar` patching, Electron renderer injection, UserScript bundling, React Fiber/Protobuf hooking, `hooks.json`, and Remote Control Web bookmarklet/iframe code.**
- Rebuilt from scratch as an official Antigravity Native Plugin (`plugin.json` + `sidecars/statusbar/sidecar.json` with `SIDECAR_UI_ENTRYPOINT_AUX_PANE`).

### Architecture & Security
- Strict Ports & Adapters (Hexagonal) separation: `src/core/` and `src/ui/` are 100% vendor-neutral (verified by automated static boundary tests).
- Hardened loopback-only Sidecar HTTP server: Fail-Closed token length (`>= 16`), `POST`-only `/api/*` (`405` + zero CORS for other methods), `Host` check on both static `GET` and API `POST`, exact same-origin `Origin` check, SHA-256 `timingSafeEqual`, `16KB` body cap (`413`), strict CSP, and `path.relative` + `realpathSync` static jail.
- Connect 5-byte streaming frame reader (`StreamAgentStateUpdates`) with status/content-type precheck, `4MB` cap, and permanent `'error'` listeners before early `destroy()`.
- Cross-process `settings.lock` with `O_EXCL`, 0-byte `10s` grace, rename-aside + token verification stale recovery, monotonic timestamps, and Windows `EPERM`/`EBUSY`/`EACCES` rename backoff (`< 3s`).
- Bounded non-acceptance-only `agentapi` fallback using `spawn(..., { shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'], signal })` with `64KB` stream drain and child PID cleanup on shutdown.
