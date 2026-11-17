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
const APP_STORAGE_LOCK_PATH = path.join(AGY_DIR, 'statusbar_app_storage.lock');
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
const APP_STORAGE_LOCK_STALE_MS = 15000;
const MAX_WS_BUFFER_BYTES = 16 * 1024 * 1024;
const LOCK_TOKEN = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
const BLOCK_SIZE = 4 * 1024 * 1024;

// Anchor 1: Unconditional loadURL in createWindow(url, storageManager) in dist/utils.js (works on v2.26+ and v2.27+)
const UTILS_ANCHOR_TARGET =
  "    void win.loadURL(url);";

const UTILS_ANCHOR_REPLACEMENT =
  "    // AGY_STATUSBAR_AUTOINJECT_V5\n" +
  "    const _injectAgyStatusBar = () => {\n" +
  "        try {\n" +
  "            if (win.isDestroyed() || win.webContents.isDestroyed() || !/^https?:/i.test(win.webContents.getURL())) return;\n" +
  "            const _p = require('path').join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'statusbar_autoinject.js');\n" +
  "            if (require('fs').existsSync(_p)) void win.webContents.executeJavaScript(require('fs').readFileSync(_p, 'utf8')).catch(() => {});\n" +
  "        } catch (_e) {}\n" +
  "    };\n" +
  "    win.webContents.on('dom-ready', _injectAgyStatusBar);\n" +
  "    win.webContents.on('did-finish-load', _injectAgyStatusBar);\n" +
  "    void win.loadURL(url);";

// Anchor 2: Global web-contents-created listener in dist/main.js (works on v2.26+ through v2.32+)
const MAIN_ANCHOR_TARGET =
  "electron_1.app.on('web-contents-created', (_event, contents) => {";

