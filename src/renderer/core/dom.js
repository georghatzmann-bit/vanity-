// Tiny DOM helpers shared by components and screens.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('button.btn.btn--primary', { onClick, dataset: { x: 1 }, attrs: { 'aria-label': 'x' } }, 'Text', childEl)
 * - tag may carry `.class` and `#id` shorthands
 * - props: class/className, style (string|object), dataset, attrs, html, text, on<Event>, any DOM property
 */
export function h(tag, props, ...children) {
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  const [base, ...rest] = String(tag).split(/(?=[.#])/);
  const el = document.createElement(base || 'div');
  for (const part of rest) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else if (part[0] === '#') el.id = part.slice(1);
  }
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      for (const c of String(value).split(/\s+/)) if (c) el.classList.add(c);
    } else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText += value;
      else for (const [k, v] of Object.entries(value)) k.startsWith('--') ? el.style.setProperty(k, v) : (el.style[k] = v);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'attrs') {
      for (const [k, v] of Object.entries(value)) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key === 'text') {
      el.textContent = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key.includes('-')) {
      el.setAttribute(key, value === true ? '' : value);
    } else {
      el[key] = value;
    }
  }
}

/** Appends strings / nodes / nested arrays, skipping null/false. */
export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Parses an SVG markup string into an SVGElement. */
export function svg(markup) {
  const tpl = document.createElementNS(SVG_NS, 'svg');
  tpl.innerHTML = markup;
  return tpl.firstElementChild;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** addEventListener that returns its own remover. */
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

let uid = 0;
export const nextId = (prefix = 'phx') => `${prefix}-${++uid}`;
