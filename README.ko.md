# Antigravity Statusbar (v3.1.3)

공식 **Antigravity 네이티브 플러그인 (`AddonManifest.v2` 인라인 상태바 + 헤드리스 네이티브 Sidecar)** 입니다. 채팅 입력창 바로 아래에서 실시간 컨텍스트 사용량, 프롬프트 캐시 적중률, 5시간·주간 계정 한도, 4단계 컨텍스트 한도(`현재 세션 > 모델별 전역 > 일괄 전역 > 호스트 기본값`), 작업 중단 없는 가드된 자동 압축·자동 재개, 토큰 상세 내역, 원클릭 `/compact`를 안전하게 제공합니다.

[English README (README.md)](./README.md)

## v3.1.3 아키텍처 (`AddonManifest.v2` 인라인 상태바 + 헤드리스 네이티브 Sidecar)

구버전(v1/v2)은 Electron `app.asar` 바이너리를 패치하고 렌더러 내부(`lsClient`, React Fiber, Protobuf)를 후킹했습니다. **v3.1.3**는 공식 네이티브 플러그인과 `antigravity-native-addon-host` v2 (`AddonManifest.v2`) 위에서 동작합니다.

- **`app.asar` 패치 0건**, Electron 렌더러 변조 0건, React Fiber/Protobuf 후킹 0건, `hooks.json` 0건.
- **Shadow DOM 격리 인라인 UI (`AddonManifest.v2`)**: 호스트가 소유한 Shadow DOM 슬롯(`status-bar`, `overlay` 팝오버, `modal` `<dialog>`)으로 렌더링하며 `window`/DOM에 토큰이나 호스트 핸들을 노출하지 않습니다. 불필요한 우측 `AUX_PANE` 탭은 제거했습니다(`sidecar.json` `has_web_ui: false`).
- **Ports & Adapters 벤더 중립 구조**: `src/core/`와 `src/ui/`에는 벤더 특화 코드가 전혀 없으며, 모든 Antigravity 연동은 `src/adapters/antigravity/`에 격리됩니다.
- **Sidecar 보안 강화**: Fail-Closed 토큰 검증(명시 토큰 `>= 16`자, 헤드리스 모드에서 미설정 시 프로세스별 256-bit 임시 암호 토큰 발급), `/api/*` `POST` 전용, `Host`·`Origin` 엄격 검증, SHA-256 `timingSafeEqual`, `16KB` 본문 상한, 엄격한 CSP, `path.relative` + `realpathSync` 정적 경로 격리, 종료 시 동기 `teardownSync()` 토큰 회수.

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

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar
npm ci --omit=dev
npm run install-plugin
```

설치 전 미리보기:

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
