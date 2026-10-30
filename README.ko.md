# antigravity-statusbar

**언어 (Languages):** **[English (README.md)](./README.md)** | **한국어 ([README.ko.md](./README.ko.md))**

**Google Antigravity IDE** (`v2.26.x` / `v2.27.x+`) 채팅 입력창 하단에 장착되는 커스텀 컨텍스트 상태바(`.agy-ctx-statusbar`), **`StatusBarAdapter` 확장 아키텍처**, 세션별 자유 토큰 한도 설정기(`32K`–`980K`), 그리고 업데이트 후에도 자동 복구되는 무결성 보존(`0` 오프셋) `app.asar` + 실시간 CDP 자동 패처입니다.

---

## 주요 기능

- **SOLID 기반 모듈화 아키텍처 (`src/`)**:
  - 단일 책임(SRP)과 의존성 역전(DIP) 기준에 따라 `src/` 하위 9개의 독립 CommonJS 모듈로 역할을 분리하고, 외부 의존성 없는 자체 번들러(`scripts/build.js`)를 통해 단일 런타임 주입 파일(`dist/statusbar_autoinject.js`)을 생성합니다.
- **플러그형 `StatusBarAdapter` 확장 구조 (`v7`)**:
  - 상태바의 코어 슬롯 레이아웃(`.agy-ctx-left`, `.agy-ctx-right`)과 개별 기능 위젯/버튼을 분리했습니다.
  - 기본 내장 버튼 2개(`[ compact ]`, `[ context ]`)와 좌측 지표(`core-metrics`)가 모두 `src/adapters/` 하위의 독립 어댑터 모듈로 동작합니다.
  - 외부 스크립트나 플러그인에서 `window.agyStatusBar.registerAdapter(adapter)` API로 새 버튼이나 상태 위젯을 코어 수정 없이 등록·교체·제거할 수 있습니다.
- **실시간 컨텍스트·캐시·쿼터 표시**:
  - 현재 대화 세션의 컨텍스트 토큰 사용률(`pct%`, `used / limit`), 프롬프트 캐시 적중률(`cache %`), `5h` / `7d` 잔여 쿼터를 채팅 입력창 하단에서 실시간으로 보여줍니다.
- **세션별 컨텍스트 한도 자유 입력 및 프리셋 선택 (`32K` – `980K`)**:
  - 하단바의 `[ 256k ▾ ]` 버튼을 클릭하면 세션별 컨텍스트 한도 설정 메뉴가 열립니다.
  - `32`~`980` (`K` 토큰) 사이의 원하는 값을 직접 입력하거나 프리셋(`128K`, `256K`, `384K`, `512K`, `750K`, `900K`)을 선택할 수 있습니다.
  - 세션 식별자(`cascadeId`)별로 `localStorage`, 쿠키, `nativeStorage`에 영구 보존되며, Redux 전역 기본값을 격리해 특정 세션의 한도 변경이 다른 세션에 영향을 주지 않습니다.
  - 세션 한도가 `256K` 이하(`<= 256K`)일 때는 네이티브 모델 선택기의 `· {cw}` 배지는 유지하면서 노란색 주의 아이콘(`⚠️`)만 숨깁니다.
- **오프셋 보존(`0` drift) `app.asar` 및 샌드박스 `preload.js` 자동 복구 패처**:
  - `app.asar` 내부 `dist/preload.js`, `dist/utils.js`, `dist/main.js`의 원본 바이트 길이를 100% 동일하게 유지하며 패치하고 `ElectronAsarIntegrity` 블록 해시를 갱신합니다.
  - 트레이에서 이미 실행 중인 프로세스에서 새 창을 열거나 앱이 업데이트된 직후에도 `app_storage.json` 동기화 및 실시간 CDP 주입으로 상태바를 즉시 복구합니다.
