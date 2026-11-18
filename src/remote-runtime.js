'use strict';

/**
 * Shared Remote Control Runtime Kernel (`window.__agyRemoteRuntime`, v1).
 *
 * Responsibilities:
 * 1. Isolated WeakMap-based `RemoteControlComponent.prototype` chaining with reference-counted
 *    lease teardown (zero shared `__agyOrig_*` clobbering across plugins).
 * 2. Preservation of active `onIframeLoad` suppression (`__agySuppressAutoIframeLoad` /
 *    `__agySuppressAutoIframeLoadCount > 0`) so `-v2` MessagePort handshakes never tear down prematurely.
 * 3. Angular 19 Ivy component discovery (`ng.getComponent`, `LView` BFS, `ɵgetLContext`, guarded fallback probe).
 * 4. Canonical `statusbar_autoinject.js` anchored companion block parser.
 */

const { resolveHostAdapterConfig } = require('./host-adapter-config');

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

function findAnchoredMarkerSpan(text, beginRe, endRe) {
  beginRe.lastIndex = 0;
  const bMatch = beginRe.exec(text);
  if (!bMatch) return { start: -1, end: -1 };
  const start = bMatch.index;
  endRe.lastIndex = bMatch.index + bMatch[0].length;
  const eMatch = endRe.exec(text);
  if (!eMatch) return { start, end: -1 };
  let end = eMatch.index + eMatch[0].length;
  while (true) {
    const afterEnd = text.slice(end);
    const nlMatch = /^(?:\r?\n)+/.exec(afterEnd);
    if (!nlMatch) break;
    const nextLineIdx = end + nlMatch[0].length;
    endRe.lastIndex = nextLineIdx;
    const nextEnd = endRe.exec(text);
    if (nextEnd && nextEnd.index === nextLineIdx) {
      end = nextEnd.index + nextEnd[0].length;
    } else {
      break;
    }
  }
  return { start, end };
}

function parseAutoinjectCompanionManifest(bundleText, discoveredPluginNames) {
  const text = typeof bundleText === 'string' ? bundleText : '';
  const pluginNames = discoveredPluginNames instanceof Set ? discoveredPluginNames : new Set(discoveredPluginNames || []);

  const mcpBeginStr = ['BEGIN_AGY_MCP', 'MANAGER'].join('_');
  const mcpEndStr = ['END_AGY_MCP', 'MANAGER'].join('_');
  const koBeginStr = ['BEGIN_AGY_KO', 'THOUGHT_LOCALIZER'].join('_');
  const koEndStr = ['END_AGY_KO', 'THOUGHT_LOCALIZER'].join('_');

  const mcpBeginRe = new RegExp(`^(?:\\/\\/ === ${mcpBeginStr}(?:_V\\d+)? ===|\\/\\* === ${mcpBeginStr}(?:_V\\d+)? === \\*\\/)[ \\t]*\\r?$`, 'gm');
  const mcpEndRe = new RegExp(`^(?:\\/\\/ === ${mcpEndStr}(?:_V\\d+)? ===|\\/\\* === ${mcpEndStr}(?:_V\\d+)? === \\*\\/)[ \\t]*\\r?$`, 'gm');
  const koBeginRe = new RegExp(`^(?:\\/\\/ === ${koBeginStr}(?:_V\\d+)? ===|\\/\\* === ${koBeginStr}(?:_V\\d+)? === \\*\\/)[ \\t]*\\r?$`, 'gm');
  const koEndRe = new RegExp(`^(?:\\/\\/ === ${koEndStr}(?:_V\\d+)? ===|\\/\\* === ${koEndStr}(?:_V\\d+)? === \\*\\/)[ \\t]*\\r?$`, 'gm');

  const mcpSpan = findAnchoredMarkerSpan(text, mcpBeginRe, mcpEndRe);
  const koSpan = findAnchoredMarkerSpan(text, koBeginRe, koEndRe);

  const mcpManagerCode = mcpSpan.start !== -1 && mcpSpan.end > mcpSpan.start ? text.slice(mcpSpan.start, mcpSpan.end).trim() : '';
  const koTranslatorCode = koSpan.start !== -1 && koSpan.end > koSpan.start ? text.slice(koSpan.start, koSpan.end).trim() : '';

  const firstMarkerIdx = [mcpSpan.start, koSpan.start].filter((i) => i !== -1).sort((a, b) => a - b)[0] ?? text.length;
  const baseSegment = text.slice(0, firstMarkerIdx).trim();

  const sbFuncRe = new RegExp(`^[ \\t]*function ${['mount', 'StatusBar'].join('')}\\s*\\(`, 'm');
  const mcpFuncRe = new RegExp(`^[ \\t]*function ${['mount', 'McpManager'].join('')}\\s*\\(`, 'm');

  const hasStatusbarMarker = sbFuncRe.test(baseSegment);
  const hasMcpMarker = Boolean(mcpManagerCode) || (!hasStatusbarMarker && mcpFuncRe.test(baseSegment));
  const hasKoMarker = Boolean(koTranslatorCode);

  return {
    hasStatusbar: hasStatusbarMarker || pluginNames.has('antigravity-statusbar'),
    hasMcpManager: hasMcpMarker || pluginNames.has('antigravity-mcp-manager'),
    hasKoTranslator: hasKoMarker || pluginNames.has('ko-thought-translator'),
    statusbarBlock: hasStatusbarMarker ? baseSegment : '',
    mcpManagerCode,
    koTranslatorCode,
  };
}

