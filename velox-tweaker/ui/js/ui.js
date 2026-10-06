// VELOX UI components. Everything that shows API data goes through textContent (h() children),
// never innerHTML: startup entries, paths and tweak texts are untrusted.
import { icon } from './icons.js';

// ------------------------------------------------------------------ DOM helper
/**
 * h('div', { class, text, attrs, dataset, style, on: { click }, onClick, ... }, ...children)
 * Strings and numbers become text nodes. Keys with a dash (aria-*, data-*) are attributes.
 */
const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'insertAdjacentHTML']);
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (HTML_SINKS.has(k)) throw new Error('h(): ' + k + ' is not allowed - use text/children');
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style') { for (const [sk, sv] of Object.entries(v)) if (sv !== undefined && sv !== null) el.style.setProperty(sk, String(sv)); }
      else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v)) if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv); }
      else if (k === 'attrs') { for (const [ak, av] of Object.entries(v)) if (av !== undefined && av !== null && av !== false) el.setAttribute(ak, av === true ? '' : String(av)); }
      else if (k === 'on') { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k.includes('-')) el.setAttribute(k, v === true ? '' : String(v));
      else if (k in el) { try { el[k] = v; } catch { el.setAttribute(k, String(v)); } }
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}
/** Null-safe append: skips null/false, flattens arrays, turns strings into text nodes. */
export function append(el, ...children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, ...c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function reducedMotion() { return document.documentElement.dataset.motion === 'reduced'; }

// ------------------------------------------------------------------ formatting
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
export function fmtNumber(n, digits = 0) { return digits ? new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n) : nf0.format(n); }
export function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return nf0.format(b) + ' B';
  if (b < 1048576) return nf0.format(b / 1024) + ' KB';
  if (b < 1073741824) return nf0.format(b / 1048576) + ' MB';
  return nf1.format(b / 1073741824) + ' GB';
}
export function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
export function fmtDate(s) {
  const d = parseDate(s);
  if (!d) return '–';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}
export function fmtRelative(s) {
  const d = parseDate(s);
  if (!d) return 'noch nie';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) { const m = Math.round(diff / 60); return 'vor ' + m + (m === 1 ? ' Minute' : ' Minuten'); }
  if (diff < 86400) { const hh = Math.round(diff / 3600); return 'vor ' + hh + (hh === 1 ? ' Stunde' : ' Stunden'); }
  const days = Math.round(diff / 86400);
  if (days < 30) return 'vor ' + days + (days === 1 ? ' Tag' : ' Tagen');
  return d.toLocaleDateString('de-DE');
}
export function plural(n, one, many) { return fmtNumber(n) + ' ' + (n === 1 ? one : many); }

// ------------------------------------------------------------------ global effects
/** Ripple on every button / clickable card, spotlight that follows the pointer on cards. */
export function installEffects() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || reducedMotion()) return;
    const target = e.target.closest('.btn, .ripple-host, .nav-item, .chip, .tile, .card.clickable, .seg-btn, .icon-btn, .switch, .swatch, .rail-item, .goal, .model, .palette-item');
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    const r = target.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    let box = target.querySelector(':scope > .ripple-box');
    if (!box) {
      box = document.createElement('span');
      box.className = 'ripple-box';
      box.setAttribute('aria-hidden', 'true');
      if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
      target.appendChild(box);
    }
    const wave = document.createElement('span');
    wave.className = 'ripple';
    wave.style.setProperty('width', size + 'px');
    wave.style.setProperty('height', size + 'px');
    wave.style.setProperty('left', (e.clientX - r.left - size / 2) + 'px');
    wave.style.setProperty('top', (e.clientY - r.top - size / 2) + 'px');
    box.appendChild(wave);
    wave.addEventListener('animationend', () => wave.remove());
    setTimeout(() => wave.remove(), 900);
  }, { passive: true });

  // Spotlight: cards with .spot get --mx/--my following the pointer.
  let raf = 0; let last = null;
  document.addEventListener('pointermove', (e) => {
    last = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const el = last.target instanceof Element ? last.target.closest('.spot') : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (last.clientX - r.left) + 'px');
      el.style.setProperty('--my', (last.clientY - r.top) + 'px');
      if (el.classList.contains('tilt') && !reducedMotion()) {
        el.style.setProperty('--ry', (((last.clientX - r.left) / r.width - 0.5) * 5).toFixed(2) + 'deg');
        el.style.setProperty('--rx', (((last.clientY - r.top) / r.height - 0.5) * -5).toFixed(2) + 'deg');
      }
    });
  }, { passive: true });

  // Tooltips for [data-tip]: one floating element, so nothing gets clipped by overflow.
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'tooltip';
  document.body.appendChild(tip);
  let tipFor = null; let tipTimer = 0;
  const hideTip = () => { clearTimeout(tipTimer); tipFor = null; tip.classList.remove('show'); };
  const showTip = (el, delay) => {
    clearTimeout(tipTimer);
    tipFor = el;
    tipTimer = setTimeout(() => {
      if (tipFor !== el || !el.isConnected) return;
      const text = el.dataset.tip;
      if (!text) return;
      if (el.classList.contains('nav-item') && document.getElementById('sidebar').getBoundingClientRect().width > 120) return;
      tip.textContent = text;
      const r = el.getBoundingClientRect();
      tip.classList.add('show');
      const tw = tip.offsetWidth; const th = tip.offsetHeight;
      const side = el.classList.contains('nav-item') ? 'right' : 'top';
      let x; let y;
      if (side === 'right') { x = r.right + 10; y = r.top + r.height / 2 - th / 2; }
      else { x = r.left + r.width / 2 - tw / 2; y = r.top - th - 8; if (y < 8) y = r.bottom + 8; }
      x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
      tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    }, delay);
  };
  document.addEventListener('pointerover', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (el && el !== tipFor) showTip(el, 350);
    else if (!el && tipFor) hideTip();
  }, { passive: true });
  document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) showTip(el, 150); else hideTip(); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip, { passive: true });
  document.addEventListener('scroll', hideTip, { passive: true, capture: true });
}

