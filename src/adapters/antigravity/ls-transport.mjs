import http from 'node:http';
import https from 'node:https';

import { DomainError, ERROR_CODES } from '../../core/i18n/error-codes.mjs';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MiB hard cap (F3)
const DEFAULT_RPC_TIMEOUT_MS = 8_000;
const DEFAULT_STREAM_TIMEOUT_MS = 6_000;
const QUOTA_TTL_MS = 15_000;
const QUOTA_MAX_BACKOFF_MS = 120_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Parses and validates the Language Server address.
 * Supports schemeless `localhost:<port>` (normalized to `http://`),
 * strictly enforces loopback-only hosts and valid port range.
 *
 * @param {string} rawAddress
 * @returns {{ protocol: 'http:' | 'https:', hostname: string, port: number, origin: string }}
 */
export function parseLoopbackLsAddress(rawAddress) {
  if (typeof rawAddress !== 'string' || !rawAddress.trim()) {
    throw new DomainError(
      ERROR_CODES.TELEMETRY_UNAVAILABLE,
      503,
      'ANTIGRAVITY_LS_ADDRESS is not configured.',
    );
  }
  const trimmed = rawAddress.trim();
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new DomainError(
      ERROR_CODES.TELEMETRY_UNAVAILABLE,
      503,
      `Invalid ANTIGRAVITY_LS_ADDRESS: ${rawAddress}`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DomainError(
      ERROR_CODES.TELEMETRY_UNAVAILABLE,
      503,
      `Unsupported LS protocol: ${parsed.protocol}`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new DomainError(
      ERROR_CODES.TELEMETRY_UNAVAILABLE,
      503,
      `Non-loopback LS host rejected: ${hostname}`,
    );
  }

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DomainError(
      ERROR_CODES.TELEMETRY_UNAVAILABLE,
      503,
      `Invalid LS port: ${parsed.port}`,
    );
  }

  return {
    protocol: /** @type {'http:' | 'https:'} */ (parsed.protocol),
    hostname: hostname.replace(/^\[|\]$/g, ''),
    port,
    origin: `${parsed.protocol}//${parsed.host}`,
  };
}

/**
 * Encodes a JSON object into a single Connect 5-byte framed message.
 *
 * @param {unknown} payload
 * @returns {Buffer}
 */
export function encodeConnectFrame(payload) {
  const jsonBytes = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const frame = Buffer.allocUnsafe(5 + jsonBytes.length);
  frame[0] = 0x00; // uncompressed data frame
  frame.writeUInt32BE(jsonBytes.length, 1);
  jsonBytes.copy(frame, 5);
  return frame;
}

/**
 * Creates a hardened loopback-only Connect RPC transport for Antigravity Language Server.
 *
 * @param {{
 *   lsAddress: string,
 *   csrfToken?: string,
 *   clock?: () => number,
 * }} config
 */
