# Antigravity Statusbar (v3.4.1)

공식 **Antigravity 네이티브 플러그인 (`AddonManifest.v3` API-First 신뢰 승인 상태바 + `host.statusbar` 제공자 + Native Host `v3.1.1` 중앙 원격 브리지 + 헤드리스 네이티브 Sidecar)** 입니다. 데스크톱 채팅 입력창 아래 및 원격 웹(`antigravity-remote-web`)에서 실시간 컨텍스트 사용량, 서브에이전트 모델 배지, 프롬프트 캐시 적중률, 로컬 시각 기반 5시간·주간 계정 한도, 4단계 컨텍스트 한도(`현재 세션 > 모델별 전역 > 일괄 전역 > 호스트 기본값`), 작업 중단 없는 가드된 자동 압축·자동 재개, 토큰 상세 내역, 원클릭 `/compact`를 제공합니다.

[English README (README.md)](./README.md)

## v3.4.1 아키텍처 (`AddonManifest.v3` API-First + Extenra `v3.3.2+` 헤더 언어 스위치·동적 제목 연동)

**v3.4.1**은 [Extenra](https://github.com/jaeseongs95/extenra)(구 `antigravity-addons`) **`>= 3.3.2`** (`AddonManifest.v3` + `AddonContextV3`, Extenra `v3.3.3` 검증 완료) 표준에서 최소 권한 `trustLevel: "trusted"`로 동작하며, 본문 하단의 중복 언어 선택 섹션을 제거하고 Extenra 호스트 공용 설정 헤더 `[ 한국어 | EN ]` 토글(`showLocaleSwitch: true`, `getTitle()`, `OverlayHandle.setTitle()`)과 호스트 단일 진실 원천 기반 `ctx.i18n` 실시간 동기화를 적용했습니다.

- **3-Tier API-First UI (수동 오버레이 DOM·좌표 계산 제거)**:
  - **Tier 1**: 통합 설정 페이지(`ctx.ui.registerSettingsPage` — Desktop Settings 인라인 본문 및 Remote Web 공용), 명령(`ctx.ui.registerCommand`), 토스트 알림(`ctx.ui.showToast`).
  - **Tier 2**: 컨텍스트 상세 팝업(`ctx.ui.openPopup`)과 전역 컨텍스트 한도 모달(`ctx.ui.openModal`)을 선언형 스키마(`handle.update(nextTree, nextState)` ID 인플레이스 패치)로 전환해 자동 뷰포트 플립/시프트 및 모바일(`<=640px`) 바텀시트 전환을 지원합니다.
  - **Tier 3**: `--ag-*` 다크/라이트 테마 토큰을 따르는 인라인 상태바 캔버스(`ctx.ui.mountCanvas`).
- **Well-Known `host.statusbar` 서비스 제공**: `permissions.services.provide: [{ name: "host.statusbar", allowedCallers: ["*"] }]`를 선언해 다른 플러그인이 `ctx.ui.registerStatusItem(...)`으로 등록한 상태바 항목을 데스크톱과 원격 웹 모두에서 자연스럽게 표시합니다.
- **Native Host `v3.1.1` 중앙 관리형 원격 브리지**: 상태바 설정 화면의 독자 원격 Sidecar URL/토큰 입력 UI, 브라우저 자격 증명 저장소, 독자 원격 HTTPS 직결 경로를 모두 제거했습니다. 데스크톱과 원격 웹 모두 동일한 `ctx.net.fetch`(`permissions.net.localLoopback: ["antigravity-sidecar"]`) + `ctx.settingsBridge` 경로를 사용하며, 원격 웹에서는 호스트 드로어의 **Addons → Host Bridge** 탭에서 한 번만 페어링하면 투명하게 연동됩니다. 미연결(`ERR_REMOTE_HOST_NOT_CONNECTED`) 상태에서는 `host:remote-bridge-changed` 이벤트를 구독해 읽기 전용 상태 배지와 연결 안내만 표시합니다.
- **신뢰 승인 불변 정적 렌더러**: `scripts/install-plugin.mjs`가 자격 증명이 없는 결정론적 `runtime/statusbar-renderer.js`를 생성해 SHA-256 신뢰 핀을 유지합니다. Sidecar는 기동 시 `HOST_DATA_DIR/antigravity-statusbar-runtime.json`(`settingsBridge`)에만 루프백 URL·256-bit 토큰을 원자적(`0o600`)으로 기록하고 종료 시 `mode: "standby"`로 회수합니다.
- **벤더 중립 아키텍처 및 Sidecar 보안**: `src/core/`와 `src/ui/`는 100% 벤더 중립이며 `app.asar` 패치·렌더러 내부 후킹 없이 동작합니다. Fail-Closed 토큰 검증, `/api/*` `POST` 전용, `Host`·`Origin` 엄격 검증, SHA-256 `timingSafeEqual`, 종료 시 동기 `teardownSync()` 토큰 회수를 유지합니다.

## 주요 기능

1. **실시간 컨텍스트 사용량**: 현재 토큰 / 유효 한도 / %(한도 미도달 99.5~99.9% 구간 `99%` 표시), 압축 직후 즉시 갱신 및 세션 간 엄격 격리.
2. **서브에이전트 모델 배지 및 포커스 고정**: 서브에이전트 뷰(`[data-testid="subagent-tab-conversation"]`)에 현재 모델 배지를 표시하고 클릭·포커스 전환 시 대상 세션을 안정적으로 고정합니다.
3. **프롬프트 캐시 적중률**: 프로바이더별 토큰 계산식 반영(`cacheReadTokens` / `inputTokens`).
4. **로컬 시각 기반 5시간·주간 계정 한도**: 5시간 한도 옆에 로컬 `HH:mm` 초기화 시각을 표시하고(툴팁에 전체 로컬 일시 표시), 초기화 시각 경과·창 포커스 복귀·클릭 시 자동 강제 갱신합니다.
5. **4단계 컨텍스트 한도 (`32K`–`980K`) 및 전역 한도 모달**: `현재 세션 > 모델별 전역 > 일괄 전역 > 호스트 기본값` 우선순위를 적용하며 전역 엔진 플래그(`SetMendelFlagOverrides`)는 건드리지 않습니다.
6. **작업 중단 없는 가드된 자동 압축·자동 재개 (`autoCompactWhileRunning`)**:
   - `'resume'`(기본값): 에이전트가 작업 중(`RUNNING`) 한도에 도달하면 즉시 `/compact`를 실행하고 `IDLE` 안착 즉시 1회성 이어하기 프롬프트를 전송합니다(연속 3회 서킷 브레이커 보호).
   - `'defer'`: 진행 중인 턴이 `IDLE`로 끝날 때까지 압축을 지연(`압축 대기` 배지)한 뒤 압축합니다.
7. **원클릭 `[ compact ]`, 요약 문구 설정 및 `StatusbarAddon.v1`**: 세션별 뮤텍스, 편집 가능한 `/compact <문구>`, `scripts/statusbar-addon.mjs` 커스텀 버튼 관리 및 `EN` / `KO` 언어 전환.

## 설치 방법

Antigravity Desktop에 [Extenra](https://github.com/jaeseongs95/extenra)(구 `antigravity-addons`) `>= 3.3.2`이 설치되어 있어야 합니다.

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar
npm ci --omit=dev
npm run install-plugin
```

설치 후 `antigravity-addons`에 `addon-manifest.v3.json`을 등록하고 `trustLevel: "trusted"`(불변 `runtime/statusbar-renderer.js` SHA-256 핀)를 승인한 뒤, 원격 웹을 사용하는 경우 원격 웹 번들을 다시 빌드합니다(`--include-settings-snapshots` 플래그는 절대 추가하지 마십시오):

```bash
# antigravity-addons 설치 경로에서 실행
node bin/addon-host.js --register ~/.gemini/config/plugins/antigravity-statusbar/addon-manifest.v3.json
node bin/addon-host.js trust approve antigravity-statusbar
# 선택: 원격 웹 번들 재빌드 (--include-settings-snapshots 제외)
node bin/addon-host.js --build-remote --out-dir ~/.gemini/antigravity/remote-dist
```

플러그인 복사 전 미리보기:

```bash
node scripts/install-plugin.mjs --dry-run
```

Antigravity를 재시작한 뒤 Plugins Manager에서 **Antigravity Statusbar**를 활성화하세요. 원격 웹에서는 데스크톱 **설정 → 애드온 관리 → 원격 호스트 브리지**를 활성화한 뒤 원격 웹 우측 하단 **Addons → Host Bridge** 탭에서 한 번만 페어링하면 됩니다.

## 검증

```bash
npm test
```

## 라이선스

MIT
