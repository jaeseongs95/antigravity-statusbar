# Release Notes — `v3.2.0` (2026-11-25)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.2.0` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.2.0` upgrades the plugin to **`trustLevel: "trusted"`** and adds full **Remote Web (`antigravity-remote-web`) support** aligned with [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons) `v2.5.3+`. Instead of rewriting `runtime/statusbar-renderer.js` on every Sidecar launch, the installer now generates a 100% static, immutable, credential-free renderer bundle (preventing `ERR_RENDERER_SHA256_MISMATCH`), Desktop Sidecar credentials flow exclusively through host `settingsBridge`, and Remote Web users configure their loopback HTTP or HTTPS Sidecar connection locally in the browser via `addonHost.saveSettings(...)`.

### 2. Key Changes
- **`AddonManifest.v2` Trusted + Remote Web Support (`addon-manifest.v2.json`, `package.json`, `plugin.json`)**:
  - Promotes `trustLevel` from `"restricted"` to `"trusted"` and declares `settingsBridge: { fileName: "antigravity-statusbar-runtime.json", maxBytes: 16384 }`.
  - Updates `compatibility.hostProfiles` to `["antigravity-desktop", "antigravity-remote-web"]`, removes `excludeHostProfiles`, and adds `anchor: "status-bar"` to `antigravity-statusbar.root`.
- **Immutable Static Renderer & `settingsBridge` Runtime Delivery (`scripts/install-plugin.mjs`, `src/adapters/antigravity/addon/bundle-builder.mjs`, `src/adapters/antigravity/addon/runtime-publisher.mjs`, `src/adapters/antigravity/sidecar-entry.mjs`)**:
  - `scripts/install-plugin.mjs` writes a deterministic, credential-free `renderAddonRendererBundle()` to `runtime/statusbar-renderer.js` on both `atomic-rename` and `in-place-fallback` installs.
  - Introduces `createSettingsBridgePublisher` (`RendererPublisherPort` LSP) and `resolveConfinedSettingsBridgeTarget` (enforcing `HOST_DATA_DIR` confinement, rejecting reserved host files and symlinks, atomic `0o600` publish, and `teardown()`/`teardownSync()` standby scrubbing).
  - `startSidecar` publishes exclusively to `ANTIGRAVITY_ADDON_HOST_DATA_DIR/antigravity-statusbar-runtime.json` (`~/.gemini/antigravity/antigravity-statusbar-runtime.json` by default) so `runtime/statusbar-renderer.js` SHA-256 remains 100% unchanged across Sidecar restarts and shutdowns.
  - Adds `resolvePreferredSidecarPort(env)` supporting optional fixed loopback port (`STATUSBAR_SIDECAR_PORT` / `ANTIGRAVITY_SIDECAR_WEB_PORT` / `ANTIGRAVITY_SIDECAR_PORT`, `[1024, 65535]`) with automatic `EADDRINUSE` fallback to ephemeral port `0`.
- **Remote Web (`antigravity-remote-web`) Runtime, Anchor Fallback & Connection UI (`src/adapters/antigravity/addon/ports.mjs`, `addon-host-adapter.mjs`, `api-client.mjs`, `bootstrap.mjs`, `bar-controller.mjs`, `bar-view.mjs`, `popover-view.mjs`, `i18n.mjs`, `styles.mjs`)**:
  - Extends `RendererHostPort` and `createAddonHostAdapter` to forward `getSettings`, `onSettingsChange`, and `saveSettings`, and supports `mountSlot(null)` (`{}` on v2 hosts) for host `anchor: "status-bar"` / `#remote-addon-host-slot-dock` fallback when `[data-testid="agent-input-box"]` is absent (styled via owner-CSS `.agy-remote-dock`).
  - Extends `createSidecarApiClient` with unconfigured startup mode (`isConfigured()`, `configure()`, `clearConnection()`), `allowRemoteHttps: true` validation (loopback HTTP always; `https://` without embedded credentials/query/hash on Remote Web), and 401/403 disconnect handling.
  - Replaces the v3.1.4 Remote Web fail-closed block in `bootstrap.mjs` with dual-profile support: Desktop consumes live `settingsBridge` updates (standby → active → port/token rotation → standby), while Remote Web ignores `persistence === "packed-initial"` snapshots, boots with zero fetches when unconfigured, and persists user-entered URL + token strictly in browser `localStorage` via `addonHost.saveSettings(...)`.
  - Adds a localized (EN/KO) **Remote Sidecar Connection** card inside the Settings tab on Remote Web (hidden on Desktop) with URL input, password token input, Connect/Disconnect buttons, and status/error feedback.
- **Subagent & Side-Question Session Pinning Fix (`src/adapters/antigravity/addon/bootstrap.mjs`, `src/adapters/antigravity/addon/bar-controller.mjs`)**:
  - Fixes a defect where viewing a subagent (`[data-testid="subagent-tab-conversation"]`) or side-question (`[data-testid="side-question-tab-conversation"]`) tab caused the statusbar metrics to jump erratically ("stock-chart fluctuation") across parallel agents every second: `bootstrap.mjs` previously matched only `[data-testid="conversation-view"]`, falling back to `agent-input-box` (no `data-cascade-id`), which caused `bar-controller.mjs` to fall back to `sharedState.fallbackSessionId` as it was continuously overwritten by the globally most-recently-updated trajectory in `/api/sessions`.
  - Resolves the nearest `data-cascade-id` ancestor/conversation container across `conversation-view`, `subagent-tab-conversation`, and `side-question-tab-conversation` (supporting nested subagents where the innermost ID wins, single-pane sibling layouts, and multi-pane `pointerdown`/`focusin` switching).
  - Hardens `bar-controller.mjs` to fail closed inside unattributed subagent/side-question views (clearing stale snapshots instead of falling back to another session), rejects mismatched `snap.sessionId` responses, and updates `fallbackSessionId` selection (used in Remote Web dock / unattributed views) to prefer the latest non-subagent session without interrupting explicitly pinned views.
- **Security & Deployment Notes**:
  - **NEVER** pass `--include-settings-snapshots` to `addon-host --build-remote`; doing so would inline Desktop runtime tokens into `antigravity-remote.user.js`/`bookmarklet.txt`.
  - Recommended deployment order: `npm run install-plugin` → `node bin/addon-host.js --register <manifest>` → `node bin/addon-host.js trust approve antigravity-statusbar` → `node bin/addon-host.js --build-remote --out-dir <remote-dist>`.
  - Note: Direct `fetch` from `https://antigravity.google.com` to loopback/HTTPS Sidecar endpoints depends on live site `connect-src` CSP and browser PNA policy and should be verified on the live site after deployment.

### 3. Verification
- Verified on 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20) across `test:static`, `test:unit` (including `TC-UNIT-06b` subagent/side-question pinning & fail-closed isolation), `test:integration` (including `TC-ADDON-10a` Desktop `settingsBridge` live rotation, `TC-ADDON-10b` Remote Web E2E + `packed-initial` rejection + `status-bar` dock fallback, `TC-ADDON-11` configurable port + `EADDRINUSE` fallback, `TC-ADDON-12` bundled subagent session pinning, and byte-for-byte SHA-256 immutability of installed `runtime/statusbar-renderer.js`), `test:security`, `test:ui` (real Headless Chromium/Edge Shadow DOM E2E), and `install-plugin.mjs --dry-run`.

---

## [한국어] `v3.2.0` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.2.0`은 [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons) `v2.5.3+` 규격에 맞춰 플러그인을 **`trustLevel: "trusted"`(신뢰 승인)**로 승격하고 **원격 웹(`antigravity-remote-web`) 정식 지원**을 추가한 마이너 릴리즈입니다. Sidecar가 기동할 때마다 `runtime/statusbar-renderer.js`를 덮어쓰던 기존 방식을 폐지하고 설치 시 100% 정적·불변·무자격증명 렌더러 번들을 고정 생성하여 `ERR_RENDERER_SHA256_MISMATCH`를 원천 차단했습니다. 데스크톱은 호스트 `settingsBridge`로 실시간 연결 정보를 전달받으며, 원격 웹은 설정 탭의 연결 UI에서 브라우저 로컬 저장소(`addonHost.saveSettings`)로 루프백 HTTP 또는 HTTPS Sidecar에 연결합니다.

### 2. 주요 변경 사항
- **`AddonManifest.v2` 신뢰 승인 및 원격 웹 선언 (`addon-manifest.v2.json`, `package.json`, `plugin.json`)**:
  - `trustLevel`을 `"restricted"`에서 `"trusted"`로 승격하고 `settingsBridge: { fileName: "antigravity-statusbar-runtime.json", maxBytes: 16384 }`를 선언했습니다.
  - `compatibility.hostProfiles`를 `["antigravity-desktop", "antigravity-remote-web"]`로 확장하고 `excludeHostProfiles`를 제거했으며, `antigravity-statusbar.root` 슬롯에 `anchor: "status-bar"`를 추가했습니다.
