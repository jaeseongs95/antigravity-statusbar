import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createJsonSettingsStore } from '../../src/adapters/storage/json-settings-store.mjs';

const STORE_MODULE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/adapters/storage/json-settings-store.mjs'),
).href;

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-store-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('json-settings-store supports concurrent field-level merges and monotonic timestamps (F10)', async () => {
  await withTempDir(async (dir) => {
    const fixedClock = () => 1_700_000_000_000;
    const store = createJsonSettingsStore({ dataDir: dir, clock: fixedClock });

    await Promise.all([
      store.update({ locale: 'ko' }),
      store.update({ defaultCustomLimit: 256_000 }),
      store.update({ sessionLimit: { sessionId: 'sess-1', limit: 128_000 } }),
      store.update({ sessionLimit: { sessionId: 'sess-2', limit: 384_000 } }),
    ]);

    const finalState = await store.read();
    assert.equal(finalState.locale, 'ko');
    assert.equal(finalState.defaultCustomLimit, 256_000);
    assert.equal(finalState.sessions.get('sess-1')?.limit, 128_000);
    assert.equal(finalState.sessions.get('sess-2')?.limit, 384_000);

    // Same-ms rapid update advances updatedAt monotonically
    const t1 = finalState.sessions.get('sess-1').updatedAt;
    const afterUpdate = await store.update({ sessionLimit: { sessionId: 'sess-1', limit: 512_000 } });
    const t2 = afterUpdate.sessions.get('sess-1').updatedAt;
    assert.ok(t2 > t1, `Expected monotonic timestamp ${t2} > ${t1}`);
  });
});

test('json-settings-store backs up corrupt settings.json inside lock and recovers cleanly', async () => {
  await withTempDir(async (dir) => {
    const store = createJsonSettingsStore({ dataDir: dir });
    await fs.writeFile(store.settingsPath, '{not-valid-json', 'utf8');

    const updated = await store.update({ locale: 'ko' });
    assert.equal(updated.locale, 'ko');

    const files = await fs.readdir(dir);
    assert.ok(files.some((f) => f.startsWith('settings.json.corrupt.')), 'Expected .corrupt.<ts> backup');
  });
});

test('R2-F2: proper-lockfile + write-file-atomic prevents lost updates across concurrent child processes', async () => {
  await withTempDir(async (dir) => {
    const runWorker = (sessionId, limit, locale) =>
      new Promise((resolve, reject) => {
        const script = `
          import { createJsonSettingsStore } from ${JSON.stringify(STORE_MODULE_URL)};
          const store = createJsonSettingsStore({ dataDir: ${JSON.stringify(dir)} });
          await store.update({ sessionLimit: { sessionId: ${JSON.stringify(sessionId)}, limit: ${limit} } });
          if (${JSON.stringify(Boolean(locale))}) {
            await store.update({ locale: ${JSON.stringify(locale || 'en')} });
          }
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (c) => {
          stderr += c.toString('utf8');
        });
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Worker ${sessionId} exited ${code}: ${stderr}`));
        });
      });

    await Promise.all([
      runWorker('proc-sess-1', 128_000, 'ko'),
      runWorker('proc-sess-2', 256_000, null),
      runWorker('proc-sess-3', 384_000, null),
    ]);

    const store = createJsonSettingsStore({ dataDir: dir });
    const state = await store.read();
    assert.equal(state.locale, 'ko');
    assert.equal(state.sessions.get('proc-sess-1')?.limit, 128_000);
    assert.equal(state.sessions.get('proc-sess-2')?.limit, 256_000);
    assert.equal(state.sessions.get('proc-sess-3')?.limit, 384_000);
  });
});
