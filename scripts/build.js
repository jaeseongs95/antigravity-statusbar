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

function buildBundle() {
  const modulesCode = [];

  for (const rel of MODULE_ORDER) {
    const abs = path.join(SRC_DIR, rel);
    const id = normalizeId(rel);
    const dir = path.posix.dirname(id);
    const source = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

    modulesCode.push(
      `  ${JSON.stringify(id)}: function(module, exports, __require) {\n` +
      `    const require = (spec) => __require(${JSON.stringify(dir)}, spec);\n` +
      source.split('\n').map((line) => (line ? `    ${line}` : '')).join('\n') +
      `\n  }`
    );
  }

  const header =
    `// ==UserScript==\n` +
    `// @name         Antigravity Custom Statusbar (Local & Remote Control)\n` +
    `// @namespace    https://github.com/jaeseongs95/antigravity-statusbar\n` +
    `// @version      1.3.3\n` +
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

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, bundle, 'utf8');
  return { outFile: OUT_FILE, size: Buffer.byteLength(bundle, 'utf8') };
}

if (require.main === module) {
  const { outFile, size } = buildBundle();
  process.stdout.write(`Built ${outFile} (${size} bytes)\n`);
}

module.exports = { buildBundle, OUT_FILE, MODULE_ORDER };