- **원격 제어(Remote Control) 웹 및 모바일 브라우저 완벽 지원 (`https://antigravity.google.com/r/...`)**:
  - 로컬 HTTP 엔드포인트와 `csrfToken`이 없는 Remote Control 원격 웹 환경에서도 React Fiber 내부의 WebRTC/WebChannel RPC 서비스(`retrieveUserQuotaSummary`, `getCascadeTrajectory`)로 자동 폴백하여 컨텍스트 사용량, 한도 선택, 캐시율, 잔여 쿼터, `[ compact ]`, `[ context ]` 모달이 동일하게 동작합니다.
  - `dist/statusbar_autoinject.js` 상단에 Tampermonkey/AdGuard용 `// ==UserScript==` 헤더가 포함되어 있으며, 확장프로그램을 지원하지 않는 모바일 크롬에서는 아래 주소창 북마클릿으로 즉시 실행할 수 있습니다:
    ```javascript
    javascript:(()=>{fetch('https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js').then(r=>r.text()).then(eval)})();
    ```

---

## 저장소 구조

```text
antigravity-statusbar/
├── src/
│   ├── index.js                   # 모듈 조립 루트(Composition Root) 및 수명주기 관찰자
│   ├── context-window-policy.js   # 컨텍스트 한도 정규화(32K-980K) 및 세션별 영속 저장소
│   ├── host-bridge.js             # Antigravity React Fiber / Redux / Lexical / Object.prototype 브릿지
│   ├── rpc-client.js              # LanguageServer RPC 클라이언트, singleflight 중복 방지 및 LRU 캐시
│   ├── dom-styles.js              # CSS 스타일시트, <=256K 경고 숨김 동적 CSS, TrustedHTML 및 포맷터
│   ├── adapter-registry.js        # StatusBarAdapter 레지스트리 및 슬롯 렌더러 (OCP / DIP 경계)
│   └── adapters/
│       ├── core-metrics.js        # 좌측 슬롯 지표 + 세션별 컨텍스트 한도 드롭다운 메뉴
│       ├── compact-button.js      # 우측 슬롯 `[ compact ]` 버튼 어댑터
│       └── context-button.js      # 우측 슬롯 `[ context ]` 버튼 어댑터 + Trajectory 디버그 모달
├── dist/
│   └── statusbar_autoinject.js    # Electron / CDP 주입용 단일 파일 런타임 번들 산출물
├── scripts/
│   ├── build.js                   # 무의존성 CommonJS 번들러 (src/ -> dist/statusbar_autoinject.js)
│   ├── ensure_statusbar_patch.js  # 오프셋 보존 ASAR 패처 + app_storage 동기화 + 실시간 CDP 주입기
│   └── install.js                 # 번들 빌드 후 ~/.gemini/antigravity 설치 및 패처 실행
├── test/
│   └── statusbar.test.js          # 개별 모듈 단위 테스트 + 런타임 번들 통합 테스트
├── README.md                      # 영문 안내 문서 (English)
├── README.ko.md                   # 국문 안내 문서 (Korean)
└── package.json
```

---

## 하단바 기능 확장 (`StatusBarAdapter` API)

런타임에서 `window.agyStatusBar`를 통해 버튼이나 커스텀 위젯을 손쉽게 추가·제거할 수 있습니다:

```js
// 1. 우측 슬롯에 커스텀 버튼 어댑터 등록
const dispose = window.agyStatusBar.registerAdapter({
  id: 'my-custom-btn',
  slot: 'right',          // 'left' | 'right' (기본값: 'right')
  order: 30,              // 숫자가 작을수록 먼저 배치됨 (compact=10, context=20)
  label: '[ clear ]',     // 문자열 또는 (ctx) => string 함수
  title: '현재 세션에서 커스텀 작업 실행',
  className: 'agy-ctx-btn',
  onClick(ctx, event) {
    console.log('세션 ID:', ctx.cascadeId, '현재 컨텍스트 한도:', ctx.getConversationContextWindow());
  },
  unmount() {
    // 어댑터 해제 또는 교체 시 정리 작업(선택)
  }
});

// 2. 등록 해제
dispose(); // 또는 window.agyStatusBar.unregisterAdapter('my-custom-btn');
```

---

## 설치 및 사용법

```bash
# dist/statusbar_autoinject.js 빌드 후 ~/.gemini/antigravity 에 설치 및 즉시 주입
npm run install-statusbar

# ASAR 패치 및 CDP 주입 상태 확인
npm run status

# 번들 빌드 및 단위·통합 테스트 실행
npm test
```

## 라이선스

MIT
