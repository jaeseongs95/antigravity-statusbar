# antigravity-statusbar (`v1.3.21` / `v27`)

**언어 (Languages):** **[English (README.md)](./README.md)** | **한국어 ([README.ko.md](./README.ko.md))**

**Google Antigravity IDE (`v2.26.x` – `v2.29.x+`)** 채팅 입력창 하단에 장착되는 커스텀 컨텍스트 상태바(`.agy-ctx-statusbar`), 세션별 자유 토큰 한도 설정기(`32K`–`980K`) 및 백엔드 체크포인터(`max_token_limit`) 실시간 동기화, 플러그형 **`StatusBarAdapter`** 확장 API, 무결성 보존(`0` 오프셋) `app.asar` + 실시간 CDP 자동 패처, 그리고 **원격 제어 웹(`https://antigravity.google.com/r/...`) 북마클릿·유저스크립트**를 지원하는 통합 확장 도구입니다.

---

## 목차 (Table of Contents)

1. [개요 및 핵심 기능](#개요-및-핵심-기능)
2. [데스크톱 앱 설치 및 사용법 (로컬 PC)](#데스크톱-앱-설치-및-사용법-로컬-pc)
3. [원격 제어 웹(Remote Control) 북마클릿 & 유저스크립트 안내](#원격-제어-웹remote-control-북마클릿--유저스크립트-안내)
4. [상태바 UI 구성 및 조작 안내](#상태바-ui-구성-및-조작-안내)
5. [호스트 설치 맞춤형 동반 플러그인 자동 로드](#호스트-설치-맞춤형-동반-플러그인-자동-로드)
6. [하단바 기능 확장 (`StatusBarAdapter` API)](#하단바-기능-확장-statusbaradapter-api)
7. [저장소 구조](#저장소-구조)
8. [검증 및 테스트](#검증-및-테스트)

---

## 개요 및 핵심 기능

- **실시간 컨텍스트·캐시·쿼터 표시 및 `Compacting` 직후 반영**:
  - 현재 대화 세션의 컨텍스트 토큰 사용률(`pct%`, `used / limit`), 프롬프트 캐시 적중률(`cache %`), `5h` / `7d` 잔여 쿼터를 채팅 입력창 하단에서 실시간으로 보여줍니다.
  - 대화 압축(`Compacting`)이 완료된 직후 새 메시지를 보내기 전에도 `agentStateProvider.getContextEstimate().estimatedAfterCompaction` 수치를 상태바와 `[ context ]` 디버그 모달 양쪽에 즉시 반영합니다.
- **세션별 컨텍스트 한도 자유 입력(`32K` – `980K`) 및 백엔드 체크포인터(`max_token_limit`) 동기화**:
  - 하단바의 `[ 256k ▾ ]` 버튼을 클릭해 프리셋(`128K`, `256K`, `384K`, `512K`, `750K`, `900K`)을 선택하거나 `32`~`980` (`K` 토큰) 사이의 원하는 값을 직접 입력할 수 있습니다.
  - `SendUserCascadeMessage` 요청(`fetch` `Request` 객체, 일반 JSON, 5바이트 Connect 프레임 JSON, Protobuf 바이너리 모두 포함) 전송 시 `cascadeConfig.checkpointConfig.maxTokenLimit`(`field 5`)에 선택된 토큰 한도(예: `384000`)를 주입하여 백엔드 `language_server.exe`가 기본값 `256K`에서 조기 압축하지 않고 사용자가 지정한 한도를 그대로 따르도록 동기화합니다.
  - 세션 식별자(`cascadeId`)별로 `localStorage`, 쿠키, `nativeStorage` 및 서버 어노테이션(`agyCwLimit`)에 저장되어 데스크톱과 모바일·원격 웹 간에 자동 동기화되며, Redux 전역 기본값을 격리해 다른 대화방을 오염시키지 않습니다.
  - 세션 한도가 `256K` 이하(`<= 256K`)일 때는 네이티브 모델 선택기의 `· {cw}` 배지는 유지하면서 노란색 주의 아이콘(`⚠️`)만 깔끔하게 숨깁니다.
- **오프셋 보존(`0` drift) `app.asar` 패처 및 무재시작 실시간 CDP 주입**:
  - `app.asar` 내부 `dist/preload.js`, `dist/utils.js`, `dist/main.js`의 바이트 길이를 100% 동일하게 유지하며 패치하고 `ElectronAsarIntegrity` 블록 해시를 갱신합니다.
  - 이미 실행 중인 Antigravity 창에도 Chrome DevTools Protocol(CDP)로 즉시 주입되어 앱을 재시작할 필요가 없습니다.
- **원격 제어 웹(`https://antigravity.google.com/r/...`) 및 호스트 설치 맞춤형 동반 로드**:
  - 최상위 `<ga-remote-control>` Angular 호스트 셸(`RemoteControlComponent.prototype.proxyCommand`)과 내부 React Fiber WebRTC/WebChannel RPC 서비스(`retrieveUserQuotaSummary`, `getCascadeTrajectoryGeneratorMetadata`, `getCascadeTrajectory`)를 자동으로 연결합니다.
  - 원격 웹에서 북마클릿 실행 시 호스트 PC에 실제로 설치된 동반 플러그인(`antigravity-mcp-manager`, `ko-thought-translator`)만 감지해 함께 로드합니다.
- **플러그형 `StatusBarAdapter` 확장 구조 (`v7`)**:
  - 코어 슬롯(`.agy-ctx-left`, `.agy-ctx-right`)과 개별 위젯/버튼(`core-metrics`, `[ compact ]`, `[ context ]`)을 분리하여 `window.agyStatusBar.registerAdapter(adapter)`로 손쉽게 커스텀 위젯을 추가·제거할 수 있습니다.

---

## 데스크톱 앱 설치 및 사용법 (로컬 PC)

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar

# 1. 단위 테스트 및 번들 통합 회귀 테스트 실행 (17/17 통과)
npm test

# 2. dist/statusbar_autoinject.js 빌드, ~/.gemini/antigravity 설치, app.asar 패치 및 CDP 즉시 주입
npm run install-statusbar

# 3. ASAR 패치 및 실시간 CDP 주입 상태 확인
npm run status
```

---

## 원격 제어 웹(Remote Control) 북마클릿 & 유저스크립트 안내

외부 PC나 태블릿·스마트폰 브라우저(Chrome / Safari / Edge)에서 **`https://antigravity.google.com/r/...`** 원격 제어 웹으로 접속할 때는 로컬 PC의 Electron `preload.js`가 원격 브라우저에서 자동 실행되지 않습니다. 아래 **북마클릿(Bookmarklet)**을 북마크바에 한 번 등록해 두면 **클릭 한 번으로 상태바와 호스트에 설치된 동반 플러그인들을 원격 웹에서도 그대로 사용**할 수 있습니다.

### 방법 1: 원클릭 북마클릿 (모바일 및 데스크톱 크롬 권장)

아래 한 줄짜리 `javascript:` 코드를 복사하여 브라우저 북마크(즐겨찾기)의 **URL(주소)** 칸에 붙여넣으세요:

```javascript
javascript:(()=>{fetch('https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js?t='+Date.now()).then(r=>r.text()).then(c=>{const s=document.createElement('script'),n=document.querySelector('script[nonce]')?.nonce,p=window.trustedTypes?.createPolicy('agy-'+Date.now(),{createScript:x=>x});if(n)s.nonce=n;s.text=p?p.createScript(c):c;document.head.appendChild(s)})})();
```

#### 데스크톱 브라우저(Chrome / Edge / Brave) 북마크바 등록 및 실행 방법
1. 브라우저 상단 **북마크바(즐겨찾기 모음)**를 우클릭하고 **페이지 추가...**(또는 **북마크 추가**)를 클릭합니다(단축키: `Ctrl+Shift+O` 북마크 관리자).
2. **이름**에 `AGY 상태바` (원하는 이름)를 입력합니다.
3. **URL** 칸에 위 `javascript:(()=>{...})();` 코드 전체를 붙여넣고 **저장**을 누릅니다.
4. Antigravity 원격 제어 웹(`https://antigravity.google.com/r/...`)에 접속한 뒤, 북마크바의 **`AGY 상태바`** 버튼을 한 번 클릭합니다.
5. 즉시 채팅 입력창 하단에 상태바가 나타나며, 호스트 PC에 `antigravity-mcp-manager`나 `ko-thought-translator`가 설치되어 있다면 자동으로 함께 활성화됩니다.

#### 모바일 크롬(Android / iOS) 북마크 등록 및 실행 방법
1. 모바일 크롬에서 아무 페이지나 북마크(⭐)한 뒤 **수정(Edit)**을 누릅니다.
2. **이름**을 `AGY 상태바`로 바꾸고, **URL** 칸의 기존 주소를 지운 뒤 위 `javascript:(()=>{...})();` 코드를 붙여넣어 저장합니다.
3. 원격 제어 웹(`https://antigravity.google.com/r/...`) 화면이 열린 상태에서 **상단 주소창을 터치**하고 `AGY 상태바`를 입력합니다.
4. 자동 완성 목록에 나타나는 **`⭐ AGY 상태바`** 북마크 항목을 터치하면 현재 화면에서 즉시 북마클릿이 실행됩니다. *(모바일 크롬에서는 북마크 메뉴가 아니라 주소창 검색 제안에서 `javascript:` 북마크를 눌러야 현재 탭에서 실행됩니다.)*

### 방법 2: Tampermonkey / AdGuard 유저스크립트 자동 실행

`dist/statusbar_autoinject.js` 상단에는 `https://antigravity.google.com/*`에서 동작하는 `// ==UserScript==` 헤더가 기본 내장되어 있습니다.

1. Tampermonkey(또는 Violentmonkey / AdGuard 유저스크립트) 대시보드에서 **URL로부터 설치**를 엽니다.
2. 아래 주소를 입력하고 **설치**를 클릭하면, 앞으로 `https://antigravity.google.com/r/...`에 접속할 때마다 클릭 없이 자동으로 로드됩니다:
   ```text
   https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js
   ```

---

## 상태바 UI 구성 및 조작 안내

| 표시 항목 / 버튼 | 위치 | 설명 |
| :--- | :--- | :--- |
| **`{pct}% · {used} / [ {limit} ▾ ]`** | 좌측 슬롯 | 현재 대화의 컨텍스트 토큰 사용률과 사용량을 실시간으로 표시합니다. **`[ {limit} ▾ ]`**를 클릭하면 세션별 토큰 한도(`128K`~`900K` 프리셋 및 `32K`~`980K` 직접 입력)를 즉시 변경할 수 있습니다. |
| **`cache {pct}%`** | 좌측 슬롯 | 최근 모델 응답의 프롬프트 캐시 적중률(`cacheReadTokens / inputTokens`)을 표시합니다. |
| **`5h {pct}% · 7d {pct}%`** | 좌측 슬롯 | `LanguageServerService.retrieveUserQuotaSummary`에서 조회한 5시간 / 7일 잔여 쿼터 비율을 표시합니다. |
| **`[ compact ]`** | 우측 슬롯 | 현재 대화방에 `/compact` 명령을 전송해 컨텍스트를 압축하고, 압축 직후 줄어든 토큰 추정치를 즉시 반영합니다. |
| **`[ context ]`** | 우측 슬롯 | **Trajectory 컨텍스트 디버그 모달**(`#agy-ctx-debug-modal`)을 열거나 닫으며, 스텝별 토큰 증감 내역·모델명·체크포인트·압축 절감량을 상세히 보여줍니다. |

---

## 호스트 설치 맞춤형 동반 플러그인 자동 로드

원격 웹(`https://antigravity.google.com/r/...`)에서 북마클릿을 실행하면 `LanguageServerService`(`GetCustomizationStates` / `GetAllSkills` / `ReadFile`)를 통해 호스트 PC의 `~/.gemini/antigravity/statusbar_autoinject.js` 및 플러그인 설치 상태를 먼저 확인합니다:

- **호스트에 `antigravity-statusbar` 1개만 단독 설치된 경우**: 상태바만 로드하며, 설치하지 않은 다른 플러그인을 강제로 불러오지 않습니다.
- **호스트에 `antigravity-mcp-manager` 및/또는 `ko-thought-translator`가 함께 설치된 경우**: 호스트에 실제로 설치된 동반 플러그인만 자동으로 함께 로드합니다(클라이언트 브라우저에서 외부 GitHub Raw 접근이 막혀 있는 환경에서도 호스트 로컬 번들에 포함된 블록을 읽어 오프라인 폴백으로 실행합니다).

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

## 저장소 구조

```text
antigravity-statusbar/
├── src/
│   ├── index.js                   # 모듈 조립 루트, 원격 동반 플러그인 로더 및 수명주기 관찰자
│   ├── context-window-policy.js   # 컨텍스트 한도 정규화(32K-980K) 및 세션별 영속 저장소
│   ├── host-bridge.js             # React Fiber / Redux / 원격 proxyCommand / Connect 프레임 & Protobuf 훅
│   ├── rpc-client.js              # LanguageServer RPC 클라이언트, singleflight 중복 방지 및 LRU 캐시
│   ├── dom-styles.js              # CSS 스타일시트, <=256K 경고 숨김 동적 CSS, TrustedHTML 및 포맷터
│   ├── adapter-registry.js        # StatusBarAdapter 레지스트리 및 정렬 슬롯 렌더러
│   └── adapters/
│       ├── core-metrics.js        # 좌측 슬롯 지표 + 세션별 컨텍스트 한도 드롭다운 메뉴
│       ├── compact-button.js      # 우측 슬롯 `[ compact ]` 버튼 어댑터
│       └── context-button.js      # 우측 슬롯 `[ context ]` 버튼 어댑터 + Trajectory 디버그 모달
├── dist/
│   └── statusbar_autoinject.js    # Electron / CDP / UserScript 겸용 단일 파일 런타임 번들 산출물
├── scripts/
│   ├── build.js                   # 무의존성 CommonJS 번들러 (src/ -> dist/statusbar_autoinject.js)
│   ├── ensure_statusbar_patch.js  # 오프셋 보존 ASAR 패처 + app_storage 동기화 + 실시간 CDP 주입기
│   └── install.js                 # 번들 빌드 후 ~/.gemini/antigravity 설치 및 패처 실행
├── test/
│   └── statusbar.test.js          # 개별 모듈 단위 테스트 + 런타임 번들 통합·회귀 테스트
├── README.md                      # 영문 안내 문서 (English)
├── README.ko.md                   # 국문 안내 문서 (Korean)
└── package.json
```

---

## 검증 및 테스트

```bash
# dist/statusbar_autoinject.js 빌드 및 17개 단위·통합 회귀 테스트 실행
npm test
```

## 라이선스

MIT
