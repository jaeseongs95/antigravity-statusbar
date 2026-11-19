import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walkFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

const VENDOR_FORBIDDEN_PATTERNS = [
  /antigravity/i,
  /sidecar_sdk/i,
  /window\.sidecar/i,
  /ANTIGRAVITY_/,
  /exa\./,
  /\/preload\.js/,
  /process\.env/,
  /node:fs/,
  /app\.asar/i,
  /SetMendelFlagOverrides/,
  /statusbar_autoinject/i,
];

test('src/core has zero vendor/host/filesystem references', () => {
  const files = walkFiles(path.join(REPO_ROOT, 'src', 'core'));
  assert.ok(files.length >= 5, 'Expected at least 5 files in src/core');

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const pattern of VENDOR_FORBIDDEN_PATTERNS) {
      assert.equal(
        pattern.test(content),
        false,
        `Forbidden pattern ${pattern} matched in ${rel}`,
      );
    }
  }
});

test('src/ui has zero vendor references, zero innerHTML, zero ../core imports, and zero inline scripts/styles', () => {
  const files = walkFiles(path.join(REPO_ROOT, 'src', 'ui'));
  assert.ok(files.length >= 5, 'Expected at least 5 files in src/ui');

  const uiForbidden = [
    ...VENDOR_FORBIDDEN_PATTERNS,
    /\binnerHTML\b/,
    /\bouterHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bdocument\.write\b/,
    /\.\.\/core\b/,
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const pattern of uiForbidden) {
      assert.equal(
        pattern.test(content),
        false,
        `Forbidden pattern ${pattern} matched in ${rel}`,
      );
    }

    if (file.endsWith('.html')) {
      // No inline <script> bodies or inline <style> tags or on*= event attributes
      assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(content), false, `Inline <script> in ${rel}`);
      assert.equal(/<style\b/i.test(content), false, `Inline <style> in ${rel}`);
      assert.equal(/\son[a-z]+\s*=/i.test(content), false, `Inline event handler in ${rel}`);
    }
  }
});

test('no runtime source code touches app.asar, hooks.json, or SetMendelFlagOverrides', () => {
  const runtimeDirs = [
    path.join(REPO_ROOT, 'src'),
    path.join(REPO_ROOT, 'sidecars'),
    path.join(REPO_ROOT, 'scripts'),
  ];

  const banned = [/app\.asar/i, /SetMendelFlagOverrides/, /SidecarApp\.sendMessage/, /execFileSync/];
  for (const dir of runtimeDirs) {
    for (const file of walkFiles(dir)) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file);
      for (const pattern of banned) {
        assert.equal(
          pattern.test(content),
          false,
          `Banned runtime pattern ${pattern} found in ${rel}`,
        );
      }
    }
  }
});

test('json-settings-store.mjs has zero direct process.env reads (F10)', () => {
  const storeFile = path.join(REPO_ROOT, 'src', 'adapters', 'storage', 'json-settings-store.mjs');
  const content = fs.readFileSync(storeFile, 'utf8');
  assert.equal(/process\.env/.test(content), false, 'json-settings-store.mjs must inject dataDir');
});

test('plugin.json and sidecars/statusbar/sidecar.json declare AUX_PANE entrypoint', () => {
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  const sidecarManifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'sidecars', 'statusbar', 'sidecar.json'), 'utf8'),
  );
  assert.equal(pluginManifest.name, 'antigravity-statusbar');
  assert.equal(pluginManifest.version, '3.0.0');
  assert.equal(sidecarManifest.ui.entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
});
