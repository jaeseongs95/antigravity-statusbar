'use strict';

function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('StatusBarAdapter must be an object');
  }
  const id = typeof adapter.id === 'string' ? adapter.id.trim() : '';
  if (!id) {
    throw new TypeError('StatusBarAdapter requires a non-empty string id');
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
    slot,
    order,
    builtin: Boolean(adapter.builtin),
  };
}

function createAdapterRegistry({ window, document, setHtml, onUpdate }) {
  const adapterRegistry = new Map();
  if (window) {
    if (!window.__agyCustomStatusBarAdapters || !(window.__agyCustomStatusBarAdapters instanceof Map)) {
      window.__agyCustomStatusBarAdapters = new Map();
    }
  }
  const customStore = window?.__agyCustomStatusBarAdapters || new Map();

  function removeAdapterDomElements(id) {
    if (!document || typeof document.querySelectorAll !== 'function') return;
    const bars = document.querySelectorAll('.agy-ctx-statusbar');
    for (const bar of bars) {
      const nodes = bar.querySelectorAll(`[data-agy-adapter-id="${id}"]`);
      for (const node of nodes) {
        try { node.remove(); } catch {}
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
      return (a.order - b.order) || a.id.localeCompare(b.id);
    });
    return list;
  }

  function registerStatusBarAdapter(rawAdapter) {
    const adapter = normalizeAdapter(rawAdapter);
    if (adapterRegistry.has(adapter.id)) {
      const prev = adapterRegistry.get(adapter.id);
      if (prev && typeof prev.unmount === 'function') {
        try { prev.unmount(); } catch {}
      }
      removeAdapterDomElements(adapter.id);
    }
    adapterRegistry.set(adapter.id, adapter);
    if (!adapter.builtin) {
      customStore.set(adapter.id, adapter);
    }
    if (typeof onUpdate === 'function') onUpdate();
    return () => unregisterStatusBarAdapter(adapter.id);
  }

  function unregisterStatusBarAdapter(id) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key || !adapterRegistry.has(key)) return false;
    const adapter = adapterRegistry.get(key);
    adapterRegistry.delete(key);
    customStore.delete(key);
    if (adapter && typeof adapter.unmount === 'function') {
      try { adapter.unmount(); } catch {}
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
    let leftEl = barEl.querySelector('.agy-ctx-left');
    let rightEl = barEl.querySelector('.agy-ctx-right');
    if (!leftEl || !rightEl) {
      setHtml(barEl, `
        <div class="agy-ctx-left"></div>
        <div class="agy-ctx-right"></div>
      `);
      leftEl = barEl.querySelector('.agy-ctx-left');
      rightEl = barEl.querySelector('.agy-ctx-right');
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
          try { node.remove(); } catch {}
        }
      }
    }

    for (const adapter of adapters) {
      let itemEl = slotEl.querySelector ? slotEl.querySelector(`[data-agy-adapter-id="${adapter.id}"]`) : null;
      if (typeof adapter.render === 'function') {
        if (!itemEl) {
          itemEl = document.createElement(adapter.tagName || 'span');
          itemEl.setAttribute('data-agy-adapter-id', adapter.id);
          if (adapter.className) itemEl.className = adapter.className;
          slotEl.appendChild(itemEl);
        }
        adapter.render(itemEl, ctx);
      } else {
        if (!itemEl) {
          itemEl = document.createElement('button');
          itemEl.type = 'button';
          itemEl.setAttribute('data-agy-adapter-id', adapter.id);
          itemEl.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const latestCtx = itemEl.__agyAdapterCtx || ctx;
            if (typeof adapter.onClick === 'function') {
              adapter.onClick(latestCtx, e);
            }
          };
          slotEl.appendChild(itemEl);
        }
        itemEl.__agyAdapterCtx = ctx;
        const resolvedClass = typeof adapter.className === 'function'
          ? adapter.className(ctx)
          : (adapter.className || 'agy-ctx-btn');
        const finalClass = resolvedClass.includes('agy-ctx-btn') ? resolvedClass : `agy-ctx-btn ${resolvedClass}`.trim();
        if (itemEl.className !== finalClass) {
          itemEl.className = finalClass;
        }
        const resolvedLabel = typeof adapter.label === 'function' ? adapter.label(ctx) : String(adapter.label ?? '');
        if (itemEl.textContent !== resolvedLabel) {
          itemEl.textContent = resolvedLabel;
        }
        const resolvedTitle = typeof adapter.title === 'function' ? adapter.title(ctx) : String(adapter.title ?? '');
        if (resolvedTitle && itemEl.getAttribute('title') !== resolvedTitle) {
          itemEl.setAttribute('title', resolvedTitle);
          itemEl.title = resolvedTitle;
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

  return {
    registerAdapter: registerStatusBarAdapter,
    unregisterAdapter: unregisterStatusBarAdapter,
    registerBuiltinAdapters,
    getAdapters,
    getSortedAdapters,
    ensureBarStructure,
    renderSlotAdapters,
  };
}

module.exports = {
  normalizeAdapter,
  createAdapterRegistry,
};
