# Test Cases Specification (`antigravity-statusbar`)

**Languages:** **English** | **[한국어 섹션 바로가기](#테스트케이스-명세-국문)**

This document defines the pre-implementation test cases and verification oracles for `antigravity-statusbar`, executed via Node.js native test runner (`node --test test/statusbar.test.js`).

## Test Environment & Runner

- **Runner**: Node.js built-in `node:test` + `node:assert/strict` (`npm test` -> `node scripts/build.js && node --test test/statusbar.test.js`)
- **Target Boundary**: Public module exports (`src/*`, `scripts/*`) and compiled single-file bundle (`dist/statusbar_autoinject.js`) inside isolated `vm` / synthetic DOM / local loopback WebSocket fixtures (zero mutation of host `~/.gemini/antigravity` or `%LOCALAPPDATA%` files).

## Test Case Matrix

| Case ID | Requirement / Defect ID | Level | Entry Point | Scenario & Input | Expected Oracle (Pass Condition) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `SB-TC-001` | `D-0001` ~ `D-0014` | Unit / Integration | `mountStatusBar`, `createContextWindowController`, `ensureRemoteCompanionScripts`, `ensure_statusbar_patch` | Existing verified baseline regressions (host-aware companion loading, `max_token_limit` sync, 5-byte Connect JSON framing, non-blocking hook stdin, listener cleanup, cookie override priority, non-destructive model selection) | All baseline assertions pass without regression. |
| `SB-TC-015` | `D-0015` | Unit | `scripts/install.js` (`splitExistingAutoinject`), `fetchHostInstalledPluginInfo` | Multi-plugin bundle containing indented string literals of markers inside `ko-thought-translator` and `(?:_V\d+)?` markers | Extracts exact top-level plugin blocks without syntax truncation or false-positive companion detection. |
| `SB-TC-016` | `D-0016` | Integration | `configureTargetViaCdp`, `injectViaCdpLive` | `Runtime.evaluate` returning `exceptionDetails`; Electron 35+ `/json/list` returning `[]` with `DevToolsActivePort` Browser WS | Rejects on runtime exception; attaches via `Target.getTargets` + `Target.attachToTarget` and injects cleanly. |
| `SB-TC-017` | `D-0017`, `D-0024` | Unit | `scripts/build.js` (`buildBundle`) | Multiline template literals following regex literals (`/\\/*/`, `/\`/`) AND single/double-quoted string lines ending with even (`'a\\\\'`) vs odd (`'a\\\n'`) trailing backslashes | Preserves template literal lines verbatim and terminates closed string literals with even trailing backslashes on the same line without corrupting subsequent lines. |
| `SB-TC-018` | `D-0018` | Unit | `createContextWindowController` | Cookie-only session override (`agy_cw_<id>=384k`) without `localStorage` entry; >200 session entries | Encodes remote annotation for cookie-only override and evicts oldest entries down to the 200-session ceiling. |
| `SB-TC-019` | `D-0019` | Unit | `stripTrailingCheckpointSuffix` | Protobuf payload ending with valid vs non-matching/truncated `0x2a` varint suffix | Strips suffix if and only if varint length reaches exact payload end and matches expected checkpoint bytes. |
| `SB-TC-020` | `D-0020`, `D-0026` | Integration | `mountStatusBar`, `window.__agyStatusBarCleanup`, `adapter-registry` | Unmounting statusbar with active timers, style tags, custom adapter empty `title` update, same-origin remote `iframe` DOM, and >200 cascade tracking map keys | Unmounts adapters, removes style tags and `.agy-ctx-statusbar`/`.agy-ctx-menu` in both parent and same-origin `iframe` documents, clears empty `title` attribute, and bounds cascade maps to <= 200 keys. |
| `SB-TC-021` | `D-0021`, `D-0029` | Static / Contract | `README.md`, `README.ko.md`, `docs/templates/*`, `package.json` | Documentation version headers, English-first language link, template existence, and API/annotation contract descriptions | Templates exist, versions match `package.json`, and no stale API/count discrepancies exist. |
| `SB-TC-022` | `D-0022` | Unit / Integration | `injectCheckpointLimitIntoSendRequest`, `installSendMessageCheckpointHook` | 1) JSON & Protobuf `SendUserCascadeMessageRequest` with `continueAfterInjection: true` / `continue_after_injection: true` / Protobuf field 20 (`0xa0 0x01 = 1`); 2) Binary Protobuf request already containing `field 5` (`cascade_config`) with other subfields (e.g., `planner_config` field 1) | 1) Must NOT inject `cascade_config` when `continue_after_injection` is `true` (bytes/JSON returned unchanged); 2) Merges `checkpoint_config` into existing `field 5` without duplicating `field 5` or losing sibling `CascadeConfig` fields. |
| `SB-TC-023` | `D-0023` | Unit | `scripts/ensure_statusbar_patch.js` (`transformExactSize`, `isAsarPatchedFast`, `syncAppStorageCode`, `acquireLock`) | 1) Source containing `//` and `/*` inside multiline template/string literals; 2) ASAR header padded with trailing `\0` bytes; 3) `MAIN_ANCHOR_REPLACEMENT` / `UTILS_ANCHOR_REPLACEMENT` URL scheme guard against `data:` / `about:blank` / `scriptJail` | 1) Preserves string/template contents intact while matching exact byte length; 2) Parses NUL-padded ASAR headers without `SyntaxError`; 3) Skips `scriptJail` and non-`http(s):` URLs. |
| `SB-TC-025` | `D-0025`, `D-0032` | Unit | `ensureRemoteCompanionScripts`, `createTrustedHtmlSetter`, `promoteCrossOriginRemoteIframe`, `core-metrics` | 1) CSP environment rejecting dynamic `agy-rc-*` policy name or all policy names while recording attempted policy names; 2) Special characters in `cdnBaseUrl`/`nonce` or `quota` fields | 1) Uses only plugin-scoped `agy-statusbar*` / `agy-rc-*` policy names (never `'default'`, `'dompurify'`, `'angular'`, `'angular#unsafe-bypass'`, `'nextjs#bundler'`) and falls back cleanly to Blob URL / `Range.createContextualFragment`; 2) Escapes HTML attributes and text safely. |
| `SB-TC-027` | `D-0027`, `D-0031` | Unit | `src/host-adapter-config.js`, `createRpcClient`, `createHostBridge`, `mountStatusBar` | 1) Custom `hostConfig` overriding `rpcServicePrefix`, `csrfHeaderName`, `remoteHostDomains`, and `companionScripts`; 2) Spoofed external hostnames (`antigravity.google.com.evil.example`, `evil-antigravity.google.com`) vs exact/dot-boundary subdomains | 1) Routes RPC requests, headers, domain checks, and companion URLs through injected `hostConfig`; 2) `isRemoteHost` strictly accepts only exact match (`host === d`) or dot-boundary subdomain (`host.endsWith('.' + d)`) and rejects substring spoofing (`false`). |
| `SB-TC-028` | `D-0028`, `D-0030` | Static / Integration | `.github/workflows/ci.yml`, `ensure_statusbar_patch.js` (`createRfc6455WebSocketClient`) | GitFlow branch trigger configuration check and Node.js 20 LTS (`globalThis.WebSocket === undefined`) RFC 6455 loopback handshake | Includes `main`, `develop`, `feature/**`, `fix/**`, `bugfix/**`, `release/**`, `hotfix/**` and `workflow_dispatch`; live CDP injection succeeds without global `WebSocket`. |

---

## 테스트케이스 명세 (국문)

본 문서는 구현 및 결함 수정에 앞서 `antigravity-statusbar`의 공개 진입점별 검증 사례와 판정 기준(Oracle)을 정의합니다.

- **실행 명령**: `npm test` (`node scripts/build.js && node --test test/statusbar.test.js`)
- **격리 원칙**: 모든 단위·통합 회귀 시험은 메모리 내 가상 컨텍스트(`node:vm`), 합성 DOM, 로컬 루프백 소켓 픽스처에서만 수행하며 호스트 PC의 전역 설치 경로(`~/.gemini/antigravity`, `%LOCALAPPDATA%`, `%APPDATA%`)를 변경하지 않습니다.
- **검증 범위**: 기존 검증 완료 항목(`D-0001`~`D-0014`), 이전 수정 보완 항목(`D-0015`~`D-0021`), 신규 등록 항목(`D-0022`~`D-0029`) 전건을 위 표의 `SB-TC-001`~`SB-TC-028` 케이스로 검증합니다.
