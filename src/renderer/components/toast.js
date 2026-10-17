// Toast stack (bottom-right). Auto-dismiss with a timer line; hover pauses.
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { gsap, motionOK, richMotion } from '../core/motion.js';
import { sound } from '../core/sound.js';

const TYPES = {
  success: { icon: 'check-circle', sound: 'success', title: 'Erledigt' },
  info: { icon: 'info', sound: 'hover', title: 'Hinweis' },
  warn: { icon: 'alert', sound: 'hover', title: 'Achtung' },
  error: { icon: 'x-circle', sound: 'error', title: 'Fehler' },
};
const MAX = 4;

/**
 * createToaster(hostEl) -> toast
 *   toast.show({ type: 'success'|'info'|'warn'|'error', title, message, duration = 4200 (0 = sticky), action: { label, onClick } })
 *   toast.success(title, message?, opts?) · toast.info(...) · toast.warn(...) · toast.error(...)
 *   Each returns { close() }.
 */
export function createToaster(host) {
  const live = [];

  function remove(item) {
    if (item.closing) return;
    item.closing = true;
    item.timer?.kill();
    gsap.killTweensOf([item.el, item.slot]);
    const i = live.indexOf(item);
    if (i >= 0) live.splice(i, 1);
    const done = () => item.slot.remove();
    if (!motionOK()) return done();
    gsap
      .timeline({ onComplete: done })
      .to(item.el, { x: 32, opacity: 0, scale: 0.97, filter: richMotion() ? 'blur(4px)' : 'none', duration: 0.22, ease: 'power2.in' })
      .to(item.slot, { height: 0, paddingTop: 0, duration: 0.28, ease: 'power3.inOut' }, '-=0.06');
  }

  function show({ type = 'info', title, message = '', duration = 4200, action } = {}) {
    const t = TYPES[type] || TYPES.info;
    const closeBtn = h('button.toast__close', { type: 'button', attrs: { 'aria-label': 'Schließen' } }, icon('close'));
    const timerEl = duration > 0 ? h('div.toast__timer') : null;
    const body = h('div.toast__body', h('div.toast__title', title || t.title), message ? h('div.toast__msg.selectable', message) : null);
    if (action) {
      body.append(
        h('button.btn.btn--secondary.btn--sm.toast__action', { type: 'button', onClick: () => { action.onClick?.(); remove(item); } }, h('span.btn__inner', action.label)),
      );
    }
    const el = h(
      `div.toast.toast--${type}`,
      { attrs: { role: type === 'error' ? 'alert' : 'status', 'aria-live': type === 'error' ? 'assertive' : 'polite' } },
      h('div.toast__icon', icon(t.icon, { strokeWidth: 2 })),
      body,
      closeBtn,
      timerEl,
    );
    const slot = h('div.toast-slot', el);
    const item = { el, slot, timer: null, closing: false };
    closeBtn.addEventListener('click', () => remove(item));

    host.append(slot);
    live.push(item);
    while (live.length > MAX) remove(live[0]);

    if (motionOK()) {
      gsap.fromTo(slot, { height: 0, paddingTop: 0 }, { height: 'auto', paddingTop: 8, duration: 0.36, ease: 'power3.out', clearProps: 'height,paddingTop' });
      gsap.fromTo(
        el,
        { x: 48, opacity: 0, scale: 0.96, filter: richMotion() ? 'blur(8px)' : 'none' },
        { x: 0, opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.55, ease: 'back.out(1.3)', clearProps: 'filter,transform' },
      );
    }
    if (timerEl) {
      item.timer = gsap.fromTo(timerEl, { scaleX: 1 }, { scaleX: 0, duration: duration / 1000, ease: 'none', onComplete: () => remove(item) });
      el.addEventListener('pointerenter', () => item.timer?.pause());
      el.addEventListener('pointerleave', () => item.timer?.resume());
    }
    sound.play(t.sound);
    return { close: () => remove(item), el };
  }

  const toast = { show };
  for (const type of Object.keys(TYPES)) {
    toast[type] = (title, message, opts = {}) => show({ ...opts, type, title, message });
  }
  toast.clear = () => [...live].forEach(remove);
  return toast;
}
