'use strict';

/**
 * Pure DOM Element Builder — zero HTML strings, zero HTML property writes, zero TrustedHTML sinks.
 * Compatible with browser DOM and lightweight Node unit-test DOM stubs.
 */

function applyStyleProps(el, styleObj) {
  if (!el || !el.style || !styleObj || typeof styleObj !== 'object') return;
  for (const [prop, val] of Object.entries(styleObj)) {
    if (val === undefined || val === null) continue;
    try {
      el.style[prop] = String(val);
    } catch {}
  }
}

function appendChildValue(doc, parent, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const nested of child) {
      appendChildValue(doc, parent, nested);
    }
    return;
  }
  if (typeof child === 'object' && typeof child.nodeType === 'number') {
    parent.appendChild(child);
    return;
  }
  if (typeof child === 'object' && typeof parent.appendChild === 'function' && child.tagName) {
    parent.appendChild(child);
    return;
  }
  const textStr = String(child);
  if (typeof doc.createTextNode === 'function') {
    parent.appendChild(doc.createTextNode(textStr));
  } else {
    const span = doc.createElement('span');
    span.textContent = textStr;
    parent.appendChild(span);
  }
}

const DANGEROUS_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'svg',
  'math',
]);

function isSafeAttribute(attrKey, attrVal) {
  const k = String(attrKey || '').trim().toLowerCase();
  if (!k || k.startsWith('on') || k === 'srcdoc' || k === 'formaction') return false;
  if (k === 'href' || k === 'src' || k === 'xlink:href' || k === 'action') {
    const normalized = String(attrVal ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
    if (/^(?:javascript|vbscript|data:text\/html)/i.test(normalized)) {
      return false;
    }
  }
  return true;
}

function h(doc, tag, props = null, ...children) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('h() requires a Document with createElement()');
  }
  const cleanTag = String(tag || '').trim().toLowerCase();
  if (!cleanTag || DANGEROUS_TAGS.has(cleanTag)) {
    throw new TypeError(`Disallowed UI element tag "${String(tag)}"`);
  }
  const el = doc.createElement(cleanTag);
  if (props && typeof props === 'object') {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null) continue;
      if (key === 'className') {
        el.className = String(val);
      } else if (key === 'textContent') {
        el.textContent = String(val);
      } else if (key === 'style') {
        if (typeof val === 'object') {
          applyStyleProps(el, val);
        }
      } else if (key === 'attrs' && typeof val === 'object') {
        for (const [attrKey, attrVal] of Object.entries(val)) {
          if (attrVal === undefined || attrVal === null) continue;
          if (!isSafeAttribute(attrKey, attrVal)) {
            throw new TypeError(`Disallowed UI attribute "${attrKey}"`);
          }
          if (typeof el.setAttribute === 'function') {
            el.setAttribute(attrKey, String(attrVal));
          }
        }
      } else if (key === 'dataset' && typeof val === 'object') {
        for (const [dsKey, dsVal] of Object.entries(val)) {
          if (dsVal === undefined || dsVal === null) continue;
          const attrName = `data-${dsKey.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
          if (typeof el.setAttribute === 'function') {
            el.setAttribute(attrName, String(dsVal));
          }
          if (el.dataset) {
            el.dataset[dsKey] = String(dsVal);
          }
        }
      } else if (key === 'on' && typeof val === 'object') {
        for (const [evt, handler] of Object.entries(val)) {
          if (typeof handler === 'function' && typeof el.addEventListener === 'function') {
            el.addEventListener(evt, handler);
          }
        }
      } else if (key.startsWith('on') && typeof val === 'function') {
        el[key] = val;
      } else if (key === 'value' || key === 'type' || key === 'id' || key === 'title' || key === 'placeholder') {
        el[key] = String(val);
        if (typeof el.setAttribute === 'function' && (key === 'id' || key === 'title' || key === 'type' || key === 'placeholder')) {
          el.setAttribute(key, String(val));
        }
      } else if (key === 'role' || key.startsWith('aria-') || key.startsWith('data-') || key === 'translate' || key === 'colspan' || key === 'inputmode' || key === 'pattern') {
        if (typeof el.setAttribute === 'function') {
          el.setAttribute(key, String(val));
        }
      } else if (isSafeAttribute(key, val)) {
        el[key] = val;
      } else {
        throw new TypeError(`Disallowed UI prop "${key}"`);
      }
    }
  }
  for (const child of children) {
    appendChildValue(doc, el, child);
  }
  return el;
}

function setText(el, value) {
  if (!el) return;
  const next = String(value ?? '');
  if (el.textContent !== next) {
    el.textContent = next;
  }
}

function clearChildren(el) {
  if (!el) return;
  if (typeof el.replaceChildren === 'function') {
    try {
      el.replaceChildren();
      return;
    } catch {}
  }
  while (el.firstChild && typeof el.removeChild === 'function') {
    el.removeChild(el.firstChild);
  }
  if ('textContent' in el && (!el.childNodes || el.childNodes.length === 0)) {
    el.textContent = '';
  }
}

module.exports = {
  h,
  setText,
  clearChildren,
};