/** Celebration: a short particle burst at (x, y). Off with reduced motion. */
export function burst(x, y, n = 30) {
  if (reducedMotion() || !Element.prototype.animate) return;
  const layer = document.createElement('div');
  layer.className = 'burst';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.left = x + 'px';
  layer.style.top = y + 'px';
  document.body.appendChild(layer);
  const colors = ['var(--accent)', 'var(--brand-2)', '#FFFFFF', 'var(--accent-hi)'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.background = colors[i % colors.length];
    if (i % 3 === 0) p.style.borderRadius = '50%';
    layer.appendChild(p);
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 70 + Math.random() * 130;
    const dx = Math.cos(ang) * dist; const dy = Math.sin(ang) * dist * 0.75;
    p.animate([
      { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
      { transform: 'translate(' + dx * 0.85 + 'px,' + (dy * 0.85 - 10) + 'px) rotate(' + (Math.random() * 360) + 'deg) scale(1)', opacity: 1, offset: 0.6 },
      { transform: 'translate(' + dx + 'px,' + (dy + 46) + 'px) rotate(' + (Math.random() * 540) + 'deg) scale(.3)', opacity: 0 }
    ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 1600);
}

// ------------------------------------------------------------------ small pieces
export function button({ label, icon: ic, variant = 'secondary', size, onClick, disabled, title, attrs, cls, type = 'button', iconRight }) {
  const b = h('button', { class: ['btn', 'btn-' + variant, size && 'btn-' + size, cls], type, disabled: !!disabled, title, attrs },
    ic && icon(ic, size === 'sm' ? 15 : 17), label !== undefined && label !== null ? h('span', { class: 'btn-label', text: label }) : null, iconRight && icon(iconRight, 15, 'btn-icon-right'));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
export function iconButton({ icon: ic, label, onClick, cls, size = 18, attrs }) {
  const b = h('button', { class: ['icon-btn', cls], type: 'button', 'aria-label': label, 'data-tip': label, attrs }, icon(ic, size));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
export function badge(text, tone = 'neutral', ic) {
  return h('span', { class: 'badge badge-' + tone }, ic && icon(ic, 12), h('span', { text }));
}
export const RISK = {
  safe: { label: 'Sicher', tone: 'ok', icon: 'shieldCheck' },
  moderate: { label: 'Mittel', tone: 'warn', icon: 'info' },
  risky: { label: 'Riskant', tone: 'error', icon: 'alert' }
};
export function riskBadge(risk) {
  const r = RISK[risk] || RISK.safe;
  return h('span', { class: 'badge badge-' + r.tone, 'data-risk': risk, title: 'Risiko: ' + r.label }, icon(r.icon, 12), h('span', { text: r.label }));
}
export const IMPACT = { 1: 'kaum spürbar', 2: 'spürbar', 3: 'stark' };
export function impactBars(n) {
  n = Math.max(1, Math.min(3, Number(n) || 1));
  return h('span', { class: 'impact', 'data-level': n, title: 'Wirkung: ' + IMPACT[n], 'data-tip': 'Wirkung: ' + IMPACT[n] },
    h('i'), h('i'), h('i'), h('span', { class: 'sr-only', text: 'Wirkung: ' + IMPACT[n] }));
}
export function needsBadge(needs) {
  if (needs === 'reboot') return badge('Neustart', 'neutral', 'restart');
  if (needs === 'explorer') return badge('Explorer', 'neutral', 'refresh');
  if (needs === 'logoff') return badge('Abmelden', 'neutral', 'user');
  return null;
}
export function spinner(size = 16) {
  return h('span', { class: 'spinner', style: { '--s': size + 'px' }, role: 'status', 'aria-label': 'Lädt' });
}

/** Spring toggle: <button role="switch">. onChange(next) may return false to veto. */
export function toggle({ checked = false, disabled = false, label, onChange, title, cls }) {
  const b = h('button', { class: ['switch', cls], type: 'button', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label || 'Umschalten', disabled: !!disabled, title },
    h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })));
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    const next = b.getAttribute('aria-checked') !== 'true';
    const res = onChange ? await onChange(next) : true;
    if (res !== false) set(next);
  });
  function set(v) { b.setAttribute('aria-checked', String(!!v)); }
  b.setChecked = set;
  return b;
}

