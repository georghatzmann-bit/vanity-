// Kleine Oberflächen-Bausteine: Elemente bauen, Meldungen, Dialoge, Formatierung.
// Texte werden immer als Text gesetzt (nie als HTML), damit Dateinamen o. Ä. nichts einschleusen können.

import { sfx } from './sound.js';

/**
 * Baut ein Element. h('button.btn.primary', { onclick }, 'Text', kindElement)
 * Attribute: class, style (Objekt oder Text), dataset, on<event>, aria-*, sonst setAttribute.
 */
export function h(spec, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.classList.add(...classes.filter(Boolean));
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv == null) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// ---------- Symbole (eigene, schlichte Linien-Icons) ----------

const ICONS = {
  back: 'M15 18l-6-6 6-6',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  play: 'M8 5l11 7-11 7z',
  stop: 'M7 7h10v10H7z',
  lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z',
  unlock: 'M7 11V8a5 5 0 019.6-2M6 11h12v9H6z',
  folder: 'M3 7h6l2 2h10v10H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  copy: 'M8 8h11v13H8zM5 16V3h11',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  info: 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 11v6M12 7.5v.5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  clock: 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 7v5l3 3',
  settings: 'M12 9a3 3 0 110 6 3 3 0 010-6zM19 12l2-1-2-4-2 .5-1.5-1.2L15 4h-4l-.5 2.3L9 7.5 7 7 5 11l2 1v1l-2 1 2 4 2-.5 1.5 1.2.5 2.3h4l.5-2.3 1.5-1.2 2 .5 2-4-2-1z',
  power: 'M12 3v9M6.3 7.3a8 8 0 1011.4 0',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v8',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  chevron: 'M9 6l6 6-6 6',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 110 6 3 3 0 010-6z',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M19 6a8 8 0 010 12',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
};

export function icon(name, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.dots);
  svg.appendChild(path);
  return svg;
}

// ---------- Knöpfe ----------

/** Knopf mit optionalem Symbol. variant: 'primary' | 'ghost' | 'danger' | '' */
export function button(label, { onClick, variant = '', iconName, title, disabled, small } = {}) {
  const b = h(`button.btn${variant ? '.' + variant : ''}${small ? '.small' : ''}`, { type: 'button', title, disabled },
    iconName ? icon(iconName, small ? 16 : 18) : null, label ? h('span', label) : null);
  b.addEventListener('mouseenter', () => sfx('hover'));
  if (onClick) {
    b.addEventListener('click', async (e) => {
      sfx('click');
      if (b.dataset.busy) return;
      b.dataset.busy = '1';
      b.classList.add('busy');
      try { await onClick(e); } finally { delete b.dataset.busy; b.classList.remove('busy'); }
    });
  }
  return b;
}

/** Schalter mit Titel und grauer Erklärungszeile. */
export function toggle({ label, hint, checked, onChange, disabled }) {
  const input = h('input', { type: 'checkbox', checked, disabled, role: 'switch' });
  input.addEventListener('change', () => { sfx('click'); onChange?.(input.checked); });
  return h('label.toggle', h('span.toggle-text', h('span.toggle-label', label), hint ? h('span.hint', hint) : null), h('span.switch', input, h('span.knob')));
}

// ---------- Meldungen ----------

let toastRoot = null;
export function toast(message, type = 'ok', { timeout = 4200 } = {}) {
  toastRoot ||= document.getElementById('toasts');
  const t = h(`div.toast.${type}`, { role: 'status' }, icon(type === 'ok' ? 'check' : type === 'warn' ? 'warn' : type === 'err' ? 'x' : 'info'), h('span', message));
  toastRoot.appendChild(t);
  sfx(type === 'err' ? 'error' : type === 'ok' ? 'success' : 'click');
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, timeout);
}

/** Zeigt eine Fehlermeldung verständlich an. */
export function showError(err, prefix) {
  const msg = err && err.message ? err.message : String(err);
  toast(prefix ? `${prefix}: ${msg}` : msg, 'err', { timeout: 7000 });
}

// ---------- Dialoge ----------

/**
 * Öffnet einen Dialog. content: Element oder Array. actions: [{label, variant, value, onClick}]
 * Gibt ein Promise mit dem value der geklickten Aktion zurück (oder null bei Abbruch).
 */
export function modal({ title, subtitle, content, actions = [], wide = false, closable = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const prevFocus = document.activeElement;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      overlay.classList.remove('show');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => overlay.remove(), 180);
      prevFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && closable) close(null);
    };
    const footer = h('div.modal-actions', actions.map((a) => button(a.label, {
      variant: a.variant || '',
      iconName: a.icon,
      disabled: a.disabled,
      onClick: async () => {
        if (a.onClick) {
          const r = await a.onClick({ close });
          if (r === false) return;
        }
        close(a.value ?? a.label);
      },
    })));
    const dialog = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.modal-head', h('div', h('h2', title), subtitle ? h('p.hint', subtitle) : null),
        closable ? h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', onclick: () => close(null) }, icon('x')) : null),
      h('div.modal-body', content),
      actions.length ? footer : null);
    const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay && closable) close(null); } }, dialog);
    root.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => {
      overlay.classList.add('show');
      (dialog.querySelector('input, .btn.primary') || dialog.querySelector('button'))?.focus();
    });
  });
}

export async function confirmDialog({ title, text, confirmLabel = 'OK', danger = false, cancelLabel = 'Abbrechen' }) {
  const r = await modal({
    title,
    content: h('p', text),
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  });
  return r === true;
}

export async function promptDialog({ title, label, value = '', hint, confirmLabel = 'Speichern', maxLength = 40 }) {
  const input = h('input.input', { type: 'text', value, maxlength: maxLength, 'aria-label': label });
  const content = h('div.field', h('label', label), input, hint ? h('p.hint', hint) : null);
  let result = null;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') content.closest('.modal')?.querySelector('.btn.primary')?.click();
  });
  const r = await modal({
    title,
    content,
    actions: [
      { label: 'Abbrechen', value: false },
      {
        label: confirmLabel, value: true, variant: 'primary',
        onClick: () => {
          if (!input.value.trim()) { input.focus(); input.classList.add('invalid'); return false; }
          result = input.value.trim();
          return true;
        },
      },
    ],
  });
  return r === true ? result : null;
}

// ---------- Formatierung ----------

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: n < 10 ? 1 : 0 })} ${u[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(ts) {
  if (!ts) return 'nie';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'gestern' : `vor ${d} Tagen`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  if (hh) return `${hh} Std. ${mm} Min.`;
  if (mm) return `${mm} Min.`;
  return `${sec} Sek.`;
}

/** Leerer Zustand mit Erklärung, was zu tun ist. */
export function emptyState({ title, text, action }) {
  return h('div.empty', h('div.empty-mark', icon('sparkle', 28)), h('h3', title), h('p.hint', text), action || null);
}

/** Abschnitt mit Überschrift und grauer Erklärung. */
export function section(title, hint, ...children) {
  return h('section.block', h('div.block-head', h('h3', title), hint ? h('p.hint', hint) : null), ...children);
}

/** Statusplakette, immer mit Text (nicht nur Farbe). */
export function badge(text, type = '') {
  return h(`span.badge${type ? '.' + type : ''}`, text);
}

export function spinner() {
  return h('span.spinner', { 'aria-label': 'Lädt' });
}
