// SVG progress ring: gradient stroke, glow, glowing tip, outer tick ring and a big center number.
import { h, svg, nextId } from '../core/dom.js';
import { gsap, motionOK } from '../core/motion.js';
import { formatNumber } from '../core/format.js';

/**
 * ProgressRing({ size, stroke, value, label, showValue, ticks })
 * - value: 0..1 (null = indeterminate spinner)
 * Returns the element with: setValue(v, { animate }), setLabel(text), setIndeterminate(bool), value (get)
 */
export function ProgressRing({ size = 200, stroke = 10, value = 0, label = '', showValue = true, ticks = true } = {}) {
  const id = nextId('ring');
  const c = size / 2;
  const r = c - stroke / 2 - 14;
  const C = 2 * Math.PI * r;
  const rt = r + stroke / 2 + 8;
  const Ct = 2 * Math.PI * rt;
  const tickGap = Ct / 72;

  const graphic = svg(`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <defs>
      <linearGradient id="${id}g" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#6d28d9"/>
        <stop offset=".55" stop-color="#8b5cf6"/>
        <stop offset="1" stop-color="#e9e3ff"/>
      </linearGradient>
    </defs>
    ${ticks ? `<circle class="ring__ticks" cx="${c}" cy="${c}" r="${rt}" fill="none" stroke-width="3" stroke-dasharray="1 ${(tickGap - 1).toFixed(3)}"/>` : ''}
    <circle class="ring__track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle class="ring__bar" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="url(#${id}g)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}"/>
    <circle class="ring__tip" cx="${c + r}" cy="${c}" r="${Math.max(2.5, stroke * 0.32)}"/>
  </svg>`);
  const bar = graphic.querySelector('.ring__bar');
  const tip = graphic.querySelector('.ring__tip');

  const num = h('span.ring__num', '0');
  const valueEl = h('div.ring__value', num, h('span.ring__unit', '%'));
  const labelEl = h('div.ring__label', label);
  const el = h(
    'div.ring',
    { style: { '--ring-size': `${size}px` }, attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } },
    graphic,
    h('div.ring__center', showValue ? valueEl : null, labelEl),
  );

  const state = { v: 0 };
  let tween = null;

  function render(v) {
    bar.style.strokeDashoffset = String(C * (1 - v));
    const a = v * Math.PI * 2;
    tip.setAttribute('cx', String(c + r * Math.cos(a)));
    tip.setAttribute('cy', String(c + r * Math.sin(a)));
    tip.style.opacity = v > 0.004 ? '1' : '0';
    num.textContent = formatNumber(Math.round(v * 100));
  }

  const api = {
    get value() {
      return state.v;
    },
    setValue(v, { animate = true } = {}) {
      if (v == null) return api.setIndeterminate(true);
      el.classList.remove('is-indeterminate');
      const target = Math.min(1, Math.max(0, Number(v) || 0));
      el.setAttribute('aria-valuenow', String(Math.round(target * 100)));
      tween?.kill();
      if (animate && motionOK()) {
        tween = gsap.to(state, { v: target, duration: 0.8, ease: 'power3.out', onUpdate: () => render(state.v) });
      } else {
        state.v = target;
        render(target);
      }
      return el;
    },
    setLabel(text) {
      labelEl.textContent = text;
      return el;
    },
    setIndeterminate(on) {
      el.classList.toggle('is-indeterminate', !!on);
      if (on) {
        tween?.kill();
        el.removeAttribute('aria-valuenow');
        bar.style.strokeDashoffset = String(C * 0.72);
        tip.setAttribute('cx', String(c + r * Math.cos(Math.PI * 2 * 0.28)));
        tip.setAttribute('cy', String(c + r * Math.sin(Math.PI * 2 * 0.28)));
        tip.style.opacity = '1';
      } else {
        render(state.v);
      }
      return el;
    },
  };
  render(0);
  if (value == null) api.setIndeterminate(true);
  else api.setValue(value, { animate: false });
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
