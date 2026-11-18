# antigravity-statusbar (`v2.0.0`)

**Languages:** **English ([README.md](./README.md))** | **[한국어 (README.ko.md)](./README.ko.md)**

Standalone **Hexagonal Architecture** context window statusbar (`.agy-ctx-statusbar`), per-session arbitrary token limit selector (`32K`–`980K`) with real-time backend checkpointer synchronization, zero-HTML-string pure DOM UI (`TrustedHTML`-free), pluggable **`StatusBarAdapter`** extension API, `Symbol.for('agy.plugin.bus.v2')` plugin event bus, modular zero-offset `app.asar` + live CDP auto-patcher, and **Remote Control Web (`https://antigravity.google.com/r/...`)** bookmarklet & userscript support for **Google Antigravity IDE**.

---

## Table of Contents

1. [Overview & Key Features](#overview--key-features)
2. [Desktop App Installation (Local PC)](#desktop-app-installation-local-pc)
3. [Remote Control Web Guide (Bookmarklet & UserScript)](#remote-control-web-guide-bookmarklet--userscript)
4. [Statusbar UI & Controls Guide](#statusbar-ui--controls-guide)
5. [Localization & Custom Configuration](#localization--custom-configuration)
6. [Extending the Statusbar (`StatusBarAdapter` & Plugin Bus v2)](#extending-the-statusbar-statusbaradapter--plugin-bus-v2)
7. [Hexagonal Repository Structure](#hexagonal-repository-structure)
8. [Verification & Testing](#verification--testing)

---

## Overview & Key Features

- **Hexagonal Ports & Adapters Architecture**:
  - Cleanly separates **Ports** (`src/ports/contracts.js`), **Domain Policy & i18n** (`src/domain/*`), **Antigravity Drivers** (`src/drivers/antigravity/*`), **Zero-HTML DOM UI** (`src/ui/*`), and the **Composition Root** (`src/app/index.js`).
  - Zero sibling-repository URLs, zero external runtime dependencies, and deterministic `DisposableScope` teardown via `window.__agyStatusBarCleanup()`.
- **Zero-HTML DOM Composition (`D-0025` / `D-0032` Structural Elimination)**:
  - All views (metrics bar, limit selector dropdown, diagnostics modal, style injection) build nodes exclusively with `document.createElement` / `textContent` (`src/ui/dom-builder.js`) — **zero `innerHTML`, zero HTML parsers, and zero `TrustedHTML` policy creation**.
- **Per-Session Context Limit (`32K` – `980K`) & Backend Checkpointer Sync**:
  - Click `[ 256k ▾ ]` to choose presets (`128K`, `256K`, `384K`, `512K`, `750K`, `900K`) or enter any custom token limit between `32` and `980` (`K`), with one-click saving as the default for new sessions.
  - Intercepts `fetch` (including `Request` objects) and `Transport.send` / `sendUnary` (`SendUserCascadeMessage`) across JSON, Connect-framed JSON, and Protobuf binary payloads to inject `cascadeConfig.checkpointConfig.maxTokenLimit` (`field 5`), while skipping `continue_after_injection` (`field 20`) continuations cleanly.
  - Synchronizes 200-entry LRU session overrides across `localStorage`, cookies, `nativeStorage`, and server annotations without mutating `Object.prototype` or polluting unrelated sessions.
- **Standalone Modular Auto-Patcher (`installer/`)**:
  - `installer/{asar-codec,file-lock,rfc6455-client,cdp-injector,host-patcher,cli}.js` patches `dist/preload.js`, `dist/utils.js`, and `dist/main.js` inside `app.asar` with **0 byte-offset drift**, maintains atomic PID+token locks, and injects live windows over CDP while preserving any local companion plugin blocks (`antigravity-mcp-manager`, `ko-thought-translator`) anchored at column 0 in `~/.gemini/antigravity/statusbar_autoinject.js`.

---

## Desktop App Installation (Local PC)

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar

# 1. Build dist/statusbar_autoinject.js and run unit, integration, installer & Chrome E2E tests
npm test

# 2. Build, install to ~/.gemini/antigravity (including modular installer/), patch app.asar & live-inject via CDP
npm run install-statusbar

# 3. Check ASAR patch & live CDP injection status
npm run status

# 4. Uninstall cleanly (restores app.asar from .orig backup & removes injected state)
npm run uninstall
```

---

## Remote Control Web Guide (Bookmarklet & UserScript)

### Method 1: One-Tap Bookmarklet

Save the single-line JavaScript below as the **URL** of a browser bookmark and click it once inside `https://antigravity.google.com/r/...`:

```javascript
javascript:(()=>{fetch('https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js?t='+Date.now()).then(r=>{if(!r.ok||!r.url.startsWith('https://raw.githubusercontent.com/'))throw new Error(r.status);return r.text()}).then(c=>{const s=document.createElement('script'),n=[...document.querySelectorAll('script,style,link')].map(x=>x.nonce||x.getAttribute('nonce')).find(Boolean),t=window.trustedTypes;let p=null;if(t?.createPolicy){for(const k of['agy-sb-bm','agy-sb-'+Date.now()])try{let u=1;p=t.createPolicy(k,{createScript:x=>{if(!u)throw new TypeError();u=0;return x}});break}catch{}}if(t&&!p&&!t.defaultPolicy)return;if(n){s.nonce=n;s.setAttribute('nonce',n)}s.text=p?p.createScript(c):c;document.head.appendChild(s)})})();
```

### Method 2: Automatic UserScript (Tampermonkey / Violentmonkey / AdGuard)

`dist/statusbar_autoinject.js` includes a `// ==UserScript==` header matching `https://antigravity.google.com/*`:

```text
https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js
```

---

## Statusbar UI & Controls Guide

| Control / Metric | Location | Description |
| :--- | :--- | :--- |
| **`ctx {pct}% {used}/[ {limit} ▾ ]`** | Left Slot | Displays context usage % and token count. Click `[ {limit} ▾ ]` to select presets (`128K`–`900K`), enter custom limits (`32K`–`980K`), or save as default. `Shift+Click` cycles `256K -> 512K -> 900K`. |
| **`cache {pct}%`** | Left Slot | Prompt cache hit ratio (`cacheReadTokens / (inputTokens + cacheReadTokens)`) on the latest turn. |
| **`5h {pct}% · 7d {pct}%`** | Left Slot | Remaining quota percentages from `retrieveUserQuotaSummary`. |
| **`[ compact ]`** | Right Slot | Dispatches `/compact` in the active session using the configured summary prompt. |
| **`[ context ]`** | Right Slot | Opens the **Trajectory & Context Debug View** (`#agy-ctx-debug-modal`) with token breakdown, prompt sections, and recent turns. |

---

## Localization & Custom Configuration

The statusbar defaults to English (`'en'`) with instant runtime switching to Korean (`'ko'`) and configurable `/compact` prompts:

```js
// Toggle UI language at runtime
window.agyStatusBar.setLocale('ko'); // 'en' | 'ko'

// Or configure before injection via window.__AGY_STATUSBAR_HOST_CONFIG__
window.__AGY_STATUSBAR_HOST_CONFIG__ = {
  locale: 'auto', // 'en' | 'ko' | 'auto' (reads navigator.language)
  compactPrompt: 'Summarize context concisely before continuing.',
};
```

---

## Extending the Statusbar (`StatusBarAdapter` & Plugin Bus v2)

```js
// Register a custom widget via window.agyStatusBar
const dispose = window.agyStatusBar.registerAdapter({
  id: 'my-custom-btn',
  slot: 'right',          // 'left' | 'right'
  order: 30,
  label: '[ clear ]',
  title: 'Run custom action',
  onClick(ctx) {
    console.log('Session:', ctx.cascadeId, 'Limit:', ctx.currentCw);
  },
});

// Listen for plugin lifecycle events on Symbol.for('agy.plugin.bus.v2')
const bus = window.agyStatusBar.pluginBus;
bus.on('plugin:registered', (entry) => console.log('Plugin active:', entry.id, entry.version));

// Remove adapter or tear down cleanly
dispose();
```

---

## Hexagonal Repository Structure

```text
antigravity-statusbar/
├── src/
│   ├── ports/contracts.js                    # Port validators & Symbol.for('agy.plugin.bus.v2')
│   ├── domain/
│   │   ├── i18n.js                           # 'en' default + 'ko' dictionary & compact prompt
│   │   ├── context-window-policy.js          # 32K–980K policy & 200-entry synchronized LRU store
│   │   └── metrics-calculator.js             # Stats, quota parsing & fail-closed cascade matcher
│   ├── drivers/antigravity/
│   │   ├── host-config.js                    # Boundary-safe host matcher & HTTPS CDN validation
│   │   ├── protobuf-wire-codec.js            # Connect / Protobuf SendUserCascadeMessage codec
│   │   ├── local-http-transport.js           # LanguageServer TransportPort & StoragePort adapters
│   │   ├── remote-port-driver.js             # WeakMap ref-counted RC hook & iframe safety driver
│   │   ├── react-fiber-driver.js             # React Fiber / Redux / fetch / lsClient EnginePort
│   │   └── compact-driver.js                 # Lexical editor /compact command dispatcher
│   ├── ui/
│   │   ├── dom-builder.js                    # Pure createElement / textContent DOM builder (0 HTML)
│   │   ├── style-manager.js                  # CSP nonce-aware stylesheet injector (WeakSet)
│   │   ├── adapter-registry.js               # StatusBarAdapter registry & slot reconciler
│   │   └── views/{metrics-view,compact-button,context-modal}.js
│   ├── app/
│   │   ├── disposable.js                     # Bound timer & observer DisposableScope
│   │   ├── state-coordinator.js              # Pure port-driven application coordinator
│   │   └── index.js                          # Composition root (mountStatusBar & cleanup)
│   └── index.js                              # Thin entry facade -> ./app/index
├── installer/
│   ├── asar-codec.js                         # Exact-size zero-offset ASAR reader/writer
│   ├── file-lock.js                          # Atomic PID + token lock recovery
│   ├── rfc6455-client.js                     # Zero-dep RFC 6455 WebSocket client
│   ├── cdp-injector.js                       # Page & Browser CDP Runtime.evaluate injector
│   ├── host-patcher.js                       # app_storage.json atomic sync & ASAR orchestrator
│   └── cli.js                                # --worker / --status / fast-path CLI
├── scripts/
│   ├── build.js                              # Zero-dep Hexagonal CommonJS bundler
│   ├── ensure_statusbar_patch.js             # Compatibility shim -> installer/cli
│   └── install.js                            # Installs bundle + installer/ & preserves column-0 blocks
├── test/
│   ├── unit/{domain,ui}.test.js              # Pure domain, i18n, UI & static Hexagonal boundary tests
│   ├── integration/drivers.test.js           # React Fiber, RemotePort, DisposableScope & bundle tests
│   ├── installer/patcher.test.js             # Build, install, ASAR, lock, RFC6455 & CDP tests
│   └── e2e/remote-chrome.test.js             # Headless Chromium CSP/TrustedTypes & live host smoke
├── .github/workflows/ci.yml                  # Standalone Windows + Ubuntu CI matrix
└── docs/{ARCHITECTURE_V2,TEST_CASES}.md
```

---

## Verification & Testing

```bash
npm test              # Full build + unit + integration + installer + Chromium E2E suites
npm run test:unit     # Fast unit tests (domain, i18n, UI, Hexagonal boundary static check)
```

## License

MIT
