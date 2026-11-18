'use strict';

/**
 * Deterministic Resource & Timer Lifecycle Scope.
 * Always binds native timer functions to `win` to avoid `Illegal invocation` on headless/DOM windows.
 */

function createDisposableScope(win) {
  let disposed = false;
  const cleanups = [];
  const intervals = new Set();
  const timeouts = new Set();

  const bindTimer = (name, fallback) => {
    try {
      if (win && typeof win[name] === 'function') {
        return win[name].bind(win);
      }
    } catch {}
    return fallback;
  };

  const nativeSetTimeout = bindTimer('setTimeout', typeof setTimeout === 'function' ? setTimeout : null);
  const nativeClearTimeout = bindTimer('clearTimeout', typeof clearTimeout === 'function' ? clearTimeout : null);
  const nativeSetInterval = bindTimer('setInterval', typeof setInterval === 'function' ? setInterval : null);
  const nativeClearInterval = bindTimer('clearInterval', typeof clearInterval === 'function' ? clearInterval : null);

  function add(fn) {
    if (typeof fn !== 'function') return () => {};
    if (disposed) {
      try {
        fn();
      } catch {}
      return () => {};
    }
    cleanups.push(fn);
    return () => {
      const idx = cleanups.indexOf(fn);
      if (idx >= 0) cleanups.splice(idx, 1);
    };
  }

  function trackTimeout(fn, ms) {
    if (disposed || !nativeSetTimeout) return null;
    let id = null;
    id = nativeSetTimeout(() => {
      if (id !== null) timeouts.delete(id);
      if (!disposed && typeof fn === 'function') fn();
    }, ms);
    timeouts.add(id);
    return id;
  }

  function clearTrackedTimeout(id) {
    if (id === null || id === undefined) return;
    timeouts.delete(id);
    try {
      nativeClearTimeout?.(id);
    } catch {}
  }

  function trackInterval(fn, ms) {
    if (disposed || !nativeSetInterval) return null;
    const id = nativeSetInterval(() => {
      if (!disposed && typeof fn === 'function') fn();
    }, ms);
    intervals.add(id);
    return id;
  }

  function clearTrackedInterval(id) {
    if (id === null || id === undefined) return;
    intervals.delete(id);
    try {
      nativeClearInterval?.(id);
    } catch {}
  }

  function listen(target, eventName, handler, options) {
    if (disposed || !target || typeof target.addEventListener !== 'function' || typeof handler !== 'function') {
      return () => {};
    }
    target.addEventListener(eventName, handler, options);
    return add(() => {
      try {
        target.removeEventListener?.(eventName, handler, options);
      } catch {}
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;

    for (const id of timeouts) {
      try {
        nativeClearTimeout?.(id);
      } catch {}
    }
    timeouts.clear();

    for (const id of intervals) {
      try {
        nativeClearInterval?.(id);
      } catch {}
    }
    intervals.clear();

    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        cleanups[i]();
      } catch {}
    }
    cleanups.length = 0;
  }

  return {
    isDisposed: () => disposed,
    add,
    setTimeout: trackTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: trackInterval,
    clearInterval: clearTrackedInterval,
    listen,
    dispose,
  };
}

module.exports = {
  createDisposableScope,
};