- **불변 정적 렌더러 및 `settingsBridge` 런타임 전달 (`scripts/install-plugin.mjs`, `src/adapters/antigravity/addon/bundle-builder.mjs`, `src/adapters/antigravity/addon/runtime-publisher.mjs`, `src/adapters/antigravity/sidecar-entry.mjs`)**:
  - `scripts/install-plugin.mjs`가 `atomic-rename`과 `in-place-fallback` 모든 경로에서 결정론적·무자격증명 `renderAddonRendererBundle()`를 `runtime/statusbar-renderer.js`에 기록합니다.
  - `createSettingsBridgePublisher`(`RendererPublisherPort` LSP)와 `resolveConfinedSettingsBridgeTarget`을 도입해 `HOST_DATA_DIR` 경로 격리, 호스트 예약 파일·심볼릭 링크 차단, `0o600` 원자적 쓰기, `teardown()`/`teardownSync()` 시 `mode: "standby"` 회수를 보장합니다.
  - `startSidecar`는 `ANTIGRAVITY_ADDON_HOST_DATA_DIR/antigravity-statusbar-runtime.json`(기본 `~/.gemini/antigravity/antigravity-statusbar-runtime.json`)에만 기록하므로 Sidecar 기동·종료 전반에 걸쳐 `runtime/statusbar-renderer.js`의 SHA-256 해시가 단 1바이트도 변하지 않습니다.
  - 선택적 고정 루프백 포트(`STATUSBAR_SIDECAR_PORT` / `ANTIGRAVITY_SIDECAR_WEB_PORT` / `ANTIGRAVITY_SIDECAR_PORT`, `[1024, 65535]`)를 해석하는 `resolvePreferredSidecarPort(env)`와 포트 충돌(`EADDRINUSE`) 시 임시 포트(`0`) 자동 폴백을 추가했습니다.
- **원격 웹(`antigravity-remote-web`) 런타임·앵커 폴백·연결 UI (`src/adapters/antigravity/addon/ports.mjs`, `addon-host-adapter.mjs`, `api-client.mjs`, `bootstrap.mjs`, `bar-controller.mjs`, `bar-view.mjs`, `popover-view.mjs`, `i18n.mjs`, `styles.mjs`)**:
  - `RendererHostPort`와 `createAddonHostAdapter`가 `getSettings`/`onSettingsChange`/`saveSettings`를 전달하고, 원격 웹 DOM에 `[data-testid="agent-input-box"]`가 없을 때 `mountSlot(null)`(v2 `{}`)로 호스트 `anchor: "status-bar"` / `#remote-addon-host-slot-dock`에 폴백 마운트(`.agy-remote-dock` 스타일)합니다.
  - `createSidecarApiClient`에 미설정 기동 모드(`isConfigured()`, `configure()`, `clearConnection()`), `allowRemoteHttps: true` 검증(루프백 HTTP 상시 허용, 원격 웹에서 자격증명·쿼리·해시 없는 `https://` 허용), 401/403 연결 해제 처리를 추가했습니다.
  - `bootstrap.mjs`의 v3.1.4 원격 웹 일괄 차단 가드를 이중 프로필 지원으로 대체했습니다. 데스크톱은 `settingsBridge` 실시간 상태(standby → active → 포트/토큰 로테이션 → standby)를 소비하고, 원격 웹은 `persistence === "packed-initial"` 스냅샷을 심층 방어로 무시하며 미설정 시 네트워크 요청 0건으로 기동합니다.
  - 원격 웹 설정 탭에 한/영 로컬라이징된 **원격 Sidecar 연결** 카드(URL 입력, 비밀번호 토큰 입력, 연결/연결 해제 버튼, 상태·오류 피드백)를 추가했습니다(데스크톱에서는 숨김).
- **서브에이전트·사이드 질문 세션 고정 결함 수정 (`src/adapters/antigravity/addon/bootstrap.mjs`, `src/adapters/antigravity/addon/bar-controller.mjs`)**:
  - 서브에이전트 탭(`[data-testid="subagent-tab-conversation"]`)이나 사이드 질문 탭(`[data-testid="side-question-tab-conversation"]`)에서 상태바 컨텍스트 수치가 병렬 에이전트 활동에 따라 매 초 다른 대화 수치로 오르내리던(주식그래프 현상) 결함을 근본 수정했습니다. 기존 `bootstrap.mjs`가 `[data-testid="conversation-view"]`만 탐색해 `data-cascade-id`가 없는 `agent-input-box`로 폴백했고, `bar-controller.mjs`가 `/api/sessions`의 전역 최신 세션(`fallbackSessionId`)을 그대로 따라가며 발생하던 문제입니다.
  - `conversation-view`, `subagent-tab-conversation`, `side-question-tab-conversation` 전반에서 가장 가까운 `data-cascade-id` 조상/컨테이너를 해석하도록 개선했습니다(중첩 서브에이전트 내부 우선, 단일 패널 형제 레이아웃 지원, 멀티 패널 `pointerdown`/`focusin` 전환 포함).
  - `data-cascade-id`가 아직 없는 서브에이전트·사이드 질문 뷰에서는 전역 폴백 세션으로 빠지지 않고 Fail-Closed(이전 스냅샷 초기화) 처리하며, 응답 `snap.sessionId` 불일치를 차단하고, 폴백 모드(원격 웹 독 등)에서는 비서브에이전트(`!isSubagent`) 세션을 우선 선택하도록 보강했습니다.
- **보안 및 배포 유의 사항**:
  - `addon-host --build-remote` 실행 시 `--include-settings-snapshots` 플래그를 **절대** 함께 사용하지 마십시오(데스크톱 런타임 토큰이 원격 웹 산출물에 평문 삽입될 수 있습니다).
  - 권장 배포 순서: `npm run install-plugin` → `node bin/addon-host.js --register <manifest>` → `node bin/addon-host.js trust approve antigravity-statusbar` → `node bin/addon-host.js --build-remote --out-dir <remote-dist>`.
  - 참고: `https://antigravity.google.com` 실사이트에서의 루프백/HTTPS `fetch` 허용 여부는 사이트 `connect-src` CSP와 브라우저 PNA 정책에 따라 달라지므로 배포 후 실브라우저 검증이 필요합니다.

### 3. 검증 근거
- 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20): `test:static`, `test:unit`(`TC-UNIT-06b` 서브에이전트·사이드 질문 세션 고정 및 Fail-Closed 격리 포함), `test:integration`(`TC-ADDON-10a` 데스크톱 `settingsBridge` 실시간 전환, `TC-ADDON-10b` 원격 웹 E2E·`packed-initial` 차단·`status-bar` 독 폴백, `TC-ADDON-11` 고정 포트·`EADDRINUSE` 폴백, `TC-ADDON-12` 번들 렌더러 서브에이전트 고정, 설치된 `runtime/statusbar-renderer.js` SHA-256 불변성 포함), `test:security`, `test:ui`(실제 Headless Chromium/Edge Shadow DOM E2E), `install-plugin.mjs --dry-run` 전 항목 검증 완료.

---

# Release Notes — `v3.1.5` (2026-11-24)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.1.5` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.1.5` eliminates leftover `.antigravity-statusbar.staging.*` and `plugin_data/.antigravity-statusbar.staging.*` directory pollution caused by creating installer staging directories inside the host-watched `~/.gemini/config/plugins/` directory on Windows, adds cross-filesystem `EXDEV` handling and retryable cleanup, and updates host project documentation references to [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons) (formerly `antigravity-native-addon-host`).

### 2. Defect Fixes & Changes
- **Installer Staging & Backup Isolation Outside `plugins/` (`scripts/install-plugin.mjs`)**:
  - Previously, `installPlugin` created `.antigravity-statusbar.staging.<pid>.<ts>` and `.antigravity-statusbar.old.<pid>.<ts>` directly inside `parentDir` (`~/.gemini/config/plugins/`). While the Antigravity host was running on Windows, its plugin watcher discovered the temporary staging folder, created `plugin_data/.antigravity-statusbar.staging.*`, and opened handles under `staging/sidecars/`, causing the subsequent `fs.rm` cleanup in `in-place-fallback` mode to fail silently and leave stranded staging folders behind.
  - Introduces `resolveInstallWorkParent()` to place a single temporary `workRoot` (`staging/` and `backup/`) outside `parentDir`: prefers `os.tmpdir()` when on the same filesystem for atomic `fs.rename`, falls back to a writable same-filesystem `path.dirname(parentDir)` (e.g., `~/.gemini/config`) on cross-filesystem `/tmp` (such as Linux `tmpfs`), and handles `EXDEV` alongside `EPERM`/`EBUSY`/`EACCES` via safe `in-place-fallback`.
  - Cleans up `workRoot` deterministically in `finally` with `{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }` while preserving `backupDir` intact if a catastrophic swap + restore double-failure occurs.
