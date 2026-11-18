# Architecture Specification v2.0 (`antigravity-statusbar`)

**Languages:** **English** | **[한국어 개요 (국문 요약)](#아키텍처-설계-명세-v20-국문-요약)**

- **Version Target**: `2.0.0` (SemVer Major — internal Hexagonal rewrite preserving public `window.agyStatusBar` and CLI `scripts/*` entrypoints)
- **Repository**: `https://github.com/jaeseongs95/antigravity-statusbar`
- **Status**: Pre-implementation Design Specification (frozen for independent design review prior to v2.0 implementation)

---

## 1. Architectural Motivation (Why v1.x Failed Under Repeated Audits)

Five adversarial audit rounds on `v1.4.0` exposed five structural defects rooted in architecture rather than isolated typos:

1. **Cross-Plugin Coupling & Promotion Races (`D-0034`, `SB-TC-037`)**: Core runtime modules, `scripts/install.js`, and `.github/workflows/ci.yml` embedded knowledge of sibling repositories (`antigravity-mcp-manager`, `ko-thought-translator`), concatenated comment-marker blocks (`BEGIN_AGY_*`), shared mutable `window.__agyLoading*` flags, and competed around `<ga-remote-control>` iframe initialization.
2. **HTML String Interpolation + Regex HTML Parser (`D-0009`, `D-0025`, `D-0032`)**: UI views built HTML template strings and fed them to `createTrustedHtmlSetter` / `renderHtmlViaSafeDomBuilder`, creating recurring escaping and TrustedTypes policy exposure (`D-0032` global policy candidates).
3. **25+ Ad-Hoc `window.__agy*` Globals & Uncoordinated Teardown (`D-0020`)**: State lived on `window.__agy*` and DOM expandos, forcing `cleanupStatusBar` to guess shared ownership during teardown.
4. **Monolithic God Files**: `scripts/ensure_statusbar_patch.js` (`1,618` lines / `52.8 KB`), `src/desktop-react-bridge.js` (`990` lines / `40.7 KB`), `src/host-bridge.js` (`839` lines / `35.6 KB`), and `test/statusbar.test.js` (`6,283` lines / `284.2 KB`) mixed unrelated responsibilities.
5. **Vendor & Locale Leakage**: Antigravity internal RPC paths (`LanguageServerService`), headers (`x-codeium-csrf-token`), DOM selectors, and hardcoded Korean strings leaked directly into domain and UI layers.

---

## 2. Hexagonal Architecture & Strict Dependency Rules

```text
          +---------------------------------------------------+
          |               src/app/ (Composition)              |
          |  index.js (mountStatusBar, window.agyStatusBar)   |
          |  state-coordinator.js   disposable.js             |
          +---------+-------------------+---------------------+
                    |                   |
                    v                   v
      +--------------------+   +----------------------------+
      |     src/ui/        |   |  src/drivers/antigravity/  |
      |  dom-builder.js    |   |  host-config.js            |
      |  style-manager.js  |   |  protobuf-wire-codec.js    |
      |  adapter-registry  |   |  local-http-transport.js   |
      |  views/*.js        |   |  remote-port-driver.js     |
      +---------+----------+   |  react-fiber-driver.js     |
                |              |  compact-driver.js         |
                |              +-------------+--------------+
                v                            |
      +--------------------+                 | implements
      |    src/domain/     |                 v
      |  context-window-   |       +--------------------+
      |   policy.js        |<------|    src/ports/      |
      |  metrics-calc.js   | uses  |  contracts.js      |
      |  i18n.js           |       +--------------------+
      +--------------------+

      +---------------------------------------------------+
      |            installer/ (Node.js CLI Tools)         |
      |  asar-codec.js   file-lock.js   rfc6455-client.js |
      |  cdp-injector.js host-patcher.js  cli.js          |
      +---------------------------------------------------+
```

### Enforced Dependency Invariants

1. `src/domain/**` **MUST NOT** reference `window`, `document`, `fetch`, timers, or any Antigravity/vendor string (`exa.language_server_pb`, `codeium`, `antigravity.google.com`, `ga-remote-control`, `jetski`).
2. `src/ports/**` defines pure interface contracts and shape validators with zero runtime side effects.
3. `src/ui/**` **MUST ONLY** depend on `src/domain/**` and `src/ports/**`. Zero `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, regex HTML parsers, or `trustedTypes.createPolicy` HTML sinks exist anywhere in `src/ui/**`.
4. `src/drivers/antigravity/**` is the **only** source tree permitted to interact with host DOM selectors, Redux/Fiber internals, Lexical editor dispatch, Protobuf wire payloads, HTTP/MessagePort RPC, and host config overrides.
5. `src/**` and `.github/workflows/ci.yml` **MUST NOT** hardcode sibling plugin repository URLs, source markers, or cross-repo CI checkouts.

---

## 3. Target Module Specifications & Public Contracts

### 3.1 `src/ports/contracts.js`
Defines explicit port contracts injected into `StateCoordinator` and `ui/views`:

- **`TransportPort`**:
  - `getStats({ cascadeId, totalGenLen, totalStepsLen }) => Promise<TelemetryStats | null>`
  - `getCachedStats(cascadeId) => TelemetryStats | null`
  - `getImmediateStats(cascadeId, snapshot) => TelemetryStats | null`
  - `getQuota() => Promise<QuotaSummary | null>`
  - `getLatestQuota() => QuotaSummary | null`
  - `getAllTrajectories() => Promise<Record<string, TrajectorySummary> | null>`
  - `updateAnnotations({ cascadeIds, annotations, mergeAnnotations }) => Promise<boolean>`
  - `dispose() => void`
- **`StoragePort`**:
  - `loadPersistent() => Promise<{ defaultCw?: string, sessionMap?: object, tsMap?: object } | null>`
  - `readSessionCookie(cascadeId) => { cw: string, ts: number } | null`
  - `writeSessionCookie(cascadeId, cw, ts) => void`
  - `readDefaultCookie() => string | null`
  - `writeDefaultCookie(cw) => void`
  - `getLocalItem(key) / setLocalItem(key, value)`
  - `flushNative(patchObj) => void`
- **`EnginePort`**:
  - `observeSessions(onRelevantChange) => UnsubscribeFn`
  - `getActiveSessions() => Array<{ sessionId, viewEl, inputEl, triggerEl, isRemoteShell }>`
  - `applyContextLimit({ viewEl, sessionId, contextWindow, userTriggered }) => boolean`
  - `triggerCompact({ inputEl, promptText }) => boolean`
  - `getSelectedModelKey(viewEl, sessionId) => string`
  - `getDebugSnapshot(sessionId, viewEl) => { totalGenLen, totalStepsLen, trajectoryId, canToggleInlineDebug, toggleInlineDebug }`
  - `dispose() => void`
- **`PluginBusPort`** (`Symbol.for('agy.plugin.bus.v2')`):
  - Isolated opt-in window-level registry (`registerPlugin(id, metadata)`, `listPlugins()`, `on(event, handler)`) so co-loaded plugins cooperate cleanly without mutating each other's prototype properties or `window.__agy*` loading flags.

### 3.2 `src/domain/`
- **`src/domain/context-window-policy.js`**:
  - Clamps all numeric inputs strictly to `[32K, 980K]`, normalizes `K` / `M` / raw tokens (`>= 10000` divided by `1000`).
  - `MAX_SESSION_ENTRIES = 200` with strict FIFO/LRU key order eviction kept synchronized across both `sessionCwMap` and `sessionCwTsMap` (`D-0018`).
  - Cookie-only override restoration updates `sessionCwTsMap` and prevents `seedSessionIfEmpty` from overwriting cookie overrides with Redux defaults (`D-0014`).
- **`src/domain/metrics-calculator.js`**:
  - Pure `extractStatsFromMetas(metas)` handling explicit `estimatedTokensUsed === 0` (`!== undefined && !== null`), `bigint`/number coercion, and `cacheRead / (cacheRead + inputTok)` hit percentage.
  - `applyRealtimeCompactionAndUsage(parsed, fullState)` with **fail-closed** `isStateForCascade(fullState, cascadeId)` requiring explicit ID match (`D-0033` — missing ID never leaks across sessions).
  - `parseQuotaResponse(raw)` handling both REST JSON and protobuf-es `remaining` oneof variants.
- **`src/domain/i18n.js`**:
  - `DEFAULT_LOCALE = 'en'`; built-in `en` and `ko` message dictionaries (`auto` detection from host `navigator.language` or explicit `setLocale('en' | 'ko')`).
  - Eliminates hardcoded Korean strings in core UI (`[ compact ]`, `[ context ]`, menu headers, custom range hint, quota hints).
  - Exports configurable `DEFAULT_COMPACT_PROMPT` overridable via `hostConfig.compactPrompt`.

### 3.3 `src/ui/` (Zero-HTML DOM Architecture)
- **`src/ui/dom-builder.js`**:
  - Implements `h(doc, tag, props, ...children)`, `setText(el, str)`, and `clearChildren(el)`.
  - Uses strictly `doc.createElement`, `doc.createTextNode`, `el.textContent`, `el.setAttribute`, and `el.addEventListener`.
  - **By construction guarantees**: zero `innerHTML`, zero HTML string interpolation, zero `decodeHtmlEntities` / regex tag parsing, zero `TrustedHTML` policy calls (`D-0009`, `D-0025`, `D-0032`).
- **`src/ui/style-manager.js`**:
  - Injects `#agy-ctx-statusbar-style` with automatic CSP `<script nonce>` inheritance (`SB-TC-039`), tracks inaccessible cross-origin child iframes in a private `WeakSet` (never sets DOM expandos), builds dynamic `<= 256K` CSS rules without touching `Object.prototype` (`D-0026`, `D-0033`), and removes all owned style elements on `dispose()`.
- **`src/ui/adapter-registry.js`**:
  - Preserves public `registerAdapter(adapter)`, `unregisterAdapter(id)`, `getAdapters()` API cleanly.
  - Builds `.agy-ctx-left` and `.agy-ctx-right` containers via `h()`, cleans child popovers tracked via `WeakMap` before node removal, reconciles `order` sorting via `insertBefore`, and invokes `removeAttribute('title')` when `title` becomes empty (`D-0026`).
- **`src/ui/views/{metrics-view,compact-button,context-modal}.js`**:
  - `metrics-view.js`: Updates metric text and limit badge attributes **in-place** without destroying button nodes or losing mouse hover (`D-0012`); tracks popover listeners in a local `DisposableScope` for leak-free toggle/outside-click/blur teardown (`D-0006`).
  - `context-modal.js`: Built entirely with `h()` (`table`, `thead`, `tbody`, cards, inline stats toggle, close button, Escape listener cleanup on close or unmount `D-0006`).

### 3.4 `src/drivers/antigravity/` (Vendor Isolation & Coexistence Boundary)
- **`src/drivers/antigravity/host-config.js`**:
  - Enforces exact domain or dot-boundary subdomain matching (`host === d || host.endsWith('.' + d)` — blocks substring spoofing `D-0031`).
  - Validates HTTPS CDN origins (`https:` only, zero credentials). Accepts runtime overrides via `mountStatusBar({ hostConfig })` or `window.__AGY_HOST_ADAPTER_CONFIG__`.
- **`src/drivers/antigravity/protobuf-wire-codec.js`**:
  - Pure Connect 5-byte frame codec & Protobuf wire injector (`D-0019` exact varint end verification, `D-0022` `ContinueAfterInjection` field-20 bypass + existing `field 5` `cascade_config` merge preserving sibling `planner_config` subfields, handles `Request` clones `D-0008`).
- **`src/drivers/antigravity/local-http-transport.js`**:
  - Handles local HTTP Connect-RPC (`!__APP_CONFIG__.isRemoteControl`) + Remote Control RPC service fallback + 15s quota throttle + tail-bounded metadata lookup + bounded `MAX_CACHE_ENTRIES = 60` & `MAX_GEN_LEN_ENTRIES = 200` internal maps + `.bind(win)` flush timers (`NB2`) + clean `dispose()`.
- **`src/drivers/antigravity/remote-port-driver.js`**:
  - Encapsulates `<ga-remote-control>` Angular Ivy discovery (`ng.getComponent`, `ɵgetLContext`, bounded `LView` BFS, `__agyProbingRcInstance` guard) and `WeakMap`-isolated ref-counted `RemoteControlComponent.prototype` lease chaining (`proxyCommand`, `streamProxyCommand`, `handlePortRequest`, `onIframeLoad`, `handleUrlChanged`, `handleIframeMessage`).
  - Preserves `__agySuppressAutoIframeLoad` / `__agySuppressAutoIframeLoadCount` so other plugins' active iframe promotion handshakes never tear down `MessagePort` (`D-0034`).
  - **Single-Responsibility Promotion Boundary**: `antigravity-statusbar` NEVER hijacks, rewrites, or promotes cross-origin child iframes (`about:blank` -> `cd.open()`); it operates strictly on the parent `<ga-remote-control>` shell (and observes accessible same-origin child DOM passively if promoted by a host or another plugin), eliminating cross-plugin iframe promotion races (`SB-TC-037`).
- **`src/drivers/antigravity/react-fiber-driver.js`**:
  - Encapsulates React Fiber DFS (`MAX_NODES = 2500`, `COOLDOWN_MS = 2500` after store acquisition), `subscribeToPlugins` 600ms timeout fallback preserving the first async iterator result without `unhandledrejection` (`D-0008`), `telemetry` sync guard, and `modelSelection/modelPicked` application that checkpoints and restores `default.model` so per-session limits never demote user reasoning effort (`D-0013`).
- **`src/drivers/antigravity/compact-driver.js`**:
  - Encapsulates Lexical editor command dispatch using configurable `compactPrompt`.

### 3.5 `src/app/` (Lifecycle & Public Entrypoint)
- **`src/app/disposable.js`**:
  - Deterministic LIFO `DisposableScope` tracking timers (`setTimeout`/`setInterval` bound via `win.setTimeout.bind(win)` per `NB2`), `AbortController`s (`AUDIT-M6`), DOM listeners, `MutationObserver`, prototype leases, and view cleanup callbacks.
- **`src/app/index.js`**:
  - Exposes `mountStatusBar(env)`, backward-compatible `window.agyStatusBar` (`version`, `registerAdapter`, `unregisterAdapter`, `getAdapters`, `updateAll`, `getConversationContextWindow`, `setConversationContextWindow`, plus `setLocale`, `destroy`), and `window.__agyStatusBarCleanup` (`D-0020`).
  - Eliminates 25+ `window.__agy*` globals; stores internal session/telemetry/DOM state inside closure/WeakMaps.
  - Registers presence safely on `Symbol.for('agy.plugin.bus.v2')`.

### 3.6 `installer/` & `scripts/` (Decomposed Host Patcher)
Replaces monolithic `scripts/ensure_statusbar_patch.js` (`1,618` lines) with six focused CommonJS modules while preserving CLI & programmatic APIs (`scripts/ensure_statusbar_patch.js` `--worker` / `--status`, `scripts/install.js`):
- `installer/asar-codec.js`: Header parser stripping trailing 4-byte alignment NUL bytes (`D-0023`), SHA-256 block integrity calculator (`4 MiB`), exact-byte-preserving JS replacer (`transformExactSize` with lexical state preserving template/string internals `D-0023`, `D-0024`).
- `installer/file-lock.js`: PID-liveness-checked lock acquisition + stale lock atomic takeover verifying `relTmp` token ownership (`D-0023`) + atomic write-temp-rename helper.
- `installer/rfc6455-client.js`: Pure Node `net`/`http` RFC 6455 WebSocket client (`D-0030`) supporting Ping (`0x89`) echo, Close (`0x88`) flush before socket teardown, `FIN=0`/`0x00` fragmentation with interleaving rejection (§5.4), and `16 MiB` max payload guard.
- `installer/cdp-injector.js`: `DevToolsActivePort` parser, Electron 35+ Browser CDP WS fallback (`Target.getTargets` / `Target.attachToTarget`), `Runtime.evaluate` exception checking (`D-0016`), and parallel target injection (`D-0023`).
- `installer/host-patcher.js`: Exact-size anchor replacements (`dist/utils.js`, `dist/main.js`, `dist/preload.js`) excluding `scriptJail` and non-`http(s):` views (`D-0023`), plus locked `app_storage.json` sync.
- `installer/cli.js`: `--worker`, `--status`, and non-blocking TTY/stdin fast hook entrypoint (`D-0005`).
- `scripts/install.js`: Builds `dist/statusbar_autoinject.js`, preserves any pre-existing host companion blocks on `~/.gemini/antigravity/statusbar_autoinject.js` cleanly via column-0 anchored regex extraction (`D-0015`, guaranteeing zero disruption to installed host plugins), copies modular `installer/` alongside `scripts/ensure_statusbar_patch.js`, and runs `--worker` + `--status`.
- `scripts/build.js`: Recursively discovers or topologically validates nested `src/` modules, reads `@version` from `package.json` (`D-0010`), runs lexical comment/blank stripper (`D-0017`, `D-0024`), validates `dist/statusbar_autoinject.js` via `vm.Script`.

---

## 4. CS & Security Invariants

| ID | Invariant | Structural Guarantee |
| :--- | :--- | :--- |
| `INV-SEC-1` | Zero HTML sink / zero XSS | `ui/dom-builder.js` exclusively uses `createElement` + `textContent`/`createTextNode`; `innerHTML` & regex HTML parser do not exist (`D-0009`, `D-0025`). |
| `INV-SEC-2` | Zero global/framework TrustedTypes policy names | Zero `TrustedHTML` policy creation in statusbar (`D-0032`); any optional script loader uses strictly scoped `agy-statusbar-*` names only on allowlisted HTTPS origins. |
| `INV-SEC-3` | Host boundary anti-spoofing | `isRemoteHost` enforces `host === d \|\| host.endsWith('.' + d)` (`D-0031`). |
| `INV-CS-1` | Deterministic teardown & timer receiver binding | All timers bound via `.bind(win)` (`NB2`), registered in `DisposableScope`, and cancelled on `__agyStatusBarCleanup()` (`D-0006`, `D-0020`, `AUDIT-M6`). |
| `INV-CS-2` | Multi-plugin WeakMap prototype lease | `RC.prototype` hooks store chains in closure/WeakMap and honor `__agySuppressAutoIframeLoad*` (`D-0034`); statusbar never promotes iframes. |
| `INV-CS-3` | Fail-closed session state reconciliation | `isStateForCascade` rejects state missing `conversationId` or belonging to another session (`D-0033`). |
| `INV-CS-4` | Bounded memory & atomic storage locks | Session map `<= 200`, telemetry cache `<= 60`, cascade len map `<= 200`, WS frame `<= 16 MiB`, PID-verified atomic lock release (`D-0018`, `D-0023`, `D-0026`). |

---

## 5. Defect & Regression Traceability (`OPEN` & Baseline)

| Ledger / Audit ID | Root Cause in v1.4 | Eliminated in v2.0 By | Verified In |
| :--- | :--- | :--- | :--- |
| `D-0025` (`OPEN`) | Template HTML interpolation & missing attr/text escaping | `src/ui/dom-builder.js` (`textContent` only) & `style-manager.js` nonce | `test/unit/ui.test.js`, `test/e2e/remote-chrome.test.js` |
| `D-0032` (`OPEN`) | Global TrustedTypes policy fallback (`default`, `angular#unsafe-bypass`, etc.) | Removed `TrustedHTML` policy layer completely via `dom-builder.js` | `test/unit/ui.test.js`, `test/e2e/remote-chrome.test.js` |
| `D-0034` (`OPEN`) + `NB2`/`M6` | Shared `__agyOrig_onIframeLoad` clobber, loading flags, unbound/uncancelled retry timers | WeakMap prototype lease, zero iframe promotion interference, `DisposableScope` + `.bind(win)` timers | `test/integration/drivers.test.js`, `test/e2e/remote-chrome.test.js` |
| `D-0001..D-0033` (Baseline Verified) | Engine model rollback, protobuf frame corruption, cookie override loss, ASAR NUL/lock TOCTOU, RFC6455 bugs | Preserved 1:1 in `domain/`, `protobuf-wire-codec.js`, `react-fiber-driver.js`, and `installer/*` | `test/unit/*`, `test/integration/*`, `test/installer/*` |

---

## 6. Standalone CI & Modular Test Layout

- **CI (`.github/workflows/ci.yml`)**: Single-repo checkout on `[ubuntu-latest, windows-latest]` for `main`, `develop`, `feature/**`, `fix/**`, `bugfix/**`, `release/**`, `hotfix/**`, and `workflow_dispatch`. Zero sibling repository checkouts.
- **Test Suites (`npm test` -> `node scripts/build.js && node --test test/**/*.test.js`)**:
  - `test/unit/domain.test.js` — pure domain policies, metrics, i18n, protobuf wire codec
  - `test/unit/ui.test.js` — DOM builder XSS safety, zero `createPolicy`/`innerHTML`, adapter ordering, menu/modal cleanup
  - `test/integration/drivers.test.js` — Fiber/Redux model preservation, WeakMap RC prototype lease, session-switch anti-bleed, `DisposableScope` & `.bind(win)` timers
  - `test/installer/patcher.test.js` — ASAR exact-size transform, NUL headers, atomic lock recovery, RFC6455 Ping/Close/fragmentation, CDP exception checks
  - `test/e2e/remote-chrome.test.js` — Headless Chromium against verbatim live `antigravity.google.com/r/...-v2` CSP (`require-trusted-types-for 'script'`, strict `trusted-types`), coexisting hook lease without promotion conflicts, and live unauthenticated `https://antigravity.google.com/r/00000000-0000-0000-0000-000000000000-v2` bookmarklet smoke verification (explicitly scoping authenticated shell vs unauthenticated login shell).

---

## 아키텍처 설계 명세 v2.0 (국문 요약)

`antigravity-statusbar` `v2.0.0`은 5차례 감사에서 드러난 타 플러그인 강결합(`D-0034`, `SB-TC-037`), HTML 문자열 조립·정규식 파서 의존(`D-0025`, `D-0032`), `window.__agy*` 전역 오염(`D-0020`), 비대한 단일 파일(`ensure_statusbar_patch.js` 1,618줄, `statusbar.test.js` 6,283줄)을 해소하기 위한 전면 육각형(Hexagonal / Ports & Adapters) 재설계입니다.

1. **도메인·포트 완전 분리(`src/domain/`, `src/ports/`)**: DOM 및 Antigravity 벤더 상수 의존이 0%인 순수 정책·계산·i18n(`en` 기본 + `ko` 전환) 모듈로 분리합니다.
2. **Zero-HTML DOM 빌더 UI(`src/ui/dom-builder.js`)**: `innerHTML`·정규식 HTML 파서·TrustedHTML 정책 등록을 완전히 제거하고 `createElement` + `textContent`/`createTextNode`만으로 렌더링해 XSS 및 `D-0025`/`D-0032`를 구조적으로 소멸시킵니다.
3. **벤더 어댑터 격리 및 Iframe 승격 비간섭(`src/drivers/antigravity/`)**: `RemoteControlComponent.prototype`은 `WeakMap` 참조 카운트 리스 체인으로 연결하고, 교차 출처 iframe 승격에는 간섭하지 않아 타 플러그인과의 경합을 원천 차단합니다.
4. **결정적 수명주기 및 설치기 6분할(`src/app/disposable.js`, `installer/*`)**: 모든 타이머(`.bind(win)`), 리스너, 옵저버를 `DisposableScope`로 소유·해제하며, 1,618줄 패처를 6개 단일 책임 모듈(`asar-codec`, `file-lock`, `rfc6455-client`, `cdp-injector`, `host-patcher`, `cli`)로 분할합니다.
5. **독립 CI 및 테스트 분리**: CI에서 형제 저장소 체크아웃을 제거해 단일 저장소만으로 `ubuntu-latest`·`windows-latest` 검증이 가능하도록 재구성합니다.
