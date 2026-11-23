import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAddonCli } from '../../scripts/statusbar-addon.mjs';
import {
  DEFAULT_LOCALE,
  DomainError,
  ERROR_CODES,
  normalizeLocale,
  SUPPORTED_LOCALES,
} from '../../src/core/i18n/error-codes.mjs';
import {
  computeCacheHitPercent,
  normalizeRemainingPercent,
  normalizeTokenGroups,
  toNonNegativeIntOrNull,
} from '../../src/core/model/telemetry.mjs';
import {
  assertCompactionPort,
  assertSettingsPort,
  assertTelemetryPort,
} from '../../src/core/ports/contracts.mjs';

test('TC-UNIT-01: DomainError, normalizeLocale, and core port contracts enforce strict invariants', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['en', 'ko']);
  assert.equal(DEFAULT_LOCALE, 'en');

  const err = new DomainError(ERROR_CODES.SESSION_MISMATCH, 409, 'Mismatch', { expected: 'a' });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'DomainError');
  assert.equal(err.code, 'SESSION_MISMATCH');
  assert.equal(err.httpStatus, 409);
  assert.equal(err.message, 'Mismatch');
  assert.deepEqual(err.details, { expected: 'a' });

  assert.equal(normalizeLocale('  KO '), 'ko');
  assert.equal(normalizeLocale('EN'), 'en');
  assert.throws(
    () => normalizeLocale('ja'),
    (e) => e instanceof DomainError && e.code === ERROR_CODES.INVALID_LOCALE && e.httpStatus === 400,
  );
  assert.throws(
    () => normalizeLocale(null),
    (e) => e instanceof DomainError && e.code === ERROR_CODES.INVALID_LOCALE && e.httpStatus === 400,
  );

  // Core port assertions
  assert.throws(
    () => assertTelemetryPort(null),
    (e) => e instanceof DomainError && e.code === ERROR_CODES.INVALID_PORT && e.httpStatus === 500,
  );
  assert.throws(
    () => assertTelemetryPort({ listSessions() {}, getSessionTelemetry() {} }),
    /getQuotaSummary/,
  );
  assert.doesNotThrow(() =>
    assertTelemetryPort({ listSessions() {}, getSessionTelemetry() {}, getQuotaSummary() {} }),
  );

  assert.throws(
    () => assertCompactionPort({}),
    (e) => e instanceof DomainError && e.code === ERROR_CODES.INVALID_PORT,
  );
  assert.doesNotThrow(() => assertCompactionPort({ compactSession() {} }));

  assert.throws(
    () => assertSettingsPort({ read() {} }),
    /update/,
  );
  assert.doesNotThrow(() => assertSettingsPort({ read() {}, update() {} }));
});

test('TC-UNIT-02: telemetry.mjs handles null/negative/overflow/boundary inputs honestly', () => {
  // toNonNegativeIntOrNull
  assert.equal(toNonNegativeIntOrNull(null), null);
  assert.equal(toNonNegativeIntOrNull(undefined), null);
  assert.equal(toNonNegativeIntOrNull(''), null);
  assert.equal(toNonNegativeIntOrNull('   '), null);
  assert.equal(toNonNegativeIntOrNull(-1), null);
  assert.equal(toNonNegativeIntOrNull(NaN), null);
  assert.equal(toNonNegativeIntOrNull(Infinity), null);
  assert.equal(toNonNegativeIntOrNull({}), null);
  assert.equal(toNonNegativeIntOrNull(0), 0);
  assert.equal(toNonNegativeIntOrNull(' 42.9 '), 42);

  // computeCacheHitPercent
  assert.equal(
    computeCacheHitPercent({ cacheReadTokens: null, inputTokens: 1000, inputIncludesCache: true }),
    null,
  );
  assert.equal(
    computeCacheHitPercent({ cacheReadTokens: 0, inputTokens: 0, inputIncludesCache: true }),
    null,
  );
  assert.equal(
    computeCacheHitPercent({ cacheReadTokens: 750, inputTokens: 1000, inputIncludesCache: true }),
    75,
  );
  assert.equal(
    computeCacheHitPercent({ cacheReadTokens: 1500, inputTokens: 1000, inputIncludesCache: true }),
    100,
  );
  assert.equal(
    computeCacheHitPercent({ cacheReadTokens: 300, inputTokens: 700, inputIncludesCache: false }),
    30,
  );
  assert.equal(
    computeCacheHitPercent({ cacheReadTokens: 1, inputTokens: 2, inputIncludesCache: false }),
    33.3,
  );

  // normalizeTokenGroups
  assert.deepEqual(normalizeTokenGroups(null), []);
  const groups = normalizeTokenGroups([
    null,
    { key: 'zero', label: 'Zero', tokens: 0 },
    { key: 'neg', label: 'Neg', tokens: -5 },
    { key: 'chat', label: 'Chat Messages', tokens: 1200 },
    { key: 'chat2', label: 'Chat Messages', tokens: 300 },
    { key: 'sys', tokens: 500 },
  ]);
  assert.deepEqual(groups, [
    { key: 'chat', label: 'Chat Messages', tokens: 1500 },
    { key: 'sys', label: 'sys', tokens: 500 },
  ]);

  // normalizeRemainingPercent
  assert.equal(normalizeRemainingPercent(null), null);
  assert.equal(normalizeRemainingPercent(NaN), null);
  assert.equal(normalizeRemainingPercent(-0.2), 0);
  assert.equal(normalizeRemainingPercent(1.5), 100);
  assert.equal(normalizeRemainingPercent(0.8432), 84.3);
});

