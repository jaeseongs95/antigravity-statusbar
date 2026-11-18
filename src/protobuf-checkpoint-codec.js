'use strict';

/**
 * Pure Protobuf wire & Connect-RPC 5-byte envelope codec for
 * `SendUserCascadeMessageRequest` checkpoint limit injection and cascade UUID extraction.
 * Zero DOM or window coupling.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PROTO_UUID_RE = /\x0a\x24([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CONVO_RPC_RE =
  /\/(StreamAgentStateUpdates|RequestAgentStatePageUpdate|StreamCascadeReactiveUpdates|GetCascadeTrajectory|GetCascadeTrajectorySteps|GetCascadeTrajectoryGeneratorMetadata|GetCascadeModelConfigData|SendUserCascadeMessage|UpdateConversationAnnotations|StartCascade)$/i;

function toUint8Slice(body) {
  if (!body) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength ?? body.buffer.byteLength);
  }
  if (body.buffer instanceof ArrayBuffer) {
    return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength ?? body.buffer.byteLength);
  }
  return null;
}

function createTextCodec(envWin) {
  let sharedDecoder = null;
  let sharedEncoder = null;

  function decodeBytesToText(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    try {
      if (!sharedDecoder) {
        const TD = envWin?.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
        if (TD) sharedDecoder = new TD('utf-8');
      }
      if (sharedDecoder) {
        const u8 = toUint8Slice(body) || new Uint8Array(body);
        return sharedDecoder.decode(u8);
      }
    } catch {}
    return '';
  }

  function encodeTextToBytes(str) {
    if (!sharedEncoder) {
      const TE = envWin?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
      if (TE) sharedEncoder = new TE();
    }
    if (sharedEncoder) return sharedEncoder.encode(str);
    return Uint8Array.from(String(str).split('').map((c) => c.charCodeAt(0) & 0xff));
  }

  function decodeBase64ToUtf8(b64) {
    if (!b64 || typeof b64 !== 'string') return '';
    try {
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        return Buffer.from(b64, 'base64').toString('utf8');
      }
      const atobFn = envWin?.atob || (typeof atob === 'function' ? atob : null);
      if (atobFn) {
        const bin = atobFn(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
        return decodeBytesToText(bytes);
      }
    } catch {}
    return '';
  }

  return {
    toUint8Slice,
    decodeBytesToText,
    encodeTextToBytes,
    decodeBase64ToUtf8,
  };
}

function encodeVarint(val) {
  const out = [];
  let v = Math.max(0, Math.floor(Number(val) || 0)) >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

function readProtobufVarint(buf, startOffset) {
  let val = 0;
  let shift = 0;
  let nonZero = false;
  for (let i = 0; i < 10; i++) {
    const idx = startOffset + i;
    if (idx >= buf.length) return null;
    const b = buf[idx];
    if ((b & 0x7f) !== 0) nonZero = true;
    if (shift < 53) {
      val += (b & 0x7f) * (2 ** shift);
    }
    if ((b & 0x80) === 0) {
      return { value: val, nonZero, nextOffset: idx + 1 };
    }
    shift += 7;
  }
  return null;
}

function scanProtobufFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const fieldStart = pos;
    const tagVar = readProtobufVarint(buf, pos);
    if (!tagVar || tagVar.value <= 0) return null;
    const wireType = tagVar.value & 0x07;
    const fieldNumber = Math.floor(tagVar.value / 8);
    if (fieldNumber <= 0) return null;
    pos = tagVar.nextOffset;
    if (wireType === 0) {
      const v = readProtobufVarint(buf, pos);
      if (!v) return null;
      pos = v.nextOffset;
      fields.push({ fieldNumber, wireType, varintNonZero: v.nonZero, rawSlice: buf.subarray(fieldStart, pos) });
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) return null;
      pos += 8;
      fields.push({ fieldNumber, wireType, rawSlice: buf.subarray(fieldStart, pos) });
    } else if (wireType === 2) {
      const lenVar = readProtobufVarint(buf, pos);
      if (!lenVar || lenVar.value < 0 || lenVar.nextOffset + lenVar.value > buf.length) return null;
      const dataStart = lenVar.nextOffset;
      pos = dataStart + lenVar.value;
      fields.push({
        fieldNumber,
        wireType,
        payloadSlice: buf.subarray(dataStart, pos),
        rawSlice: buf.subarray(fieldStart, pos),
      });
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) return null;
      pos += 4;
      fields.push({ fieldNumber, wireType, rawSlice: buf.subarray(fieldStart, pos) });
    } else {
      return null;
    }
  }
  return fields;
}

function concatUint8Arrays(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function buildSendMessageCheckpointSuffix(maxTokenLimit, contextWindow, encodeTextFn) {
  const encodeFn =
    typeof encodeTextFn === 'function'
      ? encodeTextFn
      : (s) => Uint8Array.from(String(s).split('').map((c) => c.charCodeAt(0) & 0xff));
  const cpBytes = [0x28, ...encodeVarint(maxTokenLimit)];
  if (contextWindow && typeof contextWindow === 'string') {
    const cwBytes = Array.from(encodeFn(contextWindow));
    cpBytes.push(0xa2, 0x02, ...encodeVarint(cwBytes.length), ...cwBytes);
  }
  const ccBytes = [0x12, ...encodeVarint(cpBytes.length), ...cpBytes];
  return new Uint8Array([0x2a, ...encodeVarint(ccBytes.length), ...ccBytes]);
}

function isValidCheckpointSuffixAt(buf, pos) {
  if (pos < 0 || pos >= buf.length || buf[pos] !== 0x2a) return false;
  const ccLenVar = readProtobufVarint(buf, pos + 1);
  if (!ccLenVar || ccLenVar.nextOffset + ccLenVar.value !== buf.length) return false;
  const innerPos = ccLenVar.nextOffset;
  if (innerPos >= buf.length || buf[innerPos] !== 0x12) return false;
  const cpLenVar = readProtobufVarint(buf, innerPos + 1);
  if (!cpLenVar || cpLenVar.nextOffset + cpLenVar.value !== buf.length) return false;
  const fieldPos = cpLenVar.nextOffset;
  if (fieldPos >= buf.length || buf[fieldPos] !== 0x28) return false;
  const limitVar = readProtobufVarint(buf, fieldPos + 1);
  if (!limitVar || limitVar.value <= 0) return false;
  if (limitVar.nextOffset === buf.length) return true;
  const cwTagPos = limitVar.nextOffset;
  if (cwTagPos + 2 > buf.length || buf[cwTagPos] !== 0xa2 || buf[cwTagPos + 1] !== 0x02) return false;
  const cwLenVar = readProtobufVarint(buf, cwTagPos + 2);
  return Boolean(cwLenVar && cwLenVar.value >= 1 && cwLenVar.value <= 16 && cwLenVar.nextOffset + cwLenVar.value === buf.length);
}

function stripTrailingCheckpointSuffix(bytes) {
  if (!bytes || bytes.length < 6) return bytes;
  let cur = bytes;
  let stripped = true;
  while (stripped && cur.length >= 6) {
    stripped = false;
    for (let pos = Math.max(0, cur.length - 32); pos <= cur.length - 6; pos++) {
      if (isValidCheckpointSuffixAt(cur, pos)) {
        cur = cur.subarray(0, pos);
        stripped = true;
        break;
      }
    }
  }
  return cur;
}

function findFirstNonWsByte(u8) {
  if (!u8 || u8.length === 0) return -1;
  let i = 0;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    i = 3;
  }
  while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x09 || u8[i] === 0x0a || u8[i] === 0x0d)) {
    i++;
  }
  return i < u8.length ? u8[i] : -1;
}

function endsWithByteSequence(u8, seq) {
  if (!u8 || !seq || u8.length < seq.length) return false;
  const offset = u8.length - seq.length;
  for (let i = 0; i < seq.length; i++) {
    if (u8[offset + i] !== seq[i]) return false;
  }
  return true;
}

function buildConnectFramedBytes(flagByte, payloadBytes) {
  const len = payloadBytes.length;
  const framed = new Uint8Array(5 + len);
  framed[0] = flagByte & 0xff;
  framed[1] = (len >>> 24) & 0xff;
  framed[2] = (len >>> 16) & 0xff;
  framed[3] = (len >>> 8) & 0xff;
  framed[4] = len & 0xff;
  framed.set(payloadBytes, 5);
  return framed;
}

function mergeCheckpointIntoProtobufBytes(rawPayload, maxTokenLimit, contextWindow, encodeTextFn) {
  const suffix = buildSendMessageCheckpointSuffix(maxTokenLimit, contextWindow, encodeTextFn);
  const cleanBytes = stripTrailingCheckpointSuffix(rawPayload);
  const topFields = scanProtobufFields(cleanBytes);
  if (topFields) {
    if (topFields.some((f) => f.fieldNumber === 20 && f.wireType === 0 && f.varintNonZero)) {
      return null;
    }
    const existingCascadeFields = topFields.filter((f) => f.fieldNumber === 5 && f.wireType === 2);
    if (existingCascadeFields.length > 0) {
      const preservedCcSubSlices = [];
      const preservedCpSubSlices = [];
      let allSubParsed = true;
      for (const ccField of existingCascadeFields) {
        const ccSubs = scanProtobufFields(ccField.payloadSlice);
        if (!ccSubs) {
          allSubParsed = false;
          break;
        }
        for (const sub of ccSubs) {
          if (sub.fieldNumber === 2 && sub.wireType === 2) {
            const cpSubs = scanProtobufFields(sub.payloadSlice);
            if (!cpSubs) {
              allSubParsed = false;
              break;
            }
            for (const cpSub of cpSubs) {
              if (cpSub.fieldNumber !== 5 && cpSub.fieldNumber !== 36) {
                preservedCpSubSlices.push(cpSub.rawSlice);
              }
            }
          } else {
            preservedCcSubSlices.push(sub.rawSlice);
          }
        }
        if (!allSubParsed) break;
      }
      if (allSubParsed) {
        const cpTail = [0x28, ...encodeVarint(maxTokenLimit)];
        if (contextWindow && typeof contextWindow === 'string') {
          const cwBytes = Array.from(encodeTextFn(contextWindow));
          cpTail.push(0xa2, 0x02, ...encodeVarint(cwBytes.length), ...cwBytes);
        }
        const mergedCpPayload = concatUint8Arrays([...preservedCpSubSlices, new Uint8Array(cpTail)]);
        const cpFieldBytes = concatUint8Arrays([
          new Uint8Array([0x12, ...encodeVarint(mergedCpPayload.length)]),
          mergedCpPayload,
        ]);
        const mergedCcPayload = concatUint8Arrays([...preservedCcSubSlices, cpFieldBytes]);
        const singleField5Bytes = concatUint8Arrays([
          new Uint8Array([0x2a, ...encodeVarint(mergedCcPayload.length)]),
          mergedCcPayload,
        ]);
        const nonCascadeSlices = topFields
          .filter((f) => !(f.fieldNumber === 5 && f.wireType === 2))
          .map((f) => f.rawSlice);
        return concatUint8Arrays([...nonCascadeSlices, singleField5Bytes]);
      }
    }
  }
  if (endsWithByteSequence(rawPayload, suffix)) {
    return null;
  }
  const merged = new Uint8Array(cleanBytes.length + suffix.length);
  merged.set(cleanBytes, 0);
  merged.set(suffix, cleanBytes.length);
  return merged;
}

function extractCascadeIdFromBody(body, ignoreUuid, codec) {
  const u8 = toUint8Slice(body);
  if (!u8 && body && typeof body === 'object') {
    const cid = body.cascadeId || body.conversationId;
    if (typeof cid === 'string' && UUID_RE.test(cid) && cid !== ignoreUuid) return cid;
  }
  let targetBody = u8 || body;
  if (u8 && u8.length >= 5 && u8[0] === 0) {
    const frameLen = ((u8[1] << 24) >>> 0) + (u8[2] << 16) + (u8[3] << 8) + u8[4];
    if (frameLen === u8.length - 5) {
      targetBody = u8.subarray(5);
    }
  }
  const text = codec ? codec.decodeBytesToText(targetBody) : '';
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      const cid = j.cascadeId || j.conversationId;
      if (typeof cid === 'string' && UUID_RE.test(cid) && cid !== ignoreUuid) return cid;
    } catch {}
  }
  const pm = text.match(PROTO_UUID_RE);
  if (pm && pm[1] && pm[1] !== ignoreUuid) return pm[1];
  const um = text.match(UUID_RE);
  if (um && um[0] && um[0] !== ignoreUuid) return um[0];
  return null;
}

function injectCheckpointPayload({ path, body, contextWindow, maxTokenLimit, codec }) {
  if (typeof path !== 'string' || !/\/SendUserCascadeMessage$/i.test(path) || !body) {
    return body;
  }
  if (!contextWindow || !maxTokenLimit || maxTokenLimit <= 0) return body;

  const isContinueAfterInjectionObj = (obj) =>
    Boolean(obj && typeof obj === 'object' && (obj.continueAfterInjection === true || obj.continue_after_injection === true));

  const applyCheckpointToJsonObj = (j) => {
    if (!j || typeof j !== 'object') return j;
    if (isContinueAfterInjectionObj(j)) return j;
    j.cascadeConfig = j.cascadeConfig || {};
    j.cascadeConfig.checkpointConfig = {
      ...(j.cascadeConfig.checkpointConfig || {}),
      contextWindow,
      maxTokenLimit,
    };
    return j;
  };

  try {
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed.startsWith('{')) {
        const parsedObj = JSON.parse(trimmed);
        if (isContinueAfterInjectionObj(parsedObj)) return body;
        return JSON.stringify(applyCheckpointToJsonObj(parsedObj));
      }
      return body;
    }

    const u8 = toUint8Slice(body);
    if (!u8) {
      if (typeof body === 'object') {
        if (isContinueAfterInjectionObj(body)) return body;
        const cloned =
          typeof body.clone === 'function'
            ? body.clone()
            : Object.assign(Object.create(Object.getPrototypeOf(body)), body);
        const prevCc = body.cascadeConfig;
        const nextCc =
          prevCc && typeof prevCc === 'object'
            ? (typeof prevCc.clone === 'function'
                ? prevCc.clone()
                : Object.assign(Object.create(Object.getPrototypeOf(prevCc)), prevCc))
            : {};
        const prevCp = prevCc?.checkpointConfig;
        const nextCp =
          prevCp && typeof prevCp === 'object'
            ? (typeof prevCp.clone === 'function'
                ? prevCp.clone()
                : Object.assign(Object.create(Object.getPrototypeOf(prevCp)), prevCp))
            : {};
        nextCp.contextWindow = contextWindow;
        nextCp.maxTokenLimit = maxTokenLimit;
        nextCc.checkpointConfig = nextCp;
        cloned.cascadeConfig = nextCc;
        return cloned;
      }
      return body;
    }
    if (u8.length === 0) return body;

    if (findFirstNonWsByte(u8) === 0x7b) {
      const text = codec.decodeBytesToText(u8);
      const parsedObj = JSON.parse(text);
      if (isContinueAfterInjectionObj(parsedObj)) return body;
      return codec.encodeTextToBytes(JSON.stringify(applyCheckpointToJsonObj(parsedObj)));
    }

    const frameLen =
      u8.length >= 5
        ? (((u8[1] << 24) >>> 0) + (u8[2] << 16) + (u8[3] << 8) + u8[4])
        : -1;
    const isConnectFrame = u8.length >= 5 && (u8[0] < 8 || (u8[0] & 0x80) !== 0 || frameLen === u8.length - 5);
    if (isConnectFrame) {
      if (frameLen !== u8.length - 5 || u8[0] !== 0) {
        return body;
      }
      const payload = u8.subarray(5);
      if (findFirstNonWsByte(payload) === 0x7b) {
        const text = codec.decodeBytesToText(payload);
        const parsedObj = JSON.parse(text);
        if (isContinueAfterInjectionObj(parsedObj)) return body;
        const j = applyCheckpointToJsonObj(parsedObj);
        return buildConnectFramedBytes(0, codec.encodeTextToBytes(JSON.stringify(j)));
      }
      const nextPayload = mergeCheckpointIntoProtobufBytes(
        payload,
        maxTokenLimit,
        contextWindow,
        codec.encodeTextToBytes
      );
      if (!nextPayload) return body;
      return buildConnectFramedBytes(0, nextPayload);
    }

    const nextUnframed = mergeCheckpointIntoProtobufBytes(
      u8,
      maxTokenLimit,
      contextWindow,
      codec.encodeTextToBytes
    );
    return nextUnframed || body;
  } catch {
    return body;
  }
}

module.exports = {
  UUID_RE,
  PROTO_UUID_RE,
  CONVO_RPC_RE,
  toUint8Slice,
  createTextCodec,
  encodeVarint,
  readProtobufVarint,
  scanProtobufFields,
  buildSendMessageCheckpointSuffix,
  stripTrailingCheckpointSuffix,
  mergeCheckpointIntoProtobufBytes,
  buildConnectFramedBytes,
  extractCascadeIdFromBody,
  injectCheckpointPayload,
};
