import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_STDIO_BYTES = 64 * 1024; // 64KB bounded stream drain (F6)
const DEFAULT_FALLBACK_TIMEOUT_MS = 15_000;

/**
 * Validates ANTIGRAVITY_AGENTAPI_EXE path safely:
 * - Rejects empty paths, null bytes, and UNC paths (\\... or //...)
 * - Resolves realpathSync and ensures target is an existing regular file.
 *
 * @param {unknown} rawPath
 * @returns {string | null}
 */
export function resolveSafeAgentApiExe(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  // Block UNC paths on Windows and network share prefixes
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    return null;
  }

  if (!path.isAbsolute(trimmed)) {
    return null;
  }

  try {
    const real = fs.realpathSync(trimmed);
    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Drains a readable stream while retaining at most maxBytes in memory (F6).
 *
 * @param {import('node:stream').Readable | null} stream
 * @param {number} maxBytes
 * @returns {() => string}
 */
function attachBoundedDrain(stream, maxBytes = MAX_STDIO_BYTES) {
  const chunks = [];
  let kept = 0;
  let truncated = false;

  if (stream) {
    stream.on('data', (chunk) => {
      if (kept >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - kept;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        kept += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, remaining));
        kept += remaining;
        truncated = true;
      }
    });
    stream.on('error', () => {});
  }

  return () => {
    const text = Buffer.concat(chunks, kept).toString('utf8');
    return truncated ? `${text}\n[truncated]` : text;
  };
}

/**
 * Creates the Antigravity CompactionPort implementation:
 * 1. Primary: async SendUserCascadeMessage RPC with `/compact`
 * 2. Fallback (non-acceptance-only): spawn(realExePath, ..., { shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'], signal })
 *    with 64KB bounded stream drain & active child PID tracking/cleanup (F5, F6, D-0020).
 *
 * @param {{
 *   lsTransport: ReturnType<import('./ls-transport.mjs').createLsTransport>,
 *   agentApiExePath?: string | null,
 *   fallbackTimeoutMs?: number,
 *   spawnFn?: typeof spawn,
 * }} options
 */