/** Custom checkbox with animated tick. Returns <label>; .input is the native checkbox. */
export function checkbox({ checked = false, label, desc, onChange, disabled, cls, name }) {
  const input = h('input', { type: 'checkbox', checked: !!checked, disabled: !!disabled, name });
  const box = h('span', { class: 'cb-box', 'aria-hidden': 'true' });
  box.appendChild(icon('check', 14));
  const el = h('label', { class: ['cb', cls, disabled && 'is-disabled'] }, input, box,
    (label || desc) && h('span', { class: 'cb-text' }, label && h('span', { class: 'cb-label', text: label }), desc && h('span', { class: 'cb-desc', text: desc })));
  input.addEventListener('change', () => onChange && onChange(input.checked));
  el.input = input;
  return el;
}

/** Segmented control with a sliding indicator. */
export function segmented({ options, value, onChange, label, cls }) {
  const wrap = h('div', { class: ['seg', cls], role: 'radiogroup', 'aria-label': label });
  const ind = h('span', { class: 'seg-ind', 'aria-hidden': 'true' });
  wrap.appendChild(ind);
  const btns = options.map(o => {
    const b = h('button', { class: 'seg-btn', type: 'button', role: 'radio', 'aria-checked': String(o.value === value), dataset: { value: o.value }, disabled: !!o.disabled, title: o.title },
      o.icon && icon(o.icon, 15), h('span', { text: o.label }));
    b.addEventListener('click', () => { if (b.disabled) return; select(o.value); onChange && onChange(o.value); });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = btns.indexOf(b); const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
      n.focus(); n.click(); e.preventDefault();
    });
    wrap.appendChild(b);
    return b;
  });
  function place() {
    const cur = btns.find(b => b.getAttribute('aria-checked') === 'true');
    if (!cur || !cur.offsetWidth) { ind.style.opacity = '0'; return; }
    ind.style.opacity = '1';
    ind.style.width = cur.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + cur.offsetLeft + 'px)';
  }
  function select(v) { for (const b of btns) b.setAttribute('aria-checked', String(b.dataset.value === v)); place(); }
  requestAnimationFrame(place);
  new ResizeObserver(place).observe(wrap);
  wrap.select = select;
  return wrap;
}

export function emptyState({ icon: ic = 'sparkles', title, text, action, cls }) {
  return h('div', { class: ['empty', cls] },
    h('div', { class: 'empty-art' }, h('div', { class: 'empty-glow' }), icon(ic, 28)),
    h('div', { class: 'empty-title', text: title }),
    text && h('p', { class: 'empty-text', text }),
    action);
}

export function skeleton(lines = 3, cls) {
  return h('div', { class: ['skel-block', cls], 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, i) => h('div', { class: 'skel', style: { width: (i === lines - 1 ? 60 : 100 - i * 8) + '%' } })));
}

/** Stagger the entrance of children (first ~24 only, the rest appear at once). */
export function stagger(container, selector) {
  const kids = selector ? container.querySelectorAll(selector) : container.children;
  let i = 0;
  for (const k of kids) { k.style.setProperty('--i', String(Math.min(i, 24))); k.classList.add('enter'); i++; }
  return container;
}

