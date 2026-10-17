// App tile: icon (scan icon / favicon / generated monogram), name, one-line description,
// checkbox state, status badge slot and progress slot.
import { h } from '../core/dom.js';
import { checkBox } from './checkbox.js';
import { Badge } from './badge.js';
import { ProgressBar } from './progressBar.js';
import { sound } from '../core/sound.js';
import { pop, gsap, richMotion } from '../core/motion.js';

function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/** "Visual Studio Code" -> "VS", "Discord" -> "D", "7-Zip" -> "7Z" */
export function monogram(name = '') {
  const words = String(name).replace(/[®™©]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic violet-ish gradient from a name (hues 245–300). */
export function monogramGradient(name = '') {
  const n = hash(String(name).toLowerCase());
  const h1 = 245 + (n % 55);
  const h2 = h1 + 18 + ((n >>> 8) % 28);
  const l1 = 60 + ((n >>> 4) % 10);
  const l2 = 30 + ((n >>> 12) % 10);
  const ang = 120 + ((n >>> 16) % 60);
  return `linear-gradient(${ang}deg, hsl(${h1} 88% ${l1}%) 0%, hsl(${h2} 72% ${l2}%) 100%)`;
}

export function faviconUrl(homepage) {
  if (!homepage) return null;
  try {
    const u = new URL(/^https?:/i.test(homepage) ? homepage : `https://${homepage}`);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64`;
  } catch {
    return null;
  }
}

/** Icon tile on its own (also handy for lists). */
export function AppIcon({ name = '', icon, homepage, size = 44 } = {}) {
  const wrap = h('div.app-card__icon', { style: size !== 44 ? { width: `${size}px`, height: `${size}px` } : null });
  wrap.append(h('span.app-card__mono', { style: { '--mono-bg': monogramGradient(name) } }, monogram(name)));
  const src = icon || faviconUrl(homepage);
  if (src) {
    const img = h('img', { alt: '', decoding: 'async', referrerPolicy: 'no-referrer', draggable: false });
    img.addEventListener('load', () => {
      // Google answers unknown domains with a 16px globe – keep the monogram then.
      if (icon || img.naturalWidth >= 32) wrap.classList.add('has-img');
    });
    img.addEventListener('error', () => img.remove());
    img.src = src;
    wrap.append(img);
  }
  return wrap;
}

/**
 * AppCard({ app: { key, name, desc, homepage, icon }, selected, selectable, disabled, onToggle })
 * Returns the element with: selected (get), setSelected(v, { silent, animate }), setBadge({ tone, label, icon } | null),
 * setProgress(v | null | undefined) (undefined removes the bar), setDisabled(bool), key
 */
export function AppCard({ app = {}, selected = false, selectable = true, disabled = false, onToggle } = {}) {
  const box = selectable ? checkBox() : null;
  const badgeSlot = h('div.app-card__badge');
  const progressSlot = h('div.app-card__progress');
  const el = h(
    'div.app-card',
    {
      dataset: { key: app.key || app.id || app.name || '' },
      attrs: selectable ? { role: 'checkbox', tabindex: disabled ? '-1' : '0', 'aria-checked': String(!!selected), 'aria-label': app.name } : { role: 'group', 'aria-label': app.name },
    },
    AppIcon(app),
    h('div.app-card__body', h('div.app-card__name', { title: app.name }, app.name || 'Unbenannt'), h('div.app-card__desc', { title: app.desc || '' }, app.desc || '')),
    h('div.app-card__aside', badgeSlot, box),
    progressSlot,
  );

  let isSelected = !!selected;
  let isDisabled = !!disabled;
  let bar = null;
  el.classList.toggle('is-selected', isSelected && selectable);
  el.classList.toggle('is-disabled', isDisabled);

  function setSelected(v, { silent = false, animate = true } = {}) {
    const next = !!v;
    if (next === isSelected) return;
    isSelected = next;
    el.classList.toggle('is-selected', isSelected);
    el.setAttribute('aria-checked', String(isSelected));
    if (animate) {
      pop(el, { from: 0.965 });
      if (isSelected && box && richMotion()) {
        gsap.fromTo(box, { rotate: -12, scale: 0.6 }, { rotate: 0, scale: 1, duration: 0.6, ease: 'back.out(3)' });
      }
    }
    if (!silent) onToggle?.(isSelected, app);
  }

  if (selectable) {
    const toggle = () => {
      if (isDisabled) return;
      setSelected(!isSelected);
      sound.play(isSelected ? 'click' : 'hover');
    };
    el.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      toggle();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggle();
      }
    });
  }
  el.addEventListener('pointerenter', () => !isDisabled && sound.play('hover'));

  const api = {
    key: app.key,
    app,
    get selected() {
      return isSelected;
    },
    setSelected(v, opts) {
      setSelected(v, { silent: true, ...opts });
      return el;
    },
    setBadge(b) {
      badgeSlot.textContent = '';
      if (b) badgeSlot.append(b instanceof Node ? b : Badge(b));
      return el;
    },
    setProgress(v, opts = {}) {
      if (v === undefined) {
        progressSlot.textContent = '';
        bar = null;
        return el;
      }
      if (!bar) {
        bar = ProgressBar({ size: 'sm', value: v, label: app.name });
        progressSlot.append(bar);
      }
      bar.setValue(v);
      if (opts.tone !== undefined) bar.setTone(opts.tone);
      bar.setActive(v != null && v < 1);
      return el;
    },
    setDisabled(v) {
      isDisabled = !!v;
      el.classList.toggle('is-disabled', isDisabled);
      if (selectable) el.tabIndex = isDisabled ? -1 : 0;
      el.setAttribute('aria-disabled', String(isDisabled));
      return el;
    },
  };
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
