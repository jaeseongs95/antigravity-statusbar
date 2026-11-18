'use strict';

/**
 * Antigravity Remote Control Port Driver (`<ga-remote-control>`).
 *
 * Strict isolation guarantees:
 * 1. WeakMap/closure-isolated `RemoteControlComponent.prototype` lease chaining (never writes `__agyOrig_*`).
 * 2. Honors active reference-counted iframe auto-load suppression (`__agySuppressAutoIframeLoad` /
 *    `__agySuppressAutoIframeLoadCount > 0`) so co-loaded plugins' `-v2` MessagePort handshakes never tear down.
 * 3. NEVER hijacks, rewrites, or promotes cross-origin child iframes (zero `about:blank` / `cd.open()` races).
 * 4. Tracks inaccessible cross-origin child iframes privately without setting DOM expandos.
 */

const { resolveHostAdapterConfig } = require('./host-config');

const RC_PROTO_CHAIN_SYMBOL = Symbol.for('agy.rc.proto.chain.v2');

const RC_TAP_METHODS = Object.freeze([
  'handleIframeMessage',
  'proxyCommand',
  'streamProxyCommand',
  'handlePortRequest',
  'handleUrlChanged',
  'managePolling',
  'shouldPoll',
  'loadInstances',
  'isDisconnected',
  'onIframeLoad',
  'onWindowOnline',
  'onWindowOffline',
  'isOffline',
  'isDirectIngressMode',
  'isTabHidden',
  'getSelectedInstance',
  'instanceInfos',
  'remoteConversationsInfos',
]);

function isAutoIframeLoadSuppressed(rcInst) {
  return Boolean(
    rcInst &&
      (rcInst.__agySuppressAutoIframeLoad ||
        (typeof rcInst.__agySuppressAutoIframeLoadCount === 'number' && rcInst.__agySuppressAutoIframeLoadCount > 0))
  );
}

function isRcComponentInstance(obj) {
  return Boolean(
    obj &&
      typeof obj === 'object' &&
      !obj.destroyed &&
      (typeof obj.proxyCommand === 'function' ||
        typeof obj.onIframeLoad === 'function' ||
        typeof obj.handleIframeMessage === 'function')
  );
}

function extractRcFromAngularLContext(lCtx) {
  if (!lCtx || typeof lCtx !== 'object') return null;
  if (isRcComponentInstance(lCtx)) return lCtx;
  if (isRcComponentInstance(lCtx.component)) return lCtx.component;
  const lView = lCtx.lView;
  if (Array.isArray(lView)) {
    try {
      const tView = lView[1];
      const nodeIndex = typeof lCtx.nodeIndex === 'number' ? lCtx.nodeIndex : -1;
      const tNode = nodeIndex >= 0 && Array.isArray(tView?.data) ? tView.data[nodeIndex] : null;
      if (
        tNode &&
        typeof tNode.directiveStart === 'number' &&
        typeof tNode.componentOffset === 'number' &&
        tNode.componentOffset > -1
      ) {
        const comp = lView[tNode.directiveStart + tNode.componentOffset];
        if (isRcComponentInstance(comp)) return comp;
      }
    } catch {}
    for (let i = 0; i < Math.min(lView.length, 300); i++) {
      if (isRcComponentInstance(lView[i])) return lView[i];
    }
  }
  return null;
}

function searchAngularContextBfs(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const direct = extractRcFromAngularLContext(ctx);
  if (direct) return direct;
  const visited = new Set();
  const queue = [ctx];
  let steps = 0;
  while (queue.length > 0 && steps < 400) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
    visited.add(cur);
    steps += 1;
    const extracted = extractRcFromAngularLContext(cur);
    if (extracted) return extracted;
    if (Array.isArray(cur)) {
      const scanLen = Math.min(cur.length, 300);
      for (let i = 0; i < scanLen; i++) {
        if (isRcComponentInstance(cur[i])) return cur[i];
      }
      for (let i = 0; i < scanLen; i++) {
        const item = cur[i];
        if (item && typeof item === 'object' && (Array.isArray(item) || isRcComponentInstance(item.component))) {
          queue.push(item);
        }
      }
    } else {
      for (const k of ['component', 'lView', 'data', 'context', '_lView']) {
        if (cur[k] && typeof cur[k] === 'object') queue.push(cur[k]);
      }
    }
  }
  return null;
}

