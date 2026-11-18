'use strict';

/**
 * Pure Node Zero-Dependency RFC 6455 WebSocket Client for CDP.
 * Enforces frame integrity, fragmentation assembly, Ping/Pong, Close codes, and 16 MiB buffer caps.
 */

const crypto = require('crypto');
const http = require('http');

const MAX_WS_BUFFER_BYTES = 16 * 1024 * 1024;
const LOOPBACK_WS_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function assertLoopbackWsUrl(wsUrl) {
  let parsed;
  try {
    parsed = new URL(String(wsUrl || ''));
  } catch {
    throw new Error('Invalid WebSocket URL');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported WebSocket protocol "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_WS_HOSTS.has(host)) {
    throw new Error(`Refusing non-loopback CDP WebSocket host "${parsed.hostname}"`);
  }
  return parsed;
}

function createRfc6455WebSocketClient(wsUrl) {
  const parsed = assertLoopbackWsUrl(wsUrl);
  const secKey = crypto.randomBytes(16).toString('base64');
  const expectedAccept = crypto
    .createHash('sha1')
    .update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  let sock = null;
  let closed = false;
  let closeNotified = false;

  const emitClose = (code = 1000, reason = '') => {
    if (closeNotified) return;
    closeNotified = true;
    if (typeof client.onclose === 'function') {
      try {
        client.onclose({ code, reason });
      } catch {}
    }
  };

  const gracefulEndWithCloseFrame = (targetSock, code = 1000) => {
    if (!targetSock) return;
    const mask = crypto.randomBytes(4);
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    for (let i = 0; i < 2; i++) payload[i] ^= mask[i & 3];
    const destroyTimer = setTimeout(() => {
      try {
        targetSock.destroy();
      } catch {}
    }, 250);
    if (destroyTimer && typeof destroyTimer.unref === 'function') destroyTimer.unref();
    targetSock.once('close', () => clearTimeout(destroyTimer));
    targetSock.end(Buffer.concat([Buffer.from([0x88, 0x82]), mask, payload]));
  };

  const client = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (closed || !sock) throw new Error('WebSocket is not open');
      const payload = Buffer.from(String(data), 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
      }
      sock.write(Buffer.concat([header, masked]));
    },
    close() {
      if (closed) return;
      closed = true;
      if (!sock) {
        try {
          req.destroy();
        } catch {}
        emitClose(1006, 'Closed before upgrade');
        return;
      }
      try {
        gracefulEndWithCloseFrame(sock, 1000);
      } catch {
        try {
          if (sock) sock.destroy();
        } catch {}
      }
    },
  };

  const req = http.request({
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port) || 80,
    path: (parsed.pathname || '/') + (parsed.search || ''),
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': secKey,
    },
  });

  const emitError = (err) => {
    if (closed) return;
    closed = true;
    const errObj = err instanceof Error ? err : new Error(String(err));
    try {
      req.destroy();
    } catch {}
    try {
      if (sock) sock.destroy();
    } catch {}
    if (typeof client.onerror === 'function') {
      client.onerror(errObj);
    }
    emitClose(1006, errObj.message);
  };

  req.on('error', emitError);
  req.on('response', (res) => {
    emitError(new Error(`Unexpected HTTP response ${res.statusCode} during WebSocket upgrade`));
  });

  req.on('upgrade', (res, socket, head) => {
    if (res.headers['sec-websocket-accept'] !== expectedAccept) {
      emitError(new Error('Invalid Sec-WebSocket-Accept header'));
      return;
    }
    sock = socket;
    let recvBuf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let fragOpcode = 0;
    let fragChunks = [];
    let fragBytes = 0;

    const drainFrames = () => {
      while (!closed && recvBuf.length >= 2) {
        const rsv = recvBuf[0] & 0x70;
        const fin = (recvBuf[0] & 0x80) !== 0;
        const opcode = recvBuf[0] & 0x0f;
        if (rsv !== 0) {
          emitError(new Error('Unsupported WebSocket RSV extension bits'));
          return;
        }
        const isMasked = (recvBuf[1] & 0x80) !== 0;
        let len = recvBuf[1] & 0x7f;
        if (opcode >= 0x08 && (!fin || len > 125)) {
          emitError(new Error('Invalid WebSocket control frame'));
          return;
        }
        let offset = 2;
        if (len === 126) {
          if (recvBuf.length < 4) return;
          len = recvBuf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (recvBuf.length < 10) return;
          const bigLen = recvBuf.readBigUInt64BE(2);
          if (bigLen > BigInt(MAX_WS_BUFFER_BYTES)) {
            emitError(new Error('WebSocket frame payload exceeds maximum buffer size'));
            return;
          }
          len = Number(bigLen);
          offset = 10;
        }
        if (len > MAX_WS_BUFFER_BYTES) {
          emitError(new Error('WebSocket frame payload exceeds maximum buffer size'));
          return;
        }
        const maskBytes = isMasked ? 4 : 0;
        if (recvBuf.length < offset + maskBytes + len) return;
        const body = Buffer.from(recvBuf.subarray(offset + maskBytes, offset + maskBytes + len));
        if (isMasked) {
          const m = recvBuf.subarray(offset, offset + 4);
          for (let i = 0; i < body.length; i++) body[i] ^= m[i & 3];
        }
        recvBuf = recvBuf.subarray(offset + maskBytes + len);

        if (opcode === 0x08) {
          if (body.length === 1) {
            emitError(new Error('Invalid 1-byte WebSocket Close payload'));
            return;
          }
          const closeCode = body.length >= 2 ? body.readUInt16BE(0) : 1005;
          const closeReason = body.length > 2 ? body.subarray(2).toString('utf8') : '';
          if (!closed) {
            closed = true;
            try {
              gracefulEndWithCloseFrame(sock, closeCode === 1005 ? 1000 : closeCode);
            } catch {
              try {
                if (sock) sock.destroy();
              } catch {}
            }
          }
          emitClose(closeCode, closeReason);
          return;
        }
        if (opcode === 0x09 && sock && !closed) {
          const pongPayload = body.length <= 125 ? body : body.subarray(0, 125);
          const pongMask = crypto.randomBytes(4);
          const pongHdr = Buffer.from([0x8a, 0x80 | pongPayload.length]);
          const maskedPong = Buffer.allocUnsafe(pongPayload.length);
          for (let i = 0; i < pongPayload.length; i++) {
            maskedPong[i] = pongPayload[i] ^ pongMask[i & 3];
          }
          sock.write(Buffer.concat([pongHdr, pongMask, maskedPong]));
          continue;
        }
        if (opcode === 0x0a) {
          continue;
        }
        if (opcode === 0x01 || opcode === 0x02) {
          if (fragOpcode !== 0) {
            emitError(new Error('Interleaved WebSocket data frame during fragmentation'));
            return;
          }
          if (fin) {
            if (opcode === 0x01 && typeof client.onmessage === 'function') {
              client.onmessage({ data: body.toString('utf8') });
            }
          } else {
            fragOpcode = opcode;
            fragChunks = [body];
            fragBytes = body.length;
          }
          continue;
        }
        if (opcode === 0x00) {
          if (!fragOpcode) {
            emitError(new Error('Unexpected WebSocket continuation frame'));
            return;
          }
          fragBytes += body.length;
          if (fragBytes > MAX_WS_BUFFER_BYTES) {
            emitError(new Error('WebSocket fragmented message exceeds maximum buffer size'));
            return;
          }
          fragChunks.push(body);
          if (fin) {
            const fullBuf = Buffer.concat(fragChunks, fragBytes);
            const completedOp = fragOpcode;
            fragOpcode = 0;
            fragChunks = [];
            fragBytes = 0;
            if (completedOp === 0x01 && typeof client.onmessage === 'function') {
              client.onmessage({ data: fullBuf.toString('utf8') });
            }
          }
          continue;
        }
        emitError(new Error(`Unsupported WebSocket opcode: ${opcode}`));
        return;
      }
    };

    socket.on('data', (chunk) => {
      if (recvBuf.length + chunk.length > MAX_WS_BUFFER_BYTES) {
        emitError(new Error('WebSocket receive buffer exceeded maximum size'));
        return;
      }
      recvBuf = Buffer.concat([recvBuf, chunk]);
      drainFrames();
    });
    socket.on('error', emitError);
    socket.on('close', () => {
      closed = true;
      emitClose(1006, 'Socket closed');
    });

    Promise.resolve().then(() => {
      if (!closed && typeof client.onopen === 'function') {
        client.onopen();
      }
      if (!closed && recvBuf.length > 0) {
        drainFrames();
      }
    });
  });

  req.end();
  return client;
}

function openCdpWebSocket(wsUrl) {
  assertLoopbackWsUrl(wsUrl);
  return createRfc6455WebSocketClient(wsUrl);
}

module.exports = {
  MAX_WS_BUFFER_BYTES,
  assertLoopbackWsUrl,
  createRfc6455WebSocketClient,
  openCdpWebSocket,
};
