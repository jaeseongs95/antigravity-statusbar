# Test Cases — Antigravity Statusbar v3.0.0

| Suite | File | Scope |
|---|---|---|
| Static Boundary | `test/static/boundary.test.mjs` | Zero vendor refs, zero `innerHTML`, zero inline scripts/styles, zero `../core` imports in `src/ui`, zero `app.asar` references across repo. |
| Core Unit | `test/unit/core.test.mjs` | Context policy (`32K`–`980K`), `F4` division-by-zero & host clamping, 200-LRU pruning, session ID validation, `D-0033` session mismatch `409`, `F5` compaction mutex release on dual failure & completion detection, cache hit provider formulas. |
| Storage & Concurrency | `test/integration/storage-lock.test.mjs` | `F7` `O_EXCL` `settings.lock`, 0-byte 10s grace, stale dead-PID rename-aside recovery, concurrent multi-writer field merge, `F10` monotonic timestamps & injected `dataDir`, corrupt file `.corrupt.<ts>` recovery. |
| Antigravity Adapter | `test/integration/antigravity-adapter.test.mjs` | Loopback-only LS validation, `F3` Connect 5B stream (`status !== 200`, `> 4MB` frame cap, early `destroy()` without unhandled `'error'`), `F4` post-compaction token guard, quota 15s TTL & 429 backoff, `F6` bounded `spawn` fallback (`64KB` drain, UNC rejection, `dispose()` cleanup). |
| Sidecar Security | `test/security/sidecar-security.test.mjs` | Fail-Closed `< 16` token, `F8`–`F9` `Host` validation on static `GET` and API `POST`, non-`POST` `/api/*` -> `405` + zero CORS, `Origin: null` / foreign `Origin` -> `403`, wrong token -> `401`, `> 16KB` body -> `413`, traversal / symlink / `%ZZ` / `\0` -> `400`/`403`, CSP & `Referrer-Policy` & `no-store` & `nosniff`. |
| UI Controller & DOM | `test/ui/ui-app.test.mjs` | Zero `innerHTML`, incremental DOM updates (`D-0012`), `D-0025` XSS payload escaped via `textContent`, `D-0033` session switch epoch/abort isolation, `EN`/`KO` toggle, soft-limit warning banner, `D-0006`/`D-0020` `dispose()` listener cleanup, `/bridge.js` token capture + `history.replaceState` + reload persistence. |
