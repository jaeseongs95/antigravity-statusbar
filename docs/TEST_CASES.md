# Test Cases Specification v2.0 (`antigravity-statusbar`)

**Languages:** **English** | **[한국어 섹션 바로가기](#테스트케이스-명세-v20-국문)**

This document defines the v2.0 test cases and verification oracles for the modular Hexagonal `antigravity-statusbar` architecture (`docs/ARCHITECTURE_V2.md`), preserving every regression guarantee across all 34 ledger defects (`D-0001`–`D-0034`), all 5 tasks (`T-0001`–`T-0005`), and all legacy `SB-TC-001`–`SB-TC-041` checks while separating suites by architectural layer.

## Test Environment & Runner

- **Runner**: Node.js built-in `node:test` + `node:assert/strict`
  - Full verification: `npm test` (`node scripts/build.js && node --test test/unit/domain.test.js test/unit/ui.test.js test/integration/drivers.test.js test/installer/patcher.test.js test/e2e/remote-chrome.test.js`)
  - Fast unit loop: `npm run test:unit` (`node --test test/unit/domain.test.js test/unit/ui.test.js`)
- **Isolation Guarantee**: All suites execute exclusively inside `node:vm`, synthetic DOM fixtures, temporary directories, loopback TLS/WebSocket servers, and ephemeral headless Chromium user profiles — never mutating `~/.gemini/antigravity` or `%LOCALAPPDATA%`.
- **Standalone CI**: Zero external sibling repository checkouts are required (`D-0028`).

---

## Test Suite Matrix (`test/{unit,integration,installer,e2e}/`)

| Case ID | Ledger Task / Defect Coverage | Suite File | Entry Point | Verification Oracle (Pass Condition) |
| :--- | :--- | :--- | :--- | :--- |
| `SB2-TC-001` | `T-0002`, `T-0003`, `D-0009`, `D-0014`, `D-0018`, `D-0021` | `test/unit/domain.test.js` | `src/domain/context-window-policy.js`, `src/ports/contracts.js` | Clamps `32K`–`980K`; enforces `200`-entry LRU across both value and timestamp maps; restores lazy session overrides via mechanism-neutral `StoragePort` (`loadSnapshot`, `loadPersistent`, `readSessionOverride`, `saveSessionOverride`, `evictSessionOverride`, `saveDefaultLimit`) with monotonic timestamp priority without `seedSessionIfEmpty` clobber; rejects prototype-polluting or malformed IDs. |
| `SB2-TC-002` | `T-0002`, `T-0004`, `D-0002`, `D-0007`, `D-0012`, `D-0033` | `test/unit/domain.test.js` | `src/domain/metrics-calculator.js`, `src/domain/i18n.js` | Handles `estimatedTokensUsed === 0`, immediate post-compaction reduction (`estimatedAfterCompaction`), cache hit %, protobuf-es quota oneofs, and **fail-closed** `isStateForCascade` (`false` when `conversationId` is absent or mismatched); defaults to `en` with full `ko` locale switching and configurable `compactPrompt`. |
| `SB2-TC-003` | `T-0002`, `T-0003`, `D-0002`, `D-0003`, `D-0008`, `D-0019`, `D-0022` | `test/unit/domain.test.js` | `src/drivers/antigravity/protobuf-wire-codec.js` | Skips `cascade_config` injection when `continue_after_injection` / field 20 is `true`; merges `checkpoint_config.maxTokenLimit` (`field 5`) into existing `cascade_config` preserving sibling fields; strips trailing checkpoint suffix iff varint lengths reach exact payload end; encodes Connect 5-byte JSON envelopes without appending raw binary `0x2a` (`'*'`) and skips compressed flags (`>0`). |
| `SB2-TC-004` | `T-0003`, `T-0005`, `D-0027`, `D-0028`, `D-0029`, `D-0031` | `test/unit/domain.test.js` | `src/drivers/antigravity/host-config.js`, `.github/workflows/ci.yml`, `RELEASE_NOTES.md`, `README*.md` | `isRemoteHost` accepts only exact matches (`host === d`) and dot-boundary subdomains (`*.antigravity.google.com`), rejecting `antigravity.google.com.evil.example` and `evil-antigravity.google.com`; rejects non-`https:` or credentialed CDN URLs and DOM-clobbered globals; encapsulates `resolveCsrfToken(win)`; verifies Hexagonal dependency rules, GitFlow CI triggers (`D-0028`), and bilingual inline `RELEASE_NOTES.md` (`D-0029`). |
| `SB2-TC-005` | `T-0005`, `D-0009`, `D-0025`, `D-0032` | `test/unit/ui.test.js` | `src/ui/dom-builder.js`, `src/ui/style-manager.js` | Unconditionally throwing `innerHTML` setter + spied `trustedTypes.createPolicy` verify **zero** `innerHTML` writes, **zero** HTML policy creation, safe rendering of XSS payloads (`<script>`, `javascript:`, quotes) as literal text nodes, automatic `<style nonce>` propagation (`SB-TC-039`), and zero `Object.prototype` mutation. |
| `SB2-TC-006` | `T-0003`, `T-0004`, `D-0006`, `D-0012`, `D-0026` | `test/unit/ui.test.js` | `src/ui/adapter-registry.js`, `src/ui/views/*.js` | Preserves `registerAdapter`/`unregisterAdapter`/`getAdapters`; orders slots deterministically via `insertBefore`; uses `targetEl.ownerDocument` across parent and child iframe documents; clears empty `title` attribute; updates metric text nodes **in-place** preserving limit button identity/hover; removes all outside-click/blur/Escape listeners when closing menu/modal via toggle or cleanup. |
| `SB2-TC-007` | `T-0002`, `T-0004`, `D-0002`, `D-0008`, `D-0012`, `D-0013` | `test/integration/drivers.test.js` | `src/drivers/antigravity/react-fiber-driver.js`, `compact-driver.js`, `local-http-transport.js` | Preserves user default model & reasoning effort (`default.model`) on `modelSelection/modelPicked` rollback without `atStep: 999999` poisoning; enforces `2500` node / `2500ms` DFS cooldown; normalizes desktop `lB()` RPC arguments (`D-0004`); guards `subscribeToPlugins` 600ms timeout preserving first stream yield without `unhandledrejection`; dispatches configured `/compact` prompt. |
| `SB2-TC-008` | `T-0001`, `T-0005`, `D-0034` (`SB-TC-036`) | `test/integration/drivers.test.js` | `src/drivers/antigravity/remote-port-driver.js` | Discovers `<ga-remote-control>` via Angular 19 numeric `__ngContext__` / `LView` BFS and internal `__agy_probe__` (captured before `isTrustedMessageEvent` without forwarding to `next`); chains `RC.prototype` hooks cleanly across arbitrary unmount order; honors `__agySuppressAutoIframeLoad*` guards; never mutates cross-origin iframe `src`. |
| `SB2-TC-009` | `T-0001`, `T-0005`, `D-0001`, `D-0004`, `D-0011`, `D-0015`, `D-0020`, `D-0032`, `AUDIT-M6`, `NB2` | `test/integration/drivers.test.js` | `src/app/disposable.js`, `src/app/index.js`, `companion-driver.js`, `local-http-transport.js` | Discovers installed host companions via `GetCustomizationStates` + `ReadFile` (`Uint8Array` / `ArrayBuffer` / base64, `//` & `/* */` column-0 `_V\d+` markers) without loading uninstalled companions; cancels `1500ms` retry timers immediately on `dispose()`; caches negative TrustedTypes policy blocks (`WeakMap`) so repeated attempts emit zero extra `createPolicy` violations (`BLOCKING-B`); enforces `this === win` on timers and clean `__agyStatusBarCleanup()`. |
| `SB2-TC-010` | `T-0003`, `T-0004`, `D-0005`, `D-0010`, `D-0015`, `D-0016`, `D-0017`, `D-0023`, `D-0024`, `D-0030` | `test/installer/patcher.test.js` | `scripts/build.js`, `scripts/install.js`, `installer/*.js` | Build script parses nested `src/` preserving templates/regexes/backslashes and `@version === package.json.version`; `install.js` extracts column-0 host companion blocks safely; `asar-codec` handles NUL-padded headers + exact-size replacement; `host-patcher` returns `FAILED_CORRUPTED_BACKUP` without touching `app.asar` when `.orig` backup is corrupted; `file-lock` recovers stale locks atomically; `cli` drains stdin non-blockingly (`D-0005`); `rfc6455-client` (`D-0030`) & `cdp-injector` (`D-0016`) handle fragmentation, Ping/Close, and `Runtime.evaluate` exceptions. |
| `SB2-TC-011` | `T-0001`, `T-0005`, `D-0001`, `D-0004`, `D-0011`, `D-0025`, `D-0026`, `D-0032`, `D-0034` (`SB-TC-037`) | `test/e2e/remote-chrome.test.js` | Compiled `dist/statusbar_autoinject.js` + `README.md` Bookmarklet | Launches headless Chromium against local TLS `<ga-remote-control>` host with verbatim `antigravity.google.com/r/...-v2` CSP headers (including `/r/style-nonce-only`, `/r/strict-tt-preflight` allowlisting only `ogb-qtm#html agy-sb-bm`, and `/r/strict-tt-block-all-v2`): executes unmodified `README.md` bookmarklet with **zero** synthetic `__AGY_STATUSBAR_HOST_CONFIG__`, verifies automatic host-marker companion load via `GetCustomizationStates` + `ReadFile` (`Uint8Array`) + shared one-shot `scriptGate` while skipping uninstalled companions, verifies promoted same-origin child iframe `ownerDocument` rendering + 3-plugin coexistence + debug modal + complete parent/child cleanup with zero CSP violations or runtime errors. |
| `SB2-TC-012` | `T-0005`, `AUDIT-M5` (`SB-TC-040`) | `test/e2e/remote-chrome.test.js` | Unauthenticated live `https://antigravity.google.com/r/00000000-0000-0000-0000-000000000000-v2` | Real Chromium (NO `--host-resolver-rules`) navigates to live `antigravity.google.com` login shell, executes unmodified `README.md` bookmarklet (`Fetch.enable` serving local candidate bundle only for `raw.githubusercontent.com`), verifies `window.agyStatusBar`, live style CSP nonce, clean `__agyStatusBarCleanup()`, zero CSP violations, and zero uncaught errors. *(Scoped explicitly as unauthenticated host CSP smoke; authenticated `<ga-remote-control>` UI & `-v2` MessagePort RPC remain verified in `SB2-TC-011`.)* |

---

## Complete Defect & Task Traceability Index (`D-0001`–`D-0034`, `T-0001`–`T-0005`)

- **Tasks**:
  - `T-0001`: `SB2-TC-008`, `SB2-TC-009`, `SB2-TC-011`
  - `T-0002`: `SB2-TC-001`, `SB2-TC-002`, `SB2-TC-003`, `SB2-TC-007`
  - `T-0003`: `SB2-TC-001`, `SB2-TC-003`, `SB2-TC-004`, `SB2-TC-006`, `SB2-TC-010`
  - `T-0004`: `SB2-TC-002`, `SB2-TC-006`, `SB2-TC-007`, `SB2-TC-010`
  - `T-0005`: `SB2-TC-004`, `SB2-TC-005`, `SB2-TC-008`, `SB2-TC-009`, `SB2-TC-011`, `SB2-TC-012`
- **Defects**:
  - `D-0001`, `D-0004`, `D-0011`: `SB2-TC-007`, `SB2-TC-009`, `SB2-TC-011`
  - `D-0002`, `D-0003`, `D-0007`, `D-0008`, `D-0019`, `D-0022`: `SB2-TC-002`, `SB2-TC-003`, `SB2-TC-007`
  - `D-0005`, `D-0010`, `D-0015`, `D-0016`, `D-0017`, `D-0023`, `D-0024`, `D-0030`: `SB2-TC-009`, `SB2-TC-010`
  - `D-0006`, `D-0009`, `D-0012`, `D-0013`, `D-0014`, `D-0018`, `D-0020`, `D-0021`, `D-0026`, `D-0033`: `SB2-TC-001`, `SB2-TC-002`, `SB2-TC-005`, `SB2-TC-006`, `SB2-TC-007`, `SB2-TC-009`, `SB2-TC-011`
  - `D-0025`, `D-0027`, `D-0028`, `D-0029`, `D-0031`, `D-0032`, `D-0034`: `SB2-TC-004`, `SB2-TC-005`, `SB2-TC-008`, `SB2-TC-009`, `SB2-TC-011`, `SB2-TC-012`

---

## 테스트케이스 명세 v2.0 (국문)

본 문서는 `antigravity-statusbar` `v2.0.0` 육각형 아키텍처(`docs/ARCHITECTURE_V2.md`)의 계층별 검증 테스트케이스 명세입니다.

- **실행 명령**: `npm test` (번들 빌드 후 `domain.test.js`, `ui.test.js`, `drivers.test.js`, `patcher.test.js`, `remote-chrome.test.js` 순차 실행) / `npm run test:unit` (순수 단위 및 아키텍처 경계 정적 검사)
- **격리 및 독립성**: 형제 저장소 체크아웃 없이 단독 실행하며(`D-0028`), 호스트 PC 설치 경로(`~/.gemini/antigravity`, `%LOCALAPPDATA%`, `%APPDATA%`)를 변경하지 않습니다.
- **회귀 보존**: 장부 등록 결함 전건(`D-0001`~`D-0034`) 및 작업(`T-0001`~`T-0005`), 기존 `SB-TC-001`~`SB-TC-041`의 모든 불변식과 검증 오라클을 `SB2-TC-001`~`SB2-TC-012`로 누락 없이 검증합니다.
