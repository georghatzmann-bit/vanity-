// Linear progress bar with glow; shimmer sweep while indeterminate or active.
import { h } from '../core/dom.js';

/**
 * ProgressBar({ value, size, tone, active, label })
 * - value: 0..1, or null for indeterminate
 * - size: 'sm' | 'md' | 'lg'; tone: null | 'ok' | 'err'
 * Returns the element with: setValue(v|null), setTone(tone), setActive(bool), value (get)
 */
export function ProgressBar({ value = 0, size = 'md', tone = null, active = false, label = '' } = {}) {
  const fill = h('div.progress__fill');
  const el = h(
    'div.progress',
    { attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': label || null } },
    h('div.progress__track', fill, h('div.progress__shimmer')),
  );
  if (size !== 'md') el.classList.add(`progress--${size}`);
  let current = value;

  const api = {
    get value() {
      return current;
    },
    setValue(v) {
      current = v;
      if (v == null) {
        el.classList.add('is-indeterminate');
        el.removeAttribute('aria-valuenow');
      } else {
        const p = Math.min(1, Math.max(0, Number(v) || 0));
        el.classList.remove('is-indeterminate');
        el.style.setProperty('--p', p.toFixed(4));
        el.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      }
      return el;
    },
    setTone(t) {
      el.classList.remove('progress--ok', 'progress--err');
      if (t) el.classList.add(`progress--${t}`);
      return el;
    },
    setActive(on) {
      el.classList.toggle('is-active', !!on);
      return el;
    },
  };
  api.setValue(value);
  api.setTone(tone);
  api.setActive(active);
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
