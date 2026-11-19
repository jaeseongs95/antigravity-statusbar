# Antigravity Statusbar (v3.0.0)

공식 **Antigravity 네이티브 플러그인 + 우측 보조패널 Sidecar (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)** 입니다. 세션 컨텍스트 사용량, 프롬프트 캐시 적중률, 계정 할당량, 세션별 소프트 컨텍스트 한도, 토큰 상세 내역, 원클릭 `/compact`를 안전하게 제공합니다.

[English README (README.md)](./README.md)

## v3.0.0 백지 재구축 배경

구버전(v1/v2)은 Electron `app.asar` 바이너리를 패치하고 렌더러 내부(`lsClient`, React Fiber, Protobuf)를 후킹했습니다. Antigravity `2.33.0`의 `@bufbuild/protobuf` v2 전환 이후 렌더러 변조 방식이 채팅 전송 장애를 유발함이 확인되어, **v3.0.0은 공식 네이티브 플러그인 구조로 처음부터 다시 작성**했습니다.

- **`app.asar` 패치 0건**, Electron 렌더러 주입 0건, React Fiber/Protobuf 변조 0건, `hooks.json` 0건.
- **Ports & Adapters 벤더 중립 구조**: `src/core/`와 `src/ui/`에는 벤더 특화 코드가 전혀 없으며, 모든 Antigravity 연동은 `src/adapters/antigravity/`에 격리됩니다.
- **Sidecar 보안 강화**: Fail-Closed 토큰 검증(`>= 16`자), `/api/*` `POST` 전용, `Host`·`Origin` 엄격 검증, SHA-256 `timingSafeEqual`, `16KB` 본문 상한, CORS 미송출, 엄격한 CSP 및 `path.relative` + `realpathSync` 정적 경로 격리.

## 주요 기능 (7종)

1. **실시간 컨텍스트 사용량**: 현재 토큰 / 유효 한도 / %, 압축 직후 즉시 갱신 및 세션 간 엄격 격리.
2. **프롬프트 캐시 적중률**: 프로바이더별 토큰 계산식 반영(`cacheReadTokens` / `inputTokens`).
3. **5시간·7일 계정 할당량**: 모델 그룹별 잔여 비율 및 초기화 남은 시간 표시.
4. **세션별·기본 소프트 컨텍스트 한도 (`32K`–`980K`)**: 전역 엔진 설정(`SetMendelFlagOverrides`)을 건드리지 않는 A안 세션별 소프트 한도 적용 및 초과 경고.
5. **원클릭 `[ compact ]`**: 비동기 `SendUserCascadeMessage` RPC + 미접수 시 유한 `spawn` 폴백 및 세션별 뮤텍스.
6. **`[ context ]` 토큰 상세 내역**: 모델명, 스텝 수, 8개 토큰 그룹별 분포 표시.
7. **`EN` / `KO` 언어 전환**: 즉시 전환 및 설정 영속 저장.

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

Antigravity를 재시작한 뒤 Plugins Manager에서 **Antigravity Statusbar**를 활성화하고 우측 보조패널에서 **Statusbar**를 여세요.

## 검증

```bash
npm test
```

## 라이선스

MIT
