# antigravity-statusbar

**Languages:** **English ([README.md](./README.md))** | **[한국어 (README.ko.md)](./README.ko.md)**

Custom context window statusbar (`.agy-ctx-statusbar`), **`StatusBarAdapter` extension architecture**, per-session arbitrary token limit selector (`32K`–`980K`), and resilient zero-offset `app.asar` + live CDP auto-patcher for **Google Antigravity IDE** (`v2.26.x` / `v2.27.x+`).

---

## Features

- **Modular SOLID Architecture (`src/`)**:
  - Separated by single responsibility and variation axis into 9 focused CommonJS modules under `src/` and bundled with zero external dependencies into `dist/statusbar_autoinject.js`.
- **Pluggable `StatusBarAdapter` Architecture (`v7`)**:
  - Core layout (`.agy-ctx-left` and `.agy-ctx-right`) is decoupled from individual statusbar widgets and buttons.
  - Built-in buttons (`[ compact ]`, `[ context ]`) and left-side metrics (`core-metrics`) are implemented as independent `StatusBarAdapter` modules under `src/adapters/`.
  - External plugins or user scripts can dynamically add, replace, or remove buttons and widgets via `window.agyStatusBar.registerAdapter(adapter)`.
- **Real-Time Context & Cache Telemetry**:
  - Displays current context token usage (`pct%`, `used / limit`), prompt cache hit rate (`cache %`), and `5h` / `7d` quota remaining directly inside the chat input box.
- **Per-Session Arbitrary Context Limit (`32K` – `980K`)**:
  - Click `[ 256k ▾ ]` to open the per-session context limit menu.
  - Type any custom value between `32` and `980` (`K` tokens) or choose from presets (`128K`, `256K`, `384K`, `512K`, `750K`, `900K`).
  - Stored per `cascadeId` across `localStorage`, cookies, and `nativeStorage`, while isolating Redux's global default so changing one conversation never pollutes other sessions.
  - Suppresses the yellow warning icon (`⚠️`) in the native model selector pill when the session limit is `<= 256K` while keeping the `· {cw}` badge visible.
- **Zero-Offset `app.asar` & Sandboxed `preload.js` Auto-Patcher**:
  - Patches `dist/preload.js`, `dist/utils.js`, and `dist/main.js` inside `app.asar` while preserving exact byte lengths (`0` offset drift) and updating `ElectronAsarIntegrity` SHA-256 block hashes.

---

## Repository Structure

```text
antigravity-statusbar/
├── src/
│   ├── index.js                   # Composition root & lifecycle observer
│   ├── context-window-policy.js   # Context limit normalization (32K-980K) & per-session persistence store
│   ├── host-bridge.js             # Antigravity React Fiber / Redux / Lexical / Object.prototype bridge
│   ├── rpc-client.js              # LanguageServer RPC client, singleflight deduplication & LRU cache
│   ├── dom-styles.js              # CSS styles, dynamic <=256K warning filter, TrustedHTML & formatters
│   ├── adapter-registry.js        # StatusBarAdapter registry & slot renderer (OCP / DIP boundary)
│   └── adapters/
│       ├── core-metrics.js        # Left slot metrics + per-session context limit dropdown menu
│       ├── compact-button.js      # Right slot `[ compact ]` button adapter
│       └── context-button.js      # Right slot `[ context ]` button adapter + Trajectory Debug Modal
├── dist/
│   └── statusbar_autoinject.js    # Built single-file runtime bundle for Electron / CDP injection
├── scripts/
│   ├── build.js                   # Zero-dependency CommonJS bundler (src/ -> dist/statusbar_autoinject.js)
│   ├── ensure_statusbar_patch.js  # Zero-offset ASAR patcher + app_storage sync + live CDP injector
│   └── install.js                 # Builds bundle, installs to ~/.gemini/antigravity & runs patcher
├── test/
│   └── statusbar.test.js          # Module unit tests + runtime bundle integration tests
├── README.md                      # English documentation
├── README.ko.md                   # Korean documentation
└── package.json
```

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

## Installation & Usage

```bash
# Build dist/statusbar_autoinject.js and install to ~/.gemini/antigravity
npm run install-statusbar

# Check patch & CDP status
npm run status

# Build & run unit/integration tests
npm test
```

## License

MIT
