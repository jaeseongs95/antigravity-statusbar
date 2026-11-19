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

function parseCliArgs(argv) {
  const action = argv[0] || 'list';
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return { action, flags };
}

function resolveDefaultDataDir(explicitDir) {
  if (explicitDir && typeof explicitDir === 'string') {
    return path.resolve(explicitDir);
  }
  if (process.env.ANTIGRAVITY_PLUGIN_DATA_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_PLUGIN_DATA_DIR);
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
      enabled: flags.enabled === 'false' ? false : true,
      source: typeof flags.source === 'string' ? flags.source : 'agent',
    });
    const current = await store.read();
    const list = [...current.customButtons];
    const idx = list.findIndex((b) => b.id === descriptor.id);
    if (idx >= 0) list[idx] = descriptor;
    else list.push(descriptor);
    const updated = await store.update({ customButtons: list });
    return { ok: true, action: 'upsert', addon: descriptor, addons: updated.customButtons };
  }

  if (action === 'toggle') {
    const id = validateAddonId(flags.id);
    const enabled = flags.enabled === 'false' ? false : Boolean(flags.enabled !== '0');
    const isRuntime = Boolean(flags.runtime);
    const current = await store.read();
    if (isRuntime) {
      const disabled = new Set(current.disabledRuntimeAddonIds);
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      const updated = await store.update({ disabledRuntimeAddonIds: Array.from(disabled) });
      return {
        ok: true,
        action: 'toggle',
        id,
        enabled,
        runtime: true,
        disabledRuntimeAddonIds: updated.disabledRuntimeAddonIds,
      };
    }
    const nextList = current.customButtons.map((b) => (b.id === id ? { ...b, enabled } : b));
    const updated = await store.update({ customButtons: nextList });
    return { ok: true, action: 'toggle', id, enabled, runtime: false, addons: updated.customButtons };
  }

  if (action === 'remove' || action === 'delete') {
    const id = validateAddonId(flags.id);
    const current = await store.read();
    const nextList = current.customButtons.filter((b) => b.id !== id);
    const updated = await store.update({ customButtons: nextList });
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