const MAIN_ANCHOR_REPLACEMENT =
  "electron_1.app.on('web-contents-created', (_event, contents) => {\n" +
  "    // AGY_STATUSBAR_AUTOINJECT_V5\n" +
  "    if (contents.getType() === 'window' && !(typeof scriptJail_1 !== 'undefined' && scriptJail_1.isScriptJailSession && scriptJail_1.isScriptJailSession(contents.session))) {\n" +
  "        const _injectAgyMain = () => {\n" +
  "            try {\n" +
  "                if (contents.isDestroyed() || !/^https?:/i.test(contents.getURL())) return;\n" +
  "                const _p = require('path').join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'statusbar_autoinject.js');\n" +
  "                if (require('fs').existsSync(_p)) void contents.executeJavaScript(require('fs').readFileSync(_p, 'utf8')).catch(() => {});\n" +
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
  "if (/^https?:$/i.test(globalThis.location?.protocol || '')) {\n" +
  "    electron_1.ipcRenderer.invoke('storage:get-items').then((r) => {\n" +
  "        if (r && r['agy-statusbar-code']) {\n" +
  "            void electron_1.webFrame.executeJavaScript(r['agy-statusbar-code']).catch(() => {});\n" +
  "        }\n" +
  "    }).catch(() => {});\n" +
  "}";

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
  let tmpPath = null;
  let storageLockToken = null;
  try {
    if (!fs.existsSync(AUTOINJECT_PATH) || !fs.existsSync(APP_STORAGE_PATH)) {
      return false;
    }
    const code = fs.readFileSync(AUTOINJECT_PATH, 'utf8');
    const fastRaw = fs.readFileSync(APP_STORAGE_PATH, 'utf8');
    const fastData = JSON.parse(fastRaw);
    if (fastData && typeof fastData === 'object' && fastData[STORAGE_CODE_KEY] === code) {
      return false;
    }

    const candToken = `${LOCK_TOKEN}:storage:${crypto.randomBytes(4).toString('hex')}`;
    if (!acquireFileLock(APP_STORAGE_LOCK_PATH, candToken, APP_STORAGE_LOCK_STALE_MS)) {
      return false;
    }
    storageLockToken = candToken;

    const latestRaw = fs.readFileSync(APP_STORAGE_PATH, 'utf8');
    const data = JSON.parse(latestRaw);
    if (!data || typeof data !== 'object' || data[STORAGE_CODE_KEY] === code) {
      return false;
    }
    data[STORAGE_CODE_KEY] = code;
    const serialized = JSON.stringify(data, null, 2);
    tmpPath = `${APP_STORAGE_PATH}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    try {
      fs.renameSync(tmpPath, APP_STORAGE_PATH);
    } catch {
      fs.copyFileSync(tmpPath, APP_STORAGE_PATH);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return true;
  } catch {
    return false;
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    if (storageLockToken) {
      releaseFileLock(APP_STORAGE_LOCK_PATH, storageLockToken);
    }
  }
}

const REGEX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof',
  'instanceof', 'in', 'of', 'new', 'yield', 'await', 'else', 'do',
]);

function countTrailingBackslashes(str) {
  let count = 0;
  for (let i = str.length - 1; i >= 0 && str[i] === '\\'; i--) {
    count += 1;
  }
  return count;
}

function stripPureCommentLinesLexical(lines) {
  const out = [];
  const stack = [
    { mode: 'CODE', braceDepth: 0, regexAllowed: true, prevWasDot: false, lastControlKw: false, parenStack: [] },
  ];
  let inBlockComment = false;
  let inSingle = false;
  let inDouble = false;

  for (const line of lines) {
    const startsInTemplate = stack[stack.length - 1].mode === 'TEMPLATE';
    const startsInString = inSingle || inDouble;
    const startsInBlockComment = inBlockComment;
    const trimmed = line.trim();

    if (!startsInTemplate && !startsInString && !startsInBlockComment && trimmed.includes(PATCH_MARKER)) {
      out.push(line);
      continue;
    }

    let i = 0;
    let inRegex = false;
    let inRegexCharClass = false;
    let hasCodeTokenOnLine = false;

    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1] || '';
      const top = stack[stack.length - 1];

      if (top.mode === 'TEMPLATE') {
        hasCodeTokenOnLine = true;
        if (ch === '\\') { i += 2; continue; }
        if (ch === '`') {
          stack.pop();
          const outer = stack[stack.length - 1];
          outer.regexAllowed = false;
          outer.prevWasDot = false;
          outer.lastControlKw = false;
          i += 1;
          continue;
        }
        if (ch === '$' && next === '{') {
          stack.push({ mode: 'TEMPLATE_EXPR', braceDepth: 1, regexAllowed: true, prevWasDot: false, lastControlKw: false, parenStack: [] });
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (inSingle) {
        hasCodeTokenOnLine = true;
        if (ch === '\\') { i += 2; continue; }
        if (ch === "'") {
          inSingle = false;
          top.regexAllowed = false;
          top.prevWasDot = false;
          top.lastControlKw = false;
        }
        i += 1;
        continue;
      }

      if (inDouble) {
        hasCodeTokenOnLine = true;
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') {
          inDouble = false;
          top.regexAllowed = false;
          top.prevWasDot = false;
          top.lastControlKw = false;
        }
        i += 1;
        continue;
      }

      if (inRegex) {
        hasCodeTokenOnLine = true;
        if (ch === '\\') { i += 2; continue; }
        if (inRegexCharClass) {
          if (ch === ']') inRegexCharClass = false;
          i += 1;
          continue;
        }
        if (ch === '[') { inRegexCharClass = true; i += 1; continue; }
        if (ch === '/') {
          inRegex = false;
          i += 1;
          while (i < line.length && /[A-Za-z]/.test(line[i])) i += 1;
          top.regexAllowed = false;
          top.prevWasDot = false;
          top.lastControlKw = false;
          continue;
        }
        i += 1;
        continue;
      }

      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        break;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }

      hasCodeTokenOnLine = true;
      if (ch === '/' && top.regexAllowed) {
        inRegex = true;
        inRegexCharClass = false;
        i += 1;
        continue;
      }
      if (ch === "'") { inSingle = true; i += 1; continue; }
      if (ch === '"') { inDouble = true; i += 1; continue; }
      if (ch === '`') { stack.push({ mode: 'TEMPLATE' }); i += 1; continue; }

      if (/[A-Za-z_$]/.test(ch)) {
        let end = i + 1;
        while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) end += 1;
        const word = line.slice(i, end);
        const wasDot = top.prevWasDot;
        top.regexAllowed = !wasDot && REGEX_KEYWORDS.has(word);
        top.lastControlKw = !wasDot && (word === 'if' || word === 'while' || word === 'for' || word === 'with');
        top.prevWasDot = false;
        i = end;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) {
        let end = i + 1;
        while (end < line.length && /[0-9A-Za-z_.]/.test(line[end])) end += 1;
        top.regexAllowed = false;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i = end;
        continue;
      }
      if (ch === '(') {
        top.parenStack.push(top.lastControlKw);
        top.regexAllowed = true;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      if (ch === ')') {
        top.regexAllowed = Boolean(top.parenStack.pop());
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      if (ch === '[') { top.regexAllowed = true; top.prevWasDot = false; top.lastControlKw = false; i += 1; continue; }
      if (ch === ']') { top.regexAllowed = false; top.prevWasDot = false; top.lastControlKw = false; i += 1; continue; }
      if (ch === '{') {
        if (top.mode === 'TEMPLATE_EXPR') top.braceDepth += 1;
        top.regexAllowed = true;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (top.mode === 'TEMPLATE_EXPR') {
          top.braceDepth -= 1;
          if (top.braceDepth === 0) {
            stack.pop();
            i += 1;
            continue;
          }
        }
        top.regexAllowed = true;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
        top.regexAllowed = false;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 2;
        continue;
      }
      if (ch === '.' && next === '.' && line[i + 2] === '.') {
        top.regexAllowed = true;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 3;
        continue;
      }
      if (ch === '.') {
        top.regexAllowed = false;
        top.prevWasDot = true;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      top.regexAllowed = true;
      top.prevWasDot = false;
      top.lastControlKw = false;
      i += 1;
    }

    if (inSingle && countTrailingBackslashes(line) % 2 === 0) inSingle = false;
    if (inDouble && countTrailingBackslashes(line) % 2 === 0) inDouble = false;

    if (startsInTemplate || startsInString) {
      out.push(line);
      continue;
    }
    if (!hasCodeTokenOnLine && (startsInBlockComment || trimmed.startsWith('//') || trimmed.startsWith('/*'))) {
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Transforms `origBuf` by replacing `anchorTarget` with `anchorReplacement` while
 * preserving the EXACT byte length of `origBuf` (by stripping pure comment lines outside
 * strings/templates and padding trailing comment spaces). Validates syntax via `vm.Script`.
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
  const strippedLines = stripPureCommentLinesLexical(modified.split('\n'));

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
    const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''));
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

function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function writeLockPayload(lockPath, token) {
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
      'utf8'
    );
  } finally {
    fs.closeSync(fd);
  }
}

