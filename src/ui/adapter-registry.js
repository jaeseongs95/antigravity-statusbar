'use strict';

/**
 * Pure StatusBar Adapter Registry & DOM Slot Coordinator.
 * Uses WeakMap (zero DOM expandos) and pure dom-builder nodes (zero HTML strings).
 */

const { h, setText } = require('./dom-builder');

const nodeCleanupMap = new WeakMap();
const adapterCtxMap = new WeakMap();

function registerNodeCleanup(node, fn) {
  if (!node || typeof fn !== 'function') return;
  nodeCleanupMap.set(node, fn);
}

function runNodeCleanup(node) {
  if (!node) return;
  const fn = nodeCleanupMap.get(node);
  if (typeof fn === 'function') {
    nodeCleanupMap.delete(node);
    try {
      fn();
    } catch {}
  }
}

const VALID_ADAPTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_ADAPTER_TAGS = new Set(['span', 'div', 'button']);

function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('StatusBarAdapter must be an object');
  }
  const id = typeof adapter.id === 'string' ? adapter.id.trim() : '';
  if (!id || !VALID_ADAPTER_ID_RE.test(id)) {
    throw new TypeError('StatusBarAdapter requires a valid [A-Za-z0-9_-]{1,64} id');
  }
  const rawTag = adapter.tagName === undefined ? 'span' : String(adapter.tagName).trim().toLowerCase();
  if (!ALLOWED_ADAPTER_TAGS.has(rawTag)) {
    throw new TypeError(`StatusBarAdapter "${id}" has disallowed tagName "${rawTag}"`);
  }
  const slot = adapter.slot === 'left' ? 'left' : 'right';
  const order = typeof adapter.order === 'number' && !isNaN(adapter.order) ? adapter.order : 100;
  const hasRender = typeof adapter.render === 'function';
  const hasButton = typeof adapter.onClick === 'function' || adapter.label !== undefined;
  if (!hasRender && !hasButton) {
    throw new TypeError(`StatusBarAdapter "${id}" must provide either render(el, ctx) or label/onClick`);
  }
  return {
    ...adapter,
    id,
    tagName: rawTag,
    slot,
    order,
    builtin: Boolean(adapter.builtin),
  };
}

