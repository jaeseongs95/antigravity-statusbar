#!/usr/bin/env node
/**
 * Antigravity Statusbar Auto-Patch & Live CDP Recovery (v5)
 *
 * Root Causes Solved:
 * 1. Exact-Size Sandboxed `dist/preload.js` Patch + `app_storage.json` Sync:
 *    When an Antigravity process is ALREADY running (e.g., residing in the system tray),
 *    it never re-requires `dist/main.js` or `dist/utils.js` from disk. However, whenever
 *    ANY new BrowserWindow is created (tray click, shortcut launch, `Ctrl+N`), Electron
 *    loads `dist/preload.js` from `app.asar` at its original cached offset.
 *    Even inside Electron's sandboxed preload (`sandbox: true` where `require('fs')` is
 *    blocked), `ipcRenderer.invoke('storage:get-items')` and `webFrame.executeJavaScript`
 *    are 100% natively available.
 *    Stores `statusbar_autoinject.js` inside `%APPDATA%\Antigravity\app_storage.json`
 *    under key `'agy-statusbar-code'`, and patches `dist/preload.js` (preserving its exact
 *    byte size and offset) to invoke `storage:get-items` and execute
 *    `r['agy-statusbar-code']` via `webFrame.executeJavaScript`.
 * 2. Exact-Size `dist/utils.js` and `dist/main.js` Patches (compatible across v2.26.x and v2.27.x+):
 *    Preserves exact byte sizes so all file offsets in `app.asar` remain 100% identical (`0` offset drift).
 * 3. Live CDP Injection (`SessionStart` + `PreInvocation` hooks):
 *    Immediately injects or hot-reloads into currently open windows via `Runtime.evaluate`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME_DIR, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming');

const ASAR_PATH = path.join(LOCAL_APPDATA, 'Programs', 'antigravity', 'resources', 'app.asar');
const AGY_DIR = path.join(HOME_DIR, '.gemini', 'antigravity');
const AUTOINJECT_PATH = path.join(AGY_DIR, 'statusbar_autoinject.js');
const LOCK_PATH = path.join(AGY_DIR, 'statusbar_patch.lock');
const STATUS_PATH = path.join(AGY_DIR, 'statusbar_patch_status.json');
const DEVTOOLS_PORT_FILE = path.join(APPDATA, 'Antigravity', 'DevToolsActivePort');
const APP_STORAGE_PATH = path.join(APPDATA, 'Antigravity', 'app_storage.json');

const PATCH_MARKER = 'AGY_STATUSBAR_AUTOINJECT_V5';
const LEGACY_MARKERS = [
  'statusbar_autoinject.js',
  'AGY_STATUSBAR_AUTOINJECT_V2',
  'AGY_STATUSBAR_AUTOINJECT_V3',
  'AGY_STATUSBAR_AUTOINJECT_V4',
];
const STORAGE_CODE_KEY = 'agy-statusbar-code';
const LOCK_STALE_MS = 60000;
const BLOCK_SIZE = 4 * 1024 * 1024;

// Anchor 1: Unconditional loadURL in createWindow(url, storageManager) in dist/utils.js (works on v2.26+ and v2.27+)
const UTILS_ANCHOR_TARGET =
  "    void win.loadURL(url);";

const UTILS_ANCHOR_REPLACEMENT =
  "    // AGY_STATUSBAR_AUTOINJECT_V5\n" +
  "    const _injectAgyStatusBar = () => {\n" +
  "        try {\n" +
  "            const _fs = require('fs');\n" +
  "            const _path = require('path');\n" +
  "            const _p = _path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'statusbar_autoinject.js');\n" +
  "            if (_fs.existsSync(_p) && !win.isDestroyed() && !win.webContents.isDestroyed()) {\n" +
  "                void win.webContents.executeJavaScript(_fs.readFileSync(_p, 'utf8')).catch(() => {});\n" +
  "            }\n" +
  "        } catch (_e) {}\n" +
  "    };\n" +
  "    win.webContents.on('dom-ready', _injectAgyStatusBar);\n" +
  "    win.webContents.on('did-finish-load', _injectAgyStatusBar);\n" +
  "    void win.loadURL(url);";

// Anchor 2: Global web-contents-created listener in dist/main.js (works on v2.26+ and v2.27+)
const MAIN_ANCHOR_TARGET =
  "electron_1.app.on('web-contents-created', (_event, contents) => {";

const MAIN_ANCHOR_REPLACEMENT =
  "electron_1.app.on('web-contents-created', (_event, contents) => {\n" +
  "    // AGY_STATUSBAR_AUTOINJECT_V5\n" +
  "    if (contents.getType() === 'window') {\n" +
  "        const _injectAgyMain = () => {\n" +
  "            try {\n" +
  "                const _fs = require('fs');\n" +
  "                const _path = require('path');\n" +
  "                const _p = _path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'statusbar_autoinject.js');\n" +
  "                if (_fs.existsSync(_p) && !contents.isDestroyed()) {\n" +
  "                    void contents.executeJavaScript(_fs.readFileSync(_p, 'utf8')).catch(() => {});\n" +
  "                }\n" +
  "            } catch (_e) {}\n" +
  "        };\n" +
  "        contents.on('dom-ready', _injectAgyMain);\n" +
  "        contents.on('did-finish-load', _injectAgyMain);\n" +
  "    }";

// Anchor 3: Sandboxed preload tail in dist/preload.js (uses only ipcRenderer + webFrame, zero fs/path)
const PRELOAD_ANCHOR_TARGET =
  "electron_1.contextBridge.exposeInMainWorld('wsl', wslAPI);";

const PRELOAD_ANCHOR_REPLACEMENT =
  "electron_1.contextBridge.exposeInMainWorld('wsl', wslAPI);\n" +
  "// AGY_STATUSBAR_AUTOINJECT_V5\n" +
  "electron_1.ipcRenderer.invoke('storage:get-items').then((r) => {\n" +
  "    if (r && r['agy-statusbar-code']) {\n" +
  "        void electron_1.webFrame.executeJavaScript(r['agy-statusbar-code']).catch(() => {});\n" +
  "    }\n" +
  "}).catch(() => {});";

function sha256Hex(bufferOrString) {
  return crypto.createHash('sha256').update(bufferOrString).digest('hex');
}

function computeIntegrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
    blocks.push(sha256Hex(buf.subarray(i, Math.min(i + BLOCK_SIZE, buf.length))));
  }
  if (blocks.length === 0) {
    blocks.push(sha256Hex(Buffer.alloc(0)));
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Hex(buf),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

/**
 * Ensures `%APPDATA%\Antigravity\app_storage.json` contains the latest `statusbar_autoinject.js`
 * under `agy-statusbar-code` so `preload.js` can read it via `ipcRenderer.invoke('storage:get-items')`.
 */
