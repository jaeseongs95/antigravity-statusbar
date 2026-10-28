#!/usr/bin/env node
/**
 * Installer for Antigravity Custom Statusbar & Auto-Patcher.
 * Builds `dist/statusbar_autoinject.js` from modular `src/` files, copies it
 * (preserving any embedded KO_THOUGHT_LOCALIZER block) and `ensure_statusbar_patch.js`
 * to `~/.gemini/antigravity`, then runs `--worker` to patch `app.asar`,
 * sync `app_storage.json`, and inject into active windows via CDP.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildBundle } = require('./build');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || os.homedir();
const AGY_DIR = path.join(HOME_DIR, '.gemini', 'antigravity');
const TARGET_AUTOINJECT = path.join(AGY_DIR, 'statusbar_autoinject.js');
const TARGET_PATCHER = path.join(AGY_DIR, 'ensure_statusbar_patch.js');

const SRC_PATCHER = path.join(__dirname, 'ensure_statusbar_patch.js');

const KO_BEGIN = '// === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 ===';
const KO_END = '// === END_AGY_KO_THOUGHT_LOCALIZER_V2 ===';

function install() {
  const { outFile } = buildBundle();
  fs.mkdirSync(AGY_DIR, { recursive: true });

  let baseCode = fs.readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n';

  // Preserve embedded ko-thought-translator block if already present in the user's installation
  if (fs.existsSync(TARGET_AUTOINJECT)) {
    const existing = fs.readFileSync(TARGET_AUTOINJECT, 'utf8');
    const bIdx = existing.indexOf(KO_BEGIN);
    const eIdx = existing.indexOf(KO_END);
    if (bIdx !== -1 && eIdx !== -1 && eIdx > bIdx) {
      const embeddedBlock = existing.slice(bIdx, eIdx + KO_END.length);
      baseCode += `\n${embeddedBlock}\n`;
    }
  }

  fs.writeFileSync(TARGET_AUTOINJECT, baseCode, 'utf8');
  fs.copyFileSync(SRC_PATCHER, TARGET_PATCHER);

  const workerRes = spawnSync(process.execPath, [TARGET_PATCHER, '--worker'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  const statusRes = spawnSync(process.execPath, [TARGET_PATCHER, '--status'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (statusRes.stdout) {
    process.stdout.write(statusRes.stdout);
  }
  process.exit(workerRes.status || 0);
}

if (require.main === module) {
  install();
}

module.exports = { install };