// ------------------------------------------------------------------ count up
export function countUp(el, to, { from, duration = 900, format = (v) => fmtNumber(Math.round(v)) } = {}) {
  to = Number(to) || 0;
  const start = from !== undefined ? Number(from) : Number(el.dataset.value || 0);
  el.dataset.value = String(to);
  if (el._cu) cancelAnimationFrame(el._cu);
  if (reducedMotion() || start === to || duration <= 0) { el.textContent = format(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    // Chrome hands rAF the frame's begin time, which can lie before t0: without the floor the
    // first frame eases to below the start value (a pending bar briefly showing "-46").
    const p = Math.max(0, Math.min(1, (now - t0) / duration));
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = format(start + (to - start) * e);
    if (p < 1) el._cu = requestAnimationFrame(step); else el._cu = 0;
  };
  el._cu = requestAnimationFrame(step);
}

// ------------------------------------------------------------------ score ring
let ringId = 0;
export function scoreRing({ size = 168, stroke = 12, value = null, label = 'Punkte', ghost = null, cls } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gid = 'rg' + (++ringId);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'ring-svg');
  svg.setAttribute('aria-hidden', 'true');
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const defs = mk('defs', {});
  const grad = mk('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.appendChild(mk('stop', { offset: '0%', 'stop-color': 'var(--accent)' }));
  grad.appendChild(mk('stop', { offset: '100%', 'stop-color': 'var(--brand-2)' }));
  defs.appendChild(grad);
  svg.appendChild(defs);
  const cx = size / 2;
  svg.appendChild(mk('circle', { cx, cy: cx, r, class: 'ring-track', 'stroke-width': stroke, fill: 'none' }));
  const ghostArc = mk('circle', { cx, cy: cx, r, class: 'ring-ghost', 'stroke-width': stroke, fill: 'none', 'stroke-dasharray': c, 'stroke-dashoffset': c, 'stroke-linecap': 'round', transform: 'rotate(-90 ' + cx + ' ' + cx + ')' });
  svg.appendChild(ghostArc);
  const arc = mk('circle', { cx, cy: cx, r, class: 'ring-arc', stroke: 'url(#' + gid + ')', 'stroke-width': stroke, fill: 'none', 'stroke-dasharray': c, 'stroke-dashoffset': c, 'stroke-linecap': 'round', transform: 'rotate(-90 ' + cx + ' ' + cx + ')' });
  svg.appendChild(arc);
  const num = h('span', { class: 'ring-num', text: value === null ? '–' : '0' });
  const lab = h('span', { class: 'ring-label', text: label });
  const el = h('div', { class: ['ring', cls], style: { width: size + 'px', height: size + 'px' }, role: 'img', 'aria-label': label + ': ' + (value === null ? 'noch nicht analysiert' : value) },
    h('div', { class: 'ring-glow' }), svg, h('div', { class: 'ring-center' }, num, lab));
  function set(v, g) {
    if (v === null || v === undefined) { arc.setAttribute('stroke-dashoffset', String(c)); num.textContent = '–'; el.classList.add('is-empty'); return; }
    el.classList.remove('is-empty');
    const pct = Math.max(0, Math.min(100, Number(v)));
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(c * (1 - pct / 100)))));
    countUp(num, pct, { duration: 1100 });
    el.setAttribute('aria-label', label + ': ' + Math.round(pct) + ' von 100');
    if (g !== undefined && g !== null) {
      const gp = Math.max(0, Math.min(100, Number(g)));
      requestAnimationFrame(() => requestAnimationFrame(() => ghostArc.setAttribute('stroke-dashoffset', String(c * (1 - gp / 100)))));
    }
  }
  el.set = set;
  el.setLabel = (t) => { lab.textContent = t; };
  if (value !== null) set(value, ghost);
  else el.classList.add('is-empty');
  return el;
}

// ------------------------------------------------------------------ toasts
let toastRoot = null;
const TOAST_ICON = { ok: 'checkCircle', info: 'info', warn: 'warn', error: 'xCircle' };
const TOAST_LABEL = { ok: 'Erledigt', info: 'Info', warn: 'Hinweis', error: 'Fehler' };
export function toast({ type = 'ok', title, text, action, duration }) {
  if (!toastRoot) {
    toastRoot = document.getElementById('toasts');
  }
  // Errors stay until they are closed (a slow reader must not miss them); toasts that offer an
  // action (e.g. "Rückgängig") stay longer than plain confirmations.
  const sticky = type === 'error' && duration === undefined;
  if (duration === undefined) duration = action ? 9000 : 4600;
  const close = () => {
    if (!el.isConnected || el.classList.contains('leaving')) return;
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), reducedMotion() ? 120 : 220);
  };
  const el = h('div', { class: ['toast toast-' + type, sticky && 'is-sticky'], role: type === 'error' ? 'alert' : 'status', style: { '--dur': duration + 'ms' } },
    h('div', { class: 'toast-icon' }, icon(TOAST_ICON[type] || 'info', 18)),
    h('div', { class: 'toast-body' },
      h('div', { class: 'toast-title' }, h('span', { class: 'toast-kind', text: TOAST_LABEL[type] || '' }), h('span', { text: title || '' })),
      text && h('div', { class: 'toast-text', text }),
      action && h('div', { class: 'toast-actions' }, button({ label: action.label, variant: 'secondary', size: 'sm', onClick: () => { close(); action.onClick(); } }))),
    iconButton({ icon: 'x', label: 'Schließen', size: 15, onClick: close, cls: 'toast-x' }),
    sticky ? null : h('div', { class: 'toast-timer' }));
  toastRoot.appendChild(el);
  // keep at most 4; drop the oldest non-error first
  while (toastRoot.children.length > 4) {
    const victim = Array.from(toastRoot.children).find(c => !c.classList.contains('is-sticky')) || toastRoot.firstElementChild;
    victim.remove();
  }
  let timer = sticky ? 0 : setTimeout(close, duration);
  let hovered = false; let focused = false;
  const pause = () => { clearTimeout(timer); el.classList.add('paused'); };
  const resume = () => { if (sticky || hovered || focused) return; el.classList.remove('paused'); clearTimeout(timer); timer = setTimeout(close, 2400); };
  el.addEventListener('mouseenter', () => { hovered = true; pause(); });
  el.addEventListener('mouseleave', () => { hovered = false; resume(); });
  el.addEventListener('focusin', () => { focused = true; pause(); });
  el.addEventListener('focusout', (e) => { if (el.contains(e.relatedTarget)) return; focused = false; resume(); });
  return { close, el };
}