function syncAppStorageCode() {
  try {
    if (!fs.existsSync(AUTOINJECT_PATH) || !fs.existsSync(APP_STORAGE_PATH)) {
      return false;
    }
    const code = fs.readFileSync(AUTOINJECT_PATH, 'utf8');
    const raw = fs.readFileSync(APP_STORAGE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data[STORAGE_CODE_KEY] === code) {
      return false;
    }
    data[STORAGE_CODE_KEY] = code;
    fs.writeFileSync(APP_STORAGE_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Transforms `origBuf` by replacing `anchorTarget` with `anchorReplacement` while
 * preserving the EXACT byte length of `origBuf` (by stripping comment lines and padding
 * trailing comment spaces). Validates syntax via `vm.Script`.
 */
function transformExactSize(origBuf, anchorTarget, anchorReplacement) {
  const origSize = origBuf.length;
  const origStr = origBuf.toString('utf8');
  const hasCrlf = origStr.includes('\r\n');
  const normalized = origStr.replace(/\r\n/g, '\n');

  const occ = normalized.split(anchorTarget).length - 1;
  if (occ !== 1) {
    throw new Error(`Anchor occurrences=${occ}`);
  }

  const modified = normalized.replace(anchorTarget, anchorReplacement);
  const lines = modified.split('\n');
  const strippedLines = [];
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(PATCH_MARKER)) {
      strippedLines.push(line);
      continue;
    }
    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {
        inBlockComment = true;
      }
      continue;
    }
    if (trimmed.startsWith('//')) {
      continue;
    }
    strippedLines.push(line);
  }

  let candidate = strippedLines.join(hasCrlf ? '\r\n' : '\n');
  const candBytes = Buffer.byteLength(candidate, 'utf8');
  if (candBytes > origSize) {
    throw new Error(`Patched content exceeds original byte size: ${candBytes} > ${origSize}`);
  }

  const diff = origSize - candBytes;
  if (diff > 0) {
    if (diff >= 3) {
      candidate += '//' + ' '.repeat(diff - 3) + '\n';
    } else {
      candidate += ' '.repeat(diff);
    }
  }

  const outBuf = Buffer.from(candidate, 'utf8');
  if (outBuf.length !== origSize) {
    throw new Error(`Exact size mismatch: ${outBuf.length} !== ${origSize}`);
  }

  new vm.Script(outBuf.toString('utf8'));
  return outBuf;
}

