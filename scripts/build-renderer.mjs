#!/usr/bin/env node
/**
 * Deterministic static renderer bundle builder for AddonManifest.v2 (v3.3.0).
 *
 * Emits the credential-free `runtime/statusbar-renderer.js` expected by
 * `antigravity-addons --build-addon-userscript` (v2.8.0+) and trusted SHA-256 pinning.
 *
 * Usage:
 *   node scripts/build-renderer.mjs [--out <path>] [--check]
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAddonStaticBundle } from '../src/adapters/antigravity/addon/bundle-builder.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_PATH = path.join(REPO_ROOT, 'runtime', 'statusbar-renderer.js');

function toLf(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parseBuildArgs(argv) {
  let outPath = DEFAULT_OUT_PATH;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--out') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-') || next.includes('\0')) {
        throw new Error('--out requires a valid output file path.');
      }
      outPath = path.resolve(next);
      i += 1;
    }
  }
  return { outPath, check };
}

export async function buildStaticRenderer({ outPath = DEFAULT_OUT_PATH, check = false } = {}) {
  const first = toLf(renderAddonStaticBundle());
  const second = toLf(renderAddonStaticBundle());
  const shaFirst = sha256Hex(first);
  const shaSecond = sha256Hex(second);
  if (first !== second || shaFirst !== shaSecond) {
    throw new Error('ERR_NON_DETERMINISTIC_RENDERER_BUNDLE');
  }
  const result = {
    ok: true,
    check,
    outPath,
    bytes: Buffer.byteLength(first, 'utf8'),
    sha256: shaFirst,
  };
  if (check) {
    return result;
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, first, 'utf8');
  return result;
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const opts = parseBuildArgs(process.argv.slice(2));
  const res = await buildStaticRenderer(opts);
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
}
