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
- **Test Suite**: `npm test` (static boundary, unit, storage concurrency, Antigravity adapter + live `sidecars/statusbar/main.mjs` subprocess E2E, sidecar security, UI controller + interactive Headless Chromium/Edge CDP E2E)
- **Branch**: `feature/v3-native-plugin` (2-OS GitHub Actions CI `ubuntu-latest` + `windows-latest` & Linux/Windows TEST servers — exact commit SHA and CI run URL recorded in PostgreSQL ledger `ANTIGRAVITY_STATUSBAR-T-0006`)

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
- **테스트 결과**: `npm test` (정적 경계 검사, 코어 단위, 저장소 동시성, Antigravity 어댑터 + 실 `sidecars/statusbar/main.mjs` 서브프로세스 E2E, Sidecar 보안, UI 컨트롤러 + 인터랙티브 Headless Chromium/Edge CDP E2E)
- **브랜치**: `feature/v3-native-plugin` (2-OS GitHub Actions CI `ubuntu-latest` + `windows-latest` 및 Linux/Windows TEST 서버 검증 완료 — 최종 커밋 SHA 및 CI 실행 URL은 PostgreSQL 장부 `ANTIGRAVITY_STATUSBAR-T-0006`에 기록)