/**
 * O(1) Fast-Path check using partial file descriptor reads (~1-2ms).
 * Verifies `dist/utils.js`, `dist/main.js`, and `dist/preload.js` inside `app.asar`
 * all contain PATCH_MARKER and `dist/preload.js` starts with `"use strict";`.
 */
function isAsarPatchedFast(asarPath = ASAR_PATH) {
  let fd = null;
  try {
    if (!fs.existsSync(asarPath)) return true;
    fd = fs.openSync(asarPath, 'r');
    const prefixBuf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, prefixBuf, 0, 16, 0);
    if (bytesRead < 16) return false;

    const u4 = prefixBuf.readUInt32LE(4);
    const strSize = prefixBuf.readUInt32LE(12);
    if (strSize <= 0 || strSize > 10 * 1024 * 1024) return false;

    const headerBuf = Buffer.alloc(strSize);
    fs.readSync(fd, headerBuf, 0, strSize, 16);
    const header = JSON.parse(headerBuf.toString('utf8'));
    const dataOffset = 8 + u4;

    const distFiles = header?.files?.dist?.files;
    if (!distFiles) return false;

    const utilsNode = distFiles['utils.js'];
    const mainNode = distFiles['main.js'];
    const preloadNode = distFiles['preload.js'];
    if (!utilsNode || !mainNode || !preloadNode) return false;

    const utilsBuf = Buffer.alloc(utilsNode.size);
    fs.readSync(fd, utilsBuf, 0, utilsNode.size, dataOffset + Number(utilsNode.offset));

    const mainBuf = Buffer.alloc(mainNode.size);
    fs.readSync(fd, mainBuf, 0, mainNode.size, dataOffset + Number(mainNode.offset));

    const preloadBuf = Buffer.alloc(preloadNode.size);
    fs.readSync(fd, preloadBuf, 0, preloadNode.size, dataOffset + Number(preloadNode.offset));

    const utilsStr = utilsBuf.toString('utf8');
    const mainStr = mainBuf.toString('utf8');
    const preloadStr = preloadBuf.toString('utf8');

    return (
      utilsStr.includes(PATCH_MARKER) &&
      mainStr.includes(PATCH_MARKER) &&
      preloadStr.startsWith('"use strict";') &&
      preloadStr.includes(PATCH_MARKER)
    );
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function acquireLock() {
  try {
    fs.mkdirSync(AGY_DIR, { recursive: true });
    if (fs.existsSync(LOCK_PATH)) {
      const stat = fs.statSync(LOCK_PATH);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(LOCK_PATH); } catch {}
      }
    }
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {}
}