function createRemotePortDriver({ window: win, document: doc, hostConfig, hooks = {} }) {
  const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, win);
  const hookedPrototypes = new Map();
  const inaccessibleIframes = typeof WeakSet === 'function' ? new WeakSet() : null;
  let discoveredRcInstance = null;
  let probingRcInstance = false;
  let disposed = false;

  function captureInstance(inst) {
    if (isRcComponentInstance(inst)) {
      discoveredRcInstance = inst;
      if (win && typeof win === 'object') {
        try {
          if (!win.__agyRemoteControlInstance || win.__agyRemoteControlInstance.destroyed) {
            win.__agyRemoteControlInstance = inst;
          }
        } catch {}
      }
    }
  }

  function isTrustedMessageEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const iframeWin = getAccessibleIframeWindowNoCache();
    if (iframeWin && ev.source === iframeWin) return true;
    const evOrigin = typeof ev.origin === 'string' ? ev.origin.trim() : '';
    if (!evOrigin) {
      // Allow same-window probe only when explicitly initiated internally
      return Boolean(probingRcInstance && ev.data === '__agy_probe__');
    }
    if (win?.location?.origin && evOrigin === win.location.origin) return true;
    for (const rawCdn of resolvedHostConfig.staticCdnOrigins || []) {
      try {
        if (evOrigin === new URL(rawCdn).origin) return true;
      } catch {}
    }
    try {
      const host = new URL(evOrigin).hostname;
      if (resolvedHostConfig.isRemoteHost(host)) return true;
    } catch {}
    return false;
  }

  function getAccessibleIframeWindowNoCache() {
    try {
      const iframe = doc?.querySelector?.('ga-remote-control iframe');
      return iframe?.contentWindow || null;
    } catch {
      return null;
    }
  }

  function tapPrototype(proto) {
    if (!proto || proto === Object.prototype || disposed) return;
    if (hookedPrototypes.has(proto)) return;

    let protoDisposed = false;
    const leaseTokens = [];

    let chainTable = proto[RC_PROTO_CHAIN_SYMBOL];
    if (!chainTable || typeof chainTable !== 'object') {
      chainTable = Object.create(null);
      try {
        Object.defineProperty(proto, RC_PROTO_CHAIN_SYMBOL, {
          value: chainTable,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      } catch {
        proto[RC_PROTO_CHAIN_SYMBOL] = chainTable;
      }
    }

    const wrapMethod = (mName, buildHandler) => {
      if (typeof proto[mName] !== 'function') return;
      let methodChain = chainTable[mName];
      if (!methodChain) {
        const baseFn = proto[mName];
        const nodes = [];
        const dispatcher = function (...args) {
          let idx = nodes.length - 1;
          const callNext = (...nextArgs) => {
            const callArgs = nextArgs.length > 0 ? nextArgs : args;
            while (idx >= 0) {
              const node = nodes[idx--];
              if (node && !node.disposed) {
                return node.handler.call(this, callNext, ...callArgs);
              }
            }
            return baseFn.apply(this, callArgs);
          };
          return callNext(...args);
        };
        methodChain = { baseFn, nodes, dispatcher };
        chainTable[mName] = methodChain;
        proto[mName] = dispatcher;
      } else if (proto[mName] !== methodChain.dispatcher) {
        // An external non-chain wrapper was installed outside us; capture it cleanly
        const extFn = proto[mName];
        methodChain.baseFn = extFn;
        proto[mName] = methodChain.dispatcher;
      }

      const node = {
        disposed: false,
        handler: buildHandler(() => protoDisposed || disposed || node.disposed),
      };
      methodChain.nodes.push(node);

      leaseTokens.push(() => {
        if (node.disposed) return;
        node.disposed = true;
        const pos = methodChain.nodes.indexOf(node);
        if (pos >= 0) methodChain.nodes.splice(pos, 1);
        if (methodChain.nodes.length === 0) {
          if (proto[mName] === methodChain.dispatcher) {
            proto[mName] = methodChain.baseFn;
          }
          delete chainTable[mName];
          if (Object.keys(chainTable).length === 0) {
            try {
              delete proto[RC_PROTO_CHAIN_SYMBOL];
            } catch {}
          }
        }
      });
    };

    wrapMethod('handleIframeMessage', (isOff) => function (next, ev) {
      if (isOff()) return next.call(this, ev);
      if (!isTrustedMessageEvent(ev)) {
        return next.call(this, ev);
      }
      captureInstance(this);
      if (ev && ev.data === '__agy_probe__') return;
      if (typeof hooks.onIframeMessage === 'function') {
        try {
          hooks.onIframeMessage(ev, this);
        } catch {}
      }
      return next.call(this, ev);
    });

    for (const mName of ['proxyCommand', 'streamProxyCommand']) {
      wrapMethod(mName, (isOff) => function (next, path, body, ...rest) {
        if (isOff()) return next.call(this, path, body, ...rest);
        captureInstance(this);
        let nextBody = body;
        if (typeof hooks.transformRpcRequest === 'function') {
          try {
            nextBody = hooks.transformRpcRequest(path, body, this);
          } catch {
            nextBody = body;
          }
        }
        return next.call(this, path, nextBody, ...rest);
      });
    }

    wrapMethod('handlePortRequest', (isOff) => function (next, msg) {
      if (isOff()) return next.call(this, msg);
      captureInstance(this);
      let nextMsg = msg;
      if (msg && typeof msg.path === 'string' && typeof hooks.transformPortRequest === 'function') {
        try {
          nextMsg = hooks.transformPortRequest(msg, this) || msg;
        } catch {
          nextMsg = msg;
        }
      }
      return next.call(this, nextMsg);
    });

    for (const mName of RC_TAP_METHODS) {
      if (
        mName === 'handleIframeMessage' ||
        mName === 'proxyCommand' ||
        mName === 'streamProxyCommand' ||
        mName === 'handlePortRequest'
      ) {
        continue;
      }
      wrapMethod(mName, (isOff) => function (next, ...args) {
        if (isOff()) return next.apply(this, args);
        if (mName === 'onIframeLoad' && isAutoIframeLoadSuppressed(this)) {
          return Promise.resolve();
        }
        captureInstance(this);
        if (
          probingRcInstance &&
          (mName === 'handleUrlChanged' || mName === 'onIframeLoad' || mName === 'onWindowOnline' || mName === 'loadInstances')
        ) {
          return;
        }
        if (mName === 'handleUrlChanged' && typeof hooks.onUrlChanged === 'function') {
          try {
            hooks.onUrlChanged(args[0], this);
          } catch {}
        }
        return next.apply(this, args);
      });
    }

    hookedPrototypes.set(proto, {
      release() {
        protoDisposed = true;
        for (let i = leaseTokens.length - 1; i >= 0; i--) {
          try {
            leaseTokens[i]();
          } catch {}
        }
        leaseTokens.length = 0;
      },
    });
  }

  function resolveInstance() {
    if (!win || disposed) return null;
    if (discoveredRcInstance && !discoveredRcInstance.destroyed) {
      tapPrototype(Object.getPrototypeOf(discoveredRcInstance));
      return discoveredRcInstance;
    }
    if (win.__agyRemoteControlInstance && !win.__agyRemoteControlInstance.destroyed) {
      captureInstance(win.__agyRemoteControlInstance);
      tapPrototype(Object.getPrototypeOf(win.__agyRemoteControlInstance));
      return win.__agyRemoteControlInstance;
    }

    const effDoc = doc || win.document;
    const rcEl = effDoc?.querySelector?.('ga-remote-control') || null;
    const gaRootEl = effDoc?.querySelector?.('ga-root') || null;

    if (rcEl) {
      const ngFn = win.ng && typeof win.ng.getComponent === 'function' ? win.ng.getComponent : null;
      if (ngFn) {
        try {
          const comp = ngFn(rcEl);
          if (isRcComponentInstance(comp)) {
            captureInstance(comp);
            tapPrototype(Object.getPrototypeOf(comp));
            return comp;
          }
        } catch {}
      }
      const ctxKey = Object.keys(rcEl).find((k) => k.startsWith('__ngContext'));
      const found = searchAngularContextBfs(rcEl.__ngContext__ || (ctxKey ? rcEl[ctxKey] : null));
      if (found) {
        captureInstance(found);
        tapPrototype(Object.getPrototypeOf(found));
        return found;
      }
    }

    if (gaRootEl) {
      const rootCtxKey = Object.keys(gaRootEl).find((k) => k.startsWith('__ngContext'));
      const foundFromRoot = searchAngularContextBfs(gaRootEl.__ngContext__ || (rootCtxKey ? gaRootEl[rootCtxKey] : null));
      if (foundFromRoot) {
        captureInstance(foundFromRoot);
        tapPrototype(Object.getPrototypeOf(foundFromRoot));
        return foundFromRoot;
      }
    }

    const nsRoot = win.default_GoogleAntigravity;
    if (nsRoot && typeof nsRoot === 'object') {
      const targetCandidates = [];
      if (rcEl) {
        targetCandidates.push(rcEl);
        if (rcEl.firstElementChild) targetCandidates.push(rcEl.firstElementChild);
        if (typeof rcEl.querySelector === 'function') {
          const innerContainer = rcEl.querySelector('.app-container, .iframe-panel, iframe');
          if (innerContainer && !targetCandidates.includes(innerContainer)) {
            targetCandidates.push(innerContainer);
          }
        }
      }
      if (gaRootEl) {
        targetCandidates.push(gaRootEl);
        if (gaRootEl.firstElementChild) targetCandidates.push(gaRootEl.firstElementChild);
      }

      for (const k of Object.keys(nsRoot)) {
        const mod = nsRoot[k];
        if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
        for (const targetEl of targetCandidates) {
          if (!targetEl) continue;
          try {
            if (typeof mod.getDebugNode === 'function') {
              const dbgNode = mod.getDebugNode(targetEl);
              const dbgComp = dbgNode?.componentInstance || dbgNode?.context;
              if (isRcComponentInstance(dbgComp)) {
                captureInstance(dbgComp);
                tapPrototype(Object.getPrototypeOf(dbgComp));
                return dbgComp;
              }
              const foundFromDbg = searchAngularContextBfs(dbgComp || dbgNode);
              if (foundFromDbg) {
                captureInstance(foundFromDbg);
                tapPrototype(Object.getPrototypeOf(foundFromDbg));
                return foundFromDbg;
              }
            }
            if (typeof mod.getComponent === 'function') {
              const comp = mod.getComponent(targetEl);
              if (isRcComponentInstance(comp)) {
                captureInstance(comp);
                tapPrototype(Object.getPrototypeOf(comp));
                return comp;
              }
            }
            const getLCtx = mod['\u0275getLContext'] || mod.getLContext;
            if (typeof getLCtx === 'function') {
              const lCtx = getLCtx(targetEl);
              const foundFromLCtx = extractRcFromAngularLContext(lCtx) || searchAngularContextBfs(lCtx?.lView || lCtx);
              if (foundFromLCtx) {
                captureInstance(foundFromLCtx);
                tapPrototype(Object.getPrototypeOf(foundFromLCtx));
                return foundFromLCtx;
              }
            }
          } catch {}
        }
        const RC = mod.RemoteControlComponent || (typeof mod.prototype?.proxyCommand === 'function' ? mod : null);
        if (RC && RC.prototype && typeof RC.prototype.proxyCommand === 'function') {
          tapPrototype(RC.prototype);
        }
      }
    }

    probingRcInstance = true;
    try {
      const BaseEvt = win.Event || (typeof Event !== 'undefined' ? Event : null);
      if (!discoveredRcInstance && BaseEvt && typeof effDoc?.dispatchEvent === 'function') {
        effDoc.dispatchEvent(new BaseEvt('visibilitychange'));
      }
      if (!discoveredRcInstance && BaseEvt && typeof win.dispatchEvent === 'function') {
        win.dispatchEvent(new BaseEvt('online'));
      }
      if (!discoveredRcInstance && typeof win.dispatchEvent === 'function') {
        const Evt = win.MessageEvent || (typeof MessageEvent !== 'undefined' ? MessageEvent : null);
        if (Evt) {
          const iframeEl = rcEl?.querySelector?.('iframe') || effDoc?.querySelector?.('ga-remote-control iframe') || null;
          let iframeWin = null;
          try {
            iframeWin = iframeEl?.contentWindow || null;
          } catch {}
          const rawIframeSrc = iframeEl?.getAttribute?.('src') || iframeEl?.src || '';
          const candidateOrigins = [];
          const defaultRemoteOrigin = `https://${resolvedHostConfig.remoteHostDomains[0] || 'antigravity.google.com'}`;
          try {
            if (rawIframeSrc) {
              candidateOrigins.push(new URL(rawIframeSrc, win.location?.href || defaultRemoteOrigin).origin);
            }
          } catch {}
          if (win.location?.origin && !candidateOrigins.includes(win.location.origin)) {
            candidateOrigins.push(win.location.origin);
          }
          for (const cdnOrig of resolvedHostConfig.staticCdnOrigins) {
            if (cdnOrig && !candidateOrigins.includes(cdnOrig)) {
              candidateOrigins.push(cdnOrig);
            }
          }
          for (const orig of candidateOrigins) {
            if (discoveredRcInstance) break;
            win.dispatchEvent(
              new Evt('message', {
                data: { type: 'URL_CHANGED', path: '' },
                origin: orig,
                source: iframeWin,
              })
            );
          }
          if (!discoveredRcInstance) {
            win.dispatchEvent(new Evt('message', { data: '__agy_probe__' }));
          }
        }
      }
    } catch {} finally {
      probingRcInstance = false;
    }

    const active = discoveredRcInstance || win.__agyRemoteControlInstance;
    return active && !active.destroyed ? active : null;
  }

  function getAccessibleIframeWindow() {
    try {
      const iframe = doc?.querySelector?.('ga-remote-control iframe');
      if (!iframe) return null;
      if (inaccessibleIframes && inaccessibleIframes.has(iframe)) {
        // Re-check origin in case another plugin promoted it to same-origin later
        try {
          if (iframe.contentDocument) {
            inaccessibleIframes.delete(iframe);
          } else {
            return null;
          }
        } catch {
          return null;
        }
      }
      const cwin = iframe.contentWindow;
      if (!cwin) return null;
      void cwin.document;
      return cwin;
    } catch {
      try {
        const iframe = doc?.querySelector?.('ga-remote-control iframe');
        if (iframe && inaccessibleIframes) inaccessibleIframes.add(iframe);
      } catch {}
      return null;
    }
  }

  function getAccessibleIframeDocument() {
    try {
      const iframe = doc?.querySelector?.('ga-remote-control iframe');
      if (!iframe) return null;
      const cdoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (cdoc && inaccessibleIframes) inaccessibleIframes.delete(iframe);
      return cdoc || null;
    } catch {
      try {
        const iframe = doc?.querySelector?.('ga-remote-control iframe');
        if (iframe && inaccessibleIframes) inaccessibleIframes.add(iframe);
      } catch {}
      return null;
    }
  }

  function createRcServiceAdapter(rcInst, codec, injectCheckpointLimitFn) {
    async function callJson(rpcPath, reqObj) {
      if (!rcInst || typeof rcInst.proxyCommand !== 'function') return null;
      const payloadObj =
        /\/SendUserCascadeMessage$/i.test(rpcPath) && typeof injectCheckpointLimitFn === 'function'
          ? injectCheckpointLimitFn(rpcPath, reqObj || {}, rcInst)
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
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [, rec] of hookedPrototypes.entries()) {
      try {
        rec.release();
      } catch {}
    }
    hookedPrototypes.clear();
    discoveredRcInstance = null;
    probingRcInstance = false;
  }

  return {
    resolvedHostConfig,
    tapPrototype,
    resolveInstance,
    getAccessibleIframeWindow,
    getAccessibleIframeDocument,
    createRcServiceAdapter,
    dispose,
  };
}

function createDocumentHostDriver({ document: defaultDoc, remotePortDriver }) {
  const SAFE_CW_CSS_RE = /^\d+(?:\.\d+)?[KkMm]$/;
  return {
    getAccessibleDocs(rootDoc = defaultDoc) {
      const docs = [];
      if (!rootDoc) return docs;
      docs.push(rootDoc);
      const iframeDoc = remotePortDriver?.getAccessibleIframeDocument?.();
      if (iframeDoc && iframeDoc !== rootDoc) {
        docs.push(iframeDoc);
      }
      return docs;
    },
    getIframeDocument() {
      return remotePortDriver?.getAccessibleIframeDocument?.() || null;
    },
    buildWarningSuppressionCss(underDefaultCwSet) {
      const selectors = ['[data-testid="model-selector-trigger"][data-agy-cw-warn="0"] div:has(> .text-warning)'];
      if (underDefaultCwSet) {
        for (const cw of underDefaultCwSet) {
          const clean = String(cw || '').trim();
          if (SAFE_CW_CSS_RE.test(clean)) {
            selectors.push(`[data-testid="model-selector-trigger"][data-context-window="${clean}"] div:has(> .text-warning)`);
          }
        }
      }
      return `\n    ${selectors.join(',\n    ')} {\n      display: none !important;\n    }\n`;
    },
    findFallbackSessionTarget(rootDoc = defaultDoc) {
      const view = rootDoc?.querySelector?.('[data-testid="conversation-view"][data-cascade-id]') || null;
      const inputBox = view?.querySelector?.('[data-testid="agent-input-box"]') || null;
      return { view, inputBox };
    },
  };
}

module.exports = {
  RC_PROTO_CHAIN_SYMBOL,
  RC_TAP_METHODS,
  isAutoIframeLoadSuppressed,
  createRemotePortDriver,
  createDocumentHostDriver,
};