export function createAntigravityCompactionAdapter({
  lsTransport,
  agentApiExePath = null,
  fallbackTimeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS,
  spawnFn = spawn,
}) {
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const activeChildren = new Set();

  function runFallbackSpawn(realExe, sessionId, messageText = '/compact') {
    return new Promise((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, fallbackTimeoutMs);

      let child;
      try {
        // F6: shell: false, windowsHide: true, ignore stdin, pipe stdout/stderr, AbortSignal
        // Matches official sidecar_sdk invocation: `<ANTIGRAVITY_AGENTAPI_EXE> agentapi send-message <cid> <msg>`
        child = spawnFn(
          realExe,
          ['agentapi', 'send-message', sessionId, messageText],
          {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: controller.signal,
          },
        );
      } catch (err) {
        clearTimeout(timer);
        resolve({ accepted: false, method: 'agentapi', reason: err?.message || 'spawn failed' });
        return;
      }

      activeChildren.add(child);
      const getStderr = attachBoundedDrain(child.stderr, MAX_STDIO_BYTES);
      attachBoundedDrain(child.stdout, MAX_STDIO_BYTES);

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeChildren.delete(child);
        resolve(result);
      };

      child.on('error', (err) => {
        finish({
          accepted: false,
          method: 'agentapi',
          reason: err?.name === 'AbortError' ? 'fallback timed out' : err?.message || 'child error',
        });
      });

      child.on('close', (code) => {
        if (code === 0) {
          finish({ accepted: true, method: 'agentapi' });
        } else {
          const detail = getStderr().trim();
          finish({
            accepted: false,
            method: 'agentapi',
            reason: detail || `agentapi exited with code ${code}`,
          });
        }
      });
    });
  }

  return {
    async compactSession(sessionId, options = {}) {
      const prompt = typeof options?.prompt === 'string' ? options.prompt.trim() : '';
      const items = [
        {
          item: {
            slashCommand: {
              info: {
                name: 'compact',
                type: 'SLASH_COMMAND_TYPE_SYSTEM',
                icon: 'collapse_all',
              },
            },
          },
        },
      ];
      if (prompt) {
        items.push({ text: ` ${prompt}` });
      }

      // 1. Primary path: async SendUserCascadeMessage RPC with structured slashCommand ContextScopeItem (F1)
      try {
        await lsTransport.callUnaryRpc('SendUserCascadeMessage', {
          cascadeId: sessionId,
          items,
        });
        return { accepted: true, method: 'rpc' };
      } catch (rpcErr) {
        // 2. Fallback path: non-acceptance-only spawn
        const realExe = resolveSafeAgentApiExe(agentApiExePath);
        if (!realExe) {
          return {
            accepted: false,
            method: 'rpc',
            reason: rpcErr?.message || 'SendUserCascadeMessage failed and no valid agentapi exe configured.',
          };
        }

        const fallbackMsg = prompt ? `/compact ${prompt}` : '/compact';
        const fallbackResult = await runFallbackSpawn(realExe, sessionId, fallbackMsg);
        if (fallbackResult.accepted) {
          return fallbackResult;
        }
        return {
          accepted: false,
          method: 'agentapi',
          reason: `${rpcErr?.message || 'RPC failed'}; fallback: ${fallbackResult.reason}`,
        };
      }
    },

    async sendCommand(sessionId, commandText) {
      const trimmed = String(commandText || '').trim();
      if (trimmed === '/compact') {
        return this.compactSession(sessionId);
      }
      if (trimmed.startsWith('/compact ')) {
        return this.compactSession(sessionId, { prompt: trimmed.slice(9).trim() });
      }
      const realExe = resolveSafeAgentApiExe(agentApiExePath);
      if (realExe) {
        const res = await runFallbackSpawn(realExe, sessionId, trimmed);
        if (res.accepted) {
          return res;
        }
      }
      try {
        await lsTransport.callUnaryRpc('SendUserCascadeMessage', {
          cascadeId: sessionId,
          items: [{ text: trimmed }],
        });
        return { accepted: true, method: 'rpc' };
      } catch (rpcErr) {
        return {
          accepted: false,
          method: 'rpc',
          reason: rpcErr?.message || 'Failed to send custom command.',
        };
      }
    },

    /**
     * Asynchronously terminates all active child processes on sidecar shutdown (F1, F6, D-0020):
     * Checks live status via `exitCode === null && signalCode === null` (not `child.killed`),
     * sends SIGTERM, clears timer on exit, and escalates to SIGKILL after `graceMs`.
     *
     * @param {{ graceMs?: number }} [opts]
     * @returns {Promise<void>}
     */
    async dispose({ graceMs = 1_500 } = {}) {
      const children = Array.from(activeChildren);
      activeChildren.clear();

      await Promise.all(
        children.map(
          (child) =>
            new Promise((resolve) => {
              const isAlive = () => child.exitCode === null && child.signalCode === null;
              if (!isAlive()) {
                resolve();
                return;
              }

              let settled = false;
              let killTimer = null;
              let finalTimer = null;

              const done = () => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (finalTimer) clearTimeout(finalTimer);
                child.removeListener('exit', done);
                child.removeListener('close', done);
                resolve();
              };

              child.once('exit', done);
              child.once('close', done);

              try {
                child.kill('SIGTERM');
              } catch {
                done();
                return;
              }

              killTimer = setTimeout(() => {
                if (!isAlive()) {
                  done();
                  return;
                }
                try {
                  child.kill('SIGKILL');
                } catch {
                  done();
                  return;
                }
                finalTimer = setTimeout(done, 500);
              }, graceMs);
            }),
        ),
      );
    },

    /**
     * Synchronous last-resort cleanup for process `exit` event.
     */
    disposeSync() {
      for (const child of activeChildren) {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
      activeChildren.clear();
    },

    get activeChildCount() {
      return activeChildren.size;
    },
  };
}