// ------------------------------------------------------------------ overlays (dialog, drawer)
const stack = [];
document.addEventListener('keydown', (e) => {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape' && top.dismissible !== false) { e.preventDefault(); e.stopPropagation(); top.close(false); }
  if (e.key === 'Tab') trapFocus(e, top.panel);
});
function trapFocus(e, panel) {
  const f = $$('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', panel).filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0]; const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  else if (!panel.contains(document.activeElement)) { first.focus(); e.preventDefault(); }
}
export function overlayOpen() { return stack.length > 0; }
/**
 * Where the user starts VELOX: the start menu entry of VeloxSetup.exe (VELOX.exe, WebView2), or
 * Start.bat / Start-Testmodus.bat when VELOX runs from the unpacked folder or VELOX.exe fell back
 * to an Edge window.
 */
export function startHint(test) {
  const menu = test ? '„VELOX Testmodus“' : '„VELOX“';
  if (window.chrome && window.chrome.webview) return menu + ' im Startmenü';
  return menu + ' im Startmenü (oder ' + (test ? 'Start-Testmodus.bat' : 'Start.bat') + ')';
}


export function openLayer({ kind, panel, dismissible = true, onClose, label }) {
  const root = document.getElementById('layers');
  const backdrop = h('div', { class: 'backdrop backdrop-' + kind });
  const wrap = h('div', { class: 'layer layer-' + kind, role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, backdrop, panel);
  const prevFocus = document.activeElement;
  const app = document.getElementById('app');
  let closed = false;
  let resolveFn;
  const done = new Promise(r => { resolveFn = r; });
  const entry = {
    panel, dismissible,
    close(result) {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), reducedMotion() ? 120 : 200);
      // Un-inert synchronously: focusing an element inside an inert subtree silently fails and
      // drops keyboard users onto <body>.
      if (!stack.length && !app.hasAttribute('data-splash')) app.removeAttribute('inert');
      syncLayerClasses();
      restoreFocus(prevFocus);
      onClose && onClose(result);
      resolveFn(result);
    },
    setDismissible(v) { entry.dismissible = !!v; },
    done, el: wrap
  };
  backdrop.addEventListener('click', () => { if (entry.dismissible) entry.close(false); });
  stack.push(entry);
  root.appendChild(wrap);
  app.setAttribute('inert', '');
  syncLayerClasses();
  // Focus moves into the layer at once: keys typed right after Ctrl+K must land in the palette, not
  // on the button that had focus before (a Space there would press it).
  const focusFirst = () => {
    if (closed || panel.contains(document.activeElement)) return;
    const auto = panel.querySelector('[autofocus]') || panel.querySelector('input:not([type=checkbox]), textarea') || panel.querySelector('.btn-primary:not([disabled]), .btn:not([disabled])');
    (auto || panel).focus({ preventScroll: true });
  };
  focusFirst();
  requestAnimationFrame(focusFirst); // content added by the caller right after opening
  return entry;
}
/**
 * :root.has-drawer lifts the toasts above the drawer's footer so they never cover its buttons;
 * :root.has-modal (a centred dialog, the job overlay or the palette) puts them behind the backdrop -
 * at 900 px a toast would otherwise sit on the dialog's own buttons.
 */
function syncLayerClasses() {
  const isDrawer = (e) => e.el && e.el.classList.contains('layer-drawer');
  document.documentElement.classList.toggle('has-drawer', stack.some(isDrawer));
  document.documentElement.classList.toggle('has-modal', stack.some(e => !isDrawer(e)));
}
/** Puts focus back where it was; falls back to #main when that element is gone or hidden. */
function restoreFocus(prev) {
  const top = stack[stack.length - 1];
  if (top) { if (!top.panel.contains(document.activeElement)) top.panel.focus({ preventScroll: true }); return; }
  const usable = prev && prev !== document.body && prev.focus && prev.isConnected && !prev.closest('[inert]') && !prev.disabled && prev.getClientRects().length > 0;
  if (usable) { prev.focus({ preventScroll: true }); if (document.activeElement === prev) return; }
  const main = document.getElementById('main');
  if (main) main.focus({ preventScroll: true });
}

