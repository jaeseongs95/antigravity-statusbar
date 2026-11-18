'use strict';

/**
 * Host Bridge Coordinator Facade.
 *
 * Composes three strictly bounded subsystems:
 * - `protobuf-checkpoint-codec`: pure Protobuf / Connect-RPC wire transformation
 * - `remote-runtime`: WeakMap-isolated `RemoteControlComponent` runtime lease & companion manifest parser
 * - `desktop-react-bridge`: Electron workbench React Fiber / Redux / Lexical engine adapter
 */

const { resolveHostAdapterConfig } = require('./host-adapter-config');
const {
  UUID_RE,
  CONVO_RPC_RE,
  createTextCodec,
  buildSendMessageCheckpointSuffix: buildSuffixWithEncoder,
  extractCascadeIdFromBody: extractCidWithCodec,
  injectCheckpointPayload,
} = require('./protobuf-checkpoint-codec');
const {
  parseAutoinjectCompanionManifest,
  acquireRemoteRuntimeLease,
} = require('./remote-runtime');
const {
  COMPACT_ARGS,
  setBoundedMapRecord,
  registerCustomCwInPrototype,
  createDesktopReactBridge,
} = require('./desktop-react-bridge');

function createHostBridge({ window, document, localStorage, fetchFn, cwStore, hostConfig }) {
  const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, window);
  const codec = createTextCodec(window);
  const cleanupCallbacks = [];
  const pendingSniffTimers = new Set();

  let lastRcTrajectoryPollTs = 0;
  let rcTrajectoryPollInFlight = false;
  let lastDesktopTrajectorySyncTs = 0;
  let desktopTrajectorySyncInFlight = false;

  function getAccessibleRemoteIframeWin() {
    try {
      const iframe = document?.querySelector?.('ga-remote-control iframe');
      if (!iframe) return null;
      const cwin = iframe.contentWindow;
      if (!cwin) return null;
      void cwin.document;
      iframe.__agyCrossOriginInaccessible = false;
      return cwin;
    } catch {
      try {
        const iframe = document?.querySelector?.('ga-remote-control iframe');
        if (iframe) iframe.__agyCrossOriginInaccessible = true;
      } catch {}
      return null;
    }
  }

  function getAccessibleRemoteIframeDoc() {
    try {
      const iframe = document?.querySelector?.('ga-remote-control iframe');
      if (!iframe) return null;
      const cdoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (cdoc) iframe.__agyCrossOriginInaccessible = false;
      return cdoc || null;
    } catch {
      try {
        const iframe = document?.querySelector?.('ga-remote-control iframe');
        if (iframe) iframe.__agyCrossOriginInaccessible = true;
      } catch {}
      return null;
    }
  }

  function buildSendMessageCheckpointSuffix(maxTokenLimit, contextWindow) {
    return buildSuffixWithEncoder(maxTokenLimit, contextWindow, codec.encodeTextToBytes);
  }

  function extractCascadeIdFromBody(body, ignoreUuid) {
    return extractCidWithCodec(body, ignoreUuid, codec);
  }

  function resolveEffectiveCascadeId(body, rcInst) {
    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const fromBody = extractCascadeIdFromBody(body, ignoreUuid);
    if (fromBody) return fromBody;
    if (window?.__agySniffedCascadeId && window.__agySniffedCascadeId !== 'remote-session') {
      return window.__agySniffedCascadeId;
    }
    const activeView = document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
    const domCid = activeView?.getAttribute?.('data-cascade-id');
    if (domCid && domCid !== 'remote-session') return domCid;
    return null;
  }

  function injectCheckpointLimitIntoSendRequest(path, body, rcInst) {
    if (typeof path !== 'string' || !/\/SendUserCascadeMessage$/i.test(path) || !body || !cwStore) {
      return body;
    }
    try {
      const cid = resolveEffectiveCascadeId(body, rcInst);
      const cw = cwStore.getSavedContextWindow(cid);
      const limit = cwStore.getLimit(cw);
      if (!cw || !limit || limit <= 0) return body;
      return injectCheckpointPayload({
        path,
        body,
        contextWindow: cw,
        maxTokenLimit: limit,
        codec,
      });
    } catch {
      return body;
    }
  }

  function sniffCascadeIdFromRpc(path, body, rcInst) {
    if (typeof path !== 'string' || !CONVO_RPC_RE.test(path)) return;
    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const cid = extractCascadeIdFromBody(body, ignoreUuid);
    if (cid) {
      const changed = window.__agySniffedCascadeId !== cid;
      window.__agySniffedCascadeId = cid;
      window.__agySniffedCascadeTs = Date.now();
      if (/\/(SendUserCascadeMessage|StartCascade|StreamCascadeReactiveUpdates|StreamAgentStateUpdates)$/i.test(path)) {
        lastRcTrajectoryPollTs = 0;
        if (/\/(SendUserCascadeMessage|StartCascade)$/i.test(path)) {
          const prevSteps = window?.__agyRcStepCountByCascade?.[cid] || 0;
          setBoundedMapRecord(window, '__agyRcStepCountByCascade', cid, prevSteps + 1);
        }
        const t = setTimeout(() => {
          pendingSniffTimers.delete(t);
          lastRcTrajectoryPollTs = 0;
          if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(cid);
        }, 1200);
        pendingSniffTimers.add(t);
      }
      if (changed && typeof window.__agyOnCascadeSniffed === 'function') {
        window.__agyOnCascadeSniffed(cid);
      }
    }
  }

  if (window) {
    window.__agyInjectCheckpointLimit = injectCheckpointLimitIntoSendRequest;
    window.__agySniffCascadeFromRpc = sniffCascadeIdFromRpc;
  }

  const runtimeLease = acquireRemoteRuntimeLease({
    window,
    document,
    hostConfig: resolvedHostConfig,
    hooks: {
      onIframeMessage(ev, rcInst) {
        if (ev && ev.data && typeof ev.data.path === 'string') {
          const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
          const m = ev.data.path.match(UUID_RE);
          if (m && m[0] && m[0] !== ignoreUuid && window.__agySniffedCascadeId !== m[0]) {
            window.__agySniffedCascadeId = m[0];
            window.__agySniffedCascadeTs = Date.now();
            if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(m[0]);
          }
        }
      },
      transformRpcRequest(path, body, rcInst) {
        const sniffFn = window?.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
        const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
        sniffFn(path, body, rcInst);
        return injectFn(path, body, rcInst);
      },
      transformPortRequest(msg, rcInst) {
        const sniffFn = window?.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
        const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
        sniffFn(msg.path, msg.body, rcInst);
        if (/\/SendUserCascadeMessage$/i.test(msg.path) && msg.body) {
          return { ...msg, body: injectFn(msg.path, msg.body, rcInst) };
        }
        return msg;
      },
      onUrlChanged(nextPath, rcInst) {
        if (typeof nextPath === 'string' && nextPath) {
          const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
          const m = nextPath.match(UUID_RE);
          if (m && m[0] && m[0] !== ignoreUuid && window.__agySniffedCascadeId !== m[0]) {
            window.__agySniffedCascadeId = m[0];
            window.__agySniffedCascadeTs = Date.now();
            if (typeof window.__agyOnCascadeSniffed === 'function') window.__agyOnCascadeSniffed(m[0]);
          }
        }
      },
    },
  });
  cleanupCallbacks.push(() => runtimeLease.release());

  function ensureFetchHook(targetWin) {
    try {
      const w = targetWin || window;
      if (!w || typeof w.fetch !== 'function') return;
      w.__agyInjectCheckpointLimit = injectCheckpointLimitIntoSendRequest;
      w.__agySniffCascadeFromRpc = sniffCascadeIdFromRpc;
      if (w.fetch.__agyCwHookV2) return;
      const prevFetch = w.__agyOrigFetch || w.fetch;
      const isLegacyV1Hook = Boolean(prevFetch.__agyCwHooked && !prevFetch.__agyCwHookV2);
      if (!isLegacyV1Hook && !w.__agyOrigFetch) {
        w.__agyOrigFetch = prevFetch;
      }
      const wrappedFetch = function (input, init) {
        let nextInput = input;
        let nextInit = init;
        try {
          const url = typeof input === 'string'
            ? input
            : (input && typeof input.url === 'string'
              ? input.url
              : (input && typeof input.href === 'string' ? input.href : ''));
          const sniffFn = w.__agySniffCascadeFromRpc || sniffCascadeIdFromRpc;
          const injectFn = w.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
          if (url && CONVO_RPC_RE.test(url)) {
            if (nextInit && nextInit.body) {
              sniffFn(url, nextInit.body, null);
              if (/\/SendUserCascadeMessage$/i.test(url)) {
                nextInit = { ...nextInit, body: injectFn(url, nextInit.body, null) };
                if (isLegacyV1Hook && typeof URL === 'function') {
                  try {
                    nextInput = new URL(url, w.location?.href || 'http://127.0.0.1');
                  } catch {}
                }
              }
            } else if (input && typeof input === 'object' && typeof input.arrayBuffer === 'function' && typeof input.clone === 'function' && /\/SendUserCascadeMessage$/i.test(url)) {
              return input.clone().arrayBuffer().then((ab) => {
                const rawBytes = new Uint8Array(ab);
                sniffFn(url, rawBytes, null);
                const injectedBody = injectFn(url, rawBytes, null);
                const ReqCtor = w.Request || (typeof Request === 'function' ? Request : null);
                if (ReqCtor) {
                  return prevFetch.call(this, new ReqCtor(input, { body: injectedBody }), nextInit);
                }
                return prevFetch.call(this, nextInput, { ...(nextInit || {}), body: injectedBody });
              }).catch(() => prevFetch.call(this, nextInput, nextInit));
            }
          }
        } catch {}
        return prevFetch.call(this, nextInput, nextInit);
      };
      wrappedFetch.__agyCwHooked = true;
      wrappedFetch.__agyCwHookV2 = true;
      w.fetch = wrappedFetch;
      cleanupCallbacks.push(() => {
        try {
          if (w.fetch === wrappedFetch && w.__agyOrigFetch) {
            w.fetch = w.__agyOrigFetch;
          }
          delete w.__agyOrigFetch;
          delete w.__agyInjectCheckpointLimit;
          delete w.__agySniffCascadeFromRpc;
        } catch {}
      });
    } catch {}
  }

  function hookLsClient(lsClient) {
    if (!lsClient || typeof lsClient !== 'object') return lsClient;
    if (lsClient.__agyCwHookV2) return lsClient;
    try {
      lsClient.__agyCwHooked = true;
      lsClient.__agyCwHookV2 = true;
      let origSend = null;
      let wrappedSend = null;
      if (typeof lsClient.sendUserCascadeMessage === 'function') {
        origSend = lsClient.__agyOrigSendUserCascadeMessage || lsClient.sendUserCascadeMessage;
        lsClient.__agyOrigSendUserCascadeMessage = origSend;
        wrappedSend = function (req, ...rest) {
          const injectFn = window?.__agyInjectCheckpointLimit || injectCheckpointLimitIntoSendRequest;
          const nextReq = injectFn(resolvedHostConfig.buildRpcPath('SendUserCascadeMessage'), req, null);
          return origSend.call(this, nextReq, ...rest);
        };
        lsClient.sendUserCascadeMessage = wrappedSend;
      }
      cleanupCallbacks.push(() => {
        try {
          if (wrappedSend && lsClient.sendUserCascadeMessage === wrappedSend) {
            lsClient.sendUserCascadeMessage = origSend;
          }
          delete lsClient.__agyOrigSendUserCascadeMessage;
          delete lsClient.__agyCwHooked;
          delete lsClient.__agyCwHookV2;
        } catch {}
      });
    } catch {}
    return lsClient;
  }

  function getRemoteControlInstance(onCascadeChange) {
    if (typeof onCascadeChange === 'function' && window) {
      window.__agyOnCascadeSniffed = onCascadeChange;
    }
    return runtimeLease.resolveInstance();
  }

  function createRcServiceAdapter(rcInst) {
    async function callJson(rpcPath, reqObj) {
      if (!rcInst || typeof rcInst.proxyCommand !== 'function') return null;
      const payloadObj = /\/SendUserCascadeMessage$/i.test(rpcPath)
        ? injectCheckpointLimitIntoSendRequest(rpcPath, reqObj || {}, rcInst)
        : (reqObj || {});
      const bytes = codec.encodeTextToBytes(JSON.stringify(payloadObj));
      const res = await rcInst.proxyCommand(rpcPath, bytes);
      if (!res || !res.payload) return null;
      const text = codec.decodeBytesToText(res.payload);
      return text ? JSON.parse(text) : null;
    }
    return {
      isRemoteControlHost: true,
      rcInst,
      callJson,
      async retrieveUserQuotaSummary(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('RetrieveUserQuotaSummary'), req || {});
      },
      async getCascadeTrajectoryGeneratorMetadata(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('GetCascadeTrajectoryGeneratorMetadata'), req || {});
      },
      async getCascadeTrajectory(req) {
        const metaRes = await callJson(resolvedHostConfig.buildRpcPath('GetCascadeTrajectoryGeneratorMetadata'), {
          cascadeId: req?.cascadeId,
          generatorMetadataOffset: req?.generatorMetadataOffset || 0,
        });
        if (metaRes && Array.isArray(metaRes.generatorMetadata)) {
          return { trajectory: { generatorMetadata: metaRes.generatorMetadata } };
        }
        return await callJson(resolvedHostConfig.buildRpcPath('GetCascadeTrajectory'), req || {});
      },
      async getAllCascadeTrajectories() {
        return await callJson(resolvedHostConfig.buildRpcPath('GetAllCascadeTrajectories'), {});
      },
      async updateConversationAnnotations(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('UpdateConversationAnnotations'), req || {});
      },
      async sendUserCascadeMessage(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('SendUserCascadeMessage'), req || {});
      },
      async getCustomizationStates(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('GetCustomizationStates'), req || {});
      },
      async getAllSkills(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('GetAllSkills'), req || {});
      },
      async getAllPlugins(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('GetAllPlugins'), req || {});
      },
      async readFile(req) {
        return await callJson(resolvedHostConfig.buildRpcPath('ReadFile'), req || {});
      },
    };
  }

  let desktopBridge = null;

  function getRemoteRpcServiceForElement(el) {
    if (window?.__agyCapturedLsClient && (typeof window.__agyCapturedLsClient.retrieveUserQuotaSummary === 'function' || typeof window.__agyCapturedLsClient.getCascadeTrajectory === 'function')) {
      return hookLsClient(window.__agyCapturedLsClient);
    }
    const cwin = getAccessibleRemoteIframeWin();
    if (cwin?.__agyCapturedLsClient && (typeof cwin.__agyCapturedLsClient.retrieveUserQuotaSummary === 'function' || typeof cwin.__agyCapturedLsClient.getCascadeTrajectory === 'function')) {
      return hookLsClient(cwin.__agyCapturedLsClient);
    }
    const cdoc = getAccessibleRemoteIframeDoc();
    const effBox = desktopBridge ? desktopBridge.resolveEffectiveInputBox(desktopBridge.resolveEffectiveView(el)) : el;
    const candidates = [
      effBox,
      el,
      document?.querySelector?.('[data-testid="conversation-view"]'),
      cdoc?.querySelector?.('[data-testid="conversation-view"]'),
    ].filter(Boolean);
    for (const startEl of candidates) {
      const fk = Object.keys(startEl).find((k) => k.startsWith('__reactFiber$'));
      let curr = fk ? startEl[fk] : null;
      while (curr) {
        const val = curr.memoizedProps?.value;
        if (val && typeof val === 'object') {
          if (typeof val.retrieveUserQuotaSummary === 'function' || typeof val.getCascadeTrajectory === 'function' || typeof val.getAllCascadeTrajectories === 'function' || typeof val.updateConversationAnnotations === 'function' || typeof val.getCustomizationStates === 'function' || typeof val.readFile === 'function') {
            return hookLsClient(val);
          }
          const lsClient = val.core?.projectManagementService?.lsClient || val.projectManagementService?.lsClient || val.lsClient;
          if (lsClient && (typeof lsClient.retrieveUserQuotaSummary === 'function' || typeof lsClient.getCascadeTrajectory === 'function' || typeof lsClient.getAllCascadeTrajectories === 'function' || typeof lsClient.updateConversationAnnotations === 'function' || typeof lsClient.getCustomizationStates === 'function' || typeof lsClient.readFile === 'function')) {
            return hookLsClient(lsClient);
          }
        }
        curr = curr.return;
      }
    }
    const rcInst = getRemoteControlInstance();
    if (rcInst && typeof rcInst.proxyCommand === 'function') {
      return createRcServiceAdapter(rcInst);
    }
    try {
      const parentWin = window?.parent !== window ? window?.parent : null;
      const pRc = parentWin?.__agyRemoteControlInstance;
      if (pRc && !pRc.destroyed && typeof pRc.proxyCommand === 'function') {
        return createRcServiceAdapter(pRc);
      }
    } catch {}
    return null;
  }

  desktopBridge = createDesktopReactBridge({
    window,
    document,
    localStorage,
    cwStore,
    ensureFetchHook,
    getAccessibleRemoteIframeWin,
    getAccessibleRemoteIframeDoc,
    getRemoteRpcServiceForElement,
    cleanupCallbacks,
  });

  async function fetchHostInstalledPluginInfo(csrf, viewOrEl) {
    const svc = getRemoteRpcServiceForElement(viewOrEl);
    const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
    const canCallHttp = Boolean(effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function');

    async function callRpc(methodName, rpcPath, reqObj) {
      if (svc && typeof svc[methodName] === 'function') {
        try {
          let arg = reqObj || {};
          if (!svc.isRemoteControlHost) {
            if (methodName === 'getCustomizationStates') arg = [];
            else if (methodName === 'getAllSkills') arg = [];
            else if (methodName === 'readFile' && arg && typeof arg === 'object' && typeof arg.uri === 'string') arg = arg.uri;
          }
          const r = await svc[methodName](arg);
          if (r !== undefined && r !== null) return r;
        } catch {}
      }
      if (svc && typeof svc.callJson === 'function') {
        try {
          const r = await svc.callJson(rpcPath, reqObj || {});
          if (r) return r;
        } catch {}
      }
      if (canCallHttp) {
        try {
          const res = await fetchFn(rpcPath, {
            method: 'POST',
            headers: resolvedHostConfig.buildRpcHeaders(effCsrf),
            body: JSON.stringify(reqObj || {}),
          });
          if (res && res.ok !== false) return await res.json();
        } catch {}
      }
      return null;
    }

    const [statesRes, pluginsRes] = await Promise.all([
      callRpc('getCustomizationStates', resolvedHostConfig.buildRpcPath('GetCustomizationStates'), {}),
      callRpc('getAllPlugins', resolvedHostConfig.buildRpcPath('GetAllPlugins'), {}),
    ]);

    const candidatePaths = [];
    const pluginNames = new Set();
    const statesList = Array.isArray(statesRes) ? statesRes : (Array.isArray(statesRes?.states) ? statesRes.states : []);
    for (const s of statesList) {
      const p = s?.path || s?.uri || '';
      if (p) {
        candidatePaths.push(p);
        if (String(p).includes('ko-thought-translator')) pluginNames.add('ko-thought-translator');
        if (String(p).includes('antigravity-mcp-manager')) pluginNames.add('antigravity-mcp-manager');
        if (String(p).includes('antigravity-statusbar')) pluginNames.add('antigravity-statusbar');
      }
    }
    const pluginsList = Array.isArray(pluginsRes) ? pluginsRes : (Array.isArray(pluginsRes?.plugins) ? pluginsRes.plugins : []);
    for (const p of pluginsList) {
      if (p?.name) pluginNames.add(String(p.name));
      if (p?.path) candidatePaths.push(p.path);
    }
    if (!candidatePaths.length) {
      const skillsRes = await callRpc('getAllSkills', resolvedHostConfig.buildRpcPath('GetAllSkills'), {});
      const skillsList = Array.isArray(skillsRes) ? skillsRes : (Array.isArray(skillsRes?.skills) ? skillsRes.skills : []);
      for (const sk of skillsList) {
        const p = sk?.path || sk?.uri || '';
        if (p) {
          candidatePaths.push(p);
          if (String(p).includes('ko-thought-translator')) pluginNames.add('ko-thought-translator');
        }
      }
    }

    if (!candidatePaths.length) {
      const rcSelectedDir = svc?.rcInst?.localUserInfo?.selectedGeminiDir || window?.__agyRemoteControlInstance?.localUserInfo?.selectedGeminiDir || '';
      if (rcSelectedDir) candidatePaths.push(rcSelectedDir);
    }

    let geminiDir = null;
    for (const rawPath of candidatePaths) {
      let decoded = String(rawPath).trim();
      try {
        decoded = decodeURIComponent(decoded);
      } catch {}
      const isFileUri = /^file:\/\//i.test(decoded);
      let norm = decoded.replace(/^file:\/\//i, '').replace(/\\/g, '/');
      if (isFileUri && /^\/[A-Za-z]:\//.test(norm)) {
        norm = norm.slice(1);
      } else if (isFileUri && !norm.startsWith('/') && !/^[A-Za-z]:\//.test(norm)) {
        norm = '/' + norm;
      }
      const normWithSlash = norm.endsWith('/') ? norm : norm + '/';
      const idx = normWithSlash.indexOf('/.gemini/');
      if (idx !== -1) {
        geminiDir = normWithSlash.slice(0, idx + '/.gemini'.length);
        break;
      }
    }

    let hostBundleText = '';
    let readAttemptedAndFailed = false;
    if (geminiDir) {
      const fsPath = `${geminiDir}/antigravity/statusbar_autoinject.js`;
      const uriPrefix = geminiDir.startsWith('/') ? 'file://' : 'file:///';
      const uri = `${uriPrefix}${fsPath}`;
      const rf = await callRpc('readFile', resolvedHostConfig.buildRpcPath('ReadFile'), {
        uri,
        path: fsPath,
        filePath: fsPath,
        absolutePath: fsPath,
      });
      const rfRaw = rf?.content !== undefined ? rf.content : (rf?.contents !== undefined ? rf.contents : rf?.data);
      if (rf instanceof Uint8Array || ArrayBuffer.isView(rf) || rf instanceof ArrayBuffer) {
        hostBundleText = codec.decodeBytesToText(rf);
      } else if (typeof rf === 'string' && rf.length > 0) {
        hostBundleText = rf;
      } else if (typeof rf?.text === 'string' && rf.text.length > 0) {
        hostBundleText = rf.text;
      } else if (rfRaw instanceof Uint8Array || ArrayBuffer.isView(rfRaw) || rfRaw instanceof ArrayBuffer) {
        hostBundleText = codec.decodeBytesToText(rfRaw);
      } else if (typeof rfRaw === 'string' && rfRaw.length > 0) {
        hostBundleText = codec.decodeBase64ToUtf8(rfRaw);
      }
      if (!hostBundleText) {
        readAttemptedAndFailed = true;
      }
    }

    const manifest = parseAutoinjectCompanionManifest(hostBundleText, pluginNames);
    const resolved = Boolean(hostBundleText) || (!readAttemptedAndFailed && pluginNames.size > 0);

    return {
      resolved,
      geminiDir,
      hasStatusbar: manifest.hasStatusbar,
      hasMcpManager: manifest.hasMcpManager,
      hasKoTranslator: manifest.hasKoTranslator,
      mcpManagerCode: manifest.mcpManagerCode,
      koTranslatorCode: manifest.koTranslatorCode,
      hostBundleText,
    };
  }

  async function pushSessionCwToServer(cascadeId, csrf, viewOrEl) {
    if (!cwStore || typeof cwStore.encodeRemoteAnnotationProfile !== 'function') return false;
    let targetIds = [];
    if (cascadeId && cascadeId !== 'remote-session') {
      targetIds = [cascadeId];
    } else if (!cascadeId) {
      const activeView = viewOrEl || document?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
      const activeCid = activeView?.getAttribute?.('data-cascade-id') || window?.__agySniffedCascadeId;
      if (activeCid && activeCid !== 'remote-session') {
        targetIds = [activeCid];
      }
    }
    if (!targetIds.length) return false;

    for (const cid of targetIds) {
      const profileStr = cwStore.encodeRemoteAnnotationProfile(cid);
      if (!profileStr) continue;
      const reqPayload = {
        cascadeIds: [cid],
        annotations: { activeProfile: profileStr },
        mergeAnnotations: true,
      };
      const svc = getRemoteRpcServiceForElement(viewOrEl);
      if (svc && typeof svc.updateConversationAnnotations === 'function') {
        try {
          await svc.updateConversationAnnotations(reqPayload);
          continue;
        } catch {}
      }
      const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
      if (effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function') {
        try {
          await fetchFn(resolvedHostConfig.buildRpcPath('UpdateConversationAnnotations'), {
            method: 'POST',
            headers: resolvedHostConfig.buildRpcHeaders(effCsrf),
            body: JSON.stringify(reqPayload),
          });
        } catch {}
      }
    }
    return true;
  }

  function pullAndBackfillTrajectorySummaries(summaries, csrf, viewOrEl, onRemoteUpdated) {
    if (!summaries || typeof summaries !== 'object' || typeof cwStore?.syncFromRemoteAnnotations !== 'function') {
      return false;
    }
    const { changed, unsyncedLocalIds } = cwStore.syncFromRemoteAnnotations(summaries);
    if (Array.isArray(unsyncedLocalIds) && unsyncedLocalIds.length > 0) {
      for (const cid of unsyncedLocalIds) {
        pushSessionCwToServer(cid, csrf, viewOrEl).catch?.(() => {});
      }
    }
    if (changed && typeof onRemoteUpdated === 'function') {
      try { onRemoteUpdated(); } catch {}
    }
    return changed;
  }

  function syncDesktopAnnotations(csrf, viewOrEl, onRemoteUpdated, force = false) {
    const nativeView = document?.querySelector?.('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
    if (!nativeView && document?.querySelector?.('ga-remote-control')) return;
    const now = Date.now();
    if (desktopTrajectorySyncInFlight || (!force && now - lastDesktopTrajectorySyncTs < 4000)) return;
    const svc = getRemoteRpcServiceForElement(viewOrEl);
    const effCsrf = csrf || window?.__APP_CONFIG__?.csrfToken;
    const canCallSvc = svc && typeof svc.getAllCascadeTrajectories === 'function';
    const canCallHttp = effCsrf && !window?.__APP_CONFIG__?.isRemoteControl && typeof fetchFn === 'function';
    if (!canCallSvc && !canCallHttp) return;

    lastDesktopTrajectorySyncTs = now;
    desktopTrajectorySyncInFlight = true;
    const p = canCallSvc
      ? svc.getAllCascadeTrajectories({})
      : fetchFn(resolvedHostConfig.buildRpcPath('GetAllCascadeTrajectories'), {
          method: 'POST',
          headers: resolvedHostConfig.buildRpcHeaders(effCsrf),
          body: '{}',
        }).then((r) => (r && r.ok !== false ? r.json() : null));

    Promise.resolve(p)
      .then((all) => {
        const summaries = all?.trajectorySummaries;
        if (summaries) {
          pullAndBackfillTrajectorySummaries(summaries, effCsrf, viewOrEl, onRemoteUpdated);
        }
      })
      .catch(() => {})
      .finally(() => {
        desktopTrajectorySyncInFlight = false;
      });
  }

  function ensureRemoteHostView(onCascadeChange) {
    if (!document) return null;
    const nativeView = document.querySelector('[data-testid="conversation-view"]:not(.agy-rc-host-view)');
    if (nativeView) return null;
    const rcEl = document.querySelector('ga-remote-control');
    if (!rcEl) return null;

    const rcInst = getRemoteControlInstance(onCascadeChange);
    const appContainer = rcEl.querySelector('.app-container') || rcEl;
    let hostView = appContainer.querySelector('.agy-rc-host-view');
    if (!hostView) {
      hostView = document.createElement('div');
      hostView.className = 'agy-rc-host-view';
      hostView.setAttribute('data-testid', 'conversation-view');
      const hostBox = document.createElement('div');
      hostBox.className = 'agy-rc-host-box';
      hostBox.setAttribute('data-testid', 'agent-input-box');
      hostView.appendChild(hostBox);
      appContainer.appendChild(hostView);
    }

    const ignoreUuid = typeof rcInst?.selectedInstanceUuid === 'function' ? rcInst.selectedInstanceUuid() : '';
    const cdoc = getAccessibleRemoteIframeDoc();
    const innerView = cdoc?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]');
    const rawInnerCid = innerView?.getAttribute?.('data-cascade-id');
    const innerCid = (rawInnerCid && UUID_RE.test(rawInnerCid) && rawInnerCid !== ignoreUuid) ? rawInnerCid : '';

    const childPath = rcInst?.lastSyncedChildPath || window?.location?.search || '';
    const pathMatch = String(childPath).match(UUID_RE);
    const pathCid = (pathMatch && pathMatch[0] && pathMatch[0] !== ignoreUuid) ? pathMatch[0] : '';

    let activeCid = '';
    if (innerCid) {
      activeCid = innerCid;
      if (window.__agySniffedCascadeId !== innerCid) {
        window.__agySniffedCascadeId = innerCid;
        window.__agySniffedCascadeTs = Date.now();
      }
    } else if (pathCid && pathCid !== hostView.__agyLastChildPathCid) {
      hostView.__agyLastChildPathCid = pathCid;
      activeCid = pathCid;
      window.__agySniffedCascadeId = pathCid;
      window.__agySniffedCascadeTs = Date.now();
    } else {
      activeCid = window.__agySniffedCascadeId || pathCid || '';
    }

    const currentAttr = hostView.getAttribute('data-cascade-id');
    const nextAttr = activeCid || currentAttr || 'remote-session';
    if (currentAttr !== nextAttr) {
      if (currentAttr === 'remote-session' && nextAttr !== 'remote-session') {
        cwStore?.migrateSessionOverride?.('remote-session', nextAttr);
      }
      hostView.setAttribute('data-cascade-id', nextAttr);
    }

    const now = Date.now();
    if (rcInst && !rcTrajectoryPollInFlight && (now - lastRcTrajectoryPollTs >= 2500 || nextAttr === 'remote-session')) {
      lastRcTrajectoryPollTs = now;
      rcTrajectoryPollInFlight = true;
      createRcServiceAdapter(rcInst).getAllCascadeTrajectories().then((all) => {
        const summaries = all?.trajectorySummaries || {};
        const entries = Object.entries(summaries);
        if (!entries.length) return;
        const cwChanged = pullAndBackfillTrajectorySummaries(summaries, null, hostView);
        for (const [id, sum] of entries) {
          if (typeof sum?.stepCount === 'number') {
            setBoundedMapRecord(window, '__agyRcStepCountByCascade', id, sum.stepCount);
          }
        }
        entries.sort((a, b) => {
          const vA = Date.parse(a[1]?.annotations?.lastUserViewTime || 0) || 0;
          const vB = Date.parse(b[1]?.annotations?.lastUserViewTime || 0) || 0;
          if (vA !== vB) return vB - vA;
          const mA = Date.parse(a[1]?.lastModifiedTime || 0) || 0;
          const mB = Date.parse(b[1]?.lastModifiedTime || 0) || 0;
          return mB - mA;
        });
        const [latestId] = entries[0];
        if (latestId) {
          const prevId = hostView.getAttribute('data-cascade-id');
          const hasValidActive = Boolean(
            window.__agySniffedCascadeId &&
            window.__agySniffedCascadeId !== 'remote-session' &&
            summaries[window.__agySniffedCascadeId]
          );
          if (!hasValidActive && (!prevId || prevId === 'remote-session' || !summaries[prevId])) {
            window.__agySniffedCascadeId = latestId;
          }
          const resolvedId = window.__agySniffedCascadeId || (prevId && prevId !== 'remote-session' ? prevId : latestId);
          if (prevId === 'remote-session' && resolvedId && resolvedId !== 'remote-session') {
            cwStore?.migrateSessionOverride?.('remote-session', resolvedId);
          }
          const nextSteps = window.__agyRcStepCountByCascade[resolvedId] ?? -1;
          const prevObservedSteps = hostView.__agyObservedStepCount;
          hostView.__agyObservedStepCount = nextSteps;
          if (prevId !== resolvedId || prevObservedSteps !== nextSteps || cwChanged) {
            hostView.setAttribute('data-cascade-id', resolvedId);
            if (typeof onCascadeChange === 'function') onCascadeChange(resolvedId);
          }
        }
      }).catch(() => {}).finally(() => {
        rcTrajectoryPollInFlight = false;
      });
    }

    return hostView;
  }

  function getAgentStateProviderForInputBox(inputBox) {
    const cc = desktopBridge.getCascadeContextForElement(inputBox);
    if (cc?.state?.agentStateProvider) return cc.state.agentStateProvider;
    const cid = window?.__agySniffedCascadeId || document?.querySelector?.('.agy-rc-host-view')?.getAttribute?.('data-cascade-id');
    const steps = cid && window?.__agyRcStepCountByCascade ? window.__agyRcStepCountByCascade[cid] : undefined;
    const knownGenLen = cid && window?.__agyRcGenLenByCascade ? window.__agyRcGenLenByCascade[cid] : undefined;
    if ((typeof steps === 'number' && steps >= 0) || (typeof knownGenLen === 'number' && knownGenLen >= 0)) {
      return {
        getState: () => ({
          conversationId: cid,
          trajectorySlice: {
            totalGeneratorMetadataLength: -1,
            totalStepsLength: typeof steps === 'number' ? steps : -1,
          },
        }),
      };
    }
    return null;
  }

  return {
    ensureContextWindowSelectorFlag: desktopBridge.ensureContextWindowSelectorFlag,
    ensureCustomizationsStoreLoaded: desktopBridge.ensureCustomizationsStoreLoaded,
    ensureRemoteHostView,
    getRemoteControlInstance,
    getModelSelectorContextForView: desktopBridge.getModelSelectorContextForView,
    getCascadeContextForElement: desktopBridge.getCascadeContextForElement,
    getAgentStateProviderForInputBox,
    getRemoteRpcServiceForElement,
    getSelectedModelKey: desktopBridge.getSelectedModelKey,
    applyContextWindowToEngine: desktopBridge.applyContextWindowToEngine,
    runCompactForInputBox: desktopBridge.runCompactForInputBox,
    pushSessionCwToServer,
    pullAndBackfillTrajectorySummaries,
    syncDesktopAnnotations,
    fetchHostInstalledPluginInfo,
    injectCheckpointLimitIntoSendRequest,
    buildSendMessageCheckpointSuffix,
    dispose() {
      for (const t of pendingSniffTimers) {
        clearTimeout(t);
      }
      pendingSniffTimers.clear();
      while (cleanupCallbacks.length > 0) {
        const fn = cleanupCallbacks.pop();
        try { fn(); } catch {}
      }
      try {
        if (window) {
          delete window.__agyInjectCheckpointLimit;
          delete window.__agySniffCascadeFromRpc;
          delete window.__agyOnCascadeSniffed;
          delete window.__agyProbingRcInstance;
          delete window.__agyLastAppliedContextWindow;
          delete window.__agyLastAppliedContextWindowByCascade;
          delete window.__agySniffedCascadeId;
          delete window.__agySniffedCascadeTs;
          delete window.__agyRcStepCountByCascade;
          delete window.__agyRcGenLenByCascade;
          if (!window.agyMcpManager) {
            delete window.__agyCapturedLsClient;
          }
        }
        if (document) {
          delete document.__agyCachedCustomizationsStore;
          delete document.__agyLastCustomizationsDfsTs;
        }
      } catch {}
    },
  };
}

module.exports = {
  COMPACT_ARGS,
  registerCustomCwInPrototype,
  createHostBridge,
};