- **Regression Tests (`test/unit/p0-hardening-tdd.test.mjs`, `test/integration/antigravity-adapter.test.mjs`)**:
  - Adds `TC-P0-06b` covering `resolveInstallWorkParent` (same-fs `tmpDir`, cross-fs writable/unwritable grandparent), simulated `EBUSY` and `EXDEV` fallbacks verifying zero staging/backup directories ever appear inside `plugins/`, complete `workRoot` cleanup, `data/settings.json` preservation, and backup preservation on catastrophic restore failure.
  - Extends `test/integration/antigravity-adapter.test.mjs` to assert zero leftover staging/backup entries in `parentDir` after install.
- **Host Project Rename Alignment (`README.md`, `README.ko.md`, `docs/ARCHITECTURE_V3.md`, `docs/TEST_CASES.md`, `src/adapters/antigravity/addon/bundle-builder.mjs`, `test/integration/addon-runtime.test.mjs`)**:
  - Updates documentation and comment references from `antigravity-native-addon-host` to [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons) (compatible with `v2.3.0`–`v2.5.1+`) while preserving backward-compatible `addon-host` CLI commands and `AddonManifest.v2` schema URI.

### 3. Verification
- Verified on 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20) across `test:static`, `test:unit` (including `TC-P0-06b`), `test:integration`, `test:security`, `test:ui`, and `install-plugin.mjs --dry-run`.

---

## [한국어] `v3.1.5` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.1.5`는 Windows에서 `npm run install-plugin` 실행 시 호스트가 감시하는 `~/.gemini/config/plugins/` 내부에 임시 스테이징 폴더를 생성해 `.antigravity-statusbar.staging.*` 잔여 폴더와 `plugin_data/.antigravity-statusbar.staging.*` 폴더가 누적되던 결함을 근본 수정하고, 크로스 파일시스템(`EXDEV`) 폴백과 재시도 정리를 보강했으며, 호스트 프로젝트 명칭 변경([`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons), 구 `antigravity-native-addon-host`)에 맞춰 문서를 갱신한 패치 릴리즈입니다.

### 2. 주요 결함 수정 및 변경 사항
- **설치 스테이징·백업 디렉터리 `plugins/` 외부 격리 (`scripts/install-plugin.mjs`)**:
  - 기존 구현은 `parentDir`(`~/.gemini/config/plugins/`) 바로 아래에 `.antigravity-statusbar.staging.<pid>.<ts>` 및 `.antigravity-statusbar.old.<pid>.<ts>`를 생성했습니다. Windows에서 Antigravity 호스트가 실행 중인 상태로 설치하면 호스트의 플러그인 감시기가 임시 스테이징 폴더를 플러그인으로 인식해 `plugin_data/.antigravity-statusbar.staging.*`를 생성하고 `staging/sidecars/` 핸들을 점유함으로써 `in-place-fallback` 종료 시 `fs.rm` 정리가 무음 실패하며 잔여 폴더가 남는 결함이 발생했습니다.
  - `resolveInstallWorkParent()`를 도입해 단일 임시 작업 루트(`workRoot` 하위 `staging/`·`backup/`)를 항상 `parentDir`(`plugins/`) 외부에 생성하도록 변경했습니다. 동일 파일시스템이면 `os.tmpdir()`를 우선 사용해 원자적 `fs.rename`을 유지하고, Linux `tmpfs` 등 `/tmp`가 다른 파일시스템인 경우 쓰기 가능한 동일 파일시스템 상위 디렉터리(`~/.gemini/config` 등)를 선택하며, 불가 시 `EXDEV`도 `EPERM`/`EBUSY`/`EACCES`와 함께 안전한 `in-place-fallback`으로 처리합니다.
  - `finally` 블록에서 `{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }`으로 임시 작업 루트를 일관 정리하며, 교체·복구가 모두 실패한 치명적 오류 시에는 사용자 `data/` 보존을 위해 `backupDir`을 삭제하지 않고 유지합니다.
- **회귀 테스트 추가 (`test/unit/p0-hardening-tdd.test.mjs`, `test/integration/antigravity-adapter.test.mjs`)**:
  - `TC-P0-06b`를 신설해 `resolveInstallWorkParent`(동일 파일시스템 `tmpDir`, 크로스 파일시스템 상위 폴더 쓰기 가능/불가) 및 시뮬레이션 `EBUSY`/`EXDEV` 폴백 중·후 `plugins/` 내부에 스테이징·백업 폴더가 단 한 번도 생성되지 않음, `workRoot` 완전 정리, `data/settings.json` 보존, 복구 실패 시 `backupDir` 보존을 검증합니다.
  - `test/integration/antigravity-adapter.test.mjs` 설치 통합 테스트에 설치 후 `parentDir` 잔여 항목 0건 검증을 추가했습니다.
- **호스트 프로젝트 개명 반영 (`README.md`, `README.ko.md`, `docs/ARCHITECTURE_V3.md`, `docs/TEST_CASES.md`, `src/adapters/antigravity/addon/bundle-builder.mjs`, `test/integration/addon-runtime.test.mjs`)**:
  - 문서 및 주석의 호스트 프로젝트 참조를 [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons)(구 `antigravity-native-addon-host`, `v2.3.0`~`v2.5.1+` 호환)로 갱신했습니다. 하위 호환되는 `addon-host` CLI 명령과 `AddonManifest.v2` 스키마 URI는 그대로 유지합니다.

### 3. 검증 근거
- 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20): `test:static`, `test:unit`(`TC-P0-06b` 포함), `test:integration`, `test:security`, `test:ui`, `install-plugin.mjs --dry-run` 전 항목 검증 완료.

---

# Release Notes — `v3.1.4` (2026-11-24)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.1.4` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.1.4` aligns the plugin with `antigravity-native-addon-host` **`v2.3.0`** by declaring explicit Desktop-only host profile isolation (preventing Remote Web auto-inclusion from baking ephemeral Sidecar loopback tokens into Remote Web UserScript/bookmarklet artifacts), adding a fail-closed `addonHost.hostProfileId` runtime guard, refining the auto-resume continuation prompt so it does not assume external summary-context artifacts, and updating test coverage to mirror `v2.2.0`/`v2.3.0` host kernel contracts.

### 2. Changes
- **Auto-Resume Prompt Tool-Neutrality Fix (`src/core/model/context-policy.mjs`, `test/unit/p0-hardening-tdd.test.mjs`)**:
  - Removes the assumption of an external summary-context artifact (`"요약 컨텍스트"` / `"the compaction summary"`) from `buildAutoResumePrompt` (`ko` and `en`), instructing the agent instead to check the current conversation and actual workspace state before continuing from where it left off (or briefly confirming completion if already finished).
  - Adds unit regression `TC-P0-00f` verifying both `ko` and `en` prompts.
- **Desktop-Only `AddonManifest.v2` Isolation (`addon-manifest.v2.json`)**:
  - Adds `"hostProfiles": ["antigravity-desktop"]` and `"excludeHostProfiles": ["antigravity-remote-web"]` and raises `"minHostVersion"` from `"2.0.0"` to `"2.3.0"` (the first host release whose strict `addon-manifest.v2.schema.json` accepts `hostProfiles` / `excludeHostProfiles`).
  - Prevents `antigravity-native-addon-host --build-remote` (whose `antigravity-remote-web` profile inherits `compatibleHostProfiles: ["antigravity-desktop"]`) from auto-packing `runtime/statusbar-renderer.js` with live per-process loopback URL + 256-bit Sidecar bearer tokens or permanently embedding the standby stub.
  - Intentionally retains `trustLevel: "restricted"` without enabling `settingsBridge` or `configBridge`: the headless Sidecar regenerates `runtime/statusbar-renderer.js` with a fresh ephemeral token on every launch (making static `trusted` SHA-256 pinning incompatible) and already manages `data/settings.json` atomically via `proper-lockfile` + `write-file-atomic`.
