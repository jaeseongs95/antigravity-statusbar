import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createJsonSettingsStore } from '../../src/adapters/storage/json-settings-store.mjs';

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

test('json-settings-store recovers stale dead-PID lock via rename-aside and respects 0-byte grace (F7)', async () => {
  await withTempDir(async (dir) => {
    const store = createJsonSettingsStore({
      dataDir: dir,
      zeroByteGraceMs: 250,
      lockTimeoutMs: 2_000,
    });

    // 1. Dead PID lock is recovered immediately via rename-aside
    await fs.writeFile(
      store.lockPath,
      JSON.stringify({ pid: 999_999_999, token: 'dead-token-1234', createdAt: Date.now() }),
      'utf8',
    );
    const res1 = await store.update({ locale: 'ko' });
    assert.equal(res1.locale, 'ko');

    // 2. 0-byte lock waits for zeroByteGraceMs before recovering
    await fs.writeFile(store.lockPath, '', 'utf8');
    const started = Date.now();
    const res2 = await store.update({ defaultCustomLimit: 200_000 });
    const elapsed = Date.now() - started;
    assert.equal(res2.defaultCustomLimit, 200_000);
    assert.ok(elapsed >= 200, `Expected 0-byte lock grace wait >= 200ms, got ${elapsed}ms`);

    // 3. F3: Live PID lock is NEVER unlinked during lockTimeoutMs -> throws STORAGE_LOCK_TIMEOUT and preserves lock
    const livePayload = JSON.stringify({
      pid: process.pid,
      token: 'live-holder-token-xyz',
      createdAt: Date.now(),
    });
    await fs.writeFile(store.lockPath, livePayload, 'utf8');
    const shortStore = createJsonSettingsStore({
      dataDir: dir,
      lockTimeoutMs: 180,
      staleLockMs: 60_000,
    });
    await assert.rejects(
      () => shortStore.update({ locale: 'en' }),
      (err) => err?.code === 'STORAGE_LOCK_TIMEOUT',
    );
    const preserved = JSON.parse(await fs.readFile(store.lockPath, 'utf8'));
    assert.equal(preserved.token, 'live-holder-token-xyz');
    await fs.unlink(store.lockPath);
  });
});