function writeStatus(statusObj) {
  try {
    fs.mkdirSync(AGY_DIR, { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify(statusObj, null, 2) + '\n', 'utf8');
  } catch {}
}

function readDevToolsPort() {
  try {
    if (!fs.existsSync(DEVTOOLS_PORT_FILE)) return null;
    const lines = fs.readFileSync(DEVTOOLS_PORT_FILE, 'utf8').trim().split(/\r?\n/);
    const port = parseInt(lines[0], 10);
    return port && !Number.isNaN(port) ? port : null;
  } catch {
    return null;
  }
}

function httpGetJson(port, reqPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('HTTP timeout'));
    });
  });
}

function configureTargetViaCdp(wsUrl, scriptCode, scriptHash, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new Error('Global WebSocket unavailable'));
      return;
    }
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('WebSocket evaluation timeout'));
    }, timeoutMs);

    const immediateExpr = `(() => {
      if (document.querySelector('.agy-ctx-statusbar') && window.__agyStatusBarCleanup && window.__agyStatusBarHash === ${JSON.stringify(scriptHash)}) {
        return 'ALREADY_ACTIVE';
      }
      ${scriptCode}
      window.__agyStatusBarHash = ${JSON.stringify(scriptHash)};
      return 'INJECTED_OK';
    })()`;

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: immediateExpr,
            returnByValue: true,
          },
        }));
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(err);
        }
      }
    };

    ws.onmessage = (event) => {
      if (settled) return;
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (msg.id === 1) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(msg?.result?.result?.value ?? null);
        }
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      }
    };

    ws.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(err instanceof Error ? err : new Error('WebSocket error'));
    };
  });
}

async function injectViaCdpLive() {
  if (!fs.existsSync(AUTOINJECT_PATH)) {
    return { attempted: false, reason: 'autoinject_script_missing', injectedCount: 0 };
  }
  const port = readDevToolsPort();
  if (!port) {
    return { attempted: false, reason: 'devtools_port_missing', injectedCount: 0 };
  }

  const scriptCode = fs.readFileSync(AUTOINJECT_PATH, 'utf8');
  const scriptHash = sha256Hex(scriptCode).slice(0, 16);
  const targets = await httpGetJson(port, '/json/list', 1500);
  const pageTargets = (Array.isArray(targets) ? targets : []).filter(
    (t) => t && t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').startsWith('devtools://')
  );

  let injectedCount = 0;
  let skippedAlreadyActive = 0;

  for (const target of pageTargets) {
    try {
      const val = await configureTargetViaCdp(target.webSocketDebuggerUrl, scriptCode, scriptHash, 1500);
      if (val === 'INJECTED_OK') injectedCount++;
      else if (val === 'ALREADY_ACTIVE') skippedAlreadyActive++;
    } catch {
      // Ignore individual target failures
    }
  }

  return {
    attempted: true,
    port,
    pageTargetCount: pageTargets.length,
    injectedCount,
    skippedAlreadyActive,
  };
}

function readAsarArchive(filePath) {
  const buf = fs.readFileSync(filePath);
  const u0 = buf.readUInt32LE(0);
  const u4 = buf.readUInt32LE(4);
  const strSize = buf.readUInt32LE(12);
  const dataOffset = 8 + u4;
  const header = JSON.parse(buf.toString('utf8', 16, 16 + strSize));

  const fileMap = new Map();
  function extractNode(node, relPath) {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        extractNode(child, relPath ? `${relPath}/${name}` : name);
      }
    } else if (!node.unpacked && node.offset !== undefined && node.size !== undefined) {
      const start = dataOffset + Number(node.offset);
      fileMap.set(relPath, buf.subarray(start, start + node.size));
    }
  }
  extractNode(header, '');

  let appVersion = 'unknown';
  try {
    const pkgBuf = fileMap.get('package.json');
    if (pkgBuf) {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      if (pkg && pkg.version) appVersion = String(pkg.version);
    }
  } catch {}

  return { buf, u0, u4, strSize, dataOffset, header, fileMap, appVersion };
}

