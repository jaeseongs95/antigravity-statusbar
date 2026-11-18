# Release Notes — `v2.0.0` (2026-11-18)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v2.0.0` Release Notes

### 1. Summary
`antigravity-statusbar` `v2.0.0` delivers a full **Hexagonal (Ports & Adapters)** architectural overhaul for Google Antigravity Desktop and Remote Control Web (`https://antigravity.google.com/r/...`). This release eliminates all HTML string sinks and global `TrustedTypes` policy fallbacks, decouples domain and port layers from browser/vendor globals, restores zero-configuration host-marker companion auto-discovery on Remote Control Web without sibling-repository coupling, hardens multi-plugin `<ga-remote-control>` prototype lease chaining, and decomposes the ASAR/CDP host installer into six verifiable modules.

### 2. Breaking Changes & Migration Guide
- **Public Runtime & CLI Compatibility Preserved**: `window.agyStatusBar`, `window.__agyStatusBarCleanup()`, `npm run install-statusbar`, `npm run status`, and `npm run uninstall` remain backward-compatible.
- **Remote Control Bookmarklet Update (`README.md` / `README.ko.md`)**: Remote Control Web users under strict `Content-Security-Policy: trusted-types ogb-qtm#html agy-sb-bm` should update their browser bookmarklet from `README.md` so the scoped one-shot `Symbol.for('agy.sb.tt.scriptGate.v2')` gate is shared cleanly with host-discovered companion blocks.
- **Internal Port Contract Refinement**: Custom callers instantiating `createContextWindowStore` directly against a mock `StoragePort` now implement the segregated 6-method domain contract (`loadSnapshot`, `loadPersistent`, `readSessionOverride`, `saveSessionOverride`, `evictSessionOverride`, `saveDefaultLimit`).

### 3. Defect Fixes & Enhancements
- **`ANTIGRAVITY_STATUSBAR-D-0025` (`P2`)**: Replaced template HTML string interpolation and regex HTML parsing across metrics, menus, and debug modals with pure DOM node construction (`src/ui/dom-builder.js`, `src/ui/views/*.js`), propagated CSP nonces across parent and promoted child iframe stylesheets (`src/ui/style-manager.js`), and shared a scoped one-shot `TrustedScript` gate (`src/drivers/antigravity/companion-driver.js`).
- **`ANTIGRAVITY_STATUSBAR-D-0032` (`P2`)**: Removed all `TrustedHTML` creation and global/framework `TrustedTypes` policy fallbacks (`default`, `dompurify`, `angular#unsafe-bypass`); confined script policy probing to `['agy-sb-bm', 'agy-sb-companion-v2']` with per-window `WeakMap` negative policy caching (`src/drivers/antigravity/companion-driver.js`) so strict hosts emit zero `SecurityPolicyViolationEvent` storms.
- **`ANTIGRAVITY_STATUSBAR-D-0034` (`P1`)**: Replaced shared `__agyOrig_*` prototype properties and cross-plugin loading flags with symbol-isolated, reference-counted `<ga-remote-control>` prototype lease chaining (`src/drivers/antigravity/remote-port-driver.js`) that honors `__agySuppressAutoIframeLoad` / `__agySuppressAutoIframeLoadCount`, captures internal `__agy_probe__` events before origin filtering without forwarding to host handlers, and renders child iframe widgets with `targetEl.ownerDocument` without hijacking cross-origin iframe promotion.
- **Host-Marker Companion Auto-Discovery & Lifecycle (`T-0001`, `D-0001`, `D-0004`, `D-0011`, `D-0015`, `AUDIT-M6`)**: Restored automatic Remote Control discovery via `GetCustomizationStates` / `GetAllPlugins` / `GetAllSkills` + `ReadFile` (`UTF-8`, `Uint8Array`, `ArrayBuffer`, `base64`) extracting column-0 `// === BEGIN_AGY_* ===` and `/* === BEGIN_AGY_* === */` blocks (`_V\d+` normalized, zero hardcoded sibling names) with `DisposableScope`-cancelled `1500ms` retries (`src/drivers/antigravity/companion-driver.js`, `src/app/index.js`).
- **Hexagonal Port Segregation & Backup Integrity (`D-0023`, `D-0027`, `D-0029`)**: Segregated `StoragePort` (`src/ports/contracts.js`, `src/domain/context-window-policy.js`), encapsulated `resolveCsrfToken(win)` in `src/drivers/antigravity/host-config.js`, and guarded corrupted `.orig` ASAR backups with `FAILED_CORRUPTED_BACKUP` in `installer/host-patcher.js`.

