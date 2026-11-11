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

const MCP_BEGIN_RE = /^(?:\/\/ === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? ===|\/\* === BEGIN_AGY_MCP_MANAGER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;
const MCP_END_RE = /^(?:\/\/ === END_AGY_MCP_MANAGER(?:_V\d+)? ===|\/\* === END_AGY_MCP_MANAGER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;
const KO_BEGIN_RE = /^(?:\/\/ === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? ===|\/\* === BEGIN_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;
const KO_END_RE = /^(?:\/\/ === END_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? ===|\/\* === END_AGY_KO_THOUGHT_LOCALIZER(?:_V\d+)? === \*\/)[ \t]*\r?$/gm;

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

function install() {
  const { outFile } = buildBundle();
  fs.mkdirSync(AGY_DIR, { recursive: true });

  let baseCode = fs.readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n';

  // Preserve embedded antigravity-mcp-manager and ko-thought-translator blocks only when anchored at column 0
  if (fs.existsSync(TARGET_AUTOINJECT)) {
    const existing = fs.readFileSync(TARGET_AUTOINJECT, 'utf8').replace(/\r\n/g, '\n');
    const mcpBlock = extractAnchoredCompanionBlock(existing, MCP_BEGIN_RE, MCP_END_RE);
    if (mcpBlock) {
      baseCode += `\n${mcpBlock}\n`;
    }
    const koBlock = extractAnchoredCompanionBlock(existing, KO_BEGIN_RE, KO_END_RE);
    if (koBlock) {
      baseCode += `\n${koBlock}\n`;
    }
  }

  fs.writeFileSync(TARGET_AUTOINJECT, baseCode, 'utf8');
  fs.copyFileSync(SRC_PATCHER, TARGET_PATCHER);

  const workerRes = spawnSync(process.execPath, [TARGET_PATCHER, '--worker'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (workerRes.stderr) {
    process.stderr.write(workerRes.stderr);
  }
  if (workerRes.error) {
    process.stderr.write(String(workerRes.error.message || workerRes.error) + '\n');
  }

  const statusRes = spawnSync(process.execPath, [TARGET_PATCHER, '--status'], {
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
  process.exit(exitCode);
}

if (require.main === module) {
  install();
}

module.exports = { install, extractAnchoredCompanionBlock };
