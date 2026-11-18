'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildBundle, stripCommentsAndEmptyLines } = require('../../scripts/build');
const {
  MCP_BEGIN_RE,
  MCP_END_RE,
  KO_BEGIN_RE,
  KO_END_RE,
  extractAnchoredCompanionBlock,
  install,
} = require('../../scripts/install');
const {
  PATCH_MARKER,
  UTILS_ANCHOR_TARGET,
  UTILS_ANCHOR_REPLACEMENT,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  PRELOAD_ANCHOR_TARGET,
  PRELOAD_ANCHOR_REPLACEMENT,
  transformExactSize,
  isAsarPatchedFast,
  readAsarArchive,
  serializeAsarBuffer,
} = require('../../installer/asar-codec');
const { acquireFileLock, releaseFileLock } = require('../../installer/file-lock');
const { createRfc6455WebSocketClient, openCdpWebSocket } = require('../../installer/rfc6455-client');
const { detectBundledPlugins, configureTargetViaCdp, injectViaBrowserCdpWs } = require('../../installer/cdp-injector');
const { syncAppStorageCode, patchAsarOnDisk, uninstallFromDisk } = require('../../installer/host-patcher');
const { spawnSync } = require('node:child_process');

function createTestAsar(fileEntries) {
  const headerObj = { files: {} };
  const chunks = [];
  let offset = 0;

  for (const [relPath, buf] of Object.entries(fileEntries)) {
    const parts = relPath.split('/');
    let cur = headerObj.files;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = { files: {} };
      cur = cur[parts[i]].files;
    }
    cur[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }

  const headerStrBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const strSize = headerStrBuf.length;
  const alignedStrSize = Math.ceil(strSize / 4) * 4;
  const u8 = 4 + alignedStrSize;
  const u4 = 4 + u8;
  const totalHeader = 8 + u4;
  const hdrBuf = Buffer.alloc(totalHeader, 0);
  hdrBuf.writeUInt32LE(4, 0);
  hdrBuf.writeUInt32LE(u4, 4);
  hdrBuf.writeUInt32LE(u8, 8);
  hdrBuf.writeUInt32LE(strSize, 12);
  headerStrBuf.copy(hdrBuf, 16);

  return Buffer.concat([hdrBuf, ...chunks]);
}

function acceptWsUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function makeServerFrame(opcode, payloadBuf, fin = true) {
  const first = (fin ? 0x80 : 0) | (opcode & 0x0f);
  const len = payloadBuf.length;
  let hdr;
  if (len < 126) {
    hdr = Buffer.from([first, len]);
  } else {
    hdr = Buffer.alloc(4);
    hdr[0] = first;
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
  }
  return Buffer.concat([hdr, payloadBuf]);
}