- **Defense-in-Depth Runtime Guard (`src/adapters/antigravity/addon/addon-host-adapter.mjs`, `src/adapters/antigravity/addon/bootstrap.mjs`, `src/adapters/antigravity/addon/bundle-builder.mjs`)**:
  - Forwards `addonHost.hostProfileId` (trimmed string or `null`) through `createAddonHostAdapter`.
  - Fails closed at the entry of both `startAddonStatusbar` and `startStandbyStatusbar` whenever `hostPort.hostProfileId === 'antigravity-remote-web'`, returning frozen no-op handles with zero slot mounts, zero style injections, zero `window.statusbarAddons` exposure, zero timers/observers/listeners, and zero loopback `fetch` calls.
- **Host `v2.2.0`/`v2.3.0` Test Parity & Documentation (`test/static/boundary.test.mjs`, `test/unit/addon-manifest.test.mjs`, `test/integration/addon-runtime.test.mjs`, `test/integration/antigravity-adapter.test.mjs`, `README.md`, `README.ko.md`, `docs/ARCHITECTURE_V3.md`, `docs/TEST_CASES.md`)**:
  - Updates `TC-ADDON-01` and `TC-ADDON-03` for `v2.3.0` schema fields (`hostProfiles`, `excludeHostProfiles`, `settingsBridge`/`configBridge` awareness) and `hostProfileId` forwarding.
  - Updates `TC-ADDON-09` to mirror `v2.2.0+` centered `<dialog>` defaults and the `I10` dispose invariant (running `onDispose` callbacks before marking the handle disposed so `unmountSlot`/`removeStyle` succeed without `ERR_PLUGIN_HANDLE_DISPOSED`).
  - Adds `TC-ADDON-10` verifying fail-closed Remote Web behavior for both active and standby bundles plus static bundle hygiene.
  - Documents the `addon-host --register` manifest refresh step in `README.md` and `README.ko.md`.

### 3. Verification
- Verified on 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20) across `test:static`, `test:unit`, `test:integration` (including `TC-ADDON-09` & `TC-ADDON-10`), `test:security`, `test:ui`, and `install-plugin.mjs --dry-run`.

---

## [한국어] `v3.1.4` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.1.4`는 `antigravity-native-addon-host` **`v2.3.0`** 릴리즈에 맞춰 데스크톱 전용 호스트 프로필 격리(Remote Web 자동 포함으로 인한 Sidecar 임시 토큰 유출·고장 차단)를 매니페스트와 런타임 양쪽에 적용하고, 자동 재개 프롬프트에서 외부 요약 컨텍스트 전제를 제거했으며, `v2.2.0`/`v2.3.0` 호스트 커널 계약에 맞춰 테스트와 문서를 정합화한 호환성 패치 릴리즈입니다.

### 2. 주요 변경 사항
- **자동 재개 프롬프트 외부 요약 컨텍스트 전제 제거 (`src/core/model/context-policy.mjs`, `test/unit/p0-hardening-tdd.test.mjs`)**:
  - `buildAutoResumePrompt`(`ko`/`en`)에서 외부 도구·요약 산출물 존재를 전제하는 `"요약 컨텍스트를 참고해"` / `"using the compaction summary"` 표현을 제거하고, 어떤 환경에서도 유효하도록 **현재 대화 내용과 실제 작업 상태를 확인해** 중단된 지점부터 이어가도록 수정했습니다(완료 상태 시 짧은 완료 확인 조건 유지).
  - 한·영 프롬프트 회귀 테스트 `TC-P0-00f`를 추가했습니다.
- **데스크톱 전용 `AddonManifest.v2` 격리 (`addon-manifest.v2.json`)**:
  - `compatibility`에 `"hostProfiles": ["antigravity-desktop"]`과 `"excludeHostProfiles": ["antigravity-remote-web"]`을 명시하고, 해당 필드를 허용하는 최소 호스트 버전인 `"minHostVersion": "2.3.0"`으로 상향했습니다.
  - `antigravity-native-addon-host v2.3.0`의 `antigravity-remote-web` 프로필이 `compatibleHostProfiles: ["antigravity-desktop"]`을 상속함에 따라 `addon-host --build-remote` 실행 시 `runtime/statusbar-renderer.js`가 자동 포함되는 문제를 차단했습니다(데스크톱 실행 중 빌드 시 프로세스별 임시 256-bit Sidecar 토큰·루프백 포트가 Remote Web 산출물에 고정되거나, 종료 상태 빌드 시 대기 스텁이 영구 박제되는 현상 방지).
  - `trustLevel: "restricted"`를 의도적으로 유지하고 `settingsBridge`/`configBridge`를 활성화하지 않습니다. 상태바 Sidecar는 매 기동마다 새 임시 토큰으로 `runtime/statusbar-renderer.js`를 재생성하므로 정적 SHA-256 핀이 필요한 `trusted` 승격과 맞지 않으며, 설정 저장은 이미 Sidecar가 `proper-lockfile` + `write-file-atomic`으로 원자적 처리하고 있습니다.
- **심층 방어 Fail-Closed 런타임 가드 (`src/adapters/antigravity/addon/addon-host-adapter.mjs`, `src/adapters/antigravity/addon/bootstrap.mjs`, `src/adapters/antigravity/addon/bundle-builder.mjs`)**:
  - `createAddonHostAdapter`가 호스트의 `addonHost.hostProfileId`를 정규화하여 `RendererHostPort`로 전달하도록 확장했습니다.
  - `startAddonStatusbar`와 `startStandbyStatusbar` 모두 `hostPort.hostProfileId === 'antigravity-remote-web'`이면 즉시 Fail-Closed no-op 핸들을 반환하여 슬롯 마운트, 스타일 주입, `window.statusbarAddons` 노출, 타이머/옵저버/리스너 등록, 루프백 `fetch`를 일절 수행하지 않습니다.
- **호스트 `v2.2.0`/`v2.3.0` 계약 테스트 및 문서 정합화 (`test/static/boundary.test.mjs`, `test/unit/addon-manifest.test.mjs`, `test/integration/addon-runtime.test.mjs`, `test/integration/antigravity-adapter.test.mjs`, `README.md`, `README.ko.md`, `docs/ARCHITECTURE_V3.md`, `docs/TEST_CASES.md`)**:
  - `TC-ADDON-01`, `TC-ADDON-03`에 `v2.3.0` 스키마 필드(`hostProfiles`, `excludeHostProfiles`, `settingsBridge`/`configBridge` 스키마 인지 및 미사용 확인)와 `hostProfileId` 전달 검증을 추가했습니다.
  - `TC-ADDON-09`를 `v2.2.0+` 중앙 정렬 `<dialog>` 기본 스타일과 `I10` dispose 순서(`onDispose` 콜백이 핸들 disposed 전환 전에 실행되어 `unmountSlot`/`removeStyle`이 정상 완료됨) 기준으로 갱신했습니다.
  - 활성 번들과 스탠바이 스텁 양쪽의 Remote Web Fail-Closed 가드 및 정적 번들 위생 검사를 수행하는 `TC-ADDON-10`을 신설했습니다.
  - `README.md`와 `README.ko.md`에 `addon-host --register`를 통한 `addons.d` 매니페스트 갱신 절차를 문서화했습니다.

### 3. 검증 근거
- 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20): `test:static`, `test:unit`, `test:integration`(`TC-ADDON-09`·`TC-ADDON-10` 포함), `test:security`, `test:ui`, `install-plugin.mjs --dry-run` 전 항목 검증 완료.

---

# Release Notes — `v3.1.3` (2026-11-24)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.1.3` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.1.3` eliminates five concrete root causes of duplicate `/compact` execution triggered when lowering the global context limit (`defaultCustomLimit`) on sessions that immediately exceed 100% of the new limit.

