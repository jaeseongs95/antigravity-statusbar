'use strict';

/**
 * ASAR Codec & Exact-Size Electron Bundle Patcher.
 * Preserves exact byte size & file offsets (`0` offset drift) across app.asar.
 */

const fs = require('fs');
const crypto = require('crypto');
const vm = require('vm');

const PATCH_MARKER = 'AGY_STATUSBAR_AUTOINJECT_V5';
const LEGACY_MARKERS = Object.freeze([
  'statusbar_autoinject.js',
  'AGY_STATUSBAR_AUTOINJECT_V2',
  'AGY_STATUSBAR_AUTOINJECT_V3',
  'AGY_STATUSBAR_AUTOINJECT_V4',
]);
const BLOCK_SIZE = 4 * 1024 * 1024;

const UTILS_ANCHOR_TARGET = '    void win.loadURL(url);';

const UTILS_ANCHOR_REPLACEMENT =
  '    // AGY_STATUSBAR_AUTOINJECT_V5\n' +
  '    const _injectAgyStatusBar = () => {\n' +
  '        try {\n' +
  "            if (win.isDestroyed() || win.webContents.isDestroyed() || !/^https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|(?:[a-z0-9-]+\\.)*antigravity\\.google\\.com)(?::\\d+)?(?:\\/|$)/i.test(win.webContents.getURL())) return;\n" +
  "            const _p = require('path').join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'statusbar_autoinject.js');\n" +
  "            if (require('fs').existsSync(_p)) void win.webContents.executeJavaScript(require('fs').readFileSync(_p, 'utf8')).catch(() => {});\n" +
  '        } catch (_e) {}\n' +
  '    };\n' +
  "    win.webContents.on('dom-ready', _injectAgyStatusBar);\n" +
  "    win.webContents.on('did-finish-load', _injectAgyStatusBar);\n" +
  '    void win.loadURL(url);';

const MAIN_ANCHOR_TARGET = "electron_1.app.on('web-contents-created', (_event, contents) => {";

const MAIN_ANCHOR_REPLACEMENT =
  "electron_1.app.on('web-contents-created', (_event, contents) => {\n" +
  '    // AGY_STATUSBAR_AUTOINJECT_V5\n' +
  "    if (contents.getType() === 'window' && !(typeof scriptJail_1 !== 'undefined' && scriptJail_1.isScriptJailSession && scriptJail_1.isScriptJailSession(contents.session))) {\n" +
  '        const _injectAgyMain = () => {\n' +
  '            try {\n' +
  "                if (contents.isDestroyed() || !/^https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|(?:[a-z0-9-]+\\.)*antigravity\\.google\\.com)(?::\\d+)?(?:\\/|$)/i.test(contents.getURL())) return;\n" +
  "                const _p = require('path').join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'statusbar_autoinject.js');\n" +
  "                if (require('fs').existsSync(_p)) void contents.executeJavaScript(require('fs').readFileSync(_p, 'utf8')).catch(() => {});\n" +
  '            } catch (_e) {}\n' +
  '        };\n' +
  "        contents.on('dom-ready', _injectAgyMain);\n" +
  "        contents.on('did-finish-load', _injectAgyMain);\n" +
  '    }';

const PRELOAD_ANCHOR_TARGET = "electron_1.contextBridge.exposeInMainWorld('wsl', wslAPI);";

const PRELOAD_ANCHOR_REPLACEMENT =
  "electron_1.contextBridge.exposeInMainWorld('wsl', wslAPI);\n" +
  '// AGY_STATUSBAR_AUTOINJECT_V5\n' +
  "if (/^https?:$/i.test(globalThis.location?.protocol || '') && /^(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|(?:[a-z0-9-]+\\.)*antigravity\\.google\\.com)$/i.test(globalThis.location?.hostname || '')) {\n" +
  "    electron_1.ipcRenderer.invoke('storage:get-items').then((r) => {\n" +
  "        if (r && r['agy-statusbar-code']) {\n" +
  "            void electron_1.webFrame.executeJavaScript(r['agy-statusbar-code']).catch(() => {});\n" +
  '        }\n' +
  '    }).catch(() => {});\n' +
  '}';

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
        if (ch === '[') { inRegexCharClass = true; i += 1; continue; }
        if (ch === ']') { inRegexCharClass = false; i += 1; continue; }
        if (ch === '/' && !inRegexCharClass) {
          inRegex = false;
          top.regexAllowed = false;
          top.prevWasDot = false;
          top.lastControlKw = false;
          i += 1;
          while (i < line.length && /[a-z]/i.test(line[i])) i += 1;
          continue;
        }
        i += 1;
        continue;
      }

      if (ch === ' ' || ch === '\t' || ch === '\r') {
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
      if (ch === '`') {
        stack.push({ mode: 'TEMPLATE', braceDepth: 0, regexAllowed: true, prevWasDot: false, lastControlKw: false, parenStack: [] });
        i += 1;
        continue;
      }

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

function isAsarPatchedFast(asarPath) {
  let fd = null;
  try {
    if (!asarPath || !fs.existsSync(asarPath)) return true;
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
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
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

function serializeAsarBuffer(u0, header, fileMap) {
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
      if (node.integrity) {
        node.integrity = computeIntegrity(data);
      }
      chunks.push(data);
      currentOffset += BigInt(data.length);
    }
  }
  rebuildNode(header, '');

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

  return Buffer.concat([newHeaderBuf, ...chunks]);
}

module.exports = {
  PATCH_MARKER,
  LEGACY_MARKERS,
  BLOCK_SIZE,
  UTILS_ANCHOR_TARGET,
  UTILS_ANCHOR_REPLACEMENT,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  PRELOAD_ANCHOR_TARGET,
  PRELOAD_ANCHOR_REPLACEMENT,
  sha256Hex,
  computeIntegrity,
  stripPureCommentLinesLexical,
  transformExactSize,
  isAsarPatchedFast,
  readAsarArchive,
  serializeAsarBuffer,
};
