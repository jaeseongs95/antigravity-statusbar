#!/usr/bin/env node
/**
 * Standard CLI for managing StatusbarAddon.v1 add-ons.
 * Used by AI agents or external tools to attach, enable/disable, remove, or list
 * buttons on the statusbar via the atomic lock-protected settings store.
 *
 * Usage:
 *   node scripts/statusbar-addon.mjs list
 *   node scripts/statusbar-addon.mjs add --id plan --label plan --command "/plan" [--description "..."] [--order 100] [--source agent]
 *   node scripts/statusbar-addon.mjs toggle --id plan --enabled false [--runtime]
 *   node scripts/statusbar-addon.mjs remove --id plan
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonSettingsStore } from '../src/adapters/storage/json-settings-store.mjs';
import {
  validateAddonDescriptor,
  validateAddonId,
} from '../src/core/model/context-policy.mjs';

const BOOLEAN_FLAGS = new Set(['runtime']);
const VALUE_FLAGS = new Set([
  'data-dir',
  'id',
  'label',
  'command',
  'description',
  'slot',
  'order',
  'enabled',
  'source',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseCliArgs(argv) {
  const action = argv[0] || 'list';
  const flags = Object.create(null);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (!key || FORBIDDEN_KEYS.has(key)) {
        throw new Error(`Invalid flag: ${token}`);
      }
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(key)) {
        throw new Error(`Unknown flag: --${key}`);
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--') || next.includes('\0')) {
        throw new Error(`Flag --${key} requires a valid value.`);
      }
      flags[key] = next;
      i += 1;
    }
  }
  return { action, flags };
}

function parseStrictEnabled(raw, defaultValue = null) {
  if (raw === undefined) {
    if (defaultValue !== null) return defaultValue;
    throw new Error('Flag --enabled requires one of: true, false, 1, 0.');
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`Invalid --enabled value "${raw}". Expected true, false, 1, or 0.`);
}

function resolveDefaultDataDir(explicitDir) {
  if (explicitDir !== undefined) {
    if (typeof explicitDir !== 'string' || !explicitDir.trim() || explicitDir.includes('\0')) {
      throw new Error('Flag --data-dir requires a valid non-empty directory path.');
    }
    return path.resolve(explicitDir);
  }
  if (process.env.ANTIGRAVITY_PLUGIN_DATA_DIR) {
    const envDir = process.env.ANTIGRAVITY_PLUGIN_DATA_DIR;
    if (envDir.includes('\0')) {
      throw new Error('ANTIGRAVITY_PLUGIN_DATA_DIR cannot contain null bytes.');
    }
    return path.resolve(envDir);
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-statusbar', 'data');
}

export async function runAddonCli(argv) {
  const { action, flags } = parseCliArgs(argv);
  const dataDir = resolveDefaultDataDir(flags['data-dir']);
  const store = createJsonSettingsStore({ dataDir });

  if (action === 'list') {
    const current = await store.read();
    return {
      ok: true,
      action: 'list',
      dataDir,
      addons: current.customButtons,
      disabledRuntimeAddonIds: current.disabledRuntimeAddonIds,
    };
  }

  if (action === 'add' || action === 'upsert') {
    const descriptor = validateAddonDescriptor({
      id: flags.id,
      label: flags.label,
      command: flags.command,
      description: typeof flags.description === 'string' ? flags.description : '',
      slot: flags.slot === 'left' ? 'left' : 'right',
      order: flags.order !== undefined ? Number(flags.order) : 100,
      enabled: parseStrictEnabled(flags.enabled, true),
      source: typeof flags.source === 'string' ? flags.source : 'agent',
    });
    const updated = await store.update({ addonUpsert: descriptor });
    return { ok: true, action: 'upsert', addon: descriptor, addons: updated.customButtons };
  }

  if (action === 'toggle') {
    const id = validateAddonId(flags.id);
    const enabled = parseStrictEnabled(flags.enabled, null);
    const isRuntime = Boolean(flags.runtime);
    const updated = await store.update({
      addonToggle: { id, enabled, runtime: isRuntime },
    });
    if (isRuntime) {
      return {
        ok: true,
        action: 'toggle',
        id,
        enabled,
        runtime: true,
        disabledRuntimeAddonIds: updated.disabledRuntimeAddonIds,
      };
    }
    return { ok: true, action: 'toggle', id, enabled, runtime: false, addons: updated.customButtons };
  }

  if (action === 'remove' || action === 'delete') {
    const id = validateAddonId(flags.id);
    const updated = await store.update({ addonRemove: { id } });
    return { ok: true, action: 'remove', id, addons: updated.customButtons };
  }

  throw new Error(`Unknown action "${action}". Expected list, add, toggle, or remove.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runAddonCli(process.argv.slice(2))
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`[statusbar-addon] failed: ${err?.message || String(err)}\n`);
      process.exit(1);
    });
}
