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

test('no runtime source code touches app.asar, hooks.json, SetMendelFlagOverrides, or legacy statusbar_autoinject', () => {
  const runtimeDirs = [
    path.join(REPO_ROOT, 'src'),
    path.join(REPO_ROOT, 'sidecars'),
    path.join(REPO_ROOT, 'scripts'),
  ];

  const banned = [
    /app\.asar/i,
    /hooks\.json/i,
    /SetMendelFlagOverrides/,
    /SidecarApp\.sendMessage/,
    /execFileSync/,
    /statusbar_autoinject/i,
  ];
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

test('TC-ADDON-06: addon renderer modules never create <style> tags directly, use innerHTML, or expose addonHost/token on window', () => {
  const addonDir = path.join(REPO_ROOT, 'src', 'adapters', 'antigravity', 'addon');
  const files = walkFiles(addonDir);
  assert.ok(files.length >= 10, `Expected SOLID addon modules in ${addonDir}, got ${files.length}`);

  const bannedInAddon = [
    /\binnerHTML\b/,
    /\bouterHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bdocument\.write\b/,
    /createElement\s*\(\s*['"]style['"]\s*\)/,
    /document\.head\.appendChild/,
    /window\.__agyStatusbarInline/,
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const pattern of bannedInAddon) {
      assert.equal(
        pattern.test(content),
        false,
        `Forbidden AddonManifest.v1 pattern ${pattern} matched in ${rel}`,
      );
    }
  }
});

test('json-settings-store.mjs has zero direct process.env reads (F10)', () => {
  const storeFile = path.join(REPO_ROOT, 'src', 'adapters', 'storage', 'json-settings-store.mjs');
  const content = fs.readFileSync(storeFile, 'utf8');
  assert.equal(/process\.env/.test(content), false, 'json-settings-store.mjs must inject dataDir');
});

test('plugin.json, sidecars/statusbar/sidecar.json, and addon-manifest.v2.json declare official schemas', () => {
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  const sidecarManifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'sidecars', 'statusbar', 'sidecar.json'), 'utf8'),
  );
  const addonManifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'addon-manifest.v2.json'), 'utf8'),
  );
  assert.equal(pluginManifest.name, 'antigravity-statusbar');
  assert.equal(pluginManifest.version, '3.1.0');
  assert.equal(sidecarManifest.has_web_ui, true);
  assert.equal(sidecarManifest.ui_config?.views?.[0]?.path, '/');
  assert.equal(sidecarManifest.ui_config?.views?.[0]?.entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');

  assert.equal(addonManifest.schemaVersion, 2);
  assert.equal(addonManifest.pluginId, 'antigravity-statusbar');
  assert.equal(addonManifest.version, '3.1.0');
  assert.equal(addonManifest.trustLevel, 'restricted');
  assert.equal(addonManifest.compatibility?.minHostVersion, '2.0.0');
  assert.deepEqual(addonManifest.capabilities, ['renderer']);
  assert.equal(addonManifest.entry?.rendererScript, 'runtime/statusbar-renderer.js');
  assert.equal(addonManifest.entry?.mainHookScript, null);
  assert.equal(addonManifest.uiSlots.length, 3);
  assert.ok(addonManifest.uiSlots.every((s) => s.shadow === true));
  assert.equal(addonManifest.uiSlots.find((s) => s.slot === 'status-bar')?.exclusive, true);
  assert.equal(addonManifest.uiSlots.find((s) => s.slot === 'overlay')?.exclusive, false);
  assert.equal(addonManifest.uiSlots.find((s) => s.slot === 'modal')?.exclusive, false);
  assert.equal(addonManifest.loadOrder, 50);
});

test('STATUSBAR_STYLES complies with addon-host v2.0.0 strict owner-CSS security rules', async () => {
  const { STATUSBAR_STYLES } = await import('../../src/adapters/antigravity/addon/styles.mjs');
  const allowedAtRules = new Set([
    '@media',
    '@supports',
    '@keyframes',
    '@-webkit-keyframes',
    '@layer',
  ]);
  const atMatches = STATUSBAR_STYLES.match(/@[a-z-]+/gi) || [];
  for (const rule of atMatches) {
    assert.ok(
      allowedAtRules.has(rule.toLowerCase()),
      `Forbidden @-rule in STATUSBAR_STYLES: ${rule}`,
    );
  }
  assert.equal(/:\s*has\s*\(/i.test(STATUSBAR_STYLES), false, ':has() is forbidden in owner CSS');
  assert.equal(/&[^;{}]*[+~]/.test(STATUSBAR_STYLES), false, 'Nested sibling selector forbidden');
  assert.equal(/<\s*\/\s*style/i.test(STATUSBAR_STYLES), false, 'Closing style tag forbidden');

  // Verify balanced {}, (), []
  const stack = [];
  let quote = null;
  for (let i = 0; i < STATUSBAR_STYLES.length; i += 1) {
    const ch = STATUSBAR_STYLES[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      stack.push('}');
    } else if (ch === '(') {
      stack.push(')');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ')' || ch === ']') {
      assert.equal(stack.pop(), ch, `Unbalanced delimiter ${ch} at offset ${i}`);
    }
  }
  assert.equal(quote, null, 'Unclosed string literal in STATUSBAR_STYLES');
  assert.equal(stack.length, 0, 'Unclosed block delimiter in STATUSBAR_STYLES');
});
