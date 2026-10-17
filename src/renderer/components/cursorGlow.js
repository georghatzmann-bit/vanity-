// Soft violet light that trails the cursor across the page (hidden on effects "off").
import { h } from '../core/dom.js';
import { gsap } from '../core/motion.js';

/**
 * CursorGlow({ store }) -> element with destroy()
 * Append it to <body>; it is pointer-events: none and blends with "screen".
 */
export function CursorGlow({ store } = {}) {
  const el = h('div.cursor-glow', { attrs: { 'aria-hidden': 'true' } });
  const xTo = gsap.quickTo(el, 'x', { duration: 0.9, ease: 'power3.out' });
  const yTo = gsap.quickTo(el, 'y', { duration: 0.9, ease: 'power3.out' });
  let enabled = true;

  const move = (e) => {
    if (!enabled) return;
    if (!el.classList.contains('is-visible')) {
      gsap.set(el, { x: e.clientX, y: e.clientY });
      el.classList.add('is-visible');
    }
    xTo(e.clientX);
    yTo(e.clientY);
  };
  const leave = (e) => {
    if (!e.relatedTarget) el.classList.remove('is-visible');
  };
  window.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerout', leave);

  const off = store?.subscribe(
    (s) => s.settings.effects,
    (fx) => {
      enabled = fx !== 'off';
      if (!enabled) el.classList.remove('is-visible');
    },
    { immediate: true },
  );

  return Object.assign(el, {
    destroy() {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerout', leave);
      off?.();
      el.remove();
    },
  });
}