### 2. Defect Fixes & Changes
- **Fix #1 — Remove `reducedMeaningfully` Cooldown Bypass (`src/core/app/statusbar-service.mjs`)**: Previously, when post-compaction tokens dropped by `>= 15%` (`>= 10K`) yet still remained `>= effectiveLimit` (common when lowering the global limit on large sessions), `if (droppedBelowLimit || reducedMeaningfully)` cleared `waitingForDrop` and zeroed `cooldownUntil = 0`, immediately firing a 2nd `/compact`. The bypass is removed so `waitingForDrop` and cooldown clear only when `droppedBelowLimit === true`; otherwise the 90-second cooldown and token-growth guard stay active from the refreshed post-compaction token baseline.
- **Fix #2 — Ambiguous Timeout Idempotency Guard (`src/adapters/antigravity/compaction-adapter.mjs`, `src/core/app/statusbar-service.mjs`)**: Raises `/compact` `SendUserCascadeMessage` RPC timeout to `20_000ms` and stops blind fallback (`agentapi` in `compactSession`, RPC in `sendCommand`) on ambiguous timeouts (`httpStatus === 504`, `AbortError`, timeout message), returning `{ accepted: false, ambiguous: true }`. In `statusbar-service`, ambiguous `504` timeouts preserve `waitingForDrop`, 90-second cooldown, and `pendingAutoResume` instead of triggering an immediate retry on `IDLE`.
- **Fix #3 — Preserve In-Flight Cooldowns in `updateSettings` (`src/core/app/statusbar-service.mjs`)**: Compares incoming patches against prior settings before clearing `autoCompactState` (ignoring no-op same-value saves) and never clears entries for sessions currently in `compactingSessions`.
- **Fix #4 — Arm Cooldown & Tail Probe on Manual `/compact` (`src/core/app/statusbar-service.mjs`)**: Arms `autoCompactState` (90-second cooldown + `waitingForDrop`) when a manual `/compact` is accepted and keeps `includeTailSteps: true` active while awaiting post-compaction settlement within cooldown.
- **Fix #5 — Per-Session Concurrent Snapshot Epoch Guard (`src/core/app/statusbar-service.mjs`)**: Adds a bounded LRU per-session `snapshotSeq` / `latestCompletedSnapshotSeq` guard so out-of-order slower `getSessionSnapshot` polls cannot overwrite state or fire duplicate `/compact` even when `stepCount` and `lastCompactedStep` are `null`.
- **Tests (`test/unit/p0-hardening-tdd.test.mjs`, `test/unit/autocompact-tdd.test.mjs`)**: Adds TDD regressions `TC-P0-13a`–`TC-P0-13e` covering all five root causes and updates legacy oracle `TC-TDD-AC-03` to enforce cooldown + growth guard while still verifying stale pre-compaction baseline refresh.

### 3. Verification
- Verified TDD RED (61 pass / 5 fail on `TC-P0-13a`–`TC-P0-13e`) → TDD GREEN on 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20): `test:static` (7/7), `test:unit` (66/66), `test:integration` (16/16), `test:security` (3/3), `test:ui` (5/5), and `install-plugin.mjs --dry-run` (97/97 PASS per OS).

---

## [한국어] `v3.1.3` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.1.3`은 **전역 컨텍스트 한도(`defaultCustomLimit`)를 낮춘 직후 100%를 초과한 세션에서 `/compact`가 2회 연속 호출되는 결함**의 5가지 근본 원인을 수정한 패치 릴리즈입니다.

### 2. 주요 결함 수정 및 변경 사항
- **수정 1 — `reducedMeaningfully` 쿨다운 우회 제거 (`src/core/app/statusbar-service.mjs`)**: 낮춘 전역 한도에서 압축 후 토큰이 15%(`>= 10K`) 이상 줄었더라도 여전히 새 한도 이상일 때 `droppedBelowLimit || reducedMeaningfully` 분기가 `waitingForDrop = false`, `cooldownUntil = 0`으로 초기화해 즉시 2번째 `/compact`를 호출하던 결함을 제거했습니다. 실제 한도 미만(`droppedBelowLimit`)으로 내려간 경우에만 쿨다운을 해제하고, 여전히 한도 이상이면 압축 후 토큰을 새 기준으로 90초 쿨다운과 증가량 가드를 유지합니다.
- **수정 2 — 모호한 타임아웃(504) 중복 폴백·상태 초기화 차단 (`src/adapters/antigravity/compaction-adapter.mjs`, `src/core/app/statusbar-service.mjs`)**: `/compact` RPC 타임아웃을 `20_000ms`로 상향하고, `504`/`AbortError`/타임아웃 등 호스트 접수 여부가 불명확한 오류에서는 `agentapi`·RPC 폴백을 실행하지 않고 `{ accepted: false, ambiguous: true }`를 반환합니다. `statusbar-service`는 모호한 `504` 타임아웃 시 `waitingForDrop`, 90초 쿨다운, `pendingAutoResume`을 보존해 `IDLE` 전환 직후 중복 재호출을 방지합니다.
- **수정 3 — `updateSettings` 진행 중 세션 보호 및 동일 값 저장 무시 (`src/core/app/statusbar-service.mjs`)**: 이전 설정과 실제로 값이 변경된 경우(또는 `autoCompact`가 `false → true`로 켜진 경우)에만 `autoCompactState`를 초기화하며, 현재 압축 진행 중(`compactingSessions`)인 세션의 쿨다운은 삭제하지 않습니다.
- **수정 4 — 수동 `/compact` 쿨다운 무장 및 Tail 조회 유지 (`src/core/app/statusbar-service.mjs`)**: 수동 `/compact` 수락 시에도 `autoCompactState`(90초 쿨다운 + `waitingForDrop`)를 무장해 15초 초과 압축 도중 자동 압축이 겹치지 않게 하고, 쿨다운 대기 중 `includeTailSteps: true` 조회를 유지합니다.
- **수정 5 — 동시 `getSessionSnapshot` 역순 응답 순번 가드 (`src/core/app/statusbar-service.mjs`)**: 세션별 단조 순번(`snapshotSeq` / `latestCompletedSnapshotSeq`, LRU 상한) 가드를 도입해 `stepCount`/`lastCompactedStep`이 `null`인 환경에서도 오래된 지연 폴링 응답이 상태를 덮어쓰거나 중복 `/compact`를 발화하지 않도록 차단했습니다.
- **테스트 (`test/unit/p0-hardening-tdd.test.mjs`, `test/unit/autocompact-tdd.test.mjs`)**: 5개 근본 원인 회귀 테스트 `TC-P0-13a`–`TC-P0-13e`를 추가하고, 구 오라클 `TC-TDD-AC-03`을 쿨다운+증가량 가드 준수 및 갱신된 기준선 검증으로 정합화했습니다.

### 3. 검증 근거
- 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20) TDD RED (`TC-P0-13a`–`TC-P0-13e` 5건 실패 재현) → TDD GREEN: `test:static`(7/7), `test:unit`(66/66), `test:integration`(16/16), `test:security`(3/3), `test:ui`(5/5), `install-plugin.mjs --dry-run` (OS당 97/97 전 항목 통과).

---

# Release Notes — `v3.1.2` (2026-11-23)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.1.2` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.1.2` resolves a compound defect reproduced on oversized (`>4MB`) live Antigravity Desktop sessions where auto-compaction fired twice in rapid succession after a burst of post-resume tool calls and the agent subsequently stalled without auto-resume when post-checkpoint `RUNNING` ("Working") lasted longer than 12 seconds with zero new steps.

### 2. Defect Fixes & Changes
- **Fix #1 — Widened Tail Probe & Monotonic Per-Session Checkpoint Memory (`src/adapters/antigravity/ls-transport.mjs`, `src/adapters/antigravity/telemetry-mapper.mjs`)**: Widens the initial `getTailTrajectorySteps` probe from `total - 12` to `total - 40` (`[total-40, total-16, total-4, total-1]`) and maintains a bounded 64-entry LRU monotonic `knownCheckpoints` map in `createAntigravityTelemetryAdapter` so `lastCompactedStep` and checkpoint summary size never regress when a `CHECKPOINT` leaves the tail window before the next LLM metadata arrives.
- **Fix #2 — Per-Source Metadata Step Tracking (`src/adapters/antigravity/telemetry-mapper.mjs`)**: Tracks `contextWindowEstimatedStepIndex` and `usageStepIndex` independently in `extractLatestUsageMetadata` and enforces `effectiveCheckpointStep >= tokenSourceMetaStep` so partial post-compaction items (`usage: {}`) and checkpoint-step summarization items never leak stale pre-compaction token counts across a completed `CHECKPOINT`.
- **Fix #3 — Post-Compaction Settlement Cooldown & Out-of-Order Poll Guard (`src/core/app/statusbar-service.mjs`)**: Preserves/refreshes the 90-second settlement cooldown while readings remain synthetic (`usedTokensSource === 'after_compaction'`, covering compactions longer than 90s) and clears it once a real post-compaction below-limit reading arrives. Adds a bounded LRU monotonic `observedProgress` guard so out-of-order stale polls with regressed `stepCount` or `lastCompactedStep` never re-trigger `/compact`.
- **Fix #4 — Preserve `pendingAutoResume` During Zero-Step `Working` Windows (`src/core/app/statusbar-service.mjs`)**: Requires actual step progress (`runningStepDelta >= 2`) before cancelling `pendingAutoResume` as host self-resume whenever `stepCount` telemetry is available, retaining the 12-second elapsed-time fallback strictly for hosts where `stepCount` is `null`.
- **Test Hardening (`test/unit/p0-hardening-tdd.test.mjs`, `test/ui/ui-app.test.mjs`)**: Adds TDD regressions `TC-P0-12a`–`TC-P0-12d` covering all four root causes and eliminates a CDP E2E timing race by awaiting server receipt of `POST /api/compact` before asserting `compactCalls`.