function acquireFileLock(lockPath, token, staleMs = LOCK_STALE_MS) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      writeLockPayload(lockPath, token);
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
    }

    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    let ownerPid = 0;
    try {
      const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      ownerPid = Number(lockInfo?.pid || 0);
    } catch {}
    const ownerAlive = ownerPid > 0 && isProcessAlive(ownerPid);
    const isStale =
      (ownerPid > 0 && !ownerAlive) ||
      (!ownerAlive && ageMs > staleMs) ||
      ageMs > staleMs * 10;
    if (!isStale) return false;

    const staleTmp = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lockPath, staleTmp);
      try { fs.unlinkSync(staleTmp); } catch {}
    } catch {
      return false;
    }
    writeLockPayload(lockPath, token);
    return true;
  } catch {
    return false;
  }
}

function releaseFileLock(lockPath, token) {
  try {
    if (!fs.existsSync(lockPath)) return false;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lockInfo = JSON.parse(raw);
    if (!lockInfo || lockInfo.token !== token) {
      return false;
    }
    const relTmp = `${lockPath}.rel.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lockPath, relTmp);
      fs.unlinkSync(relTmp);
    } catch {
      const verify = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (verify && verify.token === token) {
        fs.unlinkSync(lockPath);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  return acquireFileLock(LOCK_PATH, LOCK_TOKEN, LOCK_STALE_MS);
}

function releaseLock() {
  return releaseFileLock(LOCK_PATH, LOCK_TOKEN);
}

function writeStatus(statusObj) {
  try {
    fs.mkdirSync(AGY_DIR, { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify(statusObj, null, 2) + '\n', 'utf8');
  } catch {}
}

function readDevToolsEndpoint() {
  try {
    if (!fs.existsSync(DEVTOOLS_PORT_FILE)) return null;
    const lines = fs.readFileSync(DEVTOOLS_PORT_FILE, 'utf8').trim().split(/\r?\n/);
    const port = parseInt(lines[0], 10);
    if (!port || Number.isNaN(port)) return null;
    const rawWsLine = (lines[1] || '').trim();
    const browserWsUrl = rawWsLine
      ? (rawWsLine.startsWith('ws://') || rawWsLine.startsWith('wss://')
        ? rawWsLine
        : `ws://127.0.0.1:${port}${rawWsLine.startsWith('/') ? rawWsLine : `/${rawWsLine}`}`)
      : null;
    return { port, browserWsUrl };
  } catch {
    return null;
  }
}