function patchAsarOnDisk() {
  syncAppStorageCode();

  if (!fs.existsSync(ASAR_PATH)) {
    return { status: 'SKIPPED_NO_ASAR' };
  }
  if (!fs.existsSync(AUTOINJECT_PATH)) {
    return { status: 'SKIPPED_NO_AUTOINJECT_SCRIPT' };
  }

  if (isAsarPatchedFast(ASAR_PATH)) {
    let currentArchive = null;
    try {
      currentArchive = readAsarArchive(ASAR_PATH);
    } catch {}
    return {
      status: 'ALREADY_PATCHED',
      patchVersion: PATCH_MARKER,
      appVersion: currentArchive?.appVersion || 'unknown',
    };
  }

  let archive = readAsarArchive(ASAR_PATH);
  const appVersion = archive.appVersion;
  const backupPath = `${ASAR_PATH}.v${appVersion}.orig`;

  const curUtils = archive.fileMap.get('dist/utils.js')?.toString('utf8') || '';
  const curMain = archive.fileMap.get('dist/main.js')?.toString('utf8') || '';
  const curPreload = archive.fileMap.get('dist/preload.js')?.toString('utf8') || '';

  const hasAnyMarker = (str) =>
    str.includes(PATCH_MARKER) || LEGACY_MARKERS.some((m) => str.includes(m));

  const isPureUnpatched =
    !hasAnyMarker(curUtils) &&
    !hasAnyMarker(curMain) &&
    !hasAnyMarker(curPreload);

  let backupCreated = false;
  if (isPureUnpatched && !fs.existsSync(backupPath)) {
    fs.copyFileSync(ASAR_PATH, backupPath);
    backupCreated = true;
  } else if (!isPureUnpatched && fs.existsSync(backupPath)) {
    archive = readAsarArchive(backupPath);
  }

  const origArchiveSize = archive.buf.length;
  const origPreloadOffset = archive.header?.files?.dist?.files?.['preload.js']?.offset;
  const { u0, header, fileMap } = archive;

  const utilsBuf = fileMap.get('dist/utils.js');
  const mainBuf = fileMap.get('dist/main.js');
  const preloadBuf = fileMap.get('dist/preload.js');
  if (!utilsBuf || !mainBuf || !preloadBuf) {
    return { status: 'FAILED_TARGET_FILES_MISSING', appVersion };
  }

  let patchedUtilsBuf;
  let patchedMainBuf;
  let patchedPreloadBuf;
  try {
    patchedUtilsBuf = transformExactSize(utilsBuf, UTILS_ANCHOR_TARGET, UTILS_ANCHOR_REPLACEMENT);
    patchedMainBuf = transformExactSize(mainBuf, MAIN_ANCHOR_TARGET, MAIN_ANCHOR_REPLACEMENT);
    patchedPreloadBuf = transformExactSize(preloadBuf, PRELOAD_ANCHOR_TARGET, PRELOAD_ANCHOR_REPLACEMENT);
  } catch (err) {
    return {
      status: 'FAILED_PATTERN_OR_SIZE',
      appVersion,
      detail: String(err?.message || err),
    };
  }

  fileMap.set('dist/utils.js', patchedUtilsBuf);
  fileMap.set('dist/main.js', patchedMainBuf);
  fileMap.set('dist/preload.js', patchedPreloadBuf);

  // Rebuild ASAR payload & recalculate SHA256 integrity while keeping 100% identical offsets & sizes
  const chunks = [];
  let currentOffset = 0n;

  function rebuildNode(node, relPath) {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        rebuildNode(child, relPath ? `${relPath}/${name}` : name);
      }
    } else if (!node.unpacked && node.offset !== undefined && node.size !== undefined) {
      const data = fileMap.get(relPath);
      node.size = data.length;
      node.offset = currentOffset.toString();
      node.integrity = computeIntegrity(data);
      chunks.push(data);
      currentOffset += BigInt(data.length);
    }
  }
  rebuildNode(header, '');

  const newPreloadOffset = header?.files?.dist?.files?.['preload.js']?.offset;
  if (origPreloadOffset !== newPreloadOffset) {
    return {
      status: 'FAILED_OFFSET_DRIFT',
      appVersion,
      detail: `preload.js offset drifted: ${origPreloadOffset} -> ${newPreloadOffset}`,
    };
  }

  const newHeaderStr = JSON.stringify(header);
  const newHeaderStrBuf = Buffer.from(newHeaderStr, 'utf8');
  const newStrSize = newHeaderStrBuf.length;
  const alignedStrSize = Math.ceil(newStrSize / 4) * 4;
  const newU8 = 4 + alignedStrSize;
  const newU4 = 4 + newU8;
  const totalHeaderSize = 8 + newU4;

  const newHeaderBuf = Buffer.alloc(totalHeaderSize, 0);
  newHeaderBuf.writeUInt32LE(u0, 0);
  newHeaderBuf.writeUInt32LE(newU4, 4);
  newHeaderBuf.writeUInt32LE(newU8, 8);
  newHeaderBuf.writeUInt32LE(newStrSize, 12);
  newHeaderStrBuf.copy(newHeaderBuf, 16);

  const outBuf = Buffer.concat([newHeaderBuf, ...chunks]);
  if (outBuf.length !== origArchiveSize) {
    return {
      status: 'FAILED_ARCHIVE_SIZE_DRIFT',
      appVersion,
      detail: `archive size drifted: ${origArchiveSize} -> ${outBuf.length}`,
    };
  }

  const tmpPath = `${ASAR_PATH}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, outBuf);
    try {
      fs.renameSync(tmpPath, ASAR_PATH);
    } catch {
      fs.copyFileSync(tmpPath, ASAR_PATH);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  return {
    status: 'PATCHED',
    patchVersion: PATCH_MARKER,
    appVersion,
    backupPath,
    backupCreated,
    exactOffsetPreserved: true,
    preloadOffset: newPreloadOffset,
    bytes: outBuf.length,
    sha256: sha256Hex(outBuf).toUpperCase(),
  };
}

async function runWorkerMode() {
  if (!acquireLock()) {
    return;
  }
  const statusReport = {
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    cdp: null,
    asar: null,
  };

  try {
    // Block A: Isolated live CDP injection
    try {
      statusReport.cdp = await injectViaCdpLive();
    } catch (err) {
      statusReport.cdp = { error: String(err?.message || err) };
    }

    // Block B: Exact-size / offset-preserving persistent app.asar patch + app_storage sync
    try {
      statusReport.asar = patchAsarOnDisk();
    } catch (err) {
      statusReport.asar = { status: 'ERROR_EXCEPTION', error: String(err?.message || err) };
    }

    if (
      !fs.existsSync(STATUS_PATH) ||
      (statusReport.cdp && statusReport.cdp.injectedCount > 0) ||
      (statusReport.asar && statusReport.asar.status !== 'ALREADY_PATCHED')
    ) {
      writeStatus(statusReport);
    }
  } finally {
    releaseLock();
  }
}

async function runHookFastPath() {
  // Drain stdin silently so the host hook runner never gets EPIPE
  try {
    fs.readFileSync(0);
  } catch {}

  try {
    syncAppStorageCode();
    if (!isAsarPatchedFast()) {
      const child = spawn(process.execPath, [__filename, '--worker'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else {
      await injectViaCdpLive();
    }
  } catch {}
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--worker')) {
    await runWorkerMode();
    process.exit(0);
  } else if (args.includes('--status')) {
    const patched = isAsarPatchedFast();
    let lastStatus = null;
    try {
      if (fs.existsSync(STATUS_PATH)) {
        lastStatus = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
      }
    } catch {}
    process.stdout.write(JSON.stringify({ isAsarPatched: patched, patchVersion: PATCH_MARKER, lastStatus }, null, 2) + '\n');
    process.exit(0);
  } else {
    await runHookFastPath();
  }
}

module.exports = {
  PATCH_MARKER,
  UTILS_ANCHOR_TARGET,
  UTILS_ANCHOR_REPLACEMENT,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  PRELOAD_ANCHOR_TARGET,
  PRELOAD_ANCHOR_REPLACEMENT,
  sha256Hex,
  computeIntegrity,
  transformExactSize,
  isAsarPatchedFast,
};

if (require.main === module) {
  main().catch(() => process.exit(0));
}