### 3. Verification
- Verified TDD RED → GREEN on 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20) across `test:static`, `test:unit` (61/61 per OS including `TC-P0-12a`–`TC-P0-12d`), `test:integration`, `test:security`, `test:ui` (5/5 real Headless Chromium Shadow DOM E2E), and `install-plugin.mjs --dry-run`.

---

## [한국어] `v3.1.2` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.1.2`는 `>4MB` 초대형 실세션에서 재현된 **자동 압축 직후 병렬 툴 호출 구간에서 `/compact`가 2회 연속 호출되는 결함**과, **체크포인트 완료 후 새 스텝 진행 없이 `Working`(`RUNNING`) 상태가 12초 이상 지속될 때 자동 재개가 취소되어 에이전트가 정지하는 결함**을 근본 수정한 패치 릴리즈입니다.

### 2. 주요 결함 수정 및 변경 사항
- **수정 1 — Tail 조회 범위 확장 및 세션별 체크포인트 단조 기억 (`src/adapters/antigravity/ls-transport.mjs`, `src/adapters/antigravity/telemetry-mapper.mjs`)**: `getTailTrajectorySteps`의 초기 조회 오프셋을 `total - 12`에서 `total - 40`(`[total-40, total-16, total-4, total-1]`)으로 확장하고, `createAntigravityTelemetryAdapter`에 최대 64개 LRU 단조 캐시(`knownCheckpoints`)를 도입해 다음 LLM 메타데이터 도착 전 `CHECKPOINT`가 tail window를 벗어나더라도 `lastCompactedStep`과 요약 크기가 역행하지 않도록 수정했습니다.
- **수정 2 — 메타데이터 토큰 출처 스텝 분리 추적 (`src/adapters/antigravity/telemetry-mapper.mjs`)**: `extractLatestUsageMetadata`에서 `contextWindowEstimatedStepIndex`와 `usageStepIndex`를 분리 기록하고 `effectiveCheckpointStep >= tokenSourceMetaStep` 조건을 적용해, 스트리밍 중인 부분 메타데이터(`usage: {}`)나 체크포인트 요약 호출 자체가 압축 이전 구 토큰을 끌어오지 못하도록 차단했습니다.
- **수정 3 — 합성 `'after_compaction'` 안정화 쿨다운 유지 및 역순 폴링 가드 (`src/core/app/statusbar-service.mjs`)**: `usedTokensSource === 'after_compaction'`인 합성 측정 구간에서는 90초 안정화 쿨다운을 유지·갱신(90초 초과 장기 압축 대응)하고 실제 압축 이후 `<limit` 응답이 도착할 때만 해제합니다. 또한 단조 진행 가드(`observedProgress`)를 추가해 `stepCount`나 `lastCompactedStep`이 역행한 역순 폴링 응답이 `/compact`를 재발화하지 못하게 막았습니다.
- **수정 4 — 무진행 `Working` 구간의 `pendingAutoResume` 보존 (`src/core/app/statusbar-service.mjs`)**: `stepCount` 텔레메트리가 존재할 때는 실제 스텝이 `>= 2` 증가한 경우에만 호스트 자체 재개로 간주해 `pendingAutoResume`을 취소하도록 변경했으며, 12초 경과 기반 폴백은 `stepCount`가 `null`일 때만 적용합니다.
- **테스트 보강 (`test/unit/p0-hardening-tdd.test.mjs`, `test/ui/ui-app.test.mjs`)**: 4개 근본 원인에 대한 회귀 테스트(`TC-P0-12a`–`TC-P0-12d`)를 추가하고, UI CDP E2E에서 `POST /api/compact` 서버 수신을 대기하도록 보강해 Linux CI 레이스를 제거했습니다.

### 3. 검증 근거
- 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20) TDD RED → GREEN 검증: `test:static`, `test:unit`(OS당 61/61, `TC-P0-12a`–`TC-P0-12d` 포함), `test:integration`, `test:security`, `test:ui`(실브라우저 Headless Chromium Shadow DOM E2E 5/5), `install-plugin.mjs --dry-run` 전 항목 100% 통과.

---

# Release Notes — `v3.1.1` (2026-11-23)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.1.1` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.1.1` fixes the recurring mid-work auto-compaction auto-resume drop reproduced on live Antigravity Desktop sessions and removes the redundant right-hand `AUX_PANE` `"Statusbar"` side panel while keeping the `AddonManifest.v2` Shadow DOM inline statusbar running securely in headless sidecar mode.

### 2. Defect Fixes & Changes
- **Fix #1 — Transient `RUNNING` Race & Single-Shot Completion Latch (`src/core/app/statusbar-service.mjs`)**: Latches `compactionDoneAt` and `compactionDoneStepCount` as soon as `CHECKPOINT DONE` is observed, tolerating the brief post-checkpoint `RUNNING` window instead of immediately cancelling `pendingAutoResume`. Cancels only when the host genuinely resumes on its own (`stepCount` advances by `>= 2` or stays `RUNNING` for `>= 12s`) or after confirmed manual user intervention.
- **Fix #2 — Checkpoint Step Index & Empty Status Fallback (`src/adapters/antigravity/telemetry-mapper.mjs`)**: Computes positional checkpoint indices via `explicitStep ?? Math.max(baseOffset + i, includedStepIndexEnd)` so `lastCompactedStep` is never underestimated by `includedStepIndexEnd`, and trims empty `update.status` strings so status cleanly falls back to `trajectorySummary.status`.
- **Fix #3 — Continuation Transport & Visible Error Surfacing (`src/adapters/antigravity/compaction-adapter.mjs`, `src/core/app/statusbar-service.mjs`)**: Dispatches non-`/compact` continuation prompts via official `agentapi send-message` (`shell: false`) first when configured with automatic fallback to `SendUserCascadeMessage` RPC, inspects both `{ accepted: false }` responses and rejected promises, and surfaces `AUTO_RESUME_FAILED` visibly in snapshots until the session resumes running.
- **Fix #4 — Remove Redundant `AUX_PANE` Side Panel & Support Headless Ephemeral Auth (`sidecars/statusbar/sidecar.json`, `src/adapters/antigravity/sidecar-entry.mjs`)**: Sets `has_web_ui: false` and removes `ui_config` (`AUX_PANE` tab). When running headless without `ANTIGRAVITY_SIDECAR_UI_TOKEN`, `startSidecar()` mints a 256-bit (64-char hex) per-process cryptographic token for the inline renderer bundle while preserving strict Fail-Closed rejection for any explicitly supplied short token (`< 16` chars).

### 3. Verification
- Verified TDD RED → GREEN on 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20): **88/88 tests passing per OS (176/176 total)** across `test:static`, `test:unit`, `test:integration`, `test:security`, `test:ui` (real Headless Chromium Shadow DOM E2E), and `install-plugin.mjs --dry-run`.

---

## [한국어] `v3.1.1` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.1.1`은 실제 Antigravity Desktop 세션에서 재현된 **작업 중 자동 압축 후 자동 재개 누락 결함**을 근본 수정하고, 인라인 상태바 도입 이후 불필요해진 **우측 `AUX_PANE` `"Statusbar"` 패널을 제거**하면서 헤드리스 Sidecar 모드에서도 `AddonManifest.v2` Shadow DOM 인라인 상태바가 안전하게 동작하도록 개선한 패치 릴리즈입니다.

