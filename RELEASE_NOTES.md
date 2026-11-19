# Release Notes / 릴리스 노트

## v3.0.0 — Clean-Slate Official Native Plugin / 공식 네이티브 플러그인 백지 재구축

### Breaking Changes / 주요 변경 사항
- **EN**: Removed all `app.asar` patching, Electron renderer injection, UserScript bundling, React Fiber/Protobuf hooking, `hooks.json`, and Remote Control Web bookmarklet/iframe code. Rebuilt from scratch as an official Antigravity Native Plugin (`plugin.json` + `sidecars/statusbar/sidecar.json` with `SIDECAR_UI_ENTRYPOINT_AUX_PANE`).
- **KO**: 모든 `app.asar` 패치, Electron 렌더러 주입, UserScript 번들링, React Fiber/Protobuf 후킹, `hooks.json` 및 원격 웹 북마클릿/iframe 코드를 전면 삭제하고 공식 Antigravity 네이티브 플러그인(`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)으로 처음부터 재구축했습니다.

### Architecture & Security / 아키텍처 및 보안
- **EN**: Strict Ports & Adapters separation (`src/core/` and `src/ui/` 100% vendor-neutral); Fail-Closed Sidecar auth (`>= 16` char token), `POST`-only `/api/*` (`405` + zero CORS), `Host`/`Origin` validation, SHA-256 `timingSafeEqual`, `16KB` body cap (`413` + `Connection: close`), strict CSP (`vscode-webview:` / `vscode-file:` / `file:`), and `path.relative` + `realpathSync` static jail.
- **KO**: 엄격한 Ports & Adapters 벤더 중립 분리(`src/core/`, `src/ui/`), Fail-Closed Sidecar 인증(`>= 16`자 토큰), `/api/*` `POST` 전용(`405` + 무CORS), `Host`/`Origin` 검증, SHA-256 `timingSafeEqual`, `16KB` 본문 상한(`413` + `Connection: close`), 엄격 CSP 및 `path.relative` + `realpathSync` 정적 경로 격리를 적용했습니다.

### Reliability & Protocol Accuracy / 안정성 및 프로토콜 정확도
- **EN**: Real Antigravity Language Server schema support (`compactedAtStepIndices[]`, `boolean|number` `estimatedAfterCompaction`, `trajectorySlice.totalGeneratorMetadataLength`, `chatStartMetadata.contextWindowMetadata.tokenBreakdown.groups[].numTokens`, `response.groups/displayName/remaining.case`), fail-closed `conversationId` isolation, synchronous `attemptToken` compaction mutex, safe `settings.lock` stale recovery, and bounded `spawn` fallback.
- **KO**: 실 Antigravity Language Server 스키마 반영, `conversationId` Fail-Closed 세션 격리, 동기 `attemptToken` 기반 압축 뮤텍스, 안전한 `settings.lock` 스테일 복구 및 유한 `spawn` 폴백을 구현했습니다.
