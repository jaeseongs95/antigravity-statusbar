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

function normalizeId(relPath) {
  return './' + relPath.replace(/\\/g, '/').replace(/\.js$/, '');
}

function stripCommentsAndEmptyLines(source) {
  const lines = source.split('\n');
  const out = [];
  const stack = [];
  let inBlockComment = false;

  for (const line of lines) {
    const startsInTemplate = stack.length > 0 && stack[stack.length - 1].mode === 'TEMPLATE';
    const startsInBlockComment = inBlockComment;

    // Advance lexical state across this line
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1] || '';
      const top = stack.length > 0 ? stack[stack.length - 1] : null;

      if (top && top.mode === 'TEMPLATE') {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '`') {
          stack.pop();
          i += 1;
          continue;
        }
        if (ch === '$' && next === '{') {
          stack.push({ mode: 'TEMPLATE_EXPR', braceDepth: 1 });
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
        if (ch === '\\') { i += 2; continue; }
        if (ch === "'") inSingle = false;
        i += 1;
        continue;
      }

      if (inDouble) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') inDouble = false;
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
      if (top && top.mode === 'TEMPLATE_EXPR') {
        if (ch === '{') {
          top.braceDepth += 1;
        } else if (ch === '}') {
          top.braceDepth -= 1;
          if (top.braceDepth === 0) stack.pop();
        }
      }
      i += 1;
    }

    if (startsInTemplate) {
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

module.exports = { buildBundle, OUT_FILE, MODULE_ORDER };