function readDevToolsPort() {
  const ep = readDevToolsEndpoint();
  return ep ? ep.port : null;
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

function detectBundledPlugins(scriptCode) {
  const text = typeof scriptCode === 'string' ? scriptCode : '';
  const expectsStatusbar =
    /^(?:\/\/ @name[ \t]+Antigravity Custom Statusbar\b|\/\/ === BEGIN_AGY_STATUSBAR(?:_V\d+)? ===|\/\* === BEGIN_AGY_STATUSBAR(?:_V\d+)? === \*\/|[ \t]*function\s+mountStatusBar\s*\()/m.test(text);
  const expectsMcp =
    /^(?:\/\/ @name[ \t]+Antigravity Custom MCP Server Manager\b|\/\/ === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? ===|\/\* === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? === \*\/|[ \t]*function\s+mountMcpManager\s*\()/m.test(text);
  const expectsKo =
    /^(?:\/\/ @name[ \t]+Antigravity Korean Thought & UI Translator\b|\/\/ === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? ===|\/\* === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? === \*\/|[ \t]*window\.__agyKoThoughtCleanup\s*=)/m.test(text);
  return { expectsStatusbar, expectsMcp, expectsKo };
}

function buildImmediateEvalExpression(scriptCode, scriptHash) {
  const { expectsStatusbar, expectsMcp, expectsKo } = detectBundledPlugins(scriptCode);
  const activeChecks = [];
  if (expectsStatusbar) {
    activeChecks.push('Boolean(window.agyStatusBar && typeof window.__agyStatusBarCleanup === "function")');
  }
  if (expectsMcp) {
    activeChecks.push('Boolean(window.agyMcpManager && typeof window.agyMcpManager.destroy === "function")');
  }
  if (expectsKo) {
    activeChecks.push('Boolean(typeof window.__agyKoThoughtCleanup === "function" || window.__agyKoLocalizerActive)');
  }
  const activeGuardExpr = activeChecks.length > 0 ? activeChecks.join(' && ') : 'false';
  return `(() => {
      const hasActivePlugin = ${activeGuardExpr};
      if (hasActivePlugin && window.__agyStatusBarHash === ${JSON.stringify(scriptHash)}) {
        return 'ALREADY_ACTIVE';
      }
      ${scriptCode}
      window.__agyStatusBarHash = ${JSON.stringify(scriptHash)};
      return 'INJECTED_OK';
    })()`;
}

function isInjectablePageTarget(t) {
  if (!t || t.type !== 'page') return false;
  const u = String(t.url || '');
  return (
    !u.startsWith('devtools://') &&
    !u.startsWith('chrome-devtools://') &&
    !u.startsWith('data:') &&
    !u.startsWith('about:')
  );
}

function createRfc6455WebSocketClient(wsUrl) {
  const parsed = new URL(wsUrl);
  const secKey = crypto.randomBytes(16).toString('base64');
  const expectedAccept = crypto
    .createHash('sha1')
    .update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  let sock = null;
  let closed = false;
  const client = {
    onopen: null,
    onmessage: null,
    onerror: null,
    send(data) {
      if (closed || !sock) throw new Error('WebSocket is not open');
      const payload = Buffer.from(String(data), 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
      }
      sock.write(Buffer.concat([header, masked]));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (sock) {
          const mask = crypto.randomBytes(4);
          sock.end(Buffer.concat([Buffer.from([0x88, 0x80]), mask]));
          sock.destroy();
        }
      } catch {}
    },
  };

  const req = http.request({
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port) || 80,
    path: (parsed.pathname || '/') + (parsed.search || ''),
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': secKey,
    },
  });

  const emitError = (err) => {
    if (closed) return;
    closed = true;
    try { req.destroy(); } catch {}
    try { if (sock) sock.destroy(); } catch {}
    if (typeof client.onerror === 'function') {
      client.onerror(err instanceof Error ? err : new Error(String(err)));
    }
  };

  req.on('error', emitError);
  req.on('response', (res) => {
    emitError(new Error(`Unexpected HTTP response ${res.statusCode} during WebSocket upgrade`));
  });
  req.on('upgrade', (res, socket, head) => {
    if (res.headers['sec-websocket-accept'] !== expectedAccept) {
      emitError(new Error('Invalid Sec-WebSocket-Accept header'));
      return;
    }
    sock = socket;
    let recvBuf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let fragOpcode = 0;
    let fragChunks = [];
    let fragBytes = 0;

    const drainFrames = () => {
      while (!closed && recvBuf.length >= 2) {
        const fin = (recvBuf[0] & 0x80) !== 0;
        const opcode = recvBuf[0] & 0x0f;
        const isMasked = (recvBuf[1] & 0x80) !== 0;
        let len = recvBuf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (recvBuf.length < 4) return;
          len = recvBuf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (recvBuf.length < 10) return;
          const bigLen = recvBuf.readBigUInt64BE(2);
          if (bigLen > BigInt(MAX_WS_BUFFER_BYTES)) {
            emitError(new Error('WebSocket frame payload exceeds maximum buffer size'));
            return;
          }
          len = Number(bigLen);
          offset = 10;
        }
        if (len > MAX_WS_BUFFER_BYTES) {
          emitError(new Error('WebSocket frame payload exceeds maximum buffer size'));
          return;
        }
        const maskBytes = isMasked ? 4 : 0;
        if (recvBuf.length < offset + maskBytes + len) return;
        const body = Buffer.from(recvBuf.subarray(offset + maskBytes, offset + maskBytes + len));
        if (isMasked) {
          const m = recvBuf.subarray(offset, offset + 4);
          for (let i = 0; i < body.length; i++) body[i] ^= m[i & 3];
        }
        recvBuf = recvBuf.subarray(offset + maskBytes + len);

        if (opcode === 0x08) {
          client.close();
          return;
        }
        if (opcode === 0x09 && sock && !closed) {
          const pongPayload = body.length <= 125 ? body : body.subarray(0, 125);
          const pongMask = crypto.randomBytes(4);
          const pongHdr = Buffer.from([0x8a, 0x80 | pongPayload.length]);
          const maskedPong = Buffer.allocUnsafe(pongPayload.length);
          for (let i = 0; i < pongPayload.length; i++) {
            maskedPong[i] = pongPayload[i] ^ pongMask[i & 3];
          }
          sock.write(Buffer.concat([pongHdr, pongMask, maskedPong]));
          continue;
        }
        if (opcode === 0x0a) {
          continue;
        }
        if (opcode === 0x01 || opcode === 0x02) {
          if (fin) {
            if (opcode === 0x01 && typeof client.onmessage === 'function') {
              client.onmessage({ data: body.toString('utf8') });
            }
          } else {
            fragOpcode = opcode;
            fragChunks = [body];
            fragBytes = body.length;
          }
          continue;
        }
        if (opcode === 0x00) {
          if (!fragOpcode) {
            emitError(new Error('Unexpected WebSocket continuation frame'));
            return;
          }
          fragBytes += body.length;
          if (fragBytes > MAX_WS_BUFFER_BYTES) {
            emitError(new Error('WebSocket fragmented message exceeds maximum buffer size'));
            return;
          }
          fragChunks.push(body);
          if (fin) {
            const fullBuf = Buffer.concat(fragChunks, fragBytes);
            const completedOp = fragOpcode;
            fragOpcode = 0;
            fragChunks = [];
            fragBytes = 0;
            if (completedOp === 0x01 && typeof client.onmessage === 'function') {
              client.onmessage({ data: fullBuf.toString('utf8') });
            }
          }
        }
      }
    };

    socket.on('data', (chunk) => {
      if (recvBuf.length + chunk.length > MAX_WS_BUFFER_BYTES) {
        emitError(new Error('WebSocket receive buffer exceeded maximum size'));
        return;
      }
      recvBuf = Buffer.concat([recvBuf, chunk]);
      drainFrames();
    });
    socket.on('error', emitError);
    socket.on('close', () => {
      closed = true;
    });

    Promise.resolve().then(() => {
      if (!closed && typeof client.onopen === 'function') {
        client.onopen();
      }
      if (!closed && recvBuf.length > 0) {
        drainFrames();
      }
    });
  });
  req.end();
  return client;
}