function acquireRemoteRuntimeLease({ window: win, document: doc, hostConfig, hooks = {} }) {
  const resolvedHostConfig = resolveHostAdapterConfig(hostConfig, win);
  const hookedPrototypes = new Map();
  let disposed = false;

  function tapPrototype(proto) {
    if (!proto || proto === Object.prototype || disposed) return;
    if (hookedPrototypes.has(proto)) return;

    let protoDisposed = false;
    const wrappedMethods = new Map();

    const wrapMethod = (mName, buildWrapper) => {
      if (typeof proto[mName] !== 'function') return;
      const prevFn = proto[mName];
      const wrappedFn = buildWrapper(prevFn, () => protoDisposed || disposed);
      proto[mName] = wrappedFn;
      wrappedMethods.set(mName, { prevFn, wrappedFn });
    };

    wrapMethod('handleIframeMessage', (prevFn, isOff) => function (ev) {
      if (isOff()) return prevFn.apply(this, arguments);
      if (win && this && !this.destroyed) win.__agyRemoteControlInstance = this;
      if (ev && ev.data === '__agy_probe__') return;
      if (typeof hooks.onIframeMessage === 'function') {
        try {
          hooks.onIframeMessage(ev, this);
        } catch {}
      }
      return prevFn.apply(this, arguments);
    });

    for (const mName of ['proxyCommand', 'streamProxyCommand']) {
      wrapMethod(mName, (prevFn, isOff) => function (path, body, ...rest) {
        if (isOff()) return prevFn.call(this, path, body, ...rest);
        if (win && this && !this.destroyed) win.__agyRemoteControlInstance = this;
        let nextBody = body;
        if (typeof hooks.transformRpcRequest === 'function') {
          try {
            nextBody = hooks.transformRpcRequest(path, body, this);
          } catch {
            nextBody = body;
          }
        }
        return prevFn.call(this, path, nextBody, ...rest);
      });
    }

    wrapMethod('handlePortRequest', (prevFn, isOff) => function (msg) {
      if (isOff()) return prevFn.call(this, msg);
      if (win && this && !this.destroyed) win.__agyRemoteControlInstance = this;
      let nextMsg = msg;
      if (msg && typeof msg.path === 'string' && typeof hooks.transformPortRequest === 'function') {
        try {
          nextMsg = hooks.transformPortRequest(msg, this) || msg;
        } catch {
          nextMsg = msg;
        }
      }
      return prevFn.call(this, nextMsg);
    });

    for (const mName of RC_TAP_METHODS) {
      if (mName === 'handleIframeMessage' || mName === 'proxyCommand' || mName === 'streamProxyCommand' || mName === 'handlePortRequest') {
        continue;
      }
      wrapMethod(mName, (prevFn, isOff) => function () {
        if (mName === 'onIframeLoad' && isAutoIframeLoadSuppressed(this)) {
          return Promise.resolve();
        }
        if (isOff()) return prevFn.apply(this, arguments);
        if (win && this && !this.destroyed) {
          win.__agyRemoteControlInstance = this;
        }
        if (
          win?.__agyProbingRcInstance &&
          (mName === 'handleUrlChanged' || mName === 'onIframeLoad' || mName === 'onWindowOnline' || mName === 'loadInstances')
        ) {
          return;
        }
        if (mName === 'handleUrlChanged' && typeof hooks.onUrlChanged === 'function') {
          try {
            hooks.onUrlChanged(arguments[0], this);
          } catch {}
        }
        return prevFn.apply(this, arguments);
      });
    }

    hookedPrototypes.set(proto, {
      release() {
        protoDisposed = true;
        for (const [mName, entry] of wrappedMethods.entries()) {
          if (proto[mName] === entry.wrappedFn) {
            proto[mName] = entry.prevFn;
          }
        }
        wrappedMethods.clear();
      },
    });
  }

  function resolveInstance() {
    if (!win || disposed) return null;
    if (win.__agyRemoteControlInstance && !win.__agyRemoteControlInstance.destroyed) {
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
            win.__agyRemoteControlInstance = comp;
            tapPrototype(Object.getPrototypeOf(comp));
            return comp;
          }
        } catch {}
      }
      const ctxKey = Object.keys(rcEl).find((k) => k.startsWith('__ngContext'));
      const found = searchAngularContextBfs(rcEl.__ngContext__ || (ctxKey ? rcEl[ctxKey] : null));
      if (found) {
        win.__agyRemoteControlInstance = found;
        tapPrototype(Object.getPrototypeOf(found));
        return found;
      }
    }

    if (gaRootEl) {
      const rootCtxKey = Object.keys(gaRootEl).find((k) => k.startsWith('__ngContext'));
      const foundFromRoot = searchAngularContextBfs(gaRootEl.__ngContext__ || (rootCtxKey ? gaRootEl[rootCtxKey] : null));
      if (foundFromRoot) {
        win.__agyRemoteControlInstance = foundFromRoot;
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
                win.__agyRemoteControlInstance = dbgComp;
                tapPrototype(Object.getPrototypeOf(dbgComp));
                return dbgComp;
              }
              const foundFromDbg = searchAngularContextBfs(dbgComp || dbgNode);
              if (foundFromDbg) {
                win.__agyRemoteControlInstance = foundFromDbg;
                tapPrototype(Object.getPrototypeOf(foundFromDbg));
                return foundFromDbg;
              }
            }
            if (typeof mod.getComponent === 'function') {
              const comp = mod.getComponent(targetEl);
              if (isRcComponentInstance(comp)) {
                win.__agyRemoteControlInstance = comp;
                tapPrototype(Object.getPrototypeOf(comp));
                return comp;
              }
            }
            const getLCtx = mod['\u0275getLContext'] || mod.getLContext;
            if (typeof getLCtx === 'function') {
              const lCtx = getLCtx(targetEl);
              const foundFromLCtx = extractRcFromAngularLContext(lCtx) || searchAngularContextBfs(lCtx?.lView || lCtx);
              if (foundFromLCtx) {
                win.__agyRemoteControlInstance = foundFromLCtx;
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

    win.__agyProbingRcInstance = true;
    try {
      const BaseEvt = win.Event || (typeof Event !== 'undefined' ? Event : null);
      if (!win.__agyRemoteControlInstance && BaseEvt && typeof effDoc?.dispatchEvent === 'function') {
        effDoc.dispatchEvent(new BaseEvt('visibilitychange'));
      }
      if (!win.__agyRemoteControlInstance && BaseEvt && typeof win.dispatchEvent === 'function') {
        win.dispatchEvent(new BaseEvt('online'));
      }
      if (!win.__agyRemoteControlInstance && typeof win.dispatchEvent === 'function') {
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
            if (win.__agyRemoteControlInstance) break;
            win.dispatchEvent(
              new Evt('message', {
                data: { type: 'URL_CHANGED', path: '' },
                origin: orig,
                source: iframeWin,
              })
            );
          }
          if (!win.__agyRemoteControlInstance) {
            win.dispatchEvent(new Evt('message', { data: '__agy_probe__' }));
          }
        }
      }
    } catch {} finally {
      win.__agyProbingRcInstance = false;
    }

    return win.__agyRemoteControlInstance && !win.__agyRemoteControlInstance.destroyed
      ? win.__agyRemoteControlInstance
      : null;
  }

  function release() {
    if (disposed) return;
    disposed = true;
    for (const [, rec] of hookedPrototypes.entries()) {
      try {
        rec.release();
      } catch {}
    }
    hookedPrototypes.clear();
    if (win) {
      try {
        delete win.__agyProbingRcInstance;
      } catch {}
    }
  }

  return {
    resolvedHostConfig,
    tapPrototype,
    resolveInstance,
    release,
  };
}

module.exports = {
  isAutoIframeLoadSuppressed,
  parseAutoinjectCompanionManifest,
  acquireRemoteRuntimeLease,
};