/** Generic modal dialog. body: Node; footer: Node[]; returns layer entry. */
export function dialog({ title, text, body, footer, icon: ic, tone = 'accent', dismissible = true, wide, label }) {
  const panel = h('div', { class: ['dialog', wide && 'dialog-wide'], tabindex: '-1' },
    h('div', { class: 'dialog-head' },
      ic && h('div', { class: 'dialog-icon tone-' + tone }, icon(ic, 22)),
      h('div', { class: 'dialog-titles' }, h('h2', { class: 'dialog-title', text: title }), text && h('p', { class: 'dialog-text', text }))),
    body && h('div', { class: 'dialog-body' }, body),
    footer && h('div', { class: 'dialog-foot' }, footer));
  return openLayer({ kind: 'dialog', panel, dismissible, label: label || title });
}

/**
 * Confirm dialog. With `checkbox` the confirm button stays disabled until it is ticked.
 * Resolves true/false.
 */
export function confirmDialog({ title, text, body, confirmLabel = 'Bestätigen', cancelLabel = 'Abbrechen', danger = false, checkbox: cbLabel, icon: ic, tone }) {
  let entry;
  const ok = button({ label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => entry.close(true), attrs: { 'data-action': 'confirm' } });
  const cancel = button({ label: cancelLabel, variant: 'ghost', onClick: () => entry.close(false), attrs: { 'data-action': 'cancel' } });
  let cb = null;
  if (cbLabel) {
    ok.disabled = true;
    cb = checkbox({ label: cbLabel, onChange: (v) => { ok.disabled = !v; }, cls: 'confirm-check' });
  }
  entry = dialog({ title, text, icon: ic || (danger ? 'alert' : 'info'), tone: tone || (danger ? 'error' : 'accent'), body: (body || cb) ? h('div', { class: 'stack-12' }, body, cb) : null, footer: [cancel, ok] });
  if (!cb) requestAnimationFrame(() => { if (ok.isConnected && !ok.closest('.closing')) ok.focus(); });
  return entry.done.then(Boolean);
}

/** Right-side drawer. */
export function drawer({ title, subtitle, body, footer, icon: ic, label }) {
  const panel = h('aside', { class: 'drawer', tabindex: '-1' },
    h('div', { class: 'drawer-head' },
      ic && h('div', { class: 'drawer-icon' }, icon(ic, 22)),
      h('div', { class: 'drawer-titles' }, h('h2', { class: 'drawer-title', text: title }), subtitle && h('p', { class: 'drawer-sub', text: subtitle })),
      iconButton({ icon: 'x', label: 'Schließen', onClick: () => entry.close(false) })),
    h('div', { class: 'drawer-body' }, body),
    footer && h('div', { class: 'drawer-foot' }, footer));
  const entry = openLayer({ kind: 'drawer', panel, label: label || title });
  return entry;
}