function openCdpWebSocket(wsUrl) {
  if (typeof WebSocket === 'function') {
    return new WebSocket(wsUrl);
  }
  return createRfc6455WebSocketClient(wsUrl);
}

function configureTargetViaCdp(wsUrl, scriptCode, scriptHash, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = openCdpWebSocket(wsUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('WebSocket evaluation timeout'));
    }, timeoutMs);

    const immediateExpr = buildImmediateEvalExpression(scriptCode, scriptHash);

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
          if (msg.error) {
            reject(new Error(msg.error.message || 'CDP Runtime.evaluate error'));
            return;
          }
          if (msg?.result?.exceptionDetails) {
            const det = msg.result.exceptionDetails;
            const desc = det?.exception?.description || det?.text || 'CDP Runtime.evaluate exception';
            reject(new Error(desc));
            return;
          }
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

function injectViaBrowserCdpWs(browserWsUrl, scriptCode, scriptHash, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let closed = false;
    let nextId = 1;
    const pending = new Map();
    let ws;
    try {
      ws = openCdpWebSocket(browserWsUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const immediateExpr = buildImmediateEvalExpression(scriptCode, scriptHash);

    const finish = (err, val) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const [, p] of pending) {
        p.reject(err || new Error('Browser CDP socket closed'));
      }
      pending.clear();
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };

    const timer = setTimeout(() => {
      finish(new Error('Browser CDP WebSocket timeout'));
    }, timeoutMs);

    const sendCdp = (method, params = {}, sessionId = undefined) =>
      new Promise((res, rej) => {
        if (closed) {
          rej(new Error('Browser CDP socket closed'));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          pending.delete(id);
          rej(err);
        }
      });

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || `CDP ${msg.error.code || ''} error`));
          } else {
            entry.resolve(msg.result);
          }
        }
      } catch {}
    };

    ws.onerror = (err) => {
      finish(err instanceof Error ? err : new Error('Browser CDP WebSocket error'));
    };

    ws.onopen = async () => {
      try {
        const targetsRes = await sendCdp('Target.getTargets', {});
        const targetInfos = Array.isArray(targetsRes?.targetInfos) ? targetsRes.targetInfos : [];
        const pageTargets = targetInfos.filter((t) => t && t.targetId && isInjectablePageTarget(t));
        let injectedCount = 0;
        let skippedAlreadyActive = 0;

        const results = await Promise.allSettled(
          pageTargets.map(async (target) => {
            let sessionId = null;
            try {
              const attachRes = await sendCdp('Target.attachToTarget', {
                targetId: target.targetId,
                flatten: true,
              });
              sessionId = attachRes?.sessionId || null;
              if (!sessionId) return null;
              const evalRes = await sendCdp(
                'Runtime.evaluate',
                { expression: immediateExpr, returnByValue: true },
                sessionId
              );
              if (evalRes?.exceptionDetails) {
                const det = evalRes.exceptionDetails;
                throw new Error(det?.exception?.description || det?.text || 'CDP Runtime.evaluate exception');
              }
              return evalRes?.result?.value ?? null;
            } finally {
              if (sessionId) {
                await sendCdp('Target.detachFromTarget', { sessionId }).catch(() => {});
              }
            }
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value === 'INJECTED_OK') injectedCount++;
            else if (r.value === 'ALREADY_ACTIVE') skippedAlreadyActive++;
          }
        }

        finish(null, {
          pageTargetCount: pageTargets.length,
          injectedCount,
          skippedAlreadyActive,
        });
      } catch (err) {
        finish(err);
      }
    };
  });
}

