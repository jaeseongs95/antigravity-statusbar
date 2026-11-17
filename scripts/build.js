#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency bundler that assembles the modular CommonJS sources in `src/`
 * into a single self-contained runtime script (`dist/statusbar_autoinject.js`)
 * suitable for Electron `webFrame.executeJavaScript` and CDP `Runtime.evaluate`.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUT_FILE = path.join(DIST_DIR, 'statusbar_autoinject.js');

const MODULE_ORDER = [
  'host-adapter-config.js',
  'context-window-policy.js',
  'dom-styles.js',
  'rpc-client.js',
  'host-bridge.js',
  'adapter-registry.js',
  'adapters/core-metrics.js',
  'adapters/compact-button.js',
  'adapters/context-button.js',
  'index.js',
];

function countTrailingBackslashes(str) {
  let count = 0;
  for (let i = str.length - 1; i >= 0 && str[i] === '\\'; i--) {
    count += 1;
  }
  return count;
}

function collectSrcJsFiles(dir, prefix = '') {
  const found = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const isDir = typeof entry === 'string' ? fs.statSync(abs).isDirectory() : entry.isDirectory();
    if (isDir) {
      found.push(...collectSrcJsFiles(abs, rel));
    } else if (name.endsWith('.js')) {
      found.push(rel);
    }
  }
  return found;
}

function normalizeId(relPath) {
  return './' + relPath.replace(/\\/g, '/').replace(/\.js$/, '');
}

const REGEX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof',
  'instanceof', 'in', 'of', 'new', 'yield', 'await', 'else', 'do',
]);

function stripCommentsAndEmptyLines(source) {
  const lines = source.split('\n');
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

    let i = 0;
    let inRegex = false;
    let inRegexCharClass = false;

    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1] || '';
      const top = stack[stack.length - 1];

      if (top.mode === 'TEMPLATE') {
        if (ch === '\\') {
          i += 2;
          continue;
        }
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
          stack.push({
            mode: 'TEMPLATE_EXPR',
            braceDepth: 1,
            regexAllowed: true,
            prevWasDot: false,
            lastControlKw: false,
            parenStack: [],
          });
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
        if (ch === '\\') {
          i += 2;
          continue;
        }
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
        if (ch === '\\') {
          i += 2;
          continue;
        }
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
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (inRegexCharClass) {
          if (ch === ']') {
            inRegexCharClass = false;
          }
          i += 1;
          continue;
        }
        if (ch === '[') {
          inRegexCharClass = true;
          i += 1;
          continue;
        }
        if (ch === '/') {
          inRegex = false;
          i += 1;
          while (i < line.length && /[A-Za-z]/.test(line[i])) {
            i += 1;
          }
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
      if (ch === '/' && top.regexAllowed) {
        inRegex = true;
        inRegexCharClass = false;
        i += 1;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        i += 1;
        continue;
      }
      if (ch === '`') {
        stack.push({ mode: 'TEMPLATE' });
        i += 1;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        let end = i + 1;
        while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) {
          end += 1;
        }
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
        while (end < line.length && /[0-9A-Za-z_.]/.test(line[end])) {
          end += 1;
        }
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
        const afterControl = Boolean(top.parenStack.pop());
        top.regexAllowed = afterControl;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      if (ch === '[') {
        top.regexAllowed = true;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      if (ch === ']') {
        top.regexAllowed = false;
        top.prevWasDot = false;
        top.lastControlKw = false;
        i += 1;
        continue;
      }
      if (ch === '{') {
        if (top.mode === 'TEMPLATE_EXPR') {
          top.braceDepth += 1;
        }
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

    // Unescaped newline (even number of trailing backslashes) terminates single/double quoted string
    if (inSingle && countTrailingBackslashes(line) % 2 === 0) inSingle = false;
    if (inDouble && countTrailingBackslashes(line) % 2 === 0) inDouble = false;

    if (startsInTemplate || startsInString) {
      out.push(line);
      continue;
    }

    const t = line.trim();
    if (!t) continue;
    if (!startsInBlockComment && t.startsWith('//')) continue;
    out.push(`    ${line}`);
  }

  return out.join('\n');
}

function buildBundle(options = {}) {
  const write = options.write !== false;
  if (typeof fs.readdirSync === 'function') {
    const orderSet = new Set(MODULE_ORDER);
    for (const rel of collectSrcJsFiles(SRC_DIR)) {
      if (!orderSet.has(rel)) {
        throw new Error(`Module in src/ is missing from MODULE_ORDER: ${rel}`);
      }
    }
  }
  const modulesCode = [];

  for (const rel of MODULE_ORDER) {
    const abs = path.join(SRC_DIR, rel);
    const id = normalizeId(rel);
    const dir = path.posix.dirname(id);
    const source = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

    modulesCode.push(
      `  ${JSON.stringify(id)}: function(module, exports, __require) {\n` +
      `    const require = (spec) => __require(${JSON.stringify(dir)}, spec);\n` +
      stripCommentsAndEmptyLines(source) +
      `\n  }`
    );
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const pkgVersion = pkg.version || '1.3.9';

  const header =
    `// ==UserScript==\n` +
    `// @name         Antigravity Custom Statusbar (Local & Remote Control)\n` +
    `// @namespace    https://github.com/jaeseongs95/antigravity-statusbar\n` +
    `// @version      ${pkgVersion}\n` +
    `// @description  Custom context window statusbar (32K-980K), quota/cache metrics, compact & context debug modal for Antigravity Desktop and Remote Control web.\n` +
    `// @match        https://antigravity.google.com/*\n` +
    `// @match        https://*.antigravity.google.com/*\n` +
    `// @match        https://127.0.0.1/*\n` +
    `// @grant        none\n` +
    `// @run-at       document-idle\n` +
    `// ==/UserScript==\n`;

  const bundle =
    header +
    `(() => {\n` +
    `  'use strict';\n` +
    `  const __modules = {\n` +
    modulesCode.join(',\n') +
    `\n  };\n` +
    `  const __cache = {};\n` +
    `  function __resolve(baseDir, spec) {\n` +
    `    const cleanSpec = spec.replace(/\\.js$/, '');\n` +
    `    const parts = (baseDir + '/' + cleanSpec).split('/');\n` +
    `    const out = [];\n` +
    `    for (const p of parts) {\n` +
    `      if (!p || p === '.') continue;\n` +
    `      if (p === '..') out.pop();\n` +
    `      else out.push(p);\n` +
    `    }\n` +
    `    return './' + out.join('/');\n` +
    `  }\n` +
    `  function __require(baseDir, spec) {\n` +
    `    const id = __resolve(baseDir, spec);\n` +
    `    if (__cache[id]) return __cache[id].exports;\n` +
    `    const fn = __modules[id];\n` +
    `    if (!fn) throw new Error('Module not found: ' + id);\n` +
    `    const module = { exports: {} };\n` +
    `    __cache[id] = module;\n` +
    `    fn(module, module.exports, __require);\n` +
    `    return module.exports;\n` +
    `  }\n` +
    `  __require('.', './index');\n` +
    `})();\n`;

  new vm.Script(bundle, { filename: 'statusbar_autoinject.js' });

  if (write) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, bundle, 'utf8');
  }
  return { outFile: OUT_FILE, size: Buffer.byteLength(bundle, 'utf8'), bundle };
}

if (require.main === module) {
  const { outFile, size } = buildBundle();
  process.stdout.write(`Built ${outFile} (${size} bytes)\n`);
}

module.exports = { buildBundle, stripCommentsAndEmptyLines, OUT_FILE, MODULE_ORDER };