### 2. 주요 결함 수정 및 변경 사항
- **수정 1 — 체크포인트 완료 직후 일시적 `RUNNING` 레이스 및 단일-샷 완료 래치 (`src/core/app/statusbar-service.mjs`)**: `CHECKPOINT DONE` 관측 시 `compactionDoneAt`과 `compactionDoneStepCount`를 `pendingAutoResume`에 래치해, 직후 호스트가 짧게 `RUNNING`을 유지하다 `IDLE`로 전환되는 구간에서 자동 재개 예약이 오취소되는 결함을 수정했습니다. 호스트가 실제로 자체 재개한 경우(`RUNNING` 중 `stepCount` 2 이상 증가 또는 12초 이상 경과)나 사용자 수동 입력이 확인된 경우에만 취소합니다.
- **수정 2 — 체크포인트 스텝 인덱스 보정 및 빈 상태 문자열 폴백 (`src/adapters/antigravity/telemetry-mapper.mjs`)**: `extractTailCheckpoint`에서 `explicitStep ?? Math.max(baseOffset + i, includedStepIndexEnd)`로 위치를 보정해 `lastCompactedStep` 과소평가를 방지하고, `mapSessionTelemetry`에서 빈 `update.status` 문자열이 `trajectorySummary.status` 폴백을 가리지 않도록 수정했습니다.
- **수정 3 — 이어하기 전송 경로 보강 및 실패 가시화 (`src/adapters/antigravity/compaction-adapter.mjs`, `src/core/app/statusbar-service.mjs`)**: `/compact` 외 이어하기 프롬프트는 설정된 공식 `agentapi send-message`(`shell: false`)를 우선 사용하고 미접수/미설정 시 `SendUserCascadeMessage` RPC로 폴백합니다. `{ accepted: false }`와 Promise reject를 모두 검사해 재시도 루프 없이 `AUTO_RESUME_FAILED`를 스냅샷에 가시적으로 기록합니다.
- **수정 4 — 우측 `AUX_PANE` 패널 제거 및 헤드리스 256-bit 임시 토큰 인증 (`sidecars/statusbar/sidecar.json`, `src/adapters/antigravity/sidecar-entry.mjs`)**: `has_web_ui: false` 설정 및 `ui_config` 제거로 우측 `Statusbar` 탭을 제거했습니다. 헤드리스 기동 시 호스트가 `ANTIGRAVITY_SIDECAR_UI_TOKEN`을 주입하지 않으면 프로세스별 256-bit(64자 hex) 임시 암호 토큰을 생성해 인라인 번들에 발급하며, 명시적으로 16자 미만 토큰이 주어지면 기존과 동일하게 Fail-Closed로 거부합니다.

### 3. 검증 근거
- 2-OS GitHub Actions CI (`ubuntu-latest` + `windows-latest`, Node 20) TDD RED → GREEN 검증: `test:static`, `test:unit`, `test:integration`, `test:security`, `test:ui`(실브라우저 Headless Chromium Shadow DOM E2E), `install-plugin.mjs --dry-run` 전 항목 **OS당 88/88 통과(총 176/176, 0 실패, 0 스킵)**.

---

# Release Notes — `v3.1.0` (2026-11-23)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.1.0` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.1.0` introduces the official **`AddonManifest.v2` Shadow DOM Inline Statusbar** directly beneath the Antigravity chat input box (with `AUX_PANE` retained as a lightweight fallback), 4-tier context limits (`session > model > default > host`), 5h & weekly account quota display, editable `/compact` prompt, `StatusbarAddon.v1` custom command buttons, and full **P0 hardening (`ISS-00`–`ISS-14`)** verified by strict TDD + real Headless Chromium Shadow DOM E2E on 2-OS CI.

### 2. Key Enhancements & P0 Defect Fixes
- **`ISS-00` (Mid-Work Auto-Compaction Task Interruption Fix)**: Added `autoCompactWhileRunning` (`'resume'` default / `'defer'`). When a `RUNNING` session reaches its custom limit and auto-compacts into `IDLE`, a single-shot guarded continuation prompt is dispatched via `SendUserCascadeMessage` RPC (never for manual `/compact`, `IDLE` sessions, cancelled/errored runs, or after manual user input; capped by a 3-run circuit breaker).
- **`ISS-01`, `ISS-06`, `ISS-07` (Data-Loss & Silent Reset Prevention)**: Replaced `type="number"` inputs with `type="text" inputmode="numeric"` + `badInput` guard; hardened `scripts/install-plugin.mjs` (`lstat` symlink fail-fast, atomic fallback preserving live renderer, fail-fast rollback); moved `StatusbarAddon.v1` mutations into atomic in-lock delta patches (`addonUpsert`/`addonToggle`/`addonRemove`) with strict CLI flag validation.
- **`ISS-03`, `ISS-04`, `ISS-05`, `ISS-14` (State Machine & Transport Hardening)**: Preserved per-session 300s host compaction locks across cross-session polling and `<4MB` tail step checks; restricted `ls-transport.mjs` retries strictly to `RESPONSE_CAP_EXCEEDED` (eliminating 12× timeout amplification); guarded against transient `usedTokens: null` cooldown wipes and low-limit (`32K`) compaction loops; excluded identifiable subagent cascades from background auto-compact sweeps by default.
- **`ISS-08`, `ISS-09`, `ISS-10`, `ISS-13` (UI, Connectivity, Focus & Credential Teardown)**: Added synchronous `teardownSync()` on `SIGBREAK`/`stdin`/`uncaughtException`/`exit`; fixed `AUX_PANE` model-limit leak into session input; fixed `24h` quota labeling, `99.7%` → `99%` non-exceeded rounding, stale-snapshot disconnect visibility, Shadow DOM `composedPath()` outside clicks, modal `modelListEl` focus preservation across polls, `Escape` focus return, non-writable `window.statusbarAddons`, and command tooltips.
- **`ISS-02`, `ISS-11` (Real-Browser Shadow DOM E2E & Documentation Sync)**: Added `test/ui/addon-browser-e2e.test.mjs` running in real Headless Chromium/Edge on both `ubuntu-latest` and `windows-latest` CI.

---

## [한국어] `v3.1.0` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.1.0`은 Antigravity 채팅 입력창 바로 아래에 렌더링되는 공식 **`AddonManifest.v2` Shadow DOM 인라인 상태바**(우측 `AUX_PANE` 폴백 유지), 4단계 컨텍스트 한도(`현재 세션 > 모델별 전역 > 일괄 전역 > 호스트 기본값`), 5시간·주간 계정 한도 표시, 편집 가능한 `/compact` 요약 문구, `StatusbarAddon.v1` 커스텀 버튼, 그리고 **P0 결함 일괄 수정(`ISS-00`~`ISS-14`)**을 엄격한 TDD 및 2-OS 실브라우저 Shadow DOM E2E CI 검증과 함께 제공합니다.

### 2. 주요 개선 및 P0 결함 수정
- **`ISS-00` (에이전트 작업 중 자동 압축 시 작업 영구 중단 버그 수정)**: `autoCompactWhileRunning` (`'resume'` 기본값 / `'defer'`) 정책을 도입했습니다. `RUNNING` 중 자동 압축 완료 후 `IDLE`로 종료되면 1회성 가드된 이어하기 프롬프트를 `SendUserCascadeMessage` RPC로 전송해 작업 중단을 방지합니다(수동 `/compact`, 기존 `IDLE` 세션, 취소·오류, 사용자 수동 입력 개입, 연속 3회 서킷 브레이커 초과 시 미전송).
- **`ISS-01`, `ISS-06`, `ISS-07` (데이터 손실 및 무음 초기화 차단)**: 모든 한도 입력칸을 `type="text" inputmode="numeric"`으로 전환해 `badInput` 무음 초기화 차단; `scripts/install-plugin.mjs` 심볼릭 링크 fail-fast 및 안전한 롤백·원자적 폴백 보강; 애드온 CRUD를 파일 락 내부 원자적 델타 패치(`addonUpsert`/`addonToggle`/`addonRemove`)로 전환하고 CLI 플래그 검증 강화.
- **`ISS-03`, `ISS-04`, `ISS-05`, `ISS-14` (상태 머신 및 전송 계층 안정화)**: 다중 세션 폴링 중 300초 호스트 압축 락 조기 만료 차단 및 `<4MB` 세션 tail step 관측 보강; `ls-transport.mjs` 4MB 초과(`RESPONSE_CAP_EXCEEDED`) 외 타임아웃/502 증폭 차단; 일시적 `usedTokens: null` 쿨다운 증발 및 저한도(`32K`) 무한 압축 루프 차단; 백그라운드 스윕에서 서브에이전트 기본 제외.
- **`ISS-08`, `ISS-09`, `ISS-10`, `ISS-13` (UI·연결 상태·포커스·종료 토큰 회수)**: `SIGBREAK`/`stdin`/`uncaughtException`/`exit` 경로에 동기 `teardownSync()` 토큰 회수 추가; `AUX_PANE` 모델 한도→세션 입력칸 오표시 수정; `24h` 버킷 오분류 제거, `99.7%` → `99%` 반올림 보정, 연결 끊김 배지 노출, Shadow DOM `composedPath()` 판정, 모달 `modelListEl` 폴링 중 포커스 보존, `Escape` 포커스 복원, `window.statusbarAddons` 불변 정의, 커스텀 버튼 툴팁 명령 표시.
- **`ISS-02`, `ISS-11` (실브라우저 Shadow DOM E2E CI 및 문서 동기화)**: `ubuntu-latest`·`windows-latest` 양 OS에서 실제 Headless Chromium/Edge로 인라인 Shadow DOM 번들을 검증하는 `test/ui/addon-browser-e2e.test.mjs`를 CI에 편입했습니다.

---

# Release Notes — `v3.0.0` (2026-11-19)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v3.0.0` Release Notes

