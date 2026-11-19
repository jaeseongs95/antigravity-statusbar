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
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            done(
              new DomainError(
                ERROR_CODES.TELEMETRY_UNAVAILABLE,
                502,
                `LS RPC ${method} exceeded 4MB response cap.`,
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

  /**
   * Bounded overshoot tail reader for GetCascadeTrajectoryGeneratorMetadata (-20/-60/-180).
   *
   * @param {string} cascadeId
   * @param {number | null} approxIndex
   */
  async function getTailGeneratorMetadata(cascadeId, approxIndex) {
    const base =
      typeof approxIndex === 'number' && Number.isFinite(approxIndex) && approxIndex > 0
        ? Math.floor(approxIndex)
        : 0;

    const offsets =
      base > 0
        ? [Math.max(0, base - 20), Math.max(0, base - 60), Math.max(0, base - 180)]
        : [0];

    const seenOffsets = new Set();
    for (const offset of offsets) {
      if (seenOffsets.has(offset)) continue;
      seenOffsets.add(offset);

      const resp = await callUnaryRpc('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId,
        generatorMetadataOffset: offset,
      });
      const list = Array.isArray(resp?.generatorMetadata) ? resp.generatorMetadata : [];
      if (list.length > 0) {
        // Return tail items if any item has chatModel.usage
        const hasUsage = list.some((item) => item?.chatModel?.usage);
        if (hasUsage || offset === 0) {
          return list;
        }
      }
    }
    return [];
  }

  /**
   * Fetches quota summary with 15s TTL cache and exponential backoff on 429.
   */
  async function getQuotaSummaryRaw() {
    const now = clock();
    if (quotaCache && now < quotaCacheExpiresAt) {
      return { data: quotaCache, stale: false, fetchedAt: quotaCacheExpiresAt - QUOTA_TTL_MS };
    }
    if (now < quotaNextAllowedAt) {
      return { data: quotaCache, stale: true, fetchedAt: now };
    }

    try {
      const resp = await callUnaryRpc('RetrieveUserQuotaSummary', {});
      quotaCache = resp;
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
    getQuotaSummaryRaw,
  };
}
