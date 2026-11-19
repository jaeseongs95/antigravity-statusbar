import { startSidecar } from '../../src/adapters/antigravity/sidecar-entry.mjs';

startSidecar().catch((err) => {
  process.stderr.write(`[antigravity-statusbar] fatal startup error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
