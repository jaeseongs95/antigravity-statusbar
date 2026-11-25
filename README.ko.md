# Antigravity Statusbar (v3.2.0)

공식 **Antigravity 네이티브 플러그인 (`AddonManifest.v2` 신뢰 승인 인라인 상태바 + 원격 웹 지원 + 헤드리스 네이티브 Sidecar)** 입니다. 데스크톱 채팅 입력창 아래 및 원격 웹(`antigravity-remote-web`)에서 실시간 컨텍스트 사용량, 프롬프트 캐시 적중률, 5시간·주간 계정 한도, 4단계 컨텍스트 한도(`현재 세션 > 모델별 전역 > 일괄 전역 > 호스트 기본값`), 작업 중단 없는 가드된 자동 압축·자동 재개, 토큰 상세 내역, 원클릭 `/compact`를 안전하게 제공합니다.

[English README (README.md)](./README.md)

## v3.2.0 아키텍처 (신뢰 승인 정적 렌더러 + `settingsBridge` + 원격 웹 지원)

구버전(v1/v2)은 Electron `app.asar` 바이너리를 패치하고 렌더러 내부(`lsClient`, React Fiber, Protobuf)를 후킹했습니다. **v3.2.0**은 공식 네이티브 플러그인과 [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons)(구 `antigravity-native-addon-host`) **`>= 2.3.0`**(`v2.5.3+` 권장) 위에서 `trustLevel: "trusted"`로 동작합니다.

- **`app.asar` 패치 0건**, Electron 렌더러 변조 0건, React Fiber/Protobuf 후킹 0건, `hooks.json` 0건.
- **신뢰 승인 불변 정적 렌더러 (`trustLevel: "trusted"`)**: `scripts/install-plugin.mjs`가 자격 증명이 전혀 포함되지 않은 100% 정적·결정론적 `runtime/statusbar-renderer.js`를 생성하며, `antigravity-addons`의 SHA-256 신뢰 핀과 엄격한 AST 검사(HTML sink·`eval`·`new Function`·`require` 0건)를 통과합니다. Sidecar는 기동·종료 시 `runtime/statusbar-renderer.js`를 **절대 수정하지 않습니다**.
- **데스크톱 `settingsBridge` 실시간 자격 증명 전달**: `antigravity-desktop`에서 Sidecar는 기동 시 `HOST_DATA_DIR/antigravity-statusbar-runtime.json`(`settingsBridge`)에만 루프백 URL과 256-bit 토큰을 원자적(`0o600`)으로 기록하고 종료 시 `mode: "standby"`로 회수합니다. 선택적으로 `STATUSBAR_SIDECAR_PORT`(`1024`~`65535`) 고정 포트를 지원하며 충돌(`EADDRINUSE`) 시 임시 포트로 자동 폴백합니다.
- **원격 웹(`antigravity-remote-web`) 지원**: `hostProfiles: ["antigravity-desktop", "antigravity-remote-web"]` 및 `uiSlots[0].anchor: "status-bar"`를 선언합니다. 원격 웹 DOM에 `[data-testid="agent-input-box"]`가 없으면 호스트 `status-bar` 앵커/`#remote-addon-host-slot-dock`에 자동 마운트됩니다. 미설정 상태에서는 네트워크 요청 0건으로 기동하고 `packed-initial` 스냅샷을 심층 방어로 무시하며, 설정 탭의 **원격 Sidecar 연결** UI에서 사용자가 입력한 루프백 HTTP 또는 HTTPS 주소·토큰을 `addonHost.saveSettings(...)`로 브라우저 로컬 저장소에만 보관합니다.
  - **보안 주의**: `addon-host --build-remote` 실행 시 `--include-settings-snapshots` 옵션을 절대 함께 사용하지 마십시오(데스크톱 런타임 토큰이 정적 원격 웹 번들에 평문 포함될 수 있습니다).
  - **실사이트 CSP 참고**: `https://antigravity.google.com`에서의 실제 `fetch` 허용 여부는 대상 사이트의 `connect-src` CSP 및 브라우저 PNA 정책에 따라 달라지므로 배포 후 실브라우저 검증이 필요합니다.