export function createLsTransport({ lsAddress, csrfToken = '', clock = () => Date.now() }) {
  const endpoint = parseLoopbackLsAddress(lsAddress);
  const transportModule = endpoint.protocol === 'https:' ? https : http;

  let quotaCache = null;
  let quotaCacheExpiresAt = 0;
  let quotaBackoffMs = QUOTA_TTL_MS;
  let quotaNextAllowedAt = 0;

  function buildHeaders(contentType, bodyLength) {
    const headers = {
      'content-type': contentType,
      'connect-protocol-version': '1',
      'content-length': String(bodyLength),
      accept: contentType,
    };
    if (csrfToken) {
      headers['x-codeium-csrf-token'] = csrfToken;
    }
    return headers;
  }

  /**
   * Executes a unary Connect JSON RPC call (no redirects, HTTPS rejectUnauthorized: true, 4MB cap).
   *
   * @param {string} method
   * @param {Record<string, unknown>} payload
   * @param {{ timeoutMs?: number }} [opts]
   */
  function callUnaryRpc(method, payload = {}, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const rpcPath = `/exa.language_server_pb.LanguageServerService/${method}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };

      const reqOptions = {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: 'POST',
        path: rpcPath,
        headers: buildHeaders('application/json', bodyBuf.length),
      };
      if (endpoint.protocol === 'https:') {
        reqOptions.rejectUnauthorized = true;
      }

      const req = transportModule.request(reqOptions, (res) => {
        const status = res.statusCode ?? 0;

        // Strict redirect refusal
        if (status >= 300 && status < 400) {
          res.on('error', () => {});
          res.destroy();
          done(
            new DomainError(
              ERROR_CODES.TELEMETRY_UNAVAILABLE,
              502,
              `LS RPC ${method} returned unexpected redirect (${status}).`,
            ),
          );
          return;
        }

        const chunks = [];
        let totalBytes = 0;

        res.on('error', (err) => {
          done(
            new DomainError(
              ERROR_CODES.TELEMETRY_UNAVAILABLE,
              502,
              `LS RPC ${method} response error: ${err.message}`,
            ),
          );
        });

        res.on('data', (chunk) => {
          if (settled) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            done(
              new DomainError(
                ERROR_CODES.TELEMETRY_UNAVAILABLE,
                502,
                `LS RPC ${method} exceeded 4MB response cap.`,
                { reason: 'RESPONSE_CAP_EXCEEDED' },
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const text = Buffer.concat(chunks, totalBytes).toString('utf8');
          if (status === 429) {
            done(
              new DomainError(ERROR_CODES.QUOTA_UNAVAILABLE, 429, `LS RPC ${method} rate-limited.`),
            );
            return;
          }
          if (status !== 200) {
            done(
              new DomainError(
                ERROR_CODES.TELEMETRY_UNAVAILABLE,
                502,
                `LS RPC ${method} failed with HTTP ${status}.`,
              ),
            );
            return;
          }
          try {
            const parsed = text.trim() ? JSON.parse(text) : {};
            done(null, parsed);
          } catch {
            done(
              new DomainError(
                ERROR_CODES.TELEMETRY_UNAVAILABLE,
                502,
                `LS RPC ${method} returned invalid JSON.`,
              ),
            );
          }
        });
      });

      req.on('error', (err) => {
        done(
          new DomainError(
            ERROR_CODES.TELEMETRY_UNAVAILABLE,
            502,
            `LS RPC ${method} connection error: ${err.message}`,
          ),
        );
      });

      const timer = setTimeout(() => {
        req.destroy();
        done(
          new DomainError(
            ERROR_CODES.TELEMETRY_UNAVAILABLE,
            504,
            `LS RPC ${method} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      req.end(bodyBuf);
    });
  }

  /**
   * Reads the first data frame from a Connect 5-byte framed server stream (F3):
   * 1. Verifies res.statusCode === 200 and content-type includes application/connect+json first.
   * 2. Verifies 4-byte frame length <= 4MB before buffering.
   * 3. Attaches permanent 'error' listeners before calling destroy() after 1st frame.
   *
   * @param {string} method
   * @param {Record<string, unknown>} payload
   * @param {{ timeoutMs?: number }} [opts]
   */
  function readFirstStreamFrame(method, payload = {}, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const bodyBuf = encodeConnectFrame(payload);
    const rpcPath = `/exa.language_server_pb.LanguageServerService/${method}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };

      const reqOptions = {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: 'POST',
        path: rpcPath,
        headers: buildHeaders('application/connect+json', bodyBuf.length),
      };
      if (endpoint.protocol === 'https:') {
        reqOptions.rejectUnauthorized = true;
      }

      const req = transportModule.request(reqOptions, (res) => {
        // F3: Attach permanent error listener immediately to prevent ERR_STREAM_PREMATURE_CLOSE crash
        res.on('error', (err) => {
          if (!settled) {
            done(
              new DomainError(
                ERROR_CODES.TELEMETRY_UNAVAILABLE,
                502,
                `LS stream ${method} error: ${err.message}`,
              ),
            );
          }
        });

        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] || '').toLowerCase();

        // F3: Check status === 200 and content-type before reading frame bytes
        if (status !== 200 || !contentType.includes('application/connect+json')) {
          res.destroy();
          req.destroy();
          done(
            new DomainError(
              ERROR_CODES.TELEMETRY_UNAVAILABLE,
              502,
              `LS stream ${method} invalid status/content-type (${status}, ${contentType}).`,
            ),
          );
          return;
        }

        let buf = Buffer.alloc(0);
        let expectedFrameLen = null;
        let frameFlags = 0;

        res.on('data', (chunk) => {
          if (settled) return;
          buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

          if (expectedFrameLen === null && buf.length >= 5) {
            frameFlags = buf[0];
            expectedFrameLen = buf.readUInt32BE(1);

            // F3: Verify frame length <= 4MB before buffering full payload
            if (expectedFrameLen > MAX_RESPONSE_BYTES) {
              res.destroy();
              req.destroy();
              done(
                new DomainError(
                  ERROR_CODES.TELEMETRY_UNAVAILABLE,
                  502,
                  `LS stream ${method} frame length ${expectedFrameLen} exceeds 4MB cap.`,
                ),
              );
              return;
            }
          }

          if (expectedFrameLen !== null && buf.length >= 5 + expectedFrameLen) {
            const framePayload = buf.subarray(5, 5 + expectedFrameLen);
            // F3: Permanent error listeners are already attached on both req and res
            res.destroy();
            req.destroy();

            if ((frameFlags & 0x01) !== 0) {
              done(
                new DomainError(
                  ERROR_CODES.TELEMETRY_UNAVAILABLE,
                  502,
                  `LS stream ${method} returned unsupported compressed frame.`,
                ),
              );
              return;
            }

            try {
              const parsed = JSON.parse(framePayload.toString('utf8'));
              if ((frameFlags & 0x02) !== 0) {
                // End-of-stream trailer frame before any data frame
                const errMsg = parsed?.error?.message || `LS stream ${method} ended without data.`;
                done(new DomainError(ERROR_CODES.TELEMETRY_UNAVAILABLE, 502, errMsg));
                return;
              }
              done(null, parsed);
            } catch {
              done(
                new DomainError(
                  ERROR_CODES.TELEMETRY_UNAVAILABLE,
                  502,
                  `LS stream ${method} frame contained invalid JSON.`,
                ),
              );
            }
          }
        });

        res.on('end', () => {
          if (!settled) {
            done(
              new DomainError(
                ERROR_CODES.TELEMETRY_UNAVAILABLE,
                502,
                `LS stream ${method} ended before first frame completed.`,
              ),
            );
          }
        });
      });

      // F3: Permanent error listener on req before any destroy()
      req.on('error', (err) => {
        if (!settled) {
          done(
            new DomainError(
              ERROR_CODES.TELEMETRY_UNAVAILABLE,
              502,
              `LS stream ${method} request error: ${err.message}`,
            ),
          );
        }
      });

      const timer = setTimeout(() => {
        req.destroy();
        done(
          new DomainError(
            ERROR_CODES.TELEMETRY_UNAVAILABLE,
            504,
            `LS stream ${method} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      req.end(bodyBuf);
    });
  }

  const MAX_TAIL_CACHE = 64;
  const tailOffsetCache = new Map();

  function rememberTailEnd(cascadeId, endOffset) {
    if (!cascadeId || !Number.isFinite(endOffset) || endOffset <= 0) return;
    if (tailOffsetCache.has(cascadeId)) tailOffsetCache.delete(cascadeId);
    tailOffsetCache.set(cascadeId, Math.floor(endOffset));
    while (tailOffsetCache.size > MAX_TAIL_CACHE) {
      const oldest = tailOffsetCache.keys().next().value;
      if (oldest === undefined) break;
      tailOffsetCache.delete(oldest);
    }
  }

  function isOversizeResponseError(err) {
    return Boolean(
      err?.details?.reason === 'RESPONSE_CAP_EXCEEDED' ||
        (typeof err?.message === 'string' && err.message.includes('4MB')),
    );
  }

  /**
   * Bounded overshoot tail reader for GetCascadeTrajectoryGeneratorMetadata (-20/-60/-180).
   * F2: When approxIndex is missing/<=0, uses cached tail offset for O(1) subsequent polls;
   * on cache miss, probes offset=0 first and falls back to bounded exponential + binary
   * search to land cleanly on the final <4MB tail window in O(log N) calls.
   * ISS-04: Only probes/falls back on RESPONSE_CAP_EXCEEDED (>4MB); non-oversize errors
   * (504 timeouts, connection failures, 502 upstream errors) propagate immediately.
   *
   * @param {string} cascadeId
   * @param {number | null} approxIndex
   */
  async function getTailGeneratorMetadata(cascadeId, approxIndex) {
    const hasUsefulChatModel = (list) =>
      list.some((item) => {
        const cm =
          item?.chatModel ||
          (item?.metadata?.case === 'chatModel' ? item.metadata.value : null);
        if (!cm) return false;
        const hasNonEmptyUsage = Boolean(
          cm.usage && (cm.usage.inputTokens != null || cm.usage.cacheReadTokens != null),
        );
        return Boolean(
          hasNonEmptyUsage ||
            cm.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups ||
            cm.modelDisplayName ||
            cm.model,
        );
      });

    async function fetchOffset(offset) {
      const resp = await callUnaryRpc('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId,
        generatorMetadataOffset: offset,
      });
      return Array.isArray(resp?.generatorMetadata) ? resp.generatorMetadata : [];
    }

    const explicitBase =
      typeof approxIndex === 'number' && Number.isFinite(approxIndex) && approxIndex > 0
        ? Math.floor(approxIndex)
        : 0;
    const cachedBase = explicitBase === 0 ? tailOffsetCache.get(cascadeId) || 0 : 0;
    const base = explicitBase > 0 ? explicitBase : cachedBase;

    if (base > 0) {
      const offsets = [
        Math.max(0, base - 20),
        Math.max(0, base - 5),
        base,
        Math.max(0, base - 60),
        Math.max(0, base - 180),
      ];
      const seenOffsets = new Set();
      for (const offset of offsets) {
        if (seenOffsets.has(offset)) continue;
        seenOffsets.add(offset);
        let list;
        try {
          list = await fetchOffset(offset);
        } catch (err) {
          if (!isOversizeResponseError(err)) throw err;
          continue;
        }
        if (list.length > 0 && (hasUsefulChatModel(list) || offset === 0)) {
          rememberTailEnd(cascadeId, offset + list.length);
          return list;
        }
      }
      if (cachedBase > 0) {
        tailOffsetCache.delete(cascadeId);
      } else {
        return [];
      }
    }

    // Fast path for normal trajectories: offset = 0
    try {
      const list = await fetchOffset(0);
      if (list.length > 0) {
        rememberTailEnd(cascadeId, list.length);
        return list;
      }
      return [];
    } catch (err) {
      if (!isOversizeResponseError(err)) throw err;
      // offset = 0 overflowed 4MB cap -> exponential + binary tail search
    }

    let lowOverflow = 0;
    let highEmpty = null;
    let probe = 256;
    const MAX_PROBE = 262_144;

    while (probe <= MAX_PROBE) {
      try {
        const list = await fetchOffset(probe);
        if (list.length > 0) {
          if (hasUsefulChatModel(list)) {
            rememberTailEnd(cascadeId, probe + list.length);
            return list;
          }
          // Step back slightly if tail slice only had non-chatModel entries
          const backOffset = Math.max(lowOverflow + 1, probe - 64);
          try {
            const wider = await fetchOffset(backOffset);
            if (wider.length > 0) {
              rememberTailEnd(cascadeId, backOffset + wider.length);
              return wider;
            }
          } catch (backErr) {
            if (!isOversizeResponseError(backErr)) throw backErr;
          }
          rememberTailEnd(cascadeId, probe + list.length);
          return list;
        }
        highEmpty = probe;
        break;
      } catch (err) {
        if (!isOversizeResponseError(err)) throw err;
        lowOverflow = probe;
        probe *= 2;
      }
    }

    if (highEmpty === null) {
      return [];
    }

    // Binary search between lowOverflow (exceeds 4MB) and highEmpty (0 items)
    let lo = lowOverflow;
    let hi = highEmpty;
    for (let iter = 0; iter < 12 && hi - lo > 1; iter += 1) {
      const mid = Math.floor((lo + hi) / 2);
      try {
        const list = await fetchOffset(mid);
        if (list.length > 0) {
          rememberTailEnd(cascadeId, mid + list.length);
          return list;
        }
        hi = mid;
      } catch (err) {
        if (!isOversizeResponseError(err)) throw err;
        lo = mid;
      }
    }

    return [];
  }

  /**
   * Bounded tail step reader for GetCascadeTrajectorySteps.
   * Used when StreamAgentStateUpdates exceeds the 4MB cap so completed or in-progress
   * CORTEX_STEP_TYPE_CHECKPOINT (/compact) steps are detected immediately before the next LLM turn.
   *
   * @param {string} cascadeId
   * @param {number | null} stepCount
   * @returns {Promise<{ stepOffset: number, steps: unknown[] }>}
   */
  async function getTailTrajectorySteps(cascadeId, stepCount) {
    const total =
      typeof stepCount === 'number' && Number.isFinite(stepCount) && stepCount > 0
        ? Math.floor(stepCount)
        : 0;
    if (!cascadeId || total <= 0) {
      return { stepOffset: 0, steps: [] };
    }

    const candidateOffsets = [
      Math.max(0, total - 40),
      Math.max(0, total - 16),
      Math.max(0, total - 4),
      Math.max(0, total - 1),
    ];
    const seen = new Set();
    for (const stepOffset of candidateOffsets) {
      if (seen.has(stepOffset)) continue;
      seen.add(stepOffset);
      try {
        const resp = await callUnaryRpc('GetCascadeTrajectorySteps', {
          cascadeId,
          stepOffset,
        });
        const steps = Array.isArray(resp?.steps) ? resp.steps : [];
        return { stepOffset, steps };
      } catch (err) {
        if (!isOversizeResponseError(err)) throw err;
        // Retry a narrower tail window only if an earlier step contained a >4MB payload
        continue;
      }
    }
    return { stepOffset: 0, steps: [] };
  }

  const QUOTA_EXPIRED_MIN_REFETCH_MS = 3_000;
  let quotaLastFetchedAt = 0;

  function hasExpiredQuotaBucket(rawData, now) {
    const container = rawData?.response ?? rawData;
    const groups = Array.isArray(container?.groups) ? container.groups : [];
    for (const group of groups) {
      const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
      for (const b of buckets) {
        const rawRemaining =
          b?.remaining && b.remaining.case === 'remainingFraction'
            ? b.remaining.value
            : b?.remainingFraction;
        const frac = Number(rawRemaining);
        if (Number.isFinite(frac) && frac >= 1) continue;
        let resetMs = Number.NaN;
        const rt = b?.resetTime;
        if (typeof rt === 'string' && rt.trim()) {
          resetMs = Date.parse(rt.trim());
        } else if (rt && typeof rt === 'object' && Object.hasOwn(rt, 'seconds')) {
          const secs = Number(rt.seconds);
          const nanos = Number(rt.nanos ?? 0);
          if (
            rt.seconds !== null &&
            rt.seconds !== undefined &&
            String(rt.seconds).trim() !== '' &&
            Number.isFinite(secs) &&
            secs >= 0
          ) {
            resetMs = secs * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
          }
        }
        if (Number.isFinite(resetMs) && resetMs <= now) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Fetches quota summary with 15s TTL cache, automatic bypass when a cached bucket's resetTime
   * has elapsed (throttled by QUOTA_EXPIRED_MIN_REFETCH_MS), optional forceRefresh, and exponential backoff on 429.
   */
  async function getQuotaSummaryRaw(opts = {}) {
    const now = clock();
    const forceRefresh = Boolean(opts && opts.forceRefresh);
    const cacheValid = Boolean(quotaCache && now < quotaCacheExpiresAt);
    const expiredBucketDue =
      cacheValid &&
      now - quotaLastFetchedAt >= QUOTA_EXPIRED_MIN_REFETCH_MS &&
      hasExpiredQuotaBucket(quotaCache, now);

    if (cacheValid && !forceRefresh && !expiredBucketDue) {
      return {
        data: quotaCache,
        stale: false,
        fetchedAt: quotaLastFetchedAt || quotaCacheExpiresAt - QUOTA_TTL_MS,
      };
    }
    if (now < quotaNextAllowedAt) {
      return { data: quotaCache, stale: true, fetchedAt: now };
    }

    try {
      const resp = await callUnaryRpc('RetrieveUserQuotaSummary', {});
      quotaCache = resp;
      quotaLastFetchedAt = now;
      quotaCacheExpiresAt = now + QUOTA_TTL_MS;
      quotaBackoffMs = QUOTA_TTL_MS;
      quotaNextAllowedAt = 0;
      return { data: resp, stale: false, fetchedAt: now };
    } catch (err) {
      if (err instanceof DomainError && err.httpStatus === 429) {
        quotaNextAllowedAt = now + quotaBackoffMs;
        quotaBackoffMs = Math.min(quotaBackoffMs * 2, QUOTA_MAX_BACKOFF_MS);
        return { data: quotaCache, stale: true, fetchedAt: now };
      }
      if (quotaCache) {
        return { data: quotaCache, stale: true, fetchedAt: now };
      }
      return { data: null, stale: true, fetchedAt: now };
    }
  }

  return {
    endpoint,
    callUnaryRpc,
    readFirstStreamFrame,
    getTailGeneratorMetadata,
    getTailTrajectorySteps,
    getQuotaSummaryRaw,
  };
}