// ------------------------------------------------------------------ job overlay
const LEVEL = { info: { label: '', icon: 'chevronRight' }, ok: { label: 'OK', icon: 'check' }, warn: { label: 'Hinweis', icon: 'warn' }, error: { label: 'Fehler', icon: 'xCircle' } };
/** Progress overlay for a running job. */
export function jobOverlay({ title, subtitle, cancellable, onCancel, icon: ic = 'bolt' }) {
  const bar = h('div', { class: 'pbar-fill' });
  const pct = h('span', { class: 'job-pct', text: '0 %' });
  const step = h('div', { class: 'job-step', text: 'Wird vorbereitet …' });
  const logBox = h('div', { class: 'job-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Protokoll' });
  const cancelBtn = cancellable ? button({ label: 'Abbrechen', variant: 'ghost', onClick: () => { cancelBtn.disabled = true; cancelBtn.querySelector('.btn-label').textContent = 'Wird abgebrochen …'; onCancel && onCancel(); } }) : null;
  const closeBtn = button({ label: 'Schließen', variant: 'secondary', onClick: () => entry.close(true), cls: 'job-close' });
  closeBtn.hidden = true;
  const summaryEl = h('p', { class: 'job-summary', hidden: true });
  const orb = h('div', { class: 'job-orb' }, h('div', { class: 'job-orb-ring' }), h('div', { class: 'job-orb-icon' }, icon(ic, 24)));
  const panel = h('div', { class: 'dialog job', tabindex: '-1', 'data-job': 'running' },
    h('div', { class: 'job-head' }, orb,
      h('div', { class: 'dialog-titles' }, h('h2', { class: 'dialog-title job-title', text: title }), subtitle && h('p', { class: 'dialog-text', text: subtitle }))),
    h('div', { class: 'job-progress' }, h('div', { class: 'job-progress-row' }, step, pct), h('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Fortschritt' }, bar)),
    summaryEl,
    logBox,
    h('div', { class: 'dialog-foot' }, cancelBtn, closeBtn));
  const entry = openLayer({ kind: 'dialog', panel, dismissible: false, label: title });
  // a step that starts with the title ("Wiederherstellungspunkt wird erstellt – das kann …") would
  // say the headline twice: keep only what it adds
  const stepText = (txt) => {
    const t = String(txt);
    if (!title || !t.toLowerCase().startsWith(String(title).toLowerCase())) return t;
    const rest = t.slice(String(title).length).replace(/^[\s.:,–-]+/, '');
    return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : t;
  };
  let shown = 0;
  let lastPct = 0;
  function update(job) {
    const p = Math.round((Number(job.progress) || 0) * 100);
    if (p !== lastPct) { countUp(pct, p, { from: lastPct, duration: 300, format: (v) => Math.round(v) + ' %' }); lastPct = p; }
    bar.style.transform = 'scaleX(' + Math.max(0.02, p / 100) + ')';
    panel.querySelector('.pbar').setAttribute('aria-valuenow', String(p));
    if (job.step) step.textContent = stepText(job.step);
    const lines = job.log || [];
    for (; shown < lines.length; shown++) {
      const l = lines[shown];
      const lv = LEVEL[l.level] || LEVEL.info;
      // a PowerShell stack trace ("… | at Invoke-…") is for the log file, not for the user
      const msg = String(l.msg || '').split(/\s\|\s+at\s|\r?\n\s*at\s/)[0];
      logBox.appendChild(h('div', { class: 'log-line lv-' + (l.level || 'info') }, icon(lv.icon, 13), lv.label && h('span', { class: 'log-tag', text: lv.label }), h('span', { class: 'log-msg', text: msg })));
    }
    while (logBox.children.length > 120) logBox.firstElementChild.remove();
    logBox.scrollTop = logBox.scrollHeight;
  }
  /**
   * opts.keep: stay open after success (long or important jobs, logs with warnings) so the user
   * can read what happened; opts.summary: one plain line shown under the progress bar.
   */
  function finish(job, opts = {}) {
    update(job);
    panel.dataset.job = job.status;
    if (cancelBtn) cancelBtn.hidden = true;
    const orbIcon = orb.querySelector('.job-orb-icon');
    clear(orbIcon).appendChild(icon(job.status === 'done' ? 'check' : job.status === 'cancelled' ? 'minus' : 'x', 26));
    if (opts.summary) summaryEl.textContent = opts.summary;
    summaryEl.hidden = !opts.summary;
    const hasProblems = (job.log || []).some(l => l.level === 'warn' || l.level === 'error');
    if (job.status === 'done') {
      step.textContent = hasProblems ? 'Fertig – mit Hinweisen' : 'Fertig';
      bar.style.transform = 'scaleX(1)';
      countUp(pct, 100, { from: lastPct, duration: 200, format: (v) => Math.round(v) + ' %' });
      if (opts.keep) {
        panel.classList.add('is-kept');
        entry.setDismissible(true);
        closeBtn.hidden = false;
        closeBtn.focus();
      } else setTimeout(() => entry.close(true), reducedMotion() ? 250 : 650);
    } else if (job.status === 'cancelled') {
      step.textContent = 'Abgebrochen';
      setTimeout(() => entry.close(true), 500);
    } else {
      step.textContent = job.error ? 'Fehlgeschlagen: ' + job.error : 'Fehlgeschlagen';
      entry.setDismissible(true);
      closeBtn.hidden = false;
      closeBtn.focus();
    }
    return entry.done;
  }
  return { update, finish, close: () => entry.close(true), done: entry.done };
}

// ------------------------------------------------------------------ layout helpers
export function pageHead({ title, desc, actions, icon: ic }) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-head-text' },
      ic && h('div', { class: 'page-head-icon' }, icon(ic, 22)),
      h('div', {}, h('h1', { class: 'page-title', text: title }), desc && h('p', { class: 'page-desc', text: desc }))),
    actions && h('div', { class: 'page-actions' }, actions));
}
export function sectionHead(title, desc, actions) {
  return h('div', { class: 'section-head' },
    h('div', {}, h('h2', { class: 'section-title', text: title }), desc && h('p', { class: 'section-desc', text: desc })),
    actions && h('div', { class: 'section-actions' }, actions));
}
/** Settings-style row: label + one grey explanation line + control on the right. */
export function optionRow({ title, desc, control, icon: ic }) {
  return h('div', { class: 'opt-row' },
    ic && h('div', { class: 'opt-icon' }, icon(ic, 18)),
    h('div', { class: 'opt-text' }, h('div', { class: 'opt-title', text: title }), desc && h('div', { class: 'opt-desc', text: desc })),
    h('div', { class: 'opt-control' }, control));
}

