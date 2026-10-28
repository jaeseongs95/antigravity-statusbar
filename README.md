# Antigravity Custom Statusbar (`antigravity-statusbar`)

Google Antigravity 2.0 전용 **커스텀 컨텍스트·쿼터 상태바 및 자동 복구 패치(`v7` / `ASAR v5`)**입니다.

채팅 입력창 하단에 실시간 컨텍스트 사용량, 프롬프트 캐시 적중률, 5시간/주간 쿼터 잔여량을 표시하고, **어댑터(`StatusBarAdapter`) 기반 확장 구조**, **세션별(`cascadeId`) 독립 컨텍스트 한도 설정(프리셋 및 `32K`~`980K` 직접 입력)**, **앱 업데이트 시 자동 복구**를 지원합니다.

---

## 주요 기능

1. **실시간 컨텍스트·캐시·쿼터 상태바 (`.agy-ctx-statusbar`)**
   - 현재 세션의 컨텍스트 사용률(`ctx %`), 사용 토큰 / 설정 한도(`used / [ limit ▾ ]`), 프롬프트 캐시 적중률(`cache %`), 5시간(`5h`) 및 주간(`7d`) 쿼터 잔여량과 초기화 시각을 실시간으로 표시합니다.
   - `versionKey`(`totalGeneratorMetadataLength:totalStepsLength`) 기반 캐시와 singleflight 중복 제거로 불필요한 네트워크 RPC 호출 없이 0ms 즉시 렌더링합니다.

2. **세션별(`cascadeId`) 컨텍스트 한도 독립 설정 및 직접 입력 (`32K` ~ `980K`)**
   - 상태바의 `[ 256k ▾ ]` 버튼을 클릭하면 현재 세션의 컨텍스트 한도를 변경할 수 있는 팝업 메뉴가 열립니다.
   - **직접 입력**: `32` ~ `980` 사이의 원하는 숫자를 직접 입력해 `200K`, `350K`, `400K` 등 임의의 컨텍스트 한도를 세션별로 설정할 수 있습니다 (`Object.prototype` 비열거형 getter를 통해 Antigravity v2.27+ 내부 토큰/툴팁 맵 `ugb`·`vgb`와 자동 연동).
   - **프리셋 선택**: `128K`, `256K`, `384K`, `512K`, `750K`, `900K` 프리셋 및 `Shift+클릭` 빠른 순환(`256K → 512K → 900K`)을 지원합니다.
   - **영구 보존 및 세션 격리**: `localStorage` + `cookie` + `nativeStorage`(`app_storage.json`) 3중 저장과 Redux 전역 기본값 격리를 통해 한 세션의 한도를 바꿔도 다른 세션이나 새 세션에 영향을 주지 않습니다.

3. **모델 선택기 버튼(`ModelSelectorButton`) 주의 아이콘(`⚠️`) 스마트 제어**
   - Antigravity 기본 UI가 `256K`가 아닌 모든 컨텍스트 값에 노란색 주의 아이콘(`⚠️`)을 표시하는 문제를 해결하여, 기본 한도(`256K`) 이하(`32K`~`256K`)로 설정했을 때는 `· 200K` 텍스트 배지는 그대로 유지하면서 불필요한 노란색 주의 아이콘만 숨깁니다 (`256K` 초과 시에만 주의 아이콘 표시).

4. **어댑터(`StatusBarAdapter`) 아키텍처 및 기본 액션 버튼 어댑터 (`compact`, `context`)**
   - 하단바 코어 레이아웃(`.agy-ctx-left`, `.agy-ctx-right`)과 개별 기능을 분리하여 `window.agyStatusBar.registerAdapter(adapter)` / `unregisterAdapter(id)` 계약으로 기능을 동적으로 추가·교체·제거할 수 있습니다.
   - 기본 우측 버튼 두 개(`[ compact ]`, `[ context ]`)와 좌측 지표(`core-metrics`) 모두 이 어댑터 계약으로 등록되어 동작합니다:
     - `compact` 어댑터 (`slot: 'right'`, `order: 10`): Lexical 에디터에 `/compact` 시스템 슬래시 명령과 구조화된 요약 프롬프트를 자동 삽입·전송합니다.
     - `context` 어댑터 (`slot: 'right'`, `order: 20`): 현재 세션의 Token Breakdown, Prompt Sections, 최근 Generator 턴별 토큰 사용량(`Est. Ctx`, `Cache Read`, `Fresh Input`, `Output (+Think)`)을 보여주는 상세 모달을 엽니다.

```js
// 커스텀 하단바 버튼 어댑터 등록 예시
const dispose = window.agyStatusBar.registerAdapter({
  id: 'my-custom-action',
  slot: 'right',
  order: 30,
  label: '[ custom ]',
  title: '사용자 정의 액션 실행',
  onClick({ cascadeId, view, inputBox }) {
    console.log('Clicked on session:', cascadeId);
  }
});
```

5. **Antigravity 업데이트 후 무결성 보존 자동 복구 (`ensure_statusbar_patch.js`)**
   - `app.asar` 내부 `dist/preload.js`, `dist/utils.js`, `dist/main.js`를 **원본 바이트 크기·파일 오프셋 100% 일치(`0` offset drift)** 방식으로 패치하고 `%APPDATA%\Antigravity\app_storage.json`과 동기화하여, 트레이 상주 상태에서 새 창을 열거나 앱이 업데이트된 뒤에도 자동으로 상태바를 복구합니다.
   - 이미 열려 있는 Antigravity 창에는 Chrome DevTools Protocol(CDP) `Runtime.evaluate`를 통해 재시작 없이 즉시 주입합니다.

---

## 설치 및 사용법

```bash
# 저장소 클론 후 즉시 설치 및 현재 열린 Antigravity 창에 주입
npm run install-statusbar

# 패치 상태 확인
npm run status

# 수동 패치 및 CDP 즉시 재주입
npm run patch

# 단위 테스트 실행
npm test
```

## 라이선스

MIT License
