# antigravity-statusbar (`v2.0.0`)

**언어:** **[English (README.md)](./README.md)** | **한국어 ([README.ko.md](./README.ko.md))**

독립형 **헥사고날 아키텍처(Hexagonal Architecture)** 기반 Antigravity 커스텀 상태 표시줄(`.agy-ctx-statusbar`), 세션별 임의 컨텍스트 한도 선택(`32K`–`980K`) 및 백엔드 체크포인터 실시간 동기화, **HTML 문자열 없는 순수 DOM UI(`TrustedHTML` 무사용)**, 확장 가능한 **`StatusBarAdapter`** 및 **`Symbol.for('agy.plugin.bus.v2')`** 이벤트 버스, 모듈형 무오프셋 `app.asar` + 라이브 CDP 패처, **Remote Control Web(`https://antigravity.google.com/r/...`)** 북마클릿/유저스크립트 지원 프로젝트입니다.

---

## 목차

1. [개요 및 주요 기능](#개요-및-주요-기능)
2. [데스크톱 앱 설치 (로컬 PC)](#데스크톱-앱-설치-로컬-pc)
3. [Remote Control 웹 가이드 (북마클릿 / 유저스크립트)](#remote-control-웹-가이드-북마클릿--유저스크립트)
4. [상태바 UI 및 조작 안내](#상태바-ui-및-조작-안내)
5. [다국어(`en`/`ko`) 및 호스트 설정](#다국어enko-및-호스트-설정)
6. [확장 API (`StatusBarAdapter` & Plugin Bus v2)](#확장-api-statusbaradapter--plugin-bus-v2)
7. [저장소 구조](#저장소-구조)
8. [검증 및 테스트](#검증-및-테스트)

---

## 개요 및 주요 기능

- **독립 헥사고날 계층 분리**:
  - `src/ports/contracts.js`(포트 계약·플러그인 버스), `src/domain/*`(순수 도메인 정책·계산기·i18n), `src/drivers/antigravity/*`(React Fiber·Redux·Protobuf·RC 드라이버), `src/ui/*`(순수 DOM 뷰), `src/app/*`(조립 루트·수명주기 `DisposableScope`)로 엄격히 분리되어 있습니다.
  - 형제 저장소 URL 의존이나 외부 런타임 패키지 없이 단독으로 빌드·시험·실행됩니다.
- **HTML 문자열 0개 순수 DOM 빌더 (`D-0025` / `D-0032` 구조적 제거)**:
  - `innerHTML`, `outerHTML`, HTML 파서, `trustedTypes.createPolicy` HTML 정책 생성을 전혀 사용하지 않고 `src/ui/dom-builder.js` (`document.createElement` + `textContent`)만으로 모든 UI·팝오버·디버그 모달을 조립합니다.
- **세션별 임의 컨텍스트 한도(`32K`–`980K`) 및 체크포인터 동기화**:
  - `[ 256k ▾ ]` 버튼으로 프리셋(`128K`–`900K`) 또는 직접 입력(`32`–`980`K), 새 세션 기본값 저장, `Shift+클릭` 빠른 순환을 지원합니다.
  - JSON / Connect 프레이밍 / Protobuf 바이너리 페이로드의 `SendUserCascadeMessage`에 `checkpointConfig.maxTokenLimit`(`field 5`)을 병합하고 `continue_after_injection`(`field 20`) 연속 요청은 안전하게 건너뜁니다.
- **모듈형 무오프셋 `app.asar` & CDP 자동 패처 (`installer/`)**:
  - `installer/{asar-codec,file-lock,rfc6455-client,cdp-injector,host-patcher,cli}.js`가 바이트 오프셋 변화(`0 drift`) 없이 패치하고, `~/.gemini/antigravity/statusbar_autoinject.js`에 0열(column 0)로 합쳐진 로컬 동반 블록을 설치 시 그대로 보존합니다.

---

## 데스크톱 앱 설치 (로컬 PC)

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar

# 1. 번들 빌드 및 단위·통합·설치기·Chromium E2E 전체 시험
npm test

# 2. ~/.gemini/antigravity에 번들 및 모듈형 installer/ 설치, app.asar 패치 및 CDP 즉시 주입
npm run install-statusbar

# 3. ASAR 패치 및 라이브 CDP 주입 상태 확인
npm run status

# 4. 깔끔하게 제거 (.orig 백업 복원 및 앱 스토리지/설정 정리)
npm run uninstall
```

---

## Remote Control 웹 가이드 (북마클릿 / 유저스크립트)

### 방법 1: 원클릭 북마클릿

아래 한 줄 코드를 브라우저 북마크의 **URL**에 저장한 뒤 `https://antigravity.google.com/r/...` 화면에서 한 번 클릭하세요:

```javascript
javascript:(()=>{fetch('https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js?t='+Date.now()).then(r=>{if(!r.ok||!r.url.startsWith('https://raw.githubusercontent.com/'))throw new Error(r.status);return r.text()}).then(c=>{const s=document.createElement('script'),n=[...document.querySelectorAll('script,style,link')].map(x=>x.nonce||x.getAttribute('nonce')).find(Boolean),t=window.trustedTypes;let p=null;if(t?.createPolicy){for(const k of['agy-sb-bm','agy-sb-'+Date.now()])try{let u=1;p=t.createPolicy(k,{createScript:x=>{if(!u)throw new TypeError();u=0;return x}});break}catch{}}if(t&&!p&&!t.defaultPolicy)return;if(n){s.nonce=n;s.setAttribute('nonce',n)}s.text=p?p.createScript(c):c;document.head.appendChild(s)})})();
```

### 방법 2: 유저스크립트 자동 주입 (Tampermonkey / Violentmonkey / AdGuard)

```text
https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js
```

---

## 상태바 UI 및 조작 안내

| 항목 | 위치 | 설명 |
| :--- | :--- | :--- |
| **`ctx {pct}% {used}/[ {limit} ▾ ]`** | 왼쪽 슬롯 | 실시간 컨텍스트 사용률·토큰 수 표시. 클릭 시 프리셋/직접 입력(`32K`–`980K`)/기본값 저장 메뉴 열기, `Shift+클릭` 시 `256K → 512K → 900K` 순환. |
| **`cache {pct}%`** | 왼쪽 슬롯 | 직전 턴의 프롬프트 캐시 적중률 표시. |
| **`5h {pct}% · 7d {pct}%`** | 왼쪽 슬롯 | `5h` / `7d` 잔여 쿼터 표시. |
| **`[ compact ]`** | 오른쪽 슬롯 | 설정된 요약 프롬프트로 `/compact` 시스템 명령 실행. |
| **`[ context ]`** | 오른쪽 슬롯 | **Trajectory & Context Debug View**(`#agy-ctx-debug-modal`) 모달 열기/닫기. |

---

## 다국어(`en`/`ko`) 및 호스트 설정

기본 UI 언어는 영어(`'en'`)이며 런타임에 즉시 한국어(`'ko'`)로 전환하거나 사용자 정의 `/compact` 프롬프트를 지정할 수 있습니다.

```js
// 런타임 언어 즉시 전환
window.agyStatusBar.setLocale('ko'); // 'en' | 'ko'

// 또는 주입 전 호스트 설정 지정
window.__AGY_STATUSBAR_HOST_CONFIG__ = {
  locale: 'auto', // 'en' | 'ko' | 'auto'
  compactPrompt: '현재까지의 작업 맥락을 간결히 요약해 주세요.',
};
```

---

## 확장 API (`StatusBarAdapter` & Plugin Bus v2)

```js
const dispose = window.agyStatusBar.registerAdapter({
  id: 'my-custom-btn',
  slot: 'right',
  order: 30,
  label: '[ clear ]',
  onClick(ctx) {
    console.log('세션:', ctx.cascadeId, '한도:', ctx.currentCw);
  },
});

const bus = window.agyStatusBar.pluginBus;
bus.on('plugin:registered', (entry) => console.log('등록된 플러그인:', entry.id, entry.version));
```

---

## 저장소 구조

- `src/ports/` — 포트 검증 계약 및 `Symbol.for('agy.plugin.bus.v2')`
- `src/domain/` — `i18n.js`, `context-window-policy.js`, `metrics-calculator.js` (DOM/벤더 무의존 순수 로직)
- `src/drivers/antigravity/` — 호스트 설정, Protobuf/Connect 코덱, HTTP/RPC 전송, Remote Control 훅, React Fiber/Redux 엔진, `/compact` 드라이버
- `src/ui/` — `dom-builder.js`, `style-manager.js`, `adapter-registry.js`, `views/*`
- `src/app/` — `disposable.js`, `state-coordinator.js`, `index.js` (유일한 조립 루트)
- `installer/` — 모듈형 ASAR 코덱, 원자적 파일 락, RFC6455 클라이언트, CDP 인젝터, CLI
- `test/{unit,integration,installer,e2e}/` — 계층별 자동 시험

---

## 검증 및 테스트

```bash
npm test            # 번들 빌드 + 단위 + 통합 + 설치기 + Chromium E2E 전체 실행
npm run test:unit   # 순수 단위 시험 및 헥사고날 경계 정적 검사 실행
```

## 라이선스

MIT