test('TC-UNIT-08: scripts/statusbar-addon.mjs CLI supports list/add/upsert/toggle/remove and rejects invalid inputs', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-addon-cli-unit-'));
  try {
    const initial = await runAddonCli(['list', '--data-dir', tempDir]);
    assert.equal(initial.ok, true);
    assert.deepEqual(initial.addons, []);
    assert.deepEqual(initial.disabledRuntimeAddonIds, []);

    const added = await runAddonCli([
      'add',
      '--data-dir',
      tempDir,
      '--id',
      'plan_btn',
      '--label',
      'Plan',
      '--command',
      '/plan',
      '--description',
      'Start plan',
      '--order',
      '20',
      '--source',
      'agent',
    ]);
    assert.equal(added.ok, true);
    assert.equal(added.addons.length, 1);
    assert.equal(added.addons[0].id, 'plan_btn');
    assert.equal(added.addons[0].order, 20);
    assert.equal(added.addons[0].enabled, true);

    // Upsert updates existing descriptor rather than duplicating
    const upserted = await runAddonCli([
      'upsert',
      '--data-dir',
      tempDir,
      '--id',
      'plan_btn',
      '--label',
      'Plan v2',
      '--command',
      '/plan now',
      '--order',
      '10',
    ]);
    assert.equal(upserted.addons.length, 1);
    assert.equal(upserted.addons[0].label, 'Plan v2');

    // Toggle persisted add-on OFF then ON
    const toggledOff = await runAddonCli([
      'toggle',
      '--data-dir',
      tempDir,
      '--id',
      'plan_btn',
      '--enabled',
      'false',
    ]);
    assert.equal(toggledOff.addons[0].enabled, false);

    // Toggle runtime add-on OFF then ON
    const rtOff = await runAddonCli([
      'toggle',
      '--data-dir',
      tempDir,
      '--id',
      'peer_rt',
      '--enabled',
      'false',
      '--runtime',
    ]);
    assert.deepEqual(rtOff.disabledRuntimeAddonIds, ['peer_rt']);

    const rtOn = await runAddonCli([
      'toggle',
      '--data-dir',
      tempDir,
      '--id',
      'peer_rt',
      '--enabled',
      'true',
      '--runtime',
    ]);
    assert.deepEqual(rtOn.disabledRuntimeAddonIds, []);

    // Remove persisted add-on
    const removed = await runAddonCli(['remove', '--data-dir', tempDir, '--id', 'plan_btn']);
    assert.deepEqual(removed.addons, []);

    // Invalid action & invalid ID rejected
    await assert.rejects(() => runAddonCli(['unknown', '--data-dir', tempDir]), /Unknown action/);
    await assert.rejects(() => runAddonCli(['remove', '--data-dir', tempDir, '--id', 'bad id!']));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
