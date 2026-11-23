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