/** Avatar with a gradient derived from a string (for games). */
export function avatar(name, size = 44) {
  let hsh = 0; for (const c of String(name)) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  const h1 = hsh % 360; const h2 = (h1 + 50 + (hsh >> 8) % 60) % 360;
  const letters = String(name).replace(/[^A-Za-z0-9ÄÖÜäöü ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  return h('div', { class: 'avatar', style: { width: size + 'px', height: size + 'px', '--a1': 'hsl(' + h1 + ' 80% 60%)', '--a2': 'hsl(' + h2 + ' 85% 50%)' }, 'aria-hidden': 'true', text: letters });
}

/** Run fn inside a View Transition when supported and motion is on. */
export function viewTransition(fn, rootClass) {
  if (!reducedMotion() && document.startViewTransition) {
    const root = document.documentElement;
    try {
      if (rootClass) root.classList.add(rootClass);
      const vt = document.startViewTransition(fn);
      if (rootClass) vt.finished.finally(() => root.classList.remove(rootClass)).catch(() => {});
      return vt;
    } catch { if (rootClass) root.classList.remove(rootClass); /* fall through */ }
  }
  fn();
  return null;
}

// ------------------------------------------------------------------ keyboard: radio groups
/**
 * Roving tabindex for a role="radiogroup" whose children are role="radio" buttons: only the checked
 * radio is a Tab stop, arrow keys move and select, Home/End jump. select(btn) is called for the
 * new radio (it should run the same logic as a click). Same keyboard model as segmented().
 */
export function radioKeys(group, select) {
  const radios = () => Array.from(group.querySelectorAll('[role="radio"]')).filter(r => !r.disabled);
  const sync = () => {
    const rs = Array.from(group.querySelectorAll('[role="radio"]'));
    const cur = rs.find(r => r.getAttribute('aria-checked') === 'true' && !r.disabled) || rs.find(r => !r.disabled);
    for (const r of rs) r.tabIndex = r === cur ? 0 : -1;
  };
  group.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const rs = radios();
    if (!rs.length) return;
    const i = Math.max(0, rs.indexOf(document.activeElement));
    let n = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % rs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + rs.length) % rs.length;
    else if (e.key === 'Home') n = 0;
    else n = rs.length - 1;
    e.preventDefault();
    rs[n].focus();
    select(rs[n]);
    sync();
  });
  group.addEventListener('click', () => requestAnimationFrame(sync));
  sync();
  group.syncRadios = sync;
  return group;
}

// ------------------------------------------------------------------ horizontal scrollers
/** Soft edge fades on a horizontal scroller, only on the side where more content is hidden. */
export function edgeFade(el) {
  el.classList.add('edge-fade');
  const upd = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('fade-start', max > 2 && el.scrollLeft > 2);
    el.classList.toggle('fade-end', max > 2 && el.scrollLeft < max - 2);
  };
  el.addEventListener('scroll', upd, { passive: true });
  new ResizeObserver(upd).observe(el);
  requestAnimationFrame(upd);
  el.updateFade = upd;
  return el;
}

// ------------------------------------------------------------------ fly-to (staging feedback)
/**
 * A small accent dot springs from `from` (element or {x, y}) to `to` (element); onArrive runs when it
 * lands. Off with reduced motion (onArrive runs at once).
 */
export function flyTo(from, to, onArrive) {
  const done = () => { try { onArrive && onArrive(); } catch (e) { console.error(e); } };
  if (reducedMotion() || !Element.prototype.animate || !to || !to.isConnected) { done(); return; }
  const a = from instanceof Element ? from.getBoundingClientRect() : { left: from.x, top: from.y, width: 0, height: 0 };
  const b = to.getBoundingClientRect();
  if (!b.width) { done(); return; }
  const x0 = a.left + a.width / 2; const y0 = a.top + a.height / 2;
  const x1 = b.left + b.width / 2; const y1 = b.top + b.height / 2;
  const dot = document.createElement('i');
  dot.className = 'fly-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.style.left = x0 + 'px';
  dot.style.top = y0 + 'px';
  document.body.appendChild(dot);
  const dx = x1 - x0; const dy = y1 - y0;
  const lift = Math.min(120, Math.abs(dx) * 0.25 + 40);
  const anim = dot.animate([
    { transform: 'translate(-50%,-50%) translate(0,0) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%,-50%) translate(' + dx * 0.35 + 'px,' + (dy * 0.35 - lift) + 'px) scale(1.15)', opacity: 1, offset: 0.35 },
    { transform: 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px) scale(.5)', opacity: .9 }
  ], { duration: 520, easing: 'cubic-bezier(.5,0,.3,1)' });
  anim.onfinish = () => { dot.remove(); done(); };
  anim.oncancel = () => { dot.remove(); done(); };
}