function createAdapterRegistry({ window, document, onUpdate }) {
  const adapterRegistry = new Map();
  if (window) {
    if (!window.__agyCustomStatusBarAdapters || !(window.__agyCustomStatusBarAdapters instanceof Map)) {
      window.__agyCustomStatusBarAdapters = new Map();
    }
  }
  const customStore = window?.__agyCustomStatusBarAdapters || new Map();

  function cleanupChildMenus(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const menus = container.querySelectorAll('.agy-ctx-menu');
    for (const m of menus) {
      runNodeCleanup(m);
      try {
        m.remove();
      } catch {}
    }
  }

  function removeAdapterDomElements(id) {
    if (!document || typeof document.querySelectorAll !== 'function') return;
    const bars = document.querySelectorAll('.agy-ctx-statusbar');
    for (const bar of bars) {
      const nodes = bar.querySelectorAll(`[data-agy-adapter-id="${id}"]`);
      for (const node of nodes) {
        cleanupChildMenus(node);
        runNodeCleanup(node);
        try {
          node.remove();
        } catch {}
      }
    }
  }

  function getSortedAdapters(slotName) {
    const list = [];
    for (const adapter of adapterRegistry.values()) {
      if (!slotName || adapter.slot === slotName) {
        list.push(adapter);
      }
    }
    list.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot === 'left' ? -1 : 1;
      return a.order - b.order || a.id.localeCompare(b.id);
    });
    return list;
  }

  function registerAdapter(rawAdapter) {
    const adapter = normalizeAdapter(rawAdapter);
    if (adapterRegistry.has(adapter.id)) {
      const prev = adapterRegistry.get(adapter.id);
      if (prev && typeof prev.unmount === 'function') {
        try {
          prev.unmount();
        } catch {}
      }
      removeAdapterDomElements(adapter.id);
    }
    adapterRegistry.set(adapter.id, adapter);
    if (!adapter.builtin) {
      customStore.set(adapter.id, adapter);
    }
    if (typeof onUpdate === 'function') onUpdate();
    return () => unregisterAdapter(adapter.id);
  }

  function unregisterAdapter(id) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key || !adapterRegistry.has(key)) return false;
    const adapter = adapterRegistry.get(key);
    adapterRegistry.delete(key);
    customStore.delete(key);
    if (adapter && typeof adapter.unmount === 'function') {
      try {
        adapter.unmount();
      } catch {}
    }
    removeAdapterDomElements(key);
    if (typeof onUpdate === 'function') onUpdate();
    return true;
  }

  function registerBuiltinAdapters(builtins) {
    for (const b of builtins) {
      const normalized = normalizeAdapter({ ...b, builtin: true });
      adapterRegistry.set(normalized.id, normalized);
    }
    for (const [, extAdapter] of customStore.entries()) {
      try {
        const normalized = normalizeAdapter(extAdapter);
        adapterRegistry.set(normalized.id, normalized);
      } catch {}
    }
  }

  function ensureBarStructure(barEl) {
    let leftEl = barEl.querySelector?.('.agy-ctx-left') || null;
    let rightEl = barEl.querySelector?.('.agy-ctx-right') || null;
    if (!leftEl || !rightEl) {
      cleanupChildMenus(barEl);
      leftEl = h(document, 'div', { className: 'agy-ctx-left' });
      rightEl = h(document, 'div', { className: 'agy-ctx-right' });
      if (typeof barEl.replaceChildren === 'function') {
        barEl.replaceChildren(leftEl, rightEl);
      } else {
        while (barEl.firstChild && typeof barEl.removeChild === 'function') {
          barEl.removeChild(barEl.firstChild);
        }
        barEl.appendChild(leftEl);
        barEl.appendChild(rightEl);
      }
    }
    return { leftEl, rightEl };
  }

  function renderSlotAdapters(slotEl, slotName, ctx) {
    if (!slotEl) return;
    const adapters = getSortedAdapters(slotName);
    const activeIds = new Set(adapters.map((a) => a.id));

    if (slotEl.querySelectorAll) {
      const existingNodes = slotEl.querySelectorAll('[data-agy-adapter-id]');
      for (const node of existingNodes) {
        const nodeId = node.getAttribute('data-agy-adapter-id');
        if (nodeId && !activeIds.has(nodeId)) {
          cleanupChildMenus(node);
          runNodeCleanup(node);
          try {
            node.remove();
          } catch {}
        }
      }
    }

    const orderedEls = [];
    for (const adapter of adapters) {
      let itemEl = slotEl.querySelector ? slotEl.querySelector(`[data-agy-adapter-id="${adapter.id}"]`) : null;
      if (typeof adapter.render === 'function') {
        if (!itemEl) {
          itemEl = h(document, adapter.tagName || 'span', {
            className: adapter.className || undefined,
            'data-agy-adapter-id': adapter.id,
          });
          slotEl.appendChild(itemEl);
        }
        adapter.render(itemEl, ctx);
      } else {
        if (!itemEl) {
          itemEl = h(document, 'button', {
            type: 'button',
            'data-agy-adapter-id': adapter.id,
            onclick(e) {
              e.preventDefault();
              e.stopPropagation();
              const latestCtx = adapterCtxMap.get(itemEl) || ctx;
              if (typeof adapter.onClick === 'function') {
                adapter.onClick(latestCtx, e);
              }
            },
          });
          slotEl.appendChild(itemEl);
        }
        adapterCtxMap.set(itemEl, ctx);
        const resolvedClass =
          typeof adapter.className === 'function' ? adapter.className(ctx) : adapter.className || 'agy-ctx-btn';
        const finalClass = resolvedClass.includes('agy-ctx-btn')
          ? resolvedClass
          : `agy-ctx-btn ${resolvedClass}`.trim();
        if (itemEl.className !== finalClass) {
          itemEl.className = finalClass;
        }
        const resolvedLabel = typeof adapter.label === 'function' ? adapter.label(ctx) : String(adapter.label ?? '');
        setText(itemEl, resolvedLabel);
        const resolvedTitle = typeof adapter.title === 'function' ? adapter.title(ctx) : String(adapter.title ?? '');
        if (resolvedTitle) {
          if (itemEl.getAttribute?.('title') !== resolvedTitle) {
            itemEl.setAttribute?.('title', resolvedTitle);
            itemEl.title = resolvedTitle;
          }
        } else if (itemEl.getAttribute?.('title') !== null || itemEl.title) {
          itemEl.removeAttribute?.('title');
          itemEl.title = '';
        }
      }
      if (itemEl) orderedEls.push(itemEl);
    }

    if (orderedEls.length > 1 && slotEl.children) {
      let outOfOrder = false;
      for (let i = 0; i < orderedEls.length; i++) {
        if (slotEl.children[i] !== orderedEls[i]) {
          outOfOrder = true;
          break;
        }
      }
      if (outOfOrder) {
        if (typeof slotEl.insertBefore === 'function') {
          let anchor = slotEl.firstChild || null;
          for (const el of orderedEls) {
            if (el !== anchor) {
              slotEl.insertBefore(el, anchor);
            } else {
              anchor = el.nextSibling || null;
            }
          }
        } else {
          for (const el of orderedEls) {
            slotEl.appendChild(el);
          }
        }
      }
    }
  }

  function getAdapters() {
    return getSortedAdapters().map((a) => ({
      id: a.id,
      slot: a.slot,
      order: a.order,
      builtin: Boolean(a.builtin),
    }));
  }

  function clearAllMenus(targetDoc = document) {
    cleanupChildMenus(targetDoc || document);
  }

  return {
    registerAdapter,
    unregisterAdapter,
    registerBuiltinAdapters,
    getAdapters,
    getSortedAdapters,
    ensureBarStructure,
    renderSlotAdapters,
    clearAllMenus,
    registerNodeCleanup,
    runNodeCleanup,
  };
}

module.exports = {
  normalizeAdapter,
  createAdapterRegistry,
  registerNodeCleanup,
  runNodeCleanup,
};