### 4. Verification & CI Evidence
- **Test Suite**: `npm test` (`SB2-TC-001` through `SB2-TC-012` — unit, UI, integration, installer, and standalone headless Chromium E2E suites passed)
- **Target Branch**: `develop` (`v2.0.0` release candidate pending independent audit verification prior to `main` merge)
- **CI Workflow**: [`https://github.com/jaeseongs95/antigravity-statusbar/actions/workflows/ci.yml`](https://github.com/jaeseongs95/antigravity-statusbar/actions/workflows/ci.yml) (`ubuntu-latest` + `windows-latest` standalone matrix)

---

## [한국어] `v2.0.0` 릴리즈 노트

### 1. 개요
`antigravity-statusbar` `v2.0.0`은 Google Antigravity 데스크톱 및 Remote Control 웹(`https://antigravity.google.com/r/...`) 환경을 위한 전면 **헥사고날(Ports & Adapters)** 아키텍처 개편 릴리즈입니다. 모든 HTML 문자열 싱크와 전역 `TrustedTypes` 우회 정책 시도를 구조적으로 제거하고, 도메인·포트 계층에서 브라우저 저장소 및 벤더 전역 객체 결합을 분리했으며, 형제 저장소 하드코딩 없이 호스트 설치 마커 기반 원격 동반 자동 로드를 복원하고 다중 플러그인 `<ga-remote-control>` 프로토타입 리스 체인 및 6분할 모듈형 설치기를 완성했습니다.

### 2. 호환성 및 마이그레이션 안내
- **공개 런타임 API 및 CLI 하위 호환 유지**: `window.agyStatusBar`, `window.__agyStatusBarCleanup()`, `npm run install-statusbar`, `npm run status`, `npm run uninstall` 진입점은 기존과 동일하게 유지됩니다.
- **Remote Control 웹 북마클릿 갱신 안내 (`README.md` / `README.ko.md`)**: 엄격한 `trusted-types ogb-qtm#html agy-sb-bm` 헤더가 적용된 원격 웹 환경에서는 북마클릿과 호스트 마커 동반 로더가 단발성 `Symbol.for('agy.sb.tt.scriptGate.v2')` 토큰 게이트를 공유하도록 최신 북마클릿으로 갱신하는 것을 권장합니다.
- **내부 `StoragePort` 계약 정제**: `createContextWindowStore`에 사용자 정의 `StoragePort`를 직접 주입하는 테스트·호출자는 매체 중립적인 6개 도메인 메서드(`loadSnapshot`, `loadPersistent`, `readSessionOverride`, `saveSessionOverride`, `evictSessionOverride`, `saveDefaultLimit`) 계약을 따릅니다.

### 3. 주요 결함 수정 및 개선 사항
- **`ANTIGRAVITY_STATUSBAR-D-0025` (`P2`)**: 상태바·메뉴·디버그 모달 전반의 HTML 템플릿 보간 및 정규식 파서를 순수 DOM 노드 빌더(`src/ui/dom-builder.js`, `src/ui/views/*.js`)로 전면 교체하고, 부모 및 승격된 자식 iframe 스타일시트에 CSP nonce를 전파(`src/ui/style-manager.js`)했으며, 단발성 `TrustedScript` 토큰 게이트(`src/drivers/antigravity/companion-driver.js`)를 적용했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0032` (`P2`)**: `TrustedHTML` 정책 생성 및 전역/프레임워크 이름(`default`, `dompurify`, `angular#unsafe-bypass`) 정책 등록 시도를 완전히 제거하고, 스크립트 정책 탐색을 `['agy-sb-bm', 'agy-sb-companion-v2']` 및 `WeakMap(window)` 부정 결과 캐싱(`src/drivers/antigravity/companion-driver.js`)으로 제한하여 정책 거부 시 반복적인 `SecurityPolicyViolationEvent` 발생을 차단했습니다.
- **`ANTIGRAVITY_STATUSBAR-D-0034` (`P1`)**: 공유 `__agyOrig_*` 프로토타입 덮어쓰기와 플러그인 간 로딩 플래그 의존을 제거하고 심볼 격리형 참조 카운트 `<ga-remote-control>` 프로토타입 리스 체인(`src/drivers/antigravity/remote-port-driver.js`)을 적용하여 `__agySuppressAutoIframeLoad` / `__agySuppressAutoIframeLoadCount` 억제 가드를 보존하고, 내부 `__agy_probe__` 이벤트를 호스트 핸들러로 누출하지 않고 선포착하며, 교차 출처 iframe 승격에 간섭하지 않고 `targetEl.ownerDocument` 기준으로 자식 문서 UI를 렌더링합니다.
- **호스트 설치 마커 기반 동반 자동 탐색 및 수명주기 정리 (`T-0001`, `D-0001`, `D-0004`, `D-0011`, `D-0015`, `AUDIT-M6`)**: `GetCustomizationStates` / `GetAllPlugins` / `GetAllSkills` 및 `ReadFile`(`UTF-8`, `Uint8Array`, `ArrayBuffer`, `base64` 디코딩)을 통해 호스트의 `statusbar_autoinject.js` 내 0열 `// === BEGIN_AGY_* ===` 및 `/* === BEGIN_AGY_* === */` 블록(`_V\d+` 정규화, 형제 리터럴 하드코딩 0건)만 자동 로드하고 `DisposableScope`로 `1500ms` 재시도 타이머를 즉시 취소합니다(`src/drivers/antigravity/companion-driver.js`, `src/app/index.js`).
- **헥사고날 포트 분리 및 백업 무결성 방어 (`D-0023`, `D-0027`, `D-0029`)**: `StoragePort` 도메인 계약을 분리(`src/ports/contracts.js`, `src/domain/context-window-policy.js`)하고 `resolveCsrfToken(win)`을 `src/drivers/antigravity/host-config.js`로 캡슐화했으며, 손상된 `.orig` ASAR 백업 발견 시 원본 `app.asar`를 건드리지 않고 `FAILED_CORRUPTED_BACKUP`을 반환하도록 `installer/host-patcher.js`를 보강했습니다.

### 4. 검증 및 CI 근거
- **테스트 결과**: `npm test` (`SB2-TC-001` ~ `SB2-TC-012` 단위·UI·통합·설치기·헤드리스 Chromium E2E 전건 통과)
- **대상 브랜치**: `develop` (`main` 병합 전 독립 재검수 대상 `v2.0.0` 후보)
- **CI 실행 워크플로**: [`https://github.com/jaeseongs95/antigravity-statusbar/actions/workflows/ci.yml`](https://github.com/jaeseongs95/antigravity-statusbar/actions/workflows/ci.yml) (`ubuntu-latest` + `windows-latest` 단독 매트릭스)