### 1. Summary
`antigravity-statusbar` `v3.0.0` is a clean-slate rebuild implemented as an official **Antigravity Native Plugin + Auxiliary Pane Sidecar (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)** using a strict vendor-neutral Ports & Adapters architecture (`src/core/`, `src/ui/`, `src/adapters/storage/`, `src/adapters/antigravity/`). It delivers all 7 core features—real-time context window usage, prompt cache hit ratio, 5h/7d account quota, per-session and default soft context limits (`32K`–`980K`), one-click `/compact`, detailed 8-group token breakdown, and `EN`/`KO` locale toggling—without modifying any host binaries.

### 2. Breaking Changes & Migration Guide
- **Complete removal of `app.asar` patching, renderer injection, UserScript/Bookmarklet bundling, React Fiber/Protobuf mutation, `SetMendelFlagOverrides`, and `hooks.json`.**
- Remote Control Web support has been decoupled into a separate project (`antigravity-remote-plugin`).
- **Migration**: Remove any legacy `statusbar_autoinject.js` or `app_storage.json` (`agy-statusbar-code`) entries, then install the official native plugin via `npm ci --omit=dev && npm run install-plugin` and enable **Antigravity Statusbar** in Plugins Manager.

### 3. Defect Fixes & Enhancements
- **`ANTIGRAVITY_STATUSBAR-D-0006` (`P2`)**: Bound all DOM, document, and window listeners in `src/ui/app.js` to a single `AbortController` signal released deterministically in `dispose()`.
- **`ANTIGRAVITY_STATUSBAR-D-0012` (`P2`)**: Eliminated all `innerHTML` usage and React Fiber DFS polling; implemented incremental `textContent` updates and unchanged `<option>` preservation in `src/ui/app.js`.
- **`ANTIGRAVITY_STATUSBAR-D-0013` (`P1`)**: Removed global host engine flag mutation (`SetMendelFlagOverrides`) and replaced it with Option A per-session/default soft context limits (`src/core/model/context-policy.mjs`).
- **`ANTIGRAVITY_STATUSBAR-D-0020` (`P3`)**: Added deterministic shutdown cleanup for sidecar HTTP server, child processes (`SIGTERM` → `SIGKILL` escalation in `src/adapters/antigravity/compaction-adapter.mjs`), and UI timers/controllers.
- **`ANTIGRAVITY_STATUSBAR-D-0025` (`P2`)**: Enforced `textContent`-only DOM rendering, strict CSP (`default-src 'none'; script-src 'self'; style-src 'self'`), Fail-Closed `POST`-only Sidecar API auth, and `path.relative` + `realpathSync` static asset jail (`src/adapters/antigravity/sidecar-entry.mjs`).
- **`ANTIGRAVITY_STATUSBAR-D-0026` (`P2`)**: Bounded per-session settings and compaction maps to a 200-entry LRU cap (`pruneSessionOverrides`) and adopted trusted `proper-lockfile` + `write-file-atomic` for cross-process persistence (`src/adapters/storage/json-settings-store.mjs`).
- **`ANTIGRAVITY_STATUSBAR-D-0033` (`P1`)**: Enforced Fail-Closed `conversationId` matching (`409 SESSION_MISMATCH`), per-channel UI epochs + `AbortController`, transient feedback clearing on session switch, and `targetSessionId` guards on async compaction/settings mutations.
- **Obsolete v1/v2 Defects (`NOT_DEFECT`)**: `D-0001`, `D-0004`, `D-0010`, `D-0011`, `D-0015`, `D-0032`, `D-0034` closed as `NOT_DEFECT` following removal of `app.asar` patching, UserScript bundling, and Remote Web bookmarklet code.

### 4. Verification & CI Evidence
- **Test Suite**: `npm test` (`31/31` passed on Windows TEST & 2-OS CI; `30/30` passed on Linux TEST with 1 headless-browser skip)
- **Commit SHA**: Tracked on `feature/v3-native-plugin` and recorded in PostgreSQL ledger `ANTIGRAVITY_STATUSBAR-T-0006`
- **CI Workflow**: `https://github.com/jaeseongs95/antigravity-statusbar/actions` (2-OS `ubuntu-latest` + `windows-latest`, Node 20)

---

## [한국어] `v3.0.0` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v3.0.0`은 호스트 바이너리를 전혀 수정하지 않는 공식 **Antigravity 네이티브 플러그인 + 우측 보조패널 Sidecar (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)** 구조로 백지 재구축한 버전입니다. 엄격한 벤더 중립 Ports & Adapters 아키텍처(`src/core/`, `src/ui/`, `src/adapters/storage/`, `src/adapters/antigravity/`) 위에서 7대 핵심 기능(실시간 컨텍스트 사용량, 프롬프트 캐시 적중률, 5시간·7일 계정 할당량, 세션별·기본 소프트 컨텍스트 한도 `32K`–`980K`, 원클릭 `/compact`, 8개 그룹 토큰 상세 내역, `EN`/`KO` 언어 전환)을 제공합니다.

### 2. 호환성 및 마이그레이션 안내
- **`app.asar` 패치, Electron 렌더러 주입, UserScript/북마클릿 번들링, React Fiber/Protobuf 변조, `SetMendelFlagOverrides`, `hooks.json`을 전면 제거했습니다.**
- 원격 제어 웹 지원은 별도 프로젝트(`antigravity-remote-plugin`)로 분리했습니다.
- **마이그레이션**: 구버전 `statusbar_autoinject.js` 및 `app_storage.json`(`agy-statusbar-code`) 잔여 항목을 제거한 뒤 `npm ci --omit=dev && npm run install-plugin`으로 공식 네이티브 플러그인을 설치하고 Plugins Manager에서 **Antigravity Statusbar**를 활성화합니다.

### 3. 주요 결함 수정 및 개선 사항
- **`ANTIGRAVITY_STATUSBAR-D-0006` (`P2`)**: `src/ui/app.js`의 모든 DOM·문서·윈도우 리스너에 단일 `AbortController` 시그널을 바인딩해 `dispose()` 시 일괄 해제하도록 수정했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0012` (`P2`)**: `innerHTML` 사용과 React Fiber DFS 폴링을 전면 제거하고, `textContent` 증분 갱신 및 미변경 `<option>` 노드 보존을 구현했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0013` (`P1`)**: 전역 호스트 엔진 플래그 변조(`SetMendelFlagOverrides`)를 제거하고 A안 세션별·기본 소프트 컨텍스트 한도(`src/core/model/context-policy.mjs`)로 대체했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0020` (`P3`)**: Sidecar HTTP 서버, 자식 프로세스(`src/adapters/antigravity/compaction-adapter.mjs` `SIGTERM` → `SIGKILL` 단계 종료), UI 타이머·컨트롤러의 종료 시 완전 정리를 구현했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0025` (`P2`)**: `textContent` 전용 렌더링, 엄격 CSP(`default-src 'none'; script-src 'self'; style-src 'self'`), Fail-Closed `POST` 전용 Sidecar API 인증, `path.relative` + `realpathSync` 정적 경로 격리(`src/adapters/antigravity/sidecar-entry.mjs`)를 적용했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0026` (`P2`)**: 세션별 한도·압축 상태 맵에 200-LRU 상한(`pruneSessionOverrides`)을 강제하고, 크로스 프로세스 영속 저장에 신뢰 라이브러리 `proper-lockfile` + `write-file-atomic`(`src/adapters/storage/json-settings-store.mjs`)을 적용했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0033` (`P1`)**: `conversationId` 누락·불일치 시 Fail-Closed(`409 SESSION_MISMATCH`), 채널별 UI epoch + `AbortController`, 세션 전환 시 일시 피드백 초기화, 비동기 압축·한도 저장 `targetSessionId` 대조 가드를 적용했습니다.
- **폐기 구버전 결함 (`NOT_DEFECT`)**: `app.asar` 패치·UserScript·원격 북마클릿 전면 제거에 따라 `D-0001`, `D-0004`, `D-0010`, `D-0011`, `D-0015`, `D-0032`, `D-0034`를 `NOT_DEFECT`로 정리했습니다.

### 4. 검증 및 CI 근거
- **테스트 결과**: `npm test` (Windows TEST 및 2-OS CI `31/31` 통과, Linux TEST `30/30` 통과·브라우저 미설치 1건 skip)
- **커밋 SHA**: `feature/v3-native-plugin` 최신 커밋 SHA (PostgreSQL 장부 `ANTIGRAVITY_STATUSBAR-T-0006`에 원시 증빙과 함께 기록)
- **CI 실행 이력**: `https://github.com/jaeseongs95/antigravity-statusbar/actions` (2-OS `ubuntu-latest` + `windows-latest`, Node 20)
