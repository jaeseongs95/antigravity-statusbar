#!/usr/bin/env node
'use strict';

/**
 * Installer for Antigravity Custom Statusbar v2.0.0 & Modular Auto-Patcher.
 * Builds `dist/statusbar_autoinject.js` from Hexagonal `src/`, preserves column-0
 * companion plugin blocks in `~/.gemini/antigravity/statusbar_autoinject.js`,
 * installs modular `installer/*.js` + `ensure_statusbar_patch.js`, then runs `--worker`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { buildBundle } = require('./build');

function writeFileAtomic(destPath, contentBufOrStr) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${destPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, contentBufOrStr);
    fs.renameSync(tmpPath, destPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || os.homedir();
const AGY_DIR = path.join(HOME_DIR, '.gemini', 'antigravity');
const TARGET_AUTOINJECT = path.join(AGY_DIR, 'statusbar_autoinject.js');
const TARGET_PATCHER = path.join(AGY_DIR, 'ensure_statusbar_patch.js');
const TARGET_INSTALLER_DIR = path.join(AGY_DIR, 'installer');

const SRC_PATCHER = path.join(__dirname, 'ensure_statusbar_patch.js');
const SRC_INSTALLER_DIR = path.join(__dirname, '..', 'installer');

const MCP_BEGIN_RE =
  /^(?:\/\/ === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? ===|\/\* === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;
const MCP_END_RE =
  /^(?:\/\/ === END_AGY_MCP_MANAGER(?:_V\d+)? ===|\/\* === END_AGY_MCP_MANAGER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;
const KO_BEGIN_RE =
  /^(?:\/\/ === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? ===|\/\* === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;
const KO_END_RE =
  /^(?:\/\/ === END_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? ===|\/\* === END_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;

function extractAnchoredCompanionBlock(source, beginRe, endRe) {
  if (!source || typeof source !== 'string') return '';
  beginRe.lastIndex = 0;
  const beginMatch = beginRe.exec(source);
  if (!beginMatch) return '';
  const startIdx = beginMatch.index;

  endRe.lastIndex = startIdx + beginMatch[0].length;
  const firstEnd = endRe.exec(source);
  if (!firstEnd) return '';

  let endIdx = firstEnd.index + firstEnd[0].length;
  while (true) {
    endRe.lastIndex = endIdx;
    const nextEnd = endRe.exec(source);
    if (!nextEnd) break;
    if (source.slice(endIdx, nextEnd.index).trim() !== '') break;
    endIdx = nextEnd.index + nextEnd[0].length;
  }
  return source.slice(startIdx, endIdx).trim();
}

function copyInstallerModules(srcDir = SRC_INSTALLER_DIR, destDir = TARGET_INSTALLER_DIR) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(srcDir);
  for (const name of files) {
    if (!name.endsWith('.js')) continue;
    writeFileAtomic(path.join(destDir, name), fs.readFileSync(path.join(srcDir, name)));
  }
}

function install(opts = {}) {
  const { outFile } = buildBundle();
  const agyDir = opts.agyDir || AGY_DIR;
  const targetAutoinject = opts.targetAutoinject || path.join(agyDir, 'statusbar_autoinject.js');
  const targetPatcher = opts.targetPatcher || path.join(agyDir, 'ensure_statusbar_patch.js');
  const targetInstallerDir = opts.targetInstallerDir || path.join(agyDir, 'installer');

  fs.mkdirSync(agyDir, { recursive: true });

  let baseCode = fs.readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n';

  if (fs.existsSync(targetAutoinject)) {
    const existing = fs.readFileSync(targetAutoinject, 'utf8').replace(/\r\n/g, '\n');
    const mcpBlock = extractAnchoredCompanionBlock(existing, MCP_BEGIN_RE, MCP_END_RE);
    if (mcpBlock) {
      baseCode += `\n${mcpBlock}\n`;
    }
    const koBlock = extractAnchoredCompanionBlock(existing, KO_BEGIN_RE, KO_END_RE);
    if (koBlock) {
      baseCode += `\n${koBlock}\n`;
    }
  }

  writeFileAtomic(targetAutoinject, Buffer.from(baseCode, 'utf8'));
  copyInstallerModules(SRC_INSTALLER_DIR, targetInstallerDir);
  writeFileAtomic(targetPatcher, fs.readFileSync(SRC_PATCHER));

  if (opts.skipWorker) {
    return { targetAutoinject, targetPatcher, targetInstallerDir, exitCode: 0 };
  }

  const workerRes = spawnSync(process.execPath, [targetPatcher, '--worker'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (workerRes.stderr) {
    process.stderr.write(workerRes.stderr);
  }
  if (workerRes.error) {
    process.stderr.write(String(workerRes.error.message || workerRes.error) + '\n');
  }

  const statusRes = spawnSync(process.execPath, [targetPatcher, '--status'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (statusRes.stdout) {
    process.stdout.write(statusRes.stdout);
  }
  if (statusRes.stderr) {
    process.stderr.write(statusRes.stderr);
  }
  const exitCode = typeof workerRes.status === 'number' ? workerRes.status : 1;
  if (!opts.noExit) {
    process.exit(exitCode);
  }
  return { targetAutoinject, targetPatcher, targetInstallerDir, exitCode };
}

if (require.main === module) {
  install();
}

module.exports = {
  MCP_BEGIN_RE,
  MCP_END_RE,
  KO_BEGIN_RE,
  KO_END_RE,
  extractAnchoredCompanionBlock,
  copyInstallerModules,
  install,
};