describe('v2.0 Build, Install, ASAR Codec, Atomic Lock, RFC6455 & CDP Patcher Suite', () => {
  it('SB2-TC-010a: Build script compiles Hexagonal src/ cleanly preserving regexes/templates & install.js preserves column-0 companion blocks + copies installer/', () => {
    const sample = [
      '// leading comment',
      'const re = /foo\\/bar/gi;',
      'const tmpl = `hello',
      '// inside template must stay',
      'world`;',
      '/* block comment */',
      'module.exports = { re, tmpl };',
    ].join('\n');
    const stripped = stripCommentsAndEmptyLines(sample);
    assert.ok(stripped.includes('// inside template must stay'));
    assert.equal(stripped.includes('// leading comment'), false);
    assert.ok(stripped.includes('/foo\\/bar/gi'));

    const res = buildBundle({ write: false });
    assert.doesNotThrow(() => new vm.Script(res.bundle));
    assert.ok(res.bundle.includes('@version      2.0.0'));
    assert.equal(res.bundle.includes('innerHTML'), false);

    // Install isolation test (temp dir, zero ~/.gemini mutation)
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sb-inst-'));
    try {
      const targetAutoinject = path.join(tmpRoot, 'statusbar_autoinject.js');
      const prevCombined = [
        '// old statusbar',
        'const fakeStr = "\\n// === END_AGY_MCP_MANAGER_V1 ===";',
        '// === BEGIN_AGY_MCP_MANAGER_V1 ===',
        'function mountMcpManager() { return 1; }',
        '// === END_AGY_MCP_MANAGER_V1 ===',
        '// === BEGIN_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
        'window.__agyKoThoughtCleanup = () => {};',
        '// === END_AGY_KO_THOUGHT_LOCALIZER_V2 ===',
      ].join('\n');
      fs.writeFileSync(targetAutoinject, prevCombined, 'utf8');

      // Test column-0 companion extractor avoids inside-string traps
      const mcpExtracted = extractAnchoredCompanionBlock(prevCombined, MCP_BEGIN_RE, MCP_END_RE);
      assert.ok(mcpExtracted.startsWith('// === BEGIN_AGY_MCP_MANAGER_V1 ==='));
      assert.ok(mcpExtracted.includes('mountMcpManager'));

      const koExtracted = extractAnchoredCompanionBlock(prevCombined, KO_BEGIN_RE, KO_END_RE);
      assert.ok(koExtracted.includes('__agyKoThoughtCleanup'));

      const instOut = install({
        agyDir: tmpRoot,
        skipWorker: true,
        noExit: true,
      });
      const finalCombined = fs.readFileSync(instOut.targetAutoinject, 'utf8');
      assert.ok(finalCombined.includes('@version      2.0.0'));
      assert.ok(finalCombined.includes('mountMcpManager'));
      assert.ok(finalCombined.includes('__agyKoThoughtCleanup'));
      assert.ok(fs.existsSync(path.join(instOut.targetInstallerDir, 'cli.js')));
      assert.ok(fs.existsSync(instOut.targetPatcher));

      const detected = detectBundledPlugins(finalCombined);
      assert.deepEqual(detected, { expectsStatusbar: true, expectsMcp: true, expectsKo: true });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('SB2-TC-010b (D-0010, D-0017, D-0023, D-0024): Exact-size ASAR transform, NUL header reading, zero offset drift, atomic lock & app_storage sync', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sb-asar-'));
    try {
      const padding = '// ' + 'x'.repeat(900) + '\n';
      const origUtils = Buffer.from(`"use strict";\n${padding}function createWindow(win, url) {\n    void win.loadURL(url);\n}\n`, 'utf8');
      const origMain = Buffer.from(`"use strict";\n${padding}electron_1.app.on('web-contents-created', (_event, contents) => {\n});\n`, 'utf8');
      const origPreload = Buffer.from(`"use strict";\n${padding}electron_1.contextBridge.exposeInMainWorld('wsl', wslAPI);\n`, 'utf8');

      const outUtils = transformExactSize(origUtils, UTILS_ANCHOR_TARGET, UTILS_ANCHOR_REPLACEMENT);
      const outMain = transformExactSize(origMain, MAIN_ANCHOR_TARGET, MAIN_ANCHOR_REPLACEMENT);
      const outPreload = transformExactSize(origPreload, PRELOAD_ANCHOR_TARGET, PRELOAD_ANCHOR_REPLACEMENT);
      assert.equal(outUtils.length, origUtils.length);
      assert.equal(outMain.length, origMain.length);
      assert.equal(outPreload.length, origPreload.length);

      const asarPath = path.join(tmpDir, 'app.asar');
      const autoinjectPath = path.join(tmpDir, 'statusbar_autoinject.js');
      const appStoragePath = path.join(tmpDir, 'app_storage.json');
      const storageLockPath = path.join(tmpDir, 'storage.lock');
      fs.writeFileSync(autoinjectPath, '/* statusbar bundle */ window.__testOk = 1;', 'utf8');
      fs.writeFileSync(appStoragePath, JSON.stringify({ otherKey: 42 }), 'utf8');

      const rawAsar = createTestAsar({
        'package.json': Buffer.from(JSON.stringify({ version: '2.33.0' }), 'utf8'),
        'dist/utils.js': origUtils,
        'dist/main.js': origMain,
        'dist/preload.js': origPreload,
      });
      fs.writeFileSync(asarPath, rawAsar);
      assert.equal(isAsarPatchedFast(asarPath), false);

      const res = patchAsarOnDisk({
        asarPath,
        autoinjectPath,
        appStoragePath,
        appStorageLockPath: storageLockPath,
      });
      assert.equal(res.status, 'PATCHED');
      assert.equal(res.exactOffsetPreserved, true);
      assert.equal(isAsarPatchedFast(asarPath), true);

      // Re-reading patched ASAR and verifying serialization roundtrip
      const parsed = readAsarArchive(asarPath);
      const rt = serializeAsarBuffer(parsed.u0, parsed.header, parsed.fileMap);
      assert.equal(rt.length, rawAsar.length);

      const stored = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
      assert.equal(stored['agy-statusbar-code'], '/* statusbar bundle */ window.__testOk = 1;');
      assert.equal(stored.otherKey, 42);
      assert.equal(syncAppStorageCode({ autoinjectPath, appStoragePath, appStorageLockPath: storageLockPath }), false);

      // Atomic file lock stale recovery & token ownership
      const lockPath = path.join(tmpDir, 'patch.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 9999999, token: 'dead:1', startedAt: '2020-01-01T00:00:00Z' }), 'utf8');
      const oldDate = new Date(Date.now() - 120000);
      fs.utimesSync(lockPath, oldDate, oldDate);

      assert.equal(acquireFileLock(lockPath, 'me:token1', 1000), true);
      assert.equal(releaseFileLock(lockPath, 'wrong:token'), false);
      assert.equal(releaseFileLock(lockPath, 'me:token1'), true);

      // EBUSY simulation leaves existing ASAR untouched, then uninstallFromDisk restores clean .orig & cleans files
      const unpatchedRollbackDir = path.join(tmpDir, 'rollback-test');
      fs.mkdirSync(unpatchedRollbackDir, { recursive: true });
      const rbAsar = path.join(unpatchedRollbackDir, 'app.asar');
      fs.writeFileSync(rbAsar, rawAsar);
      const ebusyRes = patchAsarOnDisk({
        asarPath: rbAsar,
        autoinjectPath,
        appStoragePath,
        appStorageLockPath: storageLockPath,
        renameFn: () => {
          const e = new Error('EBUSY: resource busy');
          e.code = 'EBUSY';
          throw e;
        },
      });
      assert.equal(ebusyRes.status, 'FAILED_WRITE_BUSY');
      assert.equal(fs.readFileSync(rbAsar).equals(rawAsar), true, 'EBUSY must never corrupt original app.asar');

      const uninstRes = uninstallFromDisk({
        asarPath,
        autoinjectPath,
        appStoragePath,
        appStorageLockPath: storageLockPath,
      });
      assert.equal(uninstRes.asarRestored, true);
      assert.equal(isAsarPatchedFast(asarPath), false);
      assert.equal(fs.readFileSync(asarPath).equals(rawAsar), true);
      const afterUninstStorage = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
      assert.equal('agy-statusbar-code' in afterUninstStorage, false);
      assert.equal(afterUninstStorage.otherKey, 42);

      // Corrupted .orig backup must fail closed with FAILED_CORRUPTED_BACKUP without touching live app.asar
      const corruptDir = path.join(tmpDir, 'corrupt-backup-test');
      fs.mkdirSync(corruptDir, { recursive: true });
      const corruptAsar = path.join(corruptDir, 'app.asar');
      const legacyPatchedUtils = Buffer.from(
        origUtils.toString('utf8').replace('"use strict";', '"use strict"; /* AGY_STATUSBAR_AUTOINJECT_V4 */'),
        'utf8'
      );
      const legacyAsarBuf = createTestAsar({
        'package.json': Buffer.from(JSON.stringify({ version: '2.33.0' }), 'utf8'),
        'dist/utils.js': legacyPatchedUtils,
        'dist/main.js': origMain,
        'dist/preload.js': origPreload,
      });
      fs.writeFileSync(corruptAsar, legacyAsarBuf);
      fs.writeFileSync(`${corruptAsar}.v2.33.0.orig`, Buffer.from('corrupted-not-an-asar-header', 'utf8'));

      const corruptAutoinject = path.join(corruptDir, 'statusbar_autoinject.js');
      fs.writeFileSync(corruptAutoinject, '/* statusbar bundle */ window.__testOk = 1;', 'utf8');

      const corruptPatchRes = patchAsarOnDisk({
        asarPath: corruptAsar,
        autoinjectPath: corruptAutoinject,
        appStoragePath,
        appStorageLockPath: storageLockPath,
      });
      assert.equal(corruptPatchRes.status, 'FAILED_CORRUPTED_BACKUP');
      assert.equal(fs.readFileSync(corruptAsar).equals(legacyAsarBuf), true, 'Corrupted .orig must leave live app.asar untouched on patch');

      const corruptUninstRes = uninstallFromDisk({
        asarPath: corruptAsar,
        autoinjectPath: corruptAutoinject,
        appStoragePath,
        appStorageLockPath: storageLockPath,
      });
      assert.equal(corruptUninstRes.asarRestored, false);
      assert.equal(corruptUninstRes.asarStatus, 'FAILED_CORRUPTED_BACKUP');
      assert.equal(fs.readFileSync(corruptAsar).equals(legacyAsarBuf), true, 'Corrupted .orig must leave live app.asar untouched on uninstall');

      // NO_BACKUP_FOUND on patched app.asar must NOT delete autoinject payload or app_storage code (prevents broken startup!)
      const noBakDir = path.join(tmpDir, 'no-backup-test');
      fs.mkdirSync(noBakDir, { recursive: true });
      const noBakAsar = path.join(noBakDir, 'app.asar');
      const noBakAuto = path.join(noBakDir, 'statusbar_autoinject.js');
      const noBakStorage = path.join(noBakDir, 'app_storage.json');
      fs.writeFileSync(noBakAsar, fs.readFileSync(asarPath)); // copy patched ASAR? Wait: asarPath was restored above, so patch fresh first
      fs.writeFileSync(noBakAsar, rawAsar);
      fs.writeFileSync(noBakAuto, '/* keep-alive */', 'utf8');
      fs.writeFileSync(noBakStorage, JSON.stringify({ 'agy-statusbar-code': '/* keep-alive */' }), 'utf8');
      const noBakPatch = patchAsarOnDisk({
        asarPath: noBakAsar,
        autoinjectPath: noBakAuto,
        appStoragePath: noBakStorage,
        appStorageLockPath: path.join(noBakDir, 's.lock'),
      });
      assert.equal(noBakPatch.status, 'PATCHED');
      fs.unlinkSync(noBakPatch.backupPath); // simulate missing .orig backup
      const noBakUninst = uninstallFromDisk({
        asarPath: noBakAsar,
        autoinjectPath: noBakAuto,
        appStoragePath: noBakStorage,
        appStorageLockPath: path.join(noBakDir, 's.lock'),
      });
      assert.equal(noBakUninst.asarStatus, 'NO_BACKUP_FOUND');
      assert.equal(fs.existsSync(noBakAuto), true, 'Payload must NOT be deleted when patched ASAR cannot be restored');
      assert.equal(
        JSON.parse(fs.readFileSync(noBakStorage, 'utf8'))['agy-statusbar-code'],
        '/* keep-alive */',
        'app_storage code must NOT be deleted when patched ASAR cannot be restored'
      );

      // CLI --worker exit code must be non-zero (1) when ASAR patch fails
      const badCliDir = path.join(tmpDir, 'bad-cli-worker');
      fs.mkdirSync(badCliDir, { recursive: true });
      const badAsarDir = path.join(badCliDir, 'Programs', 'antigravity', 'resources');
      const badAgyDir = path.join(badCliDir, '.gemini', 'antigravity');
      fs.mkdirSync(badAsarDir, { recursive: true });
      fs.mkdirSync(badAgyDir, { recursive: true });
      fs.writeFileSync(
        path.join(badAsarDir, 'app.asar'),
        createTestAsar({ 'package.json': Buffer.from('{"version":"2.33.0"}', 'utf8') })
      );
      fs.writeFileSync(path.join(badAgyDir, 'statusbar_autoinject.js'), '/* payload */', 'utf8');
      const cliWorkerRes = spawnSync(
        process.execPath,
        [path.join(__dirname, '..', '..', 'scripts', 'ensure_statusbar_patch.js'), '--worker'],
        {
          env: {
            ...process.env,
            USERPROFILE: badCliDir,
            HOME: badCliDir,
            LOCALAPPDATA: badCliDir,
            APPDATA: badCliDir,
          },
          encoding: 'utf8',
          windowsHide: true,
        }
      );
      assert.equal(cliWorkerRes.status, 1, 'CLI --worker must exit 1 when patchAsarOnDisk fails');

      // Loopback enforcement & no global WebSocket bypass
      assert.throws(() => createRfc6455WebSocketClient('ws://evil.example:9222/devtools'), /non-loopback/);
      assert.throws(() => openCdpWebSocket('ws://192.168.1.50:9222/devtools'), /non-loopback/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('SB2-TC-010c (D-0015, D-0030): RFC6455 fragmentation/ping/close/interleaving checks & CDP page/browser evaluation error propagation', async () => {
    const sockets = new Set();
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });

    function parseClientTextFrames(buf) {
      const frames = [];
      let off = 0;
      while (off + 2 <= buf.length) {
        const opcode = buf[off] & 0x0f;
        const masked = (buf[off + 1] & 0x80) !== 0;
        let len = buf[off + 1] & 0x7f;
        let hdr = 2;
        if (len === 126) {
          if (off + 4 > buf.length) break;
          len = buf.readUInt16BE(off + 2);
          hdr = 4;
        } else if (len === 127) {
          if (off + 10 > buf.length) break;
          len = Number(buf.readBigUInt64BE(off + 2));
          hdr = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (off + hdr + maskLen + len > buf.length) break;
        const payload = Buffer.from(buf.subarray(off + hdr + maskLen, off + hdr + maskLen + len));
        if (masked) {
          const m = buf.subarray(off + hdr, off + hdr + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
        }
        frames.push({ opcode, payload });
        off += hdr + maskLen + len;
      }
      return { frames, rest: buf.subarray(off) };
    }

    server.on('upgrade', (req, socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      acceptWsUpgrade(req, socket);
      if (req.url === '/frag-ping') {
        let acc = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          acc = Buffer.concat([acc, chunk]);
          const parsed = parseClientTextFrames(acc);
          acc = parsed.rest;
          for (const f of parsed.frames) {
            if (f.opcode === 0x08) {
              socket.end();
              return;
            }
            if (f.opcode !== 0x01) continue;
            const msg = JSON.parse(f.payload.toString('utf8'));
            const jsonText = JSON.stringify({ id: msg.id, result: { result: { value: 'INJECTED_OK' } } });
            const mid = Math.floor(jsonText.length / 2);
            socket.write(makeServerFrame(0x01, Buffer.from(jsonText.slice(0, mid), 'utf8'), false));
            socket.write(makeServerFrame(0x09, Buffer.from('ping', 'utf8'), true));
            socket.write(makeServerFrame(0x00, Buffer.from(jsonText.slice(mid), 'utf8'), true));
          }
        });
      } else if (req.url === '/interleave-err') {
        socket.write(makeServerFrame(0x01, Buffer.from('{"partial":', 'utf8'), false));
        socket.write(makeServerFrame(0x02, Buffer.from('bad', 'utf8'), true));
        socket.end();
      } else if (req.url === '/browser-ws') {
        let acc = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          acc = Buffer.concat([acc, chunk]);
          const parsed = parseClientTextFrames(acc);
          acc = parsed.rest;
          for (const f of parsed.frames) {
            if (f.opcode === 0x08) {
              socket.end();
              return;
            }
            if (f.opcode !== 0x01) continue;
            const msg = JSON.parse(f.payload.toString('utf8'));
            if (msg.method === 'Target.getTargets') {
              socket.write(
                makeServerFrame(
                  0x01,
                  Buffer.from(JSON.stringify({ id: msg.id, result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'https://antigravity.google.com/r/1' }] } }), 'utf8'),
                  true
                )
              );
            } else if (msg.method === 'Target.attachToTarget') {
              socket.write(makeServerFrame(0x01, Buffer.from(JSON.stringify({ id: msg.id, result: { sessionId: 's1' } }), 'utf8'), true));
            } else if (msg.method === 'Runtime.evaluate') {
              socket.write(
                makeServerFrame(
                  0x01,
                  Buffer.from(JSON.stringify({ id: msg.id, result: { exceptionDetails: { text: 'BoomEvalError' } } }), 'utf8'),
                  true
                )
              );
            } else {
              socket.write(makeServerFrame(0x01, Buffer.from(JSON.stringify({ id: msg.id, result: {} }), 'utf8'), true));
            }
          }
        });
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const val = await configureTargetViaCdp(`ws://127.0.0.1:${port}/frag-ping`, 'function mountStatusBar(){}', 'abc123', 1500);
      assert.equal(val, 'INJECTED_OK');

      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            const ws = createRfc6455WebSocketClient(`ws://127.0.0.1:${port}/interleave-err`);
            ws.onerror = reject;
            ws.onmessage = resolve;
          }),
        /Interleaved WebSocket data frame/
      );

      const browserRes = await injectViaBrowserCdpWs(`ws://127.0.0.1:${port}/browser-ws`, 'console.log(1)', 'h1', 1500);
      assert.equal(browserRes.pageTargetCount, 1);
      assert.equal(browserRes.injectedCount, 0);
    } finally {
      for (const s of sockets) {
        try { s.destroy(); } catch {}
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