async function injectViaCdpLive() {
  if (!fs.existsSync(AUTOINJECT_PATH)) {
    return { attempted: false, reason: 'autoinject_script_missing', injectedCount: 0 };
  }
  const endpoint = readDevToolsEndpoint();
  if (!endpoint || !endpoint.port) {
    return { attempted: false, reason: 'devtools_port_missing', injectedCount: 0 };
  }
  const { port } = endpoint;
  let { browserWsUrl } = endpoint;

  const scriptCode = fs.readFileSync(AUTOINJECT_PATH, 'utf8');
  const scriptHash = sha256Hex(scriptCode).slice(0, 16);

  let pageTargets = [];
  try {
    const targets = await httpGetJson(port, '/json/list', 1500);
    pageTargets = (Array.isArray(targets) ? targets : []).filter(
      (t) => t && t.webSocketDebuggerUrl && isInjectablePageTarget(t)
    );
  } catch {
    pageTargets = [];
  }

  let injectedCount = 0;
  let skippedAlreadyActive = 0;

  if (pageTargets.length > 0) {
    const settled = await Promise.allSettled(
      pageTargets.map((target) =>
        configureTargetViaCdp(target.webSocketDebuggerUrl, scriptCode, scriptHash, 1500)
      )
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if (r.value === 'INJECTED_OK') injectedCount++;
        else if (r.value === 'ALREADY_ACTIVE') skippedAlreadyActive++;
      }
    }
    return {
      attempted: true,
      port,
      mode: 'http_json_list',
      pageTargetCount: pageTargets.length,
      injectedCount,
      skippedAlreadyActive,
    };
  }

  if (!browserWsUrl) {
    try {
      const ver = await httpGetJson(port, '/json/version', 1000);
      if (ver && typeof ver.webSocketDebuggerUrl === 'string' && ver.webSocketDebuggerUrl) {
        browserWsUrl = ver.webSocketDebuggerUrl;
      }
    } catch {}
  }

  if (browserWsUrl) {
    const browserRes = await injectViaBrowserCdpWs(browserWsUrl, scriptCode, scriptHash, 4000);
    return {
      attempted: true,
      port,
      mode: 'browser_ws',
      pageTargetCount: browserRes.pageTargetCount,
      injectedCount: browserRes.injectedCount,
      skippedAlreadyActive: browserRes.skippedAlreadyActive,
    };
  }

  return {
    attempted: true,
    port,
    mode: 'none',
    pageTargetCount: 0,
    injectedCount: 0,
    skippedAlreadyActive: 0,
  };
}

function readAsarArchive(filePath) {
  const buf = fs.readFileSync(filePath);
  const u0 = buf.readUInt32LE(0);
  const u4 = buf.readUInt32LE(4);
  const strSize = buf.readUInt32LE(12);
  const dataOffset = 8 + u4;
  const header = JSON.parse(buf.toString('utf8', 16, 16 + strSize).replace(/\0+$/, ''));

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
  // Drain stdin non-blockingly so the host hook runner never gets EPIPE, without hanging on TTY or open pipes
  try {
    if (process.stdin && !process.stdin.isTTY) {
      process.stdin.on('error', () => {});
      process.stdin.resume();
    }
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
  acquireLock,
  releaseLock,
  syncAppStorageCode,
  detectBundledPlugins,
  createRfc6455WebSocketClient,
  configureTargetViaCdp,
  injectViaBrowserCdpWs,
  readDevToolsEndpoint,
};

if (require.main === module) {
  main().catch(() => process.exit(0));
}