- **Ports & Adapters 벤더 중립 구조**: `src/core/`와 `src/ui/`에는 벤더 특화 코드가 전혀 없으며, 모든 Antigravity 연동은 `src/adapters/antigravity/`에 격리됩니다.
- **Sidecar 보안 강화**: Fail-Closed 토큰 검증(명시 토큰 `>= 16`자, 헤드리스 모드에서 미설정 시 프로세스별 256-bit 임시 암호 토큰 발급), `/api/*` `POST` 전용, `Host`·`Origin` 엄격 검증(`Access-Control-Allow-Private-Network: true` 포함), SHA-256 `timingSafeEqual`, `16KB` 본문 상한, 엄격한 CSP, `path.relative` + `realpathSync` 정적 경로 격리, 종료 시 동기 `teardownSync()` 토큰 회수.

## 주요 기능

1. **실시간 컨텍스트 사용량**: 현재 토큰 / 유효 한도 / %(한도 미도달 99.5~99.9% 구간 `99%` 표시), 압축 직후 즉시 갱신 및 세션 간 엄격 격리.
2. **프롬프트 캐시 적중률**: 프로바이더별 토큰 계산식 반영(`cacheReadTokens` / `inputTokens`).
3. **5시간·주간 계정 한도**: 모델 그룹별 5시간 한도와 주간한도(기타 윈도우는 실제 라벨) 및 툴팁 리셋 시각 표시.
4. **4단계 컨텍스트 한도 (`32K`–`980K`) 및 전역 한도 모달**: `현재 세션 > 모델별 전역 > 일괄 전역 > 호스트 기본값` 우선순위를 적용하며 전역 엔진 플래그(`SetMendelFlagOverrides`)는 건드리지 않습니다.
5. **작업 중단 없는 가드된 자동 압축·자동 재개 (`autoCompactWhileRunning`)**:
   - `'resume'`(기본값): 에이전트가 작업 중(`RUNNING`) 한도에 도달하면 즉시 `/compact`를 실행하고, 일시적 `RUNNING` 전환 구간을 견디며 체크포인트 완료 상태를 래치한 뒤 `IDLE` 안착 즉시 1회성 이어하기 프롬프트(`agentapi send-message` 우선 + `SendUserCascadeMessage` RPC 폴백)를 전송해 중단된 작업을 자동으로 재개합니다(수동 `/compact`, 기존 `IDLE` 세션, 사용자 취소·오류, 호스트 자체 재개, 수동 입력 개입, 연속 3회 서킷 브레이커 초과 시 미전송; 전송 실패 시 `AUTO_RESUME_FAILED` 노출).
   - `'defer'`: 진행 중인 턴이 `IDLE`로 끝날 때까지 압축을 지연(`압축 대기` 배지)한 뒤 안전하게 압축합니다.
   - 백그라운드 스윕은 식별 가능한 서브에이전트 세션을 기본 제외합니다.
6. **원클릭 `[ compact ]` 및 요약 문구 설정**: 비동기 `SendUserCascadeMessage` RPC + 미접수 시 유한 `spawn` 폴백, 세션별 뮤텍스, 편집 가능한 `/compact <문구>`.
7. **상태바 애드온 (`StatusbarAddon.v1`) & `EN` / `KO` 언어 전환**: `scripts/statusbar-addon.mjs` 원자적 락 보호 버튼 관리 및 즉시 언어 전환.

## 설치 방법

Antigravity Desktop에 [`antigravity-addons`](https://github.com/jaeseongs95/antigravity-addons)(구 `antigravity-native-addon-host`) `>= 2.3.0`이 설치되어 있어야 합니다.

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar
npm ci --omit=dev
npm run install-plugin
```

설치 후 `antigravity-addons`에 `v3.2.0` 매니페스트를 등록하고 `trustLevel: "trusted"`(불변 `runtime/statusbar-renderer.js` SHA-256 핀)를 승인한 뒤, 원격 웹을 사용하는 경우 원격 웹 번들을 다시 빌드합니다(`--include-settings-snapshots` 플래그는 절대 추가하지 마십시오):

```bash
# antigravity-addons 설치 경로에서 실행
node bin/addon-host.js --register ~/.gemini/config/plugins/antigravity-statusbar/addon-manifest.v2.json
node bin/addon-host.js trust approve antigravity-statusbar
# 선택: 원격 웹 번들 재빌드 (--include-settings-snapshots 제외)
node bin/addon-host.js --build-remote --out-dir ~/.gemini/antigravity/remote-dist
```

플러그인 복사 전 미리보기:

```bash
node scripts/install-plugin.mjs --dry-run
```

Antigravity를 재시작한 뒤 Plugins Manager에서 **Antigravity Statusbar**를 활성화하면 채팅 입력창 바로 아래에 인라인 상태바가 자동으로 표시됩니다.

## 검증

```bash
npm test
```

## 라이선스

MIT
