# antigravity-statusbar (`v1.3.10` / `v16`)

**Languages:** **English ([README.md](./README.md))** | **[한국어 (README.ko.md)](./README.ko.md)**

Custom context window statusbar (`.agy-ctx-statusbar`), per-session arbitrary token limit selector (`32K`–`980K`) with real-time backend checkpointer synchronization, pluggable **`StatusBarAdapter`** extension API, zero-offset `app.asar` + live CDP auto-patcher, and **Remote Control Web (`https://antigravity.google.com/r/...`)** bookmarklet & userscript support for **Google Antigravity IDE (`v2.26.x` – `v2.29.x+`)**.

---

## Table of Contents

1. [Overview & Key Features](#overview--key-features)
2. [Desktop App Installation (Local PC)](#desktop-app-installation-local-pc)
3. [Remote Control Web Guide (Bookmarklet & UserScript)](#remote-control-web-guide-bookmarklet--userscript)
4. [Statusbar UI & Controls Guide](#statusbar-ui--controls-guide)
5. [Host-Aware Companion Plugin Auto-Loader](#host-aware-companion-plugin-auto-loader)
6. [Extending the Statusbar (`StatusBarAdapter` API)](#extending-the-statusbar-statusbaradapter-api)
7. [Repository Structure](#repository-structure)
8. [Verification & Testing](#verification--testing)

---

## Overview & Key Features

- **Real-Time Context, Cache & Quota Telemetry**:
  - Displays current context token usage (`pct%`, `used / limit`), prompt cache hit rate (`cache %`), and `5h` / `7d` remaining quota directly inside the chat input box.
  - Immediately reflects post-compacting token reductions (`agentStateProvider.getContextEstimate().estimatedAfterCompaction`) in both the statusbar and the `[ context ]` trajectory debug modal right after `Compacting` completes.
- **Per-Session Arbitrary Context Limit (`32K` – `980K`) & Backend Checkpointer Sync**:
  - Click `[ 256k ▾ ]` to select from presets (`128K`, `256K`, `384K`, `512K`, `750K`, `900K`) or enter any custom value between `32` and `980` (`K` tokens).
  - Intercepts both `fetch` (including `Request` objects) and `Transport.send` / `sendUnary` (`SendUserCascadeMessage`) across JSON, Connect-framed JSON, and Protobuf binary payloads to inject `cascadeConfig.checkpointConfig.maxTokenLimit` (`field 5`), ensuring `language_server.exe` honors your chosen limit instead of triggering premature compaction at `256K`.
  - Persists limits per `cascadeId` across `localStorage`, cookies, `nativeStorage`, and server annotations (`agyCwLimit`) for seamless Desktop ↔ Mobile sync while isolating Redux's global default so changing one conversation never pollutes other sessions.
  - Automatically hides the yellow warning icon (`⚠️`) in the native model selector pill when the session limit is `<= 256K` while keeping the `· {cw}` badge visible.
- **Zero-Offset `app.asar` & Live CDP Auto-Patcher**:
  - Patches `dist/preload.js`, `dist/utils.js`, and `dist/main.js` inside `app.asar` with **0 byte-offset drift** and recalculates `ElectronAsarIntegrity` SHA-256 block hashes.
  - Injects into already-running Antigravity windows via Chrome DevTools Protocol (CDP) without requiring an app restart.
- **Remote Control Web (`https://antigravity.google.com/r/...`) & Host-Aware Companion Loading**:
  - Bridges the top-level `<ga-remote-control>` Angular host shell (`RemoteControlComponent.prototype.proxyCommand`) and internal React Fiber WebRTC/WebChannel RPC services (`retrieveUserQuotaSummary`, `getCascadeTrajectoryGeneratorMetadata`, `getCascadeTrajectory`).
  - Automatically detects which companion plugins (`antigravity-mcp-manager`, `ko-thought-translator`) are installed on the host PC and loads only those installed plugins in Remote Control web.
- **Pluggable `StatusBarAdapter` Architecture (`v7`)**:
  - Decouples the statusbar layout (`.agy-ctx-left` / `.agy-ctx-right`) from individual widgets and buttons (`core-metrics`, `[ compact ]`, `[ context ]`), allowing external scripts or plugins to dynamically register custom widgets via `window.agyStatusBar.registerAdapter(adapter)`.

---

## Desktop App Installation (Local PC)

```bash
git clone https://github.com/jaeseongs95/antigravity-statusbar.git
cd antigravity-statusbar

# 1. Run unit & bundle integration tests (14/14 tests)
npm test

# 2. Build dist/statusbar_autoinject.js, install to ~/.gemini/antigravity, patch app.asar & live-inject via CDP
npm run install-statusbar

# 3. Check ASAR patch & live CDP injection status
npm run status
```

---

## Remote Control Web Guide (Bookmarklet & UserScript)

When accessing your Antigravity session remotely via **`https://antigravity.google.com/r/...`** on a desktop browser, tablet, or mobile phone (Chrome / Safari / Edge), local Electron `preload.js` files do not run on the remote client device. You can activate the full statusbar (plus any companion plugins installed on your host PC) with **one tap using a Bookmarklet** or **automatically using Tampermonkey / AdGuard**.

### Method 1: One-Tap Bookmarklet (Recommended for Mobile & Desktop Chrome)

Copy the single-line JavaScript code below and save it as the **URL** of a browser bookmark:

```javascript
javascript:(()=>{fetch('https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js?t='+Date.now()).then(r=>r.text()).then(c=>{const s=document.createElement('script'),n=document.querySelector('script[nonce]')?.nonce,p=window.trustedTypes?.createPolicy('agy-'+Date.now(),{createScript:x=>x});if(n)s.nonce=n;s.text=p?p.createScript(c):c;document.head.appendChild(s)})})();
```

#### How to Add & Run on Desktop Chrome / Edge / Brave
1. Press `Ctrl+Shift+O` (Bookmark Manager) or right-click your **Bookmarks Bar** and click **Add page...** (or **Add bookmark**).
2. Set **Name** to `AGY Statusbar` (or any name you prefer).
3. Paste the `javascript:(()=>{...})();` code above into the **URL** field and click **Save**.
4. Open your Antigravity Remote Control web session (`https://antigravity.google.com/r/...`) and click the **`AGY Statusbar`** bookmark once.
5. The statusbar will immediately mount at the bottom of the chat input box, and any companion plugins installed on your host PC (`antigravity-mcp-manager`, `ko-thought-translator`) will automatically load together.

#### How to Add & Run on Mobile Chrome (Android / iOS)
1. Bookmark any page in Mobile Chrome, then tap **Edit** on that bookmark.
2. Change the **Name** to `AGY Statusbar` and replace the **URL** with the `javascript:(()=>{...})();` code above.
3. On your `https://antigravity.google.com/r/...` tab, tap the **address bar**, type `AGY Statusbar`, and tap the bookmark entry that appears with the ⭐ icon. *(Note: On mobile Chrome, tapping a `javascript:` bookmarklet from the address bar suggestions executes it in the current tab.)*

### Method 2: Automatic UserScript (Tampermonkey / Violentmonkey / AdGuard)

`dist/statusbar_autoinject.js` includes a standard `// ==UserScript==` metadata block matching `https://antigravity.google.com/*`:

1. Open your UserScript manager dashboard (e.g., Tampermonkey -> **Utilities** -> **Install from URL**).
2. Enter the raw bundle URL:
   ```text
   https://raw.githubusercontent.com/jaeseongs95/antigravity-statusbar/main/dist/statusbar_autoinject.js
   ```
3. Click **Install**. The statusbar and host-installed companion plugins will now inject automatically whenever you open `https://antigravity.google.com/r/...`.

---

## Statusbar UI & Controls Guide

| Control / Metric | Location | Description |
| :--- | :--- | :--- |
| **`{pct}% · {used} / [ {limit} ▾ ]`** | Left Slot | Shows real-time context usage percentage and token count. Click **`[ {limit} ▾ ]`** to open the per-session context limit selector (`128K`–`900K` presets or custom `32K`–`980K` input). |
| **`cache {pct}%`** | Left Slot | Displays the prompt cache hit ratio (`cacheReadTokens / inputTokens`) for the latest model turn. |
| **`5h {pct}% · 7d {pct}%`** | Left Slot | Displays remaining user quota percentages from `LanguageServerService.retrieveUserQuotaSummary`. |
| **`[ compact ]`** | Right Slot | Sends `/compact` in the current conversation to compress context history and immediately updates the token count after compaction finishes. |
| **`[ context ]`** | Right Slot | Opens the **Trajectory Context Debug Modal** (`#agy-ctx-debug-modal`), showing per-step token progression, model name, checkpoint history, and compression savings. |

---

## Host-Aware Companion Plugin Auto-Loader

When you run the `antigravity-statusbar` bookmarklet on Remote Control web (`https://antigravity.google.com/r/...`), it inspects the host PC via `LanguageServerService` (`GetCustomizationStates` / `GetAllSkills` / `ReadFile` on `~/.gemini/antigravity/statusbar_autoinject.js`):

- **1 Plugin Installed on Host (`antigravity-statusbar` only)**: Loads only the statusbar; never forces unwanted companion scripts.
- **2 or 3 Plugins Installed on Host (with `antigravity-mcp-manager` and/or `ko-thought-translator`)**: Automatically loads the exact combination installed on your host PC. If external GitHub Raw access is blocked on the client browser, it falls back to executing the embedded companion block directly from the host's local `statusbar_autoinject.js`.

---

## Extending the Statusbar (`StatusBarAdapter` API)

Register custom buttons or widgets at runtime via `window.agyStatusBar`:

```js
// 1. Register a custom button adapter in the right slot
const dispose = window.agyStatusBar.registerAdapter({
  id: 'my-custom-btn',
  slot: 'right',          // 'left' | 'right' (default: 'right')
  order: 30,              // Lower numbers render first (compact=10, context=20)
  label: '[ clear ]',     // String or (ctx) => string
  title: 'Run custom action for this session',
  className: 'agy-ctx-btn',
  onClick(ctx, event) {
    console.log('Clicked in session:', ctx.cascadeId, 'Current limit:', ctx.getConversationContextWindow());
  },
  unmount() {
    // Optional cleanup when unregistered or replaced
  }
});

// 2. Remove adapter when no longer needed
dispose(); // or window.agyStatusBar.unregisterAdapter('my-custom-btn');
```

---

## Repository Structure

```text
antigravity-statusbar/
├── src/
│   ├── index.js                   # Composition root, Remote companion loader & lifecycle observer
│   ├── context-window-policy.js   # Context limit normalization (32K-980K) & per-session persistence store
│   ├── host-bridge.js             # React Fiber / Redux / Remote proxyCommand / Connect-frame & Protobuf hook
│   ├── rpc-client.js              # LanguageServer RPC client, singleflight deduplication & LRU cache
│   ├── dom-styles.js              # CSS styles, dynamic <=256K warning filter, TrustedHTML & formatters
│   ├── adapter-registry.js        # StatusBarAdapter registry & ordered slot renderer
│   └── adapters/
│       ├── core-metrics.js        # Left slot metrics + per-session context limit dropdown menu
│       ├── compact-button.js      # Right slot `[ compact ]` button adapter
│       └── context-button.js      # Right slot `[ context ]` button adapter + Trajectory Debug Modal
├── dist/
│   └── statusbar_autoinject.js    # Built single-file runtime bundle (with ==UserScript== header)
├── scripts/
│   ├── build.js                   # Zero-dependency CommonJS bundler (src/ -> dist/statusbar_autoinject.js)
│   ├── ensure_statusbar_patch.js  # Zero-offset ASAR patcher + app_storage sync + live CDP injector
│   └── install.js                 # Builds bundle, installs to ~/.gemini/antigravity & runs patcher
├── test/
│   └── statusbar.test.js          # Module unit tests + runtime bundle integration & regression tests
├── README.md                      # English documentation
├── README.ko.md                   # Korean documentation
└── package.json
```

---

## Verification & Testing

```bash
# Build dist/statusbar_autoinject.js and run all 14 unit + integration test suites
npm test
```

## License

MIT
